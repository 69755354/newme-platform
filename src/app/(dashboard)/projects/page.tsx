import { createServerSupabase } from "@/lib/supabase-server";
import { authorizeServerPage } from "@/lib/server-page-auth";
import { ConnectionFailed } from "@/components/ConnectionFailed";
import ProjectsClient from "./projects-client";
import { DashboardScrollContainer } from "@/components/DashboardScrollContainer";

export const dynamic = "force-dynamic";

export default async function ProjectsPage() {
  const session = await authorizeServerPage({ roles: ["admin", "boss", "sales", "operator"] });
  if (session.status === "unavailable") {
    return <DashboardScrollContainer><ConnectionFailed /></DashboardScrollContainer>;
  }
  const { user, role } = session;
  let initialData: any[] = [];
  let fetchError: string | null = null;

  try {
    const supabase = await createServerSupabase();

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
    <DashboardScrollContainer className="space-y-4">
      <ProjectsClient initialData={initialData} fetchError={fetchError} />
    </DashboardScrollContainer>
  );
}
