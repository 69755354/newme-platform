import { redirect } from "next/navigation";

// ROOT_WHITEPAGE_FIX (2026-07-05): force dynamic so Next.js does not
// prerender/cache this page (which would bypass proxy.ts edge redirect
// and serve the empty BAILOUT_TO_CLIENT_SIDE_RENDERING shell).
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";
export const runtime = "nodejs";

export default function Home() {
  redirect("/dashboard");
}