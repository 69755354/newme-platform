import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../../${path}`, import.meta.url), "utf8");

function assertCanonicalServiceName(logger, unit) {
  assert.match(logger, /const CANONICAL_SERVICE_NAME = "newme-platform";/);
  assert.match(logger, /service: CANONICAL_SERVICE_NAME/);
  assert.doesNotMatch(logger, /process\.env\.SERVICE_NAME|newme-crm/);
  assert.match(unit, /^SyslogIdentifier=newme-platform$/m);
}

test("SAM-72 application and journald logs use one canonical service name", async () => {
  const [logger, unit] = await Promise.all([
    read("src/lib/logger.ts"),
    read("infra/systemd/newme-platform.service"),
  ]);

  assertCanonicalServiceName(logger, unit);
});

test("SAM-72 service-name contract rejects legacy, configurable, and unit drift", async (t) => {
  const [logger, unit] = await Promise.all([
    read("src/lib/logger.ts"),
    read("infra/systemd/newme-platform.service"),
  ]);

  await t.test("rejects the legacy application name", () => {
    assert.throws(
      () => assertCanonicalServiceName(
        logger.replace("newme-platform", "newme-crm"),
        unit,
      ),
    );
  });

  await t.test("rejects an environment-overridable application name", () => {
    assert.throws(
      () => assertCanonicalServiceName(
        logger.replace(
          "service: CANONICAL_SERVICE_NAME",
          "service: process.env.SERVICE_NAME || CANONICAL_SERVICE_NAME",
        ),
        unit,
      ),
    );
  });

  await t.test("rejects a journald identifier mismatch", () => {
    assert.throws(
      () => assertCanonicalServiceName(
        logger,
        unit.replace(
          "SyslogIdentifier=newme-platform",
          "SyslogIdentifier=newme-service",
        ),
      ),
    );
  });
});
