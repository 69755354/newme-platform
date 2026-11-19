import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import { normalizePhone } from "../../src/lib/lead-contact.mjs";

// The same cases are asserted against public.dispatch_phone_norm in tests/database/s24-dispatch-review.sql.
const cases = [
  ["0501234567", "+971501234567"], ["050 123 4567", "+971501234567"], ["501234567", "+971501234567"],
  ["042345678", "+97142345678"], ["00971501234567", "+971501234567"], ["971501234567", "+971501234567"],
  ["+971 050 123 4567", "+971501234567"], ["+44 7911 123456", "+447911123456"],
  ["12345", null], ["abc", null], ["", null], ["+971 4 12", null], ["+", null],
];

test("the JavaScript phone rules give the answers the database function is tested against", () => {
  for (const [raw, expected] of cases) {
    const result = normalizePhone(raw);
    assert.equal(result.ok ? result.e164 : null, expected, `case ${JSON.stringify(raw)}`);
  }
});

test("the database test file asserts every one of these cases", () => {
  const sql = fs.readFileSync(new URL("../../tests/database/s24-dispatch-review.sql", import.meta.url), "utf8");
  for (const [raw, expected] of cases) {
    if (expected) assert.ok(sql.includes(`dispatch_phone_norm('${raw}') = '${expected}'`), `SQL test lacks ${raw}`);
  }
  for (const raw of ["12345", "abc", "+971 4 12", "+"]) assert.ok(sql.includes(`dispatch_phone_norm('${raw}') is null`), `SQL test lacks ${raw}`);
});
