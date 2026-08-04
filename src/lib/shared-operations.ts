import "server-only";

import { NextResponse } from "next/server";
import {
  OrganizationAuthorizationError,
  type OrganizationAuthorization,
} from "@/lib/organization-authorization";
import {
  applyRequestAuthCookies,
  RequestAuthError,
} from "@/lib/request-auth-context";

export type JsonObject = Record<string, unknown>;

export function parseObject(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : null;
}

export function boundedLimit(request: Request, maximum = 100): number {
  const raw = new URL(request.url).searchParams.get("limit");
  const parsed = raw ? Number.parseInt(raw, 10) : 50;
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, maximum) : 50;
}

export function isUuid(value: unknown): value is string {
  return typeof value === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export function text(value: unknown, maximum: number): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= maximum ? normalized : null;
}

export function sharedError(error: unknown): { code: string; status: number } {
  if (error instanceof OrganizationAuthorizationError || error instanceof RequestAuthError) {
    return { code: error.code, status: error.status };
  }
  const message = error !== null && typeof error === "object" && "message" in error
    && typeof error.message === "string" ? error.message : "";
  if (message.includes("not_found")) return { code: "shared_resource_not_found", status: 404 };
  if (message.includes("forbidden") || message.includes("capability")) {
    return { code: "shared_operation_forbidden", status: 403 };
  }
  if (message.includes("idempotency_conflict") || message.includes("lease_invalid")) {
    return { code: "shared_operation_conflict", status: 409 };
  }
  if (message.includes("invalid") || message.includes("unsafe") || message.includes("required")) {
    return { code: "shared_operation_invalid", status: 400 };
  }
  return { code: "shared_operation_unavailable", status: 503 };
}

export function jsonResponse(
  access: OrganizationAuthorization,
  body: unknown,
  status = 200,
) {
  return applyRequestAuthCookies(
    access.context,
    NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } }),
  );
}

export function errorResponse(error: unknown) {
  const mapped = sharedError(error);
  return NextResponse.json(
    { error: mapped.code },
    { status: mapped.status, headers: { "Cache-Control": "no-store" } },
  );
}
