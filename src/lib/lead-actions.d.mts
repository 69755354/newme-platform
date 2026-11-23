type GreetingLead = { customer_name?: string | null; landing_page?: string | null; phone?: string | null } | null | undefined;
export function leadGreetingLanguage(lead: GreetingLead): "ar" | "en";
export function whatsappGreeting(lead: GreetingLead, salespersonName: string | null | undefined): string;
export function whatsappLinkWithGreeting(lead: GreetingLead, salespersonName: string | null | undefined): string | null;
export const QUICK_LOG_METHODS: readonly string[];
export function quickLogBody(method: string, note?: string | null): { contact_method: string; summary?: string };
