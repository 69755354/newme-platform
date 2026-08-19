// RBAC: user (authenticated)
//
// Any signed-in employee (admin | boss | operator | sales) may open this page:
// it is an internal estimating tool, so no role is filtered here — matching the
// three /api/cable-costing routes it calls. That is a deliberate difference from
// /quotes, which narrows to admin | boss | sales.
//
// The gate below is the SERVER-side one. The (dashboard) layout also redirects
// anonymous visitors, but it is a client component, so it is a convenience and
// not a boundary. `/cable-costing/:path*` is additionally registered in
// src/proxy.ts's matcher so the edge sees this page too (is_active revocation
// and the forced-password-change refusal); tests/security/
// forced-password-change-boundary.test.mjs asserts that registration.
//
// PUBLIC REPOSITORY / PRICE BOUNDARY: no price, rate or coefficient appears in
// this directory. The client component fetches every figure from
// /api/cable-costing/*, which loads the rate card from the server-only
// `CABLE_COSTING_CONFIG`.

import { redirect } from "next/navigation";
import { createServerSupabase } from "@/lib/supabase-server";
import { DashboardScrollContainer } from "@/components/DashboardScrollContainer";
import CableCostingClient from "./cable-costing-client";

// The page renders per-session and reads runtime configuration through its API
// routes, so it must never be prerendered at build time.
export const dynamic = "force-dynamic";

export default async function CableCostingPage() {
  const supabase = await createServerSupabase();
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();
  if (error || !user) redirect("/login");

  return (
    <DashboardScrollContainer>
      <CableCostingClient />
    </DashboardScrollContainer>
  );
}
