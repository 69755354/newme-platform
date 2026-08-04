"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";

type OrganizationOption = {
  id: string;
  name: string;
  slug: string;
  industryKey: string;
};

type OrganizationContextPayload = {
  organizations?: OrganizationOption[];
  currentOrganizationId?: string | null;
};

/**
 * Sets the server-validated organization cookie used by tenant-scoped routes.
 * This component deliberately makes no authorization decision in the browser.
 */
export function OrganizationContextSwitcher() {
  const pathname = usePathname();
  const [organizations, setOrganizations] = useState<OrganizationOption[]>([]);
  const [currentOrganizationId, setCurrentOrganizationId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const response = await fetch("/api/organizations/context", { cache: "no-store" });
        if (!response.ok) throw new Error("organization_context_unavailable");
        const payload = await response.json() as OrganizationContextPayload;
        if (cancelled) return;

        const options = Array.isArray(payload.organizations) ? payload.organizations : [];
        setOrganizations(options);
        setCurrentOrganizationId(
          typeof payload.currentOrganizationId === "string" ? payload.currentOrganizationId : null,
        );
      } catch {
        if (!cancelled) setError("organization_context_unavailable");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void load();
    return () => { cancelled = true; };
  }, []);

  async function selectOrganization(organizationId: string) {
    setSwitching(true);
    setError(null);
    try {
      const response = await fetch("/api/organizations/context", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ organizationId }),
        cache: "no-store",
      });
      if (!response.ok) throw new Error("organization_selection_failed");
      setCurrentOrganizationId(organizationId);
      window.location.reload();
    } catch {
      setError("organization_selection_failed");
    } finally {
      setSwitching(false);
    }
  }

  // Leads retain their existing scoped selector until that shell is migrated.
  if (pathname.startsWith("/leads") || loading || organizations.length === 0) return null;

  const value = currentOrganizationId ?? "";

  return (
    <div className="border-b border-border bg-card/80 px-6 py-2">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <label className="flex items-center gap-2">
          Current organization
          <select
            aria-label="Current organization"
            className="rounded border border-border bg-background px-2 py-1 text-sm text-foreground disabled:opacity-60"
            disabled={switching}
            value={value}
            onChange={(event) => {
              if (event.target.value) void selectOrganization(event.target.value);
            }}
          >
            {!value && <option value="" disabled>Select organization</option>}
            {organizations.map((organization) => (
              <option key={organization.id} value={organization.id}>
                {organization.name}
              </option>
            ))}
          </select>
        </label>
        {error ? <span role="status" className="text-destructive">Unable to change organization.</span> : null}
      </div>
    </div>
  );
}
