// S3 #7 — the lead list, the kanban and the pipeline read at most 500 leads
// (`.limit(500)`) and never said so: older leads could not be found, filters and
// column counts were silently wrong. This reads every row the caller may see in
// pages, with the exact total from the database, so the UI can show correct
// counts and say plainly when a (very large) safety ceiling was reached.
//
// Paging advances by the rows actually returned, so a server-side row cap
// smaller than the page size (PostgREST max-rows) cannot end the loop early.

export const LEAD_PAGE_SIZE = 1000;
export const LEAD_MAX_ROWS = 20000;

/**
 * @param {(withCount: boolean) => { range(from: number, to: number): PromiseLike<{ data: unknown[] | null, error: unknown, count?: number | null }> }} makeQuery
 *   builds a fresh, deterministically ordered query; `withCount` asks for the exact count.
 * @returns {Promise<{ rows: unknown[], total: number, truncated: boolean, error: unknown }>}
 */
export async function fetchAllRows(makeQuery, { pageSize = LEAD_PAGE_SIZE, maxRows = LEAD_MAX_ROWS } = {}) {
  const rows = [];
  let total = null;
  while (rows.length < maxRows) {
    const from = rows.length;
    const to = Math.min(from + pageSize, maxRows) - 1;
    const { data, error, count } = await makeQuery(total === null).range(from, to);
    if (error) return { rows, total: total ?? rows.length, truncated: true, error };
    if (total === null) total = typeof count === "number" ? count : null;
    const page = Array.isArray(data) ? data : [];
    rows.push(...page);
    if (page.length === 0) break;
    if (total !== null && rows.length >= total) break;
    if (total === null && page.length < to - from + 1) break;
  }
  const known = total ?? rows.length;
  return { rows, total: Math.max(known, rows.length), truncated: rows.length < known, error: null };
}
