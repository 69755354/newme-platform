import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  checkCriticalFolderLintZero,
  CRITICAL_LINT_ZERO_SCOPE,
} from "../scripts/check-critical-folder-lint-zero.mjs";

function withFixture(callback) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "critical-lint-zero-"));
  fs.mkdirSync(path.join(root, ...CRITICAL_LINT_ZERO_SCOPE.split("/")), { recursive: true });
  const eslintBin = path.join(root, "node_modules", "eslint", "bin", "eslint.js");
  fs.mkdirSync(path.dirname(eslintBin), { recursive: true });
  fs.writeFileSync(eslintBin, "");
  try {
    return callback(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function eslintResult({ errors = 0, warnings = 0, status = errors || warnings ? 1 : 0 } = {}) {
  return {
    status,
    stdout: JSON.stringify([{
      filePath: "src/app/api/cos/download-url/route.ts",
      errorCount: errors,
      warningCount: warnings,
      messages: [],
    }]),
    stderr: "",
  };
}

test("SAM-67 locks the COS download security boundary to zero lint findings", () => {
  withFixture((root) => {
    const calls = [];
    const result = checkCriticalFolderLintZero({
      root,
      run: (command, args) => {
        calls.push({ command, args });
        return eslintResult();
      },
      log: () => {},
      error: () => {},
    });

    assert.deepEqual(result, { exitCode: 0, errors: 0, warnings: 0 });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].command, process.execPath);
    assert.deepEqual(
      calls[0].args.slice(1),
      [CRITICAL_LINT_ZERO_SCOPE, "--format", "json", "--max-warnings", "0"],
    );
  });
});

test("SAM-67 lint-zero gate fails closed on a reintroduced error or warning", () => {
  withFixture((root) => {
    for (const finding of [{ errors: 1 }, { warnings: 1 }]) {
      const result = checkCriticalFolderLintZero({
        root,
        run: () => eslintResult(finding),
        log: () => {},
        error: () => {},
      });
      assert.equal(result.exitCode, 1);
    }
  });
});

test("SAM-67 lint-zero gate fails closed when the locked directory disappears", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "critical-lint-zero-missing-"));
  try {
    assert.throws(
      () => checkCriticalFolderLintZero({ root, run: () => eslintResult() }),
      /locked lint-zero scope is missing/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
