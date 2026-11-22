// S35 F05: contact time was stored 4 hours early. The form filled the UTC clock into a datetime-local field and read it back in the
// browser's zone, and its `max` (UTC) blocked the real "now". Every such field now shows and means Dubai time.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import test from "node:test";
import { dubaiDateKey, dubaiInputToIso, dubaiInputValue } from "../../src/lib/dubai-time.mjs";
import { dubaiLocalToIso, isoToDubaiLocal } from "../../src/lib/opportunity-visit.mjs";

const NOW = new Date("2026-11-21T20:31:40Z"); // 00:31 in Dubai on 22 Nov

test("the default is the Dubai wall clock, not the UTC clock (was 20:31 on the day before)", () => {
  assert.equal(dubaiInputValue(NOW), "2026-11-22T00:31");
  assert.notEqual(dubaiInputValue(NOW), NOW.toISOString().slice(0, 16), "the old default");
  assert.equal(dubaiInputValue("not a date"), "");
});

test("a contact logged 'now' stores the real now (to the minute), whatever zone the browser or server runs in", () => {
  const script = `
    import("./src/lib/dubai-time.mjs").then((m) => {
      const now = new Date("${NOW.toISOString()}");
      process.stdout.write(JSON.stringify({ stored: m.dubaiInputToIso(m.dubaiInputValue(now)), max: m.dubaiInputValue(now),
        old: new Date(now.toISOString().slice(0, 16)).toISOString() }));
    });`;
  const real = new Date("2026-11-21T20:31:00.000Z").toISOString();
  const olds = {};
  for (const tz of ["UTC", "Asia/Dubai", "Asia/Shanghai", "America/New_York"]) {
    const out = spawnSync(process.execPath, ["-e", script], { env: { ...process.env, TZ: tz }, encoding: "utf8" });
    assert.equal(out.status, 0, out.stderr);
    const got = JSON.parse(out.stdout);
    assert.equal(got.stored, real, `stored time in ${tz}`);
    assert.ok(Date.parse(got.stored) <= NOW.getTime(), "never in the future, so the server accepts it");
    assert.equal(got.max, "2026-11-22T00:31", "the max allows the real now");
    olds[tz] = got.old;
  }
  // the old pipeline was only right when the browser happened to run on UTC
  assert.equal(olds.UTC, real);
  assert.equal(olds["Asia/Dubai"], "2026-11-21T16:31:00.000Z", "4 hours early: the reported bug");
  assert.equal(olds["Asia/Shanghai"], "2026-11-21T12:31:00.000Z");
});

test("a value typed in the field is Dubai time; round trips and invalid values", () => {
  assert.equal(dubaiInputToIso("2026-11-25T14:30"), "2026-11-25T10:30:00.000Z");
  assert.equal(dubaiInputToIso("2026-11-25T14:30"), dubaiLocalToIso("2026-11-25T14:30"), "same convention as the visit planner");
  assert.equal(dubaiInputValue("2026-11-25T10:30:00.000Z"), isoToDubaiLocal("2026-11-25T10:30:00.000Z"));
  assert.equal(dubaiInputValue(dubaiInputToIso("2026-12-31T23:59")), "2026-12-31T23:59");
  for (const bad of ["", null, undefined, "2026-02-31T10:00", "2026-11-25T25:00", "2026-11-25", "x"]) assert.equal(dubaiInputToIso(bad), null, String(bad));
});

test("'today' on the contract and payment screens is the Dubai calendar day (the UTC date is still yesterday until 04:00)", () => {
  assert.equal(dubaiDateKey(new Date("2026-11-21T21:00:00Z")), "2026-11-22");
  assert.equal(new Date("2026-11-21T21:00:00Z").toISOString().slice(0, 10), "2026-11-21", "what the pages used to use");
});

const read = (p) => fs.readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");
test("the screens use the Dubai helpers; no UTC-clock datetime default is left in them", () => {
  const sales = read("src/app/(dashboard)/leads/[id]/LeadSalesProcess.tsx");
  assert.ok(!/toISOString\(\)\.slice\(0, 16\)/.test(sales));
  assert.match(sales, /useState\(\(\) => dubaiInputValue\(\)\)/);
  assert.match(sales, /const contactTimeIso = dubaiInputToIso\(contactTime\)/);
  assert.match(sales, /max=\{dubaiInputValue\(\)\}/);
  const timeline = read("src/app/(dashboard)/leads/[id]/LeadTimeline.tsx");
  assert.ok(!/toISOString\(\)\.slice\(0, 16\)/.test(timeline) && /dubaiInputToIso\(editContact\.contact_time\)/.test(timeline));
  const page = read("src/app/(dashboard)/leads/[id]/timeline/page.tsx");
  assert.match(page, /dubaiInputToIso\(formContactTime\)/);
  const task = read("src/app/(dashboard)/tasks/[id]/page.tsx");
  assert.ok(!/toISOString\(\)\.slice\(0, 16\)/.test(task) && /dubaiInputToIso\(editDueAt\)/.test(task));
  for (const f of ["src/app/(dashboard)/contracts/[id]/page.tsx", "src/app/(dashboard)/contracts/page.tsx", "src/app/(dashboard)/payments/page.tsx", "src/app/(dashboard)/quotes/quote-detail-dialog.tsx"]) {
    assert.ok(!/new Date\(\)\.toISOString\(\)\.slice\(0, 10\)\)?;/.test(read(f).replace(/dubaiDateKey\(\) \?\? new Date\(\)\.toISOString\(\)\.slice\(0, 10\)/g, "")), f);
    assert.match(read(f), /dubaiDateKey\(\)/, f);
  }
});
