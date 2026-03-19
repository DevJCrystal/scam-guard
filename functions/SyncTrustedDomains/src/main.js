import { Client, Databases, Query, ID } from 'node-appwrite';

// Syncs the top domains from the Tranco list into the trusted_domains collection.
// Tranco is a research-grade top-sites ranking that combines Alexa, Umbrella,
// Majestic, and Chrome UX data — designed to resist manipulation.
//
// Schedule: daily (set via Appwrite function schedule)
//
// Environment variables:
//   APPWRITE_DATABASE_ID        – the shared database
//   TRUSTED_DOMAINS_COLLECTION_ID – the trusted_domains collection
//   BLOCKLIST_COLLECTION_ID     – the domains/blocklist collection (for cross-check)

const DATABASE_ID = process.env.APPWRITE_DATABASE_ID;
const TRUSTED_COLLECTION_ID = process.env.TRUSTED_DOMAINS_COLLECTION_ID;
const BLOCKLIST_COLLECTION_ID = process.env.BLOCKLIST_COLLECTION_ID;

// How many top domains to import (top 1k covers the most impersonated brands)
const IMPORT_LIMIT = 1000;
// Tranco API to discover the latest list, then download as plain CSV
const TRANCO_API = 'https://tranco-list.eu/api/lists/date/latest';
// Safety: abort if more than this fraction of the list changes in one sync
const MAX_CHURN_RATIO = 0.10;

// Batch size for Appwrite reads
const BATCH_SIZE = 100;

export default async ({ req, res, log, error }) => {
  const client = new Client()
    .setEndpoint(process.env.APPWRITE_FUNCTION_API_ENDPOINT)
    .setProject(process.env.APPWRITE_FUNCTION_PROJECT_ID)
    .setKey(req.headers['x-appwrite-key'] ?? '');

  const databases = new Databases(client);

  try {
    // 1. Fetch the Tranco top list (CSV: rank,domain)
    log('Fetching Tranco list...');
    const csvText = await fetchTrancoCSV();
    const domains = parseTrancoCSV(csvText, IMPORT_LIMIT);
    log(`Parsed ${domains.length} domains from Tranco list`);

    // 2. Get existing domains in the collection for diffing
    const existing = new Map();
    let lastId = null;
    while (true) {
      const queries = [
        Query.limit(BATCH_SIZE),
        Query.select(['$id', 'domain']),
      ];
      if (lastId) queries.push(Query.cursorAfter(lastId));

      const batch = await databases.listDocuments(
        DATABASE_ID,
        TRUSTED_COLLECTION_ID,
        queries
      );
      for (const doc of batch.documents) {
        existing.set(doc.domain, doc.$id);
      }
      if (batch.documents.length < BATCH_SIZE) break;
      lastId = batch.documents[batch.documents.length - 1].$id;
    }
    log(`Existing trusted domains in DB: ${existing.size}`);

    // 3. Safety check: abort if delta is suspiciously large (possible compromise)
    const newDomainSet = new Set(domains.map(d => d.domain));
    const toAdd = [...newDomainSet].filter(d => !existing.has(d)).length;
    const toRemove = [...existing.keys()].filter(d => !newDomainSet.has(d)).length;
    const totalChanges = toAdd + toRemove;
    const baseline = Math.max(existing.size, 1);

    if (existing.size > 0 && totalChanges / baseline > MAX_CHURN_RATIO) {
      const msg = `Aborting: ${totalChanges} changes (${toAdd} add, ${toRemove} remove) exceed ${MAX_CHURN_RATIO * 100}% of ${baseline} domains. Possible upstream compromise.`;
      error(msg);
      return res.json({ ok: false, message: msg, aborted: true }, 409);
    }

    // 4. Upsert new domains, skip ones already present
    let created = 0;
    let skippedReported = 0;

    for (const { rank, domain } of domains) {
      if (existing.has(domain)) continue;

      // Cross-check: skip domains that have reports/blocks in the blocklist collection
      if (BLOCKLIST_COLLECTION_ID) {
        try {
          const check = await databases.listDocuments(
            DATABASE_ID,
            BLOCKLIST_COLLECTION_ID,
            [Query.equal('domain', domain), Query.limit(1)]
          );
          if (check.documents.length > 0 && (check.documents[0].reportCount || 0) > 0) {
            log(`Skipping ${domain}: has ${check.documents[0].reportCount || 0} reports in blocklist (status: ${check.documents[0].status})`);
            skippedReported++;
            continue;
          }
        } catch { /* non-fatal — proceed with import */ }
      }

      try {
        await databases.createDocument(
          DATABASE_ID,
          TRUSTED_COLLECTION_ID,
          ID.unique(),
          { domain, rank, firstSeen: new Date().toISOString() }
        );
        created++;
      } catch (err) {
        // Skip duplicates (unique index conflict)
        if (!err.message?.includes('duplicate')) {
          error(`Failed to insert ${domain}: ${err.message}`);
        }
      }
    }

    // 5. Remove domains that fell out of the top list
    let removed = 0;
    for (const [domain, docId] of existing) {
      if (!newDomainSet.has(domain)) {
        try {
          await databases.deleteDocument(DATABASE_ID, TRUSTED_COLLECTION_ID, docId);
          removed++;
        } catch { /* ignore */ }
      }
    }

    const summary = `Sync complete: ${created} added, ${removed} removed, ${skippedReported} skipped (reported), ${domains.length} total`;
    log(summary);
    return res.json({ ok: true, message: summary, total: domains.length, created, removed, skippedReported });
  } catch (err) {
    error('Trusted domain sync failed: ' + err.message);
    return res.json({ ok: false, message: err.message }, 500);
  }
};

async function fetchTrancoCSV() {
  // Get the latest list ID from the Tranco API
  const apiRes = await fetch(TRANCO_API);
  if (!apiRes.ok) {
    throw new Error(`Tranco API failed: HTTP ${apiRes.status}`);
  }
  const meta = await apiRes.json();
  const downloadUrl = meta.download;
  if (!downloadUrl) {
    throw new Error('Tranco API did not return a download URL');
  }

  // Download the CSV (plain text, format: rank,domain)
  const csvRes = await fetch(downloadUrl);
  if (!csvRes.ok) {
    throw new Error(`Tranco CSV download failed: HTTP ${csvRes.status}`);
  }
  return csvRes.text();
}

function parseTrancoCSV(csv, limit) {
  const lines = csv.split('\n');
  const results = [];

  for (const line of lines) {
    if (results.length >= limit) break;
    const trimmed = line.trim();
    if (!trimmed) continue;

    const comma = trimmed.indexOf(',');
    if (comma === -1) continue;

    const rank = parseInt(trimmed.substring(0, comma), 10);
    const domain = trimmed.substring(comma + 1).toLowerCase().trim();

    if (!isNaN(rank) && domain && domain.includes('.')) {
      results.push({ rank, domain });
    }
  }

  return results;
}
