import http from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { isIP } from "node:net";
import { fileURLToPath } from "node:url";
import webpush from "web-push";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const PUBLIC_DIR = join(ROOT, "public");
const DATA_DIR = process.env.DATA_DIR || join(ROOT, "data");
const DATA_FILE = join(DATA_DIR, "requests.json");
const PHOTO_DIR = join(DATA_DIR, "photos");
const PORT = Number(process.env.PORT || 3000);
const APP_VERSION = String(process.env.APP_VERSION || process.env.SOURCE_COMMIT || "local").slice(0, 7);
const LOVE_NAME = String(process.env.LOVE_NAME || "Nayane").trim().slice(0, 60) || "Nayane";
const IP_GEOLOCATION_ENABLED = process.env.IP_GEOLOCATION_ENABLED !== "false";
const IP_GEOLOCATION_URL = process.env.IP_GEOLOCATION_URL || "https://ipwho.is/{ip}";
const VAPID_PUBLIC_KEY = String(process.env.VAPID_PUBLIC_KEY || "").trim();
const VAPID_PRIVATE_KEY = String(process.env.VAPID_PRIVATE_KEY || "").trim();
const VAPID_SUBJECT = String(process.env.VAPID_SUBJECT || "mailto:notifications@example.com").trim();
const WEB_PUSH_ENABLED = Boolean(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY);
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

if (WEB_PUSH_ENABLED) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
}

async function loadRequests() {
  await mkdir(DATA_DIR, { recursive: true });
  await mkdir(PHOTO_DIR, { recursive: true });
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
    if (new Date(item.createdAt).getTime() < cutoff) {
      requests.delete(id);
      if (item.photo?.filename) {
        unlink(join(PHOTO_DIR, item.photo.filename)).catch(() => {});
      }
    }
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

function redactRequestPath(rawUrl) {
  try {
    const pathname = new URL(rawUrl || "/", "http://localhost").pathname;
    return pathname
      .replace(/^\/respond\/[^/]+/, "/respond/[redacted]")
      .replace(/^\/request\/[^/]+/, "/request/[redacted]")
      .replace(/^\/api\/respond\/[^/]+/, "/api/respond/[redacted]")
      .replace(/^\/api\/requests\/[^/]+/, "/api/requests/[redacted]");
  } catch {
    return "/[invalid-url]";
  }
}

function logRequest(req, res) {
  const startedAt = Date.now();
  const request = {
    method: req.method || "UNKNOWN",
    path: redactRequestPath(req.url),
  };
  let logged = false;

  const writeLog = (outcome) => {
    if (logged) return;
    logged = true;
    console.log(JSON.stringify({
      type: "http_request",
      ...request,
      status: res.statusCode,
      durationMs: Date.now() - startedAt,
      outcome,
    }));
  };

  res.once("finish", () => writeLog("completed"));
  res.once("close", () => {
    if (!res.writableFinished) writeLog("aborted");
  });
}

async function readJson(req, maxBytes = 10_000) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > maxBytes) throw new Error("Payload too large");
  }
  return JSON.parse(raw || "{}");
}

async function readBuffer(req, maxBytes = 2_000_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new Error("Payload too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function getBaseUrl(req) {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/$/, "");
  const protocol = req.headers["x-forwarded-proto"] || "http";
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  return `${protocol}://${host}`;
}

function normalizeLocation(value) {
  if (value === undefined || value === null) return null;
  const latitude = Number(value.latitude);
  const longitude = Number(value.longitude);
  if (
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    latitude < -90 ||
    latitude > 90 ||
    longitude < -180 ||
    longitude > 180
  ) {
    return null;
  }
  return {
    latitude: Math.round(latitude * 100) / 100,
    longitude: Math.round(longitude * 100) / 100,
  };
}

function normalizePushSubscription(value) {
  if (!value || typeof value !== "object") return null;
  const endpoint = String(value.endpoint || "");
  const p256dh = String(value.keys?.p256dh || "");
  const auth = String(value.keys?.auth || "");
  if (
    !/^https:\/\//.test(endpoint) ||
    endpoint.length > 2000 ||
    !p256dh || p256dh.length > 200 ||
    !auth || auth.length > 100
  ) return null;
  return { endpoint, expirationTime: value.expirationTime || null, keys: { p256dh, auth } };
}

function pushCopy(language, name) {
  if (language === "de") {
    return { title: "Deine Liebesantwort ist da ♥", body: `${name}, öffne den Love Tracker und entdecke deine Antwort.` };
  }
  if (language === "pt-BR") {
    return { title: "Sua resposta de amor chegou ♥", body: `${name}, abra o Love Tracker e descubra sua resposta.` };
  }
  return { title: "Your love answer is ready ♥", body: `${name}, open Love Tracker and discover your answer.` };
}

async function sendAnswerPush(request, subscription) {
  if (!WEB_PUSH_ENABLED || !subscription) return;
  const copy = pushCopy(request.pushLanguage, request.name);
  try {
    await webpush.sendNotification(subscription, JSON.stringify({
      ...copy,
      url: `/request/${request.id}`,
      tag: `love-answer-${request.id}`,
    }), { TTL: 24 * 60 * 60, urgency: "high", timeout: 10_000 });
    console.log(`Answer notification delivered for request ${request.id}`);
  } catch (error) {
    console.warn(`Answer notification failed for request ${request.id}: ${error.statusCode || error.message}`);
  }
}

function decodePhoto(dataUrl, requestId) {
  if (!dataUrl) return null;
  const match = String(dataUrl).match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/);
  if (!match) throw new Error("Unsupported photo format");
  const bytes = Buffer.from(match[2], "base64");
  if (!bytes.length || bytes.length > 1_500_000) throw new Error("Photo is too large");

  const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8;
  const isPng = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const isWebp =
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP";
  if (!isJpeg && !isPng && !isWebp) throw new Error("Invalid photo data");

  const type = isJpeg ? "image/jpeg" : isPng ? "image/png" : "image/webp";
  const extension = isJpeg ? "jpg" : isPng ? "png" : "webp";
  return { bytes, type, filename: `${requestId}.${extension}` };
}

function validatePhotoBytes(bytes, contentType, requestId) {
  if (!bytes.length || bytes.length > 2_000_000) throw new Error("Photo is too large");
  const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8;
  const isPng = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const isWebp =
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP";
  if (!isJpeg && !isPng && !isWebp) throw new Error("Invalid photo data");

  const detectedType = isJpeg ? "image/jpeg" : isPng ? "image/png" : "image/webp";
  if (contentType && !contentType.startsWith(detectedType)) throw new Error("Photo type mismatch");
  const extension = isJpeg ? "jpg" : isPng ? "png" : "webp";
  return { bytes, type: detectedType, filename: `${requestId}.${extension}` };
}

function getClientIp(req) {
  const candidates = [
    req.headers["cf-connecting-ip"],
    req.headers["true-client-ip"],
    req.headers["x-real-ip"],
    ...String(req.headers["x-forwarded-for"] || "").split(","),
    req.socket.remoteAddress,
  ];

  for (const candidate of candidates) {
    let normalized = String(candidate || "").trim().replace(/^["']|["']$/g, "");
    if (normalized.startsWith("[") && normalized.includes("]")) {
      normalized = normalized.slice(1, normalized.indexOf("]"));
    }
    normalized = normalized.replace(/^::ffff:/, "");
    if (!isIP(normalized) && /^\d{1,3}(?:\.\d{1,3}){3}:\d+$/.test(normalized)) {
      normalized = normalized.slice(0, normalized.lastIndexOf(":"));
    }
    if (isIP(normalized) && !isPrivateIp(normalized)) return normalized;
  }
  return null;
}

function isPrivateIp(ip) {
  return (
    ip === "::1" ||
    ip.startsWith("10.") ||
    ip.startsWith("127.") ||
    ip.startsWith("192.168.") ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ||
    ip.startsWith("fc") ||
    ip.startsWith("fd") ||
    ip.startsWith("fe80:")
  );
}

async function getIpLocation(req) {
  if (!IP_GEOLOCATION_ENABLED) return null;
  const ip = getClientIp(req);
  if (!ip) {
    console.warn("IP location unavailable: no public client address was forwarded");
    return null;
  }

  try {
    const response = await fetch(IP_GEOLOCATION_URL.replace("{ip}", encodeURIComponent(ip)), {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(4000),
    });
    if (!response.ok) {
      console.warn(`IP location unavailable: provider returned ${response.status}`);
      return null;
    }
    const data = await response.json();
    if (data.success === false) {
      console.warn("IP location unavailable: provider rejected the lookup");
      return null;
    }
    const latitude = Number(data.latitude);
    const longitude = Number(data.longitude);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      console.warn("IP location unavailable: provider returned no coordinates");
      return null;
    }
    const location = {
      city: String(data.city || "").slice(0, 100),
      region: String(data.region || "").slice(0, 100),
      country: String(data.country || "").slice(0, 100),
      latitude: Math.round(latitude * 100) / 100,
      longitude: Math.round(longitude * 100) / 100,
    };
    console.log(`IP location resolved: ${[location.city, location.region, location.country].filter(Boolean).join(", ")}`);
    return location;
  } catch (error) {
    console.warn("IP location lookup failed:", error.message);
    return null;
  }
}

async function sendPushover(name, responseUrl) {
  const token = process.env.PUSHOVER_APP_TOKEN;
  const user = process.env.PUSHOVER_USER_KEY;
  const apiUrl = process.env.PUSHOVER_API_URL || "https://api.pushover.net/1/messages.json";
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
    priority: "1",
    sound: "magic",
  });
  const response = await fetch(apiUrl, {
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
  const requesterLocation = normalizeLocation(body.location);
  const ipLocation = await getIpLocation(req);

  const request = {
    id: randomUUID(),
    token: randomBytes(24).toString("base64url"),
    name,
    requesterLocation,
    ipLocation,
    responderLocation: null,
    photo: null,
    value: null,
    createdAt: new Date().toISOString(),
    answeredAt: null,
    pushSubscription: null,
    pushLanguage: null,
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

async function subscribeToRequest(req, res, id) {
  if (!WEB_PUSH_ENABLED) return sendJson(res, 503, { error: "Notifications are not configured." });
  const request = requests.get(id);
  if (!request) return sendJson(res, 404, { error: "This love note has expired." });
  if (request.value !== null) return sendJson(res, 409, { error: "This love note was already answered." });
  let body;
  try {
    body = await readJson(req, 12_000);
  } catch {
    return sendJson(res, 400, { error: "That notification subscription could not be read." });
  }
  const subscription = normalizePushSubscription(body.subscription);
  if (!subscription) return sendJson(res, 400, { error: "Invalid notification subscription." });
  request.pushSubscription = subscription;
  request.pushLanguage = ["en", "de", "pt-BR"].includes(body.language) ? body.language : "en";
  await saveRequests();
  sendJson(res, 201, { subscribed: true });
}

function getRequest(res, id) {
  const request = requests.get(id);
  if (!request) return sendJson(res, 404, { error: "This love note has expired." });
  sendJson(res, 200, {
    id: request.id,
    name: request.name,
    status: request.value === null ? "waiting" : "answered",
    value: request.value,
    journey:
      request.value !== null &&
      (request.requesterLocation || request.location) &&
      request.responderLocation
        ? {
            from: request.responderLocation,
            to: request.requesterLocation || request.location,
          }
        : null,
    photoUrl: request.value !== null && request.photo ? `/api/requests/${request.id}/photo` : null,
  });
}

async function getRequestPhoto(res, id) {
  const request = requests.get(id);
  if (!request || request.value === null || !request.photo?.filename) {
    return sendJson(res, 404, { error: "Photo not found." });
  }
  try {
    const content = await readFile(join(PHOTO_DIR, request.photo.filename));
    res.writeHead(200, {
      "Content-Type": request.photo.type,
      "Content-Length": content.length,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    });
    res.end(content);
  } catch {
    sendJson(res, 404, { error: "Photo not found." });
  }
}

function getResponseRequest(res, token) {
  const request = [...requests.values()].find((item) => item.token === token);
  if (!request) return sendJson(res, 404, { error: "This private link has expired." });
  sendJson(res, 200, {
    name: request.name,
    answered: request.value !== null,
    value: request.value,
    requesterLocation: request.requesterLocation || request.location || null,
    ipLocation: request.ipLocation || null,
  });
}

async function answerRequest(req, res, token) {
  const request = [...requests.values()].find((item) => item.token === token);
  if (!request) return sendJson(res, 404, { error: "This private link has expired." });

  let body;
  try {
    body = await readJson(req, 2_100_000);
  } catch {
    return sendJson(res, 400, { error: "That answer could not be read." });
  }
  const value = Number(body.value);
  if (!Number.isInteger(value) || value < 0 || value > 1000) {
    return sendJson(res, 400, { error: "Choose a whole number between 0 and 1000." });
  }

  request.value = value;
  request.responderLocation = normalizeLocation(body.location);
  if (body.photo) {
    let photo;
    try {
      photo = decodePhoto(body.photo, request.id);
    } catch (error) {
      return sendJson(res, 400, { error: error.message });
    }
    await writeFile(join(PHOTO_DIR, photo.filename), photo.bytes);
    request.photo = { filename: photo.filename, type: photo.type };
  }
  request.answeredAt = new Date().toISOString();
  const pushSubscription = request.pushSubscription;
  request.pushSubscription = null;
  await saveRequests();
  await sendAnswerPush(request, pushSubscription);
  sendJson(res, 200, { ok: true, value });
}

async function uploadResponsePhoto(req, res, token) {
  const request = [...requests.values()].find((item) => item.token === token);
  if (!request) return sendJson(res, 404, { error: "This private link has expired." });
  if (request.value !== null) return sendJson(res, 409, { error: "This love note was already answered." });

  try {
    const bytes = await readBuffer(req);
    const photo = validatePhotoBytes(bytes, String(req.headers["content-type"] || ""), request.id);
    await writeFile(join(PHOTO_DIR, photo.filename), photo.bytes);
    request.photo = { filename: photo.filename, type: photo.type };
    await saveRequests();
    console.log(`Photo saved for request ${request.id} (${photo.bytes.length} bytes)`);
    sendJson(res, 201, { saved: true, bytes: photo.bytes.length });
  } catch (error) {
    console.error("Could not save response photo:", error.message);
    sendJson(res, 400, { error: error.message || "The photo could not be saved." });
  }
}

async function serveFile(res, pathname) {
  const requested = pathname === "/" ? "index.html" : pathname.slice(1);
  const filePath = normalize(join(PUBLIC_DIR, requested));
  if (!filePath.startsWith(PUBLIC_DIR)) return sendJson(res, 403, { error: "Forbidden" });
  try {
    let content = await readFile(filePath);
    const extension = extname(filePath);
    if (extension === ".html") {
      const escapeHtml = (value) =>
        value.replace(/[&<>"']/g, (character) => ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[character]);
      content = Buffer.from(
        content
          .toString()
          .replaceAll("__APP_VERSION__", APP_VERSION)
          .replaceAll("__LOVE_NAME__", escapeHtml(LOVE_NAME)),
      );
    }
    const noStoreExtensions = new Set([".html", ".js", ".css", ".webmanifest"]);
    const shouldNotStore = noStoreExtensions.has(extension);
    res.writeHead(200, {
      "Content-Type": contentTypes[extension] || "application/octet-stream",
      "Cache-Control": shouldNotStore
        ? "no-store, no-cache, must-revalidate, max-age=0"
        : "public, max-age=3600",
      ...(shouldNotStore ? { Pragma: "no-cache", Expires: "0" } : {}),
      "X-Content-Type-Options": "nosniff",
    });
    res.end(content);
  } catch {
    sendJson(res, 404, { error: "Not found" });
  }
}

const server = http.createServer(async (req, res) => {
  logRequest(req, res);
  const url = new URL(req.url, "http://localhost");
  const pathname = decodeURIComponent(url.pathname);

  try {
    if (req.method === "GET" && pathname === "/health") {
      return sendJson(res, 200, { status: "ok" });
    }
    if (req.method === "GET" && pathname === "/api/version") {
      return sendJson(res, 200, { version: APP_VERSION });
    }
    if (req.method === "GET" && pathname === "/api/push/config") {
      return sendJson(res, 200, { enabled: WEB_PUSH_ENABLED, publicKey: WEB_PUSH_ENABLED ? VAPID_PUBLIC_KEY : null });
    }
    if (req.method === "POST" && pathname === "/api/requests") {
      return await createRequest(req, res);
    }

    const requestMatch = pathname.match(/^\/api\/requests\/([0-9a-f-]+)$/);
    if (req.method === "GET" && requestMatch) return getRequest(res, requestMatch[1]);
    const subscriptionMatch = pathname.match(/^\/api\/requests\/([0-9a-f-]+)\/push-subscription$/);
    if (req.method === "POST" && subscriptionMatch) {
      return await subscribeToRequest(req, res, subscriptionMatch[1]);
    }
    const requestPhotoMatch = pathname.match(/^\/api\/requests\/([0-9a-f-]+)\/photo$/);
    if (req.method === "GET" && requestPhotoMatch) {
      return await getRequestPhoto(res, requestPhotoMatch[1]);
    }

    const responseApiMatch = pathname.match(/^\/api\/respond\/([A-Za-z0-9_-]+)$/);
    if (responseApiMatch && req.method === "GET") return getResponseRequest(res, responseApiMatch[1]);
    if (responseApiMatch && req.method === "POST") {
      return await answerRequest(req, res, responseApiMatch[1]);
    }
    const responsePhotoMatch = pathname.match(/^\/api\/respond\/([A-Za-z0-9_-]+)\/photo$/);
    if (responsePhotoMatch && req.method === "POST") {
      return await uploadResponsePhoto(req, res, responsePhotoMatch[1]);
    }

    if (req.method === "GET" && /^\/respond\/[A-Za-z0-9_-]+$/.test(pathname)) {
      return await serveFile(res, "/respond.html");
    }
    if (req.method === "GET" && /^\/request\/[0-9a-f-]+$/.test(pathname)) {
      return await serveFile(res, "/index.html");
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
