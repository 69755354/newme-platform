import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

const require = createRequire(import.meta.url);
const yaml = require("js-yaml");
const workflowDirectory = path.resolve(".github", "workflows");
const files = fs.readdirSync(workflowDirectory)
  .filter((file) => file.endsWith(".yml") || file.endsWith(".yaml"))
  .sort();

if (files.length === 0) {
  console.error("FAIL no GitHub workflow YAML files found");
  process.exit(1);
}

for (const file of files) {
  const relative = path.posix.join(".github", "workflows", file);
  yaml.load(fs.readFileSync(path.join(workflowDirectory, file), "utf8"));
  console.log(`PASS ${relative}`);
}
