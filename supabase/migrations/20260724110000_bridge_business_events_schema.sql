-- Converge already-deployed databases that recorded the legacy business_events shape.
-- This is additive and preserves all historical rows.
DO $$
BEGIN
  IF to_regclass('public.business_events') IS NOT NULL THEN
    ALTER TABLE public.business_events ADD COLUMN IF NOT EXISTS entity_type TEXT;
    ALTER TABLE public.business_events ADD COLUMN IF NOT EXISTS entity_id UUID;
    ALTER TABLE public.business_events ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES public.profiles(id);

    UPDATE public.business_events
    SET entity_type = 'lead',
        entity_id = lead_id,
        created_by = user_id
    WHERE lead_id IS NOT NULL
      AND (entity_type IS NULL OR entity_id IS NULL OR created_by IS NULL);

    CREATE INDEX IF NOT EXISTS idx_business_events_entity_type
      ON public.business_events(entity_type);
    CREATE INDEX IF NOT EXISTS idx_business_events_entity_id
      ON public.business_events(entity_id);
    CREATE INDEX IF NOT EXISTS idx_business_events_created_by
      ON public.business_events(created_by);
  END IF;
END;
$$;