// S40 follow-ups: one idempotency key per dialog, lost through the server route, Chinese rejection texts, no dead browser writes.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { submitStageFromDrag, submitWonFromDrag } from "../../src/lib/won-drag.mjs";
import { stageErrorZh, stageReasonsZh } from "../../src/lib/stage-error-zh.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (f) => fs.readFileSync(path.join(root, f), "utf8");
const drag = read("src/shared/hooks/usePipelineDragDrop.ts");
const KEY = "44444444-4444-4444-8444-444444444444";
const reply = (status, body) => async (url, init) => { reply.last = { url, init }; return { ok: status >= 200 && status < 300, json: async () => body }; };

test("P3-a: the key is created once when the dialog opens (WonPrompt) and every confirm reuses it", () => {
  assert.match(drag, /idempotencyKey: string;/);
  const open = drag.slice(drag.indexOf("setWonPrompt({"), drag.indexOf("return;", drag.indexOf("setWonPrompt({")));
  assert.match(open, /idempotencyKey: crypto\.randomUUID\(\)/);
  const confirm = drag.slice(drag.indexOf("const confirmWon"), drag.indexOf("const cancelWon"));
  assert.doesNotMatch(confirm, /randomUUID/, "confirmWon must not mint a new key per attempt");
  assert.match(confirm, /idempotencyKey \} = wonPrompt/);
  assert.equal((drag.match(/randomUUID/g) ?? []).length, 1);
});

test("P3-a: a network failure tells the user to refresh and confirm (the request may have been applied)", async () => {
  const down = await submitWonFromDrag(async () => { throw new Error("offline"); }, "lead-1", { note: "n", idempotencyKey: KEY });
  assert.deepEqual([down.ok, down.error_zh], [false, "网络出错，请刷新确认是否已保存。"]);
  assert.match(down.error, /Refresh the page to confirm/);
});

test("P3-a: a retry sends the same key", async () => {
  await submitStageFromDrag(reply(500, { error: "x" }), "lead-1", { stage: "won", note: "n", idempotencyKey: KEY });
  const first = JSON.parse(reply.last.init.body).idempotencyKey;
  await submitStageFromDrag(reply(200, { success: true }), "lead-1", { stage: "won", note: "n", idempotencyKey: KEY });
  assert.equal(JSON.parse(reply.last.init.body).idempotencyKey, first);
});

test("P3-e: lost goes through the stage route with the reason as the note and never an amount", async () => {
  const result = await submitStageFromDrag(reply(200, { success: true, lead: { stage: "lost" } }), "lead-9", { stage: "lost", note: " too expensive ", amount: "5000", idempotencyKey: KEY });
  assert.equal(result.ok, true);
  assert.equal(reply.last.url, "/api/leads/lead-9/stage");
  assert.deepEqual(JSON.parse(reply.last.init.body), { stage: "lost", note: "too expensive", idempotencyKey: KEY });
  const refused = await submitStageFromDrag(reply(400, { error: "Stage note is required", error_zh: "请填写阶段备注（原因）" }), "lead-9", { stage: "lost", note: "", idempotencyKey: KEY });
  assert.deepEqual([refused.ok, refused.needsAmount, refused.error_zh], [false, false, "请填写阶段备注（原因）"]);
  await assert.rejects(() => submitStageFromDrag(reply(200, {}), "lead-9", { stage: "contacted", note: "n", idempotencyKey: KEY }));
});

test("P3-e: the drop handler has no browser write for won or lost left, and the dead terminal branches are gone", () => {
  const dropBody = drag.slice(drag.indexOf("const onDrop"), drag.indexOf("const confirmWon"));
  assert.match(dropBody, /targetStage === "won" \|\| targetStage === "lost"/);
  assert.doesNotMatch(dropBody, /TERMINAL_STAGES|decision_date|from\("quotations"\)|final_status: targetStage/);
  assert.doesNotMatch(drag, /TERMINAL_STAGES/);
  assert.match(read("src/shared/kanban/WonDropDialog.tsx"), /prompt\.stage === "lost"/);
});

test("P3-b: every rejection of the stage route has Chinese wording and never falls back to English", () => {
  const route = read("src/app/api/leads/[id]/stage/route.ts");
  const messages = [...route.matchAll(/respond\(\s*\{ error: "([^"]+)"/g)].map((m) => m[1]);
  assert.ok(messages.length >= 8, "found the route's own rejections");
  for (const message of [...messages, "Lead stage changed concurrently", "Terminal Lead stage cannot be changed", "Forbidden: invalid CRM role", "Invalid stage transition from new to won", "Unauthorized", "something unexpected"]) {
    const zh = stageErrorZh(message);
    assert.match(zh, /[一-鿿]/, message);
    assert.doesNotMatch(zh, /[A-Za-z]{4,}/, message);
  }
  assert.match(stageErrorZh("Stage note is required"), /备注/);
  assert.match(stageErrorZh("First Contact requirements are incomplete"), /首次联系/);
  assert.deepEqual(stageReasonsZh(["At least one complete contact record is required", "Lead Quality must be Good, Normal, or Poor"]),
    ["至少需要一条完整的联系记录", "线索质量必须评为 好 / 一般 / 差"]);
  assert.match(route, /respond\(\{ error: message \}/);
  assert.match(route, /withChineseError\(body\)/);
  assert.match(route, /error_zh: stageErrorZh\("Internal server error"\)/);
});

test("P3-b: the lead page shows the Chinese gate reasons in Chinese", () => {
  assert.match(read("src/app/(dashboard)/leads/[id]/useLeadDetailMutations.ts"), /lang === "zh" && Array\.isArray\(json\?\.reasons_zh\)/);
});
