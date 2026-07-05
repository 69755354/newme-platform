// DEPRECATED (P3_4): /command-center was merged into /dashboard.
// Kept for legacy URL/bookmark compatibility — redirect to /dashboard.
import { redirect } from "next/navigation";

export default function CommandCenterDeprecatedPage() {
  redirect("/dashboard");
}