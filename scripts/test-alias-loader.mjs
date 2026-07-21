import { pathToFileURL, fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { resolve as pathResolve, dirname } from "node:path";

const ROOT = process.cwd();

function candidateFiles(absPath) {
  return [
    absPath,
    absPath + ".ts",
    absPath + ".tsx",
    absPath + ".mjs",
    absPath + ".js",
    pathResolve(absPath, "index.ts"),
    pathResolve(absPath, "index.tsx"),
    pathResolve(absPath, "index.mjs"),
  ];
}

function firstExisting(candidates) {
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

export async function resolve(specifier, context, nextResolve) {
  // Next.js subpath imports need .js extension for ESM resolution
  if (specifier.startsWith("next/") && !specifier.endsWith(".js")) {
    try {
      return nextResolve(specifier + ".js", context);
    } catch {
      // fall through to default
    }
  }

  if (specifier.startsWith("@/")) {
    const sub = specifier.slice(2);
    const abs = pathResolve(ROOT, "src", sub);
    const found = firstExisting(candidateFiles(abs));
    if (found) {
      return { url: pathToFileURL(found).href, shortCircuit: true };
    }
  }

  if (
    specifier.endsWith(".js") &&
    (specifier.startsWith("./") || specifier.startsWith("../") || specifier.startsWith("file:"))
  ) {
    const baseDir = context.parentURL ? dirname(fileURLToPath(context.parentURL)) : ROOT;
    const absBase = specifier.startsWith("file:")
      ? fileURLToPath(specifier)
      : pathResolve(baseDir, specifier);
    const withoutExt = absBase.slice(0, -3);
    const found = firstExisting([
      withoutExt + ".ts",
      withoutExt + ".tsx",
      withoutExt + ".mjs",
      absBase,
    ]);
    if (found) {
      return { url: pathToFileURL(found).href, shortCircuit: true };
    }
  }

  return nextResolve(specifier, context);
}
