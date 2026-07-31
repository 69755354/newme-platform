// RBAC: public (Sentry service-hook HMAC authentication)
import { NextRequest, NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import {
  BoundedReplayStore,
  Sam52BridgeError,
  createHttpHermesTransport,
  deliverSentryAlert,
  readBoundedRequestBody,
} from "@/lib/sentry-webhook-bridge.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const replayStore = new BoundedReplayStore();

function response(error: string, status: number) {
  return NextResponse.json(
    { ok: false, error },
    {
      status,
      headers: { "Cache-Control": "no-store, max-age=0" },
    },
  );
}

export async function POST(request: NextRequest) {
  try {
    const rawBody = await readBoundedRequestBody(request);
    let configuredTransport:
      | ReturnType<typeof createHttpHermesTransport>
      | undefined;
    const result = await deliverSentryAlert({
      rawBody,
      signature: request.headers.get("sentry-hook-signature"),
      resource: request.headers.get("sentry-hook-resource"),
      deliveryId: request.headers.get("sentry-hook-request-id"),
      secret: process.env.SENTRY_SERVICE_HOOK_SECRET,
      replayStore,
      transport: {
        async send(alert: Record<string, unknown>) {
          configuredTransport ??= createHttpHermesTransport({
            url: process.env.HERMES_SENTRY_BRIDGE_URL,
            token: process.env.HERMES_SENTRY_BRIDGE_TOKEN,
          });
          await configuredTransport.send(alert);
        },
      },
      audit: (entry: Record<string, unknown>) => {
        logger.info(
          { audit: true, integration: "sentry-hermes", ...entry },
          "Sentry alert bridge audit",
        );
      },
    });
    return NextResponse.json(
      {
        ok: true,
        status: "accepted",
        duplicate: result.duplicate,
        attempts: result.attempts,
      },
      {
        status: 202,
        headers: { "Cache-Control": "no-store, max-age=0" },
      },
    );
  } catch (error) {
    if (error instanceof Sam52BridgeError) {
      logger.warn(
        {
          audit: true,
          integration: "sentry-hermes",
          action: "rejected",
          code: error.code,
        },
        "Sentry alert bridge rejected",
      );
      return response(error.code, error.status);
    }
    logger.error(
      {
        audit: true,
        integration: "sentry-hermes",
        action: "failed_closed",
      },
      "Sentry alert bridge failed closed",
    );
    return response("internal_error", 500);
  }
}
