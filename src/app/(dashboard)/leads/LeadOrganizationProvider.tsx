"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

interface OrganizationOption {
  id: string;
  name: string;
  slug: string;
  industryKey: string;
}

interface LeadOrganizationContextValue {
  organizationId: string;
  organizations: OrganizationOption[];
  selectOrganization: (organizationId: string) => Promise<void>;
}

const LeadOrganizationContext =
  createContext<LeadOrganizationContextValue | null>(null);

export function useLeadOrganization(): LeadOrganizationContextValue {
  const context = useContext(LeadOrganizationContext);
  if (!context) {
    throw new Error("useLeadOrganization requires LeadOrganizationProvider");
  }
  return context;
}

export function LeadOrganizationProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [organizations, setOrganizations] = useState<OrganizationOption[]>([]);
  const [organizationId, setOrganizationId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const selectOrganization = useCallback(async (nextOrganizationId: string) => {
    const response = await fetch("/api/organizations/context", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ organizationId: nextOrganizationId }),
      cache: "no-store",
    });
    if (!response.ok) {
      throw new Error("organization_selection_failed");
    }
    setOrganizationId(nextOrganizationId);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const response = await fetch("/api/organizations/context", {
        cache: "no-store",
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      if (cancelled) return;
      const options = Array.isArray(payload.organizations)
        ? payload.organizations as OrganizationOption[]
        : [];
      setOrganizations(options);

      if (typeof payload.currentOrganizationId === "string") {
        setOrganizationId(payload.currentOrganizationId);
      } else if (options.length === 1) {
        await selectOrganization(options[0].id);
      }
    })()
      .catch((reason) => {
        if (!cancelled) {
          setError(reason instanceof Error ? reason.message : "organization_context_failed");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectOrganization]);

  const value = useMemo(
    () => organizationId
      ? { organizationId, organizations, selectOrganization }
      : null,
    [organizationId, organizations, selectOrganization],
  );

  if (loading) {
    return <div className="p-6 text-sm text-muted-foreground">Loading organization context…</div>;
  }
  if (error) {
    return <div className="p-6 text-sm text-destructive">Organization context unavailable: {error}</div>;
  }
  if (organizations.length === 0) {
    return <div className="p-6 text-sm text-destructive">No active organization membership.</div>;
  }
  if (!value) {
    return (
      <div className="p-6 space-y-3">
        <p className="text-sm text-foreground">Choose an organization to open Leads.</p>
        <select
          className="rounded-md border border-border bg-background px-3 py-2 text-sm"
          defaultValue=""
          onChange={(event) => {
            if (event.target.value) {
              selectOrganization(event.target.value).catch(() => {
                setError("organization_selection_failed");
              });
            }
          }}
        >
          <option value="" disabled>Select organization</option>
          {organizations.map((organization) => (
            <option key={organization.id} value={organization.id}>
              {organization.name}
            </option>
          ))}
        </select>
      </div>
    );
  }

  return (
    <LeadOrganizationContext value={value}>
      <div className="border-b border-border bg-card/80 px-4 py-2">
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          Organization
          <select
            aria-label="Lead organization"
            className="rounded border border-border bg-background px-2 py-1 text-sm text-foreground"
            value={organizationId ?? ""}
            onChange={(event) => {
              selectOrganization(event.target.value)
                .then(() => window.location.reload())
                .catch(() => setError("organization_selection_failed"));
            }}
          >
            {organizations.map((organization) => (
              <option key={organization.id} value={organization.id}>
                {organization.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      {children}
    </LeadOrganizationContext>
  );
}

