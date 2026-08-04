// RBAC: cron (x-cron-secret); tenant payloads are never returned or logged.
import { NextResponse } from "next/server";
import { runSharedOperationsWorker } from "@/lib/shared-operations-worker";

async function handle(request: Request) {
  const secret = request.headers.get("x-cron-secret");
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    return NextResponse.json(await runSharedOperationsWorker(), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    return NextResponse.json({ error: "shared_operations_worker_unavailable" }, { status: 503 });
  }
}

export async function GET(request: Request) { return handle(request); }
export async function POST(request: Request) { return handle(request); }
