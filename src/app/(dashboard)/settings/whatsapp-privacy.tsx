"use client";

import { useCallback, useEffect, useState } from "react";
import { useLanguage } from "@/lib/i18n/LanguageContext";

type Receipt = { request_id: string; state: string; received_at: string; completed_at: string | null; deleted_count: number };
type PrivacyStatus = { healthy: boolean; last_cleanup_at: string | null; expired_records: number; pending_requests: number; receipts: Receipt[] };

export default function WhatsAppPrivacy() {
  const { lang } = useLanguage(); const zh = lang === "zh";
  const [data, setData] = useState<PrivacyStatus | null>(null);
  const [phone, setPhone] = useState(""); const [verified, setVerified] = useState(false);
  const [requestId, setRequestId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false); const [message, setMessage] = useState("");
  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/whatsapp/privacy", { cache: "no-store" });
      if (!response.ok) throw new Error("unavailable");
      setData(await response.json());
    } catch { setData(null); }
  }, []);
  useEffect(() => { const timer = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(timer); }, [load]);
  const date = (value: string | null) => value ? new Date(value).toLocaleString(zh ? "zh-CN" : "en-GB", { timeZone: "Asia/Dubai" }) : "—";
  const submit = async (event: React.FormEvent) => {
    event.preventDefault(); if (!verified || busy) return;
    const id = requestId ?? crypto.randomUUID(); setRequestId(id); setBusy(true); setMessage("");
    try {
      const response = await fetch("/api/whatsapp/privacy", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone, verified: true, request_id: id }) });
      const result = await response.json();
      if (!response.ok) {
        const knownError = result.error === "international_phone_required" || result.error === "invalid_request"
          ? (zh ? "请填写含 + 国家码的有效号码，并确认已核实客户请求。" : "Enter a valid number including + country code and confirm the verified request.")
          : response.status === 403 ? (zh ? "当前账号没有执行权限，请重新核对管理员登录状态。" : "This session cannot perform deletion. Check the administrator sign-in.")
          : response.status === 429 ? (zh ? "请求次数已达限制，请稍后重试。" : "Request limit reached. Try again later.") : null;
        setMessage(knownError ?? (zh ? `未确认删除完成。请刷新回执；重试会使用相同请求编号：${id}` : `Deletion is not confirmed. Refresh receipts; retry keeps the same request ID: ${id}`));
      } else {
        setMessage(result.state === "completed" ? (zh ? `已删除 ${result.deleted_count} 条试点记录。回执：${id}` : `${result.deleted_count} pilot records deleted. Receipt: ${id}`)
          : (zh ? `请求已登记，等待清理。回执：${id}` : `Request registered, awaiting cleanup. Receipt: ${id}`));
        setPhone(""); setVerified(false); setRequestId(null);
      }
      await load();
    } catch { setMessage(zh ? `网络中断，结果待核实。请刷新回执；重试编号：${id}` : `Connection interrupted; outcome unknown. Refresh receipts. Retry ID: ${id}`); }
    finally { setBusy(false); }
  };
  return <section className="rounded-xl border border-border p-4 space-y-3" aria-label={zh ? "WhatsApp 数据删除" : "WhatsApp data deletion"}>
    <div className="flex items-center justify-between gap-3"><h3 className="font-semibold">{zh ? "数据保留与客户删除" : "Retention and customer deletion"}</h3>
      <button type="button" onClick={load} className="text-sm underline">{zh ? "刷新回执" : "Refresh receipts"}</button></div>
    <p className="text-sm text-muted-foreground">{zh ? "试点事件按 30 天保留策略处理，从第 29 天开始定期清理。连续 15 分钟未清理成功时暂停新增采集并提醒管理员；已有记录需等待清理恢复。此处删除两个试点号码的关联记录，不会删除手机聊天或 CRM 合同、交易记录。" : "Pilot events follow a 30-day retention policy, with scheduled cleanup from day 29. After 15 minutes without successful cleanup, new collection pauses and an administrator is alerted; existing records await resumed cleanup. Deletion covers both pilot channels, excluding phone chats and CRM contracts and transactions."}</p>
    <p role="status" className={data?.healthy ? "text-sm" : "text-sm text-amber-600"}>{data ? (data.healthy ? (zh ? "自动清理正常" : "Cleanup healthy") : (zh ? "清理需要处理，采集暂不应开启" : "Cleanup needs attention; keep capture disabled")) : (zh ? "清理状态暂不可用" : "Cleanup status unavailable")}
      {data && ` · ${zh ? "最近清理" : "Last cleanup"}: ${date(data.last_cleanup_at)}`}</p>
    {data && (data.pending_requests > 0 || data.expired_records > 0) && <p className="text-sm text-amber-600">
      {zh ? `待处理删除请求：${data.pending_requests}；过期记录：${data.expired_records}` : `Pending deletion requests: ${data.pending_requests}; expired records: ${data.expired_records}`}
    </p>}
    <form onSubmit={submit} className="space-y-3">
      <label className="block text-sm">{zh ? "客户 WhatsApp 号码（含 + 国家码）" : "Customer WhatsApp number (include + country code)"}
        <input type="tel" autoComplete="off" required maxLength={32} disabled={busy} value={phone} placeholder="+971 …"
          onChange={e => { setPhone(e.target.value); setRequestId(null); setVerified(false); }} className="mt-1 block w-full rounded-lg border border-border bg-background p-2" /></label>
      <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={verified} disabled={busy} onChange={e => setVerified(e.target.checked)} />
        {zh ? "我已核实客户身份及删除请求，确认删除该客户在所有试点号码上的现有事件记录。删除不可撤销；之后的新咨询可继续产生记录。" : "I verified the customer's identity and request and confirm irreversible deletion of their existing events across all pilot channels. Later enquiries may create new records."}</label>
      <button type="submit" disabled={busy || !verified || !phone} className="rounded-lg border border-rose-500 px-3 py-2 text-sm text-rose-600 disabled:opacity-40">{busy ? (zh ? "处理中…" : "Processing…") : (zh ? "确认删除已核实客户的记录" : "Delete verified customer records")}</button>
    </form>
    {message && <p role="status" className="text-sm break-all">{message}</p>}
    {data && data.receipts.length > 0 && <div className="overflow-auto"><table className="w-full text-left text-xs"><thead><tr>
      {(zh ? ["请求编号", "状态", "删除条数", "完成时间（迪拜）"] : ["Request ID", "Status", "Deleted", "Completed (Dubai)"]).map(title => <th key={title} className="p-2">{title}</th>)}
      </tr></thead><tbody>{data.receipts.map(r => <tr key={r.request_id} className="border-t border-border"><td className="p-2 font-mono">{r.request_id}</td><td className="p-2">{r.state === "completed" ? (zh ? "已完成" : "Completed") : (zh ? "待处理" : "Pending")}</td><td className="p-2">{r.deleted_count}</td><td className="p-2 whitespace-nowrap">{date(r.completed_at)}</td></tr>)}</tbody></table></div>}
    <p className="text-xs text-muted-foreground">{zh ? "这里只显示不含手机号的回执。邮件或其他支持记录需另行处理；备份副本需按单独的保留和恢复流程处理。" : "Receipts exclude phone numbers. Correspondence and other support records need separate handling. Backup copies require separate retention and restore handling."}</p>
  </section>;
}
