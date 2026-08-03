// RBAC: selected organization capabilities kpi.targets.read / kpi.targets.manage
import { NextRequest, NextResponse } from "next/server";
import {
  OrganizationAuthorizationError,
  resolveOrganizationAuthorization,
} from "@/lib/organization-authorization";
import { RequestAuthError } from "@/lib/request-auth-context";
import type { Json } from "@/types/database";

type TargetInput = {
  target_type: "signing" | "collection";
  target_amount: number;
  assigned_to: string | null;
  notes?: string;
};

function periodValue(value: unknown): value is string {
  return typeof value === "string" && /^[0-9]{4}-(0[1-9]|1[0-2])$/.test(value);
}

function targetInputs(value: unknown): value is TargetInput[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 100) return false;
  return value.every((target) => {
    if (!target || typeof target !== "object" || Array.isArray(target)) return false;
    const row = target as Record<string, unknown>;
    return (row.target_type === "signing" || row.target_type === "collection")
      && typeof row.target_amount === "number"
      && Number.isFinite(row.target_amount)
      && row.target_amount > 0
      && (row.assigned_to === null || typeof row.assigned_to === "string")
      && (row.notes === undefined
        || (typeof row.notes === "string" && row.notes.length <= 2000));
  });
}

function authorizationFailure(error: unknown) {
  if (error instanceof OrganizationAuthorizationError || error instanceof RequestAuthError) {
    return NextResponse.json({ error: error.code }, { status: error.status });
  }
  return null;
}

// GET /api/kpi/targets?period=2026-06
export async function GET(request: NextRequest) {
  try {
    const access = await resolveOrganizationAuthorization(
      request,
      "kpi.targets.read",
      "read",
    );
    const period = new URL(request.url).searchParams.get("period");
    if (period !== null && !periodValue(period)) {
      return NextResponse.json({ error: "invalid_period" }, { status: 400 });
    }
    let query = access.context.supabase
      .from("kpi_targets")
      .select("*, profiles(full_name)")
      .eq("organization_id", access.organizationId);
    if (period) query = query.eq("period", period);
    const { data, error } = await query.order(
      "assigned_to",
      { ascending: true, nullsFirst: true },
    );
    if (error) {
      return NextResponse.json({ error: "kpi_targets_lookup_failed" }, { status: 503 });
    }
    return NextResponse.json({ data });
  } catch (error) {
    return authorizationFailure(error)
      ?? NextResponse.json({ error: "kpi_targets_unavailable" }, { status: 503 });
  }
}

// POST /api/kpi/targets - atomically replace one organization's period.
export async function POST(request: NextRequest) {
  try {
    const access = await resolveOrganizationAuthorization(
      request,
      "kpi.targets.manage",
      "write",
    );
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    if (!body || !periodValue(body.period) || !targetInputs(body.targets)) {
      return NextResponse.json({ error: "invalid_kpi_targets" }, { status: 400 });
    }
    const targets: Json = body.targets.map((target) => ({
      target_type: target.target_type,
      target_amount: target.target_amount,
      assigned_to: target.assigned_to,
      notes: target.notes ?? null,
    }));
    const { data, error } = await access.context.supabase.rpc(
      "v4_replace_kpi_targets",
      {
        p_organization_id: access.organizationId,
        p_period: body.period,
        p_targets: targets,
        p_request_id: access.context.requestId,
      },
    );
    if (error) {
      return NextResponse.json({ error: "kpi_targets_replace_failed" }, { status: 503 });
    }
    return NextResponse.json({ data });
  } catch (error) {
    return authorizationFailure(error)
      ?? NextResponse.json({ error: "kpi_targets_unavailable" }, { status: 503 });
  }
}

// DELETE /api/kpi/targets?period=2026-06 - atomic scoped delete via empty replacement.
export async function DELETE(request: NextRequest) {
  try {
    const access = await resolveOrganizationAuthorization(
      request,
      "kpi.targets.manage",
      "write",
    );
    const period = new URL(request.url).searchParams.get("period");
    if (!periodValue(period)) {
      return NextResponse.json({ error: "invalid_period" }, { status: 400 });
    }
    const { error } = await access.context.supabase.rpc("v4_replace_kpi_targets", {
      p_organization_id: access.organizationId,
      p_period: period,
      p_targets: [],
      p_request_id: access.context.requestId,
    });
    if (error) {
      return NextResponse.json({ error: "kpi_targets_delete_failed" }, { status: 503 });
    }
    return NextResponse.json({ success: true });
  } catch (error) {
    return authorizationFailure(error)
      ?? NextResponse.json({ error: "kpi_targets_unavailable" }, { status: 503 });
  }
}
