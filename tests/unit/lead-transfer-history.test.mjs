import assert from "node:assert/strict";
import test from "node:test";

import {
  buildTransferProfileNameMap,
  describeLeadTransferEvent,
  formatLeadTransferDescription,
  runAuthorizedLeadTransferRead,
} from "../../src/lib/lead-transfer-history.mjs";

test("transfer history never invokes history reads for unassigned or non-owner sales", async () => {
  for (const assignedTo of [null, "another-sales-user"]) {
    let historyReads = 0;
    const result = await runAuthorizedLeadTransferRead({
      role: "sales",
      userId: "requesting-sales-user",
      loadVisibleLead: async () => ({
        data: { id: "lead-id", assigned_to: assignedTo },
        error: null,
      }),
      revalidateAccess: async () => ({ data: null, error: null }),
      readAuthorizedHistory: async () => {
        historyReads += 1;
        return { status: "ok", transfers: [] };
      },
    });

    assert.equal(result.status, "forbidden");
    assert.equal(historyReads, 0);
  }
});

test("transfer history rejects non-management roles even when they remain the recorded owner", async () => {
  for (const role of ["finance", "designer", "unknown"]) {
    let historyReads = 0;
    const result = await runAuthorizedLeadTransferRead({
      role,
      userId: "recorded-owner",
      loadVisibleLead: async () => ({
        data: { id: "lead-id", assigned_to: "recorded-owner" },
        error: null,
      }),
      revalidateAccess: async () => ({ data: null, error: null }),
      readAuthorizedHistory: async () => {
        historyReads += 1;
        return { status: "ok", transfers: [] };
      },
    });

    assert.equal(result.status, "forbidden");
    assert.equal(historyReads, 0);
  }
});

test("transfer history permits the current sales owner and management roles", async () => {
  for (const [role, userId, assignedTo] of [
    ["sales", "owner", "owner"],
    ["admin", "admin-user", null],
    ["boss", "boss-user", "owner"],
    ["operator", "operator-user", "owner"],
  ]) {
    let historyReads = 0;
    const result = await runAuthorizedLeadTransferRead({
      role,
      userId,
      loadVisibleLead: async () => ({
        data: { id: "lead-id", assigned_to: assignedTo },
        error: null,
      }),
      revalidateAccess: async () => ({
        data: { id: "lead-id", assigned_to: assignedTo },
        error: null,
      }),
      readAuthorizedHistory: async () => {
        historyReads += 1;
        return { status: "ok", transfers: [] };
      },
    });

    assert.equal(result.status, "ok");
    assert.equal(historyReads, 1);
  }
});

test("transfer history suppresses a sales response when ownership changes during the read", async () => {
  let reads = 0;
  const result = await runAuthorizedLeadTransferRead({
    role: "sales",
    userId: "initial-owner",
    loadVisibleLead: async () => ({
      data: { id: "lead-id", assigned_to: "initial-owner" },
      error: null,
    }),
    readAuthorizedHistory: async () => {
      reads += 1;
      return { status: "ok", transfers: [{ id: "must-not-be-returned" }] };
    },
    revalidateAccess: async () => ({
      data: { id: "lead-id", assigned_to: "new-owner" },
      error: null,
    }),
  });

  assert.equal(result.status, "forbidden");
  assert.equal("value" in result, false);
  assert.equal(reads, 1);
});

test("transfer history skips reads when visibility fails or the Lead is absent", async () => {
  for (const visibleResult of [
    { data: null, error: new Error("unavailable") },
    { data: null, error: null },
  ]) {
    let reads = 0;
    const result = await runAuthorizedLeadTransferRead({
      role: "sales",
      userId: "sales-user",
      loadVisibleLead: async () => visibleResult,
      readAuthorizedHistory: async () => {
        reads += 1;
        return { status: "ok", transfers: [] };
      },
      revalidateAccess: async () => ({ data: null, error: null }),
    });

    assert.ok(["visibility_error", "not_found"].includes(result.status));
    assert.equal(reads, 0);
  }
});

test("transfer history formats inactive historical owner names returned by caller RLS", () => {
  const transfers = [{
    from_user_id: "former-owner",
    to_user_id: "current-owner",
    from_user: { id: "former-owner", full_name: "Former Owner", is_active: false },
    to_user: { id: "current-owner", full_name: "Current Owner", is_active: true },
  }];
  const names = buildTransferProfileNameMap(transfers);

  assert.equal(
    formatLeadTransferDescription("former-owner", "current-owner", names),
    "Reassigned from Former Owner to Current Owner",
  );
  assert.equal(
    describeLeadTransferEvent({
      event_type: "transfer",
      description: "Lead reassigned",
      event_data: { from_user_id: "former-owner", to_user_id: "current-owner" },
    }, names),
    "Reassigned from Former Owner to Current Owner",
  );
});

test("transfer history falls back safely when a historical profile is unavailable", () => {
  const names = new Map([["current-owner", "Current Owner"]]);
  assert.equal(
    formatLeadTransferDescription(null, "current-owner", names),
    "Reassigned from Unassigned to Current Owner",
  );
  assert.equal(
    formatLeadTransferDescription("missing-owner", "current-owner", names),
    "Reassigned from Unknown to Current Owner",
  );
  assert.equal(
    describeLeadTransferEvent({
      event_type: "transfer",
      description: "Lead reassigned",
      event_data: { from_user_id: "missing-owner", to_user_id: "current-owner" },
    }, names),
    "Lead reassigned",
  );
});
