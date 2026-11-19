// External authorization: Meta App Secret HMAC (same handler as /api/whatsapp/webhook).
// The production Meta app's WhatsApp Business Account subscription calls this path; both
// paths run the one handler, so GET verification and POST behaviour cannot drift apart.
export { GET, POST } from "@/app/api/whatsapp/webhook/route";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
