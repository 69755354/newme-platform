import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import type { NotificationDraft, NotificationType } from "@/lib/notifications";

type NotificationDatabase = SupabaseClient<Database>;

export interface NotificationActor {
  id: string;
  role: string;
  fullName: string;
}

export interface NotificationEventInput extends Record<string, unknown> {
  type: NotificationType;
}

export class NotificationDispatchError extends Error {
  readonly status: 400 | 403 | 404 | 409 | 413 | 503;
  readonly code: string;

  constructor(status: NotificationDispatchError["status"], code: string) {
    super(code);
    this.name = "NotificationDispatchError";
    this.status = status;
    this.code = code;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MANAGEMENT = ["admin", "boss"];
const OPERATIONS = ["admin", "boss", "operator"];
const MONEY = ["admin", "boss", "finance"];

const PRESENTATION_OR_RECIPIENT_FIELDS = [
  "title",
  "body",
  "related_id",
  "related_type",
  "user_id",
  "target_user_id",
  "recipient_id",
  "recipient_ids",
] as const;

function requiredUuid(input: NotificationEventInput, field: string): string {
  const value = input[field];
  if (typeof value !== "string" || !UUID.test(value)) {
    throw new NotificationDispatchError(400, `${field}_required`);
  }
  return value;
}

function requiredText(input: NotificationEventInput, field: string, pattern?: RegExp): string {
  const value = input[field];
  if (typeof value !== "string" || value.trim() === "" || (pattern && !pattern.test(value))) {
    throw new NotificationDispatchError(400, `${field}_required`);
  }
  return value;
}

function assertNoClientPresentation(input: NotificationEventInput): void {
  for (const field of PRESENTATION_OR_RECIPIENT_FIELDS) {
    if (Object.hasOwn(input, field)) {
      throw new NotificationDispatchError(400, "client_notification_content_forbidden");
    }
  }
}

function allowRole(actor: NotificationActor, roles: string[]): boolean {
  return roles.includes(actor.role);
}

function assertAllowed(condition: boolean): void {
  if (!condition) throw new NotificationDispatchError(403, "notification_forbidden");
}

function text(value: string | null | undefined, fallback: string): string {
  const normalized = value?.trim();
  return normalized ? normalized : fallback;
}

function money(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value)
    ? value.toLocaleString("en-US", { maximumFractionDigits: 2 })
    : "N/A";
}

function unique(values: Array<string | null | undefined>, exclude?: string): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value) && value !== exclude))];
}

async function activeProfilesByRole(db: NotificationDatabase, roles: string[]): Promise<string[]> {
  const { data, error } = await db
    .from("profiles")
    .select("id")
    .eq("is_active", true)
    .in("role", roles);
  if (error) throw new NotificationDispatchError(503, "notification_recipient_lookup_failed");
  return (data ?? []).map((profile) => profile.id);
}

async function activeRecipients(
  db: NotificationDatabase,
  candidates: Array<string | null | undefined>,
  exclude?: string,
): Promise<string[]> {
  const ids = unique(candidates, exclude);
  if (ids.length === 0) return [];
  const { data, error } = await db
    .from("profiles")
    .select("id")
    .eq("is_active", true)
    .in("id", ids);
  if (error) throw new NotificationDispatchError(503, "notification_recipient_lookup_failed");
  return (data ?? []).map((profile) => profile.id);
}

function rows(
  recipients: string[],
  type: NotificationType,
  title: string,
  body: string,
  relatedId: string,
  relatedType: string,
  eventKey?: string,
): NotificationDraft[] {
  if (recipients.length > 64) {
    throw new NotificationDispatchError(413, "notification_recipient_limit_exceeded");
  }
  return recipients.map((userId) => ({ userId, type, title, body, relatedId, relatedType, eventKey }));
}

function notFound(error: { code?: string } | null, data: unknown, entity: string): void {
  if (!data && (error?.code === "PGRST116" || error === null)) {
    throw new NotificationDispatchError(404, `${entity}_not_found`);
  }
  if (error) throw new NotificationDispatchError(503, `${entity}_lookup_failed`);
}

/**
 * Resolve one user-requested notification from persisted business facts.
 * Request fields identify an entity; they never supply presentation or recipients.
 */
export async function deriveNotificationDispatch(options: {
  db: NotificationDatabase;
  actor: NotificationActor;
  input: NotificationEventInput;
  now?: Date;
}): Promise<NotificationDraft[]> {
  const { db, actor, input } = options;
  const now = options.now ?? new Date();
  assertNoClientPresentation(input);

  switch (input.type) {
    case "lead_created": {
      const leadId = requiredUuid(input, "lead_id");
      const result = await db.from("leads")
        .select("id, customer_name, assigned_to, created_by")
        .eq("id", leadId)
        .maybeSingle();
      notFound(result.error, result.data, "lead");
      const lead = result.data!;
      assertAllowed(allowRole(actor, OPERATIONS) || lead.created_by === actor.id || lead.assigned_to === actor.id);
      const managers = await activeProfilesByRole(db, MANAGEMENT);
      const recipients = await activeRecipients(db, [...managers, lead.assigned_to], actor.id);
      const customer = text(lead.customer_name, "New Lead");
      return rows(
        recipients,
        input.type,
        `New lead: ${customer}`,
        `${actor.fullName} created lead "${customer}"`,
        lead.id,
        "lead",
        `lead_created:${lead.id}`,
      );
    }

    case "lead_assigned": {
      const leadId = requiredUuid(input, "lead_id");
      const result = await db.from("leads")
        .select("id, customer_name, assigned_to")
        .eq("id", leadId)
        .maybeSingle();
      notFound(result.error, result.data, "lead");
      const lead = result.data!;
      assertAllowed(allowRole(actor, OPERATIONS) || lead.assigned_to === actor.id);
      if (!lead.assigned_to) throw new NotificationDispatchError(409, "lead_is_unassigned");
      const recipients = await activeRecipients(db, [lead.assigned_to], actor.id);
      const customer = text(lead.customer_name, "Lead");
      return rows(recipients, input.type, `New lead assigned: ${customer}`, `Lead "${customer}" has been assigned to you`, lead.id, "lead");
    }

    case "lead_stage_change":
    case "lead_stage_changed": {
      const leadId = requiredUuid(input, "lead_id");
      const result = await db.from("leads")
        .select("id, customer_name, assigned_to, stage, stage_changed_at")
        .eq("id", leadId)
        .maybeSingle();
      notFound(result.error, result.data, "lead");
      const lead = result.data!;
      assertAllowed(allowRole(actor, OPERATIONS) || lead.assigned_to === actor.id);
      if (!lead.stage) throw new NotificationDispatchError(409, "lead_stage_missing");
      const candidates = [lead.assigned_to];
      if (["won", "lost", "negotiation", "quotation_submitted"].includes(lead.stage)) {
        candidates.push(...await activeProfilesByRole(db, MANAGEMENT));
      }
      const recipients = await activeRecipients(db, candidates, actor.id);
      const customer = text(lead.customer_name, "Lead");
      const changed = lead.stage_changed_at ? ` at ${lead.stage_changed_at}` : "";
      const eventKey = lead.stage_changed_at
        ? `lead_stage:${lead.id}:${lead.stage_changed_at}`
        : undefined;
      return rows(recipients, input.type, `${customer}: ${lead.stage}`, `${actor.fullName} moved "${customer}" to ${lead.stage}${changed}`, lead.id, "lead", eventKey);
    }

    case "quote_created": {
      const quoteId = requiredUuid(input, "quote_id");
      const result = await db.from("quotations")
        .select("id, quote_no, total_amount, created_by, lead_id")
        .eq("id", quoteId)
        .maybeSingle();
      notFound(result.error, result.data, "quotation");
      const quote = result.data!;
      assertAllowed(allowRole(actor, OPERATIONS) || quote.created_by === actor.id);
      const leadResult = await db.from("leads").select("assigned_to").eq("id", quote.lead_id).maybeSingle();
      if (leadResult.error) throw new NotificationDispatchError(503, "lead_lookup_failed");
      const managers = await activeProfilesByRole(db, MANAGEMENT);
      const recipients = await activeRecipients(db, [...managers, leadResult.data?.assigned_to], actor.id);
      return rows(
        recipients,
        input.type,
        `New quote: ${quote.quote_no}`,
        `${actor.fullName} created quotation ${quote.quote_no} for AED ${money(quote.total_amount)}`,
        quote.id,
        "quote",
        `quote_created:${quote.id}`,
      );
    }

    case "contract_created":
    case "contract_signed":
    case "contract_pending_approval": {
      const contractId = requiredUuid(input, "contract_id");
      const result = await db.from("contracts")
        .select("id, contract_no, contract_amount, created_by, sales_id, status")
        .eq("id", contractId)
        .maybeSingle();
      notFound(result.error, result.data, "contract");
      const contract = result.data!;
      assertAllowed(allowRole(actor, OPERATIONS) || contract.created_by === actor.id || contract.sales_id === actor.id);
      if (input.type === "contract_signed" && !["signed", "pending_admin", "pending_ceo", "approved", "active"].includes(contract.status)) {
        throw new NotificationDispatchError(409, "contract_is_not_signed");
      }
      const candidates: string[] = [contract.sales_id].filter((id): id is string => Boolean(id));
      let eventKey = `${input.type}:${contract.id}`;
      if (input.type === "contract_pending_approval") {
        if (contract.status === "pending_admin") candidates.push(...await activeProfilesByRole(db, ["admin", "operator"]));
        else if (contract.status === "pending_ceo") candidates.push(...await activeProfilesByRole(db, ["boss"]));
        else throw new NotificationDispatchError(409, "contract_is_not_pending_approval");
        const approvalResult = await db.from("contract_approvals")
          .select("id")
          .eq("contract_id", contract.id)
          .eq("status", "pending")
          .order("created_at", { ascending: true })
          .limit(1)
          .maybeSingle();
        notFound(approvalResult.error, approvalResult.data, "contract_approval");
        eventKey = `contract_pending_approval:${approvalResult.data!.id}`;
      } else {
        candidates.push(...await activeProfilesByRole(db, MANAGEMENT));
      }
      const recipients = await activeRecipients(db, candidates, actor.id);
      const label = input.type === "contract_pending_approval" ? "Contract pending approval" : input.type === "contract_signed" ? "Contract signed" : "New contract";
      return rows(recipients, input.type, `${label}: ${contract.contract_no}`, `${contract.contract_no} · AED ${money(contract.contract_amount)} · ${contract.status}`, contract.id, "contract", eventKey);
    }

    case "contract_approved":
    case "contract_rejected": {
      const contractId = requiredUuid(input, "contract_id");
      const contractResult = await db.from("contracts")
        .select("id, contract_no, sales_id")
        .eq("id", contractId)
        .maybeSingle();
      notFound(contractResult.error, contractResult.data, "contract");
      const approvalResult = await db.from("contract_approvals")
        .select("id, approver_id, status, step, reviewed_at")
        .eq("contract_id", contractId)
        .in("status", ["approved", "rejected"])
        .order("reviewed_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      notFound(approvalResult.error, approvalResult.data, "contract_approval");
      const approval = approvalResult.data!;
      const expectedStatus = input.type === "contract_approved" ? "approved" : "rejected";
      assertAllowed(approval.approver_id === actor.id && approval.status === expectedStatus);
      const managers = await activeProfilesByRole(db, MANAGEMENT);
      const recipients = await activeRecipients(db, [...managers, contractResult.data!.sales_id], actor.id);
      return rows(recipients, input.type, `Contract ${expectedStatus}: ${contractResult.data!.contract_no}`, `${actor.fullName} ${expectedStatus} ${contractResult.data!.contract_no} at ${approval.step}`, contractId, "contract", `${input.type}:${approval.id}`);
    }

    case "payment_received": {
      const paymentId = requiredUuid(input, "payment_id");
      const result = await db.from("payments")
        .select("id, amount, contract_id, confirmed, confirmed_by, created_by, voided_at")
        .eq("id", paymentId)
        .maybeSingle();
      notFound(result.error, result.data, "payment");
      const payment = result.data!;
      assertAllowed(allowRole(actor, MONEY) || payment.created_by === actor.id || payment.confirmed_by === actor.id);
      // The ledger's cash predicate is `confirmed = true AND voided_at IS NULL`.
      // A legacy or damaged row may retain confirmed=true after reversal; never
      // turn that row into a fresh "payment received" fact.
      if (payment.confirmed !== true || payment.voided_at) {
        throw new NotificationDispatchError(409, "payment_is_not_confirmed");
      }
      const contractResult = await db.from("contracts").select("sales_id, contract_no").eq("id", payment.contract_id).maybeSingle();
      notFound(contractResult.error, contractResult.data, "contract");
      const moneyRoles = await activeProfilesByRole(db, MONEY);
      const recipients = await activeRecipients(db, [...moneyRoles, contractResult.data!.sales_id], actor.id);
      return rows(recipients, input.type, `Payment received: AED ${money(payment.amount)}`, `Confirmed payment for ${contractResult.data!.contract_no}`, payment.id, "payment", `payment_received:${payment.id}`);
    }

    case "payment_due":
    case "payment_overdue": {
      assertAllowed(allowRole(actor, MONEY));
      const installmentId = requiredUuid(input, "installment_id");
      const result = await db.from("installment_plans")
        .select("id, amount, contract_id, due_date, status")
        .eq("id", installmentId)
        .maybeSingle();
      notFound(result.error, result.data, "installment");
      const installment = result.data!;
      if (["paid", "cancelled", "void"].includes(installment.status)) {
        throw new NotificationDispatchError(409, "installment_is_not_due");
      }
      const dueTime = Date.parse(`${installment.due_date}T00:00:00Z`);
      if (!Number.isFinite(dueTime)) throw new NotificationDispatchError(409, "installment_due_date_invalid");
      const overdueDays = Math.max(0, Math.floor((now.getTime() - dueTime) / 86_400_000));
      if (input.type === "payment_overdue" && overdueDays < 1) {
        throw new NotificationDispatchError(409, "installment_is_not_overdue");
      }
      const contractResult = await db.from("contracts").select("sales_id, contract_no").eq("id", installment.contract_id).maybeSingle();
      notFound(contractResult.error, contractResult.data, "contract");
      const moneyRoles = await activeProfilesByRole(db, MONEY);
      const recipients = await activeRecipients(db, [...moneyRoles, contractResult.data!.sales_id], actor.id);
      const title = input.type === "payment_overdue"
        ? `Overdue: AED ${money(installment.amount)} (${overdueDays} days)`
        : `Payment due: AED ${money(installment.amount)} by ${installment.due_date}`;
      return rows(recipients, input.type, title, `Installment for ${contractResult.data!.contract_no}`, installment.id, "payment");
    }

    case "kpi_target_set": {
      // KPI writes are admin/boss only. Operators have read access but the
      // service-role persistence path must not grant them a write-shaped event.
      assertAllowed(allowRole(actor, MANAGEMENT));
      const period = requiredText(input, "period", /^\d{4}-\d{2}$/);
      const assignedTo = requiredUuid(input, "assigned_to");
      const targetType = requiredText(input, "target_type");
      const result = await db.from("kpi_targets")
        .select("id, period, assigned_to, target_type, target_amount, set_by")
        .eq("period", period)
        .eq("assigned_to", assignedTo)
        .eq("target_type", targetType)
        .maybeSingle();
      notFound(result.error, result.data, "kpi_target");
      const target = result.data!;
      assertAllowed(target.set_by === actor.id);
      if (!target.assigned_to) throw new NotificationDispatchError(409, "kpi_target_has_no_recipient");
      const recipients = await activeRecipients(db, [target.assigned_to], actor.id);
      // replace_kpi_targets() deletes and inserts the period atomically, so this
      // row id is the persisted occurrence: a later intentional save receives a
      // new id while concurrent delivery of this save reuses the same id.
      return rows(recipients, input.type, `KPI target set for ${target.period}`, `${target.target_type}: AED ${money(target.target_amount)}`, target.id, "kpi", `kpi_target_set:${target.id}`);
    }

    case "followup_reminder":
    case "follow_up_overdue": {
      const leadId = requiredUuid(input, "lead_id");
      const taskResult = await db.from("tasks")
        .select("id, lead_id, assignee_id, due_at, status, title")
        .eq("lead_id", leadId)
        .eq("source", "follow_up")
        .neq("status", "completed")
        .order("due_at", { ascending: true })
        .limit(1)
        .maybeSingle();
      notFound(taskResult.error, taskResult.data, "followup_task");
      const task = taskResult.data!;
      if (!task.assignee_id) throw new NotificationDispatchError(409, "followup_has_no_recipient");
      assertAllowed(allowRole(actor, OPERATIONS) || task.assignee_id === actor.id);
      const dueTime = Date.parse(task.due_at);
      const overdueDays = Number.isFinite(dueTime) ? Math.max(0, Math.floor((now.getTime() - dueTime) / 86_400_000)) : 0;
      if (input.type === "follow_up_overdue" && overdueDays < 1) {
        throw new NotificationDispatchError(409, "followup_is_not_overdue");
      }
      const leadResult = await db.from("leads").select("customer_name").eq("id", leadId).maybeSingle();
      notFound(leadResult.error, leadResult.data, "lead");
      const recipients = await activeRecipients(db, [task.assignee_id], actor.id);
      const customer = text(leadResult.data!.customer_name, "Lead");
      const title = input.type === "follow_up_overdue" ? `Overdue follow-up: ${customer}` : `Follow-up: ${customer}`;
      const detail = input.type === "follow_up_overdue" ? `${overdueDays} day(s) overdue` : `due ${task.due_at}`;
      return rows(recipients, input.type, title, `${text(task.title, "Follow up")} · ${detail}`, task.id, "lead");
    }

    case "team_member_added": {
      assertAllowed(allowRole(actor, MANAGEMENT));
      const profileId = requiredUuid(input, "new_user_id");
      const result = await db.from("profiles")
        .select("id, full_name, role, is_active")
        .eq("id", profileId)
        .maybeSingle();
      notFound(result.error, result.data, "profile");
      const profile = result.data!;
      if (profile.is_active !== true) throw new NotificationDispatchError(409, "profile_is_not_active");
      const managers = await activeProfilesByRole(db, MANAGEMENT);
      const recipients = await activeRecipients(db, managers, actor.id);
      const name = text(profile.full_name, "New team member");
      return rows(recipients, input.type, `New team member: ${name}`, `${name} added as ${text(profile.role, "member")}`, profile.id, "user", `team_member_added:${profile.id}`);
    }

    case "first_payment_reminder": {
      const contractId = requiredUuid(input, "contract_id");
      const result = await db.from("contracts")
        .select("id, contract_no, contract_amount, party_a_name, first_payment_status, first_payment_due_date, sales_id")
        .eq("id", contractId)
        .maybeSingle();
      notFound(result.error, result.data, "contract");
      const contract = result.data!;
      assertAllowed(allowRole(actor, OPERATIONS) || actor.role === "finance" || contract.sales_id === actor.id);
      if (!contract.sales_id) throw new NotificationDispatchError(409, "contract_has_no_sales_owner");
      if (contract.first_payment_status === "paid") throw new NotificationDispatchError(409, "first_payment_already_paid");
      const recipients = await activeRecipients(db, [contract.sales_id], actor.id);
      let urgency = "";
      if (contract.first_payment_due_date) {
        const dueTime = Date.parse(`${contract.first_payment_due_date}T00:00:00Z`);
        if (Number.isFinite(dueTime)) {
          const days = Math.floor((now.getTime() - dueTime) / 86_400_000);
          urgency = days > 0 ? ` — ${days} day${days === 1 ? "" : "s"} overdue` : days === 0 ? " — due today" : ` — due in ${Math.abs(days)} day${Math.abs(days) === 1 ? "" : "s"}`;
        }
      }
      const contractNo = text(contract.contract_no, "Contract");
      return rows(recipients, input.type, `First payment reminder: ${contractNo}${urgency}`, `${contractNo} (${text(contract.party_a_name, "Unknown")}) · AED ${money(contract.contract_amount)} · ${text(contract.first_payment_status, "unpaid")}`, contract.id, "contract");
    }
  }
}
