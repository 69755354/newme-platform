export declare const DISCOUNT_RATE_MIN: number;
export declare const DISCOUNT_RATE_MAX: number;

export declare function clampDiscountRate(value: unknown, max?: number): number;
export declare function discountRateError(value: unknown): string | null;

export interface NormalizedQuotationLineItem {
  id: string;
  name: string;
  description: string;
  quantity: number;
  unit_price: number;
  line_total: number;
  unit: string;
}

export declare function normalizeQuotationLineItems(devicesJson: unknown): NormalizedQuotationLineItem[];
export declare function lineItemsSubtotal(items: readonly NormalizedQuotationLineItem[]): number;
