#!/usr/bin/env node

import { lstat, readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { evidenceSchemas, schemaNames } from "./schemas.mjs";
import {
  V4ValidationError,
  validateEvidenceDocument,
  validatePreparationBundle,
} from "./validators.mjs";

const MAX_INPUT_BYTES = 1024 * 1024;

function usage() {
  return [
    "usage:",
    "  node scripts/v4-rehearsal-kit/cli.mjs schema <schema-name>",
    "  node scripts/v4-rehearsal-kit/cli.mjs validate-document <schema-name> <aggregate-json-file>",
    "  node scripts/v4-rehearsal-kit/cli.mjs validate-template <bundle-json-file>",
    "  node scripts/v4-rehearsal-kit/cli.mjs validate-evidence <bundle-json-file>",
    `schema names: ${schemaNames.join(", ")}`,
  ].join("\n");
}

async function readAggregateJson(path) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new V4ValidationError("input_must_be_regular_file");
  if (stat.size <= 0 || stat.size > MAX_INPUT_BYTES) throw new V4ValidationError("input_size_invalid");
  const text = await readFile(path, "utf8");
  try {
    return JSON.parse(text);
  } catch {
    throw new V4ValidationError("input_json_invalid");
  }
}

export async function runCli(args) {
  const [command, ...rest] = args;
  if (command === "schema" && rest.length === 1) {
    const schema = evidenceSchemas[rest[0]];
    if (!schema) throw new V4ValidationError("unknown_schema");
    return schema;
  }
  if (command === "validate-document" && rest.length === 2) {
    return validateEvidenceDocument(rest[0], await readAggregateJson(rest[1]));
  }
  if (["validate-template", "validate-evidence"].includes(command) && rest.length === 1) {
    return validatePreparationBundle(await readAggregateJson(rest[0]), {
      expectedMode: command === "validate-template" ? "template" : "evidence",
    });
  }
  const error = new V4ValidationError("usage_invalid");
  error.exitCode = 64;
  throw error;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  runCli(process.argv.slice(2)).then(
    (result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`),
    (error) => {
      const code = error instanceof V4ValidationError ? error.code : "unexpected_failure";
      process.stderr.write(`V4 rehearsal kit validation failed: ${code}\n`);
      if (error?.code === "ENOENT") process.exitCode = 66;
      else process.exitCode = Number.isInteger(error?.exitCode) ? error.exitCode : 1;
      if (code === "usage_invalid") process.stderr.write(`${usage()}\n`);
    },
  );
}
// This module intentionally exposes validation only; it has no execution connector.
