CREATE OR REPLACE FUNCTION public.sam25_sync_project_paid_amount()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  target_contract_id uuid;
  target_organization_id uuid;
BEGIN
  target_contract_id := CASE WHEN TG_OP = 'DELETE'
    THEN OLD.contract_id ELSE NEW.contract_id END;
  target_organization_id := CASE WHEN TG_OP = 'DELETE'
    THEN OLD.organization_id ELSE NEW.organization_id END;

  UPDATE public.projects project
  SET
    paid_amount = (
      SELECT COALESCE(SUM(payment.amount), 0)
      FROM public.payments payment
      WHERE payment.contract_id = target_contract_id
        AND payment.organization_id = target_organization_id
        AND payment.confirmed IS TRUE
    ),
    updated_at = now()
  WHERE project.contract_id = target_contract_id
    AND project.organization_id = target_organization_id;

  IF TG_OP = 'UPDATE'
    AND (
      OLD.contract_id IS DISTINCT FROM NEW.contract_id
      OR OLD.organization_id IS DISTINCT FROM NEW.organization_id
    )
  THEN
    UPDATE public.projects project
    SET
      paid_amount = (
        SELECT COALESCE(SUM(payment.amount), 0)
        FROM public.payments payment
        WHERE payment.contract_id = OLD.contract_id
          AND payment.organization_id = OLD.organization_id
          AND payment.confirmed IS TRUE
      ),
      updated_at = now()
    WHERE project.contract_id = OLD.contract_id
      AND project.organization_id = OLD.organization_id;
  END IF;

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

REVOKE ALL ON FUNCTION public.sam25_sync_project_paid_amount()
  FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS sam25_sync_project_paid_amount
  ON public.payments;
CREATE TRIGGER sam25_sync_project_paid_amount
AFTER INSERT OR UPDATE OR DELETE ON public.payments
FOR EACH ROW
EXECUTE FUNCTION public.sam25_sync_project_paid_amount();

NOTIFY pgrst, 'reload schema';
