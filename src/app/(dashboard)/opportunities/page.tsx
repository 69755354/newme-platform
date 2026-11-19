import { authorizeServerPage } from "@/lib/server-page-auth";
import { ConnectionFailed } from "@/components/ConnectionFailed";
import { DashboardScrollContainer } from "@/components/DashboardScrollContainer";
import OpportunitiesClient from "./opportunities-client";

export const dynamic = "force-dynamic";

export default async function OpportunitiesPage() {
  const session = await authorizeServerPage({ roles: ["admin", "boss", "operator", "sales"] });
  if (session.status === "unavailable") {
    return <DashboardScrollContainer><ConnectionFailed /></DashboardScrollContainer>;
  }
  return (
    <DashboardScrollContainer className="space-y-4">
      <OpportunitiesClient />
    </DashboardScrollContainer>
  );
}
