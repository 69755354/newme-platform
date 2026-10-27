// RBAC: user (authenticated)
//
// Any signed-in employee (admin | boss | operator | sales) may export a costing:
// this is an internal estimating tool, so no role is filtered here.
// Authorization is the caller-scoped Supabase session only — never service_role
// (03_ARCHITECTURE_RULES.yaml rule_102).
//
// PUBLIC REPOSITORY / PRICE BOUNDARY: no price, rate or coefficient appears in
// this file. The rate card is loaded server-side from `CABLE_COSTING_CONFIG`;
// every figure written into the workbook comes from the engine's result for this
// request. The arithmetic is never re-stated here (rule_014): the totals rows
// echo `CableCostingResult` fields rather than re-adding the line items, so the
// spreadsheet cannot disagree with the API.

import { NextRequest, NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase-server";
import { applyPrivateNoStore } from "@/lib/request-auth-context";
import { genReqId, logger } from "@/lib/logger";
import {
  CableCostingInputError,
  calculateCableCosting,
  getPointCatalogue,
} from "@/lib/cable-costing";
import type {
  CableCostingConfig,
  CableCostingInput,
  CableCostingResult,
} from "@/lib/cable-costing";
import { CableCostingConfigError, loadCableCostingConfig } from "@/lib/cable-costing/config";

/**
 * POST /api/cable-costing/export
 *
 * Input:  the same body as POST /api/cable-costing/calculate —
 *         { areaSqm, floors, quantities, tier }
 * Output: an .xlsx attachment with four sheets — Inputs (echo of what was
 *         priced), Cables (material line items), Labour (labour line items),
 *         Summary (wastage, markup, VAT, grand total).
 *
 * Errors: 401 not signed in · 400 unparseable body or rejected input ·
 *         503 `CABLE_COSTING_CONFIG` absent or invalid ·
 *         500 anything else (message withheld in production).
 */

type Cell = string | number;

interface SheetSpec {
  name: string;
  rows: Cell[][];
  /** Column widths in characters. */
  colWidths: number[];
  /** Zero-based columns whose numeric cells render with two decimals. */
  decimalColumns: number[];
}

const TWO_DECIMALS = "0.00";
const XLSX_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/** AED are quoted to the fil, so every money and metre figure is held to 2dp. */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** `back_solved` never reaches here — the engine already folds it into `estimate`. */
function gradeLabel(grade: CableCostingResult["cables"][number]["grade"]): string {
  return grade === "supplier_quote" ? "supplier_quote 供应商报价" : "estimate 估价";
}

function tierLabel(tier: CableCostingInput["tier"]): string {
  return tier === "internal"
    ? "internal — 内部成本版 / cost-plus basis"
    : "client — 客户版 / per-point client tariff";
}

function buildSheets(
  input: CableCostingInput,
  result: CableCostingResult,
  config: CableCostingConfig,
): SheetSpec[] {
  const catalogue = getPointCatalogue(config);
  const currency = result.currency;

  // --- Sheet 1: what was priced -------------------------------------------
  const inputRows: Cell[][] = [
    ["NewMe 线材与穿线报价 / Cable & Pulling Labour Costing"],
    ["模型版本 / Model version", config.modelVersion],
    ["币种 / Currency", currency],
    ["报价口径 / Tier", tierLabel(input.tier)],
    ["建筑面积 / Gross area (m²)", input.areaSqm],
    ["层数 / Floors", input.floors],
    ["导出时间 / Exported at (UTC)", new Date().toISOString()],
    [],
    ["点位数量回显 / Point quantities as submitted"],
    [
      "点位 ID / Point ID",
      "名称",
      "Name",
      "系统 / System",
      "拓扑 / Topology",
      "数量 / Points",
      "每点线长 / Metres per point",
    ],
  ];
  let totalPoints = 0;
  for (const point of catalogue) {
    const count = input.quantities[point.id] ?? 0;
    totalPoints += count;
    inputRows.push([
      point.id,
      point.nameCn,
      point.nameEn,
      point.system,
      point.topology,
      count,
      round2(result.derived.perPointLengthM[point.id] ?? 0),
    ]);
  }
  inputRows.push(["点位合计 / Total points", "", "", "", "", totalPoints, ""]);

  // --- Sheet 2: material --------------------------------------------------
  const cableRows: Cell[][] = [
    [`线材分项 / Cable line items — 金额单位 ${currency} / amounts in ${currency}`],
    [
      "线材型号 / Cable model",
      "名称",
      "Name",
      "米数（含损耗）/ Metres (incl. wastage)",
      `单价 / Unit price (${currency}/m)`,
      `金额 / Amount (${currency})`,
      "价格等级 / Price grade",
    ],
  ];
  for (const cable of result.cables) {
    cableRows.push([
      cable.cableId,
      cable.nameCn,
      cable.nameEn,
      round2(cable.metres),
      round2(cable.unitPrice),
      round2(cable.amount),
      gradeLabel(cable.grade),
    ]);
  }
  cableRows.push([]);
  cableRows.push(["材料小计（不含损耗）/ Material subtotal excl. wastage", "", "", "", "", round2(result.materialSubtotal), ""]);
  cableRows.push(["损耗与整卷差额 / Wastage & roll rounding", "", "", "", "", round2(result.wastage), ""]);
  cableRows.push(["材料合计 / Material total", "", "", "", "", round2(result.materialTotal), ""]);

  // --- Sheet 3: labour ----------------------------------------------------
  const labourRows: Cell[][] = [
    [`人工分项 / Labour line items — 金额单位 ${currency} / amounts in ${currency}`],
    [
      "点位 ID / Point ID",
      "名称",
      "Name",
      "数量 / Points",
      "单点穿线 / Pull minutes per point",
      "单点端接 / Terminate minutes per point",
      "班组工时 / Crew-hours",
      `金额 / Amount (${currency})`,
    ],
  ];
  for (const line of result.labour.lines) {
    labourRows.push([
      line.pointId,
      line.nameCn,
      line.nameEn,
      line.points,
      round2(line.pullMinutes),
      round2(line.terminateMinutes),
      round2(line.totalHours),
      round2(line.amount),
    ]);
  }
  labourRows.push([]);
  labourRows.push(["人工小计 / Labour subtotal", "", "", "", "", "", "", round2(result.labour.subtotal)]);
  labourRows.push(["班组天数 / Crew-days", "", "", "", "", "", round2(result.derived.crewDays), ""]);

  // --- Sheet 4: totals ----------------------------------------------------
  const summaryRows: Cell[][] = [
    ["合计 / Summary", `金额 / Amount (${currency})`],
    ["材料小计（不含损耗）/ Material subtotal excl. wastage", round2(result.materialSubtotal)],
    ["损耗与整卷差额 / Wastage & roll rounding", round2(result.wastage)],
    ["材料合计 / Material total", round2(result.materialTotal)],
    ["人工小计 / Labour subtotal", round2(result.labour.subtotal)],
    ["加成 / Markup", round2(result.overheads.markup)],
    [
      "分包毛利（已计入人工小计）/ Subcontract margin (already inside labour subtotal)",
      round2(result.overheads.subcontractMargin),
    ],
    ["税前总计 / Total excl. VAT", round2(result.totalExVat)],
    ["增值税 / VAT", round2(result.vat)],
    ["总价（含税）/ Total incl. VAT", round2(result.total)],
    [],
    ["总线长（含损耗）/ Total metres incl. wastage", round2(result.derived.totalMetres)],
    ["班组天数 / Crew-days", round2(result.derived.crewDays)],
    ["报价口径 / Tier", tierLabel(input.tier)],
    ["模型版本 / Model version", config.modelVersion],
  ];
  if (result.warnings.length > 0) {
    summaryRows.push([]);
    summaryRows.push(["提示 / Warnings"]);
    for (const warning of result.warnings) summaryRows.push([warning]);
  }

  return [
    { name: "Inputs", rows: inputRows, colWidths: [30, 22, 26, 16, 14, 12, 24], decimalColumns: [6] },
    { name: "Cables", rows: cableRows, colWidths: [30, 22, 26, 26, 20, 18, 24], decimalColumns: [3, 4, 5] },
    { name: "Labour", rows: labourRows, colWidths: [30, 22, 26, 12, 26, 28, 16, 18], decimalColumns: [4, 5, 6, 7] },
    { name: "Summary", rows: summaryRows, colWidths: [62, 20], decimalColumns: [1] },
  ];
}

/** A numeric cell, the only kind the 2dp format may be applied to. */
function asNumericCell(value: unknown): { z?: string } | null {
  if (typeof value !== "object" || value === null) return null;
  return (value as { t?: unknown }).t === "n" ? (value as { z?: string }) : null;
}

async function buildXlsx(sheets: SheetSpec[]): Promise<ArrayBuffer> {
  // Dynamic import keeps SheetJS out of any shared module graph, matching how
  // the import dialogs load it.
  const XLSX = await import("xlsx");
  const workbook = XLSX.utils.book_new();
  for (const sheet of sheets) {
    const worksheet = XLSX.utils.aoa_to_sheet(sheet.rows);
    worksheet["!cols"] = sheet.colWidths.map((wch) => ({ wch }));
    for (let r = 0; r < sheet.rows.length; r += 1) {
      for (const c of sheet.decimalColumns) {
        const cell = asNumericCell(worksheet[XLSX.utils.encode_cell({ r, c })]);
        if (cell) cell.z = TWO_DECIMALS;
      }
    }
    XLSX.utils.book_append_sheet(workbook, worksheet, sheet.name);
  }
  const written = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
  // Copied into a plain ArrayBuffer: a Node Buffer may be a view into a larger
  // pooled allocation, and handing that to the response would ship the
  // neighbouring bytes.
  const body = new ArrayBuffer(written.byteLength);
  new Uint8Array(body).set(written);
  return body;
}

export async function POST(request: NextRequest) {
  const request_id = genReqId();
  try {
    const bearerToken = request.headers.get("authorization")?.replace("Bearer ", "") ?? undefined;
    const cookieHeader = request.headers.get("cookie") ?? "";
    const supabase = await createServerSupabase(bearerToken, cookieHeader);
    const { data: { user }, error: authErr } = await supabase.auth.getUser();
    if (authErr || !user) {
      return applyPrivateNoStore(NextResponse.json({ error: "Unauthorized" }, { status: 401 }));
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return applyPrivateNoStore(
        NextResponse.json({ error: "Request body must be valid JSON" }, { status: 400 }),
      );
    }

    // Same contract as /calculate: the engine validates, so a rejected body is
    // reported as 400 with the engine's own message.
    const config = loadCableCostingConfig();
    const input = body as CableCostingInput;
    const result = calculateCableCosting(input, config);
    const file = await buildXlsx(buildSheets(input, result, config));

    const stamp = new Date().toISOString().slice(0, 10).replaceAll("-", "");
    const filename = `cable_costing_${input.tier}_${stamp}.xlsx`;

    return new NextResponse(file, {
      status: 200,
      headers: {
        "Content-Type": XLSX_CONTENT_TYPE,
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "private, no-store",
      },
    });
  } catch (err) {
    if (err instanceof CableCostingInputError) {
      return applyPrivateNoStore(NextResponse.json({ error: err.message }, { status: 400 }));
    }
    // A missing or malformed rate card is an operator task, not a caller error:
    // answer 503 and say which variable to inject. The message carries the
    // variable name and the file to put it in, never any part of its value.
    if (err instanceof CableCostingConfigError) {
      logger.error(
        { err, request_id, operation: "cable_costing_export" },
        "[Cable Costing Export] Costing configuration unavailable",
      );
      return applyPrivateNoStore(NextResponse.json({ error: err.message }, { status: 503 }));
    }
    logger.error(
      { err, request_id, operation: "cable_costing_export" },
      "[Cable Costing Export] Error",
    );
    const message = process.env.NODE_ENV === "production"
      ? "Internal server error"
      : err instanceof Error ? err.message : String(err);
    return applyPrivateNoStore(
      NextResponse.json({ error: message || "Internal error" }, { status: 500 }),
    );
  }
}
