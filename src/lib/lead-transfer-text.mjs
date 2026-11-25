// S42 (recheck §2-13, F18): reassign_lead_atomic() writes an `activities` row that reads
// "Lead reassigned from <uuid> to <uuid>" (and "Lead unassigned from <uuid>"). The same transfer is also
// stored as a business_event whose event_data carries the ids, and the lead page already renders that one
// with names (lead-transfer-history.mjs). These helpers recognise the raw activity text so a renderer can
// hide the duplicate, and rewrite the ids with names where only the text is available (timeline API).

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const RAW_TRANSFER = /^Lead (?:re|un)assigned from (?:unassigned|[0-9a-f-]{36})(?: to (?:unassigned|[0-9a-f-]{36}))?$/i;

/** True for the machine-written transfer activity ("Lead reassigned from <uuid> to <uuid>"). */
export function isRawTransferActivity(text) {
  return typeof text === "string" && RAW_TRANSFER.test(text.trim());
}

/** The user ids mentioned in a raw transfer text, in order. */
export function transferUuids(text) {
  if (typeof text !== "string") return [];
  return [...text.matchAll(UUID)].map((m) => m[0].toLowerCase());
}

/**
 * Replace every user id in a transfer text with the person's name. An id with no known name becomes
 * "a colleague" rather than the raw UUID, so no identifier ever reaches the screen.
 * @param {string} text
 * @param {(id: string) => string | null | undefined} nameOf
 */
export function humanizeTransferText(text, nameOf) {
  if (!isRawTransferActivity(text)) return text;
  return text.trim().replace(UUID, (id) => {
    const name = nameOf(id.toLowerCase()) ?? nameOf(id);
    return typeof name === "string" && name.trim() ? name.trim() : "a colleague";
  });
}
