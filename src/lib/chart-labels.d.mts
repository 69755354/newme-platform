export function humanizeKey(key: unknown): string;
export function chartLabel(labels: Record<string, string> | null | undefined, key: string, fallback?: string): string;
export function segmentTitle(labels: Record<string, string> | null | undefined, key: string, count: number, fallback?: string): string;
export function translatedOrRaw(translate: (path: string) => string, path: string, raw: string): string;
