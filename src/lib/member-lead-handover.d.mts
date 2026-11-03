export declare const UNASSIGNED_QUEUE: "unassigned";

export declare function readHandoverTarget(
  transferTo: unknown,
  memberId: string,
): { ok: true; target: string | null } | { ok: false; code: string };

export interface MemberHandoverReport {
  moved: string[];
  conflicts: string[];
  failed: { id: string; message: string }[];
  complete: boolean;
}

export declare function handOverMemberLeads(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client: any,
  options: { memberId: string; target: string | null; batchKey: string; reason?: string },
): Promise<MemberHandoverReport>;
