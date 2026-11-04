// S5: chart hover text must never print "undefined" (analytics quality bar showed
// "undefined: 20" for the segment with no label).
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { chartLabel, humanizeKey, segmentTitle } from "../../src/lib/chart-labels.mjs";

test("a missing label falls back to the translated name, then to the key", () => {
  const labels = { good: "Good", pending: "Pending", bad: "Bad" }; // what the page used to pass
  assert.equal(segmentTitle(labels, "unknown", 20, "Unknown"), "Unknown: 20");
  assert.equal(segmentTitle(labels, "normal", 7), "Normal: 7");
  assert.equal(segmentTitle(labels, "good", 3, "x"), "Good: 3");
  assert.equal(chartLabel(undefined, "job_seeker"), "Job seeker");
  assert.equal(humanizeKey(""), "");
  assert.ok(!segmentTitle({}, "whatever", Number.NaN).includes("undefined"));
});

test("analytics charts name every series and cover every quality bucket", () => {
  const health = fs.readFileSync("src/app/(dashboard)/analytics/_components/LeadHealth.tsx", "utf8");
  assert.match(health, /segmentTitle\(/);
  for (const key of ["pending", "good", "normal", "bad", "unknown"]) assert.match(health, new RegExp(`"${key}"`));
  const load = fs.readFileSync("src/app/(dashboard)/analytics/_components/SalesLoad.tsx", "utf8");
  // a Bar without `name` shows its dataKey ("leads", "count") in the tooltip
  for (const line of load.split("\n").filter((l) => l.includes("<Bar "))) assert.match(line, /name=/);
  const en = fs.readFileSync("src/lib/i18n/translations.ts", "utf8");
  assert.equal((en.match(/\/\/ S5: numbers and statistics\n\s+qualityNormal:/g) ?? []).length, 2, "analytics.qualityNormal in both languages");
});

import { translatedOrRaw } from "../../src/lib/chart-labels.mjs";

test("an unknown source shows its stored name, never the translation key", () => {
  // The app's translate function returns the lookup path itself when an entry is missing.
  const translate = (path) => ({ "sourceLabels.fb": "Facebook" })[path] ?? path;
  assert.equal(translatedOrRaw(translate, "sourceLabels.fb", "fb"), "Facebook");
  assert.equal(translatedOrRaw(translate, "sourceLabels.google", "google"), "google");
  assert.equal(translatedOrRaw(translate, "sourceLabels.Spring Sale", "Spring Sale"), "Spring Sale");
  assert.equal(translatedOrRaw(() => "", "sourceLabels.x", "x"), "x");
});
