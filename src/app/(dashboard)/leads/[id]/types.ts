// Shared types and constants for the Lead Detail three-column layout.
// Extracted from page.tsx during the three-column refactor — see
// .hermes/tasks/ld-three-column-refactor.md. Pure types/data only (no JSX),
// so this is a plain .ts module importable by every column component.

import type { ReactNode } from "react";

// ─── Stage data ───
export const STAGES: string[] = [
  "new",
  "contacted",
  "requirement_confirmed",
  "solution_submitted",
  "quotation_submitted",
  "negotiation",
  "pending_decision",
  "won",
  "lost",
];

export const STAGE_COLORS: Record<string, string> = {
  new: "bg-gray-500/10 text-muted-foreground",
  contacted: "bg-amber-500/10 text-amber-400",
  requirement_confirmed: "bg-yellow-500/10 text-yellow-400",
  solution_submitted: "bg-rose-500/10 text-rose-400",
  quotation_submitted: "bg-purple-500/10 text-purple-400",
  negotiation: "bg-blue-500/10 text-blue-400",
  pending_decision: "bg-amber-500/10 text-amber-400",
  won: "bg-emerald-500/10 text-emerald-400",
  lost: "bg-gray-500/10 text-muted-foreground",
};

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
  smart_requirements: any | null;
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
}

export interface Activity {
  id: string;
  type: string;
  content: string;
  ai_generated: boolean;
  created_at: string;
}

export interface BusinessEvent {
  id: string;
  event_type: string;
  description: string;
  event_data: any;
  created_at: string;
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
  created_at: string;
}

export interface LeadMilestone {
  id: string;
  lead_id: string;
  milestone_key: string;
  completed: boolean;
  completed_at: string | null;
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
export type RenderInlineEdit = (field: string, label: string, type?: string) => ReactNode;
export type RenderDateEdit = (field: string, label: string) => ReactNode;
export type RenderJsonEdit = (field: string, label: string) => ReactNode;
