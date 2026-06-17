import { withSentryConfig } from "@sentry/nextjs";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  async headers() {
    return [
      {
        // Security headers apply to ALL routes (pages + API)
        source: "/:path*",
        headers: [
          { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains; preload" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-XSS-Protection", value: "1; mode=block" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
          {
            key: "Content-Security-Policy",
            value: [
              "default-src 'self'",
              "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://connect.facebook.net https://eu.posthog.com",
              "style-src 'self' 'unsafe-inline'",
              "img-src 'self' data: blob: https:",
              "font-src 'self' data:",
              "connect-src 'self' https://*.supabase.co wss://*.supabase.co https://*.sentry.io https://eu.posthog.com https://*.posthog.com https://graph.facebook.com",
              "frame-src 'self' https://www.facebook.com https://drive.google.com",
              "object-src 'none'",
              "base-uri 'self'",
              "form-action 'self'",
            ].join("; "),
          },
        ],
      },
      {
        // CORS headers for API routes
        source: "/api/:path*",
        headers: [
          { key: "Access-Control-Allow-Credentials", value: "true" },
          { key: "Access-Control-Allow-Origin", value: process.env.NEXT_PUBLIC_SITE_URL || "https://app.newme.ae" },
          { key: "Access-Control-Allow-Methods", value: "GET,DELETE,PATCH,POST,PUT,OPTIONS" },
          { key: "Access-Control-Allow-Headers", value: "X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, Authorization" },
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

  // Don't widen the client bundle unnecessarily
  widenClientFileUpload: false,
});

export default sentryConfig;
