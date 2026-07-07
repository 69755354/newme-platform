// 可完成的里程碑（不含 new/negotiation——它们是 stage 标签，非里程碑动作）
export const COMPLETABLE_MILESTONES = [
  'first_contact',
  'basic_info',
  'drawings',
  'requirements',
  'solution',
  'quotation',
  'meeting'
];

// 完整顺序（含 new/negotiation，供 DB trigger 和 funnel 排序使用）
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
  if (!COMPLETABLE_MILESTONES.includes(targetKey)) {
    return { allowed: false, reason: MILESTONE_ERROR_REASONS.zh.invalidMilestone };
  }

  if (currentMilestones.includes(targetKey)) {
    return { allowed: false, reason: MILESTONE_ERROR_REASONS.zh.alreadyCompleted };
  }

  if (currentMilestones.length === 0) {
    // First milestone must be 'first_contact' (position 0 in COMPLETABLE_MILESTONES)
    if (targetKey === COMPLETABLE_MILESTONES[0]) {
      return { allowed: true };
    }
    return { allowed: false, reason: MILESTONE_ERROR_REASONS.zh.startWithFirstContact };
  }

  const targetOrder = MILESTONE_KEYS.indexOf(targetKey);
  const currentOrders = currentMilestones.map(m => MILESTONE_KEYS.indexOf(m));
  const maxCurrentOrder = Math.max(...currentOrders);

  if (targetOrder <= maxCurrentOrder) {
    return { allowed: false, reason: MILESTONE_ERROR_REASONS.zh.cannotMoveBackward };
  }

  if (targetOrder > maxCurrentOrder + 1) {
    return { allowed: false, reason: MILESTONE_ERROR_REASONS.zh.completePreviousFirst };
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

const MILESTONE_LABELS_ZH: Record<string, string> = {
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

export const MILESTONE_LABELS = Object.assign(MILESTONE_LABELS_ZH, {
  en: {
    'new': 'New Lead',
    'first_contact': 'First Contact',
    'basic_info': 'Basic Info',
    'drawings': 'Drawings & Planning',
    'requirements': 'Requirements',
    'solution': 'Solution',
    'quotation': 'Quotation',
    'meeting': 'Meeting',
    'negotiation': 'Negotiation'
  }
});

export const MILESTONE_ERROR_REASONS = {
  zh: {
    invalidMilestone: '无效的里程碑节点',
    alreadyCompleted: '该里程碑已完成，不能重复标记',
    startWithFirstContact: '不能跳级，请从首次联系开始',
    cannotMoveBackward: '不能往回走，已完成后续里程碑',
    completePreviousFirst: '不能跳级，请先完成前置里程碑'
  },
  en: {
    invalidMilestone: 'Invalid milestone',
    alreadyCompleted: 'This milestone has already been completed and cannot be marked again',
    startWithFirstContact: 'Cannot skip stages. Please start with First Contact',
    cannotMoveBackward: 'Cannot move backward because a later milestone has already been completed',
    completePreviousFirst: 'Cannot skip stages. Please complete the previous milestone first'
  }
} as const;

// P1-12: Human-readable milestone descriptions with i18n support
export const MILESTONE_DESCRIPTIONS: Record<string, { en: string; zh: string }> = {
  'new': { en: 'New lead, no contact yet', zh: '新线索，尚未联系' },
  'first_contact': { en: 'Initial contact made, gathering information', zh: '已初次联系，收集信息中' },
  'basic_info': { en: 'Basic client info collected, moving to drawings', zh: '基础信息已收集，进入图纸阶段' },
  'drawings': { en: 'Designing solution, confirming floor plans and quotes', zh: '方案设计中，确认点位图和报价' },
  'requirements': { en: 'Requirements confirmed, preparing solution', zh: '需求已确认，准备方案' },
  'solution': { en: 'Solution presented, awaiting client feedback', zh: '方案已提交，等待客户反馈' },
  'quotation': { en: 'Quote submitted, entering negotiation', zh: '报价已提交，进入谈判阶段' },
  'meeting': { en: 'Meeting/consultation in progress', zh: '会面/洽谈中' },
  'negotiation': { en: 'Final negotiation, close to decision', zh: '最终谈判，接近成交' }
};
