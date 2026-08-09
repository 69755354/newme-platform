import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const gateDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(gateDir, "..", "..");

const sources = [
  [
    "6762d706cb6a9fde469fc994244a3898296ff552:supabase/migrations/20260601000000_init.sql",
    "4cbac950899405cade64efeecdb4e111452fc637",
  ],
  [
    "c8a7bf83e5c:supabase/migrations/20260623020000_crm_v3_new_tables.sql",
    "76ab226c40d0c44e0c63adf7f94b90ccc65589b1",
  ],
  [
    "6762d706cb6a9fde469fc994244a3898296ff552:supabase/migrations/20260630200000_rls_policy_remediation.sql",
    "c0f82e4efdc50e8015fe5d5da58f9611052cf321",
  ],
  [
    "9623e6ca759:docs/final-v3-test-report-20260603.md",
    "720eb923c79e661c2283bf011687bb08be11d9b5",
  ],
  [
    "729c31a9d96^:docs/context-pack/04-db-schema-facts.md",
    "d4d3864fd442ac5d5079f5244578c3ed1e781b74",
  ],
  [
    "d8278c4c218:supabase/migrations/20260702000002_p0_10_sync_lead_from_tasks.sql",
    "9be49177c86170c834dc4017ae2e05f5f1f3c4c4",
  ],
  [
    "d8278c4c218:supabase/migrations/20260702000003_p0_10_sync_task_from_lead.sql",
    "0d6cf5a3e9e183feefc0a43415f6fe2b266336a4",
  ],
  [
    "6762d706cb6a9fde469fc994244a3898296ff552:supabase/migrations/20260805202917_hotfix_public_definer_acl_search_path.sql",
    "ed6fbb9dd762d3c6ef5bfe5ac57b44930fb2c7bd",
  ],
];

const restored = [
  [
    "supabase/ci-local/supabase/migrations/20260702000002_p0_10_sync_lead_from_tasks.sql",
    "9be49177c86170c834dc4017ae2e05f5f1f3c4c4",
  ],
  [
    "supabase/ci-local/supabase/migrations/20260702000003_p0_10_sync_task_from_lead.sql",
    "0d6cf5a3e9e183feefc0a43415f6fe2b266336a4",
  ],
];

const gateAssets = [
  [
    "supabase/ci-local/supabase/config.toml",
    "23e1c341f14c1866a9340db72e67665bf413c4e9",
  ],
  [
    "supabase/ci-local/supabase/migrations/00000000000000_ci_task_followup_baseline.sql",
    "4ccb3ea9e6d2d21c39139b26752e89178c3e1f8d",
  ],
  [
    "supabase/ci-local/supabase/migrations/20260805202917_ci_task_followup_function_hardening.sql",
    "fc59555e654e25f10659101519657f0d94de5707",
  ],
  [
    "supabase/ci-local/supabase/seed.sql",
    "067597064b38b4af967dadb655a7960de1fe3bb8",
  ],
  [
    "supabase/ci-local/supabase/tests/database/task_followup_rls.sql",
    "0cd2b6ca2717f8a92318a28f6b43a7fe846ec051",
  ],
];

function git(args) {
  return execFileSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

const failures = [];

for (const [source, expected] of sources) {
  let actual;
  try {
    actual = git(["rev-parse", source]);
  } catch (error) {
    failures.push(`${source}: source Git object is unavailable`);
    continue;
  }
  if (actual !== expected) {
    failures.push(`${source}: expected ${expected}, got ${actual}`);
  }
}

for (const [path, expected] of restored) {
  let actual;
  try {
    actual = git(["hash-object", path]);
  } catch (error) {
    failures.push(`${path}: restored file is unavailable`);
    continue;
  }
  if (actual !== expected) {
    failures.push(`${path}: expected ${expected}, got ${actual}`);
  }
}

for (const [path, expected] of gateAssets) {
  let actual;
  try {
    actual = git(["hash-object", path]);
  } catch (error) {
    failures.push(`${path}: accepted gate asset is unavailable`);
    continue;
  }
  if (actual !== expected) {
    failures.push(`${path}: accepted gate asset expected ${expected}, got ${actual}`);
  }
}

const provenance = readFileSync(resolve(gateDir, "PROVENANCE.md"), "utf8");
if (provenance.includes("VERIFY_BEFORE_MERGE")) {
  failures.push("PROVENANCE.md contains an unresolved verification placeholder");
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`FAIL ${failure}`);
  process.exit(1);
}

console.log(
  `PASS ${sources.length} source Git blobs, ${restored.length} restored migration files, and ${gateAssets.length} accepted gate assets verified`,
);
