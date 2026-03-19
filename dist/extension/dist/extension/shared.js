// ─────────────────────────────────────────────
//  shared.js  –  Shared utilities for popup & content scripts
// ─────────────────────────────────────────────
//  Loaded via <script> before popup.js and content.js.
//  Also importable by background.js via importScripts().
// ─────────────────────────────────────────────

/** HTML-entity escaping to prevent DOM injection. */
function escapeHtml(str) {
  const map = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  return str.replace(/[&<>"']/g, (ch) => map[ch]);
}

/**
 * Appwrite public REST helper (no auth — for public function calls).
 * For authenticated requests, use the version in settings.js instead.
 */
async function appwriteFetch(path, method = "GET", body = null) {
  const headers = {
    "Content-Type": "application/json",
    "X-Appwrite-Project": UM_CONFIG.APPWRITE_PROJECT_ID,
    "X-Fallback-Cookies": JSON.stringify({}),
  };

  const res = await fetch(`${UM_CONFIG.APPWRITE_ENDPOINT}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const error = new Error(err.message || `HTTP ${res.status}`);
    error.type = err.type || "";
    error.code = res.status;
    throw error;
  }

  if (res.status === 204) return {};
  return res.json();
}
