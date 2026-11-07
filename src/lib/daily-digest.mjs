// One concise daily digest instead of the two disabled reminders (review
// 5-logging-monitoring F7: "followups" was redundant, "alerts" produced 432+
// duplicates per call because every overdue lead notified 1 rep + 4 admins).
//
// Rules that make it spam-proof:
//  * ONE notification per recipient per Dubai calendar day (stable eventKey,
//    enforced by the notifications table's atomic insert);
//  * counts only -- no customer names or contact data in the notification;
//  * nothing is sent when there is nothing overdue.
const TERMINAL_STAGES = new Set(["won", "lost"]);

/** Calendar date (YYYY-MM-DD) in Dubai (UTC+4, no DST). */
export function dubaiDate(now = new Date()) {
  return new Date(now.getTime() + 4 * 3_600_000).toISOString().slice(0, 10);
}

/**
 * @param leads rows with { assigned_to, next_followup_date, stage }
 * @param managers array of { id } for active admin/boss users
 * @returns notification drafts (same shape as createNotificationsBulk input)
 */
export function buildDailyDigest({ leads, managers, today }) {
  const perRep = new Map();
  for (const lead of leads) {
    if (!lead.assigned_to || !lead.next_followup_date) continue;
    if (TERMINAL_STAGES.has(lead.stage)) continue;
    const overdue = lead.next_followup_date < today;
    const dueToday = lead.next_followup_date === today;
    if (!overdue && !dueToday) continue;
    const entry = perRep.get(lead.assigned_to) ?? { overdue: 0, dueToday: 0 };
    if (overdue) entry.overdue += 1; else entry.dueToday += 1;
    perRep.set(lead.assigned_to, entry);
  }
  const drafts = [];
  const eventKey = `daily_digest:${today}`;
  let teamOverdue = 0;
  let teamDueToday = 0;
  for (const [userId, { overdue, dueToday }] of perRep) {
    teamOverdue += overdue;
    teamDueToday += dueToday;
    drafts.push({
      userId, type: "followup_reminder", eventKey, relatedType: "digest",
      title: `今日跟进摘要 / Today's follow-ups: ${overdue} overdue, ${dueToday} due today`,
      body: `您有 ${overdue} 条线索已逾期、${dueToday} 条今天到期。\nYou have ${overdue} overdue and ${dueToday} due-today follow-ups.`,
    });
  }
  if (teamOverdue + teamDueToday > 0) {
    for (const { id } of managers) {
      drafts.push({
        userId: id, type: "followup_reminder", eventKey, relatedType: "digest",
        title: `团队跟进摘要 / Team follow-ups: ${teamOverdue} overdue, ${teamDueToday} due today`,
        body: `全团队 ${perRep.size} 位销售共有 ${teamOverdue} 条已逾期、${teamDueToday} 条今天到期。\n${perRep.size} reps hold ${teamOverdue} overdue and ${teamDueToday} due-today follow-ups.`,
      });
    }
  }
  return drafts;
}
