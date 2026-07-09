// RBAC: public
import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import crypto from "crypto";

const ERRORS_DIR = "/tmp/hermes/errors";

function ensureDir() {
  if (!fs.existsSync(ERRORS_DIR)) {
    fs.mkdirSync(ERRORS_DIR, { recursive: true });
  }
}

function fingerprint(message: string, stack?: string): string {
  return crypto
    .createHash("md5")
    .update(`${message}${stack?.split("\n")?.[0] || ""}`)
    .digest("hex")
    .slice(0, 12);
}

export async function POST(req: NextRequest) {
  // Require shared secret — this is an internal monitoring endpoint
  const secret = req.headers.get("x-monitoring-secret");
  if (!process.env.MONITORING_SECRET || secret !== process.env.MONITORING_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await req.json();
    const {
      message = "Unknown error",
      stack = "",
      type = "frontend",
      url = "",
      userAgent = req.headers.get("user-agent") || "",
    } = body;

    const fp = fingerprint(message, stack);
    const timestamp = new Date().toISOString();

    ensureDir();

    // Append to fingerprint-based log file (one file per error type)
    const logFile = path.join(ERRORS_DIR, `${fp}.jsonl`);
    const entry = JSON.stringify({
      fp,
      message,
      stack: stack.slice(0, 2000),
      type,
      url,
      userAgent,
      timestamp,
    });
    fs.appendFileSync(logFile, entry + "\n");

    return NextResponse.json({ ok: true, fingerprint: fp });
  } catch (e: any) {
    console.error("[monitoring/report]", e.message);
    return NextResponse.json({ ok: false, error: e.message }, { status: 500 });
  }
}
