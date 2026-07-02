/**
 * Web Vitals collection module.
 * Captures Core Web Vitals (LCP, CLS, INP, FCP, TTFB) and sends them to PostHog.
 *
 * Note: web-vitals v5 removed onFID (replaced by onINP).
 * We report the 5 metrics the package currently exports.
 */

import { onCLS, onFCP, onINP, onLCP, onTTFB, type Metric } from "web-vitals";
import posthog from "posthog-js";

function sendToPostHog(metric: Metric) {
  posthog.capture("web_vitals", {
    metric_name: metric.name,
    metric_value: metric.value,
    metric_rating: metric.rating,
    metric_delta: metric.delta,
    metric_id: metric.id,
    navigation_type: metric.navigationType,
  });
}

export function reportWebVitals() {
  onCLS(sendToPostHog);
  onFCP(sendToPostHog);
  onINP(sendToPostHog);
  onLCP(sendToPostHog);
  onTTFB(sendToPostHog);
}
