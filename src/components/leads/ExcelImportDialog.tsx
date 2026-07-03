"use client";

import { useState, useRef } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogClose,
} from "@/components/ui/dialog";
import {
  Loader2, Upload, FileSpreadsheet, CheckCircle2, XCircle,
  AlertCircle, AlertTriangle,
} from "lucide-react";
import { useLanguage } from "@/lib/i18n/LanguageContext";
import { cn } from "@/lib/utils";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImported: () => void;
}

type Step = "select" | "preview" | "done";

interface PreviewRow {
  row_number: number;
  customer_name: string | null;
  phone: string | null;
  source: string | null;
  quality: string | null;
  location: string | null;
  project_type: string | null;
  quotation_value: number | null;
  notes: string | null;
}

interface PreviewResponse {
  total_rows: number;
  importable: number;
  skipped: number;
  warnings: string[];
  preview: PreviewRow[];
  // Normalized rows returned by the server — these are what the confirm
  // endpoint expects (snake_case fields). Sending raw Excel rows to confirm
  // would write nulls for every field, so confirm must use all_rows verbatim.
  all_rows: Record<string, any>[];
}

interface ConfirmResponse {
  batch_id: string;
  imported: number;
  failed: number;
  errors: { row: number; error: string }[];
  imported_ids: string[];
}

// Key fields shown in the preview table.
const PREVIEW_COLUMNS: { key: keyof PreviewRow; label: string }[] = [
  { key: "customer_name", label: "Client Name" },
  { key: "phone", label: "Phone" },
  { key: "source", label: "Source" },
  { key: "quality", label: "Quality" },
  { key: "location", label: "Location" },
  { key: "quotation_value", label: "Quotation" },
];

function StatCard({
  label, value, tone,
}: { label: string; value: number; tone?: "emerald" | "amber" }) {
  return (
    <div className={cn(
      "rounded-lg p-3 text-center border",
      tone === "emerald"
        ? "bg-emerald-500/10 border-emerald-500/20"
        : tone === "amber"
          ? "bg-amber-500/10 border-amber-500/20"
          : "bg-gray-900/50 border-gray-800",
    )}>
      <p className={cn(
        "text-lg font-bold",
        tone === "emerald" ? "text-emerald-400"
          : tone === "amber" ? "text-amber-400"
            : "text-gray-200",
      )}>{value}</p>
      <p className="text-[11px] text-gray-400 mt-0.5">{label}</p>
    </div>
  );
}

export default function ExcelImportDialog({ open, onOpenChange, onImported }: Props) {
  const { t } = useLanguage();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [step, setStep] = useState<Step>("select");
  const [fileName, setFileName] = useState<string | null>(null);
  const [parsing, setParsing] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [result, setResult] = useState<ConfirmResponse | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  function resetState() {
    setStep("select");
    setFileName(null);
    setParsing(false);
    setImporting(false);
    setError(null);
    setPreview(null);
    setResult(null);
    setConfirmOpen(false);
    setDragOver(false);
  }

  function handleOpenChange(open: boolean) {
    if (!open) {
      // Capture before reset so closing the dialog still refreshes the list
      // after a successful import.
      const wasImported = !!result && result.imported > 0;
      resetState();
      onOpenChange(false);
      if (wasImported) onImported();
    } else {
      onOpenChange(open);
    }
  }

  // Parse the workbook client-side with xlsx and ask the server for a preview.
  // sheet_to_json produces objects keyed by the spreadsheet header text
  // (e.g. "Client Name"), which is exactly what the preview endpoint reads.
  async function handleFile(file: File) {
    const lower = file.name.toLowerCase();
    if (!lower.endsWith(".xlsx") && !lower.endsWith(".xls")) {
      setError(t("leads.importError"));
      return;
    }
    setError(null);
    setFileName(file.name);
    setParsing(true);
    try {
      const XLSX = await import("xlsx");
      const data = new Uint8Array(await file.arrayBuffer());
      const wb = XLSX.read(data, { type: "array" });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json<Record<string, any>>(ws, { defval: "" });

      const res = await fetch("/api/leads/import/preview", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(json?.error || `Preview failed (${res.status})`);
      }
      setPreview(json as PreviewResponse);
      setStep("preview");
    } catch (e: any) {
      setError(e?.message || t("leads.importError"));
    } finally {
      setParsing(false);
    }
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    const f = e.dataTransfer.files?.[0];
    if (f) handleFile(f);
  }
  function handleDragOver(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(true);
  }
  function handleDragLeave(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
  }

  function requestConfirm() {
    if (!preview || preview.importable === 0 || importing) return;
    setConfirmOpen(true);
  }

  // Confirm sends the server-normalized all_rows — NOT the raw parsed rows.
  async function doImport() {
    setConfirmOpen(false);
    if (!preview) return;
    setImporting(true);
    setError(null);
    try {
      const res = await fetch("/api/leads/import/confirm", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows: preview.all_rows }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(json?.error || `Import failed (${res.status})`);
      }
      setResult(json as ConfirmResponse);
      setStep("done");
    } catch (e: any) {
      setError(e?.message || t("leads.importError"));
    } finally {
      setImporting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-2xl bg-[#1E2328] border-gray-800 text-gray-100">
        <DialogHeader>
          <DialogTitle className="text-white text-lg flex items-center gap-2">
            <FileSpreadsheet className="w-4 h-4 text-copper-400" />
            {t("leads.importTitle")}
          </DialogTitle>
        </DialogHeader>

        {/* Step: select file */}
        {step === "select" && (
          <div className="space-y-4 pt-2">
            <div
              onDrop={handleDrop}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onClick={() => !parsing && fileInputRef.current?.click()}
              className={cn(
                "border-2 border-dashed rounded-xl p-8 text-center transition-colors",
                parsing ? "cursor-wait" : "cursor-pointer",
                dragOver
                  ? "border-copper-500 bg-copper-500/5"
                  : "border-gray-700 hover:border-gray-500 bg-gray-900/50",
              )}
            >
              {parsing
                ? <Loader2 className="w-8 h-8 mx-auto text-copper-400 mb-3 animate-spin" />
                : <Upload className="w-8 h-8 mx-auto text-gray-500 mb-3" />}
              <p className="text-sm text-gray-300 font-medium">
                {t("leads.importSelectFile")}
              </p>
              <p className="text-xs text-gray-500 mt-1">.xlsx / .xls</p>
              <input
                ref={fileInputRef}
                type="file"
                accept=".xlsx,.xls"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) handleFile(f);
                  e.target.value = "";
                }}
              />
            </div>

            {parsing && (
              <p className="text-xs text-gray-400 text-center flex items-center justify-center gap-1.5">
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                {t("leads.importParsing")}
              </p>
            )}

            {error && (
              <p className="text-red-400 text-xs flex items-center gap-1.5">
                <AlertCircle className="w-3.5 h-3.5 shrink-0" />{error}
              </p>
            )}
          </div>
        )}

        {/* Step: preview */}
        {step === "preview" && preview && !importing && (
          <div className="space-y-4 pt-2">
            <div className="flex items-center gap-2 text-sm">
              <FileSpreadsheet className="w-4 h-4 text-copper-400 shrink-0" />
              <span className="text-gray-300 truncate">{fileName}</span>
            </div>

            <div className="grid grid-cols-3 gap-2">
              <StatCard label={t("leads.importTotalRows")} value={preview.total_rows} />
              <StatCard label={t("leads.importImportable")} value={preview.importable} tone="emerald" />
              <StatCard label={t("leads.importSkipped")} value={preview.skipped} tone="amber" />
            </div>

            {preview.warnings.length > 0 && (
              <div className="bg-amber-500/5 border border-amber-500/15 rounded-lg p-2.5 max-h-24 overflow-auto">
                <p className="text-xs text-amber-400 font-medium mb-1">
                  {t("leads.importWarnings")} ({preview.warnings.length})
                </p>
                {preview.warnings.slice(0, 10).map((w, i) => (
                  <p key={i} className="text-[11px] text-amber-400/70 leading-snug">{w}</p>
                ))}
              </div>
            )}

            <div className="bg-gray-900/50 rounded-lg overflow-hidden">
              <div className="max-h-56 overflow-auto">
                <table className="w-full text-xs">
                  <thead className="sticky top-0 bg-gray-900/95 backdrop-blur">
                    <tr className="border-b border-gray-800">
                      <th className="px-2 py-2 text-left text-gray-500 font-medium">#</th>
                      {PREVIEW_COLUMNS.map((c) => (
                        <th key={c.key} className="px-2 py-2 text-left text-gray-500 font-medium">
                          {c.label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {preview.preview.length === 0 && (
                      <tr>
                        <td colSpan={PREVIEW_COLUMNS.length + 1} className="px-2 py-6 text-center text-gray-500">
                          {t("common.noResults")}
                        </td>
                      </tr>
                    )}
                    {preview.preview.map((pr) => (
                      <tr key={pr.row_number} className="border-b border-gray-800/50 last:border-0">
                        <td className="px-2 py-1.5 text-gray-500">{pr.row_number}</td>
                        {PREVIEW_COLUMNS.map((c) => (
                          <td key={c.key} className="px-2 py-1.5 text-gray-300 max-w-[120px] truncate">
                            {c.key === "quotation_value"
                              ? (pr.quotation_value != null ? pr.quotation_value.toLocaleString() : "—")
                              : (String(pr[c.key] ?? "").trim() || "—")}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {error && (
              <p className="text-red-400 text-xs flex items-center gap-1.5">
                <AlertCircle className="w-3.5 h-3.5 shrink-0" />{error}
              </p>
            )}

            <div className="flex items-center justify-between pt-1">
              <Button
                variant="ghost"
                className="text-gray-400 h-8"
                disabled={importing}
                onClick={resetState}
              >
                {t("common.back")}
              </Button>
              <Button
                onClick={requestConfirm}
                disabled={preview.importable === 0 || importing}
                className="bg-[#D4A373] hover:bg-[#D4A373]/85 text-[#1E2328] font-medium h-8 text-sm gap-1.5"
              >
                {importing && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                {importing ? t("leads.importImporting") : t("leads.importConfirm")}
              </Button>
            </div>
          </div>
        )}

        {/* Step: importing (between confirm click and results) */}
        {step === "preview" && importing && (
          <div className="py-10 text-center space-y-4">
            <Loader2 className="w-10 h-10 animate-spin text-copper-400 mx-auto" />
            <div>
              <p className="text-gray-300 font-medium">{t("leads.importImporting")}</p>
              <p className="text-xs text-gray-500 mt-1">{fileName}</p>
            </div>
          </div>
        )}

        {/* Step: results */}
        {step === "done" && result && (
          <div className="space-y-4 pt-2">
            <div className={cn(
              "rounded-xl p-4 text-center border",
              result.failed === 0 ? "bg-emerald-500/10 border-emerald-500/20"
                : result.imported > 0 ? "bg-amber-500/10 border-amber-500/20"
                  : "bg-red-500/10 border-red-500/20",
            )}>
              {result.failed === 0
                ? <CheckCircle2 className="w-8 h-8 text-emerald-400 mx-auto mb-2" />
                : result.imported > 0
                  ? <AlertCircle className="w-8 h-8 text-amber-400 mx-auto mb-2" />
                  : <XCircle className="w-8 h-8 text-red-400 mx-auto mb-2" />}
              {result.imported > 0 && (
                <p className={cn(
                  "font-medium",
                  result.failed === 0 ? "text-emerald-400" : "text-amber-400",
                )}>
                  {t("leads.importSuccess").replace("{n}", String(result.imported))}
                </p>
              )}
              {result.failed > 0 && (
                <p className={cn(
                  "text-xs mt-1",
                  result.imported > 0 ? "text-amber-400/70" : "text-red-400 font-medium",
                )}>
                  {t("leads.importFailed").replace("{n}", String(result.failed))}
                </p>
              )}
              {result.imported === 0 && result.failed === 0 && (
                <p className="text-gray-300 font-medium">{t("leads.importError")}</p>
              )}
            </div>

            {result.errors.length > 0 && (
              <div className="bg-gray-900/50 rounded-lg p-2.5 max-h-40 overflow-auto">
                {result.errors.slice(0, 30).map((er, i) => (
                  <div key={i} className="text-[11px] text-gray-400 py-0.5 leading-snug">
                    <span className="text-gray-500">Row {er.row}:</span> {er.error}
                  </div>
                ))}
              </div>
            )}

            <div className="flex items-center justify-end gap-2 pt-1">
              <DialogClose
                render={
                  <Button className="bg-[#D4A373] hover:bg-[#D4A373]/85 text-[#1E2328] font-medium h-8 text-sm">
                    {t("leads.importClose")}
                  </Button>
                }
              />
            </div>
          </div>
        )}

        {/* Second confirmation dialog — guard the destructive write */}
        <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
          <DialogContent className="sm:max-w-sm bg-[#1E2328] border-gray-800 text-gray-100">
            <DialogHeader>
              <DialogTitle className="text-white text-base flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 text-amber-400" />
                {t("leads.importConfirm")}
              </DialogTitle>
            </DialogHeader>
            <p className="text-sm text-gray-300 pt-1">
              {t("leads.importConfirmWarning").replace("{n}", String(preview?.importable ?? 0))}
            </p>
            <div className="flex items-center justify-end gap-2 pt-3">
              <DialogClose
                render={
                  <Button variant="ghost" className="text-gray-400 h-8">
                    {t("common.cancel")}
                  </Button>
                }
              />
              <Button
                onClick={doImport}
                disabled={importing}
                className="bg-[#D4A373] hover:bg-[#D4A373]/85 text-[#1E2328] font-medium h-8 text-sm gap-1.5"
              >
                {importing && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                {t("common.confirm")}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </DialogContent>
    </Dialog>
  );
}
