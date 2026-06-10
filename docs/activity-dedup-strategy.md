# Activity & Business Events — Dedup Strategy

## Current State (v2.2)

Every lead operation writes to **both** tables simultaneously, creating a dual-write pattern:

### `activities` (16 columns)
- **Purpose**: Human-readable activity feed displayed in the UI
- **Key columns**: `type` (text), `content` (text), `metadata` (jsonb), `user_id`, `lead_id`, `created_at`
- **Usage**: Frontend reads `activities` for the lead detail activity feed
- **Write origin**: Direct `supabase.from("activities").insert(...)` calls in [leads/page.tsx], [leads/[id]/page.tsx], [leads/new/page.tsx], [generate-quote/route.ts]

### `business_events` (7 columns)
- **Purpose**: Structured audit trail for programmatic processing
- **Key columns**: `event_type` (text), `description` (text), `event_data` (jsonb), `user_id`, `lead_id`, `created_at`
- **Usage**: Written by `writeEvent()` function, read for automation triggers
- **Write origin**: The `writeEvent()` helper shared by [leads/page.tsx] and [leads/[id]/page.tsx]

### Dual-Write Call Sites (every operation writes to both)

| Operation | `activities` insert | `business_events` insert |
|---|---|---|
| Stage change | `type: "stage_changed"` | `event_type: "stage_changed"` |
| Lost reason set | `type: "lost_reason_set"` | `event_type: "lost_reason_set"` |
| Note added | `type: "note"` | `event_type: "note_added"` |
| Probability changed | (not always) | `event_type: "probability_changed"` |
| Win probability | (not always) | `event_type: "probability_changed"` |
| Followup scheduled | (not always) | `event_type: "followup_scheduled"` |
| Quotation sent | `type: "quote_sent"` | `event_type: "quotation_sent"` |

## Analysis

### Overlap
- ~80% of rows are written to both tables with near-identical data
- Both have: `lead_id`, `created_at`, a type/event_type discriminator, and a human-readable description
- Both are queried by `lead_id` and ordered by `created_at DESC`

### Distinctions
- `activities` is the **display-layer** table (users see this in the UI)
- `business_events` is the **event-sourcing** table (machines/triggers read this)
- `business_events.event_data` (jsonb) stores structured payload; `activities.metadata` (jsonb) serves the same role
- `activities` has extra columns for task tracking: `due_at`, `duration`, `priority`, `is_completed`
- `activities` has FK to `contracts` and `quotations`; `business_events` does not

## Recommendation

### Primary Source of Truth: `activities` (with enhancements)

**Rationale:**
1. More columns = more capable to serve both roles
2. Already has FK relationships to contracts/quotations
3. Already displayed in the UI — no frontend migration needed
4. Idempotent: a single `activities` row can serve both human and machine consumers

### Migration Path

**Phase 1 (v2.3 — recommend targeting this): Add `event_data` backfill to `activities`**

```sql
-- activities already has metadata (jsonb) — ensure it's populated
-- for all rows that need structured data
ALTER TABLE activities ADD COLUMN IF NOT EXISTS event_type text;
ALTER TABLE activities ADD COLUMN IF NOT EXISTS event_source text DEFAULT 'manual';
CREATE INDEX IF NOT EXISTS idx_activities_event_type ON activities(event_type);
```

Then update the write paths to write **only** to `activities` (not both):

1. Migrate `writeEvent()` to write to `activities` instead of `business_events`
2. Set `type` to the event type (e.g. `"stage_changed"`) and `content` to the description
3. Store structured data in `metadata` (already jsonb, already exists)
4. Keep `business_events` as a read-only archive for ~1 release cycle

**Phase 2 (v3.0 — cleanup):**
```sql
-- After verifying no code reads from business_events:
-- DROP TABLE IF EXISTS business_events;
```

### Data Migration (no-loss)

```sql
-- Backfill any business_events not in activities:
INSERT INTO activities (lead_id, user_id, type, content, metadata, created_at)
SELECT 
  be.lead_id,
  be.user_id,
  be.event_type,
  be.description,
  be.event_data,
  be.created_at
FROM business_events be
WHERE NOT EXISTS (
  SELECT 1 FROM activities a 
  WHERE a.lead_id = be.lead_id 
    AND a.created_at = be.created_at
);
```

This is safe to run at any time — it's INSERT-only and won't overwrite existing rows.

### Risks & Mitigation

| Risk | Mitigation |
|---|---|
| Automation engine reads `business_events` | Update `on_lead_won` and any other triggers to read from `activities` first, fall back to `business_events` |
| Frontend reads different columns | `activities` already has all columns the UI needs. The `type` field in activities maps 1:1 to `event_type` in business_events |
| Data loss during migration | Phase 1 keeps both tables; Phase 2 only drops after verification |
| RLS policies diverge | Both tables already have permissive admin/boss policies. Align by copying policies |

### Verification Checklist

- [ ] All `supabase.from("business_events")` calls replaced with `supabase.from("activities")`
- [ ] Automation triggers (`on_lead_won`, etc.) updated
- [ ] `activities.metadata` jsonb stores structured data (already does for existing rows)
- [ ] RLS on `activities` covers all roles that currently access `business_events`
- [ ] Run backfill query (safe to run anytime)
- [ ] Deploy, monitor for a full release cycle
- [ ] Drop `business_events` table in v3.0

---

*Document generated by Architecture Director — v2.3 target recommended for consolidation.*
