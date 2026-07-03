import { withSentryConfig } from "@sentry/nextjs";
import bundleAnalyzer from "@next/bundle-analyzer";
import type { NextConfig } from "next";
import { execSync } from "child_process";

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
