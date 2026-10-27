import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ORIGINAL = "886677432990a735e5ebdfb345ff1cbd40e264f9947a8432eeeb254b3a926bde";
const PATCHED = "1f503e07e1a7ca2889f8be8efbe5330f787f0febb7bd5ce024b7d7b103bf4470";
const digest = (source) => createHash("sha256").update(source).digest("hex");

// The verified 16.4.1 npm tarball is documented in docs/security/next-eslint-glob.md.
// tinyglobby's default relative output differs on cross-volume Windows paths.
// Explicit absolute paths preserve the directory consumers' path.join/existsSync
// behavior; expandDirectories:false preserves fast-glob's literal-root behavior.
// No Next lint rule or source is removed.
export function patchRootGlobSource(source) {
  const hash = digest(source);
  if (hash === PATCHED) return source;
  if (hash !== ORIGINAL) throw new Error("Unrecognized Next ESLint root helper; review the compatibility patch before installing");
  const patched = source.replace("onlyDirectories: true\n", "onlyDirectories: true,\n        absolute: true,\n        expandDirectories: false\n");
  if (digest(patched) !== PATCHED) throw new Error("Next ESLint root helper patch hash mismatch");
  return patched;
}

export function applyNextEslintGlobPatch(root = ROOT) {
  const manifest = path.join(root, "node_modules", "@next", "eslint-plugin-next", "package.json");
  // Runtime-only installs can omit dev dependencies; there is then no lint
  // helper or vulnerable development chain to patch.
  if (!existsSync(manifest)) return "Next ESLint dev tooling absent; no patch needed";
  const plugin = JSON.parse(readFileSync(manifest, "utf8"));
  if (plugin.name !== "@next/eslint-plugin-next" || plugin.version !== "16.4.1") {
    throw new Error("Next ESLint version changed; review the compatibility patch before installing");
  }
  const require = createRequire(manifest);
  const alias = require("fast-glob/package.json");
  if (alias.name !== "tinyglobby" || alias.version !== "0.2.17") throw new Error("Next ESLint glob alias is not the reviewed tinyglobby version");
  const helper = path.join(path.dirname(manifest), "dist", "utils", "get-root-dirs.js");
  const source = readFileSync(helper, "utf8");
  const patched = patchRootGlobSource(source);
  if (source !== patched) writeFileSync(helper, patched);
  return "Next ESLint glob compatibility patch verified";
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    console.log(applyNextEslintGlobPatch());
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
