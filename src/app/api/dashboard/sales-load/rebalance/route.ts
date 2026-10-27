// RBAC: user (admin, boss)
import { NextRequest, NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase-server";
import { filterLeadTransferCandidateQuery } from "@/lib/lead-transfer-candidates.mjs";
import {
  classifyLeadReassignResult,
  deriveLeadTransferKey,
  isLeadTransferConflict,
  readLeadTransferBatchKey,
} from "@/lib/lead-transfer-batch.mjs";
import type { Json } from "@/types/database";

type LeadRebalanceUpdate = {
  id: string;
  assigned_to: string;
  expected_updated_at: string;
  idempotency_key: string;
};

type LeadRebalancePlan = {
  updates: LeadRebalanceUpdate[];
  untokened_lead_ids: string[];
  source_ids: string[];
  target_ids: string[];
};

function decodeLeadRebalancePlan(value: unknown): LeadRebalancePlan | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("lead rebalance plan lookup returned an invalid envelope");
  }
  const envelope = value as Record<string, unknown>;
  if (envelope.found === false && envelope.plan === undefined) return null;
  if (envelope.found !== true || !envelope.plan || typeof envelope.plan !== "object" || Array.isArray(envelope.plan)) {
    throw new Error("lead rebalance plan lookup returned an invalid result");
  }
  const plan = envelope.plan as Record<string, unknown>;
  if (!Array.isArray(plan.updates)
      || !Array.isArray(plan.untokened_lead_ids)
      || !Array.isArray(plan.source_ids)
      || !Array.isArray(plan.target_ids)
      || !plan.untokened_lead_ids.every((id) => typeof id === "string")
      || !plan.source_ids.every((id) => typeof id === "string")
      || !plan.target_ids.every((id) => typeof id === "string")
      || !plan.updates.every((item) => item && typeof item === "object" && !Array.isArray(item)
        && typeof item.id === "string"
        && typeof item.assigned_to === "string"
        && typeof item.expected_updated_at === "string"
        && typeof item.idempotency_key === "string")) {
    throw new Error("stored lead rebalance plan has an invalid shape");
  }
  return plan as LeadRebalancePlan;
}

// ─── POST /api/dashboard/sales-load/rebalance ───
// Round-robin transfer of transferable leads from overloaded reps to underloaded reps
//
// Round-4 finding R6. This route used to move each lead with a bare
// `update({ assigned_to }).eq("id", ...)`, which meant three things at once:
//
//   * no compare-and-set. It read the leads, computed a plan, and then wrote the
//     plan — so a transfer somebody performed in between was overwritten, and
//     the rebalance reported success.
//   * no audit trail. public.transfer_history, activities, business_events and
//     the assignee's notification are written by reassign_lead_atomic() and by
//     nothing else, so leads moved by this route moved invisibly.
//   * no idempotency. A retried or double-clicked rebalance ran the whole
//     round-robin again from the new loads.
//
// All three are the same fix: go through the routine, with the token read in this
// request and a key derived from a caller-supplied batch key. The route now
// requires that batch key — a rebalance whose caller cannot survive a retry is
// exactly the caller this protects against.
export async function POST(request: NextRequest) {
  const bearerToken = request.headers.get("authorization")?.replace("Bearer ", "") ?? undefined;
  const cookieHeader = request.headers.get("cookie") ?? "";
  const supabase = await createServerSupabase(bearerToken, cookieHeader);

  // 1. Authenticate
  const { data: { user }, error: authErr } = await supabase.auth.getUser();
  if (authErr || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // 2. Check admin/boss role
  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();

  const role = profile?.role ?? "sales";
  if (role !== "admin" && role !== "boss") {
    return NextResponse.json({ error: "Only admins can rebalance" }, { status: 403 });
  }

  // 3. The batch key, before any read. Every lead's idempotency key is derived
  //    from it, so without one this request cannot be retried safely and is
  //    refused rather than run.
  const body = await request.json().catch(() => ({}));
  const batchKey = readLeadTransferBatchKey({
    body,
    headerValue: request.headers.get("idempotency-key"),
  });
  if (!batchKey) {
    return NextResponse.json(
      { error: "batchKey must be a UUID", code: "INVALID_REQUEST" },
      { status: 400 }
    );
  }

  try {
    // A persisted plan is consulted before any load read or no-op decision.
    // After a partial first attempt, the load distribution has changed; planning
    // again at that point is not a retry of the original request.
    const { data: lookupEnvelope, error: lookupError } = await supabase.rpc(
      "get_or_create_lead_rebalance_plan",
      { p_batch_key: batchKey, p_plan: undefined },
    );
    if (lookupError) throw lookupError;
    let plan = decodeLeadRebalancePlan(lookupEnvelope);

    if (!plan) {
      // ── Fetch all eligible reps and compute the first plan ──
      const repsQuery = supabase
        .from("profiles")
        .select("id, full_name, email, role, is_active");
      const eligibleRepsQuery = filterLeadTransferCandidateQuery(
        repsQuery as never
      ) as typeof repsQuery;
      eligibleRepsQuery.order("id", { ascending: true });
      const { data: salesReps, error: salesRepsErr } = await eligibleRepsQuery;
      if (salesRepsErr) throw salesRepsErr;

      const reps = salesReps ?? [];
      const repIds = reps.map((rep) => rep.id);
      const { data: allLeads, error: allLeadsError } = repIds.length > 0
        ? await supabase.from("leads").select("id, assigned_to").in("assigned_to", repIds)
        : { data: [], error: null };
      if (allLeadsError) throw allLeadsError;

      const leadsByRep: Record<string, number> = {};
      for (const lead of allLeads ?? []) {
        if (lead.assigned_to) {
          leadsByRep[lead.assigned_to] = (leadsByRep[lead.assigned_to] ?? 0) + 1;
        }
      }
      const leadCounts = reps.map((rep) => ({
        id: rep.id,
        name: rep.full_name || rep.email || rep.id,
        count: leadsByRep[rep.id] ?? 0,
      }));
      const avgLoad = leadCounts.length > 0
        ? leadCounts.reduce((sum, rep) => sum + rep.count, 0) / leadCounts.length
        : 0;
      const imbalanceThreshold = avgLoad * 1.5;
      const overloaded = leadCounts.filter((rep) => rep.count > imbalanceThreshold);
      const underloaded = leadCounts.filter((rep) => rep.count < avgLoad);

      let transferable: Array<{
        id: string;
        assigned_to: string | null;
        customer_name: string | null;
        updated_at: string | null;
      }> = [];
      if (overloaded.length > 0 && underloaded.length > 0) {
        const { data: transferableRaw, error: transferableError } = await supabase
          .from("leads")
          .select("id, assigned_to, customer_name, updated_at")
          .in("assigned_to", overloaded.map((rep) => rep.id))
          .eq("stage", "new")
          .is("last_contact_date", null)
          .order("id", { ascending: true });
        if (transferableError) throw transferableError;
        transferable = transferableRaw ?? [];
      }

      const updates: LeadRebalanceUpdate[] = [];
      const untokenedLeadIds: string[] = [];
      let index = 0;
      for (const lead of transferable) {
        const target = underloaded[index % underloaded.length];
        if (lead.assigned_to !== target.id) {
          if (typeof lead.updated_at === "string" && lead.updated_at !== "") {
            updates.push({
              id: lead.id,
              assigned_to: target.id,
              expected_updated_at: lead.updated_at,
              idempotency_key: deriveLeadTransferKey(batchKey, lead.id),
            });
          } else {
            untokenedLeadIds.push(lead.id);
          }
        }
        index++;
      }

      const proposedPlan: LeadRebalancePlan = {
        updates,
        untokened_lead_ids: untokenedLeadIds,
        source_ids: overloaded.map((rep) => rep.id),
        target_ids: underloaded.map((rep) => rep.id),
      };
      const { data: claimedEnvelope, error: claimError } = await supabase.rpc(
        "get_or_create_lead_rebalance_plan",
        { p_batch_key: batchKey, p_plan: proposedPlan as Json },
      );
      if (claimError) throw claimError;
      plan = decodeLeadRebalancePlan(claimedEnvelope);
      if (!plan) throw new Error("lead rebalance plan was not persisted");
    }

    const updates = plan.updates;
    const untokenedLeadIds = plan.untokened_lead_ids;
    if (updates.length === 0 && untokenedLeadIds.length === 0) {
      return NextResponse.json({
        message: "No eligible lead transfers were present in this rebalance plan.",
        transferred: 0,
        replayed: 0,
        unchanged: 0,
        conflicts: 0,
        from: plan.source_ids,
        to: plan.target_ids,
      });
    }

    // ── Execute the plan, one audited compare-and-set per lead ──
    //
    // Four outcomes, counted apart. A lead whose owner moved since the read above
    // is a `conflict`, not a `failure`: the routine refused because somebody else
    // had already decided where that lead goes, which is the correct answer and
    // not an error to retry blindly. A lead whose key was already spent is a
    // `replay` — attempt 1 moved it, this attempt did not — and neither a
    // conflict nor a replay is allowed to inflate `transferred`.
    let transferred = 0;
    let replayed = 0;
    let unchanged = 0;
    const conflictLeadIds: string[] = [];
    const failedLeadIds: string[] = [...untokenedLeadIds];
    for (const update of updates) {
      const { data: result, error } = await supabase.rpc("reassign_lead_atomic", {
        p_lead_id: update.id,
        p_new_assignee: update.assigned_to,
        p_expected_updated_at: update.expected_updated_at,
        p_idempotency_key: update.idempotency_key,
        p_reason: "sales_load_rebalance",
      });
      if (error) {
        if (isLeadTransferConflict(error)) {
          conflictLeadIds.push(update.id);
        } else {
          failedLeadIds.push(update.id);
        }
        continue;
      }
      const outcome = classifyLeadReassignResult(result);
      if (outcome === "replayed") replayed++;
      else if (outcome === "unchanged") unchanged++;
      else transferred++;
    }

    if (failedLeadIds.length > 0) {
      return NextResponse.json({
        error: `Rebalance partially failed for ${failedLeadIds.length} lead(s).`,
        transferred,
        replayed,
        unchanged,
        conflicts: conflictLeadIds.length,
        failed: failedLeadIds.length,
      }, { status: 500 });
    }

    return NextResponse.json({
      message: conflictLeadIds.length > 0
        ? `Rebalanced ${transferred} leads across ${plan.target_ids.length} reps; ${conflictLeadIds.length} skipped because they were reassigned while this ran.`
        : `Rebalanced ${transferred} leads across ${plan.target_ids.length} reps.`,
      transferred,
      replayed,
      unchanged,
      conflicts: conflictLeadIds.length,
      from: plan.source_ids,
      to: plan.target_ids,
    });
  } catch (err: any) {
    console.error("Rebalance API error:", err);
    return NextResponse.json({ error: "Failed to rebalance" }, { status: 500 });
  }
}
