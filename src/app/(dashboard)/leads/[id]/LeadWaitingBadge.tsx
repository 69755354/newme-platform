"use client";

import { useState } from "react";

/**
 * "客户在 WhatsApp 等回复 N 小时": the customer wrote first (click-to-WhatsApp ad) and nobody has
 * answered yet. Only the first inbound / first reply timestamps exist on the lead, so this is the
 * wait since the first message while the first reply is still missing; it disappears once we reply.
 */
export default function LeadWaitingBadge({ inboundAt, t }: { inboundAt: string; t: (key: string) => string }) {
  const [now] = useState(() => Date.now());
  const waitingMs = now - new Date(inboundAt).getTime();
  if (!Number.isFinite(waitingMs) || waitingMs < 0) return null;
  const label = waitingMs < 3_600_000
    ? t("s37.wa.waitingMinutes").replace("{n}", String(Math.max(1, Math.round(waitingMs / 60_000))))
    : t("s37.wa.waitingHours").replace("{n}", String(Math.floor(waitingMs / 3_600_000)));
  return (
    <span data-testid="whatsapp-waiting" className="text-xs px-2 py-0.5 rounded font-medium bg-amber-500/10 text-amber-400">
      {label}
    </span>
  );
}
