// RBAC: user (authenticated)
import { NextRequest, NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase-server";
import { logger, genReqId } from "@/lib/logger";

/**
 * POST /api/contracts/[id]/confirm-upload
 * Confirm that a contract file has been uploaded to COS.
 * Updates the contract record with file_url and file_metadata.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const request_id = genReqId();
  const { id: contractId } = await params;
  try {
    const bearerToken = request.headers.get("authorization")?.replace("Bearer ", "") ?? undefined;
    const cookieHeader = request.headers.get("cookie") ?? "";
    const supabase = await createServerSupabase(bearerToken, cookieHeader);
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json();
    const { key, filename, size } = body;

    if (!key || typeof key !== "string") {
      return NextResponse.json(
        { error: "key is required" },
        { status: 400 }
      );
    }
    if (!filename || typeof filename !== "string") {
      return NextResponse.json(
        { error: "filename is required" },
        { status: 400 }
      );
    }

    // Validate key belongs to this contract
    const expectedPrefix = `contracts/${contractId}/`;
    if (!key.startsWith(expectedPrefix)) {
      return NextResponse.json(
        { error: "Key does not belong to this contract" },
        { status: 400 }
      );
    }

    // Verify the contract exists
    const { data: contract, error: contractErr } = await supabase
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

    // Build the file URL from COS config
    const bucket = process.env.COS_BUCKET || "newme-1302961787";
    const region = process.env.COS_REGION || "ap-singapore";
    const fileUrl = `https://${bucket}.cos.${region}.myqcloud.com/${key}`;

    // Build file metadata
    const fileMetadata: Record<string, any> = {
      filename,
      key,
      uploaded_at: new Date().toISOString(),
      uploaded_by: user.id,
    };
    if (typeof size === "number" && size > 0) {
      fileMetadata.size = size;
    }

    // Update the contract record
    const { error: updateErr } = await supabase
      .from("contracts")
      .update({
        file_url: fileUrl,
        file_metadata: fileMetadata,
        updated_at: new Date().toISOString(),
      })
      .eq("id", contractId);

    if (updateErr) {
      logger.error(
        {
          err: updateErr,
          request_id,
          operation: "contract_confirm_upload",
          user_id: user.id,
          contract_id: contractId,
        },
        "[Confirm Upload] DB update failed",
      );
      return NextResponse.json(
        { error: "Failed to update contract file info" },
        { status: 500 }
      );
    }

    return NextResponse.json({ success: true, file_url: fileUrl });
  } catch (err: any) {
    const message =
      process.env.NODE_ENV === "production"
        ? "Internal server error"
        : err.message;
    logger.error(
      {
        err,
        request_id,
        operation: "contract_confirm_upload",
        contract_id: contractId,
      },
      "[Confirm Upload] Error",
    );
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
