// RBAC: public
import { NextResponse } from "next/server";
import { intakeDegradedSnapshot } from "@/lib/intake-degraded.mjs";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const noStoreHeaders = { "Cache-Control": "no-store, max-age=0" };

export function GET() {
  // S35: "status" stays "ok" (probes match it). `intake` appears only while a lead intake path ran degraded in the last
  // 30 minutes, e.g. {"whatsapp":"degraded"}: the WhatsApp privacy gate was closed and leads were created without message text.
  const intake = intakeDegradedSnapshot();
  return NextResponse.json({
    status: "ok",
    ...(Object.keys(intake).length ? { intake } : {}),
  }, { headers: noStoreHeaders });
}
