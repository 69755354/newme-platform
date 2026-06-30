-- ============================================================================
-- Migration: Drop remaining FOR ALL admin policies (chat_messages, quotes)
-- These were originally inside EXECUTE blocks or never DROPped in the prior
-- migration (20260701000000_non_core_tables_rls_fix.sql)
-- ============================================================================

DROP POLICY IF EXISTS chat_messages_admin_all ON chat_messages;
DROP POLICY IF EXISTS quotes_admin_all ON quotes;

COMMIT;
