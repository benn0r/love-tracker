import { test, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import { createECDH, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import webpush from "web-push";

let app;
let appPort;
let baseUrl;
let dataDir;
let mockPushover;
let mockWebPush;
let pushEndpoint;
let serverOutput = "";
const notifications = [];
const pushDeliveries = [];
const photoFixture = fileURLToPath(
  new URL("../public/apple-touch-icon.png", import.meta.url),
);

test.beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "love-tracker-e2e-"));
  mockPushover = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const notification = Object.fromEntries(new URLSearchParams(body));
    notifications.push(notification);
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
      pushDeliveries.push(delivery);
      res.writeHead(201);
      res.end();
    },
  );
  await listen(mockWebPush);
  pushEndpoint = `https://localhost:${mockWebPush.address().port}/push`;
  const vapidKeys = webpush.generateVAPIDKeys();

  app = spawn(process.execPath, ["server.js"], {
    env: {
      ...process.env,
      PORT: "0",
      DATA_DIR: dataDir,
      NODE_ENV: "production",
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
  app.stdout.on("data", (chunk) => {
    serverOutput += chunk.toString();
  });
  app.stderr.on("data", (chunk) => {
    serverOutput += chunk.toString();
  });
  appPort = await waitForApp();
  baseUrl = `http://127.0.0.1:${appPort}`;
  await waitForHealth();
});

test.afterAll(async () => {
  if (app && !app.killed) {
    const exited = new Promise((resolve) => app.once("exit", resolve));
    app.kill();
    await Promise.race([
      exited,
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
    const notificationIndex = notifications.length;
    await page.locator('#ask-form button[type="submit"]').click();
    await expect(page).toHaveURL(/\/request\/[0-9a-f-]+$/);
    await expect(page.locator("#waiting-view")).toBeVisible();
    const requestUrl = page.url();
    let transientStatusFailure = true;
    await page.route("**/api/requests/*", async (route) => {
      if (transientStatusFailure) {
        transientStatusFailure = false;
        return route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ error: "Temporary test outage" }),
        });
      }
      return route.fallback();
    });
    await page.reload();
    await expect(page).toHaveURL(requestUrl);
    await expect(page.locator("#waiting-view")).toBeVisible();
    await expect(page.locator("#ask-view")).toBeHidden();
    await expect(page.locator("#waiting-copy")).toContainText("Ada", {
      timeout: 5000,
    });
    await page.unroute("**/api/requests/*");
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
    ).toBeGreaterThanOrEqual(0);
    const phraseMargin = await page
      .locator("#waiting-phrase")
      .evaluate((element) => parseFloat(getComputedStyle(element).marginTop));
    expect(phraseMargin).toBeGreaterThanOrEqual(12);
    await attachScreenshot(page, testInfo, "with-location-waiting");

    const notification = await recordAt(
      notifications,
      notificationIndex,
      "Pushover notification",
    );
    assertNotification(notification, "Ada");
    const answerPage = await responder.newPage();
    await answerPage.goto(notification.url);
    await expect(answerPage.locator("#response-form-view")).toBeVisible();
    await expect(answerPage.locator("#request-location-map")).toBeVisible();
    await answerPage.locator("#value").fill("875");
    await answerPage.locator("#love-photo-input").setInputFiles(photoFixture);
    await expect(answerPage.locator("#photo-preview-wrap")).toBeVisible();
    await expect
      .poll(() =>
        answerPage
          .locator("#photo-preview")
          .evaluate((image) => image.complete && image.naturalWidth > 0),
      )
      .toBe(true);
    await attachScreenshot(answerPage, testInfo, "with-location-answer");
    const pushIndex = pushDeliveries.length;
    const seenNotificationIndex = notifications.length;
    await answerPage.locator('#response-form button[type="submit"]').click();
    await expect(answerPage.locator("#sent-view")).toBeVisible();
    const delivery = await recordAt(
      pushDeliveries,
      pushIndex,
      "Web Push delivery",
    );
    expect(delivery.body.length).toBeGreaterThan(0);
    expect(delivery.headers.authorization).toBeTruthy();
    expect(delivery.headers.urgency).toBe("high");

    await expect(page.locator("#result-view")).toBeVisible({ timeout: 10_000 });
    await expect(page.locator("#result-number")).toHaveText("875", {
      timeout: 6_000,
    });
    await expect(page.locator("#love-map")).toBeVisible();
    await expect(page.locator("#love-photo")).toBeVisible();
    assertSeenNotification(
      await recordAt(
        notifications,
        seenNotificationIndex,
        "Pushover seen notification",
      ),
      "Ada",
    );
    await expect
      .poll(() =>
        page
          .locator("#result-photo")
          .evaluate((image) => image.complete && image.naturalWidth > 0),
      )
      .toBe(true);
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
    const secondNotificationIndex = notifications.length;
    await page.locator('#ask-form button[type="submit"]').click();
    await expect(page).toHaveURL(/\/request\/[0-9a-f-]+$/);
    await expect(page.locator("#waiting-view")).toBeVisible();
    await expect(page.locator("#waiting-copy")).toContainText("Beatrice");
    expect(new URL(page.url()).pathname).not.toBe(`/request/${requestId}`);
    assertNotification(
      await recordAt(
        notifications,
        secondNotificationIndex,
        "second Pushover notification",
      ),
      "Beatrice",
    );
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
    const notificationIndex = notifications.length;
    await page.locator('#ask-form button[type="submit"]').click();
    await expect(page.locator("#waiting-view")).toBeVisible();
    await attachScreenshot(page, testInfo, "without-location-waiting");

    const notification = await recordAt(
      notifications,
      notificationIndex,
      "Pushover notification",
    );
    assertNotification(notification, "Grace");
    const answerPage = await responder.newPage();
    await answerPage.goto(notification.url);
    await expect(answerPage.locator("#response-form-view")).toBeVisible();
    await expect(answerPage.locator("#request-location-map")).toBeHidden();
    await answerPage.locator("#value").fill("100");
    await attachScreenshot(answerPage, testInfo, "without-location-answer");
    const seenNotificationIndex = notifications.length;
    await answerPage.locator('#response-form button[type="submit"]').click();
    await expect(answerPage.locator("#sent-view")).toBeVisible();

    await expect(page.locator("#result-view")).toBeVisible({ timeout: 10_000 });
    await expect(page.locator("#result-number")).toHaveText("100", {
      timeout: 6_000,
    });
    await expect(page.locator("#love-map")).toBeHidden();
    assertSeenNotification(
      await recordAt(
        notifications,
        seenNotificationIndex,
        "Pushover seen notification",
      ),
      "Grace",
    );
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

test("selects German and Brazilian Portuguese from browser preferences", async ({
  browser,
}) => {
  for (const language of [
    { locale: "de-DE", lang: "de", name: "Dein Name", button: "Fragen" },
    {
      locale: "pt-BR",
      lang: "pt-BR",
      name: "Seu nome",
      button: "Perguntar",
    },
  ]) {
    const context = await browser.newContext({
      baseURL: baseUrl,
      locale: language.locale,
    });
    try {
      const page = await context.newPage();
      await page.goto("/");
      await expect(page.locator("html")).toHaveAttribute("lang", language.lang);
      await expect(page.locator('label[for="name"]')).toHaveText(language.name);
      await expect(page.locator("[data-button-label]")).toHaveText(
        language.button,
      );
    } finally {
      await context.close();
    }
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

function assertSeenNotification(notification, name) {
  expect(notification.token).toBe("mock-app-token");
  expect(notification.user).toBe("mock-user-key");
  expect(notification.title).toBe("Love message seen 👀");
  expect(notification.message).toBe(`${name} has seen your love message. ♥`);
  expect(notification.priority).toBe("0");
  expect(notification.sound).toBe("magic");
  expect(notification.url).toBeUndefined();
}

async function recordAt(records, index, description) {
  await expect
    .poll(() => records.length, { message: `${description} was not received` })
    .toBeGreaterThan(index);
  return records[index];
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
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function waitForApp() {
  return new Promise((resolve, reject) => {
    let output = "";
    const timeout = setTimeout(
      () => reject(new Error(`E2E app did not start: ${serverOutput}`)),
      5000,
    );
    app.stdout.on("data", (chunk) => {
      output += chunk.toString();
      const match = output.match(/Love Tracker listening on port (\d+)/);
      if (!match) return;
      clearTimeout(timeout);
      resolve(Number(match[1]));
    });
    app.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`E2E app exited with ${code}: ${serverOutput}`));
    });
  });
}

async function waitForHealth() {
  await expect
    .poll(
      async () => {
        try {
          return (await fetch(`${baseUrl}/health`)).status;
        } catch {
          return 0;
        }
      },
      { message: `E2E app health check failed: ${serverOutput}` },
    )
    .toBe(200);
}
