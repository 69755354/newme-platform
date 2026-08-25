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
  if (!values || values.length > 12) return undefined;
  const normalized = values.map((value) => typeof value === "string" ? value.trim() : "");
  if (normalized.some((value) => !value || value.length > 80)) return undefined;
  return [...new Set(normalized)];
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
  const location = optionalText(body, ["area", "location"], 120);
  const propertyType = optionalText(body, ["type", "property_type"], 80);
  const floors = optionalText(body, ["floors"], 30);
  const message = optionalText(body, ["message", "notes"], 2_000);
  const ref = optionalText(body, ["ref"], 100);
  const needs = serviceNeeds(body);
  const turnstileToken = optionalText(body, ["turnstileToken", "cf-turnstile-response"], 2_048);

  if ([name, rawPhone, email, location, propertyType, floors, message, ref, needs, turnstileToken].some((value) => value === undefined)) {
    return { ok: false, code: "invalid_field" };
  }
  if (!name || name.length < 2) return { ok: false, code: "name_required" };
  if (rawPhone && phone === undefined) return { ok: false, code: "invalid_phone" };
  if (email && !EMAIL.test(email)) return { ok: false, code: "invalid_email" };
  if (!phone && !email) return { ok: false, code: "contact_required" };

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
    },
  };
}
