// RBAC: internal-readiness
import { NextRequest, NextResponse } from "next/server";
export async function GET(request: NextRequest) {
  const token = process.env.NEWME_READINESS_TOKEN;
  if (!token || request.headers.get("x-newme-readiness-token") !== token) return NextResponse.json({ status: "unauthorized" }, { status: 401 });
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return NextResponse.json({ status: "degraded" }, { status: 503 });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    const response = await fetch(url + "/rest/v1/profiles?select=id&limit=1", { headers: { apikey: key, Authorization: "Bearer " + key }, signal: controller.signal, cache: "no-store" });
    return NextResponse.json({ status: response.ok ? "ready" : "degraded" }, { status: response.ok ? 200 : 503 });
  } catch { return NextResponse.json({ status: "degraded" }, { status: 503 }); }
  finally { clearTimeout(timer); }
}
