import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../src/types/database.ts", import.meta.url), "utf8");
const required = [
  "export type Database =",
  "profiles:",
  "leads:",
  "allocate_payment:",
  "confirm_payment:",
  "transition_lead_stage:",
];
const missing = required.filter((token) => !source.includes(token));
if (missing.length) {
  console.error(`Database type source is incomplete: ${missing.join(", ")}`);
  process.exit(1);
}
console.log("Database type source gate passed");
