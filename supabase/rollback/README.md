# Supabase clean-room migration verification

The forward schema source is supabase/migrations/. Files in supabase/rollback/ are operator-run rollback helpers and are never part of the forward migration chain.

Run the fail-closed preflight from the repository root:

    node scripts/verify-clean-room-migrations.mjs

For an isolated, empty staging database only, review the target URL and then use:

    node scripts/verify-clean-room-migrations.mjs --apply --database-url "$STAGING_DATABASE_URL" --allow-nonproduction
    supabase db push --db-url "$STAGING_DATABASE_URL" --include-all

The verifier does not contact a database. The apply command requires an explicit URL plus --allow-nonproduction, and rejects known production markers. Never use business data or a production URL.

Rollback is a clean-room reset: preserve the command output, destroy/recreate the isolated staging database or branch, and rerun the same forward command. Do not run rollback helpers against production. Existing rollback SQL is kept under supabase/rollback for operator-reviewed targeted recovery only.