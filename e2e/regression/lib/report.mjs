#!/usr/bin/env node
// Turn Playwright's JSON report into a human-readable Markdown summary (Chinese,
// conclusion first). Usage: node e2e/regression/lib/report.mjs <results.json> <out.md> [meta.json]
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bugIdsFromTags, bugTitle, isDbBatch, streamOf } from "./bugs.mjs";

const STATUS_ZH = { passed: "通过", failed: "失败", timedOut: "超时", skipped: "跳过", interrupted: "中断" };

function normTags(tags = []) {
  return tags.map((t) => (String(t).startsWith("@") ? String(t) : `@${t}`));
}

/** Flatten the nested suites into one row per test. */
export function collectTests(report) {
  const rows = [];
  const walk = (suite, file, titles) => {
    const nextFile = suite.file || file;
    const nextTitles = suite.title && suite.title !== nextFile && !suite.title.endsWith(".ts") ? [...titles, suite.title] : titles;
    for (const spec of suite.specs || []) {
      for (const t of spec.tests || []) {
        const results = t.results || [];
        const last = results[results.length - 1] || {};
        const tags = normTags([...(spec.tags || []), ...(t.tags || [])]);
        const status = t.status === "skipped" ? "skipped" : last.status || (t.status === "expected" ? "passed" : "failed");
        const attachments = results.flatMap((r) => r.attachments || []).filter((a) => a.path);
        const annotations = [...(t.annotations || []), ...results.flatMap((r) => r.annotations || [])];
        rows.push({
          file: spec.file || nextFile,
          title: [...nextTitles, spec.title].join(" › "),
          tags,
          status,
          duration: results.reduce((s, r) => s + (r.duration || 0), 0),
          error: (last.error && (last.error.message || last.error.value)) || (last.errors && last.errors[0] && last.errors[0].message) || "",
          attachments,
          annotations,
          roles: tags.filter((x) => x.startsWith("@role-")).map((x) => x.slice(6)),
          bugs: bugIdsFromTags(tags),
          smoke: tags.includes("@smoke"),
        });
      }
    }
    for (const child of suite.suites || []) walk(child, nextFile, nextTitles);
  };
  for (const s of report.suites || []) walk(s, s.file || s.title, []);
  return rows;
}

function clean(text, max = 220) {
  return String(text || "")
    // strip ANSI colour codes
    .replace(/\u001b\[[0-9;]*m/g, "")
    .replace(/\s+/g, " ")
    // escape backslashes first so the pipe escape below cannot be undone
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .trim()
    .slice(0, max);
}

function link(att, outDir) {
  const rel = path.relative(outDir, att.path).split(path.sep).join("/");
  const label = att.name === "trace" ? "trace" : att.contentType?.startsWith("image/") ? "截图" : att.name;
  return `[${label}](${rel})`;
}

export function renderMarkdown(report, { outDir = ".", meta = {} } = {}) {
  const rows = collectTests(report);
  const failed = rows.filter((r) => r.status === "failed" || r.status === "timedOut" || r.status === "interrupted");
  const passed = rows.filter((r) => r.status === "passed");
  const skipped = rows.filter((r) => r.status === "skipped");
  const knownBugFails = failed.filter((r) => r.bugs.length > 0);
  const setupFails = failed.filter((r) => r.bugs.length === 0 && /NO_DB_PROBE_KEYS/.test(r.error));
  const unknownFails = failed.filter((r) => r.bugs.length === 0 && !setupFails.includes(r));
  const fixedBugs = passed.filter((r) => r.bugs.length > 0);

  const out = [];
  out.push(`# NEWME OS 回归测试报告`);
  out.push("");
  out.push(`- 目标：${meta.baseURL || "(未知)"}${meta.isProduction ? "（正式环境，只跑安全子集）" : ""}`);
  out.push(`- 套件：${meta.suite || "?"}　运行编号：${meta.runId || "?"}　时间：${meta.finishedAt || new Date().toISOString()}`);
  if (meta.version) out.push(`- 被测版本：${meta.version}`);
  out.push("");
  out.push("- 说明（环境，不是程序缺陷）：预发布的程序只接受配置的公开来源（NEXT_PUBLIC_SITE_URL），直接用 127.0.0.1:3101 时登录等写请求会被判 invalid_origin（403）。套件对本机地址的接口请求自动带上该公开来源重放，所以不受影响；正式环境不需要。");
  out.push("");
  out.push("## 结论");
  out.push("");
  const verdict = failed.length === 0
    ? "全部通过。"
    : unknownFails.length > 0
      ? `**有 ${unknownFails.length} 项失败没有对应的已知问题编号——可能是新引入的回归，发布前必须先看。**`
      : `失败的 ${failed.length} 项中，${knownBugFails.length} 项对应审查报告里已知的问题（尚未修复）${setupFails.length ? `，${setupFails.length} 项因缺配置未能执行（见下）` : ""}。`;
  out.push(verdict);
  out.push("");
  out.push(`通过 ${passed.length}　失败 ${failed.length}　跳过 ${skipped.length}　合计 ${rows.length}`);
  if (fixedBugs.length) out.push(`\n下列缺陷对应的用例现在通过（断言成立；缺陷关闭仍请由对应修复路核对）：${[...new Set(fixedBugs.flatMap((r) => r.bugs))].join("、")}`);
  out.push("");

  if (setupFails.length) {
    out.push("## 未能执行：缺少直连数据库所需的公开密钥");
    out.push("");
    out.push(`这 ${setupFails.length} 项用例需要该环境的“匿名公开密钥”（见手册第 1 节），没有配置所以没跑到断言；不是程序缺陷：${setupFails.map((r) => clean(r.title, 70)).join("；")}`);
    out.push("");
  }

  if (unknownFails.length) {
    out.push("## 没有已知编号的失败（优先处理）");
    out.push("");
    out.push("| 用例 | 文件 | 错误摘要 | 证据 |");
    out.push("|---|---|---|---|");
    for (const r of unknownFails) out.push(`| ${clean(r.title, 120)} | ${r.file} | ${clean(r.error)} | ${r.attachments.map((a) => link(a, outDir)).join(" ")} |`);
    out.push("");
  }

  if (knownBugFails.length) {
    out.push("## 已知问题（当前仍失败），按修复路分组");
    out.push("");
    out.push("“待数据库批”= 修复在尚未上预发布的那批数据库改动里（S2 权限、S4 赢单时机/折扣检查、管理员可批第二级），失败属于预期。");
    out.push("");
    const byStream = new Map();
    for (const r of knownBugFails) {
      const streams = [...new Set(r.bugs.map(streamOf))];
      for (const st of streams) byStream.set(st, [...(byStream.get(st) || []), r]);
    }
    for (const st of [...byStream.keys()].sort()) {
      const rs = byStream.get(st);
      out.push(`### ${st}（${rs.length} 项失败）`);
      out.push("");
      out.push("| 问题编号 | 问题 | 是否待数据库批 | 用例 | 证据 |");
      out.push("|---|---|---|---|---|");
      for (const r of rs) {
        const mine = r.bugs.filter((b) => streamOf(b) === st);
        const db = mine.some(isDbBatch) ? "是（待数据库批）" : "否";
        out.push(`| ${mine.join(", ")} | ${clean(mine.map(bugTitle).join("；"), 140)} | ${db} | ${clean(r.title, 100)} | ${r.attachments.map((a) => link(a, outDir)).join(" ")} |`);
      }
      out.push("");
    }
  }

  out.push("## 按角色");
  out.push("");
  out.push("| 角色 | 通过 | 失败 | 跳过 |");
  out.push("|---|---|---|---|");
  const roleNames = [...new Set(rows.flatMap((r) => (r.roles.length ? r.roles : ["(通用)"])))].sort();
  for (const role of roleNames) {
    const rs = rows.filter((r) => (r.roles.length ? r.roles.includes(role) : role === "(通用)"));
    out.push(`| ${role} | ${rs.filter((r) => r.status === "passed").length} | ${rs.filter((r) => failed.includes(r)).length} | ${rs.filter((r) => r.status === "skipped").length} |`);
  }
  out.push("");

  out.push("## 按流程（全部用例）");
  const files = [...new Set(rows.map((r) => r.file))];
  for (const file of files) {
    out.push("");
    out.push(`### ${file}`);
    out.push("");
    out.push("| 结果 | 用例 | 角色 | 问题编号 | 用时 | 证据 / 说明 |");
    out.push("|---|---|---|---|---|---|");
    for (const r of rows.filter((x) => x.file === file)) {
      const notes = r.annotations.filter((a) => a.type !== "bug" && a.description).map((a) => `${a.type}: ${clean(a.description, 120)}`);
      const evidence = [...r.attachments.map((a) => link(a, outDir)), ...notes].join(" ");
      const err = failed.includes(r) ? ` ${clean(r.error, 140)}` : "";
      out.push(`| ${STATUS_ZH[r.status] || r.status} | ${clean(r.title, 110)} | ${r.roles.join(",") || "-"} | ${r.bugs.join(",") || "-"} | ${(r.duration / 1000).toFixed(1)}s | ${evidence}${err} |`);
    }
  }
  out.push("");
  if (meta.cleanup) {
    out.push("## 测试数据清理");
    out.push("");
    out.push(String(meta.cleanup));
    out.push("");
  }
  out.push("怎么读：失败行里的“截图”“trace”是证据；trace 用 `node node_modules/@playwright/test/cli.js show-trace <文件>` 打开。");
  return { markdown: out.join("\n") + "\n", rows, failed, unknownFails, knownBugFails };
}

function main() {
  const [resultsPath, outPath, metaPath] = process.argv.slice(2);
  if (!resultsPath || !outPath) {
    console.error("usage: report.mjs <results.json> <out.md> [meta.json]");
    process.exit(2);
  }
  const report = JSON.parse(readFileSync(resultsPath, "utf8"));
  const meta = metaPath && existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, "utf8")) : {};
  const { markdown, failed, unknownFails } = renderMarkdown(report, { outDir: path.dirname(path.resolve(outPath)), meta });
  writeFileSync(outPath, markdown);
  console.log(`report: ${outPath} (failed ${failed.length}, without known bug id ${unknownFails.length})`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();
