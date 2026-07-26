import { test, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let app;
let appPort;
let baseUrl;
let dataDir;
let mockPushover;
let serverError = "";
const notifications = [];
const notificationWaiters = [];

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "love-tracker-e2e-"));
  mockPushover = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const notification = Object.fromEntries(new URLSearchParams(body));
    const waiter = notificationWaiters.shift();
    if (waiter) waiter(notification);
    else notifications.push(notification);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: 1, request: "mock-request" }));
  });

  await listen(mockPushover);
  const mockPort = mockPushover.address().port;
  appPort = await availablePort();
  baseUrl = `http://127.0.0.1:${appPort}`;

  app = spawn(process.execPath, ["server.js"], {
    env: {
      ...process.env,
      PORT: String(appPort),
      DATA_DIR: dataDir,
      NODE_ENV: "production",
      PUBLIC_URL: baseUrl,
      PUSHOVER_APP_TOKEN: "mock-app-token",
      PUSHOVER_USER_KEY: "mock-user-key",
      PUSHOVER_API_URL: `http://127.0.0.1:${mockPort}/messages`,
      IP_GEOLOCATION_ENABLED: "false",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  app.stderr.on("data", (chunk) => { serverError += chunk.toString(); });
  await waitForApp();
});

test.afterAll(async () => {
  if (app && !app.killed) {
    app.kill();
    await Promise.race([
      new Promise((resolve) => app.once("exit", resolve)),
      new Promise((resolve) => setTimeout(resolve, 1000)),
    ]);
  }
  if (mockPushover?.listening) {
    await new Promise((resolve) => mockPushover.close(resolve));
  }
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
});

test("complete browser journey with shared locations", async ({ browser }, testInfo) => {
  const requesterLocation = { latitude: 47.3769, longitude: 8.5417 };
  const responderLocation = { latitude: 47.3885, longitude: 8.175 };
  const requester = await browser.newContext({
    baseURL: baseUrl,
    locale: "en-US",
    geolocation: requesterLocation,
    permissions: ["geolocation"],
  });
  const responder = await browser.newContext({
    baseURL: baseUrl,
    locale: "en-US",
    geolocation: responderLocation,
    permissions: ["geolocation"],
  });

  try {
    const page = await requester.newPage();
    await page.goto("/");
    await page.locator("#name").fill("Ada");
    await page.locator('label[for="share-location"]').click();
    await expect(page.locator("#share-location")).toBeChecked();
    const notificationPromise = nextNotification();
    await page.locator('#ask-form button[type="submit"]').click();
    await expect(page).toHaveURL(/\/request\/[0-9a-f-]+$/);
    await expect(page.locator("#waiting-view")).toBeVisible();
    await attachScreenshot(page, testInfo, "with-location-waiting");

    const notification = await notificationPromise;
    assertNotification(notification, "Ada");
    const answerPage = await responder.newPage();
    await answerPage.goto(notification.url);
    await expect(answerPage.locator("#response-form-view")).toBeVisible();
    await expect(answerPage.locator("#request-location-map")).toBeVisible();
    await answerPage.locator("#value").fill("875");
    await attachScreenshot(answerPage, testInfo, "with-location-answer");
    await answerPage.locator('#response-form button[type="submit"]').click();
    await expect(answerPage.locator("#sent-view")).toBeVisible();

    await expect(page.locator("#result-view")).toBeVisible({ timeout: 10_000 });
    await expect(page.locator("#result-number")).toHaveText("875", { timeout: 6_000 });
    await expect(page.locator("#love-map")).toBeVisible();
    await expect(page.locator(".progress-track")).toHaveAttribute("aria-valuenow", "100");
    await attachScreenshot(page, testInfo, "with-location-result");

    const requestId = new URL(page.url()).pathname.split("/").pop();
    const result = await (await requester.request.get(`/api/requests/${requestId}`)).json();
    expect(result.journey).toEqual({
      from: { latitude: 47.39, longitude: 8.18 },
      to: { latitude: 47.38, longitude: 8.54 },
    });
  } finally {
    await requester.close().catch(() => {});
    await responder.close().catch(() => {});
  }
});

test("complete browser journey without locations", async ({ browser }, testInfo) => {
  const requester = await browser.newContext({ baseURL: baseUrl, locale: "en-US" });
  const responder = await browser.newContext({ baseURL: baseUrl, locale: "en-US" });

  try {
    const page = await requester.newPage();
    await page.goto("/");
    await page.locator("#name").fill("Grace");
    await expect(page.locator("#share-location")).not.toBeChecked();
    const notificationPromise = nextNotification();
    await page.locator('#ask-form button[type="submit"]').click();
    await expect(page.locator("#waiting-view")).toBeVisible();
    await attachScreenshot(page, testInfo, "without-location-waiting");

    const notification = await notificationPromise;
    assertNotification(notification, "Grace");
    const answerPage = await responder.newPage();
    await answerPage.goto(notification.url);
    await expect(answerPage.locator("#response-form-view")).toBeVisible();
    await expect(answerPage.locator("#request-location-map")).toBeHidden();
    await answerPage.locator("#value").fill("100");
    await attachScreenshot(answerPage, testInfo, "without-location-answer");
    await answerPage.locator('#response-form button[type="submit"]').click();
    await expect(answerPage.locator("#sent-view")).toBeVisible();

    await expect(page.locator("#result-view")).toBeVisible({ timeout: 10_000 });
    await expect(page.locator("#result-number")).toHaveText("100", { timeout: 6_000 });
    await expect(page.locator("#love-map")).toBeHidden();
    await attachScreenshot(page, testInfo, "without-location-result");

    const requestId = new URL(page.url()).pathname.split("/").pop();
    const result = await (await requester.request.get(`/api/requests/${requestId}`)).json();
    expect(result.journey).toBeNull();
  } finally {
    await requester.close().catch(() => {});
    await responder.close().catch(() => {});
  }
});

async function attachScreenshot(page, testInfo, name) {
  const path = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path, fullPage: true });
  await testInfo.attach(name, { path, contentType: "image/png" });
}

function assertNotification(notification, name) {
  expect(notification.token).toBe("mock-app-token");
  expect(notification.user).toBe("mock-user-key");
  expect(notification.priority).toBe("1");
  expect(notification.url_title).toBe(`Answer ${name}`);
  expect(notification.message).toMatch(new RegExp(`^${name} wants to know`));
  const answerUrl = new URL(notification.url);
  expect(answerUrl.origin).toBe(baseUrl);
  expect(answerUrl.pathname).toMatch(/^\/respond\/[A-Za-z0-9_-]+$/);
}

function nextNotification() {
  if (notifications.length) return Promise.resolve(notifications.shift());
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Mock notification was not received")), 10_000);
    notificationWaiters.push((notification) => {
      clearTimeout(timeout);
      resolve(notification);
    });
  });
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}

async function availablePort() {
  const probe = createServer();
  await listen(probe);
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

function waitForApp() {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`E2E app did not start: ${serverError}`)), 5000);
    app.stdout.on("data", (chunk) => {
      if (!chunk.toString().includes("listening")) return;
      clearTimeout(timeout);
      resolve();
    });
    app.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`E2E app exited with ${code}: ${serverError}`));
    });
  });
}
