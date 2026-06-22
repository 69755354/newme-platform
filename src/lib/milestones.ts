export const MILESTONE_KEYS = [
  'new',
  'first_contact',
  'basic_info',
  'drawings',
  'requirements',
  'solution',
  'quotation',
  'meeting',
  'negotiation'
];

const STAGE_MAP = [
  'new',
  'contacted',
  'qualified',
  'drawings',
  'requirements',
  'solution',
  'quotation',
  'meeting',
  'negotiation'
];

export function deriveStage(milestoneCount: number): string {
  if (milestoneCount < 0) return STAGE_MAP[0];
  if (milestoneCount >= STAGE_MAP.length) return STAGE_MAP[STAGE_MAP.length - 1];
  return STAGE_MAP[milestoneCount];
}

export function milestoneOrder(key: string): number {
  const index = MILESTONE_KEYS.indexOf(key);
  return index === -1 ? 99 : index;
}

export function canCompleteMilestone(
  currentMilestones: string[],
  targetKey: string
): { allowed: boolean; reason?: string } {
  if (!MILESTONE_KEYS.includes(targetKey)) {
    return { allowed: false, reason: '无效的里程碑节点' };
  }

  if (currentMilestones.includes(targetKey)) {
    return { allowed: false, reason: '该里程碑已完成，不能重复标记' };
  }

  const targetOrder = milestoneOrder(targetKey);

  if (currentMilestones.length === 0) {
    if (targetOrder === 0) {
      return { allowed: true };
    }
    return { allowed: false, reason: '不能跳级，请先完成前置里程碑' };
  }

  const currentOrders = currentMilestones.map(m => milestoneOrder(m));
  const maxCurrentOrder = Math.max(...currentOrders);

  if (targetOrder <= maxCurrentOrder) {
    return { allowed: false, reason: '不能往回走，已完成后续里程碑' };
  }

  if (targetOrder > maxCurrentOrder + 1) {
    return { allowed: false, reason: '不能跳级，请先完成前置里程碑' };
  }

  return { allowed: true };
}

export const PENDING_DECISION_MILESTONES = [
  'solution',
  'quotation',
  'meeting'
];

export function funnelQuery(useCurrentMilestone: boolean): string {
  const groupByField = useCurrentMilestone ? 'current_milestone' : 'latest_milestone';
  return `
    SELECT 
      ${groupByField} as milestone, 
      COUNT(*) as count 
    FROM customers 
    WHERE ${groupByField} IS NOT NULL 
    GROUP BY ${groupByField} 
    ORDER BY CASE ${groupByField}
      ${MILESTONE_KEYS.map((key, index) => `WHEN '${key}' THEN ${index}`).join('\n      ')}
      ELSE 99 
    END;
  `;
}

export const MILESTONE_LABELS: Record<string, string> = {
  'new': '新建线索',
  'first_contact': '初次接触',
  'basic_info': '基础信息收集',
  'drawings': '图纸/空间规划',
  'requirements': '需求确认',
  'solution': '方案提供',
  'quotation': '报价阶段',
  'meeting': '会面/洽谈',
  'negotiation': '最终谈判'
};