// RBAC: public
import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import fs from "fs";
import path from "path";

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export async function GET() {
  const start = Date.now();
  const checks: Record<string, string> = {};

  try {
    const { error } = await supabaseAdmin.from("profiles").select("id").limit(1);
    checks.database = error ? `DOWN: ${error.message}` : "UP";
  } catch (e) {
    checks.database = `DOWN: ${errMsg(e)}`;
  }

  try {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (supabaseUrl && supabaseKey) {
      const res = await fetch(`${supabaseUrl}/rest/v1/profiles?select=id&limit=1`, {
        headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` },
        signal: AbortSignal.timeout(5000),
      });
      checks.supabase_api = res.ok ? "UP" : `DOWN: HTTP ${res.status}`;
    } else {
      checks.supabase_api = "DOWN: missing env";
    }
  } catch (e) {
    checks.supabase_api = `DOWN: ${errMsg(e)}`;
  }

  try {
    const testFile = path.join("/tmp", `ready-${Date.now()}.test`);
    fs.writeFileSync(testFile, "ok");
    fs.unlinkSync(testFile);
    checks.disk = "UP";
  } catch {
    checks.disk = "DOWN";
  }

  let version = "unknown";
  try {
    const p = path.join(process.cwd(), ".next", "BUILD_ID");
    if (fs.existsSync(p)) version = fs.readFileSync(p, "utf-8").trim();
  } catch {}

  const healthy = Object.values(checks).every((v) => v.startsWith("UP"));

  return NextResponse.json(
    {
      status: healthy ? "ready" : "degraded",
      version,
      checks,
      responseTime: `${Date.now() - start}ms`,
      timestamp: new Date().toISOString(),
    },
    { status: healthy ? 200 : 503 }
  );
}
