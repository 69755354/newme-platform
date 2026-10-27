/** Read-only pre-switch gate for the one reviewed, default-off observer migration. */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { loadPg, readUrlFile } from "./db-phase-push.mjs";
import { readLiveMode, readReleaseManifest } from "./check-release-phase.mjs";

export const OBSERVER = Object.freeze({
  version: "20261019104004",
  file: "20261019104004_whatsapp_pilot_events.sql",
  sha256: "1b37cc05c022f11c2d6a5a982a53c6dd56ffab82461c22c5f092eccb34ed49c6",
  tables: ["whatsapp_pilot_channels", "whatsapp_pilot_events"],
});

const entries = (list) => Array.isArray(list)
  ? list.map(({ version, file, sha256 }) => ({ version, file, sha256 })) : null;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export function judgeProvisioning({ live, candidate, sql, phase, existingTables = [], recordedVersions = [] }) {
  const problems = [];
  if (phase !== "strict") problems.push("live database must already be strict");
  if (!live?.runs_under?.database_phases?.includes("strict") ||
      !candidate?.runs_under?.database_phases?.includes("strict")) {
    problems.push("both releases must declare strict compatibility");
  }
  if (!Array.isArray(live?.required_for_app) || live.required_for_app.length === 0 ||
      !same(entries(live.required_for_app), entries(candidate?.required_for_app))) {
    problems.push("required migration set or content changed");
  }
  const prior = entries(live?.deferred_contract);
  const next = entries(candidate?.deferred_contract);
  if (!prior?.length || !next || next.length !== prior.length + 1 ||
      !same(prior, next.slice(0, prior.length))) {
    problems.push("candidate must preserve the entire live deferred prefix and add exactly one migration");
  }
  const expected = { version: OBSERVER.version, file: OBSERVER.file, sha256: OBSERVER.sha256 };
  if (!same(next?.at(-1), expected) || prior?.some((entry) => entry.version >= OBSERVER.version)) {
    problems.push("only the exact reviewed observer suffix is permitted");
  }
  const hash = createHash("sha256").update(String(sql ?? "").replaceAll("\r\n", "\n")).digest("hex");
  if (hash !== OBSERVER.sha256) problems.push("observer SQL does not match the reviewed immutable hash");
  const recorded = recordedVersions.includes(OBSERVER.version);
  for (const table of OBSERVER.tables) {
    if (existingTables.includes(table) !== recorded) {
      problems.push(`${table}: table presence and recorded observer migration disagree`);
    }
  }
  return { problems, version: OBSERVER.version, alreadyRecorded: recorded };
}

async function main(argv) {
  const flags = new Map();
  for (let i = 0; i < argv.length; i += 2) {
    if (!["--live-release", "--candidate-release", "--url-file", "--modules-dir"].includes(argv[i]) ||
        !argv[i + 1] || flags.has(argv[i])) throw new Error("invalid provisioning gate arguments");
    flags.set(argv[i], argv[i + 1]);
  }
  for (const name of ["--live-release", "--candidate-release", "--url-file", "--modules-dir"]) {
    if (!flags.has(name)) throw new Error(`${name} is required`);
  }
  const live = readReleaseManifest(flags.get("--live-release")).manifest;
  const candidate = readReleaseManifest(flags.get("--candidate-release")).manifest;
  const sql = fs.readFileSync(path.join(flags.get("--candidate-release"), "supabase/migrations", OBSERVER.file), "utf8");
  const url = readUrlFile(flags.get("--url-file"));
  const phase = await readLiveMode(url, flags.get("--modules-dir"));
  const { Client } = loadPg(flags.get("--modules-dir"));
  const client = new Client({ connectionString: url, application_name: "newme-whatsapp-provisioning-gate",
    connectionTimeoutMillis: 15000, statement_timeout: 15000 });
  let existingTables;
  let recordedVersions;
  try {
    await client.connect();
    await client.query("begin read only");
    existingTables = (await client.query(
      "select tablename from pg_catalog.pg_tables where schemaname = 'public' and tablename = any($1::text[])",
      [OBSERVER.tables],
    )).rows.map((row) => row.tablename);
    recordedVersions = (await client.query(
      "select version from supabase_migrations.schema_migrations where version = $1", [OBSERVER.version],
    )).rows.map((row) => row.version);
  } catch (error) {
    // A driver error can contain database details; emit its code/name, never its message.
    throw new Error(`database provisioning gate refused (${error.code ?? error.name})`);
  } finally {
    await client.end().catch(() => {});
  }
  const result = judgeProvisioning({ live, candidate, sql, phase, existingTables, recordedVersions });
  if (result.problems.length) throw new Error(result.problems.join("; "));
  console.log(JSON.stringify({ observer_provisioning: "approved", ...result }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
