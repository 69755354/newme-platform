/** Database receipts are evidence; a successful transport alone is not. */
export function atomicWriteResult(data, expected) {
  if (!data || Array.isArray(data) || data.ok !== true || data.atomic !== true ||
      data.inserted !== expected || data.present !== expected ||
      !Number.isSafeInteger(data.deleted) || data.deleted < 0 ||
      !Number.isFinite(data.total_spend_aed) || data.total_spend_aed < 0) {
    return { ok: false, error: "window_row_count_mismatch" };
  }
  return { ok: true, inserted: data.inserted, deleted: data.deleted, present: data.present };
}

export function atomicWriteError(error) {
  if (error?.code === "55P03" || error?.code === "57014")
    return { error: "sync_already_running", status: 409 };
  if (["overlapping_spend_window", "empty_window_requires_review"].includes(error?.message))
    return { error: error.message, status: 409 };
  if (error?.code === "PGRST202") return { error: "atomic_writer_unavailable", status: 503 };
  if (typeof error?.code === "string" && error.code.startsWith("22"))
    return { error: "invalid_window_rows", status: 422 };
  return { error: "atomic_window_replace_failed", status: 500 };
}
