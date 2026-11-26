// S43 (B8): the shared "same open customer" rule used by the website intake (the S39 Meta rule).
import assert from "node:assert/strict";
import test from "node:test";
import { PUBLIC_LEAD_DEDUPE_SWITCH, findOpenLeadByContact, pickOpenLeadMatch, publicLeadDedupeEnabled } from "../../src/lib/lead-dedupe.mjs";

const open = (id, phone, extra = {}) => ({ id, phone, email: null, archived: false, final_status: null, ...extra });

test("the switch is off unless NEWME_PUBLIC_LEAD_DEDUPE_ENABLED=true", () => {
  assert.equal(publicLeadDedupeEnabled({}), false);
  assert.equal(publicLeadDedupeEnabled({ [PUBLIC_LEAD_DEDUPE_SWITCH]: "true" }), true);
  assert.equal(publicLeadDedupeEnabled({ [PUBLIC_LEAD_DEDUPE_SWITCH]: "yes" }), false);
});

test("050, 00971 and +971 spellings of one number are the same open customer; closed and archived leads never are", () => {
  const stored = open("L1", "050 123 4567");
  assert.equal(pickOpenLeadMatch([stored], { phone: "+971501234567" })?.id, "L1");
  assert.equal(pickOpenLeadMatch([open("L2", "00971501234567")], { phone: "+971501234567" })?.id, "L2");
  assert.equal(pickOpenLeadMatch([open("L3", "+971501234567", { final_status: "won" })], { phone: "+971501234567" }), null);
  assert.equal(pickOpenLeadMatch([open("L4", "+971501234567", { archived: true })], { phone: "+971501234567" }), null);
  assert.equal(pickOpenLeadMatch([open("L5", "+971501234568")], { phone: "+971501234567" }), null);
  // the oldest open match wins (candidates come ordered by created_at)
  assert.equal(pickOpenLeadMatch([open("old", "0501234567"), open("new", "+971501234567")], { phone: "+971501234567" })?.id, "old");
});

test("two emails that differ mean two people sharing a phone; a matching email wins first; junk numbers never match", () => {
  assert.equal(pickOpenLeadMatch([open("L1", "+971501234567", { email: "a@x.ae" })], { phone: "+971501234567", email: "b@x.ae" }), null);
  assert.equal(pickOpenLeadMatch([open("L1", "+971501234567", { email: "a@x.ae" })], { phone: "+971501234567", email: "A@X.AE" })?.id, "L1");
  assert.equal(pickOpenLeadMatch([open("L1", "+971501234567", { email: null })], { phone: "+971501234567", email: "b@x.ae" })?.id, "L1");
  assert.equal(pickOpenLeadMatch([open("L1", "+971509999999", { email: "same@x.ae" })], { phone: "+971501234567", email: "same@x.ae" })?.id, "L1");
  assert.equal(pickOpenLeadMatch([open("L1", "0000000000")], { phone: "0000000000" }), null);
  assert.equal(pickOpenLeadMatch([], { phone: "+971501234567" }), null);
});

function fakeDb(rows, { fail = false } = {}) {
  const calls = [];
  return {
    calls,
    from(table) {
      const q = {
        select() { return q; }, eq() { return q; }, is() { return q; }, order() { return q; }, limit() { return q; },
        ilike(_col, pattern) { calls.push(pattern); return q; },
        then(res, rej) {
          return Promise.resolve(fail ? { data: null, error: { code: "x" } } : { data: table === "leads" ? rows : [], error: null }).then(res, rej);
        },
      };
      return q;
    },
  };
}

test("findOpenLeadByContact filters by the last seven digits and reports (never throws) a lookup failure", async () => {
  const db = fakeDb([open("L1", "050 123 4567")]);
  const found = await findOpenLeadByContact(db, { phone: "+971501234567", email: null });
  assert.equal(found.lead?.id, "L1");
  assert.equal(found.error, null);
  assert.deepEqual(db.calls, ["%1%2%3%4%5%6%7%"]);
  const broken = await findOpenLeadByContact(fakeDb([], { fail: true }), { phone: "+971501234567", email: null });
  assert.deepEqual(broken, { lead: null, error: "lead_lookup_failed" });
  assert.deepEqual(await findOpenLeadByContact(fakeDb([]), { phone: null, email: null }), { lead: null, error: null });
});
