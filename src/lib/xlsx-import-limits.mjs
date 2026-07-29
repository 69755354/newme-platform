export const MAX_XLSX_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_XLSX_REQUEST_BYTES = 5 * 1024 * 1024;
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

export async function readXlsxImportJson(
  request,
  { maxBytes = MAX_XLSX_REQUEST_BYTES } = {},
) {
  assertNonNegativeSafeInteger(maxBytes, "maxBytes");

  const declaredText = request.headers?.get?.("content-length");
  if (declaredText != null && declaredText !== "") {
    if (!/^\d+$/.test(declaredText)) {
      throw new TypeError("Content-Length must be a non-negative integer");
    }
    const declaredBytes = Number(declaredText);
    assertNonNegativeSafeInteger(declaredBytes, "Content-Length");
    if (declaredBytes > maxBytes) {
      throw new RangeError(
        `Import request is too large (maximum ${maxBytes} bytes)`,
      );
    }
  }

  if (!request.body || typeof request.body.getReader !== "function") {
    throw new SyntaxError("Request body is required");
  }

  const reader = request.body.getReader();
  const chunks = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) {
        throw new TypeError("Request body must contain bytes");
      }
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new RangeError(
          `Import request is too large (maximum ${maxBytes} bytes)`,
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new SyntaxError("Request body must be valid JSON");
  }
}

