// RBAC: user (authenticated)
import { NextRequest, NextResponse } from "next/server";
import { execFile } from "child_process";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import {
  LeadOrganizationAccessError,
  resolveLeadOrganizationAccess,
} from "@/lib/lead-organization-access";
import { RequestAuthError } from "@/lib/request-auth-context";

/** Service-role client used only to map a COS key back to its owning lead. */
function getSupabaseAdmin(): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

/**
 * Resolve a COS object key back to the lead_id that owns it.
 * Returns null when the owning lead cannot be determined.
 *
 *   leads/{leadId}/...          → leadId is the lead id directly
 *   contracts/{contractId}/...  → contracts.lead_id
 *   quotations/{quoteId}/...    → quotations.lead_id (falls back to quote_no stem)
 *   attachments/{file}          → lead_documents.lead_id (by file_url/file_name)
 *   media/{file}                → chat_messages.lead_id (by media_url)
 */
async function resolveLeadIdFromKey(
  key: string,
  admin: SupabaseClient | null,
): Promise<string | null> {
  const segments = key.split("/");
  const prefix = segments[0];
  const id = segments[1];
  if (!id) return null;

  // leads/{leadId}/... → the lead id is embedded in the path
  if (prefix === "leads") {
    return id;
  }

  if (!admin) return null;

  if (prefix === "contracts") {
    const { data } = await admin
      .from("contracts")
      .select("lead_id")
      .eq("id", id)
      .maybeSingle();
    return (data?.lead_id as string) ?? null;
  }

  if (prefix === "quotations") {
    const { data } = await admin
      .from("quotations")
      .select("lead_id")
      .eq("id", id)
      .maybeSingle();
    if (data?.lead_id) return data.lead_id as string;
    // fall back to matching quote_no from the filename stem (e.g. NM-2026-0001.pdf)
    const stem = id.replace(/\.[^.]+$/, "");
    const { data: byNo } = await admin
      .from("quotations")
      .select("lead_id")
      .eq("quote_no", stem)
      .maybeSingle();
    return (byNo?.lead_id as string) ?? null;
  }

  if (prefix === "attachments") {
    const filename = segments[segments.length - 1];
    const { data } = await admin
      .from("lead_documents")
      .select("lead_id")
      .eq("file_url", key)
      .maybeSingle();
    if (data?.lead_id) return data.lead_id as string;
    const { data: byName } = await admin
      .from("lead_documents")
      .select("lead_id")
      .eq("file_name", filename)
      .maybeSingle();
    return (byName?.lead_id as string) ?? null;
  }

  if (prefix === "media") {
    const { data } = await admin
      .from("chat_messages")
      .select("lead_id")
      .eq("media_url", key)
      .maybeSingle();
    return (data?.lead_id as string) ?? null;
  }

  return null;
}

/**
 * POST /api/cos/download-url
 * Body: { key: string, expires?: number }
 * Returns: { url: string, key: string, expires_in: number }
 */
export async function POST(request: NextRequest) {
  try {
    const access = await resolveLeadOrganizationAccess(
      request,
      "lead:read",
      "cos_download",
      null,
    );

    const { key, expires } = await request.json();

    if (!key || typeof key !== "string") {
      return NextResponse.json({ error: "key is required" }, { status: 400 });
    }

    // Validate key: must match known prefixes or safe pattern
    const safePattern = /^[a-zA-Z0-9_\/\-.]+$/;
    if (!safePattern.test(key)) {
      return NextResponse.json({ error: "Invalid key: contains unsafe characters" }, { status: 400 });
    }
    if (key.split("/").some((segment: string) => !segment || segment === "." || segment === "..")) {
      return NextResponse.json({ error: "Invalid key: unsafe path segment" }, { status: 400 });
    }
    const knownPrefixes = ["quotations/", "attachments/", "leads/", "media/", "contracts/"];
    const hasKnownPrefix = knownPrefixes.some(p => key.startsWith(p));
    if (!hasKnownPrefix) {
      return NextResponse.json({ error: "Invalid key: unknown path prefix" }, { status: 400 });
    }

    // Resolve the object to a lead, then bind that lead to the caller's exact
    // organization before signing. Unresolvable objects are never signable.
    const admin = getSupabaseAdmin();
    const ownerLeadId = await resolveLeadIdFromKey(key, admin);
    if (!ownerLeadId) {
      return NextResponse.json({ error: "Object not found" }, { status: 404 });
    }
    const { data: ownerLead, error: ownerLeadError } = await access.client
      .from("leads")
      .select("assigned_to")
      .eq("id", ownerLeadId)
      .eq("organization_id", access.organizationId)
      .maybeSingle();
    if (ownerLeadError) {
      return NextResponse.json({ error: "lead_access_lookup_failed" }, { status: 503 });
    }
    if (!ownerLead) {
      return NextResponse.json({ error: "Object not found" }, { status: 404 });
    }
    const isManagement = ["admin", "boss", "operator"].includes(
      access.context.role,
    );
    if (
      !access.supportSessionId
      && !isManagement
      && ownerLead.assigned_to !== access.context.user.id
    ) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const expireSec = typeof expires === "number" && expires > 0 ? expires : 3600;

    const result = await new Promise<string>((resolve, reject) => {
      execFile(
        "python3",
        ["/home/ubuntu/newme-platform/scripts/cos-presign.py", key, String(expireSec)],
        {
          env: { ...process.env },
          timeout: 5000,
          encoding: "utf-8",
        },
        (err, stdout) => {
          if (err) reject(err);
          else resolve(stdout);
        }
      );
    });

    const data = JSON.parse(result);
    if (data.error) {
      return NextResponse.json({ error: data.error }, { status: 500 });
    }

    return NextResponse.json(data);
  } catch (err: unknown) {
    if (err instanceof LeadOrganizationAccessError) {
      return NextResponse.json({ error: err.code }, { status: err.status });
    }
    if (err instanceof RequestAuthError) {
      return NextResponse.json({ error: err.code }, { status: err.status });
    }
    console.error("[COS Download] Error:", err);
    const message =
      process.env.NODE_ENV === "production"
        ? "Internal server error"
        : err instanceof Error
          ? err.message
          : "Failed to generate download URL";
    return NextResponse.json(
      { error: message || "Failed to generate download URL" },
      { status: 500 }
    );
  }
}
