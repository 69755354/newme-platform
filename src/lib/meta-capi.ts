import { createHash } from "node:crypto";
import type { WebsiteLeadInput } from "@/lib/public-lead";

export type MetaCapiLead = {
  leadId: string;
  input: WebsiteLeadInput;
  clientIp: string;
  clientUserAgent: string | null;
};

export type MetaCapiPayload = {
  data: Array<{
    event_name: "Lead";
    event_time: number;
    event_id: string;
    event_source_url: string;
    action_source: "website";
    user_data: Record<string, string | string[]>;
    custom_data: {
      content_name: "Smart Home Budget Estimator";
      lead_event_source: "website";
    };
  }>;
};

const hash = (value: string) => createHash("sha256").update(value).digest("hex");

export function normalizedPhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (/^0\d{9}$/.test(digits)) return `971${digits.slice(1)}`;
  if (/^\d{9}$/.test(digits)) return `971${digits}`;
  return digits;
}

function normalizedName(name: string): string {
  return name.trim().toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

export function buildMetaCapiLeadPayload({ leadId, input, clientIp, clientUserAgent }: MetaCapiLead): MetaCapiPayload {
  const userData: Record<string, string | string[]> = {
    external_id: [hash(leadId)],
  };
  if (input.email) userData.em = [hash(input.email.trim().toLowerCase())];
  if (input.phone) userData.ph = [hash(normalizedPhone(input.phone))];
  const firstName = normalizedName(input.customerName.split(/\s+/)[0] || "");
  const lastName = normalizedName(input.customerName.split(/\s+/).slice(1).join(""));
  if (firstName) userData.fn = [hash(firstName)];
  if (lastName) userData.ln = [hash(lastName)];
  if (clientIp !== "unknown") userData.client_ip_address = clientIp;
  if (clientUserAgent) userData.client_user_agent = clientUserAgent;
  if (input.attribution.fbc) userData.fbc = input.attribution.fbc;
  if (input.attribution.fbp) userData.fbp = input.attribution.fbp;

  return {
    data: [{
      event_name: "Lead",
      event_time: Math.floor(Date.now() / 1_000),
      event_id: input.attribution.eventId || leadId,
      event_source_url: input.attribution.landingPage || "https://newme.ae/",
      action_source: "website",
      user_data: userData,
      custom_data: {
        content_name: "Smart Home Budget Estimator",
        lead_event_source: "website",
      },
    }],
  };
}

export async function sendMetaCapiPayload(payload: MetaCapiPayload): Promise<void> {
  const pixelId = process.env.META_PIXEL_ID;
  const accessToken = process.env.META_CAPI_ACCESS_TOKEN;
  if (!pixelId || !accessToken) throw new Error("Meta CAPI configuration is unavailable");
  const graphVersion = process.env.META_GRAPH_API_VERSION || "v25.0";
  const endpoint = new URL(`https://graph.facebook.com/${graphVersion}/${encodeURIComponent(pixelId)}/events`);
  endpoint.searchParams.set("access_token", accessToken);
  const result = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    cache: "no-store",
    signal: AbortSignal.timeout(5_000),
  });
  if (!result.ok) throw new Error(`Meta CAPI returned ${result.status}`);
}

export async function sendMetaCapiLead(input: MetaCapiLead): Promise<void> {
  await sendMetaCapiPayload(buildMetaCapiLeadPayload(input));
}
