import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("archived staging source gets an ephemeral tracked-file index", async () => {
  const script = await readFile(
    new URL("../../scripts/run-staging-build.sh", import.meta.url),
    "utf8",
  );
  const archive = script.indexOf('git --git-dir="$REPOSITORY" archive "$SHA"');
  const init = script.indexOf('git -C "$WORK" init --quiet');
  const add = script.indexOf('git -C "$WORK" add --force --all');
  const build = script.indexOf("setsid runuser -u newme-staging");

  assert.ok(archive >= 0 && archive < init);
  assert.ok(init < add && add < build);
});
