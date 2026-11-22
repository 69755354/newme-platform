// Chinese wording for every rejection of PATCH /api/leads/:id/stage, so the Chinese screens never show raw English.
// The English text stays in `error` (API contract and logs); the route adds `error_zh` (and `reasons_zh`) from here.

const EXACT = new Map([
  ["A valid idempotency key is required", "请求缺少有效的防重复标识，请刷新页面后重试"],
  ["Stage note must be 1000 characters or fewer", "阶段备注不能超过 1000 字"],
  ["Stage note is required", "请填写阶段备注（原因）"],
  ["Invalid stage", "无效的阶段"],
  ["Lead not found", "找不到这条线索"],
  ["Lead stage is missing", "这条线索缺少阶段信息，请联系管理员"],
  ["Forbidden: lead not assigned to you", "这条线索没有分配给你，不能修改"],
  ["Forbidden: invalid CRM role", "你的角色不能修改线索阶段"],
  ["Unable to verify contact records", "暂时无法核对联系记录，请稍后重试"],
  ["First Contact requirements are incomplete", "首次联系要求未完成：需要至少一条完整的联系记录，并评估线索质量"],
  ["Lead stage changed concurrently", "这条线索刚被别人改动，请刷新后再试"],
  ["Terminal Lead stage cannot be changed", "已赢单或已丢单的线索不能再改阶段"],
  ["Unauthorized", "登录已失效，请重新登录"],
  ["Stage update failed", "阶段更新失败，请稍后重试"],
  ["Internal server error", "服务器出错，请稍后重试"],
]);

const REASONS = new Map([
  ["At least one complete contact record is required", "至少需要一条完整的联系记录"],
  ["Lead Quality must be Good, Normal, or Poor", "线索质量必须评为 好 / 一般 / 差"],
]);

const PATTERNS = [
  [/^Invalid stage transition from /, "不允许这样改变阶段，请按流程推进"],
  [/^First Contact requirements/, EXACT.get("First Contact requirements are incomplete")],
  [/concurrently/, EXACT.get("Lead stage changed concurrently")],
  [/^Forbidden/, "没有权限修改这条线索"],
  [/not found/i, EXACT.get("Lead not found")],
];

const FALLBACK = "阶段更新失败，请稍后重试";

/** Chinese text for one English rejection message; never returns English. */
export function stageErrorZh(message) {
  const text = typeof message === "string" ? message.trim() : "";
  if (EXACT.has(text)) return EXACT.get(text);
  for (const [pattern, zh] of PATTERNS) if (pattern.test(text)) return zh;
  return FALLBACK;
}

/** Chinese text for the first-contact gate reasons (unknown reasons fall back to the generic gate message). */
export function stageReasonsZh(reasons) {
  return (Array.isArray(reasons) ? reasons : []).map((r) => REASONS.get(String(r)) ?? EXACT.get("First Contact requirements are incomplete"));
}
