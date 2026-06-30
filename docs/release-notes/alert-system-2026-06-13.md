# CRM Alert System — June 13, 2026

## What's New

The CRM now has a **real-time alert system** that automatically flags leads needing attention. No more manually checking who's overdue — the system tells you.

---

## Alert Types

| Alert | Trigger | Severity |
|-------|---------|----------|
| **Overdue Follow-up** | Follow-up date has passed | 🔴 Red |
| **Due Today** | Follow-up scheduled for today | 🟡 Yellow |
| **Stale Lead** | No contact in 7+ days | 🔴 Red |
| **Over-contacted** | 5+ contacts but still "New" stage | 🔴 Red |
| **High-Value Stuck** | Quote >50K AED submitted 14+ days with no progress | 🟡 Yellow |
| **No Contact** | Lead assigned but never contacted | 🔴 Red |

**Only active leads** are monitored. Won/Lost/Disqualified leads are excluded.

---

## Where to See It

### Dashboard — Alert Panel
Both Management and Sales dashboards now show an **Alert Panel** at the top:

- **Collapsed view**: Shows total alert count (e.g. "136 alerts (130🔴 6🟡)") — click to expand
- **Expanded view**: Full list of alerts grouped by type, each clickable to go directly to the lead
- Click any alert row → takes you to that lead's detail page

### Notification Bell
Hourly alert checks create in-app notifications. You'll see them in the 🔔 bell icon:

- **Overdue alerts** → "逾期未跟进: [Customer Name]"
- **Today's follow-ups** → "今日跟进提醒: [Customer Name]"
- Management receives copies of all 🔴 red-severity alerts

---

## What You Need to Do

**Nothing to set up.** The system works automatically.

To clear alerts:
1. **Overdue follow-up** → Update `next_followup_date` or log a contact
2. **Stale lead** → Log a contact or make a call (updates `last_contact_date`)
3. **Over-contacted** → Change the lead's stage or reconsider strategy
4. **High-value stuck** → Move the deal forward or update the stage
5. **No contact** → Make first contact

Alerts disappear automatically when the trigger condition is no longer met.

---

## Current Snapshot

As of deployment: **136 active alerts** across the pipeline.
- 🔴 130 red (urgent)
- 🟡 6 yellow (warning)

Most are overdue follow-ups — please check your lead list and update follow-up dates.

---

Questions? Reply in the group.
