import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("self password change uses the authenticated server identity with the admin client", () => {
  const route = readFileSync("src/app/api/users/[id]/password/route.ts", "utf8");
  const selfChange = route.slice(route.indexOf('if (targetId === "change-password")'), route.indexOf('const { data: profile }'));

  assert.match(selfChange, /adminClient\.auth\.admin\.updateUserById\(user\.id, \{ password \}\)/);
  assert.doesNotMatch(selfChange, /supabase\.auth\.updateUser/);
});
