"use client";

/**
 * Cable & pulling-labour costing — interactive form.
 *
 * ---------------------------------------------------------------------------
 * PUBLIC REPOSITORY / PRICE BOUNDARY
 * Not a single price, rate, coefficient or per-point tariff appears in this
 * file, and none is derivable from it: the component holds no arithmetic. It
 * posts the form to `/api/cable-costing/calculate` and renders the numbers the
 * server sends back. The rate card lives only in the server-only configuration
 * loaded from `CABLE_COSTING_CONFIG`.
 *
 * This file also never touches Supabase. The page it lives under
 * (`page.tsx`) does the server-side session gate; every figure on screen
 * arrives through a `fetch` to an authenticated API route.
 * ---------------------------------------------------------------------------
 *
 * Types are imported from `@/lib/cable-costing/types`, not from the barrel
 * `@/lib/cable-costing`: the barrel re-exports the engine's *values*, and
 * pulling the engine into a client module would put domain code in the browser
 * bundle. `types.ts` is declarations only, so `import type` from it erases
 * completely at build time and the API response shape still cannot drift from
 * the engine's contract.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, Download, Loader2, RotateCcw, ServerCog } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ErrorState } from "@/components/ui/error-state";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { useLanguage } from "@/lib/i18n/LanguageContext";
import type {
  CableCostingResult,
  PointCatalogueEntry,
  Tier,
} from "@/lib/cable-costing/types";

/* ─── API contracts (mirror the two route handlers) ─── */

interface CatalogueResponse {
  modelVersion: string;
  currency: string;
  tiers: Tier[];
  points: PointCatalogueEntry[];
}

interface CalculateResponse {
  result: CableCostingResult;
}

const TIERS: readonly Tier[] = ["internal", "client"];

/** Cell class shared by every numeric cell: right-aligned, non-jittering digits. */
const NUM_CELL = "text-right tabular-nums whitespace-nowrap";

/* ─── Helpers ─── */

/**
 * AED are quoted to the fil. Fixed 2dp with grouping, always `en-US` so the
 * digits and separators do not change when the UI language is toggled — a
 * quote read aloud in Chinese is still an AED figure.
 */
function fmtMoney(value: number): string {
  return value.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function fmtNumber(value: number, digits: number): string {
  return value.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

/** `{ error: string }` is the shape every failure branch of the routes uses. */
async function readErrorMessage(response: Response): Promise<string> {
  try {
    const body: unknown = await response.json();
    if (body && typeof body === "object") {
      const error = (body as { error?: unknown }).error;
      if (typeof error === "string" && error.length > 0) return error;
    }
  } catch {
    // A non-JSON body carries nothing worth showing; the caller falls back to
    // its own wording.
  }
  return "";
}

function filenameFromDisposition(header: string | null): string | null {
  if (!header) return null;
  const match = /filename="([^"]+)"/.exec(header);
  return match ? match[1] : null;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

/** Blank input means "none of this point", not "invalid". */
function parseQuantity(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return 0;
  return Number(raw);
}

/**
 * Catalogue outcomes are described, not rendered, by this helper: it runs
 * outside React and therefore cannot reach `t()`. The component maps a failure
 * kind to wording. It never rejects, so the caller needs no `.catch`.
 */
type CatalogueFailure = "config" | "unauthorized" | "failed";

type CatalogueOutcome =
  | { ok: true; catalogue: CatalogueResponse }
  | { ok: false; failure: CatalogueFailure; detail: string };

async function requestCatalogue(): Promise<CatalogueOutcome> {
  try {
    const response = await fetch("/api/cable-costing/catalogue", { cache: "no-store" });
    if (!response.ok) {
      const detail = await readErrorMessage(response);
      if (response.status === 503) return { ok: false, failure: "config", detail };
      if (response.status === 401) return { ok: false, failure: "unauthorized", detail };
      return { ok: false, failure: "failed", detail };
    }
    return { ok: true, catalogue: (await response.json()) as CatalogueResponse };
  } catch (err) {
    return { ok: false, failure: "failed", detail: errorMessage(err, "") };
  }
}

/* ─── Component ─── */

export default function CableCostingClient() {
  const { lang, t } = useLanguage();

  const [catalogue, setCatalogue] = useState<CatalogueResponse | null>(null);
  const [catalogueLoading, setCatalogueLoading] = useState(true);
  const [catalogueError, setCatalogueError] = useState<string | null>(null);

  const [areaSqm, setAreaSqm] = useState("");
  const [floors, setFloors] = useState("");
  const [tier, setTier] = useState<Tier>("internal");
  const [quantities, setQuantities] = useState<Record<string, string>>({});

  const [result, setResult] = useState<CableCostingResult | null>(null);
  const [calculating, setCalculating] = useState(false);
  const [exporting, setExporting] = useState(false);

  /** 400 from the engine — shown next to the buttons, in the engine's words. */
  const [inputError, setInputError] = useState<string | null>(null);
  /** 503 — the rate card is missing. An operator task, so it gets its own panel. */
  const [configError, setConfigError] = useState<string | null>(null);

  const pointName = useCallback(
    (point: { nameCn: string; nameEn: string }) => (lang === "zh" ? point.nameCn : point.nameEn),
    [lang],
  );

  /* ─── Catalogue ─── */

  /**
   * Every catalogue outcome lands here, so a retry cannot leave a stale error
   * sitting next to fresh data. It is called from a promise callback rather than
   * from the effect body: a synchronous setState inside an effect is both a
   * cascading render and a lint error (react-hooks/set-state-in-effect).
   */
  const applyCatalogue = useCallback(
    (outcome: CatalogueOutcome) => {
      setCatalogueLoading(false);
      if (outcome.ok) {
        setCatalogue(outcome.catalogue);
        setCatalogueError(null);
        setConfigError(null);
        return;
      }
      setCatalogue(null);
      if (outcome.failure === "config") {
        setConfigError(outcome.detail);
        setCatalogueError(null);
        return;
      }
      setConfigError(null);
      setCatalogueError(
        outcome.failure === "unauthorized"
          ? t("cableCosting.sessionExpired")
          : outcome.detail || t("cableCosting.catalogueFailed"),
      );
    },
    [t],
  );

  useEffect(() => {
    let active = true;
    void requestCatalogue().then((outcome) => {
      // A language toggle re-runs this effect; the guard stops an in-flight
      // answer from overwriting the newer one.
      if (active) applyCatalogue(outcome);
    });
    return () => {
      active = false;
    };
  }, [applyCatalogue]);

  /** Retry from a button: the spinner may be raised synchronously here. */
  const retryCatalogue = useCallback(() => {
    setCatalogueLoading(true);
    void requestCatalogue().then(applyCatalogue);
  }, [applyCatalogue]);

  /* ─── Derived form state ─── */

  const points = catalogue?.points ?? [];

  /**
   * Points keep the catalogue's order inside each system group: the server
   * emits them in rate-card order, which is the order the estimators know.
   */
  const groupedPoints = useMemo(() => {
    const groups: { system: string; entries: PointCatalogueEntry[] }[] = [];
    const index = new Map<string, PointCatalogueEntry[]>();
    for (const point of points) {
      let bucket = index.get(point.system);
      if (!bucket) {
        bucket = [];
        index.set(point.system, bucket);
        groups.push({ system: point.system, entries: bucket });
      }
      bucket.push(point);
    }
    return groups;
  }, [points]);

  const totalPoints = useMemo(() => {
    let sum = 0;
    for (const point of points) {
      const value = parseQuantity(quantities[point.id]);
      if (Number.isFinite(value)) sum += value;
    }
    return sum;
  }, [points, quantities]);

  /**
   * Every catalogue id is sent, blanks as 0. The engine rejects ids it does not
   * know, so the catalogue is the only legitimate key set; sending zeros keeps
   * the exported "point quantities as submitted" sheet complete.
   */
  const buildBody = useCallback(() => {
    const payload: Record<string, number> = {};
    for (const point of points) payload[point.id] = parseQuantity(quantities[point.id]);
    return {
      areaSqm: areaSqm.trim() === "" ? Number.NaN : Number(areaSqm),
      floors: floors.trim() === "" ? Number.NaN : Number(floors),
      quantities: payload,
      tier,
    };
  }, [areaSqm, floors, points, quantities, tier]);

  /**
   * One place decides what a failed response means, so /calculate and /export
   * cannot disagree about which status is the operator's problem and which is
   * the user's.
   */
  const handleFailure = useCallback(
    async (response: Response) => {
      const detail = await readErrorMessage(response);
      if (response.status === 503) {
        setConfigError(detail);
        toast.error(t("cableCosting.configMissing"));
        return;
      }
      if (response.status === 400) {
        setInputError(detail || t("cableCosting.inputInvalid"));
        toast.error(t("cableCosting.inputInvalid"));
        return;
      }
      if (response.status === 401) {
        toast.error(t("cableCosting.sessionExpired"));
        return;
      }
      toast.error(detail || t("cableCosting.requestFailed"));
    },
    [t],
  );

  const handleCalculate = useCallback(async () => {
    setCalculating(true);
    setInputError(null);
    setConfigError(null);
    try {
      const response = await fetch("/api/cable-costing/calculate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildBody()),
      });
      if (!response.ok) {
        setResult(null);
        await handleFailure(response);
        return;
      }
      const body = (await response.json()) as CalculateResponse;
      setResult(body.result);
    } catch (err) {
      setResult(null);
      toast.error(errorMessage(err, t("cableCosting.requestFailed")));
    } finally {
      setCalculating(false);
    }
  }, [buildBody, handleFailure, t]);

  const handleExport = useCallback(async () => {
    setExporting(true);
    setInputError(null);
    try {
      const response = await fetch("/api/cable-costing/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildBody()),
      });
      if (!response.ok) {
        await handleFailure(response);
        return;
      }
      const blob = await response.blob();
      // The server already named the file (tier + date); the fallback only
      // covers a proxy that strips the header.
      const filename =
        filenameFromDisposition(response.headers.get("content-disposition")) ??
        `cable_costing_${tier}.xlsx`;
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      toast.success(t("cableCosting.exportDone"));
    } catch (err) {
      toast.error(errorMessage(err, t("cableCosting.requestFailed")));
    } finally {
      setExporting(false);
    }
  }, [buildBody, handleFailure, t, tier]);

  const handleClearQuantities = useCallback(() => {
    setQuantities({});
    setResult(null);
    setInputError(null);
  }, []);

  const busy = calculating || exporting;

  /* ─── Config panel (503) ─── */

  if (configError !== null) {
    return (
      <div className="space-y-5">
        <PageHeader modelVersion={catalogue?.modelVersion} />
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
            <ServerCog className="size-8 text-amber-500" />
            <p className="text-sm font-medium">{t("cableCosting.configMissing")}</p>
            {configError.length > 0 && (
              <p className="max-w-xl text-xs text-muted-foreground break-words">{configError}</p>
            )}
            <Button variant="outline" size="sm" onClick={retryCatalogue}>
              {t("cableCosting.retry")}
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  /* ─── Catalogue states ─── */

  if (catalogueLoading) {
    return (
      <div className="space-y-5">
        <PageHeader />
        <div className="flex h-48 items-center justify-center">
          <Loader2 className="size-6 animate-spin text-muted-foreground" />
        </div>
      </div>
    );
  }

  if (catalogueError !== null) {
    return (
      <div className="space-y-5">
        <PageHeader />
        <ErrorState
          message={catalogueError}
          retryText={t("cableCosting.retry")}
          onRetry={retryCatalogue}
        />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <PageHeader modelVersion={catalogue?.modelVersion} />

      {/* ─── Inputs ─── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("cableCosting.inputsHeading")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <div>
              <label
                htmlFor="cable-costing-area"
                className="mb-1.5 block text-xs text-muted-foreground"
              >
                {t("cableCosting.areaLabel")}
              </label>
              <Input
                id="cable-costing-area"
                type="number"
                min="0"
                inputMode="decimal"
                value={areaSqm}
                onChange={(e) => setAreaSqm(e.target.value)}
                placeholder={t("cableCosting.areaPlaceholder")}
                className={cn("h-9", NUM_CELL)}
              />
            </div>
            <div>
              <label
                htmlFor="cable-costing-floors"
                className="mb-1.5 block text-xs text-muted-foreground"
              >
                {t("cableCosting.floorsLabel")}
              </label>
              <Input
                id="cable-costing-floors"
                type="number"
                min="1"
                step="1"
                inputMode="numeric"
                value={floors}
                onChange={(e) => setFloors(e.target.value)}
                placeholder={t("cableCosting.floorsPlaceholder")}
                className={cn("h-9", NUM_CELL)}
              />
            </div>
            <div>
              <span className="mb-1.5 block text-xs text-muted-foreground">
                {t("cableCosting.tierLabel")}
              </span>
              {/* Two mutually exclusive buttons rather than a Select: the tier
                  decides whether the figures may be shown to a customer, so it
                  has to stay legible without opening anything. */}
              <div className="flex gap-2" role="group" aria-label={t("cableCosting.tierLabel")}>
                {TIERS.map((value) => (
                  <Button
                    key={value}
                    type="button"
                    size="lg"
                    variant={tier === value ? "default" : "outline"}
                    aria-pressed={tier === value}
                    className="flex-1"
                    onClick={() => {
                      setTier(value);
                      // The old result was priced on the other basis; keeping it
                      // on screen under a new tier label would misreport it.
                      setResult(null);
                    }}
                  >
                    {t(`cableCosting.tier_${value}`)}
                  </Button>
                ))}
              </div>
              <p className="mt-1.5 text-[11px] leading-snug text-muted-foreground">
                {t(`cableCosting.tierHint_${tier}`)}
              </p>
            </div>
          </div>

          <Separator />

          <div>
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 className="text-sm font-medium">{t("cableCosting.pointsHeading")}</h2>
                <p className="text-xs text-muted-foreground">{t("cableCosting.pointsHint")}</p>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-xs text-muted-foreground tabular-nums">
                  {t("cableCosting.totalPoints")}: {totalPoints}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={handleClearQuantities}
                  disabled={busy || totalPoints === 0}
                >
                  <RotateCcw />
                  {t("cableCosting.clearQuantities")}
                </Button>
              </div>
            </div>

            {points.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t("cableCosting.noPoints")}</p>
            ) : (
              <div className="space-y-4">
                {groupedPoints.map((group) => (
                  <div key={group.system}>
                    <p className="mb-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">
                      {group.system}
                    </p>
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
                      {group.entries.map((point) => (
                        <div key={point.id} className="flex items-center gap-3">
                          <label
                            htmlFor={`cable-costing-qty-${point.id}`}
                            className="min-w-0 flex-1"
                          >
                            <span className="block truncate text-sm" title={pointName(point)}>
                              {pointName(point)}
                            </span>
                            <span className="text-[11px] text-muted-foreground">
                              {point.topology}
                            </span>
                          </label>
                          <Input
                            id={`cable-costing-qty-${point.id}`}
                            type="number"
                            min="0"
                            step="1"
                            inputMode="numeric"
                            value={quantities[point.id] ?? ""}
                            onChange={(e) =>
                              setQuantities((prev) => ({ ...prev, [point.id]: e.target.value }))
                            }
                            placeholder="0"
                            className={cn("h-9 w-20 shrink-0", NUM_CELL)}
                          />
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <Separator />

          <div className="flex flex-wrap items-center gap-3">
            <Button type="button" size="lg" onClick={() => void handleCalculate()} disabled={busy}>
              {calculating && <Loader2 className="animate-spin" />}
              {calculating ? t("cableCosting.calculating") : t("cableCosting.calculate")}
            </Button>
            <Button
              type="button"
              size="lg"
              variant="outline"
              onClick={() => void handleExport()}
              disabled={busy}
            >
              {exporting ? <Loader2 className="animate-spin" /> : <Download />}
              {exporting ? t("cableCosting.exporting") : t("cableCosting.export")}
            </Button>
            {inputError !== null && (
              <p className="flex items-start gap-1.5 text-sm text-destructive">
                <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                <span className="break-words">{inputError}</span>
              </p>
            )}
          </div>
        </CardContent>
      </Card>

      {/* ─── Results ─── */}
      {result === null ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            {t("cableCosting.noResult")}
          </CardContent>
        </Card>
      ) : (
        <ResultView result={result} tier={tier} pointName={pointName} t={t} />
      )}
    </div>
  );
}

/* ─── Header ─── */

function PageHeader({ modelVersion }: { modelVersion?: string }) {
  const { t } = useLanguage();
  return (
    <div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h1 className="text-xl font-semibold">{t("cableCosting.title")}</h1>
        {modelVersion && (
          <Badge variant="outline" className="tabular-nums">
            {t("cableCosting.modelVersion")} {modelVersion}
          </Badge>
        )}
      </div>
      <p className="mt-1 text-sm text-muted-foreground">{t("cableCosting.subtitle")}</p>
    </div>
  );
}

/* ─── Result blocks ─── */

interface ResultViewProps {
  result: CableCostingResult;
  tier: Tier;
  pointName: (point: { nameCn: string; nameEn: string }) => string;
  t: (path: string) => string;
}

function ResultView({ result, tier, pointName, t }: ResultViewProps) {
  const currency = result.currency;
  return (
    <div className="space-y-5">
      {/* Warnings first: an expired supplier quote or an estimated cable price
          changes whether these figures may be sent to a customer, so it must be
          read before the totals, not after them. */}
      {result.warnings.length > 0 && (
        <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-4">
          <p className="flex items-center gap-2 text-sm font-medium text-amber-700 dark:text-amber-400">
            <AlertTriangle className="size-4 shrink-0" />
            {t("cableCosting.warningsHeading")}
          </p>
          <ul className="mt-2 space-y-1.5 pl-6">
            {result.warnings.map((warning, index) => (
              // Index-qualified key: the engine may emit the same sentence for two
              // different cables, and a duplicate key would drop one line.
              <li key={`${index}-${warning}`} className="list-disc text-xs leading-relaxed break-words">
                {warning}
              </li>
            ))}
          </ul>
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            {t("cableCosting.cablesHeading")}
            <span className="ml-2 text-xs font-normal text-muted-foreground">({currency})</span>
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {result.cables.length === 0 ? (
            <p className="px-4 pb-4 text-sm text-muted-foreground">
              {t("cableCosting.noCableLines")}
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("cableCosting.cableModel")}</TableHead>
                  <TableHead className="text-right">{t("cableCosting.metres")}</TableHead>
                  <TableHead className="text-right">{t("cableCosting.unitPrice")}</TableHead>
                  <TableHead className="text-right">{t("cableCosting.amount")}</TableHead>
                  <TableHead>{t("cableCosting.grade")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {result.cables.map((cable) => (
                  <TableRow key={cable.cableId}>
                    <TableCell>
                      <span className="block text-sm">{pointName(cable)}</span>
                      <span className="text-[11px] text-muted-foreground">{cable.cableId}</span>
                    </TableCell>
                    <TableCell className={NUM_CELL}>{fmtNumber(cable.metres, 2)}</TableCell>
                    <TableCell className={NUM_CELL}>{fmtMoney(cable.unitPrice)}</TableCell>
                    <TableCell className={cn(NUM_CELL, "font-medium")}>
                      {fmtMoney(cable.amount)}
                    </TableCell>
                    <TableCell>
                      {/* An estimate is the one thing on this row that can make
                          the total wrong, so it is coloured, not just worded. */}
                      <Badge variant={cable.grade === "supplier_quote" ? "secondary" : "destructive"}>
                        {t(`cableCosting.grade_${cable.grade}`)}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            {t("cableCosting.labourHeading")}
            <span className="ml-2 text-xs font-normal text-muted-foreground">({currency})</span>
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {result.labour.lines.length === 0 ? (
            <p className="px-4 pb-4 text-sm text-muted-foreground">
              {t("cableCosting.noLabourLines")}
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("cableCosting.pointColumn")}</TableHead>
                  <TableHead className="text-right">{t("cableCosting.pointsColumn")}</TableHead>
                  <TableHead className="text-right">{t("cableCosting.pullMinutes")}</TableHead>
                  <TableHead className="text-right">{t("cableCosting.terminateMinutes")}</TableHead>
                  <TableHead className="text-right">{t("cableCosting.crewHours")}</TableHead>
                  <TableHead className="text-right">{t("cableCosting.amount")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {result.labour.lines.map((line) => (
                  <TableRow key={line.pointId}>
                    <TableCell>
                      <span className="block text-sm">{pointName(line)}</span>
                      <span className="text-[11px] text-muted-foreground">{line.pointId}</span>
                    </TableCell>
                    <TableCell className={NUM_CELL}>{line.points}</TableCell>
                    <TableCell className={NUM_CELL}>{fmtNumber(line.pullMinutes, 1)}</TableCell>
                    <TableCell className={NUM_CELL}>
                      {fmtNumber(line.terminateMinutes, 1)}
                    </TableCell>
                    <TableCell className={NUM_CELL}>{fmtNumber(line.totalHours, 2)}</TableCell>
                    <TableCell className={cn(NUM_CELL, "font-medium")}>
                      {fmtMoney(line.amount)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <SummaryCard result={result} tier={tier} t={t} />
    </div>
  );
}

function SummaryRow({
  label,
  value,
  note,
  emphasis,
}: {
  label: string;
  value: string;
  note?: string;
  emphasis?: "none" | "subtotal" | "total";
}) {
  const level = emphasis ?? "none";
  return (
    <div
      className={cn(
        "flex items-baseline justify-between gap-4 py-1.5",
        level === "total" && "border-t pt-3 mt-1",
        level === "subtotal" && "border-t",
      )}
    >
      <span
        className={cn(
          "text-sm",
          level === "none" && "text-muted-foreground",
          level === "subtotal" && "font-medium",
          level === "total" && "font-semibold",
        )}
      >
        {label}
        {note && <span className="ml-1.5 text-[11px] text-muted-foreground">{note}</span>}
      </span>
      <span
        className={cn(
          "tabular-nums whitespace-nowrap",
          level === "none" && "text-sm",
          level === "subtotal" && "text-sm font-medium",
          level === "total" && "text-lg font-semibold",
        )}
      >
        {value}
      </span>
    </div>
  );
}

function SummaryCard({
  result,
  tier,
  t,
}: {
  result: CableCostingResult;
  tier: Tier;
  t: (path: string) => string;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">
          {t("cableCosting.summaryHeading")}
          <span className="ml-2 text-xs font-normal text-muted-foreground">
            ({result.currency}) · {t(`cableCosting.tier_${tier}`)}
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-1 gap-x-10 lg:grid-cols-2">
          <div>
            <SummaryRow
              label={t("cableCosting.materialSubtotal")}
              value={fmtMoney(result.materialSubtotal)}
            />
            <SummaryRow label={t("cableCosting.wastage")} value={fmtMoney(result.wastage)} />
            <SummaryRow
              label={t("cableCosting.materialTotal")}
              value={fmtMoney(result.materialTotal)}
              emphasis="subtotal"
            />
            <SummaryRow
              label={t("cableCosting.labourSubtotal")}
              value={fmtMoney(result.labour.subtotal)}
              emphasis="subtotal"
            />
          </div>
          <div>
            {/* Markup and subcontract margin are already inside the figures
                above, so they are labelled as inclusions. Reading them as extra
                addends would double-count them. */}
            <SummaryRow
              label={t("cableCosting.markup")}
              note={t("cableCosting.markupNote")}
              value={fmtMoney(result.overheads.markup)}
            />
            <SummaryRow
              label={t("cableCosting.subcontractMargin")}
              note={t("cableCosting.subcontractMarginNote")}
              value={fmtMoney(result.overheads.subcontractMargin)}
            />
            <SummaryRow
              label={t("cableCosting.totalExVat")}
              value={fmtMoney(result.totalExVat)}
              emphasis="subtotal"
            />
            <SummaryRow label={t("cableCosting.vat")} value={fmtMoney(result.vat)} />
            <SummaryRow
              label={t("cableCosting.total")}
              value={fmtMoney(result.total)}
              emphasis="total"
            />
          </div>
        </div>

        <Separator className="my-4" />

        <div className="flex flex-wrap gap-x-8 gap-y-2 text-xs text-muted-foreground">
          <span>
            {t("cableCosting.totalMetres")}:{" "}
            <span className="tabular-nums text-foreground">
              {fmtNumber(result.derived.totalMetres, 2)}
            </span>
          </span>
          <span>
            {t("cableCosting.crewDays")}:{" "}
            <span className="tabular-nums text-foreground">
              {fmtNumber(result.derived.crewDays, 2)}
            </span>
          </span>
        </div>
      </CardContent>
    </Card>
  );
}
