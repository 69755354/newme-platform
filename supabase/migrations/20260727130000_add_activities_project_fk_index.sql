-- SAM-69: cover activities_project_id_fkey with a dedicated FK index.
--
-- The staging performance advisor reports that activities.project_id has no
-- covering index. This additive index improves reverse lookups and avoids
-- full scans when a referenced project is updated or deleted.
--
-- Rollback: DROP INDEX IF EXISTS public.idx_activities_project;
CREATE INDEX IF NOT EXISTS idx_activities_project
  ON public.activities (project_id);
