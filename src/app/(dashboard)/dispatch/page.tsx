import { authorizeServerPage } from "@/lib/server-page-auth";
import { ConnectionFailed } from "@/components/ConnectionFailed";
import { DashboardScrollContainer } from "@/components/DashboardScrollContainer";
import DispatchClient from "./dispatch-client";

export const dynamic = "force-dynamic";

export default async function DispatchPage() {
  const session = await authorizeServerPage({ roles: ["admin", "boss", "operator"] });
  if (session.status === "unavailable") {
    return <DashboardScrollContainer><ConnectionFailed /></DashboardScrollContainer>;
  }
  return (
    <DashboardScrollContainer className="space-y-4">
      <DispatchClient />
    </DashboardScrollContainer>
  );
}
