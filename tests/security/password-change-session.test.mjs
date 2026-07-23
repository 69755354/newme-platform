import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("password endpoints use the shared validated admin client and the authenticated server identity", () => {
  const route = readFileSync("src/app/api/users/[id]/password/route.ts", "utf8");
  const start = route.indexOf('if (targetId === "change-password")');
  const selfChange = route.slice(start, route.indexOf('const { data: profile }', start));

  assert.match(route, /import \{ supabaseAdmin \} from "@\/lib\/supabase-admin"/);
  assert.doesNotMatch(route, /createClient\(/);
  assert.match(selfChange, /supabaseAdmin\.auth\.admin\.updateUserById\(user\.id, \{ password \}\)/);
  assert.doesNotMatch(selfChange, /supabase\.auth\.updateUser/);
});
