// RBAC: user (authenticated)
//
// Any signed-in employee (admin | boss | operator | sales) may price a project:
// this is an internal estimating tool, so no role is filtered here.
// Authorization is the caller-scoped Supabase session only — never service_role
// (03_ARCHITECTURE_RULES.yaml rule_102).
//
// PUBLIC REPOSITORY / PRICE BOUNDARY: no price, rate or coefficient appears in
// this file. The rate card is loaded server-side from `CABLE_COSTING_CONFIG` and
// only the computed result crosses the wire. The arithmetic itself lives in the
// single domain module `src/lib/cable-costing` (rule_014) and is not re-stated
// here.

import { NextRequest, NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase-server";
import { applyPrivateNoStore } from "@/lib/request-auth-context";
import { genReqId, logger } from "@/lib/logger";
import { CableCostingInputError, calculateCableCosting } from "@/lib/cable-costing";
import type { CableCostingInput } from "@/lib/cable-costing";
import { CableCostingConfigError, loadCableCostingConfig } from "@/lib/cable-costing/config";

/**
 * POST /api/cable-costing/calculate
 *
 * Input:  { areaSqm: number, floors: number,
 *           quantities: Record<pointId, number>, tier: "internal" | "client" }
 * Output: { result: CableCostingResult }  — the engine's value, unmodified.
 *
 * Errors: 401 not signed in · 400 unparseable body or rejected input ·
 *         503 `CABLE_COSTING_CONFIG` absent or invalid ·
 *         500 anything else (message withheld in production).
 */
export async function POST(request: NextRequest) {
  const request_id = genReqId();
  try {
    const bearerToken = request.headers.get("authorization")?.replace("Bearer ", "") ?? undefined;
    const cookieHeader = request.headers.get("cookie") ?? "";
    const supabase = await createServerSupabase(bearerToken, cookieHeader);
    const { data: { user }, error: authErr } = await supabase.auth.getUser();
    if (authErr || !user) {
      return applyPrivateNoStore(NextResponse.json({ error: "Unauthorized" }, { status: 401 }));
    }

    // A body that is not JSON is a caller error, so it is separated from the
    // 500 branch below rather than being reported as a server fault.
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return applyPrivateNoStore(
        NextResponse.json({ error: "Request body must be valid JSON" }, { status: 400 }),
      );
    }

    // The engine owns input validation (it is the only place that knows which
    // point ids exist and are enabled), so the body is handed over as-is and
    // `CableCostingInputError` is mapped to 400. Duplicating field checks here
    // would create a second, looser copy of that rule.
    const config = loadCableCostingConfig();
    const result = calculateCableCosting(body as CableCostingInput, config);

    return applyPrivateNoStore(NextResponse.json({ result }));
  } catch (err) {
    if (err instanceof CableCostingInputError) {
      return applyPrivateNoStore(NextResponse.json({ error: err.message }, { status: 400 }));
    }
    // A missing or malformed rate card is an operator task, not a caller error:
    // answer 503 and say which variable to inject. The message carries the
    // variable name and the file to put it in, never any part of its value.
    if (err instanceof CableCostingConfigError) {
      logger.error(
        { err, request_id, operation: "cable_costing_calculate" },
        "[Cable Costing Calculate] Costing configuration unavailable",
      );
      return applyPrivateNoStore(NextResponse.json({ error: err.message }, { status: 503 }));
    }
    logger.error(
      { err, request_id, operation: "cable_costing_calculate" },
      "[Cable Costing Calculate] Error",
    );
    const message = process.env.NODE_ENV === "production"
      ? "Internal server error"
      : err instanceof Error ? err.message : String(err);
    return applyPrivateNoStore(
      NextResponse.json({ error: message || "Internal error" }, { status: 500 }),
    );
  }
}
