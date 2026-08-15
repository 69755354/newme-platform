#!/usr/bin/env node

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RELEASE_SHA = /^[0-9a-f]{40}$/;
const UUID_EVENT = /^[A-Za-z0-9][A-Za-z0-9._:/-]{5,255}$/;
const UTC_SECOND = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/;
const ALERT_SOURCE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const ALERT_LEVEL = /^(critical|warning|info)$/;
const CONFIG_FILE = "/etc/newme/postdeploy-alert-provider-v1.json";
const ACCEPTANCE_INPUT_FILE = "/etc/newme/postdeploy-acceptance-credentials-v1.json";
const INBOX_ROOT = "/var/lib/newme/postdeploy-alert-inbox-v1";
const ALERT_PIPELINE_VERSION = "newme-alert-state-notifier-provider/v1";

class ProviderError extends Error {}
const refuse = (code) => { throw new ProviderError(code); };
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const utcSecond = (value) => new Date(value).toISOString().replace(/\.\d{3}Z$/, "Z");

function exactKeys(value, expected, code) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) refuse(code);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) refuse(code);
}

function safeRead(filePath, label, maximumBytes = 1024 * 1024) {
  let cursor = path.dirname(path.resolve(filePath));
  while (true) {
    const ancestor = lstatSync(cursor);
    if (!ancestor.isDirectory() || ancestor.isSymbolicLink() || ancestor.uid !== 0 || ancestor.gid !== 0 || (ancestor.mode & 0o022) !== 0) {
      refuse(`${label}_ancestor_untrusted`);
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  const descriptor = openSync(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = fstatSync(descriptor);
    if (!before.isFile() || before.uid !== 0 || before.gid !== 0 || ![0o400, 0o600].includes(before.mode & 0o777) || before.size > maximumBytes) {
      refuse(`${label}_untrusted`);
    }
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
      refuse(`${label}_changed_during_read`);
    }
    return bytes;
  } finally {
    closeSync(descriptor);
  }
}

function parseJson(bytes, code) {
  try {
    const value = JSON.parse(bytes.toString("utf8"));
    if (value === null || typeof value !== "object" || Array.isArray(value)) refuse(code);
    return value;
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    refuse(code);
  }
}

function protectedConfig() {
  const config = parseJson(safeRead(CONFIG_FILE, "provider_config", 64 * 1024), "provider_config_invalid");
  exactKeys(config, ["provider_version", "bot_token", "chat_id", "bot_user_id"], "provider_config_shape_invalid");
  if (
    config.provider_version !== "newme-alert-provider-telegram/v1"
    || typeof config.bot_token !== "string"
    || !/^\d{6,16}:[A-Za-z0-9_-]{20,128}$/.test(config.bot_token)
    || !/^-?[1-9]\d{4,20}$/.test(String(config.chat_id))
    || !/^[1-9]\d{4,20}$/.test(String(config.bot_user_id))
  ) refuse("provider_config_semantic_invalid");
  return config;
}

function requireRoot() {
  if (typeof process.getuid !== "function" || process.getuid() !== 0) refuse("provider_writer_requires_root");
}

function receiptSecret() {
  const credentials = parseJson(safeRead(ACCEPTANCE_INPUT_FILE, "acceptance_credentials", 1024 * 1024), "acceptance_credentials_invalid");
  exactKeys(credentials, ["credentials_version", "accounts", "alert_receipt_hmac_secret_b64"], "acceptance_credentials_shape_invalid");
  if (credentials.credentials_version !== "newme-postdeploy-credentials/v1") refuse("acceptance_credentials_version_invalid");
  const secret = Buffer.from(credentials.alert_receipt_hmac_secret_b64, "base64");
  if (secret.length < 32 || secret.length > 128) refuse("acceptance_receipt_secret_invalid");
  return secret;
}

function readTrigger(mode, releaseSha) {
  const name = mode === "readback" ? "readback-trigger.json" : `${mode}-trigger.json`;
  const bytes = safeRead(path.join(INBOX_ROOT, releaseSha, name), `${mode}_trigger`, 64 * 1024);
  const trigger = parseJson(bytes, `${mode}_trigger_invalid`);
  const expectedKeys = mode === "readback"
    ? ["trigger_version", "release_sha", "event_type", "trigger_id", "triggered_at", "recovery_event_id"]
    : ["trigger_version", "pipeline_version", "alert_key", "release_sha", "event_type", "trigger_id", "triggered_at"];
  exactKeys(trigger, expectedKeys, `${mode}_trigger_shape_invalid`);
  if (
    trigger.trigger_version !== (mode === "readback" ? "newme-alert-readback-trigger/v1" : "newme-alert-trigger/v1")
    || trigger.release_sha !== releaseSha
    || trigger.event_type !== mode
    || (mode !== "readback" && trigger.pipeline_version !== ALERT_PIPELINE_VERSION)
    || (mode !== "readback" && trigger.alert_key !== `postdeploy-acceptance-${releaseSha}`)
    || !UUID_EVENT.test(trigger.trigger_id)
    || !UTC_SECOND.test(trigger.triggered_at)
    || (mode === "readback" && !UUID_EVENT.test(trigger.recovery_event_id))
  ) refuse(`${mode}_trigger_semantic_invalid`);
  return { trigger, triggerSha256: sha256(bytes) };
}

async function providerRequest(config, method, body = undefined) {
  let response;
  try {
    response = await fetch(`https://api.telegram.org/bot${config.bot_token}/${method}`, {
      method: body === undefined ? "GET" : "POST",
      headers: body === undefined ? { accept: "application/json" } : { accept: "application/json", "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    refuse("provider_request_failed");
  }
  let parsed;
  try {
    parsed = await response.json();
  } catch {
    refuse("provider_response_invalid");
  }
  if (response.status !== 200 || parsed?.ok !== true || parsed.result === undefined) refuse("provider_response_refused");
  return parsed.result;
}

async function verifyProviderIdentity(config, request = providerRequest) {
  const identity = await request(config, "getMe");
  if (String(identity?.id ?? "") !== String(config.bot_user_id) || identity?.is_bot !== true) {
    refuse("provider_identity_mismatch");
  }
}

export async function deliverOperationalNotification({
  config,
  event,
  source,
  detail,
  level,
  request = providerRequest,
}) {
  if (
    !["alert", "recovery"].includes(event)
    || !ALERT_SOURCE.test(source)
    || !ALERT_LEVEL.test(level)
    || typeof detail !== "string"
    || Buffer.byteLength(detail, "utf8") > 1024
    || /[\u0000-\u001f\u007f-\u009f]/u.test(detail)
  ) refuse("provider_notify_usage_invalid");
  await verifyProviderIdentity(config, request);
  const text = `NewMe ${event} source=${source} level=${level} detail=${detail || "-"}`;
  const requestedAt = Date.now();
  const delivered = await request(config, "sendMessage", { chat_id: config.chat_id, text });
  if (
    !Number.isSafeInteger(delivered?.message_id)
    || delivered.message_id < 1
    || String(delivered?.chat?.id ?? "") !== String(config.chat_id)
    || String(delivered?.from?.id ?? "") !== String(config.bot_user_id)
    || delivered?.text !== text
    || !Number.isSafeInteger(delivered?.date)
  ) refuse("provider_delivery_readback_mismatch");
  const occurredAt = utcSecond(delivered.date * 1000);
  if (Date.parse(occurredAt) < requestedAt - 5000 || Date.parse(occurredAt) > Date.now() + 5000) {
    refuse("provider_delivery_readback_mismatch");
  }
  return {
    event,
    source,
    providerDeliveryId: `telegram:message:${delivered.message_id}`,
    occurredAt,
  };
}

export async function produceOperationalNotification(event, source, detail, level) {
  requireRoot();
  return deliverOperationalNotification({ config: protectedConfig(), event, source, detail, level });
}

function lstatExists(filePath) {
  try {
    lstatSync(filePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function readExactRegularFile(filePath, code) {
  const metadata = lstatSync(filePath);
  if (!metadata.isFile() || metadata.isSymbolicLink()) refuse(code);
  return readFileSync(filePath);
}

function writeExclusiveTemporary(filePath, bytes) {
  const descriptor = openSync(filePath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try {
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function fsyncDirectory(directory) {
  const descriptor = openSync(directory, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0));
  try {
    try {
      fsyncSync(descriptor);
    } catch (error) {
      if (!(process.platform === "win32" && error?.code === "EPERM")) throw error;
    }
  } finally {
    closeSync(descriptor);
  }
}

export function persistProviderReceiptPair(directory, name, bodyBytes, signatureBytes, { afterBodyCommit } = {}) {
  const bodyPath = path.join(directory, `${name}.json`);
  const signaturePath = path.join(directory, `${name}.hmac`);
  const nonce = `${process.pid}-${Date.now()}`;
  const bodyTemporary = `${bodyPath}.tmp-${nonce}`;
  const signatureTemporary = `${signaturePath}.tmp-${nonce}`;
  const bodyExists = lstatExists(bodyPath);
  const signatureExists = lstatExists(signaturePath);
  if (signatureExists && !bodyExists) refuse("provider_receipt_signature_without_body");
  if (bodyExists) {
    const existingBody = readExactRegularFile(bodyPath, "provider_receipt_body_untrusted");
    if (!existingBody.equals(bodyBytes)) refuse("provider_receipt_body_conflict");
    if (signatureExists) {
      const existingSignature = readExactRegularFile(signaturePath, "provider_receipt_signature_untrusted");
      if (!existingSignature.equals(signatureBytes)) refuse("provider_receipt_signature_conflict");
      return "existing";
    }
    try {
      writeExclusiveTemporary(signatureTemporary, signatureBytes);
      renameSync(signatureTemporary, signaturePath);
      fsyncDirectory(directory);
      return "recovered";
    } catch (error) {
      if (lstatExists(signatureTemporary)) unlinkSync(signatureTemporary);
      throw error;
    }
  }
  try {
    writeExclusiveTemporary(bodyTemporary, bodyBytes);
    renameSync(bodyTemporary, bodyPath);
    fsyncDirectory(directory);
    afterBodyCommit?.();
    writeExclusiveTemporary(signatureTemporary, signatureBytes);
    renameSync(signatureTemporary, signaturePath);
    fsyncDirectory(directory);
    return "created";
  } catch (error) {
    if (lstatExists(bodyTemporary)) unlinkSync(bodyTemporary);
    if (lstatExists(signatureTemporary)) unlinkSync(signatureTemporary);
    throw error;
  }
}

function validateExistingReceipt(receipt, { mode, releaseSha, triggerSha256 }) {
  exactKeys(receipt, [
    "receipt_version",
    "source",
    "release_sha",
    "trigger_sha256",
    "event_type",
    "event_id",
    "provider_delivery_id",
    "provider_operation_id",
    "occurred_at",
    "status",
  ], "provider_receipt_shape_invalid");
  const delivery = /^telegram:message:([1-9][0-9]*)$/.exec(receipt.provider_delivery_id ?? "");
  const operation = mode === "readback"
    ? /^telegram:edit:[1-9][0-9]*:[1-9][0-9]*$/
    : /^telegram:send:[1-9][0-9]*$/;
  if (
    receipt.receipt_version !== "newme-alert-provider-receipt/v1"
    || receipt.source !== "newme-l0-alert-drill"
    || receipt.release_sha !== releaseSha
    || receipt.trigger_sha256 !== triggerSha256
    || receipt.event_type !== mode
    || receipt.status !== (mode === "failure" ? "firing" : "ok")
    || !UUID_EVENT.test(receipt.event_id ?? "")
    || !delivery
    || !operation.test(receipt.provider_operation_id ?? "")
    || !UTC_SECOND.test(receipt.occurred_at ?? "")
  ) refuse("provider_receipt_semantic_invalid");
  return receipt;
}

function recoverExistingReceipt(mode, releaseSha, secret, triggerSha256) {
  const directory = path.join(INBOX_ROOT, releaseSha);
  const bodyPath = path.join(directory, `${mode}.json`);
  const signaturePath = path.join(directory, `${mode}.hmac`);
  const bodyExists = lstatExists(bodyPath);
  const signatureExists = lstatExists(signaturePath);
  if (!bodyExists && !signatureExists) return null;
  if (!bodyExists) refuse("provider_receipt_signature_without_body");
  const bodyBytes = safeRead(bodyPath, `${mode}_receipt`, 64 * 1024);
  const receipt = validateExistingReceipt(parseJson(bodyBytes, `${mode}_receipt_invalid`), {
    mode,
    releaseSha,
    triggerSha256,
  });
  const signatureBytes = Buffer.from(`${createHmac("sha256", secret).update(bodyBytes).digest("hex")}\n`, "ascii");
  if (signatureExists) {
    const supplied = safeRead(signaturePath, `${mode}_receipt_signature`, 4096);
    if (!supplied.equals(signatureBytes)) refuse("provider_receipt_signature_mismatch");
  } else {
    persistProviderReceiptPair(directory, mode, bodyBytes, signatureBytes);
  }
  return {
    eventId: receipt.event_id,
    providerDeliveryId: receipt.provider_delivery_id,
    providerOperationId: receipt.provider_operation_id,
    triggerSha256,
  };
}

function publishDeliveryIntent(mode, releaseSha, triggerSha256) {
  const directory = path.join(INBOX_ROOT, releaseSha);
  const intentPath = path.join(directory, `${mode}.intent.json`);
  const intentBytes = Buffer.from(`${JSON.stringify({
    intent_version: "newme-alert-provider-intent/v1",
    release_sha: releaseSha,
    event_type: mode,
    trigger_sha256: triggerSha256,
  })}\n`, "utf8");
  if (lstatExists(intentPath)) {
    const existing = safeRead(intentPath, `${mode}_delivery_intent`, 4096);
    if (!existing.equals(intentBytes)) refuse("provider_delivery_intent_conflict");
    refuse("provider_delivery_outcome_unknown");
  }
  const temporary = `${intentPath}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeExclusiveTemporary(temporary, intentBytes);
    renameSync(temporary, intentPath);
    fsyncDirectory(directory);
  } catch (error) {
    if (lstatExists(temporary)) unlinkSync(temporary);
    throw error;
  }
}

function readRecoveryReceipt(releaseSha, secret) {
  const directory = path.join(INBOX_ROOT, releaseSha);
  const body = safeRead(path.join(directory, "recovery.json"), "recovery_receipt", 64 * 1024);
  const signatureText = safeRead(path.join(directory, "recovery.hmac"), "recovery_receipt_signature", 4096).toString("ascii").trim();
  if (!/^[0-9a-f]{64}$/.test(signatureText)) refuse("recovery_receipt_signature_invalid");
  const supplied = Buffer.from(signatureText, "hex");
  const expected = createHmac("sha256", secret).update(body).digest();
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) refuse("recovery_receipt_signature_mismatch");
  const receipt = parseJson(body, "recovery_receipt_invalid");
  exactKeys(receipt, [
    "receipt_version",
    "source",
    "release_sha",
    "trigger_sha256",
    "event_type",
    "event_id",
    "provider_delivery_id",
    "provider_operation_id",
    "occurred_at",
    "status",
  ], "recovery_receipt_shape_invalid");
  const message = /^telegram:message:([1-9][0-9]*)$/.exec(receipt.provider_delivery_id ?? "");
  if (
    receipt.receipt_version !== "newme-alert-provider-receipt/v1"
    || receipt.source !== "newme-l0-alert-drill"
    || receipt.release_sha !== releaseSha
    || receipt.event_type !== "recovery"
    || receipt.status !== "ok"
    || !UUID_EVENT.test(receipt.event_id ?? "")
    || !UUID_EVENT.test(receipt.provider_operation_id ?? "")
    || !UTC_SECOND.test(receipt.occurred_at ?? "")
    || !message
  ) refuse("recovery_receipt_semantic_invalid");
  return { receipt, messageId: Number(message[1]) };
}

export async function produceProviderReceipt(mode, releaseSha) {
  requireRoot();
  if (!RELEASE_SHA.test(releaseSha) || !["failure", "recovery", "readback"].includes(mode)) refuse("provider_writer_usage_invalid");
  const secret = receiptSecret();
  const { trigger, triggerSha256 } = readTrigger(mode, releaseSha);
  const recovered = recoverExistingReceipt(mode, releaseSha, secret, triggerSha256);
  if (recovered) return recovered;
  publishDeliveryIntent(mode, releaseSha, triggerSha256);
  const config = protectedConfig();
  await verifyProviderIdentity(config);
  let eventId;
  let providerDeliveryId;
  let providerOperationId;
  let text;
  let delivered;
  if (mode === "readback") {
    const recovery = readRecoveryReceipt(releaseSha, secret);
    if (recovery.receipt.event_id !== trigger.recovery_event_id) refuse("readback_recovery_event_mismatch");
    const recoveryTrigger = readTrigger("recovery", releaseSha);
    if (recovery.receipt.trigger_sha256 !== recoveryTrigger.triggerSha256) refuse("readback_recovery_trigger_mismatch");
    text = `NewMe postdeploy recovery release=${releaseSha.slice(0, 12)} challenge=${recoveryTrigger.triggerSha256} readback=${triggerSha256}`;
    delivered = await providerRequest(config, "editMessageText", {
      chat_id: config.chat_id,
      message_id: recovery.messageId,
      text,
    });
    eventId = recovery.receipt.event_id;
    providerDeliveryId = recovery.receipt.provider_delivery_id;
  } else {
    text = `NewMe postdeploy ${mode} release=${releaseSha.slice(0, 12)} challenge=${triggerSha256}`;
    delivered = await providerRequest(config, "sendMessage", { chat_id: config.chat_id, text });
    eventId = `newme:alert:${mode}:${releaseSha.slice(0, 12)}:${delivered?.message_id}`;
    providerDeliveryId = `telegram:message:${delivered?.message_id}`;
  }
  if (
    !Number.isSafeInteger(delivered?.message_id)
    || String(delivered?.chat?.id ?? "") !== String(config.chat_id)
    || String(delivered?.from?.id ?? "") !== String(config.bot_user_id)
    || delivered?.text !== text
    || !Number.isSafeInteger(mode === "readback" ? delivered?.edit_date : delivered?.date)
  ) refuse("provider_delivery_readback_mismatch");
  const providerTimestamp = mode === "readback" ? delivered.edit_date : delivered.date;
  const occurredAt = utcSecond(providerTimestamp * 1000);
  if (Date.parse(occurredAt) < Date.parse(trigger.triggered_at) || Date.parse(occurredAt) > Date.now() + 5000) {
    refuse("provider_delivery_time_invalid");
  }
  providerOperationId = mode === "readback"
    ? `telegram:edit:${delivered.message_id}:${providerTimestamp}`
    : `telegram:send:${delivered.message_id}`;
  const receipt = {
    receipt_version: "newme-alert-provider-receipt/v1",
    source: "newme-l0-alert-drill",
    release_sha: releaseSha,
    trigger_sha256: triggerSha256,
    event_type: mode,
    event_id: eventId,
    provider_delivery_id: providerDeliveryId,
    provider_operation_id: providerOperationId,
    occurred_at: occurredAt,
    status: mode === "failure" ? "firing" : "ok",
  };
  const bodyBytes = Buffer.from(`${JSON.stringify(receipt)}\n`, "utf8");
  const signatureBytes = Buffer.from(`${createHmac("sha256", secret).update(bodyBytes).digest("hex")}\n`, "ascii");
  persistProviderReceiptPair(path.join(INBOX_ROOT, releaseSha), mode, bodyBytes, signatureBytes);
  return { eventId, providerDeliveryId: receipt.provider_delivery_id, providerOperationId, triggerSha256 };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length === 3 && process.argv[2] === "validate-config") {
      const config = protectedConfig();
      receiptSecret();
      await verifyProviderIdentity(config);
      process.stdout.write("newme alert provider configuration: valid\n");
      process.exit(0);
    }
    if (process.argv.length === 7 && process.argv[2] === "notify") {
      const result = await produceOperationalNotification(process.argv[3], process.argv[4], process.argv[5], process.argv[6]);
      process.stdout.write(`newme-alert-provider-v1 notify ${result.event} ${result.source} ${result.providerDeliveryId}\n`);
      process.exit(0);
    }
    if (process.argv.length !== 4) refuse("provider_writer_usage_invalid");
    const result = await produceProviderReceipt(process.argv[2], process.argv[3]);
    process.stdout.write(`newme-alert-provider-v1 receipt ${process.argv[2]} ${process.argv[3]} ${result.triggerSha256} ${result.providerDeliveryId}\n`);
  } catch (error) {
    console.error(`newme alert provider: refused code=${error instanceof ProviderError ? error.message : "unexpected_failure"}`);
    process.exit(1);
  }
}
