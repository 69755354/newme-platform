import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migration = new URL(
  "../../supabase/migrations/20260726083458_harden_lead_mutation_idempotency_and_transfer_audit.sql",
  import.meta.url,
);

function functionBody(sql, name, nextName) {
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  const end = nextName
    ? sql.indexOf(`CREATE OR REPLACE FUNCTION public.${nextName}(`, start + 1)
    : sql.indexOf("-- Transfer history is audit evidence.", start + 1);
  assert.notEqual(start, -1, `${name} must be defined`);
  assert.notEqual(end, -1, `${name} definition must have a boundary`);
  return sql.slice(start, end);
}

test("SAM-62 serializes each replay key before reading its request row", async () => {
  const sql = await readFile(migration, "utf8");
  const functions = [
    ["delete_lead_atomic", "reassign_lead_atomic", "lead_delete"],
    ["reassign_lead_atomic", "record_lead_note_atomic", "lead_reassignment"],
    ["record_lead_note_atomic", "record_lead_contact_atomic", "lead_note"],
    ["record_lead_contact_atomic", null, "lead_contact"],
  ];

  for (const [name, nextName, operation] of functions) {
    const body = functionBody(sql, name, nextName);
    const lock = body.indexOf("pg_catalog.pg_advisory_xact_lock");
    const replay = body.indexOf("SELECT response INTO v_response");
    assert.notEqual(lock, -1, `${name} must acquire a transaction-scoped replay lock`);
    assert.notEqual(replay, -1, `${name} must read its replay response`);
    assert.ok(lock < replay, `${name} must serialize before checking replay state`);
    assert.match(body, new RegExp(`:${operation}:`));
    assert.match(body, /idempotent_replay/);
  }
});

test("SAM-62 makes transfer history read-only to authenticated clients", async () => {
  const sql = await readFile(migration, "utf8");
  for (const operation of ["insert", "update", "delete"]) {
    assert.match(
      sql,
      new RegExp(`DROP POLICY IF EXISTS policy_transfer_history_${operation}_admin`, "i"),
    );
  }
  assert.match(
    sql,
    /REVOKE INSERT, UPDATE, DELETE ON TABLE public\.transfer_history FROM authenticated/,
  );
  assert.match(sql, /GRANT SELECT ON TABLE public\.transfer_history TO authenticated/);
  assert.doesNotMatch(
    sql,
    /CREATE POLICY[\s\S]+ON public\.transfer_history FOR (INSERT|UPDATE|DELETE)/i,
  );
});
