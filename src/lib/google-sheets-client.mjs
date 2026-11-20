// Zero-dependency Google Sheets client for a service account (generalised from tools/gsheet.mjs).
// Retries 429/5xx and network errors with jittered backoff, counts requests against a per-run budget and
// never logs the key, the token or response bodies. fetch/sleep/clock are injectable for tests.
import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";
import { SyncError, backoffDelayMs, isRetryableStatus, retryAfterMs } from "./os-drive-sync.mjs";

const SCOPE = "https://www.googleapis.com/auth/spreadsheets";
const b64 = (o) => Buffer.from(typeof o === "string" ? o : JSON.stringify(o)).toString("base64url");

export function loadServiceAccount(path) {
  const sa = JSON.parse(readFileSync(path, "utf8"));
  if (!sa.client_email || !sa.private_key || !sa.token_uri) throw new SyncError("sa_invalid", "service account file is missing fields");
  return sa;
}

export function createSheetsClient({ serviceAccount, fetchImpl = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  now = () => Date.now(), rand = Math.random, maxRequests = 40, maxAttempts = 5, log = () => {} } = {}) {
  let tokenValue = null; let tokenExpires = 0; let requests = 0;

  // idempotent=false (append): a network error or 5xx may have landed on the sheet, so only 429 (never processed) is retried
  async function raw(url, init, label, idempotent = true) {
    for (let attempt = 0; ; attempt++) {
      if (requests >= maxRequests) throw new SyncError("request_budget", `request budget of ${maxRequests} reached`);
      requests++;
      let res = null; let failure = null;
      try { res = await fetchImpl(url, init); } catch { failure = "network"; }
      if (res && res.ok) return res;
      const status = res ? res.status : 0;
      const retry = idempotent ? (failure === "network" || isRetryableStatus(status)) : status === 429;
      if (!retry || attempt + 1 >= maxAttempts) throw new SyncError(`http_${status || "network"}`, `${label} failed (HTTP ${status || "network error"})`);
      const wait = Math.max(retryAfterMs(res?.headers?.get?.("retry-after"), now()) ?? 0, backoffDelayMs(attempt, { rand }));
      log(`retry ${label} after ${wait}ms (HTTP ${status || "network"})`);
      await sleep(wait);
    }
  }

  async function token() {
    if (tokenValue && now() < tokenExpires - 60_000) return tokenValue;
    const iat = Math.floor(now() / 1000);
    const head = b64({ alg: "RS256", typ: "JWT" });
    const claim = b64({ iss: serviceAccount.client_email, scope: SCOPE, aud: serviceAccount.token_uri, iat, exp: iat + 3000 });
    const sig = createSign("RSA-SHA256").update(`${head}.${claim}`).sign(serviceAccount.private_key, "base64url");
    const res = await raw(serviceAccount.token_uri, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${head}.${claim}.${sig}` }) }, "token");
    const body = await res.json();
    if (!body.access_token) throw new SyncError("token_missing", "token response had no access_token");
    tokenValue = body.access_token; tokenExpires = now() + 3000_000;
    return tokenValue;
  }

  const api = async (path, { method = "GET", body, query = "", idempotent = true } = {}, label = "sheets") => {
    const t = await token();
    const res = await raw(`https://sheets.googleapis.com/v4/spreadsheets/${path}${query}`,
      { method, headers: { authorization: `Bearer ${t}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }, label, idempotent);
    return res.json();
  };
  const enc = encodeURIComponent;

  return {
    get requestCount() { return requests; },
    async getFirstSheetTitle(id) {
      const meta = await api(`${id}`, { query: "?fields=sheets.properties.title" }, "get title");
      const title = meta.sheets?.[0]?.properties?.title;
      if (!title) throw new SyncError("no_sheet", "spreadsheet has no tabs");
      return title;
    },
    async getSheetId(id, title) {
      const meta = await api(`${id}`, { query: "?fields=sheets.properties(sheetId,title)" }, "get sheet id");
      const sheet = (meta.sheets ?? []).find((x) => x.properties?.title === title);
      if (!sheet) throw new SyncError("no_sheet", "tab not found");
      return sheet.properties.sheetId;
    },
    /** One batchUpdate: value + background + note of each cell in the same request. See guardSheets for what is allowed. */
    async batchUpdateCells(id, tab, ops) {
      if (!ops.length) return {};
      const sheetId = await this.getSheetId(id, tab);
      const requests = ops.map((o) => {
        if (o.kind === "rowbg") {
          return { repeatCell: { range: { sheetId, startRowIndex: o.row - 1, endRowIndex: o.row, startColumnIndex: o.c1, endColumnIndex: o.c2 + 1 },
            cell: { userEnteredFormat: { backgroundColor: o.bg } }, fields: "userEnteredFormat.backgroundColor" } };
        }
        const cellData = {}; const fields = [];
        if (o.value !== undefined) { cellData.userEnteredValue = { stringValue: String(o.value) }; fields.push("userEnteredValue"); }
        if (o.bg) { cellData.userEnteredFormat = { backgroundColor: o.bg }; fields.push("userEnteredFormat.backgroundColor"); }
        if (o.note !== undefined) { cellData.note = o.note; fields.push("note"); }
        return { updateCells: { rows: [{ values: [cellData] }], fields: fields.join(","), start: { sheetId, rowIndex: o.row - 1, columnIndex: o.col } } };
      });
      return api(`${id}:batchUpdate`, { method: "POST", body: { requests } }, "format update");
    },
    /** Value, background and note of single cells, in the order asked. ranges are single-cell A1 strings. */
    async getCells(id, ranges) {
      const out = [];
      for (let i = 0; i < ranges.length; i += 40) {
        const part = ranges.slice(i, i + 40);
        const q = `?fields=${enc("sheets.data.rowData.values(formattedValue,userEnteredFormat.backgroundColor,note)")}&${part.map((r) => `ranges=${enc(r)}`).join("&")}`;
        const r = await api(`${id}`, { query: q }, "get cells");
        const data = r.sheets?.[0]?.data ?? [];
        part.forEach((_, k) => {
          const c = data[k]?.rowData?.[0]?.values?.[0] ?? {};
          out.push({ value: c.formattedValue ?? "", bg: c.userEnteredFormat?.backgroundColor ?? null, note: c.note ?? "" });
        });
      }
      return out;
    },
    async getValues(id, range) {
      const r = await api(`${id}/values/${enc(range)}`, { query: "?majorDimension=ROWS" }, "get values");
      return r.values ?? [];
    },
    async batchGetValues(id, ranges) {
      const q = `?majorDimension=ROWS&${ranges.map((r) => `ranges=${enc(r)}`).join("&")}`;
      const r = await api(`${id}/values:batchGet`, { query: q }, "batch get");
      return (r.valueRanges ?? []).map((v) => v.values ?? []);
    },
    async batchUpdateValues(id, data) {
      if (!data.length) return { totalUpdatedCells: 0 };
      return api(`${id}/values:batchUpdate`, { method: "POST", body: { valueInputOption: "RAW", data: data.map((d) => ({ range: d.range, majorDimension: "ROWS", values: d.values })) } }, "batch update");
    },
    async appendValues(id, range, values) {
      if (!values.length) return { updates: {} };
      return api(`${id}/values/${enc(range)}:append`, { method: "POST", query: "?valueInputOption=RAW&insertDataOption=INSERT_ROWS", body: { majorDimension: "ROWS", values }, idempotent: false }, "append");
    },
  };
}
