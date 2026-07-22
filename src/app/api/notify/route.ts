// RBAC: user (authenticated)
import { NextRequest, NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase-server";
import {
  createNotification,
  createNotificationsBulk,
  getAdminUserIds,
  getAllActiveUserIds,
  VALID_NOTIFICATION_TYPES,
} from "@/lib/notifications";
import type { NotificationType } from "@/lib/notifications";

/**
 * POST /api/notify
 * Unified notification trigger — called from client after business actions.
 * Validates auth + ownership before writing.
 */
export async function POST(request: NextRequest) {
  const bearerToken = request.headers.get("authorization")?.replace("Bearer ", "") ?? undefined;
  const cookieHeader = request.headers.get("cookie") ?? "";
  const supabase = await createServerSupabase(bearerToken, cookieHeader);
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json();
  const { type, related_id, related_type, title, body: notifBody } = body as {
    type: NotificationType;
    related_id?: string;
    related_type?: string;
    title?: string;
    body?: string;
  };

  if (!type) return NextResponse.json({ error: "type required" }, { status: 400 });

  // Validate type against shared constant
  if (!VALID_NOTIFICATION_TYPES.includes(type)) {
    return NextResponse.json({ error: `Invalid notification type: ${type}` }, { status: 400 });
  }

  // Verify user role
  const { data: profile } = await supabase
    .from("profiles")
    .select("id, role, full_name")
    .eq("id", user.id)
    .single();
  if (!profile?.role) return NextResponse.json({ error: "Profile not found" }, { status: 403 });

  const isAdmin = ["admin", "boss"].includes(profile.role);

  switch (type) {
    case "lead_created": {
      // Notify all admins/bosses about new lead
      const { lead_id, customer_name: leadCustomerName, assigned_to: leadAssignee } = body as {
        lead_id?: string;
        customer_name?: string;
        assigned_to?: string;
      };
      if (!lead_id) {
        return NextResponse.json({ error: "lead_id required" }, { status: 400 });
      }
      const displayName = leadCustomerName || "New Lead";
      // Admin/boss sees all notifications; others don't notify themselves
      const activeIds = await getAllActiveUserIds(isAdmin ? undefined : user.id);
      if (activeIds.length > 0) {
        await createNotificationsBulk(
          activeIds.map((id) => ({
            userId: id,
            type: "lead_created",
            title: `New lead: ${displayName}`,
            body: notifBody || `${profile.full_name || "Someone"} created lead "${displayName}"`,
            relatedId: lead_id,
            relatedType: "lead",
          }))
        );
      }
      // If lead was assigned to someone else (not the creator), notify them too
      if (leadAssignee && leadAssignee !== user.id && !activeIds.includes(leadAssignee)) {
        await createNotification({
          userId: leadAssignee,
          type: "lead_assigned",
          title: `Lead assigned to you: ${displayName}`,
          body: notifBody || `${profile.full_name || "Someone"} assigned lead "${displayName}" to you`,
          relatedId: lead_id,
          relatedType: "lead",
        });
      }
      break;
    }

    case "lead_assigned": {
      // Notify the salesperson who got assigned
      const { lead_id, assigned_to } = body as {
        lead_id?: string;
        assigned_to?: string;
      };
      if (!lead_id || !assigned_to) {
        return NextResponse.json({ error: "lead_id and assigned_to required" }, { status: 400 });
      }
      // Only admin/boss or the assigner can trigger this
      if (!isAdmin && assigned_to !== user.id) {
        // Verify the lead is currently assigned to this user (they're reassigning from themselves)
        const { data: lead } = await supabase
          .from("leads")
          .select("assigned_to")
          .eq("id", lead_id)
          .single();
        if (!lead || (lead.assigned_to !== user.id && !isAdmin)) {
          return NextResponse.json({ error: "Forbidden" }, { status: 403 });
        }
      }
      // Get lead name
      const { data: lead } = await supabase
        .from("leads")
        .select("customer_name")
        .eq("id", lead_id)
        .single();
      const customerName = lead?.customer_name || "Unknown";
      await createNotification({
        userId: assigned_to,
        type: "lead_assigned",
        title: `New lead assigned: ${customerName}`,
        body: notifBody || `Lead "${customerName}" has been assigned to you`,
        relatedId: lead_id,
        relatedType: "lead",
      });
      break;
    }

    case "quote_created": {
      const { quote_id, lead_id: quoteLeadId, quote_no } = body as {
        quote_id?: string;
        lead_id?: string;
        quote_no?: string;
      };
      if (!quote_id) {
        return NextResponse.json({ error: "quote_id required" }, { status: 400 });
      }
      // Notify all active users about new quotation
      const activeIds = await getAllActiveUserIds(user.id);
      if (activeIds.length > 0) {
        await createNotificationsBulk(
          activeIds.map((id) => ({
            userId: id,
            type: "quote_created",
            title: `New quote: ${quote_no || "Untitled"}`,
            body: notifBody || `Quotation created by ${profile.full_name || "user"}`,
            relatedId: quote_id,
            relatedType: "quote",
          }))
        );
      }
      break;
    }

    case "contract_created": {
      const { contract_id, lead_id: createdContractLeadId, amount: createdAmount, contract_no } = body as {
        contract_id?: string;
        lead_id?: string;
        amount?: number;
        contract_no?: string;
      };
      if (!contract_id) {
        return NextResponse.json({ error: "contract_id required" }, { status: 400 });
      }
      // Notify all active users about new contract
      const activeIds = await getAllActiveUserIds(user.id);
      if (activeIds.length > 0) {
        await createNotificationsBulk(
          activeIds.map((id) => ({
            userId: id,
            type: "contract_created",
            title: `New contract: ${contract_no || "Untitled"}${createdAmount ? ` · AED ${createdAmount.toLocaleString()}` : ""}`,
            body: notifBody || `Contract created by ${profile.full_name || "user"}`,
            relatedId: contract_id,
            relatedType: "contract",
          }))
        );
      }
      break;
    }

    case "lead_stage_change":
    case "lead_stage_changed": {
      const { lead_id, from_stage, to_stage } = body as {
        lead_id?: string;
        from_stage?: string;
        to_stage?: string;
      };
      if (!lead_id || !to_stage) {
        return NextResponse.json({ error: "lead_id and to_stage required" }, { status: 400 });
      }
      // Fetch lead data once (assigned_to + customer_name)
      const { data: lead } = await supabase
        .from("leads")
        .select("assigned_to, customer_name")
        .eq("id", lead_id)
        .single();
      // Verify user owns this lead or is admin
      if (!isAdmin) {
        if (!lead || lead.assigned_to !== user.id) {
          return NextResponse.json({ error: "Forbidden" }, { status: 403 });
        }
      }
      const customerName = lead?.customer_name || "Unknown";
      const leadAssignee = lead?.assigned_to;

      // Notify admins about important stage changes
      const importantStages = ["won", "lost", "negotiation", "quotation_submitted"];
      if (importantStages.includes(to_stage)) {
        const adminIds = await getAdminUserIds();
        if (adminIds.length > 0) {
          await createNotificationsBulk(
            adminIds
              .filter((id) => id !== user.id) // don't notify yourself
              .map((id) => ({
                userId: id,
                type: "lead_stage_change",
                title: `${customerName}: ${from_stage || "new"} → ${to_stage}`,
                body: `Lead "${customerName}" moved to ${to_stage} by ${profile.full_name || "sales"}`,
                relatedId: lead_id,
                relatedType: "lead",
              }))
          );
        }
      }

      // Also notify the assigned salesperson if different from the person making the change
      if (leadAssignee && leadAssignee !== user.id) {
        await createNotification({
          userId: leadAssignee,
          type: "lead_stage_change",
          title: `${customerName}: ${from_stage || "new"} → ${to_stage}`,
          body: `Lead "${customerName}" moved to ${to_stage} by ${profile.full_name || "sales"}`,
          relatedId: lead_id,
          relatedType: "lead",
        });
      }
      break;
    }

    case "contract_signed": {
      const { contract_id, lead_id: contractLeadId, amount } = body as {
        contract_id?: string;
        lead_id?: string;
        amount?: number;
      };
      if (!contract_id) {
        return NextResponse.json({ error: "contract_id required" }, { status: 400 });
      }
      // Ownership check: caller must be admin/boss or own this contract
      if (!isAdmin) {
        const { data: contract } = await supabase
          .from("contracts")
          .select("sales_id")
          .eq("id", contract_id)
          .single();
        if (!contract || contract.sales_id !== user.id) {
          return NextResponse.json({ error: "Forbidden" }, { status: 403 });
        }
      }
      // Notify all active users
      const activeIds = await getAllActiveUserIds(isAdmin ? undefined : user.id);
      if (activeIds.length > 0) {
        await createNotificationsBulk(
          activeIds.map((id) => ({
            userId: id,
            type: "contract_signed",
            title: `New contract: AED ${amount?.toLocaleString() || "N/A"}`,
            body: notifBody || `Contract created by ${profile.full_name || "user"}`,
            relatedId: contract_id,
            relatedType: "contract",
          }))
        );
      }
      break;
    }

    case "contract_pending_approval": {
      const { contract_id, contract_no, amount } = body as {
        contract_id?: string;
        contract_no?: string;
        amount?: number;
      };
      if (!contract_id) {
        return NextResponse.json({ error: "contract_id required" }, { status: 400 });
      }
      const adminIds = await getAdminUserIds();
      if (adminIds.length > 0) {
        await createNotificationsBulk(
          adminIds.map((id) => ({
            userId: id,
            type: "contract_pending_approval",
            title: `Contract pending approval: ${contract_no || "Untitled"}`,
            body: notifBody || `Contract ${contract_no || contract_id}${amount ? ` (AED ${amount.toLocaleString()})` : ""} is awaiting admin review.`,
            relatedId: contract_id,
            relatedType: "contract",
          }))
        );
      }
      break;
    }

    case "contract_approved":
    case "contract_rejected": {
      const { contract_id, contract_no, action: approvalAction, step, approver_name, target_user_id } = body as {
        contract_id?: string;
        contract_no?: string;
        action?: string;
        step?: string;
        approver_name?: string;
        target_user_id?: string;
      };
      if (!contract_id) {
        return NextResponse.json({ error: "contract_id required" }, { status: 400 });
      }
      const wasApproved = type === "contract_approved";
      const recipients: string[] = [];
      // Notify the contract salesperson
      if (target_user_id) {
        recipients.push(target_user_id);
      }
      // Also notify other admins
      const adminIds = await getAdminUserIds();
      for (const id of adminIds) {
        if (!recipients.includes(id)) {
          recipients.push(id);
        }
      }
      if (recipients.length > 0) {
        await createNotificationsBulk(
          recipients.map((id) => ({
            userId: id,
            type,
            title: `Contract ${wasApproved ? "approved" : "rejected"}: ${contract_no || "Untitled"}`,
            body: notifBody || `${approver_name || "Approver"} ${wasApproved ? "approved" : "rejected"} contract ${contract_no || contract_id} at step ${step || "unknown"}.`,
            relatedId: contract_id,
            relatedType: "contract",
          }))
        );
      }
      break;
    }

    case "payment_received": {
      const { payment_id, contract_id: payContractId, amount: payAmount } = body as {
        payment_id?: string;
        contract_id?: string;
        amount?: number;
      };
      if (!payment_id) {
        return NextResponse.json({ error: "payment_id required" }, { status: 400 });
      }
      // Ownership check: caller must be admin/boss or own the related contract
      if (!isAdmin && payContractId) {
        const { data: contract } = await supabase
          .from("contracts")
          .select("sales_id")
          .eq("id", payContractId)
          .single();
        if (!contract || contract.sales_id !== user.id) {
          return NextResponse.json({ error: "Forbidden" }, { status: 403 });
        }
      }
      // Notify all active users about payment
      const activeIds = await getAllActiveUserIds(isAdmin ? undefined : user.id);
      if (activeIds.length > 0) {
        await createNotificationsBulk(
          activeIds.map((id) => ({
            userId: id,
            type: "payment_received",
            title: `Payment received: AED ${payAmount?.toLocaleString() || "N/A"}`,
            body: notifBody || `Payment recorded by ${profile.full_name || "user"}`,
            relatedId: payment_id,
            relatedType: "payment",
          }))
        );
      }
      break;
    }

    case "payment_overdue": {
      const { installment_id, contract_id: overdueContractId, amount: overdueAmount, days_overdue } = body as {
        installment_id?: string;
        contract_id?: string;
        amount?: number;
        days_overdue?: number;
      };
      if (!installment_id) {
        return NextResponse.json({ error: "installment_id required" }, { status: 400 });
      }
      // Notify admins + the sales person who owns the contract
      const adminIds = await getAdminUserIds();
      const recipients = [...adminIds];
      // Find sales person for this contract
      if (overdueContractId) {
        const { data: contract } = await supabase
          .from("contracts")
          .select("sales_id")
          .eq("id", overdueContractId)
          .single();
        if (contract?.sales_id && !recipients.includes(contract.sales_id)) {
          recipients.push(contract.sales_id);
        }
      }
      await createNotificationsBulk(
        recipients.map((id) => ({
          userId: id,
          type: "payment_overdue",
          title: `Overdue: AED ${overdueAmount?.toLocaleString() || "N/A"} (${days_overdue || "?"} days)`,
          body: notifBody || "Installment payment is overdue",
          relatedId: installment_id,
          relatedType: "payment",
        }))
      );
      break;
    }

    case "payment_due": {
      const { installment_id, contract_id: dueContractId, amount: dueAmount, due_date } = body as {
        installment_id?: string;
        contract_id?: string;
        amount?: number;
        due_date?: string;
      };
      if (!installment_id) {
        return NextResponse.json({ error: "installment_id required" }, { status: 400 });
      }
      // Notify assigned sales + admins
      const adminIds = await getAdminUserIds();
      const recipients = [...adminIds];
      if (dueContractId) {
        const { data: contract } = await supabase
          .from("contracts")
          .select("sales_id")
          .eq("id", dueContractId)
          .single();
        if (contract?.sales_id && !recipients.includes(contract.sales_id)) {
          recipients.push(contract.sales_id);
        }
      }
      await createNotificationsBulk(
        recipients.map((id) => ({
          userId: id,
          type: "payment_due",
          title: `Payment due: AED ${dueAmount?.toLocaleString() || "N/A"}${due_date ? ` by ${due_date}` : ""}`,
          body: notifBody || "Installment payment is due",
          relatedId: installment_id,
          relatedType: "payment",
        }))
      );
      break;
    }

    case "kpi_target_set": {
      const { period, assigned_to, target_type, target_amount } = body as {
        period?: string;
        assigned_to?: string;
        target_type?: string;
        target_amount?: number;
      };
      if (!period) {
        return NextResponse.json({ error: "period required" }, { status: 400 });
      }
      // Only admin/boss/operator can set KPI (already verified at top)
      if (!isAdmin && profile.role !== "operator") {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
      }
      // Notify the salesperson whose KPI was set
      if (assigned_to) {
        await createNotification({
          userId: assigned_to,
          type: "kpi_target_set",
          title: `KPI target set for ${period}`,
          body: `${target_type || "Target"}: AED ${target_amount?.toLocaleString() || "N/A"}`,
          relatedId: period,
          relatedType: "kpi",
        });
      }
      break;
    }

    case "followup_reminder": {
      const { lead_id: reminderLeadId, assigned_to: reminderAssignee, due_date } = body as {
        lead_id?: string;
        assigned_to?: string;
        due_date?: string;
      };
      if (!reminderLeadId || !reminderAssignee) {
        return NextResponse.json({ error: "lead_id and assigned_to required" }, { status: 400 });
      }
      const { data: lead } = await supabase
        .from("leads")
        .select("customer_name")
        .eq("id", reminderLeadId)
        .single();
      await createNotification({
        userId: reminderAssignee,
        type: "followup_reminder",
        title: `Follow-up: ${lead?.customer_name || "Lead"}`,
        body: notifBody || `Scheduled follow-up${due_date ? ` due ${due_date}` : ""}`,
        relatedId: reminderLeadId,
        relatedType: "lead",
      });
      break;
    }

    case "team_member_added": {
      const { new_user_id, new_user_name, new_user_role } = body as {
        new_user_id?: string;
        new_user_name?: string;
        new_user_role?: string;
      };
      if (!new_user_id) {
        return NextResponse.json({ error: "new_user_id required" }, { status: 400 });
      }
      // Notify all active admins
      const adminIds = await getAdminUserIds();
      if (adminIds.length > 0) {
        await createNotificationsBulk(
          adminIds
            .filter((id) => id !== user.id)
            .map((id) => ({
              userId: id,
              type: "team_member_added",
              title: `New team member: ${new_user_name || "Unknown"}`,
              body: notifBody || `${profile.full_name || "Someone"} added ${new_user_name || "a new user"} as ${new_user_role || "member"}`,
              relatedId: new_user_id,
              relatedType: "user",
            }))
        );
      }
      break;
    }

    case "follow_up_overdue": {
      const { lead_id: overdueLeadId, assigned_to: overdueAssignee, overdue_days } = body as {
        lead_id?: string;
        assigned_to?: string;
        overdue_days?: number;
      };
      if (!overdueLeadId || !overdueAssignee) {
        return NextResponse.json({ error: "lead_id and assigned_to required" }, { status: 400 });
      }
      const { data: lead } = await supabase
        .from("leads")
        .select("customer_name")
        .eq("id", overdueLeadId)
        .single();
      await createNotification({
        userId: overdueAssignee,
        type: "follow_up_overdue",
        title: `Overdue follow-up: ${lead?.customer_name || "Lead"}`,
        body: notifBody || `Follow-up is ${overdue_days || "?"} day(s) overdue`,
        relatedId: overdueLeadId,
        relatedType: "lead",
      });
      break;
    }

    case "first_payment_reminder": {
      const { contract_id: firstPayContractId, sales_id: firstPaySalesId, urgency: firstPayUrgency } = body as {
        contract_id?: string;
        sales_id?: string;
        urgency?: string;
      };
      if (!firstPayContractId || !firstPaySalesId) {
        return NextResponse.json({ error: "contract_id and sales_id required" }, { status: 400 });
      }
      const { data: contract } = await supabase
        .from("contracts")
        .select("contract_no, contract_amount, party_a_name, first_payment_status")
        .eq("id", firstPayContractId)
        .single();
      await createNotification({
        userId: firstPaySalesId,
        type: "first_payment_reminder",
        title: `First payment reminder: ${contract?.contract_no || "Contract"}${firstPayUrgency ? ` — ${firstPayUrgency}` : ""}`,
        body: notifBody || `Contract ${contract?.contract_no || ""} first payment needs attention. Status: ${contract?.first_payment_status || "unpaid"}.`,
        relatedId: firstPayContractId,
        relatedType: "contract",
      });
      break;
    }

    default:
      return NextResponse.json({ error: `Unknown notification type: ${type}` }, { status: 400 });
  }

  return NextResponse.json({ success: true });
}
