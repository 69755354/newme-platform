import { createServerSupabase } from "@/lib/supabase-server";
import ProjectsClient from "./projects-client";

export const dynamic = "force-dynamic";

export default async function ProjectsPage() {
  let initialData: any[] = [];
  let fetchError: string | null = null;

  try {
    const supabase = await createServerSupabase();

    const { data: { user } } = await supabase.auth.getUser();
    let role: string | null = null;
    if (user) {
      const { data: profile } = await supabase
        .from("profiles")
        .select("role")
        .eq("id", user.id)
        .single();
      role = profile?.role ?? null;
    }

    let query = supabase
      .from("projects")
      .select(
        `
        *,
        customer:customers!customer_id(
          name,
          phone,
          lead:leads!lead_id(customer_name)
        ),
        assigned_profile:profiles!assigned_to(full_name)
      `
      );

    if (role === "sales" && user) {
      query = query.eq("assigned_to", user.id);
    }

    const { data, error } = await query
      .order("created_at", { ascending: false })
      .limit(500);

    if (error) throw error;
    if (data) initialData = data;
  } catch (err: any) {
    console.error("Projects server fetch failed:", err?.message || err);
    fetchError = err?.message || "common.failedToLoadProjects";
  }

  return (
    <div className="space-y-4">
      <ProjectsClient initialData={initialData} fetchError={fetchError} />
    </div>
  );
}
