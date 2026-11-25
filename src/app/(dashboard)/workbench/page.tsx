"use client"

import { translatedOrRaw } from "@/lib/chart-labels.mjs";
import { useLanguage } from "@/lib/i18n/LanguageContext"
import { localizeServerText } from "@/lib/i18n/server-text.mjs"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Inbox, ListTodo, Clock, AlertTriangle, BarChart3, User, Phone, MessageCircle, Plus } from "lucide-react"
import Link from "next/link"
import { useEffect, useState } from "react"
import { DashboardScrollContainer } from "@/components/DashboardScrollContainer";
import { mergeTasksWithOverdue, todayThreeThings } from "@/lib/workbench-today.mjs";
import { telHref, whatsappHref } from "@/lib/lead-contact.mjs";

interface InboxItem {
  id: string
  customer_name: string
  phone?: string
  current_milestone?: string
  next_followup_date?: string
  next_action?: string
  updated_at?: string
  /** S35: new (never contacted) -> due_today -> overdue -> later; "later" has no tag. */
  inbox_group?: "new" | "due_today" | "overdue" | "later"
}

interface TaskItem {
  id: string
  title: string
  due_at: string
  source?: string
  lead_id?: string
  lead_name?: string | null
}

interface AlertItem {
  id: string
  customer_name: string
  phone?: string
  next_followup_date?: string
  no_answer_flag: boolean
  days_overdue: number | null
}

interface TomorrowTaskItem {
  id: string
  title: string
  lead_id?: string | null
  lead_name?: string | null
  due_at?: string | null
}

interface MyWeeklyStats {
  contacted_leads: number
  quality_judged: number
  pending_quality: number
  stage_advanced: number
  period_start: string
  period_end: string
  label: string
}

interface ProgressGroup {
  current_milestone: string
  count: number
  percentage: number
}

interface WorkbenchData {
  inbox: InboxItem[]
  tasks: TaskItem[]
  overdue: TaskItem[]
  alerts: AlertItem[]
  progress: ProgressGroup[]
  tomorrowTasks?: TomorrowTaskItem[]
  myWeeklyStats?: MyWeeklyStats
}

const milestoneColors: Record<string, string> = {
  new: "bg-slate-400",
  contacted: "bg-slate-500",
  qualified: "bg-slate-500",
  proposal: "bg-slate-600",
  negotiation: "bg-slate-600",
  won: "bg-emerald-600",
  lost: "bg-stone-400",
}

import { fmtDubai } from "@/lib/utils";
import { formatShortDate, isDateOnly } from "@/lib/display-format.mjs";
import { onFetchFailure } from "@/lib/fetch-interruption"

function formatDate(value: string | undefined, locale: string) {
  if (!value) return "—"
  // A date-only value (DATE column) is a calendar day: no clock time, no time-zone shift.
  if (isDateOnly(value)) return formatShortDate(value, locale.toLowerCase().startsWith("zh") ? "zh" : "en")
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return value
  return fmtDubai(d, {
    locale, month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })
}

function MetricBox({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border bg-slate-50/50 p-3">
      <div className="text-2xl font-semibold">{value}</div>
      <div className="mt-1 text-xs text-muted-foreground">{label}</div>
    </div>
  )
}

export default function WorkbenchPage() {
  const { lang, t } = useLanguage()
  // S6 (review 4d section 4): task sources are raw enum values (new, meeting,
  // basic_info…); show a translated label, or the raw value if unknown.
  const taskSourceLabel = (source: string) => {
    const key = `workbench.taskSource.${source}`
    const label = t(key)
    return label === key ? source : label
  }
  // S41 (N4, from S42): milestone keys (basic_info, first_contact…) are shown through the lead-detail milestone labels,
  // then the stages dictionary, and only then as the raw key.
  const milestoneLabel = (key: string) =>
    translatedOrRaw(t, `leadDetail.milestone_${key}`, translatedOrRaw(t, `stages.${key}`, key))
  const [data, setData] = useState<WorkbenchData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const fetchData = async () => {
      try {
        setLoading(true)
        setError(null)
        const res = await fetch("/api/workbench", { cache: "no-store" })
        if (!res.ok) throw new Error(`Failed to load workbench (${res.status})`)
        const json = (await res.json()) as WorkbenchData
        setData(json)
      } catch (err: unknown) {
        onFetchFailure(err, () => setError(err instanceof Error ? err.message : "Unknown error"))
      } finally {
        setLoading(false)
      }
    }
    fetchData()
  }, [])

  if (loading) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-slate-300 border-t-slate-700" />
      </div>
    )
  }

  if (error) {
    return (
      <DashboardScrollContainer className="mx-auto max-w-2xl p-6">
        <Card className="border-red-200 bg-red-50">
          <CardContent className="flex items-center gap-3 py-6 text-red-700">
            <AlertTriangle className="h-5 w-5 shrink-0" />
            <span className="font-medium">{error}</span>
          </CardContent>
        </Card>
      </DashboardScrollContainer>
    )
  }

  const inbox = data?.inbox ?? []
  const rawTasks = data?.tasks ?? []
  const overdue = data?.overdue ?? []
  const alerts = data?.alerts ?? []
  const progress = data?.progress ?? []
  // S41 (F04): one task list (overdue first, red) and the three numbers that matter today.
  const tasks = mergeTasksWithOverdue(rawTasks, overdue)
  const today = todayThreeThings({ inbox, tasks: rawTasks, overdue })
  const dateLocale = t("locale.dateLocale")
  const contactLinks = (phone: string | null | undefined) => {
    const wa = whatsappHref(phone)
    const tel = telHref(phone)
    if (!wa && !tel) return null
    return (
      <span className="flex shrink-0 items-center gap-1">
        {tel && (
          <a href={tel} aria-label={t("s39.actions.call")} className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-border bg-background text-copper-700 hover:bg-copper-500/10">
            <Phone className="h-4 w-4" />
          </a>
        )}
        {wa && (
          <a href={wa} target="_blank" rel="noopener noreferrer" aria-label="WhatsApp" className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-border bg-background text-emerald-700 hover:bg-emerald-500/10">
            <MessageCircle className="h-4 w-4" />
          </a>
        )}
      </span>
    )
  }

  return (
    <DashboardScrollContainer className="mx-auto max-w-7xl space-y-6 p-6">
      {/* Header */}
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">
          {t("workbench.title") || "Sales Workbench"}
        </h1>
        <p className="text-sm text-muted-foreground">
          {t("workbench.subtitle") || "Your daily pipeline at a glance"}
        </p>
      </div>

      {/* S41 (F04): today's 3 things — new leads not contacted, tasks due today, the longest overdue — each actionable. */}
      <section data-testid="today-three" aria-label={t("s41.workbench.today")} className="rounded-xl border border-copper-500/30 bg-copper-500/5 p-3">
        <h2 className="mb-2 text-sm font-semibold text-copper-700">{t("s41.workbench.today")}</h2>
        <ol className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          <li className="rounded-lg border bg-card p-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs text-muted-foreground">{t("s41.workbench.newUncontacted")}</span>
              <span data-testid="today-new-count" className="text-xl font-semibold">{today.uncontactedNew.count}</span>
            </div>
            {today.uncontactedNew.items.slice(0, 2).map((lead) => (
              <div key={lead.id} className="mt-2 flex items-center justify-between gap-2">
                <Link prefetch={false} href={`/leads/${lead.id}`} className="truncate text-sm font-medium hover:underline">{lead.customer_name}</Link>
                {contactLinks(lead.phone)}
              </div>
            ))}
          </li>
          <li className="rounded-lg border bg-card p-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs text-muted-foreground">{t("s41.workbench.dueToday")}</span>
              <span data-testid="today-due-count" className="text-xl font-semibold">{today.dueToday.count}</span>
            </div>
            {today.dueToday.items.slice(0, 2).map((task) => (
              <div key={task.id} className="mt-2 flex items-center justify-between gap-2">
                {task.lead_id ? (
                  <Link prefetch={false} href={`/leads/${task.lead_id}`} className="truncate text-sm font-medium hover:underline">{task.lead_name || localizeServerText(task.title, lang)}</Link>
                ) : (
                  <span className="truncate text-sm font-medium">{localizeServerText(task.title, lang)}</span>
                )}
                {contactLinks(inbox.find((row) => row.id === task.lead_id)?.phone)}
              </div>
            ))}
          </li>
          <li className="rounded-lg border bg-card p-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs text-muted-foreground">{t("s41.workbench.longestOverdue")}</span>
              {today.longestOverdue && (
                <span className="rounded bg-red-100 px-1.5 py-0.5 text-xs font-medium text-red-800">
                  {formatDate(today.longestOverdue.due_at, dateLocale)}
                </span>
              )}
            </div>
            {today.longestOverdue ? (
              <div className="mt-2 flex items-center justify-between gap-2">
                {today.longestOverdue.lead_id ? (
                  <Link prefetch={false} href={`/leads/${today.longestOverdue.lead_id}`} className="truncate text-sm font-medium hover:underline">
                    {today.longestOverdue.customer_name || localizeServerText(today.longestOverdue.title, lang)}
                  </Link>
                ) : (
                  <span className="truncate text-sm font-medium">{localizeServerText(today.longestOverdue.title, lang)}</span>
                )}
                {contactLinks(today.longestOverdue.phone)}
              </div>
            ) : (
              <p className="mt-2 text-sm text-muted-foreground">{t("s41.workbench.none")}</p>
            )}
          </li>
        </ol>
      </section>

      {/* Card grid */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
        {/* Tomorrow's Tasks (明日预告) */}
        <Card className="flex flex-col border-emerald-200">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
            <CardTitle className="text-sm font-medium text-emerald-700">
              {t("workbench.tomorrow") || "明日预告 (Tomorrow's Tasks)"}
            </CardTitle>
            <Clock className="h-4 w-4 text-emerald-600" />
          </CardHeader>
          <CardContent className="flex-1">
            {(data?.tomorrowTasks ?? []).length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">
                {t("workbench.empty.tomorrow") || "暂无明日任务"}
              </p>
            ) : (
              <ul className="-mx-2 max-h-[320px] space-y-0.5 overflow-y-auto">
                {(data?.tomorrowTasks ?? []).slice(0, 5).map((task) => {
                  const href = task.lead_id ? `/leads/${task.lead_id}` : null
                  const inner = (
                    <>
                      <div className="flex items-center justify-between gap-2">
                        <span className="line-clamp-1 text-sm font-medium">
                          {localizeServerText(task.title, lang)}
                        </span>
                      </div>
                      {task.lead_name && (
                        <span className="line-clamp-1 text-xs text-slate-500">
                          {task.lead_name}
                        </span>
                      )}
                      {task.due_at && (
                        <span className="flex items-center gap-1 text-xs text-muted-foreground">
                          <Clock className="h-3 w-3" />
                          {formatDate(task.due_at, t("locale.dateLocale"))}
                        </span>
                      )}
                    </>
                  )
                  return (
                    <li key={task.id}>
                      {href ? (
                        <Link
                          prefetch={false}
                          href={href}
                          className="flex flex-col gap-1 rounded-md px-2 py-2 transition hover:bg-emerald-50"
                        >
                          {inner}
                        </Link>
                      ) : (
                        <div className="flex flex-col gap-1 rounded-md px-2 py-2 hover:bg-emerald-50/60">
                          {inner}
                        </div>
                      )}
                    </li>
                  )
                })}
              </ul>
            )}
          </CardContent>
        </Card>

        {/* Inbox */}
        <Card className="flex flex-col">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
            <CardTitle className="text-sm font-medium">
              {t("workbench.inbox") || "Inbox"}
            </CardTitle>
            <Inbox className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent className="flex-1">
            {inbox.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">
                {t("workbench.empty.inbox") || "All caught up"}
              </p>
            ) : (
              <ul className="-mx-2 max-h-[320px] space-y-0.5 overflow-y-auto">
                {inbox.map((item) => {
                  const overdue =
                    !!item.next_followup_date &&
                    new Date(item.next_followup_date).getTime() < Date.now()
                  return (
                    <li key={item.id}>
                      <Link prefetch={false}
                        href={`/leads/${item.id}`}
                        className="flex flex-col gap-1 rounded-md px-2 py-2 transition hover:bg-slate-100"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="truncate text-sm font-medium">
                            {item.customer_name}
                          </span>
                          {item.inbox_group && item.inbox_group !== "later" && (
                            <span
                              data-testid={`inbox-group-${item.inbox_group}`}
                              className={`shrink-0 rounded px-1.5 py-0.5 text-xs font-medium ${
                                item.inbox_group === "overdue"
                                  ? "bg-red-100 text-red-800"
                                  : item.inbox_group === "new"
                                    ? "bg-slate-100 text-slate-700"
                                    : "bg-slate-100 text-slate-700"
                              }`}
                            >
                              {t(`workbench.group.${item.inbox_group}`)}
                            </span>
                          )}
                          {item.current_milestone && (
                            <span
                              className={`shrink-0 rounded px-1.5 py-0.5 text-xs font-medium text-white ${
                                milestoneColors[item.current_milestone] ||
                                "bg-slate-400"
                              }`}
                            >
                              {milestoneLabel(item.current_milestone)}
                            </span>
                          )}
                        </div>
                        <div className="flex items-center justify-between gap-2">
                          {item.phone && (
                            <span className="text-xs text-muted-foreground">
                              {item.phone}
                            </span>
                          )}
                          {item.next_followup_date && (
                            <span
                              className={`flex items-center gap-1 text-xs ${
                                overdue
                                  ? "font-medium text-red-600"
                                  : "text-muted-foreground"
                              }`}
                            >
                              <Clock className="h-3 w-3" />
                              {formatDate(item.next_followup_date, t("locale.dateLocale"))}
                            </span>
                          )}
                        </div>
                        {item.next_action && (
                          <span className="line-clamp-1 text-xs text-slate-600">
                            {translatedOrRaw(t, `leads.nextActionLabels.${item.next_action}`, localizeServerText(item.next_action, lang))}
                          </span>
                        )}
                      </Link>
                    </li>
                  )
                })}
              </ul>
            )}
          </CardContent>
        </Card>

        {/* Tasks */}
        <Card className="flex flex-col">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
            <CardTitle className="text-sm font-medium">
              {t("workbench.tasks") || "Tasks"}
            </CardTitle>
            <ListTodo className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent className="flex-1">
            {tasks.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">
                {t("workbench.empty.tasks") || "No pending tasks"}
              </p>
            ) : (
              <ul className="-mx-2 max-h-[320px] space-y-0.5 overflow-y-auto">
                {tasks.map((task) => {
                  const href = task.lead_id ? `/leads/${task.lead_id}` : null
                  const inner = (
                    <>
                      <div className="flex items-center justify-between gap-2">
                        <span className={`line-clamp-1 text-sm font-medium ${task.overdue ? "text-red-800" : ""}`}>
                          {localizeServerText(task.title, lang)}
                        </span>
                        <span className="flex shrink-0 items-center gap-1">
                          {task.overdue && (
                            <Badge data-testid="task-overdue-tag" className="bg-red-100 text-xs text-red-800">
                              {t("s41.workbench.overdueTag")}
                            </Badge>
                          )}
                          {task.source && (
                            <Badge variant="secondary" className="shrink-0 text-xs">
                              {taskSourceLabel(task.source)}
                            </Badge>
                          )}
                        </span>
                      </div>
                      {task.lead_name && (
                        <span className="line-clamp-1 text-xs text-slate-500">
                          {task.lead_name}
                        </span>
                      )}
                      <span className={`flex items-center gap-1 text-xs ${task.overdue ? "font-medium text-red-600" : "text-muted-foreground"}`}>
                        <Clock className="h-3 w-3" />
                        {formatDate(task.due_at, t("locale.dateLocale"))}
                      </span>
                    </>
                  )
                  const rowClass = task.overdue
                    ? "flex flex-col gap-1 rounded-md border border-red-200 bg-red-50/60 px-2 py-2 transition hover:bg-red-100/70"
                    : "flex flex-col gap-1 rounded-md px-2 py-2 transition hover:bg-slate-100"
                  return (
                    <li key={task.id}>
                      {href ? (
                        <Link prefetch={false} href={href} className={rowClass}>
                          {inner}
                        </Link>
                      ) : (
                        <div className={rowClass}>
                          {inner}
                        </div>
                      )}
                    </li>
                  )
                })}
              </ul>
            )}
          </CardContent>
        </Card>

        {/* Progress */}
        <Card className="flex flex-col">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
            <CardTitle className="text-sm font-medium">
              {t("workbench.progress") || "Progress"}
            </CardTitle>
            <BarChart3 className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent className="flex-1">
            {progress.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">
                {t("workbench.empty.progress") || "No leads"}
              </p>
            ) : (
              <ul className="max-h-[320px] space-y-3 overflow-y-auto">
                {progress.map((g) => {
                  const color = milestoneColors[g.current_milestone] || "bg-slate-400"
                  const width = Math.min(Math.max(g.percentage ?? 0, 0), 100)
                  return (
                    <li key={g.current_milestone} className="space-y-1.5">
                      <div className="flex items-center justify-between text-xs">
                        <span className="flex items-center gap-1.5 font-medium">
                          <span className={`inline-block h-2 w-2 rounded-full ${color}`} />
                          {milestoneLabel(g.current_milestone)}
                        </span>
                        <span className="text-muted-foreground">
                          {g.count} · {width}%
                        </span>
                      </div>
                      <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
                        <div
                          className={`h-full rounded-full ${color}`}
                          style={{ width: `${width}%` }}
                        />
                      </div>
                    </li>
                  )
                })}
              </ul>
            )}
          </CardContent>
        </Card>

        {/* This Week Performance (本周我的表现) — collapsible, default collapsed */}
        <details className="col-span-full rounded-lg border bg-card text-card-foreground shadow-sm">
          <summary className="flex cursor-pointer items-center justify-between px-6 py-4 text-sm font-medium [&::-webkit-details-marker]:hidden">
            <span>
              {t("workbench.weeklyStats") || "本周我的表现 (This Week)"}
            </span>
            <span className="text-xs text-muted-foreground">
              {formatDate(data?.myWeeklyStats?.period_start, t("locale.dateLocale"))} – {formatDate(data?.myWeeklyStats?.period_end, t("locale.dateLocale"))}
            </span>
          </summary>
          <div className="grid grid-cols-2 gap-4 px-6 pb-5 pt-1 sm:grid-cols-4">
            <MetricBox
              label={t("workbench.week.contacted") || "Contacted Leads"}
              value={data?.myWeeklyStats?.contacted_leads ?? 0}
            />
            <MetricBox
              label={t("workbench.week.qualityJudged") || "Quality Judged"}
              value={data?.myWeeklyStats?.quality_judged ?? 0}
            />
            <MetricBox
              label={t("workbench.week.pendingQuality") || "Pending Quality"}
              value={data?.myWeeklyStats?.pending_quality ?? 0}
            />
            <MetricBox
              label={t("workbench.week.stageAdvanced") || "Stage Advanced"}
              value={data?.myWeeklyStats?.stage_advanced ?? 0}
            />
          </div>
        </details>

        {/* Follow-up Alerts */}
        <Card className="flex flex-col border-amber-300">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
            <CardTitle className="text-sm font-medium text-amber-700">
              {t("workbench.followupAlerts")}
            </CardTitle>
            <AlertTriangle className="h-4 w-4 text-amber-600" />
          </CardHeader>
          <CardContent className="flex-1">
            {alerts.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">
                {t("workbench.noAlerts")}
              </p>
            ) : (
              <ul className="-mx-2 max-h-[320px] space-y-1 overflow-y-auto">
                {alerts.map((a) => {
                  const isOverdue = (a.days_overdue ?? 0) > 0
                  // red = no-answer (stuck), amber = overdue follow-up
                  const tone = a.no_answer_flag ? "red" : "amber"
                  return (
                    <li key={a.id}>
                      <Link prefetch={false}
                        href={`/leads/${a.id}`}
                        className={`flex flex-col gap-1 rounded-md border px-2 py-2 transition hover:opacity-80 ${
                          tone === "red"
                            ? "border-red-200 bg-red-50/60"
                            : "border-amber-200 bg-amber-50/60"
                        }`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span
                            className={`truncate text-sm font-medium ${
                              tone === "red" ? "text-red-800" : "text-amber-800"
                            }`}
                          >
                            {a.customer_name}
                          </span>
                          <span className="flex shrink-0 items-center gap-1">
                            {isOverdue && (
                              <Badge className="bg-amber-100 text-xs text-amber-800">
                                {t("analytics.daysShort").replace("{n}", String(a.days_overdue))}
                              </Badge>
                            )}
                            {a.no_answer_flag && (
                              <Badge className="bg-red-100 text-xs text-red-800">
                                {t("workbench.noAnswer")}
                              </Badge>
                            )}
                          </span>
                        </div>
                        {a.phone && (
                          <span className="text-xs text-muted-foreground">
                            {a.phone}
                          </span>
                        )}
                      </Link>
                    </li>
                  )
                })}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Quick actions */}
      <div className="flex flex-wrap items-center gap-2 pt-2">
        <Link prefetch={false} href="/leads">
          <Button variant="outline">
            <User className="mr-2 h-4 w-4" />
            {t("workbench.allLeads")}
          </Button>
        </Link>
      </div>

      {/* S41 (F04): New Lead floats bottom-right so it is on the first phone screen whatever the page height. */}
      <Link
        prefetch={false}
        href="/leads/new"
        data-testid="workbench-new-lead-fab"
        aria-label={t("workbench.newLead")}
        className="fixed bottom-5 right-5 z-30 inline-flex min-h-12 items-center gap-2 rounded-full bg-copper-500 px-4 text-sm font-semibold text-foreground shadow-lg hover:bg-copper-600"
      >
        <Plus className="h-5 w-5" />
        {t("workbench.newLead")}
      </Link>

      {/* Feedback banner */}
      <Card className="border-slate-200 bg-slate-50/60">
        <CardContent className="flex flex-col items-start gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs text-slate-500">
            {lang === "zh"
              ? "遇到问题请截图发给 Tanya 或 Ayana"
              : "If you encounter issues, screenshot and send to Tanya or Ayana"}
          </p>
          <a
            href="https://t.me/+YOUR_INVITE"
            target="_blank"
            rel="noopener noreferrer"
          >
            <Button variant="outline" size="sm" className="h-7 text-xs">
              {t("workbench.reportIssue")}
            </Button>
          </a>
        </CardContent>
      </Card>
    </DashboardScrollContainer>
  )
}
