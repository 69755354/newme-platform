import { createHmac } from "node:crypto";

/** Match webhook canonicalization, but require an explicit country code in UI input. */
export function deletionCustomerKey(phone, salt) {
  if (typeof phone !== "string" || typeof salt !== "string" || !salt) return null;
  const canonical = phone.trim().replace(/[ ()-]/g, "");
  if (!/^\+[1-9][0-9]{6,14}$/.test(canonical)) return null;
  return createHmac("sha256", salt).update(canonical.slice(1)).digest("hex");
}

export async function readDeletionInput(request) {
  if (Number(request.headers.get("content-length")) > 1024) return null;
  const reader = request.body?.getReader();
  if (!reader) return null;
  let size = 0; const chunks = [];
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      size += item.value.byteLength;
      if (size > 1024) { await reader.cancel(); return null; }
      chunks.push(item.value);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!body || Array.isArray(body) || Object.keys(body).sort().join(",") !== "phone,request_id,verified"
      || body.verified !== true || typeof body.phone !== "string"
      || typeof body.request_id !== "string"
      || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(body.request_id)) return null;
    return body;
  } catch { return null; }
}
