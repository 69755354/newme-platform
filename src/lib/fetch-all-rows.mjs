// Read every row of a PostgREST query in pages.
//
// Supabase silently caps an unranged select at the project's max-rows (1000), and
// several report routes added their own `.limit(500)`; past either number the
// totals on the dashboard and attribution pages quietly stopped growing. Report
// routes read the narrow metric columns through this helper instead.
//
// `buildPage(from, to, withCount)` must return a fresh query for rows
// [from, to] with a stable order (e.g. `.order("id")`) and, when `withCount` is
// true, a `{ count: "exact" }` select. The first page reports the total; the
// remaining pages are requested in parallel.
//
// The result is `{ data, error, truncated, total }`: `total` is the exact count
// from the database (or the number of rows read when the server gave none), and
// `truncated` is true only when the safety ceiling stopped the read short. On
// any page error the result has no rows and carries the error.
//
// This is the single paged reader for report routes AND the lead / pipeline
// lists (S3 and S5 used to carry one each). The lists pass LIST_MAX_ROWS.

export const DEFAULT_PAGE_SIZE = 1000;
export const DEFAULT_MAX_ROWS = 50000;
export const LIST_MAX_ROWS = 20000;

export async function fetchAllRows(buildPage, { pageSize = DEFAULT_PAGE_SIZE, maxRows = DEFAULT_MAX_ROWS } = {}) {
  const first = await buildPage(0, pageSize - 1, true);
  if (first.error) return { data: [], error: first.error, truncated: false, total: 0 };
  const rows = [...(first.data ?? [])];
  const total = typeof first.count === "number" ? first.count : null;
  if (rows.length === 0 || (total !== null && total <= rows.length)) {
    return { data: rows, error: null, truncated: false, total: Math.max(total ?? 0, rows.length) };
  }
  if (total === null && rows.length < pageSize) {
    return { data: rows, error: null, truncated: false, total: rows.length };
  }

  const target = Math.min(total ?? maxRows, maxRows);
  if (rows.length === pageSize && total !== null) {
    // Normal case: the server honoured the page size, so the remaining pages are
    // independent and are requested in parallel.
    const pages = [];
    for (let from = pageSize; from < target; from += pageSize) {
      pages.push(buildPage(from, Math.min(from + pageSize, target) - 1, false));
    }
    for (const page of await Promise.all(pages)) {
      if (page.error) return { data: [], error: page.error, truncated: false, total: 0 };
      rows.push(...(page.data ?? []));
    }
    return { data: rows, error: null, truncated: total > maxRows, total: Math.max(total, rows.length) };
  }

  // The server returned fewer rows than asked (a project-level row cap smaller
  // than the page size) or gave no count: advance by what actually came back so
  // no row range is skipped.
  while (rows.length < target) {
    const from = rows.length;
    const page = await buildPage(from, Math.min(from + pageSize, target) - 1, false);
    if (page.error) return { data: [], error: page.error, truncated: false, total: 0 };
    const got = page.data ?? [];
    if (got.length === 0) break;
    rows.push(...got);
    if (total === null && got.length < pageSize) break;
  }
  return {
    data: rows,
    error: null,
    truncated: (total ?? rows.length) > rows.length,
    total: Math.max(total ?? rows.length, rows.length),
  };
}

/**
 * Every counted (non-archived) lead with the narrow metric columns, optionally
 * for one assignee. `columns` defaults to the lead-metrics column list.
 */
export function fetchCountedLeads(supabase, columns, { assignedTo = null } = {}) {
  return fetchAllRows((from, to, withCount) => {
    let q = supabase
      .from("leads")
      .select(columns, withCount ? { count: "exact" } : undefined)
      .eq("archived", false);
    if (assignedTo) q = q.eq("assigned_to", assignedTo);
    return q.order("id", { ascending: true }).range(from, to);
  });
}
