const apiKeyEl = document.getElementById("apiKey");
const homeEl = document.getElementById("home");
const workEl = document.getElementById("work");
const aiApiKeyEl = document.getElementById("aiApiKey");
const statusEl = document.getElementById("status");

chrome.storage.sync.get(["apiKey", "home", "work", "aiApiKey"], (data) => {
  apiKeyEl.value = data.apiKey || "";
  homeEl.value = data.home || "";
  workEl.value = data.work || "";
  aiApiKeyEl.value = data.aiApiKey || "";
});

document.getElementById("save").addEventListener("click", () => {
  chrome.storage.sync.set(
    {
      apiKey: apiKeyEl.value.trim(),
      home: homeEl.value.trim(),
      work: workEl.value.trim(),
      aiApiKey: aiApiKeyEl.value.trim(),
    },
    () => {
      statusEl.textContent = "✓ Saved";
      statusEl.classList.add("show");
      setTimeout(() => statusEl.classList.remove("show"), 1600);
    }
  );
});
