import { NextRequest, NextResponse } from "next/server";
import { execFile } from "child_process";
import { createServerSupabase } from "@/lib/supabase-server";
import { supabaseAdmin } from "@/lib/supabase-admin";

/**
 * POST /api/cos/download-url
 * Body: { key: string, expires?: number, lead_id?: string }
 * Returns: { url: string, key: string, expires_in: number }
 */
export async function POST(request: NextRequest) {
  try {
    const supabase = await createServerSupabase();
    const authHeader = request.headers.get("authorization");
    const { data: { user }, error: authErr } = authHeader?.startsWith("Bearer ")
      ? await supabase.auth.getUser(authHeader.slice(7))
      : await supabase.auth.getUser();
    if (authErr || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { key, expires, lead_id } = await request.json();

    if (!key || typeof key !== "string") {
      return NextResponse.json({ error: "key is required" }, { status: 400 });
    }

    // Validate key: must match known prefixes or safe pattern
    const safePattern = /^[a-zA-Z0-9_\/\-.]+$/;
    if (!safePattern.test(key)) {
      return NextResponse.json({ error: "Invalid key: contains unsafe characters" }, { status: 400 });
    }
    const knownPrefixes = ["quotations/", "attachments/", "leads/", "media/", "contracts/"];
    const matchingPrefix = knownPrefixes.find(p => key.startsWith(p));
    if (!matchingPrefix) {
      return NextResponse.json({ error: "Invalid key: unknown path prefix" }, { status: 400 });
    }

    // Ownership check for sensitive prefixes
    const sensitivePrefixes = ["quotations/", "leads/", "attachments/", "contracts/"];
    if (sensitivePrefixes.includes(matchingPrefix)) {
      // Resolve lead ownership
      let resolvedLeadId: string | null = lead_id || null;

      if (!resolvedLeadId) {
        // Try to resolve lead_id from the COS key
        // quotations/ prefix: parse key to find quotation → lead
        if (matchingPrefix === "quotations/") {
          // Key format: quotations/{quote_id}-{type}.pdf or quotations/{quote_no}.pdf
          // Try to extract quote identifier from path
          const pathParts = key.replace("quotations/", "").split("/");
          const filename = pathParts[0] || "";
          // Extract first segment before '-' or '.'
          const quoteIdentifier = filename.split("-")[0].split(".")[0];
          if (quoteIdentifier) {
            // Look up by quote_no prefix — try exact match first
            const { data: quotes } = await supabaseAdmin
              .from("quotations")
              .select("id, lead_id")
              .or(`quote_no.eq.${quoteIdentifier},id.eq.${quoteIdentifier}`)
              .limit(1);
            if (quotes && quotes.length > 0) {
              resolvedLeadId = quotes[0].lead_id;
            }
          }
        } else if (matchingPrefix === "leads/") {
          // Key format: leads/{lead_id}/...
          const pathParts = key.replace("leads/", "").split("/");
          const candidateLeadId = pathParts[0];
          if (candidateLeadId) {
            resolvedLeadId = candidateLeadId; // Will be validated below
          }
        }
        // For attachments/ and contracts/ - require explicit lead_id
      }

      if (!resolvedLeadId) {
        return NextResponse.json(
          { error: "lead_id required for this file type" },
          { status: 400 }
        );
      }

      // Verify user has permission to this lead
      const { data: profile } = await supabaseAdmin
        .from("user_profiles")
        .select("role")
        .eq("id", user.id)
        .single();

      const userRole = profile?.role;
      const isPrivileged = userRole === "admin" || userRole === "boss";

      if (!isPrivileged) {
        const { data: lead } = await supabaseAdmin
          .from("leads")
          .select("assigned_to")
          .eq("id", resolvedLeadId)
          .single();

        if (!lead || lead.assigned_to !== user.id) {
          return NextResponse.json(
            { error: "Forbidden: you do not have permission to access this file" },
            { status: 403 }
          );
        }
      }
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
  } catch (err: any) {
    console.error("[COS Download] Error:", err);
    const message = process.env.NODE_ENV === "production" ? "Internal server error" : err.message;
    return NextResponse.json(
      { error: message || "Failed to generate download URL" },
      { status: 500 }
    );
  }
}
