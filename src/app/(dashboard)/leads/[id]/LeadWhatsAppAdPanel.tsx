"use client";

// Click-to-WhatsApp ad facts for the lead: source ad, Meta click id (copyable, marketing needs it),
// first customer message and our first reply. Shown only for leads that came in through WhatsApp.

import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Copy, Check, ExternalLink, MessageCircle } from "lucide-react";
import { fmtDubai } from "@/lib/utils";
import { durationParts, firstResponseSeconds, isWhatsAppAdLead, isWhatsAppDirectLead } from "@/lib/whatsapp-ad-display.mjs";
import type { Lead } from "./types";

interface Props { lead: Lead; t: (key: string) => string }

export default function LeadWhatsAppAdPanel({ lead, t }: Props) {
  const [copied, setCopied] = useState(false);
  const isAd = isWhatsAppAdLead(lead);
  if (!isAd && !isWhatsAppDirectLead(lead)) return null;

  const copyClickId = async () => {
    try {
      await navigator.clipboard.writeText(lead.ctwa_clid ?? "");
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard unavailable: the id stays selectable on screen */ }
  };
  const when = (value: string | null | undefined) => value
    ? fmtDubai(value, { locale: t("locale.dateLocale"), month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
    : "—";
  const seconds = firstResponseSeconds(lead.wa_first_inbound_at, lead.wa_first_reply_at);
  const parts = seconds === null ? null : durationParts(seconds);
  const duration = parts ? t(`whatsappAds.${parts.unit}`).replace("{n}", String(parts.n)) : null;
  const safeLink = lead.wa_ad_source_url && /^https:\/\//i.test(lead.wa_ad_source_url) ? lead.wa_ad_source_url : null;

  return (
    <Card data-testid="whatsapp-ad-panel">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm">
          <MessageCircle className="h-4 w-4 text-emerald-500" />
          {isAd ? t("whatsappAds.panelTitle") : t("whatsappAds.organicTitle")}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {isAd && (
          <>
            <div>
              <Label className="text-xs text-muted-foreground">{t("whatsappAds.sourceAd")}</Label>
              <div className="mt-0.5 break-words">{lead.ad_name || lead.wa_ad_headline || "—"}</div>
              <div className="text-xs text-muted-foreground">{t("whatsappAds.adId")}: <span className="font-mono select-all">{lead.ad_id || "—"}</span></div>
              {lead.ad_name && lead.wa_ad_headline && (
                <div className="text-xs text-muted-foreground">{t("whatsappAds.headline")}: {lead.wa_ad_headline}</div>
              )}
              {safeLink && (
                <a href={safeLink} target="_blank" rel="noopener noreferrer" className="mt-1 inline-flex items-center gap-1 text-xs text-copper-700 hover:underline">
                  <ExternalLink className="h-3 w-3" />{t("whatsappAds.adLink")}
                </a>
              )}
            </div>
            <div>
              <Label className="text-xs text-muted-foreground">{t("whatsappAds.clickId")}</Label>
              <div className="mt-0.5 flex items-start gap-2">
                <code data-testid="ctwa-clid" className="min-w-0 flex-1 break-all rounded bg-muted px-2 py-1 text-xs select-all">{lead.ctwa_clid || "—"}</code>
                {lead.ctwa_clid && (
                  <button type="button" onClick={copyClickId} aria-label={t("whatsappAds.copy")}
                    className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md border border-border px-2 text-xs hover:bg-muted">
                    {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                    {copied ? t("whatsappAds.copied") : t("whatsappAds.copy")}
                  </button>
                )}
              </div>
            </div>
          </>
        )}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label className="text-xs text-muted-foreground">{t("whatsappAds.firstCustomerMessage")}</Label>
            <div className="mt-0.5 text-xs">{when(lead.wa_first_inbound_at)}</div>
          </div>
          <div>
            <Label className="text-xs text-muted-foreground">{t("whatsappAds.firstReply")}</Label>
            <div className="mt-0.5 text-xs">{lead.wa_first_reply_at ? when(lead.wa_first_reply_at) : t("whatsappAds.noReplyYet")}</div>
          </div>
        </div>
        {duration && (
          <div className="text-xs text-muted-foreground">{t("whatsappAds.responseTime")}: {duration}</div>
        )}
      </CardContent>
    </Card>
  );
}
