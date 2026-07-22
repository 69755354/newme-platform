// RBAC: public
import { NextResponse } from "next/server";

export async function GET() {
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
