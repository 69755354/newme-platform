// RBAC: cron (x-cron-secret), service-only bounded expiry and COS deletion outbox
import { NextResponse } from "next/server";
import { runCosPresign } from "@/lib/cos-presign";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { genReqId } from "@/lib/logger";

type DeletionClaim = {
  queue_id: string;
  organization_id: string;
  file_id: string;
  object_key: string;
  terminal_status: string;
  attempt_count: number;
  lease_owner: string;
};

const DELETION_BATCH_LIMIT = 10;
const DELETION_CONCURRENCY = 3;
const DELETION_LEASE_SECONDS = 120;

function deletionClaims(value: unknown): value is DeletionClaim[] {
  return Array.isArray(value) && value.every((entry) => entry !== null
    && typeof entry === "object"
    && "queue_id" in entry && typeof entry.queue_id === "string"
    && "organization_id" in entry && typeof entry.organization_id === "string"
    && "file_id" in entry && typeof entry.file_id === "string"
    && "object_key" in entry && typeof entry.object_key === "string"
    && "terminal_status" in entry && typeof entry.terminal_status === "string"
    && "attempt_count" in entry && typeof entry.attempt_count === "number"
    && "lease_owner" in entry && typeof entry.lease_owner === "string");
}

function deletionEvidence(value: unknown): value is {
  absent: true;
  evidence: "cos_delete_204_head_404" | "cos_delete_404_head_404";
} {
  return value !== null && typeof value === "object"
    && "absent" in value && value.absent === true
    && "evidence" in value
    && (value.evidence === "cos_delete_204_head_404"
      || value.evidence === "cos_delete_404_head_404");
}

async function handle(request: Request) {
  const cronSecret = request.headers.get("x-cron-secret");
  if (!process.env.CRON_SECRET || cronSecret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const requestId = genReqId();
  const workerId = `pending-upload-cleanup:${requestId}`;
  const { data: candidates, error: candidateError } = await supabaseAdmin
    .from("tenant_file_objects")
    .select("organization_id")
    .eq("status", "pending")
    .lte("pending_expires_at", new Date().toISOString())
    .order("pending_expires_at", { ascending: true })
    .order("id", { ascending: true })
    .limit(100);
  if (candidateError) {
    return NextResponse.json({ error: "pending_upload_lookup_failed" }, { status: 503 });
  }
  const organizationIds = [...new Set(
    (candidates ?? []).map((candidate) => candidate.organization_id),
  )];
  let expiryQueued = 0;
  let remaining = 100;
  const failedOrganizations: string[] = [];
  for (const organizationId of organizationIds) {
    if (remaining === 0) break;
    const { data, error } = await supabaseAdmin.rpc("v4_expire_tenant_file_uploads", {
      p_organization_id: organizationId,
      p_limit: remaining,
      p_request_id: `${requestId}:${organizationId}`,
    });
    if (error || !data || typeof data !== "object" || Array.isArray(data)
      || typeof data.expired !== "number") {
      failedOrganizations.push(organizationId);
      continue;
    }
    expiryQueued += data.expired;
    remaining -= data.expired;
  }

  const { data: claimed, error: claimError } = await supabaseAdmin.rpc(
    "v4_claim_tenant_file_deletions",
    {
      p_limit: DELETION_BATCH_LIMIT,
      p_worker_id: workerId,
      p_lease_seconds: DELETION_LEASE_SECONDS,
    },
  );
  if (claimError || !deletionClaims(claimed)) {
    return NextResponse.json({ error: "storage_deletion_claim_failed" }, { status: 503 });
  }

  let deleted = 0;
  const failedQueueIds: string[] = [];
  let nextDeletionIndex = 0;
  const processClaimedDeletion = async () => {
    while (nextDeletionIndex < claimed.length) {
      const deletion = claimed[nextDeletionIndex++];
      let retryCode = "cos_delete_failed";
    try {
      const providerResult = await runCosPresign(["--delete", deletion.object_key]);
      if (!deletionEvidence(providerResult)) {
        retryCode = "provider_absence_missing";
        throw new Error(retryCode);
      }
      const { error } = await supabaseAdmin.rpc("v4_complete_tenant_file_deletion", {
        p_organization_id: deletion.organization_id,
        p_queue_id: deletion.queue_id,
        p_file_id: deletion.file_id,
        p_worker_id: workerId,
        p_provider_evidence: providerResult.evidence,
        p_request_id: `${requestId}:complete:${deletion.queue_id}`,
      });
      if (error) {
        retryCode = "database_complete_failed";
        throw new Error(retryCode);
      }
      deleted += 1;
    } catch {
      failedQueueIds.push(deletion.queue_id);
      await supabaseAdmin.rpc("v4_retry_tenant_file_deletion", {
        p_queue_id: deletion.queue_id,
        p_worker_id: workerId,
        p_error: retryCode,
        p_request_id: `${requestId}:retry:${deletion.queue_id}`,
      });
    }
    }
  };
  await Promise.all(Array.from(
    { length: Math.min(DELETION_CONCURRENCY, claimed.length) },
    () => processClaimedDeletion(),
  ));

  const hasFailures = failedOrganizations.length > 0 || failedQueueIds.length > 0;
  return NextResponse.json(
    {
      candidates_checked: candidates?.length ?? 0,
      organizations_checked: organizationIds.length,
      expiry_queued: expiryQueued,
      deletion_claimed: claimed.length,
      deleted,
      failed_organizations: failedOrganizations,
      failed_queue_ids: failedQueueIds,
      batch_limit: DELETION_BATCH_LIMIT,
      concurrency_limit: DELETION_CONCURRENCY,
      lease_seconds: DELETION_LEASE_SECONDS,
    },
    { status: hasFailures ? 502 : 200 },
  );
}

export async function GET(request: Request) {
  return handle(request);
}

export async function POST(request: Request) {
  return handle(request);
}
