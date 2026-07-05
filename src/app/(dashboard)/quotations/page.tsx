// DEPRECATED (P3_4): /quotations was merged into /quotes.
// Kept for legacy URL/bookmark compatibility — redirect to /quotes.
import { redirect } from "next/navigation";

export default function QuotationsDeprecatedPage() {
  redirect("/quotes");
}