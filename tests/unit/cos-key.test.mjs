// COS download link rules (review 2026-11-03, 2-security F-07).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { clampCosExpires, cosKeyError, COS_MAX_EXPIRES_SECONDS, sanitizeContractFilename } from "../../src/lib/cos-key.mjs";

const ROOT = path.resolve(import.meta.dirname, "../..");
const route = readFileSync(path.join(ROOT, "src/app/api/cos/download-url/route.ts"), "utf8");

test("keys that climb out of their own folder are refused", () => {
  assert.match(cosKeyError("leads/abc/../../contracts/xyz/contract.pdf"), /traversal/);
  assert.match(cosKeyError("leads/abc/.."), /traversal/);
  assert.match(cosKeyError("quotations/..%2f"), /unsafe|traversal/);
  assert.match(cosKeyError("leads/a//b"), /malformed/);
  assert.match(cosKeyError("/leads/abc/x.pdf"), /malformed/);
  assert.match(cosKeyError("leads/abc/x y.pdf"), /unsafe/);
  assert.match(cosKeyError(""), /required/);
  assert.match(cosKeyError(42), /required/);
});

test("ordinary keys still pass", () => {
  for (const key of [
    "leads/0b94b039-2489-495a-ad78-8ea8fe244660/quote.pdf",
    "contracts/abc/NEW-20261102-001.pdf",
    "quotations/NM-2026-0056.pdf",
    "attachments/photo_1.v2.png",
  ]) {
    assert.equal(cosKeyError(key), null, key);
  }
});

test("a signed link lives at most one hour, whatever was asked", () => {
  assert.equal(COS_MAX_EXPIRES_SECONDS, 3600);
  assert.equal(clampCosExpires(undefined), 3600);
  assert.equal(clampCosExpires("999999"), 3600);
  assert.equal(clampCosExpires(-5), 3600);
  assert.equal(clampCosExpires(Number.NaN), 3600);
  assert.equal(clampCosExpires(31536000), 3600);
  assert.equal(clampCosExpires(900), 900);
  assert.equal(clampCosExpires(900.9), 900);
  assert.equal(clampCosExpires(5), 60);
});

test("the route uses both rules and no longer matches attachments by bare file name", () => {
  assert.match(route, /cosKeyError\(key\)/);
  assert.match(route, /clampCosExpires\(expires\)/);
  assert.doesNotMatch(route, /eq\("file_name"/);
  assert.doesNotMatch(route, /expires > 0 \? expires/);
});

test("two dots inside a file name are fine, whole-segment dots are not", () => {
  assert.equal(cosKeyError("contracts/c/draft_report..pdf"), null);
  assert.equal(cosKeyError("attachments/a..b.pdf"), null);
  assert.match(cosKeyError("leads/a/./b"), /traversal/);
  assert.match(cosKeyError("leads/a/../b"), /traversal/);
  assert.match(cosKeyError("leads/abc/.."), /traversal/);
  assert.match(cosKeyError("../leads/a"), /traversal/);
  assert.match(cosKeyError("leads/abc/..%2f"), /unsafe|traversal/);
  assert.match(cosKeyError("leads/a\\..\\b"), /unsafe/);
});

test("contract upload file names always make a downloadable key", () => {
  for (const name of ["my file.pdf", "report..pdf", "a  b...c.pdf", "合同 v2.pdf", "..", "x/../y.pdf", "a b\\c.pdf"]) {
    const safe = sanitizeContractFilename(name);
    assert.equal(cosKeyError(`contracts/c/draft_${safe}`), null, `${name} -> ${safe}`);
  }
  assert.equal(sanitizeContractFilename("my file.pdf"), "my_file.pdf");
  assert.equal(sanitizeContractFilename("report..pdf"), "report.pdf");
  assert.match(readFileSync(path.join(ROOT, "src/app/api/contracts/[id]/upload-url/route.ts"), "utf8"), /sanitizeContractFilename\(filename\)/);
});
