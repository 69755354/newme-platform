export const MAX_XLSX_FILE_BYTES: number;
export const MAX_XLSX_REQUEST_BYTES: number;
export const MAX_XLSX_ROWS: number;

export interface XlsxImportLimits {
  fileBytes?: number;
  rowCount?: number;
}

export interface XlsxImportJsonOptions {
  maxBytes?: number;
}

export function validateXlsxImportLimits(limits?: XlsxImportLimits): void;
export function readXlsxImportJson(
  request: Request,
  options?: XlsxImportJsonOptions,
): Promise<unknown>;

