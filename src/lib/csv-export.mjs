const FORMULA_PREFIX = /^[\t\r\n ]*[=+\-@]/;

export function csvEscape(value) {
  let text = value == null ? "" : String(value);
  if (FORMULA_PREFIX.test(text)) {
    text = `'${text}`;
  }
  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

export function buildCsv(rows) {
  return "\uFEFF" + rows.map((row) => row.map(csvEscape).join(",")).join("\n");
}

export function sanitizeDownloadFilenamePart(value) {
  const safe = String(value ?? "")
    .trim()
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .slice(0, 80);
  return safe || "download";
}
