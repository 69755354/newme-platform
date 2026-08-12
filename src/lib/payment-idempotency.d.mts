export declare const PAYMENT_IDEMPOTENCY_KEY_PATTERN: RegExp;
export declare const PAYMENT_RECORDING_ROLES: readonly string[];
export declare const PAYMENT_PAGE_ROLES: readonly string[];
export declare const PAYMENT_METHODS: readonly string[];
export declare const PAYMENT_UI_METHODS: readonly string[];

export declare function isPaymentMethod(value: unknown): boolean;
export declare function paymentAmountMinorUnits(value: unknown): number | null;

export interface PaymentIntentSource {
  contract_id?: string | null;
  amount?: number | string | null;
  payment_date?: string | null;
  payment_method?: string | null;
  reference_no?: string | null;
  notes?: string | null;
}

export interface PaymentIntent {
  contract_id: string | null;
  amount: number | null;
  payment_date: string | null;
  payment_method: string | null;
  reference_no: string | null;
  notes: string | null;
}

export interface ValidatedPaymentIntent {
  contract_id: string;
  amount: number;
  payment_date: string;
  payment_method: string;
  reference_no: string | null;
  notes: string | null;
}

export declare function readIdempotencyKey(input: {
  body?: unknown;
  headerValue?: string | null;
}): string | null;

export declare function paymentIntentOf(source: PaymentIntentSource | null | undefined): PaymentIntent;

export declare function paymentIntentsMatch(
  left: PaymentIntentSource | null | undefined,
  right: PaymentIntentSource | null | undefined,
): boolean;

export declare function validatePaymentRecordInput(source: unknown):
  | { ok: false; error: string }
  | { ok: true; intent: ValidatedPaymentIntent };

export declare function isRequestKeyConflict(
  error: { code?: string | null; message?: string | null; details?: string | null; constraint?: string | null } | null | undefined,
): boolean;

export declare function resolveSpentKey(input: {
  stored: PaymentIntentSource | null | undefined;
  requested: PaymentIntentSource;
}): {
  outcome: "replay" | "mismatch" | "opaque";
  status: 200 | 409;
  code: "DUPLICATE_REQUEST" | "IDEMPOTENCY_KEY_REUSED" | null;
};

export declare function recordPaymentWithKey(input: {
  supabase: unknown;
  creatorId: string;
  requestKey: string;
  intent: ValidatedPaymentIntent;
}): Promise<
  | { outcome: "created"; status: 201; payment: { id: string; amount: number | string }; code: null; error: null }
  | { outcome: "replay"; status: 200; payment: PaymentIntentSource & { id: string }; code: null; error: null }
  | { outcome: "mismatch"; status: 409; payment: (PaymentIntentSource & { id: string }) | null; code: "IDEMPOTENCY_KEY_REUSED"; error: null }
  | { outcome: "opaque"; status: 409; payment: null; code: "DUPLICATE_REQUEST"; error: unknown }
  | { outcome: "failed"; status: 500; payment: null; code: null; error: unknown }
>;

export declare function canRecordPayment(input: {
  role?: string | null;
  contractSalesId?: string | null;
  userId?: string | null;
}): boolean;
