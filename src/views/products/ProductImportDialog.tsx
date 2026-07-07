"use client";

import { useState, useRef, useCallback } from "react";
import { Button } from "@/views/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogClose,
} from "@/views/ui/dialog";
import { Loader2, Upload, FileText, CheckCircle2, XCircle, AlertCircle } from "lucide-react";
import { useLanguage } from "@/views/i18n/LanguageContext";
import { cn } from "@/models/utils";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImported: () => void;
}

type Step = "upload" | "preview" | "importing" | "results";

interface PreviewRow {
  index: number;
  data: Record<string, string>;
}

interface ImportResult {
  created: number;
  total: number;
  failed?: { row: number; data: Record<string, string>; reason: string }[];
  error?: string;
}

export default function ProductImportDialog({ open, onOpenChange, onImported }: Props) {
  const { t } = useLanguage();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [step, setStep] = useState<Step>("upload");
  const [file, setFile] = useState<File | null>(null);
  const [previewRows, setPreviewRows] = useState<PreviewRow[]>([]);
  const [allRows, setAllRows] = useState<Record<string, string>[]>([]);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [dragOver, setDragOver] = useState(false);

  function resetState() {
    setStep("upload");
    setFile(null);
    setPreviewRows([]);
    setAllRows([]);
    setResult(null);
    setDragOver(false);
  }

  function handleOpenChange(open: boolean) {
    if (!open) resetState();
    onOpenChange(open);
  }

  function parseCSVText(text: string): Record<string, string>[] {
    const lines = text.trim().split(/\r?\n/);
    if (lines.length < 2) return [];

    const headers = lines[0].split(",").map((h) => h.trim().toLowerCase().replace(/\s+/g, "_"));
    const rows: Record<string, string>[] = [];

    for (let i = 1; i < lines.length; i++) {
      const values = lines[i].split(",");
      if (values.length === 0 || (values.length === 1 && values[0].trim() === "")) continue;
      const row: Record<string, string> = {};
      for (let j = 0; j < headers.length; j++) {
        row[headers[j]] = (values[j] ?? "").trim();
      }
      rows.push(row);
    }
    return rows;
  }

  function handleFile(file: File) {
    if (!file.name.endsWith(".csv") && !file.name.endsWith(".CSV")) {
      alert(t("products.importInvalidFile"));
      return;
    }

    setFile(file);

    const reader = new FileReader();
    reader.onload = (e) => {
      const text = e.target?.result as string;
      const rows = parseCSVText(text);
      setAllRows(rows);
      setPreviewRows(rows.slice(0, 5).map((data, i) => ({ index: i + 1, data })));
      setStep("preview");
    };
    reader.readAsText(file);
  }

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const droppedFile = e.dataTransfer.files[0];
    if (droppedFile) handleFile(droppedFile);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
  }, []);

  async function startImport() {
    if (!file) return;
    setStep("importing");

    const formData = new FormData();
    formData.append("file", file);

    try {
      const res = await fetch("/api/products/import", {
        method: "POST",
        body: formData,
      });

      const data = await res.json();

      if (!res.ok) {
        setResult({ created: 0, total: allRows.length, error: data.error || "Import failed" });
      } else {
        setResult({
          created: data.created,
          total: data.total,
          failed: data.failed,
        });
      }

      if (data.created > 0) {
        onImported();
      }
    } catch (err: any) {
      setResult({ created: 0, total: allRows.length, error: err.message || "Network error" });
    }

    setStep("results");
  }

  // Get unique headers from preview rows for the table
  const previewHeaders = previewRows.length > 0
    ? Object.keys(previewRows[0].data).filter((k) => k)
    : [];

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-xl bg-[#1E2328] border-gray-800 text-gray-100">
        <DialogHeader>
          <DialogTitle className="text-white text-lg">
            {t("products.importTitle")}
          </DialogTitle>
        </DialogHeader>

        {/* Step: Upload */}
        {step === "upload" && (
          <div className="space-y-4 pt-2">
            <div
              onDrop={handleDrop}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              className={cn(
                "border-2 border-dashed rounded-xl p-8 text-center transition-colors cursor-pointer",
                dragOver
                  ? "border-copper-500 bg-copper-500/5"
                  : "border-gray-700 hover:border-gray-500 bg-gray-900/50",
              )}
              onClick={() => fileInputRef.current?.click()}
            >
              <Upload className="w-8 h-8 mx-auto text-gray-500 mb-3" />
              <p className="text-sm text-gray-300 font-medium">
                {t("products.importDropCSV")}
              </p>
              <p className="text-xs text-gray-500 mt-1">
                {t("products.importCSVFormat")}
              </p>
              <input
                ref={fileInputRef}
                type="file"
                accept=".csv"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) handleFile(f);
                }}
              />
            </div>

            <div className="bg-gray-900/50 rounded-lg p-3 text-xs text-gray-400 space-y-1">
              <p className="text-gray-300 font-medium mb-1">
                <FileText className="w-3.5 h-3.5 inline mr-1" />
                {t("products.importExpectedColumns")}
              </p>
              <p><code className="text-copper-400">name*</code>, category, sku, unit_price, description, unit</p>
              <p className="text-gray-500 mt-1">{t("products.importNotes")}</p>
            </div>
          </div>
        )}

        {/* Step: Preview */}
        {step === "preview" && (
          <div className="space-y-4 pt-2">
            <div className="flex items-center gap-2 text-sm">
              <FileText className="w-4 h-4 text-copper-400" />
              <span className="text-gray-300">{file?.name}</span>
              <span className="text-gray-500 text-xs">
                ({allRows.length} {t("products.importRowsFound")})
              </span>
            </div>

            <div className="bg-gray-900/50 rounded-lg overflow-hidden">
              <div className="max-h-48 overflow-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-gray-800">
                      <th className="px-3 py-2 text-left text-gray-500 font-medium">#</th>
                      {previewHeaders.map((h) => (
                        <th key={h} className="px-3 py-2 text-left text-gray-500 font-medium capitalize">
                          {h.replace(/_/g, " ")}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {previewRows.map((pr) => (
                      <tr key={pr.index} className="border-b border-gray-800/50 last:border-0">
                        <td className="px-3 py-1.5 text-gray-500">{pr.index}</td>
                        {previewHeaders.map((h) => (
                          <td key={h} className="px-3 py-1.5 text-gray-300 max-w-[150px] truncate">
                            {pr.data[h] || "—"}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {allRows.length > 5 && (
              <p className="text-xs text-gray-500 text-center">
                {t("products.importPreviewNote").replace("{n}", String(allRows.length - 5))}
              </p>
            )}

            <div className="flex items-center justify-between pt-2">
              <Button
                variant="ghost"
                className="text-gray-400 h-8"
                onClick={() => setStep("upload")}
              >
                {t("common.back")}
              </Button>
              <Button
                onClick={startImport}
                className="bg-[#D4A373] hover:bg-[#D4A373]/85 text-[#1E2328] font-medium h-8 text-sm"
              >
                {t("products.importStartBtn").replace("{n}", String(allRows.length))}
              </Button>
            </div>
          </div>
        )}

        {/* Step: Importing */}
        {step === "importing" && (
          <div className="py-10 text-center space-y-4">
            <Loader2 className="w-10 h-10 animate-spin text-copper-400 mx-auto" />
            <div>
              <p className="text-gray-300 font-medium">
                {t("products.importProgress")}
              </p>
              <p className="text-xs text-gray-500 mt-1">
                {t("products.importProgressDesc").replace("{n}", String(allRows.length))}
              </p>
            </div>
          </div>
        )}

        {/* Step: Results */}
        {step === "results" && result && (
          <div className="space-y-4 pt-2">
            {result.error ? (
              <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-4 text-center">
                <XCircle className="w-8 h-8 text-red-400 mx-auto mb-2" />
                <p className="text-red-400 font-medium">{t("products.importFailed")}</p>
                <p className="text-xs text-red-400/70 mt-1">{result.error}</p>
              </div>
            ) : (
              <>
                <div className="grid grid-cols-2 gap-3">
                  <div className="bg-emerald-500/10 border border-emerald-500/20 rounded-xl p-4 text-center">
                    <CheckCircle2 className="w-6 h-6 text-emerald-400 mx-auto mb-1" />
                    <p className="text-lg font-bold text-emerald-400">{result.created}</p>
                    <p className="text-xs text-emerald-400/70">{t("products.importCreated")}</p>
                  </div>
                  <div className={cn(
                    "rounded-xl p-4 text-center border",
                    (result.failed?.length ?? 0) > 0
                      ? "bg-amber-500/10 border-amber-500/20"
                      : "bg-gray-500/10 border-gray-500/20",
                  )}>
                    <AlertCircle className={cn(
                      "w-6 h-6 mx-auto mb-1",
                      (result.failed?.length ?? 0) > 0 ? "text-amber-400" : "text-gray-400",
                    )} />
                    <p className={cn(
                      "text-lg font-bold",
                      (result.failed?.length ?? 0) > 0 ? "text-amber-400" : "text-gray-400",
                    )}>
                      {result.failed?.length ?? 0}
                    </p>
                    <p className="text-xs text-gray-400">{t("products.importFailedCount")}</p>
                  </div>
                </div>

                {result.failed && result.failed.length > 0 && (
                  <div className="bg-amber-500/5 border border-amber-500/10 rounded-lg p-3 max-h-40 overflow-auto">
                    <p className="text-xs text-amber-400 font-medium mb-2">{t("products.importFailures")}:</p>
                    {result.failed.map((f, i) => (
                      <div key={i} className="text-xs text-gray-400 py-0.5">
                        <span className="text-amber-400/70">{f.reason}</span>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}

            <div className="flex items-center justify-end gap-2 pt-2">
              {result.failed && result.failed.length > 0 && (
                <Button
                  variant="ghost"
                  className="text-gray-400 h-8 text-sm"
                  onClick={() => setStep("preview")}
                >
                  {t("common.retry")}
                </Button>
              )}
              <DialogClose
                render={
                  <Button className="bg-[#D4A373] hover:bg-[#D4A373]/85 text-[#1E2328] font-medium h-8 text-sm">
                    {t("quotes.close")}
                  </Button>
                }
              />
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
