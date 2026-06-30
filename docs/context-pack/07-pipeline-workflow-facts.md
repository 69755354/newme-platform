# 07 — Pipeline Workflow Facts

Source: src/lib/milestones.ts + src/app/(dashboard)/pipeline/page.tsx

## Current Pipeline Columns (9 stages)
new → contacted → requirement_confirmed → solution_submitted → quotation_submitted → negotiation → pending_decision → won → lost

## COMPLETABLE_MILESTONES (7 real milestones)
first_contact → basic_info → drawings → requirements → solution → quotation → meeting

(new/negotiation are stage labels, not completable milestones)

## MILESTONE_KEYS (full ordered list, 9 items)
new, first_contact, basic_info, drawings, requirements, solution, quotation, meeting, negotiation

## STAGE_MAP (milestone count → stage label)
0=new, 1=contacted, 2=qualified, 3=drawings, 4=requirements, 5=solution, 6=quotation, 7=meeting, 8=negotiation

## canCompleteMilestone() Rules
1. targetKey must be in COMPLETABLE_MILESTONES (not new/negotiation)
2. Cannot complete already-completed milestone
3. First milestone must be first_contact (when currentMilestones is empty)
4. Cannot go backward (targetOrder <= maxCurrentOrder)
5. Cannot skip (targetOrder > maxCurrentOrder + 1)

## Won/Lost Writing
- Milestone API: `POST /api/leads/[id]/milestone` with milestoneKey='won' or 'lost'
- Writes final_status + legacy stage (dual-write)
- trg_lead_won trigger fires on final_status change → auto-creates contract, installments, project

## Lost Reason
- Stored in leads table (lost_reason field)
- Values: price/competitor/noBudget/cancelled/delayed/noResponse/other
- Written via updateField() on lead detail page

## Drag Behavior (pipeline page)
- Pipeline page has drag-and-drop between stage columns
- Dragging updates lead.stage via API (legacy behavior)
- Working tree changes: drag now updates current_milestone/final_status

## Stage Buttons (lead detail page)
- updateStage() function in leads/[id]/page.tsx
- won/lost routes to final_status field (in working tree)
- Other stages write to legacy stage column
- handleWon() calls updateStage("won") → awaits result before showing toast
