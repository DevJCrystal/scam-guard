// ─────────────────────────────────────────────
//  background.js  –  Service Worker (Manifest V3)
// ─────────────────────────────────────────────
//  Responsibilities:
//    1. Download compiled JSON lists from Appwrite Storage.
//    2. Store in IndexedDB for fast keyed lookups (popup.js).
//    3. Mirror blocked/reported arrays to chrome.storage.local
//       so content scripts can check domains without messaging.
//    4. Handle domain-lookup messages from content.js / popup.js.
// ─────────────────────────────────────────────

self.importScripts('config.js', 'db.js');

const LISTS_ALARM = "sync-lists";
const SYNC_INTERVAL_MINUTES = UM_CONFIG.SYNC_INTERVAL_MINUTES;
const STORAGE_KEY = "maliciousDomains";

// ── Config (from config.js, loaded via importScripts) ───────────────
const APPWRITE_ENDPOINT = UM_CONFIG.APPWRITE_ENDPOINT;
const APPWRITE_PROJECT_ID = UM_CONFIG.APPWRITE_PROJECT_ID;
const LISTS_BUCKET_ID = UM_CONFIG.LISTS_BUCKET_ID;
const BLOCKLIST_FILE_ID = UM_CONFIG.BLOCKLIST_FILE_ID;
const TRUSTED_FILE_ID = UM_CONFIG.TRUSTED_FILE_ID;
const FETCH_BLOCKLIST_FUNCTION_ID = UM_CONFIG.FETCH_BLOCKLIST_FUNCTION_ID;

// ── Bootstrap on install / browser start ────────────────────────────
chrome.runtime.onInstalled.addListener(async () => {
  await chrome.alarms.create(LISTS_ALARM, {
    periodInMinutes: SYNC_INTERVAL_MINUTES,
  });
  await syncLists();
});

chrome.runtime.onStartup.addListener(async () => {
  await syncLists();
});

// ── Alarm handler ───────────────────────────────────────────────────
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === LISTS_ALARM) {
    await syncLists();
  }
});

// ── Message handler (domain lookups from popup / content) ───────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "lookup-domain" && msg.domain) {
    umLookupDomain(msg.domain)
      .then((entry) => sendResponse({ found: !!entry, ...(entry || {}) }))
      .catch(() => sendResponse({ found: false }));
    return true; // async response
  }
  if (msg.type === "force-sync") {
    syncLists()
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }
});

// ── External message handler (vote results from sg.crystaljake.com) ──
chrome.runtime.onMessageExternal.addListener(async (msg, sender) => {
  // Only accept messages from the ScamGuard website
  if (!sender.url || !sender.url.startsWith(UM_CONFIG.SITE_URL)) return;

  if (msg.type === "vote-result" && msg.ok && msg.domain && msg.action) {
    // Update local vote cache
    const localVotes = await chrome.storage.local.get("userVotes");
    const votes = localVotes.userVotes || {};
    votes[msg.domain] = msg.action === 'report' ? 'report' : 'vouch';
    await chrome.storage.local.set({ userVotes: votes });

    // Update suspicious domains list
    if (msg.action === 'report') {
      const cached = await chrome.storage.local.get("suspiciousDomains");
      const list = cached.suspiciousDomains || [];
      if (!list.includes(msg.domain)) {
        list.push(msg.domain);
        await chrome.storage.local.set({ suspiciousDomains: list });
      }
    } else {
      const cached = await chrome.storage.local.get("suspiciousDomains");
      const list = (cached.suspiciousDomains || []).filter(d => d !== msg.domain);
      await chrome.storage.local.set({ suspiciousDomains: list });
    }

    // Forward to popup if it's open
    chrome.runtime.sendMessage(msg).catch(() => {});
  }
});

// ── Badge: color the extension icon per-tab ─────────────────────────
// Green = trusted, White = unknown, Orange = suspicious, Red = blocked

const DEFAULT_BADGE_COLORS = {
  verified:   "#2e7d32",
  trusted:    "#4caf50",
  unknown:    "#9e9e9e",
  suspicious: "#ff9800",
  blocked:    "#d32f2f",
};

async function getBadgeColors() {
  const stored = await chrome.storage.local.get("displayPrefs");
  const prefs = stored.displayPrefs || {};
  const custom = prefs.colors || {};
  return {
    verified:   custom.verified || DEFAULT_BADGE_COLORS.verified,
    trusted:    custom.trusted || DEFAULT_BADGE_COLORS.trusted,
    unknown:    DEFAULT_BADGE_COLORS.unknown,
    suspicious: custom.reported || DEFAULT_BADGE_COLORS.suspicious,
    blocked:    custom.blocked || DEFAULT_BADGE_COLORS.blocked,
  };
}

async function updateBadge(tabId, url) {
  if (!url) {
    chrome.action.setBadgeText({ text: "", tabId });
    return;
  }

  // Check if badge is disabled
  const stored = await chrome.storage.local.get("displayPrefs");
  const prefs = stored.displayPrefs || {};
  if (prefs.showBadge === false) {
    chrome.action.setBadgeText({ text: "", tabId });
    return;
  }

  let hostname;
  try {
    hostname = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    chrome.action.setBadgeText({ text: "", tabId });
    return;
  }

  // Skip chrome://, about:, localhost, internal IPs
  if (!hostname || url.startsWith("chrome") || url.startsWith("about") ||
      hostname === 'localhost' ||
      /^(127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|0\.|\[::1\]|\[fd|\[fe80)/.test(hostname)) {
    chrome.action.setBadgeText({ text: "", tabId });
    return;
  }

  let level = "unknown";
  try {
    const entry = await umLookupDomain(hostname);
    if (entry) {
      level = entry.status === "blocked" ? "blocked" : "suspicious";
    } else {
      const trustedEntry = await umLookupTrustedDomain(hostname);
      if (trustedEntry) {
        if (trustedEntry.source === 'curated') level = 'unknown'; // Tranco import — neutral badge
        else level = trustedEntry.status === "verified" ? "verified" : "trusted";
      }
    }
  } catch {
    // DB not ready yet — leave as unknown
  }

  chrome.action.setBadgeText({ text: level === "unknown" ? "" : " ", tabId });
  const badgeColors = await getBadgeColors();
  chrome.action.setBadgeBackgroundColor({ color: badgeColors[level], tabId });
}

// Update badge when switching tabs
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    await updateBadge(tabId, tab.url);
  } catch { /* tab may have closed */ }
});

// Update badge when a tab navigates
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.url || changeInfo.status === "complete") {
    try {
      await updateBadge(tabId, tab.url);
    } catch (err) {
      console.warn(`[URL Monitor] Badge update failed for tab ${tabId}:`, err);
    }
  }
});

// Re-apply badge when display prefs change
chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area === "local" && changes.displayPrefs) {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.id) await updateBadge(tab.id, tab.url);
    } catch { /* no active tab */ }
  }
});

// ── Primary sync: download JSON files from Storage ──────────────────
async function syncLists() {
  try {
    const [blocklistOk, trustedOk] = await Promise.allSettled([
      syncBlocklistFromStorage(),
      syncTrustedFromStorage(),
    ]);

    if (blocklistOk.status === "rejected") {
      console.warn("[URL Monitor] Storage blocklist unavailable, trying function fallback…");
      await syncBlocklistFallback();
    }

    if (trustedOk.status === "rejected") {
      console.warn("[URL Monitor] Trusted list download failed:", trustedOk.reason?.message);
    }
  } catch (err) {
    console.error("[URL Monitor] List sync failed:", err);
  }

  // Refresh badge on the active tab after sync
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) await updateBadge(tab.id, tab.url);
  } catch { /* no active tab */ }
}

async function syncBlocklistFromStorage() {
  const data = await downloadStorageFile(BLOCKLIST_FILE_ID);
  if (!data?.domains) throw new Error("Invalid blocklist JSON");

  // Store in IndexedDB (keyed by domain, enriched data)
  await umStoreBlocklist(data.domains);

  // Mirror to chrome.storage.local for content.js
  const blocked = [];
  const reported = [];
  for (const [domain, info] of Object.entries(data.domains)) {
    if (info.status === "blocked") blocked.push(domain);
    else if (info.status === "reported") reported.push(domain);
  }
  await chrome.storage.local.set({
    [STORAGE_KEY]: blocked,
    suspiciousDomains: reported,
  });
  await umSetMeta("blocklist_buildTime", data.buildTime);

  console.log(
    `[URL Monitor] Blocklist synced from Storage – ${blocked.length} blocked, ${reported.length} suspicious (${data.count} total).`
  );
}

async function syncTrustedFromStorage() {
  const data = await downloadStorageFile(TRUSTED_FILE_ID);
  if (!data?.domains) throw new Error("Invalid trusted JSON");

  // v2 format: domains is an object { "example.com": { source, status, ... } }
  // v1 format: domains was an array of strings
  if (Array.isArray(data.domains)) {
    await umStoreTrustedDomains(data.domains);
  } else {
    await umStoreTrustedDomainsV2(data.domains);
  }
  await umSetMeta("trusted_buildTime", data.buildTime);

  console.log(`[URL Monitor] Trusted list synced – ${data.count} domains.`);
}

// ── Download a file from Appwrite Storage ───────────────────────────
async function downloadStorageFile(fileId) {
  const url = `${APPWRITE_ENDPOINT}/storage/buckets/${LISTS_BUCKET_ID}/files/${fileId}/view`;
  const res = await fetch(url, {
    cache: "no-store",
    headers: {
      "X-Appwrite-Project": APPWRITE_PROJECT_ID,
    },
  });

  if (!res.ok) {
    throw new Error(`Storage download HTTP ${res.status} for ${fileId}`);
  }

  const raw = await res.text();
  const parsed = JSON.parse(raw);

  // If the file is a signed envelope, verify integrity
  if (parsed.payload && parsed.signature) {
    const valid = await verifySignature(JSON.stringify(parsed.payload), parsed.signature);
    if (!valid) {
      throw new Error(`Signature verification failed for ${fileId}`);
    }
    return parsed.payload;
  }

  return parsed;
}

// ── ECDSA P-256 signature verification ──────────────────────────────
const LIST_SIGNING_PUBLIC_KEY = UM_CONFIG.LIST_SIGNING_PUBLIC_KEY;

async function verifySignature(json, signatureB64) {
  if (!LIST_SIGNING_PUBLIC_KEY) {
    console.error('[URL Monitor] Signature verification key not configured — rejecting list.');
    return false;
  }

  try {
    const keyDer = Uint8Array.from(atob(LIST_SIGNING_PUBLIC_KEY), c => c.charCodeAt(0));
    const pubKey = await crypto.subtle.importKey(
      "spki", keyDer, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]
    );
    const derSig = Uint8Array.from(atob(signatureB64), c => c.charCodeAt(0));
    // Convert DER signature to raw IEEE P1363 format (r || s) for Web Crypto
    const rawSig = derToRaw(derSig);
    const dataBytes = new TextEncoder().encode(json);
    return crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" }, pubKey, rawSig, dataBytes
    );
  } catch (err) {
    console.error("[URL Monitor] Signature verification error:", err);
    return false;
  }
}

/** Convert an ECDSA DER signature to raw r||s (IEEE P1363) format. */
function derToRaw(der) {
  // DER: 0x30 <len> 0x02 <rLen> <r> 0x02 <sLen> <s>
  let offset = 2; // skip 0x30 + total length
  if (der[1] & 0x80) offset += (der[1] & 0x7f); // long-form length

  // Read r
  offset++; // skip 0x02
  let rLen = der[offset++];
  let r = der.subarray(offset, offset + rLen);
  offset += rLen;

  // Read s
  offset++; // skip 0x02
  let sLen = der[offset++];
  let s = der.subarray(offset, offset + sLen);

  // Strip leading zero padding (DER adds 0x00 for positive sign)
  if (r.length > 32 && r[0] === 0) r = r.subarray(1);
  if (s.length > 32 && s[0] === 0) s = s.subarray(1);

  // Pad to 32 bytes each
  const raw = new Uint8Array(64);
  raw.set(r, 32 - r.length);
  raw.set(s, 64 - s.length);
  return raw;
}

// ── Fallback: call FetchBlocklist function directly ─────────────────
async function syncBlocklistFallback() {
  // If a signing key is configured, refuse unsigned data for integrity
  if (LIST_SIGNING_PUBLIC_KEY) {
    console.warn("[URL Monitor] Fallback sync skipped — function responses cannot be signature-verified. Lists will update on next signed sync.");
    return;
  }
  try {
    const res = await fetch(
      `${APPWRITE_ENDPOINT}/functions/${FETCH_BLOCKLIST_FUNCTION_ID}/executions`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Appwrite-Project": APPWRITE_PROJECT_ID,
          "X-Fallback-Cookies": JSON.stringify({}),
        },
        body: JSON.stringify({ async: false }),
      }
    );

    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const execution = await res.json();
    const payload = JSON.parse(execution.responseBody || "{}");
    if (!payload.ok) throw new Error("FetchBlocklist returned ok=false");

    const blocked = payload.domains || [];
    const reported = payload.reportedDomains || [];

    // Build a domains object for IndexedDB so popup lookups work too
    const domainsObj = {};
    for (const d of blocked) domainsObj[d] = { domain: d, status: "blocked" };
    for (const d of reported) domainsObj[d] = { domain: d, status: "reported" };
    await umStoreBlocklist(domainsObj);

    // Mirror arrays to chrome.storage.local for content.js
    await chrome.storage.local.set({
      [STORAGE_KEY]: blocked,
      suspiciousDomains: reported,
    });
    console.log(
      `[URL Monitor] Blocklist synced via fallback – ${blocked.length} blocked, ${reported.length} suspicious.`
    );
  } catch (err) {
    console.error("[URL Monitor] Fallback sync also failed:", err);
  }
}
