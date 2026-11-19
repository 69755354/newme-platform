// Minimal READ-ONLY Google Sheets client for the Drive -> OS sync (S29). No dependencies.
// Scope is spreadsheets.readonly: the key can read but Google refuses every write. Only the values endpoint is used
// (one GET per tab). Key material is never printed. Own file on purpose: tools/gsheet.mjs can write and is not reused.
import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";

export const READONLY_SCOPE = "https://www.googleapis.com/auth/spreadsheets.readonly https://www.googleapis.com/auth/drive.metadata.readonly";
export const DEFAULT_SA_FILE = `${homedir()}/.config/newme/google-sheets-sa.json`;
const b64 = (o) => Buffer.from(typeof o === "string" ? o : JSON.stringify(o)).toString("base64url");

export function createSheetsReader({ saFile = process.env.GOOGLE_SA_FILE || DEFAULT_SA_FILE, fetchImpl = fetch, now = () => Date.now() } = {}) {
  let cached = null;
  async function token() {
    if (cached && cached.exp > now() + 60_000) return cached.value;
    const sa = JSON.parse(readFileSync(saFile, "utf8"));
    const iat = Math.floor(now() / 1000);
    const head = b64({ alg: "RS256", typ: "JWT" });
    const claim = b64({ iss: sa.client_email, scope: READONLY_SCOPE, aud: sa.token_uri, iat, exp: iat + 3000 });
    const sig = createSign("RSA-SHA256").update(`${head}.${claim}`).sign(sa.private_key, "base64url");
    const r = await fetchImpl(sa.token_uri, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${head}.${claim}.${sig}` }) });
    const j = await r.json();
    if (!j.access_token) throw new Error(`google token request failed (status ${r.status})`);
    cached = { value: j.access_token, exp: now() + 3_000_000 };
    return cached.value;
  }
  return {
    /** Last-modified time of the whole file (Drive metadata, read-only). null when Drive refuses. */
    async getModifiedTime(spreadsheetId) {
      try {
        const r = await fetchImpl(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(spreadsheetId)}?fields=modifiedTime&supportsAllDrives=true`, { method: "GET", headers: { authorization: `Bearer ${await token()}` } });
        if (r.status !== 200) return null;
        const t = (await r.json()).modifiedTime;
        return Number.isFinite(Date.parse(t)) ? new Date(t).toISOString() : null;
      } catch { return null; }
    },
    /** One GET: the values of one range (header row included). Never anything but GET. */
    async getValues(spreadsheetId, range) {
      const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}?valueRenderOption=FORMATTED_VALUE`;
      const r = await fetchImpl(url, { method: "GET", headers: { authorization: `Bearer ${await token()}` } });
      if (r.status !== 200) throw new Error(`sheets read failed (status ${r.status})`);
      return (await r.json()).values ?? [];
    },
  };
}
