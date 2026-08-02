import { NextResponse } from "next/server";
import {
  OrganizationAuthorizationError,
  resolveOrganizationAuthorization,
} from "@/lib/organization-authorization";
import {
  applyRequestAuthCookies,
  RequestAuthError,
  type RequestAuthContext,
} from "@/lib/request-auth-context";

function jsonWithAuthCookies(
  context: RequestAuthContext,
  body: unknown,
  init?: ResponseInit,
) {
  return applyRequestAuthCookies(context, NextResponse.json(body, init));
}

export async function GET(request: Request) {
  let accessContext: RequestAuthContext | undefined;
  try {
    const access = await resolveOrganizationAuthorization(
      request,
      "catalog.products.read",
    );
    accessContext = access.context;
    const { data: products, error } = await access.context.supabase
      .from("products")
      .select("*")
      .eq("organization_id", access.organizationId)
      .order("category")
      .order("name");

    if (error) {
      return jsonWithAuthCookies(
        access.context,
        { error: "product_catalog_unavailable" },
        { status: 503 },
      );
    }
    return jsonWithAuthCookies(
      access.context,
      {
        organization_id: access.organizationId,
        products,
      },
    );
  } catch (error) {
    if (error instanceof OrganizationAuthorizationError) {
      return jsonWithAuthCookies(
        error.context,
        { error: error.code },
        { status: error.status },
      );
    }
    if (error instanceof RequestAuthError) {
      return NextResponse.json({ error: error.code }, { status: error.status });
    }
    const response = NextResponse.json(
      { error: "product_catalog_unavailable" },
      { status: 503 },
    );
    return accessContext
      ? applyRequestAuthCookies(accessContext, response)
      : response;
  }
}
