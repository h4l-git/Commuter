const contentEl = document.getElementById("content");
const routeLabelEl = document.getElementById("routeLabel");
const jobPillEl = document.getElementById("jobPill");
const jobPillTextEl = document.getElementById("jobPillText");

const VEHICLE_ICONS = {
  BUS: "🚌",
  SUBWAY: "🚇",
  METRO_RAIL: "🚇",
  HEAVY_RAIL: "🚆",
  COMMUTER_TRAIN: "🚆",
  HIGH_SPEED_TRAIN: "🚄",
  RAIL: "🚆",
  TRAM: "🚊",
  FERRY: "⛴",
  CABLE_CAR: "🚡",
  GONDOLA_LIFT: "🚡",
  FUNICULAR: "🚡",
  WALK: "🚶",
};

const VEHICLE_COLORS = {
  BUS: "#f59e0b",
  SUBWAY: "#2563eb",
  METRO_RAIL: "#2563eb",
  HEAVY_RAIL: "#7c3aed",
  COMMUTER_TRAIN: "#7c3aed",
  HIGH_SPEED_TRAIN: "#7c3aed",
  RAIL: "#7c3aed",
  TRAM: "#16a34a",
  FERRY: "#0891b2",
  CABLE_CAR: "#db2777",
  GONDOLA_LIFT: "#db2777",
  FUNICULAR: "#db2777",
  WALK: "#64748b",
};

let reversed = false;
let useSavedInstead = false;

function getActiveTabId() {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      resolve(tabs[0] && tabs[0].id);
    });
  });
}

function getJobForTab(tabId) {
  return new Promise((resolve) => {
    if (tabId === undefined) return resolve(null);
    const key = `job_${tabId}`;
    chrome.storage.session.get([key], (data) => resolve(data[key] || null));
  });
}

async function askAiForLocation(aiApiKey, jobText) {
  const prompt = `You are extracting workplace location(s) from a job advertisement. Read the job posting text below and identify the physical work location(s) mentioned — a full street address where given, otherwise the most specific city/area mentioned. Some postings list more than one possible location (e.g. "based in London, Manchester, or remote from our Bristol office") — list every distinct one mentioned. If no location is mentioned anywhere, say so.

Respond with ONLY a JSON object and nothing else, in this exact shape:
{"addresses": ["<location string>", ...] or [], "confidence": "high" | "medium" | "low"}

Job posting text:
"""
${jobText}
"""`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": aiApiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 300,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!res.ok) {
    let detail = "";
    try {
      const errJson = await res.json();
      detail = errJson.error && errJson.error.message;
    } catch (e) {
      // ignore
    }
    throw new Error(detail || `AI request failed (HTTP ${res.status})`);
  }

  const data = await res.json();
  const raw = data.content && data.content[0] && data.content[0].text;
  if (!raw) throw new Error("AI returned no content");

  const cleaned = raw
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/, "")
    .replace(/```$/, "")
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch (e) {
    throw new Error("Couldn't parse the AI's response");
  }
}

function setState({ spinner, icon, title, description, action }, variant) {
  contentEl.innerHTML = "";
  const state = document.createElement("div");
  state.className = "state" + (variant ? ` ${variant}` : "");

  if (spinner) {
    const spinnerEl = document.createElement("div");
    spinnerEl.className = "spinner";
    state.appendChild(spinnerEl);
  } else if (icon) {
    const iconEl = document.createElement("div");
    iconEl.className = "state-icon";
    iconEl.textContent = icon;
    state.appendChild(iconEl);
  }
  if (title) {
    const strong = document.createElement("strong");
    strong.textContent = title;
    state.appendChild(strong);
  }
  if (description) {
    const p = document.createElement("p");
    p.textContent = description;
    state.appendChild(p);
  }
  if (action) {
    const btn = document.createElement("button");
    btn.className = action.className || "btn";
    btn.textContent = action.label;
    btn.addEventListener("click", action.onClick);
    state.appendChild(btn);
  }

  contentEl.appendChild(state);
}

function setLoading(message) {
  setState({ spinner: true, description: message || "Finding your route…" });
}

function openOptions() {
  window.location.href = "options.html";
}

document.getElementById("settings").addEventListener("click", openOptions);
document.getElementById("refresh").addEventListener("click", () => load());
document.getElementById("swap").addEventListener("click", () => {
  reversed = !reversed;
  load();
});

function directionsUrl(origin, destination) {
  const params = new URLSearchParams({
    api: "1",
    origin,
    destination,
    travelmode: "transit",
  });
  return `https://www.google.com/maps/dir/?${params.toString()}`;
}

async function fetchRoute(apiKey, origin, destination) {
  const params = new URLSearchParams({
    origin,
    destination,
    mode: "transit",
    departure_time: "now",
    key: apiKey,
  });
  const res = await fetch(
    `https://maps.googleapis.com/maps/api/directions/json?${params.toString()}`
  );
  if (!res.ok) {
    throw new Error(`Directions request failed (HTTP ${res.status})`);
  }
  const data = await res.json();
  if (data.status !== "OK") {
    throw new Error(data.error_message || `Directions API status: ${data.status}`);
  }
  return data;
}

function swapForDirection(reversed, home, other) {
  return reversed ? [other, home] : [home, other];
}

// A job can list several candidate work locations. Route to each from home
// and keep whichever comes back with the shortest travel distance, so we
// only ever end up rendering one final route.
async function resolveClosestRoute(apiKey, home, addresses, reversed) {
  const attempts = await Promise.all(
    addresses.map(async (addr) => {
      const [origin, destination] = swapForDirection(reversed, home, addr);
      try {
        const result = await fetchRoute(apiKey, origin, destination);
        return { result, origin, destination, distance: result.routes[0].legs[0].distance.value };
      } catch (e) {
        return { error: e };
      }
    })
  );

  const valid = attempts.filter((a) => !a.error);
  if (!valid.length) {
    // With just one candidate, surface its actual error instead of the
    // generic multi-location message.
    throw addresses.length === 1
      ? attempts[0].error
      : new Error("Couldn't find a route to any of the listed locations.");
  }
  valid.sort((a, b) => a.distance - b.distance);
  return valid[0];
}

function renderStep(step) {
  const isTransit = step.travel_mode === "TRANSIT";
  const wrap = document.createElement("div");
  wrap.className = "step";

  const icon = document.createElement("div");
  icon.className = "step-icon";
  const body = document.createElement("div");
  body.className = "step-body";

  const vehicleType = isTransit
    ? step.transit_details.line.vehicle
      ? step.transit_details.line.vehicle.type
      : "BUS"
    : "WALK";
  icon.textContent = VEHICLE_ICONS[vehicleType] || "🚌";
  icon.style.background = VEHICLE_COLORS[vehicleType] || "#64748b";

  if (isTransit) {
    const td = step.transit_details;
    const lineName = td.line.short_name || td.line.name;
    const strong = document.createElement("strong");
    strong.textContent = `${lineName}${td.headsign ? " → " + td.headsign : ""}`;
    const meta = document.createElement("div");
    meta.className = "step-meta";
    meta.textContent = `${td.departure_stop.name} → ${td.arrival_stop.name} · ${step.duration.text} (${td.num_stops} stop${td.num_stops === 1 ? "" : "s"})`;
    body.appendChild(strong);
    body.appendChild(meta);
  } else {
    const strong = document.createElement("strong");
    strong.textContent = "Walk";
    const meta = document.createElement("div");
    meta.className = "step-meta";
    meta.textContent = `${step.html_instructions.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()} · ${step.duration.text}`;
    body.appendChild(strong);
    body.appendChild(meta);
  }

  wrap.appendChild(icon);
  wrap.appendChild(body);
  return wrap;
}

function embedMapUrl(apiKey, origin, destination) {
  const params = new URLSearchParams({
    key: apiKey,
    origin,
    destination,
    mode: "transit",
  });
  return `https://www.google.com/maps/embed/v1/directions?${params.toString()}`;
}

function render(data, origin, destination, jobActive, apiKey) {
  contentEl.innerHTML = "";
  const leg = data.routes[0].legs[0];

  const summaryCard = document.createElement("div");
  summaryCard.className = "summary-card";

  const time = document.createElement("div");
  time.className = "summary-time";
  time.textContent = `${leg.duration.text}`;

  const meta = document.createElement("div");
  meta.className = "summary-meta";
  const arrival = leg.arrival_time ? leg.arrival_time.text : null;
  const departure = leg.departure_time ? leg.departure_time.text : null;
  meta.textContent =
    departure && arrival
      ? `Depart ${departure} · Arrive ${arrival}`
      : leg.distance.text;

  summaryCard.appendChild(time);
  summaryCard.appendChild(meta);
  contentEl.appendChild(summaryCard);

  if (jobActive) {
    const mapWrap = document.createElement("div");
    mapWrap.className = "map-frame";
    const iframe = document.createElement("iframe");
    iframe.src = embedMapUrl(apiKey, origin, destination);
    iframe.width = "100%";
    iframe.height = "170";
    iframe.style.border = "0";
    iframe.loading = "lazy";
    iframe.referrerPolicy = "no-referrer";
    mapWrap.appendChild(iframe);
    contentEl.appendChild(mapWrap);
  }

  const steps = document.createElement("div");
  steps.className = "steps";
  leg.steps.forEach((step) => steps.appendChild(renderStep(step)));
  contentEl.appendChild(steps);

  const link = document.createElement("a");
  link.className = "link-out";
  link.href = directionsUrl(origin, destination);
  link.target = "_blank";
  link.textContent = "Open full route in Google Maps →";
  contentEl.appendChild(link);

  if (jobActive) {
    const useSaved = document.createElement("button");
    useSaved.className = "use-saved-link";
    useSaved.textContent = "Use my saved work address instead";
    useSaved.addEventListener("click", () => {
      useSavedInstead = true;
      load();
    });
    contentEl.appendChild(useSaved);
  }
}

async function runAi(tabId, job, aiApiKey) {
  setLoading("Asking AI to read the job description…");
  try {
    const result = await askAiForLocation(aiApiKey, job.text);
    const addresses = (result && result.addresses) || [];
    if (!addresses.length) {
      setState({
        icon: "🤷",
        title: "AI couldn't find a location either",
        description: "This posting doesn't seem to mention a specific workplace location.",
      });
      return;
    }
    chrome.storage.session.set(
      {
        [`job_${tabId}`]: { status: "resolved", addresses, title: job.title, company: null },
      },
      () => load()
    );
  } catch (err) {
    setState({ icon: "⚠️", title: "AI lookup failed", description: err.message }, "error");
  }
}

function getSyncSettings() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(["apiKey", "home", "work", "aiApiKey"], resolve);
  });
}

async function load() {
  jobPillEl.hidden = true;

  const [data, tabId] = await Promise.all([getSyncSettings(), getActiveTabId()]);

  if (!data.apiKey || !data.home) {
    routeLabelEl.textContent = "Set up required";
    setState({
      icon: "🏠",
      title: "Set up your commute",
      description: "Add your API key, home, and work address to get started.",
      action: { label: "Open settings", onClick: openOptions },
    });
    return;
  }

  const job = useSavedInstead ? null : await getJobForTab(tabId);

  if (job && job.addresses && job.addresses.length) {
    routeLabelEl.textContent = reversed ? "Job → Home" : "Home → Job";
    jobPillEl.hidden = false;
    jobPillTextEl.textContent = job.company ? `${job.title} at ${job.company}` : job.title;

    setLoading();
    try {
      const { result, origin, destination } = await resolveClosestRoute(
        data.apiKey,
        data.home,
        job.addresses,
        reversed
      );
      render(result, origin, destination, true, data.apiKey);
    } catch (err) {
      setState({ icon: "⚠️", title: "Couldn't load route", description: err.message }, "error");
    }
    return;
  }

  if (job && job.status === "unresolved") {
    routeLabelEl.textContent = "Job detected";
    jobPillEl.hidden = false;
    jobPillTextEl.textContent = job.title || "Job posting";

    const description = data.aiApiKey
      ? "Want AI to read the job description and look for a location? This makes a small billed API call."
      : "Add an Anthropic API key in settings to let AI read the job description instead.";
    const action = data.aiApiKey
      ? { label: "Use AI", className: "btn btn-outline", onClick: () => runAi(tabId, job, data.aiApiKey) }
      : { label: "Open settings", onClick: openOptions };

    setState({ icon: "🤖", title: "No address found automatically", description, action });
    return;
  }

  if (!data.work) {
    routeLabelEl.textContent = "Ready when you are";
    setState({
      icon: "💼",
      title: "Nothing to route to yet",
      description:
        "Visit a job listing to see its commute, or add a work address in settings to check your regular commute anytime.",
      action: { label: "Open settings", onClick: openOptions },
    });
    return;
  }

  const [origin, destination] = swapForDirection(reversed, data.home, data.work);
  routeLabelEl.textContent = reversed ? "Work → Home" : "Home → Work";

  setLoading();
  try {
    const result = await fetchRoute(data.apiKey, origin, destination);
    render(result, origin, destination, false, data.apiKey);
  } catch (err) {
    setState({ icon: "⚠️", title: "Couldn't load route", description: err.message }, "error");
  }
}

load();
