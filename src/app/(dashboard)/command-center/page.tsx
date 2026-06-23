"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useLanguage } from "@/lib/i18n/LanguageContext";
import { AlertTriangle, Target, Users, Clock, CalendarCheck } from "lucide-react";

interface SalesPerson {
  name: string;
  fullName: string;
  progress: number;
  level: string;
}

interface AttentionLead {
  leadId: string;
  customerName: string;
  projectType: string;
  budget: number;
  reason: string;
}

interface CommandCenterData {
  monthTarget: number;
  monthCompleted: number;
  monthProgress: number;
  salesTeam: SalesPerson[];
  overdueFollowUps: number;
  todayFollowUps: number;
  needsAttention: AttentionLead[];
}

export default function CommandCenterPage() {
  const { t } = useLanguage();
  const [data, setData] = useState<CommandCenterData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    fetch("/api/command-center")
      .then((r) => r.json())
      .then((d) => { setData(d); setLoading(false); })
      .catch((e) => { setError(e.message); setLoading(false); });
  }, []);

  if (loading) return (
    <div className="min-h-screen bg-black flex items-center justify-center">
      <p className="text-gray-400">{t("common.loading")}</p>
    </div>
  );

  if (error) return (
    <div className="min-h-screen bg-black flex items-center justify-center">
      <p className="text-red-400">{error}</p>
    </div>
  );

  if (!data) return null;

  return (
    <div className="min-h-screen bg-black p-6">
      <h1 className="text-2xl font-bold text-white mb-6">{t("commandCenter.title")}</h1>

      {/* KPI Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <Card className="bg-gray-950 border-gray-800">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-gray-400 flex items-center gap-2">
              <Target className="w-4 h-4 text-gold-500" />
              {t("commandCenter.monthTarget")}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-bold text-white">{data.monthTarget}</p>
          </CardContent>
        </Card>

        <Card className="bg-gray-950 border-gray-800">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-gray-400 flex items-center gap-2">
              <Users className="w-4 h-4 text-green-500" />
              {t("commandCenter.monthCompleted")}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-bold text-white">{data.monthCompleted}</p>
          </CardContent>
        </Card>

        <Card className="bg-gray-950 border-gray-800">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-gray-400 flex items-center gap-2">
              <CalendarCheck className="w-4 h-4 text-amber-500" />
              {t("commandCenter.todayFollowUps")}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-bold text-white">{data.todayFollowUps}</p>
          </CardContent>
        </Card>

        <Card className="bg-gray-950 border-gray-800">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-gray-400 flex items-center gap-2">
              <Clock className="w-4 h-4 text-blue-500" />
              {t("commandCenter.progress")}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-3">
              <p className="text-3xl font-bold text-white">{data.monthProgress}%</p>
              <div className="flex-1 h-2 bg-gray-800 rounded-full overflow-hidden">
                <div
                  className="h-full bg-gradient-to-r from-gold-500 to-gold-600 rounded-full transition-all"
                  style={{ width: `${Math.min(data.monthProgress, 100)}%` }}
                />
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Sales Team */}
      <Card className="bg-gray-950 border-gray-800 mb-8">
        <CardHeader>
          <CardTitle className="text-white">{t("commandCenter.salesTeam")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {data.salesTeam.map((person) => (
            <div key={person.name} className="flex items-center gap-4">
              <div className="w-10 h-10 rounded-full bg-gray-800 flex items-center justify-center text-white font-semibold">
                {person.fullName.charAt(0)}
              </div>
              <div className="flex-1">
                <div className="flex justify-between items-center mb-1">
                  <span className="text-white font-medium">{person.fullName}</span>
                  <span className="text-sm text-gray-400">{person.progress}%</span>
                </div>
                <div className="h-2 bg-gray-800 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-gradient-to-r from-gold-500 to-gold-600 rounded-full transition-all"
                    style={{ width: `${Math.min(person.progress, 100)}%` }}
                  />
                </div>
              </div>
              <span className="text-xs px-2 py-1 rounded bg-gray-800 text-gray-300">{person.level}</span>
            </div>
          ))}
        </CardContent>
      </Card>

      {/* Needs Attention */}
      <Card className="bg-gray-950 border-gray-800">
        <CardHeader>
          <CardTitle className="text-white flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-yellow-500" />
            {t("commandCenter.needsAttention")}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {data.needsAttention.length === 0 ? (
            <p className="text-gray-400 text-sm">{t("commandCenter.allClear")}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-gray-400 border-b border-gray-800">
                    <th className="text-left py-2 px-2">{t("commandCenter.customer")}</th>
                    <th className="text-left py-2 px-2">{t("commandCenter.reason")}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.needsAttention.map((lead) => (
                    <tr key={lead.leadId} className="border-b border-gray-800/50 hover:bg-gray-900/50">
                      <td className="py-2 px-2 text-white">{lead.customerName}</td>
                      <td className="py-2 px-2 text-gray-300">{lead.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
