import type { PaymentIntentSource, ValidatedPaymentIntent } from "./payment-idempotency.mjs";

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
