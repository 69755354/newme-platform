import { redirect } from "next/navigation";
import { createServerSupabase } from "@/lib/supabase-server";
import QuotesClient from "./quotes-client";
import SubNavTabs from "@/components/SubNavTabs";
import { DashboardScrollContainer } from "@/components/DashboardScrollContainer";

export const dynamic = "force-dynamic";

async function authorize() {
  const supabase = await createServerSupabase();
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user) redirect("/login");
  const { data: profile } = await supabase.from("profiles").select("role").eq("id", user.id).single();
  if (!profile?.role || !["admin", "boss", "sales"].includes(profile.role)) redirect("/dashboard");
  return { user, role: profile.role };
}

export default async function QuotesPage() {
  const { user, role } = await authorize();
  let initialData: any[] = [];
  let fetchError: string | null = null;

  try {
    const supabase = await createServerSupabase();
    const { data, error } = await supabase
      .from("quotations")
      .select("*, leads!quotations_lead_id_fkey(customer_name, phone)")
      .order("created_at", { ascending: false })
      .limit(500);
    if (error) throw error;
    if (data) initialData = data;
  } catch (err: any) {
    console.error("Quotes server fetch failed:", err?.message || err);
    fetchError = err?.message || "common.failedToLoadQuotations";
  }

  return (
    <DashboardScrollContainer className="space-y-0">
      <SubNavTabs
        items={[
          { href: "/quotes", labelKey: "quotes.subnavQuotes", iconName: "calculator" },
          { href: "/products", labelKey: "quotes.subnavProducts", iconName: "package" },
        ]}
      />
      <QuotesClient initialData={initialData} fetchError={fetchError} userRole={role} />
    </DashboardScrollContainer>
  );
}
