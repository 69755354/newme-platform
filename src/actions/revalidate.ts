"use server";

import { revalidatePath } from "next/cache";

/**
 * Server Action: clears all cached Server Component data.
 * Call after signOut or critical data mutations to ensure fresh data on next visit.
 */
export async function revalidateEverything() {
  revalidatePath("/", "layout");
}
