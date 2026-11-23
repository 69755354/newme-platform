// S38: one calm colour language for stages and lead status (WCAG AA on white / card).
//   neutral  = new, lost, dormant       (grey)
//   active   = every working stage       (one slate tone, no rainbow)
//   attention= hot / overdue / needs you (the single accent, amber)
//   won      = green
// Do not add new hues here; use `attention` only for something that needs action now.

export const TONE_CLASS = {
  neutral: "bg-stone-100 text-stone-700",
  active: "bg-slate-100 text-slate-700",
  attention: "bg-amber-100 text-amber-800",
  won: "bg-emerald-100 text-emerald-800",
} as const;

export type Tone = keyof typeof TONE_CLASS;

export const STAGE_TONE: Record<string, Tone> = {
  new: "neutral",
  contacted: "active",
  requirement_confirmed: "active",
  solution_submitted: "active",
  quotation_submitted: "active",
  negotiation: "active",
  pending_decision: "active",
  won: "won",
  lost: "neutral",
};

/** Solid colours for charts / dots (all >= 3:1 on white, graphics rule). */
export const TONE_HEX: Record<Tone, string> = {
  neutral: "#78716C",
  active: "#475569",
  attention: "#B45309",
  won: "#047857",
};

export const STAGE_HEX: Record<string, string> = Object.fromEntries(
  Object.entries(STAGE_TONE).map(([stage, tone]) => [stage, TONE_HEX[tone]]),
);

export const STAGE_CLASS: Record<string, string> = Object.fromEntries(
  Object.entries(STAGE_TONE).map(([stage, tone]) => [stage, TONE_CLASS[tone]]),
);

/** Lead temperature: only "hot" uses the accent; everything else is quiet. */
export const LEAD_STATUS_CLASS: Record<string, string> = {
  hot: TONE_CLASS.attention,
  warm: TONE_CLASS.active,
  cold: TONE_CLASS.neutral,
  dormant: TONE_CLASS.neutral,
};
