"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useLanguage } from "@/lib/i18n/LanguageContext";
import type { ReviewAction, ReviewResult } from "@/lib/whatsapp-review-tools.mjs";

type Readiness = { enabled: boolean; until: string | null; template_body: string };
type Result = Partial<ReviewResult> & { error?: string; meta_code?: number; result_uncertain?: boolean };

export default function WhatsAppReviewTools() {
  const { lang } = useLanguage(); const zh = lang === "zh";
  const [status, setStatus] = useState<Readiness | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [connectionChecked, setConnectionChecked] = useState(false);
  const [confirm, setConfirm] = useState<ReviewAction | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const pending = useRef(false);

  const load = useCallback(async () => {
    setLoadFailed(false);
    try {
      const response = await fetch("/api/whatsapp/review-tools", { cache: "no-store" });
      if (!response.ok) throw new Error("unavailable");
      setStatus(await response.json());
    } catch { setStatus(null); setLoadFailed(true); }
  }, []);
  useEffect(() => { const timer = window.setTimeout(() => { void load(); }, 0); return () => window.clearTimeout(timer); }, [load]);

  async function run(action: ReviewAction) {
    if (pending.current || !status?.enabled || uncertain) return;
    pending.current = true; setBusy(true); setResult(null); setConfirm(null);
    try {
      const response = await fetch("/api/whatsapp/review-tools", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, request_id: crypto.randomUUID() }),
      });
      const body: Result = await response.json();
      setResult(body);
      if (body.result_uncertain) setUncertain(true);
      if (response.ok && action === "check_connection") setConnectionChecked(true);
      if (!response.ok && action === "check_connection") setConnectionChecked(false);
    } catch {
      const unknown = action !== "check_connection";
      setResult({ error: unknown ? "result_unknown" : "connection_failed", result_uncertain: unknown });
      if (unknown) setUncertain(true);
    } finally { pending.current = false; setBusy(false); }
  }

  const labels = {
    check_connection: zh ? "检查测试连接" : "Check test connection",
    send_hello_world: zh ? "发送测试消息" : "Send test message",
    create_template: zh ? "创建审核模板" : "Create review template",
  };
  const errorText = (code?: string) => {
    if (code === "sandbox_binding_failed") return zh ? "无法确认测试号码归属，操作已停止。" : "The test-number binding could not be verified. Operation stopped.";
    if (code === "review_rate_limit" || code === "review_capacity_reached") return zh ? "已达到测试次数上限。" : "The test limit has been reached.";
    if (code === "review_tools_disabled") return zh ? "测试授权未启用或已到期。" : "Test authorisation is disabled or expired.";
    return zh ? "操作未确认成功，请根据下方结果核对。" : "The operation was not confirmed. Check the result below.";
  };
  return <section aria-label={zh ? "WhatsApp 审核测试" : "WhatsApp review test"} className="space-y-3 border-t border-border pt-5">
    <h3 className="text-base font-semibold">{zh ? "Meta 应用审核测试" : "Meta app review test"}</h3>
    <p className="text-sm text-muted-foreground">{zh
      ? "仅使用 Meta 分配的测试发送号码。测试消息只能发送至 Tanya 尾号 9388；不会连接或迁移员工正在使用的号码。"
      : "Uses only the Meta test sender. Test messages can go only to Tanya’s number ending 9388. This does not connect or migrate staff phone numbers."}</p>
    {loadFailed ? <p role="alert">{zh ? "无法读取测试状态。" : "Unable to load test status."}</p> : !status ? <p>{zh ? "读取中…" : "Loading…"}</p> : <>
      <p className="text-sm">{status.enabled
        ? (zh ? "测试已临时授权，到期时间：" : "Test access is temporarily enabled until: ") + new Date(status.until!).toLocaleString(zh ? "zh-CN" : "en-GB", { timeZone: "Asia/Dubai" })
        : zh ? "测试功能未启用。需管理员完成测试账户授权后才能操作。" : "Test tools are disabled. An administrator must authorise the test account first."}</p>
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={load} disabled={busy} className="border border-border rounded-lg px-3 py-2 text-sm">{zh ? "刷新状态" : "Refresh status"}</button>
        <button type="button" onClick={() => void run("check_connection")} disabled={!status.enabled || busy || uncertain} className="border border-border rounded-lg px-3 py-2 text-sm disabled:opacity-50">{labels.check_connection}</button>
        {(["send_hello_world", "create_template"] as const).map(action => <button key={action} type="button" onClick={() => setConfirm(action)} disabled={!status.enabled || !connectionChecked || busy || uncertain} className="border border-border rounded-lg px-3 py-2 text-sm disabled:opacity-50">{labels[action]}</button>)}
      </div>
      {confirm && <div role="group" aria-label={zh ? "确认测试操作" : "Confirm test operation"} className="rounded-lg border border-border p-4 space-y-3">
        <p>{confirm === "send_hello_world"
          ? zh ? "将从 Meta 测试号向 Tanya（尾号 9388）发送一条官方 hello_world 测试消息。" : "Send one official hello_world message from the Meta test sender to Tanya (ending 9388)."
          : zh ? "将在 Meta 测试账户创建一个新的英文 UTILITY 审核模板；这一步不会发送消息。" : "Create a new English UTILITY template in the Meta test account. This does not send a message."}</p>
        {confirm === "create_template" && <blockquote className="text-sm text-muted-foreground">{status.template_body}</blockquote>}
        <button type="button" onClick={() => void run(confirm)} disabled={busy} className="border border-border rounded-lg px-3 py-2 text-sm">{zh ? "确认执行" : "Confirm operation"}</button>
        <button type="button" onClick={() => setConfirm(null)} className="ml-2 text-sm underline">{zh ? "取消" : "Cancel"}</button>
      </div>}
    </>}
    {busy && <p role="status">{zh ? "处理中，请勿重复操作…" : "Working. Do not repeat the operation…"}</p>}
    {result && <div role="status" className="rounded-lg border border-border p-3 text-sm space-y-1">
      <p>{result.ok ? result.action === "check_connection" ? (zh ? "测试号码归属与连接验证通过。" : "Test-number binding and connection verified.")
        : result.action === "send_hello_world" ? (zh ? "Meta 已接受发送请求，尚需在收件手机确认送达。" : "Meta accepted the send request. Receipt on the phone still needs confirmation.")
        : (zh ? "Meta 已创建模板；是否批准以其状态为准。" : "Meta created the template. Its approval is determined by Meta.") : errorText(result.error)}</p>
      {result.message_id && <p className="break-all">{zh ? "消息编号：" : "Message ID: "}{result.message_id}</p>}
      {result.template_name && <p className="break-all">{zh ? "模板名称：" : "Template name: "}{result.template_name}</p>}
      {result.template_status && <p>{zh ? "模板状态：" : "Template status: "}{result.template_status}</p>}
      {result.meta_code !== undefined && <p>{zh ? "Meta 错误编号：" : "Meta error code: "}{result.meta_code}</p>}
    </div>}
    {uncertain && <p role="alert" className="text-sm text-amber-600">{zh
      ? "结果不明，已停止再次执行。请先核对 Meta 和收件手机；刷新页面或重启服务不能保证撤销之前的请求。"
      : "The result is uncertain; further operations are stopped. Check Meta and the recipient phone first. Reloading or restarting does not cancel an earlier request."}</p>}
  </section>;
}
