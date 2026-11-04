#!/usr/bin/env node
// Daily synthetic production journey (S7 item 4, review 5-logging-monitoring F6):
//   login -> open leads -> assign -> change stage -> revert both -> logout
// using ONE dedicated QA operator account and ONE pinned, marked test lead.
//
// Safety model (zero tolerance for touching real data):
//   * the lead id is pinned in configuration and every write re-checks it;
//   * before the first write the lead must match the pinned id, the exact marker
//     name and the marker source, and must be assigned to one of the two QA users;
//   * the assignee/stage the lead had before are restored in `finally`, and a
//     failed restore is reported as CRITICAL;
//   * only counts, step names, HTTP status codes and the release id are printed or
//     alerted: never a name, phone, token, cookie or response body.
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

export class SyntheticAbort extends Error {}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function loadConfig(env) {
  const need = (key) => {
    const value = env[key]?.trim();
    if (!value) throw new SyntheticAbort(`missing configuration: ${key}`);
    return value;
  };
  const config = {
    baseUrl: need("SYNTH_BASE_URL").replace(/\/+$/, ""),
    email: need("SYNTH_QA_EMAIL"),
    password: need("SYNTH_QA_PASSWORD"),
    leadId: need("SYNTH_LEAD_ID"),
    marker: need("SYNTH_LEAD_MARKER"),
    markerSource: need("SYNTH_LEAD_SOURCE"),
    homeAssignee: need("SYNTH_HOME_ASSIGNEE_ID"),
    awayAssignee: need("SYNTH_AWAY_ASSIGNEE_ID"),
    toStage: env.SYNTH_TO_STAGE?.trim() || "contacted",
    timeoutMs: Number(env.SYNTH_TIMEOUT_MS) || 15_000,
  };
  if (!config.baseUrl.startsWith("https://")) throw new SyntheticAbort("SYNTH_BASE_URL must be https");
  for (const key of ["leadId", "homeAssignee", "awayAssignee"]) {
    if (!UUID.test(config[key])) throw new SyntheticAbort(`${key} must be a UUID`);
  }
  if (config.homeAssignee === config.awayAssignee) throw new SyntheticAbort("assignees must differ");
  if (config.marker.length < 12) throw new SyntheticAbort("marker must be a long, unmistakable name");
  return config;
}

/** The only gate between this script and a real customer. Pure, so it is tested alone. */
export function assertSafeSyntheticLead(lead, config) {
  if (!lead || lead.id !== config.leadId) throw new SyntheticAbort("pinned test lead not found in the list");
  if (lead.customer_name !== config.marker) throw new SyntheticAbort("pinned lead does not carry the test marker name");
  if (lead.source !== config.markerSource) throw new SyntheticAbort("pinned lead does not carry the test marker source");
  if (![config.homeAssignee, config.awayAssignee].includes(lead.assigned_to)) {
    throw new SyntheticAbort("pinned lead is assigned to someone other than the QA users");
  }
}

function cookieJar() {
  const jar = new Map();
  return {
    absorb(response) {
      const raw = typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [];
      for (const line of raw) {
        const [pair] = line.split(";");
        const eq = pair.indexOf("=");
        if (eq > 0) {
          const name = pair.slice(0, eq).trim();
          const value = pair.slice(eq + 1).trim();
          if (value === "" || /;\s*max-age=0/i.test(line)) jar.delete(name); else jar.set(name, value);
        }
      }
    },
    header: () => [...jar].map(([k, v]) => `${k}=${v}`).join("; "),
    size: () => jar.size,
  };
}

/**
 * Run the journey with an injectable fetch. Returns { ok, steps, failedStep,
 * critical, release }. Never throws for expected failures.
 */
export async function runJourney({ config, fetchImpl = fetch }) {
  const steps = [];
  const jar = cookieJar();
  let release = null;
  let original = null;
  let wrote = false;
  const result = { ok: false, steps, failedStep: null, critical: false, release: null };

  const call = async (name, path, init = {}) => {
    const response = await fetchImpl(`${config.baseUrl}${path}`, {
      ...init,
      redirect: "manual",
      signal: AbortSignal.timeout(config.timeoutMs),
      headers: { origin: config.baseUrl, cookie: jar.header(), ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers },
    });
    jar.absorb(response);
    release = response.headers.get("x-newme-release") || release;
    steps.push({ step: name, status: response.status });
    return response;
  };
  const must = async (name, path, init, okStatuses = [200]) => {
    const response = await call(name, path, init);
    if (!okStatuses.includes(response.status)) {
      result.failedStep = name;
      throw new SyntheticAbort(`${name}: HTTP ${response.status}`);
    }
    return response;
  };
  const listLead = async (name) => {
    const response = await must(name, "/api/leads/list", { method: "GET" });
    const body = await response.json();
    return { lead: (body.leads ?? []).find((l) => l.id === config.leadId), body };
  };
  const writeLead = (name, path, init) => {
    if (!path.includes(`/api/leads/${config.leadId}/`)) throw new SyntheticAbort("refusing to write to a lead other than the pinned one");
    wrote = true;
    return must(name, path, init, [200]);
  };

  try {
    await must("login", "/api/auth/login", { method: "POST", body: JSON.stringify({ email: config.email, password: config.password }) });
    if (jar.size() === 0) { result.failedStep = "login"; throw new SyntheticAbort("login returned no session cookie"); }

    const { lead, body } = await listLead("open_leads");
    assertSafeSyntheticLead(lead, config);
    if (!(body.salesUsers ?? []).some((u) => u.id === config.awayAssignee) && !(body.salesUsers ?? []).some((u) => u.id === config.homeAssignee)) {
      result.failedStep = "open_leads";
      throw new SyntheticAbort("assignee directory is empty");
    }
    original = { assignee: lead.assigned_to, stage: lead.stage, updatedAt: lead.updated_at };
    const target = original.assignee === config.homeAssignee ? config.awayAssignee : config.homeAssignee;

    await writeLead("assign", `/api/leads/${config.leadId}/assignment`, { method: "POST", body: JSON.stringify({
      assignedTo: target, idempotencyKey: randomUUID(), expectedUpdatedAt: original.updatedAt, reason: "synthetic_journey" }) });
    let after = (await listLead("verify_assign")).lead;
    if (after?.assigned_to !== target) { result.failedStep = "verify_assign"; throw new SyntheticAbort("assignee did not change"); }

    if (original.stage === config.toStage) throw new SyntheticAbort("test lead is already in the target stage; reset it");
    await writeLead("stage", `/api/leads/${config.leadId}/stage`, { method: "PATCH", body: JSON.stringify({
      stage: config.toStage, note: "synthetic journey", idempotencyKey: randomUUID() }) });
    after = (await listLead("verify_stage")).lead;
    if (after?.stage !== config.toStage) { result.failedStep = "verify_stage"; throw new SyntheticAbort("stage did not change"); }
  } catch (error) {
    if (!result.failedStep) result.failedStep = steps.at(-1)?.step ?? "setup";
    result.error = error instanceof SyntheticAbort ? error.message : `unexpected ${error?.name ?? "error"}`;
  } finally {
    if (wrote && original) {
      try {
        // Revert to exactly what we found, using the lead's current version token.
        let { lead } = await listLead("revert_read");
        assertSafeSyntheticLead(lead, config);
        if (lead.stage !== original.stage) {
          await writeLead("revert_stage", `/api/leads/${config.leadId}/stage`, { method: "PATCH", body: JSON.stringify({
            stage: original.stage, note: "synthetic journey revert", idempotencyKey: randomUUID() }) });
          ({ lead } = await listLead("revert_read_2"));
        }
        if (lead.assigned_to !== original.assignee) {
          await writeLead("revert_assign", `/api/leads/${config.leadId}/assignment`, { method: "POST", body: JSON.stringify({
            assignedTo: original.assignee, idempotencyKey: randomUUID(), expectedUpdatedAt: lead.updated_at, reason: "synthetic_journey_revert" }) });
        }
        const { lead: final } = await listLead("revert_verify");
        if (final?.assigned_to !== original.assignee || final?.stage !== original.stage) throw new SyntheticAbort("state not restored");
      } catch {
        result.critical = true;
        result.failedStep ??= "revert";
        result.error = `${result.error ? result.error + "; " : ""}REVERT FAILED: the test lead may be left changed`;
      }
    }
    try { await call("logout", "/api/auth/logout", { method: "POST" }); } catch { /* best effort */ }
    result.release = release;
    result.ok = !result.failedStep && !result.critical;
  }
  return result;
}

export function formatReport(result, config) {
  const where = result.release ? ` (release ${result.release})` : "";
  if (result.ok) return `每日巡检通过 / Daily production check PASSED${where}: ${result.steps.length} steps.`;
  return `${result.critical ? "【严重】CRITICAL " : ""}每日巡检失败 / Daily production check FAILED${where} at step "${result.failedStep}". ${result.error ?? ""}`.trim();
}

async function sendTelegram(env, text) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return false;
  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text }), signal: AbortSignal.timeout(15_000),
  });
  return response.ok;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  let config;
  try { config = loadConfig(process.env); } catch (error) { console.error(error.message); process.exit(2); }
  const dryRun = process.argv.includes("--dry-run");
  if (dryRun) { console.log(`dry run: configuration valid for ${new URL(config.baseUrl).host}; no request sent`); process.exit(0); }
  let result = await runJourney({ config });
  if (!result.ok && !result.critical) result = await runJourney({ config }); // one retry, as the review asked
  const text = formatReport(result, config);
  console.log(text);
  const delivered = await sendTelegram(process.env, text).catch(() => false);
  if (!delivered && !result.ok) console.error("alert could not be delivered");
  process.exit(result.ok ? 0 : 1);
}
