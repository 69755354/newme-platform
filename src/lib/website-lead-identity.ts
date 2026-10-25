import { createHash } from "node:crypto";
import type { WebsiteLeadInput } from "./public-lead";

// Fixed UUID namespace, separate from IDs supplied by any other CRM intake.
const NAMESPACE = new Uint8Array([
  0x81, 0xf9, 0x66, 0x41, 0x3a, 0x55, 0x5c, 0x69,
  0x8f, 0xd1, 0xa1, 0xad, 0x85, 0x39, 0xe0, 0x5c,
]);

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
