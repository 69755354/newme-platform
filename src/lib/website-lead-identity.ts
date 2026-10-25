import { createHash } from "node:crypto";
import type { WebsiteLeadInput } from "./public-lead";

// Fixed UUID namespace, separate from IDs supplied by any other CRM intake.
const NAMESPACE = Buffer.from("81f966413a555c698fd1a1ad8539e05c", "hex");

export function websiteEventUuid(kind: "lead" | "task" | "delivery", eventId: string): string {
  const bytes = createHash("sha1").update(NAMESPACE).update(`${kind}:${eventId}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function websiteLeadFingerprint(input: WebsiteLeadInput): string {
  // Verification tokens may change on a retry; the actual inquiry must not.
  const { turnstileToken: _token, honeypot: _honeypot, attribution: _attribution, ...inquiry } = input;
  void _token;
  void _honeypot;
  void _attribution;
  return createHash("sha256").update(JSON.stringify(inquiry)).digest("hex");
}
