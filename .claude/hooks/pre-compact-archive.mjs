#!/usr/bin/env node
// PreCompact hook: archive the full transcript to disk before Claude Code
// summarizes it, so nothing dropped by compaction is lost.
// Archive lives in .audit/compact-archive/ (gitignored). Never blocks compaction.
import { readFileSync, mkdirSync, copyFileSync, appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";

try {
  const input = JSON.parse(readFileSync(0, "utf8") || "{}");
  const root = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
  const dir = join(root, ".audit", "compact-archive");
  mkdirSync(dir, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const session = String(input.session_id || "unknown").slice(0, 36);
  const trigger = input.trigger || "unknown"; // "manual" | "auto"
  const file = `${stamp}_${session}_${trigger}.jsonl`;

  let archived = null;
  if (input.transcript_path && existsSync(input.transcript_path)) {
    copyFileSync(input.transcript_path, join(dir, file));
    archived = file;
  }

  appendFileSync(
    join(dir, "index.jsonl"),
    JSON.stringify({
      at: new Date().toISOString(),
      session_id: input.session_id ?? null,
      trigger,
      archived,
      custom_instructions: input.custom_instructions || null,
    }) + "\n",
  );
} catch (err) {
  process.stderr.write(`pre-compact-archive: ${err?.message || err}\n`);
}
process.exit(0);
