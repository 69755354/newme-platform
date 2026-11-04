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

// Get git hash at build time
const gitHash = process.env.NEXT_PUBLIC_APP_VERSION ||
  execSync("git rev-parse --short HEAD").toString().trim();

// One stable identifier per release. The release script passes the release SHA
// as NEXT_DEPLOYMENT_ID (scripts/deploy-immutable.sh); local builds fall back to
// the git hash. Next.js stamps it on every asset URL and navigation request, and
// a client whose id no longer matches the server's does one full reload instead
// of calling server actions that no longer exist ("Server Reference ID did not
// match" / "Expected RSC response, got text/plain" after a deploy).
const releaseId = process.env.NEXT_DEPLOYMENT_ID || gitHash;

const nextConfig: NextConfig = {
  deploymentId: releaseId,
  // deploymentId makes BUILD_ID constant unless generateBuildId is set, and the
  // release pipeline compares BUILD_ID between releases (deploy-immutable.sh).
  generateBuildId: async () => releaseId,
  env: {
    NEXT_PUBLIC_APP_VERSION: gitHash,
    // Exposed to both bundles so src/lib/deployment-skew.ts can compare the
    // client's release with the one that answered /api/auth/me.
    NEXT_PUBLIC_DEPLOYMENT_ID: releaseId,
  },
  experimental: {
    // Release directories under /opt/newme/releases/<sha> are root-owned,
    // 0550 and mounted read-only. The prerender/ISR file cache otherwise tries
    // to promote seed pages into .next/server/app at startup and on every
    // revalidatePath(), logging "Failed to update prerender cache ... ENOENT".
    // Keep the page cache in memory only; seeds are still read from disk.
    isrFlushToDisk: false,
  },
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          {
            key: "Content-Security-Policy",
            value: "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' https://*.supabase.co https://*.sentry.io https://static.cloudflareinsights.com; connect-src 'self' https://*.supabase.co https://*.sentry.io; img-src 'self' data: blob: https:; style-src 'self' 'unsafe-inline'; font-src 'self' data: https:; frame-src 'self' https://*.supabase.co; upgrade-insecure-requests",
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
      {
        source: "/api/public/leads",
        has: [{ type: "header", key: "Origin", value: "https://newme.ae" }],
        headers: [
          { key: "Access-Control-Allow-Origin", value: "https://newme.ae" },
          { key: "Access-Control-Allow-Methods", value: "POST,OPTIONS" },
          { key: "Access-Control-Allow-Headers", value: "Content-Type" },
        ],
      },
      {
        source: "/api/public/leads",
        has: [{ type: "header", key: "Origin", value: "https://www.newme.ae" }],
        headers: [
          { key: "Access-Control-Allow-Origin", value: "https://www.newme.ae" },
          { key: "Access-Control-Allow-Methods", value: "POST,OPTIONS" },
          { key: "Access-Control-Allow-Headers", value: "Content-Type" },
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

  // Browser events go through our own origin (rewritten to Sentry at build time
  // when a DSN is present). /monitoring-tunnel is deliberately not in the proxy
  // matcher, so it needs no session and carries no cookies to Sentry.
  tunnelRoute: "/monitoring-tunnel",
});

export default withBundleAnalyzer(sentryConfig);
