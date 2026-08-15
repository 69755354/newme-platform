import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LOCK_PATH = path.join(ROOT, "infra", "ci", "provenance-lock.json");
const MAXIMUM_ARCHIVE_BYTES = 128 * 1024 * 1024;
const REDIRECT_HOSTS = new Set([
  "github.com",
  "release-assets.githubusercontent.com",
  "objects.githubusercontent.com",
]);

function assertArtifact(artifact) {
  if (!artifact || artifact.id !== "supabase-cli-linux-amd64") {
    throw new Error("only the reviewed Supabase CLI artifact may be installed");
  }
  const version = String(artifact.version || "");
  const assetName = `supabase_${version}_linux_amd64.tar.gz`;
  const expectedUrl = `https://github.com/supabase/cli/releases/download/v${version}/${assetName}`;
  if (!/^\d+\.\d+\.\d+$/.test(version)
    || artifact.asset_name !== assetName
    || artifact.url !== expectedUrl
    || !/^[0-9a-f]{64}$/.test(String(artifact.sha256))) {
    throw new Error("reviewed artifact metadata is invalid");
  }
}

async function fetchLockedArchive(url, fetchImpl) {
  let current = new URL(url);
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    if (current.protocol !== "https:" || !REDIRECT_HOSTS.has(current.hostname)) {
      throw new Error("artifact download left the approved HTTPS hosts");
    }
    const response = await fetchImpl(current, {
      redirect: "manual",
      headers: { "User-Agent": "newme-reviewed-artifact-installer" },
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location) throw new Error("artifact redirect omitted Location");
      current = new URL(location, current);
      continue;
    }
    if (!response.ok) throw new Error(`artifact download returned HTTP ${response.status}`);
    const declaredLength = response.headers.get("content-length");
    if (declaredLength && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > MAXIMUM_ARCHIVE_BYTES)) {
      throw new Error("artifact Content-Length is invalid or too large");
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length || bytes.length > MAXIMUM_ARCHIVE_BYTES) {
      throw new Error("artifact body is empty or too large");
    }
    if (declaredLength && Number(declaredLength) !== bytes.length) {
      throw new Error("artifact body length does not match Content-Length");
    }
    return bytes;
  }
  throw new Error("artifact download exceeded the redirect limit");
}

async function extractSupabase(archivePath, destination) {
  const result = spawnSync("tar", ["-xzf", archivePath, "-C", destination, "supabase"], {
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.error || result.status !== 0) throw new Error("reviewed Supabase CLI archive extraction failed");
}

export async function installReviewedArtifact({
  artifact,
  destination,
  runnerTemp,
  fetchImpl = globalThis.fetch,
  extractImpl = extractSupabase,
}) {
  assertArtifact(artifact);
  if (typeof fetchImpl !== "function") throw new Error("artifact installer has no fetch implementation");
  const resolvedRunnerTemp = path.resolve(String(runnerTemp || ""));
  const resolvedDestination = path.resolve(String(destination || ""));
  if (!path.isAbsolute(String(runnerTemp || ""))
    || resolvedDestination !== path.join(resolvedRunnerTemp, "newme-supabase-cli")) {
    throw new Error("artifact destination must be the fixed runner-temporary directory");
  }

  await mkdir(resolvedDestination, { recursive: false, mode: 0o700 });
  const bytes = await fetchLockedArchive(artifact.url, fetchImpl);
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== artifact.sha256) throw new Error("artifact SHA-256 does not match the provenance lock");

  const archivePath = path.join(resolvedDestination, artifact.asset_name);
  const archive = await open(archivePath, "wx", 0o600);
  try {
    await archive.writeFile(bytes);
    await archive.sync();
  } finally {
    await archive.close();
  }

  await extractImpl(archivePath, resolvedDestination);
  const binaryPath = path.join(resolvedDestination, "supabase");
  const stat = await lstat(binaryPath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("extracted Supabase CLI is not a regular file");
  await chmod(binaryPath, 0o755);
  return binaryPath;
}

async function main() {
  const [id] = process.argv.slice(2);
  if (id !== "supabase-cli-linux-amd64" || process.argv.length !== 3) {
    throw new Error("usage: node scripts/install-reviewed-artifact.mjs supabase-cli-linux-amd64");
  }
  const runnerTemp = process.env.RUNNER_TEMP;
  if (!runnerTemp) throw new Error("RUNNER_TEMP is required");
  const lock = JSON.parse(await readFile(LOCK_PATH, "utf8"));
  const matches = Array.isArray(lock.artifacts)
    ? lock.artifacts.filter((artifact) => artifact?.id === id)
    : [];
  if (matches.length !== 1) throw new Error("provenance lock must contain exactly one requested artifact");
  const destination = path.join(path.resolve(runnerTemp), "newme-supabase-cli");
  const binaryPath = await installReviewedArtifact({
    artifact: matches[0],
    destination,
    runnerTemp,
  });
  console.log(`[PASS] reviewed artifact installed at ${binaryPath}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[FAIL] reviewed artifact install failed: ${error.message}`);
    process.exitCode = 1;
  });
}
