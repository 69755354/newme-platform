/**
 * Hermes API Bridge
 * 对接 Hermes Gateway (:22884) 的 CAD分析、报价生成、PPT方案
 */

const HERMES_BASE = process.env.HERMES_API_URL || "http://127.0.0.1:22884";

interface QuoteRequest {
  rooms: Array<{
    name: string;
    area: number;
    windows: number;
    type: string;
    light_circuits: number;
    light_fixtures: number;
  }>;
  project_name: string;
  property_type: string;
  total_sqm: number;
  floors: number;
}

interface QuoteResponse {
  quote_id: string;
  total_aed: number;
  devices: Record<string, number>;
  quote_url: string | null;
  ppt_url: string | null;
  error?: string;
}

export async function requestQuote(data: QuoteRequest): Promise<QuoteResponse> {
  try {
    const res = await fetch(`${HERMES_BASE}/api/smart-home/quote`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });

    if (!res.ok) {
      return { quote_id: "", total_aed: 0, devices: {}, quote_url: null, ppt_url: null, error: `Hermes API ${res.status}` };
    }

    return await res.json();
  } catch (err: any) {
    return { quote_id: "", total_aed: 0, devices: {}, quote_url: null, ppt_url: null, error: err.message };
  }
}

interface CADAnalysis {
  project: string;
  floors: Record<string, Array<{
    name: string;
    area: number;
    windows: number;
    type: string;
    light_circuits: number;
    light_fixtures: number;
  }>>;
  electrical_summary: {
    total_light_circuits: number;
    total_light_fixtures: number;
    total_dimming_zones: number;
    total_cct_zones: number;
  };
}

export async function analyzeCAD(cadUrl: string): Promise<CADAnalysis | null> {
  try {
    const res = await fetch(`${HERMES_BASE}/api/cad/analyze`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file_url: cadUrl }),
    });

    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/** Check if Hermes engine is reachable */
export async function healthCheck(): Promise<boolean> {
  try {
    const res = await fetch(`${HERMES_BASE}/health`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}
