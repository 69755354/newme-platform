# Fixed cleanup RPC compatibility

Managed authentication schemas need not delegate grant option to an application
migration account. A grant that works in a superuser test database can therefore
be unavailable in a hosted environment. The initial cleanup check refused the
release when its dedicated role could not access that schema.

Supabase documents this managed-schema limitation and the controlled definer
pattern in its [official troubleshooting guide](https://supabase.com/kb/troubleshooting/permission-errors-when-granting-custom-roles-access-to-the-auth-schema).

The forward-only repair retains the original migration unchanged. It moves two
existing, argument-free routines to the repository's trusted database owner and
removes direct observer-table privileges from the unused NOLOGIN role. Function
bodies and external EXECUTE grants do not change. The fixed routines operate only
on the declared observer lifecycle; callers cannot supply SQL, table names or a
different data source. Administrator customer-deletion checks remain in place,
and the web service still has no direct event DELETE/UPDATE/TRUNCATE.

The repair is admitted only by its immutable hash, after the recorded original
privacy migration and with all capture channels disabled. The entire prior
deferred prefix is preserved. An already provisioned original migration may be
present even when its application release was automatically rolled back; the
gate handles that specific recorded state without applying unrelated migrations.

The database test explicitly removes auth-schema usage from the retired role.
It checks that the role cannot use the schema, that cleanup has its reviewed
owner, and that the full expiry, deletion, session, race and recovery behavior
still passes. Live acceptance additionally requires the actual HTTP cleanup RPC,
a successful scheduled receipt and disabled actual-number collection.
