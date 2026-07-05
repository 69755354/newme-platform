"use client";

// Bottom folding panels — 6 collapsible accordion blocks (one open at a time).
// Extracted verbatim from the old renderFoldingPanel() in page.tsx during the
// three-column refactor. State (openPanel, projectInfoDraft, projectInfoStatus)
// and the save/reset handlers stay owned by page.tsx and are passed down, so the
// batch-save Project Info form behaves exactly as before.

import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn, fmtDubai } from "@/lib/utils";
import { ChevronDown, RotateCcw } from "lucide-react";
import LeadContractsPanel from "./LeadContractsPanel";
import { fmtAED } from "./utils";
import type { Lead, RenderJsonEdit } from "./types";

// Project Info batch-save draft shape (mirrors the page.tsx useState).
export type ProjectInfoDraft = {
  project_type: string;
  emirate: string;
  area: string;
  ac_brand: string;
  customer_budget: string;
};

interface Props {
  lead: Lead;
  openPanel: string | null;
  onOpenPanelChange: (v: string | null) => void;
  projectInfoDraft: ProjectInfoDraft;
  onProjectInfoDraftChange: React.Dispatch<React.SetStateAction<ProjectInfoDraft>>;
  projectInfoStatus: "idle" | "saving" | "saved" | "error";
  onSaveProjectInfo: () => void;
  onResetProjectInfo: () => void;
  renderJsonEdit: RenderJsonEdit;
  t: (key: string) => string;
  lang: "en" | "zh";
}

export default function LeadFoldingPanel({
  lead,
  openPanel,
  onOpenPanelChange,
  projectInfoDraft,
  onProjectInfoDraftChange: setProjectInfoDraft,
  projectInfoStatus,
  onSaveProjectInfo,
  onResetProjectInfo,
  renderJsonEdit,
  t,
  lang,
}: Props) {
  const PANELS: { key: string; icon: string; title: string }[] = [
    { key: "project_info", icon: "📋", title: t("leadDetail.projectInfoTitle") },
    { key: "smart_req", icon: "🎯", title: t("leadDetail.smartReqTitle") },
    { key: "quotation", icon: "💰", title: t("leadDetail.quotationTitle") },
    { key: "drawings", icon: "📄", title: t("leadDetail.drawingsTitle") },
    { key: "contract", icon: "📎", title: t("leadDetail.contractTitle") },
    { key: "project_exec", icon: "🏗️", title: t("leadDetail.projectTitle") },
  ];

  return (
    <div className="space-y-2">
      {PANELS.map(({ key, icon, title }) => {
        const isOpen = openPanel === key;
        return (
          <Card key={key} className="bg-card border-border overflow-visible">
            <button
              type="button"
              onClick={() => onOpenPanelChange(isOpen ? null : key)}
              className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-muted/40 transition-colors"
            >
              <span className="flex items-center gap-2 text-sm font-medium text-foreground">
                <span className="text-base leading-none">{icon}</span>
                {title}
              </span>
              <ChevronDown className={cn("w-4 h-4 text-muted-foreground transition-transform", isOpen && "rotate-180")} />
            </button>
            {isOpen && (
              <CardContent className="pt-4 border-t border-border">
                {key === "project_info" && (
                  <div className="space-y-3">
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
                      <div>
                        <Label className="text-muted-foreground text-xs">{t("leadDetail.projectType")}</Label>
                        <Select
                          value={projectInfoDraft.project_type}
                          onValueChange={(v) => setProjectInfoDraft((d) => ({ ...d, project_type: v ?? "" }))}
                        >
                          <SelectTrigger className="h-8 text-xs mt-1">
                            <SelectValue placeholder="—" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="villa">{t("leadDetail.projectType_villa")}</SelectItem>
                            <SelectItem value="apartment">{t("leadDetail.projectType_apartment")}</SelectItem>
                            <SelectItem value="developer">{t("leadDetail.projectType_developer")}</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      <div>
                        <Label className="text-muted-foreground text-xs">{t("leadDetail.emirate")}</Label>
                        <Input
                          value={projectInfoDraft.emirate}
                          onChange={(e) => setProjectInfoDraft((d) => ({ ...d, emirate: e.target.value }))}
                          className="h-8 text-xs mt-1 bg-muted border-border"
                        />
                      </div>
                      <div>
                        <Label className="text-muted-foreground text-xs">{t("leadDetail.areaLocality")}</Label>
                        <Input
                          value={projectInfoDraft.area}
                          onChange={(e) => setProjectInfoDraft((d) => ({ ...d, area: e.target.value }))}
                          className="h-8 text-xs mt-1 bg-muted border-border"
                        />
                      </div>
                      <div>
                        <Label className="text-muted-foreground text-xs">{t("leadDetail.acBrand")}</Label>
                        <Input
                          value={projectInfoDraft.ac_brand}
                          onChange={(e) => setProjectInfoDraft((d) => ({ ...d, ac_brand: e.target.value }))}
                          className="h-8 text-xs mt-1 bg-muted border-border"
                        />
                      </div>
                      <div>
                        <Label className="text-muted-foreground text-xs">{t("leadDetail.customerBudget")}</Label>
                        <Input
                          type="number"
                          value={projectInfoDraft.customer_budget}
                          onChange={(e) => setProjectInfoDraft((d) => ({ ...d, customer_budget: e.target.value }))}
                          className="h-8 text-xs mt-1 bg-muted border-border"
                        />
                      </div>
                    </div>
                    <div className="flex items-center gap-2 pt-1">
                      <Button
                        size="sm"
                        onClick={onSaveProjectInfo}
                        disabled={projectInfoStatus === "saving"}
                        className="bg-copper-500 hover:bg-copper-600 text-black"
                      >
                        {projectInfoStatus === "saving" ? t("common.saving") : t("common.save")}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={onResetProjectInfo}
                        disabled={projectInfoStatus === "saving"}
                        className="border-border text-muted-foreground"
                      >
                        <RotateCcw className="w-3.5 h-3.5 mr-1" />
                        {t("leadDetail.undo")}
                      </Button>
                      {projectInfoStatus === "saved" && (
                        <span className="text-xs text-emerald-400">{t("leadDetail.saved")}</span>
                      )}
                      {projectInfoStatus === "error" && (
                        <span className="text-xs text-rose-400">{t("leadDetail.saveFailed")}</span>
                      )}
                    </div>
                  </div>
                )}
                {key === "smart_req" && (
                  <div className="text-sm">
                    <Label className="text-muted-foreground text-xs">{t("leadDetail.smartRequirements")}</Label>
                    {renderJsonEdit("smart_requirements", t("leadDetail.smartRequirements"))}
                  </div>
                )}
                {key === "quotation" && (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
                    <div>
                      <Label className="text-muted-foreground text-xs">{t("leadDetail.quotationValue")}</Label>
                      <p className="text-foreground mt-1">
                        {lead.quotation_value != null && lead.quotation_value > 0 ? fmtAED(lead.quotation_value) : "—"}
                      </p>
                    </div>
                    <div>
                      <Label className="text-muted-foreground text-xs">{t("leadDetail.quotationSent")}</Label>
                      <p className="text-foreground mt-1">
                        {lead.quotation_sent_date
                          ? fmtDubai(lead.quotation_sent_date, { locale: t("locale.dateLocale") })
                          : "—"}
                      </p>
                    </div>
                  </div>
                )}
                {key === "contract" && <LeadContractsPanel leadId={lead.id} />}
                {(key === "drawings" || key === "project_exec") && (
                  <div className="py-8 text-center text-sm text-muted-foreground">{t("leadDetail.comingSoon")}</div>
                )}
              </CardContent>
            )}
          </Card>
        );
      })}
    </div>
  );
}
