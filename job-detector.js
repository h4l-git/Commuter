function readJobPostings() {
  const blocks = document.querySelectorAll('script[type="application/ld+json"]');
  const postings = [];

  for (const block of blocks) {
    let data;
    try {
      data = JSON.parse(block.textContent);
    } catch (e) {
      continue;
    }

    const items = Array.isArray(data) ? data : data["@graph"] ? data["@graph"] : [data];
    for (const item of items) {
      if (!item || !item["@type"]) continue;
      const types = Array.isArray(item["@type"]) ? item["@type"] : [item["@type"]];
      if (types.includes("JobPosting")) postings.push(item);
    }
  }

  return postings;
}

function formatOneAddress(loc) {
  const addr = loc && loc.address;
  if (!addr) return null;
  if (typeof addr === "string") return addr;

  const parts = [
    addr.streetAddress,
    addr.addressLocality,
    addr.addressRegion,
    addr.postalCode,
    addr.addressCountry,
  ].filter(Boolean);

  return parts.length ? parts.join(", ") : null;
}

// A posting can list several possible work locations (jobLocation as an
// array) — return all of them so the popup can pick whichever is closest
// to the user's home instead of blindly taking the first.
function formatAddresses(jobLocation) {
  if (!jobLocation) return [];
  const locs = Array.isArray(jobLocation) ? jobLocation : [jobLocation];
  const addresses = locs.map(formatOneAddress).filter(Boolean);
  return [...new Set(addresses)];
}

function detectJobFromSchema() {
  const postings = readJobPostings();
  if (!postings.length) return null;

  for (const job of postings) {
    const addresses = formatAddresses(job.jobLocation);
    if (addresses.length) {
      return {
        addresses,
        title: job.title || document.title,
        company: job.hiringOrganization ? job.hiringOrganization.name : null,
      };
    }
  }
  return null;
}

// LinkedIn's logged-in view doesn't embed JobPosting schema, so these fall
// back to reading visible page text. Fragile by nature (relies on text
// shape, not structured data) — LinkedIn's own class names are build-hashed
// and useless as selectors — so treat this as best-effort, not guaranteed.
function isNoise(line) {
  return /applicant|ago|promoted|viewed|easy apply|employee|response|verif/i.test(line);
}

function stripWorkMode(text) {
  return text.replace(/\s*\([^)]*\)\s*$/, "").trim();
}

function climbAncestors(el, levels = 6) {
  let cur = el;
  for (let i = 0; i < levels && cur.parentElement; i++) cur = cur.parentElement;
  return cur;
}

// Search-results layout: URL carries ?currentJobId=, list + detail pane both
// exist client-side. Anchor on the link matching that id so we always read
// the currently-selected card, not just whichever one happens to be first.
function extractFromSearchList() {
  const idParam = new URLSearchParams(location.search).get("currentJobId");
  if (!idParam) return null;

  const link = document.querySelector(`a[href*="${idParam}"]`);
  if (!link) return null;

  const container = climbAncestors(link);

  const lines = (container.innerText || "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const deduped = lines.filter((l, i) => l !== lines[i - 1]);

  const title = deduped[0] || "LinkedIn job";
  const rest = deduped.slice(1);
  const company = rest.find((l) => !l.includes(",") && !isNoise(l)) || null;
  const locationLine = rest.find((l) => l.includes(",") && !isNoise(l) && l.length < 100);

  if (!locationLine) return null;
  return { addresses: [stripWorkMode(locationLine)], title, company };
}

// Direct job-view page (/jobs/view/<id>/): document.title reliably reflects
// the job, so anchor on the element whose exact text matches it.
function extractFromViewPage() {
  const titleGuess = document.title.split(" | ")[0].trim();
  if (!titleGuess || /^\(\d+\)/.test(document.title)) return null;

  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
  let titleEl = null;
  let n;
  while ((n = walker.nextNode())) {
    if (n.children.length === 0 && n.textContent.trim() === titleGuess) {
      titleEl = n;
      break;
    }
  }
  if (!titleEl) return null;

  const scope = climbAncestors(titleEl);

  // Candidates come out in document order, and the top-card location line
  // always precedes everything else in that scope, so the first one that
  // matches the shape we want is the right one — no need to score them all.
  let best = null;
  for (const el of scope.querySelectorAll("p, span, div, li")) {
    const text = (el.innerText || el.textContent || "").trim();
    if (!text || text.length > 150 || !text.includes("·")) continue;
    const first = text.split("·")[0].trim();
    if (!first || first.length > 60 || /\d/.test(first) || isNoise(first) || !first.includes(",")) continue;
    best = first;
    break;
  }
  if (!best) return null;

  const titleParts = document.title.split(" | ").map((s) => s.trim());
  return {
    addresses: [stripWorkMode(best)],
    title: titleGuess,
    company: titleParts.length >= 3 ? titleParts[1] : null,
  };
}

function jobIdentifier() {
  const idParam = new URLSearchParams(location.search).get("currentJobId");
  return idParam || location.href;
}

function looksLikeJobPage() {
  if (!/job/i.test(location.pathname)) return false;
  return (document.body.innerText || "").length > 500;
}

// Every DOM mutation (ads, hover states, chat widgets — anything) re-fires
// the debounced re-scan below, but only a changed job actually needs the
// expensive work (schema parsing, or extractFromViewPage's TreeWalker).
// Gate on the cheap identifier first so an already-handled job short-circuits
// instantly instead of re-running detection just to be deduped afterwards.
const handledJobIds = new Set();

function detectAndSend() {
  const id = jobIdentifier();
  if (handledJobIds.has(id)) return;

  const result =
    detectJobFromSchema() ||
    (location.hostname.includes("linkedin.com")
      ? extractFromSearchList() || extractFromViewPage()
      : null);

  if (result && result.addresses && result.addresses.length) {
    handledJobIds.add(id);
    chrome.runtime.sendMessage({ type: "JOB_DETECTED", ...result });
    return;
  }

  // No address found by the free methods. If this still looks like a job
  // posting, offer the page's text up for an opt-in AI lookup rather than
  // giving up.
  if (!looksLikeJobPage()) return;
  handledJobIds.add(id);

  chrome.runtime.sendMessage({
    type: "JOB_TEXT_ONLY",
    text: (document.body.innerText || "").slice(0, 6000),
    title: document.title,
  });
}

detectAndSend();

// Several boards (LinkedIn, Indeed, Glassdoor, ...) swap the job detail
// panel in-place via JS when you click a different search result, without a
// full page load — a plain one-shot scan would miss every job after the
// first. Re-scan whenever the page's content settles after a change.
let debounceTimer;
const observer = new MutationObserver(() => {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(detectAndSend, 800);
});
observer.observe(document.body, { childList: true, subtree: true });
