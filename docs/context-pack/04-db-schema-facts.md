# 04 — DB Schema Facts

Source: Production Supabase (Management API SQL query)

## leads (105 columns)

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

## profiles (15 columns)

| Column | Type | Nullable | Default |
|---|---|---|---|
| id | uuid | NO | — |
| role | text | YES | 'sales'::text |
| full_name | text | YES | — |
| phone | text | YES | — |
| avatar_url | text | YES | — |
| created_at | timestamp with time zone | YES | now() |
| updated_at | timestamp with time zone | YES | now() |
| manager_id | uuid | YES | — |
| is_active | boolean | YES | true |
| last_active_at | timestamp with time zone | YES | — |
| joined_at | timestamp with time zone | YES | now() |
| email | text | YES | — |
| password_changed_at | timestamp with time zone | YES | — |
| force_password_change | boolean | YES | false |
| password_hint | text | YES | — |

## tasks (9 columns)

| Column | Type | Nullable | Default |
|---|---|---|---|
| id | uuid | NO | gen_random_uuid() |
| lead_id | uuid | NO | — |
| title | text | NO | — |
| assignee_id | uuid | YES | — |
| due_at | timestamp with time zone | NO | — |
| status | text | NO | 'pending'::text |
| source | text | YES | 'manual'::text |
| completed_at | timestamp with time zone | YES | — |
| created_at | timestamp with time zone | NO | now() |

## follow_up_logs (9 columns)

| Column | Type | Nullable | Default |
|---|---|---|---|
| id | uuid | NO | gen_random_uuid() |
| lead_id | uuid | NO | — |
| user_id | uuid | YES | — |
| contact_type | text | NO | 'phone'::text |
| summary | text | NO | ''::text |
| result | text | YES | — |
| no_answer | boolean | NO | false |
| next_action | text | YES | — |
| created_at | timestamp with time zone | NO | now() |

## lead_milestones (7 columns)

| Column | Type | Nullable | Default |
|---|---|---|---|
| id | uuid | NO | gen_random_uuid() |
| lead_id | uuid | NO | — |
| milestone_key | text | NO | — |
| completed_by | uuid | YES | — |
| completed_at | timestamp with time zone | NO | now() |
| notes | text | YES | — |
| created_at | timestamp with time zone | NO | now() |

## contracts (27 columns)

| Column | Type | Nullable | Default |
|---|---|---|---|
| id | uuid | NO | gen_random_uuid() |
| lead_id | uuid | NO | — |
| quotation_id | uuid | YES | — |
| customer_id | uuid | YES | — |
| sales_id | uuid | YES | — |
| created_by | uuid | YES | — |
| contract_no | text | NO | — |
| contract_date | date | NO | CURRENT_DATE |
| contract_amount | numeric | NO | — |
| currency | text | YES | 'AED'::text |
| party_a_name | text | NO | — |
| party_a_contact | text | YES | — |
| party_b_name | text | NO | 'NewMe Smart Home FZCO'::text |
| party_b_contact | text | YES | — |
| file_url | text | YES | — |
| file_metadata | jsonb | YES | — |
| status | text | NO | 'draft'::text |
| notes | text | YES | — |
| terminated_reason | text | YES | — |
| terminated_at | timestamp with time zone | YES | — |
| created_at | timestamp with time zone | YES | now() |
| updated_at | timestamp with time zone | YES | now() |
| first_payment_status | text | NO | 'unpaid'::text |
| first_payment_due_date | date | YES | — |
| sealed_file_url | text | YES | — |
| sealed_file_metadata | jsonb | YES | — |
| approval_status | text | YES | 'none'::text |

## installment_plans (11 columns)

| Column | Type | Nullable | Default |
|---|---|---|---|
| id | uuid | NO | gen_random_uuid() |
| contract_id | uuid | NO | — |
| seq | integer | NO | — |
| amount | numeric | NO | — |
| due_date | date | NO | — |
| description | text | YES | — |
| status | text | NO | 'pending'::text |
| paid_amount | numeric | YES | 0 |
| created_at | timestamp with time zone | YES | now() |
| updated_at | timestamp with time zone | YES | now() |
| allocated_amount | numeric | NO | 0 |

## projects (22 columns)

| Column | Type | Nullable | Default |
|---|---|---|---|
| id | uuid | NO | gen_random_uuid() |
| customer_id | uuid | YES | — |
| name | text | NO | — |
| property_type | text | YES | — |
| property_size | integer | YES | — |
| location | text | YES | — |
| phase | text | YES | 'design'::text |
| status | text | YES | 'active'::text |
| cad_url | text | YES | — |
| quote_url | text | YES | — |
| ppt_url | text | YES | — |
| contract_url | text | YES | — |
| quoted_amount | numeric | YES | — |
| contract_amount | numeric | YES | — |
| paid_amount | numeric | YES | 0 |
| assigned_to | uuid | YES | — |
| created_at | timestamp with time zone | YES | now() |
| updated_at | timestamp with time zone | YES | now() |
| contract_id | uuid | YES | — |
| lead_id | uuid | YES | — |
| sales_id | uuid | YES | — |
| project_manager | uuid | YES | — |

## customers (14 columns)

| Column | Type | Nullable | Default |
|---|---|---|---|
| id | uuid | NO | gen_random_uuid() |
| lead_id | uuid | YES | — |
| name | text | NO | — |
| phone | text | YES | — |
| email | text | YES | — |
| whatsapp | text | YES | — |
| address | text | YES | — |
| notes | text | YES | — |
| created_at | timestamp with time zone | YES | now() |
| unified_profile | boolean | YES | true |
| tags | ARRAY | YES | — |
| total_contract_amount | numeric | YES | 0 |
| last_activity_at | timestamp with time zone | YES | — |
| assigned_sales_id | uuid | YES | — |

## quotations (26 columns)

| Column | Type | Nullable | Default |
|---|---|---|---|
| id | uuid | NO | gen_random_uuid() |
| lead_id | uuid | NO | — |
| customer_id | uuid | YES | — |
| created_by | uuid | YES | — |
| quote_no | text | NO | — |
| version | integer | YES | 1 |
| subtotal | numeric | NO | 0 |
| discount_rate | numeric | YES | 0 |
| discount_amount | numeric | YES | 0 |
| tax_rate | numeric | YES | 5.0 |
| tax_amount | numeric | YES | 0 |
| total_amount | numeric | NO | — |
| currency | text | YES | 'AED'::text |
| valid_until | date | NO | (CURRENT_DATE + '30 days'::interval) |
| payment_terms | text | YES | — |
| delivery_terms | text | YES | — |
| status | text | NO | 'draft'::text |
| pdf_url | text | YES | — |
| ppt_url | text | YES | — |
| devices_json | jsonb | YES | — |
| notes | text | YES | — |
| internal_notes | text | YES | — |
| created_at | timestamp with time zone | YES | now() |
| updated_at | timestamp with time zone | YES | now() |
| contract_id | uuid | YES | — |
| quotation_type | text | NO | 'standard'::text |

## business_events (7 columns)

| Column | Type | Nullable | Default |
|---|---|---|---|
| id | uuid | NO | gen_random_uuid() |
| lead_id | uuid | YES | — |
| user_id | uuid | YES | — |
| event_type | text | NO | — |
| event_data | jsonb | YES | '{}'::jsonb |
| description | text | YES | — |
| created_at | timestamp with time zone | YES | now() |

## activities (16 columns)

| Column | Type | Nullable | Default |
|---|---|---|---|
| id | uuid | NO | gen_random_uuid() |
| lead_id | uuid | YES | — |
| customer_id | uuid | YES | — |
| project_id | uuid | YES | — |
| user_id | uuid | YES | — |
| type | text | NO | — |
| content | text | YES | — |
| ai_generated | boolean | YES | false |
| created_at | timestamp with time zone | YES | now() |
| contract_id | uuid | YES | — |
| quotation_id | uuid | YES | — |
| duration | integer | YES | — |
| is_completed | boolean | YES | true |
| due_at | timestamp with time zone | YES | — |
| priority | text | YES | 'normal'::text |
| metadata | jsonb | YES | — |

## notifications (9 columns)

| Column | Type | Nullable | Default |
|---|---|---|---|
| id | uuid | NO | gen_random_uuid() |
| user_id | uuid | NO | — |
| type | character varying | NO | — |
| title | text | NO | — |
| body | text | YES | — |
| related_id | text | YES | — |
| related_type | character varying | YES | — |
| is_read | boolean | YES | false |
| created_at | timestamp with time zone | YES | now() |

## Triggers

- trg_auto_create_task ON follow_up_logs → auto_create_task_from_followup
- trg_check_milestone_order ON lead_milestones → check_milestone_order
- trg_derive_lead_status ON leads → derive_lead_status
- trg_enforce_followup ON leads → enforce_followup_required
- trg_lead_won ON leads → on_lead_won
- trg_set_lost_reasons ON leads → set_lost_reasons
- trg_set_updated_at ON leads → set_updated_at
- trg_update_lead_metrics ON leads → update_lead_metrics
- trg_payment_after_insert ON payments → update_installment_status

## RLS Policies: 104 total

- activities.activities_admin_all (PERMISSIVE)
- activities.activities_sales_own (PERMISSIVE)
- activities.activities_sales_select (PERMISSIVE)
- activity_logs.boss_admin_see_all_activity (PERMISSIVE)
- activity_logs.sales_see_own_activity (PERMISSIVE)
- ad_spend.boss_admin_insert_ad_spend (PERMISSIVE)
- ad_spend.boss_admin_read_ad_spend (PERMISSIVE)
- audit_log_archived_20260615.Admins read all audit logs (PERMISSIVE)
- audit_log_archived_20260615.Users insert own audit events (PERMISSIVE)
- audit_log_archived_20260615.Users read own audit logs (PERMISSIVE)
- audit_logs.Authenticated can insert audit_logs (PERMISSIVE)
- audit_logs.Staff can read audit_logs (PERMISSIVE)
- business_events.be_admin_all (PERMISSIVE)
- business_events.be_relevant_select (PERMISSIVE)
- business_events.be_sales_insert (PERMISSIVE)
- chat_messages.chat_messages_admin_all (PERMISSIVE)
- chat_messages.chat_messages_sales_insert (PERMISSIVE)
- chat_messages.chat_messages_sales_select (PERMISSIVE)
- contract_approvals.ca_admin_all (PERMISSIVE)
- contract_approvals.ca_sales_select (PERMISSIVE)
- contracts.contracts_admin_all (PERMISSIVE)
- contracts.contracts_finance_select (PERMISSIVE)
- contracts.contracts_sales_select (PERMISSIVE)
- crm_daily_funnel_snapshot.Default deny all (PERMISSIVE)
- crm_daily_funnel_snapshot.crm_daily_funnel_snapshot_admin (PERMISSIVE)
- customers.customers_admin_all (PERMISSIVE)
- customers.customers_sales_own (PERMISSIVE)
- customers.customers_sales_see (PERMISSIVE)
- follow_up_logs.Default deny all (PERMISSIVE)
- follow_up_logs.follow_up_logs_insert (PERMISSIVE)

... and 74 more
