-- Prevent concurrent cron invocations from creating duplicate overdue alerts.
-- Existing rows remain NULL and are intentionally outside the new uniqueness scope.
ALTER TABLE public.notifications
  ADD COLUMN IF NOT EXISTS idempotency_key UUID;

COMMENT ON COLUMN public.notifications.idempotency_key IS
  'Event-specific idempotency key. Used by overdue-installment cron notifications.';

CREATE UNIQUE INDEX IF NOT EXISTS notifications_payment_overdue_idempotency_uidx
  ON public.notifications (user_id, idempotency_key)
  WHERE type = 'payment_overdue'
    AND related_type = 'payment'
    AND idempotency_key IS NOT NULL;
