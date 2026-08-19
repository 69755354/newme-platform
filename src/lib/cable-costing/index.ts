/**
 * Cable & pulling-labour costing — public barrel.
 *
 * `./config.ts` is NOT re-exported here on purpose: it starts with
 * `import "server-only"`, and re-exporting it would make this barrel unusable
 * from any browser-reachable module (and would trip
 * `scripts/check-supabase-boundaries.mjs`, rule
 * `server-only-module-imported-by-browser`). Server code that needs the rate
 * card imports it directly:
 *
 *   import { loadCableCostingConfig } from "@/lib/cable-costing/config";
 *   import { calculateCableCosting } from "@/lib/cable-costing";
 */

export {
  CableCostingConfigError,
  CableCostingInputError,
  calculateCableCosting,
  getPointCatalogue,
  validateCableCostingConfig,
} from "./engine";

export type {
  CableCostingConfig,
  CableCostingInput,
  CableCostingResult,
  CableGrade,
  CableLengthModelConfig,
  CableLineItem,
  CablePriceConfig,
  LabourBasis,
  LabourLineItem,
  LabourModelConfig,
  OverheadsConfig,
  PointCatalogueConfig,
  PointCatalogueEntry,
  ProcurementBasis,
  Tier,
  Topology,
} from "./types";
