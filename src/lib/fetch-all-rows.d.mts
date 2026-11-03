export interface PageResult<T> { data: T[] | null; error: unknown; count?: number | null }
export const DEFAULT_PAGE_SIZE: number;
export const DEFAULT_MAX_ROWS: number;
export function fetchAllRows<T = unknown>(
  buildPage: (from: number, to: number, withCount: boolean) => PromiseLike<PageResult<T>>,
  options?: { pageSize?: number; maxRows?: number },
): Promise<{ data: T[]; error: unknown; truncated: boolean }>;
export function fetchCountedLeads<T = unknown>(
  supabase: unknown,
  columns: string,
  options?: { assignedTo?: string | null },
): Promise<{ data: T[]; error: unknown; truncated: boolean }>;
