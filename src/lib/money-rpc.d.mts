export type MoneyRpcError = {
  code?: string | null;
  message?: string | null;
} | null | undefined;
export type MoneyRpcFailure = {
  status: number;
  body: { error: string; code?: string };
};
export const MONEY_RPC_STATUS: Readonly<Record<string, number>>;
export function moneyRpcStatus(error: MoneyRpcError): number;
export function moneyRpcFailure(error: MoneyRpcError, fallback: string): MoneyRpcFailure;
