import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dataDir = await mkdtemp(join(tmpdir(), "love-tracker-e2e-"));
const notifications = [];
const notificationWaiters = [];

const mockPushover = createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  const notification = Object.fromEntries(new URLSearchParams(body));
      const waiter = notificationWaiters.shift();
      if (waiter) {
        waiter(notification);
      } else {
        notifications.push(notification);
      }
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ status: 1, request: "mock-request" }));
});

await new Promise((resolve) => mockPushover.listen(0, "127.0.0.1", resolve));
const mockPort = mockPushover.address().port;

const portProbe = createServer();
await new Promise((resolve) => portProbe.listen(0, "127.0.0.1", resolve));
const appPort = portProbe.address().port;
await new Promise((resolve) => portProbe.close(resolve));

let serverError = "";
const app = spawn(process.execPath, ["server.js"], {
  env: {
    ...process.env,
    PORT: String(appPort),
    DATA_DIR: dataDir,
    NODE_ENV: "production",
    PUBLIC_URL: `http://127.0.0.1:${appPort}`,
    PUSHOVER_APP_TOKEN: "mock-app-token",
    PUSHOVER_USER_KEY: "mock-user-key",
    PUSHOVER_API_URL: `http://127.0.0.1:${mockPort}/messages`,
    IP_GEOLOCATION_ENABLED: "false",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
app.stderr.on("data", (chunk) => {
  serverError += chunk.toString();
});

await new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error(`E2E app did not start: ${serverError}`)), 5000);
  app.stdout.on("data", (chunk) => {
    if (chunk.toString().includes("listening")) {
      clearTimeout(timeout);
      resolve();
    }
  });
  app.once("exit", (code) => reject(new Error(`E2E app exited with ${code}: ${serverError}`)));
});

test.after(async () => {
  app.kill();
  await new Promise((resolve) => mockPushover.close(resolve));
  await rm(dataDir, { recursive: true, force: true });
});

function nextNotification() {
  if (notifications.length) return Promise.resolve(notifications.shift());
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Mock notification was not received")), 3000);
    notificationWaiters.push((notification) => {
      clearTimeout(timeout);
      resolve(notification);
    });
  });
}

async function createRequest(name, location) {
  const notificationPromise = nextNotification();
  const response = await fetch(`http://127.0.0.1:${appPort}/api/requests`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, ...(location ? { location } : {}) }),
  });
  assert.equal(response.status, 201);
  const request = await response.json();
  const notification = await notificationPromise;

  assert.equal(notification.token, "mock-app-token");
  assert.equal(notification.user, "mock-user-key");
  assert.equal(notification.priority, "1");
  assert.equal(notification.url_title, `Answer ${name}`);
  assert.match(notification.message, new RegExp(`^${name} wants to know`));

  const answerUrl = new URL(notification.url);
  assert.equal(answerUrl.origin, `http://127.0.0.1:${appPort}`);
  assert.match(answerUrl.pathname, /^\/respond\/[A-Za-z0-9_-]+$/);
  return { request, answerUrl };
}

test("complete notification flow with shared locations", async () => {
  const requesterLocation = { latitude: 47.3769, longitude: 8.5417 };
  const responderLocation = { latitude: 47.3885, longitude: 8.175 };
  const { request, answerUrl } = await createRequest("Ada", requesterLocation);

  const privateResponse = await fetch(
    `http://127.0.0.1:${appPort}/api${answerUrl.pathname}`,
  );
  assert.equal(privateResponse.status, 200);
  assert.deepEqual(await privateResponse.json(), {
    name: "Ada",
    answered: false,
    value: null,
    requesterLocation: { latitude: 47.38, longitude: 8.54 },
    ipLocation: null,
  });

  const answerResponse = await fetch(
    `http://127.0.0.1:${appPort}/api${answerUrl.pathname}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: 875, location: responderLocation }),
    },
  );
  assert.equal(answerResponse.status, 200);

  const resultResponse = await fetch(
    `http://127.0.0.1:${appPort}/api/requests/${request.id}`,
  );
  assert.equal(resultResponse.status, 200);
  assert.deepEqual(await resultResponse.json(), {
    id: request.id,
    name: "Ada",
    status: "answered",
    value: 875,
    journey: {
      from: { latitude: 47.39, longitude: 8.18 },
      to: { latitude: 47.38, longitude: 8.54 },
    },
    photoUrl: null,
  });
});

test("complete notification flow without locations", async () => {
  const { request, answerUrl } = await createRequest("Grace", null);

  const privateResponse = await fetch(
    `http://127.0.0.1:${appPort}/api${answerUrl.pathname}`,
  );
  assert.equal(privateResponse.status, 200);
  assert.deepEqual(await privateResponse.json(), {
    name: "Grace",
    answered: false,
    value: null,
    requesterLocation: null,
    ipLocation: null,
  });

  const answerResponse = await fetch(
    `http://127.0.0.1:${appPort}/api${answerUrl.pathname}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: 100 }),
    },
  );
  assert.equal(answerResponse.status, 200);

  const resultResponse = await fetch(
    `http://127.0.0.1:${appPort}/api/requests/${request.id}`,
  );
  assert.equal(resultResponse.status, 200);
  assert.deepEqual(await resultResponse.json(), {
    id: request.id,
    name: "Grace",
    status: "answered",
    value: 100,
    journey: null,
    photoUrl: null,
  });
});
