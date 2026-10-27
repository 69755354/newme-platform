import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { installReviewedArtifact } from "../../scripts/install-reviewed-artifact.mjs";

function artifactFor(bytes, sha256 = createHash("sha256").update(bytes).digest("hex")) {
  return {
    id: "supabase-cli-linux-amd64",
    version: "1.2.3",
    asset_name: "supabase_1.2.3_linux_amd64.tar.gz",
    url: "https://github.com/supabase/cli/releases/download/v1.2.3/supabase_1.2.3_linux_amd64.tar.gz",
    sha256,
  };
}

test("reviewed artifact bytes are hash-verified before the same archive path is extracted", async (t) => {
  const runnerTemp = await mkdtemp(path.join(os.tmpdir(), "newme-reviewed-artifact-"));
  t.after(() => rm(runnerTemp, { recursive: true, force: true }));
  const bytes = Buffer.from("reviewed-supabase-cli-archive");
  const destination = path.join(runnerTemp, "newme-supabase-cli");
  let extracted = false;

  const binary = await installReviewedArtifact({
    artifact: artifactFor(bytes),
    destination,
    runnerTemp,
    fetchImpl: async () => new Response(bytes, {
      status: 200,
      headers: { "content-length": String(bytes.length) },
    }),
    extractImpl: async (archivePath, extractDestination) => {
      extracted = true;
      assert.equal(archivePath, path.join(destination, "supabase_1.2.3_linux_amd64.tar.gz"));
      assert.equal(extractDestination, destination);
      assert.deepEqual(await readFile(archivePath), bytes);
      await writeFile(path.join(extractDestination, "supabase"), "verified binary");
    },
  });

  assert.equal(extracted, true);
  assert.equal(binary, path.join(destination, "supabase"));
});

test("digest mismatch, redirect escape, and destination escape fail before extraction", async (t) => {
  const runnerTemp = await mkdtemp(path.join(os.tmpdir(), "newme-reviewed-artifact-negative-"));
  t.after(() => rm(runnerTemp, { recursive: true, force: true }));
  const bytes = Buffer.from("different bytes");
  let extracted = false;

  await assert.rejects(
    installReviewedArtifact({
      artifact: artifactFor(bytes, "0".repeat(64)),
      destination: path.join(runnerTemp, "newme-supabase-cli"),
      runnerTemp,
      fetchImpl: async () => new Response(bytes, { status: 200 }),
      extractImpl: async () => { extracted = true; },
    }),
    /SHA-256 does not match/,
  );
  assert.equal(extracted, false);

  const redirectRunner = await mkdtemp(path.join(os.tmpdir(), "newme-reviewed-artifact-redirect-"));
  t.after(() => rm(redirectRunner, { recursive: true, force: true }));
  await assert.rejects(
    installReviewedArtifact({
      artifact: artifactFor(bytes),
      destination: path.join(redirectRunner, "newme-supabase-cli"),
      runnerTemp: redirectRunner,
      fetchImpl: async () => new Response(null, {
        status: 302,
        headers: { location: "https://attacker.invalid/archive" },
      }),
      extractImpl: async () => { extracted = true; },
    }),
    /left the approved HTTPS hosts/,
  );
  assert.equal(extracted, false);

  await assert.rejects(
    installReviewedArtifact({
      artifact: artifactFor(bytes),
      destination: path.join(runnerTemp, "escape"),
      runnerTemp,
      fetchImpl: async () => new Response(bytes, { status: 200 }),
      extractImpl: async () => { extracted = true; },
    }),
    /fixed runner-temporary directory/,
  );
  assert.equal(extracted, false);
});
