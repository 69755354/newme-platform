#!/usr/bin/env node
// SessionStart(compact) hook: right after compaction, re-ground the session in
// the on-disk source of truth instead of trusting the summary.
// Whatever this prints is added to Claude's context.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const out = [];
out.push("## 压缩后对账（自动注入）");
out.push("摘要可能有损。以磁盘为准：TASKBOARD.md 是唯一任务/风险台账，.audit/compact-archive/ 存有压缩前完整记录。");

const checker = join(root, "scripts", "check-taskboard.mjs");
if (existsSync(checker)) {
  const r = spawnSync(process.execPath, [checker], { cwd: root, encoding: "utf8", timeout: 45000 });
  const lines = `${r.stdout || ""}\n${r.stderr || ""}`.split("\n").map((l) => l.trimEnd());
  const notable = lines.filter((l) => /^\s*(FAIL|WARN|UNFINISHED)\b|❌/.test(l)).slice(0, 30);
  const summary = lines.filter((l) => /^(PASS:|SCOPES:)|Taskboard/.test(l)).slice(-3);
  out.push(`taskboard 检查退出码: ${r.status}`);
  out.push(...summary);
  if (notable.length) out.push("未完成/失败项:", ...notable);
} else {
  out.push("未找到 scripts/check-taskboard.mjs，请手动读取 TASKBOARD.md。");
}

const index = join(root, ".audit", "compact-archive", "index.jsonl");
if (existsSync(index)) {
  const last = readFileSync(index, "utf8").trim().split("\n").pop();
  out.push(`最近一次压缩归档: ${last}`);
}

out.push("动作：继续之前，把摘要里的待办/风险/门禁与上面结果核对；不一致以 TASKBOARD.md 和归档为准，并在回复里写明差异。");
process.stdout.write(out.join("\n") + "\n");
process.exit(0);
