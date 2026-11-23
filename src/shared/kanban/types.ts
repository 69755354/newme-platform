export const PIPELINE_STAGES = [
  { key: "new", label: "New Lead", color: "#78716C", bg: "bg-muted/30", border: "border-border/40" },
  { key: "contacted", label: "Contacted", color: "#475569", bg: "bg-muted/30", border: "border-border/40" },
  { key: "requirement_confirmed", label: "Req Confirmed", color: "#475569", bg: "bg-muted/30", border: "border-border/40" },
  { key: "solution_submitted", label: "Solution Sub.", color: "#475569", bg: "bg-muted/30", border: "border-border/40" },
  { key: "quotation_submitted", label: "Quotation Sub.", color: "#475569", bg: "bg-muted/30", border: "border-border/40" },
  { key: "negotiation", label: "Negotiation", color: "#475569", bg: "bg-muted/30", border: "border-border/40" },
  { key: "pending_decision", label: "Pending Decision", color: "#475569", bg: "bg-muted/30", border: "border-border/40" },
  { key: "won", label: "Won", color: "#047857", bg: "bg-emerald-50/70", border: "border-emerald-200" },
  { key: "lost", label: "Lost", color: "#78716C", bg: "bg-muted/30", border: "border-border/40" },
] as const;

export type StageKey = typeof PIPELINE_STAGES[number]["key"];

export const TERMINAL_STAGES = new Set(["won", "lost"]);
