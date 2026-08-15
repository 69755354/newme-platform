// RBAC: user (boss, admin)
import { NextRequest, NextResponse } from "next/server";
import { execFile } from "child_process";
import { createServerSupabase } from "@/lib/supabase-server";
import { resolveReleaseScript } from "@/lib/release-script";

/**
 * POST /api/dashboard/ads-roi/import
 *
 * Downloads the Meta Ads Excel from COS, parses it, and inserts
 * rows into the ad_spend table. CEO/Admin only.
 */
export async function POST(request: NextRequest) {
  try {
    const bearerToken = request.headers.get("authorization")?.replace("Bearer ", "") ?? undefined;
    const cookieHeader = request.headers.get("cookie") ?? "";
    const supabase = await createServerSupabase(bearerToken, cookieHeader);
    const { data: { user }, error: authErr } = await supabase.auth.getUser();
    if (authErr || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Check user role — only boss/admin can import
    const { data: profile } = await supabase
      .from("profiles")
      .select("role")
      .eq("id", user.id)
      .single();

    if (!profile?.role || !["boss", "admin"].includes(profile.role)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    // Parse the Excel using the Python script that ships inside this release;
    // see resolveReleaseScript for why the absolute /home/ubuntu path was wrong.
    const parser = resolveReleaseScript("scripts/parse-ad-spend.py");
    if (!parser) {
      console.error("[Ads Import] parser missing from release at", process.cwd());
      return NextResponse.json({ error: "Parser unavailable" }, { status: 500 });
    }

    const result = await new Promise<string>((resolve, reject) => {
      execFile(
        "python3",
        [parser],
        {
          // Only what parse-ad-spend.py and the cos-download.py it shells out to
          // actually read. `{ ...process.env }` handed the subprocess
          // SUPABASE_SERVICE_ROLE_KEY and every other runtime secret — the same
          // defect fixed in /api/cos/download-url as F-25, still present here.
          env: {
            PATH: process.env.PATH ?? "",
            COS_SECRET_ID: process.env.COS_SECRET_ID ?? "",
            COS_SECRET_KEY: process.env.COS_SECRET_KEY ?? "",
            COS_BUCKET: process.env.COS_BUCKET ?? "",
            COS_REGION: process.env.COS_REGION ?? "",
            NODE_ENV: process.env.NODE_ENV,
          },
          timeout: 120_000, // 2 minutes for download + parse
          maxBuffer: 50 * 1024 * 1024, // 50MB buffer for large Excel
          encoding: "utf-8",
        },
        (err, stdout, stderr) => {
          if (err) {
            console.error("[Ads Import] Python error:", stderr);
            reject(new Error(stderr || err.message));
          } else {
            resolve(stdout);
          }
        }
      );
    });

    const rows = JSON.parse(result);

    if (!Array.isArray(rows) || rows.length === 0) {
      return NextResponse.json(
        { error: "No data rows found in the Excel file" },
        { status: 400 }
      );
    }

    if (rows[0]?.error) {
      return NextResponse.json(
        { error: rows[0].error },
        { status: 500 }
      );
    }

    // Insert rows in batches of 500
    const batchSize = 500;
    let inserted = 0;
    let errors: string[] = [];

    for (let i = 0; i < rows.length; i += batchSize) {
      const batch = rows.slice(i, i + batchSize);

      const { data, error: insertErr } = await supabase
        .from("ad_spend")
        .insert(batch)
        .select("id");

      if (insertErr) {
        console.error(`[Ads Import] Batch insert error at offset ${i}:`, insertErr);
        errors.push(`Batch ${Math.floor(i / batchSize)}: ${insertErr.message}`);
      } else {
        inserted += data?.length || 0;
      }
    }

    return NextResponse.json({
      success: true,
      total_rows: rows.length,
      inserted,
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (err: any) {
    console.error("[Ads Import] Error:", err);
    const message =
      process.env.NODE_ENV === "production"
        ? "Internal server error"
        : err.message;
    return NextResponse.json(
      { error: message || "Failed to import ad spend data" },
      { status: 500 }
    );
  }
}
