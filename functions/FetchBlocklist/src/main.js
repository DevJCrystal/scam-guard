import { Client, Databases, Query } from 'node-appwrite';

// Environment variables (set in Appwrite console):
//   APPWRITE_DATABASE_ID   – the database containing the blocklist
//   BLOCKLIST_COLLECTION_ID – the collection with domain documents
//   VOTES_COLLECTION_ID     – the votes collection (for my-votes sync)

const DATABASE_ID = process.env.APPWRITE_DATABASE_ID;
const COLLECTION_ID = process.env.BLOCKLIST_COLLECTION_ID;
const VOTES_COLLECTION_ID = process.env.VOTES_COLLECTION_ID;

export default async ({ req, res, log, error }) => {
  const client = new Client()
    .setEndpoint(process.env.APPWRITE_FUNCTION_API_ENDPOINT)
    .setProject(process.env.APPWRITE_FUNCTION_PROJECT_ID)
    .setKey(req.headers['x-appwrite-key'] ?? '');

  const databases = new Databases(client);

  // Single-domain lookup: GET ?domain=example.com
  const body = req.bodyJson ?? (typeof req.bodyText === 'string' && req.bodyText ? JSON.parse(req.bodyText) : {});

  // Sync user's votes: { action: 'my-votes' }
  if (body?.action === 'my-votes') {
    const userId = req.headers['x-appwrite-user-id'];
    if (!userId) {
      return res.json({ ok: false, message: 'Authentication required' }, 401);
    }
    try {
      const votes = {};
      let lastId = null;
      while (true) {
        const queries = [
          Query.equal('userId', userId),
          Query.limit(100),
          Query.select(['domain', 'type']),
        ];
        if (lastId) queries.push(Query.cursorAfter(lastId));
        const batch = await databases.listDocuments(DATABASE_ID, VOTES_COLLECTION_ID, queries);
        for (const doc of batch.documents) {
          votes[doc.domain] = doc.type;
        }
        if (batch.documents.length < 100) break;
        lastId = batch.documents[batch.documents.length - 1].$id;
      }
      return res.json({ ok: true, votes });
    } catch (err) {
      error('my-votes failed: ' + err.message);
      return res.json({ ok: false, message: 'Could not fetch votes' }, 500);
    }
  }

  const lookupDomain = body?.domain?.toLowerCase().trim();

  if (lookupDomain) {
    try {
      const result = await databases.listDocuments(
        DATABASE_ID,
        COLLECTION_ID,
        [Query.equal('domain', lookupDomain), Query.limit(1)]
      );

      if (result.documents.length === 0) {
        return res.json({ ok: true, found: false });
      }

      const d = result.documents[0];
      return res.json({
        ok: true,
        found: true,
        domain: d.domain,
        status: d.status,
        riskScore: d.riskScore || 0,
        reportCount: d.reportCount || 0,
        vouchCount: d.vouchCount || 0,
        qualifiedVouchCount: d.qualifiedVouchCount || 0,
        lookalikeDomain: d.lookalikeDomain || null,
        lookalikeScore: d.lookalikeScore || null,
        firstReportedAt: d.firstReportedAt || null,
        trustedSince: d.trustedSince || null,
        verifiedAt: d.verifiedAt || null,
      });
    } catch (err) {
      error('Domain lookup failed: ' + err.message);
      return res.json({ ok: false, found: false }, 500);
    }
  }

  // Bulk blocklist fetch (default behavior)
  try {
    const blocked = [];
    const reported = [];

    // Fetch blocked, reported, and pending domains
    const pending = [];
    for (const status of ['blocked', 'reported', 'pending']) {
      let lastId = null;
      const limit = 100;
      const target = status === 'blocked' ? blocked : status === 'reported' ? reported : pending;

      while (true) {
        const queries = [
          Query.equal('status', status),
          Query.limit(limit),
          Query.select(['domain']),
        ];
        if (lastId) queries.push(Query.cursorAfter(lastId));

        const batch = await databases.listDocuments(
          DATABASE_ID,
          COLLECTION_ID,
          queries
        );
        target.push(...batch.documents.map((d) => d.domain.toLowerCase()));
        if (batch.documents.length < limit) break;
        lastId = batch.documents[batch.documents.length - 1].$id;
      }
    }

    log(`Returning ${blocked.length} blocked, ${reported.length} reported, ${pending.length} pending domains`);
    return res.json({ ok: true, domains: blocked, reportedDomains: reported, pendingDomains: pending });
  } catch (err) {
    error('Failed to fetch blocklist: ' + err.message);
    return res.json({ ok: false, domains: [], reportedDomains: [] }, 500);
  }
};
