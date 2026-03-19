// ─────────────────────────────────────────────
//  popup.js  –  ScamGuard popup
// ─────────────────────────────────────────────
//  Domain info is always shown. Clicking Report / Vouch opens
//  the ScamGuard website where auth + bot protection happen.
//  Vote results are sent back via chrome.runtime.onMessageExternal.
// ─────────────────────────────────────────────

// ── Config (from config.js, loaded via popup.html) ──────────────────
const SITE_URL = UM_CONFIG.SITE_URL;

// ── DOM refs ────────────────────────────────────────────────────────
const reportMsgEl     = document.getElementById("report-msg");
const btnSync         = document.getElementById("btn-sync");
const btnGithub       = document.getElementById("btn-github");
const btnSettings     = document.getElementById("btn-settings");
const btnReport       = document.getElementById("btn-report");
const btnVouch        = document.getElementById("btn-vouch");
const btnReeval       = document.getElementById("btn-reeval");
const currentDomainEl = document.getElementById("current-domain");
const domainStatusEl  = document.getElementById("domain-status");
const statsRowEl      = document.getElementById("stats-row");
const statReportsEl   = document.getElementById("stat-reports");
const statVouchesEl   = document.getElementById("stat-vouches");
const statRiskEl      = document.getElementById("stat-risk");
const lookalikeWarnEl = document.getElementById("lookalike-warn");
const trustAgeEl      = document.getElementById("trust-age");
const statusBar       = document.getElementById("status-bar");
const userAreaEl      = document.getElementById("user-area");
const voteStatusEl    = document.getElementById("vote-status");

let currentTabHostname = "";

// ── Initialise ──────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", async () => {
  // Get the active tab's hostname
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.url) {
    try {
      currentTabHostname = new URL(tab.url).hostname.toLowerCase().replace(/^www\./, "");
      currentDomainEl.textContent = currentTabHostname;
      currentDomainEl.classList.remove("empty");
    } catch {
      currentDomainEl.textContent = "—";
    }
  }

  // Update footer status bar with cached counts
  refreshStatusBar();

  // Always look up the domain
  lookupCurrentDomain();
  loadUserVoteStatus();
});

// ── Open website for voting ─────────────────────────────────────────
let voteWindowPending = false;
function openVotePage(action) {
  if (voteWindowPending || !currentTabHostname) {
    if (!currentTabHostname) showReportMsg("Cannot determine current site.", "text-red");
    return;
  }
  voteWindowPending = true;
  const extId = chrome.runtime.id;
  const url = `${SITE_URL}/vote?domain=${encodeURIComponent(currentTabHostname)}&action=${encodeURIComponent(action)}&ext=${encodeURIComponent(extId)}&popup=1`;
  chrome.windows.create({ url, type: "popup", width: 460, height: 520 })
    .finally(() => { voteWindowPending = false; });
}

// ── Listen for vote results from the website (via background.js) ────
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "vote-result" && msg.ok && msg.domain === currentTabHostname) {
    updateVoteStatus(msg.action);
    showReportMsg(`✓ ${msg.action === 'report' ? 'Report' : 'Vouch'} submitted`, "text-green");
    setTimeout(() => showReportMsg("", ""), 3000);
    lookupCurrentDomain();
  }
});

btnReport.addEventListener("click", () => openVotePage("report"));
btnVouch.addEventListener("click", () => openVotePage("vouch"));
btnReeval.addEventListener("click", () => openVotePage("report"));

// ── Force sync ──────────────────────────────────────────────────────
btnSync.addEventListener("click", async () => {
  btnSync.classList.add("spinning");
  btnSync.disabled = true;
  try {
    const result = await chrome.runtime.sendMessage({ type: "force-sync" });
    if (result?.ok) {
      await Promise.all([refreshStatusBar(), lookupCurrentDomain()]);
      const prev = statusBar.textContent;
      statusBar.textContent = "✓ Synced";
      setTimeout(() => { statusBar.textContent = prev; }, 1500);
    } else {
      statusBar.textContent = "Sync failed";
    }
  } catch (err) {
    console.error("[ScamGuard] Sync failed:", err);
    statusBar.textContent = "Sync failed";
  } finally {
    btnSync.classList.remove("spinning");
    btnSync.disabled = false;
  }
});

btnGithub.addEventListener("click", () => {
  chrome.tabs.create({ url: "https://github.com/DevJCrystal/scam-guard" });
});

btnSettings.addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("settings.html") });
});
function showVoteButtons(mode) {
  const standardEl = document.getElementById("vote-buttons-standard");
  const verifiedEl = document.getElementById("vote-buttons-verified");
  if (mode === 'verified') {
    standardEl.classList.add("hidden");
    verifiedEl.classList.remove("hidden");
  } else {
    standardEl.classList.remove("hidden");
    verifiedEl.classList.add("hidden");
  }
}

// ── Helpers ─────────────────────────────────────────────────────────
function showReportMsg(text, cls) { reportMsgEl.textContent = text; reportMsgEl.className = cls || ""; }

async function refreshStatusBar() {
  try {
    const [blockCount, trustCount] = await Promise.all([umCountBlocklist(), umCountTrusted()]);
    statusBar.textContent = `${blockCount} reported · ${trustCount} trusted`;
  } catch {
    statusBar.textContent = "—";
  }
}

// ── Domain lookup (local IndexedDB → server fallback) ───────────────
async function lookupCurrentDomain() {
  if (!currentTabHostname) {
    domainStatusEl.innerHTML = '<span class="status-pill pill-unknown">No domain</span>';
    statsRowEl.classList.add("hidden");
    return;
  }

  domainStatusEl.innerHTML = '<span class="status-pill pill-loading loading-pulse">Checking…</span>';
  statsRowEl.classList.add("hidden");
  lookalikeWarnEl.classList.add("hidden");

  try {
    // Check blocklist (reported/blocked)
    const entry = await umLookupDomain(currentTabHostname);
    if (entry) {
      renderDomainInfo({
        found: true,
        domain: entry.domain,
        status: entry.status,
        riskScore: entry.riskScore,
        reportCount: entry.reportCount,
        vouchCount: entry.vouchCount,
        lookalikeDomain: entry.lookalikeDomain,
        lookalikeScore: entry.lookalikeScore,
        trustedSince: entry.trustedSince,
        verifiedAt: entry.verifiedAt,
        firstReportedAt: entry.firstReportedAt,
      });
      return;
    }

    // Check trusted store
    const trustedEntry = await umLookupTrustedDomain(currentTabHostname);
    if (trustedEntry) {
      renderDomainInfo({
        found: true,
        domain: trustedEntry.domain,
        status: trustedEntry.status || 'trusted',
        source: trustedEntry.source || 'curated',
        vouchCount: trustedEntry.vouchCount || 0,
        qualifiedVouchCount: trustedEntry.qualifiedVouchCount || 0,
        trustedSince: trustedEntry.trustedSince,
        verifiedAt: trustedEntry.verifiedAt,
        firstSeen: trustedEntry.firstSeen,
      });
      return;
    }

    // Not cached locally — ask the server
    domainStatusEl.innerHTML = '<span class="status-pill pill-loading loading-pulse">Looking up…</span>';
    const serverData = await lookupDomainOnServer(currentTabHostname);
    if (serverData?.found) {
      renderDomainInfo(serverData);
      return;
    }

    renderDomainInfo({ found: false });
  } catch {
    renderDomainInfo({ found: false });
  }
}

async function lookupDomainOnServer(domain) {
  try {
    const result = await appwriteFetch(
      `/functions/${UM_CONFIG.FETCH_BLOCKLIST_FUNCTION_ID}/executions`,
      "POST",
      { body: JSON.stringify({ domain }), async: false, method: "POST" }
    );
    let data;
    try {
      data = JSON.parse(result.responseBody || "{}");
    } catch {
      console.warn("[ScamGuard] Invalid JSON from server lookup");
      return null;
    }
    if (data.ok && data.found) {
      return {
        found: true,
        domain: data.domain,
        status: data.status,
        riskScore: data.riskScore,
        reportCount: data.reportCount,
        vouchCount: data.vouchCount,
        qualifiedVouchCount: data.qualifiedVouchCount,
        lookalikeDomain: data.lookalikeDomain,
        lookalikeScore: data.lookalikeScore,
        trustedSince: data.trustedSince,
        verifiedAt: data.verifiedAt,
      };
    }
  } catch {
    // Server lookup failed — treat as unknown
  }
  return null;
}

async function renderDomainInfo(data) {
  if (!data.found) {
    domainStatusEl.innerHTML = '<span class="status-pill pill-unknown">Unknown</span>';
    statsRowEl.classList.add("hidden");
    lookalikeWarnEl.classList.add("hidden");
    trustAgeEl.classList.add("hidden");
    showVoteButtons('standard');
    return;
  }

  const pills = {
    blocked:  { cls: "pill-blocked",  label: "Blocked" },
    reported: { cls: "pill-reported", label: "Under Review" },
    pending:  { cls: "pill-pending",  label: "Pending Review" },
    trusted:  { cls: "pill-trusted",  label: "Community Trusted" },
    verified: { cls: "pill-verified", label: "Verified ✓" },
  };

  // Curated imports (Tranco) show as neutral "Known Domain" — not a trust endorsement
  let pill;
  if (data.source === 'curated' && (data.status === 'trusted' || !data.status)) {
    pill = { cls: "pill-known", label: "Known Domain" };
  } else {
    pill = pills[data.status] || { cls: "pill-unknown", label: data.status };
  }

  // Apply custom colors if set
  const stored = await chrome.storage.local.get("displayPrefs");
  const customColors = stored.displayPrefs?.colors;
  let pillStyle = "";
  if (customColors && pill.cls !== "pill-known" && pill.cls !== "pill-unknown" && pill.cls !== "pill-loading") {
    const colorMap = {
      "pill-blocked": customColors.blocked,
      "pill-reported": customColors.reported,
      "pill-pending": customColors.reported,
      "pill-trusted": customColors.trusted,
      "pill-verified": customColors.verified,
    };
    if (colorMap[pill.cls]) {
      pillStyle = ` style="background:${colorMap[pill.cls]};color:#fff"`;
    }
  }
  domainStatusEl.innerHTML = `<span class="status-pill ${pill.cls}"${pillStyle}>${pill.label}</span>`;

  // Trust age subtitle
  if (data.source === 'curated' && data.firstSeen) {
    const daysSinceAdded = (Date.now() - new Date(data.firstSeen).getTime()) / 86400000;
    if (daysSinceAdded < 30) {
      trustAgeEl.textContent = `⚠ New to list (added ${formatTimeAgo(data.firstSeen)})`;
      trustAgeEl.style.color = 'var(--lookalike-text)';
      trustAgeEl.classList.remove("hidden");
    } else {
      trustAgeEl.textContent = `On list since ${formatTimeAgo(data.firstSeen)}`;
      trustAgeEl.style.color = '';
      trustAgeEl.classList.remove("hidden");
    }
  } else if (data.status === 'verified' && data.verifiedAt) {
    trustAgeEl.textContent = `Verified ${formatTimeAgo(data.verifiedAt)}`;
    trustAgeEl.classList.remove("hidden");
  } else if (data.status === 'trusted' && data.trustedSince) {
    trustAgeEl.textContent = `Trusted for ${formatDuration(data.trustedSince)}`;
    trustAgeEl.classList.remove("hidden");
  } else if (data.status === 'reported' && data.firstReportedAt) {
    trustAgeEl.textContent = `First reported ${formatTimeAgo(data.firstReportedAt)}`;
    trustAgeEl.classList.remove("hidden");
  } else {
    trustAgeEl.classList.add("hidden");
  }

  // Stats row
  statReportsEl.textContent = data.reportCount ?? "—";
  statVouchesEl.textContent = data.vouchCount ?? 0;
  statRiskEl.textContent = data.riskScore ? `${data.riskScore}` : "—";
  statsRowEl.classList.remove("hidden");

  // Lookalike warning
  if (data.lookalikeDomain) {
    lookalikeWarnEl.innerHTML = '⚠ May be impersonating <strong>' +
      escapeHtml(data.lookalikeDomain) + '</strong>' +
      (data.lookalikeScore ? ' (' + Math.round(data.lookalikeScore * 100) + '% match)' : '');
    lookalikeWarnEl.classList.remove("hidden");
  } else {
    lookalikeWarnEl.classList.add("hidden");
  }

  showVoteButtons(data.status === 'verified' ? 'verified' : 'standard');
}

/** Format an ISO date as a relative duration, e.g. "3 days" or "2 months". */
function formatDuration(isoDate) {
  const ms = Date.now() - new Date(isoDate).getTime();
  const days = Math.floor(ms / 86400000);
  if (days < 1) return "less than a day";
  if (days === 1) return "1 day";
  if (days < 30) return `${days} days`;
  const months = Math.floor(days / 30);
  if (months === 1) return "1 month";
  if (months < 12) return `${months} months`;
  const years = Math.floor(months / 12);
  return years === 1 ? "1 year" : `${years} years`;
}

/** Format an ISO date as "X ago", e.g. "3 days ago". */
function formatTimeAgo(isoDate) {
  return formatDuration(isoDate) + " ago";
}

// ── Vote status helpers ─────────────────────────────────────────────
async function loadUserVoteStatus() {
  if (!currentTabHostname) return;
  const localVotes = await chrome.storage.local.get("userVotes");
  const votes = localVotes.userVotes || {};
  const existing = votes[currentTabHostname];
  if (existing) {
    updateVoteStatus(existing);
  } else {
    voteStatusEl.className = "vote-status";
    voteStatusEl.textContent = "";
    resetVoteButtons();
  }
}

function resetVoteButtons() {
  btnReport.disabled = false;
  btnReport.textContent = "⚠ Report";
  btnVouch.disabled = false;
  btnVouch.textContent = "✓ Vouch";
}

function updateVoteStatus(action) {
  if (action === 'report') {
    voteStatusEl.className = "vote-status active voted-report";
    voteStatusEl.textContent = "⚠ You reported this site";
    btnReport.disabled = true;
    btnReport.textContent = "⚠ Reported";
    btnVouch.disabled = false;
    btnVouch.textContent = "↻ Change to Vouch";
  } else if (action === 'vouch') {
    voteStatusEl.className = "vote-status active voted-vouch";
    voteStatusEl.textContent = "✓ You vouched for this site";
    btnVouch.disabled = true;
    btnVouch.textContent = "✓ Vouched";
    btnReport.disabled = false;
    btnReport.textContent = "↻ Change to Report";
  }
}

// ── Client-side lookalike detection ─────────────────────────────────
// Compares a reported domain's base name (e.g. "paypa1" from "paypa1.com")
// against all locally cached trusted domains. If the Levenshtein similarity
// exceeds the threshold, the report is flagged as a potential lookalike.
// This helps prioritise reviews — the server re-validates independently.
async function detectLookalike(reported) {
  let trustedDomains;
  try { trustedDomains = await umGetAllTrustedDomains(); } catch { return null; }
  if (!trustedDomains.length) return null;

  const reportedBase = extractBase(reported);
  let bestMatch = null;
  let bestScore = 0;

  for (const trusted of trustedDomains) {
    const trustedBase = extractBase(trusted);
    if (reportedBase === trustedBase && reported !== trusted) {
      return { domain: trusted, score: 1.0 };
    }
    const sim = similarity(reportedBase, trustedBase);
    if (sim > bestScore && sim >= UM_CONFIG.LOOKALIKE_SIMILARITY_MIN && reported !== trusted) {
      bestScore = sim;
      bestMatch = trusted;
    }
  }

  return bestMatch ? { domain: bestMatch, score: Math.round(bestScore * 100) / 100 } : null;
}

/**
 * Extract the "base" label from a domain for comparison.
 * For standard TLDs (com, org) this is the second-level label.
 * For compound TLDs (co.uk, com.au) this is the third-level label.
 */
function extractBase(domain) {
  const parts = domain.split('.');
  if (parts.length >= 3 && parts[parts.length - 1].length <= 3 && parts[parts.length - 2].length <= 3) {
    return parts[parts.length - 3];
  }
  return parts.length >= 2 ? parts[parts.length - 2] : parts[0];
}

/** Normalised Levenshtein similarity: 1.0 = identical, 0.0 = completely different. */
function similarity(a, b) {
  const dist = levenshtein(a, b);
  const maxLen = Math.max(a.length, b.length);
  return maxLen === 0 ? 1 : 1 - dist / maxLen;
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}
