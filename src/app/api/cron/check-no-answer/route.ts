// RBAC: cron (x-cron-secret); tenant work is partitioned by active organization.
import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";

export async function GET(request: Request) {
  return handleCron(request);
}

export async function POST(request: Request) {
  return handleCron(request);
}

async function handleCron(request: Request) {
  const cronSecret = request.headers.get("x-cron-secret");
  if (!cronSecret || cronSecret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const runId = crypto.randomUUID();
  const { error: expiryError } = await supabaseAdmin.rpc(
    "v4_expire_support_sessions",
    { p_request_id: `no-answer-expiry:${runId}` },
  );
  if (expiryError) {
    return NextResponse.json({ error: "support_expiry_failed" }, { status: 503 });
  }
  const { data: organizations, error: organizationError } = await supabaseAdmin
    .from("organizations")
    .select("id")
    .eq("status", "active");
  if (organizationError) {
    return NextResponse.json({ error: "organization_lookup_failed" }, { status: 503 });
  }
  const results: unknown[] = [];
  const failedOrganizations: string[] = [];
  for (const organization of organizations ?? []) {
    const { data, error } = await supabaseAdmin.rpc(
      "v4_process_no_answer_worker",
      {
        p_organization_id: organization.id,
        p_request_id: `no-answer:${runId}:${organization.id}`,
      },
    );
    if (error) failedOrganizations.push(organization.id);
    else results.push(data);
  }
  if (failedOrganizations.length > 0) {
    return NextResponse.json(
      { error: "tenant_worker_failed", run_id: runId, failed_organizations: failedOrganizations },
      { status: 503 },
    );
  }
  return NextResponse.json({ run_id: runId, organizations: results });
}
