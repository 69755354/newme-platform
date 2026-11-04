#!/usr/bin/env node
// Create the "any NEW production error -> notify immediately" Sentry alert rules
// from infra/sentry/alert-rules.json (S7 item 1). Dry run by default: it only
// prints what it would create. --apply needs SENTRY_AUTH_TOKEN (project:write) in
// the environment; the token is never printed. Existing rules with the same name
// are left alone, so re-running is safe.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const API = "https://de.sentry.io/api/0";

/** Pure planner: which rules are missing, and with which copied actions. */
export function planRules(spec, existingRules) {
  const source = existingRules.find((rule) => rule.name === spec.copyActionsFrom);
  const actions = source?.actions ?? [];
  const have = new Set(existingRules.map((rule) => rule.name));
  const create = spec.rules.filter((rule) => !have.has(rule.name)).map((rule) => ({ ...rule, actions }));
  return { create, actionsFound: actions.length > 0, skipped: spec.rules.filter((r) => have.has(r.name)).map((r) => r.name) };
}

async function sentry(fetchImpl, token, path, init = {}) {
  const response = await fetchImpl(`${API}${path}`, {
    ...init, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`sentry_http_${response.status}`);
  return response.json();
}

export async function applyRules(spec, { fetchImpl = fetch, token, apply }) {
  const base = `/projects/${spec.organization}/${spec.project}/rules/`;
  const existing = await sentry(fetchImpl, token, base);
  const plan = planRules(spec, existing);
  if (!plan.actionsFound) throw new Error(`no actions to copy: rule "${spec.copyActionsFrom}" not found or has none`);
  if (apply) for (const rule of plan.create) await sentry(fetchImpl, token, base, { method: "POST", body: JSON.stringify(rule) });
  return plan;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const spec = JSON.parse(readFileSync(new URL("../infra/sentry/alert-rules.json", import.meta.url), "utf8"));
  const token = process.env.SENTRY_AUTH_TOKEN;
  if (!token) { console.error("SENTRY_AUTH_TOKEN is required (it is read from the environment and never printed)"); process.exit(2); }
  try {
    const apply = process.argv.includes("--apply");
    const plan = await applyRules(spec, { token, apply });
    console.log(`${apply ? "created" : "would create"}: ${plan.create.map((r) => r.name).join(" | ") || "nothing"}; already present: ${plan.skipped.join(" | ") || "none"}`);
  } catch (error) {
    console.error(`failed: ${error.message}`);
    process.exit(1);
  }
}
