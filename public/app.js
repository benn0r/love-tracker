const askView = document.querySelector("#ask-view");
const waitingView = document.querySelector("#waiting-view");
const resultView = document.querySelector("#result-view");
const askForm = document.querySelector("#ask-form");
const askError = document.querySelector("#ask-error");
const { locale, t, apply, resultMessages, waitingPhrases } = window.LoveI18n;
const loveName = document.body.dataset.loveName;
apply({ loveName });
if (location.pathname === "/" && new URL(location.href).searchParams.has("new")) {
  history.replaceState({}, "", "/");
}
const requestPathMatch = location.pathname.match(/^\/request\/([0-9a-f-]+)$/);
let pollTimer;
let phraseTimer;
let phraseTransitionTimer;
let phraseIndex = -1;
let currentRequestId = requestPathMatch?.[1] || null;

if (requestPathMatch) {
  askView.classList.add("hidden");
  waitingView.classList.remove("hidden");
  document.querySelector("#waiting-copy").textContent = t("request.restoring");
}

askForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  askError.textContent = "";
  const button = askForm.querySelector("button");
  const name = new FormData(askForm).get("name").trim();
  const wantsLocation = document.querySelector("#share-location").checked;
  button.disabled = true;
  const buttonLabel = button.querySelector("[data-button-label]");
  buttonLabel.textContent = t("ask.sending");

  try {
    let location = null;
    if (wantsLocation) {
      buttonLabel.textContent = t("ask.finding");
      location = await getApproximateLocation();
      buttonLabel.textContent = t("ask.sending");
    }
    const response = await fetch("/api/requests", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, location }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);
    history.pushState({}, "", `/request/${data.id}`);
    showWaiting(data);
  } catch (error) {
    askError.textContent = error.message || t("ask.error");
    button.disabled = false;
    buttonLabel.textContent = t("ask.button");
  }
});

function showWaiting(request) {
  currentRequestId = request.id;
  askView.classList.add("hidden");
  waitingView.classList.remove("hidden");
  document.querySelector("#waiting-copy").textContent = t("waiting.copy", { name: request.name });
  startWaitingPhrases();
  preparePushPrompt(request.id);
  poll(request.id, request.name);
}

async function preparePushPrompt(id) {
  const prompt = document.querySelector("#push-prompt");
  const button = document.querySelector("#enable-push");
  const status = document.querySelector("#push-status");
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) return;
  try {
    const config = await fetch("/api/push/config", { cache: "no-store" }).then((response) => response.json());
    if (!config.enabled || !config.publicKey || id !== currentRequestId) return;
    prompt.classList.remove("hidden");
    button.onclick = () => enablePush(id, config.publicKey, button, status);
    if (Notification.permission === "granted") {
      status.textContent = t("push.ready");
    }
  } catch (error) {
    console.error("Could not prepare notifications:", error);
  }
}

async function enablePush(id, publicKey, button, status) {
  button.disabled = true;
  status.textContent = t("push.enabling");
  try {
    const permission = await Notification.requestPermission();
    if (permission !== "granted") throw new Error(t("push.denied"));
    await navigator.serviceWorker.register("/sw.js");
    const registration = await navigator.serviceWorker.ready;
    const existing = await registration.pushManager.getSubscription();
    const subscription = existing || await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    });
    const response = await fetch(`/api/requests/${id}/push-subscription`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subscription: subscription.toJSON(), language: locale }),
    });
    if (!response.ok) throw new Error((await response.json()).error || t("push.error"));
    button.classList.add("hidden");
    status.textContent = t("push.enabled");
  } catch (error) {
    status.textContent = error.message || t("push.error");
    button.disabled = false;
  }
}

function urlBase64ToUint8Array(value) {
  const padding = "=".repeat((4 - value.length % 4) % 4);
  const base64 = (value + padding).replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
}

function startWaitingPhrases() {
  stopWaitingPhrases();
  const phrase = document.querySelector("#waiting-phrase");
  if (!phrase || !waitingPhrases?.length) return;

  const showNextPhrase = () => {
    let nextIndex = Math.floor(Math.random() * waitingPhrases.length);
    if (waitingPhrases.length > 1 && nextIndex === phraseIndex) {
      nextIndex = (nextIndex + 1) % waitingPhrases.length;
    }
    phraseIndex = nextIndex;
    phrase.classList.add("is-changing");
    phraseTransitionTimer = setTimeout(() => {
      phrase.textContent = waitingPhrases[phraseIndex];
      phrase.classList.remove("is-changing");
    }, 250);
  };

  showNextPhrase();
  phraseTimer = setInterval(showNextPhrase, 4200);
}

function stopWaitingPhrases() {
  clearInterval(phraseTimer);
  clearTimeout(phraseTransitionTimer);
}

async function poll(id, name) {
  try {
    const response = await fetch(`/api/requests/${id}`);
    const data = await response.json();
    if (!response.ok) {
      if (response.status === 404) return showExpiredRequest();
      throw new Error(data.error);
    }
    if (data.status === "answered") {
      return showResult(data.name || name, data.value, data.journey, data.photoUrl);
    }
  } catch (error) {
    console.error(error);
  }
  pollTimer = setTimeout(() => poll(id, name), 1800);
}

async function restoreRequest(id) {
  try {
    const response = await fetch(`/api/requests/${id}`, { cache: "no-store" });
    const data = await response.json();
    if (!response.ok) return showExpiredRequest();
    if (data.status === "answered") {
      return showResult(data.name, data.value, data.journey, data.photoUrl);
    }
    showWaiting(data);
  } catch (error) {
    console.error(error);
    showExpiredRequest();
  }
}

function showExpiredRequest() {
  clearTimeout(pollTimer);
  stopWaitingPhrases();
  waitingView.classList.add("hidden");
  resultView.classList.add("hidden");
  askView.classList.remove("hidden");
  askView.innerHTML = `
    <p class="eyebrow">${t("request.expiredEyebrow")}</p>
    <h1><em>${t("request.expiredTitle")}</em></h1>
    <p class="intro">${t("request.expiredCopy")}</p>
    <button type="button" id="new-request-button">${t("request.new")}</button>
  `;
  document.querySelector("#new-request-button").addEventListener("click", () => location.assign("/"));
}

function showResult(name, value, journey, photoUrl) {
  clearTimeout(pollTimer);
  stopWaitingPhrases();
  waitingView.classList.add("hidden");
  resultView.classList.remove("hidden");
  document.querySelector("#push-prompt").classList.add("hidden");
  document.querySelector("#result-title").innerHTML = t("result.title", { name: escapeHtml(name) });
  document.querySelector("#result-message").textContent = pickResultMessage(value);
  if (journey) showLoveMap(name, journey);
  if (photoUrl) showLovePhoto(photoUrl);

  const duration = 2200;
  const started = performance.now();
  const number = document.querySelector("#result-number");
  const fill = document.querySelector("#progress-fill");
  const progressBar = document.querySelector(".progress-track");
  const normalizedValue = Math.min(value, 100);
  document.body.classList.add("celebrate");

  function animate(now) {
    const progress = Math.min((now - started) / duration, 1);
    const eased = 1 - Math.pow(1 - progress, 4);
    number.textContent = Math.round(value * eased);
    const displayedProgress = normalizedValue * eased;
    fill.style.width = `${displayedProgress}%`;
    progressBar.setAttribute("aria-valuenow", String(Math.round(displayedProgress)));
    if (progress < 1) requestAnimationFrame(animate);
  }
  requestAnimationFrame(animate);
}

async function showLovePhoto(photoUrl) {
  const figure = document.querySelector("#love-photo");
  const image = document.querySelector("#result-photo");
  const caption = document.querySelector("#photo-caption");
  const retryButton = document.querySelector("#retry-photo");
  let objectUrl;

  const reveal = () => {
    figure.classList.remove("hidden");
    requestAnimationFrame(() => figure.classList.add("photo-reveal"));
  };

  async function load(attempt = 1) {
    retryButton.classList.add("hidden");
    caption.textContent = attempt > 1 ? t("result.photoLoading") : t("result.photoCaption");
    try {
      const separator = photoUrl.includes("?") ? "&" : "?";
      const response = await fetch(`${photoUrl}${separator}fresh=${Date.now()}`, {
        cache: "no-store",
        headers: { "Cache-Control": "no-cache" },
      });
      if (!response.ok) throw new Error(`Photo returned ${response.status}`);
      const blob = await response.blob();
      if (!blob.type.startsWith("image/") || !blob.size) throw new Error("Invalid photo response");
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      objectUrl = URL.createObjectURL(blob);
      image.addEventListener("load", reveal, { once: true });
      image.src = objectUrl;
      caption.textContent = t("result.photoCaption");
    } catch (error) {
      if (attempt < 4) {
        setTimeout(() => load(attempt + 1), attempt * 700);
        return;
      }
      console.error("Could not load love photo:", error);
      figure.classList.remove("hidden");
      figure.classList.add("photo-reveal");
      caption.textContent = t("result.photoDelayed");
      retryButton.classList.remove("hidden");
    }
  }

  retryButton.onclick = () => load(1);
  load();
}

function getApproximateLocation() {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => resolve({
        latitude: Math.round(coords.latitude * 100) / 100,
        longitude: Math.round(coords.longitude * 100) / 100,
      }),
      () => resolve(null),
      { enableHighAccuracy: false, timeout: 8000, maximumAge: 300000 },
    );
  });
}

function showLoveMap(name, journey) {
  const map = document.querySelector("#love-map");
  const mapTitle = document.querySelector("#love-map-title");
  const latDirection = journey.to.latitude >= journey.from.latitude ? "north" : "south";
  const lonDirection = journey.to.longitude >= journey.from.longitude ? "east" : "west";
  const direction = t(`direction.${latDirection}-${lonDirection}`);

  mapTitle.textContent = t("result.journeyDynamic", { direction, name });
  map.classList.remove("hidden");
  requestAnimationFrame(() => initializeRealMap(name, journey));
}

function initializeRealMap(name, journey) {
  if (!window.L) return;
  const origin = [journey.from.latitude, journey.from.longitude];
  const destination = [journey.to.latitude, journey.to.longitude];
  const map = L.map("real-map", {
    attributionControl: true,
    scrollWheelZoom: false,
    zoomControl: true,
  });

  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(map);

  const route = createArchedRoute(origin, destination);
  const originIcon = L.divIcon({
    className: "love-map-marker",
    html: '<span class="marker-core">♥</span>',
    iconSize: [30, 30],
    iconAnchor: [15, 15],
  });
  const destinationIcon = L.divIcon({
    className: "love-map-marker destination-marker",
    html: '<span class="marker-core">♥</span><span class="marker-pulse"></span>',
    iconSize: [30, 30],
    iconAnchor: [15, 15],
  });

  L.marker(origin, { icon: originIcon })
    .addTo(map)
    .bindTooltip(t("result.origin"), { permanent: true, direction: "bottom", offset: [0, 12] });
  L.marker(destination, { icon: destinationIcon })
    .addTo(map)
    .bindTooltip(name, { permanent: true, direction: "bottom", offset: [0, 12] });

  L.polyline(route, {
    color: "#bd3955",
    weight: 4,
    opacity: 0.85,
    dashArray: "7 10",
    lineCap: "round",
    className: "arched-love-route",
  }).addTo(map);

  map.fitBounds(L.latLngBounds(route), {
    padding: [58, 58],
    maxZoom: 12,
  });

  const travellingIcon = L.divIcon({
    className: "travelling-map-heart",
    html: "♥",
    iconSize: [28, 28],
    iconAnchor: [14, 14],
  });
  const travellingHeart = L.marker(origin, {
    icon: travellingIcon,
    interactive: false,
    keyboard: false,
    zIndexOffset: 1000,
  }).addTo(map);

  if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    animateHeartAlongRoute(travellingHeart, route);
  }
}

function createArchedRoute(from, to) {
  const pointCount = 64;
  let longitudeDelta = to[1] - from[1];
  if (longitudeDelta > 180) longitudeDelta -= 360;
  if (longitudeDelta < -180) longitudeDelta += 360;
  const latitudeDelta = to[0] - from[0];
  const distance = Math.hypot(latitudeDelta, longitudeDelta);
  const arcStrength = Math.min(Math.max(distance * 0.22, 0.08), 24);
  const normalLatitude = distance ? -longitudeDelta / distance : -1;
  const normalLongitude = distance ? latitudeDelta / distance : 0;
  const control = [
    (from[0] + to[0]) / 2 + normalLatitude * arcStrength,
    from[1] + longitudeDelta / 2 + normalLongitude * arcStrength,
  ];

  return Array.from({ length: pointCount + 1 }, (_, index) => {
    const t = index / pointCount;
    const inverse = 1 - t;
    return [
      inverse * inverse * from[0] + 2 * inverse * t * control[0] + t * t * to[0],
      inverse * inverse * from[1] + 2 * inverse * t * control[1] + t * t * to[1],
    ];
  });
}

function animateHeartAlongRoute(marker, route) {
  const duration = 3800;
  let startedAt;

  function frame(timestamp) {
    if (!startedAt) startedAt = timestamp;
    const progress = ((timestamp - startedAt) % duration) / duration;
    const position = progress * (route.length - 1);
    const index = Math.floor(position);
    const nextIndex = Math.min(index + 1, route.length - 1);
    const fraction = position - index;
    marker.setLatLng([
      route[index][0] + (route[nextIndex][0] - route[index][0]) * fraction,
      route[index][1] + (route[nextIndex][1] - route[index][1]) * fraction,
    ]);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

function pickResultMessage(value) {
  const localizedPool = resultMessages.find(([max]) => value <= max)[1];
  return localizedPool[Math.floor(Math.random() * localizedPool.length)];

  /* English source archive kept here for easy copywriting reference. */
  const messagePools = [
    {
      max: 0,
      messages: [
        "A quiet answer can still begin an honest conversation.",
        "Even hearts have cloudy days. Tomorrow may feel softer.",
        "Zero is only where this little meter starts.",
        "Some feelings need time before they find their number.",
        "An honest answer is its own kind of tenderness.",
        "Today may be complicated, but your story is still being written.",
        "Not every heart speaks loudly every day.",
        "A small pause in love is not the end of the song.",
      ],
    },
    {
      max: 24,
      messages: [
        "A tiny spark is still a spark.",
        "Love sometimes whispers before it learns to sing.",
        "Small beginnings can grow the loveliest roots.",
        "There’s a little warmth here, waiting to be noticed.",
        "Every great love story starts with one brave percent.",
        "A pocket-sized feeling, but a real one.",
        "Just enough glow to light the next step.",
        "The heart has cracked the door open.",
      ],
    },
    {
      max: 49,
      messages: [
        "Something sweet is definitely blooming here.",
        "That’s a lovely little constellation of feelings.",
        "The heart is warming up beautifully.",
        "More than a spark, less than a wildfire—for now.",
        "There’s real tenderness tucked inside that number.",
        "A gentle kind of love has entered the room.",
        "That feeling has found its rhythm.",
        "The butterflies are starting to organize.",
      ],
    },
    {
      max: 74,
      messages: [
        "That’s the kind of number that comes with butterflies.",
        "A very serious amount of softness is happening.",
        "The heart is officially doing happy little somersaults.",
        "That’s plenty of love to make an ordinary day glow.",
        "Someone is smiling at their screen right now.",
        "This feeling has warmth, sparkle, and excellent potential.",
        "Love is settling in and making itself comfortable.",
        "That number deserves a long hug.",
      ],
    },
    {
      max: 99,
      messages: [
        "So close to overflowing, the heart can barely contain it.",
        "That’s an almost-perfect storm of affection.",
        "The love meter is blushing.",
        "One more heartbeat and this may spill over.",
        "That number feels like being pulled into a warm embrace.",
        "There’s barely any room left in the heart.",
        "Love has filled nearly every corner.",
        "This is dangerously close to a romantic masterpiece.",
      ],
    },
    {
      max: 100,
      messages: [
        "A whole heart, beautifully and completely given.",
        "One hundred percent: no fine print, no missing pieces.",
        "The classic perfect score, sealed with a kiss.",
        "Every last percent belongs to you.",
        "The love meter is full and the heart is happy.",
        "Exactly one complete heart’s worth of love.",
        "Perfectly, wonderfully, entirely loved.",
        "A full cup, a full heart, a perfect hundred.",
      ],
    },
    {
      max: 199,
      messages: [
        "The meter ended at 100, but the heart clearly didn’t.",
        "Some feelings refuse to respect sensible limits.",
        "That’s one full heart plus a generous refill.",
        "Officially more love than this bar was built to hold.",
        "Love has escaped the chart and is making its own rules.",
        "A hundred percent was only the beginning.",
        "The heart brought extra love, just in case.",
        "This answer comes with bonus butterflies.",
      ],
    },
    {
      max: 399,
      messages: [
        "That’s enough love for several parallel universes.",
        "The heart has gone gloriously off the scale.",
        "Warning: excessive affection detected.",
        "This much love may require a larger universe.",
        "The calculator blushed and gave up.",
        "That number contains at least three happily-ever-afters.",
        "Love is now operating far beyond factory settings.",
        "The meter is full; the feelings are still arriving.",
      ],
    },
    {
      max: 699,
      messages: [
        "That’s not a percentage. That’s a whole galaxy.",
        "Scientists have been informed. This is extraordinary.",
        "The heart has achieved escape velocity.",
        "That amount of love could power a small moon.",
        "This feeling has its own gravitational pull.",
        "The scale is speechless, but the heart understands.",
        "Love has left the atmosphere and packed snacks.",
        "A truly unreasonable—and wonderful—amount of affection.",
      ],
    },
    {
      max: 999,
      messages: [
        "The universe called. It wants some of that love back.",
        "That number is basically a handwritten infinity.",
        "The heart has broken every known measurement record.",
        "This is what happens when love forgets how to count.",
        "Nearly one thousand percent of pure, magnificent devotion.",
        "The meter is now just watching in amazement.",
        "Love this big needs its own postal code.",
        "An absolutely celestial quantity of affection.",
      ],
    },
    {
      max: 1000,
      messages: [
        "One thousand percent. The heart has said everything.",
        "Maximum number, immeasurable feeling.",
        "A perfect 1000—the love meter can retire happy.",
        "You found the top of the scale and filled every bit of it.",
        "One thousand reasons to smile, all wrapped into one answer.",
        "The grand finale of percentages. Spectacular.",
        "This is love with every dial turned all the way up.",
        "The scale stops here. The love clearly doesn’t.",
      ],
    },
  ];

  const pool = messagePools.find((entry) => value <= entry.max).messages;
  return pool[Math.floor(Math.random() * pool.length)];
}

function escapeHtml(value) {
  const node = document.createElement("span");
  node.textContent = value;
  return node.innerHTML;
}

function openFreshRequest() {
  clearTimeout(pollTimer);
  stopWaitingPhrases();
  const freshUrl = new URL("/", location.origin);
  freshUrl.searchParams.set("new", `${Date.now()}-${crypto.randomUUID?.() || Math.random()}`);
  location.replace(freshUrl);
}

document.querySelector("#again-button").addEventListener("click", openFreshRequest);

if (requestPathMatch) restoreRequest(requestPathMatch[1]);
