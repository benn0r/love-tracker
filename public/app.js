const askView = document.querySelector("#ask-view");
const waitingView = document.querySelector("#waiting-view");
const resultView = document.querySelector("#result-view");
const askForm = document.querySelector("#ask-form");
const askError = document.querySelector("#ask-error");
let pollTimer;

askForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  askError.textContent = "";
  const button = askForm.querySelector("button");
  const name = new FormData(askForm).get("name").trim();
  button.disabled = true;
  button.firstChild.textContent = "Sending… ";

  try {
    const response = await fetch("/api/requests", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);
    showWaiting(data);
  } catch (error) {
    askError.textContent = error.message || "Something went wrong. Please try again.";
    button.disabled = false;
    button.firstChild.textContent = "Send my love note ";
  }
});

function showWaiting(request) {
  askView.classList.add("hidden");
  waitingView.classList.remove("hidden");
  document.querySelector("#waiting-name").textContent = request.name;
  poll(request.id, request.name);
}

async function poll(id, name) {
  try {
    const response = await fetch(`/api/requests/${id}`);
    const data = await response.json();
    if (data.status === "answered") return showResult(name, data.value);
    if (!response.ok) throw new Error(data.error);
  } catch (error) {
    console.error(error);
  }
  pollTimer = setTimeout(() => poll(id, name), 1800);
}

function showResult(name, value) {
  clearTimeout(pollTimer);
  waitingView.classList.add("hidden");
  resultView.classList.remove("hidden");
  document.querySelector("#result-name").textContent = name;
  document.querySelector("#result-message").textContent = pickResultMessage(value);

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

function pickResultMessage(value) {
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

document.querySelector("#again-button").addEventListener("click", () => location.reload());
