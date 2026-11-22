// S36 review P2-3: dragging a lead onto Won uses the lead page's server route, with the note and (when needed) the amount.
import assert from "node:assert/strict";
import test from "node:test";
import { leadHasWonAmount, submitWonFromDrag } from "../../src/lib/won-drag.mjs";

const KEY = "33333333-3333-4333-8333-333333333333";
const reply = (status, body) => async (url, init) => { reply.last = { url, init }; return { ok: status >= 200 && status < 300, json: async () => body }; };

test("the Won request is the stage route with note, key and the typed amount", async () => {
  const fetchImpl = reply(200, { success: true, lead: { stage: "won" } });
  const result = await submitWonFromDrag(fetchImpl, "lead-1", { note: "  signed  ", amount: " 12,000 ", idempotencyKey: KEY });
  assert.equal(result.ok, true);
  assert.equal(reply.last.url, "/api/leads/lead-1/stage");
  assert.equal(reply.last.init.method, "PATCH");
  assert.deepEqual(JSON.parse(reply.last.init.body), { stage: "won", note: "signed", idempotencyKey: KEY, amount: "12,000" });
});

test("without a typed amount none is sent (the server uses the contract or quotation)", async () => {
  await submitWonFromDrag(reply(200, { success: true }), "lead-1", { note: "n", amount: "", idempotencyKey: KEY });
  assert.equal("amount" in JSON.parse(reply.last.init.body), false);
});

test("a missing amount comes back as needsAmount so the dialog can ask for it", async () => {
  const result = await submitWonFromDrag(reply(409, { code: "won_amount_required", error: "x", error_zh: "赢单必须有金额" }), "lead-1", { note: "n", idempotencyKey: KEY });
  assert.deepEqual([result.ok, result.needsAmount, result.error_zh], [false, true, "赢单必须有金额"]);
});

test("other refusals and network failures leave the lead untouched and report an error", async () => {
  const gate = await submitWonFromDrag(reply(409, { error: "First Contact requirements are incomplete" }), "lead-1", { note: "n", idempotencyKey: KEY });
  assert.deepEqual([gate.ok, gate.needsAmount], [false, false]);
  assert.match(gate.error, /First Contact/);
  const down = await submitWonFromDrag(async () => { throw new Error("offline"); }, "lead-1", { note: "n", idempotencyKey: KEY });
  assert.equal(down.ok, false);
});

test("a lead counts as having an amount only when quotation_value is positive", () => {
  assert.equal(leadHasWonAmount({ quotation_value: 100 }), true);
  for (const lead of [{ quotation_value: 0 }, { quotation_value: null }, {}, null]) assert.equal(leadHasWonAmount(lead), false);
});
