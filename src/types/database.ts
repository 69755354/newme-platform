// Migration fingerprint: sha256=6a8c1ac9118bc5e3582abed55bc35b9ac2c33e7daf711f89bef1a751cd3fd1c7
export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

type GeneratedTable<Row, RequiredInsert extends keyof Row = never> = {
  Row: Row
  Insert: Partial<Row> & Pick<Row, RequiredInsert>
  Update: Partial<Row>
  Relationships: []
}

type CommercialPlanVersionRow = {
  id: string; plan_key: string; version: number; display_name: string
  paid_seat_limit: number; organization_limit: number | null
  included_entitlements: Json; effective_from: string; effective_until: string | null
  is_active: boolean; created_at: string
}
type OrganizationSubscriptionRow = {
  id: string; organization_id: string; plan_version_id: string; lifecycle_state: string
  invoice_mode: string; paid_seat_limit: number; trial_ends_at: string | null
  grace_ends_at: string | null; current_period_start: string
  current_period_end: string | null; version: number; created_at: string; updated_at: string
}
type CommercialEntitlementRow = {
  id: string; organization_id: string; entitlement_key: string; enabled: boolean
  numeric_limit: number | null; source: string; source_ref: string
  created_at: string; updated_at: string
}
type PaidSeatAllocationRow = {
  id: string; organization_id: string; membership_id: string; status: string
  allocation_key: string; allocated_at: string; released_at: string | null; created_at: string
}
type CommercialSeatEventRow = {
  id: string; organization_id: string; allocation_id: string; delta: number
  seats_before: number; seats_after: number; event_key: string
  actor_platform_staff_id: string | null; created_at: string
}
type CommercialUsageEventRow = {
  id: string; organization_id: string; metric_key: string; quantity: number
  idempotency_key: string; source: string; period_start: string; period_end: string
  metadata: Json; created_at: string
}
type CommercialInvoiceReferenceRow = {
  id: string; organization_id: string; invoice_ref: string; source: string; status: string
  amount_minor: number; currency: string; due_at: string | null; paid_at: string | null
  metadata: Json; created_at: string; updated_at: string
}
type CommercialActionRequestRow = {
  id: string; organization_id: string; action_key: string; payload: Json; payload_hash: string
  status: string; requested_by_platform_staff_id: string
  approved_by_platform_staff_id: string | null; request_key: string
  execution_key: string | null; execution_result: Json | null; requested_at: string
  approved_at: string | null; consumed_at: string | null; expires_at: string
}
type CommercialActionEventRow = {
  id: string; request_id: string; organization_id: string; actor_platform_staff_id: string
  event_type: string; event_key: string; metadata: Json; created_at: string
}
type CommercialStateEventRow = {
  id: string; organization_id: string; subscription_id: string; from_state: string
  to_state: string; reason: string; action_request_id: string | null; created_at: string
}
type CommercialMigrationSnapshotRow = {
  organization_id: string; plan_key: string; billable_seat_limit: number
  organization_status: string; captured_at: string
}
type AgentGatewayCommandRow = {
  id: string; organization_id: string; actor_user_id: string; command_key: string; risk_level: string
  required_capability: string | null; access_mode: string; channel: string; correlation_id: string
  idempotency_key: string; payload: Json; payload_sha256: string; event_signature: string
  credential_fingerprint: string; credential_expires_at: string; approval_id: string | null
  adapter_state: string; status: string; created_at: string
}
type AgentGatewayEventRow = {
  id: string; command_id: string; organization_id: string; actor_user_id: string; correlation_id: string
  event_type: string; event_signature: string; metadata: Json; created_at: string
}
type AgentGatewayAdapterRow = { adapter_key: string; enabled: boolean; created_at: string }

export type Database = {
  public: {
    Tables: {
      agent_gateway_adapter_registry: GeneratedTable<AgentGatewayAdapterRow, "adapter_key">
      agent_gateway_commands: GeneratedTable<AgentGatewayCommandRow,
        "organization_id" | "actor_user_id" | "command_key" | "risk_level" | "access_mode"
        | "channel" | "correlation_id" | "idempotency_key" | "payload_sha256" | "event_signature"
        | "credential_fingerprint" | "credential_expires_at" | "status">
      agent_gateway_events: GeneratedTable<AgentGatewayEventRow,
        "command_id" | "organization_id" | "actor_user_id" | "correlation_id" | "event_type" | "event_signature">
      commercial_action_events: GeneratedTable<CommercialActionEventRow,
        "request_id" | "organization_id" | "actor_platform_staff_id" | "event_type" | "event_key">
      commercial_action_requests: GeneratedTable<CommercialActionRequestRow,
        "organization_id" | "action_key" | "payload" | "payload_hash"
        | "requested_by_platform_staff_id" | "request_key">
      commercial_entitlements: GeneratedTable<CommercialEntitlementRow,
        "organization_id" | "entitlement_key" | "source" | "source_ref">
      commercial_invoice_references: GeneratedTable<CommercialInvoiceReferenceRow,
        "organization_id" | "invoice_ref" | "status" | "amount_minor" | "currency">
      commercial_migration_org_snapshots: GeneratedTable<CommercialMigrationSnapshotRow,
        "organization_id" | "plan_key" | "billable_seat_limit" | "organization_status">
      commercial_plan_versions: GeneratedTable<CommercialPlanVersionRow,
        "plan_key" | "version" | "display_name" | "paid_seat_limit" | "effective_from">
      commercial_seat_events: GeneratedTable<CommercialSeatEventRow,
        "organization_id" | "allocation_id" | "delta" | "seats_before" | "seats_after" | "event_key">
      commercial_state_events: GeneratedTable<CommercialStateEventRow,
        "organization_id" | "subscription_id" | "from_state" | "to_state" | "reason">
      commercial_usage_events: GeneratedTable<CommercialUsageEventRow,
        "organization_id" | "metric_key" | "quantity" | "idempotency_key"
        | "source" | "period_start" | "period_end">
      organization_subscriptions: GeneratedTable<OrganizationSubscriptionRow,
        "organization_id" | "plan_version_id" | "paid_seat_limit">
      paid_seat_allocations: GeneratedTable<PaidSeatAllocationRow,
        "organization_id" | "membership_id" | "allocation_key">
      activities: {
        Row: {
          ai_generated: boolean | null
          content: string | null
          contract_id: string | null
          created_at: string | null
          customer_id: string | null
          due_at: string | null
          duration: number | null
          id: string
          is_completed: boolean | null
          lead_id: string | null
          metadata: Json | null
          organization_id: string
          priority: string | null
          project_id: string | null
          quotation_id: string | null
          type: string
          user_id: string | null
        }
        Insert: {
          ai_generated?: boolean | null
          content?: string | null
          contract_id?: string | null
          created_at?: string | null
          customer_id?: string | null
          due_at?: string | null
          duration?: number | null
          id?: string
          is_completed?: boolean | null
          lead_id?: string | null
          metadata?: Json | null
          organization_id?: string
          priority?: string | null
          project_id?: string | null
          quotation_id?: string | null
          type: string
          user_id?: string | null
        }
        Update: {
          ai_generated?: boolean | null
          content?: string | null
          contract_id?: string | null
          created_at?: string | null
          customer_id?: string | null
          due_at?: string | null
          duration?: number | null
          id?: string
          is_completed?: boolean | null
          lead_id?: string | null
          metadata?: Json | null
          organization_id?: string
          priority?: string | null
          project_id?: string | null
          quotation_id?: string | null
          type?: string
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "activities_contract_id_fkey"
            columns: ["contract_id"]
            isOneToOne: false
            referencedRelation: "contracts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "activities_contract_id_fkey"
            columns: ["contract_id"]
            isOneToOne: false
            referencedRelation: "v_account_receivable_aging"
            referencedColumns: ["contract_id"]
          },
          {
            foreignKeyName: "activities_contract_id_fkey"
            columns: ["contract_id"]
            isOneToOne: false
            referencedRelation: "v_lead_trace"
            referencedColumns: ["contract_id"]
          },
          {
            foreignKeyName: "activities_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "activities_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "lead_alerts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "activities_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "activities_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "v_lead_trace"
            referencedColumns: ["lead_id"]
          },
          {
            foreignKeyName: "activities_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "v_risk_pool"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "activities_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "v_stagnant_leads"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "activities_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "activities_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "v_sam23_organization_commercial_summary"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "activities_organization_lead_fkey"
            columns: ["organization_id", "lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["organization_id", "id"]
          },
          {
            foreignKeyName: "activities_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "activities_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "v_lead_trace"
            referencedColumns: ["project_id"]
          },
          {
            foreignKeyName: "activities_quotation_id_fkey"
            columns: ["quotation_id"]
            isOneToOne: false
            referencedRelation: "quotations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "activities_quotation_id_fkey"
            columns: ["quotation_id"]
            isOneToOne: false
            referencedRelation: "v_lead_trace"
            referencedColumns: ["quotation_id"]
          },
          {
            foreignKeyName: "activities_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "activities_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "sales_performance"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "activities_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "v_sales_personal_stats"
            referencedColumns: ["user_id"]
          },
        ]
      }
      activity_logs: {
        Row: {
          action: string
          created_at: string | null
          details: Json | null
          duration_seconds: number | null
          entity_id: string | null
          entity_type: string | null
          id: string
          ip_address: unknown
          organization_id: string
          page_path: string | null
          session_id: string | null
          tenant_id: string
          user_agent: string | null
          user_id: string
        }
        Insert: {
          action: string
          created_at?: string | null
          details?: Json | null
          duration_seconds?: number | null
          entity_id?: string | null
          entity_type?: string | null
          id?: string
          ip_address?: unknown
          organization_id?: string
          page_path?: string | null
          session_id?: string | null
          tenant_id?: string
          user_agent?: string | null
          user_id: string
        }
        Update: {
          action?: string
          created_at?: string | null
          details?: Json | null
          duration_seconds?: number | null
          entity_id?: string | null
          entity_type?: string | null
          id?: string
          ip_address?: unknown
          organization_id?: string
          page_path?: string | null
          session_id?: string | null
          tenant_id?: string
          user_agent?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "activity_logs_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "activity_logs_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "v_sam23_organization_commercial_summary"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "activity_logs_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "activity_logs_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "sales_performance"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "activity_logs_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "v_sales_personal_stats"
            referencedColumns: ["user_id"]
          },
        ]
      }
      ad_spend: {
        Row: {
          ad_name: string | null
          adset_name: string | null
          amount: number | null
          campaign_name: string | null
          clicks: number | null
          created_at: string | null
          currency: string | null
          id: string
          impressions: number | null
          organization_id: string
          source: string | null
          spend_date: string | null
        }
        Insert: {
          ad_name?: string | null
          adset_name?: string | null
          amount?: number | null
          campaign_name?: string | null
          clicks?: number | null
          created_at?: string | null
          currency?: string | null
          id?: string
          impressions?: number | null
          organization_id?: string
          source?: string | null
          spend_date?: string | null
        }
        Update: {
          ad_name?: string | null
          adset_name?: string | null
          amount?: number | null
          campaign_name?: string | null
          clicks?: number | null
          created_at?: string | null
          currency?: string | null
          id?: string
          impressions?: number | null
          organization_id?: string
          source?: string | null
          spend_date?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "ad_spend_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ad_spend_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "v_sam23_organization_commercial_summary"
            referencedColumns: ["organization_id"]
          },
        ]
      }
      audit_events: {
        Row: {
          action: string
          actor_platform_staff_id: string | null
          actor_user_id: string | null
          id: string
          metadata: Json
          occurred_at: string
          organization_id: string | null
          outcome: string
          reason: string | null
          request_id: string
          support_session_id: string | null
          target_id: string | null
          target_type: string
        }
        Insert: {
          action: string
          actor_platform_staff_id?: string | null
          actor_user_id?: string | null
          id?: string
          metadata?: Json
          occurred_at?: string
          organization_id?: string | null
          outcome: string
          reason?: string | null
          request_id: string
          support_session_id?: string | null
          target_id?: string | null
          target_type: string
        }
        Update: {
          action?: string
          actor_platform_staff_id?: string | null
          actor_user_id?: string | null
          id?: string
          metadata?: Json
          occurred_at?: string
          organization_id?: string | null
          outcome?: string
          reason?: string | null
          request_id?: string
          support_session_id?: string | null
          target_id?: string | null
          target_type?: string
        }
        Relationships: [
          {
            foreignKeyName: "audit_events_actor_platform_staff_id_fkey"
            columns: ["actor_platform_staff_id"]
            isOneToOne: false
            referencedRelation: "platform_staff"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "audit_events_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "audit_events_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "v_sam23_organization_commercial_summary"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "audit_events_support_session_id_fkey"
            columns: ["support_session_id"]
            isOneToOne: false
            referencedRelation: "support_sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      audit_logs: {
        Row: {
          action: string
          actor_email: string | null
          actor_id: string | null
          created_at: string | null
          details: Json | null
          id: string
          ip_address: string | null
          organization_id: string
          target_id: string | null
          target_type: string | null
          user_agent: string | null
        }
        Insert: {
          action: string
          actor_email?: string | null
          actor_id?: string | null
          created_at?: string | null
          details?: Json | null
          id?: string
          ip_address?: string | null
          organization_id?: string
          target_id?: string | null
          target_type?: string | null
          user_agent?: string | null
        }
        Update: {
          action?: string
          actor_email?: string | null
          actor_id?: string | null
          created_at?: string | null
          details?: Json | null
          id?: string
          ip_address?: string | null
          organization_id?: string
          target_id?: string | null
          target_type?: string | null
          user_agent?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "audit_logs_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "audit_logs_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "v_sam23_organization_commercial_summary"
            referencedColumns: ["organization_id"]
          },
        ]
      }
      business_events: {
        Row: {
          created_at: string | null
          created_by: string | null
          description: string | null
          entity_id: string | null
          entity_type: string
          event_data: Json | null
          event_type: string
          id: string
          lead_id: string | null
          organization_id: string
          user_id: string | null
        }
        Insert: {
          created_at?: string | null
          created_by?: string | null
          description?: string | null
          entity_id?: string | null
          entity_type?: string
          event_data?: Json | null
          event_type: string
          id?: string
          lead_id?: string | null
          organization_id?: string
          user_id?: string | null
        }
        Update: {
          created_at?: string | null
          created_by?: string | null
          description?: string | null
          entity_id?: string | null
          entity_type?: string
          event_data?: Json | null
          event_type?: string
          id?: string
          lead_id?: string | null
          organization_id?: string
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "business_events_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "business_events_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "sales_performance"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "business_events_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "v_sales_personal_stats"
            referencedColumns: ["user_id"]
          },
          {
            foreignKeyName: "business_events_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "lead_alerts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "business_events_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "business_events_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "v_lead_trace"
            referencedColumns: ["lead_id"]
          },
          {
            foreignKeyName: "business_events_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "v_risk_pool"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "business_events_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "v_stagnant_leads"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "business_events_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "business_events_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "v_sam23_organization_commercial_summary"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "business_events_organization_lead_fkey"
            columns: ["organization_id", "lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["organization_id", "id"]
          },
          {
            foreignKeyName: "business_events_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "business_events_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "sales_performance"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "business_events_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "v_sales_personal_stats"
            referencedColumns: ["user_id"]
          },
          {
            foreignKeyName: "fk_business_events_user_id"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fk_business_events_user_id"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "sales_performance"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fk_business_events_user_id"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "v_sales_personal_stats"
            referencedColumns: ["user_id"]
          },
        ]
      }
      capabilities: {
        Row: {
          capability_key: string
          created_at: string
          description: string
          id: string
          scope: string
        }
        Insert: {
          capability_key: string
          created_at?: string
          description: string
          id?: string
          scope?: string
        }
        Update: {
          capability_key?: string
          created_at?: string
          description?: string
          id?: string
          scope?: string
        }
        Relationships: []
      }
      chat_messages: {
        Row: {
          content: string | null
          created_at: string | null
          direction: string
          extracted: Json | null
          from_number: string | null
          id: string
          lead_id: string | null
          media_type: string | null
          media_url: string | null
          organization_id: string
          sent_at: string | null
          to_number: string | null
          wa_message_id: string | null
        }
        Insert: {
          content?: string | null
          created_at?: string | null
          direction: string
          extracted?: Json | null
          from_number?: string | null
          id?: string
          lead_id?: string | null
          media_type?: string | null
          media_url?: string | null
          organization_id?: string
          sent_at?: string | null
          to_number?: string | null
          wa_message_id?: string | null
        }
        Update: {
          content?: string | null
          created_at?: string | null
          direction?: string
          extracted?: Json | null
          from_number?: string | null
          id?: string
          lead_id?: string | null
          media_type?: string | null
          media_url?: string | null
          organization_id?: string
          sent_at?: string | null
          to_number?: string | null
          wa_message_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "chat_messages_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "lead_alerts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "chat_messages_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "chat_messages_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "v_lead_trace"
            referencedColumns: ["lead_id"]
          },
          {
            foreignKeyName: "chat_messages_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "v_risk_pool"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "chat_messages_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "v_stagnant_leads"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "chat_messages_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "chat_messages_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "v_sam23_organization_commercial_summary"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "chat_messages_organization_lead_fkey"
            columns: ["organization_id", "lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["organization_id", "id"]
          },
        ]
      }
      contract_approvals: {
        Row: {
          approver_id: string | null
          contract_id: string
          created_at: string | null
          id: string
          notes: Json | null
          organization_id: string
          reviewed_at: string | null
          status: string
          step: string
          tenant_id: string
        }
        Insert: {
          approver_id?: string | null
          contract_id: string
          created_at?: string | null
          id?: string
          notes?: Json | null
          organization_id: string
          reviewed_at?: string | null
          status?: string
          step: string
          tenant_id?: string
        }
        Update: {
          approver_id?: string | null
          contract_id?: string
          created_at?: string | null
          id?: string
          notes?: Json | null
          organization_id?: string
          reviewed_at?: string | null
          status?: string
          step?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "contract_approvals_approver_id_fkey"
            columns: ["approver_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "contract_approvals_approver_id_fkey"
            columns: ["approver_id"]
            isOneToOne: false
            referencedRelation: "sales_performance"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "contract_approvals_approver_id_fkey"
            columns: ["approver_id"]
            isOneToOne: false
            referencedRelation: "v_sales_personal_stats"
            referencedColumns: ["user_id"]
          },
          {
            foreignKeyName: "contract_approvals_contract_id_fkey"
            columns: ["contract_id"]
            isOneToOne: false
            referencedRelation: "contracts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "contract_approvals_contract_id_fkey"
            columns: ["contract_id"]
            isOneToOne: false
            referencedRelation: "v_account_receivable_aging"
            referencedColumns: ["contract_id"]
          },
          {
            foreignKeyName: "contract_approvals_contract_id_fkey"
            columns: ["contract_id"]
            isOneToOne: false
            referencedRelation: "v_lead_trace"
            referencedColumns: ["contract_id"]
          },
          {
            foreignKeyName: "contract_approvals_organization_contract_fkey"
            columns: ["organization_id", "contract_id"]
            isOneToOne: false
            referencedRelation: "contracts"
            referencedColumns: ["organization_id", "id"]
          },
          {
            foreignKeyName: "contract_approvals_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "contract_approvals_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "v_sam23_organization_commercial_summary"
            referencedColumns: ["organization_id"]
          },
        ]
      }
      contract_workflow_requests: {
        Row: {
          actor_user_id: string
          completed_at: string | null
          created_at: string
          operation: string
          organization_id: string
          payload_hash: string
          request_id: string
          result: Json | null
        }
        Insert: {
          actor_user_id: string
          completed_at?: string | null
          created_at?: string
          operation: string
          organization_id: string
          payload_hash: string
          request_id: string
          result?: Json | null
        }
        Update: {
          actor_user_id?: string
          completed_at?: string | null
          created_at?: string
          operation?: string
          organization_id?: string
          payload_hash?: string
          request_id?: string
          result?: Json | null
        }
        Relationships: [
          {
            foreignKeyName: "contract_workflow_requests_actor_user_id_fkey"
            columns: ["actor_user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "contract_workflow_requests_actor_user_id_fkey"
            columns: ["actor_user_id"]
            isOneToOne: false
            referencedRelation: "sales_performance"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "contract_workflow_requests_actor_user_id_fkey"
            columns: ["actor_user_id"]
            isOneToOne: false
            referencedRelation: "v_sales_personal_stats"
            referencedColumns: ["user_id"]
          },
          {
            foreignKeyName: "contract_workflow_requests_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "contract_workflow_requests_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "v_sam23_organization_commercial_summary"
            referencedColumns: ["organization_id"]
          },
        ]
      }
      contracts: {
        Row: {
          approval_status: string | null
          contract_amount: number
          contract_date: string
          contract_no: string
          created_at: string | null
          created_by: string | null
          currency: string | null
          customer_id: string | null
          file_metadata: Json | null
          file_url: string | null
          first_payment_due_date: string | null
          first_payment_status: string
          id: string
          lead_id: string
          notes: string | null
          organization_id: string
          party_a_contact: string | null
          party_a_name: string
          party_b_contact: string | null
          party_b_name: string
          quotation_id: string | null
          sales_id: string | null
          sealed_file_metadata: Json | null
          sealed_file_url: string | null
          status: string
          terminated_at: string | null
          terminated_reason: string | null
          updated_at: string | null
        }
        Insert: {
          approval_status?: string | null
          contract_amount: number
          contract_date?: string
          contract_no: string
          created_at?: string | null
          created_by?: string | null
          currency?: string | null
          customer_id?: string | null
          file_metadata?: Json | null
          file_url?: string | null
          first_payment_due_date?: string | null
          first_payment_status?: string
          id?: string
          lead_id: string
          notes?: string | null
          organization_id: string
          party_a_contact?: string | null
          party_a_name: string
          party_b_contact?: string | null
          party_b_name?: string
          quotation_id?: string | null
          sales_id?: string | null
          sealed_file_metadata?: Json | null
          sealed_file_url?: string | null
          status?: string
          terminated_at?: string | null
          terminated_reason?: string | null
          updated_at?: string | null
        }
        Update: {
          approval_status?: string | null
          contract_amount?: number
          contract_date?: string
          contract_no?: string
          created_at?: string | null
          created_by?: string | null
          currency?: string | null
          customer_id?: string | null
          file_metadata?: Json | null
          file_url?: string | null
          first_payment_due_date?: string | null
          first_payment_status?: string
          id?: string
          lead_id?: string
          notes?: string | null
          organization_id?: string
          party_a_contact?: string | null
          party_a_name?: string
          party_b_contact?: string | null
          party_b_name?: string
          quotation_id?: string | null
          sales_id?: string | null
          sealed_file_metadata?: Json | null
          sealed_file_url?: string | null
          status?: string
          terminated_at?: string | null
          terminated_reason?: string | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "contracts_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "contracts_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "sales_performance"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "contracts_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "v_sales_personal_stats"
            referencedColumns: ["user_id"]
          },
          {
            foreignKeyName: "contracts_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "lead_alerts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "contracts_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "contracts_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "v_lead_trace"
            referencedColumns: ["lead_id"]
          },
          {
            foreignKeyName: "contracts_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "v_risk_pool"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "contracts_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "v_stagnant_leads"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "contracts_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "contracts_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "v_sam23_organization_commercial_summary"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "contracts_organization_lead_fkey"
            columns: ["organization_id", "lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["organization_id", "id"]
          },
          {
            foreignKeyName: "contracts_organization_quotation_fkey"
            columns: ["organization_id", "quotation_id"]
            isOneToOne: false
            referencedRelation: "quotations"
            referencedColumns: ["organization_id", "id"]
          },
          {
            foreignKeyName: "contracts_quotation_id_fkey"
            columns: ["quotation_id"]
            isOneToOne: false
            referencedRelation: "quotations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "contracts_quotation_id_fkey"
            columns: ["quotation_id"]
            isOneToOne: false
            referencedRelation: "v_lead_trace"
            referencedColumns: ["quotation_id"]
          },
          {
            foreignKeyName: "contracts_sales_id_fkey"
            columns: ["sales_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "contracts_sales_id_fkey"
            columns: ["sales_id"]
            isOneToOne: false
            referencedRelation: "sales_performance"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "contracts_sales_id_fkey"
            columns: ["sales_id"]
            isOneToOne: false
            referencedRelation: "v_sales_personal_stats"
            referencedColumns: ["user_id"]
          },
        ]
      }
      crm_daily_funnel_snapshot: {
        Row: {
          created_at: string
          current_milestone: string
          id: string
          lead_count: number
          organization_id: string
          snapshot_date: string
          total_value: number | null
        }
        Insert: {
          created_at?: string
          current_milestone: string
          id?: string
          lead_count?: number
          organization_id: string
          snapshot_date?: string
          total_value?: number | null
        }
        Update: {
          created_at?: string
          current_milestone?: string
          id?: string
          lead_count?: number
          organization_id?: string
          snapshot_date?: string
          total_value?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "crm_daily_funnel_snapshot_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "crm_daily_funnel_snapshot_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "v_sam23_organization_commercial_summary"
            referencedColumns: ["organization_id"]
          },
        ]
      }
      customers: {
        Row: {
          address: string | null
          assigned_sales_id: string | null
          created_at: string | null
          email: string | null
          id: string
          last_activity_at: string | null
          lead_id: string | null
          name: string
          notes: string | null
          organization_id: string
          phone: string | null
          tags: string[] | null
          total_contract_amount: number | null
          unified_profile: boolean | null
          whatsapp: string | null
        }
        Insert: {
          address?: string | null
          assigned_sales_id?: string | null
          created_at?: string | null
          email?: string | null
          id?: string
          last_activity_at?: string | null
          lead_id?: string | null
          name: string
          notes?: string | null
          organization_id?: string
          phone?: string | null
          tags?: string[] | null
          total_contract_amount?: number | null
          unified_profile?: boolean | null
          whatsapp?: string | null
        }
        Update: {
          address?: string | null
          assigned_sales_id?: string | null
          created_at?: string | null
          email?: string | null
          id?: string
          last_activity_at?: string | null
          lead_id?: string | null
          name?: string
          notes?: string | null
          organization_id?: string
          phone?: string | null
          tags?: string[] | null
          total_contract_amount?: number | null
          unified_profile?: boolean | null
          whatsapp?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "customers_assigned_sales_id_fkey"
            columns: ["assigned_sales_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "customers_assigned_sales_id_fkey"
            columns: ["assigned_sales_id"]
            isOneToOne: false
            referencedRelation: "sales_performance"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "customers_assigned_sales_id_fkey"
            columns: ["assigned_sales_id"]
            isOneToOne: false
            referencedRelation: "v_sales_personal_stats"
            referencedColumns: ["user_id"]
          },
          {
            foreignKeyName: "customers_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "lead_alerts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "customers_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "customers_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "v_lead_trace"
            referencedColumns: ["lead_id"]
          },
          {
            foreignKeyName: "customers_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "v_risk_pool"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "customers_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "v_stagnant_leads"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "customers_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "customers_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "v_sam23_organization_commercial_summary"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "customers_organization_lead_fkey"
            columns: ["organization_id", "lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["organization_id", "id"]
          },
        ]
      }
      follow_up_logs: {
        Row: {
          contact_fingerprint: string | null
          contact_result: string | null
          contact_time: string
          contact_type: string
          created_at: string
          created_by: string | null
          id: string
          lead_id: string
          next_action: string | null
          next_followup_date: string | null
          no_answer: boolean
          organization_id: string
          result: string | null
          summary: string
          user_id: string | null
        }
        Insert: {
          contact_fingerprint?: string | null
          contact_result?: string | null
          contact_time: string
          contact_type?: string
          created_at?: string
          created_by?: string | null
          id?: string
          lead_id: string
          next_action?: string | null
          next_followup_date?: string | null
          no_answer?: boolean
          organization_id?: string
          result?: string | null
          summary?: string
          user_id?: string | null
        }
        Update: {
          contact_fingerprint?: string | null
          contact_result?: string | null
          contact_time?: string
          contact_type?: string
          created_at?: string
          created_by?: string | null
          id?: string
          lead_id?: string
          next_action?: string | null
          next_followup_date?: string | null
          no_answer?: boolean
          organization_id?: string
          result?: string | null
          summary?: string
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "fk_follow_up_logs_created_by"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fk_follow_up_logs_created_by"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "sales_performance"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fk_follow_up_logs_created_by"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "v_sales_personal_stats"
            referencedColumns: ["user_id"]
          },
          {
            foreignKeyName: "fk_follow_up_logs_user_id"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fk_follow_up_logs_user_id"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "sales_performance"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fk_follow_up_logs_user_id"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "v_sales_personal_stats"
            referencedColumns: ["user_id"]
          },
          {
            foreignKeyName: "follow_up_logs_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "lead_alerts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "follow_up_logs_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "follow_up_logs_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "v_lead_trace"
            referencedColumns: ["lead_id"]
          },
          {
            foreignKeyName: "follow_up_logs_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "v_risk_pool"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "follow_up_logs_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "v_stagnant_leads"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "follow_up_logs_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "follow_up_logs_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "v_sam23_organization_commercial_summary"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "follow_up_logs_organization_lead_fkey"
            columns: ["organization_id", "lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["organization_id", "id"]
          },
          {
            foreignKeyName: "follow_up_logs_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "follow_up_logs_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "sales_performance"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "follow_up_logs_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "v_sales_personal_stats"
            referencedColumns: ["user_id"]
          },
        ]
      }
      installment_plans: {
        Row: {
          allocated_amount: number
          amount: number
          contract_id: string
          created_at: string | null
          description: string | null
          due_date: string
          id: string
          organization_id: string
          paid_amount: number | null
          seq: number
          status: string
          updated_at: string | null
        }
        Insert: {
          allocated_amount?: number
          amount: number
          contract_id: string
          created_at?: string | null
          description?: string | null
          due_date: string
          id?: string
          organization_id: string
          paid_amount?: number | null
          seq: number
          status?: string
          updated_at?: string | null
        }
        Update: {
          allocated_amount?: number
          amount?: number
          contract_id?: string
          created_at?: string | null
          description?: string | null
          due_date?: string
          id?: string
          organization_id?: string
          paid_amount?: number | null
          seq?: number
          status?: string
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "installment_plans_contract_id_fkey"
            columns: ["contract_id"]
            isOneToOne: false
            referencedRelation: "contracts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "installment_plans_contract_id_fkey"
            columns: ["contract_id"]
            isOneToOne: false
            referencedRelation: "v_account_receivable_aging"
            referencedColumns: ["contract_id"]
          },
          {
            foreignKeyName: "installment_plans_contract_id_fkey"
            columns: ["contract_id"]
            isOneToOne: false
            referencedRelation: "v_lead_trace"
            referencedColumns: ["contract_id"]
          },
          {
            foreignKeyName: "installment_plans_organization_contract_fkey"
            columns: ["organization_id", "contract_id"]
            isOneToOne: false
            referencedRelation: "contracts"
            referencedColumns: ["organization_id", "id"]
          },
          {
            foreignKeyName: "installment_plans_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "installment_plans_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "v_sam23_organization_commercial_summary"
            referencedColumns: ["organization_id"]
          },
        ]
      }
      knx_designs: {
        Row: {
          completed_at: string | null
          created_at: string | null
          device_count: number | null
          devices_json: Json | null
          id: string
          lead_id: string
          organization_id: string
          status: string | null
          total_aed: number | null
          updated_at: string | null
        }
        Insert: {
          completed_at?: string | null
          created_at?: string | null
          device_count?: number | null
          devices_json?: Json | null
          id?: string
          lead_id: string
          organization_id?: string
          status?: string | null
          total_aed?: number | null
          updated_at?: string | null
        }
        Update: {
          completed_at?: string | null
          created_at?: string | null
          device_count?: number | null
          devices_json?: Json | null
          id?: string
          lead_id?: string
          organization_id?: string
          status?: string | null
          total_aed?: number | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "knx_designs_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "lead_alerts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "knx_designs_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "knx_designs_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "v_lead_trace"
            referencedColumns: ["lead_id"]
          },
          {
            foreignKeyName: "knx_designs_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "v_risk_pool"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "knx_designs_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "v_stagnant_leads"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "knx_designs_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "knx_designs_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "v_sam23_organization_commercial_summary"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "knx_designs_organization_lead_fkey"
            columns: ["organization_id", "lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["organization_id", "id"]
          },
        ]
      }
      kpi_targets: {
        Row: {
          actual_amount: number
          assigned_to: string | null
          created_at: string | null
          id: string
          notes: string | null
          organization_id: string
          period: string
          set_by: string | null
          target_amount: number
          target_type: string
          updated_at: string | null
        }
        Insert: {
          actual_amount?: number
          assigned_to?: string | null
          created_at?: string | null
          id?: string
          notes?: string | null
          organization_id?: string
          period: string
          set_by?: string | null
          target_amount: number
          target_type: string
          updated_at?: string | null
        }
        Update: {
          actual_amount?: number
          assigned_to?: string | null
          created_at?: string | null
          id?: string
          notes?: string | null
          organization_id?: string
          period?: string
          set_by?: string | null
          target_amount?: number
          target_type?: string
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "kpi_targets_assigned_to_fkey"
            columns: ["assigned_to"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "kpi_targets_assigned_to_fkey"
            columns: ["assigned_to"]
            isOneToOne: false
            referencedRelation: "sales_performance"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "kpi_targets_assigned_to_fkey"
            columns: ["assigned_to"]
            isOneToOne: false
            referencedRelation: "v_sales_personal_stats"
            referencedColumns: ["user_id"]
          },
          {
            foreignKeyName: "kpi_targets_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "kpi_targets_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "v_sam23_organization_commercial_summary"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "kpi_targets_set_by_fkey"
            columns: ["set_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "kpi_targets_set_by_fkey"
            columns: ["set_by"]
            isOneToOne: false
            referencedRelation: "sales_performance"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "kpi_targets_set_by_fkey"
            columns: ["set_by"]
            isOneToOne: false
            referencedRelation: "v_sales_personal_stats"
            referencedColumns: ["user_id"]
          },
        ]
      }
      lead_assignment_state: {
        Row: {
          id: number
          last_assigned_at: string | null
          last_assigned_to: string | null
          organization_id: string
          round_robin_index: number | null
        }
        Insert: {
          id?: number
          last_assigned_at?: string | null
          last_assigned_to?: string | null
          organization_id?: string
          round_robin_index?: number | null
        }
        Update: {
          id?: number
          last_assigned_at?: string | null
          last_assigned_to?: string | null
          organization_id?: string
          round_robin_index?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "lead_assignment_state_last_assigned_to_fkey"
            columns: ["last_assigned_to"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lead_assignment_state_last_assigned_to_fkey"
            columns: ["last_assigned_to"]
            isOneToOne: false
            referencedRelation: "sales_performance"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lead_assignment_state_last_assigned_to_fkey"
            columns: ["last_assigned_to"]
            isOneToOne: false
            referencedRelation: "v_sales_personal_stats"
            referencedColumns: ["user_id"]
          },
          {
            foreignKeyName: "lead_assignment_state_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lead_assignment_state_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "v_sam23_organization_commercial_summary"
            referencedColumns: ["organization_id"]
          },
        ]
      }
      lead_deletion_requests: {
        Row: {
          actor_id: string
          created_at: string
          deleted_lead_id: string
          id: string
          idempotency_key: string
          organization_id: string
          response: Json
        }
        Insert: {
          actor_id: string
          created_at?: string
          deleted_lead_id: string
          id?: string
          idempotency_key: string
          organization_id?: string
          response: Json
        }
        Update: {
          actor_id?: string
          created_at?: string
          deleted_lead_id?: string
          id?: string
          idempotency_key?: string
          organization_id?: string
          response?: Json
        }
        Relationships: [
          {
            foreignKeyName: "lead_deletion_requests_actor_id_fkey"
            columns: ["actor_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lead_deletion_requests_actor_id_fkey"
            columns: ["actor_id"]
            isOneToOne: false
            referencedRelation: "sales_performance"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lead_deletion_requests_actor_id_fkey"
            columns: ["actor_id"]
            isOneToOne: false
            referencedRelation: "v_sales_personal_stats"
            referencedColumns: ["user_id"]
          },
          {
            foreignKeyName: "lead_deletion_requests_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lead_deletion_requests_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "v_sam23_organization_commercial_summary"
            referencedColumns: ["organization_id"]
          },
        ]
      }
      lead_documents: {
        Row: {
          created_at: string
          document_type: string
          file_name: string
          file_size: number | null
          file_url: string
          id: string
          lead_id: string
          notes: string | null
          organization_id: string
          uploaded_by: string | null
        }
        Insert: {
          created_at?: string
          document_type: string
          file_name: string
          file_size?: number | null
          file_url: string
          id?: string
          lead_id: string
          notes?: string | null
          organization_id: string
          uploaded_by?: string | null
        }
        Update: {
          created_at?: string
          document_type?: string
          file_name?: string
          file_size?: number | null
          file_url?: string
          id?: string
          lead_id?: string
          notes?: string | null
          organization_id?: string
          uploaded_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "lead_documents_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "lead_alerts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lead_documents_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lead_documents_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "v_lead_trace"
            referencedColumns: ["lead_id"]
          },
          {
            foreignKeyName: "lead_documents_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "v_risk_pool"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lead_documents_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "v_stagnant_leads"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lead_documents_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lead_documents_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "v_sam23_organization_commercial_summary"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "lead_documents_organization_lead_fkey"
            columns: ["organization_id", "lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["organization_id", "id"]
          },
          {
            foreignKeyName: "lead_documents_uploaded_by_fkey"
            columns: ["uploaded_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lead_documents_uploaded_by_fkey"
            columns: ["uploaded_by"]
            isOneToOne: false
            referencedRelation: "sales_performance"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lead_documents_uploaded_by_fkey"
            columns: ["uploaded_by"]
            isOneToOne: false
            referencedRelation: "v_sales_personal_stats"
            referencedColumns: ["user_id"]
          },
        ]
      }
      lead_files: {
        Row: {
          created_at: string | null
          file_name: string | null
          file_path: string
          file_size: number | null
          file_type: string | null
          id: string
          lead_id: string
          mime_type: string | null
          organization_id: string
          uploaded_by: string | null
        }
        Insert: {
          created_at?: string | null
          file_name?: string | null
          file_path: string
          file_size?: number | null
          file_type?: string | null
          id?: string
          lead_id: string
          mime_type?: string | null
          organization_id?: string
          uploaded_by?: string | null
        }
        Update: {
          created_at?: string | null
          file_name?: string | null
          file_path?: string
          file_size?: number | null
          file_type?: string | null
          id?: string
          lead_id?: string
          mime_type?: string | null
          organization_id?: string
          uploaded_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "lead_files_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "lead_alerts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lead_files_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lead_files_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "v_lead_trace"
            referencedColumns: ["lead_id"]
          },
          {
            foreignKeyName: "lead_files_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "v_risk_pool"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lead_files_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "v_stagnant_leads"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lead_files_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lead_files_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "v_sam23_organization_commercial_summary"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "lead_files_organization_lead_fkey"
            columns: ["organization_id", "lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["organization_id", "id"]
          },
        ]
      }
      lead_milestones: {
        Row: {
          completed_at: string | null
          completed_by: string | null
          created_at: string
          id: string
          lead_id: string
          milestone_key: string
          notes: string | null
          organization_id: string
        }
        Insert: {
          completed_at?: string | null
          completed_by?: string | null
          created_at?: string
          id?: string
          lead_id: string
          milestone_key: string
          notes?: string | null
          organization_id?: string
        }
        Update: {
          completed_at?: string | null
          completed_by?: string | null
          created_at?: string
          id?: string
          lead_id?: string
          milestone_key?: string
          notes?: string | null
          organization_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "fk_lead_milestones_completed_by"
            columns: ["completed_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fk_lead_milestones_completed_by"
            columns: ["completed_by"]
            isOneToOne: false
            referencedRelation: "sales_performance"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fk_lead_milestones_completed_by"
            columns: ["completed_by"]
            isOneToOne: false
            referencedRelation: "v_sales_personal_stats"
            referencedColumns: ["user_id"]
          },
          {
            foreignKeyName: "lead_milestones_completed_by_fkey"
            columns: ["completed_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lead_milestones_completed_by_fkey"
            columns: ["completed_by"]
            isOneToOne: false
            referencedRelation: "sales_performance"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lead_milestones_completed_by_fkey"
            columns: ["completed_by"]
            isOneToOne: false
            referencedRelation: "v_sales_personal_stats"
            referencedColumns: ["user_id"]
          },
          {
            foreignKeyName: "lead_milestones_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "lead_alerts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lead_milestones_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lead_milestones_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "v_lead_trace"
            referencedColumns: ["lead_id"]
          },
          {
            foreignKeyName: "lead_milestones_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "v_risk_pool"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lead_milestones_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "v_stagnant_leads"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lead_milestones_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lead_milestones_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "v_sam23_organization_commercial_summary"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "lead_milestones_organization_lead_fkey"
            columns: ["organization_id", "lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["organization_id", "id"]
          },
        ]
      }
      lead_mutation_requests: {
        Row: {
          actor_id: string
          created_at: string
          id: string
          idempotency_key: string
          lead_id: string
          operation: string
          organization_id: string
          response: Json
        }
        Insert: {
          actor_id: string
          created_at?: string
          id?: string
          idempotency_key: string
          lead_id: string
          operation: string
          organization_id?: string
          response: Json
        }
        Update: {
          actor_id?: string
          created_at?: string
          id?: string
          idempotency_key?: string
          lead_id?: string
          operation?: string
          organization_id?: string
          response?: Json
        }
        Relationships: [
          {
            foreignKeyName: "lead_mutation_requests_actor_id_fkey"
            columns: ["actor_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lead_mutation_requests_actor_id_fkey"
            columns: ["actor_id"]
            isOneToOne: false
            referencedRelation: "sales_performance"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lead_mutation_requests_actor_id_fkey"
            columns: ["actor_id"]
            isOneToOne: false
            referencedRelation: "v_sales_personal_stats"
            referencedColumns: ["user_id"]
          },
          {
            foreignKeyName: "lead_mutation_requests_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "lead_alerts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lead_mutation_requests_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lead_mutation_requests_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "v_lead_trace"
            referencedColumns: ["lead_id"]
          },
          {
            foreignKeyName: "lead_mutation_requests_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "v_risk_pool"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lead_mutation_requests_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "v_stagnant_leads"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lead_mutation_requests_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lead_mutation_requests_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "v_sam23_organization_commercial_summary"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "lead_mutation_requests_organization_lead_fkey"
            columns: ["organization_id", "lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["organization_id", "id"]
          },
        ]
      }
      lead_workflow_stages: {
        Row: {
          assigned_to: string | null
          completed_at: string | null
          created_at: string | null
          deadline_at: string | null
          id: string
          lead_id: string
          notes: string | null
          notified_24h: boolean | null
          notified_48h: boolean | null
          organization_id: string
          stage_key: string
          stage_order: number
          started_at: string | null
          status: string
          updated_at: string | null
          weight: number
        }
        Insert: {
          assigned_to?: string | null
          completed_at?: string | null
          created_at?: string | null
          deadline_at?: string | null
          id?: string
          lead_id: string
          notes?: string | null
          notified_24h?: boolean | null
          notified_48h?: boolean | null
          organization_id?: string
          stage_key: string
          stage_order?: number
          started_at?: string | null
          status?: string
          updated_at?: string | null
          weight?: number
        }
        Update: {
          assigned_to?: string | null
          completed_at?: string | null
          created_at?: string | null
          deadline_at?: string | null
          id?: string
          lead_id?: string
          notes?: string | null
          notified_24h?: boolean | null
          notified_48h?: boolean | null
          organization_id?: string
          stage_key?: string
          stage_order?: number
          started_at?: string | null
          status?: string
          updated_at?: string | null
          weight?: number
        }
        Relationships: [
          {
            foreignKeyName: "lead_workflow_stages_assigned_to_fkey"
            columns: ["assigned_to"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lead_workflow_stages_assigned_to_fkey"
            columns: ["assigned_to"]
            isOneToOne: false
            referencedRelation: "sales_performance"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lead_workflow_stages_assigned_to_fkey"
            columns: ["assigned_to"]
            isOneToOne: false
            referencedRelation: "v_sales_personal_stats"
            referencedColumns: ["user_id"]
          },
          {
            foreignKeyName: "lead_workflow_stages_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "lead_alerts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lead_workflow_stages_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lead_workflow_stages_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "v_lead_trace"
            referencedColumns: ["lead_id"]
          },
          {
            foreignKeyName: "lead_workflow_stages_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "v_risk_pool"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lead_workflow_stages_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "v_stagnant_leads"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lead_workflow_stages_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lead_workflow_stages_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "v_sam23_organization_commercial_summary"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "lead_workflow_stages_organization_lead_fkey"
            columns: ["organization_id", "lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["organization_id", "id"]
          },
        ]
      }
      leads: {
        Row: {
          ac_brand: string | null
          ad_id: string | null
          ad_name: string | null
          adset_id: string | null
          adset_name: string | null
          ai_quality: string | null
          ai_summary: string | null
          ai_tags: string[] | null
          archive_batch_id: string | null
          archive_reason: string | null
          archived: boolean
          archived_at: string | null
          area: string | null
          assigned_to: string | null
          assigned_to_uuid: string | null
          budget_range: string | null
          campaign_id: string | null
          campaign_name: string | null
          circuit_diagrams: boolean | null
          competitor: string | null
          contact_result: string | null
          converted_at: string | null
          created_at: string | null
          created_by: string | null
          creative_id: string | null
          creative_name: string | null
          current_milestone: string | null
          customer_budget: number | null
          customer_company_type: string | null
          customer_id: string | null
          customer_name: string | null
          customer_position: string | null
          days_since_last_contact: number | null
          decision_date: string | null
          decision_maker: string | null
          disqualified_candidate: boolean | null
          email: string | null
          emirate: string | null
          expected_close_date: string | null
          expected_sign_date: string | null
          fbclid: string | null
          final_status: string | null
          first_touch_at: string | null
          follow_up_count: number | null
          followup_count: number | null
          form_id: string | null
          form_name: string | null
          gclid: string | null
          google_sheets_row_id: string | null
          hold_since: string | null
          id: string
          import_batch_id: string | null
          import_fingerprint: string | null
          imported_at: string | null
          imported_by: string | null
          landing_page: string | null
          last_contact_date: string | null
          last_touch_at: string | null
          lead_status: string | null
          location: string | null
          lost_at: string | null
          lost_reason: string | null
          lost_reason_competitor: boolean | null
          lost_reason_no_budget: boolean | null
          lost_reason_no_response: boolean | null
          lost_reason_other: boolean | null
          lost_reason_price: boolean | null
          lost_reason_project_cancelled: boolean | null
          lost_reason_project_delayed: boolean | null
          meta_ad_id: string | null
          meta_campaign: string | null
          meta_click_id: string | null
          metadata: Json
          next_action: string | null
          next_followup_date: string | null
          no_answer_flag: boolean
          not_interested_reason: string | null
          notes: string | null
          organization_id: string
          owner: string | null
          owner_uuid: string | null
          phone: string | null
          poor_reason: string | null
          project_status: string | null
          project_type: string | null
          property_size_sqm: number | null
          property_type: string | null
          quality: string | null
          quotation_sent_date: string | null
          quotation_value: number | null
          raw_import_data: Json | null
          recovery_candidate: boolean | null
          referrer: string | null
          rep_name: string | null
          sales_manager: string | null
          sales_manager_review: boolean | null
          service_needs: string[] | null
          smart_requirements: Json | null
          source: string
          source_channel: string | null
          source_platform: string | null
          stage: string | null
          stage_changed_at: string | null
          stage_old: string | null
          transfer_candidate: boolean | null
          updated_at: string | null
          utm_campaign: string | null
          utm_content: string | null
          utm_medium: string | null
          utm_source: string | null
          utm_term: string | null
          win_probability: number | null
          won_at: string | null
        }
        Insert: {
          ac_brand?: string | null
          ad_id?: string | null
          ad_name?: string | null
          adset_id?: string | null
          adset_name?: string | null
          ai_quality?: string | null
          ai_summary?: string | null
          ai_tags?: string[] | null
          archive_batch_id?: string | null
          archive_reason?: string | null
          archived?: boolean
          archived_at?: string | null
          area?: string | null
          assigned_to?: string | null
          assigned_to_uuid?: string | null
          budget_range?: string | null
          campaign_id?: string | null
          campaign_name?: string | null
          circuit_diagrams?: boolean | null
          competitor?: string | null
          contact_result?: string | null
          converted_at?: string | null
          created_at?: string | null
          created_by?: string | null
          creative_id?: string | null
          creative_name?: string | null
          current_milestone?: string | null
          customer_budget?: number | null
          customer_company_type?: string | null
          customer_id?: string | null
          customer_name?: string | null
          customer_position?: string | null
          days_since_last_contact?: number | null
          decision_date?: string | null
          decision_maker?: string | null
          disqualified_candidate?: boolean | null
          email?: string | null
          emirate?: string | null
          expected_close_date?: string | null
          expected_sign_date?: string | null
          fbclid?: string | null
          final_status?: string | null
          first_touch_at?: string | null
          follow_up_count?: number | null
          followup_count?: number | null
          form_id?: string | null
          form_name?: string | null
          gclid?: string | null
          google_sheets_row_id?: string | null
          hold_since?: string | null
          id?: string
          import_batch_id?: string | null
          import_fingerprint?: string | null
          imported_at?: string | null
          imported_by?: string | null
          landing_page?: string | null
          last_contact_date?: string | null
          last_touch_at?: string | null
          lead_status?: string | null
          location?: string | null
          lost_at?: string | null
          lost_reason?: string | null
          lost_reason_competitor?: boolean | null
          lost_reason_no_budget?: boolean | null
          lost_reason_no_response?: boolean | null
          lost_reason_other?: boolean | null
          lost_reason_price?: boolean | null
          lost_reason_project_cancelled?: boolean | null
          lost_reason_project_delayed?: boolean | null
          meta_ad_id?: string | null
          meta_campaign?: string | null
          meta_click_id?: string | null
          metadata?: Json
          next_action?: string | null
          next_followup_date?: string | null
          no_answer_flag?: boolean
          not_interested_reason?: string | null
          notes?: string | null
          organization_id: string
          owner?: string | null
          owner_uuid?: string | null
          phone?: string | null
          poor_reason?: string | null
          project_status?: string | null
          project_type?: string | null
          property_size_sqm?: number | null
          property_type?: string | null
          quality?: string | null
          quotation_sent_date?: string | null
          quotation_value?: number | null
          raw_import_data?: Json | null
          recovery_candidate?: boolean | null
          referrer?: string | null
          rep_name?: string | null
          sales_manager?: string | null
          sales_manager_review?: boolean | null
          service_needs?: string[] | null
          smart_requirements?: Json | null
          source: string
          source_channel?: string | null
          source_platform?: string | null
          stage?: string | null
          stage_changed_at?: string | null
          stage_old?: string | null
          transfer_candidate?: boolean | null
          updated_at?: string | null
          utm_campaign?: string | null
          utm_content?: string | null
          utm_medium?: string | null
          utm_source?: string | null
          utm_term?: string | null
          win_probability?: number | null
          won_at?: string | null
        }
        Update: {
          ac_brand?: string | null
          ad_id?: string | null
          ad_name?: string | null
          adset_id?: string | null
          adset_name?: string | null
          ai_quality?: string | null
          ai_summary?: string | null
          ai_tags?: string[] | null
          archive_batch_id?: string | null
          archive_reason?: string | null
          archived?: boolean
          archived_at?: string | null
          area?: string | null
          assigned_to?: string | null
          assigned_to_uuid?: string | null
          budget_range?: string | null
          campaign_id?: string | null
          campaign_name?: string | null
          circuit_diagrams?: boolean | null
          competitor?: string | null
          contact_result?: string | null
          converted_at?: string | null
          created_at?: string | null
          created_by?: string | null
          creative_id?: string | null
          creative_name?: string | null
          current_milestone?: string | null
          customer_budget?: number | null
          customer_company_type?: string | null
          customer_id?: string | null
          customer_name?: string | null
          customer_position?: string | null
          days_since_last_contact?: number | null
          decision_date?: string | null
          decision_maker?: string | null
          disqualified_candidate?: boolean | null
          email?: string | null
          emirate?: string | null
          expected_close_date?: string | null
          expected_sign_date?: string | null
          fbclid?: string | null
          final_status?: string | null
          first_touch_at?: string | null
          follow_up_count?: number | null
          followup_count?: number | null
          form_id?: string | null
          form_name?: string | null
          gclid?: string | null
          google_sheets_row_id?: string | null
          hold_since?: string | null
          id?: string
          import_batch_id?: string | null
          import_fingerprint?: string | null
          imported_at?: string | null
          imported_by?: string | null
          landing_page?: string | null
          last_contact_date?: string | null
          last_touch_at?: string | null
          lead_status?: string | null
          location?: string | null
          lost_at?: string | null
          lost_reason?: string | null
          lost_reason_competitor?: boolean | null
          lost_reason_no_budget?: boolean | null
          lost_reason_no_response?: boolean | null
          lost_reason_other?: boolean | null
          lost_reason_price?: boolean | null
          lost_reason_project_cancelled?: boolean | null
          lost_reason_project_delayed?: boolean | null
          meta_ad_id?: string | null
          meta_campaign?: string | null
          meta_click_id?: string | null
          metadata?: Json
          next_action?: string | null
          next_followup_date?: string | null
          no_answer_flag?: boolean
          not_interested_reason?: string | null
          notes?: string | null
          organization_id?: string
          owner?: string | null
          owner_uuid?: string | null
          phone?: string | null
          poor_reason?: string | null
          project_status?: string | null
          project_type?: string | null
          property_size_sqm?: number | null
          property_type?: string | null
          quality?: string | null
          quotation_sent_date?: string | null
          quotation_value?: number | null
          raw_import_data?: Json | null
          recovery_candidate?: boolean | null
          referrer?: string | null
          rep_name?: string | null
          sales_manager?: string | null
          sales_manager_review?: boolean | null
          service_needs?: string[] | null
          smart_requirements?: Json | null
          source?: string
          source_channel?: string | null
          source_platform?: string | null
          stage?: string | null
          stage_changed_at?: string | null
          stage_old?: string | null
          transfer_candidate?: boolean | null
          updated_at?: string | null
          utm_campaign?: string | null
          utm_content?: string | null
          utm_medium?: string | null
          utm_source?: string | null
          utm_term?: string | null
          win_probability?: number | null
          won_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "fk_leads_assigned_to"
            columns: ["assigned_to"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fk_leads_assigned_to"
            columns: ["assigned_to"]
            isOneToOne: false
            referencedRelation: "sales_performance"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fk_leads_assigned_to"
            columns: ["assigned_to"]
            isOneToOne: false
            referencedRelation: "v_sales_personal_stats"
            referencedColumns: ["user_id"]
          },
          {
            foreignKeyName: "fk_leads_created_by"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fk_leads_created_by"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "sales_performance"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fk_leads_created_by"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "v_sales_personal_stats"
            referencedColumns: ["user_id"]
          },
          {
            foreignKeyName: "fk_leads_customer_id"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "leads_assigned_to_fkey"
            columns: ["assigned_to"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "leads_assigned_to_fkey"
            columns: ["assigned_to"]
            isOneToOne: false
            referencedRelation: "sales_performance"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "leads_assigned_to_fkey"
            columns: ["assigned_to"]
            isOneToOne: false
            referencedRelation: "v_sales_personal_stats"
            referencedColumns: ["user_id"]
          },
          {
            foreignKeyName: "leads_assigned_to_uuid_fkey"
            columns: ["assigned_to_uuid"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "leads_assigned_to_uuid_fkey"
            columns: ["assigned_to_uuid"]
            isOneToOne: false
            referencedRelation: "sales_performance"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "leads_assigned_to_uuid_fkey"
            columns: ["assigned_to_uuid"]
            isOneToOne: false
            referencedRelation: "v_sales_personal_stats"
            referencedColumns: ["user_id"]
          },
          {
            foreignKeyName: "leads_imported_by_fkey"
            columns: ["imported_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "leads_imported_by_fkey"
            columns: ["imported_by"]
            isOneToOne: false
            referencedRelation: "sales_performance"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "leads_imported_by_fkey"
            columns: ["imported_by"]
            isOneToOne: false
            referencedRelation: "v_sales_personal_stats"
            referencedColumns: ["user_id"]
          },
          {
            foreignKeyName: "leads_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "leads_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "v_sam23_organization_commercial_summary"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "leads_owner_uuid_fkey"
            columns: ["owner_uuid"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "leads_owner_uuid_fkey"
            columns: ["owner_uuid"]
            isOneToOne: false
            referencedRelation: "sales_performance"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "leads_owner_uuid_fkey"
            columns: ["owner_uuid"]
            isOneToOne: false
            referencedRelation: "v_sales_personal_stats"
            referencedColumns: ["user_id"]
          },
          {
            foreignKeyName: "leads_sales_manager_fkey"
            columns: ["sales_manager"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "leads_sales_manager_fkey"
            columns: ["sales_manager"]
            isOneToOne: false
            referencedRelation: "sales_performance"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "leads_sales_manager_fkey"
            columns: ["sales_manager"]
            isOneToOne: false
            referencedRelation: "v_sales_personal_stats"
            referencedColumns: ["user_id"]
          },
        ]
      }
      membership_roles: {
        Row: {
          granted_at: string
          granted_by_membership_id: string | null
          id: string
          membership_id: string
          organization_id: string
          revoked_at: string | null
          role_id: string
        }
        Insert: {
          granted_at?: string
          granted_by_membership_id?: string | null
          id?: string
          membership_id: string
          organization_id?: string
          revoked_at?: string | null
          role_id: string
        }
        Update: {
          granted_at?: string
          granted_by_membership_id?: string | null
          id?: string
          membership_id?: string
          organization_id?: string
          revoked_at?: string | null
          role_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "membership_roles_granted_by_membership_id_fkey"
            columns: ["granted_by_membership_id"]
            isOneToOne: false
            referencedRelation: "memberships"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "membership_roles_membership_id_fkey"
            columns: ["membership_id"]
            isOneToOne: false
            referencedRelation: "memberships"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "membership_roles_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "membership_roles_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "v_sam23_organization_commercial_summary"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "membership_roles_organization_membership_fkey"
            columns: ["organization_id", "membership_id"]
            isOneToOne: false
            referencedRelation: "memberships"
            referencedColumns: ["organization_id", "id"]
          },
          {
            foreignKeyName: "membership_roles_role_id_fkey"
            columns: ["role_id"]
            isOneToOne: false
            referencedRelation: "roles"
            referencedColumns: ["id"]
          },
        ]
      }
      memberships: {
        Row: {
          accepted_at: string | null
          created_at: string
          deactivated_at: string | null
          id: string
          invited_at: string
          invited_by_membership_id: string | null
          organization_id: string
          recovery_deadline: string | null
          status: string
          updated_at: string
          user_id: string
          version: number
        }
        Insert: {
          accepted_at?: string | null
          created_at?: string
          deactivated_at?: string | null
          id?: string
          invited_at?: string
          invited_by_membership_id?: string | null
          organization_id: string
          recovery_deadline?: string | null
          status?: string
          updated_at?: string
          user_id: string
          version?: number
        }
        Update: {
          accepted_at?: string | null
          created_at?: string
          deactivated_at?: string | null
          id?: string
          invited_at?: string
          invited_by_membership_id?: string | null
          organization_id?: string
          recovery_deadline?: string | null
          status?: string
          updated_at?: string
          user_id?: string
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "memberships_invited_by_membership_id_fkey"
            columns: ["invited_by_membership_id"]
            isOneToOne: false
            referencedRelation: "memberships"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "memberships_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "memberships_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "v_sam23_organization_commercial_summary"
            referencedColumns: ["organization_id"]
          },
        ]
      }
      notifications: {
        Row: {
          body: string | null
          created_at: string | null
          event_key: string | null
          id: string
          is_read: boolean | null
          organization_id: string
          related_id: string | null
          related_type: string | null
          title: string
          type: string
          user_id: string
        }
        Insert: {
          body?: string | null
          created_at?: string | null
          event_key?: string | null
          id?: string
          is_read?: boolean | null
          organization_id?: string
          related_id?: string | null
          related_type?: string | null
          title: string
          type: string
          user_id: string
        }
        Update: {
          body?: string | null
          created_at?: string | null
          event_key?: string | null
          id?: string
          is_read?: boolean | null
          organization_id?: string
          related_id?: string | null
          related_type?: string | null
          title?: string
          type?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "notifications_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notifications_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "v_sam23_organization_commercial_summary"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "notifications_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notifications_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "sales_performance"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notifications_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "v_sales_personal_stats"
            referencedColumns: ["user_id"]
          },
        ]
      }
      organization_document_sequences: {
        Row: {
          document_date: string
          document_kind: string
          next_value: number
          organization_id: string
        }
        Insert: {
          document_date: string
          document_kind: string
          next_value: number
          organization_id: string
        }
        Update: {
          document_date?: string
          document_kind?: string
          next_value?: number
          organization_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "organization_document_sequences_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "organization_document_sequences_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "v_sam23_organization_commercial_summary"
            referencedColumns: ["organization_id"]
          },
        ]
      }
      organization_exit_requests: {
        Row: {
          approved_by_platform_staff_id: string
          backup_evidence_ref: string | null
          completed_at: string | null
          created_at: string
          customer_confirmation_ref: string | null
          export_sha256: string | null
          id: string
          idempotency_key: string
          organization_id: string
          prepared_at: string
          previous_organization_status: string
          reason: string
          requested_by_platform_staff_id: string
          retention_basis: string | null
          status: string
        }
        Insert: {
          approved_by_platform_staff_id: string
          backup_evidence_ref?: string | null
          completed_at?: string | null
          created_at?: string
          customer_confirmation_ref?: string | null
          export_sha256?: string | null
          id?: string
          idempotency_key: string
          organization_id: string
          prepared_at?: string
          previous_organization_status: string
          reason: string
          requested_by_platform_staff_id: string
          retention_basis?: string | null
          status?: string
        }
        Update: {
          approved_by_platform_staff_id?: string
          backup_evidence_ref?: string | null
          completed_at?: string | null
          created_at?: string
          customer_confirmation_ref?: string | null
          export_sha256?: string | null
          id?: string
          idempotency_key?: string
          organization_id?: string
          prepared_at?: string
          previous_organization_status?: string
          reason?: string
          requested_by_platform_staff_id?: string
          retention_basis?: string | null
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "organization_exit_requests_approved_by_platform_staff_id_fkey"
            columns: ["approved_by_platform_staff_id"]
            isOneToOne: false
            referencedRelation: "platform_staff"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "organization_exit_requests_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "organization_exit_requests_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "v_sam23_organization_commercial_summary"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "organization_exit_requests_requested_by_platform_staff_id_fkey"
            columns: ["requested_by_platform_staff_id"]
            isOneToOne: false
            referencedRelation: "platform_staff"
            referencedColumns: ["id"]
          },
        ]
      }
      organization_lifecycle_requests: {
        Row: {
          action: string
          actor_platform_staff_id: string
          approver_platform_staff_id: string
          created_at: string
          organization_id: string
          previous_status: string
          reason: string
          request_id: string
          result: Json
          target_status: string
        }
        Insert: {
          action: string
          actor_platform_staff_id: string
          approver_platform_staff_id: string
          created_at?: string
          organization_id: string
          previous_status: string
          reason: string
          request_id: string
          result: Json
          target_status: string
        }
        Update: {
          action?: string
          actor_platform_staff_id?: string
          approver_platform_staff_id?: string
          created_at?: string
          organization_id?: string
          previous_status?: string
          reason?: string
          request_id?: string
          result?: Json
          target_status?: string
        }
        Relationships: [
          {
            foreignKeyName: "organization_lifecycle_requests_actor_platform_staff_id_fkey"
            columns: ["actor_platform_staff_id"]
            isOneToOne: false
            referencedRelation: "platform_staff"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "organization_lifecycle_requests_approver_platform_staff_id_fkey"
            columns: ["approver_platform_staff_id"]
            isOneToOne: false
            referencedRelation: "platform_staff"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "organization_lifecycle_requests_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "organization_lifecycle_requests_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "v_sam23_organization_commercial_summary"
            referencedColumns: ["organization_id"]
          },
        ]
      }
      organization_provisioning_requests: {
        Row: {
          completed_at: string | null
          created_at: string
          idempotency_key: string
          organization_id: string | null
          owner_membership_id: string | null
          request_payload: Json
          result: Json | null
        }
        Insert: {
          completed_at?: string | null
          created_at?: string
          idempotency_key: string
          organization_id?: string | null
          owner_membership_id?: string | null
          request_payload: Json
          result?: Json | null
        }
        Update: {
          completed_at?: string | null
          created_at?: string
          idempotency_key?: string
          organization_id?: string | null
          owner_membership_id?: string | null
          request_payload?: Json
          result?: Json | null
        }
        Relationships: [
          {
            foreignKeyName: "organization_provisioning_requests_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "organization_provisioning_requests_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "v_sam23_organization_commercial_summary"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "organization_provisioning_requests_owner_membership_id_fkey"
            columns: ["owner_membership_id"]
            isOneToOne: false
            referencedRelation: "memberships"
            referencedColumns: ["id"]
          },
        ]
      }
      organizations: {
        Row: {
          billable_seat_limit: number
          closed_at: string | null
          created_at: string
          created_by: string | null
          data_region: string
          id: string
          industry_key: string
          name: string
          plan_key: string
          slug: string
          status: string
          timezone: string
          updated_at: string
        }
        Insert: {
          billable_seat_limit?: number
          closed_at?: string | null
          created_at?: string
          created_by?: string | null
          data_region?: string
          id?: string
          industry_key: string
          name: string
          plan_key?: string
          slug: string
          status?: string
          timezone?: string
          updated_at?: string
        }
        Update: {
          billable_seat_limit?: number
          closed_at?: string | null
          created_at?: string
          created_by?: string | null
          data_region?: string
          id?: string
          industry_key?: string
          name?: string
          plan_key?: string
          slug?: string
          status?: string
          timezone?: string
          updated_at?: string
        }
        Relationships: []
      }
      payment_allocations: {
        Row: {
          allocated_by: string | null
          amount_allocated: number
          created_at: string | null
          id: string
          organization_id: string
          payment_id: string
          plan_id: string
          tenant_id: string
        }
        Insert: {
          allocated_by?: string | null
          amount_allocated: number
          created_at?: string | null
          id?: string
          organization_id: string
          payment_id: string
          plan_id: string
          tenant_id?: string
        }
        Update: {
          allocated_by?: string | null
          amount_allocated?: number
          created_at?: string | null
          id?: string
          organization_id?: string
          payment_id?: string
          plan_id?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "payment_allocations_allocated_by_fkey"
            columns: ["allocated_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payment_allocations_allocated_by_fkey"
            columns: ["allocated_by"]
            isOneToOne: false
            referencedRelation: "sales_performance"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payment_allocations_allocated_by_fkey"
            columns: ["allocated_by"]
            isOneToOne: false
            referencedRelation: "v_sales_personal_stats"
            referencedColumns: ["user_id"]
          },
          {
            foreignKeyName: "payment_allocations_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payment_allocations_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "v_sam23_organization_commercial_summary"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "payment_allocations_organization_payment_fkey"
            columns: ["organization_id", "payment_id"]
            isOneToOne: false
            referencedRelation: "payments"
            referencedColumns: ["organization_id", "id"]
          },
          {
            foreignKeyName: "payment_allocations_organization_plan_fkey"
            columns: ["organization_id", "plan_id"]
            isOneToOne: false
            referencedRelation: "installment_plans"
            referencedColumns: ["organization_id", "id"]
          },
          {
            foreignKeyName: "payment_allocations_payment_id_fkey"
            columns: ["payment_id"]
            isOneToOne: false
            referencedRelation: "payments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payment_allocations_payment_id_fkey"
            columns: ["payment_id"]
            isOneToOne: false
            referencedRelation: "v_lead_trace"
            referencedColumns: ["payment_id"]
          },
          {
            foreignKeyName: "payment_allocations_plan_id_fkey"
            columns: ["plan_id"]
            isOneToOne: false
            referencedRelation: "installment_plans"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payment_allocations_plan_id_fkey"
            columns: ["plan_id"]
            isOneToOne: false
            referencedRelation: "v_lead_trace"
            referencedColumns: ["installment_id"]
          },
        ]
      }
      payments: {
        Row: {
          amount: number
          confirmed: boolean | null
          confirmed_at: string | null
          confirmed_by: string | null
          contract_id: string
          created_at: string | null
          created_by: string | null
          currency: string | null
          id: string
          installment_plan_id: string | null
          notes: string | null
          organization_id: string
          overpayment_action: string | null
          payment_date: string
          payment_method: string | null
          received_at: string | null
          reference_no: string | null
          updated_at: string | null
        }
        Insert: {
          amount: number
          confirmed?: boolean | null
          confirmed_at?: string | null
          confirmed_by?: string | null
          contract_id: string
          created_at?: string | null
          created_by?: string | null
          currency?: string | null
          id?: string
          installment_plan_id?: string | null
          notes?: string | null
          organization_id: string
          overpayment_action?: string | null
          payment_date?: string
          payment_method?: string | null
          received_at?: string | null
          reference_no?: string | null
          updated_at?: string | null
        }
        Update: {
          amount?: number
          confirmed?: boolean | null
          confirmed_at?: string | null
          confirmed_by?: string | null
          contract_id?: string
          created_at?: string | null
          created_by?: string | null
          currency?: string | null
          id?: string
          installment_plan_id?: string | null
          notes?: string | null
          organization_id?: string
          overpayment_action?: string | null
          payment_date?: string
          payment_method?: string | null
          received_at?: string | null
          reference_no?: string | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "payments_confirmed_by_fkey"
            columns: ["confirmed_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payments_confirmed_by_fkey"
            columns: ["confirmed_by"]
            isOneToOne: false
            referencedRelation: "sales_performance"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payments_confirmed_by_fkey"
            columns: ["confirmed_by"]
            isOneToOne: false
            referencedRelation: "v_sales_personal_stats"
            referencedColumns: ["user_id"]
          },
          {
            foreignKeyName: "payments_contract_id_fkey"
            columns: ["contract_id"]
            isOneToOne: false
            referencedRelation: "contracts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payments_contract_id_fkey"
            columns: ["contract_id"]
            isOneToOne: false
            referencedRelation: "v_account_receivable_aging"
            referencedColumns: ["contract_id"]
          },
          {
            foreignKeyName: "payments_contract_id_fkey"
            columns: ["contract_id"]
            isOneToOne: false
            referencedRelation: "v_lead_trace"
            referencedColumns: ["contract_id"]
          },
          {
            foreignKeyName: "payments_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payments_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "sales_performance"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payments_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "v_sales_personal_stats"
            referencedColumns: ["user_id"]
          },
          {
            foreignKeyName: "payments_installment_plan_id_fkey"
            columns: ["installment_plan_id"]
            isOneToOne: false
            referencedRelation: "installment_plans"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payments_installment_plan_id_fkey"
            columns: ["installment_plan_id"]
            isOneToOne: false
            referencedRelation: "v_lead_trace"
            referencedColumns: ["installment_id"]
          },
          {
            foreignKeyName: "payments_organization_contract_fkey"
            columns: ["organization_id", "contract_id"]
            isOneToOne: false
            referencedRelation: "contracts"
            referencedColumns: ["organization_id", "id"]
          },
          {
            foreignKeyName: "payments_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payments_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "v_sam23_organization_commercial_summary"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "payments_organization_installment_fkey"
            columns: ["organization_id", "installment_plan_id"]
            isOneToOne: false
            referencedRelation: "installment_plans"
            referencedColumns: ["organization_id", "id"]
          },
        ]
      }
      pipeline_stages: {
        Row: {
          created_at: string | null
          id: string
          is_terminal: boolean | null
          name: string
          order_index: number
        }
        Insert: {
          created_at?: string | null
          id?: string
          is_terminal?: boolean | null
          name: string
          order_index: number
        }
        Update: {
          created_at?: string | null
          id?: string
          is_terminal?: boolean | null
          name?: string
          order_index?: number
        }
        Relationships: []
      }
      platform_action_approval_events: {
        Row: {
          action: string
          actor_platform_staff_id: string
          approval_request_id: string
          created_at: string
          id: string
          metadata: Json
          request_id: string
        }
        Insert: {
          action: string
          actor_platform_staff_id: string
          approval_request_id: string
          created_at?: string
          id?: string
          metadata?: Json
          request_id: string
        }
        Update: {
          action?: string
          actor_platform_staff_id?: string
          approval_request_id?: string
          created_at?: string
          id?: string
          metadata?: Json
          request_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "platform_action_approval_events_actor_platform_staff_id_fkey"
            columns: ["actor_platform_staff_id"]
            isOneToOne: false
            referencedRelation: "platform_staff"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "platform_action_approval_events_approval_request_id_fkey"
            columns: ["approval_request_id"]
            isOneToOne: false
            referencedRelation: "platform_action_approvals"
            referencedColumns: ["id"]
          },
        ]
      }
      platform_action_approvals: {
        Row: {
          action_key: string
          approved_at: string | null
          approved_by_platform_staff_id: string | null
          consumed_at: string | null
          consumption_key: string | null
          execution_result: Json | null
          expires_at: string
          id: string
          payload: Json
          payload_hash: string
          request_id: string
          requested_at: string
          requested_by_platform_staff_id: string
          status: string
          target_key: string
        }
        Insert: {
          action_key: string
          approved_at?: string | null
          approved_by_platform_staff_id?: string | null
          consumed_at?: string | null
          consumption_key?: string | null
          execution_result?: Json | null
          expires_at?: string
          id?: string
          payload: Json
          payload_hash: string
          request_id: string
          requested_at?: string
          requested_by_platform_staff_id: string
          status?: string
          target_key: string
        }
        Update: {
          action_key?: string
          approved_at?: string | null
          approved_by_platform_staff_id?: string | null
          consumed_at?: string | null
          consumption_key?: string | null
          execution_result?: Json | null
          expires_at?: string
          id?: string
          payload?: Json
          payload_hash?: string
          request_id?: string
          requested_at?: string
          requested_by_platform_staff_id?: string
          status?: string
          target_key?: string
        }
        Relationships: [
          {
            foreignKeyName: "platform_action_approvals_approved_by_platform_staff_id_fkey"
            columns: ["approved_by_platform_staff_id"]
            isOneToOne: false
            referencedRelation: "platform_staff"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "platform_action_approvals_requested_by_platform_staff_id_fkey"
            columns: ["requested_by_platform_staff_id"]
            isOneToOne: false
            referencedRelation: "platform_staff"
            referencedColumns: ["id"]
          },
        ]
      }
      platform_staff: {
        Row: {
          created_at: string
          id: string
          offboarded_at: string | null
          role_key: string
          staff_ref: string
          status: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          offboarded_at?: string | null
          role_key: string
          staff_ref: string
          status?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          offboarded_at?: string | null
          role_key?: string
          staff_ref?: string
          status?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      products: {
        Row: {
          brand: string | null
          category: string | null
          created_at: string | null
          description: string | null
          id: string
          is_active: boolean | null
          name: string
          organization_id: string
          sku: string
          tenant_id: string
          unit: string | null
          unit_price: number
          updated_at: string | null
        }
        Insert: {
          brand?: string | null
          category?: string | null
          created_at?: string | null
          description?: string | null
          id?: string
          is_active?: boolean | null
          name: string
          organization_id: string
          sku: string
          tenant_id: string
          unit?: string | null
          unit_price?: number
          updated_at?: string | null
        }
        Update: {
          brand?: string | null
          category?: string | null
          created_at?: string | null
          description?: string | null
          id?: string
          is_active?: boolean | null
          name?: string
          organization_id?: string
          sku?: string
          tenant_id?: string
          unit?: string | null
          unit_price?: number
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "products_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "products_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "v_sam23_organization_commercial_summary"
            referencedColumns: ["organization_id"]
          },
        ]
      }
      profiles: {
        Row: {
          avatar_url: string | null
          created_at: string | null
          email: string | null
          force_password_change: boolean
          full_name: string | null
          id: string
          is_active: boolean | null
          joined_at: string | null
          last_active_at: string | null
          manager_id: string | null
          password_changed_at: string | null
          phone: string | null
          role: string | null
          updated_at: string | null
        }
        Insert: {
          avatar_url?: string | null
          created_at?: string | null
          email?: string | null
          force_password_change?: boolean
          full_name?: string | null
          id: string
          is_active?: boolean | null
          joined_at?: string | null
          last_active_at?: string | null
          manager_id?: string | null
          password_changed_at?: string | null
          phone?: string | null
          role?: string | null
          updated_at?: string | null
        }
        Update: {
          avatar_url?: string | null
          created_at?: string | null
          email?: string | null
          force_password_change?: boolean
          full_name?: string | null
          id?: string
          is_active?: boolean | null
          joined_at?: string | null
          last_active_at?: string | null
          manager_id?: string | null
          password_changed_at?: string | null
          phone?: string | null
          role?: string | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "profiles_manager_id_fkey"
            columns: ["manager_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "profiles_manager_id_fkey"
            columns: ["manager_id"]
            isOneToOne: false
            referencedRelation: "sales_performance"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "profiles_manager_id_fkey"
            columns: ["manager_id"]
            isOneToOne: false
            referencedRelation: "v_sales_personal_stats"
            referencedColumns: ["user_id"]
          },
        ]
      }
      projects: {
        Row: {
          assigned_to: string | null
          cad_url: string | null
          contract_amount: number | null
          contract_id: string | null
          contract_url: string | null
          created_at: string | null
          customer_id: string | null
          id: string
          lead_id: string | null
          location: string | null
          name: string
          organization_id: string
          paid_amount: number | null
          phase: string | null
          ppt_url: string | null
          project_manager: string | null
          property_size: number | null
          property_type: string | null
          quote_url: string | null
          quoted_amount: number | null
          sales_id: string | null
          status: string | null
          updated_at: string | null
        }
        Insert: {
          assigned_to?: string | null
          cad_url?: string | null
          contract_amount?: number | null
          contract_id?: string | null
          contract_url?: string | null
          created_at?: string | null
          customer_id?: string | null
          id?: string
          lead_id?: string | null
          location?: string | null
          name: string
          organization_id: string
          paid_amount?: number | null
          phase?: string | null
          ppt_url?: string | null
          project_manager?: string | null
          property_size?: number | null
          property_type?: string | null
          quote_url?: string | null
          quoted_amount?: number | null
          sales_id?: string | null
          status?: string | null
          updated_at?: string | null
        }
        Update: {
          assigned_to?: string | null
          cad_url?: string | null
          contract_amount?: number | null
          contract_id?: string | null
          contract_url?: string | null
          created_at?: string | null
          customer_id?: string | null
          id?: string
          lead_id?: string | null
          location?: string | null
          name?: string
          organization_id?: string
          paid_amount?: number | null
          phase?: string | null
          ppt_url?: string | null
          project_manager?: string | null
          property_size?: number | null
          property_type?: string | null
          quote_url?: string | null
          quoted_amount?: number | null
          sales_id?: string | null
          status?: string | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "fk_projects_lead"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "lead_alerts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fk_projects_lead"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fk_projects_lead"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "v_lead_trace"
            referencedColumns: ["lead_id"]
          },
          {
            foreignKeyName: "fk_projects_lead"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "v_risk_pool"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fk_projects_lead"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "v_stagnant_leads"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "projects_assigned_to_fkey"
            columns: ["assigned_to"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "projects_assigned_to_fkey"
            columns: ["assigned_to"]
            isOneToOne: false
            referencedRelation: "sales_performance"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "projects_assigned_to_fkey"
            columns: ["assigned_to"]
            isOneToOne: false
            referencedRelation: "v_sales_personal_stats"
            referencedColumns: ["user_id"]
          },
          {
            foreignKeyName: "projects_contract_id_fkey"
            columns: ["contract_id"]
            isOneToOne: false
            referencedRelation: "contracts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "projects_contract_id_fkey"
            columns: ["contract_id"]
            isOneToOne: false
            referencedRelation: "v_account_receivable_aging"
            referencedColumns: ["contract_id"]
          },
          {
            foreignKeyName: "projects_contract_id_fkey"
            columns: ["contract_id"]
            isOneToOne: false
            referencedRelation: "v_lead_trace"
            referencedColumns: ["contract_id"]
          },
          {
            foreignKeyName: "projects_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "projects_organization_contract_fkey"
            columns: ["organization_id", "contract_id"]
            isOneToOne: false
            referencedRelation: "contracts"
            referencedColumns: ["organization_id", "id"]
          },
          {
            foreignKeyName: "projects_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "projects_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "v_sam23_organization_commercial_summary"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "projects_organization_lead_fkey"
            columns: ["organization_id", "lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["organization_id", "id"]
          },
          {
            foreignKeyName: "projects_project_manager_fkey"
            columns: ["project_manager"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "projects_project_manager_fkey"
            columns: ["project_manager"]
            isOneToOne: false
            referencedRelation: "sales_performance"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "projects_project_manager_fkey"
            columns: ["project_manager"]
            isOneToOne: false
            referencedRelation: "v_sales_personal_stats"
            referencedColumns: ["user_id"]
          },
          {
            foreignKeyName: "projects_sales_id_fkey"
            columns: ["sales_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "projects_sales_id_fkey"
            columns: ["sales_id"]
            isOneToOne: false
            referencedRelation: "sales_performance"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "projects_sales_id_fkey"
            columns: ["sales_id"]
            isOneToOne: false
            referencedRelation: "v_sales_personal_stats"
            referencedColumns: ["user_id"]
          },
        ]
      }
      quotations: {
        Row: {
          accepted_at: string | null
          contract_id: string | null
          created_at: string | null
          created_by: string | null
          currency: string | null
          customer_id: string | null
          delivery_terms: string | null
          devices_json: Json | null
          discount_amount: number | null
          discount_rate: number | null
          id: string
          internal_notes: string | null
          lead_id: string
          notes: string | null
          organization_id: string
          payment_terms: string | null
          pdf_url: string | null
          ppt_url: string | null
          quotation_type: string
          quote_no: string
          rejected_at: string | null
          sent_at: string | null
          status: string
          subtotal: number
          tax_amount: number | null
          tax_rate: number | null
          total_amount: number
          updated_at: string | null
          valid_until: string
          version: number | null
        }
        Insert: {
          accepted_at?: string | null
          contract_id?: string | null
          created_at?: string | null
          created_by?: string | null
          currency?: string | null
          customer_id?: string | null
          delivery_terms?: string | null
          devices_json?: Json | null
          discount_amount?: number | null
          discount_rate?: number | null
          id?: string
          internal_notes?: string | null
          lead_id: string
          notes?: string | null
          organization_id: string
          payment_terms?: string | null
          pdf_url?: string | null
          ppt_url?: string | null
          quotation_type?: string
          quote_no: string
          rejected_at?: string | null
          sent_at?: string | null
          status?: string
          subtotal?: number
          tax_amount?: number | null
          tax_rate?: number | null
          total_amount: number
          updated_at?: string | null
          valid_until?: string
          version?: number | null
        }
        Update: {
          accepted_at?: string | null
          contract_id?: string | null
          created_at?: string | null
          created_by?: string | null
          currency?: string | null
          customer_id?: string | null
          delivery_terms?: string | null
          devices_json?: Json | null
          discount_amount?: number | null
          discount_rate?: number | null
          id?: string
          internal_notes?: string | null
          lead_id?: string
          notes?: string | null
          organization_id?: string
          payment_terms?: string | null
          pdf_url?: string | null
          ppt_url?: string | null
          quotation_type?: string
          quote_no?: string
          rejected_at?: string | null
          sent_at?: string | null
          status?: string
          subtotal?: number
          tax_amount?: number | null
          tax_rate?: number | null
          total_amount?: number
          updated_at?: string | null
          valid_until?: string
          version?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "quotations_contract_id_fkey"
            columns: ["contract_id"]
            isOneToOne: false
            referencedRelation: "contracts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "quotations_contract_id_fkey"
            columns: ["contract_id"]
            isOneToOne: false
            referencedRelation: "v_account_receivable_aging"
            referencedColumns: ["contract_id"]
          },
          {
            foreignKeyName: "quotations_contract_id_fkey"
            columns: ["contract_id"]
            isOneToOne: false
            referencedRelation: "v_lead_trace"
            referencedColumns: ["contract_id"]
          },
          {
            foreignKeyName: "quotations_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "quotations_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "sales_performance"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "quotations_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "v_sales_personal_stats"
            referencedColumns: ["user_id"]
          },
          {
            foreignKeyName: "quotations_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "lead_alerts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "quotations_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "quotations_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "v_lead_trace"
            referencedColumns: ["lead_id"]
          },
          {
            foreignKeyName: "quotations_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "v_risk_pool"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "quotations_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "v_stagnant_leads"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "quotations_organization_contract_fkey"
            columns: ["organization_id", "contract_id"]
            isOneToOne: false
            referencedRelation: "contracts"
            referencedColumns: ["organization_id", "id"]
          },
          {
            foreignKeyName: "quotations_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "quotations_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "v_sam23_organization_commercial_summary"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "quotations_organization_lead_fkey"
            columns: ["organization_id", "lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["organization_id", "id"]
          },
        ]
      }
      quotes: {
        Row: {
          created_at: string | null
          device_details: Json | null
          devices: Json | null
          generated_by: string | null
          id: string
          lead_id: string | null
          organization_id: string
          ppt_url: string | null
          project_id: string | null
          quote_url: string | null
          status: string | null
          total_amount: number | null
          version: number | null
        }
        Insert: {
          created_at?: string | null
          device_details?: Json | null
          devices?: Json | null
          generated_by?: string | null
          id?: string
          lead_id?: string | null
          organization_id?: string
          ppt_url?: string | null
          project_id?: string | null
          quote_url?: string | null
          status?: string | null
          total_amount?: number | null
          version?: number | null
        }
        Update: {
          created_at?: string | null
          device_details?: Json | null
          devices?: Json | null
          generated_by?: string | null
          id?: string
          lead_id?: string | null
          organization_id?: string
          ppt_url?: string | null
          project_id?: string | null
          quote_url?: string | null
          status?: string | null
          total_amount?: number | null
          version?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "quotes_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "lead_alerts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "quotes_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "quotes_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "v_lead_trace"
            referencedColumns: ["lead_id"]
          },
          {
            foreignKeyName: "quotes_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "v_risk_pool"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "quotes_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "v_stagnant_leads"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "quotes_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "quotes_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "v_sam23_organization_commercial_summary"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "quotes_organization_lead_fkey"
            columns: ["organization_id", "lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["organization_id", "id"]
          },
          {
            foreignKeyName: "quotes_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "quotes_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "v_lead_trace"
            referencedColumns: ["project_id"]
          },
        ]
      }
      retail_inventory_movements: {
        Row: {
          blocked_delta: number
          created_at: string
          created_by: string | null
          damaged_delta: number
          id: string
          idempotency_key: string
          in_transit_delta: number
          location_id: string
          movement_type: string
          occurred_at: string
          on_hand_delta: number
          organization_id: string
          reference_id: string
          reference_type: string
          reserved_delta: number
          sku_id: string
        }
        Insert: {
          blocked_delta?: number
          created_at?: string
          created_by?: string | null
          damaged_delta?: number
          id?: string
          idempotency_key: string
          in_transit_delta?: number
          location_id: string
          movement_type: string
          occurred_at?: string
          on_hand_delta?: number
          organization_id: string
          reference_id?: string
          reference_type?: string
          reserved_delta?: number
          sku_id: string
        }
        Update: never
        Relationships: [
          {
            foreignKeyName: "retail_inventory_movements_organization_location_fkey"
            columns: ["organization_id", "location_id"]
            isOneToOne: false
            referencedRelation: "retail_locations"
            referencedColumns: ["organization_id", "id"]
          },
          {
            foreignKeyName: "retail_inventory_movements_organization_sku_fkey"
            columns: ["organization_id", "sku_id"]
            isOneToOne: false
            referencedRelation: "retail_skus"
            referencedColumns: ["organization_id", "id"]
          },
        ]
      }
      retail_locations: {
        Row: {
          code: string
          created_at: string
          id: string
          location_kind: string
          name: string
          organization_id: string
          status: string
          updated_at: string
        }
        Insert: {
          code: string
          created_at?: string
          id?: string
          location_kind: string
          name: string
          organization_id: string
          status?: string
          updated_at?: string
        }
        Update: {
          code?: string
          created_at?: string
          id?: string
          location_kind?: string
          name?: string
          organization_id?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "retail_locations_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      retail_price_book_items: {
        Row: {
          created_at: string
          effective_from: string
          effective_until: string | null
          id: string
          max_discount_percent: number
          organization_id: string
          price_book_id: string
          sku_id: string
          unit_price: number
          updated_at: string
        }
        Insert: {
          created_at?: string
          effective_from?: string
          effective_until?: string | null
          id?: string
          max_discount_percent?: number
          organization_id: string
          price_book_id: string
          sku_id: string
          unit_price: number
          updated_at?: string
        }
        Update: {
          created_at?: string
          effective_from?: string
          effective_until?: string | null
          id?: string
          max_discount_percent?: number
          organization_id?: string
          price_book_id?: string
          sku_id?: string
          unit_price?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "retail_price_book_items_organization_price_book_fkey"
            columns: ["organization_id", "price_book_id"]
            isOneToOne: false
            referencedRelation: "retail_price_books"
            referencedColumns: ["organization_id", "id"]
          },
          {
            foreignKeyName: "retail_price_book_items_organization_sku_fkey"
            columns: ["organization_id", "sku_id"]
            isOneToOne: false
            referencedRelation: "retail_skus"
            referencedColumns: ["organization_id", "id"]
          },
        ]
      }
      retail_price_books: {
        Row: {
          created_at: string
          currency: string
          id: string
          name: string
          organization_id: string
          status: string
          updated_at: string
          vat_rate: number
        }
        Insert: {
          created_at?: string
          currency?: string
          id?: string
          name: string
          organization_id: string
          status?: string
          updated_at?: string
          vat_rate?: number
        }
        Update: {
          created_at?: string
          currency?: string
          id?: string
          name?: string
          organization_id?: string
          status?: string
          updated_at?: string
          vat_rate?: number
        }
        Relationships: [
          {
            foreignKeyName: "retail_price_books_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      retail_skus: {
        Row: {
          barcode: string | null
          created_at: string
          id: string
          is_active: boolean
          name: string
          organization_id: string
          product_id: string | null
          sku: string
          unit: string
          updated_at: string
          variant_attributes: Json
        }
        Insert: {
          barcode?: string | null
          created_at?: string
          id?: string
          is_active?: boolean
          name: string
          organization_id: string
          product_id?: string | null
          sku: string
          unit?: string
          updated_at?: string
          variant_attributes?: Json
        }
        Update: {
          barcode?: string | null
          created_at?: string
          id?: string
          is_active?: boolean
          name?: string
          organization_id?: string
          product_id?: string | null
          sku?: string
          unit?: string
          updated_at?: string
          variant_attributes?: Json
        }
        Relationships: [
          {
            foreignKeyName: "retail_skus_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "retail_skus_organization_product_fkey"
            columns: ["organization_id", "product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["organization_id", "id"]
          },
        ]
      }
      retail_orders: {
        Row: { id: string; organization_id: string; source_quotation_id: string; fulfillment_location_id: string; order_number: string; status: string; currency: string; total_amount: number; created_by: string | null; created_at: string; updated_at: string }
        Insert: { id?: string; organization_id: string; source_quotation_id: string; fulfillment_location_id: string; order_number: string; status?: string; currency?: string; total_amount: number; created_by?: string | null; created_at?: string; updated_at?: string }
        Update: { status?: string; updated_at?: string }
        Relationships: [
          { foreignKeyName: "retail_orders_organization_quotation_fkey"; columns: ["organization_id", "source_quotation_id"]; isOneToOne: false; referencedRelation: "quotations"; referencedColumns: ["organization_id", "id"] },
          { foreignKeyName: "retail_orders_organization_location_fkey"; columns: ["organization_id", "fulfillment_location_id"]; isOneToOne: false; referencedRelation: "retail_locations"; referencedColumns: ["organization_id", "id"] },
        ]
      }
      retail_order_items: {
        Row: { id: string; organization_id: string; order_id: string; sku_id: string; quantity: number; unit_price: number; created_at: string }
        Insert: { id?: string; organization_id: string; order_id: string; sku_id: string; quantity: number; unit_price: number; created_at?: string }
        Update: never
        Relationships: [
          { foreignKeyName: "retail_order_items_organization_order_fkey"; columns: ["organization_id", "order_id"]; isOneToOne: false; referencedRelation: "retail_orders"; referencedColumns: ["organization_id", "id"] },
          { foreignKeyName: "retail_order_items_organization_sku_fkey"; columns: ["organization_id", "sku_id"]; isOneToOne: false; referencedRelation: "retail_skus"; referencedColumns: ["organization_id", "id"] },
        ]
      }
      retail_purchase_orders: {
        Row: { id: string; organization_id: string; receiving_location_id: string; purchase_order_number: string; supplier_name: string; status: string; created_by: string | null; created_at: string; updated_at: string }
        Insert: { id?: string; organization_id: string; receiving_location_id: string; purchase_order_number: string; supplier_name: string; status?: string; created_by?: string | null; created_at?: string; updated_at?: string }
        Update: { status?: string; updated_at?: string }
        Relationships: [{ foreignKeyName: "retail_purchase_orders_organization_location_fkey"; columns: ["organization_id", "receiving_location_id"]; isOneToOne: false; referencedRelation: "retail_locations"; referencedColumns: ["organization_id", "id"] }]
      }
      retail_purchase_order_items: {
        Row: { id: string; organization_id: string; purchase_order_id: string; sku_id: string; ordered_quantity: number; unit_cost: number; created_at: string }
        Insert: { id?: string; organization_id: string; purchase_order_id: string; sku_id: string; ordered_quantity: number; unit_cost: number; created_at?: string }
        Update: never
        Relationships: [
          { foreignKeyName: "retail_purchase_order_items_organization_purchase_order_fkey"; columns: ["organization_id", "purchase_order_id"]; isOneToOne: false; referencedRelation: "retail_purchase_orders"; referencedColumns: ["organization_id", "id"] },
          { foreignKeyName: "retail_purchase_order_items_organization_sku_fkey"; columns: ["organization_id", "sku_id"]; isOneToOne: false; referencedRelation: "retail_skus"; referencedColumns: ["organization_id", "id"] },
        ]
      }
      retail_goods_receipts: {
        Row: { id: string; organization_id: string; purchase_order_id: string; location_id: string; idempotency_key: string; status: string; received_by: string; received_at: string; created_at: string }
        Insert: { id?: string; organization_id: string; purchase_order_id: string; location_id: string; idempotency_key: string; status?: string; received_by: string; received_at?: string; created_at?: string }
        Update: never
        Relationships: [
          { foreignKeyName: "retail_goods_receipts_organization_purchase_order_fkey"; columns: ["organization_id", "purchase_order_id"]; isOneToOne: false; referencedRelation: "retail_purchase_orders"; referencedColumns: ["organization_id", "id"] },
          { foreignKeyName: "retail_goods_receipts_organization_location_fkey"; columns: ["organization_id", "location_id"]; isOneToOne: false; referencedRelation: "retail_locations"; referencedColumns: ["organization_id", "id"] },
        ]
      }
      retail_goods_receipt_items: {
        Row: { id: string; organization_id: string; receipt_id: string; purchase_order_item_id: string; sku_id: string; received_quantity: number; created_at: string }
        Insert: { id?: string; organization_id: string; receipt_id: string; purchase_order_item_id: string; sku_id: string; received_quantity: number; created_at?: string }
        Update: never
        Relationships: [
          { foreignKeyName: "retail_goods_receipt_items_organization_receipt_fkey"; columns: ["organization_id", "receipt_id"]; isOneToOne: false; referencedRelation: "retail_goods_receipts"; referencedColumns: ["organization_id", "id"] },
          { foreignKeyName: "retail_goods_receipt_items_organization_sku_fkey"; columns: ["organization_id", "sku_id"]; isOneToOne: false; referencedRelation: "retail_skus"; referencedColumns: ["organization_id", "id"] },
        ]
      }
      retail_delivery_handoffs: {
        Row: { id: string; organization_id: string; order_id: string; location_id: string; assigned_driver_id: string; status: string; delivered_at: string | null; created_at: string; updated_at: string }
        Insert: { id?: string; organization_id: string; order_id: string; location_id: string; assigned_driver_id: string; status?: string; delivered_at?: string | null; created_at?: string; updated_at?: string }
        Update: { status?: string; delivered_at?: string | null; updated_at?: string }
        Relationships: [{ foreignKeyName: "retail_delivery_handoffs_organization_order_fkey"; columns: ["organization_id", "order_id"]; isOneToOne: false; referencedRelation: "retail_orders"; referencedColumns: ["organization_id", "id"] }]
      }
      retail_cod_events: {
        Row: { id: string; organization_id: string; order_id: string; handoff_id: string; idempotency_key: string; event_type: string; amount: number; currency: string; actor_id: string; occurred_at: string; created_at: string }
        Insert: { id?: string; organization_id: string; order_id: string; handoff_id: string; idempotency_key: string; event_type: string; amount: number; currency?: string; actor_id: string; occurred_at?: string; created_at?: string }
        Update: never
        Relationships: [
          { foreignKeyName: "retail_cod_events_organization_order_fkey"; columns: ["organization_id", "order_id"]; isOneToOne: false; referencedRelation: "retail_orders"; referencedColumns: ["organization_id", "id"] },
          { foreignKeyName: "retail_cod_events_organization_handoff_fkey"; columns: ["organization_id", "handoff_id"]; isOneToOne: false; referencedRelation: "retail_delivery_handoffs"; referencedColumns: ["organization_id", "id"] },
        ]
      }
      retail_finance_allocations: {
        Row: { id: string; organization_id: string; order_id: string; finance_confirmation_id: string; idempotency_key: string; allocated_amount: number; allocated_by: string; allocated_at: string }
        Insert: { id?: string; organization_id: string; order_id: string; finance_confirmation_id: string; idempotency_key: string; allocated_amount: number; allocated_by: string; allocated_at?: string }
        Update: never
        Relationships: [{ foreignKeyName: "retail_finance_allocations_organization_order_fkey"; columns: ["organization_id", "order_id"]; isOneToOne: false; referencedRelation: "retail_orders"; referencedColumns: ["organization_id", "id"] }]
      }
      retail_finance_reconciliations: {
        Row: { id: string; organization_id: string; reconciliation_date: string; collected_amount: number; allocated_amount: number; status: string; completed_by: string | null; completed_at: string | null; created_at: string }
        Insert: { id?: string; organization_id: string; reconciliation_date: string; collected_amount: number; allocated_amount: number; status?: string; completed_by?: string | null; completed_at?: string | null; created_at?: string }
        Update: { collected_amount?: number; allocated_amount?: number; status?: string; completed_by?: string | null; completed_at?: string | null }
        Relationships: []
      }
      role_capabilities: {
        Row: {
          capability_id: string
          granted_at: string
          role_id: string
        }
        Insert: {
          capability_id: string
          granted_at?: string
          role_id: string
        }
        Update: {
          capability_id?: string
          granted_at?: string
          role_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "role_capabilities_capability_id_fkey"
            columns: ["capability_id"]
            isOneToOne: false
            referencedRelation: "capabilities"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "role_capabilities_role_id_fkey"
            columns: ["role_id"]
            isOneToOne: false
            referencedRelation: "roles"
            referencedColumns: ["id"]
          },
        ]
      }
      real_estate_listing_assets: {
        Row: {
          asset_kind: string
          asset_reference: string
          created_at: string
          created_by: string
          id: string
          listing_id: string
          organization_id: string
          verification_status: string
        }
        Insert: {
          asset_kind: string
          asset_reference: string
          created_at?: string
          created_by?: string
          id?: string
          listing_id: string
          organization_id: string
          verification_status?: string
        }
        Update: {
          asset_kind?: string
          asset_reference?: string
          created_at?: string
          created_by?: string
          id?: string
          listing_id?: string
          organization_id?: string
          verification_status?: string
        }
        Relationships: [
          {
            foreignKeyName: "real_estate_listing_assets_organization_listing_fkey"
            columns: ["organization_id", "listing_id"]
            isOneToOne: false
            referencedRelation: "real_estate_listings"
            referencedColumns: ["organization_id", "id"]
          },
          {
            foreignKeyName: "real_estate_listing_assets_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      real_estate_listings: {
        Row: {
          asking_price: number
          availability_status: string
          created_at: string
          created_by: string
          currency_code: string
          exclusivity: string
          id: string
          listing_reference: string
          organization_id: string
          owner_party_id: string
          property_id: string
          publish_state: string
          status: string
          updated_at: string
        }
        Insert: {
          asking_price: number
          availability_status?: string
          created_at?: string
          created_by?: string
          currency_code?: string
          exclusivity?: string
          id?: string
          listing_reference: string
          organization_id: string
          owner_party_id: string
          property_id: string
          publish_state?: string
          status?: string
          updated_at?: string
        }
        Update: {
          asking_price?: number
          availability_status?: string
          created_at?: string
          created_by?: string
          currency_code?: string
          exclusivity?: string
          id?: string
          listing_reference?: string
          organization_id?: string
          owner_party_id?: string
          property_id?: string
          publish_state?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "real_estate_listings_organization_owner_fkey"
            columns: ["organization_id", "owner_party_id"]
            isOneToOne: false
            referencedRelation: "real_estate_parties"
            referencedColumns: ["organization_id", "id"]
          },
          {
            foreignKeyName: "real_estate_listings_organization_property_fkey"
            columns: ["organization_id", "property_id"]
            isOneToOne: false
            referencedRelation: "real_estate_properties"
            referencedColumns: ["organization_id", "id"]
          },
          {
            foreignKeyName: "real_estate_listings_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      real_estate_parties: {
        Row: {
          consent_status: string
          created_at: string
          created_by: string
          display_name: string
          id: string
          makani_reference: string | null
          normalized_email: string | null
          organization_id: string
          party_type: string
          permit_reference: string | null
          phone_e164: string | null
          trakheesi_reference: string | null
          updated_at: string
          verification_status: string
        }
        Insert: {
          consent_status?: string
          created_at?: string
          created_by?: string
          display_name: string
          id?: string
          makani_reference?: string | null
          normalized_email?: string | null
          organization_id: string
          party_type: string
          permit_reference?: string | null
          phone_e164?: string | null
          trakheesi_reference?: string | null
          updated_at?: string
          verification_status?: string
        }
        Update: {
          consent_status?: string
          created_at?: string
          created_by?: string
          display_name?: string
          id?: string
          makani_reference?: string | null
          normalized_email?: string | null
          organization_id?: string
          party_type?: string
          permit_reference?: string | null
          phone_e164?: string | null
          trakheesi_reference?: string | null
          updated_at?: string
          verification_status?: string
        }
        Relationships: [
          {
            foreignKeyName: "real_estate_parties_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      real_estate_properties: {
        Row: {
          address_line: string
          area_sqm: number | null
          created_at: string
          created_by: string
          id: string
          organization_id: string
          owner_party_id: string
          property_reference: string
          property_type: string
          status: string
          unit_reference: string | null
          updated_at: string
        }
        Insert: {
          address_line: string
          area_sqm?: number | null
          created_at?: string
          created_by?: string
          id?: string
          organization_id: string
          owner_party_id: string
          property_reference: string
          property_type: string
          status?: string
          unit_reference?: string | null
          updated_at?: string
        }
        Update: {
          address_line?: string
          area_sqm?: number | null
          created_at?: string
          created_by?: string
          id?: string
          organization_id?: string
          owner_party_id?: string
          property_reference?: string
          property_type?: string
          status?: string
          unit_reference?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "real_estate_properties_organization_owner_fkey"
            columns: ["organization_id", "owner_party_id"]
            isOneToOne: false
            referencedRelation: "real_estate_parties"
            referencedColumns: ["organization_id", "id"]
          },
          {
            foreignKeyName: "real_estate_properties_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      real_estate_viewings: {
        Row: {
          created_at: string
          created_by: string
          feedback: string | null
          id: string
          idempotency_key: string
          lead_id: string
          listing_id: string
          organization_id: string
          scheduled_at: string
          status: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by?: string
          feedback?: string | null
          id?: string
          idempotency_key: string
          lead_id: string
          listing_id: string
          organization_id: string
          scheduled_at: string
          status?: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string
          feedback?: string | null
          id?: string
          idempotency_key?: string
          lead_id?: string
          listing_id?: string
          organization_id?: string
          scheduled_at?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "real_estate_viewings_organization_lead_fkey"
            columns: ["organization_id", "lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["organization_id", "id"]
          },
          {
            foreignKeyName: "real_estate_viewings_organization_listing_fkey"
            columns: ["organization_id", "listing_id"]
            isOneToOne: false
            referencedRelation: "real_estate_listings"
            referencedColumns: ["organization_id", "id"]
          },
          {
            foreignKeyName: "real_estate_viewings_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      roles: {
        Row: {
          can_write_business_data: boolean
          created_at: string
          display_name: string
          id: string
          is_billable: boolean
          role_key: string
          scope: string
        }
        Insert: {
          can_write_business_data?: boolean
          created_at?: string
          display_name: string
          id?: string
          is_billable?: boolean
          role_key: string
          scope?: string
        }
        Update: {
          can_write_business_data?: boolean
          created_at?: string
          display_name?: string
          id?: string
          is_billable?: boolean
          role_key?: string
          scope?: string
        }
        Relationships: []
      }
      shared_approval_requests: {
        Row: {
          action_key: string
          created_at: string
          decided_at: string | null
          decided_by: string | null
          decision_reason_code: string | null
          expires_at: string
          id: string
          idempotency_key: string
          organization_id: string
          payload: Json
          payload_sha256: string
          requested_by: string
          resource_id: string | null
          resource_type: string
          status: string
          updated_at: string
        }
        Insert: {
          action_key: string
          created_at?: string
          decided_at?: string | null
          decided_by?: string | null
          decision_reason_code?: string | null
          expires_at: string
          id?: string
          idempotency_key: string
          organization_id: string
          payload?: Json
          payload_sha256?: string
          requested_by: string
          resource_id?: string | null
          resource_type: string
          status?: string
          updated_at?: string
        }
        Update: {
          action_key?: string
          created_at?: string
          decided_at?: string | null
          decided_by?: string | null
          decision_reason_code?: string | null
          expires_at?: string
          id?: string
          idempotency_key?: string
          organization_id?: string
          payload?: Json
          payload_sha256?: string
          requested_by?: string
          resource_id?: string | null
          resource_type?: string
          status?: string
          updated_at?: string
        }
        Relationships: []
      }
      shared_jobs: {
        Row: {
          attempts: number
          completed_at: string | null
          created_at: string
          error_code: string | null
          id: string
          idempotency_key: string
          input_file_id: string | null
          kind: string
          lease_expires_at: string | null
          leased_by: string | null
          max_attempts: number
          next_attempt_at: string
          organization_id: string
          output_file_id: string | null
          parameters: Json
          requested_by: string
          result_counts: Json
          result_sha256: string | null
          started_at: string | null
          state: string
          updated_at: string
        }
        Insert: {
          attempts?: number
          completed_at?: string | null
          created_at?: string
          error_code?: string | null
          id?: string
          idempotency_key: string
          input_file_id?: string | null
          kind: string
          lease_expires_at?: string | null
          leased_by?: string | null
          max_attempts?: number
          next_attempt_at?: string
          organization_id: string
          output_file_id?: string | null
          parameters?: Json
          requested_by: string
          result_counts?: Json
          result_sha256?: string | null
          started_at?: string | null
          state?: string
          updated_at?: string
        }
        Update: {
          attempts?: number
          completed_at?: string | null
          created_at?: string
          error_code?: string | null
          id?: string
          idempotency_key?: string
          input_file_id?: string | null
          kind?: string
          lease_expires_at?: string | null
          leased_by?: string | null
          max_attempts?: number
          next_attempt_at?: string
          organization_id?: string
          output_file_id?: string | null
          parameters?: Json
          requested_by?: string
          result_counts?: Json
          result_sha256?: string | null
          started_at?: string | null
          state?: string
          updated_at?: string
        }
        Relationships: []
      }
      shared_notifications: {
        Row: {
          attempts: number
          channel: string
          created_at: string
          dedupe_key: string
          delivered_at: string | null
          id: string
          organization_id: string
          payload: Json
          read_at: string | null
          recipient_user_id: string
          source_event_id: string | null
          state: string
          template_key: string
          updated_at: string
        }
        Insert: {
          attempts?: number
          channel?: string
          created_at?: string
          dedupe_key: string
          delivered_at?: string | null
          id?: string
          organization_id: string
          payload?: Json
          read_at?: string | null
          recipient_user_id: string
          source_event_id?: string | null
          state?: string
          template_key: string
          updated_at?: string
        }
        Update: {
          attempts?: number
          channel?: string
          created_at?: string
          dedupe_key?: string
          delivered_at?: string | null
          id?: string
          organization_id?: string
          payload?: Json
          read_at?: string | null
          recipient_user_id?: string
          source_event_id?: string | null
          state?: string
          template_key?: string
          updated_at?: string
        }
        Relationships: []
      }
      shared_outbox: {
        Row: {
          aggregate_id: string | null
          aggregate_type: string
          attempts: number
          created_at: string
          dedupe_key: string
          delivered_at: string | null
          event_type: string
          id: string
          last_error_code: string | null
          lease_expires_at: string | null
          leased_by: string | null
          max_attempts: number
          next_attempt_at: string
          organization_id: string
          payload: Json
          state: string
          updated_at: string
        }
        Insert: {
          aggregate_id?: string | null
          aggregate_type: string
          attempts?: number
          created_at?: string
          dedupe_key: string
          delivered_at?: string | null
          event_type: string
          id?: string
          last_error_code?: string | null
          lease_expires_at?: string | null
          leased_by?: string | null
          max_attempts?: number
          next_attempt_at?: string
          organization_id: string
          payload?: Json
          state?: string
          updated_at?: string
        }
        Update: {
          aggregate_id?: string | null
          aggregate_type?: string
          attempts?: number
          created_at?: string
          dedupe_key?: string
          delivered_at?: string | null
          event_type?: string
          id?: string
          last_error_code?: string | null
          lease_expires_at?: string | null
          leased_by?: string | null
          max_attempts?: number
          next_attempt_at?: string
          organization_id?: string
          payload?: Json
          state?: string
          updated_at?: string
        }
        Relationships: []
      }
      shared_report_snapshots: {
        Row: {
          created_at: string
          generated_by_job_id: string
          id: string
          metrics: Json
          organization_id: string
          period_end: string
          period_start: string
          report_key: string
          source_sha256: string
        }
        Insert: {
          created_at?: string
          generated_by_job_id: string
          id?: string
          metrics: Json
          organization_id: string
          period_end: string
          period_start: string
          report_key: string
          source_sha256: string
        }
        Update: {
          created_at?: string
          generated_by_job_id?: string
          id?: string
          metrics?: Json
          organization_id?: string
          period_end?: string
          period_start?: string
          report_key?: string
          source_sha256?: string
        }
        Relationships: []
      }
      shared_timeline_events: {
        Row: {
          actor_user_id: string | null
          created_at: string
          event_type: string
          id: string
          metadata: Json
          organization_id: string
          request_id: string
          resource_id: string | null
          resource_type: string
          visibility: string
        }
        Insert: {
          actor_user_id?: string | null
          created_at?: string
          event_type: string
          id?: string
          metadata?: Json
          organization_id: string
          request_id: string
          resource_id?: string | null
          resource_type: string
          visibility?: string
        }
        Update: {
          actor_user_id?: string | null
          created_at?: string
          event_type?: string
          id?: string
          metadata?: Json
          organization_id?: string
          request_id?: string
          resource_id?: string | null
          resource_type?: string
          visibility?: string
        }
        Relationships: []
      }
      shared_work_items: {
        Row: {
          assignee_user_id: string | null
          completed_at: string | null
          created_at: string
          created_by: string
          details: string | null
          due_at: string | null
          id: string
          idempotency_key: string
          organization_id: string
          priority: string
          source_id: string | null
          source_type: string | null
          status: string
          title: string
          updated_at: string
        }
        Insert: {
          assignee_user_id?: string | null
          completed_at?: string | null
          created_at?: string
          created_by: string
          details?: string | null
          due_at?: string | null
          id?: string
          idempotency_key: string
          organization_id: string
          priority?: string
          source_id?: string | null
          source_type?: string | null
          status?: string
          title: string
          updated_at?: string
        }
        Update: {
          assignee_user_id?: string | null
          completed_at?: string | null
          created_at?: string
          created_by?: string
          details?: string | null
          due_at?: string | null
          id?: string
          idempotency_key?: string
          organization_id?: string
          priority?: string
          source_id?: string | null
          source_type?: string | null
          status?: string
          title?: string
          updated_at?: string
        }
        Relationships: []
      }
      support_sessions: {
        Row: {
          approved_at: string | null
          approved_by_platform_staff_id: string | null
          created_at: string
          expires_at: string
          id: string
          organization_id: string
          platform_staff_id: string
          reason: string
          requested_at: string
          revoked_at: string | null
          scope: Json
          status: string
          ticket_ref: string
        }
        Insert: {
          approved_at?: string | null
          approved_by_platform_staff_id?: string | null
          created_at?: string
          expires_at: string
          id?: string
          organization_id: string
          platform_staff_id: string
          reason: string
          requested_at?: string
          revoked_at?: string | null
          scope: Json
          status?: string
          ticket_ref: string
        }
        Update: {
          approved_at?: string | null
          approved_by_platform_staff_id?: string | null
          created_at?: string
          expires_at?: string
          id?: string
          organization_id?: string
          platform_staff_id?: string
          reason?: string
          requested_at?: string
          revoked_at?: string | null
          scope?: Json
          status?: string
          ticket_ref?: string
        }
        Relationships: [
          {
            foreignKeyName: "support_sessions_approved_by_platform_staff_id_fkey"
            columns: ["approved_by_platform_staff_id"]
            isOneToOne: false
            referencedRelation: "platform_staff"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "support_sessions_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "support_sessions_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "v_sam23_organization_commercial_summary"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "support_sessions_platform_staff_id_fkey"
            columns: ["platform_staff_id"]
            isOneToOne: false
            referencedRelation: "platform_staff"
            referencedColumns: ["id"]
          },
        ]
      }
      tasks: {
        Row: {
          assignee_id: string | null
          completed_at: string | null
          created_at: string
          description: string | null
          due_at: string
          id: string
          lead_id: string
          organization_id: string
          priority: string | null
          source: string | null
          status: string
          title: string
        }
        Insert: {
          assignee_id?: string | null
          completed_at?: string | null
          created_at?: string
          description?: string | null
          due_at: string
          id?: string
          lead_id: string
          organization_id: string
          priority?: string | null
          source?: string | null
          status?: string
          title: string
        }
        Update: {
          assignee_id?: string | null
          completed_at?: string | null
          created_at?: string
          description?: string | null
          due_at?: string
          id?: string
          lead_id?: string
          organization_id?: string
          priority?: string | null
          source?: string | null
          status?: string
          title?: string
        }
        Relationships: [
          {
            foreignKeyName: "tasks_assignee_id_fkey"
            columns: ["assignee_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tasks_assignee_id_fkey"
            columns: ["assignee_id"]
            isOneToOne: false
            referencedRelation: "sales_performance"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tasks_assignee_id_fkey"
            columns: ["assignee_id"]
            isOneToOne: false
            referencedRelation: "v_sales_personal_stats"
            referencedColumns: ["user_id"]
          },
          {
            foreignKeyName: "tasks_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "lead_alerts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tasks_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tasks_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "v_lead_trace"
            referencedColumns: ["lead_id"]
          },
          {
            foreignKeyName: "tasks_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "v_risk_pool"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tasks_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "v_stagnant_leads"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tasks_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tasks_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "v_sam23_organization_commercial_summary"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "tasks_organization_lead_fkey"
            columns: ["organization_id", "lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["organization_id", "id"]
          },
        ]
      }
      tenant_file_deletion_outbox: {
        Row: {
          attempt_count: number
          completed_at: string | null
          created_at: string
          file_id: string
          id: string
          last_error: string | null
          lease_expires_at: string | null
          lease_owner: string | null
          next_attempt_at: string
          object_key: string
          organization_id: string
          provider_delete_not_before: string
          reason: string
          request_id: string
          requested_by: string | null
          status: string
          terminal_status: string
        }
        Insert: {
          attempt_count?: number
          completed_at?: string | null
          created_at?: string
          file_id: string
          id?: string
          last_error?: string | null
          lease_expires_at?: string | null
          lease_owner?: string | null
          next_attempt_at?: string
          object_key: string
          organization_id: string
          provider_delete_not_before: string
          reason: string
          request_id: string
          requested_by?: string | null
          status?: string
          terminal_status: string
        }
        Update: {
          attempt_count?: number
          completed_at?: string | null
          created_at?: string
          file_id?: string
          id?: string
          last_error?: string | null
          lease_expires_at?: string | null
          lease_owner?: string | null
          next_attempt_at?: string
          object_key?: string
          organization_id?: string
          provider_delete_not_before?: string
          reason?: string
          request_id?: string
          requested_by?: string | null
          status?: string
          terminal_status?: string
        }
        Relationships: [
          {
            foreignKeyName: "tenant_file_deletion_outbox_file_id_fkey"
            columns: ["file_id"]
            isOneToOne: true
            referencedRelation: "tenant_file_objects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tenant_file_deletion_outbox_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tenant_file_deletion_outbox_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "v_sam23_organization_commercial_summary"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "tenant_file_deletion_outbox_requested_by_fkey"
            columns: ["requested_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tenant_file_deletion_outbox_requested_by_fkey"
            columns: ["requested_by"]
            isOneToOne: false
            referencedRelation: "sales_performance"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tenant_file_deletion_outbox_requested_by_fkey"
            columns: ["requested_by"]
            isOneToOne: false
            referencedRelation: "v_sales_personal_stats"
            referencedColumns: ["user_id"]
          },
        ]
      }
      tenant_file_objects: {
        Row: {
          confirmed_at: string | null
          confirmed_by: string | null
          content_type: string
          created_at: string
          created_by: string
          expected_content_md5: string
          expected_size_bytes: number
          id: string
          metadata: Json
          object_key: string
          organization_id: string
          original_filename: string
          pending_expires_at: string
          provider_checksum_crc64ecma: string | null
          provider_etag: string | null
          provider_verified_at: string | null
          record_id: string
          record_type: string
          request_id: string
          size_bytes: number | null
          status: string
          terminal_at: string | null
          terminal_reason: string | null
          upload_url_expires_at: string
          version: string
        }
        Insert: {
          confirmed_at?: string | null
          confirmed_by?: string | null
          content_type: string
          created_at?: string
          created_by: string
          expected_content_md5: string
          expected_size_bytes: number
          id?: string
          metadata?: Json
          object_key: string
          organization_id: string
          original_filename: string
          pending_expires_at?: string
          provider_checksum_crc64ecma?: string | null
          provider_etag?: string | null
          provider_verified_at?: string | null
          record_id: string
          record_type: string
          request_id: string
          size_bytes?: number | null
          status?: string
          terminal_at?: string | null
          terminal_reason?: string | null
          upload_url_expires_at?: string
          version?: string
        }
        Update: {
          confirmed_at?: string | null
          confirmed_by?: string | null
          content_type?: string
          created_at?: string
          created_by?: string
          expected_content_md5?: string
          expected_size_bytes?: number
          id?: string
          metadata?: Json
          object_key?: string
          organization_id?: string
          original_filename?: string
          pending_expires_at?: string
          provider_checksum_crc64ecma?: string | null
          provider_etag?: string | null
          provider_verified_at?: string | null
          record_id?: string
          record_type?: string
          request_id?: string
          size_bytes?: number | null
          status?: string
          terminal_at?: string | null
          terminal_reason?: string | null
          upload_url_expires_at?: string
          version?: string
        }
        Relationships: [
          {
            foreignKeyName: "tenant_file_objects_confirmed_by_fkey"
            columns: ["confirmed_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tenant_file_objects_confirmed_by_fkey"
            columns: ["confirmed_by"]
            isOneToOne: false
            referencedRelation: "sales_performance"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tenant_file_objects_confirmed_by_fkey"
            columns: ["confirmed_by"]
            isOneToOne: false
            referencedRelation: "v_sales_personal_stats"
            referencedColumns: ["user_id"]
          },
          {
            foreignKeyName: "tenant_file_objects_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tenant_file_objects_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "sales_performance"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tenant_file_objects_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "v_sales_personal_stats"
            referencedColumns: ["user_id"]
          },
          {
            foreignKeyName: "tenant_file_objects_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tenant_file_objects_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "v_sam23_organization_commercial_summary"
            referencedColumns: ["organization_id"]
          },
        ]
      }
      transfer_history: {
        Row: {
          created_at: string | null
          from_user_id: string | null
          id: string
          lead_id: string
          notes: string | null
          organization_id: string
          reason: string | null
          to_user_id: string
          transferred_by: string
        }
        Insert: {
          created_at?: string | null
          from_user_id?: string | null
          id?: string
          lead_id: string
          notes?: string | null
          organization_id?: string
          reason?: string | null
          to_user_id: string
          transferred_by: string
        }
        Update: {
          created_at?: string | null
          from_user_id?: string | null
          id?: string
          lead_id?: string
          notes?: string | null
          organization_id?: string
          reason?: string | null
          to_user_id?: string
          transferred_by?: string
        }
        Relationships: [
          {
            foreignKeyName: "transfer_history_from_user_id_fkey"
            columns: ["from_user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "transfer_history_from_user_id_fkey"
            columns: ["from_user_id"]
            isOneToOne: false
            referencedRelation: "sales_performance"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "transfer_history_from_user_id_fkey"
            columns: ["from_user_id"]
            isOneToOne: false
            referencedRelation: "v_sales_personal_stats"
            referencedColumns: ["user_id"]
          },
          {
            foreignKeyName: "transfer_history_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "lead_alerts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "transfer_history_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "transfer_history_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "v_lead_trace"
            referencedColumns: ["lead_id"]
          },
          {
            foreignKeyName: "transfer_history_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "v_risk_pool"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "transfer_history_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "v_stagnant_leads"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "transfer_history_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "transfer_history_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "v_sam23_organization_commercial_summary"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "transfer_history_organization_lead_fkey"
            columns: ["organization_id", "lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["organization_id", "id"]
          },
          {
            foreignKeyName: "transfer_history_to_user_id_fkey"
            columns: ["to_user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "transfer_history_to_user_id_fkey"
            columns: ["to_user_id"]
            isOneToOne: false
            referencedRelation: "sales_performance"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "transfer_history_to_user_id_fkey"
            columns: ["to_user_id"]
            isOneToOne: false
            referencedRelation: "v_sales_personal_stats"
            referencedColumns: ["user_id"]
          },
          {
            foreignKeyName: "transfer_history_transferred_by_fkey"
            columns: ["transferred_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "transfer_history_transferred_by_fkey"
            columns: ["transferred_by"]
            isOneToOne: false
            referencedRelation: "sales_performance"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "transfer_history_transferred_by_fkey"
            columns: ["transferred_by"]
            isOneToOne: false
            referencedRelation: "v_sales_personal_stats"
            referencedColumns: ["user_id"]
          },
        ]
      }
      user_features: {
        Row: {
          created_at: string
          enabled: boolean
          feature_key: string
          user_id: string
        }
        Insert: {
          created_at?: string
          enabled?: boolean
          feature_key: string
          user_id: string
        }
        Update: {
          created_at?: string
          enabled?: boolean
          feature_key?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_features_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_features_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "sales_performance"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_features_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "v_sales_personal_stats"
            referencedColumns: ["user_id"]
          },
        ]
      }
      user_session_daily: {
        Row: {
          actions_count: number | null
          created_at: string | null
          first_login: string | null
          id: string
          last_active: string | null
          login_count: number | null
          organization_id: string
          pages_viewed: number | null
          session_date: string
          tenant_id: string
          total_duration_seconds: number | null
          updated_at: string | null
          user_id: string
        }
        Insert: {
          actions_count?: number | null
          created_at?: string | null
          first_login?: string | null
          id?: string
          last_active?: string | null
          login_count?: number | null
          organization_id?: string
          pages_viewed?: number | null
          session_date?: string
          tenant_id?: string
          total_duration_seconds?: number | null
          updated_at?: string | null
          user_id: string
        }
        Update: {
          actions_count?: number | null
          created_at?: string | null
          first_login?: string | null
          id?: string
          last_active?: string | null
          login_count?: number | null
          organization_id?: string
          pages_viewed?: number | null
          session_date?: string
          tenant_id?: string
          total_duration_seconds?: number | null
          updated_at?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_session_daily_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_session_daily_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "v_sam23_organization_commercial_summary"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "user_session_daily_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_session_daily_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "sales_performance"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_session_daily_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "v_sales_personal_stats"
            referencedColumns: ["user_id"]
          },
        ]
      }
      v4_legacy_policy_snapshots: {
        Row: {
          check_expression: string | null
          permissive: string
          policy_command: string
          policy_name: string
          policy_roles: string[]
          schema_name: string
          table_name: string
          using_expression: string | null
        }
        Insert: {
          check_expression?: string | null
          permissive: string
          policy_command: string
          policy_name: string
          policy_roles: string[]
          schema_name: string
          table_name: string
          using_expression?: string | null
        }
        Update: {
          check_expression?: string | null
          permissive?: string
          policy_command?: string
          policy_name?: string
          policy_roles?: string[]
          schema_name?: string
          table_name?: string
          using_expression?: string | null
        }
        Relationships: []
      }
      v4_legacy_table_acl_snapshots: {
        Row: {
          grantee_name: string
          grantor_name: string
          is_grantable: boolean
          privilege_type: string
          schema_name: string
          table_name: string
        }
        Insert: {
          grantee_name: string
          grantor_name: string
          is_grantable: boolean
          privilege_type: string
          schema_name: string
          table_name: string
        }
        Update: {
          grantee_name?: string
          grantor_name?: string
          is_grantable?: boolean
          privilege_type?: string
          schema_name?: string
          table_name?: string
        }
        Relationships: []
      }
    }
    Views: {
      v4_shared_operations_summary: {
        Row: {
          active_jobs: number | null
          dead_letters: number | null
          open_work_items: number | null
          organization_id: string | null
          pending_approvals: number | null
          unread_notifications: number | null
        }
        Relationships: []
      }
      retail_order_finance_summary: {
        Row: {
          allocated_amount: number | null
          confirmed_cod_amount: number | null
          fulfillment_location_id: string | null
          order_id: string | null
          organization_id: string | null
          receivable_amount: number | null
          status: string | null
          total_amount: number | null
        }
        Relationships: []
      }
      retail_effective_prices: {
        Row: {
          currency: string | null
          effective_from: string | null
          effective_until: string | null
          max_discount_percent: number | null
          organization_id: string | null
          price_book_id: string | null
          sku_id: string | null
          unit_price: number | null
          vat_rate: number | null
        }
        Relationships: []
      }
      retail_inventory_balances: {
        Row: {
          available: number | null
          blocked: number | null
          damaged: number | null
          in_transit: number | null
          location_id: string | null
          on_hand: number | null
          organization_id: string | null
          reserved: number | null
          sku_id: string | null
        }
        Relationships: []
      }
      v_real_estate_listing_publish_readiness: {
        Row: {
          is_publish_ready: boolean | null
          listing_id: string | null
          organization_id: string | null
          publish_state: string | null
          status: string | null
        }
        Relationships: []
      }
      lead_alerts: {
        Row: {
          alert_message: string | null
          alert_type: string | null
          assigned_to: string | null
          customer_name: string | null
          days_since_contact: number | null
          followup_count: number | null
          funnel_stage: string | null
          hold_since: string | null
          id: string | null
          last_contact_date: string | null
          lead_status: string | null
          next_action: string | null
          next_followup_date: string | null
          phone: string | null
          quotation_value: number | null
          recovery_candidate: boolean | null
          rep_name: string | null
          sales_manager_review: boolean | null
          severity: string | null
          stage_changed_at: string | null
          transfer_candidate: boolean | null
          win_probability: number | null
        }
        Insert: {
          alert_message?: never
          alert_type?: never
          assigned_to?: string | null
          customer_name?: string | null
          days_since_contact?: never
          followup_count?: number | null
          funnel_stage?: string | null
          hold_since?: string | null
          id?: string | null
          last_contact_date?: string | null
          lead_status?: string | null
          next_action?: string | null
          next_followup_date?: string | null
          phone?: string | null
          quotation_value?: number | null
          recovery_candidate?: boolean | null
          rep_name?: string | null
          sales_manager_review?: boolean | null
          severity?: never
          stage_changed_at?: string | null
          transfer_candidate?: boolean | null
          win_probability?: number | null
        }
        Update: {
          alert_message?: never
          alert_type?: never
          assigned_to?: string | null
          customer_name?: string | null
          days_since_contact?: never
          followup_count?: number | null
          funnel_stage?: string | null
          hold_since?: string | null
          id?: string | null
          last_contact_date?: string | null
          lead_status?: string | null
          next_action?: string | null
          next_followup_date?: string | null
          phone?: string | null
          quotation_value?: number | null
          recovery_candidate?: boolean | null
          rep_name?: string | null
          sales_manager_review?: boolean | null
          severity?: never
          stage_changed_at?: string | null
          transfer_candidate?: boolean | null
          win_probability?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "fk_leads_assigned_to"
            columns: ["assigned_to"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fk_leads_assigned_to"
            columns: ["assigned_to"]
            isOneToOne: false
            referencedRelation: "sales_performance"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fk_leads_assigned_to"
            columns: ["assigned_to"]
            isOneToOne: false
            referencedRelation: "v_sales_personal_stats"
            referencedColumns: ["user_id"]
          },
          {
            foreignKeyName: "leads_assigned_to_fkey"
            columns: ["assigned_to"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "leads_assigned_to_fkey"
            columns: ["assigned_to"]
            isOneToOne: false
            referencedRelation: "sales_performance"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "leads_assigned_to_fkey"
            columns: ["assigned_to"]
            isOneToOne: false
            referencedRelation: "v_sales_personal_stats"
            referencedColumns: ["user_id"]
          },
        ]
      }
      lead_funnel_daily: {
        Row: {
          count: number | null
          day: string | null
          quality: string | null
          source: string | null
          stage: string | null
        }
        Relationships: []
      }
      pipeline_summary: {
        Row: {
          avg_probability: number | null
          funnel_stage: string | null
          hot_count: number | null
          lead_count: number | null
          recovery_count: number | null
          total_value: number | null
          transfer_count: number | null
          weighted_value: number | null
        }
        Relationships: []
      }
      sales_performance: {
        Row: {
          avg_probability: number | null
          cold_leads: number | null
          contacted: number | null
          conversion_rate: number | null
          dormant_leads: number | null
          full_name: string | null
          hot_leads: number | null
          id: string | null
          lost: number | null
          negotiation: number | null
          new_leads: number | null
          pending_decision: number | null
          pipeline_value: number | null
          quotation_submitted: number | null
          recovery_candidates: number | null
          requirement_confirmed: number | null
          reviews_needed: number | null
          role: string | null
          solution_submitted: number | null
          transfer_candidates: number | null
          warm_leads: number | null
          won: number | null
        }
        Relationships: []
      }
      v_account_receivable_aging: {
        Row: {
          contract_amount: number | null
          contract_id: string | null
          contract_no: string | null
          customer_name: string | null
          overdue_installments: number | null
          payment_rate: number | null
          sales_id: string | null
          total_paid: number | null
          total_unpaid: number | null
        }
        Relationships: [
          {
            foreignKeyName: "contracts_sales_id_fkey"
            columns: ["sales_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "contracts_sales_id_fkey"
            columns: ["sales_id"]
            isOneToOne: false
            referencedRelation: "sales_performance"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "contracts_sales_id_fkey"
            columns: ["sales_id"]
            isOneToOne: false
            referencedRelation: "v_sales_personal_stats"
            referencedColumns: ["user_id"]
          },
        ]
      }
      v_funnel_conversion: {
        Row: {
          lead_count: number | null
          pct_of_total: number | null
          pipeline_value: number | null
          stage: string | null
        }
        Relationships: []
      }
      v_lead_trace: {
        Row: {
          confirmed: boolean | null
          contract_amount: number | null
          contract_id: string | null
          contract_no: string | null
          contract_status: string | null
          customer_name: string | null
          due_date: string | null
          installment_amount: number | null
          installment_id: string | null
          installment_status: string | null
          lead_id: string | null
          payment_amount: number | null
          payment_date: string | null
          payment_id: string | null
          project_id: string | null
          project_name: string | null
          project_phase: string | null
          project_status: string | null
          quotation_id: string | null
          quotation_price: number | null
          quotation_status: string | null
          quotation_value: number | null
          seq: number | null
          stage: string | null
        }
        Relationships: []
      }
      v_risk_pool: {
        Row: {
          assigned_to: string | null
          customer_name: string | null
          days_overdue: number | null
          id: string | null
          next_action: string | null
          next_followup_date: string | null
          phone: string | null
          risk_level: string | null
          stage: string | null
        }
        Insert: {
          assigned_to?: string | null
          customer_name?: string | null
          days_overdue?: never
          id?: string | null
          next_action?: string | null
          next_followup_date?: string | null
          phone?: string | null
          risk_level?: never
          stage?: string | null
        }
        Update: {
          assigned_to?: string | null
          customer_name?: string | null
          days_overdue?: never
          id?: string | null
          next_action?: string | null
          next_followup_date?: string | null
          phone?: string | null
          risk_level?: never
          stage?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "fk_leads_assigned_to"
            columns: ["assigned_to"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fk_leads_assigned_to"
            columns: ["assigned_to"]
            isOneToOne: false
            referencedRelation: "sales_performance"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fk_leads_assigned_to"
            columns: ["assigned_to"]
            isOneToOne: false
            referencedRelation: "v_sales_personal_stats"
            referencedColumns: ["user_id"]
          },
          {
            foreignKeyName: "leads_assigned_to_fkey"
            columns: ["assigned_to"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "leads_assigned_to_fkey"
            columns: ["assigned_to"]
            isOneToOne: false
            referencedRelation: "sales_performance"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "leads_assigned_to_fkey"
            columns: ["assigned_to"]
            isOneToOne: false
            referencedRelation: "v_sales_personal_stats"
            referencedColumns: ["user_id"]
          },
        ]
      }
      v_sales_personal_stats: {
        Row: {
          active_contracts: number | null
          active_leads: number | null
          conversion_rate: number | null
          full_name: string | null
          lost_leads: number | null
          user_id: string | null
          won_leads: number | null
        }
        Relationships: []
      }
      v_sam23_organization_commercial_summary: {
        Row: {
          confirmed_payment_amount: number | null
          contract_count: number | null
          document_count: number | null
          organization_id: string | null
          project_count: number | null
          quotation_count: number | null
          task_count: number | null
        }
        Insert: {
          confirmed_payment_amount?: never
          contract_count?: never
          document_count?: never
          organization_id?: string | null
          project_count?: never
          quotation_count?: never
          task_count?: never
        }
        Update: {
          confirmed_payment_amount?: never
          contract_count?: never
          document_count?: never
          organization_id?: string | null
          project_count?: never
          quotation_count?: never
          task_count?: never
        }
        Relationships: []
      }
      v_stagnant_leads: {
        Row: {
          assigned_to: string | null
          created_at: string | null
          customer_name: string | null
          days_inactive: number | null
          id: string | null
          last_activity_at: string | null
          sales_name: string | null
          stage: string | null
        }
        Relationships: [
          {
            foreignKeyName: "fk_leads_assigned_to"
            columns: ["assigned_to"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fk_leads_assigned_to"
            columns: ["assigned_to"]
            isOneToOne: false
            referencedRelation: "sales_performance"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fk_leads_assigned_to"
            columns: ["assigned_to"]
            isOneToOne: false
            referencedRelation: "v_sales_personal_stats"
            referencedColumns: ["user_id"]
          },
          {
            foreignKeyName: "leads_assigned_to_fkey"
            columns: ["assigned_to"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "leads_assigned_to_fkey"
            columns: ["assigned_to"]
            isOneToOne: false
            referencedRelation: "sales_performance"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "leads_assigned_to_fkey"
            columns: ["assigned_to"]
            isOneToOne: false
            referencedRelation: "v_sales_personal_stats"
            referencedColumns: ["user_id"]
          },
        ]
      }
    }
    Functions: {
      v4_dispatch_agent_gateway_command: {
        Args: {
          p_access_mode: string; p_actor_user_id: string; p_channel: string; p_command_key: string
          p_correlation_id: string; p_credential_expires_at: string; p_credential_fingerprint: string
          p_event_signature: string; p_idempotency_key: string; p_organization_id: string; p_payload: Json
          p_payload_sha256: string; p_required_capability: string | null; p_risk_level: string
        }
        Returns: Json
      }
      v4_approve_commercial_action: {
        Args: { p_event_key: string; p_request_id: string }
        Returns: Json
      }
      v4_commercial_payload_hash: { Args: { p_payload: Json }; Returns: string }
      v4_execute_commercial_action: {
        Args: { p_execution_key: string; p_request_id: string }
        Returns: Json
      }
      v4_get_commercial_summary: {
        Args: { p_organization_id: string }
        Returns: Json
      }
      v4_reconcile_commercial_control_plane: {
        Args: { p_organization_id: string }
        Returns: Json
      }
      v4_record_commercial_usage: {
        Args: {
          p_idempotency_key: string
          p_metadata?: Json
          p_metric_key: string
          p_organization_id: string
          p_period_end: string
          p_period_start: string
          p_quantity: number
          p_source: string
        }
        Returns: Json
      }
      v4_request_commercial_action: {
        Args: {
          p_action_key: string
          p_organization_id: string
          p_payload: Json
          p_request_key: string
        }
        Returns: Json
      }
      allocate_payment: {
        Args: {
          p_allocated_by: string
          p_allocations: Json
          p_payment_id: string
        }
        Returns: Json
      }
      approve_contract: {
        Args: {
          p_action: string
          p_approver_id: string
          p_contract_id: string
          p_notes?: string
        }
        Returns: Json
      }
      assign_new_lead: {
        Args: {
          p_customer_name: string
          p_email?: string
          p_notes?: string
          p_phone?: string
          p_project_type?: string
          p_quality?: string
          p_source?: string
        }
        Returns: string
      }
      auto_assign_lead: { Args: never; Returns: string }
      complete_organization_customer_exit: {
        Args: {
          p_actor_user_id: string
          p_approver_user_id: string
          p_backup_evidence_ref: string
          p_customer_confirmation_ref: string
          p_expected_export_sha256: string
          p_idempotency_key: string
          p_organization_id: string
          p_request_id: string
          p_retention_basis: string
        }
        Returns: Json
      }
      confirm_payment: {
        Args: { p_confirmer_id: string; p_payment_id: string }
        Returns: Json
      }
      create_business_event: {
        Args: {
          p_created_by: string
          p_entity_id: string
          p_entity_type: string
          p_event_data: Json
          p_event_type: string
          p_lead_id: string
        }
        Returns: undefined
      }
      create_product_for_organization: {
        Args: { p_organization_id: string; p_product: Json }
        Returns: Json
      }
      days_since_last_contact: { Args: { lead_id: string }; Returns: number }
      delete_lead_atomic: {
        Args: { p_idempotency_key: string; p_lead_id: string }
        Returns: Json
      }
      detect_stale_leads: { Args: { stale_days?: number }; Returns: number }
      end_support_session_atomic: {
        Args: {
          p_actor_user_id: string
          p_request_id: string
          p_support_session_id: string
        }
        Returns: boolean
      }
      export_organization_customer_data: {
        Args: {
          p_actor_user_id: string
          p_organization_id: string
          p_request_id: string
        }
        Returns: Json
      }
      generate_quote_no: { Args: { year_param: number }; Returns: string }
      get_my_role: { Args: never; Returns: string }
      get_team_activity: {
        Args: { p_date?: string }
        Returns: {
          actions_count: number
          first_login: string
          full_name: string
          last_active: string
          login_count: number
          pages_viewed: number
          role: string
          total_duration_seconds: number
          user_id: string
        }[]
      }
      import_products_for_organization: {
        Args: { p_organization_id: string; p_products: Json }
        Returns: Json
      }
      initialize_organization: {
        Args: {
          p_billable_seat_limit: number
          p_idempotency_key: string
          p_industry_key: string
          p_name: string
          p_owner_user_id: string
          p_plan_key: string
          p_slug: string
        }
        Returns: Json
      }
      log_activity: {
        Args: {
          p_action: string
          p_details?: Json
          p_duration_seconds?: number
          p_entity_id?: string
          p_entity_type?: string
          p_page_path?: string
        }
        Returns: string
      }
      milestone_order: { Args: { key: string }; Returns: number }
      next_quote_no: { Args: never; Returns: string }
      organization_billable_seat_count: {
        Args: { p_organization_id: string }
        Returns: number
      }
      organization_customer_snapshot: {
        Args: { p_organization_id: string }
        Returns: Json
      }
      organization_export_rows: {
        Args: { p_organization_id: string; p_query: string }
        Returns: Json
      }
      prepare_organization_customer_exit: {
        Args: {
          p_actor_user_id: string
          p_approver_user_id: string
          p_idempotency_key: string
          p_organization_id: string
          p_reason: string
          p_request_id: string
        }
        Returns: Json
      }
      product_capability_allowed: {
        Args: { p_capability_key: string; p_organization_id: string }
        Returns: boolean
      }
      product_organization_context: { Args: never; Returns: string }
      product_payload_is_valid: { Args: { p_product: Json }; Returns: boolean }
      provision_organization_member: {
        Args: {
          p_invited_by_membership_id: string
          p_organization_id: string
          p_profile_role: string
          p_request_id: string
          p_user_id: string
        }
        Returns: Json
      }
      reassign_lead: {
        Args: { p_lead_id: string; p_new_sales: string; p_reason?: string }
        Returns: boolean
      }
      reassign_lead_atomic: {
        Args: {
          p_expected_updated_at: string
          p_idempotency_key: string
          p_lead_id: string
          p_new_assignee: string
          p_reason?: string
        }
        Returns: Json
      }
      recomplete_lead_milestone: {
        Args: { p_lead_id: string; p_milestone_key: string; p_notes: string }
        Returns: Json
      }
      record_lead_contact_atomic: {
        Args: {
          p_contact_fingerprint: string
          p_contact_method: string
          p_contact_result: string
          p_contact_time: string
          p_idempotency_key: string
          p_lead_id: string
          p_summary: string
        }
        Returns: Json
      }
      record_lead_note_atomic: {
        Args: { p_idempotency_key: string; p_lead_id: string; p_note: string }
        Returns: Json
      }
      reopen_lead_milestone: {
        Args: { p_lead_id: string; p_milestone_key: string; p_reason: string }
        Returns: Json
      }
      requested_organization_id: { Args: never; Returns: string }
      security_definer_rpc_allowlist_gate: { Args: never; Returns: Json }
      start_support_session_atomic: {
        Args: {
          p_actor_user_id: string
          p_approver_user_id: string
          p_expires_at: string
          p_organization_id: string
          p_reason: string
          p_request_id: string
          p_scope: Json
          p_ticket_ref: string
        }
        Returns: string
      }
      transition_lead_stage: {
        Args: {
          p_expected_stage: string
          p_idempotency_key: string
          p_lead_id: string
          p_next_stage: string
          p_note: string
        }
        Returns: Json
      }
      v4_accept_organization_membership: {
        Args: {
          p_membership_id: string
          p_organization_id: string
          p_request_id: string
        }
        Returns: Json
      }
      v4_claim_shared_jobs: {
        Args: { p_batch_size: number; p_lease_seconds: number; p_worker_id: string }
        Returns: Json
      }
      v4_claim_shared_outbox: {
        Args: { p_batch_size: number; p_lease_seconds: number; p_worker_id: string }
        Returns: Json
      }
      v4_complete_shared_job: {
        Args: {
          p_error_code: string | null
          p_job_id: string
          p_result_counts: Json
          p_result_sha256: string | null
          p_succeeded: boolean
          p_worker_id: string
        }
        Returns: Json
      }
      v4_complete_shared_outbox: {
        Args: {
          p_error_code: string | null
          p_outbox_id: string
          p_succeeded: boolean
          p_worker_id: string
        }
        Returns: Json
      }
      v4_create_shared_job: {
        Args: {
          p_idempotency_key: string
          p_input_file_id: string | null
          p_kind: string
          p_organization_id: string
          p_parameters: Json
        }
        Returns: Json
      }
      v4_create_shared_work_item: {
        Args: {
          p_assignee_user_id: string | null
          p_details: string | null
          p_due_at: string | null
          p_idempotency_key: string
          p_organization_id: string
          p_priority: string
          p_source_id: string | null
          p_source_type: string | null
          p_title: string
        }
        Returns: Json
      }
      v4_decide_shared_approval: {
        Args: {
          p_approval_id: string
          p_decision: string
          p_organization_id: string
          p_reason_code: string
        }
        Returns: Json
      }
      v4_mark_shared_notification_read: {
        Args: { p_notification_id: string; p_organization_id: string }
        Returns: Json
      }
      v4_requeue_shared_dead_letter: {
        Args: {
          p_actor_user_id: string
          p_organization_id: string
          p_queue_kind: string
          p_record_id: string
          p_request_id: string
        }
        Returns: Json
      }
      v4_request_shared_approval: {
        Args: {
          p_action_key: string
          p_expires_at: string
          p_idempotency_key: string
          p_organization_id: string
          p_payload: Json
          p_resource_id: string | null
          p_resource_type: string
        }
        Returns: Json
      }
      v4_shared_payload_is_safe: {
        Args: { p_depth?: number; p_payload: Json }
        Returns: boolean
      }
      v4_transition_shared_work_item: {
        Args: { p_organization_id: string; p_status: string; p_work_item_id: string }
        Returns: Json
      }
      v4_actor_has_capability: {
        Args: {
          p_access_mode?: string
          p_actor_user_id: string
          p_capability_key: string
          p_organization_id: string
        }
        Returns: boolean
      }
      v4_actor_has_organization_role: {
        Args: {
          p_actor_user_id: string
          p_organization_id: string
          p_role_keys: string[]
        }
        Returns: boolean
      }
      v4_allocate_payment_for_organization: {
        Args: {
          p_allocations: Json
          p_organization_id: string
          p_payment_id: string
          p_request_id: string
        }
        Returns: Json
      }
      v4_approve_platform_action: {
        Args: { p_approval_request_id: string; p_request_id: string }
        Returns: Json
      }
      v4_assert_tenant_closure_rollback_safe: {
        Args: never
        Returns: undefined
      }
      v4_cancel_tenant_file_upload: {
        Args: {
          p_file_id: string
          p_organization_id: string
          p_reason: string
          p_request_id: string
        }
        Returns: Json
      }
      v4_claim_tenant_file_deletions: {
        Args: { p_lease_seconds: number; p_limit: number; p_worker_id: string }
        Returns: Json
      }
      v4_complete_organization_customer_exit: {
        Args: {
          p_actor_user_id: string
          p_approver_user_id: string
          p_backup_evidence_ref: string
          p_customer_confirmation_ref: string
          p_expected_export_sha256: string
          p_idempotency_key: string
          p_organization_id: string
          p_request_id: string
          p_retention_basis: string
        }
        Returns: Json
      }
      v4_complete_tenant_file_deletion: {
        Args: {
          p_file_id: string
          p_organization_id: string
          p_provider_evidence: string
          p_queue_id: string
          p_request_id: string
          p_worker_id: string
        }
        Returns: Json
      }
      v4_confirm_payment_for_organization: {
        Args: {
          p_organization_id: string
          p_payment_id: string
          p_request_id: string
        }
        Returns: Json
      }
      v4_convert_quotation_for_organization: {
        Args: {
          p_organization_id: string
          p_payload: Json
          p_quotation_id: string
          p_request_id: string
        }
        Returns: Json
      }
      v4_create_contract_for_organization: {
        Args: {
          p_organization_id: string
          p_payload: Json
          p_request_id: string
        }
        Returns: Json
      }
      v4_execute_approved_platform_action: {
        Args: { p_approval_request_id: string; p_consumption_key: string }
        Returns: Json
      }
      v4_expire_support_sessions: {
        Args: { p_request_id: string }
        Returns: Json
      }
      v4_expire_tenant_file_uploads: {
        Args: {
          p_limit: number
          p_organization_id: string
          p_request_id: string
        }
        Returns: Json
      }
      v4_export_organization_customer_data: {
        Args: {
          p_actor_user_id: string
          p_organization_id: string
          p_request_id: string
        }
        Returns: Json
      }
      v4_finalize_tenant_file: {
        Args: {
          p_actor_user_id: string
          p_file_id: string
          p_organization_id: string
          p_provider_checksum_crc64ecma: string
          p_provider_etag: string
          p_request_id: string
          p_verified_content_md5: string
          p_verified_content_type: string
          p_verified_size_bytes: number
        }
        Returns: Json
      }
      v4_import_leads_for_organization: {
        Args: {
          p_import_batch_id: string
          p_organization_id: string
          p_request_id: string
          p_rows: Json
        }
        Returns: Json
      }
      v4_invite_organization_member: {
        Args: {
          p_organization_id: string
          p_request_id: string
          p_role_key: string
          p_user_id: string
        }
        Returns: Json
      }
      v4_organization_customer_snapshot: {
        Args: { p_organization_id: string }
        Returns: Json
      }
      v4_platform_payload_hash: { Args: { p_payload: Json }; Returns: string }
      v4_prepare_organization_customer_exit: {
        Args: {
          p_actor_user_id: string
          p_approver_user_id: string
          p_idempotency_key: string
          p_organization_id: string
          p_reason: string
          p_request_id: string
        }
        Returns: Json
      }
      v4_process_no_answer_worker: {
        Args: { p_organization_id: string; p_request_id: string }
        Returns: Json
      }
      v4_provision_organization: {
        Args: {
          p_actor_user_id: string
          p_approver_user_id: string
          p_billable_seat_limit: number
          p_idempotency_key: string
          p_industry_key: string
          p_name: string
          p_owner_user_id: string
          p_plan_key: string
          p_request_id: string
          p_slug: string
        }
        Returns: Json
      }
      v4_register_tenant_file: {
        Args: {
          p_content_type: string
          p_expected_content_md5: string
          p_expected_size_bytes: number
          p_filename: string
          p_organization_id: string
          p_record_id: string
          p_record_type: string
          p_request_id: string
          p_version: string
        }
        Returns: Json
      }
      v4_replace_kpi_targets: {
        Args: {
          p_organization_id: string
          p_period: string
          p_request_id: string
          p_targets: Json
        }
        Returns: Json
      }
      v4_request_platform_action_approval: {
        Args: {
          p_action_key: string
          p_payload: Json
          p_request_id: string
          p_target_key: string
        }
        Returns: Json
      }
      v4_retry_tenant_file_deletion: {
        Args: {
          p_error: string
          p_queue_id: string
          p_request_id: string
          p_worker_id: string
        }
        Returns: Json
      }
      v4_transition_organization_lifecycle: {
        Args: {
          p_action: string
          p_actor_user_id: string
          p_approver_user_id: string
          p_organization_id: string
          p_reason: string
          p_request_id: string
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
