import { Client, Databases, Functions, Users, Query } from 'node-appwrite';

// Environment variables (set in Appwrite console):
//   APPWRITE_DATABASE_ID    – the database ID
//   BLOCKLIST_COLLECTION_ID – domains/blocklist collection
//   VOTES_COLLECTION_ID     – votes collection
//   BUILD_BLOCKLISTS_ID     – function ID for BuildBlocklists

const DATABASE_ID = process.env.APPWRITE_DATABASE_ID;
const BLOCKLIST_COLLECTION_ID = process.env.BLOCKLIST_COLLECTION_ID;
const VOTES_COLLECTION_ID = process.env.VOTES_COLLECTION_ID;
const BUILD_BLOCKLISTS_ID = process.env.BUILD_BLOCKLISTS_ID;

// Tunable thresholds — override via env vars so production values stay secret
const BURST_WINDOW_MS = +(process.env.BURST_WINDOW_MS || 2 * 60 * 60 * 1000);
const BURST_MIN_VOTES = +(process.env.BURST_MIN_VOTES || 3);
const FRESH_ACCOUNT_AGE_MS = +(process.env.FRESH_ACCOUNT_AGE_MS || 7 * 24 * 60 * 60 * 1000);
const FRESH_SWARM_MIN = +(process.env.FRESH_SWARM_MIN || 3);
const SUBNET_CLUSTER_MIN = +(process.env.SUBNET_CLUSTER_MIN || 3);
const AUDIT_WINDOW_MS = +(process.env.AUDIT_WINDOW_MS || 5 * 60 * 60 * 1000);

// Status resolution constants (mirrored from SubmitReport)
const BLOCK_THRESHOLD = +(process.env.BLOCK_THRESHOLD || 3);
const TRUSTED_MIN_VOUCHES = +(process.env.TRUSTED_MIN_VOUCHES || 2);
const VERIFIED_VOUCH_THRESHOLD = +(process.env.VERIFIED_VOUCH_THRESHOLD || 500);
const VERIFIED_TRUSTED_DAYS = +(process.env.VERIFIED_TRUSTED_DAYS || 30);
const QUALIFIED_VOTER_MIN_DOMAINS = +(process.env.QUALIFIED_VOTER_MIN_DOMAINS || 3);

export default async ({ req, res, log, error }) => {
  const client = new Client()
    .setEndpoint(process.env.APPWRITE_FUNCTION_API_ENDPOINT)
    .setProject(process.env.APPWRITE_FUNCTION_PROJECT_ID)
    .setKey(req.headers['x-appwrite-key'] ?? '');

  const databases = new Databases(client);
  const users = new Users(client);

  const cutoff = new Date(Date.now() - AUDIT_WINDOW_MS).toISOString();
  let totalFlagged = 0;
  const affectedDomains = new Set();

  // Fetch recent unflagged votes in pages
  const recentVotes = await fetchAllPages(databases, VOTES_COLLECTION_ID, [
    Query.equal('flagged', false),
    Query.greaterThan('createdAt', cutoff),
  ]);

  log(`Auditing ${recentVotes.length} recent unflagged votes`);

  // Group votes by domain for heuristic analysis
  const byDomain = new Map();
  for (const vote of recentVotes) {
    const arr = byDomain.get(vote.domain) || [];
    arr.push(vote);
    byDomain.set(vote.domain, arr);
  }

  for (const [domain, votes] of byDomain) {
    const toFlag = new Map(); // voteId → reason

    // ── Heuristic 1: Burst targeting ──────────────────────────
    // Flag domains that received ≥BURST_MIN_VOTES of the same type
    // within a BURST_WINDOW_MS window from different users
    const reports = votes.filter(v => v.type === 'report');
    flagBurst(reports, toFlag, 'burst_report');
    const vouches = votes.filter(v => v.type === 'vouch');
    flagBurst(vouches, toFlag, 'burst_vouch');

    // ── Heuristic 2: Fresh account swarm ──────────────────────
    // Flag if ≥FRESH_SWARM_MIN voters on this domain were all created
    // within the last 7 days
    const uniqueUserIds = [...new Set(votes.map(v => v.userId))];
    const freshUserIds = new Set();
    for (const uid of uniqueUserIds) {
      try {
        const u = await users.get(uid);
        const age = Date.now() - new Date(u.$createdAt).getTime();
        if (age < FRESH_ACCOUNT_AGE_MS) freshUserIds.add(uid);
      } catch { /* user deleted — skip */ }
    }
    if (freshUserIds.size >= FRESH_SWARM_MIN) {
      for (const vote of votes) {
        if (freshUserIds.has(vote.userId)) {
          toFlag.set(vote.$id, (toFlag.get(vote.$id) || '') + 'fresh_swarm;');
        }
      }
    }

    // ── Heuristic 3: IP subnet clustering ─────────────────────
    // Flag if ≥SUBNET_CLUSTER_MIN votes come from the same /24 subnet
    const bySubnet = new Map();
    for (const vote of votes) {
      if (!vote.ip) continue;
      const subnet = toSubnet24(vote.ip);
      if (!subnet) continue;
      const arr = bySubnet.get(subnet) || [];
      arr.push(vote);
      bySubnet.set(subnet, arr);
    }
    for (const [subnet, subnetVotes] of bySubnet) {
      if (subnetVotes.length >= SUBNET_CLUSTER_MIN) {
        for (const vote of subnetVotes) {
          toFlag.set(vote.$id, (toFlag.get(vote.$id) || '') + `subnet_cluster:${subnet};`);
        }
      }
    }

    // Apply flags
    for (const [voteId, reason] of toFlag) {
      try {
        await databases.updateDocument(DATABASE_ID, VOTES_COLLECTION_ID, voteId, {
          flagged: true,
          flagReason: reason.slice(0, 200),
        });
        totalFlagged++;
        affectedDomains.add(domain);
      } catch (err) {
        log(`Failed to flag vote ${voteId}: ${err.message}`);
      }
    }
  }

  log(`Flagged ${totalFlagged} votes across ${affectedDomains.size} domains`);

  // Recount votes for affected domains and update statuses
  let statusChanges = 0;
  for (const domain of affectedDomains) {
    const changed = await recountDomain(databases, domain, log);
    if (changed) statusChanges++;
  }

  // Trigger blocklist rebuild if any statuses changed
  if (statusChanges > 0 && BUILD_BLOCKLISTS_ID) {
    try {
      const functions = new Functions(client);
      await functions.createExecution(BUILD_BLOCKLISTS_ID, '', false);
      log(`Triggered BuildBlocklists (${statusChanges} status changes)`);
    } catch (err) {
      log(`BuildBlocklists trigger failed: ${err.message}`);
    }
  }

  return res.json({
    ok: true,
    audited: recentVotes.length,
    flagged: totalFlagged,
    affectedDomains: affectedDomains.size,
    statusChanges,
  });
};

// ── Helpers ─────────────────────────────────────────────────────────

/**
 * Detect time-clustered bursts of same-type votes on the same domain.
 * Uses a sliding-window approach: sort votes by time, check if any
 * window of BURST_MIN_VOTES consecutive votes all fall within BURST_WINDOW_MS.
 */
function flagBurst(votes, toFlag, reason) {
  if (votes.length < BURST_MIN_VOTES) return;

  // Deduplicate by userId — only one vote per user counts toward burst
  const seen = new Set();
  const deduped = [];
  for (const v of votes) {
    if (!seen.has(v.userId)) {
      seen.add(v.userId);
      deduped.push(v);
    }
  }
  if (deduped.length < BURST_MIN_VOTES) return;

  const sorted = deduped.sort((a, b) =>
    new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
  );

  for (let i = 0; i <= sorted.length - BURST_MIN_VOTES; i++) {
    const windowStart = new Date(sorted[i].createdAt).getTime();
    const windowEnd = new Date(sorted[i + BURST_MIN_VOTES - 1].createdAt).getTime();
    if (windowEnd - windowStart <= BURST_WINDOW_MS) {
      for (let j = i; j < i + BURST_MIN_VOTES; j++) {
        toFlag.set(sorted[j].$id, (toFlag.get(sorted[j].$id) || '') + `${reason};`);
      }
    }
  }
}

/**
 * Extract /24 subnet from an IPv4 address. Returns null for IPv6 or invalid.
 */
function toSubnet24(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  return `${parts[0]}.${parts[1]}.${parts[2]}.0/24`;
}

/**
 * Recount unflagged votes for a domain and update the domain record.
 * Returns true if the status changed.
 */
async function recountDomain(databases, domain, log) {
  // Get all unflagged votes for this domain
  const votes = await fetchAllPages(databases, VOTES_COLLECTION_ID, [
    Query.equal('domain', domain),
    Query.equal('flagged', false),
  ]);

  const reportCount = votes.filter(v => v.type === 'report').length;
  const vouchVotes = votes.filter(v => v.type === 'vouch');
  const vouchCount = vouchVotes.length;

  // Check which vouchers are qualified (voted on 3+ different domains)
  let qualifiedVouchCount = 0;
  for (const v of vouchVotes) {
    const userVotes = await fetchAllPages(databases, VOTES_COLLECTION_ID, [
      Query.equal('userId', v.userId),
      Query.equal('flagged', false),
    ]);
    const uniqueDomains = new Set(userVotes.map(uv => uv.domain));
    if (uniqueDomains.size >= QUALIFIED_VOTER_MIN_DOMAINS) qualifiedVouchCount++;
  }

  // Look up the existing domain record
  const existing = await databases.listDocuments(
    DATABASE_ID, BLOCKLIST_COLLECTION_ID,
    [Query.equal('domain', domain), Query.limit(1)]
  );
  if (existing.documents.length === 0) return false;

  const doc = existing.documents[0];
  const oldStatus = doc.status;
  const net = reportCount - vouchCount;
  const status = resolveStatus(net, reportCount, vouchCount, qualifiedVouchCount, doc);
  const changed = status !== oldStatus;

  await databases.updateDocument(DATABASE_ID, BLOCKLIST_COLLECTION_ID, doc.$id, {
    reportCount,
    vouchCount,
    qualifiedVouchCount,
    status,
  });

  if (changed) {
    log(`Domain ${domain}: status ${oldStatus} → ${status} after recount`);
  }
  return changed;
}

/**
 * Status resolution — mirrors SubmitReport logic exactly.
 */
function resolveStatus(net, reportCount, vouchCount, qualifiedVouchCount, existingDoc) {
  if (existingDoc?.status === 'verified') {
    if (net >= BLOCK_THRESHOLD) return 'blocked';
    if (net > 0) return 'reported';
    return 'verified';
  }
  if (net >= BLOCK_THRESHOLD) return 'blocked';
  if (net > 0) return 'reported';
  if (qualifiedVouchCount >= VERIFIED_VOUCH_THRESHOLD && existingDoc?.trustedSince) {
    const trustedMs = Date.now() - new Date(existingDoc.trustedSince).getTime();
    const trustedDays = trustedMs / (1000 * 60 * 60 * 24);
    if (trustedDays >= VERIFIED_TRUSTED_DAYS) return 'verified';
  }
  if (vouchCount >= TRUSTED_MIN_VOUCHES && net <= 0) return 'trusted';
  if (vouchCount > 0) return 'pending';
  return 'reported';
}

/**
 * Paginate through all documents matching the given queries.
 * Uses cursor-based pagination to avoid the 5,000 offset limit.
 */
async function fetchAllPages(databases, collectionId, queries, batchSize = 100) {
  const all = [];
  let lastId = null;
  while (true) {
    const pageQueries = [...queries, Query.limit(batchSize)];
    if (lastId) pageQueries.push(Query.cursorAfter(lastId));
    const page = await databases.listDocuments(
      DATABASE_ID, collectionId, pageQueries
    );
    all.push(...page.documents);
    if (page.documents.length < batchSize) break;
    lastId = page.documents[page.documents.length - 1].$id;
  }
  return all;
}

export { flagBurst, toSubnet24, resolveStatus };
