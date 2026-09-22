// RBAC: user (boss, admin)
import { NextRequest, NextResponse } from "next/server";
import { execFile } from "child_process";
import { createServerSupabase } from "@/lib/supabase-server";
import { resolveReleaseScript } from "@/lib/release-script";
import { API_SOURCE_PREFIX } from "@/lib/meta-ads-insights.mjs";

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

    // One spend_date, one source.
    //
    // Both readers of this table — src/app/api/dashboard/ads-roi/route.ts and
    // src/app/api/analytics/summary/route.ts — sum every row in ad_spend without
    // filtering on source, which is correct only while no day is described twice.
    // A day covered by both this Excel export and /api/meta/ads-sync would be
    // counted twice: total spend reads high, cost per lead reads low, and nothing
    // in the response says so. ads-sync refuses to write a window that already
    // holds rows from another source; this is the same fence facing the other way.
    // Refusing the import is recoverable in a minute; a silently doubled number is
    // not, because afterwards there is no way to tell which rows were the copy.
    const incomingDates = new Set(
      (rows as { spend_date?: unknown }[])
        .map((r) => (typeof r.spend_date === "string" ? r.spend_date.slice(0, 10) : ""))
        .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)),
    );
    if (incomingDates.size > 0) {
      const ordered = [...incomingDates].sort();
      const { data: owned, error: ownedErr } = await supabase
        .from("ad_spend")
        .select("spend_date")
        .like("source", `${API_SOURCE_PREFIX}%`)
        .gte("spend_date", ordered[0])
        .lte("spend_date", ordered[ordered.length - 1]);

      // A failed check is not an absent conflict: without this the fence would
      // fall open exactly when the database is unhappy.
      if (ownedErr) {
        console.error("[Ads Import] source overlap check failed:", ownedErr);
        return NextResponse.json({ error: "Overlap check failed" }, { status: 500 });
      }

      const clash = [...new Set((owned ?? []).map((r) => String(r.spend_date).slice(0, 10)))]
        .filter((d) => incomingDates.has(d))
        .sort();
      if (clash.length > 0) {
        return NextResponse.json(
          {
            error: "api_sourced_days_would_be_double_counted",
            days: clash.slice(0, 20),
            day_count: clash.length,
            next: "retire_the_api_sourced_rows_for_those_days_or_trim_the_export",
          },
          { status: 409 },
        );
      }
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
