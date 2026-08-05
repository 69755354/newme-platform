import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = process.cwd();
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

test("auth and request-scoped mutation responses are explicitly private and uncached", () => {
  const authMe = read("src/app/api/auth/me/route.ts");
  const requestAuth = read("src/lib/request-auth-context.ts");

  for (const source of [authMe, requestAuth]) {
    assert.match(source, /private, no-store, max-age=0, must-revalidate/);
    assert.match(source, /response\.headers\.set\("Cache-Control"/);
    assert.match(source, /response\.headers\.set\("Vary", "Cookie, Authorization"\)/);
  }

  assert.match(authMe, /applyPrivateNoStore\(NextResponse\.json\(body, init\)\)/);
  assert.match(requestAuth, /const response = applyPrivateNoStore/);
  assert.match(requestAuth, /applyPrivateNoStore\(response\)/);
});
