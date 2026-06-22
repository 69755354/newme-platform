export function calculateHealthScore(params: {
  hasRecentFollowUp: boolean;
  hasMeeting: boolean;
  hasDrawings: boolean;
  hasQuotation: boolean;
  isOverdue: boolean;
}): { score: number; level: 'healthy' | 'at_risk' | 'stale'; label: string } {
  let score = 0;

  if (params.hasRecentFollowUp) score += 20;
  if (params.hasMeeting) score += 20;
  if (params.hasDrawings) score += 15;
  if (params.hasQuotation) score += 15;
  if (params.isOverdue) score -= 30;

  let level: 'healthy' | 'at_risk' | 'stale';
  let label: string;

  if (score >= 50) {
    level = 'healthy';
    label = 'Healthy';
  } else if (score >= 20) {
    level = 'at_risk';
    label = 'At Risk';
  } else {
    level = 'stale';
    label = 'Stale';
  }

  return { score, level, label };
}
