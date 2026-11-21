"use client";

// Read-only AI needs summary for WhatsApp leads (written by the scheduled routine through /api/leads/ai-notes).
// Advisory only: it never changes the lead's quality, stage or owner. Hidden when no note exists.

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Sparkles } from "lucide-react";
import { fmtDubai } from "@/lib/utils";
import { AI_NOTE_LABEL, QUALITY_LABEL_ZH, latestAiNote } from "@/lib/wa-ai-notes.mjs";
import type { Activity } from "./types";

export default function LeadAiNoteCard({ activities }: { activities: Activity[] }) {
  const note = latestAiNote(activities);
  if (!note) return null;
  const quality = QUALITY_LABEL_ZH[note.suggested_quality as keyof typeof QUALITY_LABEL_ZH];
  return (
    <Card data-testid="lead-ai-note">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Sparkles className="h-4 w-4 text-violet-500" />
          {AI_NOTE_LABEL}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        <p className="whitespace-pre-wrap break-words">{note.summary}</p>
        <p className="text-xs text-muted-foreground">建议线索质量：<span className="font-medium text-foreground">{quality}</span> — {note.reason}</p>
        <p className="text-xs text-muted-foreground">{fmtDubai(note.created_at, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</p>
      </CardContent>
    </Card>
  );
}
