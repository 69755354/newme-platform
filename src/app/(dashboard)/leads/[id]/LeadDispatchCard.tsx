"use client";

// Dispatch label of this lead (S24): the state, what is missing, and a link to the workbench for admin, boss and
// operator. A salesperson sees the label of their own lead only. The card hides itself while the lead has not been
// checked yet or the batch is not provisioned.
import { useEffect, useState } from "react";
import Link from "next/link";
import { Route } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { callApi, STATUS_TONE } from "@/components/dispatch/shared";
import type { Lead } from "./types";

interface Props { lead: Lead; t: (key: string) => string; role: string | null }
interface State { status: string; missing_fields?: string[]; routing_note?: string | null }

export default function LeadDispatchCard({ lead, t, role }: Props) {
  const allowed = Boolean(role) && ["admin", "boss", "operator", "sales"].includes(role as string);
  const [state, setState] = useState<State | null>(null);
  useEffect(() => {
    if (!allowed) return;
    let cancelled = false;
    (async () => {
      const result = await callApi<{ data: State | null }>(`/api/dispatch/${lead.id}`);
      if (!cancelled && result.ok) setState(result.body.data ?? null);
    })();
    return () => { cancelled = true; };
  }, [allowed, lead.id]);
  if (!allowed || !state) return null;
  const staff = role !== "sales";
  return (
    <Card data-testid="lead-dispatch-card">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm"><Route className="h-4 w-4 text-copper-700" />{t("dispatch.card.title")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-1 text-xs">
        <span className={`inline-flex rounded px-1.5 py-0.5 ${STATUS_TONE[state.status] ?? ""}`}>{t(`dispatch.status.${state.status}`)}</span>
        {state.missing_fields?.length ? <div>{t("dispatch.missingLabel")}: {state.missing_fields.map((f) => t(`dispatch.field.${f}`)).join(", ")}</div> : null}
        {staff && state.routing_note ? <div className="text-muted-foreground">{state.routing_note}</div> : null}
        {staff ? <Link href="/dispatch" className="text-xs underline-offset-2 hover:underline">{t("dispatch.card.openWorkbench")}</Link> : null}
      </CardContent>
    </Card>
  );
}
