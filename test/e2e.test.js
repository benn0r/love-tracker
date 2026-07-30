import { test, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import { createECDH, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import webpush from "web-push";

let app;
let appPort;
let baseUrl;
let dataDir;
let mockPushover;
let mockWebPush;
let pushEndpoint;
let serverError = "";
const notifications = [];
const notificationWaiters = [];
const pushDeliveries = [];
const pushWaiters = [];

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
  const [pushKey, pushCert] = await Promise.all([
    readFile(new URL("./fixtures/web-push-key.pem", import.meta.url)),
    readFile(new URL("./fixtures/web-push-cert.pem", import.meta.url)),
  ]);
  mockWebPush = createHttpsServer(
    { key: pushKey, cert: pushCert },
    async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const delivery = { headers: req.headers, body: Buffer.concat(chunks) };
      const waiter = pushWaiters.shift();
      if (waiter) waiter(delivery);
      else pushDeliveries.push(delivery);
      res.writeHead(201);
      res.end();
    },
  );
  await listen(mockWebPush);
  pushEndpoint = `https://localhost:${mockWebPush.address().port}/push`;
  const vapidKeys = webpush.generateVAPIDKeys();
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
      VAPID_PUBLIC_KEY: vapidKeys.publicKey,
      VAPID_PRIVATE_KEY: vapidKeys.privateKey,
      VAPID_SUBJECT: "mailto:tests@example.com",
      NODE_TLS_REJECT_UNAUTHORIZED: "0",
      LOVE_NAME: "Aurora",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  app.stderr.on("data", (chunk) => {
    serverError += chunk.toString();
  });
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
  if (mockWebPush?.listening) {
    await new Promise((resolve) => mockWebPush.close(resolve));
  }
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
});

test("complete browser journey with shared locations", async ({
  browser,
}, testInfo) => {
  const requesterLocation = { latitude: 51.5072, longitude: -0.1276 };
  const responderLocation = { latitude: 48.8566, longitude: 2.3522 };
  const requester = await browser.newContext({
    baseURL: baseUrl,
    locale: "en-US",
    viewport: { width: 390, height: 844 },
    isMobile: true,
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
    await installPushMock(page);
    await page.goto("/");
    await page.locator("#name").fill("Ada");
    await page.locator('label[for="share-location"]').click();
    await expect(page.locator("#share-location")).toBeChecked();
    const notificationPromise = nextNotification();
    await page.locator('#ask-form button[type="submit"]').click();
    await expect(page).toHaveURL(/\/request\/[0-9a-f-]+$/);
    await expect(page.locator("#waiting-view")).toBeVisible();
    await expect(page.locator("#enable-push")).toBeVisible();
    await page.locator("#enable-push").click();
    await expect(page.locator("#push-status")).toContainText(
      "You’ll get a notification",
    );
    await expect(page.locator("#waiting-phrase")).not.toBeEmpty();
    const pushStatusBox = await page.locator("#push-status").boundingBox();
    const waitingPhraseBox = await page
      .locator("#waiting-phrase")
      .boundingBox();
    expect(pushStatusBox).not.toBeNull();
    expect(waitingPhraseBox).not.toBeNull();
    expect(
      waitingPhraseBox.y - (pushStatusBox.y + pushStatusBox.height),
    ).toBeGreaterThanOrEqual(12);
    await attachScreenshot(page, testInfo, "with-location-waiting");

    const notification = await notificationPromise;
    assertNotification(notification, "Ada");
    const answerPage = await responder.newPage();
    await answerPage.goto(notification.url);
    await expect(answerPage.locator("#response-form-view")).toBeVisible();
    await expect(answerPage.locator("#request-location-map")).toBeVisible();
    await answerPage.locator("#value").fill("875");
    await attachScreenshot(answerPage, testInfo, "with-location-answer");
    const pushPromise = nextPushDelivery();
    await answerPage.locator('#response-form button[type="submit"]').click();
    await expect(answerPage.locator("#sent-view")).toBeVisible();
    const delivery = await pushPromise;
    expect(delivery.body.length).toBeGreaterThan(0);
    expect(delivery.headers.authorization).toBeTruthy();
    expect(delivery.headers.urgency).toBe("high");

    await expect(page.locator("#result-view")).toBeVisible({ timeout: 10_000 });
    await expect(page.locator("#result-number")).toHaveText("875", {
      timeout: 6_000,
    });
    await expect(page.locator("#love-map")).toBeVisible();
    await expect(page.locator(".progress-track")).toHaveAttribute(
      "aria-valuenow",
      "100",
    );
    await attachScreenshot(page, testInfo, "with-location-result");

    const requestId = new URL(page.url()).pathname.split("/").pop();
    const result = await (
      await requester.request.get(`/api/requests/${requestId}`)
    ).json();
    expect(result.journey).toEqual({
      from: { latitude: 48.86, longitude: 2.35 },
      to: { latitude: 51.51, longitude: -0.13 },
    });

    await page.locator("#again-button").click();
    await expect(page).toHaveURL(`${baseUrl}/`);
    await expect(page.locator("#ask-view")).toBeVisible();
    await expect(page.locator("#waiting-view")).toBeHidden();
    await page.locator("#name").fill("Beatrice");
    const secondNotificationPromise = nextNotification();
    await page.locator('#ask-form button[type="submit"]').click();
    await expect(page).toHaveURL(/\/request\/[0-9a-f-]+$/);
    await expect(page.locator("#waiting-view")).toBeVisible();
    await expect(page.locator("#waiting-copy")).toContainText("Beatrice");
    expect(new URL(page.url()).pathname).not.toBe(`/request/${requestId}`);
    assertNotification(await secondNotificationPromise, "Beatrice");
    await expect(page.locator("#ask-view")).toBeHidden();
  } finally {
    await requester.close().catch(() => {});
    await responder.close().catch(() => {});
  }
});

test("complete browser journey without locations", async ({
  browser,
}, testInfo) => {
  const deliveriesBefore = pushDeliveries.length;
  const requester = await browser.newContext({
    baseURL: baseUrl,
    locale: "en-US",
  });
  const responder = await browser.newContext({
    baseURL: baseUrl,
    locale: "en-US",
  });

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
    await expect(page.locator("#result-number")).toHaveText("100", {
      timeout: 6_000,
    });
    await expect(page.locator("#love-map")).toBeHidden();
    await attachScreenshot(page, testInfo, "without-location-result");

    const requestId = new URL(page.url()).pathname.split("/").pop();
    const result = await (
      await requester.request.get(`/api/requests/${requestId}`)
    ).json();
    expect(result.journey).toBeNull();
    expect(pushDeliveries.length).toBe(deliveriesBefore);
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
    const timeout = setTimeout(
      () => reject(new Error("Mock notification was not received")),
      10_000,
    );
    notificationWaiters.push((notification) => {
      clearTimeout(timeout);
      resolve(notification);
    });
  });
}

function nextPushDelivery() {
  if (pushDeliveries.length) return Promise.resolve(pushDeliveries.shift());
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Web Push delivery was not received")),
      10_000,
    );
    pushWaiters.push((delivery) => {
      clearTimeout(timeout);
      resolve(delivery);
    });
  });
}

async function installPushMock(page) {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const subscription = {
    endpoint: pushEndpoint,
    expirationTime: null,
    keys: {
      p256dh: ecdh.getPublicKey().toString("base64url"),
      auth: randomBytes(16).toString("base64url"),
    },
  };
  await page.addInitScript((mockSubscription) => {
    class MockNotification {
      static permission = "default";
      static async requestPermission() {
        this.permission = "granted";
        return "granted";
      }
    }
    const registration = {
      pushManager: {
        getSubscription: async () => null,
        subscribe: async () => ({ toJSON: () => mockSubscription }),
      },
    };
    Object.defineProperty(window, "Notification", {
      configurable: true,
      value: MockNotification,
    });
    Object.defineProperty(window, "PushManager", {
      configurable: true,
      value: class PushManager {},
    });
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: {
        register: async () => registration,
        ready: Promise.resolve(registration),
      },
    });
  }, subscription);
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
    const timeout = setTimeout(
      () => reject(new Error(`E2E app did not start: ${serverError}`)),
      5000,
    );
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
