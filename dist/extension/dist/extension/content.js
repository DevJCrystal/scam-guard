// ─────────────────────────────────────────────
//  content.js  –  Content Script (runs on every page)
// ─────────────────────────────────────────────
//  Checks the current hostname against the cached blocklist and
//  injects a warning banner when there is a match.
// ─────────────────────────────────────────────

const STORAGE_KEY = "maliciousDomains";
const SUSPICIOUS_KEY = "suspiciousDomains";

(async function checkCurrentSite() {
  const hostname = window.location.hostname.toLowerCase().replace(/^www\./, "");

  // Skip localhost, internal IPs, and non-routable addresses
  if (!hostname || hostname === 'localhost' ||
      /^(127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|0\.|\[::1\]|\[fd|\[fe80)/.test(hostname)) {
    return;
  }

  // Load display preferences
  const stored = await chrome.storage.local.get("displayPrefs");
  const prefs = stored.displayPrefs || {};
  if (prefs.showBanner === false) return; // Banners disabled

  const data = await chrome.storage.local.get([STORAGE_KEY, SUSPICIOUS_KEY]);
  const blockSet = new Set(data[STORAGE_KEY] || []);
  const suspiciousSet = new Set(data[SUSPICIOUS_KEY] || []);

  const customColors = prefs.colors || {};

  // Check exact hostname and all parent domains (O(1) per check)
  const matchesDomain = (domainSet) => {
    if (domainSet.size === 0) return false;
    let h = hostname;
    while (h) {
      if (domainSet.has(h)) return true;
      const dot = h.indexOf('.');
      if (dot === -1) break;
      h = h.slice(dot + 1);
    }
    return false;
  };

  if (matchesDomain(blockSet)) {
    injectWarningBanner(hostname, "blocked", customColors);
  } else if (matchesDomain(suspiciousSet)) {
    injectWarningBanner(hostname, "suspicious", customColors);
  }
})();

/**
 * Inject a full-width, fixed-position warning banner at the top of the page.
 * Users can dismiss the banner, which hides it for the current page load.
 */
function injectWarningBanner(hostname, level, customColors) {
  // Prevent duplicate banners if the script fires more than once.
  if (document.getElementById("url-monitor-warning")) return;

  const isBlocked = level === "blocked";
  const defaultColor = isBlocked ? "#d32f2f" : "#e65100";
  const bgColor = isBlocked
    ? (customColors.blocked || defaultColor)
    : (customColors.reported || defaultColor);

  const banner = document.createElement("div");
  banner.id = "url-monitor-warning";

  banner.setAttribute(
    "style",
    [
      "position: fixed",
      "top: 0",
      "left: 0",
      "width: 100%",
      "min-height: 56px",
      `background: ${bgColor}`,
      "color: #fff",
      "font: bold 16px/56px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
      "text-align: center",
      "z-index: 2147483647",
      "box-shadow: 0 2px 8px rgba(0,0,0,0.45)",
      "padding: 0 24px",
      "box-sizing: border-box",
      "user-select: none",
      "letter-spacing: 0.3px",
      "display: flex",
      "align-items: center",
      "justify-content: center",
      "gap: 12px",
    ].join(" !important;") + " !important"
  );

  const escapedHostname = escapeHtml(hostname);
  const codeStyle = "background:rgba(0,0,0,0.25)!important;padding:2px 6px!important;border-radius:3px!important;font-size:15px!important";

  const msgSpan = document.createElement("span");
  msgSpan.style.cssText = "flex:1!important;";
  if (isBlocked) {
    msgSpan.innerHTML =
      "\u26A0\uFE0F <strong>Warning:</strong> " +
      "<code style='" + codeStyle + "'>" + escapedHostname + "</code>" +
      " has been flagged as a <strong>phishing / scam</strong> site. Leave this page immediately.";
  } else {
    msgSpan.innerHTML =
      "\u26A0\uFE0F <strong>Suspicious:</strong> " +
      "<code style='" + codeStyle + "'>" + escapedHostname + "</code>" +
      " has been reported but <strong>not yet verified</strong>. Proceed with caution.";
  }
  banner.appendChild(msgSpan);

  // Dismiss button
  const dismissBtn = document.createElement("button");
  dismissBtn.textContent = "✕";
  dismissBtn.title = "Dismiss warning";
  dismissBtn.setAttribute(
    "style",
    [
      "background: rgba(0,0,0,0.3)",
      "border: none",
      "color: #fff",
      "font-size: 18px",
      "cursor: pointer",
      "border-radius: 4px",
      "width: 32px",
      "height: 32px",
      "line-height: 32px",
      "padding: 0",
      "flex-shrink: 0",
    ].join(" !important;") + " !important"
  );
  dismissBtn.addEventListener("click", () => {
    banner.remove();
    if (document.body) {
      document.body.style.removeProperty("margin-top");
    }
  });
  banner.appendChild(dismissBtn);

  // Push page content down so the banner doesn't cover it.
  if (document.body) {
    document.body.style.setProperty("margin-top", "56px", "important");
  }

  // Insert as the first child of <html> so it sits above everything.
  const root = document.documentElement;
  root.insertBefore(banner, root.firstChild);
}

// Listen for messages from the popup to inject a banner on demand
chrome.runtime.onMessage.addListener(async (msg) => {
  if (msg.type === "show-banner" && msg.hostname && msg.level) {
    const stored = await chrome.storage.local.get("displayPrefs");
    const prefs = stored.displayPrefs || {};
    if (prefs.showBanner === false) return;
    injectWarningBanner(msg.hostname, msg.level, prefs.colors || {});
  }
});
