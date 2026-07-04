"use client"

import { useLanguage } from "@/lib/i18n/LanguageContext"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Inbox, ListTodo, Clock, AlertTriangle, BarChart3, User } from "lucide-react"
import Link from "next/link"
import { useEffect, useState } from "react"
import { DashboardScrollContainer } from "@/components/DashboardScrollContainer";

interface InboxItem {
  id: string
  customer_name: string
  phone?: string
  current_milestone?: string
  next_followup_date?: string
  next_action?: string
  updated_at?: string
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
}

const milestoneColors: Record<string, string> = {
  new: "bg-blue-500",
  contacted: "bg-cyan-500",
  qualified: "bg-violet-500",
  proposal: "bg-amber-500",
  negotiation: "bg-orange-500",
  won: "bg-emerald-500",
  lost: "bg-rose-500",
}

import { fmtDubai } from "@/lib/utils";

function formatDate(value?: string) {
  if (!value) return "—"
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return value
  return fmtDubai(d, {
    locale: "en-US",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })
}

export default function WorkbenchPage() {
  const { t } = useLanguage()
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
        setError(err instanceof Error ? err.message : "Unknown error")
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
  const tasks = data?.tasks ?? []
  const overdue = data?.overdue ?? []
  const alerts = data?.alerts ?? []
  const progress = data?.progress ?? []

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

      {/* Card grid */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-5">
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
                          {item.current_milestone && (
                            <span
                              className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium capitalize text-white ${
                                milestoneColors[item.current_milestone] ||
                                "bg-slate-400"
                              }`}
                            >
                              {item.current_milestone}
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
                              {formatDate(item.next_followup_date)}
                            </span>
                          )}
                        </div>
                        {item.next_action && (
                          <span className="line-clamp-1 text-xs text-slate-600">
                            {item.next_action}
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
                        <span className="line-clamp-1 text-sm font-medium">
                          {task.title}
                        </span>
                        {task.source && (
                          <Badge variant="secondary" className="shrink-0 text-[10px]">
                            {task.source}
                          </Badge>
                        )}
                      </div>
                      {task.lead_name && (
                        <span className="line-clamp-1 text-xs text-slate-500">
                          {task.lead_name}
                        </span>
                      )}
                      <span className="flex items-center gap-1 text-xs text-muted-foreground">
                        <Clock className="h-3 w-3" />
                        {formatDate(task.due_at)}
                      </span>
                    </>
                  )
                  return (
                    <li key={task.id}>
                      {href ? (
                        <Link prefetch={false}
                          href={href}
                          className="flex flex-col gap-1 rounded-md px-2 py-2 transition hover:bg-slate-100"
                        >
                          {inner}
                        </Link>
                      ) : (
                        <div className="flex flex-col gap-1 rounded-md px-2 py-2 hover:bg-slate-50">
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

        {/* Overdue */}
        <Card className="flex flex-col border-red-300">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
            <CardTitle className="text-sm font-medium text-red-700">
              {t("workbench.overdue") || "Overdue"}
            </CardTitle>
            <AlertTriangle className="h-4 w-4 text-red-600" />
          </CardHeader>
          <CardContent className="flex-1">
            {overdue.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">
                {t("workbench.empty.overdue") || "Nothing overdue"}
              </p>
            ) : (
              <ul className="-mx-2 max-h-[320px] space-y-1 overflow-y-auto">
                {overdue.map((task) => {
                  const href = task.lead_id ? `/leads/${task.lead_id}` : null
                  const inner = (
                    <>
                      <span className="line-clamp-1 text-sm font-medium text-red-800">
                        {task.title}
                      </span>
                      {task.lead_name && (
                        <span className="line-clamp-1 text-xs text-red-500/80">
                          {task.lead_name}
                        </span>
                      )}
                      <span className="flex items-center gap-1 text-xs text-red-600">
                        <Clock className="h-3 w-3" />
                        {formatDate(task.due_at)}
                      </span>
                    </>
                  )
                  return (
                    <li key={task.id}>
                      {href ? (
                        <Link prefetch={false}
                          href={href}
                          className="flex flex-col gap-1 rounded-md border border-red-200 bg-red-50/60 px-2 py-2 transition hover:bg-red-100/70"
                        >
                          {inner}
                        </Link>
                      ) : (
                        <div className="flex flex-col gap-1 rounded-md border border-red-200 bg-red-50/60 px-2 py-2">
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
                        <span className="flex items-center gap-1.5 font-medium capitalize">
                          <span className={`inline-block h-2 w-2 rounded-full ${color}`} />
                          {g.current_milestone}
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

        {/* Follow-up Alerts */}
        <Card className="flex flex-col border-amber-300">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
            <CardTitle className="text-sm font-medium text-amber-700">
              Follow-up Alerts
            </CardTitle>
            <AlertTriangle className="h-4 w-4 text-amber-600" />
          </CardHeader>
          <CardContent className="flex-1">
            {alerts.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">
                No alerts
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
                              <Badge className="bg-amber-500 text-[10px] text-white">
                                {a.days_overdue}d
                              </Badge>
                            )}
                            {a.no_answer_flag && (
                              <Badge className="bg-red-500 text-[10px] text-white">
                                No answer
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
        <Link prefetch={false} href="/leads/new">
          <Button>
            <User className="mr-2 h-4 w-4" />
            New Lead
          </Button>
        </Link>
        <Link prefetch={false} href="/leads">
          <Button variant="outline">
            All Leads
          </Button>
        </Link>
      </div>

      {/* Feedback banner */}
      <Card className="border-slate-200 bg-slate-50/60">
        <CardContent className="flex flex-col items-start gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs text-slate-500">
            遇到问题请截图发给 Tanya 或 Ayana
          </p>
          <a
            href="https://t.me/+YOUR_INVITE"
            target="_blank"
            rel="noopener noreferrer"
          >
            <Button variant="outline" size="sm" className="h-7 text-xs">
              Report Issue
            </Button>
          </a>
        </CardContent>
      </Card>
    </DashboardScrollContainer>
  )
}