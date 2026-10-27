// ============================================================================
// R8 — the proxy's activity throttle, executed rather than read
// ============================================================================
// The defect was a `Map<string, number>` in src/proxy.ts that was only ever
// written to: one retained entry per user id that ever passed through the proxy,
// held for the life of the process to enforce a 5-minute window.
//
// A regex can show the Map is gone. It cannot show that the replacement still
// throttles, that its footprint is fixed, or — the property that decides whether
// this fix is worse than the leak — that a slot collision does not suppress a
// real user's activity signal. `last_active_at` is read as a fact about the user
// (team page, /api/users, the daily activity report), so a throttle that
// silently answers "already stamped" for the wrong user would corrupt that fact
// while looking healthy. Behavioural claims below run the module; the final test
// separately checks the proxy-to-module source coupling.
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const {
  shouldRecordActivity,
  resetActivityThrottle,
  ACTIVITY_THROTTLE_SLOTS,
  activityThrottleSize,
} = await import("../../src/lib/activity-throttle.mjs");

const WINDOW = 300_000; // the proxy's window, unchanged by this fix
const T0 = 1_770_000_000_000;

test("R8 · the window still throttles, on the same boundary as the Map it replaced", () => {
  resetActivityThrottle();
  const user = "11111111-1111-4111-8111-111111111111";

  assert.equal(shouldRecordActivity(user, WINDOW, T0), true, "first sight must stamp");
  assert.equal(shouldRecordActivity(user, WINDOW, T0), false);
  assert.equal(shouldRecordActivity(user, WINDOW, T0 + 1), false);

  // The replaced code allowed a stamp when `now - last > 300_000`, so exactly at
  // the window it suppressed. That boundary is preserved deliberately: this is a
  // memory fix, not a change to how often the column is written.
  assert.equal(shouldRecordActivity(user, WINDOW, T0 + WINDOW), false);
  assert.equal(shouldRecordActivity(user, WINDOW, T0 + WINDOW + 1), true);

  // And the window restarts from the stamp that was just taken, not from T0.
  assert.equal(shouldRecordActivity(user, WINDOW, T0 + WINDOW + 2), false);
});

test("R8 · 200k sampled distinct ids never exceed the configured capacity", () => {
  resetActivityThrottle();

  // This is a bounded stress sample, not a proof over every possible input. The
  // source assertion below checks the branch that enforces the same capacity.
  for (let i = 0; i < 200_000; i += 1) {
    shouldRecordActivity(`flood-${i}`, WINDOW, T0);
  }
  assert.equal(ACTIVITY_THROTTLE_SLOTS, 4096);
  assert.equal(activityThrottleSize(), ACTIVITY_THROTTLE_SLOTS);

  const source = fs.readFileSync(path.join(root, "src/lib/activity-throttle.mjs"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  assert.match(source, /while \(stamps\.size >= ACTIVITY_THROTTLE_SLOTS\)/);
  assert.match(source, /stamps\.delete\(oldest\)/);
});

test("R8 · 5,000 sampled distinct user ids are each stamped on first sight", () => {
  resetActivityThrottle();

  // This crosses the 4,096-entry capacity and therefore exercises eviction while
  // checking each fresh full key. It makes no universal claim about unexecuted ids.
  let stamped = 0;
  for (let i = 0; i < 5_000; i += 1) {
    if (shouldRecordActivity(`user-${i}`, WINDOW, T0)) stamped += 1;
  }
  assert.equal(stamped, 5_000);
});

test("R8 · capacity eviction causes one observable extra write for the evicted key", () => {
  resetActivityThrottle();

  // Fill the exact LRU capacity so the first full key is deterministically evicted.
  const oldest = "oldest-user";
  assert.equal(shouldRecordActivity(oldest, WINDOW, T0), true);
  for (let i = 1; i <= ACTIVITY_THROTTLE_SLOTS; i += 1) {
    assert.equal(shouldRecordActivity(`other-${i}`, WINDOW, T0), true);
  }
  assert.equal(activityThrottleSize(), ACTIVITY_THROTTLE_SLOTS);

  // The evicted key is treated as unseen and is stamped again.
  assert.equal(shouldRecordActivity(oldest, WINDOW, T0), true, "the oldest key was not evicted at capacity");

  // Once reinserted, the same full key is throttled normally.
  assert.equal(shouldRecordActivity(oldest, WINDOW, T0), false, "the refreshed full key is throttled normally");

});

test("R8 · a clock step backwards does not freeze a user's activity signal", () => {
  resetActivityThrottle();
  const user = "22222222-2222-4222-8222-222222222222";

  // Stamp far in the future, then ask from the corrected clock. A plain
  // `now - stamped <= windowMs` test reads a future stamp as "just stamped" and
  // suppresses until the clock catches up — here, for a day.
  assert.equal(shouldRecordActivity(user, WINDOW, T0 + 86_400_000), true);
  assert.equal(shouldRecordActivity(user, WINDOW, T0), true);
  assert.equal(shouldRecordActivity(user, WINDOW, T0), false);
});

test("R8 · the proxy calls the bounded throttle and keeps no table of its own", () => {
  const proxy = fs.readFileSync(path.join(root, "src/proxy.ts"), "utf8");
  const code = proxy.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  assert.match(code, /import \{ shouldRecordActivity \} from "@\/lib\/activity-throttle\.mjs"/);
  assert.match(code, /if \(shouldRecordActivity\(user\.id, ACTIVITY_WINDOW_MS\)\)/);
  assert.doesNotMatch(code, /activityThrottle/);
  assert.doesNotMatch(code, /new Map</);

  // The write stays here. profiles-grant-coupling.test.mjs requires the proxy to
  // be the only caller-scoped writer of public.profiles, so moving the UPDATE
  // into the throttle module would break a security boundary to tidy a leak.
  assert.match(code, /supabase\s*\n?\s*\.?from\("profiles"\)[\s\S]{0,120}\.update\(\{ last_active_at/);
});
