"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useLanguage } from "@/lib/i18n/LanguageContext";
import { cn } from "@/lib/utils";
import { WandSparkles, Loader2, CheckCircle, XCircle, FileText } from "lucide-react";

interface KnxDesignResult {
  lead_id: string;
  devices_by_type: Record<string, number>;
  device_count: number;
  total_aed: number;
  quote_url: string | null;
  ppt_url: string | null;
  layout_url: string | null;
  generated_at: string;
}

interface KnxDesignStatus {
  status: "started" | "running" | "completed" | "failed";
  progress_pct: number;
  progress_label: string;
  result?: KnxDesignResult;
  error?: string;
}

const PROGRESS_LABELS: Record<string, string> = {
  knxProgressAnalyzing: "knxProgressAnalyzing",
  knxProgressComputing: "knxProgressComputing",
  knxProgressQuote: "knxProgressQuote",
  knxProgressPpt: "knxProgressPpt",
  knxProgressDone: "knxProgressDone",
};

function fmtAED(v: number | null | undefined): string {
  if (v == null || v === 0) return "AED 0";
  return `AED ${v.toLocaleString()}`;
}

export default function KnxDesignPanel({ leadId }: { leadId: string }) {
  const { t } = useLanguage();
  const [generating, setGenerating] = useState(false);
  const [taskId, setTaskId] = useState<string | null>(null);
  const [status, setStatus] = useState<KnxDesignStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<NodeJS.Timeout | null>(null);

  // Cleanup polling on unmount
  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  const startPolling = useCallback((id: string) => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      try {
        const res = await fetch(`/api/hermes/knx-design/status?task_id=${id}`);
        if (!res.ok) {
          if (res.status === 404) {
            // Task not found yet — keep waiting
            return;
          }
          throw new Error(`Status check failed: ${res.status}`);
        }
        const data: KnxDesignStatus = await res.json();
        setStatus(data);

        if (data.status === "completed" || data.status === "failed") {
          if (pollRef.current) clearInterval(pollRef.current);
          pollRef.current = null;
          setGenerating(false);
        }
      } catch (err: any) {
        console.error("[KNX Design] Poll error:", err);
      }
    }, 5000);
  }, []);

  const handleGenerate = useCallback(async () => {
    setGenerating(true);
    setError(null);
    setStatus(null);
    setTaskId(null);

    try {
      const res = await fetch("/api/hermes/knx-design", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lead_id: leadId }),
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || `Request failed: ${res.status}`);
      }

      const data = await res.json();
      setTaskId(data.task_id);
      startPolling(data.task_id);

      // Initial status
      setStatus({
        status: "started",
        progress_pct: 0,
        progress_label: "knxProgressAnalyzing",
      });
    } catch (err: any) {
      console.error("[KNX Design] Generate error:", err);
      setError(err.message || "Failed to start KNX design");
      setGenerating(false);
    }
  }, [leadId, startPolling]);

  const progressLabel = status?.progress_label
    ? t(`leadDetail.${status.progress_label}` as any) || status.progress_label
    : "";
  const progressPct = status?.progress_pct || 0;

  return (
    <Card className="bg-gray-900 border-gray-800" data-knx-panel>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm text-gray-400 flex items-center gap-2">
          <WandSparkles className="w-4 h-4" />
          {t("leadDetail.knxDesign")}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* Generate button when idle */}
        {!generating && !status?.result && !error && (
          <Button
            variant="outline"
            size="sm"
            className="w-full border-purple-500/30 text-purple-400 hover:bg-purple-500/10 justify-start"
            onClick={handleGenerate}
          >
            <WandSparkles className="w-4 h-4 mr-2" />
            {t("leadDetail.generateKnxPlan")}
          </Button>
        )}

        {/* Progress indicator */}
        {generating && status && status.status !== "completed" && status.status !== "failed" && (
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-sm text-gray-300">
              <Loader2 className="w-4 h-4 animate-spin text-purple-400" />
              <span>{progressLabel || "Starting..."}</span>
            </div>
            <div className="w-full bg-gray-800 rounded-full h-2">
              <div
                className="bg-purple-500 h-2 rounded-full transition-all duration-500"
                style={{ width: `${progressPct}%` }}
              />
            </div>
            <p className="text-xs text-gray-500">{progressPct}%</p>
          </div>
        )}

        {/* Error state */}
        {error && (
          <div className="flex items-center gap-2 text-sm text-red-400">
            <XCircle className="w-4 h-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {error && (
          <Button
            variant="outline"
            size="sm"
            className="w-full border-purple-500/30 text-purple-400 hover:bg-purple-500/10 justify-start"
            onClick={handleGenerate}
          >
            <WandSparkles className="w-4 h-4 mr-2" />
            {t("leadDetail.generateKnxPlan")}
          </Button>
        )}

        {/* Results card */}
        {status?.result && (
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-sm text-emerald-400">
              <CheckCircle className="w-4 h-4" />
              <span>{t("leadDetail.knxProgressDone")}</span>
            </div>

            <div className="bg-gray-800/50 rounded-lg p-3 space-y-2">
              <div className="flex justify-between text-sm">
                <span className="text-gray-400">{t("leadDetail.knxResultsDeviceCount")}</span>
                <span className="text-white font-medium">{status.result.device_count}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-gray-400">{t("leadDetail.knxResultsTotal")}</span>
                <span className="text-copper-400 font-medium">{fmtAED(status.result.total_aed)}</span>
              </div>
            </div>

            {/* Links to generated files */}
            <div className="space-y-1.5">
              {status.result.quote_url && (
                <a
                  href={status.result.quote_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-2 text-sm text-blue-400 hover:text-blue-300"
                >
                  <FileText className="w-3.5 h-3.5" />
                  Quotation Excel
                </a>
              )}
              {status.result.ppt_url && (
                <a
                  href={status.result.ppt_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-2 text-sm text-blue-400 hover:text-blue-300"
                >
                  <FileText className="w-3.5 h-3.5" />
                  PPT Presentation
                </a>
              )}
              {status.result.layout_url && (
                <a
                  href={status.result.layout_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-2 text-sm text-blue-400 hover:text-blue-300"
                >
                  <FileText className="w-3.5 h-3.5" />
                  Layout PDF
                </a>
              )}
              {!status.result.quote_url && !status.result.ppt_url && !status.result.layout_url && (
                <p className="text-xs text-gray-500 italic">
                  Generated results stored in database. File URLs will appear once exported.
                </p>
              )}
            </div>

            {/* Generate again */}
            <Button
              variant="outline"
              size="sm"
              className="w-full border-purple-500/30 text-purple-400 hover:bg-purple-500/10 justify-start"
              onClick={handleGenerate}
            >
              <WandSparkles className="w-4 h-4 mr-2" />
              {t("leadDetail.generateKnxPlan")}
            </Button>
          </div>
        )}

        {/* Error with retry */}
        {status?.status === "failed" && !error && (
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-sm text-red-400">
              <XCircle className="w-4 h-4 shrink-0" />
              <span>{status.error || "Generation failed"}</span>
            </div>
            <Button
              variant="outline"
              size="sm"
              className="w-full border-purple-500/30 text-purple-400 hover:bg-purple-500/10 justify-start"
              onClick={handleGenerate}
            >
              <WandSparkles className="w-4 h-4 mr-2" />
              {t("leadDetail.generateKnxPlan")}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
