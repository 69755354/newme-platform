// S6 (review 4d section 4, #20): some user-visible text is produced in English
// by the server (dashboard action reasons, notification titles, follow-up task
// titles stored in the database). Stored rows cannot be re-translated, so the
// interface translates the known shapes at display time. Unknown text passes
// through unchanged (it is usually user data such as a customer name).

const ZH_PATTERNS = [
  [/^Overdue follow-up \((\d+)d\)$/, (m) => `跟进已逾期（${m[1]} 天）`],
  [/^No reply \((\d+)d\)$/, (m) => `未回复（${m[1]} 天）`],
  [/^Hot lead priority$/, () => "高意向线索优先"],
  [/^Draft quote pending$/, () => "报价草稿待发送"],
  [/^Workflow stage overdue$/, () => "流程阶段已超期"],
  [/^Follow[- ]up$/i, () => "跟进"],
  [/^Follow[- ]up: (.*)$/i, (m) => `跟进：${m[1]}`],
  [/^Overdue follow-up: (.*)$/, (m) => `跟进已逾期：${m[1]}`],
  [/^New lead assigned: (.*)$/, (m) => `分配给你的新线索：${m[1]}`],
  [/^New lead: (.*)$/, (m) => `新线索：${m[1]}`],
  [/^First payment reminder: (.*)$/, (m) => `首付提醒：${m[1]}`],
  [/^call$/i, () => "打电话"],
  [/^Confirm requirements$/i, () => "确认需求"],
  [/^Prepare solution$/i, () => "准备方案"],
  [/^Follow up on quotation$/i, () => "跟进报价"],
  [/^Unknown$/, () => "未知"],
  [/^Unnamed$/, () => "未命名"],
];

/** Translate a known server-generated English phrase for the given UI language. */
export function localizeServerText(text, lang) {
  if (typeof text !== "string" || lang !== "zh") return text;
  const trimmed = text.trim();
  for (const [re, fn] of ZH_PATTERNS) {
    const m = trimmed.match(re);
    if (m) return fn(m);
  }
  return text;
}
