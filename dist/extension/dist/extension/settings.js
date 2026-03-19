/* settings.js – Account settings page logic */

const { APPWRITE_ENDPOINT, APPWRITE_PROJECT_ID } = UM_CONFIG;

// ── Color presets ───────────────────────────────────────────────
const COLOR_PRESETS = {
  default: {
    blocked: "#d32f2f",
    reported: "#e65100",
    trusted: "#4caf50",
    verified: "#2e7d32",
  },
  colorblind: {
    blocked: "#d81b60",   // magenta - distinguishable for deuteranopia/protanopia
    reported: "#f57c00",  // orange
    trusted: "#1e88e5",   // blue - replaces green
    verified: "#7b1fa2",  // purple
  },
};

const DEFAULT_DISPLAY_PREFS = {
  showBanner: true,
  showBadge: true,
  colorPreset: "default",
  colors: { ...COLOR_PRESETS.default },
};

// ── Appwrite REST helper (mirrors popup.js) ─────────────────────
async function appwriteFetch(path, method = "GET", body = null) {
  const headers = {
    "Content-Type": "application/json",
    "X-Appwrite-Project": APPWRITE_PROJECT_ID,
  };
  const stored = await chrome.storage.session.get("appwrite_session_secret");
  const cookieName = "a_session_" + APPWRITE_PROJECT_ID;
  headers["X-Fallback-Cookies"] = JSON.stringify(
    stored.appwrite_session_secret
      ? { [cookieName]: stored.appwrite_session_secret }
      : {}
  );
  const res = await fetch(`${APPWRITE_ENDPOINT}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.ok) {
    const fallback = res.headers.get("X-Fallback-Cookies");
    if (fallback) {
      try {
        const cookies = JSON.parse(fallback);
        if (cookies[cookieName]) {
          await chrome.storage.session.set({ appwrite_session_secret: cookies[cookieName] });
        }
      } catch { /* ignore */ }
    }
  }
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

// ── DOM refs ────────────────────────────────────────────────────
const $  = id => document.getElementById(id);
const notSignedIn        = $("not-signed-in");
const settingsContent    = $("settings-content");
const accountEmail       = $("account-email");
const emailVerifiedEl    = $("email-verified-status");
const mfaStatusEl        = $("mfa-status");
const accountCreated     = $("account-created");
const verifyEmailCard    = $("verify-email-card");
const mfaNotEnabled      = $("mfa-not-enabled");
const mfaEnabled         = $("mfa-enabled");
const mfaSetupFlow       = $("mfa-setup-flow");
const mfaDisableFlow     = $("mfa-disable-flow");

// ── State ───────────────────────────────────────────────────────
let currentAccount = null;

// ── Init ────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", init);

async function init() {
  // Load display prefs first (always visible, no auth needed)
  await loadDisplayPrefs();
  wireDisplayPrefs();

  try {
    currentAccount = await appwriteFetch("/account");
    showSettings(currentAccount);
  } catch {
    notSignedIn.classList.remove("hidden");
    settingsContent.classList.add("hidden");
  }

  // Wire up buttons
  $("btn-change-password").addEventListener("click", changePassword);
  $("btn-send-verification").addEventListener("click", sendVerification);
  $("btn-setup-mfa").addEventListener("click", startMfaSetup);
  $("btn-confirm-mfa").addEventListener("click", confirmMfaSetup);
  $("btn-cancel-mfa-setup").addEventListener("click", cancelMfaSetup);
  $("btn-disable-mfa").addEventListener("click", startMfaDisable);
  $("btn-confirm-disable-mfa").addEventListener("click", confirmMfaDisable);
  $("btn-cancel-mfa-disable").addEventListener("click", cancelMfaDisable);
  $("btn-delete-account").addEventListener("click", startDeleteAccount);
  $("btn-confirm-delete").addEventListener("click", confirmDeleteAccount);
  $("btn-cancel-delete").addEventListener("click", cancelDeleteAccount);
}

// ── Display account info ────────────────────────────────────────
function showSettings(acct) {
  notSignedIn.classList.add("hidden");
  settingsContent.classList.remove("hidden");

  accountEmail.textContent = acct.email;

  if (acct.emailVerification) {
    emailVerifiedEl.innerHTML = '<span class="badge-ok">Verified</span>';
    verifyEmailCard.classList.add("hidden");
  } else {
    emailVerifiedEl.innerHTML = '<span class="badge-warn">Not verified</span>';
    verifyEmailCard.classList.remove("hidden");
  }

  const mfaOn = acct.mfa;
  if (mfaOn) {
    mfaStatusEl.innerHTML = '<span class="badge-ok">Enabled</span>';
    mfaNotEnabled.classList.add("hidden");
    mfaEnabled.classList.remove("hidden");
  } else {
    mfaStatusEl.innerHTML = '<span class="badge-off">Disabled</span>';
    mfaNotEnabled.classList.remove("hidden");
    mfaEnabled.classList.add("hidden");
  }

  const created = new Date(acct.$createdAt);
  accountCreated.textContent = created.toLocaleDateString(undefined, {
    year: "numeric", month: "short", day: "numeric"
  });
}

// ── Helpers ─────────────────────────────────────────────────────
function showMsg(elId, text, cls) {
  const el = $(elId);
  el.textContent = text;
  el.className = "msg " + cls;
  if (cls === "text-green") {
    setTimeout(() => { el.textContent = ""; el.className = "msg"; }, 3000);
  }
}

function clearInputs(...ids) {
  ids.forEach(id => { $(id).value = ""; });
}

// ── Change password ─────────────────────────────────────────────
async function changePassword() {
  const oldPw = $("current-password").value;
  const newPw = $("new-password").value;
  const confirmPw = $("confirm-password").value;

  if (!oldPw || !newPw) {
    return showMsg("password-msg", "Please fill in both fields.", "text-red");
  }
  if (newPw.length < 8) {
    return showMsg("password-msg", "New password must be at least 8 characters.", "text-red");
  }
  if (newPw !== confirmPw) {
    return showMsg("password-msg", "New passwords don't match.", "text-red");
  }

  const btn = $("btn-change-password");
  btn.disabled = true;
  btn.textContent = "Updating…";

  try {
    await appwriteFetch("/account/password", "PATCH", {
      password: newPw,
      oldPassword: oldPw,
    });
    showMsg("password-msg", "Password updated.", "text-green");
    clearInputs("current-password", "new-password", "confirm-password");
  } catch (e) {
    showMsg("password-msg", e.message || "Failed to update password.", "text-red");
  } finally {
    btn.disabled = false;
    btn.textContent = "Update Password";
  }
}

// ── Email verification ──────────────────────────────────────────
async function sendVerification() {
  const btn = $("btn-send-verification");
  btn.disabled = true;
  btn.textContent = "Sending…";

  try {
    await appwriteFetch("/account/verification", "POST", {
      url: `${UM_CONFIG.SITE_URL}/auth/verify`,
    });
    showMsg("verify-email-msg", "Verification email sent — check your inbox.", "text-green");
  } catch (e) {
    showMsg("verify-email-msg", e.message || "Failed to send verification email.", "text-red");
  } finally {
    btn.disabled = false;
    btn.textContent = "Send Verification Email";
  }
}

// ── MFA setup ───────────────────────────────────────────────────
let pendingMfaAuthId = null;

async function startMfaSetup() {
  const btn = $("btn-setup-mfa");
  btn.disabled = true;
  btn.textContent = "Setting up…";
  showMsg("mfa-msg", "", "");

  try {
    const result = await appwriteFetch("/account/mfa/authenticators/totp", "POST");
    pendingMfaAuthId = result.$id;

    // Render QR code client-side (no external service)
    if (result.uri) {
      const canvas = $("mfa-qr-canvas");
      const { matrix, size: modules } = QR.generate(result.uri);
      const margin = 4;
      const total = modules + margin * 2;
      const scale = Math.max(1, Math.floor(180 / total));
      const canvasSize = total * scale;
      canvas.width = canvasSize;
      canvas.height = canvasSize;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvasSize, canvasSize);
      ctx.fillStyle = "#000000";
      for (let r = 0; r < modules; r++) {
        for (let c = 0; c < modules; c++) {
          if (matrix[r][c] > 0) {
            ctx.fillRect((c + margin) * scale, (r + margin) * scale, scale, scale);
          }
        }
      }
    }

    // Show secret
    $("mfa-secret").textContent = result.secret || "—";

    mfaSetupFlow.classList.add("open");
    $("mfa-setup-code").value = "";
    $("mfa-setup-code").focus();
  } catch (e) {
    showMsg("mfa-msg", e.message || "Failed to start MFA setup.", "text-red");
  } finally {
    btn.disabled = false;
    btn.textContent = "Enable MFA";
  }
}

async function confirmMfaSetup() {
  const code = $("mfa-setup-code").value.trim();
  if (!/^\d{6}$/.test(code)) {
    return showMsg("mfa-msg", "Enter a 6-digit code.", "text-red");
  }

  const btn = $("btn-confirm-mfa");
  btn.disabled = true;
  btn.textContent = "Verifying…";

  try {
    // Verify the authenticator
    await appwriteFetch("/account/mfa/authenticators/totp", "PUT", { otp: code });
    // Enable MFA on the account
    await appwriteFetch("/account/mfa", "PATCH", { mfa: true });

    showMsg("mfa-msg", "MFA enabled successfully.", "text-green");
    mfaSetupFlow.classList.remove("open");
    pendingMfaAuthId = null;

    // Refresh display
    currentAccount = await appwriteFetch("/account");
    showSettings(currentAccount);
  } catch (e) {
    showMsg("mfa-msg", e.message || "Invalid code. Try again.", "text-red");
  } finally {
    btn.disabled = false;
    btn.textContent = "Verify & Enable";
  }
}

function cancelMfaSetup() {
  mfaSetupFlow.classList.remove("open");
  pendingMfaAuthId = null;
  showMsg("mfa-msg", "", "");
}

// ── MFA disable ─────────────────────────────────────────────────
const MAX_MFA_DISABLE_FAILURES = 3;
let mfaDisableFailCount = 0;

function startMfaDisable() {
  mfaDisableFlow.classList.add("open");
  $("mfa-disable-code").value = "";
  $("mfa-disable-code").focus();
  showMsg("mfa-msg", "", "");
}

async function confirmMfaDisable() {
  if (mfaDisableFailCount >= MAX_MFA_DISABLE_FAILURES) {
    return showMsg("mfa-msg", "Too many failed attempts. Please restart the extension.", "text-red");
  }

  const code = $("mfa-disable-code").value.trim();
  if (!/^\d{6}$/.test(code)) {
    return showMsg("mfa-msg", "Enter a 6-digit code.", "text-red");
  }

  const btn = $("btn-confirm-disable-mfa");
  btn.disabled = true;
  btn.textContent = "Disabling…";

  try {
    // Appwrite requires a challenge to disable MFA
    // First create TOTP challenge
    const challenge = await appwriteFetch("/account/mfa/challenge", "POST", {
      factor: "totp"
    });
    // Confirm challenge
    await appwriteFetch("/account/mfa/challenge", "PUT", {
      challengeId: challenge.$id,
      otp: code,
    });
    // Disable MFA
    await appwriteFetch("/account/mfa", "PATCH", { mfa: false });
    // Delete the authenticator
    await appwriteFetch("/account/mfa/authenticators/totp", "DELETE");

    mfaDisableFailCount = 0;
    showMsg("mfa-msg", "MFA disabled.", "text-green");
    mfaDisableFlow.classList.remove("open");

    currentAccount = await appwriteFetch("/account");
    showSettings(currentAccount);
  } catch (e) {
    mfaDisableFailCount++;
    const remaining = MAX_MFA_DISABLE_FAILURES - mfaDisableFailCount;
    if (remaining <= 0) {
      showMsg("mfa-msg", "Too many failed attempts. Please restart the extension.", "text-red");
      btn.disabled = true;
    } else {
      showMsg("mfa-msg", `${e.message || "Invalid code."} ${remaining} attempt${remaining === 1 ? '' : 's'} remaining.`, "text-red");
    }
  } finally {
    if (mfaDisableFailCount < MAX_MFA_DISABLE_FAILURES) {
      btn.disabled = false;
    }
    btn.textContent = "Disable MFA";
  }
}

function cancelMfaDisable() {
  mfaDisableFlow.classList.remove("open");
  showMsg("mfa-msg", "", "");
}

// ── Delete account ──────────────────────────────────────────────
function startDeleteAccount() {
  $("delete-confirm").classList.add("open");
  $("delete-confirm-input").value = "";
  $("delete-confirm-input").focus();
  showMsg("delete-msg", "", "");
}

async function confirmDeleteAccount() {
  const val = $("delete-confirm-input").value.trim();
  if (val !== "DELETE") {
    return showMsg("delete-msg", 'Type "DELETE" to confirm.', "text-red");
  }

  const password = $("delete-confirm-password").value;
  if (!password) {
    return showMsg("delete-msg", "Password is required.", "text-red");
  }

  const btn = $("btn-confirm-delete");
  btn.disabled = true;
  btn.textContent = "Deleting…";

  try {
    const stored = await chrome.storage.session.get("appwrite_session_secret");
    const session = stored.appwrite_session_secret;
    if (!session) throw new Error("Not signed in.");

    const res = await fetch(`${UM_CONFIG.SITE_URL}/api/auth/delete-account`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${session}`,
      },
      body: JSON.stringify({ password }),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.message || "Failed to delete account.");

    await chrome.storage.session.clear();
    showMsg("delete-msg", "Account deleted.", "text-green");
    setTimeout(() => {
      notSignedIn.classList.remove("hidden");
      settingsContent.classList.add("hidden");
    }, 2000);
  } catch (e) {
    showMsg("delete-msg", e.message || "Failed to delete account.", "text-red");
    btn.disabled = false;
    btn.textContent = "Permanently Delete Account";
  }
}

function cancelDeleteAccount() {
  $("delete-confirm").classList.remove("open");
  $("delete-confirm-input").value = "";
  $("delete-confirm-password").value = "";
  showMsg("delete-msg", "", "");
}

// ── Display preferences ─────────────────────────────────────────
async function loadDisplayPrefs() {
  const stored = await chrome.storage.local.get("displayPrefs");
  const prefs = { ...DEFAULT_DISPLAY_PREFS, ...stored.displayPrefs };
  if (stored.displayPrefs?.colors) {
    prefs.colors = { ...DEFAULT_DISPLAY_PREFS.colors, ...stored.displayPrefs.colors };
  }

  $("pref-banner").checked = prefs.showBanner;
  $("pref-badge").checked = prefs.showBadge;

  // Color preset buttons
  document.querySelectorAll("#color-presets button").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.preset === prefs.colorPreset);
  });

  // Color pickers
  $("color-blocked").value = prefs.colors.blocked;
  $("color-reported").value = prefs.colors.reported;
  $("color-trusted").value = prefs.colors.trusted;
  $("color-verified").value = prefs.colors.verified;

  // Show/hide custom picker
  $("custom-colors").classList.toggle("hidden", prefs.colorPreset !== "custom");

  updateSwatches(prefs.colors);
}

function updateSwatches(colors) {
  $("swatch-blocked").style.background = colors.blocked;
  $("swatch-reported").style.background = colors.reported;
  $("swatch-trusted").style.background = colors.trusted;
  $("swatch-verified").style.background = colors.verified;
}

async function saveDisplayPrefs() {
  const preset = document.querySelector("#color-presets button.active")?.dataset.preset || "default";
  let colors;
  if (preset === "custom") {
    colors = {
      blocked: $("color-blocked").value,
      reported: $("color-reported").value,
      trusted: $("color-trusted").value,
      verified: $("color-verified").value,
    };
  } else {
    colors = { ...COLOR_PRESETS[preset] };
  }

  const prefs = {
    showBanner: $("pref-banner").checked,
    showBadge: $("pref-badge").checked,
    colorPreset: preset,
    colors,
  };

  await chrome.storage.local.set({ displayPrefs: prefs });
  updateSwatches(colors);
  showMsg("display-msg", "Saved.", "text-green");
}

function wireDisplayPrefs() {
  // Toggle switches
  $("pref-banner").addEventListener("change", saveDisplayPrefs);
  $("pref-badge").addEventListener("change", saveDisplayPrefs);

  // Preset buttons
  document.querySelectorAll("#color-presets button").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("#color-presets button").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");

      const preset = btn.dataset.preset;
      $("custom-colors").classList.toggle("hidden", preset !== "custom");

      // Apply preset colors to pickers
      if (preset !== "custom" && COLOR_PRESETS[preset]) {
        $("color-blocked").value = COLOR_PRESETS[preset].blocked;
        $("color-reported").value = COLOR_PRESETS[preset].reported;
        $("color-trusted").value = COLOR_PRESETS[preset].trusted;
        $("color-verified").value = COLOR_PRESETS[preset].verified;
      }

      saveDisplayPrefs();
    });
  });

  // Custom color pickers
  ["color-blocked", "color-reported", "color-trusted", "color-verified"].forEach(id => {
    $(id).addEventListener("input", saveDisplayPrefs);
  });
}
