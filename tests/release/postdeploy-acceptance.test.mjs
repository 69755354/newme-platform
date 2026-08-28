import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  abortSealTransaction,
  sealVerifiedAcceptance,
  sha256,
  verifyPostdeployAcceptance,
} from "../../scripts/verify-postdeploy-acceptance.mjs";
import { recordDeployAcceptance } from "../../scripts/record-deploy-acceptance.mjs";
import {
  canonicalJsonBytes,
  receiptPublicKeySha256,
  signPostdeployArtifact,
} from "../../scripts/postdeploy-receipt.mjs";

const ROOT = path.resolve(import.meta.dirname, "../..");
const POLICY_BYTES = readFileSync(path.join(ROOT, "infra/release/postdeploy-acceptance-policy-v1.json"));
const SCHEMA_BYTES = readFileSync(path.join(ROOT, "infra/release/postdeploy-evidence-v1.schema.json"));
const RELEASE_SHA = "a".repeat(40);
const RUN_ID = "31415926535";
const BUILD_ID = "build-postdeploy-v1";
const DEPLOYED_AT = "2026-08-15T00:00:00Z";
const NOW = new Date("2026-08-15T00:20:00Z");
const RECEIPT_KEYS = generateKeyPairSync("ed25519");
const RECEIPT_PRIVATE_KEY = RECEIPT_KEYS.privateKey.export({ type: "pkcs8", format: "pem" });
const RECEIPT_PUBLIC_KEY = RECEIPT_KEYS.publicKey.export({ type: "spki", format: "pem" });
const BROWSER_RUNNER = "newme-postdeploy-browser-uat/v1";
const BROWSER_SOURCE_PATH = "scripts/run-postdeploy-browser-uat.mjs";
const BROWSER_SOURCE_SHA256 = sha256(readFileSync(path.join(ROOT, BROWSER_SOURCE_PATH)));
const PLAYWRIGHT_IMAGE = "mcr.microsoft.com/playwright:v1.60.0-noble@sha256:9bd26ad900bb5e0f4dee75839e957a89ae89c2b7ab1e76050e559790e946b948";
const BROWSER_STEPS = [
  "login_page_visible",
  "login_submitted",
  "landing_visible",
  "navigation_visible",
  "collection_card_visible",
  "bulk_action_verified",
  "detail_visible",
  "contract_list_visible",
  "settings_contract_verified",
  "locale_switched",
  "locale_content_verified",
  "locale_restored",
  "logout",
  "post_logout_denied",
];
const SCREENSHOT_STEPS = new Set([
  "login_page_visible",
  "collection_card_visible",
  "bulk_action_verified",
  "detail_visible",
  "contract_list_visible",
  "settings_contract_verified",
  "locale_content_verified",
]);
const BROWSER_SUBJECT = Object.freeze({
  lead_id: "20000000-0000-4000-8000-000000000003",
  contract_id: "20000000-0000-4000-8000-000000000004",
  marker_sha256: "f".repeat(64),
});
const BROWSER_COPY = Object.freeze({
  en: Object.freeze({
    leads: "Leads", contracts: "Contracts", settings: "Admin Panel", create: "Create", signIn: "Sign In", logout: "Logout",
    managementLeadsNav: "Leads", salesLeadsNav: "My Leads", managementContractsNav: "Contracts & Payments", salesContractsNav: "My Contracts",
    transferAction: "Transfer →", cancel: "Cancel", quickCreate: "Quick Create Lead",
  }),
  zh: Object.freeze({
    leads: "线索", contracts: "合同管理", settings: "系统管理", create: "新建", signIn: "登录", logout: "退出",
    managementLeadsNav: "线索", salesLeadsNav: "我的线索", managementContractsNav: "合同&回款", salesContractsNav: "我的合同",
    transferAction: "转移 →", cancel: "取消", quickCreate: "快速创建线索",
  }),
});

function browserSemantics(stepId, role, locale) {
  const copy = BROWSER_COPY[locale];
  const alternateLocale = locale === "en" ? "zh" : "en";
  const alternateCopy = BROWSER_COPY[alternateLocale];
  const assertion = (id, value) => ({ id, value });
  const values = {
    login_page_visible: [assertion("login_copy", copy.signIn)],
    login_submitted: [],
    landing_visible: [assertion("authenticated_role", role)],
    navigation_visible: [
      assertion("leads_navigation_copy", role === "sales" ? copy.salesLeadsNav : copy.managementLeadsNav),
      assertion("contracts_navigation_copy", role === "sales" ? copy.salesContractsNav : copy.managementContractsNav),
    ],
    collection_card_visible: [
      assertion("leads_heading_copy", copy.leads),
      assertion("fixture_lead_id", BROWSER_SUBJECT.lead_id),
      assertion("fixture_marker_sha256", BROWSER_SUBJECT.marker_sha256),
    ],
    bulk_action_verified: role === "admin" || role === "boss"
      ? [assertion("bulk_access", "allowed"), assertion("bulk_fixture_lead_id", BROWSER_SUBJECT.lead_id), assertion("bulk_transfer_copy", copy.transferAction), assertion("bulk_cancel_copy", copy.cancel)]
      : [assertion("bulk_access", "denied"), assertion("bulk_fixture_lead_id", BROWSER_SUBJECT.lead_id), assertion("permitted_create_copy", copy.create), assertion("create_dialog_copy", copy.quickCreate)],
    detail_visible: [assertion("fixture_detail_id", BROWSER_SUBJECT.lead_id), assertion("fixture_detail_copy_sha256", BROWSER_SUBJECT.marker_sha256)],
    contract_list_visible: [
      assertion("contracts_heading_copy", copy.contracts),
      assertion("fixture_contract_id", BROWSER_SUBJECT.contract_id),
      assertion("fixture_contract_number", `UAT-C-${BROWSER_SUBJECT.contract_id.slice(0, 8)}`),
    ],
    settings_contract_verified: role === "sales"
      ? [assertion("settings_access", "denied")]
      : [assertion("settings_access", "allowed"), assertion("settings_heading_copy", copy.settings), assertion("settings_assignment_filter", "all"), assertion("settings_fixture_lead_id", BROWSER_SUBJECT.lead_id)],
    locale_switched: [assertion("locale_target", alternateLocale)],
    locale_content_verified: [
      assertion("alternate_leads_heading_copy", alternateCopy.leads),
      assertion("alternate_create_copy", alternateCopy.create),
      assertion("alternate_html_locale", alternateLocale),
      assertion("alternate_fixture_marker_sha256", BROWSER_SUBJECT.marker_sha256),
    ],
    locale_restored: [assertion("locale_restored", locale)],
    logout: [assertion("logout_copy", copy.logout)],
    post_logout_denied: [],
  };
  return values[stepId];
}

function artifact(id, kind, file, observedAt, payload, relativePath = path.basename(file)) {
  const document = signPostdeployArtifact({
    artifact: {
    artifact_version: "newme-postdeploy-artifact/v1",
    kind,
    release: {
      git_sha: RELEASE_SHA,
      build_id: BUILD_ID,
      deploy_run_id: RUN_ID,
    },
    observed_at: observedAt,
    payload,
    },
    producer: payload.runner,
    signedAt: observedAt,
    privateKeyBytes: RECEIPT_PRIVATE_KEY,
  });
  const content = `${JSON.stringify(document, null, 2)}\n`;
  writeFileSync(file, content);
  return {
    id,
    kind,
    path: relativePath,
    sha256: sha256(Buffer.from(content)),
    media_type: "application/json",
  };
}

function passingChecks(ids, completedAt) {
  return ids.map((id) => ({ id, status: "pass", completed_at: completedAt }));
}

const ASSERTION_ROLES = {
  lead_marked_won: "sales",
  draft_contract_created: "sales",
  admin_review_pending: "sales",
  transition_accepted: "operator",
  persisted_status_matches: "operator",
  quotation_marked_converted: "sales",
  contract_linked: "sales",
  admin_review_recorded: "admin",
  ceo_review_recorded: "boss",
  contract_approved: "boss",
  payment_confirmed: "boss",
  allocation_persisted: "boss",
  derived_totals_reconciled: "boss",
  period_replaced: "admin",
  no_duplicate_targets: "admin",
  target_readback_matches: "admin",
};

function flowChecks(ids, completedAt, requestsByRole, fixtureId, actorByRole) {
  return ids.map((id) => ({
    id,
    status: "pass",
    completed_at: completedAt,
    request_id: requestsByRole.get(ASSERTION_ROLES[id]).id,
    fixture_id: fixtureId,
    http_status: requestsByRole.get(ASSERTION_ROLES[id]).http_status,
    actor_role: ASSERTION_ROLES[id],
    actor_id: actorByRole.get(ASSERTION_ROLES[id]),
    readback_sha256: "9".repeat(64),
  }));
}

function fixture(t) {
  const directory = mkdtempSync(path.join(tmpdir(), "newme-postdeploy-v1-"));
  t?.after(() => rmSync(directory, { recursive: true, force: true }));
  const samples = Array.from({ length: 20 }, (_unused, index) => 1000 + index * 10);
  const roles = [
      {
        role: "admin",
        actor_id: "10000000-0000-4000-8000-000000000001",
        status: "pass",
        completed_at: "2026-08-15T00:10:00Z",
        flow_ids: ["kpi_period_replace"],
        artifact_id: "role_admin",
      },
      {
        role: "boss",
        actor_id: "10000000-0000-4000-8000-000000000002",
        status: "pass",
        completed_at: "2026-08-15T00:10:00Z",
        flow_ids: ["quotation_two_step_approval", "payment_allocation"],
        artifact_id: "role_boss",
      },
      {
        role: "operator",
        actor_id: "10000000-0000-4000-8000-000000000003",
        status: "pass",
        completed_at: "2026-08-15T00:10:00Z",
        flow_ids: ["contract_status_transition"],
        artifact_id: "role_operator",
      },
      {
        role: "sales",
        actor_id: "10000000-0000-4000-8000-000000000004",
        status: "pass",
        completed_at: "2026-08-15T00:10:00Z",
        flow_ids: ["lead_to_contract", "quotation_conversion"],
        artifact_id: "role_sales",
      },
    ];
  const flowAssertions = {
    lead_to_contract: ["lead_marked_won", "draft_contract_created", "admin_review_pending"],
    contract_status_transition: ["transition_accepted", "persisted_status_matches"],
    quotation_conversion: ["quotation_marked_converted", "contract_linked"],
    quotation_two_step_approval: ["admin_review_recorded", "ceo_review_recorded", "contract_approved"],
    payment_allocation: ["payment_confirmed", "allocation_persisted", "derived_totals_reconciled"],
    kpi_period_replace: ["period_replaced", "no_duplicate_targets", "target_readback_matches"],
  };
  const actorByRole = new Map(roles.map((role) => [role.role, role.actor_id]));
  const flowParticipants = {
    lead_to_contract: ["sales"],
    contract_status_transition: ["operator"],
    quotation_conversion: ["sales"],
    quotation_two_step_approval: ["admin", "boss"],
    payment_allocation: ["boss"],
    kpi_period_replace: ["admin"],
  };
  const flows = [
      ["lead_to_contract", "sales", "role_sales"],
      ["contract_status_transition", "operator", "role_operator"],
      ["quotation_conversion", "sales", "role_sales"],
      ["quotation_two_step_approval", "boss", "role_boss"],
      ["payment_allocation", "boss", "role_boss"],
      ["kpi_period_replace", "admin", "role_admin"],
    ].map(([id, role, artifactId], index) => ({
      id,
      role,
      status: "pass",
      started_at: `2026-08-15T00:0${index + 3}:00Z`,
      completed_at: `2026-08-15T00:0${index + 4}:00Z`,
      artifact_id: artifactId,
    }));
  const fixtures = {
      created_ids: [
        "20000000-0000-4000-8000-000000000001",
        "20000000-0000-4000-8000-000000000002",
        BROWSER_SUBJECT.lead_id,
        BROWSER_SUBJECT.contract_id,
      ],
      cleaned_ids: [
        BROWSER_SUBJECT.contract_id,
        BROWSER_SUBJECT.lead_id,
        "20000000-0000-4000-8000-000000000002",
        "20000000-0000-4000-8000-000000000001",
      ],
      residual_count: 0,
      verified_at: "2026-08-15T00:10:00Z",
      payment_id: "20000000-0000-4000-8000-000000000001",
      payment_status: "voided",
      payment_void_request_id: "cleanup:payment:void:001",
      payment_void_receipt_sha256: "1".repeat(64),
      payment_voided_at: "2026-08-15T00:09:00Z",
      kpi_baseline_sha256: "2".repeat(64),
      kpi_restored_sha256: "2".repeat(64),
      artifact_id: "fixture_cleanup",
    };
  const alertDrill = {
      failure_event_id: "sentry:event/failure-100",
      recovery_event_id: "hermes:event/recovery-101",
      failure_provider_delivery_id: "provider:delivery:failure-100",
      recovery_provider_delivery_id: "provider:delivery:recovery-101",
      failure_provider_operation_id: "provider:operation:failure-100",
      recovery_provider_operation_id: "provider:operation:recovery-101",
      failure_trigger_sha256: "3".repeat(64),
      recovery_trigger_sha256: "4".repeat(64),
      failure_receipt_sha256: "5".repeat(64),
      recovery_receipt_sha256: "6".repeat(64),
      failed_at: "2026-08-15T00:12:00Z",
      recovered_at: "2026-08-15T00:13:00Z",
      final_status: "ok",
      artifact_id: "alert_drill",
    };
  const performance = {
      samples_ms: samples,
      p75_ms: samples[14],
      p95_ms: samples[18],
      measured_at: "2026-08-15T00:14:00Z",
      artifact_id: "performance",
    };
  const delayedVerification = {
      not_before: "2026-08-15T00:15:00Z",
      completed_at: "2026-08-15T00:16:00Z",
      status: "pass",
      provider_trigger_sha256: "0".repeat(64),
      provider_event_id: alertDrill.recovery_event_id,
      provider_delivery_id: alertDrill.recovery_provider_delivery_id,
      provider_query_id: "provider:query:readback-102",
      provider_receipt_sha256: "7".repeat(64),
      provider_observed_at: "2026-08-15T00:15:30Z",
      artifact_id: "delayed_verify",
    };
  const roleArtifacts = roles.map((role) => artifact(
    role.artifact_id,
    "role_uat",
    path.join(directory, `${role.role}.json`),
    role.completed_at,
    {
      runner: "newme-postdeploy-uat/v1",
      runner_run_id: `uat:role:${role.role}:001`,
      role: role.role,
      actor_id: role.actor_id,
      status: role.status,
      started_at: "2026-08-15T00:01:00Z",
      completed_at: role.completed_at,
      session_checks: [
        { id: "login", status: "pass", completed_at: "2026-08-15T00:01:00Z", http_status: 200, response_sha256: "a".repeat(64) },
        { id: "refresh", status: "pass", completed_at: "2026-08-15T00:02:00Z", http_status: 200, response_sha256: "b".repeat(64) },
        { id: "authorization", status: "pass", completed_at: "2026-08-15T00:03:00Z", http_status: 200, response_sha256: "c".repeat(64) },
        { id: "logout", status: "pass", completed_at: "2026-08-15T00:09:00Z", http_status: 200, response_sha256: "d".repeat(64) },
        { id: "post_logout_denied", status: "pass", completed_at: role.completed_at, http_status: 401, response_sha256: "e".repeat(64) },
      ],
      flows: flows.filter((flow) => flow.role === role.role).map((flow, index) => {
        const participants = flowParticipants[flow.id];
        const requests = participants.map((participantRole, participantIndex) => ({
          id: `request:${participantRole}:${flow.id}:${index + participantIndex + 1}`,
          actor_role: participantRole,
          actor_id: actorByRole.get(participantRole),
          method: "POST",
          path: `/api/uat/${flow.id}`,
          http_status: 200,
          completed_at: flow.completed_at,
          response_sha256: "8".repeat(64),
        }));
        const requestsByRole = new Map(requests.map((request) => [request.actor_role, request]));
        return {
          id: flow.id,
          status: flow.status,
          started_at: flow.started_at,
          completed_at: flow.completed_at,
          participants: participants.map((participantRole) => ({
            role: participantRole,
            actor_id: actorByRole.get(participantRole),
          })),
          requests,
          fixture_ids: [...fixtures.created_ids],
          assertions: flowChecks(flowAssertions[flow.id], flow.completed_at, requestsByRole, fixtures.created_ids[0], actorByRole),
        };
      }),
    },
  ));
  const browserSessions = [];
  const browserArtifacts = [];
  for (const role of roles) {
    for (const locale of ["en", "zh"]) {
      const sessionRoot = path.join(directory, role.role, locale);
      const screenshotsRoot = path.join(sessionRoot, "screenshots");
      mkdirSync(screenshotsRoot, { recursive: true });
      const minuteMarks = [1, 2, 3, 4, 5, 6, 7, 8, 8, 9, 9, 9, 10, 10];
      let previous = "2026-08-15T00:01:00Z";
      const steps = BROWSER_STEPS.map((id, index) => {
        const completedAt = `2026-08-15T00:${String(minuteMarks[index]).padStart(2, "0")}:00Z`;
        const core = {
          sequence: index + 1,
          id,
          status: "pass",
          started_at: previous,
          completed_at: completedAt,
          path: id.includes("login") || id === "logout" || id === "post_logout_denied" ? "/login" : "/leads",
          semantic_assertions: browserSemantics(id, role.role, locale),
        };
        previous = completedAt;
        let screenshot = null;
        if (SCREENSHOT_STEPS.has(id)) {
          const screenshotFile = path.join(screenshotsRoot, `${String(index + 1).padStart(2, "0")}-${id}.png`);
          const screenshotBytes = Buffer.concat([
            Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
            Buffer.from(`${role.role}-${locale}-${id}`, "utf8"),
          ]);
          writeFileSync(screenshotFile, screenshotBytes);
          screenshot = {
            path: path.relative(directory, screenshotFile).split(path.sep).join("/"),
            sha256: sha256(screenshotBytes),
            media_type: "image/png",
            redaction_version: "newme-postdeploy-browser-redaction/v2",
          };
        }
        return {
          ...core,
          evidence_sha256: sha256(canonicalJsonBytes(core)),
          screenshot,
        };
      });
      const httpChecks = [
        { id: "login", method: "POST", path: "/api/auth/login", http_status: 200, response_sha256: "a".repeat(64), completed_at: "2026-08-15T00:02:00Z" },
        { id: "identity", method: "GET", path: "/api/auth/me", http_status: 200, response_sha256: "b".repeat(64), completed_at: "2026-08-15T00:03:00Z" },
        { id: "logout", method: "POST", path: "/api/auth/logout", http_status: 200, response_sha256: "c".repeat(64), completed_at: "2026-08-15T00:09:00Z" },
        { id: "post_logout_denied", method: "GET", path: "/api/auth/me", http_status: 401, response_sha256: "d".repeat(64), completed_at: "2026-08-15T00:10:00Z" },
      ];
      const quality = {
        console_error_count: 0,
        page_error_count: 0,
        critical_http_failure_count: 0,
        overflow_violation_count: 0,
        overlap_violation_count: 0,
        raw_i18n_key_count: 0,
      };
      const trace = {
        trace_version: "newme-postdeploy-browser-trace/v1",
        release: {
          git_sha: RELEASE_SHA,
          build_id: BUILD_ID,
          deploy_run_id: RUN_ID,
          deployed_at: DEPLOYED_AT,
        },
        runner: BROWSER_RUNNER,
        runner_source_sha256: BROWSER_SOURCE_SHA256,
        role: role.role,
        actor_id: role.actor_id,
        locale,
        subject: { ...BROWSER_SUBJECT },
        viewport: { width: 1440, height: 900 },
        ordered_steps: steps,
        http_checks: httpChecks,
        quality,
      };
      const traceBytes = Buffer.from(`${JSON.stringify(trace, null, 2)}\n`, "utf8");
      const traceFile = path.join(sessionRoot, "redacted-trace.json");
      writeFileSync(traceFile, traceBytes);
      const artifactId = `browser_${role.role}_${locale}`;
      const relativeArtifactPath = `${role.role}/${locale}/artifact.json`;
      browserArtifacts.push(artifact(
        artifactId,
        "browser_uat",
        path.join(sessionRoot, "artifact.json"),
        "2026-08-15T00:10:00Z",
        {
          runner: BROWSER_RUNNER,
          runner_run_id: `browser:${role.role}:${locale}:001`,
          runner_source_path: BROWSER_SOURCE_PATH,
          runner_source_sha256: BROWSER_SOURCE_SHA256,
          playwright_image: PLAYWRIGHT_IMAGE,
          browser_name: "chromium",
          browser_version: "148.0.7778.96",
          role: role.role,
          actor_id: role.actor_id,
          locale,
          subject: { ...BROWSER_SUBJECT },
          viewport: { width: 1440, height: 900 },
          status: "pass",
          started_at: "2026-08-15T00:01:00Z",
          completed_at: "2026-08-15T00:10:00Z",
          ordered_steps: steps,
          http_checks: httpChecks,
          quality,
          redaction: {
            redaction_version: "newme-postdeploy-browser-redaction/v2",
            non_subject_dynamic_text_hidden: true,
            evidence_copy_visible: true,
            input_values_hidden: true,
            screenshot_images_hidden: true,
            trace_closed_fields_only: true,
            storage_state_written: false,
          },
          trace: {
            trace_version: "newme-postdeploy-browser-trace/v1",
            path: path.relative(directory, traceFile).split(path.sep).join("/"),
            sha256: sha256(traceBytes),
            media_type: "application/json",
          },
        },
        relativeArtifactPath,
      ));
      browserSessions.push({
        role: role.role,
        actor_id: role.actor_id,
        locale,
        subject: { ...BROWSER_SUBJECT },
        status: "pass",
        completed_at: "2026-08-15T00:10:00Z",
        artifact_id: artifactId,
      });
    }
  }
  const artifacts = [
    ...roleArtifacts,
    ...browserArtifacts,
    artifact("fixture_cleanup", "fixture_cleanup", path.join(directory, "fixtures.json"), fixtures.verified_at, {
      runner: "newme-postdeploy-fixture-audit/v1",
      query_run_id: "fixture:audit:001",
      created_ids: [...fixtures.created_ids],
      cleaned_ids: [...fixtures.cleaned_ids],
      residual_count: fixtures.residual_count,
      verified_at: fixtures.verified_at,
      payment_id: fixtures.payment_id,
      payment_status: fixtures.payment_status,
      payment_void_request_id: fixtures.payment_void_request_id,
      payment_void_receipt_sha256: fixtures.payment_void_receipt_sha256,
      payment_voided_at: fixtures.payment_voided_at,
      kpi_baseline_sha256: fixtures.kpi_baseline_sha256,
      kpi_restored_sha256: fixtures.kpi_restored_sha256,
    }),
    artifact("alert_drill", "alert_drill", path.join(directory, "alert.json"), alertDrill.recovered_at, {
      runner: "newme-postdeploy-alert-drill/v1",
      drill_run_id: "alert:drill:001",
      failure_event_id: alertDrill.failure_event_id,
      recovery_event_id: alertDrill.recovery_event_id,
      failure_provider_delivery_id: alertDrill.failure_provider_delivery_id,
      recovery_provider_delivery_id: alertDrill.recovery_provider_delivery_id,
      failure_provider_operation_id: alertDrill.failure_provider_operation_id,
      recovery_provider_operation_id: alertDrill.recovery_provider_operation_id,
      failure_trigger_sha256: alertDrill.failure_trigger_sha256,
      recovery_trigger_sha256: alertDrill.recovery_trigger_sha256,
      failure_receipt_sha256: alertDrill.failure_receipt_sha256,
      recovery_receipt_sha256: alertDrill.recovery_receipt_sha256,
      failed_at: alertDrill.failed_at,
      recovered_at: alertDrill.recovered_at,
      final_status: alertDrill.final_status,
    }),
    artifact("performance", "performance", path.join(directory, "performance.json"), performance.measured_at, {
      runner: "newme-postdeploy-performance/v1",
      measurement_run_id: "performance:run:001",
      samples_ms: [...performance.samples_ms],
      p75_ms: performance.p75_ms,
      p95_ms: performance.p95_ms,
      measured_at: performance.measured_at,
    }),
    artifact("delayed_verify", "delayed_verification", path.join(directory, "delayed.json"), delayedVerification.completed_at, {
      runner: "newme-postdeploy-delayed-verification/v1",
      verification_run_id: "delayed:run:001",
      not_before: delayedVerification.not_before,
      completed_at: delayedVerification.completed_at,
      status: delayedVerification.status,
      checks: passingChecks(["service", "logs", "alerts", "restarts"], delayedVerification.completed_at),
      provider_trigger_sha256: delayedVerification.provider_trigger_sha256,
      provider_event_id: delayedVerification.provider_event_id,
      provider_delivery_id: delayedVerification.provider_delivery_id,
      provider_query_id: delayedVerification.provider_query_id,
      provider_receipt_sha256: delayedVerification.provider_receipt_sha256,
      provider_observed_at: delayedVerification.provider_observed_at,
    }),
  ];
  const bundle = {
    schema_version: "newme-postdeploy-evidence/v1",
    policy: {
      path: "infra/release/postdeploy-acceptance-policy-v1.json",
      sha256: sha256(POLICY_BYTES),
    },
    schema: {
      path: "infra/release/postdeploy-evidence-v1.schema.json",
      sha256: sha256(SCHEMA_BYTES),
    },
    receipt_key_sha256: receiptPublicKeySha256(RECEIPT_PUBLIC_KEY),
    release: {
      git_sha: RELEASE_SHA,
      build_id: BUILD_ID,
      deploy_run_id: RUN_ID,
      deploy_run_url: `https://github.com/69755354/newme-platform/actions/runs/${RUN_ID}`,
      deployed_at: DEPLOYED_AT,
    },
    roles,
    browser_uat: browserSessions,
    flows,
    fixtures,
    alert_drill: alertDrill,
    performance,
    delayed_verification: delayedVerification,
    artifacts,
    generated_at: "2026-08-15T00:17:00Z",
  };
  return { directory, bundle };
}

function verify(data, override = {}) {
  const bundleBytes = Buffer.from(`${JSON.stringify(data.bundle, null, 2)}\n`);
  return verifyPostdeployAcceptance({
    bundleBytes,
    bundlePath: path.join(data.directory, "bundle.json"),
    policyBytes: POLICY_BYTES,
    schemaBytes: SCHEMA_BYTES,
    receiptPublicKeyBytes: RECEIPT_PUBLIC_KEY,
    artifactRoot: data.directory,
    expectedReleaseSha: RELEASE_SHA,
    expectedBuildId: BUILD_ID,
    expectedDeployRunId: RUN_ID,
    expectedDeployedAt: DEPLOYED_AT,
    now: NOW,
    ...override,
  });
}

function clone(value) {
  return structuredClone(value);
}

function rewriteArtifact(data, id, mutate) {
  const metadata = data.bundle.artifacts.find((item) => item.id === id);
  const artifactPath = path.join(data.directory, metadata.path);
  const document = JSON.parse(readFileSync(artifactPath, "utf8"));
  mutate(document);
  const unsigned = structuredClone(document);
  delete unsigned.receipt;
  const resigned = signPostdeployArtifact({
    artifact: unsigned,
    producer: document.payload.runner,
    signedAt: document.observed_at,
    privateKeyBytes: RECEIPT_PRIVATE_KEY,
  });
  const bytes = Buffer.from(`${JSON.stringify(resigned, null, 2)}\n`);
  writeFileSync(artifactPath, bytes);
  metadata.sha256 = sha256(bytes);
}

test("complete four-role, dual-locale browser postdeploy evidence verifies and seals idempotently", (t) => {
  const data = fixture(t);
  const result = verify(data);
  assert.match(result.bundleSha256, /^[0-9a-f]{64}$/);
  assert.equal(result.artifacts.length, 16);
  const sealDirectory = path.join(data.directory, "sealed");
  const first = sealVerifiedAcceptance(result, sealDirectory);
  const retry = sealVerifiedAcceptance(result, sealDirectory);
  assert.deepEqual(retry, first);
  assert.equal(first.bundle_sha256, result.bundleSha256);
  assert.equal(sha256(readFileSync(path.join(sealDirectory, "bundle.json"))), result.bundleSha256);
});

test("an incomplete seal requires an explicit exact-byte recovery or controlled abort", (t) => {
  const data = fixture(t);
  const result = verify(data);
  const recoveredSeal = path.join(data.directory, "recovered-seal");
  const pending = `${recoveredSeal}.pending`;
  mkdirSync(pending, { mode: 0o700 });
  mkdirSync(path.join(pending, "artifacts"), { mode: 0o700 });
  writeFileSync(path.join(pending, "bundle.json"), result.bundleBytes);
  assert.throws(() => sealVerifiedAcceptance(result, recoveredSeal), /recovery or abort is required/);
  const recovered = sealVerifiedAcceptance(result, recoveredSeal, { recoverPending: true });
  assert.equal(recovered.bundle_sha256, result.bundleSha256);
  assert.equal(existsSync(pending), false);
  assert.equal(existsSync(recoveredSeal), true);

  const abortedSeal = path.join(data.directory, "aborted-seal");
  mkdirSync(`${abortedSeal}.pending`, { mode: 0o700 });
  writeFileSync(path.join(`${abortedSeal}.pending`, "unexpected.partial"), "partial");
  assert.equal(abortSealTransaction(abortedSeal).status, "aborted");
  assert.equal(abortSealTransaction(abortedSeal).status, "none");
});

test("mutations across every completion claim fail closed", (t) => {
  const base = fixture(t);
  const cases = [
    ["unknown root property", (bundle) => { bundle.self_reported_complete = true; }, /unknown property/],
    ["unknown nested property", (bundle) => { bundle.roles[0].operator_note = "looks good"; }, /unknown property/],
    ["missing role", (bundle) => { bundle.roles.pop(); }, /bundle\.roles must contain/],
    ["reused actor", (bundle) => { bundle.roles[1].actor_id = bundle.roles[0].actor_id; }, /four distinct actor IDs/],
    ["role completed before deploy", (bundle) => { bundle.roles[0].completed_at = "2026-08-14T23:59:59Z"; }, /predates deployment/],
    ["failed flow", (bundle) => { bundle.flows[0].status = "fail"; }, /status must be pass/],
    ["wrong role flow", (bundle) => { bundle.flows[0].role = "admin"; }, /does not match policy/],
    ["flow started before deploy", (bundle) => { bundle.flows[0].started_at = "2026-08-14T23:59:59Z"; }, /predates deployment/],
    ["fixture omitted from cleanup", (bundle) => { bundle.fixtures.cleaned_ids.pop(); }, /identical sets/],
    ["fixture residual", (bundle) => { bundle.fixtures.residual_count = 1; }, /exceeds policy/],
    ["same alert event", (bundle) => { bundle.alert_drill.recovery_event_id = bundle.alert_drill.failure_event_id; }, /event IDs must differ/],
    ["alert not recovered", (bundle) => { bundle.alert_drill.final_status = "failed"; }, /final_status is not ok/],
    ["invented p95", (bundle) => { bundle.performance.p95_ms -= 1; }, /percentiles are not nearest-rank/],
    ["threshold exceeded", (bundle) => { bundle.performance.samples_ms.fill(6000); bundle.performance.p75_ms = 6000; bundle.performance.p95_ms = 6000; }, /exceed policy thresholds/],
    ["early delayed verify", (bundle) => { bundle.delayed_verification.not_before = "2026-08-15T00:14:59Z"; }, /earlier than policy/],
    ["completed before not_before", (bundle) => { bundle.delayed_verification.completed_at = "2026-08-15T00:14:00Z"; }, /completed before not_before/],
    ["wrong deploy run", (bundle) => { bundle.release.deploy_run_id = "2"; bundle.release.deploy_run_url = "https://github.com/69755354/newme-platform/actions/runs/2"; }, /does not match deployment evidence/],
    ["wrong policy digest", (bundle) => { bundle.policy.sha256 = "f".repeat(64); }, /policy digest/],
    ["unreferenced artifact", (bundle) => {
      bundle.roles[0].artifact_id = "role_boss";
      bundle.flows.find((flow) => flow.id === "kpi_period_replace").artifact_id = "role_boss";
    }, /unreferenced artifact/],
  ];

  for (const [name, mutate, expected] of cases) {
    const data = { ...base, bundle: clone(base.bundle) };
    mutate(data.bundle);
    assert.throws(() => verify(data), expected, name);
  }
});

test("artifact byte drift is rejected before attestation", (t) => {
  const data = fixture(t);
  writeFileSync(path.join(data.directory, "admin.json"), "{\"status\":\"tampered\"}\n");
  assert.throws(() => verify(data), /digest does not match artifact bytes/);
});

test("canonical artifact documents refuse text, self-report fields, and unbound flow results", (t) => {
  {
    const data = fixture(t);
    const metadata = data.bundle.artifacts.find((item) => item.id === "role_admin");
    const bytes = Buffer.from("operator says this passed\n");
    writeFileSync(path.join(data.directory, metadata.path), bytes);
    metadata.sha256 = sha256(bytes);
    assert.throws(() => verify(data), /not valid JSON/);
  }
  {
    const data = fixture(t);
    data.bundle.artifacts[0].media_type = "text/plain";
    assert.throws(() => verify(data), /media_type is not allowed/);
  }
  {
    const data = fixture(t);
    rewriteArtifact(data, "role_admin", (document) => { document.payload.operator_note = "looks good"; });
    assert.throws(() => verify(data), /unknown property "operator_note"/);
  }
  {
    const data = fixture(t);
    rewriteArtifact(data, "role_admin", (document) => { document.payload.runner = "manual-self-report/v1"; });
    assert.throws(() => verify(data), /receipt producer is not canonical|runner is not canonical/);
  }
  {
    const data = fixture(t);
    rewriteArtifact(data, "role_sales", (document) => { document.payload.flows[0].requests = []; });
    assert.throws(() => verify(data), /requests must contain/);
  }
  {
    const data = fixture(t);
    rewriteArtifact(data, "role_sales", (document) => { document.payload.flows[0].assertions[0].request_id = "request:not-in-transcript:001"; });
    assert.throws(() => verify(data), /not in the flow request transcript/);
  }
  {
    const data = fixture(t);
    rewriteArtifact(data, "role_sales", (document) => { document.payload.flows[0].assertions[0].http_status = 500; });
    assert.throws(() => verify(data), /http_status must be an integer between 200 and 299/);
  }
  {
    const data = fixture(t);
    rewriteArtifact(data, "role_sales", (document) => { document.payload.flows[0].assertions.pop(); });
    assert.throws(() => verify(data), /assertions must contain|canonical flow readback assertions/);
  }
  {
    const data = fixture(t);
    rewriteArtifact(data, "role_admin", (document) => { document.release.deploy_run_id = "2"; });
    assert.throws(() => verify(data), /release identity does not match/);
  }
});

test("browser evidence rejects missing locale, identity, source, step, quality, screenshot, and trace bindings", (t) => {
  {
    const data = fixture(t);
    data.bundle.browser_uat.pop();
    assert.throws(() => verify(data), /bundle\.browser_uat must contain/);
  }
  {
    const data = fixture(t);
    data.bundle.browser_uat[1].locale = "en";
    assert.throws(() => verify(data), /canonical role-locale order|duplicate admin:en|missing admin:zh/);
  }
  {
    const data = fixture(t);
    data.bundle.browser_uat[0].actor_id = data.bundle.roles[1].actor_id;
    assert.throws(() => verify(data), /actor_id does not match/);
  }
  {
    const data = fixture(t);
    data.bundle.browser_uat[0].subject.lead_id = "20000000-0000-4000-8000-000000000099";
    assert.throws(() => verify(data), /one exact fixture subject/);
  }
  {
    const data = fixture(t);
    rewriteArtifact(data, "browser_admin_en", (document) => { document.payload.runner_source_sha256 = "f".repeat(64); });
    assert.throws(() => verify(data), /immutable canonical browser runner/);
  }
  {
    const data = fixture(t);
    rewriteArtifact(data, "browser_admin_en", (document) => { document.payload.subject.contract_id = "20000000-0000-4000-8000-000000000099"; });
    assert.throws(() => verify(data), /identity does not match its browser session claim/);
  }
  {
    const data = fixture(t);
    rewriteArtifact(data, "browser_admin_en", (document) => { document.payload.ordered_steps.pop(); });
    assert.throws(() => verify(data), /ordered_steps must contain/);
  }
  {
    const data = fixture(t);
    rewriteArtifact(data, "browser_admin_en", (document) => {
      document.payload.ordered_steps.find((step) => step.id === "contract_list_visible").semantic_assertions[0].value = "Contracts (self reported)";
    });
    assert.throws(() => verify(data), /canonical bilingual subject-bound journey/);
  }
  {
    const data = fixture(t);
    rewriteArtifact(data, "browser_admin_en", (document) => { document.payload.quality.console_error_count = 1; });
    assert.throws(() => verify(data), /console_error_count must be zero/);
  }
  {
    const data = fixture(t);
    rewriteArtifact(data, "browser_admin_en", (document) => {
      document.payload.ordered_steps.find((step) => step.screenshot).screenshot.sha256 = "f".repeat(64);
    });
    assert.throws(() => verify(data), /screenshot digest does not match/);
  }
  {
    const data = fixture(t);
    const traceFile = path.join(data.directory, "admin/en/redacted-trace.json");
    const trace = JSON.parse(readFileSync(traceFile, "utf8"));
    trace.role = "boss";
    const traceBytes = Buffer.from(`${JSON.stringify(trace, null, 2)}\n`);
    writeFileSync(traceFile, traceBytes);
    rewriteArtifact(data, "browser_admin_en", (document) => { document.payload.trace.sha256 = sha256(traceBytes); });
    assert.throws(() => verify(data), /redacted trace does not exactly match/);
  }
  {
    const data = fixture(t);
    data.bundle.fixtures.created_ids = data.bundle.fixtures.created_ids.filter((id) => id !== BROWSER_SUBJECT.lead_id);
    data.bundle.fixtures.cleaned_ids = data.bundle.fixtures.cleaned_ids.filter((id) => id !== BROWSER_SUBJECT.lead_id);
    rewriteArtifact(data, "fixture_cleanup", (document) => {
      document.payload.created_ids = [...data.bundle.fixtures.created_ids];
      document.payload.cleaned_ids = [...data.bundle.fixtures.cleaned_ids];
    });
    assert.throws(() => verify(data), /not bound to fixtures created and cleaned/);
  }
});

test("canonical attest reads through O_NOFOLLOW descriptors behind a root-only ancestor chain", () => {
  const verifier = readFileSync(path.join(ROOT, "scripts/verify-postdeploy-acceptance.mjs"), "utf8");
  const deploy = readFileSync(path.join(ROOT, "infra/systemd/newme-deploy.sh"), "utf8");
  assert.match(verifier, /openSync\(resolved, constants\.O_RDONLY \| \(constants\.O_NOFOLLOW \?\? 0\)\)/);
  assert.match(verifier, /fstatSync\(descriptor\)/);
  assert.match(verifier, /readFileSync\(descriptor\)/);
  assert.match(verifier, /metadata\.uid !== 0[\s\S]*metadata\.mode & 0o022/);
  assert.match(deploy, /postdeploy bundle ancestor trust is invalid/);
  assert.match(deploy, /metadata\.st_uid != 0[\s\S]*stat\.S_IMODE\(metadata\.st_mode\) & 0o022/);
  assert.ok(deploy.indexOf("postdeploy bundle ancestor trust is invalid") < deploy.indexOf('"$NODE_BIN" "$ATTEST_VERIFIER"'));
});

test("a digest-consistent weakened policy or open schema is still refused", (t) => {
  const data = fixture(t);
  const weakPolicy = JSON.parse(POLICY_BYTES.toString("utf8"));
  weakPolicy.required_roles = ["admin"];
  const weakPolicyBytes = Buffer.from(`${JSON.stringify(weakPolicy)}\n`);
  data.bundle.policy.sha256 = sha256(weakPolicyBytes);
  assert.throws(() => verify(data, { policyBytes: weakPolicyBytes }), /must require admin, boss, operator, and sales|must contain between 4 and 4/);

  const openSchema = JSON.parse(SCHEMA_BYTES.toString("utf8"));
  delete openSchema.properties.roles.items.additionalProperties;
  const openSchemaBytes = Buffer.from(`${JSON.stringify(openSchema)}\n`);
  const schemaData = fixture(t);
  schemaData.bundle.schema.sha256 = sha256(openSchemaBytes);
  assert.throws(() => verify(schemaData, { schemaBytes: openSchemaBytes }), /additionalProperties=false/);

  const openArtifactSchema = JSON.parse(SCHEMA_BYTES.toString("utf8"));
  delete openArtifactSchema.$defs.roleUatArtifact.properties.payload.additionalProperties;
  const openArtifactSchemaBytes = Buffer.from(`${JSON.stringify(openArtifactSchema)}\n`);
  const artifactSchemaData = fixture(t);
  artifactSchemaData.bundle.schema.sha256 = sha256(openArtifactSchemaBytes);
  assert.throws(
    () => verify(artifactSchemaData, { schemaBytes: openArtifactSchemaBytes }),
    /additionalProperties=false/,
  );
});

test("acceptance_verified is not recorded if any sealed artifact changed after verification", (t) => {
  const data = fixture(t);
  const result = verify(data);
  const sealDirectory = path.join(data.directory, "postdeploy-acceptance-v1");
  const attestation = sealVerifiedAcceptance(result, sealDirectory);
  const evidencePath = path.join(data.directory, "deploy-tamper.json");
  writeFileSync(evidencePath, `${JSON.stringify({
    git_sha: RELEASE_SHA,
    build_id: BUILD_ID,
    created_at: DEPLOYED_AT,
    ci: { run_id: RUN_ID },
    release_status: "awaiting_uat",
  }, null, 2)}\n`);
  writeFileSync(path.join(sealDirectory, ...attestation.sealed_artifacts[0].file.split("/")), "tampered\n");
  assert.throws(() => recordDeployAcceptance({
    evidencePath,
    attestationPath: path.join(sealDirectory, "attestation.json"),
    bundlePath: path.join(sealDirectory, "bundle.json"),
  }), /sealed artifact 0 digest/);
  assert.equal(JSON.parse(readFileSync(evidencePath, "utf8")).release_status, "awaiting_uat");
});

test("only a sealed matching attestation can create acceptance_verified", (t) => {
  const data = fixture(t);
  const result = verify(data);
  const sealDirectory = path.join(data.directory, "postdeploy-acceptance-v1");
  const attestation = sealVerifiedAcceptance(result, sealDirectory);
  const evidencePath = path.join(data.directory, "deploy.json");
  writeFileSync(evidencePath, `${JSON.stringify({
    git_sha: RELEASE_SHA,
    build_id: BUILD_ID,
    created_at: DEPLOYED_AT,
    ci: { run_id: RUN_ID },
    release_status: "awaiting_uat",
  }, null, 2)}\n`);
  const acceptance = recordDeployAcceptance({
    evidencePath,
    attestationPath: path.join(sealDirectory, "attestation.json"),
    bundlePath: path.join(sealDirectory, "bundle.json"),
  });
  assert.equal(acceptance.bundle_sha256, attestation.bundle_sha256);
  const recorded = JSON.parse(readFileSync(evidencePath, "utf8"));
  assert.equal(recorded.release_status, "acceptance_verified");
  assert.equal(recorded.acceptance.status, "verified");

  const retry = recordDeployAcceptance({
    evidencePath,
    attestationPath: path.join(sealDirectory, "attestation.json"),
    bundlePath: path.join(sealDirectory, "bundle.json"),
  });
  assert.deepEqual(retry, acceptance);

  const tampered = JSON.parse(readFileSync(path.join(sealDirectory, "attestation.json"), "utf8"));
  tampered.bundle_sha256 = "f".repeat(64);
  writeFileSync(path.join(sealDirectory, "attestation.json"), JSON.stringify(tampered));
  assert.throws(() => recordDeployAcceptance({
    evidencePath,
    attestationPath: path.join(sealDirectory, "attestation.json"),
    bundlePath: path.join(sealDirectory, "bundle.json"),
  }), /sealed bundle digest/);
});
