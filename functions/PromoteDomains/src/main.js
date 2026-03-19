import { Client, Databases, Functions, Query } from 'node-appwrite';

// Environment variables (set in Appwrite console):
//   APPWRITE_DATABASE_ID    – the database ID
//   BLOCKLIST_COLLECTION_ID – domains/blocklist collection
//   BUILD_BLOCKLISTS_ID     – function ID for BuildBlocklists

const DATABASE_ID = process.env.APPWRITE_DATABASE_ID;
const BLOCKLIST_COLLECTION_ID = process.env.BLOCKLIST_COLLECTION_ID;
const BUILD_BLOCKLISTS_ID = process.env.BUILD_BLOCKLISTS_ID;

const VERIFIED_VOUCH_THRESHOLD = +(process.env.VERIFIED_VOUCH_THRESHOLD || 500);
const VERIFIED_TRUSTED_DAYS = +(process.env.VERIFIED_TRUSTED_DAYS || 30);

export default async ({ req, res, log, error }) => {
  const client = new Client()
    .setEndpoint(process.env.APPWRITE_FUNCTION_API_ENDPOINT)
    .setProject(process.env.APPWRITE_FUNCTION_PROJECT_ID)
    .setKey(req.headers['x-appwrite-key'] ?? '');

  const databases = new Databases(client);

  try {
    const cutoffDate = new Date(Date.now() - VERIFIED_TRUSTED_DAYS * 24 * 60 * 60 * 1000).toISOString();

    // Find trusted domains eligible for verified promotion:
    //   status = 'trusted', qualifiedVouchCount >= threshold, trustedSince <= cutoff
    const promoted = [];
    let cursor = null;
    const batchSize = 100;

    while (true) {
      const queries = [
        Query.equal('status', 'trusted'),
        Query.greaterThanEqual('qualifiedVouchCount', VERIFIED_VOUCH_THRESHOLD),
        Query.lessThanEqual('trustedSince', cutoffDate),
        Query.limit(batchSize),
      ];
      if (cursor) queries.push(Query.cursorAfter(cursor));

      const batch = await databases.listDocuments(DATABASE_ID, BLOCKLIST_COLLECTION_ID, queries);

      for (const doc of batch.documents) {
        await databases.updateDocument(DATABASE_ID, BLOCKLIST_COLLECTION_ID, doc.$id, {
          status: 'verified',
          verifiedAt: new Date().toISOString(),
        });
        promoted.push(doc.domain);
        log(`Promoted ${doc.domain} to verified (${doc.qualifiedVouchCount} qualified vouches, trusted since ${doc.trustedSince})`);
      }

      if (batch.documents.length < batchSize) break;
      cursor = batch.documents[batch.documents.length - 1].$id;
    }

    log(`Promotion sweep complete: ${promoted.length} domain(s) promoted`);

    // Trigger list rebuild if any promotions occurred
    if (promoted.length > 0 && BUILD_BLOCKLISTS_ID) {
      try {
        const functions = new Functions(client);
        await functions.createExecution(BUILD_BLOCKLISTS_ID, '', false);
        log('Triggered BuildBlocklists rebuild');
      } catch (rebuildErr) {
        log(`BuildBlocklists trigger failed (non-fatal): ${rebuildErr.message}`);
      }
    }

    return res.json({ ok: true, promoted: promoted.length, domains: promoted });
  } catch (err) {
    error('PromoteDomains failed: ' + err.message);
    return res.json({ ok: false, message: 'Promotion sweep failed' }, 500);
  }
};
