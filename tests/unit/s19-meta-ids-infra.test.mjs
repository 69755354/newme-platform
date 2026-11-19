import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn, spawnSync } from "node:child_process";

const ROOT = new URL("../../", import.meta.url).pathname;
const UPLOAD = path.join(ROOT, "infra/nas/newme-nas-upload.sh");
const EXPORT = path.join(ROOT, "infra/meta-ids/newme-meta-ids-export.sh");
const TOKEN = "z".repeat(40);
const PASSWORD = ["nas", "test", String(process.pid)].join("-");

function run(cmd, args, env) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { env: { PATH: process.env.PATH, ...env } });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; }); child.stderr.on("data", (d) => { stderr += d; });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}
const listen = (server) => new Promise((r) => server.listen(0, "127.0.0.1", () => r(server.address().port)));

/** Minimal DSM FileStation: login, getinfo (size) and multipart upload. */
function fakeNas({ corruptSize = false } = {}) {
  const files = new Map(); const calls = []; const argvSeen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const url = new URL(req.url, "http://x");
      const type = req.headers["content-type"] ?? "";
      const form = type.startsWith("application/x-www-form-urlencoded") ? new URLSearchParams(body.toString()) : url.searchParams;
      const api = form.get("api") ?? (type.startsWith("multipart") ? "SYNO.FileStation.Upload" : "");
      calls.push(api + ":" + (form.get("method") ?? ""));
      const send = (obj) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(obj)); };
      if (api === "SYNO.API.Auth" && form.get("method") === "login") {
        return send(form.get("passwd") === PASSWORD ? { success: true, data: { sid: "SID123" } } : { success: false, error: { code: 400 } });
      }
      if (url.searchParams.get("_sid") !== "SID123" && form.get("_sid") !== "SID123") return send({ success: false, error: { code: 119 } });
      if (api === "SYNO.API.Auth") return send({ success: true });
      if (api === "SYNO.FileStation.List") {
        const p = JSON.parse(form.get("path"))[0];
        const f = files.get(p);
        return send({ success: true, data: { files: [f === undefined ? { path: p, code: 408 } : { path: p, additional: { size: corruptSize ? f.length + 1 : f.length } }] } });
      }
      if (type.startsWith("multipart")) {
        const text = body.toString("latin1");
        const dir = text.match(/name="path"\r\n\r\n([^\r]*)/)?.[1];
        const name = text.match(/filename="([^"]*)"/)?.[1];
        const start = text.indexOf("\r\n\r\n", text.indexOf("filename=")) + 4;
        const end = text.lastIndexOf("\r\n--");
        files.set(`${dir}/${name}`, Buffer.from(text.slice(start, end), "latin1"));
        return send({ success: true });
      }
      return send({ success: false });
    });
  });
  return { server, files, calls, argvSeen };
}
function setup(extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "s19-"));
  return { dir, envFile: path.join(dir, "nas.env"), ...extra };
}
const writeNasEnv = (envFile, port, password = PASSWORD) => fs.writeFileSync(envFile, `NAS_USER=u\nNAS_PASSWORD=${password}\nNAS_HOST=127.0.0.1:${port}\n`, { mode: 0o600 });

test("shellcheck is clean for both scripts when shellcheck is installed", () => {
  const probe = spawnSync("shellcheck", ["--version"]);
  if (probe.status !== 0) return;
  const r = spawnSync("shellcheck", [UPLOAD, EXPORT], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout);
});

test("upload: sends the file, then skips when the NAS already holds the same size", async () => {
  const nas = fakeNas(); const port = await listen(nas.server); const t = setup();
  try {
    writeNasEnv(t.envFile, port);
    const file = path.join(t.dir, "meta-ids-20261119.csv"); fs.writeFileSync(file, "lead_ref,source\r\nNM-1,form\r\n");
    const env = { NAS_ENV_FILE: t.envFile, NAS_SCHEME: "http" };
    const first = await run("bash", [UPLOAD, file, "/newme-os-backup/exports"], env);
    assert.equal(first.code, 0, first.stderr);
    assert.match(first.stdout, /uploaded meta-ids-20261119\.csv/);
    assert.equal(nas.files.get("/newme-os-backup/exports/meta-ids-20261119.csv").toString(), "lead_ref,source\r\nNM-1,form\r\n");
    const second = await run("bash", [UPLOAD, file, "/newme-os-backup/exports"], env);
    assert.equal(second.code, 0, second.stderr);
    assert.match(second.stdout, /skip meta-ids-20261119\.csv/);
    assert.equal(nas.calls.filter((c) => c.startsWith("SYNO.FileStation.Upload")).length, 1);
    assert.ok(nas.calls.includes("SYNO.API.Auth:logout"));
    assert.ok(!first.stdout.includes(PASSWORD) && !first.stderr.includes(PASSWORD));
  } finally { nas.server.close(); fs.rmSync(t.dir, { recursive: true, force: true }); }
});

test("upload: --overwrite replaces an equal-length file with different content; default still skips", async () => {
  const nas = fakeNas(); const port = await listen(nas.server); const t = setup();
  try {
    writeNasEnv(t.envFile, port);
    const file = path.join(t.dir, "meta-ids-20261119.csv");
    const remote = "/newme-os-backup/exports/meta-ids-20261119.csv";
    const env = { NAS_ENV_FILE: t.envFile };
    fs.writeFileSync(file, "lead_ref,stage\r\nNM-1,new\r\n");
    assert.equal((await run("bash", [UPLOAD, file, "/newme-os-backup/exports"], env)).code, 0);
    fs.writeFileSync(file, "lead_ref,stage\r\nNM-1,won\r\n"); // same length, new content
    const kept = await run("bash", [UPLOAD, file, "/newme-os-backup/exports"], env);
    assert.match(kept.stdout, /skip /);
    assert.match(nas.files.get(remote).toString(), /NM-1,new/);
    const flag = await run("bash", [UPLOAD, "--overwrite", file, "/newme-os-backup/exports"], env);
    assert.equal(flag.code, 0, flag.stderr);
    assert.match(flag.stdout, /uploaded /);
    assert.match(nas.files.get(remote).toString(), /NM-1,won/);
    fs.writeFileSync(file, "lead_ref,stage\r\nNM-1,lost\r\n");
    const viaEnv = await run("bash", [UPLOAD, file, "/newme-os-backup/exports"], { ...env, NAS_UPLOAD_OVERWRITE: "1" });
    assert.equal(viaEnv.code, 0, viaEnv.stderr);
    assert.match(nas.files.get(remote).toString(), /NM-1,lost/);
  } finally { nas.server.close(); fs.rmSync(t.dir, { recursive: true, force: true }); }
});

test("daily export asks the uploader to overwrite the dated file", () => {
  assert.match(fs.readFileSync(EXPORT, "utf8"), /"\$NAS_UPLOAD" --overwrite "\$FINAL" "\$NAS_DIR"/);
});

test("upload: size mismatch after upload fails", async () => {
  const nas = fakeNas({ corruptSize: true }); const port = await listen(nas.server); const t = setup();
  try {
    writeNasEnv(t.envFile, port);
    const file = path.join(t.dir, "a.csv"); fs.writeFileSync(file, "hello");
    const r = await run("bash", [UPLOAD, file, "/newme-os-backup/exports"], { NAS_ENV_FILE: t.envFile });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /size mismatch/);
  } finally { nas.server.close(); fs.rmSync(t.dir, { recursive: true, force: true }); }
});

test("upload: wrong NAS password, unsafe paths and missing file are refused", async () => {
  const nas = fakeNas(); const port = await listen(nas.server); const t = setup();
  try {
    const file = path.join(t.dir, "a.csv"); fs.writeFileSync(file, "x");
    writeNasEnv(t.envFile, port, "wrong");
    const bad = await run("bash", [UPLOAD, file, "/newme-os-backup/exports"], { NAS_ENV_FILE: t.envFile });
    assert.equal(bad.code, 1); assert.match(bad.stderr, /NAS login failed/);
    writeNasEnv(t.envFile, port);
    const env = { NAS_ENV_FILE: t.envFile };
    assert.equal((await run("bash", [UPLOAD, file, "/etc"], env)).code, 2);
    assert.equal((await run("bash", [UPLOAD, file, "/newme-os-backup/../etc"], env)).code, 2);
    assert.equal((await run("bash", [UPLOAD, path.join(t.dir, "missing.csv"), "/newme-os-backup/exports"], env)).code, 2);
    assert.equal((await run("bash", [UPLOAD, file], env)).code, 2);
    assert.equal((await run("bash", [UPLOAD, file, "/newme-os-backup/exports"], { NAS_ENV_FILE: path.join(t.dir, "nope.env") })).code, 2);
    assert.equal(nas.files.size, 0);
  } finally { nas.server.close(); fs.rmSync(t.dir, { recursive: true, force: true }); }
});

function fakeApp({ status = 200, body, seen }) {
  const server = http.createServer((req, res) => {
    seen.push({ url: req.url, auth: req.headers.authorization });
    res.statusCode = status; res.setHeader("content-type", "text/csv"); res.end(body);
  });
  return server;
}
const CSV = "﻿lead_ref,source,meta_id_type,meta_id,campaign_id\r\nNM-1,form,leadgen,123,c1\r\n";

test("daily export: fetches with the token in a header (not the URL), stores a dated file and uploads it", async () => {
  const seen = []; const app = fakeApp({ body: CSV, seen }); const appPort = await listen(app);
  const t = setup(); const out = path.join(t.dir, "out"); const calls = path.join(t.dir, "calls");
  try {
    fs.writeFileSync(t.envFile, `META_IDS_EXPORT_TOKEN=${TOKEN}\nMETA_IDS_EXPORT_URL=http://127.0.0.1:${appPort}/api/export/meta-ids\n`, { mode: 0o600 });
    const fakeUpload = path.join(t.dir, "upload.sh"); fs.writeFileSync(fakeUpload, `#!/bin/bash\necho "$1 $2 $3" >> ${calls}\n`, { mode: 0o755 });
    const r = await run("bash", [EXPORT], { META_IDS_ENV_FILE: t.envFile, META_IDS_OUT_DIR: out, NAS_UPLOAD_SCRIPT: fakeUpload });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(seen[0].auth, `Bearer ${TOKEN}`);
    assert.ok(!seen[0].url.includes(TOKEN));
    const files = fs.readdirSync(out).filter((f) => /^meta-ids-\d{8}\.csv$/.test(f));
    assert.equal(files.length, 1);
    assert.equal(fs.readFileSync(path.join(out, files[0]), "utf8"), CSV);
    assert.match(fs.readFileSync(calls, "utf8"), /--overwrite .*meta-ids-\d{8}\.csv \/newme-os-backup\/exports/);
    assert.ok(!(r.stdout + r.stderr).includes(TOKEN));
  } finally { app.close(); fs.rmSync(t.dir, { recursive: true, force: true }); }
});

test("daily export: HTTP errors, HTML bodies and missing config never produce a file or an upload", async () => {
  const t = setup(); const out = path.join(t.dir, "out"); const calls = path.join(t.dir, "calls");
  const fakeUpload = path.join(t.dir, "upload.sh"); fs.writeFileSync(fakeUpload, `#!/bin/bash\necho x >> ${calls}\n`, { mode: 0o755 });
  try {
    for (const [status, body] of [[401, "{\"error\":\"Unauthorized\"}"], [200, "<html>login</html>"]]) {
      const app = fakeApp({ status, body, seen: [] }); const port = await listen(app);
      fs.writeFileSync(t.envFile, `META_IDS_EXPORT_TOKEN=${TOKEN}\nMETA_IDS_EXPORT_URL=http://127.0.0.1:${port}/x\n`);
      const r = await run("bash", [EXPORT], { META_IDS_ENV_FILE: t.envFile, META_IDS_OUT_DIR: out, NAS_UPLOAD_SCRIPT: fakeUpload });
      app.close();
      assert.equal(r.code, 1, `${status}: ${r.stderr}`);
      assert.equal(fs.existsSync(out) ? fs.readdirSync(out).filter((f) => f.endsWith(".csv")).length : 0, 0);
    }
    assert.equal(fs.existsSync(calls), false);
    fs.writeFileSync(t.envFile, "META_IDS_EXPORT_URL=http://127.0.0.1:1/x\n");
    assert.notEqual((await run("bash", [EXPORT], { META_IDS_ENV_FILE: t.envFile, META_IDS_OUT_DIR: out, NAS_UPLOAD_SCRIPT: fakeUpload })).code, 0);
    assert.equal((await run("bash", [EXPORT], { META_IDS_ENV_FILE: path.join(t.dir, "none"), META_IDS_OUT_DIR: out })).code, 2);
  } finally { fs.rmSync(t.dir, { recursive: true, force: true }); }
});

test("systemd templates: 02:10 Dubai timer, alert on failure, hardened, no secrets", () => {
  const timer = fs.readFileSync(path.join(ROOT, "infra/meta-ids/newme-meta-ids-export.timer"), "utf8");
  const service = fs.readFileSync(path.join(ROOT, "infra/meta-ids/newme-meta-ids-export.service"), "utf8");
  assert.match(timer, /OnCalendar=\*-\*-\* 02:10:00 Asia\/Dubai/);
  assert.match(timer, /Persistent=true/);
  assert.match(service, /OnFailure=newme-backup-alert@%n\.service/);
  assert.match(service, /ExecStart=\/usr\/local\/libexec\/newme\/newme-meta-ids-export\.sh/);
  assert.match(service, /ProtectSystem=strict/); assert.match(service, /ReadWritePaths=\/var\/lib\/newme-meta-ids/);
  const example = fs.readFileSync(path.join(ROOT, "infra/meta-ids/meta-ids-export.env.example"), "utf8");
  assert.match(example, /^META_IDS_EXPORT_TOKEN=$/m);
  const verify = spawnSync("systemd-analyze", ["verify", "--man=no", path.join(ROOT, "infra/meta-ids/newme-meta-ids-export.service")], { encoding: "utf8" });
  if (verify.error === undefined && /Failed to parse|Unknown (key|section)/.test(verify.stderr)) assert.fail(verify.stderr);
});
