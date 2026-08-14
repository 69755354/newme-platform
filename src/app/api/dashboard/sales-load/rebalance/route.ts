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
    // ── Fetch all sales reps ──
    const repsQuery = supabase
      .from("profiles")
      .select("id, full_name, email, role, is_active");
    const eligibleRepsQuery = filterLeadTransferCandidateQuery(
      repsQuery as never
    ) as typeof repsQuery;
    const { data: salesReps, error: salesRepsErr } = await eligibleRepsQuery;
    if (salesRepsErr) throw salesRepsErr;

    const reps = salesReps ?? [];
    const repIds = reps.map((r: any) => r.id);

    // ── Get leads per rep ──
    const { data: allLeads } = await supabase
      .from("leads")
      .select("id, assigned_to")
      .in("assigned_to", repIds);

    const leadsByRep: Record<string, number> = {};
    (allLeads ?? []).forEach((l: any) => {
      leadsByRep[l.assigned_to] = (leadsByRep[l.assigned_to] ?? 0) + 1;
    });

    // ── Identify overloaded and underloaded ──
    const leadCounts = reps.map((r: any) => ({
      id: r.id,
      name: r.full_name || r.email,
      count: leadsByRep[r.id] ?? 0,
    }));

    const avgLoad =
      leadCounts.length > 0
        ? leadCounts.reduce((s, r) => s + r.count, 0) / leadCounts.length
        : 0;
    const imbalanceThreshold = avgLoad * 1.5;

    const overloaded = leadCounts.filter((r) => r.count > imbalanceThreshold);
    const underloaded = leadCounts.filter((r) => r.count < avgLoad);

    if (overloaded.length === 0 || underloaded.length === 0) {
      return NextResponse.json({
        message: "No imbalance detected. Nothing to rebalance.",
        transferred: 0,
      });
    }

    // ── Find transferable leads from overloaded reps ──
    // Transferable: stage='new' AND last_contact_date IS NULL
    // `updated_at` is the compare-and-set token, so it is read here, with the
    // plan, and handed back to the routine unchanged. Selecting it later — or not
    // at all, which is what this route used to do — is what turns the comparison
    // in reassign_lead_atomic() into a no-op.
    const overloadedIds = overloaded.map((r) => r.id);
    const { data: transferableRaw } = await supabase
      .from("leads")
      .select("id, assigned_to, customer_name, updated_at")
      .in("assigned_to", overloadedIds)
      .eq("stage", "new")
      .is("last_contact_date", null);

    const transferable = transferableRaw ?? [];

    if (transferable.length === 0) {
      return NextResponse.json({
        message: "No transferable leads found (new leads with no contact).",
        transferred: 0,
      });
    }

    // ── Round-robin assign ──
    //
    // A lead with no updated_at is dropped rather than transferred. The column is
    // NOT NULL with a default in production and the trigger keeps it that way, so
    // this is unreachable there — but the alternative to dropping it is passing
    // null as the token, and reassign_lead_atomic() reads null as "do not
    // compare", which is precisely the behaviour this route is here to stop.
    let idx = 0;
    const updates: { id: string; assigned_to: string; expected_updated_at: string }[] = [];
    const untokenedLeadIds: string[] = [];

    for (const lead of transferable) {
      const target = underloaded[idx % underloaded.length];
      if (lead.assigned_to !== target.id) {
        if (typeof lead.updated_at === "string" && lead.updated_at !== "") {
          updates.push({
            id: lead.id,
            assigned_to: target.id,
            expected_updated_at: lead.updated_at,
          });
        } else {
          untokenedLeadIds.push(lead.id);
        }
      }
      idx++;
    }

    if (updates.length === 0 && untokenedLeadIds.length === 0) {
      return NextResponse.json({
        message: "All transferable leads already assigned to underloaded reps.",
        transferred: 0,
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
        p_idempotency_key: deriveLeadTransferKey(batchKey, update.id),
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
        ? `Rebalanced ${transferred} leads across ${underloaded.length} reps; ${conflictLeadIds.length} skipped because they were reassigned while this ran.`
        : `Rebalanced ${transferred} leads across ${underloaded.length} reps.`,
      transferred,
      replayed,
      unchanged,
      conflicts: conflictLeadIds.length,
      from: overloaded.map((r) => r.name),
      to: underloaded.map((r) => r.name),
    });
  } catch (err: any) {
    console.error("Rebalance API error:", err);
    return NextResponse.json({ error: "Failed to rebalance" }, { status: 500 });
  }
}
