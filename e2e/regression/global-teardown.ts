// Cleans up everything this run created, through the app's own APIs (signed in as
// the QA admin), and records what could not be removed. Never runs on production
// (nothing is created there; the smoke journey reverts its own edits).
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { chromium, type FullConfig } from "@playwright/test";
import { isMetaTraffic, publicOriginFor, resolveTarget } from "./lib/target.mjs";
import { authStatePath } from "./lib/paths";
import { restCoordsFromCookies, type RestCoords } from "./lib/restcoords";

interface Rec {
  kind: string;
  id: string;
  label?: string;
}

export default async function globalTeardown(config: FullConfig) {
  const target = resolveTarget(process.env);
  const runDir = process.env.E2E_RUN_DIR as string;
  const metaFile = path.join(runDir, "meta.json");
  const meta = existsSync(metaFile) ? JSON.parse(readFileSync(metaFile, "utf8")) : {};
  meta.finishedAt = new Date().toISOString();
  const lines: string[] = [];

  if (target.isProduction || process.env.E2E_SKIP_CLEANUP === "1") {
    lines.push(target.isProduction ? "正式环境：本次未创建任何数据（冒烟旅程会自行还原标记线索）。" : "按 E2E_SKIP_CLEANUP=1 跳过清理。");
    meta.cleanup = lines.join("\n");
    writeFileSync(metaFile, JSON.stringify(meta, null, 2));
    return;
  }

  const regFile = path.join(runDir, "created.jsonl");
  const recs: Rec[] = existsSync(regFile)
    ? readFileSync(regFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Rec)
    : [];

  const use = config.projects[0]?.use ?? {};
  const browser = await chromium.launch({ headless: true, ...(use.launchOptions ?? {}) });
  try {
    const ctx = await browser.newContext({ baseURL: target.baseURL, storageState: authStatePath(target.baseURL, "admin"), ignoreHTTPSErrors: true });
    await ctx.route((u) => isMetaTraffic(u.href), (r) => r.abort());
    const publicOrigin = publicOriginFor(target.baseURL);
    if (publicOrigin) {
      await ctx.route(/\/api\//, async (route) => {
        const headers = route.request().headers();
        if (!headers.origin) return route.continue();
        const response = await route.fetch({ headers: { ...headers, origin: publicOrigin } });
        return route.fulfill({ response });
      });
    }
    const page = await ctx.newPage();
    await page.goto("/leads", { waitUntil: "networkidle" }).catch(() => undefined);

    const call = (method: string, url: string, body?: unknown) =>
      page.evaluate(
        async ([m, u, b]) => {
          const r = await fetch(u as string, { method: m as string, headers: { "Content-Type": "application/json" }, body: b === undefined ? undefined : JSON.stringify(b) });
          return { status: r.status, text: (await r.text()).slice(0, 300) };
        },
        [method, url, body] as const,
      );
    const restCall = async (method: string, p: string): Promise<{ status: number; text: string }> => {
      let rc: RestCoords;
      try {
        rc = restCoordsFromCookies(await ctx.cookies(), false);
      } catch (e) {
        return { status: 0, text: String((e as Error).message).slice(0, 100) };
      }
      return page.evaluate(
        async ([base, k, a, m, q]) => {
          const r = await fetch(`${base}/rest/v1/${q}`, { method: m as string, headers: { apikey: k as string, Authorization: a as string, Prefer: "return=representation" } });
          return { status: r.status, text: (await r.text()).slice(0, 300) };
        },
        [rc.url, rc.apikey, rc.authorization, method, p] as const,
      );
    };

    // Sweep by name as a safety net for anything the registry missed.
    const prefix = process.env.E2E_CLEANUP_ALL_E2E === "1" ? "E2E-" : `E2E-${target.runId}`;
    const list = await call("GET", "/api/leads/list");
    try {
      const leads = (JSON.parse(list.text.length >= 300 ? (await page.evaluate(async () => (await fetch("/api/leads/list")).text())) : list.text).leads ?? []) as Array<{ id: string; customer_name: string | null }>;
      for (const l of leads) {
        if ((l.customer_name ?? "").startsWith(prefix) && !(l.customer_name ?? "").startsWith("E2E-SMOKE") && !recs.some((r) => r.id === l.id)) {
          recs.push({ kind: "lead", id: l.id, label: l.customer_name ?? "" });
        }
      }
    } catch {
      lines.push("- 按名称补扫线索失败（列表接口不可读）。");
    }

    const order = ["payment", "contract", "quotation", "product", "lead", "user"];
    recs.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
    const leftovers: string[] = [];
    const notes: string[] = [];
    let ok = 0;
    for (const r of recs) {
      let res: { status: number; text: string };
      switch (r.kind) {
        case "payment":
          res = await call("POST", `/api/payments/${r.id}/void`, { reason: `E2E cleanup ${target.runId}`, idempotencyKey: randomUUID() });
          break;
        case "contract":
          res = await call("PATCH", `/api/contracts/${r.id}`, { status: "terminated", reason: `E2E cleanup ${target.runId}` });
          if (res.status >= 300) {
            // Draft / pending contracts have no terminate transition and no delete API: they go away with the next staging data reset.
            res = { status: 200, text: `left in place (no API removes a ${res.status === 500 ? "draft" : "non-terminable"} contract); cleared by the next staging reset` };
            notes.push(`- 合同 ${r.id} 无接口可删除（草稿/审批中），保留，预发布下次重置数据时清除`);
          }
          break;
        case "quotation":
          res = await restCall("DELETE", `quotations?id=eq.${r.id}`);
          break;
        case "product":
          res = await restCall("DELETE", `products?id=eq.${r.id}`);
          break;
        case "lead": {
          res = await call("POST", `/api/leads/${r.id}/delete`, { idempotencyKey: randomUUID() });
          if (res.status !== 200) {
            const archived = await call("POST", "/api/leads/archive", { lead_ids: [r.id], archive_reason: `E2E cleanup ${target.runId}` });
            res = archived.status === 200 ? { status: 200, text: "archived (delete blocked)" } : res;
          }
          break;
        }
        case "user":
          res = await call("DELETE", `/api/users/${r.id}`, { transferTo: "unassigned", batchKey: randomUUID() });
          break;
        default:
          res = { status: 0, text: "unknown kind" };
      }
      if (res.status >= 200 && res.status < 300) ok += 1;
      else leftovers.push(`- ${r.kind} ${r.id} ${r.label ?? ""}: HTTP ${res.status} ${res.text.replace(/\s+/g, " ").slice(0, 120)}`);
    }
    lines.push(`已清理 ${ok}/${recs.length} 条本次创建的记录（线索优先删除，删除被拦时改为归档；合同改为终止；收款作废；临时账号停用）。`);
    lines.push(...notes);
    if (leftovers.length) {
      lines.push("未能清理（需人工处理）：");
      lines.push(...leftovers);
    }
    await ctx.close();
  } finally {
    await browser.close();
  }
  meta.cleanup = lines.join("\n");
  writeFileSync(metaFile, JSON.stringify(meta, null, 2));
  writeFileSync(path.join(runDir, "cleanup.md"), lines.join("\n") + "\n");
}
