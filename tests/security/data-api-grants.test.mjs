import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const migration = await readFile(
  new URL(
    "../../supabase/migrations/20260728121000_reproduce_data_api_table_grants.sql",
    import.meta.url,
  ),
  "utf8",
);

test("Data API grants are explicit and leave row authorization to RLS", () => {
  assert.match(
    migration,
    /GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;/,
  );
  assert.match(
    migration,
    /GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE[\s\S]*public\.leads,[\s\S]*public\.profiles,[\s\S]*TO authenticated;/,
  );
  assert.match(
    migration,
    /GRANT SELECT ON TABLE public\.chat_messages TO authenticated;/,
  );
  assert.match(
    migration,
    /GRANT SELECT ON TABLE[\s\S]*public\.activity_logs,[\s\S]*public\.audit_logs,[\s\S]*public\.transfer_history,[\s\S]*public\.user_session_daily[\s\S]*TO authenticated;/,
  );
});

test("service role receives table access without reopening function execution", () => {
  assert.match(
    migration,
    /GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE[\s\S]*public\.lead_mutation_requests,[\s\S]*public\.leads,[\s\S]*public\.profiles,[\s\S]*TO service_role;/,
  );
  assert.doesNotMatch(migration, /GRANT\s+EXECUTE/i);
  assert.doesNotMatch(migration, /ALL\s+TABLES\s+IN\s+SCHEMA/i);
  assert.doesNotMatch(migration, /ALTER\s+DEFAULT\s+PRIVILEGES/i);
});

test("anonymous users receive schema discovery only", () => {
  const objectGrantToAnon = /GRANT[\s\S]*?\bON\s+(?:TABLE|SEQUENCE|FUNCTION)[\s\S]*?\bTO\s+anon\b/i;
  assert.doesNotMatch(migration, objectGrantToAnon);
});
