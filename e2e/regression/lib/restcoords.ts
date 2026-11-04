// Coordinates for direct database REST calls made with a signed-in user's own token.
// The URL comes from the session cookie name (sb-<project>-auth-token); the public anon
// key from E2E_SUPABASE_ANON_KEY or ~/.config/newme/<staging|production>-public-keys.env
// (or the file named by E2E_PUBLIC_KEYS_FILE). The anon key is public by design but is
// kept out of the repository; staging's browser bundle does not carry it.
import { readFileSync } from "node:fs";

export interface RestCoords {
  url: string;
  apikey: string;
  authorization: string;
}

export function anonKey(isProduction: boolean): string {
  if (process.env.E2E_SUPABASE_ANON_KEY) return process.env.E2E_SUPABASE_ANON_KEY;
  const file = process.env.E2E_PUBLIC_KEYS_FILE || `${process.env.HOME}/.config/newme/${isProduction ? "production" : "staging"}-public-keys.env`;
  try {
    return readFileSync(file, "utf8").match(/^E2E_SUPABASE_ANON_KEY=(.+)$/m)?.[1]?.trim() ?? "";
  } catch {
    return "";
  }
}

export function restCoordsFromCookies(cookies: Array<{ name: string; value: string }>, isProduction: boolean): RestCoords {
  const ref = cookies.map((c) => c.name.match(/^sb-([a-z0-9]+)-auth-token$/)?.[1]).find(Boolean);
  const apikey = anonKey(isProduction);
  if (!ref || !apikey) throw new Error("NO_DB_PROBE_KEYS: set E2E_SUPABASE_ANON_KEY (or E2E_PUBLIC_KEYS_FILE) for direct database probes");
  const c = cookies.find((x) => /^sb-.*-auth-token$/.test(x.name))!;
  let raw = decodeURIComponent(c.value);
  if (raw.startsWith("base64-")) raw = Buffer.from(raw.slice(7), "base64").toString("utf8");
  const parsed = JSON.parse(raw) as { access_token?: string } | string[];
  const token = Array.isArray(parsed) ? parsed[0] : parsed.access_token;
  if (!token) throw new Error("session cookie has no access token");
  return { url: `https://${ref}.supabase.co`, apikey, authorization: `Bearer ${token}` };
}

export function tokenExpiresAt(authorization: string): number {
  const payload = JSON.parse(Buffer.from(authorization.replace(/^Bearer /, "").split(".")[1], "base64url").toString("utf8")) as { exp: number };
  return payload.exp * 1000;
}
