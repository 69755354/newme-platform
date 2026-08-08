// Shared types and constants for the Lead Detail three-column layout.
// Extracted from page.tsx during the three-column refactor — see
// .hermes/tasks/ld-three-column-refactor.md. Pure types/data only (no JSX),
// so this is a plain .ts module importable by every column component.

import type { ReactNode } from "react";
import type { Database, Json } from "@/types/database";
import { PIPELINE_STAGES } from "@/shared/kanban/types";

// ─── Stage data ───
export const STAGES: string[] = PIPELINE_STAGES.map((stage) => stage.key);

export const STAGE_COLORS: Record<string, string> = Object.fromEntries(
  PIPELINE_STAGES.map((stage) => [stage.key, stage.color])
);

export const PROBABILITIES = [10, 30, 50, 70, 90];

export const LOST_REASON_KEYS = [
  "price",
  "competitor",
  "noBudget",
  "cancelled",
  "delayed",
  "noResponse",
  "other",
];

// ─── Row interfaces (mirror the supabase tables / views) ───
export interface Lead {
  id: string;
  source: string;
  quality: string;
  poor_reason: string | null;
  stage: string;
  final_status: string | null;
  customer_name: string | null;
  phone: string | null;
  email: string | null;
  property_type: string | null;
  property_size_sqm: number | null;
  location: string | null;
  budget_range: string | null;
  service_needs: string[] | null;
  ai_summary: string | null;
  ai_tags: string[] | null;
  ai_quality: string | null;
  created_at: string;
  updated_at: string;
  disqualified_candidate: boolean;
  notes: string | null;
  lead_status: string | null;
  win_probability: number | null;
  stage_changed_at: string | null;
  decision_maker: string | null;
  decision_date: string | null;
  competitor: string | null;
  last_contact_date: string | null;
  next_followup_date: string | null;
  next_action: string | null;
  followup_count: number | null;
  lost_reason: string | null;
  lost_at: string | null;
  sales_manager_review: boolean;
  recovery_candidate: boolean;
  transfer_candidate: boolean;
  hold_since: string | null;
  source_platform: string | null;
  source_channel: string | null;
  campaign_id: string | null;
  campaign_name: string | null;
  adset_id: string | null;
  adset_name: string | null;
  ad_id: string | null;
  ad_name: string | null;
  creative_id: string | null;
  creative_name: string | null;
  form_id: string | null;
  form_name: string | null;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  utm_content: string | null;
  utm_term: string | null;
  landing_page: string | null;
  referrer: string | null;
  first_touch_at: string | null;
  last_touch_at: string | null;
  assigned_to: string | null;
  rep_name: string | null;
  quotation_value: number | null;
  project_name: string | null;
  project_status: string | null;
  ac_brand: string | null;
  system_preference: string | null;
  // Phase B extension fields
  project_type: string | null;
  emirate: string | null;
  area: string | null;
  customer_budget: number | null;
  smart_requirements: Json | null;
  raw_import_data?: Record<string, unknown> | null;
  expected_sign_date: string | null;
  visit_status: string | null;
  rejection_detail: string | null;
  circuit_diagrams: boolean | null;
  sales_phase: string | null;
  phase_pct: number | null;
  sub_phase: string | null;
  quotation_sent_date: string | null;
  reminder_24h_sent: boolean | null;
  reminder_48h_sent: boolean | null;
  created_by: string | null;
  creator_name: string | null;
  // ── P0-1 embed children (PostgREST JOIN via lead query) ──────────────
  // Populated by the optimised fetchData batch — may be missing for leads
  // fetched outside that path (e.g. server-side prefetch). All optional.
  /** Creator profile (FK fk_leads_created_by) */
  creator?: ProfileEmbed | null;
  /** Assignee profile (FK fk_leads_assigned_to) */
  assignee?: ProfileEmbed | null;
  /** All follow_up_logs for this lead (FK follow_up_logs_lead_id_fkey) */
  follow_ups?: FollowUpLogEmbed[];
  /** All lead_milestones for this lead (FK lead_milestones_lead_id_fkey) */
  milestones?: LeadMilestoneEmbed[];
  /** All business_events for this lead (FK business_events_lead_id_fkey) */
  business_events?: BusinessEventEmbed[];
  /** All tasks for this lead (FK tasks_lead_id_fkey); filtered client-side to next 1 */
  next_task?: TaskEmbed[];
  /** Customer info (FK fk_leads_customer_id) — currently always null (all leads have customer_id=NULL) */
  customer?: CustomerEmbed | null;
  /** Convenience pointer — set by fetchData() from embed */
  creator_profile?: ProfileEmbed | null;
  assignee_profile?: ProfileEmbed | null;
}

/** Profile row shape returned by embed hints (subset of full profile) */
export interface ProfileEmbed {
  id: string;
  full_name: string | null;
  email: string | null;
  role: string | null;
}

/** follow_up_logs row shape returned by embed (subset) */
export interface FollowUpLogEmbed {
  id: string;
  contact_type: string;
  summary: string;
  user_id: string | null;
  contact_time: string | null;
  created_at: string;
}

/** lead_milestones row shape returned by embed (subset) */
export interface LeadMilestoneEmbed {
  id: string;
  lead_id?: string;
  milestone_key: string;
  completed_at: string | null;
  completed_by?: string | null;
  notes?: string | null;
  completer?: { id: string; full_name: string | null } | null;
}

/** business_events row shape returned by embed (subset, with operator) */
export interface BusinessEventEmbed {
  id: string;
  event_type: string;
  event_data: Json | null;
  description: string | null;
  created_at: string;
  user_id: string | null;
  operator?: { id: string; full_name: string | null } | null;
}

export interface TransferHistoryEmbed {
  id: string;
  from_user_id: string | null;
  to_user_id: string;
  reason: string | null;
  created_at: string | null;
  transferred_by: string;
  from_user?: { id: string; full_name: string | null } | null;
  to_user?: { id: string; full_name: string | null } | null;
  operator?: { id: string; full_name: string | null } | null;
}

/** tasks row shape returned by embed (subset) */
export interface TaskEmbed {
  id: string;
  title: string;
  due_at: string | null;
  completed_at?: string | null;
}

/** customers row shape returned by embed (subset, future-proof for when customer_id becomes populated) */
export interface CustomerEmbed {
  id: string;
  name?: string | null;
  email?: string | null;
  phone?: string | null;
}

// (FetchResult<T> removed — Hermes 2 审 determined unused, dead code W1)

export interface Activity {
  id: string;
  type: string;
  content: string;
  ai_generated: boolean;
  created_at: string;
  user_id: string | null;
  metadata: Json | null;
}

export interface SalesUser {
  id: string;
  email: string | null;
  role: string | null;
  full_name: string | null;
}

export interface BusinessEvent {
  id: string;
  event_type: string;
  description: string;
  event_data: Json | null;
  created_at: string;
  user_id: string | null;
}

export interface ChatMessage {
  id: string;
  content: string | null;
  direction: string;
  created_at: string;
}

export interface Task {
  id: string;
  title: string;
  due_at: string;
  completed_at?: string | null;
}

// follow_up_logs row — immutable CRM v3 activity log. `contact_type` acts as the
// "type" (e.g. 'note', 'phone', 'whatsapp', 'import_note'), `summary` is the content,
// `user_id` is the author (created_by). See migration 20260623020001_crm_v3_new_tables.sql.
export interface FollowUpLog {
  id: string;
  contact_type: string;
  summary: string;
  user_id: string | null;
  contact_time: string | null;
  contact_result?: string | null;
  created_at: string;
}

export interface LeadMilestone {
  id: string;
  lead_id: string;
  milestone_key: string;
  completed: boolean;
  completed_at: string | null;
  completed_by?: string | null;
  notes?: string | null;
  completer?: { id: string; full_name: string | null } | null;
}

export interface LeadTrace {
  lead_id: string;
  customer_name: string | null;
  stage: string;
  quotation_value: number | null;
  quotation_id: string | null;
  quotation_price: number | null;
  quotation_status: string | null;
  contract_id: string | null;
  contract_no: string | null;
  contract_amount: number | null;
  contract_status: string | null;
  installment_id: string | null;
  seq: number | null;
  installment_amount: number | null;
  due_date: string | null;
  installment_status: string | null;
  payment_id: string | null;
  payment_amount: number | null;
  payment_date: string | null;
  confirmed: boolean | null;
  project_id: string | null;
  project_name: string | null;
  project_phase: string | null;
  project_status: string | null;
}

// ─── Render-closure types ───
// page.tsx owns the shared editField/editValue state and the updateField /
// updateNextTask handlers. To preserve the exact single-edit-at-a-time behavior
// across all three columns, it passes these render closures down as props instead
// of duplicating edit state into each child.
type LeadUpdate = Database["public"]["Tables"]["leads"]["Update"];
export type LeadField = Extract<keyof Lead, keyof LeadUpdate>;
export type LeadTextField = {
  [K in LeadField]: Exclude<LeadUpdate[K], null | undefined> extends string ? K : never;
}[LeadField];
export type LeadDateField = Extract<LeadField, "expected_sign_date" | "decision_date" | "last_contact_date">;
export type LeadJsonField = Extract<LeadField, "smart_requirements" | "raw_import_data" | "devices_json">;
export type LeadFieldUpdater = <K extends keyof LeadUpdate>(
  field: K,
  value: LeadUpdate[K],
  eventType?: string,
  eventDesc?: string
) => Promise<boolean> | void;

export type RenderInlineEdit = (field: LeadField, label: string, type?: string) => ReactNode;
export type RenderDateEdit = (field: LeadField, label: string) => ReactNode;
export type RenderJsonEdit = (field: LeadField, label: string) => ReactNode;
