// RBAC: public (retired endpoint)
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const noStoreHeaders = { "Cache-Control": "no-store, max-age=0" };

// Server errors are sent through the structured logger/Sentry pipeline. This
// legacy browser-report endpoint must never accept arbitrary payloads or write
// request-derived files under /tmp.
export function POST() {
  return NextResponse.json(
    { error: "Monitoring endpoint retired" },
    { status: 410, headers: noStoreHeaders },
  );
}
