# 06 — Leads Model Facts

Source: Production DB schema + code scan

## Columns

| Column | Type | Nullable | Default |
|---|---|---|---|
| id | uuid | NO | gen_random_uuid() |
| source | text | NO | — |
| meta_click_id | text | YES | — |
| meta_campaign | text | YES | — |
| meta_ad_id | text | YES | — |
| quality | text | YES | 'pending'::text |
| customer_name | text | YES | — |
| phone | text | YES | — |
| email | text | YES | — |
| property_type | text | YES | — |
| property_size_sqm | integer | YES | — |
| location | text | YES | — |
| budget_range | text | YES | — |
| service_needs | ARRAY | YES | — |
| ai_summary | text | YES | — |
| ai_tags | ARRAY | YES | — |
| ai_quality | text | YES | — |
| assigned_to | uuid | YES | — |
| converted_at | timestamp with time zone | YES | — |
| lost_at | timestamp with time zone | YES | — |
| lost_reason | text | YES | — |
| created_at | timestamp with time zone | YES | now() |
| updated_at | timestamp with time zone | YES | now() |
| stage | text | YES | 'new'::text |
| lead_status | text | YES | — |
| win_probability | integer | YES | — |
| stage_changed_at | timestamp with time zone | YES | — |
| decision_maker | text | YES | — |
| decision_date | date | YES | — |
| competitor | text | YES | — |
| last_contact_date | date | YES | — |
| next_followup_date | date | YES | (CURRENT_DATE + '1 day'::interval) |
| followup_count | integer | YES | 0 |
| next_action | text | YES | 'call'::text |
| disqualified_candidate | boolean | YES | false |
| sales_manager_review | boolean | YES | false |
| recovery_candidate | boolean | YES | false |
| transfer_candidate | boolean | YES | false |
| hold_since | date | YES | — |
| notes | text | YES | — |
| quotation_value | numeric | YES | — |
| expected_close_date | date | YES | — |
| confidence_pct | integer | YES | 50 |
| forecast_category | text | YES | — |
| rep_name | text | YES | — |
| source_platform | text | YES | — |
| source_channel | text | YES | — |
| campaign_id | text | YES | — |
| campaign_name | text | YES | — |
| adset_id | text | YES | — |
| adset_name | text | YES | — |
| ad_id | text | YES | — |
| ad_name | text | YES | — |
| creative_id | text | YES | — |
| creative_name | text | YES | — |
| form_id | text | YES | — |
| form_name | text | YES | — |
| utm_source | text | YES | — |
| utm_medium | text | YES | — |
| utm_campaign | text | YES | — |
| utm_content | text | YES | — |
| utm_term | text | YES | — |
| fbclid | text | YES | — |
| gclid | text | YES | — |
| landing_page | text | YES | — |
| referrer | text | YES | — |
| first_touch_at | timestamp with time zone | YES | — |
| last_touch_at | timestamp with time zone | YES | — |
| owner | text | YES | — |
| sales_manager | uuid | YES | — |
| days_since_last_contact | integer | YES | 0 |
| customer_id | uuid | YES | — |
| project_name | text | YES | — |
| project_status | text | YES | — |
| ac_brand | text | YES | — |
| system_preference | text | YES | — |
| visit_status | text | YES | — |
| rejection_detail | text | YES | — |
| circuit_diagrams | boolean | YES | false |
| phase_pct | integer | YES | 0 |
| sub_phase | text | YES | — |
| quotation_sent_date | timestamp with time zone | YES | — |
| reminder_24h_sent | boolean | YES | false |
| reminder_48h_sent | boolean | YES | false |
| sales_phase | text | YES | 'lead'::text |
| lost_reason_price | boolean | YES | false |
| lost_reason_competitor | boolean | YES | false |
| lost_reason_no_budget | boolean | YES | false |
| lost_reason_project_cancelled | boolean | YES | false |
| lost_reason_project_delayed | boolean | YES | false |
| lost_reason_no_response | boolean | YES | false |
| lost_reason_other | boolean | YES | false |
| current_milestone | text | YES | 'new'::text |
| final_status | text | YES | — |
| no_answer_flag | boolean | NO | false |
| not_interested_reason | text | YES | — |
| emirate | text | YES | — |
| area | text | YES | — |
| customer_company_type | text | YES | — |
| customer_position | text | YES | — |
| smart_requirements | jsonb | YES | — |
| customer_budget | numeric | YES | — |
| expected_sign_date | date | YES | — |
| contact_result | text | YES | — |
| project_type | text | YES | — |

## Stage Field (legacy)
- CHECK constraint: new/contacted/requirement_confirmed/solution_submitted/quotation_submitted/negotiation/pending_decision/won/lost
- Currently written by: milestone API (dual-write for won/lost), manual updateStage()
- Read by: dashboard, pipeline, leads list, analytics, ads pages
- Being replaced by: final_status + current_milestone (in working tree, NOT deployed)

## final_status Field
- Type: TEXT, nullable
- Values: NULL (active), 'won', 'lost'
- Written by: trg_lead_won trigger, milestone API
- Production counts: NULL=61, lost=8, won=0

## current_milestone Field
- Type: TEXT, nullable
- Maintained by: trg_check_milestone_order trigger
- Values: new/first_contact/basic_info/drawings/requirements/solution/quotation/meeting/negotiation

## source CHECK values
- meta_ads / whatsapp / website / offline / referral / other
- Production: meta_ads(35), other(31), whatsapp(2), offline(1)

## lead_quality / poor_reason
- quality field exists, values: valid/invalid/pending
- poor_reason field exists for low-quality leads

## assigned_to → profiles.id (FK)
## created_by → profiles.id (FK)
## No soft-delete column. No archive table.
