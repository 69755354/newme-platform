const MD5_SHIFTS = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
] as const;

const MD5_CONSTANTS = Array.from(
  { length: 64 },
  (_, index) => Math.floor(Math.abs(Math.sin(index + 1)) * 0x1_0000_0000) >>> 0,
);

function rotateLeft(value: number, shift: number): number {
  return ((value << shift) | (value >>> (32 - shift))) >>> 0;
}

class Md5Accumulator {
  private a = 0x67452301;
  private b = 0xefcdab89;
  private c = 0x98badcfe;
  private d = 0x10325476;
  private byteLength = 0;
  private remainder = new Uint8Array(0);

  update(chunk: Uint8Array): void {
    this.byteLength += chunk.byteLength;
    const input = new Uint8Array(this.remainder.byteLength + chunk.byteLength);
    input.set(this.remainder);
    input.set(chunk, this.remainder.byteLength);
    let offset = 0;
    while (offset + 64 <= input.byteLength) {
      this.processBlock(input, offset);
      offset += 64;
    }
    this.remainder = input.slice(offset);
  }

  digest(): Uint8Array {
    const tailLength = this.remainder.byteLength;
    const paddingLength = tailLength < 56 ? 64 - tailLength : 128 - tailLength;
    const finalBlocks = new Uint8Array(tailLength + paddingLength);
    finalBlocks.set(this.remainder);
    finalBlocks[tailLength] = 0x80;
    const bitLengthLow = (this.byteLength * 8) >>> 0;
    const bitLengthHigh = Math.floor(this.byteLength / 0x2000_0000) >>> 0;
    const finalView = new DataView(finalBlocks.buffer);
    finalView.setUint32(finalBlocks.byteLength - 8, bitLengthLow, true);
    finalView.setUint32(finalBlocks.byteLength - 4, bitLengthHigh, true);
    for (let offset = 0; offset < finalBlocks.byteLength; offset += 64) {
      this.processBlock(finalBlocks, offset);
    }
    const output = new Uint8Array(16);
    const view = new DataView(output.buffer);
    view.setUint32(0, this.a, true);
    view.setUint32(4, this.b, true);
    view.setUint32(8, this.c, true);
    view.setUint32(12, this.d, true);
    return output;
  }

  private processBlock(block: Uint8Array, offset: number): void {
    const words = new Uint32Array(16);
    for (let index = 0; index < 16; index += 1) {
      const wordOffset = offset + index * 4;
      words[index] = (
        block[wordOffset]
        | (block[wordOffset + 1] << 8)
        | (block[wordOffset + 2] << 16)
        | (block[wordOffset + 3] << 24)
      ) >>> 0;
    }

    let a = this.a;
    let b = this.b;
    let c = this.c;
    let d = this.d;
    for (let index = 0; index < 64; index += 1) {
      let mixed: number;
      let wordIndex: number;
      if (index < 16) {
        mixed = (b & c) | (~b & d);
        wordIndex = index;
      } else if (index < 32) {
        mixed = (d & b) | (~d & c);
        wordIndex = (5 * index + 1) % 16;
      } else if (index < 48) {
        mixed = b ^ c ^ d;
        wordIndex = (3 * index + 5) % 16;
      } else {
        mixed = c ^ (b | ~d);
        wordIndex = (7 * index) % 16;
      }
      const sum = (a + (mixed >>> 0) + MD5_CONSTANTS[index] + words[wordIndex]) >>> 0;
      const previousD = d;
      d = c;
      c = b;
      b = (b + rotateLeft(sum, MD5_SHIFTS[index])) >>> 0;
      a = previousD;
    }
    this.a = (this.a + a) >>> 0;
    this.b = (this.b + b) >>> 0;
    this.c = (this.c + c) >>> 0;
    this.d = (this.d + d) >>> 0;
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export async function fileMd5Base64(file: Blob): Promise<string> {
  const accumulator = new Md5Accumulator();
  const chunkSize = 4 * 1024 * 1024;
  for (let offset = 0; offset < file.size; offset += chunkSize) {
    const chunk = new Uint8Array(await file.slice(offset, offset + chunkSize).arrayBuffer());
    accumulator.update(chunk);
  }
  return bytesToBase64(accumulator.digest());
}

export function createSubmissionSession(): string {
  return globalThis.crypto.randomUUID().replaceAll("-", "");
}

export type UploadAttempt = { sessionId: string };

export function createUploadAttempt(): UploadAttempt {
  return { sessionId: createSubmissionSession() };
}

export async function submissionIdempotencyKey(
  operation: string,
  sessionId: string,
  payload: unknown,
): Promise<string> {
  const normalizedOperation = operation.replace(/[^A-Za-z0-9._:-]/g, "").slice(0, 32);
  const normalizedSession = sessionId.replace(/[^A-Za-z0-9._:-]/g, "").slice(0, 40);
  if (!normalizedOperation || !normalizedSession) throw new Error("invalid_submission_identity");
  const serialized = JSON.stringify(payload);
  if (serialized === undefined) throw new Error("invalid_submission_payload");
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(serialized),
  ));
  const digestHex = Array.from(digest.slice(0, 16), (byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `${normalizedOperation}:${normalizedSession}:${digestHex}`;
}

export function buildFullAmountInstallment(totalAmount: number, dueDate: string) {
  const roundedAmount = Math.round(totalAmount * 100) / 100;
  if (!Number.isFinite(totalAmount) || totalAmount <= 0
    || Math.abs(roundedAmount - totalAmount) > 1e-9
    || !/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) {
    throw new Error("invalid_conversion_installment");
  }
  return [{
    seq: 1,
    amount: roundedAmount,
    due_date: dueDate,
    description: "Full quotation amount",
  }];
}

export function buildPercentageInstallments(
  totalAmount: number,
  percentages: number[],
  dueDays: number[],
  baseDate: Date,
) {
  const totalCents = Math.round(totalAmount * 100);
  if (!Number.isFinite(totalAmount) || totalAmount <= 0
    || Math.abs(totalAmount * 100 - totalCents) > 1e-6
    || percentages.length === 0 || percentages.length !== dueDays.length
    || percentages.some((percentage) => !Number.isInteger(percentage) || percentage <= 0)
    || percentages.reduce((sum, percentage) => sum + percentage, 0) !== 100
    || dueDays.some((days) => !Number.isInteger(days) || days < 0)
    || Number.isNaN(baseDate.getTime())) {
    throw new Error("invalid_contract_installments");
  }
  let allocatedCents = 0;
  return percentages.map((percentage, index) => {
    const amountCents = index === percentages.length - 1
      ? totalCents - allocatedCents
      : Math.round((totalCents * percentage) / 100);
    allocatedCents += amountCents;
    const dueDate = new Date(baseDate.getTime());
    dueDate.setUTCDate(dueDate.getUTCDate() + dueDays[index]);
    return {
      seq: index + 1,
      amount: amountCents / 100,
      due_date: dueDate.toISOString().slice(0, 10),
    };
  });
}

type UploadRegistration = {
  file_id: string;
  url: string;
  headers: Record<string, string>;
};

function isUploadRegistration(value: unknown): value is UploadRegistration {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && "file_id" in value && typeof value.file_id === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      .test(value.file_id)
    && "url" in value && typeof value.url === "string"
    && (() => {
      try {
        return new URL(value.url).protocol === "https:";
      } catch {
        return false;
      }
    })()
    && "headers" in value && value.headers !== null
    && typeof value.headers === "object" && !Array.isArray(value.headers);
}

async function responseError(response: Response, fallback: string): Promise<Error> {
  const body: unknown = await response.json().catch(() => null);
  if (body !== null && typeof body === "object" && "error" in body
    && typeof body.error === "string") return new Error(body.error);
  return new Error(fallback);
}

function putFile(
  registration: UploadRegistration,
  file: File,
  onProgress: (percentage: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", registration.url);
    for (const [header, value] of Object.entries(registration.headers)) {
      const normalizedHeader = header.toLowerCase();
      // Browsers set the exact Blob length themselves and forbid scripts from
      // assigning Content-Length or Host. Both values remain signed by COS.
      if (normalizedHeader !== "content-length" && normalizedHeader !== "host") {
        xhr.setRequestHeader(header, value);
      }
    }
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(Math.round((event.loaded / event.total) * 100));
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new Error("storage_provider_upload_failed"));
    };
    xhr.onerror = () => reject(new Error("storage_provider_upload_failed"));
    xhr.send(file);
  });
}

export async function uploadContractFile(
  contractId: string,
  file: File,
  attempt: UploadAttempt,
  onProgress: (percentage: number) => void,
): Promise<string> {
  const contentType = file.type.trim() || "application/octet-stream";
  const contentMd5 = await fileMd5Base64(file);
  const uploadIdentity = {
    contract_id: contractId,
    filename: file.name,
    last_modified: file.lastModified,
    size: file.size,
    content_type: contentType,
    content_md5: contentMd5,
  };
  let registration: unknown = null;
  let rotatedExpiringAttempt = false;
  while (registration === null) {
    const idempotencyKey = await submissionIdempotencyKey(
      "storage.upload.ui",
      attempt.sessionId,
      uploadIdentity,
    );
    const registrationResponse = await fetch(`/api/contracts/${contractId}/upload-url`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        filename: file.name,
        version: "draft",
        content_type: contentType,
        size: file.size,
        content_md5: contentMd5,
        idempotency_key: idempotencyKey,
      }),
    });
    if (!registrationResponse.ok) {
      const error = await responseError(registrationResponse, "storage_registration_failed");
      if (error.message === "upload_url_expiring_new_idempotency_key_required"
        && !rotatedExpiringAttempt) {
        attempt.sessionId = createSubmissionSession();
        rotatedExpiringAttempt = true;
        continue;
      }
      throw error;
    }
    registration = await registrationResponse.json().catch(() => null);
  }
  if (!isUploadRegistration(registration)
    || registration.headers["Content-Length"] !== String(file.size)
    || registration.headers["Content-MD5"] !== contentMd5
    || registration.headers["Content-Type"] !== contentType
    || registration.headers["x-cos-meta-md5"] !== contentMd5) {
    throw new Error("invalid_storage_registration");
  }
  await putFile(registration, file, onProgress);
  const confirmationResponse = await fetch(`/api/contracts/${contractId}/confirm-upload`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ file_id: registration.file_id }),
  });
  if (!confirmationResponse.ok) {
    throw await responseError(confirmationResponse, "storage_confirmation_failed");
  }
  return registration.file_id;
}
