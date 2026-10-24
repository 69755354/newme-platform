# Advertising writer coordination

All ad_spend INSERT/UPDATE/DELETE statements acquire the shared transaction advisory lock. A statement-wide transition-table guard rejects a different source on the same date, including the legacy Excel importer after a stale overlap probe. Existing administrator RLS remains in force. RPC replacement retains full-field atomic readback; missing impression/click metrics remain null.

PostgREST hoists statement_timeout from RPC settings before the outer query (official Transactions / Hoisted Function Settings documentation). Direct scheduler connections set statement_timeout=20s and lock_timeout=5s on connection before invoking the RPC; function-local settings alone are not the direct-session deadline. The worker remains disabled.
