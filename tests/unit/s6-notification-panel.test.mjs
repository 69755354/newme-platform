// S6 · review 4d #1 (总报告 一.5): the 380 px notification panel was anchored to
// the bell's right edge minus 380, so at 360/390 px its left edge sat at
// -256/-226 px and most of it was off-screen.
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const { notificationPanelPosition } = await import("../../src/lib/notification-panel-position.mjs");

for (const viewport of [320, 360, 390, 414, 768, 1280, 1920]) {
  test(`panel fits entirely inside a ${viewport} px viewport`, () => {
    // Bell sits near the right edge of the top bar on every layout.
    const anchor = { right: viewport - 60, bottom: 48 };
    const { left, width, top } = notificationPanelPosition(anchor, viewport);
    assert.ok(left >= 8, `left ${left} must be on screen`);
    assert.ok(left + width <= viewport - 8, `right edge ${left + width} must be on screen`);
    assert.ok(width <= 380 && width >= Math.min(380, viewport - 16));
    assert.equal(top, 56);
  });
}

test("desktop keeps the panel right-aligned under the bell", () => {
  const { left, width } = notificationPanelPosition({ right: 1220, bottom: 48 }, 1280);
  assert.equal(width, 380);
  assert.equal(left, 1220 - 380);
});

test("NotificationBell uses the clamped position instead of right - 380", () => {
  const src = fs.readFileSync(new URL("../../src/components/NotificationBell.tsx", import.meta.url), "utf8");
  assert.match(src, /notificationPanelPosition\(/);
  assert.doesNotMatch(src, /\) - 380/);
  assert.doesNotMatch(src, /w-\[380px\]/);
});
