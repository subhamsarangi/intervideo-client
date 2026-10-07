// ---------- DOM ----------
const $ = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T;

const avatarsGrid = $<HTMLElement>("avatarsGrid");
const topicInput = $<HTMLInputElement>("topicInput");
const validateBtn = $<HTMLButtonElement>("validateBtn");
const validationMessage = $<HTMLElement>("validationMessage");
const suggestionsContainer = $<HTMLElement>("suggestionsContainer");
const suggestionsList = $<HTMLElement>("suggestionsList");
const startBtn = $<HTMLButtonElement>("startBtn");
const avatarError = $<HTMLElement>("avatarError");
const globalError = $<HTMLElement>("globalError");

// ---------- state ----------
let selectedAvatarId: string | null = null;
let avatarList: Array<{ id: string; name: string; path: string; preview: string; description: string; voice: string }> = [];
let isValidating = false;
let isTopicValid = false;

// ---------- avatar loading ----------
async function loadAvatars() {
  try {
    const res = await fetch("/api/avatars");
    if (!res.ok) throw new Error("Failed to load avatars");
    const data = await res.json();
    avatarList = data.avatars;
    renderAvatars();
  } catch (err) {
    avatarError.textContent = `Error loading avatars: ${err instanceof Error ? err.message : err}`;
    avatarError.style.display = "block";
  }
}

function renderAvatars() {
  avatarsGrid.innerHTML = "";
  for (const avatar of avatarList) {
    const card = document.createElement("div");
    card.className = "avatar-card";
    card.title = avatar.description; // Add tooltip with description
    if (avatar.id === selectedAvatarId) card.classList.add("selected");
    
    const img = document.createElement("img");
    img.className = "avatar-preview";
    img.src = avatar.preview;
    img.alt = avatar.name;
    
    const label = document.createElement("div");
    label.className = "avatar-label";
    label.textContent = avatar.name;
    
    card.appendChild(img);
    card.appendChild(label);
    card.addEventListener("click", () => selectAvatar(avatar.id));
    
    avatarsGrid.appendChild(card);
  }
}

function selectAvatar(avatarId: string) {
  selectedAvatarId = avatarId;
  renderAvatars();
  updateStartButton();
}

// ---------- topic validation ----------
async function validateTopic(topic: string) {
  if (!topic || topic.trim().length === 0) {
    setValidationMessage("Please enter a topic", "");
    hideSuggestions();
    return false;
  }

  setValidationMessage("Validating topic...", "loading");
  isValidating = true;
  isTopicValid = false;
  hideSuggestions();
  updateStartButton();

  try {
    const res = await fetch("/api/topics/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ topic: topic.trim() }),
    });

    const data = await res.json();

    if (!res.ok) {
      setValidationMessage(data.reason || data.error || "Topic validation failed", "error");
      if (data.suggestions && Array.isArray(data.suggestions) && data.suggestions.length > 0) {
        showSuggestions(data.suggestions);
      }
      topicInput.value = ""; // Clear invalid input
      isTopicValid = false;
      return false;
    }

    if (data.valid) {
      setValidationMessage("✓ Topic validated", "success");
      isTopicValid = true;
      return true;
    } else {
      setValidationMessage(data.reason || "Topic is not suitable", "error");
      if (data.suggestions && Array.isArray(data.suggestions) && data.suggestions.length > 0) {
        showSuggestions(data.suggestions);
      }
      topicInput.value = ""; // Clear invalid input
      isTopicValid = false;
      return false;
    }
  } catch (err) {
    setValidationMessage(`Validation error: ${err instanceof Error ? err.message : err}`, "error");
    isTopicValid = false;
    return false;
  } finally {
    isValidating = false;
    updateStartButton();
  }
}

function setValidationMessage(msg: string, type: "error" | "success" | "loading" | "") {
  validationMessage.textContent = msg;
  validationMessage.className = "validation-message";
  if (type) validationMessage.classList.add(type);
  if (msg) validationMessage.style.display = "block";
  else validationMessage.style.display = "none";
}

function showSuggestions(suggestions: string[]) {
  suggestionsList.innerHTML = "";
  for (const suggestion of suggestions) {
    const chip = document.createElement("div");
    chip.className = "suggestion-chip";
    chip.textContent = suggestion;
    chip.addEventListener("click", () => {
      topicInput.value = suggestion;
      hideSuggestions();
      setValidationMessage("", "");
      isTopicValid = false;
      updateStartButton();
    });
    suggestionsList.appendChild(chip);
  }
  suggestionsContainer.classList.add("visible");
}

function hideSuggestions() {
  suggestionsContainer.classList.remove("visible");
  suggestionsList.innerHTML = "";
}

// Input change resets validation state
topicInput.addEventListener("input", () => {
  isTopicValid = false;
  setValidationMessage("", "");
  hideSuggestions();
  updateStartButton();
});

// Enter key triggers validation
topicInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !isValidating) {
    validateBtn.click();
  }
});

// Validate button click
validateBtn.addEventListener("click", () => {
  const topic = topicInput.value.trim();
  if (topic) {
    void validateTopic(topic);
  }
});

// ---------- start button ----------
function updateStartButton() {
  const hasAvatar = selectedAvatarId !== null;
  startBtn.disabled = !isTopicValid || !hasAvatar || isValidating;
}

startBtn.addEventListener("click", startCall);

// ---------- start call ----------
async function startCall() {
  const topic = topicInput.value.trim();
  
  if (!selectedAvatarId || !topic) {
    globalError.textContent = "Please select an interviewer and enter a valid topic";
    globalError.style.display = "block";
    return;
  }

  startBtn.disabled = true;
  globalError.style.display = "none";

  try {
    // Get generated system prompt from validation
    const res = await fetch("/api/topics/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ topic }),
    });

    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(errData.reason || errData.error || "Failed to generate system prompt");
    }

    const data = await res.json();
    const systemPrompt = data.systemPrompt;

    // Find avatar path from avatarId
    const selectedAvatar = avatarList.find(a => a.id === selectedAvatarId);
    const avatarPath = selectedAvatar?.path || "/avatar.png";
    const avatarVoice = selectedAvatar?.voice || "en-US-GuyNeural";

    // Navigate to call page with avatar path, voice and prompt via URL params
    const params = new URLSearchParams({
      avatarPath: avatarPath,
      avatarId: selectedAvatarId,
      avatarVoice: avatarVoice,
      prompt: systemPrompt,
      topic: topic,
    });
    window.location.href = `/call.html?${params.toString()}`;
  } catch (err) {
    globalError.textContent = `Error starting call: ${err instanceof Error ? err.message : err}`;
    globalError.style.display = "block";
    startBtn.disabled = false;
  }
}

// ---------- init ----------
document.addEventListener("DOMContentLoaded", async () => {
  await loadAvatars();
  // Select first avatar by default
  if (avatarList.length > 0) {
    selectAvatar(avatarList[0].id);
  }
});
