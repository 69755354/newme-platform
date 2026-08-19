// RBAC: user (authenticated)
//
// Any signed-in employee (admin | boss | operator | sales) may read the point
// catalogue: this is an internal estimating tool, so no role is filtered here.
// Authorization is the caller-scoped Supabase session only — never service_role
// (03_ARCHITECTURE_RULES.yaml rule_102).
//
// PUBLIC REPOSITORY / PRICE BOUNDARY: this endpoint answers with the point list
// used to render the input form and NOTHING priced. Cable ids, per-metre rates,
// per-point tariffs, labour rates and coefficients all stay inside the
// server-only configuration loaded from `CABLE_COSTING_CONFIG`; only
// `getPointCatalogue()`'s price-free projection is serialised.

import { NextRequest, NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase-server";
import { applyPrivateNoStore } from "@/lib/request-auth-context";
import { genReqId, logger } from "@/lib/logger";
import { getPointCatalogue } from "@/lib/cable-costing";
import type { Tier } from "@/lib/cable-costing";
import { CableCostingConfigError, loadCableCostingConfig } from "@/lib/cable-costing/config";

/**
 * GET /api/cable-costing/catalogue
 *
 * Output: { modelVersion, currency: "AED", tiers: ["internal","client"],
 *           points: [{ id, nameCn, nameEn, system, topology }] }
 *
 * Errors: 401 not signed in · 503 `CABLE_COSTING_CONFIG` absent or invalid ·
 *         500 anything else (message withheld in production).
 */

// The response is derived from the caller's session and from runtime
// configuration, so it must never be prerendered or held by a shared cache.
export const dynamic = "force-dynamic";

const TIERS: readonly Tier[] = ["internal", "client"];

export async function GET(request: NextRequest) {
  const request_id = genReqId();
  try {
    const bearerToken = request.headers.get("authorization")?.replace("Bearer ", "") ?? undefined;
    const cookieHeader = request.headers.get("cookie") ?? "";
    const supabase = await createServerSupabase(bearerToken, cookieHeader);
    const { data: { user }, error: authErr } = await supabase.auth.getUser();
    if (authErr || !user) {
      return applyPrivateNoStore(NextResponse.json({ error: "Unauthorized" }, { status: 401 }));
    }

    const config = loadCableCostingConfig();

    return applyPrivateNoStore(
      NextResponse.json({
        modelVersion: config.modelVersion,
        currency: config.currency,
        tiers: TIERS,
        points: getPointCatalogue(config),
      }),
    );
  } catch (err) {
    // A missing or malformed rate card is an operator task, not a caller error:
    // answer 503 and say which variable to inject. The message carries the
    // variable name and the file to put it in, never any part of its value.
    if (err instanceof CableCostingConfigError) {
      logger.error(
        { err, request_id, operation: "cable_costing_catalogue" },
        "[Cable Costing Catalogue] Costing configuration unavailable",
      );
      return applyPrivateNoStore(NextResponse.json({ error: err.message }, { status: 503 }));
    }
    logger.error(
      { err, request_id, operation: "cable_costing_catalogue" },
      "[Cable Costing Catalogue] Error",
    );
    const message = process.env.NODE_ENV === "production"
      ? "Internal server error"
      : err instanceof Error ? err.message : String(err);
    return applyPrivateNoStore(
      NextResponse.json({ error: message || "Internal error" }, { status: 500 }),
    );
  }
}
