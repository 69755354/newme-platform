-- Migration: Upgrade lead_alerts view to ARCH-REVIEW v2
-- Adds: alert_type, alert_message, severity columns
-- 5 alert rules: overdue_followup, stale_lead, over_contacted, high_value_stuck, no_contact, due_today
-- Date: 2026-06-13

ALTER TABLE leads ADD COLUMN IF NOT EXISTS quotation_sent_date DATE;

DROP VIEW IF EXISTS lead_alerts;

CREATE VIEW lead_alerts AS
SELECT 
  l.id,
  l.customer_name,
  l.phone,
  l.stage AS funnel_stage,
  l.lead_status,
  l.quotation_value,
  l.win_probability,
  l.assigned_to,
  l.rep_name,
  l.next_followup_date,
  l.last_contact_date,
  l.followup_count,
  l.next_action,
  l.stage_changed_at,
  l.recovery_candidate,
  l.transfer_candidate,
  l.sales_manager_review,
  l.hold_since,
  -- alert_type: machine-readable type for filtering
  CASE 
    WHEN next_followup_date IS NOT NULL AND next_followup_date = CURRENT_DATE 
      THEN 'due_today'
    WHEN next_followup_date IS NOT NULL AND next_followup_date < CURRENT_DATE 
      THEN 'overdue_followup'
    WHEN last_contact_date IS NOT NULL 
      AND last_contact_date < CURRENT_DATE - INTERVAL '7 days'
      AND stage NOT IN ('won', 'lost')
      THEN 'stale_lead'
    WHEN followup_count >= 5 AND stage = 'new'
      THEN 'over_contacted'
    WHEN quotation_value > 50000 
      AND stage = 'quotation_submitted'
      AND quotation_sent_date IS NOT NULL 
      AND quotation_sent_date < CURRENT_DATE - INTERVAL '14 days'
      THEN 'high_value_stuck'
    WHEN last_contact_date IS NULL 
      AND stage NOT IN ('won', 'lost')
      THEN 'no_contact'
    ELSE NULL
  END AS alert_type,
  -- alert_message: human-readable Chinese description
  CASE 
    WHEN next_followup_date IS NOT NULL AND next_followup_date = CURRENT_DATE 
      THEN '今日需跟进'
    WHEN next_followup_date IS NOT NULL AND next_followup_date < CURRENT_DATE 
      THEN '逾期未跟进，已超过预定跟进日期'
    WHEN last_contact_date IS NOT NULL 
      AND last_contact_date < CURRENT_DATE - INTERVAL '7 days'
      AND stage NOT IN ('won', 'lost')
      THEN '超过7天未联系，建议尽快跟进'
    WHEN followup_count >= 5 AND stage = 'new'
      THEN '已联系5次以上但仍在新线索阶段，建议降级或淘汰'
    WHEN quotation_value > 50000 
      AND stage = 'quotation_submitted'
      AND quotation_sent_date IS NOT NULL 
      AND quotation_sent_date < CURRENT_DATE - INTERVAL '14 days'
      THEN '高金额报价已提交超14天无进展，建议重点跟进'
    WHEN last_contact_date IS NULL 
      AND stage NOT IN ('won', 'lost')
      THEN '从未联系过，需要首次触达'
    ELSE NULL
  END AS alert_message,
  -- severity: red (urgent), yellow (warning), null (clean)
  CASE
    WHEN next_followup_date IS NOT NULL AND next_followup_date < CURRENT_DATE THEN 'red'
    WHEN last_contact_date IS NOT NULL AND last_contact_date < CURRENT_DATE - INTERVAL '7 days' THEN 'red'
    WHEN followup_count >= 5 AND stage = 'new' THEN 'red'
    WHEN last_contact_date IS NULL THEN 'red'
    WHEN quotation_value > 50000 AND stage = 'quotation_submitted' THEN 'yellow'
    WHEN next_followup_date IS NOT NULL AND next_followup_date = CURRENT_DATE THEN 'yellow'
    ELSE NULL
  END AS severity,
  (CURRENT_DATE - last_contact_date::DATE) AS days_since_contact
FROM leads l
WHERE l.disqualified_candidate = false
  AND l.stage NOT IN ('won', 'lost');
