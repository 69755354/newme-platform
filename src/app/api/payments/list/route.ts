// RBAC: selected organization capability payments.read
import { NextResponse } from "next/server";
import {
  OrganizationAuthorizationError,
  resolveOrganizationAuthorization,
} from "@/lib/organization-authorization";
import { RequestAuthError } from "@/lib/request-auth-context";
import { getCached, setCache } from "@/lib/api-cache";

export async function GET(request: Request) {
  try {
    const access = await resolveOrganizationAuthorization(
      request,
      "payments.read",
      "read",
    );
    const { supabase, user } = access.context;
    const canReadAll = access.roleKeys.some((roleKey) => [
      "org_owner", "org_admin", "operations", "finance",
    ].includes(roleKey));
    const role = canReadAll
      ? access.roleKeys.find((roleKey) => roleKey !== "sales_agent") ?? access.roleKeys[0]
      : "sales_agent";
    const cacheKey = [
      "payments:list",
      access.organizationId,
      [...access.roleKeys].sort().join(","),
      user.id,
    ].join(":");
    const cached = getCached(cacheKey);
    if (cached) return NextResponse.json(cached);

    let paymentsQuery = supabase
      .from("payments")
      .select("*, contracts!payments_contract_id_fkey!inner(contract_no, party_a_name, sales_id)")
      .eq("organization_id", access.organizationId)
      .order("created_at", { ascending: false });
    let contractsQuery = supabase
      .from("contracts")
      .select("id, contract_no, contract_amount, status, party_a_name, sales_id")
      .eq("organization_id", access.organizationId)
      .in("status", ["signed", "active"])
      .order("contract_no", { ascending: true });
    if (!canReadAll) {
      paymentsQuery = paymentsQuery.eq("contracts.sales_id", user.id);
      contractsQuery = contractsQuery.eq("sales_id", user.id);
    }
    const [paymentsResult, contractsResult] = await Promise.all([
      paymentsQuery,
      contractsQuery,
    ]);
    if (paymentsResult.error || contractsResult.error) {
      return NextResponse.json({ error: "payment_list_failed" }, { status: 503 });
    }
    const responseData = {
      payments: paymentsResult.data ?? [],
      contracts: contractsResult.data ?? [],
      role,
      roleKeys: access.roleKeys,
      organizationId: access.organizationId,
      userId: user.id,
    };
    setCache(cacheKey, responseData, 30);
    return NextResponse.json(responseData);
  } catch (error) {
    if (error instanceof OrganizationAuthorizationError || error instanceof RequestAuthError) {
      return NextResponse.json({ error: error.code }, { status: error.status });
    }
    return NextResponse.json({ error: "payment_list_unavailable" }, { status: 503 });
  }
}
