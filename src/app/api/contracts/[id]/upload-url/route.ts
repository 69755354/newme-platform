import { NextRequest, NextResponse } from "next/server";
import { execFile } from "child_process";
import { createServerSupabase } from "@/lib/supabase-server";
import { supabaseAdmin } from "@/lib/supabase-admin";

/**
 * POST /api/contracts/[id]/upload-url
 * Generate a COS pre-signed PUT URL for contract file upload.
 * Only admin/boss/sales who owns the contract can request.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: contractId } = await params;

    const supabase = await createServerSupabase();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json();
    const { filename, version } = body;

    if (!filename || typeof filename !== "string") {
      return NextResponse.json(
        { error: "filename is required" },
        { status: 400 }
      );
    }

    const uploadVersion = version || "draft"; // default to draft

    // Sanitize filename: only safe characters allowed
    const safeFilename = filename.replace(/[^a-zA-Z0-9_.\-. ]/g, "_");
    if (!safeFilename) {
      return NextResponse.json(
        { error: "Invalid filename" },
        { status: 400 }
      );
    }

    // Verify the contract exists
    const { data: contract, error: contractErr } = await supabaseAdmin
      .from("contracts")
      .select("id, sales_id")
      .eq("id", contractId)
      .single();

    if (contractErr || !contract) {
      return NextResponse.json(
        { error: "Contract not found" },
        { status: 404 }
      );
    }

    // Check user role and ownership
    const { data: profile } = await supabase
      .from("profiles")
      .select("role")
      .eq("id", user.id)
      .single();

    const isAdminOrBoss =
      profile?.role && ["admin", "boss"].includes(profile.role);
    const isOwner = contract.sales_id === user.id;

    if (!isAdminOrBoss && !isOwner) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    // Version-based permission: sales can only upload draft, admin/boss can upload sealed
    if (uploadVersion === "sealed" && !isAdminOrBoss) {
      return NextResponse.json(
        { error: "Only admin/boss can upload sealed contracts" },
        { status: 403 }
      );
    }

    // Build the COS object key with version prefix
    const key = `contracts/${contractId}/${uploadVersion}_${safeFilename}`;

    // Run cos-presign.py to generate the pre-signed PUT URL
    const presignResult = await new Promise<string>((resolve, reject) => {
      execFile(
        "python3",
        ["/home/ubuntu/newme-platform/scripts/cos-presign.py", "--put", key],
        {
          env: {
            ...process.env,
            COS_SECRET_ID: process.env.COS_SECRET_ID,
            COS_SECRET_KEY: process.env.COS_SECRET_KEY,
            COS_BUCKET: process.env.COS_BUCKET,
            COS_REGION: process.env.COS_REGION,
          },
          timeout: 5000,
          encoding: "utf-8",
        },
        (err, stdout, stderr) => {
          if (err) {
            console.error("[Upload URL] cos-presign.py error:", stderr || err.message);
            reject(err);
          } else {
            resolve(stdout);
          }
        }
      );
    });

    const data = JSON.parse(presignResult);
    if (data.error) {
      console.error("[Upload URL] Pre-sign error:", data.error);
      return NextResponse.json(
        { error: "Failed to generate upload URL" },
        { status: 500 }
      );
    }

    return NextResponse.json({
      url: data.url,
      key: data.key,
      headers: data.headers || {},
    });
  } catch (err: any) {
    const message =
      process.env.NODE_ENV === "production"
        ? "Internal server error"
        : err.message;
    console.error("[Upload URL] Error:", err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
