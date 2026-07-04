'use server'

import { createServerSupabase } from '@/lib/supabase-server'

interface UpdateTaskInput {
  title: string
  description: string | null
  priority: string
  assigned_to: string | null
  due_at: string | null
}

interface UpdateTaskStatusInput {
  status: string
}

/**
 * Update task details (title, description, priority, assigned_to, due_at).
 */
export async function updateTask(taskId: string, updates: UpdateTaskInput) {
  const supabase = await createServerSupabase()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('Unauthorized')

  const updateData: Record<string, any> = {
    title: updates.title.trim(),
    description: updates.description?.trim() || null,
    priority: updates.priority,
    assigned_to: updates.assigned_to || null,
    due_at: updates.due_at,
    updated_at: new Date().toISOString(),
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

  const updateData: Record<string, any> = {
    status,
    updated_at: new Date().toISOString(),
  }

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
