import { expect, test } from "@playwright/test";

const expectedSha = process.env.E2E_EXPECTED_SHA;
if (!/^[0-9a-f]{40}$/i.test(expectedSha ?? "")) {
  throw new Error("Staging authenticated E2E requires E2E_EXPECTED_SHA");
}

test("authenticated staging release gate proves session, version, role boundary, and clean console", async ({ page }, testInfo) => {
  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => consoleErrors.push(error.message));

  const dashboard = await page.goto("/dashboard", { waitUntil: "networkidle" });
  expect(dashboard?.status(), "dashboard request must succeed").toBe(200);

  const health = await page.request.get("/api/health");
  expect(health.status(), "health request must succeed").toBe(200);
  expect((await health.json()).version, "runtime version must match candidate SHA").toBe(expectedSha);

  const currentUser = await page.request.get("/api/auth/me");
  expect(currentUser.status(), "authenticated session must be accepted").toBe(200);
  expect((await currentUser.json()).isActive, "fixture user must be active").toBe(true);

  await page.goto("/team", { waitUntil: "networkidle" });
  if (testInfo.project.name === "boss") {
    await expect(page).toHaveURL(/\/team(?:[/?#]|$)/);
  }
  if (testInfo.project.name === "sales") {
    await expect(page).toHaveURL(/\/dashboard(?:[/?#]|$)/);
  }

  expect(consoleErrors, "console or page errors block release").toEqual([]);
});
