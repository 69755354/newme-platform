import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) =>
  readFile(new URL(`../../${path}`, import.meta.url), "utf8");

const DOCUMENT_PATH =
  "docs/product-decisions/SAM-23-customer-readiness-delivery-boundary.md";

function normalizeRepositoryText(value) {
  return value.replaceAll("\r\n", "\n");
}

function gitBlobSha(value) {
  const content = Buffer.from(normalizeRepositoryText(value), "utf8");
  return createHash("sha1")
    .update(Buffer.from(`blob ${content.byteLength}\0`, "utf8"))
    .update(content)
    .digest("hex");
}

function tableBlock(types, table) {
  const normalizedTypes = normalizeRepositoryText(types);
  const marker = `      ${table}: {`;
  const start = normalizedTypes.indexOf(marker);
  assert.notEqual(start, -1, `database types must include ${table}`);
  const remainder = normalizedTypes.slice(start + marker.length);
  const next = remainder.search(/\n      [a-zA-Z_][a-zA-Z0-9_]*: \{\n/);
  return next === -1
    ? normalizedTypes.slice(start)
    : normalizedTypes.slice(start, start + marker.length + next);
}

test("SAM-23 evidence ledger matches the reviewed canonical source blobs", async () => {
  const document = await read(DOCUMENT_PATH);
  const evidence = new Map([
    [
      "docs/product-decisions/SAM-18-saas-product-boundary.md",
      "94a45599582885507ad789d190f237230fc57a60",
    ],
    [
      "docs/product-decisions/SAM-19-organization-membership-data-model.md",
      "f6d968456fa82034afca2679d012feaa9bec4560",
    ],
    [
      "supabase/migrations/20260730100000_sam20_lead_organization_isolation.sql",
      "7371c83028e8ad23769c4469aa2977e805e2c629",
    ],
    [
      "supabase/migrations/20260730110000_sam22_two_organization_isolation.sql",
      "f0222d10d8653aa9e2c872f0e4cac2a70e7a0651",
    ],
    [
      "tests/security/sam20-lead-organization-isolation.test.mjs",
      "d4ba0b9f6c1d908172334d6b878e38a814190a40",
    ],
    [
      "tests/security/sam22-two-organization-isolation.test.mjs",
      "f762eaf243e482f51bb09aa825eeb0d0a1a22254",
    ],
    [
      "src/types/database.ts",
      "9de949e9e043951e620b83c27b29f4744327113a",
    ],
  ]);

  assert.match(
    document,
    /canonical commit \| `a9a0ee860925031ce4dfd6ce781430a1619d4413`/,
  );
  assert.match(
    document,
    /canonical tree \| `7a3cbc461fdabffd113ef2f5d5934e14e245af1f`/,
  );

  for (const [path, expectedSha] of evidence) {
    const source = await read(path);
    assert.equal(gitBlobSha(source), expectedSha, `${path} changed after the audit`);
    assert.ok(document.includes(`\`${path}\``), `${path} missing from evidence ledger`);
    assert.ok(document.includes(`\`${expectedSha}\``), `${path} SHA missing from ledger`);
  }
});

test("SAM-23 current-state claims match generated database types and merged boundaries", async () => {
  const [document, types, sam20, sam22] = await Promise.all([
    read(DOCUMENT_PATH),
    read("src/types/database.ts"),
    read("supabase/migrations/20260730100000_sam20_lead_organization_isolation.sql"),
    read("supabase/migrations/20260730110000_sam22_two_organization_isolation.sql"),
  ]);

  for (const table of ["leads", "crm_daily_funnel_snapshot"]) {
    assert.match(
      tableBlock(types, table),
      /\n\s+organization_id: string/,
      `${table} must retain its direct organization key`,
    );
  }

  for (const table of [
    "quotations",
    "contracts",
    "payments",
    "projects",
    "tasks",
    "lead_documents",
  ]) {
    assert.doesNotMatch(
      tableBlock(types, table),
      /\n\s+organization_id:/,
      `${table} gained an organization key; refresh the SAM-23 audit`,
    );
  }

  assert.equal(types.includes("      roles: {"), false);
  assert.equal(types.includes("      membership_roles: {"), false);
  assert.match(sam20, /'lead_documents'/);
  assert.match(sam20, /'tasks'/);
  assert.match(
    sam20,
    /CREATE POLICY sam20_%I_organization_boundary[\s\S]*AS RESTRICTIVE/,
  );
  assert.match(
    sam22,
    /crm_daily_funnel_snapshot[\s\S]*ADD COLUMN IF NOT EXISTS organization_id uuid/,
  );
  assert.match(document, /canonical 尚无 `roles`、`membership_roles`/);
});

test("SAM-23 contract covers every Linear acceptance area and stays fail closed", async () => {
  const [document, taskboard] = await Promise.all([
    read(DOCUMENT_PATH),
    read("TASKBOARD.md"),
  ]);

  for (const moduleName of [
    "报价",
    "合同",
    "回款",
    "项目",
    "任务",
    "文件",
    "报表",
  ]) {
    assert.match(
      document,
      new RegExp(`\\| ${moduleName} \\|`),
      `${moduleName} missing from module matrix`,
    );
  }

  for (const acceptance of [
    "通用模块全部具有组织归属和隔离测试",
    "席位计数与成员状态一致",
    "新公司初始化不需要复制代码或数据库",
    "形成 5–10 家公司接入、支持、备份和退出清单",
  ]) {
    assert.ok(document.includes(acceptance), `${acceptance} missing`);
  }

  for (const cohort of Array.from({ length: 10 }, (_, index) =>
    `P${String(index + 1).padStart(2, "0")}`
  )) {
    assert.match(
      document,
      new RegExp(`\\| ${cohort} \\|.*\\| NO-GO \\|`),
      `${cohort} must remain explicitly NO-GO until evidence is attached`,
    );
  }

  for (const gate of ["G1 仓库静态", "G2 disposable DB", "G3 staging", "G4 首批客户"]) {
    assert.match(
      document,
      new RegExp(`\\| ${gate} \\|.*\\| NO-GO \\|`),
      `${gate} must remain fail closed`,
    );
  }

  assert.match(document, /当前判定 \| \*\*NO-GO：不得接入真实客户\*\*/);
  assert.match(document, /不证明任何能力已在 staging 或 production 上线/);
  assert.match(document, /P01.*P10.*无 PII/s);
  assert.doesNotMatch(document, /首批客户(?:已经|已)就绪/);
  assert.doesNotMatch(document, /staging (?:已经|已)通过/);
  assert.doesNotMatch(document, /production (?:已经|已)上线/);
  assert.match(
    taskboard,
    /\| SAM-23 \| IN_PROGRESS \| Codex \| 2026-07-30 \|/,
  );
});
