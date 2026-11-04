// RBAC: public (browser error reports; no session needed, none is forwarded).
// Logic and safeguards live in src/lib/sentry-tunnel.mjs. Only POST is exported,
// so every other method is answered 405 by Next.
import { handleTunnelRequest } from "@/lib/sentry-tunnel.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  return handleTunnelRequest(request);
}
