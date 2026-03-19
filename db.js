// ─────────────────────────────────────────────
//  db.js  –  Shared IndexedDB helper for URL Monitor
// ─────────────────────────────────────────────
//  Used by both background.js (via importScripts) and popup.js
//  (via <script> tag). Both run in the extension origin so they
//  share the same IndexedDB instance.
// ─────────────────────────────────────────────

const UM_DB_NAME = "urlmonitor";
const UM_DB_VERSION = 1;

let _dbInstance = null;

function openUmDB() {
  if (_dbInstance) return Promise.resolve(_dbInstance);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(UM_DB_NAME, UM_DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains("blocklist")) {
        db.createObjectStore("blocklist", { keyPath: "domain" });
      }
      if (!db.objectStoreNames.contains("trusted")) {
        db.createObjectStore("trusted", { keyPath: "domain" });
      }
      if (!db.objectStoreNames.contains("meta")) {
        db.createObjectStore("meta", { keyPath: "key" });
      }
    };
    req.onsuccess = () => {
      _dbInstance = req.result;
      _dbInstance.onclose = () => { _dbInstance = null; };
      resolve(_dbInstance);
    };
    req.onerror = () => reject(req.error);
  });
}

// ── Blocklist operations ────────────────────────────────────────────

/** Look up a single domain in the blocklist store. Returns the entry or null. */
async function umLookupDomain(domain) {
  const db = await openUmDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("blocklist", "readonly");
    const req = tx.objectStore("blocklist").get(domain);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

/** Store the full blocklist (object keyed by domain). Clears old data first. */
async function umStoreBlocklist(domainsObj) {
  const db = await openUmDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("blocklist", "readwrite");
    const store = tx.objectStore("blocklist");
    store.clear();
    for (const [domain, info] of Object.entries(domainsObj)) {
      store.put({ domain, ...info });
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** Get all blocked domain strings (status === "blocked"). */
async function umGetBlockedDomains() {
  const db = await openUmDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("blocklist", "readonly");
    const req = tx.objectStore("blocklist").getAll();
    req.onsuccess = () => {
      resolve(req.result.filter(d => d.status === "blocked").map(d => d.domain));
    };
    req.onerror = () => reject(req.error);
  });
}

/** Get all reported (suspicious) domain strings (status === "reported"). */
async function umGetReportedDomains() {
  const db = await openUmDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("blocklist", "readonly");
    const req = tx.objectStore("blocklist").getAll();
    req.onsuccess = () => {
      resolve(req.result.filter(d => d.status === "reported").map(d => d.domain));
    };
    req.onerror = () => reject(req.error);
  });
}

// ── Trusted domains operations ──────────────────────────────────────

/** Store the trusted domains array (v1 format — plain strings). Clears old data first. */
async function umStoreTrustedDomains(domainArray) {
  const db = await openUmDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("trusted", "readwrite");
    const store = tx.objectStore("trusted");
    store.clear();
    for (const domain of domainArray) {
      store.put({ domain, source: 'curated' });
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** Store the trusted domains object (v2 format — keyed by domain with metadata). */
async function umStoreTrustedDomainsV2(domainsObj) {
  const db = await openUmDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("trusted", "readwrite");
    const store = tx.objectStore("trusted");
    store.clear();
    for (const [domain, info] of Object.entries(domainsObj)) {
      store.put({ domain, ...info });
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** Look up a single domain in the trusted store. Returns the entry or null. */
async function umLookupTrustedDomain(domain) {
  const db = await openUmDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("trusted", "readonly");
    const req = tx.objectStore("trusted").get(domain);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

/** Get all trusted domain strings. */
async function umGetAllTrustedDomains() {
  const db = await openUmDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("trusted", "readonly");
    const req = tx.objectStore("trusted").getAll();
    req.onsuccess = () => resolve(req.result.map(d => d.domain));
    req.onerror = () => reject(req.error);
  });
}

/** Count entries in the blocklist store. */
async function umCountBlocklist() {
  const db = await openUmDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("blocklist", "readonly");
    const req = tx.objectStore("blocklist").count();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Count entries in the trusted store. */
async function umCountTrusted() {
  const db = await openUmDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("trusted", "readonly");
    const req = tx.objectStore("trusted").count();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// ── Metadata operations ─────────────────────────────────────────────

async function umGetMeta(key) {
  const db = await openUmDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("meta", "readonly");
    const req = tx.objectStore("meta").get(key);
    req.onsuccess = () => resolve(req.result?.value ?? null);
    req.onerror = () => reject(req.error);
  });
}

async function umSetMeta(key, value) {
  const db = await openUmDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("meta", "readwrite");
    tx.objectStore("meta").put({ key, value });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
