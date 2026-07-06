export const PIPELINE_STAGES = [
  { key: "new", label: "New Lead", color: "#6B7280", bg: "bg-muted/30", border: "border-border/40" },
  { key: "contacted", label: "Contacted", color: "#C48A52", bg: "bg-amber-950/30", border: "border-amber-800/40" },
  { key: "requirement_confirmed", label: "Req Confirmed", color: "#E0B95A", bg: "bg-yellow-950/20", border: "border-yellow-800/40" },
  { key: "solution_submitted", label: "Solution Sub.", color: "#4A5568", bg: "bg-slate-950/20", border: "border-slate-800/40" },
  { key: "quotation_submitted", label: "Quotation Sub.", color: "#8B5CF6", bg: "bg-purple-950/20", border: "border-purple-800/40" },
  { key: "negotiation", label: "Negotiation", color: "#3B82F6", bg: "bg-blue-950/20", border: "border-blue-800/40" },
  { key: "pending_decision", label: "Pending Decision", color: "#F59E0B", bg: "bg-amber-950/20", border: "border-amber-800/40" },
  { key: "won", label: "Won", color: "#4ADE80", bg: "bg-emerald-950/20", border: "border-emerald-800/40" },
  { key: "lost", label: "Lost", color: "#6B7280", bg: "bg-muted/30", border: "border-border/40" },
] as const;

export type StageKey = typeof PIPELINE_STAGES[number]["key"];

export const TERMINAL_STAGES = new Set(["won", "lost"]);
