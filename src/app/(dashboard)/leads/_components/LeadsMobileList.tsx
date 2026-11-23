"use client";

// S39: compact, sortable, paged list of leads for phones (one line pair per lead instead of a big card). The sort the
// user picks is remembered in this browser.

import { useMemo, useState } from "react";
import { MessageCircle, Phone } from "lucide-react";
import { cn } from "@/lib/utils";
import { telHref, whatsappHref } from "@/lib/lead-contact.mjs";
import {
  DEFAULT_LEAD_SORT, LEAD_SORTS, LEAD_SORT_STORAGE_KEY, MOBILE_PAGE_SIZE, neverContacted, overdueFollowUp,
  pageOf, parseLeadSort, sortLeads, type LeadSort,
} from "@/lib/leads-sort.mjs";
import { dubaiDateKey } from "@/lib/dubai-time.mjs";
import { isWaitingForReply, isWhatsAppAdLead } from "@/lib/whatsapp-ad-display.mjs";
import { fmtAED, daysSince } from "../_utils/format";
import { isPlaceholder } from "../_utils/constants";
import type { Lead } from "../_hooks/useLeadsData";

interface Props {
  leads: Lead[];
  /** Changes when a filter changes; a refresh of the same filter keeps the reader on the page they reached. */
  resetKey?: string;
  onOpen: (id: string) => void;
  t: (key: string) => string;
}

export function readSavedSort(): LeadSort {
  try { return parseLeadSort(window.localStorage.getItem(LEAD_SORT_STORAGE_KEY)); } catch { return DEFAULT_LEAD_SORT; }
}

export function LeadsMobileList({ leads, resetKey = "", onOpen, t }: Props) {
  // Rendered only after the leads have loaded in the browser, so reading the saved sort at first render is safe.
  const [sort, setSort] = useState<LeadSort>(() => readSavedSort());
  // The page count belongs to one (filter, sort) pair. A refresh that hands over a NEW array of the same leads keeps
  // the page the reader reached; only a filter change (resetKey) or a sort change starts again at the first page.
  const [pageState, setPageState] = useState<{ resetKey: string; sort: LeadSort; pages: number }>({ resetKey, sort, pages: 1 });
  const pages = pageState.resetKey === resetKey && pageState.sort === sort ? pageState.pages : 1;

  const today = dubaiDateKey() ?? "";
  const sorted = useMemo(() => sortLeads(leads, sort), [leads, sort]);
  const shown = pageOf(sorted, pages);

  const choose = (value: string) => {
    const next = parseLeadSort(value);
    setSort(next);
    try { window.localStorage.setItem(LEAD_SORT_STORAGE_KEY, next); } catch { /* the choice just is not remembered */ }
  };

  return (
    <div data-testid="leads-mobile-list" className="space-y-2 pb-24">
      <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>{t("s39.list.count").replace("{n}", String(sorted.length))}</span>
        <label className="flex items-center gap-1">
          {t("s39.list.sort")}
          <select
            data-testid="leads-sort-select"
            value={sort}
            onChange={(event) => choose(event.target.value)}
            className="h-9 rounded-md border border-border bg-background px-2 text-xs text-foreground"
          >
            {LEAD_SORTS.map((key) => <option key={key} value={key}>{t(`s39.list.sorts.${key}`)}</option>)}
          </select>
        </label>
      </div>
      <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
        {shown.map((lead) => {
          const fresh = neverContacted(lead);
          const overdue = overdueFollowUp(lead, today);
          const tel = telHref(lead.phone);
          const wa = whatsappHref(lead.phone);
          const days = daysSince(lead.last_contact_date || lead.updated_at);
          const name = !isPlaceholder(lead.customer_name) ? lead.customer_name : (lead.phone || t("common.unnamed"));
          return (
            <li key={lead.id} data-testid="leads-mobile-row" data-lead-id={lead.id} className="flex items-stretch">
              <button type="button" onClick={() => onOpen(lead.id)} className="min-w-0 flex-1 px-3 py-2 text-left">
                <div className="flex items-center gap-1.5">
                  <span className="truncate text-sm font-medium text-foreground">{name}</span>
                  {isWhatsAppAdLead(lead) && (
                    <span data-testid="whatsapp-ad-badge" className="shrink-0 rounded bg-emerald-500/10 px-1 py-0.5 text-xs font-medium text-emerald-400">{t("s37.wa.badge")}</span>
                  )}
                  {lead.quotation_value != null && lead.quotation_value > 0 && (
                    <span className="ml-auto shrink-0 text-xs font-semibold text-copper-400">{fmtAED(lead.quotation_value)}</span>
                  )}
                </div>
                <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
                  <span>{t(`stageLabels.${lead.final_status || lead.stage}`)}</span>
                  <span>{t(`sourceLabels.${lead.source}`)}</span>
                  {fresh && <span data-testid="row-uncontacted" className="font-medium text-amber-500">{t("s39.list.uncontacted")}</span>}
                  {!fresh && overdue && <span data-testid="row-overdue" className="font-medium text-rose-400">{t("s39.list.overdue")}</span>}
                  {!fresh && !overdue && days !== null && <span>{days === 0 ? t("common.today") : t("common.nDays").replace("{n}", String(days))}</span>}
                  {isWaitingForReply(lead) && <span data-testid="row-waiting" className="font-medium text-amber-400">{t("s39.list.waitingReply")}</span>}
                </div>
              </button>
              <div className="flex shrink-0 items-center gap-1 pr-2">
                {tel && <a href={tel} aria-label={t("s39.actions.call")} className="flex h-11 w-11 items-center justify-center rounded-lg text-copper-400 hover:bg-muted"><Phone className="h-5 w-5" /></a>}
                {wa && <a href={wa} target="_blank" rel="noopener noreferrer" aria-label="WhatsApp" className={cn("flex h-11 w-11 items-center justify-center rounded-lg text-emerald-400 hover:bg-muted")}><MessageCircle className="h-5 w-5" /></a>}
              </div>
            </li>
          );
        })}
      </ul>
      {shown.length < sorted.length && (
        <button type="button" data-testid="leads-load-more" onClick={() => setPageState({ resetKey, sort, pages: pages + 1 })}
          className="h-11 w-full rounded-lg border border-border bg-card text-sm font-medium text-foreground hover:bg-muted">
          {t("s39.list.loadMore").replace("{n}", String(Math.min(MOBILE_PAGE_SIZE, sorted.length - shown.length)))}
        </button>
      )}
      {sorted.length === 0 && <p className="py-10 text-center text-sm text-muted-foreground">{t("s39.list.empty")}</p>}
    </div>
  );
}
