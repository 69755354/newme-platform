\set ON_ERROR_STOP on

\ir ../../supabase/migrations/20260730225759_sam14_platform_support_session_lifecycle.sql

DO $$
BEGIN
  IF has_function_privilege(
    'anon',
    'public.start_support_session_atomic(uuid,uuid,uuid,text,text,jsonb,timestamptz,text)',
    'EXECUTE'
  ) OR has_function_privilege(
    'authenticated',
    'public.start_support_session_atomic(uuid,uuid,uuid,text,text,jsonb,timestamptz,text)',
    'EXECUTE'
  ) OR has_function_privilege(
    'anon',
    'public.end_support_session_atomic(uuid,uuid,text)',
    'EXECUTE'
  ) OR has_function_privilege(
    'authenticated',
    'public.end_support_session_atomic(uuid,uuid,text)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'SAM-14 lifecycle RPC exposed to an application role';
  END IF;

  IF NOT has_function_privilege(
    'service_role',
    'public.start_support_session_atomic(uuid,uuid,uuid,text,text,jsonb,timestamptz,text)',
    'EXECUTE'
  ) OR NOT has_function_privilege(
    'service_role',
    'public.end_support_session_atomic(uuid,uuid,text)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'SAM-14 lifecycle RPC missing service_role grant';
  END IF;

  IF NOT (
    SELECT procedure.prosecdef
      AND procedure.proconfig @> ARRAY['search_path=pg_catalog, public, pg_temp']
    FROM pg_proc AS procedure
    WHERE procedure.oid =
      'public.start_support_session_atomic(uuid,uuid,uuid,text,text,jsonb,timestamptz,text)'::regprocedure
  ) OR NOT (
    SELECT procedure.prosecdef
      AND procedure.proconfig @> ARRAY['search_path=pg_catalog, public, pg_temp']
    FROM pg_proc AS procedure
    WHERE procedure.oid =
      'public.end_support_session_atomic(uuid,uuid,text)'::regprocedure
  ) THEN
    RAISE EXCEPTION 'SAM-14 lifecycle RPC security contract drifted';
  END IF;
END
$$;

INSERT INTO auth.users(id)
VALUES
  ('cccccccc-cccc-4ccc-8ccc-cccccccccccc'),
  ('dddddddd-dddd-4ddd-8ddd-dddddddddddd'),
  ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee');

INSERT INTO public.profiles(id, role, is_active)
VALUES
  ('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'operator', true),
  ('dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'admin', true),
  ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'admin', true);

INSERT INTO public.platform_staff(id, user_id, status, staff_ref)
VALUES
  (
    'cccccccc-0000-4ccc-8ccc-000000000001',
    'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    'active',
    'sam14-support'
  ),
  (
    'dddddddd-0000-4ddd-8ddd-000000000002',
    'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    'active',
    'sam14-approver'
  );

INSERT INTO public.memberships(
  organization_id,
  user_id,
  status,
  accepted_at
)
VALUES (
  '6bc3b06e-5c05-4f45-9f1f-e9ea03a3cdd1',
  'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  'active',
  now()
);

CREATE FUNCTION public.sam14_harness_reject_audit()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.request_id LIKE 'sam14-audit-failure-%' THEN
    RAISE EXCEPTION 'sam14_harness_audit_unavailable';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER sam14_harness_reject_audit
BEFORE INSERT ON public.audit_events
FOR EACH ROW
EXECUTE FUNCTION public.sam14_harness_reject_audit();

SET ROLE service_role;

DO $$
BEGIN
  BEGIN
    PERFORM public.start_support_session_atomic(
      'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      '6bc3b06e-5c05-4f45-9f1f-e9ea03a3cdd1',
      'SAM14-company-admin',
      'Company admin must not obtain a platform support role',
      '["lead:read"]'::jsonb,
      now() + interval '30 minutes',
      'sam14-company-admin'
    );
    RAISE EXCEPTION 'company admin unexpectedly started a support session';
  EXCEPTION
    WHEN raise_exception THEN
      IF SQLERRM <> 'platform_staff_required' THEN
        RAISE;
      END IF;
  END;

  IF EXISTS (
    SELECT 1
    FROM public.platform_staff
    WHERE user_id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
  ) OR EXISTS (
    SELECT 1
    FROM public.support_sessions
    WHERE ticket_ref = 'SAM14-company-admin'
  ) THEN
    RAISE EXCEPTION 'company admin gained platform support state';
  END IF;

  BEGIN
    PERFORM public.start_support_session_atomic(
      'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      '6bc3b06e-5c05-4f45-9f1f-e9ea03a3cdd1',
      'SAM14-empty-reason',
      '   ',
      '["lead:read"]'::jsonb,
      now() + interval '30 minutes',
      'sam14-empty-reason'
    );
    RAISE EXCEPTION 'blank support reason unexpectedly accepted';
  EXCEPTION
    WHEN raise_exception THEN
      IF SQLERRM <> 'support_reason_required' THEN
        RAISE;
      END IF;
  END;

  BEGIN
    PERFORM public.start_support_session_atomic(
      'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      '6bc3b06e-5c05-4f45-9f1f-e9ea03a3cdd1',
      'SAM14-long-expiry',
      'Bounded support access',
      '["lead:read"]'::jsonb,
      now() + interval '4 hours 1 minute',
      'sam14-long-expiry'
    );
    RAISE EXCEPTION 'unbounded support expiry unexpectedly accepted';
  EXCEPTION
    WHEN raise_exception THEN
      IF SQLERRM <> 'support_expiry_invalid' THEN
        RAISE;
      END IF;
  END;

  BEGIN
    PERFORM public.start_support_session_atomic(
      'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      '6bc3b06e-5c05-4f45-9f1f-e9ea03a3cdd1',
      'SAM14-audit-failure-start',
      'Audit failure must prevent activation',
      '["lead:read"]'::jsonb,
      now() + interval '30 minutes',
      'sam14-audit-failure-start'
    );
    RAISE EXCEPTION 'support session activated without a start audit';
  EXCEPTION
    WHEN raise_exception THEN
      IF SQLERRM <> 'sam14_harness_audit_unavailable' THEN
        RAISE;
      END IF;
  END;

  IF EXISTS (
    SELECT 1
    FROM public.support_sessions
    WHERE ticket_ref = 'SAM14-audit-failure-start'
  ) THEN
    RAISE EXCEPTION 'audit failure left an active support session';
  END IF;
END
$$;

DO $$
DECLARE
  session_id uuid;
  start_audits integer;
  end_audits integer;
BEGIN
  session_id := public.start_support_session_atomic(
    'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    '6bc3b06e-5c05-4f45-9f1f-e9ea03a3cdd1',
    'SAM14-lifecycle',
    'Synthetic cross-organization support verification',
    '["lead:read"]'::jsonb,
    now() + interval '30 minutes',
    'sam14-start-success'
  );

  IF NOT EXISTS (
    SELECT 1
    FROM public.support_sessions
    WHERE id = session_id
      AND status = 'active'
      AND reason = 'Synthetic cross-organization support verification'
      AND expires_at > requested_at
      AND expires_at <= requested_at + interval '4 hours'
  ) THEN
    RAISE EXCEPTION 'valid bounded support session was not activated';
  END IF;

  SELECT count(*) INTO start_audits
  FROM public.audit_events
  WHERE support_session_id = session_id
    AND action = 'support.session.start'
    AND outcome = 'success';
  IF start_audits <> 1 THEN
    RAISE EXCEPTION 'support start audit count %, expected 1', start_audits;
  END IF;

  BEGIN
    PERFORM public.end_support_session_atomic(
      'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      session_id,
      'sam14-audit-failure-end'
    );
    RAISE EXCEPTION 'support session ended without an end audit';
  EXCEPTION
    WHEN raise_exception THEN
      IF SQLERRM <> 'sam14_harness_audit_unavailable' THEN
        RAISE;
      END IF;
  END;

  IF NOT EXISTS (
    SELECT 1
    FROM public.support_sessions
    WHERE id = session_id
      AND status = 'active'
      AND revoked_at IS NULL
  ) THEN
    RAISE EXCEPTION 'failed end audit changed the support session';
  END IF;

  PERFORM public.end_support_session_atomic(
    'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    session_id,
    'sam14-end-success'
  );

  IF NOT EXISTS (
    SELECT 1
    FROM public.support_sessions
    WHERE id = session_id
      AND status = 'revoked'
      AND revoked_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'support session was not revoked';
  END IF;

  SELECT count(*) INTO end_audits
  FROM public.audit_events
  WHERE support_session_id = session_id
    AND action = 'support.session.end'
    AND outcome = 'success';
  IF end_audits <> 1 THEN
    RAISE EXCEPTION 'support end audit count %, expected 1', end_audits;
  END IF;
END
$$;

RESET ROLE;

DROP TRIGGER sam14_harness_reject_audit ON public.audit_events;
DROP FUNCTION public.sam14_harness_reject_audit();

DELETE FROM public.audit_events
WHERE actor_user_id IN (
  'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
);
DELETE FROM public.support_sessions
WHERE platform_staff_id IN (
  'cccccccc-0000-4ccc-8ccc-000000000001',
  'dddddddd-0000-4ddd-8ddd-000000000002'
);
DELETE FROM public.platform_staff
WHERE id IN (
  'cccccccc-0000-4ccc-8ccc-000000000001',
  'dddddddd-0000-4ddd-8ddd-000000000002'
);
DELETE FROM public.memberships
WHERE user_id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
DELETE FROM public.profiles
WHERE id IN (
  'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
);
DELETE FROM auth.users
WHERE id IN (
  'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.platform_staff
  ) OR EXISTS (
    SELECT 1
    FROM public.support_sessions
  ) OR EXISTS (
    SELECT 1
    FROM public.audit_events
  ) THEN
    RAISE EXCEPTION 'SAM-14 fixture cleanup failed';
  END IF;
END
$$;

SELECT 'SAM-14 platform support lifecycle and audit atomicity passed' AS result;
