import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const route = new URL(
  "../../src/app/api/hermes/generate-quote/route.ts",
  import.meta.url,
);

test("SAM-49 Hermes quote generation rejects unknown stored device keys before persistence", async () => {
  const source = await readFile(route, "utf8");

  assert.match(source, /import \{ DEVICE_CATALOG \} from "@\/lib\/device-catalog"/);
  assert.match(source, /const VALID_DEVICE_IDS = new Set<string>\(/);
  assert.match(source, /const unknownDevices = Object\.keys\(devices\)\.filter\(\(id\) => !VALID_DEVICE_IDS\.has\(id\)\)/);
  assert.match(source, /error: "Unknown device_ids", unknown_devices: unknownDevices/);
});

test("SAM-49 Hermes quote generation rejects a non-positive calculated total before persistence", async () => {
  const source = await readFile(route, "utf8");
  const guard = source.indexOf("if (calculation.total <= 0)");
  const insert = source.indexOf(".insert({", guard);

  assert.ok(guard >= 0, "Hermes route must guard the calculated total");
  assert.ok(insert > guard, "non-positive total must be rejected before quotation insertion");
  assert.match(source, /error: "Quotation total must be greater than zero"/);
});
