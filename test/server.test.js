import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dataDir = await mkdtemp(join(tmpdir(), "love-tracker-unit-"));
const notifications = [];
let app;
let appOutput = "";
let baseUrl;

const notificationServer = createServer(async (req, res) => {
  if (req.url?.startsWith("/geo/")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(
      JSON.stringify({
        success: true,
        city: "Moonlight Bay",
        region: "Rose Coast",
        country: "Wonderland",
        latitude: 12.345,
        longitude: 67.894,
      }),
    );
  }

  let raw = "";
  for await (const chunk of req) raw += chunk;
  const notification = Object.fromEntries(new URLSearchParams(raw));
  if (notification.message?.startsWith("Delivery Failure")) {
    res.writeHead(503, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ status: 0 }));
  }
  notifications.push(notification);
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ status: 1, request: "mock-request" }));
});

await listen(notificationServer);
const notificationPort = notificationServer.address().port;
app = spawn(process.execPath, ["server.js"], {
  env: {
    PATH: process.env.PATH,
    PORT: "0",
    DATA_DIR: dataDir,
    NODE_ENV: "test",
    APP_VERSION: "test-build",
    LOVE_NAME: "Aurora & Orion",
    PUSHOVER_APP_TOKEN: "mock-app-token",
    PUSHOVER_USER_KEY: "mock-user-key",
    PUSHOVER_API_URL: `http://127.0.0.1:${notificationPort}/messages`,
    IP_GEOLOCATION_ENABLED: "true",
    IP_GEOLOCATION_URL: `http://127.0.0.1:${notificationPort}/geo/{ip}`,
    VAPID_PUBLIC_KEY: "",
    VAPID_PRIVATE_KEY: "",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
baseUrl = `http://127.0.0.1:${await waitForListeningPort(app)}`;
await waitForHealth();

test.after(async () => {
  await stopProcess(app);
  if (notificationServer.listening) {
    await new Promise((resolve) => notificationServer.close(resolve));
  }
  await rm(dataDir, { recursive: true, force: true });
});

test("health, version, and disabled push configuration are stable", async () => {
  const health = await fetchJson("/health");
  assert.equal(health.response.status, 200);
  assert.deepEqual(health.body, { status: "ok" });

  const version = await fetchJson("/api/version");
  assert.deepEqual(version.body, { version: "test-bu" });

  const push = await fetchJson("/api/push/config");
  assert.deepEqual(push.body, { enabled: false, publicKey: null });
});

test("HTML is personalized, escaped, versioned, and never cached", async () => {
  for (const path of ["/", "/respond/example-token"]) {
    const response = await fetch(`${baseUrl}${path}`);
    const html = await response.text();
    assert.equal(response.status, 200);
    assert.equal(
      response.headers.get("cache-control"),
      "no-store, no-cache, must-revalidate, max-age=0",
    );
    assert.match(html, /made with <span>♥<\/span> for Aurora &amp; Orion/);
    assert.match(html, />\s*vtest-bu<\/span/);
    assert.match(html, /\/i18n\.js\?v=test-bu/);
    assert.match(html, /\/styles\.css\?v=test-bu/);
    assert.match(html, /\/vendor\/fonts\/fonts\.css\?v=test-bu/);
    assert.match(html, /\/vendor\/leaflet\/leaflet\.css\?v=test-bu/);
    assert.match(html, /\/vendor\/leaflet\/leaflet\.js\?v=test-bu/);
    assert.doesNotMatch(html, /unpkg\.com|fonts\.googleapis\.com/);
    assert.doesNotMatch(html, /__(APP_VERSION|LOVE_NAME)__/);
  }

  const mainHtml = await (await fetch(`${baseUrl}/`)).text();
  assert.match(mainHtml, /\/app\.js\?v=test-bu/);
  assert.match(mainHtml, /id="waiting-phrase"/);
  assert.match(mainHtml, /id="enable-push"/);
  assert.match(mainHtml, /placeholder="e\.g\. Aurora &amp; Orion"/);

  const answerHtml = await (
    await fetch(`${baseUrl}/respond/example-token`)
  ).text();
  assert.match(answerHtml, /\/respond\.js\?v=test-bu/);
  assert.match(answerHtml, /<button type="submit">\s*<span data-button-label/);
});

test("scripts, manifests, and the service worker are served fresh", async () => {
  for (const path of [
    "/app.js",
    "/respond.js",
    "/i18n.js",
    "/styles.css",
    "/manifest.webmanifest",
    "/sw.js",
  ]) {
    const response = await fetch(`${baseUrl}${path}`);
    assert.equal(response.status, 200, path);
    assert.equal(
      response.headers.get("cache-control"),
      "no-store, no-cache, must-revalidate, max-age=0",
      path,
    );
    assert.equal(response.headers.get("pragma"), "no-cache", path);
  }
  assert.match(
    await (await fetch(`${baseUrl}/sw.js`)).text(),
    /notificationclick/,
  );
});

test("serves bundled Leaflet and font assets locally", async () => {
  const assets = [
    ["/vendor/leaflet/leaflet.js", "text/javascript; charset=utf-8"],
    ["/vendor/leaflet/leaflet.css", "text/css; charset=utf-8"],
    ["/vendor/leaflet/images/marker-icon.png", "image/png"],
    ["/vendor/fonts/fonts.css", "text/css; charset=utf-8"],
    ["/vendor/fonts/dm-sans-latin-400-normal.woff2", "font/woff2"],
    ["/vendor/fonts/italiana-latin-400-normal.woff2", "font/woff2"],
  ];

  for (const [path, contentType] of assets) {
    const response = await fetch(`${baseUrl}${path}`);
    assert.equal(response.status, 200, path);
    assert.equal(response.headers.get("content-type"), contentType, path);
    assert.ok((await response.arrayBuffer()).byteLength > 0, path);
  }
});

test("creates a private waiting request and sends the expected notification", async () => {
  const created = await createRequest({ name: "  Ada   Lovelace  " });
  assert.equal(created.response.status, 201);
  assert.equal(created.body.name, "Ada Lovelace");
  assert.match(created.body.id, /^[0-9a-f-]{36}$/);
  assert.equal(Object.hasOwn(created.body, "token"), false);

  assert.equal(created.notification.token, "mock-app-token");
  assert.equal(created.notification.user, "mock-user-key");
  assert.equal(created.notification.priority, "1");
  assert.equal(created.notification.url_title, "Answer Ada Lovelace");
  assert.match(created.notification.message, /^Ada Lovelace wants to know/);

  const answerUrl = new URL(created.notification.url);
  assert.equal(answerUrl.origin, baseUrl);
  assert.match(answerUrl.pathname, /^\/respond\/[A-Za-z0-9_-]+$/);

  const waiting = await fetchJson(`/api/requests/${created.body.id}`);
  assert.deepEqual(waiting.body, {
    id: created.body.id,
    name: "Ada Lovelace",
    status: "waiting",
    value: null,
    journey: null,
    photoUrl: null,
  });

  const privateRequest = await fetchJson(
    `/api/respond/${answerUrl.pathname.split("/").pop()}`,
  );
  assert.deepEqual(privateRequest.body, {
    name: "Ada Lovelace",
    answered: false,
    value: null,
    requesterLocation: null,
    ipLocation: null,
  });
});

test("answers once, preserves the winner, and rejects sequential duplicates", async () => {
  const created = await createRequest({
    name: "Beatrice",
    location: { latitude: 51.5072, longitude: -0.1276 },
  });

  const first = await answer(created.token, {
    value: 875,
    location: { latitude: 48.8566, longitude: 2.3522 },
  });
  assert.equal(first.response.status, 200);
  assert.deepEqual(first.body, { ok: true, value: 875 });

  const duplicate = await answer(created.token, { value: 12 });
  assert.equal(duplicate.response.status, 409);

  const result = await fetchJson(`/api/requests/${created.body.id}`);
  assert.equal(result.body.value, 875);
  assert.deepEqual(result.body.journey, {
    from: { latitude: 48.86, longitude: 2.35 },
    to: { latitude: 51.51, longitude: -0.13 },
  });
});

test("allows only one winner when two answers arrive concurrently", async () => {
  const created = await createRequest({ name: "Celeste" });
  const submissions = await Promise.all([
    answer(created.token, { value: 222 }),
    answer(created.token, { value: 777 }),
  ]);
  assert.deepEqual(
    submissions.map(({ response }) => response.status).sort(),
    [200, 409],
  );

  const winner = submissions.find(({ response }) => response.status === 200)
    .body.value;
  const result = await fetchJson(`/api/requests/${created.body.id}`);
  assert.equal(result.body.value, winner);
});

test("strictly validates score type and boundaries without changing state", async () => {
  const invalidValues = [-1, 1001, 1.5, "100", "", null, true, [], {}];
  const created = await createRequest({ name: "Dahlia" });
  for (const value of invalidValues) {
    const result = await answer(created.token, { value });
    assert.equal(result.response.status, 400, JSON.stringify(value));
  }

  const missing = await answer(created.token, {});
  assert.equal(missing.response.status, 400);
  const waiting = await fetchJson(`/api/requests/${created.body.id}`);
  assert.equal(waiting.body.status, "waiting");

  const lower = await answer(created.token, { value: 0 });
  assert.equal(lower.response.status, 200);

  const upperRequest = await createRequest({ name: "Ember" });
  const upper = await answer(upperRequest.token, { value: 1000 });
  assert.equal(upper.response.status, 200);
});

test("invalid inline photo does not partially answer the request", async () => {
  const created = await createRequest({ name: "Fable" });
  const response = await answer(created.token, {
    value: 500,
    photo: "data:text/plain;base64,bm90LWEtcGhvdG8=",
  });
  assert.equal(response.response.status, 400);

  const waiting = await fetchJson(`/api/requests/${created.body.id}`);
  assert.equal(waiting.body.status, "waiting");
  assert.equal(waiting.body.value, null);
});

test("photo upload is private, unavailable before answer, and immutable afterward", async () => {
  const created = await createRequest({ name: "Glimmer" });
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );

  const invalid = await fetch(`${baseUrl}/api/respond/${created.token}/photo`, {
    method: "POST",
    headers: { "Content-Type": "image/jpeg" },
    body: png,
  });
  assert.equal(invalid.status, 400);

  const upload = await fetch(`${baseUrl}/api/respond/${created.token}/photo`, {
    method: "POST",
    headers: { "Content-Type": "image/png" },
    body: png,
  });
  assert.equal(upload.status, 201);

  const beforeAnswer = await fetch(
    `${baseUrl}/api/requests/${created.body.id}/photo`,
  );
  assert.equal(beforeAnswer.status, 404);

  assert.equal(
    (await answer(created.token, { value: 100 })).response.status,
    200,
  );
  const photo = await fetch(`${baseUrl}/api/requests/${created.body.id}/photo`);
  assert.equal(photo.status, 200);
  assert.equal(photo.headers.get("content-type"), "image/png");
  assert.equal(photo.headers.get("cache-control"), "private, no-store");
  assert.equal(photo.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual(Buffer.from(await photo.arrayBuffer()), png);

  const replacement = await fetch(
    `${baseUrl}/api/respond/${created.token}/photo`,
    { method: "POST", headers: { "Content-Type": "image/png" }, body: png },
  );
  assert.equal(replacement.status, 409);
});

test("normalizes shared location and returns a bounded IP estimate", async () => {
  const created = await createRequest(
    {
      name: "Halo",
      location: { latitude: 40.71281, longitude: -74.00601 },
    },
    { "X-Forwarded-For": "203.0.113.9" },
  );
  const privateRequest = await fetchJson(`/api/respond/${created.token}`);
  assert.deepEqual(privateRequest.body.requesterLocation, {
    latitude: 40.71,
    longitude: -74.01,
  });
  assert.deepEqual(privateRequest.body.ipLocation, {
    city: "Moonlight Bay",
    region: "Rose Coast",
    country: "Wonderland",
    latitude: 12.35,
    longitude: 67.89,
  });
});

test("rejects malformed requests and invalid names", async () => {
  const malformed = await fetch(`${baseUrl}/api/requests`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{",
  });
  assert.equal(malformed.status, 400);

  for (const name of ["", " ", "x".repeat(61)]) {
    const { response } = await createRequest({ name }, {}, false);
    assert.equal(response.status, 400, JSON.stringify(name));
  }

  const exactLimit = await createRequest({ name: "x".repeat(60) });
  assert.equal(exactLimit.response.status, 201);
});

test("handles unknown capabilities, disabled subscriptions, and bad paths safely", async () => {
  assert.equal((await fetch(`${baseUrl}/api/requests/not-a-uuid`)).status, 404);
  assert.equal((await fetch(`${baseUrl}/api/respond/not-a-token`)).status, 404);
  assert.equal(
    (await fetch(`${baseUrl}/api/requests/not-a-uuid/photo`)).status,
    404,
  );

  const created = await createRequest({ name: "Iris" });
  const subscription = await fetch(
    `${baseUrl}/api/requests/${created.body.id}/push-subscription`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subscription: {} }),
    },
  );
  assert.equal(subscription.status, 503);

  const badPath = await fetch(`${baseUrl}/%E0%A4%A`);
  assert.equal(badPath.status, 400);
  assert.equal((await fetch(`${baseUrl}/health`)).status, 200);
});

test("request logs redact public IDs, private tokens, query data, and names", async () => {
  const created = await createRequest({ name: "Secret Stardust" });
  const outputStart = appOutput.length;
  await fetch(`${baseUrl}/api/requests/${created.body.id}?private=value`);
  await fetch(`${baseUrl}/api/respond/${created.token}?private=value`);
  await new Promise((resolve) => setTimeout(resolve, 20));

  const logs = appOutput.slice(outputStart);
  assert.match(logs, /"path":"\/api\/requests\/\[redacted\]"/);
  assert.match(logs, /"path":"\/api\/respond\/\[redacted\]"/);
  assert.doesNotMatch(logs, new RegExp(created.body.id));
  assert.doesNotMatch(logs, new RegExp(created.token));
  assert.doesNotMatch(logs, /private=value|Secret Stardust/);
});

test("notification provider failure returns 502 and does not create a request", async () => {
  const before = notifications.length;
  const failed = await createRequest({ name: "Delivery Failure" }, {}, false);
  assert.equal(failed.response.status, 502);
  assert.equal(notifications.length, before);
});

test("removes expired capabilities and photos from memory and disk", async () => {
  const expiryDir = await mkdtemp(join(tmpdir(), "love-tracker-expiry-"));
  const photosDir = join(expiryDir, "photos");
  const expiredId = "00000000-0000-4000-8000-000000000001";
  const expiredToken = "expired-test-token-000000000000";
  const expiredPhoto = `${expiredId}.png`;
  await mkdir(photosDir, { recursive: true });
  await writeFile(join(photosDir, expiredPhoto), Buffer.from("expired"));
  await writeFile(
    join(expiryDir, "requests.json"),
    JSON.stringify([
      {
        id: expiredId,
        token: expiredToken,
        name: "Old Star",
        requesterLocation: null,
        ipLocation: null,
        responderLocation: null,
        photo: { filename: expiredPhoto, type: "image/png" },
        value: null,
        createdAt: new Date(Date.now() - 10_000).toISOString(),
        answeredAt: null,
        pushSubscription: null,
        pushLanguage: null,
      },
    ]),
  );

  const expiryApp = spawn(process.execPath, ["server.js"], {
    env: {
      PATH: process.env.PATH,
      PORT: "0",
      DATA_DIR: expiryDir,
      NODE_ENV: "test",
      REQUEST_TTL_MS: "80",
      PUSHOVER_APP_TOKEN: "mock-app-token",
      PUSHOVER_USER_KEY: "mock-user-key",
      PUSHOVER_API_URL: `http://127.0.0.1:${notificationPort}/messages`,
      IP_GEOLOCATION_ENABLED: "false",
      VAPID_PUBLIC_KEY: "",
      VAPID_PRIVATE_KEY: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  try {
    const expiryBaseUrl = `http://127.0.0.1:${await waitForListeningPort(expiryApp)}`;
    assert.equal(
      (await fetch(`${expiryBaseUrl}/api/requests/${expiredId}`)).status,
      404,
    );
    assert.equal(
      (await fetch(`${expiryBaseUrl}/api/respond/${expiredToken}`)).status,
      404,
    );
    assert.equal(
      (
        await fetch(`${expiryBaseUrl}/api/respond/${expiredToken}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ value: 100 }),
        })
      ).status,
      404,
    );
    assert.equal(
      (await fetch(`${expiryBaseUrl}/api/requests/${expiredId}/photo`)).status,
      404,
    );
    assert.deepEqual(
      JSON.parse(await readFile(join(expiryDir, "requests.json"), "utf8")),
      [],
    );
    await assert.rejects(readFile(join(photosDir, expiredPhoto)), {
      code: "ENOENT",
    });

    const notificationIndex = notifications.length;
    const createdResponse = await fetch(`${expiryBaseUrl}/api/requests`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Brief Comet" }),
    });
    assert.equal(createdResponse.status, 201);
    const created = await createdResponse.json();
    const createdToken = new URL(notifications[notificationIndex].url).pathname
      .split("/")
      .pop();
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(
      (await fetch(`${expiryBaseUrl}/api/requests/${created.id}`)).status,
      404,
    );
    assert.equal(
      (await fetch(`${expiryBaseUrl}/api/respond/${createdToken}`)).status,
      404,
    );
    assert.deepEqual(
      JSON.parse(await readFile(join(expiryDir, "requests.json"), "utf8")),
      [],
    );
  } finally {
    await stopProcess(expiryApp);
    await rm(expiryDir, { recursive: true, force: true });
  }
});

async function createRequest(body, headers = {}, expectNotification = true) {
  const before = notifications.length;
  const response = await fetch(`${baseUrl}/api/requests`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const result = await response.json();
  const notification = notifications[before] || null;
  if (expectNotification && response.ok) assert.ok(notification);
  const token = notification
    ? new URL(notification.url).pathname.split("/").pop()
    : null;
  return { response, body: result, notification, token };
}

async function answer(token, body) {
  const response = await fetch(`${baseUrl}/api/respond/${token}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { response, body: await response.json() };
}

async function fetchJson(path) {
  const response = await fetch(`${baseUrl}${path}`);
  return { response, body: await response.json() };
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

function waitForListeningPort(child) {
  return new Promise((resolve, reject) => {
    let output = "";
    const timeout = setTimeout(
      () => reject(new Error(`Server did not start:\n${appOutput}`)),
      5000,
    );
    const onData = (chunk) => {
      const text = chunk.toString();
      appOutput += text;
      output += text;
      const match = output.match(/Love Tracker listening on port (\d+)/);
      if (!match) return;
      clearTimeout(timeout);
      resolve(Number(match[1]));
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", (chunk) => {
      appOutput += chunk.toString();
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`Server exited with ${code}:\n${appOutput}`));
    });
  });
}

async function waitForHealth() {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch {
      // The child may not have bound its socket yet; retry until the deadline.
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Health check timed out:\n${appOutput}`);
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill();
  await Promise.race([
    exited,
    new Promise((resolve) => setTimeout(resolve, 2000)),
  ]);
}
