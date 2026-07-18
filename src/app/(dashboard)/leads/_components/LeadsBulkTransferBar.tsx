"use client";

/**
 * LeadsBulkTransferBar — T3-3 step 10 extracted from leads/page.tsx (was L457-500)
 *
 * Bottom-sticky toolbar that appears when an admin/boss selects ≥1 lead.
 * Lets them select-all / clear / open a target-user dropdown / commit a
 * batch reassignment.
 *
 * Returns a React Fragment so the page-level DOM stays identical to the
 * pre-refactor shape. The whole bar (including the conditional wrapper
 * div) is rendered here — no fragment needed in the parent.
 *
 * 100% behavioural equivalence with the inline JSX that lived in page.tsx:
 *   - data-sticky-region="bulk-transfer-bar" preserved on the wrapping div
 *   - same sticky bottom-0 z-10 + 95% backdrop-blur-sm + -mx-4 px-4 py-2.5
 *   - same visibility gate (selectedCount > 0 AND role admin/boss)
 *   - options are the already-filtered shared transfer candidate list
 *   - same button labels, same disabled state, same cancel behaviour
 *
 * Why no supabase calls in this component?
 *   - Per the T3-3 step 10 contract, the bulkTransfer action remains
 *     defined in the page (it touches 4 tables: leads / transfer_history
 *     / activities / business_events — see page.tsx bulkTransfer body).
 *   - This component is a pure presentational shell that delegates the
 *     write to the parent's handler. Easier to mock in tests, and keeps
 *     the data-layer logic in one place.
 *
 * Props mirror the page-level state + handlers exactly. Nothing is
 * duplicated or derived here.
 */

import { Fragment } from "react";
import type { SalesUser } from "../_hooks/useLeadMutations";

/* ─── Props ─── */
export interface LeadsBulkTransferBarProps {
  /** Number of currently selected leads (selectedLeadIds.size). */
  selectedCount: number;
  /** Total filtered leads shown (used for "Select all {n}" affordance). */
  totalFiltered: number;
  /** Current sales role — bar only shows for admin/boss. */
  salesRole: string | null;
  /** Visibility of the target-user dropdown. */
  showBulkTransfer: boolean;
  setShowBulkTransfer: (v: boolean | ((prev: boolean) => boolean)) => void;
  /** Currently chosen target user id, or "" for "Select user...". */
  bulkTransferTargetId: string;
  setBulkTransferTargetId: (v: string | ((prev: string) => string)) => void;
  /** Active sales-capable users from the shared candidate policy. */
  salesUsers: SalesUser[];
  /** Shared reassigning flag — also used by single-card reassign UI. */
  reassigning: boolean;
  /** Page-level handler that performs the 4-table batch write. */
  bulkTransfer: () => Promise<void> | void;
  /** Page-level handler: select every visible filtered lead. */
  onSelectAll: () => void;
  /** Page-level handler: clear the selection set. */
  onClear: () => void;
}

/* ─── Component ─── */
export function LeadsBulkTransferBar({
  selectedCount,
  totalFiltered,
  salesRole,
  showBulkTransfer,
  setShowBulkTransfer,
  bulkTransferTargetId,
  setBulkTransferTargetId,
  salesUsers,
  reassigning,
  bulkTransfer,
  onSelectAll,
  onClear,
}: LeadsBulkTransferBarProps) {
  if (selectedCount <= 0) return <Fragment />;
  if (salesRole !== "admin" && salesRole !== "boss") return <Fragment />;

  return (
    <Fragment>
      {/* bulk-transfer-bar sticky: 选中 lead 后出现在底部，方便用户随时操作
          选中的卡片滚到底，工具栏始终可见 */}
      <div
        data-sticky-region="bulk-transfer-bar"
        className="sticky bottom-0 z-10 bg-background/95 backdrop-blur-sm border-t -mx-4 px-4 py-2.5"
      >
        <div className="flex items-center justify-between px-4 py-2.5 rounded-lg bg-copper-500/10 border border-copper-500/30">
          <span className="text-sm font-medium text-copper-300">{selectedCount} leads selected</span>
          <div className="flex items-center gap-2">
            <button onClick={onSelectAll}
              className="text-xs text-copper-400 hover:text-copper-300">Select all {totalFiltered}</button>
            <button onClick={onClear}
              className="text-xs text-muted-foreground hover:text-foreground">Clear</button>
            {selectedCount > 0 && !showBulkTransfer && (
              <button onClick={() => { setShowBulkTransfer(true); setBulkTransferTargetId(""); }}
                className="inline-flex items-center gap-1 px-3 py-1 text-xs font-medium bg-copper-500 text-foreground rounded-md hover:bg-copper-400 transition-colors">
                Transfer →
              </button>
            )}
            {showBulkTransfer && (
              <>
                <select value={bulkTransferTargetId} onChange={e => setBulkTransferTargetId(e.target.value)}
                  className="text-xs bg-card border border-border/50 rounded px-2 py-1 text-foreground">
                  <option value="">Select user...</option>
                  {salesUsers.map((u: SalesUser) => (
                    <option key={u.id} value={u.id}>{u.full_name || u.email}</option>
                  ))}
                </select>
                <button onClick={bulkTransfer} disabled={reassigning || !bulkTransferTargetId}
                  className="px-3 py-1 text-xs font-medium bg-emerald-600 text-foreground rounded-md hover:bg-emerald-500 disabled:opacity-40 transition-colors">
                  {reassigning ? "Transferring..." : `Transfer ${selectedCount}`}
                </button>
                <button onClick={() => setShowBulkTransfer(false)}
                  className="text-xs text-muted-foreground hover:text-foreground">Cancel</button>
              </>
            )}
          </div>
        </div>
      </div>
    </Fragment>
  );
}
