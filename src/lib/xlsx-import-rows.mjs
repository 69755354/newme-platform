const UNSAFE_ROW_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export function validateXlsxImportRows(rows) {
  if (!Array.isArray(rows)) {
    throw new TypeError("Import rows must be an array");
  }

  for (let index = 0; index < rows.length; index++) {
    const row = rows[index];
    const prototype = row != null && typeof row === "object"
      ? Object.getPrototypeOf(row)
      : undefined;

    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`Import row ${index + 1} must be a plain object`);
    }

    for (const key of Object.keys(row)) {
      if (UNSAFE_ROW_KEYS.has(key)) {
        throw new TypeError(`Import row ${index + 1} contains an unsafe column name`);
      }
    }
  }
}
