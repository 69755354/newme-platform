"use client";

import { useState, useEffect } from "react";
import { createClient } from "@/lib/supabase";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
  CardFooter,
} from "@/components/ui/card";
import { toast } from "sonner";
import {
  ClipboardCheck, PenTool, FileText, Handshake, PackageCheck,
  Play, CheckCircle2, Clock, AlertTriangle, ChevronDown, ChevronUp,
  User, Phone, MapPin, Building, Ruler, Image, Wrench, Network,
  Lightbulb, Monitor, Lock, Video, Radio,
} from "lucide-react";

/* ─── Types ─── */
interface WorkflowStage {
  id: string;
  lead_id: string;
  stage_key: string;
  stage_order: number;
  weight: number;
  status: "pending" | "in_progress" | "completed" | "skipped";
  assigned_to: string | null;
  started_at: string | null;
  completed_at: string | null;
  deadline_at: string | null;
  notified_24h: boolean;
  notified_48h: boolean;
  notes: string | null;
}

interface StageFormData {
  [key: string]: any;
}

/* ─── Stage Config ─── */
const STAGE_CONFIG: Record<
  string,
  {
    label: string;
    goal: string;
    icon: any;
    color: string;
    completionColor: string;
    deadlineHours: number;
    weight: number;
  }
> = {
  basic_info: {
    label: "Basic Info",
    goal: "Get customer basic info",
    icon: User,
    color: "text-sky-400",
    completionColor: "bg-sky-500",
    deadlineHours: 24,
    weight: 20,
  },
  requirements: {
    label: "Requirements",
    goal: "Understand customer needs",
    icon: Ruler,
    color: "text-violet-400",
    completionColor: "bg-violet-500",
    deadlineHours: 48,
    weight: 30,
  },
  design_proposal: {
    label: "Design Proposal",
    goal: "Output design proposal to customer",
    icon: FileText,
    color: "text-amber-400",
    completionColor: "bg-amber-500",
    deadlineHours: 24,
    weight: 50,
  },
  contract: {
    label: "Contract",
    goal: "Sign contract",
    icon: Handshake,
    color: "text-blue-400",
    completionColor: "bg-blue-500",
    deadlineHours: 48,
    weight: 60,
  },
  decision: {
    label: "Decision",
    goal: "Customer decision",
    icon: PackageCheck,
    color: "text-emerald-400",
    completionColor: "bg-emerald-500",
    deadlineHours: 72,
    weight: 80,
  },
};

const STAGE_ORDER = [
  "basic_info",
  "requirements",
  "design_proposal",
  "contract",
  "decision",
];

/* ─── Helpers ─── */
function fmtTimeLeft(deadline: string | null): { text: string; urgent: boolean; expired: boolean } {
  if (!deadline) return { text: "—", urgent: false, expired: false };
  const diff = new Date(deadline).getTime() - Date.now();
  const hours = Math.ceil(diff / (1000 * 60 * 60));
  if (diff < 0) return { text: `${Math.abs(hours)}h ago`, urgent: true, expired: true };
  if (hours <= 4) return { text: `${hours}h left`, urgent: true, expired: false };
  if (hours <= 12) return { text: `${hours}h left`, urgent: false, expired: false };
  const days = Math.ceil(hours / 24);
  return { text: `${days}d left`, urgent: false, expired: false };
}

/* ─── Component ─── */
interface LeadWorkflowProps {
  leadId: string;
}

export default function LeadWorkflow({ leadId }: LeadWorkflowProps) {
  const supabase = createClient();
  const [stages, setStages] = useState<WorkflowStage[]>([]);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState<string | null>(null);
  const [expandedStage, setExpandedStage] = useState<string | null>(null);

  // Form data for each stage
  const [formData, setFormData] = useState<Record<string, StageFormData>>({});

  useEffect(() => {
    if (!leadId) return;
    supabase
      .from("lead_workflow_stages")
      .select("*")
      .eq("lead_id", leadId)
      .order("stage_order", { ascending: true })
      .then(({ data, error }) => {
        if (!error && data) setStages(data as WorkflowStage[]);
        setLoading(false);
      });
  }, [leadId]);

  const updateFormField = (stageKey: string, field: string, value: any) => {
    setFormData((prev) => ({
      ...prev,
      [stageKey]: { ...(prev[stageKey] || {}), [field]: value },
    }));
  };

  const handleStartStage = async (stageKey: string) => {
    setActing(stageKey);
    try {
      const res = await fetch("/api/workflow", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lead_id: leadId, stage_key: stageKey }),
      });
      const data = await res.json();
      if (data.status === "ok") {
        setStages((prev) =>
          prev.map((s) => (s.stage_key === stageKey ? { ...s, ...data.data } : s))
        );
        setExpandedStage(stageKey);
        toast.success(`Started: ${STAGE_CONFIG[stageKey]?.label}`);
      } else {
        toast.error(data.error || "Failed to start stage");
      }
    } catch {
      toast.error("Network error");
    } finally {
      setActing(null);
    }
  };

  const handleCompleteStage = async (stageKey: string) => {
    setActing(stageKey);
    try {
      const notes = formData[stageKey] ? JSON.stringify(formData[stageKey]) : null;
      const res = await fetch("/api/workflow", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lead_id: leadId, stage_key: stageKey, notes }),
      });
      const data = await res.json();
      if (data.status === "ok") {
        setStages((prev) =>
          prev.map((s) => (s.stage_key === stageKey ? { ...s, ...data.data } : s))
        );
        setExpandedStage(null);
        toast.success(`Completed: ${STAGE_CONFIG[stageKey]?.label}`);

        // Auto-expand next pending stage
        const nextIdx = STAGE_ORDER.indexOf(stageKey) + 1;
        if (nextIdx < STAGE_ORDER.length) {
          const nextKey = STAGE_ORDER[nextIdx];
          // Only auto-expand if it exists in our stages
          setStages((prev) => {
            const nextStage = prev.find((s) => s.stage_key === nextKey);
            if (nextStage && nextStage.status === "pending") {
              setExpandedStage(nextKey);
            }
            return prev;
          });
        }
      } else {
        toast.error(data.error || "Failed to complete stage");
      }
    } catch {
      toast.error("Network error");
    } finally {
      setActing(null);
    }
  };

  /* ─── Stage Detail Forms ─── */

  const renderBasicInfoForm = (stage: WorkflowStage) => {
    const data = formData.basic_info || {};
    return (
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label className="text-xs flex items-center gap-1">
            <User className="w-3 h-3" /> Customer Name
          </Label>
          <Input
            placeholder="e.g. John Doe"
            value={data.customer_name || ""}
            onChange={(e) => updateFormField("basic_info", "customer_name", e.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs flex items-center gap-1">
            <Phone className="w-3 h-3" /> Contact Info
          </Label>
          <Input
            placeholder="e.g. +971-50-123-4567"
            value={data.contact_info || ""}
            onChange={(e) => updateFormField("basic_info", "contact_info", e.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs flex items-center gap-1">
            <Building className="w-3 h-3" /> Project Name
          </Label>
          <Input
            placeholder="e.g. Villa Palm Jumeirah"
            value={data.project_name || ""}
            onChange={(e) => updateFormField("basic_info", "project_name", e.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs flex items-center gap-1">
            <MapPin className="w-3 h-3" /> Address
          </Label>
          <Input
            placeholder="e.g. Villa 42, Palm Jumeirah"
            value={data.address || ""}
            onChange={(e) => updateFormField("basic_info", "address", e.target.value)}
          />
        </div>
        <div className="space-y-1.5 sm:col-span-2">
          <Label className="text-xs flex items-center gap-1">
            <ClipboardCheck className="w-3 h-3" /> Project Type
          </Label>
          <Input
            placeholder="e.g. Residential Villa / Commercial Office / Penthouse"
            value={data.project_type || ""}
            onChange={(e) => updateFormField("basic_info", "project_type", e.target.value)}
          />
        </div>
      </div>
    );
  };

  const renderRequirementsForm = (stage: WorkflowStage) => {
    const data = formData.requirements || {};
    const needsFields = [
      { key: "knx_or_wireless", label: "KNX or Wireless" },
      { key: "lighting_dimming", label: "Lighting Dimming" },
      { key: "curtains", label: "Curtains" },
      { key: "ac", label: "AC" },
      { key: "access_control", label: "Access Control" },
      { key: "surveillance", label: "Surveillance" },
      { key: "network_coverage", label: "Network Coverage" },
    ];
    const needs: string[] = data.needs || [];

    const toggleNeed = (key: string) => {
      const current: string[] = data.needs || [];
      const updated = current.includes(key)
        ? current.filter((n: string) => n !== key)
        : [...current, key];
      updateFormField("requirements", "needs", updated);
    };

    return (
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label className="text-xs flex items-center gap-1">
            <Ruler className="w-3 h-3" /> House Area (sqm)
          </Label>
          <Input
            type="number"
            min="0"
            placeholder="e.g. 450"
            value={data.house_area || ""}
            onChange={(e) => updateFormField("requirements", "house_area", e.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs flex items-center gap-1">
            <Wrench className="w-3 h-3" /> AC Brand
          </Label>
          <Input
            placeholder="e.g. Daikin / LG / Trane"
            value={data.ac_brand || ""}
            onChange={(e) => updateFormField("requirements", "ac_brand", e.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs flex items-center gap-1">
            <Building className="w-3 h-3" /> Project Status
          </Label>
          <Select
            value={data.project_status || ""}
            onValueChange={(v) => updateFormField("requirements", "project_status", v)}
          >
            <SelectTrigger className="w-full">
              <SelectValue placeholder="Select status..." />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="under_construction">Under Construction</SelectItem>
              <SelectItem value="renovation">Renovation</SelectItem>
              <SelectItem value="retrofit">Retrofit</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs flex items-center gap-1">
            <Image className="w-3 h-3" /> Drawings (URL)
          </Label>
          <Input
            placeholder="e.g. https://drive.google.com/..."
            value={data.drawings_url || ""}
            onChange={(e) => updateFormField("requirements", "drawings_url", e.target.value)}
          />
        </div>

        {/* Needs Checklist */}
        <div className="sm:col-span-2 space-y-1.5">
          <Label className="text-xs flex items-center gap-1">
            <Network className="w-3 h-3" /> Needs Checklist
          </Label>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-1">
            {needsFields.map((nf) => (
              <label
                key={nf.key}
                className={cn(
                  "flex items-center gap-2 px-2.5 py-1.5 rounded-md border text-xs cursor-pointer transition-colors",
                  needs.includes(nf.key)
                    ? "border-copper-500/50 bg-copper-500/10 text-copper-300"
                    : "border-gray-700/50 bg-gray-800/30 text-gray-400 hover:border-gray-600"
                )}
              >
                <input
                  type="checkbox"
                  className="accent-copper-500 w-3.5 h-3.5"
                  checked={needs.includes(nf.key)}
                  onChange={() => toggleNeed(nf.key)}
                />
                {nf.label}
              </label>
            ))}
          </div>
        </div>
      </div>
    );
  };

  const renderDesignProposalForm = (stage: WorkflowStage) => {
    const data = formData.design_proposal || {};
    const isSubmitted = data.proposal_submitted === true;

    return (
      <div className="space-y-3">
        <div className="bg-amber-500/10 border border-amber-500/20 rounded-lg px-3 py-2 text-xs text-amber-300">
          ⏱ Auto-triggers: 24h follow-up reminder → 48h notify management (Tanya)
        </div>

        {!isSubmitted ? (
          <div className="flex items-center gap-3">
            <Button
              onClick={() => {
                updateFormField("design_proposal", "proposal_submitted", true);
                updateFormField(
                  "design_proposal",
                  "submitted_at",
                  new Date().toISOString()
                );
                updateFormField(
                  "design_proposal",
                  "follow_up_date",
                  new Date(Date.now() + 24 * 3600 * 1000).toISOString().split("T")[0]
                );
              }}
              className="bg-amber-500 hover:bg-amber-600 text-black font-semibold"
              size="sm"
            >
              <FileText className="w-4 h-4" />
              Proposal Submitted
            </Button>
            <span className="text-xs text-muted-foreground">
              Click when proposal has been delivered to customer
            </span>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-xs text-emerald-400">
              <CheckCircle2 className="w-4 h-4" />
              Proposal submitted — 24h timer started
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs">Proposal Submission Date</Label>
                <Input
                  type="date"
                  value={
                    data.submitted_at
                      ? data.submitted_at.split("T")[0]
                      : new Date().toISOString().split("T")[0]
                  }
                  onChange={(e) =>
                    updateFormField("design_proposal", "submitted_at", e.target.value)
                  }
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Follow-up Date</Label>
                <Input
                  type="date"
                  value={data.follow_up_date || ""}
                  onChange={(e) =>
                    updateFormField("design_proposal", "follow_up_date", e.target.value)
                  }
                />
              </div>
            </div>
          </div>
        )}
      </div>
    );
  };

  const renderContractForm = (stage: WorkflowStage) => {
    const data = formData.contract || {};
    return (
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label className="text-xs flex items-center gap-1">
            <ClipboardCheck className="w-3 h-3" /> Visit Status
          </Label>
          <Select
            value={data.visit_status || ""}
            onValueChange={(v) => updateFormField("contract", "visit_status", v)}
          >
            <SelectTrigger className="w-full">
              <SelectValue placeholder="Select visit status..." />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="scheduled">Scheduled</SelectItem>
              <SelectItem value="completed">Completed</SelectItem>
              <SelectItem value="cancelled">Cancelled</SelectItem>
              <SelectItem value="rescheduled">Rescheduled</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs flex items-center gap-1">
            <Clock className="w-3 h-3" /> Expected Sign Date
          </Label>
          <Input
            type="date"
            value={data.expected_sign_date || ""}
            onChange={(e) =>
              updateFormField("contract", "expected_sign_date", e.target.value)
            }
          />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs flex items-center gap-1">
            <FileText className="w-3 h-3" /> Proposal Presentation
          </Label>
          <Input
            placeholder="URL or file name"
            value={data.proposal_presentation || ""}
            onChange={(e) =>
              updateFormField("contract", "proposal_presentation", e.target.value)
            }
          />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs flex items-center gap-1">
            <Play className="w-3 h-3" /> Next Activity Content
          </Label>
          <Input
            placeholder="e.g. Face-to-face meeting"
            value={data.next_activity_content || ""}
            onChange={(e) =>
              updateFormField("contract", "next_activity_content", e.target.value)
            }
          />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs flex items-center gap-1">
            <Clock className="w-3 h-3" /> Next Activity Date
          </Label>
          <Input
            type="date"
            value={data.next_activity_date || ""}
            onChange={(e) =>
              updateFormField("contract", "next_activity_date", e.target.value)
            }
          />
        </div>
      </div>
    );
  };

  const renderDecisionForm = (stage: WorkflowStage) => {
    const data = formData.decision || {};
    const status = data.status || "";

    return (
      <div className="space-y-3">
        <div className="space-y-1.5">
          <Label className="text-xs font-semibold">Decision Status</Label>
          <div className="grid grid-cols-1 gap-2">
            {/* Deepening Proposal */}
            <label
              className={cn(
                "flex items-start gap-3 px-3 py-2.5 rounded-lg border cursor-pointer transition-colors",
                status === "deepening_proposal"
                  ? "border-blue-500/50 bg-blue-500/10"
                  : "border-gray-700/50 bg-gray-800/30 hover:border-gray-600"
              )}
            >
              <input
                type="radio"
                name="decision_status"
                className="mt-0.5 accent-blue-500"
                checked={status === "deepening_proposal"}
                onChange={() => updateFormField("decision", "status", "deepening_proposal")}
              />
              <div className="flex-1">
                <span className="text-sm font-medium text-blue-300">Deepening Proposal</span>
                <p className="text-[10px] text-muted-foreground mt-0.5">
                  Customer needs more details or revisions
                </p>
                {status === "deepening_proposal" && (
                  <div className="mt-2 space-y-2 pl-0">
                    <div className="space-y-1">
                      <Label className="text-[10px]">Next Expected Follow-up Time</Label>
                      <Input
                        type="date"
                        size={10}
                        className="h-7 text-xs"
                        value={data.follow_up_time || ""}
                        onChange={(e) =>
                          updateFormField("decision", "follow_up_time", e.target.value)
                        }
                        onClick={(e: React.MouseEvent) => e.stopPropagation()}
                      />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-[10px]">Follow-up Content</Label>
                      <Textarea
                        className="min-h-[60px] text-xs"
                        placeholder="What needs to be prepared / presented..."
                        value={data.follow_up_content || ""}
                        onChange={(e) =>
                          updateFormField("decision", "follow_up_content", e.target.value)
                        }
                        onClick={(e: React.MouseEvent) => e.stopPropagation()}
                      />
                    </div>
                  </div>
                )}
              </div>
            </label>

            {/* Preparing to Sign */}
            <label
              className={cn(
                "flex items-start gap-3 px-3 py-2.5 rounded-lg border cursor-pointer transition-colors",
                status === "preparing_to_sign"
                  ? "border-emerald-500/50 bg-emerald-500/10"
                  : "border-gray-700/50 bg-gray-800/30 hover:border-gray-600"
              )}
            >
              <input
                type="radio"
                name="decision_status"
                className="mt-0.5 accent-emerald-500"
                checked={status === "preparing_to_sign"}
                onChange={() => updateFormField("decision", "status", "preparing_to_sign")}
              />
              <div className="flex-1">
                <span className="text-sm font-medium text-emerald-300">Preparing to Sign</span>
                <p className="text-[10px] text-muted-foreground mt-0.5">
                  Customer is ready to proceed with contract
                </p>
                {status === "preparing_to_sign" && (
                  <div className="mt-2 space-y-1 pl-0">
                    <Label className="text-[10px]">Expected Sign Date</Label>
                    <Input
                      type="date"
                      size={10}
                      className="h-7 text-xs"
                      value={data.expected_sign_date || ""}
                      onChange={(e) =>
                        updateFormField("decision", "expected_sign_date", e.target.value)
                      }
                      onClick={(e: React.MouseEvent) => e.stopPropagation()}
                    />
                  </div>
                )}
              </div>
            </label>

            {/* Rejected */}
            <label
              className={cn(
                "flex items-start gap-3 px-3 py-2.5 rounded-lg border cursor-pointer transition-colors",
                status === "rejected"
                  ? "border-rose-500/50 bg-rose-500/10"
                  : "border-gray-700/50 bg-gray-800/30 hover:border-gray-600"
              )}
            >
              <input
                type="radio"
                name="decision_status"
                className="mt-0.5 accent-rose-500"
                checked={status === "rejected"}
                onChange={() => updateFormField("decision", "status", "rejected")}
              />
              <div className="flex-1">
                <span className="text-sm font-medium text-rose-300">Rejected</span>
                <p className="text-[10px] text-muted-foreground mt-0.5">
                  Customer declined the proposal
                </p>
                {status === "rejected" && (
                  <div className="mt-2 space-y-2 pl-0">
                    <div className="space-y-1">
                      <Label className="text-[10px]">Rejection Reason</Label>
                      <Select
                        value={data.rejection_reason || ""}
                        onValueChange={(v) =>
                          updateFormField("decision", "rejection_reason", v)
                        }
                      >
                        <SelectTrigger
                          className="w-full h-7 text-xs"
                          onClick={(e: React.MouseEvent) => e.stopPropagation()}
                        >
                          <SelectValue placeholder="Select reason..." />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="budget">Budget</SelectItem>
                          <SelectItem value="competitor">Competitor</SelectItem>
                          <SelectItem value="project">Project</SelectItem>
                          <SelectItem value="product">Product</SelectItem>
                          <SelectItem value="other">Other</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-1">
                      <Label className="text-[10px]">Rejection Details</Label>
                      <Textarea
                        className="min-h-[60px] text-xs"
                        placeholder="Provide details on why the customer rejected..."
                        value={data.rejection_detail || ""}
                        onChange={(e) =>
                          updateFormField("decision", "rejection_detail", e.target.value)
                        }
                        onClick={(e: React.MouseEvent) => e.stopPropagation()}
                      />
                    </div>
                  </div>
                )}
              </div>
            </label>
          </div>
        </div>
      </div>
    );
  };

  /* ─── Render Stage Detail (expanded card) ─── */
  const renderStageDetail = (stage: WorkflowStage) => {
    const isCurrent = stage.status === "in_progress";
    const isFuture = stage.status === "pending";
    const isDone = stage.status === "completed";
    const config = STAGE_CONFIG[stage.stage_key];
    const isExpanded = expandedStage === stage.stage_key;
    const Icon = config?.icon || ClipboardCheck;
    const timeLeft = stage.deadline_at ? fmtTimeLeft(stage.deadline_at) : null;

    // Determine which stages should show detail
    // Show if: completed (collapsible summary) OR in_progress (form) OR it's the first pending and no active stage
    const firstPendingIdx = stages.findIndex((s) => s.status === "pending");
    const hasActive = stages.some((s) => s.status === "in_progress");
    const showDetail =
      isDone ||
      isCurrent ||
      (isFuture && !hasActive && stages.indexOf(stage) === firstPendingIdx);

    if (!showDetail && !isExpanded) return null;

    // Parse stored notes for completed stages
    let storedData: StageFormData = {};
    if (isDone && stage.notes) {
      try {
        storedData = JSON.parse(stage.notes);
      } catch {
        storedData = {};
      }
    }

    return (
      <Card
        key={stage.stage_key}
        size="sm"
        className={cn(
          "transition-all",
          isDone && "border-emerald-500/20",
          isCurrent && "border-amber-500/30 ring-1 ring-amber-500/10",
          isFuture && "border-gray-700/30 opacity-70"
        )}
      >
        <CardHeader
          className={cn(
            "flex flex-row items-center justify-between cursor-pointer",
            (isDone || isFuture) && "hover:bg-muted/30"
          )}
          onClick={() => {
            if (isDone || isFuture) {
              setExpandedStage(isExpanded ? null : stage.stage_key);
            }
          }}
        >
          <div className="flex items-center gap-2">
            <div
              className={cn(
                "w-6 h-6 rounded-full flex items-center justify-center",
                isDone && "bg-emerald-500/20",
                isCurrent && "bg-amber-500/20",
                isFuture && "bg-gray-800"
              )}
            >
              {isDone ? (
                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
              ) : (
                <Icon className={cn("w-3.5 h-3.5", isCurrent ? "text-amber-400" : config?.color || "text-gray-500")} />
              )}
            </div>
            <div>
              <CardTitle className="text-sm flex items-center gap-2">
                <span className="text-gray-300">{config?.label}</span>
                <span className="text-[10px] text-muted-foreground font-normal">
                  {config?.weight}% weight
                </span>
                <Badge
                  className={cn(
                    "text-[9px] px-1.5 py-0",
                    isDone && "bg-emerald-500/15 text-emerald-400 border-emerald-500/20",
                    isCurrent && "bg-amber-500/15 text-amber-400 border-amber-500/20",
                    isFuture && "bg-gray-700/30 text-gray-500 border-gray-600/30"
                  )}
                >
                  {isDone ? "Completed" : isCurrent ? "In Progress" : "Pending"}
                </Badge>
              </CardTitle>
              <CardDescription className="text-[10px]">{config?.goal}</CardDescription>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {isCurrent && timeLeft && (
              <div
                className={cn(
                  "flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full",
                  timeLeft.expired && "text-rose-400 bg-rose-500/10",
                  timeLeft.urgent && !timeLeft.expired && "text-amber-400 bg-amber-500/10",
                  !timeLeft.urgent && !timeLeft.expired && "text-muted-foreground bg-gray-800/50"
                )}
              >
                {timeLeft.expired ? (
                  <AlertTriangle className="w-3 h-3" />
                ) : (
                  <Clock className="w-3 h-3" />
                )}
                {timeLeft.text}
              </div>
            )}
            {(isDone || isFuture) && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setExpandedStage(isExpanded ? null : stage.stage_key);
                }}
                className="p-1 rounded hover:bg-muted/50 transition-colors"
              >
                {isExpanded ? (
                  <ChevronUp className="w-3.5 h-3.5 text-muted-foreground" />
                ) : (
                  <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" />
                )}
              </button>
            )}
          </div>
        </CardHeader>

        {/* Expanded Content */}
        {(isExpanded || isCurrent) && (
          <>
            <CardContent>
              {/* Form or Stored Data */}
              {isCurrent && stage.stage_key === "basic_info" && renderBasicInfoForm(stage)}
              {isCurrent && stage.stage_key === "requirements" && renderRequirementsForm(stage)}
              {isCurrent && stage.stage_key === "design_proposal" && renderDesignProposalForm(stage)}
              {isCurrent && stage.stage_key === "contract" && renderContractForm(stage)}
              {isCurrent && stage.stage_key === "decision" && renderDecisionForm(stage)}

              {/* Completed stage data summary */}
              {isDone && storedData && Object.keys(storedData).length > 0 && (
                <div className="text-xs text-muted-foreground space-y-1">
                  {Object.entries(storedData).map(([key, value]) => (
                    <div key={key} className="flex gap-2">
                      <span className="text-gray-500 font-medium min-w-[100px]">
                        {key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())}:
                      </span>
                      <span>
                        {Array.isArray(value)
                          ? (value as string[]).join(", ")
                          : typeof value === "boolean"
                          ? value
                            ? "Yes"
                            : "No"
                          : String(value)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
              {isDone && (!storedData || Object.keys(storedData).length === 0) && (
                <p className="text-xs text-muted-foreground italic">No data recorded</p>
              )}
            </CardContent>

            {isCurrent && (
              <CardFooter className="flex justify-between">
                <span className="text-[10px] text-muted-foreground">
                  Fill in the required fields and click Complete
                </span>
                <Button
                  size="xs"
                  onClick={() => handleCompleteStage(stage.stage_key)}
                  disabled={!!acting}
                  className={cn(
                    "font-semibold",
                    acting === stage.stage_key && "opacity-50 cursor-wait"
                  )}
                >
                  {acting === stage.stage_key ? (
                    <Clock className="w-3 h-3 animate-spin" />
                  ) : (
                    <CheckCircle2 className="w-3 h-3" />
                  )}
                  Complete
                </Button>
              </CardFooter>
            )}

            {/* Start button for first pending stage if no stage is active */}
            {isFuture && !hasActive && stages.indexOf(stage) === firstPendingIdx && (
              <CardFooter>
                <Button
                  size="xs"
                  onClick={() => handleStartStage(stage.stage_key)}
                  disabled={!!acting}
                  className={cn(
                    "font-semibold",
                    acting === stage.stage_key && "opacity-50 cursor-wait"
                  )}
                >
                  {acting === stage.stage_key ? (
                    <Clock className="w-3 h-3 animate-spin" />
                  ) : (
                    <Play className="w-3 h-3" />
                  )}
                  Start Stage
                </Button>
              </CardFooter>
            )}
          </>
        )}
      </Card>
    );
  };

  /* ─── Render ─── */
  if (loading) {
    return <div className="text-xs text-muted-foreground py-4 text-center">Loading workflow...</div>;
  }

  if (stages.length === 0) {
    return <div className="text-xs text-muted-foreground py-4 text-center">No workflow stages</div>;
  }

  const completedCount = stages.filter((s) => s.status === "completed").length;
  const totalWeight = stages.reduce((sum, s) => (s.status === "completed" ? sum + s.weight : sum), 0);
  const allComplete = stages.every((s) => s.status === "completed");

  return (
    <div className="space-y-4">
      {/* Overall progress */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-foreground">Sales Workflow</span>
          <Badge className="text-[10px] bg-copper-500/10 text-copper-400 border-copper-500/20">
            {completedCount}/{stages.length} done · {totalWeight}% progress
          </Badge>
        </div>
        {allComplete && (
          <Badge className="text-[10px] bg-emerald-500/15 text-emerald-400 border-emerald-500/20">
            <CheckCircle2 className="w-3 h-3 mr-1" />
            Workflow Complete
          </Badge>
        )}
      </div>

      {/* 5-Step Progress Bar */}
      <div className="relative">
        {/* Connection line */}
        <div className="absolute top-5 left-0 right-0 h-0.5 bg-gray-700/50">
          <div
            className="h-full bg-copper-500/60 transition-all duration-500"
            style={{ width: `${(completedCount / stages.length) * 100}%` }}
          />
        </div>

        {/* Stage nodes */}
        <div className="relative flex justify-between">
          {stages.map((stage) => {
            const config = STAGE_CONFIG[stage.stage_key];
            const Icon = config?.icon || ClipboardCheck;
            const isCompleted = stage.status === "completed";
            const isActive = stage.status === "in_progress";
            const isPending = stage.status === "pending";
            const timeLeft = stage.deadline_at ? fmtTimeLeft(stage.deadline_at) : null;
            const isLoading = acting === stage.stage_key;

            return (
              <div
                key={stage.stage_key}
                className="flex flex-col items-center gap-1.5"
                style={{ width: "20%" }}
              >
                {/* Circle icon */}
                <button
                  onClick={() => {
                    if (isPending) handleStartStage(stage.stage_key);
                    else if (isActive) setExpandedStage(stage.stage_key);
                    else if (isCompleted) setExpandedStage(expandedStage === stage.stage_key ? null : stage.stage_key);
                  }}
                  disabled={!!acting}
                  className={cn(
                    "relative w-10 h-10 rounded-full flex items-center justify-center transition-all border-2",
                    isCompleted && "bg-emerald-500/20 border-emerald-500/50 cursor-pointer",
                    isActive && "bg-amber-500/20 border-amber-500/50 animate-pulse cursor-pointer",
                    isPending && "bg-gray-800 border-gray-600/50 hover:border-gray-500 cursor-pointer",
                    isLoading && "opacity-50 cursor-wait"
                  )}
                  title={
                    isPending
                      ? "Click to start"
                      : isActive
                      ? config?.label
                      : config?.label
                  }
                >
                  {isCompleted ? (
                    <CheckCircle2 className="w-5 h-5 text-emerald-400" />
                  ) : isActive ? (
                    <Play className="w-4 h-4 text-amber-400" />
                  ) : (
                    <Icon className={cn("w-4 h-4", config?.color || "text-gray-500")} />
                  )}
                </button>

                {/* Label */}
                <span
                  className={cn(
                    "text-[10px] font-medium text-center leading-tight",
                    isCompleted
                      ? "text-emerald-400"
                      : isActive
                      ? "text-amber-400"
                      : "text-gray-500"
                  )}
                >
                  {config?.label}
                </span>

                {/* Weight */}
                <span className="text-[9px] text-muted-foreground">{config?.weight}%</span>

                {/* Deadline indicator */}
                {isActive && timeLeft && (
                  <div
                    className={cn(
                      "flex items-center gap-1 text-[9px]",
                      timeLeft.expired
                        ? "text-rose-400"
                        : timeLeft.urgent
                        ? "text-amber-400"
                        : "text-muted-foreground"
                    )}
                  >
                    {timeLeft.expired ? (
                      <AlertTriangle className="w-2.5 h-2.5" />
                    ) : (
                      <Clock className="w-2.5 h-2.5" />
                    )}
                    {timeLeft.text}
                  </div>
                )}

                {/* Stage number */}
                <span className="text-[8px] text-muted-foreground/50">
                  Stage {stage.stage_order + 1}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      {/* Stage Detail Cards */}
      <div className="space-y-2 mt-4">
        {stages.map((stage) => renderStageDetail(stage))}
      </div>
    </div>
  );
}
