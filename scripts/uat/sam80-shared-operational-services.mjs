import { readFile } from "node:fs/promises";
import { createClient } from "@supabase/supabase-js";

const required = (name) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name}_required`);
  return value;
};
const expectedSha = required("SAM80_EXPECTED_RELEASE_SHA");
if (!/^[0-9a-f]{40}$/.test(expectedSha)) throw new Error("release_sha_invalid");
const manifest = JSON.parse(await readFile("/runner/release/manifest.json", "utf8"));
if (manifest.git_sha !== expectedSha) throw new Error("release_sha_mismatch");

const baseUrl = required("SAM80_BASE_URL").replace(/\/$/, "");
const organizationId = required("SAM80_ORGANIZATION_ID");
const requesterToken = required("SAM80_REQUESTER_TOKEN");
const approverToken = required("SAM80_APPROVER_TOKEN");
const supabaseUrl = required("NEXT_PUBLIC_SUPABASE_URL");
const serviceKey = required("SUPABASE_SERVICE_ROLE_KEY");
const marker = `SAM80-${expectedSha.slice(0, 12)}-${Date.now()}`;
const created = { work: [], approval: [], event: [], notification: [], outbox: [], job: [], report: [] };
const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

async function api(path, token, init = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`,
      "x-newme-organization-id": organizationId, ...(init.headers ?? {}) },
  });
  const body = await response.json().catch(() => null);
  return { response, body };
}

async function collect() {
  const workIds = [...new Set(created.work)];
  const approvalIds = [...new Set(created.approval)];
  const jobLookup = await admin.from("shared_jobs").select("id").eq("organization_id", organizationId)
    .ilike("idempotency_key", `${marker}%`);
  if (jobLookup.error) throw new Error("cleanup_discovery_failed");
  created.job.push(...(jobLookup.data ?? []).map((row) => row.id));
  const resourceIds = [...new Set([...workIds, ...approvalIds, ...created.job])];
  if (resourceIds.length > 0) {
    const events = await admin.from("shared_timeline_events").select("id").eq("organization_id", organizationId)
      .in("resource_id", resourceIds);
    if (events.error) throw new Error("cleanup_discovery_failed");
    created.event.push(...(events.data ?? []).map((row) => row.id));
    const outbox = await admin.from("shared_outbox").select("id").eq("organization_id", organizationId)
      .in("aggregate_id", resourceIds);
    if (outbox.error) throw new Error("cleanup_discovery_failed");
    created.outbox.push(...(outbox.data ?? []).map((row) => row.id));
  }
  if (created.event.length > 0) {
    const notifications = await admin.from("shared_notifications").select("id").eq("organization_id", organizationId)
      .in("source_event_id", [...new Set(created.event)]);
    if (notifications.error) throw new Error("cleanup_discovery_failed");
    created.notification.push(...(notifications.data ?? []).map((row) => row.id));
  }
  if (created.job.length > 0) {
    const reports = await admin.from("shared_report_snapshots").select("id").eq("organization_id", organizationId)
      .in("generated_by_job_id", [...new Set(created.job)]);
    if (reports.error) throw new Error("cleanup_discovery_failed");
    created.report.push(...(reports.data ?? []).map((row) => row.id));
  }
}

async function cleanup() {
  await collect();
  const order = [["shared_report_snapshots", "report"], ["shared_notifications", "notification"],
    ["shared_outbox", "outbox"], ["shared_timeline_events", "event"], ["shared_approval_requests", "approval"],
    ["shared_jobs", "job"], ["shared_work_items", "work"]];
  for (const [table, key] of order) {
    const ids = [...new Set(created[key])];
    if (ids.length > 0) {
      const { error } = await admin.from(table).delete().eq("organization_id", organizationId).in("id", ids);
      if (error) throw new Error(`cleanup_${key}_failed`);
    }
  }
  for (const [table, key] of order) {
    const ids = [...new Set(created[key])];
    if (ids.length === 0) continue;
    const { count, error } = await admin.from(table).select("id", { head: true, count: "exact" })
      .eq("organization_id", organizationId).in("id", ids);
    if (error || count !== 0) throw new Error("cleanup_residue_detected");
  }
}

try {
  const health = await fetch(`${baseUrl}/api/health`, { redirect: "manual" });
  const healthBody = await health.json().catch(() => null);
  if (health.status !== 200 || healthBody?.status !== "ok") throw new Error("health_gate_failed");

  const unauthorized = await api("/api/operations/summary", "invalid");
  if (unauthorized.response.status !== 401) throw new Error("unauthorized_gate_failed");
  const work = await api("/api/operations/work-items", requesterToken, { method: "POST",
    body: JSON.stringify({ title: marker, priority: "normal", idempotency_key: marker }) });
  if (work.response.status !== 201 || !work.body?.data?.id) throw new Error("work_create_failed");
  created.work.push(work.body.data.id);
  const approval = await api("/api/operations/approvals", requesterToken, { method: "POST",
    body: JSON.stringify({ action_key: "work.complete", resource_type: "shared_work_item",
      resource_id: work.body.data.id, payload: { marker_code: marker }, idempotency_key: `${marker}-approval` }) });
  if (approval.response.status !== 201 || !approval.body?.data?.id) throw new Error("approval_request_failed");
  created.approval.push(approval.body.data.id);
  const selfDecision = await api(`/api/operations/approvals/${approval.body.data.id}`, requesterToken,
    { method: "PATCH", body: JSON.stringify({ decision: "approved", reason_code: "uat_approve" }) });
  if (selfDecision.response.status !== 403 && selfDecision.response.status !== 404) throw new Error("independent_approval_gate_failed");
  const decision = await api(`/api/operations/approvals/${approval.body.data.id}`, approverToken,
    { method: "PATCH", body: JSON.stringify({ decision: "approved", reason_code: "uat_approve" }) });
  if (decision.response.status !== 200 || decision.body?.data?.status !== "approved") throw new Error("approval_decision_failed");
  const crossOrganization = await api("/api/operations/work-items", requesterToken, {
    headers: { "x-newme-organization-id": "00000000-0000-4000-8000-000000000001" },
  });
  if (crossOrganization.response.status !== 403) throw new Error("cross_organization_gate_failed");
  const timeline = await api("/api/operations/timeline?limit=100", requesterToken);
  if (timeline.response.status !== 200 || !Array.isArray(timeline.body?.data)) throw new Error("timeline_gate_failed");
  await collect();
  await cleanup();
  process.stdout.write(JSON.stringify({ ok: true, sam: "SAM-80", release_sha: expectedSha,
    project_ref: new URL(supabaseUrl).hostname.split(".")[0], checks: 7, cleanup: "verified" }));
} catch (error) {
  await cleanup().catch(() => undefined);
  process.stdout.write(JSON.stringify({ ok: false, sam: "SAM-80", release_sha: expectedSha,
    error: error instanceof Error ? error.message : "uat_failed" }));
  process.exitCode = 1;
}
