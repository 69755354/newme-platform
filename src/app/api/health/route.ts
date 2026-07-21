// RBAC: public
import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export async function GET() {
  const checks: Record<string, string> = {};

  // 1. Runtime
  checks.runtime = typeof process.uptime === "function" ? "OK" : "DOWN";

  // 2. Logger — verify module resolution
  try {
    await import("@/lib/logger");
    checks.logger = "OK";
  } catch (e) {
    checks.logger = `DOWN: ${errMsg(e)}`;
  }

  // 3. Disk
  try {
    const testFile = path.join("/tmp", `health-${Date.now()}.test`);
    fs.writeFileSync(testFile, "ok");
    fs.unlinkSync(testFile);
    checks.disk = "OK";
  } catch {
    checks.disk = "DOWN";
  }

  // 4. BUILD_ID
  let buildId = "unknown";
  try {
    const p = path.join(process.cwd(), ".next", "BUILD_ID");
    if (fs.existsSync(p)) buildId = fs.readFileSync(p, "utf-8").trim();
  } catch {}

  const allOk = Object.values(checks).every((v) => v === "OK");

  return NextResponse.json(
    {
      status: allOk ? "ok" : "degraded",
      service: "newme-crm",
      release: buildId,
      checks,
      uptime: typeof process.uptime === "function" ? `${Math.floor(process.uptime())}s` : "unknown",
      timestamp: new Date().toISOString(),
    },
    { status: allOk ? 200 : 503 }
  );
}
