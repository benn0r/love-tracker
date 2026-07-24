const token = location.pathname.split("/").filter(Boolean).pop();
const formView = document.querySelector("#response-form-view");
const sentView = document.querySelector("#sent-view");
const form = document.querySelector("#response-form");
const valueInput = document.querySelector("#value");
const rangeInput = document.querySelector("#love-range");
const photoInput = document.querySelector("#love-photo-input");
const photoPreview = document.querySelector("#photo-preview");
const photoPreviewWrap = document.querySelector("#photo-preview-wrap");
const errorElement = document.querySelector("#response-error");
let personName = "";
let selectedPhoto = null;

valueInput.addEventListener("input", () => {
  rangeInput.value = Math.max(0, Math.min(1000, Number(valueInput.value) || 0));
});
rangeInput.addEventListener("input", () => {
  valueInput.value = rangeInput.value;
});
photoInput.addEventListener("change", () => {
  selectedPhoto = photoInput.files?.[0] || null;
  if (!selectedPhoto) return clearPhoto();
  photoPreview.src = URL.createObjectURL(selectedPhoto);
  photoPreviewWrap.classList.remove("hidden");
});
document.querySelector("#remove-photo").addEventListener("click", clearPhoto);

async function loadRequest() {
  try {
    const response = await fetch(`/api/respond/${token}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);
    personName = data.name;
    document.querySelector("#person-name").textContent = data.name;
    document.querySelector("#sent-name").textContent = data.name;
    if (data.answered) {
      valueInput.value = data.value;
      showSent();
    }
  } catch (error) {
    formView.innerHTML = `<p class="eyebrow">This note has faded</p><h1><em>Link expired.</em></h1><p class="intro">${escapeHtml(error.message)}</p>`;
  }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  errorElement.textContent = "";
  const button = form.querySelector("button");
  button.disabled = true;
  try {
    button.firstChild.textContent = "Finding your place… ";
    const location = await getApproximateLocation();
    button.firstChild.textContent = selectedPhoto ? "Preparing your photo… " : "Sending my answer… ";
    const photo = selectedPhoto ? await compressPhoto(selectedPhoto) : null;
    button.firstChild.textContent = "Sending my answer… ";
    const response = await fetch(`/api/respond/${token}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: Number(valueInput.value), location, photo }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);
    showSent();
  } catch (error) {
    errorElement.textContent = error.message || "Couldn’t send your answer.";
    button.disabled = false;
    button.firstChild.textContent = "Send my answer ";
  }
});

function clearPhoto() {
  if (photoPreview.src.startsWith("blob:")) URL.revokeObjectURL(photoPreview.src);
  selectedPhoto = null;
  photoInput.value = "";
  photoPreview.removeAttribute("src");
  photoPreviewWrap.classList.add("hidden");
}

function compressPhoto(file) {
  return new Promise((resolve, reject) => {
    if (file.size > 12_000_000) return reject(new Error("Please choose a photo smaller than 12 MB."));
    const image = new Image();
    const objectUrl = URL.createObjectURL(file);
    image.onload = () => {
      const maxDimension = 1400;
      const scale = Math.min(maxDimension / image.width, maxDimension / image.height, 1);
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(image.width * scale));
      canvas.height = Math.max(1, Math.round(image.height * scale));
      canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(objectUrl);
      resolve(canvas.toDataURL("image/jpeg", 0.82));
    };
    image.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error("That photo could not be opened."));
    };
    image.src = objectUrl;
  });
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

function showSent() {
  formView.classList.add("hidden");
  sentView.classList.remove("hidden");
  document.body.classList.add("celebrate");
}

function escapeHtml(value) {
  const node = document.createElement("span");
  node.textContent = value;
  return node.innerHTML;
}

loadRequest();
