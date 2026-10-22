/** Fixed, bounded cleanup RPC. No HTTP endpoint, user selector or SQL argument. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export async function runWhatsAppMaintenance({ url, key, fetchImpl = fetch }) {
  if (url !== "https://vfopmpxlhwzpxqegayew.supabase.co" || typeof key !== "string" || key.length < 24) throw new Error("privacy_configuration_invalid");
  let last;
  for (let attempt = 0; attempt < 5; attempt++) {
    let response;
    try {
      response = await fetchImpl(`${url}/rest/v1/rpc/maintain_whatsapp_privacy`, {
        method: "POST", headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: "{}", signal: AbortSignal.timeout(30_000), redirect: "error",
      });
    } catch { throw new Error("privacy_maintenance_connection_failed"); }
    if (!response.ok) { await response.body?.cancel(); throw new Error("privacy_maintenance_rpc_failed"); }
    let value;
    try { value = await response.json(); } catch { throw new Error("privacy_maintenance_receipt_invalid"); }
    if (!value || !Number.isSafeInteger(value.deleted_expired) || value.deleted_expired < 0
      || !Number.isSafeInteger(value.completed_requests) || value.completed_requests < 0
      || !Number.isFinite(Date.parse(value.completed_at)) || typeof value.backlog !== "boolean") throw new Error("privacy_maintenance_receipt_invalid");
    // Build a fresh allowlisted receipt; never print the provider response body.
    last = { completed_at: value.completed_at, deleted_expired: value.deleted_expired,
      completed_requests: value.completed_requests, backlog: value.backlog };
    if (!last.backlog) return last;
  }
  throw new Error("privacy_maintenance_backlog");
}

function assignments(text) {
  const result = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (Object.hasOwn(result, match[1])) throw new Error("privacy_duplicate_config");
    result[match[1]] = value;
  }
  return result;
}

async function main() {
  if (process.argv.length !== 2 || process.getuid?.() !== 0) throw new Error("privacy_maintenance_root_only");
  const configPath = "/etc/newme/newme-runtime.env";
  const info = fs.lstatSync(configPath);
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== 0 || (info.mode & 0o077)) throw new Error("privacy_runtime_permissions_invalid");
  const runtime = assignments(fs.readFileSync(configPath, "utf8"));
  const release = assignments(fs.readFileSync(new URL("../.env.local", import.meta.url), "utf8"));
  const receipt = await runWhatsAppMaintenance({
    url: runtime.NEXT_PUBLIC_SUPABASE_URL ?? release.NEXT_PUBLIC_SUPABASE_URL,
    key: runtime.SUPABASE_SERVICE_ROLE_KEY,
  });
  // Root-owned, content-free receipt lets the independent dependency probe
  // detect a missing cron or a worker that has stopped completing RPCs.
  const receiptPath = "/run/newme-whatsapp-privacy-last-success.json";
  const temporary = `${receiptPath}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(receipt) + "\n", { mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, receiptPath);
  } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  console.log(JSON.stringify({ whatsapp_privacy: "complete", ...receipt }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    // Even filesystem/provider exceptions can contain sensitive values or paths.
    console.error("WHATSAPP_PRIVACY_MAINTENANCE_FAILED"); process.exitCode = 1;
  });
}
