export declare const LEAD_PAGE_SIZE: number;
export declare const LEAD_MAX_ROWS: number;
export declare function fetchAllRows<T = unknown>(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  makeQuery: (withCount: boolean) => { range(from: number, to: number): PromiseLike<{ data: any[] | null; error: any; count?: number | null }> },
  options?: { pageSize?: number; maxRows?: number },
): Promise<{ rows: T[]; total: number; truncated: boolean; error: unknown }>;
