import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { checkToolchain } from "../scripts/check-toolchain.mjs";

function withFixture(callback) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sam67-toolchain-"));
  try {
    fs.mkdirSync(path.join(root, ".github", "workflows"), { recursive: true });
    fs.writeFileSync(path.join(root, ".nvmrc"), "24.18.0\n");
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({
      packageManager: "npm@11.16.0",
      engines: {
        node: "24.18.0",
        npm: "11.16.0",
      },
    }));
    fs.writeFileSync(
      path.join(root, ".github", "workflows", "ci.yml"),
      "steps:\n  - uses: actions/setup-node@v4\n    with:\n      node-version: '24.18.0'\n",
    );
    callback(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("SAM-67 accepts one exact, consistent Node and npm toolchain", () => {
  withFixture((root) => {
    assert.deepEqual(
      checkToolchain({ root, actualNode: "24.18.0", actualNpm: "11.16.0" }),
      { node: "24.18.0", npm: "11.16.0" },
    );
  });
});

test("SAM-67 fails closed on floating, inconsistent, or unavailable toolchains", async (t) => {
  await t.test("rejects a floating Node engine", () => {
    withFixture((root) => {
      const packagePath = path.join(root, "package.json");
      const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8"));
      packageJson.engines.node = ">=24";
      fs.writeFileSync(packagePath, JSON.stringify(packageJson));
      assert.throws(
        () => checkToolchain({ root, actualNode: "24.18.0", actualNpm: "11.16.0" }),
        /engines\.node must be one exact/,
      );
    });
  });

  await t.test("rejects CI drift", () => {
    withFixture((root) => {
      fs.writeFileSync(
        path.join(root, ".github", "workflows", "ci.yml"),
        "node-version: '24'\n",
      );
      assert.throws(
        () => checkToolchain({ root, actualNode: "24.18.0", actualNpm: "11.16.0" }),
        /exactly one node-version pinned/,
      );
    });
  });

  await t.test("rejects runtime npm drift", () => {
    withFixture((root) => {
      assert.throws(
        () => checkToolchain({ root, actualNode: "24.18.0", actualNpm: "11.15.0" }),
        /Runtime npm 11\.15\.0 does not equal pinned npm 11\.16\.0/,
      );
    });
  });

  await t.test("rejects an unreadable npm runtime", () => {
    withFixture((root) => {
      assert.throws(
        () => checkToolchain({
          root,
          actualNode: "24.18.0",
          run: () => ({ status: 1, stdout: undefined, stderr: "spawn failed" }),
        }),
        /Unable to determine runtime npm version: spawn failed/,
      );
    });
  });
});
