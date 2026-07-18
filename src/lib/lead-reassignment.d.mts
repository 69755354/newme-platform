export interface TransferCandidateQuery<T> {
  in(column: string, values: readonly string[]): {
    eq(column: string, value: boolean): {
      order(column: string, options: { ascending: boolean }): {
        limit(count: number): Promise<{ data: T[] | null; error: Error | null }>;
      };
      eq(column: string, value: string): {
        maybeSingle(): Promise<{ data: T | null; error: Error | null }>;
      };
    };
  };
}

export function resolveActiveLeadReassignmentTarget<T extends { id: string }>(
  profilesQuery: TransferCandidateQuery<T>,
): Promise<string | null>;

export function requireActiveLeadTransferCandidate<T>(
  profilesQuery: TransferCandidateQuery<T>,
  userId: string,
): Promise<T>;
