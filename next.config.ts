import { withSentryConfig } from "@sentry/nextjs";
import bundleAnalyzer from "@next/bundle-analyzer";
import type { NextConfig } from "next";
import { execSync } from "child_process";
import { existsSync } from "fs";

// 🔴 PRODUCTION BUILD GUARD — prevents npx next build from overwriting live .next
const PROD_DIR = "/opt/newme/current";
const IS_PROD = process.cwd() === PROD_DIR;
const IS_ISOLATED = process.cwd().startsWith("/tmp/newme-build-");
// Only guard during build, not start
const IS_START = process.env.npm_lifecycle_event === "start" || process.argv.includes("start");
if (IS_PROD && !IS_ISOLATED && !IS_START && process.env.NEWME_ISOLATED_BUILD !== "1") {
  const marker = `${PROD_DIR}/.hermes/IS_PRODUCTION`;
  if (existsSync(marker) || existsSync(".hermes/IS_PRODUCTION")) {
    const serviceRunning = (() => {
      try { execSync("systemctl is-active --quiet newme-platform.service", { stdio: "ignore" }); return true; } catch { return false; }
    })();
    if (serviceRunning) {
      console.error("🚫 PRODUCTION BUILD BLOCKED by next.config.ts guard");
      console.error("   Service is RUNNING. npx next build would overwrite .next.");
      console.error("   Use: npm run deploy");
      process.exit(1);
    }
  }
}

const withBundleAnalyzer = bundleAnalyzer({
  enabled: process.env.ANALYZE === "true",
});
const isStandaloneBuild = process.env.NEWME_STANDALONE_BUILD === "1";
const isLowMemoryWebpackBuild = process.env.NEWME_STAGING_LOW_MEMORY === "1";
const shouldUploadSentrySourceMaps = process.env.SENTRY_UPLOAD_SOURCEMAPS === "1"
  && Boolean(process.env.SENTRY_AUTH_TOKEN);
const stagingReleaseSha = process.env.NEXT_PUBLIC_APP_VERSION || "";
if (isStandaloneBuild && !/^[0-9a-f]{40}$/.test(stagingReleaseSha)) {
  throw new Error("staging standalone builds require an exact 40-character release SHA");
}

// Get git hash at build time
const gitHash = process.env.NEXT_PUBLIC_APP_VERSION ||
  execSync("git rev-parse --short HEAD").toString().trim();
const stagingReleaseMetadata = isStandaloneBuild ? stagingReleaseSha : "";

export function getLocalSupabaseConnectOrigin(
  nodeEnv = process.env.NODE_ENV,
  rawSupabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL,
): string | undefined {
  if (nodeEnv === "production" || !rawSupabaseUrl) return undefined;
  try {
    const url = new URL(rawSupabaseUrl);
    const isLoopback = url.hostname === "127.0.0.1" || url.hostname === "localhost";
    if (
      url.protocol !== "http:"
      || !isLoopback
      || !url.port
      || url.username
      || url.password
      || url.pathname !== "/"
      || url.search
      || url.hash
    ) {
      return undefined;
    }
    return url.origin;
  } catch {
    return undefined;
  }
}

export function buildContentSecurityPolicy(
  nodeEnv = process.env.NODE_ENV,
  rawSupabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL,
): string {
  const localSupabaseOrigin = getLocalSupabaseConnectOrigin(nodeEnv, rawSupabaseUrl);
  const connectSources = [
    "'self'",
    "https://*.supabase.co",
    "https://*.sentry.io",
    "https://*.posthog.com",
    "https://eu-assets.i.posthog.com",
    ...(localSupabaseOrigin ? [localSupabaseOrigin] : []),
  ];
  return `default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' https://*.supabase.co https://*.sentry.io https://*.posthog.com https://eu-assets.i.posthog.com; connect-src ${connectSources.join(" ")}; img-src 'self' data: blob: https:; style-src 'self' 'unsafe-inline'; font-src 'self' data: https:; frame-src 'self' https://*.supabase.co; upgrade-insecure-requests`;
}

const nextConfig: NextConfig = {
  output: isStandaloneBuild ? "standalone" : undefined,
  experimental: isLowMemoryWebpackBuild
    ? { webpackMemoryOptimizations: true }
    : undefined,
  env: {
    NEXT_PUBLIC_APP_VERSION: gitHash,
    NEWME_RELEASE_SHA: stagingReleaseMetadata,
    NEWME_BUILD_ID: stagingReleaseMetadata,
    NEWME_RELEASE_METADATA_REQUIRED: isStandaloneBuild ? "1" : "0",
  },
  generateBuildId: isStandaloneBuild
    ? async () => stagingReleaseSha
    : undefined,
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          {
            key: "Content-Security-Policy",
            value: buildContentSecurityPolicy(),
          },
          { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
        ],
      },
      {
        source: "/api/:path*",
        headers: [
          { key: "Access-Control-Allow-Credentials", value: "true" },
          { key: "Access-Control-Allow-Origin", value: process.env.NEXT_PUBLIC_SITE_URL || "https://app.newme.ae" },
          { key: "Access-Control-Allow-Methods", value: "GET,DELETE,PATCH,POST,PUT,OPTIONS" },
          { key: "Access-Control-Allow-Headers", value: "X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, Authorization" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-XSS-Protection", value: "1; mode=block" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
    ];
  },

  // Source maps handled by Sentry wrapper below
};

const configuredNext = isLowMemoryWebpackBuild || !shouldUploadSentrySourceMaps ? nextConfig : withSentryConfig(nextConfig, {
  org: process.env.SENTRY_ORG || "newme-o4",
  project: process.env.SENTRY_PROJECT || "javascript-nextjs",
  authToken: process.env.SENTRY_AUTH_TOKEN,
  silent: false,
  telemetry: false,

  // Source map upload
  sourcemaps: {
    assets: "./.next/**/*.map",
    ignore: ["node_modules"],
    deleteSourcemapsAfterUpload: true,
  },

  // Widen client file upload for Turbopack compatibility
  // Fixes React Client Manifest errors (global-error.tsx, icon-mark.js, etc.)
  widenClientFileUpload: true,
});

export default withBundleAnalyzer(configuredNext);
