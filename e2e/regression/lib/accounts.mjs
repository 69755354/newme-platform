// Parse the QA accounts file: one `role|name|email|password|user_id` per line,
// `#` comments allowed. Passwords stay inside the returned objects and are never
// part of any string this module produces (toString / toJSON redact them).
import { readFileSync } from "node:fs";

export const ROLE_KEYS = ["boss", "admin", "operator", "salesA", "salesB", "finance", "designer"];

function redacted(account) {
  Object.defineProperty(account, "password", { enumerable: false, value: account.password });
  account.toJSON = () => ({ key: account.key, role: account.role, name: account.name, email: account.email, id: account.id });
  account.toString = () => `${account.key}<${account.email}>`;
  return account;
}

export function parseAccounts(text) {
  const rows = String(text)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  /** @type {Record<string, any>} */
  const accounts = {};
  const sales = [];
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  for (const [n, line] of rows.entries()) {
    // Documented layout is role|name|email|password|user_id; the staging file is
    // tab-separated as role, email, password, name, user_id. Fields are recognised by
    // shape (email has "@", the id is a UUID), never echoed in error messages.
    const parts = line.split(/\||\t/).map((p) => p.trim());
    const emailAt = parts.findIndex((p) => p.includes("@"));
    const id = parts[parts.length - 1];
    if (parts.length < 5 || emailAt < 1 || emailAt + 1 >= parts.length - 1 || !UUID.test(id)) {
      throw new Error(`Malformed accounts line #${n + 1} (need role, name, email, password, user_id)`);
    }
    const role = parts[0];
    const email = parts[emailAt];
    const password = parts[emailAt + 1];
    const name = emailAt >= 2 ? parts[emailAt - 1] : parts[emailAt + 2] || role;
    const account = { role, name, email, password, id };
    if (role === "sales_a" || role === "sales_b") {
      accounts[role === "sales_a" ? "salesA" : "salesB"] = { ...account, role: "sales" };
    } else if (role === "sales") sales.push(account);
    else if (!accounts[role]) accounts[role] = account;
  }
  // Sales A / Sales B: prefer names ending in " A" / " B", else file order.
  const salesA = accounts.salesA || sales.find((a) => / A$/.test(a.name)) || sales[0];
  const salesB = accounts.salesB || sales.find((a) => / B$/.test(a.name) && a !== salesA) || sales.find((a) => a !== salesA);
  if (salesA) accounts.salesA = salesA;
  if (salesB) accounts.salesB = salesB;
  for (const [key, account] of Object.entries(accounts)) {
    account.key = key;
    redacted(account);
  }
  return accounts;
}

export function loadAccounts(file) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    throw new Error(`Cannot read accounts file ${file}: ${error.code || error.message}`);
  }
  return parseAccounts(text);
}

export function missingRoles(accounts, wanted = ROLE_KEYS) {
  return wanted.filter((key) => !accounts[key]);
}

/** Resolve "sales:QA Sales A" / "salesA" / "admin" to an account key. */
export function accountKeyFor(spec, accounts) {
  const s = String(spec || "").trim();
  if (accounts[s]) return s;
  const [role, name] = s.split(":");
  const hit = Object.values(accounts).find((a) => a.role === role && (!name || a.name === name));
  if (!hit) throw new Error(`No account matches "${s}"`);
  return hit.key;
}
