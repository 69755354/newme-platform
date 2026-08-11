import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// F-07: self-service password change must prove ownership of the CURRENT
// password. This suite previously asserted that the reset route performed the
// self-change itself (`updateUserById(user.id, { password })`) with no old-password
// proof — it pinned the vulnerable implementation as the expected one. The
// assertions below check the security property instead of the source shape.

test("admin reset route uses the shared admin client and never a raw client", () => {
  const route = readFileSync("src/app/api/users/[id]/password/route.ts", "utf8");
  assert.match(route, /import \{ supabaseAdmin \} from "@\/lib\/supabase-admin"/);
  assert.doesNotMatch(route, /createClient\(/);
});

test("reset route refuses to change a password without old-password proof", () => {
  const route = readFileSync("src/app/api/users/[id]/password/route.ts", "utf8");
  const start = route.indexOf('if (targetId === "change-password")');
  assert.notEqual(start, -1, "the change-password guard must still be present");
  const selfChange = route.slice(start, route.indexOf("const { data: profile }", start));

  // It must NOT update any password on this path...
  assert.doesNotMatch(selfChange, /updateUserById/);
  assert.doesNotMatch(selfChange, /supabase\.auth\.updateUser/);
  // ...and must reject, pointing at the verifying endpoint.
  assert.match(selfChange, /status:\s*400/);
  assert.match(selfChange, /change-password/);
});

test("the verifying endpoint proves the old password before updating", () => {
  const verifying = readFileSync("src/app/api/auth/change-password/route.ts", "utf8");
  const signInAt = verifying.search(/signInWithPassword/);
  const updateAt = verifying.search(/updateUserById/);
  assert.notEqual(signInAt, -1, "must re-authenticate with the current password");
  assert.notEqual(updateAt, -1, "must then update the password");
  assert.ok(signInAt < updateAt, "verification must happen BEFORE the update");
  assert.match(verifying, /oldPassword/);
});

test("no caller-supplied identity is trusted for a self password change", () => {
  const verifying = readFileSync("src/app/api/auth/change-password/route.ts", "utf8");
  // The subject must come from the authenticated session, never the request body.
  assert.match(verifying, /updateUserById\(\s*\n?\s*user\.id/);
});
