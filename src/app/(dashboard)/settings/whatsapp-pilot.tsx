"use client";

import { useCallback, useEffect, useState } from "react";
import { useLanguage } from "@/lib/i18n/LanguageContext";
import type { PilotConversation } from "@/lib/whatsapp-pilot.mjs";
import WhatsAppReviewTools from "./whatsapp-review-tools";
import WhatsAppPrivacy from "./whatsapp-privacy";

type Status = {
  state: string; configured: boolean; since?: string; last_received_at?: string | null;
  channels: { id: string; label: string; purpose: string; enabled: boolean }[];
  conversations: PilotConversation[];
};

export default function WhatsAppPilot() {
  const { lang } = useLanguage();
  const zh = lang === "zh";
  const [data, setData] = useState<Status | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(false);
  const load = useCallback(async () => {
    setLoading(true); setError(false);
    try {
      const response = await fetch("/api/whatsapp/pilot-status", { cache: "no-store" });
      if (!response.ok) throw new Error("status_unavailable");
      setData(await response.json());
    } catch { setError(true); setData(null); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => {
    const timer = window.setTimeout(() => { void load(); }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);
  const date = (value: string | null | undefined) => value
    ? new Date(value).toLocaleString(zh ? "zh-CN" : "en-GB", { timeZone: "Asia/Dubai" }) : "—";
  const states: Record<string, string> = zh ? {
    disabled: "试点尚未启用", awaiting_channels: "等待号码接入", awaiting_events: "等待真实消息验收",
    observing: "已收到部分消息事件，覆盖范围仍需验收", sample_limit: "超出显示上限，暂不计算回复指标",
  } : {
    disabled: "Pilot not enabled", awaiting_channels: "Waiting for number onboarding", awaiting_events: "Waiting for a real-message check",
    observing: "Message events received; coverage still needs validation", sample_limit: "Display limit reached; response metrics withheld",
  };
  return <section className="space-y-4" aria-label={zh ? "WhatsApp 试点" : "WhatsApp pilot"}>
    <div className="flex items-center justify-between gap-4">
      <h2 className="text-lg font-semibold">{zh ? "WhatsApp 收发跟进试点" : "WhatsApp follow-up pilot"}</h2>
      <button type="button" onClick={load} disabled={loading} className="border border-border rounded-lg px-3 py-2 text-sm disabled:opacity-50">
        {loading ? (zh ? "读取中…" : "Loading…") : (zh ? "刷新" : "Refresh")}
      </button>
    </div>
    <p className="text-sm text-muted-foreground">{zh
      ? "仅统计已接入号码过去 7 天收到的客户消息和手机发信事件；不保存聊天正文。缺少同步事件不能证明员工未回复，号码上的发信也不能证明由哪位员工操作。群聊、通话及不受支持设备不在统计范围内。"
      : "Observed customer messages and handset sends from opted-in numbers over the last 7 days. No chat content is stored. Missing events do not prove a missed reply; a send identifies a number, not an employee. Groups, calls and unsupported devices are outside coverage."}</p>
    {error && <p role="alert" className="text-rose-500">{zh ? "读取失败，暂时无法判断接入状态。" : "Status unavailable. Connection state is unknown."}</p>}
    {data && <>
      <p role="status" className="rounded-lg bg-muted/50 p-3">{states[data.state] ?? (zh ? "未知状态" : "Unknown state")}</p>
      <p className="text-xs text-muted-foreground">{zh ? "最近收到事件（迪拜时间）：" : "Last event received (Dubai): "}{date(data.last_received_at)}</p>
      {!data.channels.length && <p>{zh ? "尚无已配置的试点号码。" : "No pilot numbers configured yet."}</p>}
      {data.channels.map(channel => {
        const rows = data.conversations.filter(row => row.channel_id === channel.id);
        return <div key={channel.id} className="rounded-xl border border-border p-4 space-y-3">
          <h3 className="font-medium">{channel.label} · {channel.purpose === "intake" ? (zh ? "主号收件" : "Intake") : (zh ? "跟进号" : "Follow-up")}
            {!channel.enabled && (zh ? " · 未启用" : " · Disabled")}</h3>
          {!rows.length ? <p className="text-sm text-muted-foreground">{zh ? "暂无可计算的消息记录。" : "No measurable message records yet."}</p> : <div className="overflow-auto">
            <table className="w-full text-sm text-left"><thead><tr>
              {(zh ? ["客户代号", "收件 / 发信", "本轮待回复起点", "最近发信", "已观察到的回复间隔"] : ["Contact reference", "In / Out", "Pending since", "Last send", "Observed response intervals"]).map(text => <th key={text} className="p-2 whitespace-nowrap">{text}</th>)}
            </tr></thead><tbody>{rows.map(row => <tr key={row.customer_ref} className="border-t border-border/50">
              <td className="p-2 font-mono">{row.customer_ref}</td><td className="p-2">{row.inbound_count} / {row.outbound_count}</td>
              <td className="p-2 whitespace-nowrap">{date(row.pending_since)}</td><td className="p-2 whitespace-nowrap">{date(row.last_outbound_at)}</td>
              <td className="p-2">{row.observed_response_seconds.length ? row.observed_response_seconds.map(s => `${Math.round(s / 60)} min`).join(", ") : "—"}</td>
            </tr>)}</tbody></table>
          </div>}
        </div>;
      })}
      <p className="text-xs text-muted-foreground">{zh ? "跨号码交接以 OS 的分配记录另行核对；本页不将主号收件时间当成销售接单时间。" : "Cross-number handoff must be checked against OS assignment records. Intake time is not a salesperson's assignment time."}</p>
    </>}
    <WhatsAppPrivacy />
    <WhatsAppReviewTools />
  </section>;
}
