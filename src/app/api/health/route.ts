// RBAC: public
import { NextResponse } from "next/server";
export function GET() {
  return NextResponse.json({
    status: "ok",
    service: "newme-crm",
    version: process.env.NEXT_PUBLIC_APP_VERSION ?? "unknown",
  });
}
