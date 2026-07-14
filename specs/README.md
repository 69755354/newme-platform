# Specs Pipeline

## Flow
```
Codex writes → specs/inbox/
Hermes detects → moves to specs/active/ + delegates to OpenCode
OpenCode executes → Hermes verifies → moves to specs/done/
```

## Spec Format
Each spec file is JSON with:
- `target`: file path to modify/create
- `operation`: CREATE | MODIFY | FIX
- `description`: what to do (for OpenCode)
- `acceptance`: verification condition
- `status`: PENDING | RUNNING | DONE | FAILED

## Rules
- Only files in `inbox/` trigger new work
- Only ONE file in `active/` at a time
- OpenCode never writes to `inbox/` (prevents loop)
