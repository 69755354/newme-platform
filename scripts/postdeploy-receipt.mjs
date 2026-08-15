import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as signBytes,
  verify as verifyBytes,
} from "node:crypto";

export const RECEIPT_VERSION = "newme-postdeploy-receipt/v1";
export const RECEIPT_ALGORITHM = "Ed25519";

function fail(message) {
  throw new Error(message);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, keys, label) {
  if (!isObject(value)) fail(`${label} must be an object`);
  const expected = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!expected.has(key)) fail(`${label} contains unknown property ${JSON.stringify(key)}`);
  }
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) fail(`${label}.${key} is required`);
  }
}

function canonicalValue(value, label) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map((item, index) => canonicalValue(item, `${label}[${index}]`));
  if (!isObject(value)) fail(`${label} contains a value that JSON cannot canonically encode`);
  const result = {};
  for (const key of Object.keys(value).sort()) result[key] = canonicalValue(value[key], `${label}.${key}`);
  return result;
}

export function canonicalJsonBytes(value) {
  return Buffer.from(JSON.stringify(canonicalValue(value, "receipt")), "utf8");
}

function publicKeyObject(bytes, label = "receipt public key") {
  let key;
  try {
    key = createPublicKey(bytes);
  } catch {
    fail(`${label} is not a valid public key`);
  }
  if (key.asymmetricKeyType !== "ed25519") fail(`${label} must be an Ed25519 public key`);
  return key;
}

export function receiptPublicKeySha256(publicKeyBytes) {
  const der = publicKeyObject(publicKeyBytes).export({ type: "spki", format: "der" });
  return createHash("sha256").update(der).digest("hex");
}

function unsignedArtifact(document) {
  exactKeys(document, ["artifact_version", "kind", "release", "observed_at", "payload", "receipt"], "signed artifact");
  return {
    artifact_version: document.artifact_version,
    kind: document.kind,
    release: document.release,
    observed_at: document.observed_at,
    payload: document.payload,
  };
}

function signatureInput(document) {
  const artifact = unsignedArtifact(document);
  exactKeys(document.receipt, ["receipt_version", "algorithm", "producer", "key_sha256", "signed_at", "signature"], "signed artifact.receipt");
  return canonicalJsonBytes({
    receipt_version: document.receipt.receipt_version,
    algorithm: document.receipt.algorithm,
    producer: document.receipt.producer,
    key_sha256: document.receipt.key_sha256,
    signed_at: document.receipt.signed_at,
    artifact,
  });
}

export function signPostdeployArtifact({ artifact, producer, signedAt, privateKeyBytes }) {
  exactKeys(artifact, ["artifact_version", "kind", "release", "observed_at", "payload"], "artifact");
  let privateKey;
  try {
    privateKey = createPrivateKey(privateKeyBytes);
  } catch {
    fail("receipt private key is not a valid private key");
  }
  if (privateKey.asymmetricKeyType !== "ed25519") fail("receipt private key must be an Ed25519 private key");
  const publicKey = createPublicKey(privateKey);
  const publicKeyDer = publicKey.export({ type: "spki", format: "der" });
  const keySha256 = createHash("sha256").update(publicKeyDer).digest("hex");
  const document = {
    ...structuredClone(artifact),
    receipt: {
      receipt_version: RECEIPT_VERSION,
      algorithm: RECEIPT_ALGORITHM,
      producer,
      key_sha256: keySha256,
      signed_at: signedAt,
      signature: "",
    },
  };
  document.receipt.signature = signBytes(null, signatureInput(document), privateKey).toString("base64url");
  return document;
}

export function verifyPostdeployArtifactReceipt({ document, publicKeyBytes, expectedProducer }) {
  const key = publicKeyObject(publicKeyBytes);
  const keySha256 = receiptPublicKeySha256(publicKeyBytes);
  const receipt = document?.receipt;
  exactKeys(receipt, ["receipt_version", "algorithm", "producer", "key_sha256", "signed_at", "signature"], "signed artifact.receipt");
  if (receipt.receipt_version !== RECEIPT_VERSION) fail("signed artifact receipt_version is not supported");
  if (receipt.algorithm !== RECEIPT_ALGORITHM) fail("signed artifact receipt algorithm is not Ed25519");
  if (receipt.producer !== expectedProducer) fail("signed artifact receipt producer is not canonical for its kind");
  if (receipt.key_sha256 !== keySha256) fail("signed artifact receipt key digest does not match the protected public key");
  if (typeof receipt.signature !== "string" || !/^[A-Za-z0-9_-]{86}$/.test(receipt.signature)) {
    fail("signed artifact receipt signature has an invalid format");
  }
  let signature;
  try {
    signature = Buffer.from(receipt.signature, "base64url");
  } catch {
    fail("signed artifact receipt signature is not valid base64url");
  }
  if (signature.length !== 64 || !verifyBytes(null, signatureInput(document), key, signature)) {
    fail("signed artifact receipt signature verification failed");
  }
  return { keySha256, signedAt: receipt.signed_at };
}
