# NewMe CRM — 菜单树 & 数据库 Schema

_导出时间: 2026-06-05 | 版本: v2.1_
_基础: Next.js 16.2.6 + Supabase PostgreSQL_

---

## 一、菜单树

### Admin / Boss 导航（11 项）

```
Dashboard        /dashboard      驾驶舱
Leads            /leads          线索
Quotes           /quotes         产品/报价
Contracts        /contracts       合同
Payments         /payments        回款
Projects         /projects        项目
Pipeline         /pipeline        销售漏斗
── 系统工具 ──
Ads              /ads             投放
Products         /products        产品库
Team             /team            团队
Settings         /settings        设置
```

### Sales 导航（6 项）

```
My Desk          /dashboard      我的工作台
My Leads         /leads          我的线索
Quotes           /quotes         产品/报价
My Contracts     /contracts       我的合同
My Payments      /payments        我的回款
My Stats         /pipeline        我的业绩
```

---

## 二、数据库 Schema

### 核心表关系图

```
auth.users
  └─ profiles (id → auth.users.id)

leads
  ├─ assigned_to → profiles
  ├─ owner → profiles
  ├─ sales_manager → profiles
  └─ 1:N → chat_messages, activities, business_events, lead_workflow_stages

customers
  └─ lead_id → leads

projects
  ├─ customer_id → customers
  ├─ lead_id → leads
  ├─ contract_id → contracts
  ├─ sales_id → profiles
  ├─ project_manager → profiles
  └─ assigned_to → profiles

quotations
  ├─ lead_id → leads
  └─ created_by → profiles

contracts
  ├─ lead_id → leads
  ├─ quotation_id → quotations
  ├─ customer_id → customers
  ├─ sales_id → profiles
  └─ created_by → profiles

installment_plans
  └─ contract_id → contracts

payments
  ├─ contract_id → contracts
  ├─ installment_plan_id → installment_plans
  ├─ created_by → profiles
  └─ confirmed_by → profiles

activities
  ├─ lead_id → leads
  ├─ customer_id → customers
  ├─ project_id → projects
  ├─ contract_id → contracts
  ├─ quotation_id → quotations
  └─ user_id → profiles

quotes (legacy)
  ├─ project_id → projects
  └─ lead_id → leads
```

---

### profiles
| 列 | 类型 | 约束 |
|---|---|---|
| id | UUID PK | FK → auth.users, CASCADE |
| role | TEXT | CHECK: admin/manager/sales/designer |
| full_name | TEXT | |
| phone | TEXT | |
| avatar_url | TEXT | |
| manager_id | UUID | FK → profiles |
| created_at | TIMESTAMPTZ | DEFAULT now() |
| updated_at | TIMESTAMPTZ | DEFAULT now() |

### leads
| 列 | 类型 | 约束 |
|---|---|---|
| id | UUID PK | gen_random_uuid() |
| source | TEXT | NOT NULL, CHECK: meta_ads/whatsapp/website/offline/referral/other |
| quality | TEXT | CHECK: pending/valid/job_seeker/fake/duplicate |
| stage | TEXT | CHECK: new/contacted/requirement_confirmed/solution_submitted/quotation_submitted/negotiation/pending_decision/won/lost |
| lead_status | TEXT | CHECK: hot/warm/cold/dormant |
| ai_quality | TEXT | CHECK: hot/warm/cold |
| win_probability | INTEGER | CHECK: 10/30/50/70/90 |
| quotation_value | DECIMAL | |
| customer_name | TEXT | |
| phone | TEXT | |
| email | TEXT | |
| company | TEXT | |
| project_type | TEXT | |
| location | TEXT | |
| meta_click_id | TEXT | |
| meta_campaign | TEXT | |
| meta_ad_id | TEXT | |
| meta_adset_id | TEXT | |
| notes | TEXT | |
| next_action | TEXT | |
| last_contact_date | TIMESTAMPTZ | |
| next_followup_date | TIMESTAMPTZ | |
| followup_count | INTEGER | |
| recovery_candidate | BOOLEAN | |
| transfer_candidate | BOOLEAN | |
| sales_manager_review | BOOLEAN | |
| hold_since | TIMESTAMPTZ | |
| rep_name | TEXT | |
| assigned_to | UUID | FK → profiles |
| owner | UUID | FK → profiles |
| sales_manager | UUID | FK → profiles |
| created_at | TIMESTAMPTZ | DEFAULT now() |
| updated_at | TIMESTAMPTZ | DEFAULT now() |

### customers
| 列 | 类型 | 约束 |
|---|---|---|
| id | UUID PK | gen_random_uuid() |
| lead_id | UUID | FK → leads |
| name | TEXT | |
| phone | TEXT | |
| email | TEXT | |
| company | TEXT | |
| assigned_sales_id | UUID | FK → profiles |
| created_at | TIMESTAMPTZ | DEFAULT now() |

### projects
| 列 | 类型 | 约束 |
|---|---|---|
| id | UUID PK | gen_random_uuid() |
| customer_id | UUID | FK → customers |
| lead_id | UUID | FK → leads |
| contract_id | UUID | FK → contracts |
| name | TEXT | NOT NULL |
| property_type | TEXT | |
| property_size | INTEGER | |
| location | TEXT | |
| phase | TEXT | CHECK: design/procurement/installation/commissioning/handover/warranty/completed |
| status | TEXT | CHECK: active/on_hold/completed/cancelled |
| cad_url | TEXT | |
| quote_url | TEXT | |
| ppt_url | TEXT | |
| contract_url | TEXT | |
| quoted_amount | DECIMAL(12,2) | |
| contract_amount | DECIMAL(12,2) | |
| paid_amount | DECIMAL(12,2) | |
| budget | DECIMAL | |
| actual_cost | DECIMAL | |
| start_date | DATE | |
| end_date | DATE | |
| description | TEXT | |
| sales_id | UUID | FK → profiles |
| project_manager | UUID | FK → profiles |
| assigned_to | UUID | FK → profiles |
| created_at | TIMESTAMPTZ | DEFAULT now() |
| updated_at | TIMESTAMPTZ | DEFAULT now() |

### quotations (new — 报价单)
| 列 | 类型 | 约束 |
|---|---|---|
| id | UUID PK | gen_random_uuid() |
| lead_id | UUID | NOT NULL, FK → leads, SET NULL |
| project_id | UUID | FK → projects |
| customer_id | UUID | FK → customers |
| created_by | UUID | FK → profiles |
| quote_no | TEXT | NOT NULL, UNIQUE |
| version | INTEGER | DEFAULT 1 |
| status | TEXT | CHECK: draft/sent/accepted/rejected/expired |
| meta_ads_campaign | TEXT | |
| meta_ads_adset | TEXT | |
| meta_ads_ad | TEXT | |
| currency | TEXT | DEFAULT 'AED' |
| subtotal | DECIMAL(12,2) | |
| discount_pct | DECIMAL(5,2) | |
| discount_amount | DECIMAL(12,2) | |
| vat_pct | DECIMAL(5,2) | DEFAULT 5.00 |
| vat_amount | DECIMAL(12,2) | |
| total_amount | DECIMAL(12,2) | |
| pdf_url | TEXT | |
| ppt_url | TEXT | |
| devices | JSONB | |
| device_details | JSONB | |
| notes | TEXT | |
| valid_until | TIMESTAMPTZ | |
| accepted_at | TIMESTAMPTZ | |
| created_at | TIMESTAMPTZ | DEFAULT now() |
| updated_at | TIMESTAMPTZ | DEFAULT now() |

### contracts
| 列 | 类型 | 约束 |
|---|---|---|
| id | UUID PK | gen_random_uuid() |
| lead_id | UUID | NOT NULL, FK → leads, SET NULL |
| quotation_id | UUID | FK → quotations |
| customer_id | UUID | FK → customers |
| sales_id | UUID | FK → profiles |
| created_by | UUID | FK → profiles |
| contract_no | TEXT | NOT NULL, UNIQUE |
| contract_date | DATE | NOT NULL, DEFAULT CURRENT_DATE |
| contract_amount | DECIMAL(12,2) | NOT NULL, CHECK > 0 |
| currency | TEXT | DEFAULT 'AED' |
| party_a_name | TEXT | NOT NULL |
| party_a_contact | TEXT | |
| party_b_name | TEXT | DEFAULT 'NewMe Smart Home FZCO' |
| party_b_contact | TEXT | |
| file_url | TEXT | |
| file_metadata | JSONB | |
| status | TEXT | CHECK: draft/active/completed/terminated |
| approval_status | TEXT | CHECK: none/pending/approved/rejected |
| notes | TEXT | |
| terminated_reason | TEXT | |
| terminated_at | TIMESTAMPTZ | |
| created_at | TIMESTAMPTZ | DEFAULT now() |
| updated_at | TIMESTAMPTZ | DEFAULT now() |

### installment_plans
| 列 | 类型 | 约束 |
|---|---|---|
| id | UUID PK | gen_random_uuid() |
| contract_id | UUID | NOT NULL, FK → contracts, CASCADE |
| seq | INTEGER | |
| label | TEXT | |
| amount | DECIMAL(12,2) | NOT NULL, CHECK > 0 |
| due_date | DATE | |
| status | TEXT | CHECK: pending/paid/overdue/cancelled |
| UNIQUE | (contract_id, seq) | |

### payments
| 列 | 类型 | 约束 |
|---|---|---|
| id | UUID PK | gen_random_uuid() |
| contract_id | UUID | NOT NULL, FK → contracts, CASCADE |
| installment_plan_id | UUID | FK → installment_plans |
| created_by | UUID | FK → profiles |
| confirmed_by | UUID | FK → profiles |
| amount | DECIMAL(12,2) | NOT NULL, CHECK > 0 |
| payment_date | DATE | |
| payment_method | TEXT | CHECK: bank_transfer/cash/cheque/card/other |
| reference_no | TEXT | |
| notes | TEXT | |
| overpayment_action | TEXT | CHECK: refund/credit/adjust |
| overpayment_amount | DECIMAL(12,2) | |
| created_at | TIMESTAMPTZ | DEFAULT now() |

### products
| 列 | 类型 | 约束 |
|---|---|---|
| id | UUID PK | gen_random_uuid() |
| sku | TEXT | NOT NULL, UNIQUE |
| name | TEXT | NOT NULL |
| name_zh | TEXT | |
| category | TEXT | |
| brand | TEXT | |
| unit | TEXT | |
| unit_price | DECIMAL(12,2) | |
| description | TEXT | |
| image_url | TEXT | |
| is_active | BOOLEAN | DEFAULT true |
| tenant_id | UUID | FK → tenants |
| created_at | TIMESTAMPTZ | DEFAULT now() |
| updated_at | TIMESTAMPTZ | DEFAULT now() |

### activities
| 列 | 类型 | 约束 |
|---|---|---|
| id | UUID PK | gen_random_uuid() |
| lead_id | UUID | FK → leads, CASCADE |
| customer_id | UUID | FK → customers |
| project_id | UUID | FK → projects |
| contract_id | UUID | FK → contracts |
| quotation_id | UUID | FK → quotations |
| user_id | UUID | FK → profiles |
| type | TEXT | NOT NULL, CHECK: call/whatsapp/email/meeting/quote_sent/follow_up/note/stage_change/quality_change/contract_signed/payment_received/design_submitted/installation/commissioning/handover |
| content | TEXT | |
| priority | TEXT | CHECK: low/normal/high/urgent |
| created_at | TIMESTAMPTZ | DEFAULT now() |

### lead_workflow_stages
| 列 | 类型 | 约束 |
|---|---|---|
| id | UUID PK | gen_random_uuid() |
| lead_id | UUID | NOT NULL, FK → leads, CASCADE |
| stage_key | TEXT | CHECK: basic_info/requirements/design_proposal/contract/decision |
| stage_order | INTEGER | |
| weight | INTEGER | CHECK: 20/30/50/60/80 |
| status | TEXT | CHECK: pending/in_progress/completed/skipped |
| assigned_to | UUID | FK → profiles |
| started_at | TIMESTAMPTZ | |
| completed_at | TIMESTAMPTZ | |
| deadline_at | TIMESTAMPTZ | |
| notified_24h | BOOLEAN | |
| notified_48h | BOOLEAN | |
| notes | TEXT | (JSON: form data) |
| UNIQUE | (lead_id, stage_key) | |

### chat_messages
| 列 | 类型 | 约束 |
|---|---|---|
| id | UUID PK | gen_random_uuid() |
| lead_id | UUID | FK → leads, CASCADE |
| wa_message_id | TEXT | UNIQUE |
| direction | TEXT | NOT NULL, CHECK: inbound/outbound |
| content | TEXT | |
| created_at | TIMESTAMPTZ | DEFAULT now() |

### business_events
| 列 | 类型 | 约束 |
|---|---|---|
| id | UUID PK | gen_random_uuid() |
| lead_id | UUID | FK → leads, CASCADE |
| entity_type | TEXT | NOT NULL, CHECK: lead/customer/project/quote |
| event_type | TEXT | NOT NULL, CHECK: stage_changed/quality_changed/assigned/note_added/contacted/quotation_sent/contract_signed/payment_received/design_submitted/installation/commissioning/handover/project_created |
| description | TEXT | |
| event_data | JSONB | |
| created_by | UUID | FK → profiles |
| created_at | TIMESTAMPTZ | DEFAULT now() |

### kpi_targets
| 列 | 类型 | 约束 |
|---|---|---|
| id | UUID PK | gen_random_uuid() |
| period | TEXT | |
| target_type | TEXT | NOT NULL, CHECK: signing/collection |
| target_amount | DECIMAL(12,2) | |
| assigned_to | UUID | FK → profiles |
| set_by | UUID | FK → profiles |
| set_at | TIMESTAMPTZ | |
| UNIQUE | (period, target_type, assigned_to) | |

### quotes (legacy)
| 列 | 类型 | 约束 |
|---|---|---|
| id | UUID PK | gen_random_uuid() |
| project_id | UUID | FK → projects |
| lead_id | UUID | FK → leads |
| version | INTEGER | DEFAULT 1 |
| devices | JSONB | |
| device_details | JSONB | |
| subtotal | DECIMAL(12,2) | |
| discount | DECIMAL(12,2) | |
| vat | DECIMAL(12,2) | |
| total | DECIMAL(12,2) | |
| status | TEXT | CHECK: draft/sent/approved/rejected |
| quote_url | TEXT | |
| ppt_url | TEXT | |
| created_at | TIMESTAMPTZ | |
| updated_at | TIMESTAMPTZ | |

---

## 三、Lead Pipeline 阶段流转

```
new → contacted → requirement_confirmed → solution_submitted
  → quotation_submitted → negotiation → pending_decision
  → won | lost
```

---

## 四、Workflow 阶段（AI 销售助理）

| 阶段 | 权重 | 累计 | 时限 |
|------|------|------|------|
| basic_info | 20% | 20% | 24h |
| requirements | 30% | 50% | 48h |
| design_proposal | 50% | — | 24h (48h→管理层) |
| contract | 60% | — | 48h |
| decision | 80% | — | 72h |
