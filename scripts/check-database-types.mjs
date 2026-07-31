import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const typesPath = resolve(root, "src/types/database.ts");
const migrationsPath = resolve(root, "supabase/migrations");
const provenancePrefix = "// Migration fingerprint: sha256=";
const required = [
  "export type Database =",
  "audit_events:",
  "memberships:",
  "membership_roles:",
  "organizations:",
  "organization_provisioning_requests:",
  "platform_staff:",
  "profiles:",
  "roles:",
  "leads:",
  "support_sessions:",
  "allocate_payment:",
  "confirm_payment:",
  "end_support_session_atomic:",
  'requested_organization_id: { Args: never; Returns: string }',
  "start_support_session_atomic:",
  "organization_billable_seat_count:",
  "initialize_organization:",
  "v_sam23_organization_commercial_summary:",
  "transition_lead_stage:",
];

const migrationNames = (await readdir(migrationsPath))
  .filter((name) => name.endsWith(".sql"))
  .sort();
const fingerprintHash = createHash("sha256");
for (const name of migrationNames) {
  const path = resolve(migrationsPath, name);
  fingerprintHash.update(relative(root, path).replaceAll("\\", "/"));
  fingerprintHash.update("\0");
  fingerprintHash.update((await readFile(path, "utf8")).replaceAll("\r\n", "\n"));
  fingerprintHash.update("\0");
}
const fingerprint = fingerprintHash.digest("hex");
const provenance = `${provenancePrefix}${fingerprint}`;

const source = await readFile(typesPath, "utf8");
if (process.argv.includes("--stamp")) {
  const stamped = source.startsWith(provenancePrefix)
    ? source.replace(/^\/\/ Migration fingerprint: sha256=[a-f0-9]+\r?\n/, `${provenance}\n`)
    : `${provenance}\n${source}`;
  await writeFile(typesPath, stamped);
} else if (source.split(/\r?\n/, 1)[0] !== provenance) {
  console.error(`Database type source migration fingerprint mismatch: expected ${fingerprint}`);
  process.exit(1);
}

const checkedSource = process.argv.includes("--stamp") ? await readFile(typesPath, "utf8") : source;
const missing = required.filter((token) => !checkedSource.includes(token));
if (missing.length) {
  console.error(`Database type source is incomplete: ${missing.join(", ")}`);
  process.exit(1);
}
console.log("Database type source gate passed");
