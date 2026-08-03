import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const script = path.join(root, "scripts", "cos-presign.py");
const python = process.env.COS_TEST_PYTHON
  ?? (process.platform === "win32" ? "python" : "python3");
const contentMd5 = "1B2M2Y8AsgTpgAmY7PhCfg==";
const expectedEtag = "d41d8cd98f00b204e9800998ecf8427e";
const key = "organizations/78000000-0000-4000-8000-000000000001/contracts/a/file.pdf";

function runScript(args, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(python, [script, ...args], {
      cwd: root,
      env: { ...process.env, ...extraEnv },
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

test("COS upload binds provider-validated MD5, type, and exact Content-Length", async (t) => {
  const result = await runScript(
    ["--put", key, "900", "application/pdf", contentMd5, "4"],
    {
      COS_SECRET_ID: "test-secret-id",
      COS_SECRET_KEY: "test-secret-key",
      COS_BUCKET: "newme-test-1300000000",
      COS_REGION: "ap-singapore",
    },
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.deepEqual(payload.headers, {
    "Content-Length": "4",
    "Content-MD5": contentMd5,
    "Content-Type": "application/pdf",
    "x-cos-meta-md5": contentMd5,
  });
  const url = new URL(payload.url);
  assert.equal(url.hostname, "newme-test-1300000000.cos.ap-singapore.myqcloud.com");
  assert.equal(
    url.searchParams.get("q-header-list"),
    "content-length;content-md5;content-type;host;x-cos-meta-md5",
  );

  const provider = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const actualBytes = Buffer.concat(chunks).length;
      const declaredLength = request.headers["content-length"] ?? "";
      const accepted = declaredLength === payload.headers["Content-Length"]
        && actualBytes === Number(declaredLength);
      response.writeHead(accepted ? 200 : 403);
      response.end();
    });
  });
  await new Promise((resolve, reject) => {
    provider.once("error", reject);
    provider.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise((resolve) => provider.close(resolve)));
  const address = provider.address();
  assert.ok(address && typeof address === "object");
  const providerUrl = `http://127.0.0.1:${address.port}/object`;

  const accepted = await fetch(providerUrl, {
    method: "PUT",
    headers: payload.headers,
    body: "data",
  });
  assert.equal(accepted.status, 200);

  const rejected = await fetch(providerUrl, {
    method: "PUT",
    headers: { ...payload.headers, "Content-Length": "3" },
    body: "bad",
  });
  assert.equal(rejected.status, 403);

  const invalidSize = await runScript(
    ["--put", key, "900", "application/pdf", contentMd5, "1073741825"],
    {
      COS_SECRET_ID: "test-secret-id",
      COS_SECRET_KEY: "test-secret-key",
      COS_BUCKET: "newme-test-1300000000",
      COS_REGION: "ap-singapore",
    },
  );
  assert.notEqual(invalidSize.status, 0);
  assert.deepEqual(JSON.parse(invalidSize.stdout), {
    error: "invalid_storage_expected_size",
  });
});

test("COS HEAD verifies provider length, type, metadata MD5, ETag and optional CRC64", async (t) => {
  const server = createServer((request, response) => {
    assert.equal(request.method, "HEAD");
    response.writeHead(200, {
      "Content-Length": "0",
      "Content-Type": "application/pdf",
      "x-cos-meta-md5": contentMd5,
      ETag: `"${expectedEtag}"`,
      "x-cos-hash-crc64ecma": "0",
    });
    response.end();
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const env = {
    NEWME_ENVIRONMENT: "test",
    COS_VERIFY_TEST_BASE_URL: `http://127.0.0.1:${address.port}`,
  };
  const verified = await runScript(
    ["--head", key, "0", "application/pdf", contentMd5],
    env,
  );
  assert.equal(verified.status, 0, verified.stdout + verified.stderr);
  assert.deepEqual(JSON.parse(verified.stdout), {
    key,
    size: 0,
    content_type: "application/pdf",
    content_md5: contentMd5,
    etag: `"${expectedEtag}"`,
    checksum_crc64ecma: "0",
  });

  const mismatch = await runScript(
    ["--head", key, "1", "application/pdf", contentMd5],
    env,
  );
  assert.notEqual(mismatch.status, 0);
  assert.deepEqual(JSON.parse(mismatch.stdout), { error: "storage_size_mismatch" });
});

test("COS deletion retries and completes only after provider HEAD proves absence", async (t) => {
  let objectExists = true;
  let deleteAttempts = 0;
  const server = createServer((request, response) => {
    if (request.method === "DELETE") {
      deleteAttempts += 1;
      if (deleteAttempts === 1) {
        response.writeHead(500);
      } else if (objectExists) {
        objectExists = false;
        response.writeHead(204);
      } else {
        response.writeHead(404);
      }
      response.end();
      return;
    }
    assert.equal(request.method, "HEAD");
    response.writeHead(objectExists ? 200 : 404);
    response.end();
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const env = {
    NEWME_ENVIRONMENT: "test",
    COS_VERIFY_TEST_BASE_URL: `http://127.0.0.1:${address.port}`,
  };

  const failed = await runScript(["--delete", key], env);
  assert.notEqual(failed.status, 0);
  assert.deepEqual(JSON.parse(failed.stdout), { error: "cos_delete_failed" });
  assert.equal(objectExists, true);

  const deleted = await runScript(["--delete", key], env);
  assert.equal(deleted.status, 0, deleted.stdout + deleted.stderr);
  assert.deepEqual(JSON.parse(deleted.stdout), {
    key,
    absent: true,
    delete_status: 204,
    evidence: "cos_delete_204_head_404",
  });

  const idempotent = await runScript(["--delete", key], env);
  assert.equal(idempotent.status, 0, idempotent.stdout + idempotent.stderr);
  assert.deepEqual(JSON.parse(idempotent.stdout), {
    key,
    absent: true,
    delete_status: 404,
    evidence: "cos_delete_404_head_404",
  });
});

test("storage routes resolve the script from the immutable release and trust no confirm metadata", async () => {
  const files = await Promise.all([
    "src/lib/cos-presign.ts",
    "src/app/api/contracts/[id]/upload-url/route.ts",
    "src/app/api/contracts/[id]/confirm-upload/route.ts",
    "src/app/api/cos/download-url/route.ts",
  ].map((name) => readFile(path.join(root, name), "utf8")));
  const source = files.join("\n");
  assert.doesNotMatch(source, /\/home\/ubuntu\/newme-platform/);
  assert.match(files[0], /realpathSync\(process\.cwd\(\)\)/);
  assert.match(files[0], /resolve\(releaseRoot, "scripts", "cos-presign\.py"\)/);
  assert.match(files[1], /"Content-MD5"/);
  assert.match(files[1], /"Content-Length"/);
  assert.match(files[1], /q-header-list/);
  assert.match(files[1], /"x-cos-meta-md5"/);
  assert.match(files[2], /Object\.keys\(body\)\.length !== 1/);
  assert.doesNotMatch(files[2], /body\?\.(key|size|content_md5)/);
  assert.match(files[2], /"--head"/);
  assert.match(files[2], /v4_finalize_tenant_file/);
});
