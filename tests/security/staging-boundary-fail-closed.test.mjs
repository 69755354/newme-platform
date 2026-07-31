import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const run = promisify(execFile);
const bash = process.platform === "win32"
  ? "C:\\Program Files\\Git\\bin\\bash.exe"
  : "bash";
const command = fileURLToPath(
  new URL("../../scripts/check-staging-boundaries.sh", import.meta.url),
);
const stagingRef = "bfsiibofuzoglziltgyd";
const productionRef = "vfopmpxlhwzpxqegayew";
const forbiddenIntegrations = [
  "SENTRY_ORG",
  "SENTRY_PROJECT",
  "META_APP_ID",
  "META_APP_SECRET",
  "META_CAPI_WEBHOOK_SECRET",
  "META_REDIRECT_URI",
  "NEXT_PUBLIC_POSTHOG_HOST",
  "NEXT_PUBLIC_POSTHOG_KEY",
  "COS_BUCKET",
  "COS_REGION",
  "COS_SECRET_ID",
  "COS_SECRET_KEY",
];

const environment = (directory, expectedRef) => ({
  ...process.env,
  NEWME_STAGING_BOUNDARY_MODE: "build",
  NEWME_STAGING_ENV_FILE: join(directory, "staging.env"),
  NEWME_STAGING_PROJECT_REF: expectedRef,
  SUPABASE_SERVICE_ROLE_KEY: "",
  SUPABASE_PAT: "",
  SUPABASE_DB_PASSWORD: "",
  SENTRY_AUTH_TOKEN: "",
  NEXT_PUBLIC_SENTRY_DSN: "",
  SENTRY_DSN: "",
  ...Object.fromEntries(forbiddenIntegrations.map((name) => [name, ""])),
});

const fileContents = (ref, extra = "") => [
  `SUPABASE_PROJECT_REF=${ref}`,
  `NEXT_PUBLIC_SUPABASE_URL=https://${ref}.supabase.co`,
  "NEXT_PUBLIC_SITE_URL=https://staging.newme.ae",
  extra,
  "",
].join("\n");

test("staging rejects the production Supabase ref even when every value agrees", async () => {
  const directory = await mkdtemp(join(tmpdir(), "newme-staging-prod-ref-"));
  try {
    await writeFile(
      join(directory, "staging.env"),
      fileContents(productionRef),
      "utf8",
    );
    await assert.rejects(
      run(bash, [command], { env: environment(directory, productionRef) }),
      /production Supabase ref is forbidden/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("staging rejects production-side external integrations", async () => {
  const directory = await mkdtemp(join(tmpdir(), "newme-staging-integrations-"));
  try {
    for (const name of forbiddenIntegrations) {
      await writeFile(
        join(directory, "staging.env"),
        fileContents(stagingRef, `${name}=not-allowed`),
        "utf8",
      );
      await assert.rejects(
        run(bash, [command], { env: environment(directory, stagingRef) }),
        new RegExp(`${name} is forbidden`),
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
