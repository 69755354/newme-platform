export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
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
            referencedRelation: "customer_summary"
            referencedColumns: ["customer_id"]
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
          page_path?: string | null
          session_id?: string | null
          tenant_id?: string
          user_agent?: string | null
          user_id?: string
        }
        Relationships: [
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
          source?: string | null
          spend_date?: string | null
        }
        Relationships: []
      }
      audit_log_archived_20260615: {
        Row: {
          created_at: string | null
          event_type: string
          id: number
          ip_address: string | null
          metadata: Json | null
          user_id: string
        }
        Insert: {
          created_at?: string | null
          event_type: string
          id?: never
          ip_address?: string | null
          metadata?: Json | null
          user_id: string
        }
        Update: {
          created_at?: string | null
          event_type?: string
          id?: never
          ip_address?: string | null
          metadata?: Json | null
          user_id?: string
        }
        Relationships: []
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
          target_id?: string | null
          target_type?: string | null
          user_agent?: string | null
        }
        Relationships: []
      }
      business_events: {
        Row: {
          created_at: string | null
          description: string | null
          event_data: Json | null
          event_type: string
          id: string
          lead_id: string | null
          user_id: string | null
        }
        Insert: {
          created_at?: string | null
          description?: string | null
          event_data?: Json | null
          event_type: string
          id?: string
          lead_id?: string | null
          user_id?: string | null
        }
        Update: {
          created_at?: string | null
          description?: string | null
          event_data?: Json | null
          event_type?: string
          id?: string
          lead_id?: string | null
          user_id?: string | null
        }
        Relationships: [
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
        ]
      }
      contract_approvals: {
        Row: {
          approver_id: string | null
          contract_id: string
          created_at: string | null
          id: string
          notes: Json | null
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
          snapshot_date: string
          total_value: number | null
        }
        Insert: {
          created_at?: string
          current_milestone: string
          id?: string
          lead_count?: number
          snapshot_date?: string
          total_value?: number | null
        }
        Update: {
          created_at?: string
          current_milestone?: string
          id?: string
          lead_count?: number
          snapshot_date?: string
          total_value?: number | null
        }
        Relationships: []
      }
      customers: {
        Row: {
          address: string | null
          archive_reason: string | null
          assigned_sales_id: string | null
          created_at: string | null
          email: string | null
          id: string
          last_activity_at: string | null
          lead_id: string | null
          name: string
          notes: string | null
          phone: string | null
          poor_reason: string | null
          tags: string[] | null
          total_contract_amount: number | null
          unified_profile: boolean | null
          whatsapp: string | null
        }
        Insert: {
          address?: string | null
          archive_reason?: string | null
          assigned_sales_id?: string | null
          created_at?: string | null
          email?: string | null
          id?: string
          last_activity_at?: string | null
          lead_id?: string | null
          name: string
          notes?: string | null
          phone?: string | null
          poor_reason?: string | null
          tags?: string[] | null
          total_contract_amount?: number | null
          unified_profile?: boolean | null
          whatsapp?: string | null
        }
        Update: {
          address?: string | null
          archive_reason?: string | null
          assigned_sales_id?: string | null
          created_at?: string | null
          email?: string | null
          id?: string
          last_activity_at?: string | null
          lead_id?: string | null
          name?: string
          notes?: string | null
          phone?: string | null
          poor_reason?: string | null
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
        ]
      }
      kpi_targets: {
        Row: {
          actual_amount: number
          assigned_to: string | null
          created_at: string | null
          id: string
          notes: string | null
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
        }
        Insert: {
          completed_at?: string | null
          completed_by?: string | null
          created_at?: string
          id?: string
          lead_id: string
          milestone_key: string
          notes?: string | null
        }
        Update: {
          completed_at?: string | null
          completed_by?: string | null
          created_at?: string
          id?: string
          lead_id?: string
          milestone_key?: string
          notes?: string | null
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
          budget_range: string | null
          campaign_id: string | null
          campaign_name: string | null
          circuit_diagrams: boolean | null
          competitor: string | null
          confidence_pct: number | null
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
          devices_json: Json | null
          disqualified_candidate: boolean | null
          email: string | null
          emirate: string | null
          expected_close_date: string | null
          expected_sign_date: string | null
          fbclid: string | null
          final_status: string | null
          first_touch_at: string | null
          followup_count: number | null
          forecast_category: string | null
          form_id: string | null
          form_name: string | null
          gclid: string | null
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
          next_action: string | null
          next_followup_date: string | null
          no_answer_flag: boolean
          not_interested_reason: string | null
          notes: string | null
          owner: string | null
          phase_pct: number | null
          phone: string | null
          poor_reason: string | null
          project_name: string | null
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
          rejection_detail: string | null
          reminder_24h_sent: boolean | null
          reminder_48h_sent: boolean | null
          rep_name: string | null
          sales_manager: string | null
          sales_manager_review: boolean | null
          sales_phase: string | null
          service_needs: string[] | null
          smart_requirements: Json | null
          source: string
          source_channel: string | null
          source_platform: string | null
          stage: string | null
          stage_changed_at: string | null
          sub_phase: string | null
          system_preference: string | null
          transfer_candidate: boolean | null
          updated_at: string | null
          utm_campaign: string | null
          utm_content: string | null
          utm_medium: string | null
          utm_source: string | null
          utm_term: string | null
          visit_status: string | null
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
          budget_range?: string | null
          campaign_id?: string | null
          campaign_name?: string | null
          circuit_diagrams?: boolean | null
          competitor?: string | null
          confidence_pct?: number | null
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
          devices_json?: Json | null
          disqualified_candidate?: boolean | null
          email?: string | null
          emirate?: string | null
          expected_close_date?: string | null
          expected_sign_date?: string | null
          fbclid?: string | null
          final_status?: string | null
          first_touch_at?: string | null
          followup_count?: number | null
          forecast_category?: string | null
          form_id?: string | null
          form_name?: string | null
          gclid?: string | null
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
          next_action?: string | null
          next_followup_date?: string | null
          no_answer_flag?: boolean
          not_interested_reason?: string | null
          notes?: string | null
          owner?: string | null
          phase_pct?: number | null
          phone?: string | null
          poor_reason?: string | null
          project_name?: string | null
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
          rejection_detail?: string | null
          reminder_24h_sent?: boolean | null
          reminder_48h_sent?: boolean | null
          rep_name?: string | null
          sales_manager?: string | null
          sales_manager_review?: boolean | null
          sales_phase?: string | null
          service_needs?: string[] | null
          smart_requirements?: Json | null
          source: string
          source_channel?: string | null
          source_platform?: string | null
          stage?: string | null
          stage_changed_at?: string | null
          sub_phase?: string | null
          system_preference?: string | null
          transfer_candidate?: boolean | null
          updated_at?: string | null
          utm_campaign?: string | null
          utm_content?: string | null
          utm_medium?: string | null
          utm_source?: string | null
          utm_term?: string | null
          visit_status?: string | null
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
          budget_range?: string | null
          campaign_id?: string | null
          campaign_name?: string | null
          circuit_diagrams?: boolean | null
          competitor?: string | null
          confidence_pct?: number | null
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
          devices_json?: Json | null
          disqualified_candidate?: boolean | null
          email?: string | null
          emirate?: string | null
          expected_close_date?: string | null
          expected_sign_date?: string | null
          fbclid?: string | null
          final_status?: string | null
          first_touch_at?: string | null
          followup_count?: number | null
          forecast_category?: string | null
          form_id?: string | null
          form_name?: string | null
          gclid?: string | null
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
          next_action?: string | null
          next_followup_date?: string | null
          no_answer_flag?: boolean
          not_interested_reason?: string | null
          notes?: string | null
          owner?: string | null
          phase_pct?: number | null
          phone?: string | null
          poor_reason?: string | null
          project_name?: string | null
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
          rejection_detail?: string | null
          reminder_24h_sent?: boolean | null
          reminder_48h_sent?: boolean | null
          rep_name?: string | null
          sales_manager?: string | null
          sales_manager_review?: boolean | null
          sales_phase?: string | null
          service_needs?: string[] | null
          smart_requirements?: Json | null
          source?: string
          source_channel?: string | null
          source_platform?: string | null
          stage?: string | null
          stage_changed_at?: string | null
          sub_phase?: string | null
          system_preference?: string | null
          transfer_candidate?: boolean | null
          updated_at?: string | null
          utm_campaign?: string | null
          utm_content?: string | null
          utm_medium?: string | null
          utm_source?: string | null
          utm_term?: string | null
          visit_status?: string | null
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
            referencedRelation: "customer_summary"
            referencedColumns: ["customer_id"]
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
      marketing_campaigns: {
        Row: {
          attribution_window: string | null
          budget_type: string | null
          campaign_name: string
          clicks: number | null
          conversion_metric: string | null
          conversions: number | null
          cost_per_conversion_aed: number | null
          cpc_aed: number | null
          cpm_aed: number | null
          created_at: string | null
          ctr_pct: number | null
          daily_budget: number | null
          end_date: string | null
          frequency: number | null
          id: string
          impressions: number | null
          platform: string | null
          reach: number | null
          start_date: string | null
          status: string | null
          total_spent_aed: number | null
        }
        Insert: {
          attribution_window?: string | null
          budget_type?: string | null
          campaign_name: string
          clicks?: number | null
          conversion_metric?: string | null
          conversions?: number | null
          cost_per_conversion_aed?: number | null
          cpc_aed?: number | null
          cpm_aed?: number | null
          created_at?: string | null
          ctr_pct?: number | null
          daily_budget?: number | null
          end_date?: string | null
          frequency?: number | null
          id?: string
          impressions?: number | null
          platform?: string | null
          reach?: number | null
          start_date?: string | null
          status?: string | null
          total_spent_aed?: number | null
        }
        Update: {
          attribution_window?: string | null
          budget_type?: string | null
          campaign_name?: string
          clicks?: number | null
          conversion_metric?: string | null
          conversions?: number | null
          cost_per_conversion_aed?: number | null
          cpc_aed?: number | null
          cpm_aed?: number | null
          created_at?: string | null
          ctr_pct?: number | null
          daily_budget?: number | null
          end_date?: string | null
          frequency?: number | null
          id?: string
          impressions?: number | null
          platform?: string | null
          reach?: number | null
          start_date?: string | null
          status?: string | null
          total_spent_aed?: number | null
        }
        Relationships: []
      }
      meta_tokens: {
        Row: {
          access_token: string
          created_at: string | null
          expires_at: string | null
          id: number
        }
        Insert: {
          access_token: string
          created_at?: string | null
          expires_at?: string | null
          id?: number
        }
        Update: {
          access_token?: string
          created_at?: string | null
          expires_at?: string | null
          id?: number
        }
        Relationships: []
      }
      notifications: {
        Row: {
          body: string | null
          created_at: string | null
          id: string
          is_read: boolean | null
          related_id: string | null
          related_type: string | null
          title: string
          type: string
          user_id: string
        }
        Insert: {
          body?: string | null
          created_at?: string | null
          id?: string
          is_read?: boolean | null
          related_id?: string | null
          related_type?: string | null
          title: string
          type: string
          user_id: string
        }
        Update: {
          body?: string | null
          created_at?: string | null
          id?: string
          is_read?: boolean | null
          related_id?: string | null
          related_type?: string | null
          title?: string
          type?: string
          user_id?: string
        }
        Relationships: [
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
      payment_allocations: {
        Row: {
          allocated_by: string | null
          amount_allocated: number
          created_at: string | null
          id: string
          payment_id: string
          plan_id: string
          tenant_id: string
        }
        Insert: {
          allocated_by?: string | null
          amount_allocated: number
          created_at?: string | null
          id?: string
          payment_id: string
          plan_id: string
          tenant_id?: string
        }
        Update: {
          allocated_by?: string | null
          amount_allocated?: number
          created_at?: string | null
          id?: string
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
      products: {
        Row: {
          brand: string | null
          category: string | null
          created_at: string | null
          description: string | null
          id: string
          is_active: boolean | null
          name: string
          sku: string
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
          sku: string
          unit?: string | null
          unit_price: number
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
          sku?: string
          unit?: string | null
          unit_price?: number
          updated_at?: string | null
        }
        Relationships: []
      }
      profiles: {
        Row: {
          avatar_url: string | null
          created_at: string | null
          email: string | null
          force_password_change: boolean | null
          full_name: string | null
          id: string
          is_active: boolean | null
          joined_at: string | null
          last_active_at: string | null
          manager_id: string | null
          password_changed_at: string | null
          password_hint: string | null
          phone: string | null
          role: string | null
          updated_at: string | null
        }
        Insert: {
          avatar_url?: string | null
          created_at?: string | null
          email?: string | null
          force_password_change?: boolean | null
          full_name?: string | null
          id: string
          is_active?: boolean | null
          joined_at?: string | null
          last_active_at?: string | null
          manager_id?: string | null
          password_changed_at?: string | null
          password_hint?: string | null
          phone?: string | null
          role?: string | null
          updated_at?: string | null
        }
        Update: {
          avatar_url?: string | null
          created_at?: string | null
          email?: string | null
          force_password_change?: boolean | null
          full_name?: string | null
          id?: string
          is_active?: boolean | null
          joined_at?: string | null
          last_active_at?: string | null
          manager_id?: string | null
          password_changed_at?: string | null
          password_hint?: string | null
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
            referencedRelation: "customer_summary"
            referencedColumns: ["customer_id"]
          },
          {
            foreignKeyName: "projects_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
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
          contract_id: string | null
          created_at: string | null
          created_by: string | null
          currency: string | null
          customer_id: string | null
          delivery_terms: string | null
          sent_at: string | null
          accepted_at: string | null
          rejected_at: string | null
          devices_json: Json | null
          discount_amount: number | null
          discount_rate: number | null
          id: string
          internal_notes: string | null
          lead_id: string
          notes: string | null
          payment_terms: string | null
          pdf_url: string | null
          ppt_url: string | null
          quotation_type: string
          quote_no: string
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
          contract_id?: string | null
          created_at?: string | null
          created_by?: string | null
          currency?: string | null
          customer_id?: string | null
          delivery_terms?: string | null
          sent_at?: string | null
          accepted_at?: string | null
          rejected_at?: string | null
          devices_json?: Json | null
          discount_amount?: number | null
          discount_rate?: number | null
          id?: string
          internal_notes?: string | null
          lead_id: string
          notes?: string | null
          payment_terms?: string | null
          pdf_url?: string | null
          ppt_url?: string | null
          quotation_type?: string
          quote_no: string
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
          contract_id?: string | null
          created_at?: string | null
          created_by?: string | null
          currency?: string | null
          customer_id?: string | null
          delivery_terms?: string | null
          sent_at?: string | null
          accepted_at?: string | null
          rejected_at?: string | null
          devices_json?: Json | null
          discount_amount?: number | null
          discount_rate?: number | null
          id?: string
          internal_notes?: string | null
          lead_id?: string
          notes?: string | null
          payment_terms?: string | null
          pdf_url?: string | null
          ppt_url?: string | null
          quotation_type?: string
          quote_no?: string
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
      tasks: {
        Row: {
          assignee_id: string | null
          completed_at: string | null
          created_at: string
          due_at: string
          id: string
          lead_id: string
          source: string | null
          status: string
          title: string
        }
        Insert: {
          assignee_id?: string | null
          completed_at?: string | null
          created_at?: string
          due_at: string
          id?: string
          lead_id: string
          source?: string | null
          status?: string
          title: string
        }
        Update: {
          assignee_id?: string | null
          completed_at?: string | null
          created_at?: string
          due_at?: string
          id?: string
          lead_id?: string
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
        ]
      }
      transfer_history: {
        Row: {
          created_at: string | null
          from_user_id: string | null
          id: string
          lead_id: string
          notes: string | null
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
          pages_viewed?: number | null
          session_date?: string
          tenant_id?: string
          total_duration_seconds?: number | null
          updated_at?: string | null
          user_id?: string
        }
        Relationships: [
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
    }
    Views: {
      customer_summary: {
        Row: {
          assigned_sales_id: string | null
          customer_id: string | null
          customer_name: string | null
          total_contract_amount: number | null
          total_contracts: number | null
          total_leads: number | null
          total_paid: number | null
          won_leads: number | null
        }
        Insert: {
          assigned_sales_id?: string | null
          customer_id?: string | null
          customer_name?: string | null
          total_contract_amount?: never
          total_contracts?: never
          total_leads?: never
          total_paid?: never
          won_leads?: never
        }
        Update: {
          assigned_sales_id?: string | null
          customer_id?: string | null
          customer_name?: string | null
          total_contract_amount?: never
          total_contracts?: never
          total_leads?: never
          total_paid?: never
          won_leads?: never
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
        ]
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
      revenue_forecast: {
        Row: {
          deal_count: number | null
          funnel_stage: string | null
          total_value: number | null
          weighted_value: number | null
        }
        Relationships: []
      }
      sales_performance: {
        Row: {
          conversion_rate: number | null
          full_name: string | null
          id: string | null
          lost: number | null
          new_leads: number | null
          quoted: number | null
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
      v_unified_timeline: {
        Row: {
          created_at: string | null
          description: string | null
          event_type: string | null
          id: string | null
          lead_id: string | null
          source: string | null
          user_id: string | null
        }
        Relationships: []
      }
    }
    Functions: {
      allocate_payment: {
        Args: {
          p_allocated_by: string
          p_allocations: Json
          p_payment_id: string
        }
        Returns: Json
      }
      apply_standard_rls: { Args: { table_name: string }; Returns: undefined }
      approve_contract: {
        Args: {
          p_action: string
          p_approver_id: string
          p_contract_id: string
          p_notes?: string
        }
        Returns: Json
      }
      confirm_payment: {
        Args: { p_confirmer_id: string; p_payment_id: string }
        Returns: Json
      }
      days_since_last_contact: { Args: { lead_id: string }; Returns: number }
      detect_stale_leads: { Args: { stale_days?: number }; Returns: number }
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
      log_activity:
        | {
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
        | {
            Args: {
              p_content: string
              p_lead_id: string
              p_type: string
              p_user_id?: string
            }
            Returns: string
          }
      milestone_order: { Args: { milestone: string }; Returns: number }
      next_quote_no: { Args: never; Returns: string }
      reassign_lead: {
        Args: { p_lead_id: string; p_new_sales: string; p_reason?: string }
        Returns: boolean
      }
      recomplete_lead_milestone: {
        Args: { p_lead_id: string; p_milestone_key: string; p_notes: string }
        Returns: Json
      }
      reopen_lead_milestone: {
        Args: { p_lead_id: string; p_milestone_key: string; p_reason: string }
        Returns: Json
      }
      transition_lead_stage: {
        Args: {
          p_expected_stage: string
          p_lead_id: string
          p_next_stage: string
          p_note?: string
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
