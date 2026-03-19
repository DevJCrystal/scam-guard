import { Client, Databases, Storage, Query } from 'node-appwrite';
import { InputFile } from 'node-appwrite/file';
import { createSign } from 'crypto';

// Environment variables (set in Appwrite console):
//   APPWRITE_DATABASE_ID           – the database ID
//   BLOCKLIST_COLLECTION_ID        – domains/blocklist collection
//   TRUSTED_DOMAINS_COLLECTION_ID  – trusted domains collection
//   LISTS_BUCKET_ID                – Storage bucket for compiled JSON files

const DATABASE_ID = process.env.APPWRITE_DATABASE_ID;
const BLOCKLIST_COLLECTION_ID = process.env.BLOCKLIST_COLLECTION_ID;
const TRUSTED_COLLECTION_ID = process.env.TRUSTED_DOMAINS_COLLECTION_ID;
const BUCKET_ID = process.env.LISTS_BUCKET_ID;

// Fixed file IDs so download URLs are stable
const BLOCKLIST_FILE_ID = 'blocklist';
const TRUSTED_FILE_ID = 'trusted';

export default async ({ req, res, log, error }) => {
  const client = new Client()
    .setEndpoint(process.env.APPWRITE_FUNCTION_API_ENDPOINT)
    .setProject(process.env.APPWRITE_FUNCTION_PROJECT_ID)
    .setKey(req.headers['x-appwrite-key'] ?? '');

  const databases = new Databases(client);
  const storage = new Storage(client);

  try {
    // ── 1. Read all domains and split by status ──────────────────
    log('Reading domains…');
    const { blocklist: badDomains, communityTrusted } = await readAllDomains(databases, log);

    // ── 2. Build the blocklist JSON (reported + blocked only) ────
    log('Building blocklist…');
    const blocklist = buildBlocklist(badDomains);

    // ── 3. Build the trusted JSON (curated + community) ─────────
    log('Building trusted list…');
    const trustedList = await buildTrustedList(databases, communityTrusted, log);

    // ── 4. Upload both to Storage ────────────────────────────────
    await uploadJson(storage, BLOCKLIST_FILE_ID, 'blocklist.json', blocklist, log);
    await uploadJson(storage, TRUSTED_FILE_ID, 'trusted.json', trustedList, log);

    return res.json({
      ok: true,
      blocklist: { count: blocklist.count },
      trusted: { count: trustedList.count },
      buildTime: blocklist.buildTime,
    });
  } catch (err) {
    error('BuildBlocklists failed: ' + err.message);
    return res.json({ ok: false, message: err.message }, 500);
  }
};

// ── Read all docs from the domains collection, split by status ──────
// Uses cursor-based pagination — no 5000 offset limit.
// Returns { blocklist, communityTrusted } where:
//   blocklist       = domains with status reported/blocked (bad)
//   communityTrusted = domains with status trusted/verified (good)

async function readAllDomains(databases, log) {
  const blocklist = {};
  const communityTrusted = {};
  let lastId = null;
  const limit = 100;
  let total = 0;

  while (true) {
    const queries = [Query.limit(limit)];
    if (lastId) queries.push(Query.cursorAfter(lastId));

    const batch = await databases.listDocuments(
      DATABASE_ID,
      BLOCKLIST_COLLECTION_ID,
      queries
    );

    for (const doc of batch.documents) {
      const entry = {
        status: doc.status,
        riskScore: doc.riskScore || 0,
        reportCount: doc.reportCount || 0,
        vouchCount: doc.vouchCount || 0,
        qualifiedVouchCount: doc.qualifiedVouchCount || 0,
        firstReportedAt: doc.firstReportedAt || null,
        lookalikeDomain: doc.lookalikeDomain || null,
        lookalikeScore: doc.lookalikeScore || null,
        scamType: doc.scamType || null,
        evidence: doc.evidence || null,
        trustedSince: doc.trustedSince || null,
        verifiedAt: doc.verifiedAt || null,
      };

      if (doc.status === 'trusted' || doc.status === 'verified') {
        communityTrusted[doc.domain] = entry;
      } else if (doc.status === 'reported' || doc.status === 'blocked') {
        blocklist[doc.domain] = entry;
      }
      // 'pending' domains are excluded from both lists — they have some
      // vouches but haven't reached trusted threshold yet. Showing them
      // in the blocklist would warn users about domains that aren't dangerous.
      total++;
    }

    if (batch.documents.length < limit) break;
    lastId = batch.documents[batch.documents.length - 1].$id;
  }

  log(`Read ${total} domains: ${Object.keys(blocklist).length} bad, ${Object.keys(communityTrusted).length} trusted/verified, ${total - Object.keys(blocklist).length - Object.keys(communityTrusted).length} pending`);
  return { blocklist, communityTrusted };
}

// ── Build blocklist JSON (reported + blocked only) ──────────────────

function buildBlocklist(blocklist) {
  return {
    buildTime: new Date().toISOString(),
    version: 2,
    count: Object.keys(blocklist).length,
    domains: blocklist,
  };
}

// ── Build trusted JSON (Tranco + community trusted + verified) ──────

async function buildTrustedList(databases, communityTrusted, log) {
  // 1. Tranco / curated trusted domains from the trusted_domains collection
  const curatedDomains = [];
  let lastId = null;
  const limit = 100;

  while (true) {
    const queries = [Query.limit(limit)];
    if (lastId) queries.push(Query.cursorAfter(lastId));

    const batch = await databases.listDocuments(
      DATABASE_ID,
      TRUSTED_COLLECTION_ID,
      queries
    );

    for (const doc of batch.documents) {
      curatedDomains.push({ domain: doc.domain, firstSeen: doc.firstSeen || null });
    }

    if (batch.documents.length < limit) break;
    lastId = batch.documents[batch.documents.length - 1].$id;
  }

  // 2. Merge curated + community trusted into a single trusted list
  //    Community trusted domains include richer data (vouchCount, verified status)
  const domains = {};

  for (const entry of curatedDomains) {
    domains[entry.domain] = { source: 'curated', firstSeen: entry.firstSeen };
  }

  for (const [d, info] of Object.entries(communityTrusted)) {
    domains[d] = {
      source: 'community',
      status: info.status,
      vouchCount: info.vouchCount,
      qualifiedVouchCount: info.qualifiedVouchCount,
      verifiedAt: info.verifiedAt,
    };
  }

  log(`Trusted list compiled: ${curatedDomains.length} curated + ${Object.keys(communityTrusted).length} community = ${Object.keys(domains).length} total`);
  return {
    buildTime: new Date().toISOString(),
    version: 2,
    count: Object.keys(domains).length,
    domains,
  };
}

// ── Sign JSON data with ECDSA P-256 private key ────────────────────

function signPayload(json) {
  const privKeyB64 = process.env.LIST_SIGNING_KEY;
  if (!privKeyB64) return null;

  const privKeyDer = Buffer.from(privKeyB64, 'base64');
  const signer = createSign('SHA256');
  signer.update(json);
  signer.end();
  return signer.sign({ key: privKeyDer, format: 'der', type: 'pkcs8' }, 'base64');
}

// ── Upload a JSON payload to Storage (replace if exists) ────────────

async function uploadJson(storage, fileId, filename, data, log) {
  const json = JSON.stringify(data);

  // Sign the payload so the extension can verify integrity
  const signature = signPayload(json);
  const envelope = signature ? { payload: data, signature } : data;
  const envelopeJson = JSON.stringify(envelope);
  const buffer = Buffer.from(envelopeJson, 'utf-8');

  // Try to create the file; if it already exists, delete the old one and retry.
  // This avoids any window where the file is missing.
  try {
    await storage.createFile(BUCKET_ID, fileId, InputFile.fromBuffer(buffer, filename));
  } catch (err) {
    // File already exists — delete and re-upload
    await storage.deleteFile(BUCKET_ID, fileId);
    await storage.createFile(BUCKET_ID, fileId, InputFile.fromBuffer(buffer, filename));
  }

  log(`Uploaded ${filename} (${(buffer.length / 1024).toFixed(1)} KB, ${data.count} entries${signature ? ', signed' : ''})`);
}
