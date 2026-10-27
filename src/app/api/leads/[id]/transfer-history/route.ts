import { NextRequest, NextResponse } from "next/server";
import {
  applyPrivateNoStore,
  applyRequestAuthCookies,
  getRequestAuthContext,
  RequestAuthError,
  requestAuthErrorResponse,
} from "@/lib/request-auth-context";
import { runAuthorizedLeadTransferRead } from "@/lib/lead-transfer-history.mjs";

const validUuid = (value: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const context = await getRequestAuthContext(req);
    const respond = (body: Record<string, unknown>, init?: ResponseInit) =>
      applyRequestAuthCookies(context, NextResponse.json(body, init));
    const { id: leadId } = await params;
    if (!validUuid(leadId)) {
      return respond({ error: "Invalid Lead id" }, { status: 400 });
    }

    // The caller-bound query is followed by an explicit owner/management check.
    // This prevents a permissive legacy RLS policy from authorizing an
    // unassigned Lead. All subsequent reads keep the caller's RLS context.
    const authorizedRead = await runAuthorizedLeadTransferRead({
      role: context.role,
      userId: context.user.id,
      loadVisibleLead: () => context.supabase
        .from("leads")
        .select("id, assigned_to")
        .eq("id", leadId)
        .maybeSingle(),
      revalidateAccess: () => context.supabase
        .from("leads")
        .select("id, assigned_to")
        .eq("id", leadId)
        .eq("assigned_to", context.user.id)
        .maybeSingle(),
      readAuthorizedHistory: async () => {
        const { data: transfers, error: transferError } = await context.supabase
          .from("transfer_history")
          .select("id, from_user_id, to_user_id, reason, created_at, transferred_by")
          .eq("lead_id", leadId)
          .order("created_at", { ascending: false })
          .limit(100);
        if (transferError) return { status: "history_error" as const };

        const profileIds = [...new Set((transfers ?? []).flatMap((transfer) => [
          transfer.from_user_id,
          transfer.to_user_id,
          transfer.transferred_by,
        ]).filter((id): id is string => typeof id === "string" && validUuid(id)))];
        let profileNames = new Map<string, string | null>();
        if (profileIds.length > 0) {
          const { data: profiles, error: profileError } = await context.supabase
            .from("profiles")
            .select("id, full_name")
            .in("id", profileIds);
          if (profileError) return { status: "identity_error" as const };
          profileNames = new Map((profiles ?? []).map((profile) => [profile.id, profile.full_name]));
        }

        return {
          status: "ok" as const,
          transfers: (transfers ?? []).map((transfer) => ({
            ...transfer,
            from_user: transfer.from_user_id
              ? { id: transfer.from_user_id, full_name: profileNames.get(transfer.from_user_id) ?? null }
              : null,
            to_user: {
              id: transfer.to_user_id,
              full_name: profileNames.get(transfer.to_user_id) ?? null,
            },
            operator: {
              id: transfer.transferred_by,
              full_name: profileNames.get(transfer.transferred_by) ?? null,
            },
          })),
        };
      },
    });
    if (authorizedRead.status === "visibility_error") {
      return respond({ error: "Lead visibility check failed" }, { status: 503 });
    }
    if (authorizedRead.status === "not_found") {
      return respond({ error: "Lead not found" }, { status: 404 });
    }
    if (authorizedRead.status === "forbidden") {
      return respond({ error: "Lead not found" }, { status: 404 });
    }
    if (authorizedRead.value.status === "history_error") {
      return respond({ error: "Transfer history unavailable" }, { status: 503 });
    }
    if (authorizedRead.value.status === "identity_error") {
      return respond({ error: "Transfer identities unavailable" }, { status: 503 });
    }

    return respond({ transfers: authorizedRead.value.transfers });
  } catch (error) {
    if (error instanceof RequestAuthError) return requestAuthErrorResponse(error);
    return applyPrivateNoStore(
      NextResponse.json({ error: "Internal server error" }, { status: 500 }),
    );
  }
}
