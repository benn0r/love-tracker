import http from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const PUBLIC_DIR = join(ROOT, "public");
const DATA_DIR = process.env.DATA_DIR || join(ROOT, "data");
const DATA_FILE = join(DATA_DIR, "requests.json");
const PORT = Number(process.env.PORT || 3000);
const MAX_NAME_LENGTH = 60;
const REQUEST_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
};

let requests = new Map();
let saveQueue = Promise.resolve();

async function loadRequests() {
  await mkdir(DATA_DIR, { recursive: true });
  try {
    const stored = JSON.parse(await readFile(DATA_FILE, "utf8"));
    requests = new Map(stored.map((item) => [item.id, item]));
  } catch (error) {
    if (error.code !== "ENOENT") console.error("Could not load request data:", error);
  }
  pruneExpired();
}

function pruneExpired() {
  const cutoff = Date.now() - REQUEST_TTL_MS;
  for (const [id, item] of requests) {
    if (new Date(item.createdAt).getTime() < cutoff) requests.delete(id);
  }
}

function saveRequests() {
  const snapshot = JSON.stringify([...requests.values()], null, 2);
  saveQueue = saveQueue.then(async () => {
    const temporaryFile = `${DATA_FILE}.tmp`;
    await writeFile(temporaryFile, snapshot);
    await rename(temporaryFile, DATA_FILE);
  });
  return saveQueue;
}

function sendJson(res, status, value) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(JSON.stringify(value));
}

async function readJson(req) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 10_000) throw new Error("Payload too large");
  }
  return JSON.parse(raw || "{}");
}

function getBaseUrl(req) {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/$/, "");
  const protocol = req.headers["x-forwarded-proto"] || "http";
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  return `${protocol}://${host}`;
}

async function sendPushover(name, responseUrl) {
  const token = process.env.PUSHOVER_APP_TOKEN;
  const user = process.env.PUSHOVER_USER_KEY;
  if (!token || !user) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("Pushover credentials are not configured");
    }
    console.log(`Love request from ${name}: ${responseUrl}`);
    return;
  }

  const body = new URLSearchParams({
    token,
    user,
    title: "Someone is wondering… 💌",
    message: `${name} wants to know how much you love her.`,
    url: responseUrl,
    url_title: `Answer ${name}`,
    sound: "magic",
  });
  const response = await fetch("https://api.pushover.net/1/messages.json", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Pushover returned ${response.status}`);
}

async function createRequest(req, res) {
  let body;
  try {
    body = await readJson(req);
  } catch {
    return sendJson(res, 400, { error: "That request could not be read." });
  }

  const name = String(body.name || "").trim().replace(/\s+/g, " ");
  if (!name || name.length > MAX_NAME_LENGTH) {
    return sendJson(res, 400, { error: "Please enter a name of up to 60 characters." });
  }

  const request = {
    id: randomUUID(),
    token: randomBytes(24).toString("base64url"),
    name,
    value: null,
    createdAt: new Date().toISOString(),
    answeredAt: null,
  };
  const responseUrl = `${getBaseUrl(req)}/respond/${request.token}`;

  try {
    await sendPushover(name, responseUrl);
    requests.set(request.id, request);
    pruneExpired();
    await saveRequests();
    sendJson(res, 201, { id: request.id, name: request.name });
  } catch (error) {
    console.error("Could not create love request:", error);
    sendJson(res, 502, { error: "I couldn’t send the love note. Please try again in a moment." });
  }
}

function getRequest(res, id) {
  const request = requests.get(id);
  if (!request) return sendJson(res, 404, { error: "This love note has expired." });
  sendJson(res, 200, {
    id: request.id,
    name: request.name,
    status: request.value === null ? "waiting" : "answered",
    value: request.value,
  });
}

function getResponseRequest(res, token) {
  const request = [...requests.values()].find((item) => item.token === token);
  if (!request) return sendJson(res, 404, { error: "This private link has expired." });
  sendJson(res, 200, {
    name: request.name,
    answered: request.value !== null,
    value: request.value,
  });
}

async function answerRequest(req, res, token) {
  const request = [...requests.values()].find((item) => item.token === token);
  if (!request) return sendJson(res, 404, { error: "This private link has expired." });

  let body;
  try {
    body = await readJson(req);
  } catch {
    return sendJson(res, 400, { error: "That answer could not be read." });
  }
  const value = Number(body.value);
  if (!Number.isInteger(value) || value < 0 || value > 1000) {
    return sendJson(res, 400, { error: "Choose a whole number between 0 and 1000." });
  }

  request.value = value;
  request.answeredAt = new Date().toISOString();
  await saveRequests();
  sendJson(res, 200, { ok: true, value });
}

async function serveFile(res, pathname) {
  const requested = pathname === "/" ? "index.html" : pathname.slice(1);
  const filePath = normalize(join(PUBLIC_DIR, requested));
  if (!filePath.startsWith(PUBLIC_DIR)) return sendJson(res, 403, { error: "Forbidden" });
  try {
    const content = await readFile(filePath);
    res.writeHead(200, {
      "Content-Type": contentTypes[extname(filePath)] || "application/octet-stream",
      "Cache-Control": extname(filePath) === ".html" ? "no-cache" : "public, max-age=3600",
      "X-Content-Type-Options": "nosniff",
    });
    res.end(content);
  } catch {
    sendJson(res, 404, { error: "Not found" });
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const pathname = decodeURIComponent(url.pathname);

  try {
    if (req.method === "GET" && pathname === "/health") {
      return sendJson(res, 200, { status: "ok" });
    }
    if (req.method === "POST" && pathname === "/api/requests") {
      return await createRequest(req, res);
    }

    const requestMatch = pathname.match(/^\/api\/requests\/([0-9a-f-]+)$/);
    if (req.method === "GET" && requestMatch) return getRequest(res, requestMatch[1]);

    const responseApiMatch = pathname.match(/^\/api\/respond\/([A-Za-z0-9_-]+)$/);
    if (responseApiMatch && req.method === "GET") return getResponseRequest(res, responseApiMatch[1]);
    if (responseApiMatch && req.method === "POST") {
      return await answerRequest(req, res, responseApiMatch[1]);
    }

    if (req.method === "GET" && /^\/respond\/[A-Za-z0-9_-]+$/.test(pathname)) {
      return await serveFile(res, "/respond.html");
    }
    if (req.method === "GET") return await serveFile(res, pathname);
    sendJson(res, 404, { error: "Not found" });
  } catch (error) {
    console.error(error);
    sendJson(res, 500, { error: "Something went wrong." });
  }
});

await loadRequests();
server.listen(PORT, "0.0.0.0", () => {
  console.log(`Love Tracker listening on port ${PORT}`);
});
