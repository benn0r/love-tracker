import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const port = 43871;
const dataDir = await mkdtemp(join(tmpdir(), "love-tracker-"));
const server = spawn(process.execPath, ["server.js"], {
  env: {
    ...process.env,
    PORT: String(port),
    DATA_DIR: dataDir,
    NODE_ENV: "test",
    APP_VERSION: "test-build",
    LOVE_NAME: "Nayane & Ben",
    IP_GEOLOCATION_ENABLED: "false",
  },
  stdio: ["ignore", "pipe", "pipe"],
});

await new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error("Server did not start")), 5000);
  server.stdout.on("data", (chunk) => {
    if (chunk.toString().includes("listening")) {
      clearTimeout(timeout);
      resolve();
    }
  });
  server.once("exit", (code) => reject(new Error(`Server exited with ${code}`)));
});

test.after(async () => {
  server.kill();
  await rm(dataDir, { recursive: true, force: true });
});

test("health endpoint reports ready", async () => {
  const response = await fetch(`http://localhost:${port}/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "ok" });
});

test("version endpoint identifies the running deployment", async () => {
  const response = await fetch(`http://localhost:${port}/api/version`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { version: "test-bu" });
});

test("HTML embeds the deployment version in its footer and asset URLs", async () => {
  const response = await fetch(`http://localhost:${port}/`);
  const html = await response.text();
  assert.match(html, />vtest-bu<\/span>/);
  assert.match(html, /\/app\.js\?v=test-bu/);
  assert.match(html, /\/i18n\.js\?v=test-bu/);
  assert.match(html, /\/styles\.css\?v=test-bu/);
  assert.match(html, /made with <span>♥<\/span> for Nayane &amp; Ben/);
  assert.match(html, /placeholder="e\.g\. Nayane &amp; Ben"/);
  assert.doesNotMatch(html, /__APP_VERSION__/);
  assert.doesNotMatch(html, /__LOVE_NAME__/);
});

test("private answer HTML carries the same deployment footer and fresh asset URLs", async () => {
  const response = await fetch(`http://localhost:${port}/respond/example-token`);
  const html = await response.text();
  assert.match(html, /made with <span>♥<\/span> for Nayane &amp; Ben/);
  assert.match(html, />vtest-bu<\/span>/);
  assert.match(html, /\/respond\.js\?v=test-bu/);
  assert.match(html, /\/i18n\.js\?v=test-bu/);
  assert.match(html, /\/styles\.css\?v=test-bu/);
  assert.doesNotMatch(html, /__(APP_VERSION|LOVE_NAME)__/);
});

test("application scripts are never stored so new reveal features load immediately", async () => {
  const response = await fetch(`http://localhost:${port}/app.js`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store, no-cache, must-revalidate, max-age=0");
  assert.equal(response.headers.get("pragma"), "no-cache");
});

test("creates and answers a love request", async () => {
  let responseUrl = "";
  server.stdout.on("data", (chunk) => {
    const match = chunk.toString().match(/(http:\/\/localhost:\d+\/respond\/\S+)/);
    if (match) responseUrl = match[1];
  });

  const createResponse = await fetch(`http://localhost:${port}/api/requests`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Nayane",
      location: { latitude: 47.3769, longitude: 8.5417 },
    }),
  });
  assert.equal(createResponse.status, 201);
  const created = await createResponse.json();

  await new Promise((resolve) => setTimeout(resolve, 25));
  const token = responseUrl.split("/").pop();
  assert.ok(token);

  const privateRequestResponse = await fetch(`http://localhost:${port}/api/respond/${token}`);
  assert.deepEqual(await privateRequestResponse.json(), {
    name: "Nayane",
    answered: false,
    value: null,
    requesterLocation: { latitude: 47.38, longitude: 8.54 },
    ipLocation: null,
  });

  const photoUploadResponse = await fetch(`http://localhost:${port}/api/respond/${token}/photo`, {
    method: "POST",
    headers: { "Content-Type": "image/jpeg" },
    body: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
  });
  assert.equal(photoUploadResponse.status, 201);
  assert.equal((await photoUploadResponse.json()).saved, true);

  const answerResponse = await fetch(`http://localhost:${port}/api/respond/${token}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      value: 875,
      location: { latitude: 47.3885, longitude: 8.175 },
    }),
  });
  assert.equal(answerResponse.status, 200);

  const statusResponse = await fetch(`http://localhost:${port}/api/requests/${created.id}`);
  assert.deepEqual(await statusResponse.json(), {
    id: created.id,
    name: "Nayane",
    status: "answered",
    value: 875,
    journey: {
      from: { latitude: 47.39, longitude: 8.18 },
      to: { latitude: 47.38, longitude: 8.54 },
    },
    photoUrl: `/api/requests/${created.id}/photo`,
  });
  const photoResponse = await fetch(`http://localhost:${port}/api/requests/${created.id}/photo`);
  assert.equal(photoResponse.status, 200);
  assert.equal(photoResponse.headers.get("content-type"), "image/jpeg");
});

test("rejects invalid names and percentages", async () => {
  const response = await fetch(`http://localhost:${port}/api/requests`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "" }),
  });
  assert.equal(response.status, 400);
});
