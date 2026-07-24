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
  document.querySelector("#result-message").textContent =
    value > 500 ? "That’s not a percentage. That’s a whole universe." :
    value > 100 ? "Some feelings were never meant to fit inside 100%." :
    value > 0 ? "A beautiful answer, sealed just for you." :
    "Even honest hearts can have complicated days.";

  const duration = 2200;
  const started = performance.now();
  const number = document.querySelector("#result-number");
  const fill = document.querySelector("#progress-fill");
  document.body.classList.add("celebrate");

  function animate(now) {
    const progress = Math.min((now - started) / duration, 1);
    const eased = 1 - Math.pow(1 - progress, 4);
    number.textContent = Math.round(value * eased);
    fill.style.width = `${Math.min(value / 10, 100) * eased}%`;
    if (progress < 1) requestAnimationFrame(animate);
  }
  requestAnimationFrame(animate);
}

document.querySelector("#again-button").addEventListener("click", () => location.reload());
