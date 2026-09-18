function jobKey(tabId) {
  return `job_${tabId}`;
}

function badgeFound(tabId) {
  chrome.action.setBadgeText({ tabId, text: "\u{1F4CD}" });
  chrome.action.setBadgeBackgroundColor({ tabId, color: "#6366f1" });
  chrome.action.setTitle({
    tabId,
    title: "Job location detected — click to see your commute",
  });
}

chrome.runtime.onMessage.addListener((message, sender) => {
  if (!sender.tab) return;
  const tabId = sender.tab.id;

  if (message.type === "JOB_DETECTED") {
    chrome.storage.session.set({
      [jobKey(tabId)]: {
        status: "resolved",
        addresses: message.addresses,
        title: message.title,
        company: message.company,
      },
    });
    badgeFound(tabId);
  } else if (message.type === "JOB_TEXT_ONLY") {
    chrome.storage.session.set({
      [jobKey(tabId)]: {
        status: "unresolved",
        text: message.text,
        title: message.title,
      },
    });
    badgeFound(tabId);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.session.remove(jobKey(tabId));
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status !== "loading") return;
  chrome.storage.session.remove(jobKey(tabId));
  chrome.action.setBadgeText({ tabId, text: "" });
  chrome.action.setTitle({ tabId, title: "" });
});
