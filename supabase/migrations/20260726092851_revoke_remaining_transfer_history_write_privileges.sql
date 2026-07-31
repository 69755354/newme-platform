-- transfer_history is immutable audit evidence for authenticated callers.
-- Earlier migrations granted ALL, so revoke every table privilege before
-- restoring the single intended read permission.
REVOKE ALL PRIVILEGES ON TABLE public.transfer_history FROM authenticated;
GRANT SELECT ON TABLE public.transfer_history TO authenticated;
