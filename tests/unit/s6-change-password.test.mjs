// S6 · review 4d #2/#3 (总报告 一.4): the forced password-change page gave no
// feedback for any outcome, jumped to /login ~1.5 s after success without a
// word, and accepted a new password identical to the old one.
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const Module = require("node:module");
const ROOT = path.resolve(import.meta.dirname, "../..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

const validation = await import("../../src/lib/password-change-validation.mjs");

function loadTs(relativePath, mocks) {
  const ts = require("typescript");
  const filename = path.join(ROOT, relativePath);
  const { outputText } = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    fileName: filename,
    compilerOptions: { esModuleInterop: true, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const loaded = new Module(filename);
  loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  const previous = Module._load;
  Module._load = function mocked(request, parent, isMain) {
    if (Object.hasOwn(mocks, request)) return mocks[request];
    return previous.call(this, request, parent, isMain);
  };
  try {
    loaded._compile(outputText, filename);
    return loaded.exports;
  } finally {
    Module._load = previous;
  }
}

function loadRoute({ correctPassword = "old-secret-1" } = {}) {
  const calls = { signIn: 0, update: 0, revoke: 0 };
  const route = loadTs("src/app/api/auth/change-password/route.ts", {
    "next/server": {
      NextResponse: { json: (body, init = {}) => ({ body, status: init.status ?? 200 }) },
    },
    "@/lib/supabase-server": {
      createServerSupabase: async () => ({
        auth: {
          getUser: async () => ({ data: { user: { id: "u1", email: "u1@example.com" } }, error: null }),
          signInWithPassword: async ({ password }) => {
            calls.signIn += 1;
            return { error: password === correctPassword ? null : { message: "Invalid login credentials" } };
          },
        },
      }),
    },
    "@/lib/supabase-admin": {
      supabaseAdmin: {
        auth: { admin: { updateUserById: async () => { calls.update += 1; return { error: null }; } } },
        from: () => ({ update: () => ({ eq: async () => ({ error: null }) }) }),
        rpc: async () => { calls.revoke += 1; return { data: { verified: true }, error: null }; },
      },
    },
    "@/lib/logger": { logger: { error() {}, warn() {}, info() {} } },
    "@/lib/password-change-validation.mjs": validation,
  });
  return { route, calls };
}

const request = (body) => ({ headers: new Headers(), json: async () => body });

test("validator: same-as-old, mismatch, too short and missing fields are distinct codes", () => {
  const v = validation.validatePasswordChange;
  assert.equal(v({ oldPassword: "abcdef1", newPassword: "abcdef1", confirmPassword: "abcdef1" }), "same_as_old");
  assert.equal(v({ oldPassword: "abcdef1", newPassword: "abcdef2", confirmPassword: "abcdef3" }), "mismatch");
  assert.equal(v({ oldPassword: "abcdef1", newPassword: "abc", confirmPassword: "abc" }), "too_short");
  assert.equal(v({ oldPassword: "", newPassword: "abcdef2" }), "missing_fields");
  assert.equal(v({ oldPassword: "abcdef1", newPassword: "abcdef2", confirmPassword: "abcdef2" }), null);
  assert.equal(v({ oldPassword: "abcdef1", newPassword: "abcdef2" }), null, "server path has no confirm field");
});

test("API refuses a new password equal to the current one before touching auth", async () => {
  const { route, calls } = loadRoute();
  const res = await route.POST(request({ oldPassword: "old-secret-1", newPassword: "old-secret-1" }));
  assert.equal(res.status, 400);
  assert.equal(res.body.code, "same_as_old");
  assert.equal(calls.update, 0, "password must not be updated");
  assert.equal(calls.signIn, 0, "no credential check is needed to refuse");
});

test("API returns stable codes for wrong current password and too-short passwords", async () => {
  const { route, calls } = loadRoute();
  const wrong = await route.POST(request({ oldPassword: "nope-nope", newPassword: "brand-new-2" }));
  assert.equal(wrong.status, 400);
  assert.equal(wrong.body.code, "wrong_current_password");
  const short = await route.POST(request({ oldPassword: "old-secret-1", newPassword: "abc" }));
  assert.equal(short.status, 400);
  assert.equal(short.body.code, "too_short");
  assert.equal(calls.update, 0);
});

test("API still succeeds for a genuinely new password", async () => {
  const { route, calls } = loadRoute();
  const res = await route.POST(request({ oldPassword: "old-secret-1", newPassword: "brand-new-2" }));
  assert.equal(res.status, 200);
  assert.equal(res.body.success, true);
  assert.equal(calls.update, 1);
});

test("every change-password code has Chinese and English text", async () => {
  const src = read("src/lib/i18n/translations.ts");
  const scratch = fs.mkdtempSync(path.join((await import("node:os")).tmpdir(), "s6-cp-"));
  const file = path.join(scratch, "t.mjs");
  fs.writeFileSync(file, src.replace(/\} as const;/, "};").replace(/^export type .*$/gm, ""));
  const { translations } = await import(file);
  const get = (lang, key) => key.split(".").reduce((n, k) => (n && typeof n === "object" ? n[k] : undefined), translations[lang]);
  for (const code of validation.PASSWORD_CHANGE_CODES) {
    const key = validation.passwordChangeMessageKey(code);
    for (const lang of ["en", "zh"]) {
      assert.equal(typeof get(lang, key), "string", `${lang}:${key} missing for ${code}`);
    }
  }
  for (const key of ["changePassword.successContinuing", "changePassword.reloginRequired", "changePassword.goToLogin"]) {
    assert.equal(typeof get("zh", key), "string", key);
    assert.equal(typeof get("en", key), "string", key);
  }
});

test("page shows inline feedback, keeps the user on errors and does not silently bounce to login", () => {
  const page = read("src/app/(auth)/change-password/page.tsx");
  // The (auth) layout mounts no Toaster: toasts there were invisible.
  assert.doesNotMatch(page, /toast\./, "toasts render nowhere on this page");
  assert.match(page, /role="alert"/, "errors must be announced inline");
  assert.match(page, /role="status"/, "success must be shown inline");
  assert.match(page, /validatePasswordChange\(/, "client applies the shared rules (incl. same-as-old)");
  assert.match(page, /passwordChangeMessageKey\(/);
  assert.doesNotMatch(page, /setTimeout\(\(\) => \{\s*window\.location\.href = "\/login"/, "no unexplained timed bounce to login");
  // Success continues into the app by signing in with the new password; only
  // when that is impossible does the page explain that a re-login is required.
  assert.match(page, /\/api\/auth\/login/);
  assert.match(page, /changePassword\.reloginRequired/);
});
