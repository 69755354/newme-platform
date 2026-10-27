import "server-only";

/**
 * Server-side glue between a request body and the bottom-up labour model.
 *
 * It exists so the two routes that create quotations do not each grow their own
 * copy of "load the rate card, and decide what to do when it is missing".
 *
 * It is server-only for the same reason `./cable-costing/config` is: the rate
 * card must never be reachable from browser code. `src/lib/quotation-engine.ts`
 * therefore cannot call this — it is imported by the client quote wizard — which
 * is why the engine takes the loaded rate card as an argument instead.
 *
 * It also injects the cable-costing entry point, so the quotation engine does not
 * import the model statically and the model stays out of the client bundle.
 */

import { calculateCableCosting } from "./cable-costing";
import { CableCostingConfigError, loadCableCostingConfig } from "./cable-costing/config";
import { logger } from "./logger";
import type { BottomUpLabourRequest } from "./quotation-labour-basis.mjs";

/**
 * Normalise `body.bottom_up_labour` into a request for the quotation engine.
 *
 * @param raw the untrusted value from the request body; anything that is not an
 *        object means "not requested" and the caller keeps the percentage basis.
 * @returns null when the caller did not ask for the bottom-up model.
 *
 * A missing or malformed `CABLE_COSTING_CONFIG` yields `config: null` rather
 * than an exception. These routes answered before the rate card existed and must
 * keep answering: the engine then falls back to the percentage and reports
 * `install_labor_basis: "product_pct"` with a reason. The one outcome that is
 * never acceptable is a zero labour line, which would under-quote the job.
 */
export function buildBottomUpLabourRequest(
  raw: unknown,
  meta: { request_id: string; operation: string },
): BottomUpLabourRequest | null {
  if (typeof raw !== "object" || raw === null) return null;
  const requested = raw as Partial<BottomUpLabourRequest>;

  let config = null;
  try {
    config = loadCableCostingConfig();
  } catch (err) {
    if (!(err instanceof CableCostingConfigError)) throw err;
    // The message names the environment variable, never any part of its value.
    logger.warn(
      { err, request_id: meta.request_id, operation: meta.operation },
      "[Quotation] Cable costing configuration unavailable; labour falls back to the percentage basis",
    );
  }

  return {
    config,
    calculate: calculateCableCosting,
    area_sqm: requested.area_sqm,
    floors: requested.floors,
    point_quantities: requested.point_quantities,
    tier: requested.tier,
  };
}
