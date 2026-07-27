export const MAX_XLSX_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_XLSX_ROWS = 2_000;

function assertNonNegativeSafeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
}

export function validateXlsxImportLimits({ fileBytes, rowCount } = {}) {
  if (fileBytes !== undefined) {
    assertNonNegativeSafeInteger(fileBytes, "fileBytes");
    if (fileBytes > MAX_XLSX_FILE_BYTES) {
      throw new RangeError(
        `XLSX file is too large (maximum ${MAX_XLSX_FILE_BYTES} bytes)`,
      );
    }
  }

  if (rowCount !== undefined) {
    assertNonNegativeSafeInteger(rowCount, "rowCount");
    if (rowCount > MAX_XLSX_ROWS) {
      throw new RangeError(
        `XLSX contains too many rows (maximum ${MAX_XLSX_ROWS})`,
      );
    }
  }
}
