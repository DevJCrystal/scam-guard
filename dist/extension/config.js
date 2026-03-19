// ─────────────────────────────────────────────
//  config.js  –  Centralised configuration
// ─────────────────────────────────────────────
//  All Appwrite IDs and endpoints live here so contributors
//  only need to update one file when setting up their own instance.
//
//  To run your own instance:
//    1. Create an Appwrite project.
//    2. Copy this file and fill in your own IDs.
//    3. See README.md for the full setup guide.
// ─────────────────────────────────────────────

const UM_CONFIG = Object.freeze({
  // ── Appwrite connection ───────────────────────────────────────
  APPWRITE_ENDPOINT: "https://nyc.cloud.appwrite.io/v1",
  APPWRITE_PROJECT_ID: "693af3910033ee1e5486",

  // ── ScamGuard website ─────────────────────────────────────────
  SITE_URL: "https://sg.crystaljake.com",

  // ── Function IDs ──────────────────────────────────────────────
  SUBMIT_REPORT_FUNCTION_ID: "69b3e61a0016a2bb271d",
  FETCH_BLOCKLIST_FUNCTION_ID: "69b3e72f00159acbc4f1",

  // ── Storage ───────────────────────────────────────────────────
  LISTS_BUCKET_ID: "url_monitor_lists",
  BLOCKLIST_FILE_ID: "blocklist",
  TRUSTED_FILE_ID: "trusted",

  // ── Sync settings ────────────────────────────────────────────
  SYNC_INTERVAL_MINUTES: 15,
  // ── List integrity (ECDSA P-256 public key for signature verification) ──
  LIST_SIGNING_PUBLIC_KEY: "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEbes2MEBf1kXsyvoee5UUGbgX1ulWmul6oyVwWIFlq1VkrJXRGPu4iI6eg6xyAyNO089WYAxl3aPaJk8Xsd9SJw==",
  // ── Thresholds (must match server-side values) ────────────────
  LOOKALIKE_SIMILARITY_MIN: 0.75,
});
