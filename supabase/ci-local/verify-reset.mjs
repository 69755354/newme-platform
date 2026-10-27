import { execFileSync } from "node:child_process";

const container = "supabase_db_newme-ci-task-followup-v1";
const expected = "task-followup-ci-v1|1";
const query = [
  "select marker, count(*)",
  "from ci_gate.seed_markers",
  "group by marker",
  "order by marker",
].join(" ");

let actual;
try {
  actual = execFileSync(
    "docker",
    [
      "exec",
      container,
      "psql",
      "-X",
      "-U",
      "postgres",
      "-d",
      "postgres",
      "-Atqc",
      query,
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ).trim();
} catch (error) {
  console.error(`FAIL unable to query the isolated local DB container ${container}`);
  process.exit(1);
}

if (actual !== expected) {
  console.error(`FAIL expected seed marker ${expected}, got ${JSON.stringify(actual)}`);
  process.exit(1);
}

console.log(`PASS seed marker ${actual}`);
