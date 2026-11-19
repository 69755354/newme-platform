// CSV for marketing: one row per click-to-WhatsApp lead, with the Meta click id and the state of the
// feedback sent back to Meta. Pure functions so the route, node:test and any operator script agree.
export const WA_EXPORT_ROLES = Object.freeze(["admin", "boss", "operator"]);
export const WA_EXPORT_HEADER = Object.freeze([
  "lead_id", "phone", "ctwa_clid", "ad_id", "created_at", "stage", "final_status", "meta_feedback",
]);

export function canExportWhatsAppAdLeads(role) {
  return typeof role === "string" && WA_EXPORT_ROLES.includes(role);
}

/** Spreadsheet-safe cell: a value that could start a formula is prefixed with an apostrophe. */
export function csvCell(value, { phone = false } = {}) {
  let text = value === null || value === undefined ? "" : String(value);
  const plainPhone = phone && /^\+\d{7,15}$/.test(text);
  if (!plainPhone && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** "LeadSubmitted:delivered; QualifiedLead:pending" in a stable order. */
export function feedbackSummary(events) {
  const order = ["LeadSubmitted", "QualifiedLead", "Purchase"];
  return [...events].sort((a, b) => order.indexOf(a.event_name) - order.indexOf(b.event_name))
    .map((e) => `${e.event_name}:${e.status}`).join("; ");
}

export function buildWhatsAppAdExportCsv(leads, events) {
  const byLead = new Map();
  for (const event of events) {
    if (!byLead.has(event.lead_id)) byLead.set(event.lead_id, []);
    byLead.get(event.lead_id).push(event);
  }
  const lines = [WA_EXPORT_HEADER.join(",")];
  for (const lead of leads) {
    lines.push([
      csvCell(lead.id), csvCell(lead.phone, { phone: true }), csvCell(lead.ctwa_clid), csvCell(lead.ad_id),
      csvCell(lead.created_at), csvCell(lead.stage), csvCell(lead.final_status),
      csvCell(feedbackSummary(byLead.get(lead.id) ?? [])),
    ].join(","));
  }
  return `﻿${lines.join("\r\n")}\r\n`;
}
