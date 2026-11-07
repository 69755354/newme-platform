export type MutationFailureKind = "network" | "session" | "forbidden" | "conflict" | "validation" | "server" | "unexpected";
export declare const SLOW_MUTATION_MS: number;
export declare const SESSION_REDIRECT_DELAY_MS: number;
export declare const KNOWN_API_ERRORS: readonly string[];
export declare function apiErrorSlug(raw: unknown): string;
export declare function classifyMutationFailure(failure?: { status?: number; body?: unknown; error?: unknown }): MutationFailureKind;
export declare function mutationFailureMessage(
  failure: { kind: MutationFailureKind; body?: unknown; error?: unknown },
  t: (key: string) => string,
  fallbackKey?: string,
): string;
