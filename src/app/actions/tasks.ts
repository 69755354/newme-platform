'use server'

import { createServerSupabase } from '@/lib/supabase-server'
import type { Database } from '@/types/database'

type TaskUpdate = Database['public']['Tables']['tasks']['Update']

interface UpdateTaskInput {
  title: string
  assignee_id: string | null
  due_at: string | null
}

interface UpdateTaskStatusInput {
  status: string
}

/**
 * Update the task fields that exist in the production tasks contract.
 */
export async function updateTask(taskId: string, updates: UpdateTaskInput) {
  const supabase = await createServerSupabase()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('Unauthorized')

  // Role + ownership gate
  const { data: profile } = await supabase.from('profiles').select('role').eq('id', user.id).single()
  const isPrivileged = profile?.role ? ['admin', 'boss', 'operator'].includes(profile.role) : false
  if (!isPrivileged) {
    const { data: task } = await supabase.from('tasks').select('assignee_id').eq('id', taskId).single()
    if (!task || task.assignee_id !== user.id) throw new Error('Forbidden')
  }

  const updateData: TaskUpdate = {
    title: updates.title.trim(),
    assignee_id: updates.assignee_id,
    due_at: updates.due_at,
  }

  const { error: err } = await supabase
    .from('tasks')
    .update(updateData)
    .eq('id', taskId)

  if (err) throw new Error(err.message || 'Failed to update task')

  return { success: true }
}

/**
 * Update task status.
 */
export async function updateTaskStatus(taskId: string, status: string) {
  const supabase = await createServerSupabase()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('Unauthorized')

  // Role + ownership gate
  const { data: profile } = await supabase.from('profiles').select('role').eq('id', user.id).single()
  const isPrivileged = profile?.role && ['admin', 'boss', 'operator'].includes(profile.role)
  if (!isPrivileged) {
    const { data: task } = await supabase.from('tasks').select('assignee_id').eq('id', taskId).single()
    if (!task || task.assignee_id !== user.id) throw new Error('Forbidden')
  }

  const updateData: TaskUpdate = { status }

  if (status === 'done') {
    updateData.completed_at = new Date().toISOString()
  } else {
    updateData.completed_at = null
  }

  const { error: err } = await supabase
    .from('tasks')
    .update(updateData)
    .eq('id', taskId)

  if (err) throw new Error(err.message || 'Failed to update task status')

  return { success: true }
}
