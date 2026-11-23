export const ASSESSED_QUALITIES = Object.freeze(["good", "normal", "poor"]);

export function isAssessedQuality(quality) {
  return ASSESSED_QUALITIES.includes(quality);
}

export function isCompleteContact({ contact_time, contact_result }) {
  return Boolean(
    contact_time
      && typeof contact_result === "string"
      && contact_result.trim(),
  );
}

export function evaluateFirstContactGate({
  currentStage,
  nextStage,
  contactCount,
  quality,
}) {
  const isLeavingNew = currentStage === "new" && nextStage !== "new";
  if (!isLeavingNew) return { allowed: true, reasons: [] };

  const reasons = [];
  if (contactCount < 1) reasons.push("At least one complete contact record is required");
  // S39: the quality rating is optional; it no longer blocks leaving "new".
  return { allowed: reasons.length === 0, reasons };
}
