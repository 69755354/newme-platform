export const ORGANIZATION_CONTEXT_COOKIE = "newme-organization-id";
export const ORGANIZATION_CONTEXT_HEADER = "x-newme-organization-id";
export const SUPPORT_SESSION_HEADER = "x-newme-support-session-id";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function parseOrganizationId(value: unknown): string | null {
  return typeof value === "string" && UUID_PATTERN.test(value) ? value : null;
}

export function readCookieValue(cookieHeader: string, name: string): string | null {
  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    const key = part.slice(0, separator).trim();
    if (key !== name) continue;
    return decodeURIComponent(part.slice(separator + 1).trim());
  }
  return null;
}

export function getRequestedOrganizationId(request: Request): string | null {
  const headerValue = parseOrganizationId(
    request.headers.get(ORGANIZATION_CONTEXT_HEADER),
  );
  if (headerValue) return headerValue;
  return parseOrganizationId(
    readCookieValue(
      request.headers.get("cookie") ?? "",
      ORGANIZATION_CONTEXT_COOKIE,
    ),
  );
}

export function getBrowserOrganizationId(): string | null {
  if (typeof document === "undefined") return null;
  return parseOrganizationId(
    readCookieValue(document.cookie, ORGANIZATION_CONTEXT_COOKIE),
  );
}
