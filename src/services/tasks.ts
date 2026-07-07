import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * tasks 表 source 列的合法取值（见 crm_v3_new_tables 的 CHECK）。
 */
export type TaskSource = "manual" | "follow_up" | "cron" | "system";

export interface FollowUpTaskInput {
  leadId: string;
  /**
   * 用户给的到期日：YYYY-MM-DD 或 ISO 字符串。
   * "今天" 会被接受（tasks_future_only 已放宽为 24h 宽限）。
   */
  dueAt: string;
  assigneeId?: string | null;
  title?: string;
  source?: TaskSource;
}

/**
 * 把用户输入的日期（YYYY-MM-DD 或 ISO）归一化为 tasks.due_at 可用的 TIMESTAMPTZ。
 * 纯日历日期锚定到 09:00 UTC，使 "今天" 始终落在放宽后的 24h 宽限内，与时区无关。
 * 非法值回退到明天，保证不违反约束。
 */
export function toTaskDueAt(value: string): string {
  const trimmed = (value ?? "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return new Date(`${trimmed}T09:00:00.000Z`).toISOString();
  }
  const d = new Date(trimmed);
  if (isNaN(d.getTime())) {
    return new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  }
  return d.toISOString();
}

/**
 * 为 lead 创建一条跟进 task。集中 lead 创建 / 设置 follow-up → tasks 写入逻辑，
 * 保证每个入口写出来的 task 形状一致（P0-7 最小补丁）。
 * 错误以返回值返回、不抛出，由调用方决定如何提示。
 */
export async function createFollowUpTask(
  supabase: SupabaseClient,
  input: FollowUpTaskInput,
) {
  const due_at = toTaskDueAt(input.dueAt);
  return supabase
    .from("tasks")
    .insert({
      lead_id: input.leadId,
      title: input.title?.trim() || "Follow up",
      assignee_id: input.assigneeId ?? null,
      due_at,
      source: input.source ?? "follow_up",
    })
    .select("id")
    .single();
}
