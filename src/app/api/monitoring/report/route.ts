// RBAC: public
import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import * as Sentry from "@sentry/nextjs";
import { sanitizeValue } from "@/lib/observability.mjs";

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
    const message = typeof body.message === "string" ? body.message : "Unknown error";
    const stack = typeof body.stack === "string" ? body.stack : "";
    const type = typeof body.type === "string" ? body.type : "frontend";
    const url = typeof body.url === "string" ? body.url : "";
    const userAgent = typeof body.userAgent === "string"
      ? body.userAgent
      : req.headers.get("user-agent") || "";

    const safe = sanitizeValue({ message, stack, type, url, userAgent }) as {
      message: string;
      stack: string;
      type: string;
      url: string;
      userAgent: string;
    };
    const fp = fingerprint(safe.message, safe.stack);
    const timestamp = new Date().toISOString();

    ensureDir();

    // Append to fingerprint-based log file (one file per error type)
    const logFile = path.join(ERRORS_DIR, `${fp}.jsonl`);
    const entry = JSON.stringify({
      fp,
      message: safe.message.slice(0, 1000),
      stack: safe.stack.slice(0, 2000),
      type: safe.type.slice(0, 100),
      url: safe.url.slice(0, 1000),
      userAgent: safe.userAgent.slice(0, 500),
      timestamp,
    });
    fs.appendFileSync(logFile, entry + "\n");
    Sentry.captureMessage(safe.message.slice(0, 1000), {
      level: "error",
      tags: { report_type: safe.type.slice(0, 100), fingerprint: fp },
      extra: { url: safe.url.slice(0, 1000), stack: safe.stack.slice(0, 2000) },
    });

    return NextResponse.json({ ok: true, fingerprint: fp });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "monitoring report failed";
    console.error("[monitoring/report]", message);
    return NextResponse.json({ ok: false, error: "Internal error" }, { status: 500 });
  }
}
