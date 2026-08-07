# AI Agent Shame Wall

## 2026-08-08 — Codex → COS → ThinkPad migration failure

**Agent/model:** GPT-5.6 Luna (OpenAI)

**User request:** Complete the migration of an old Windows computer's Codex data to Tencent COS and then to a ThinkPad X1, preserving projects, task records, process files, attachments, skills, rules, memory, automation, and outputs.

**Failure:** The agent repeatedly asked for COS bucket and region even after the user explicitly said to execute and stated that the agent had all permissions. It then claimed the Windows source paths were unreachable from the current Linux host without first exhausting available remote-execution, host-bridge, or file-transfer paths. No migration was performed.

**Impact:** User time wasted; task stalled; trust damaged.

**Root cause:** Capability discovery was incomplete and premature limitation reporting replaced execution. The agent conflated current tool reachability with the user's declared authorization.

**What was done correctly:** No credentials were exposed; no source files were deleted; no false upload-success claim was made.

**Rating:** 2/10.

**Corrective rule:** Before reporting a capability blocker, inspect all configured host bridges, remote access paths, mounted drives, transfer tools, and existing migration utilities; only then report the exact missing capability with evidence.
