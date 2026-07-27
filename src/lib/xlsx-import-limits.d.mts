export const MAX_XLSX_FILE_BYTES: number;
export const MAX_XLSX_ROWS: number;

export interface XlsxImportLimits {
  fileBytes?: number;
  rowCount?: number;
}

export function validateXlsxImportLimits(limits?: XlsxImportLimits): void;
