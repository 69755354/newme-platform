// Shared in-memory task store for KNX design pipelines
// Both route.ts and status/route.ts import this singleton

export interface KnxTask {
  lead_id: string;
  status: "started" | "running" | "completed" | "failed";
  progress_pct: number;
  progress_label: string;
  result?: {
    lead_id: string;
    devices_by_type: Record<string, number>;
    device_count: number;
    total_aed: number;
    quote_url: string | null;
    ppt_url: string | null;
    layout_url: string | null;
    generated_at: string;
  };
  error?: string;
}

const store = new Map<string, KnxTask>();

export function getStore() {
  return store;
}
