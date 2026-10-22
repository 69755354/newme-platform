import { createHmac } from "node:crypto";

// This helper cannot address a production number or an arbitrary recipient.
export const REVIEW_SANDBOX = Object.freeze({
  appId: "2295611971276443", wabaId: "2153400175580231",
  phoneId: "1301171506423999", sender: "15556640296", recipient: "971586799388",
});
export const REVIEW_TEMPLATE_BODY = "Your NEWME enquiry has been received. Our team will contact you about your request.";
export const REVIEW_ACTIONS = Object.freeze(["check_connection", "send_hello_world", "create_template"]);

export function reviewToolsConfig(env = process.env, now = Date.now()) {
  const until = env.WHATSAPP_REVIEW_TOOLS_UNTIL;
  const from = env.WHATSAPP_REVIEW_TOOLS_FROM;
  const utcTime = value => {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value)) return NaN;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) && new Date(parsed).toISOString().replace(".000Z", "Z") === value ? parsed : NaN;
  };
  const start = utcTime(from);
  const expiry = utcTime(until);
  const enabled = env.WHATSAPP_REVIEW_TOOLS_ENABLED === "true"
    && Boolean(env.WHATSAPP_REVIEW_ACCESS_TOKEN && env.WHATSAPP_APP_SECRET)
    && Number.isFinite(start) && Number.isFinite(expiry)
    && expiry > start && expiry - start <= 86_400_000 && start <= now && expiry > now;
  return { enabled, until: enabled ? until : null, environment: "meta_test_number_only", recipient_suffix: "9388" };
}

export class ReviewToolsError extends Error {
  constructor(code, { status = 502, metaCode, uncertain = false } = {}) {
    super(code); this.code = code; this.status = status;
    this.metaCode = Number.isInteger(metaCode) ? metaCode : undefined;
    this.uncertain = uncertain;
  }
}

function safeBody(data, action) {
  if (action === "check_connection") return { ok: true, action, environment: "meta_test_number_only" };
  if (action === "send_hello_world") {
    const id = data?.messages?.[0]?.id;
    if (typeof id !== "string" || !/^wamid\.[A-Za-z0-9._~=-]{1,500}$/.test(id)) {
      throw new ReviewToolsError("unexpected_meta_response", { uncertain: true });
    }
    return { ok: true, action, message_id: id, delivery: "accepted_by_meta_not_confirmed_on_recipient" };
  }
  if (!/^\d{1,30}$/.test(data?.id ?? "")) throw new ReviewToolsError("unexpected_meta_response", { uncertain: true });
  return { ok: true, action, template_id: data.id,
    template_status: ["PENDING", "APPROVED", "REJECTED", "IN_APPEAL", "DISABLED", "PAUSED"].includes(data.status) ? data.status : "UNKNOWN" };
}

export async function performReviewAction(action, requestId, {
  env = process.env, now = Date.now(), fetchImpl = fetch,
} = {}) {
  if (!reviewToolsConfig(env, now).enabled) throw new ReviewToolsError("review_tools_disabled", { status: 503 });
  if (!REVIEW_ACTIONS.includes(action) || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(requestId)) {
    throw new ReviewToolsError("invalid_action", { status: 400 });
  }
  const token = env.WHATSAPP_REVIEW_ACCESS_TOKEN;
  const proof = createHmac("sha256", env.WHATSAPP_APP_SECRET).update(token).digest("hex");
  async function graph(path, payload) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    let response;
    try {
      response = await fetchImpl(`https://graph.facebook.com/v26.0/${path}`, {
        method: payload ? "POST" : "GET", cache: "no-store", redirect: "error", signal: controller.signal,
        headers: { Authorization: `Bearer ${token}`, ...(payload ? { "Content-Type": "application/json" } : {}) },
        ...(payload ? { body: JSON.stringify({ ...payload, appsecret_proof: proof }) } : {}),
      });
      if (Number(response.headers.get("content-length")) > 65_536) throw new Error("response_too_large");
      const reader = response.body?.getReader();
      if (!reader) throw new Error("response_missing");
      let bytes = 0; const chunks = [];
      while (true) {
        const item = await reader.read(); if (item.done) break;
        bytes += item.value.byteLength;
        if (bytes > 65_536) { await reader.cancel(); throw new Error("response_too_large"); }
        chunks.push(item.value);
      }
      const data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!response.ok || data.error) {
        throw new ReviewToolsError("meta_request_rejected", { metaCode: data.error?.code, uncertain: Boolean(payload) && response.status >= 500 });
      }
      return data;
    } catch (error) {
      if (error instanceof ReviewToolsError) throw error;
      // A timed-out mutation may already have reached Meta. Never auto-retry it.
      throw new ReviewToolsError(payload ? "meta_result_unknown" : "meta_connection_failed", { uncertain: Boolean(payload) });
    } finally { clearTimeout(timer); }
  }

  // Resolve the phone through the fixed test WABA before every operation.
  const phones = await graph(`${REVIEW_SANDBOX.wabaId}/phone_numbers?fields=id,display_phone_number&limit=100&appsecret_proof=${proof}`);
  const matching = Array.isArray(phones.data) && phones.data.find(p => p.id === REVIEW_SANDBOX.phoneId
    && typeof p.display_phone_number === "string"
    && p.display_phone_number.replace(/[+ ()-]/g, "") === REVIEW_SANDBOX.sender);
  if (!matching) throw new ReviewToolsError("sandbox_binding_failed", { status: 409 });
  if (action === "check_connection") return safeBody(null, action);
  if (action === "send_hello_world") {
    const data = await graph(`${REVIEW_SANDBOX.phoneId}/messages`, {
      messaging_product: "whatsapp", to: REVIEW_SANDBOX.recipient,
      type: "template", template: { name: "hello_world", language: { code: "en_US" } },
    });
    const result = safeBody(data, action);
    if ([token, env.WHATSAPP_APP_SECRET].some(s => JSON.stringify(result).includes(s))) throw new ReviewToolsError("unexpected_meta_response", { uncertain: true });
    return result;
  }
  const name = `newme_review_enquiry_${requestId.toLowerCase().replaceAll("-", "")}`;
  const data = await graph(`${REVIEW_SANDBOX.wabaId}/message_templates`, {
    name, language: "en_US", category: "UTILITY",
    components: [{ type: "BODY", text: REVIEW_TEMPLATE_BODY }],
  });
  return { ...safeBody(data, action), template_name: name };
}

// Bounded process-local replay cache. Unknown mutation outcomes are retained too.
// It is intentionally a test tool, not a production delivery queue.
const attempts = new Map();
export async function runReviewAttempt(actor, action, requestId, work, now = Date.now()) {
  requestId = requestId.toLowerCase();
  for (const [id, item] of attempts) if (now - item.at > 24 * 3_600_000 && item.settled) attempts.delete(id);
  const existing = attempts.get(requestId);
  if (existing) {
    if (existing.actor !== actor || existing.action !== action) throw new ReviewToolsError("request_id_conflict", { status: 409 });
    return existing.promise;
  }
  if (attempts.size >= 128) throw new ReviewToolsError("review_capacity_reached", { status: 429 });
  const item = { actor, action, at: now, settled: false };
  item.promise = Promise.resolve().then(work).finally(() => { item.settled = true; });
  attempts.set(requestId, item);
  return item.promise;
}
