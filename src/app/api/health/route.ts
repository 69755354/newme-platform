// RBAC: public
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const noStoreHeaders = { "Cache-Control": "no-store, max-age=0" };

export function GET() {
  return NextResponse.json({
    status: "ok",`n    version: process.env.NEXT_PUBLIC_APP_VERSION ?? null,
  }, { headers: noStoreHeaders });
}
