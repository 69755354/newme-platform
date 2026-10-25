export const PUBLIC_LEAD_ORIGINS = new Set([
  "https://newme.ae",
  "https://www.newme.ae",
]);

const PHONE = /^\+?\d{7,15}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type WebsiteLeadInput = {
  customerName: string;
  phone: string | null;
  email: string | null;
  location: string | null;
  propertyType: string | null;
  serviceNeeds: string[] | null;
  notes: string | null;
  turnstileToken: string | null;
  honeypot: boolean;
  attribution: {
    eventId: string | null;
    fbclid: string | null;
    fbc: string | null;
    fbp: string | null;
    landingPage: string | null;
    referrer: string | null;
    utmSource: string | null;
    utmMedium: string | null;
    utmCampaign: string | null;
    utmContent: string | null;
    utmTerm: string | null;
    campaignId: string | null;
    campaignName: string | null;
    adsetId: string | null;
    adsetName: string | null;
    adId: string | null;
    adName: string | null;
  };
};

export type WebsiteLeadParseResult =
  | { ok: true; value: WebsiteLeadInput }
  | { ok: false; code: string };

function optionalText(
  input: Record<string, unknown>,
  keys: string[],
  maxLength: number,
): string | null | undefined {
  for (const key of keys) {
    if (!Object.hasOwn(input, key)) continue;
    const value = input[key];
    if (value === null || value === undefined || value === "") return null;
    if (typeof value !== "string") return undefined;
    const normalized = value.trim();
    if (normalized.length > maxLength) return undefined;
    return normalized || null;
  }
  return null;
}

// Free-text fields must never cost us the inquiry itself: an
// over-long value (the bridge appends attribution to
// the message) is truncated instead of rejecting the whole lead. Numbers are
// accepted as text. Contact fields keep the strict optionalText rules.
function lenientText(
  input: Record<string, unknown>,
  keys: string[],
  maxLength: number,
): string | null | undefined {
  for (const key of keys) {
    if (!Object.hasOwn(input, key)) continue;
    const value = input[key];
    if (value === null || value === undefined || value === "") return null;
    if (typeof value === "number" && Number.isFinite(value)) return String(value).slice(0, maxLength);
    if (typeof value !== "string") return undefined;
    const normalized = value.trim().slice(0, maxLength).trim();
    return normalized || null;
  }
  return null;
}

// Attribution identifiers are opaque: shortening one produces a different ID.
// Omit an overlong optional identifier while retaining the customer inquiry.
function attributionIdentifier(
  input: Record<string, unknown>,
  keys: string[],
  maxLength: number,
): string | null | undefined {
  const value = optionalText(input, keys, maxLength);
  if (value !== undefined) return value;
  for (const key of keys) {
    if (!Object.hasOwn(input, key)) continue;
    return typeof input[key] === "string" ? null : undefined;
  }
  return null;
}

function normalizePhone(value: string | null | undefined): string | null | undefined {
  if (!value) return null;
  let normalized = value.replace(/[\s().-]/g, "");
  if (normalized.startsWith("00")) normalized = `+${normalized.slice(2)}`;
  return PHONE.test(normalized) ? normalized : undefined;
}

function serviceNeeds(input: Record<string, unknown>): string[] | null | undefined {
  if (!Object.hasOwn(input, "systems")) return null;
  const raw = input.systems;
  const values = Array.isArray(raw)
    ? raw
    : typeof raw === "string"
      ? raw.split(",")
      : null;
  if (!values) return undefined;
  const normalized = values
    .map((value) => typeof value === "string" ? value.trim() : "")
    .filter((value) => value && value.length <= 80)
    .slice(0, 12);
  return normalized.length ? [...new Set(normalized)] : null;
}

export function isAllowedPublicLeadOrigin(origin: string | null): boolean {
  if (!origin) return false;
  try {
    return PUBLIC_LEAD_ORIGINS.has(new URL(origin).origin);
  } catch {
    return false;
  }
}

export function publicLeadCorsHeaders(origin: string | null): HeadersInit {
  const headers: Record<string, string> = {
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Max-Age": "600",
    "Cache-Control": "no-store, max-age=0",
    Vary: "Origin",
  };
  if (isAllowedPublicLeadOrigin(origin)) {
    headers["Access-Control-Allow-Origin"] = new URL(origin!).origin;
  }
  return headers;
}

export function parseWebsiteLead(input: unknown): WebsiteLeadParseResult {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, code: "invalid_body" };
  }
  const body = input as Record<string, unknown>;
  const company = optionalText(body, ["company", "website"], 200);
  if (company === undefined) return { ok: false, code: "invalid_body" };

  const name = optionalText(body, ["name", "customer_name"], 100);
  const rawPhone = optionalText(body, ["phone", "whatsapp"], 40);
  const phone = normalizePhone(rawPhone);
  const email = optionalText(body, ["email"], 254);
  const location = lenientText(body, ["area", "location"], 120);
  const propertyType = lenientText(body, ["type", "property_type"], 80);
  const floors = lenientText(body, ["floors"], 30);
  const message = lenientText(body, ["message", "notes"], 2_000);
  const ref = lenientText(body, ["ref"], 100);
  const needs = serviceNeeds(body);
  const turnstileToken = optionalText(body, ["turnstileToken", "cf-turnstile-response"], 2_048);
  const eventId = optionalText(body, ["event_id"], 100);
  const fbclid = attributionIdentifier(body, ["fbclid"], 500);
  const fbc = attributionIdentifier(body, ["fbc"], 500);
  const fbp = attributionIdentifier(body, ["fbp"], 500);
  const landingPage = lenientText(body, ["landing_page"], 2_048);
  const referrer = lenientText(body, ["referrer"], 2_048);
  const utmSource = lenientText(body, ["utm_source"], 200);
  const utmMedium = lenientText(body, ["utm_medium"], 200);
  const utmCampaign = lenientText(body, ["utm_campaign"], 300);
  const utmContent = lenientText(body, ["utm_content"], 300);
  const utmTerm = lenientText(body, ["utm_term"], 300);
  const campaignId = attributionIdentifier(body, ["campaign_id"], 100);
  const campaignName = lenientText(body, ["campaign_name"], 300);
  const adsetId = attributionIdentifier(body, ["adset_id"], 100);
  const adsetName = lenientText(body, ["adset_name"], 300);
  const adId = attributionIdentifier(body, ["ad_id"], 100);
  const adName = lenientText(body, ["ad_name"], 300);

  if ([name, rawPhone, email, location, propertyType, floors, message, ref, needs, turnstileToken,
    eventId, fbclid, fbc, fbp, landingPage, referrer, utmSource, utmMedium, utmCampaign,
    utmContent, utmTerm, campaignId, campaignName, adsetId, adsetName, adId, adName,
  ].some((value) => value === undefined)) {
    return { ok: false, code: "invalid_field" };
  }
  if (!name || name.length < 2) return { ok: false, code: "name_required" };
  if (rawPhone && phone === undefined) return { ok: false, code: "invalid_phone" };
  if (email && !EMAIL.test(email)) return { ok: false, code: "invalid_email" };
  if (!phone && !email) return { ok: false, code: "contact_required" };
  if (!eventId && !company) return { ok: false, code: "event_id_required" };

  const noteParts = [
    message ? `Message: ${message}` : null,
    floors ? `Floors: ${floors}` : null,
    ref ? `Website reference: ${ref}` : null,
  ].filter((value): value is string => Boolean(value));

  return {
    ok: true,
    value: {
      customerName: name,
      phone: phone ?? null,
      email: email ?? null,
      location: location ?? null,
      propertyType: propertyType ?? null,
      serviceNeeds: needs ?? null,
      notes: noteParts.length ? noteParts.join("\n") : null,
      turnstileToken: turnstileToken ?? null,
      honeypot: Boolean(company),
      attribution: {
        eventId: eventId ?? null,
        fbclid: fbclid ?? null,
        fbc: fbc ?? null,
        fbp: fbp ?? null,
        landingPage: landingPage ?? null,
        referrer: referrer ?? null,
        utmSource: utmSource ?? null,
        utmMedium: utmMedium ?? null,
        utmCampaign: utmCampaign ?? null,
        utmContent: utmContent ?? null,
        utmTerm: utmTerm ?? null,
        campaignId: campaignId ?? null,
        campaignName: campaignName ?? null,
        adsetId: adsetId ?? null,
        adsetName: adsetName ?? null,
        adId: adId ?? null,
        adName: adName ?? null,
      },
    },
  };
}
