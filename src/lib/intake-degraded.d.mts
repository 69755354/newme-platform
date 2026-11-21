export const INTAKE_DEGRADED_WINDOW_MS: number;
export function markIntakeDegraded(channel: string, now?: number): void;
export function intakeDegradedSnapshot(now?: number, windowMs?: number): Record<string, "degraded">;
export function resetIntakeDegraded(): void;
