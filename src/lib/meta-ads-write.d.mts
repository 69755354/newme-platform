export function atomicWriteResult(data: unknown, expected: number):
  | { ok: false; error: string }
  | { ok: true; inserted: number; deleted: number; present: number };
export function atomicWriteError(error: { code?: string; message?: string } | null):
  { error: string; status: number };
