/**
 * Which contract action buttons a role may use on a contract in a given status.
 *
 * OS fix stream S2 (review 4c problems 6-8): the detail page showed Approve /
 * Reject / Upload / Remind / Revoke to every "management" role regardless of the
 * approval step, so finance saw Approve on a pending_admin contract, boss saw it on
 * the admin step and admin on the boss step, and every click came back as a
 * refusal. The rules below are the routines' own, restated for the UI:
 *
 *   approve  approve_contract(): pending_admin → money_actor(['admin','operator'])
 *                                pending_ceo   → money_actor(['boss'])
 *   revoke   revoke_contract():  money_actor(['admin','boss']); transition table
 *                                admits revoking from approved / active / suspended
 *   upload   /api/contracts/[id]/upload-url: admin/boss or the contract owner,
 *                                while the contract is draft / pending_*
 *   remind   /api/contracts/[id]/remind-payment: admin/boss/operator or the owner
 *
 * This is a usability boundary, not the security boundary: the routes and
 * routines refuse on their own. A .mjs module so node --test imports the value
 * the app ships (same reason as src/lib/contract-status-capabilities.mjs).
 */

/** Roles approve_contract() accepts for each awaiting status. */
export const APPROVAL_STEP_ROLES = Object.freeze({
  pending_admin: Object.freeze(["admin", "operator"]),
  pending_ceo: Object.freeze(["boss"]),
});

const REVOKABLE = Object.freeze(["approved", "active", "suspended"]);
const UPLOADABLE = Object.freeze(["draft", "pending_admin", "pending_ceo"]);

/**
 * @param {string} role       the caller's profiles.role
 * @param {boolean} isOwner   contract.sales_id === caller
 * @param {string} status     contract.status
 * @returns {{approve: boolean, revoke: boolean, upload: boolean, remind: boolean}}
 */
export function contractActionPermissions(role, isOwner, status) {
  const stepRoles = APPROVAL_STEP_ROLES[status] ?? [];
  const adminOrBoss = role === "admin" || role === "boss";
  return {
    approve: stepRoles.includes(role),
    revoke: adminOrBoss && REVOKABLE.includes(status),
    upload: (adminOrBoss || isOwner === true) && UPLOADABLE.includes(status),
    remind: adminOrBoss || role === "operator" || isOwner === true,
  };
}
