import { LeadOrganizationProvider } from "./LeadOrganizationProvider";

export default function LeadsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <LeadOrganizationProvider>{children}</LeadOrganizationProvider>;
}

