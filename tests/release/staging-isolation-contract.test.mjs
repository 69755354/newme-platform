import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const root = new URL("../../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");
const readBinary = (path) => readFile(new URL(path, root));
const run = promisify(execFile);
const bash = process.platform === "win32"
  ? "C:\\Program Files\\Git\\bin\\bash.exe"
  : "bash";

function assertPinnedStagingBuildToolchain(build) {
  const checksum = "55aa7153f9d88f28d765fcdad5ae6945b5c0f98a36881703817e4c450fa76742";
  const checksumIndex = build.indexOf('sha256sum --check --status');
  const extractionIndex = build.indexOf('tar -xJf "$NODE_ARCHIVE_PATH"');
  const nodeVerificationIndex = build.indexOf('actual_node="$(node --version)"');
  const npmVerificationIndex = build.indexOf('actual_npm="$(npm --version)"');
  const installIndex = build.indexOf("npm ci --no-audit --no-fund");

  for (const token of [
    'readonly NODE_VERSION="24.18.0"',
    'readonly NPM_VERSION="11.16.0"',
    'readonly NODE_DIST="node-v${NODE_VERSION}-linux-x64"',
    'readonly NODE_URL="https://nodejs.org/dist/v${NODE_VERSION}/${NODE_ARCHIVE}"',
    `readonly NODE_SHA256="${checksum}"`,
    'readonly TOOLCHAIN_CACHE="/opt/newme-staging/cache"',
    'mktemp "${TOOLCHAIN_CACHE}/.${NODE_ARCHIVE}.download.XXXXXX"',
    "curl --fail --silent --show-error --location",
    "--proto '=https' --tlsv1.2",
    'mv -f -- "$TOOLCHAIN_TEMP" "$NODE_ARCHIVE_PATH"',
    'flock -n 8 || fail "toolchain cache is locked"',
    'export PATH="$NODE_DIR/bin:/usr/bin:/bin"',
    '[ "$actual_node" = "v$NODE_VERSION" ]',
    '[ "$actual_npm" = "$NPM_VERSION" ]',
    "node scripts/check-toolchain.mjs",
  ]) assert.ok(build.includes(token), `missing pinned toolchain contract: ${token}`);

  assert.ok(checksumIndex >= 0 && checksumIndex < extractionIndex,
    "the archive must be checksum-verified before extraction");
  assert.ok(extractionIndex < nodeVerificationIndex,
    "the pinned toolchain must be extracted before Node verification");
  assert.ok(nodeVerificationIndex < installIndex && npmVerificationIndex < installIndex,
    "Node and npm must be verified before npm ci");
  assert.doesNotMatch(build, /NODE_VERSION="\$\{/);
  assert.doesNotMatch(build, /NPM_VERSION="\$\{/);
  assert.doesNotMatch(build, /TOOLCHAIN_CACHE="\$\{/);
  assert.doesNotMatch(build, /\/usr\/local/);
  assert.doesNotMatch(build, /sha256sum --check --status\s*\|\|\s*true/);
}

test("staging build bootstraps one pinned official Node/npm toolchain fail-closed", async () => {
  assertPinnedStagingBuildToolchain(await read("scripts/build-staging-artifact.sh"));
});

test("staging build toolchain contract rejects digest, cache, and ordering drift", async (t) => {
  const build = await read("scripts/build-staging-artifact.sh");

  await t.test("rejects a changed official digest", () => {
    assert.throws(
      () => assertPinnedStagingBuildToolchain(build.replace(
        "55aa7153f9d88f28d765fcdad5ae6945b5c0f98a36881703817e4c450fa76742",
        "05aa7153f9d88f28d765fcdad5ae6945b5c0f98a36881703817e4c450fa76742",
      )),
      /missing pinned toolchain contract/,
    );
  });

  await t.test("rejects a configurable cache root", () => {
    assert.throws(
      () => assertPinnedStagingBuildToolchain(build.replace(
        'readonly TOOLCHAIN_CACHE="/opt/newme-staging/cache"',
        'readonly TOOLCHAIN_CACHE="${NEWME_TOOLCHAIN_CACHE:-/opt/newme-staging/cache}"',
      )),
      /missing pinned toolchain contract/,
    );
  });

  await t.test("rejects version checks after dependency installation", () => {
    const nodeCheck = 'actual_node="$(node --version)"';
    const drifted = build.replace(nodeCheck, "# node check moved").replace(
      "npm ci --no-audit --no-fund",
      `npm ci --no-audit --no-fund\n${nodeCheck}`,
    );
    assert.throws(
      () => assertPinnedStagingBuildToolchain(drifted),
      /Node and npm must be verified before npm ci/,
    );
  });
});

test("standalone output is opt-in and production builds remain unchanged", async () => {
  const config = await read("next.config.ts");
  assert.match(config, /NEWME_STANDALONE_BUILD/);
  assert.match(config, /output:\s*isStandaloneBuild \? "standalone" : undefined/);
  assert.match(config, /NEWME_STAGING_LOW_MEMORY/);
  assert.match(config, /webpackMemoryOptimizations:\s*true/);
  assert.match(
    config,
    /configuredNext = isLowMemoryWebpackBuild \|\| !shouldUploadSentrySourceMaps \? nextConfig : withSentryConfig/,
  );
});

test("application fonts are pinned locally so builds never depend on Google Fonts", async () => {
  const [layout, styles, sans, mono, license] = await Promise.all([
    read("src/app/layout.tsx"),
    read("src/app/globals.css"),
    readBinary("src/app/fonts/Geist-Variable.woff2"),
    readBinary("src/app/fonts/GeistMono-Variable.woff2"),
    read("src/app/fonts/LICENSE.txt"),
  ]);
  assert.match(layout, /from "next\/font\/local"/);
  assert.doesNotMatch(layout, /next\/font\/google/);
  assert.match(layout, /\.\/fonts\/Geist-Variable\.woff2/);
  assert.match(layout, /\.\/fonts\/GeistMono-Variable\.woff2/);
  assert.match(styles, /--font-sans:\s*var\(--font-geist-sans\)/);
  assert.equal(
    createHash("sha256").update(sans).digest("hex"),
    "2ffebe993e969069a9789d15164b7715d42491b5835516c5e3b935d5f81b05f1",
  );
  assert.equal(
    createHash("sha256").update(mono).digest("hex"),
    "afaacc4c5fbba89d2ebf7a02dc4070208540874592a5504d57175782fe893101",
  );
  assert.match(license, /SIL OPEN FONT LICENSE Version 1\.1/);
});

test("staging refuses unsafe Supabase credentials and target drift", async () => {
  const guard = await read("scripts/check-staging-boundaries.sh");
  for (const token of [
    "NEWME_STAGING_PROJECT_REF",
    "NEWME_STAGING_BOUNDARY_MODE",
    "SUPABASE_PROJECT_REF",
    "NEXT_PUBLIC_SUPABASE_URL",
    "https://staging.newme.ae",
    "sb_secret_",
    "Supabase secret keys are forbidden on external builders",
    "SUPABASE_PAT",
    "SUPABASE_DB_PASSWORD",
    "supabase/.temp/project-ref",
  ]) assert.ok(guard.includes(token), `missing staging boundary: ${token}`);
});

test("external builders cannot receive the staging runtime secret", async () => {
  const directory = await mkdtemp(join(tmpdir(), "newme-staging-boundary-"));
  const environmentPath = join(directory, "staging.env");
  const publicEnvironment = [
    "SUPABASE_PROJECT_REF=bfsiibofuzoglziltgyd",
    "NEXT_PUBLIC_SUPABASE_URL=https://bfsiibofuzoglziltgyd.supabase.co",
    "NEXT_PUBLIC_SITE_URL=https://staging.newme.ae",
    "",
  ].join("\n");
  const command = fileURLToPath(new URL("scripts/check-staging-boundaries.sh", root));
  const commonEnvironment = {
    ...process.env,
    NEWME_STAGING_PROJECT_REF: "bfsiibofuzoglziltgyd",
    NEWME_STAGING_ENV_FILE: environmentPath,
    SUPABASE_SERVICE_ROLE_KEY: "",
    SUPABASE_PAT: "",
    SUPABASE_DB_PASSWORD: "",
    SENTRY_AUTH_TOKEN: "",
    NEXT_PUBLIC_SENTRY_DSN: "",
    SENTRY_DSN: "",
  };

  try {
    await writeFile(environmentPath, publicEnvironment, "utf8");
    const build = await run(bash, [command], {
      env: { ...commonEnvironment, NEWME_STAGING_BOUNDARY_MODE: "build" },
    });
    assert.match(build.stdout, /staging build boundaries verified/);

    await writeFile(
      environmentPath,
      `${publicEnvironment}SUPABASE_SERVICE_ROLE_KEY=sb_secret_test_only\n`,
      "utf8",
    );
    await assert.rejects(
      run(bash, [command], {
        env: { ...commonEnvironment, NEWME_STAGING_BOUNDARY_MODE: "build" },
      }),
      /Supabase secret keys are forbidden on external builders/,
    );

    const runtime = await run(bash, [command], {
      env: { ...commonEnvironment, NEWME_STAGING_BOUNDARY_MODE: "runtime" },
    });
    assert.match(runtime.stdout, /staging runtime boundaries verified/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("staging builder emits an immutable standalone artifact without runtime secrets", async () => {
  const build = await read("scripts/build-staging-artifact.sh");
  for (const pattern of [
    /NEWME_STAGING_BOUNDARY_MODE=build/,
    /NEWME_STAGING_PROJECT_REF="\$EXPECTED_REF"/,
    /NEWME_STANDALONE_BUILD=1/,
    /NEWME_STAGING_LOW_MEMORY=0/,
    /NEXT_PUBLIC_APP_VERSION="\$SHA"/,
    /NEWME_STAGING_BUILD_HEAP_MB:-896/,
    /build heap must stay between 768 and 1152 MiB/,
    /NODE_OPTIONS="--max_old_space_size=\$HEAP_MB"/,
    /npm ci --no-audit --no-fund/,
    /npm run typecheck/,
    /npm run check:security/,
    /npm run lint:baseline/,
    /npm test/,
    /npm run check:supply-chain -- --accept-known/,
    /\. "\$ENV_FILE"/,
    /unset ANALYZE/,
    /npm run build -- --turbopack/,
    /manifest\.json/,
    /tar --dereference -C "\$STANDALONE" -czf "\$ARTIFACT" \./,
    /sha256sum "\$ARTIFACT"/,
  ]) assert.match(build, pattern);
  assert.doesNotMatch(build, /npm run build -- --webpack/);
  assert.doesNotMatch(build, /SUPABASE_SERVICE_ROLE_KEY/);
  assert.doesNotMatch(build, /vfopmpxlhwzpxqegayew/);
});

test("staging deploy only verifies prebuilt artifacts and atomically switches", async () => {
  const deploy = await read("scripts/deploy-staging.sh");
  for (const pattern of [
    /00\|01\|02\|03\|04\|05\|18\|19\|20\|21\|22\|23/,
    /flock -n/,
    /refs\/remotes\/origin\/\$BRANCH/,
    /INCOMING="\$ROOT\/incoming"/,
    /BARE_REPO="\$ROOT\/repository\.git"/,
    /BRANCH="\$\{NEWME_STAGING_BRANCH:-agent\/saas-staging-isolation\}"/,
    /DEPLOY_KEY="\/etc\/newme-staging\/github_deploy_key"/,
    /UserKnownHostsFile=\$KNOWN_HOSTS/,
    /sha256sum "\$ARTIFACT"/,
    /artifact contains an unsafe path/,
    /artifact contains links or special files/,
    /release manifest SHA does not match requested SHA/,
    /NEWME_STAGING_BOUNDARY_MODE=runtime/,
    /127\.0\.0\.1:3001\/api\/health/,
    /PORT=3102/,
    /127\.0\.0\.1:3101\/api\/health/,
    /mv -Tf "\$CURRENT_NEXT" "\$CURRENT"/,
    /current staging symlink does not resolve to the promoted release/,
    /PROMOTED=1/,
    /\[ "\$PROMOTED" -eq 1 \] && \[ "\$SWITCHED" -eq 0 \]/,
    /rollback/,
    /\[ -n "\$PREVIOUS" \] && \[ -d "\$PREVIOUS" \]/,
    /rm -f -- "\$CURRENT"/,
    /systemctl stop newme-staging\.service/,
  ]) assert.match(deploy, pattern);
  assert.doesNotMatch(deploy, /npm ci/);
  assert.doesNotMatch(deploy, /npm run build/);
  assert.doesNotMatch(deploy, /supabase\s+(?:link|db|migration)/);
  assert.doesNotMatch(deploy, /vfopmpxlhwzpxqegayew/);
  assert.doesNotMatch(deploy, /\/opt\/newme\/repository\.git/);
  assert.doesNotMatch(deploy, /SWitched/);
});

test("server build continuously protects production and only accepts the exact remote staging SHA", async () => {
  const [build, buildUnit, installer, runtimeUnit] = await Promise.all([
    read("scripts/run-staging-build.sh"),
    read("infra/systemd/newme-staging-build@.service"),
    read("scripts/install-staging-assets.sh"),
    read("infra/systemd/newme-staging.service"),
  ]);
  for (const pattern of [
    /\/run\/newme-staging-window-override/,
    /date -u \+%F/,
    /outside the normal Dubai window/,
    /REPOSITORY="\$ROOT\/repository\.git"/,
    /PUBLIC_ENV="\/etc\/newme-staging\/build\.env"/,
    /DEPLOY_KEY="\/etc\/newme-staging\/github_deploy_key"/,
    /BRANCH="\$\{NEWME_STAGING_BRANCH:-agent\/saas-staging-isolation\}"/,
    /build SHA must equal the canonical remote staging branch/,
    /git --git-dir="\$REPOSITORY" archive "\$SHA"/,
    /env -i/,
    /NEWME_STAGING_BUILD_HEAP_MB/,
    /production health changed before staging build/,
    /production health changed during staging build/,
    /production health changed after staging build/,
  ]) assert.match(build, pattern);
  assert.doesNotMatch(build, /SUPABASE_SERVICE_ROLE_KEY/);
  assert.doesNotMatch(build, /vfopmpxlhwzpxqegayew/);
  assert.doesNotMatch(build, /\/opt\/newme\/repository\.git/);
  assert.match(
    build,
    /setsid runuser -u newme-staging --group newme-staging --supp-group docker -- env -i/,
  );
  assert.equal((build.match(/--group newme-staging/g) ?? []).length, 1);
  assert.equal((build.match(/--supp-group docker/g) ?? []).length, 1);
  for (const source of [build, installer]) {
    assert.doesNotMatch(source, /\b(?:usermod|gpasswd)\b/);
  }
  assert.match(runtimeUnit, /^User=newme-staging$/m);
  assert.match(runtimeUnit, /^Group=newme-staging$/m);
  assert.doesNotMatch(runtimeUnit, /^(?:SupplementaryGroups=.*|\S*=.*\bdocker\b.*)$/m);
  assert.match(buildUnit, /^User=root$/m);
  assert.doesNotMatch(buildUnit, /^(?:SupplementaryGroups=.*|\S*=.*\bdocker\b.*)$/m);
});

test("staging window override is explicit, date-bound, and shared by build and deploy", async () => {
  const [build, deploy] = await Promise.all([
    read("scripts/run-staging-build.sh"),
    read("scripts/deploy-staging.sh"),
  ]);
  for (const script of [build, deploy]) {
    assert.match(script, /WINDOW_OVERRIDE="\/run\/newme-staging-window-override"/);
    assert.match(script, /TODAY_UTC="\$\(date -u \+%F\)"/);
    assert.match(script, /\[ "\$\(cat "\$WINDOW_OVERRIDE" 2>\/dev\/null \|\| true\)" = "\$TODAY_UTC" \]/);
    assert.match(script, /outside the normal Dubai window/);
  }
});

test("staging installer derives a public-only build environment and isolated repository", async () => {
  const install = await read("scripts/install-staging-assets.sh");
  for (const pattern of [
    /BUILD_ENV="\/etc\/newme-staging\/build\.env"/,
    /\$1 == "SUPABASE_PROJECT_REF"/,
    /\$1 == "NEXT_PUBLIC_SUPABASE_URL"/,
    /\$1 == "NEXT_PUBLIC_SUPABASE_ANON_KEY"/,
    /\$1 == "NEXT_PUBLIC_SITE_URL"/,
    /install -m 0640 -o root -g newme-staging "\$public_env" "\$BUILD_ENV"/,
    /install -d -m 0750 -o newme-staging -g newme-staging \/opt\/newme-staging\/cache \/opt\/newme-staging\/cache\/npm/,
    /\/opt\/newme-staging\/repository\.git/,
    /git@github\.com:69755354\/newme-platform\.git/,
    /newme-staging-build@\.service/,
  ]) assert.match(install, pattern);
  assert.doesNotMatch(install, /\$1 == "SUPABASE_SERVICE_ROLE_KEY"/);
  assert.doesNotMatch(install, /\$1 == "SUPABASE_PAT"/);
  assert.doesNotMatch(install, /\$1 == "SUPABASE_DB_PASSWORD"/);
  assert.doesNotMatch(install, /\/opt\/newme\/repository\.git/);
});

test("staging edge stays closed during certificate bootstrap and rejects direct origin traffic", async () => {
  const [bootstrap, finalConfig, installer] = await Promise.all([
    read("infra/nginx/staging.newme.ae.bootstrap.conf"),
    read("infra/nginx/staging.newme.ae.conf"),
    read("scripts/install-staging-edge.sh"),
  ]);
  assert.match(bootstrap, /location \^~ \/\.well-known\/acme-challenge\//);
  assert.match(bootstrap, /location \/\s*\{\s*return 404;/s);
  assert.doesNotMatch(bootstrap, /proxy_pass/);
  assert.match(finalConfig, /proxy_pass http:\/\/127\.0\.0\.1:3101/);
  assert.match(finalConfig, /ssl_certificate \/etc\/letsencrypt\/live\/staging\.newme\.ae\/fullchain\.pem/);
  assert.match(finalConfig, /allow 173\.245\.48\.0\/20/);
  assert.match(finalConfig, /allow 2400:cb00::\/32/);
  assert.match(finalConfig, /deny all/);
  assert.doesNotMatch(finalConfig, /app\.newme\.ae/);
  for (const pattern of [
    /bootstrap\|final/,
    /127\.0\.0\.1:3001\/api\/health/,
    /127\.0\.0\.1:3101\/api\/health/,
    /nginx -t/,
    /systemctl reload nginx/,
    /--resolve staging\.newme\.ae:443:127\.0\.0\.1/,
    /rollback/,
  ]) assert.match(installer, pattern);
});

test("staging systemd units enforce separate identity, ports, and resource ceilings", async () => {
  const [runtime, build, deploy] = await Promise.all([
    read("infra/systemd/newme-staging.service"),
    read("infra/systemd/newme-staging-build@.service"),
    read("infra/systemd/newme-staging-deploy@.service"),
  ]);
  assert.match(runtime, /^User=newme-staging$/m);
  assert.match(runtime, /^Environment=PORT=3101$/m);
  assert.match(runtime, /^MemoryMax=512M$/m);
  assert.match(runtime, /^MemorySwapMax=0$/m);
  assert.match(runtime, /^CPUQuota=50%$/m);
  assert.match(build, /^EnvironmentFile=\/etc\/newme-staging\/build\.env$/m);
  assert.match(build, /^Environment=NODE_OPTIONS=--max-old-space-size=768$/m);
  assert.match(build, /^TimeoutStartSec=60min$/m);
  assert.match(build, /^MemoryHigh=1792M$/m);
  assert.match(build, /^MemoryMax=2048M$/m);
  assert.match(build, /^MemorySwapMax=256M$/m);
  assert.match(build, /^CPUQuota=100%$/m);
  assert.match(build, /^OOMPolicy=stop$/m);
  assert.match(deploy, /^TimeoutStartSec=15min$/m);
  assert.match(deploy, /^MemoryHigh=384M$/m);
  assert.match(deploy, /^MemoryMax=512M$/m);
  assert.match(deploy, /^MemorySwapMax=0$/m);
  assert.match(deploy, /^CPUQuota=50%$/m);
});
