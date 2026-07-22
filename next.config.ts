import { withSentryConfig } from "@sentry/nextjs";
import bundleAnalyzer from "@next/bundle-analyzer";
import type { NextConfig } from "next";
import { execSync } from "child_process";
import { existsSync } from "fs";

// 🔴 PRODUCTION BUILD GUARD — prevents npx next build from overwriting live .next
const PROD_DIR = "/home/ubuntu/newme-platform";
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

// Get git hash at build time
const gitHash = process.env.NEXT_PUBLIC_APP_VERSION ||
  execSync("git rev-parse --short HEAD").toString().trim();

const nextConfig: NextConfig = {
  env: {
    NEXT_PUBLIC_APP_VERSION: gitHash,
  },
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          {
            key: "Content-Security-Policy",
            value: "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' https://*.supabase.co https://*.sentry.io https://*.posthog.com; connect-src 'self' https://*.supabase.co https://*.sentry.io https://*.posthog.com; img-src 'self' data: blob: https:; style-src 'self' 'unsafe-inline'; font-src 'self' data: https:; frame-src 'self' https://*.supabase.co; upgrade-insecure-requests",
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

const sentryConfig = withSentryConfig(nextConfig, {
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

export default withBundleAnalyzer(sentryConfig);
