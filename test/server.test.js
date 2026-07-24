import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const port = 43871;
const dataDir = await mkdtemp(join(tmpdir(), "love-tracker-"));
const server = spawn(process.execPath, ["server.js"], {
  env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, NODE_ENV: "test" },
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

test("creates and answers a love request", async () => {
  let responseUrl = "";
  server.stdout.on("data", (chunk) => {
    const match = chunk.toString().match(/(http:\/\/localhost:\d+\/respond\/\S+)/);
    if (match) responseUrl = match[1];
  });

  const createResponse = await fetch(`http://localhost:${port}/api/requests`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Nayane" }),
  });
  assert.equal(createResponse.status, 201);
  const created = await createResponse.json();

  await new Promise((resolve) => setTimeout(resolve, 25));
  const token = responseUrl.split("/").pop();
  assert.ok(token);

  const answerResponse = await fetch(`http://localhost:${port}/api/respond/${token}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ value: 875 }),
  });
  assert.equal(answerResponse.status, 200);

  const statusResponse = await fetch(`http://localhost:${port}/api/requests/${created.id}`);
  assert.deepEqual(await statusResponse.json(), {
    id: created.id,
    name: "Nayane",
    status: "answered",
    value: 875,
  });
});

test("rejects invalid names and percentages", async () => {
  const response = await fetch(`http://localhost:${port}/api/requests`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "" }),
  });
  assert.equal(response.status, 400);
});
