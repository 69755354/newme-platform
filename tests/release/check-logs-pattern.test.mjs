// The post-switch journald scan must flag HTTP 500s but not a pid, port or id that merely contains "500"
// (2026-11-26: pid 3917500 failed a healthy release and auto-rolled it back).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../../scripts/check-logs.sh", import.meta.url), "utf8");
const block = src.slice(src.indexOf("PATTERNS=("), src.indexOf("\n)", src.indexOf("PATTERNS=(")));
const re = new RegExp([...block.matchAll(/^\s+"([^"]+)"/gm)].map((m) => m[1]).join("|"), "i");

test("check-logs: 500 matches HTTP status, not pids or ids", () => {
  for (const line of ["GET /api/leads 500 in 12ms", "status=500", "HTTP 500"]) assert.match(line, re);
  for (const line of [
    "newme-platform[3917500]: ✓ Ready in 159ms",
    "newme-platform[500]: - Local: http://localhost:3001",
    "debug id 0b9cecf4-b2dc-7461-6a9b-2f5d8777500c",
  ]) assert.doesNotMatch(line, re);
});
