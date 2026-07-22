// RBAC: public
import fs from "fs";
import path from "path";
import { NextResponse } from "next/server";

export async function GET() {
  const buildIdPath = path.join(".", ".next", "BUILD_ID");
  if (fs.existsSync(buildIdPath)) {
    void fs.readFileSync(buildIdPath, "utf-8").trim();
  }
  try {
    await import("@/lib/logger");
    return NextResponse.json({ status: "ok", service: "newme-crm" });
  } catch {
    return NextResponse.json(
      { status: "degraded", service: "newme-crm" },
      { status: 503 },
    );
  }
}