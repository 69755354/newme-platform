import { NextRequest, NextResponse } from "next/server";
import { execFile } from "child_process";
import { createServerSupabase } from "@/lib/supabase-server";

/**
 * POST /api/cos/download-url
 * Body: { key: string, expires?: number }
 * Returns: { url: string, key: string, expires_in: number }
 */
export async function POST(request: NextRequest) {
  try {
    const supabase = await createServerSupabase();
    const { data: { user }, error: authErr } = await supabase.auth.getUser();
    if (authErr || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { key, expires } = await request.json();

    if (!key || typeof key !== "string") {
      return NextResponse.json({ error: "key is required" }, { status: 400 });
    }

    // Validate key: must match known prefixes or safe pattern
    const safePattern = /^[a-zA-Z0-9_\/\-.]+$/;
    if (!safePattern.test(key)) {
      return NextResponse.json({ error: "Invalid key: contains unsafe characters" }, { status: 400 });
    }
    const knownPrefixes = ["quotations/", "attachments/", "leads/", "media/", "contracts/"];
    const hasKnownPrefix = knownPrefixes.some(p => key.startsWith(p));
    if (!hasKnownPrefix) {
      return NextResponse.json({ error: "Invalid key: unknown path prefix" }, { status: 400 });
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
