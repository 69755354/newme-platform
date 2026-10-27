import { expect, test } from "@playwright/test";

test("production build serves anonymous release boundaries without browser errors", async ({
  baseURL,
  page,
  request,
}) => {
  expect(baseURL).toBeTruthy();

  const health = await request.get("/api/health");
  expect(health.status()).toBe(200);
  expect(await health.json()).toMatchObject({ status: "ok" });

  const root = await request.get("/", { maxRedirects: 0 });
  expect(root.status()).toBe(307);
  const rootLocation = root.headers().location;
  expect(rootLocation).toBeTruthy();
  expect(new URL(rootLocation, baseURL).pathname).toBe("/dashboard");

  const authMe = await request.get("/api/auth/me");
  expect(authMe.status()).toBe(401);

  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));

  const login = await page.goto("/login", { waitUntil: "load" });
  expect(login?.status()).toBe(200);
  await page.waitForLoadState("networkidle");
  await expect(page).toHaveURL(`${baseURL}/login`);
  await expect(page.locator('input[type="email"]').first()).toBeVisible();
  await expect(page.locator('input[type="password"]').first()).toBeVisible();
  await expect(page.locator('button[type="submit"]').first()).toBeVisible();
  await expect(page.locator("script#meta-pixel")).toHaveCount(0);

  expect(pageErrors, `unexpected page errors: ${pageErrors.join(" | ")}`).toEqual([]);
  expect(consoleErrors, `unexpected console errors: ${consoleErrors.join(" | ")}`).toEqual([]);
});
