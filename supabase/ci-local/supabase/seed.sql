INSERT INTO ci_gate.seed_markers (marker)
VALUES ('task-followup-ci-v1')
ON CONFLICT (marker) DO UPDATE SET seeded_at = now();

