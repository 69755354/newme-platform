import { createServerSupabase } from "@/lib/supabase-server";
import QuotesClient from "./quotes-client";
import SubNavTabs from "@/components/SubNavTabs";

export const dynamic = "force-dynamic";

export default async function QuotesPage() {
  let initialData: any[] = [];
  let fetchError: string | null = null;

  try {
    const supabase = await createServerSupabase();
    const { data, error } = await supabase
      .from("quotations")
      .select("*, leads(customer_name, phone)")
      .order("created_at", { ascending: false })
      .limit(500);
    if (error) throw error;
    if (data) initialData = data;
  } catch (err: any) {
    console.error("Quotes server fetch failed:", err?.message || err);
    fetchError = err?.message || "common.failedToLoadQuotations";
  }

  return (
    <div className="space-y-0">
      <SubNavTabs
        items={[
          { href: "/quotes", labelKey: "quotes.subnavQuotes", iconName: "calculator" },
          { href: "/products", labelKey: "quotes.subnavProducts", iconName: "package" },
        ]}
      />
      <QuotesClient initialData={initialData} fetchError={fetchError} />
    </div>
  );
}
