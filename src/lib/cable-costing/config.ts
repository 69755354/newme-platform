import "server-only";

/**
 * Server-only loader for the cable & pulling-labour costing configuration.
 *
 * This repository is public, so it carries NO prices, labour rates, coefficients
 * or per-point tariffs — not even as a fallback. The whole configuration arrives
 * at runtime as base64-encoded JSON in the `CABLE_COSTING_CONFIG` environment
 * variable (production: `/etc/newme/newme-runtime.env`, read by the systemd unit
 * `newme-platform.service`).
 *
 * The variable must NOT be named `NEXT_PUBLIC_*`: that would ship the rate card
 * to the browser and trip `scripts/check-supabase-boundaries.mjs`.
 *
 * Generating the value (structure documented in `./types.ts`):
 *   base64 -w0 cable-costing-config.json
 *
 * Anything missing or malformed throws `CableCostingConfigError`; there is
 * deliberately no built-in rate card to fall back to.
 */

import { CableCostingConfigError, validateCableCostingConfig } from "./engine";
import type { CableCostingConfig } from "./types";

export const CABLE_COSTING_CONFIG_ENV = "CABLE_COSTING_CONFIG";

const ADMIN_HINT =
  `Set ${CABLE_COSTING_CONFIG_ENV} in /etc/newme/newme-runtime.env to the base64 encoding of the ` +
  "cable costing configuration JSON (generate it from the cost model spec, then restart " +
  "newme-platform.service). The configuration is intentionally absent from this repository.";

let cachedRaw: string | null = null;
let cachedConfig: CableCostingConfig | null = null;

function decodeBase64Json(raw: string): unknown {
  let decoded: string;
  try {
    decoded = Buffer.from(raw, "base64").toString("utf8");
  } catch {
    throw new CableCostingConfigError(
      `${CABLE_COSTING_CONFIG_ENV} is not valid base64. ${ADMIN_HINT}`,
    );
  }
  if (decoded.trim() === "") {
    throw new CableCostingConfigError(
      `${CABLE_COSTING_CONFIG_ENV} decoded to an empty string. ${ADMIN_HINT}`,
    );
  }
  try {
    return JSON.parse(decoded) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new CableCostingConfigError(
      `${CABLE_COSTING_CONFIG_ENV} does not decode to valid JSON (${detail}). ${ADMIN_HINT}`,
    );
  }
}

/**
 * Read, decode, validate and memoise the costing configuration.
 * @throws CableCostingConfigError when the environment variable is absent or invalid.
 */
export function loadCableCostingConfig(): CableCostingConfig {
  const raw = process.env[CABLE_COSTING_CONFIG_ENV];
  if (raw === undefined || raw.trim() === "") {
    throw new CableCostingConfigError(
      `${CABLE_COSTING_CONFIG_ENV} is not set, so cable costing cannot run. ${ADMIN_HINT}`,
    );
  }
  if (cachedConfig !== null && cachedRaw === raw) return cachedConfig;

  let config: CableCostingConfig;
  try {
    config = validateCableCostingConfig(decodeBase64Json(raw.trim()));
  } catch (error) {
    if (error instanceof CableCostingConfigError) {
      throw new CableCostingConfigError(`${error.message} ${ADMIN_HINT}`);
    }
    throw error;
  }

  cachedRaw = raw;
  cachedConfig = config;
  return config;
}

/** Drop the memoised configuration (used after a rate-card rotation). */
export function resetCableCostingConfigCache(): void {
  cachedRaw = null;
  cachedConfig = null;
}

export { CableCostingConfigError };
