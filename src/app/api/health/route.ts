// RBAC: public
import { NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase-server";
import fs from "fs";
import path from "path";

export async function GET() {
  const start = Date.now();
  const checks: Record<string, string> = {};

  // Check Supabase DB (direct query)
  try {
    const supabase = await createServerSupabase();
    const { error } = await supabase.from("profiles").select("id").limit(1);
    checks.database = error ? `DOWN: ${error.message}` : "UP";
  } catch (e: any) {
    checks.database = `DOWN: ${e.message}`;
  }

  // Check Supabase REST API (full HTTP round-trip)
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
  } catch (e: any) {
    checks.supabase_api = `DOWN: ${e.message}`;
  }

  // Disk (check /tmp writable)
  try {
    const testFile = path.join("/tmp", `health-${Date.now()}.test`);
    fs.writeFileSync(testFile, "ok");
    fs.unlinkSync(testFile);
    checks.disk = "UP";
  } catch {
    checks.disk = "DOWN: /tmp not writable";
  }

  // BUILD_ID version
  let version = process.env.npm_package_version || "unknown";
  try {
    const buildIdPath = path.join(process.cwd(), ".next", "BUILD_ID");
    if (fs.existsSync(buildIdPath)) {
      version = fs.readFileSync(buildIdPath, "utf-8").trim();
    }
  } catch {
    // fallback to npm version
  }

  const duration = Date.now() - start;
  const healthy = Object.values(checks).every((v) => v.startsWith("UP") || /^\d+MB$/.test(v));

  return NextResponse.json(
    {
      status: healthy ? "healthy" : "degraded",
      version,
      uptime: process.uptime ? `${Math.floor(process.uptime())}s` : "unknown",
      checks,
      responseTime: `${duration}ms`,
      timestamp: new Date().toISOString(),
    },
    { status: healthy ? 200 : 503 }
  );
}
