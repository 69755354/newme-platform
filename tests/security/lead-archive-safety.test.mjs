import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const routeUrl = new URL("../../src/app/api/leads/archive/route.ts", import.meta.url);

test("archive requires an explicitly approved immutable lead ID set", async () => {
  const source = await readFile(routeUrl, "utf8");
  assert.ok(source.includes("lead_ids required; preview an owner"));
  assert.ok(source.includes('query.in("id", approvedLeadIds).eq("archived", false)'));
  assert.equal(source.includes('ilike("full_name", "%mohamed%")'), false);
});

test("archive preview resolves an exact owner ID and returns the approved IDs", async () => {
  const source = await readFile(routeUrl, "utf8");
  assert.ok(source.includes('searchParams.get("owner_id")'));
  assert.ok(source.includes('.eq("id", ownerId)'));
  assert.ok(source.includes('.eq("assigned_to", owner.id)'));
  assert.ok(source.includes("lead_ids: leads.map((lead) => lead.id)"));
  assert.ok(source.includes("truncated: leads.length === 500"));
});

test("archive batches can be rolled back without deleting leads", async () => {
  const source = await readFile(routeUrl, "utf8");
  assert.ok(source.includes("export async function DELETE"));
  assert.ok(source.includes('.eq("archive_batch_id", batchId)'));
  assert.ok(source.includes("archived: false"));
  assert.ok(source.includes("archived_at: null"));
  assert.ok(source.includes("restored_count: restoredCount"));
  assert.equal(source.includes('.delete()'), false);
});
