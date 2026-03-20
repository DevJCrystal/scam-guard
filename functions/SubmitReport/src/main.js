import { Client, Databases, Functions, Users, ID, Query } from 'node-appwrite';
import { createHash } from 'crypto';
import { DISPOSABLE_DOMAINS, ALLOWED_PROVIDERS } from './email-domains.js';

// Environment variables (set in Appwrite console):
//   APPWRITE_DATABASE_ID              – the database containing reports
//   BLOCKLIST_COLLECTION_ID           – the domains/blocklist collection
//   VOTES_COLLECTION_ID               – votes collection { domain, userId, type, reason, ip, createdAt }
//   BUILD_BLOCKLISTS_ID               – function ID for BuildBlocklists (triggers list rebuild)
//   TRUSTED_DOMAINS_COLLECTION_ID     – curated Tranco trusted domains collection

const DATABASE_ID = process.env.APPWRITE_DATABASE_ID;
const BLOCKLIST_COLLECTION_ID = process.env.BLOCKLIST_COLLECTION_ID;
const VOTES_COLLECTION_ID = process.env.VOTES_COLLECTION_ID;
const BUILD_BLOCKLISTS_ID = process.env.BUILD_BLOCKLISTS_ID;
const TRUSTED_DOMAINS_COLLECTION_ID = process.env.TRUSTED_DOMAINS_COLLECTION_ID;

// Tunable thresholds — override via env vars so production values stay secret
const BLOCK_THRESHOLD = +(process.env.BLOCK_THRESHOLD || 3);
const TRUSTED_MIN_VOUCHES = +(process.env.TRUSTED_MIN_VOUCHES || 2);
const VERIFIED_VOUCH_THRESHOLD = +(process.env.VERIFIED_VOUCH_THRESHOLD || 500);
const VERIFIED_TRUSTED_DAYS = +(process.env.VERIFIED_TRUSTED_DAYS || 30);
const QUALIFIED_VOTER_MIN_DOMAINS = +(process.env.QUALIFIED_VOTER_MIN_DOMAINS || 3);
const MAX_ACCOUNTS_PER_UNKNOWN_DOMAIN = +(process.env.MAX_ACCOUNTS_PER_UNKNOWN_DOMAIN || 5);
const LOOKALIKE_SIMILARITY_MIN = +(process.env.LOOKALIKE_SIMILARITY_MIN || 0.75);
const ACCOUNT_MIN_AGE_MS = +(process.env.ACCOUNT_MIN_AGE_MS || 24 * 60 * 60 * 1000);
const ALLOWED_ACTIONS = new Set(['report', 'vouch', 're-evaluate']);

export default async ({ req, res, log, error }) => {
  if (req.method !== 'POST') {
    return res.json({ ok: false, message: 'Method not allowed' }, 405);
  }

  const userId = req.headers['x-appwrite-user-id'];
  if (!userId) {
    return res.json({ ok: false, message: 'Authentication required' }, 401);
  }

  const body = req.bodyJson ?? (typeof req.bodyText === 'string' ? JSON.parse(req.bodyText) : {});
  const { domain, action, reason: rawReason } = body;
  const reason = typeof rawReason === 'string' ? rawReason.slice(0, 1000) : '';

  if (!domain || typeof domain !== 'string') {
    return res.json({ ok: false, message: '"domain" is required' }, 400);
  }

  if (!action || typeof action !== 'string' || !ALLOWED_ACTIONS.has(action)) {
    return res.json({ ok: false, message: 'Invalid vote action' }, 400);
  }

  // Basic domain validation
  const domainPattern = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;
  if (domain.length > 253 || !domainPattern.test(domain.trim())) {
    return res.json({ ok: false, message: 'Invalid domain format' }, 400);
  }

  // "re-evaluate" triggers a review of a verified domain
  const voteType = action === 'vouch' ? 'vouch'
    : action === 're-evaluate' ? 're-evaluate'
    : 'report';
  const cleanDomain = domain.toLowerCase().trim();

  const client = new Client()
    .setEndpoint(process.env.APPWRITE_FUNCTION_API_ENDPOINT)
    .setProject(process.env.APPWRITE_FUNCTION_PROJECT_ID)
    .setKey(req.headers['x-appwrite-key'] ?? '');

  const databases = new Databases(client);
  const users = new Users(client);

  // Require verified email before allowing votes
  let userEmail;
  try {
    const user = await users.get(userId);
    if (!user.emailVerification) {
      return res.json({ ok: false, message: 'Please verify your email before voting.', emailUnverified: true }, 403);
    }
    userEmail = (user.email || '').toLowerCase();

    // Account age gate — prevent freshly created accounts from voting
    const accountAge = Date.now() - new Date(user.$createdAt).getTime();
    if (accountAge < ACCOUNT_MIN_AGE_MS) {
      const hoursLeft = Math.ceil((ACCOUNT_MIN_AGE_MS - accountAge) / (60 * 60 * 1000));
      return res.json({ ok: false, message: `New accounts must wait 24 hours before voting. Please try again in ~${hoursLeft} hour(s).` }, 403);
    }
  } catch (err) {
    log(`Could not check email verification for ${userId}: ${err.message}`);
    return res.json({ ok: false, message: 'Could not verify account status' }, 500);
  }

  // Three-tier email domain check
  const emailDomain = userEmail.split('@')[1] || '';
  if (!emailDomain) {
    return res.json({ ok: false, message: 'Invalid account email' }, 403);
  }

  // Normalize email to prevent alias-based sybil attacks
  const normalizedEmail = normalizeEmail(userEmail);
  const emailHash = createHash('sha256').update(normalizedEmail).digest('hex').slice(0, 16);

  // Tier 1: Block known disposable email domains
  if (DISPOSABLE_DOMAINS.has(emailDomain)) {
    log(`Blocked vote from disposable email domain: ${emailDomain} (user ${userId})`);
    return res.json({ ok: false, message: 'Disposable email addresses are not allowed. Please use a permanent email provider.' }, 403);
  }

  // Tier 2: Allow known-good providers without further checks
  // Tier 3: Unknown domains — cap accounts per email domain
  if (!ALLOWED_PROVIDERS.has(emailDomain)) {
    try {
      const domainUsers = await users.list(
        [Query.search('email', emailDomain)],
      );
      if (domainUsers.total > MAX_ACCOUNTS_PER_UNKNOWN_DOMAIN) {
        log(`Blocked vote: email domain ${emailDomain} has ${domainUsers.total} accounts (cap: ${MAX_ACCOUNTS_PER_UNKNOWN_DOMAIN})`);
        return res.json({ ok: false, message: 'Too many accounts registered with this email domain. Please use a well-known email provider.' }, 403);
      }
    } catch (err) {
      log(`Could not check email domain count for ${emailDomain}: ${err.message}`);
      // Allow on error — don't block legitimate users due to API hiccups
    }
  }

  // Extract client IP for vote audit trail (no visible rate limiting)
  const clientIp = req.headers['x-appwrite-client-ip'] || '';

  try {
    // Re-evaluate stores as a report vote in the DB
    const storeType = voteType === 're-evaluate' ? 'report' : voteType;

    // 1. Check if this user already voted on this domain
    const existingVotes = await databases.listDocuments(
      DATABASE_ID,
      VOTES_COLLECTION_ID,
      [
        Query.equal('domain', cleanDomain),
        Query.equal('userId', userId),
        Query.limit(1),
      ]
    );

    let voteAction;
    let previousType = null;

    if (existingVotes.documents.length > 0) {
      const existing = existingVotes.documents[0];
      if (existing.type === storeType) {
        return res.json({
          ok: false,
          message: `You already ${storeType === 'report' ? 'reported' : 'vouched for'} this site.`,
          duplicate: true,
        });
      }
      // Changing vote (report → vouch or vouch → report)
      previousType = existing.type;
      await databases.updateDocument(DATABASE_ID, VOTES_COLLECTION_ID, existing.$id, {
        type: storeType,
        reason,
        ip: clientIp || null,
        emailHash,
        createdAt: new Date().toISOString(),
      });
      voteAction = 'changed';
      log(`User ${userId} changed vote on ${cleanDomain}: ${previousType} → ${storeType}`);
    } else {
      // Check for votes from another account with the same normalized email
      const emailDupCheck = await databases.listDocuments(
        DATABASE_ID, VOTES_COLLECTION_ID,
        [Query.equal('domain', cleanDomain), Query.equal('emailHash', emailHash), Query.limit(1)]
      );
      if (emailDupCheck.documents.length > 0) {
        log(`Blocked alias vote: ${userEmail} (hash ${emailHash}) already voted on ${cleanDomain} via user ${emailDupCheck.documents[0].userId}`);
        return res.json({ ok: false, message: 'A vote from this email address already exists for this domain.', duplicate: true }, 403);
      }

      // New vote — use try-catch to handle race condition (concurrent duplicate)
      try {
        await databases.createDocument(DATABASE_ID, VOTES_COLLECTION_ID, ID.unique(), {
          domain: cleanDomain,
          userId,
          type: storeType,
          reason,
          ip: clientIp || null,
          emailHash,
          createdAt: new Date().toISOString(),
        });
        voteAction = 'created';
        log(`User ${userId} cast ${voteType} vote on ${cleanDomain}`);
      } catch (createErr) {
        // Re-check for duplicate in case of race
        const raceCheck = await databases.listDocuments(
          DATABASE_ID,
          VOTES_COLLECTION_ID,
          [
            Query.equal('domain', cleanDomain),
            Query.equal('userId', userId),
            Query.limit(1),
          ]
        );
        if (raceCheck.documents.length > 0) {
          return res.json({
            ok: false,
            message: `You already ${storeType === 'report' ? 'reported' : 'vouched for'} this site.`,
            duplicate: true,
          });
        }
        throw createErr; // Re-throw if it wasn't a duplicate race
      }
    }

    // 1b + 2. Run independent checks in parallel to cut response latency
    const [isQualified, lookalike] = await Promise.all([
      isQualifiedVoter(databases, userId),
      detectLookalike(databases, cleanDomain),
    ]);

    // 3. Update the domain record with new vote counts
    const domainResult = await updateDomainVotes(
      databases, cleanDomain, storeType, previousType, isQualified,
      lookalike, log
    );

    // 4. If status changed, trigger a list rebuild so other users get the update
    if (domainResult.statusChanged && BUILD_BLOCKLISTS_ID) {
      try {
        const functions = new Functions(client);
        await functions.createExecution(BUILD_BLOCKLISTS_ID, '', true);
        log(`Triggered BuildBlocklists rebuild (status → ${domainResult.status})`);
      } catch (rebuildErr) {
        log(`BuildBlocklists trigger failed (non-fatal): ${rebuildErr.message}`);
      }
    }

    return res.json({ ok: true, voteAction, voteType, ...domainResult });
  } catch (err) {
    error('Vote failed: ' + err.message);
    return res.json({ ok: false, message: 'Could not submit vote' }, 500);
  }
};

// ── Check if a voter is "qualified" (voted on 3+ different domains) ─

async function isQualifiedVoter(databases, userId) {
  const result = await databases.listDocuments(
    DATABASE_ID,
    VOTES_COLLECTION_ID,
    [
      Query.equal('userId', userId),
      Query.limit(QUALIFIED_VOTER_MIN_DOMAINS + 1),
    ]
  );
  // Count distinct domains
  const uniqueDomains = new Set(result.documents.map(d => d.domain));
  return uniqueDomains.size >= QUALIFIED_VOTER_MIN_DOMAINS;
}

// ── Update domain record based on vote ──────────────────────────────

async function updateDomainVotes(databases, domain, voteType, previousType, isQualified, lookalike, log) {
  const existing = await databases.listDocuments(
    DATABASE_ID,
    BLOCKLIST_COLLECTION_ID,
    [Query.equal('domain', domain), Query.limit(1)]
  );

  if (existing.documents.length > 0) {
    const doc = existing.documents[0];
    const oldStatus = doc.status;
    let reportCount = doc.reportCount || 0;
    let vouchCount = doc.vouchCount || 0;
    let qualifiedVouchCount = doc.qualifiedVouchCount || 0;

    // Adjust counts for vote change
    if (previousType) {
      if (previousType === 'report') reportCount = Math.max(0, reportCount - 1);
      else {
        vouchCount = Math.max(0, vouchCount - 1);
        if (isQualified) qualifiedVouchCount = Math.max(0, qualifiedVouchCount - 1);
      }
    }
    if (voteType === 'report') reportCount++;
    else {
      vouchCount++;
      if (isQualified) qualifiedVouchCount++;
    }

    const net = reportCount - vouchCount;
    const status = resolveStatus(net, reportCount, vouchCount, qualifiedVouchCount, doc);
    const statusChanged = status !== oldStatus;

    const updates = { reportCount, vouchCount, qualifiedVouchCount, status };

    // Recalculate risk score when a report comes in and current score is 0
    if (voteType === 'report' && (!doc.riskScore || doc.riskScore === 0)) {
      updates.riskScore = computeInitialRisk(domain, lookalike || (doc.lookalikeDomain ? { domain: doc.lookalikeDomain, score: doc.lookalikeScore || 0 } : null));
    }

    // Track when a domain first becomes trusted
    if (status === 'trusted' && !doc.trustedSince) {
      updates.trustedSince = new Date().toISOString();
    }
    // Clear trustedSince if it falls out of trusted
    if (status !== 'trusted' && status !== 'verified' && doc.trustedSince) {
      updates.trustedSince = null;
    }
    // Record verifiedAt when promoting to verified
    if (status === 'verified' && oldStatus !== 'verified') {
      updates.verifiedAt = new Date().toISOString();
    }

    if (lookalike && !doc.lookalikeDomain) {
      updates.lookalikeDomain = lookalike.domain;
      updates.lookalikeScore = lookalike.score;
    }

    await databases.updateDocument(DATABASE_ID, BLOCKLIST_COLLECTION_ID, doc.$id, updates);
    log(`Domain ${domain}: ${reportCount} reports, ${vouchCount} vouches (${qualifiedVouchCount} qualified) → ${status}`);
    return { reportCount, vouchCount, qualifiedVouchCount, status, net, statusChanged };
  }

  // New domain entry
  const reportCount = voteType === 'report' ? 1 : 0;
  const vouchCount = voteType === 'vouch' ? 1 : 0;
  const qualifiedVouchCount = (voteType === 'vouch' && isQualified) ? 1 : 0;
  const net = reportCount - vouchCount;
  const status = resolveStatus(net, reportCount, vouchCount, qualifiedVouchCount, null);
  const riskScore = voteType === 'report' ? computeInitialRisk(domain, lookalike) : 0;

  await databases.createDocument(DATABASE_ID, BLOCKLIST_COLLECTION_ID, ID.unique(), {
    domain,
    status,
    riskScore,
    reportCount,
    vouchCount,
    qualifiedVouchCount,
    firstReportedAt: new Date().toISOString(),
    ...(status === 'trusted' ? { trustedSince: new Date().toISOString() } : {}),
    ...(lookalike ? { lookalikeDomain: lookalike.domain, lookalikeScore: lookalike.score } : {}),
  });

  log(`Created ${domain}: ${status} (risk: ${riskScore})`);
  return { reportCount, vouchCount, qualifiedVouchCount, status, riskScore, net, statusChanged: true };
}

// ── Status resolution ───────────────────────────────────────────────
// Determines a domain's status from its vote counts.
//
//   blocked   – net reports (reports − vouches) >= BLOCK_THRESHOLD
//   reported  – net reports > 0 but below block threshold
//   verified  – promoted from trusted after 500+ qualified vouches
//               AND 30+ days as trusted (see PromoteDomains cron).
//               Stays verified unless net reports hit the block threshold.
//   trusted   – has at least one vouch and net reports <= 0
//
// "Qualified" voters are users who have voted on 3+ different domains,
// preventing sybil attacks with throwaway single-use accounts.

function resolveStatus(net, reportCount, vouchCount, qualifiedVouchCount, existingDoc) {
  // Already verified — stays verified unless net reports overwhelm
  if (existingDoc?.status === 'verified') {
    if (net >= BLOCK_THRESHOLD) return 'blocked';
    if (net > 0) return 'reported';
    return 'verified';
  }

  if (net >= BLOCK_THRESHOLD) return 'blocked';
  if (net > 0) return 'reported';

  // Check verified promotion: 500+ qualified vouches AND trusted for 30+ days
  if (qualifiedVouchCount >= VERIFIED_VOUCH_THRESHOLD && existingDoc?.trustedSince) {
    const trustedMs = Date.now() - new Date(existingDoc.trustedSince).getTime();
    const trustedDays = trustedMs / (1000 * 60 * 60 * 24);
    if (trustedDays >= VERIFIED_TRUSTED_DAYS) return 'verified';
  }

  if (vouchCount >= TRUSTED_MIN_VOUCHES && net <= 0) return 'trusted';
  if (vouchCount > 0) return 'pending';
  return 'reported';
}

// ── Server-side lookalike detection ─────────────────────────────
// Recomputes similarity score server-side — never trusts client values.

async function detectLookalike(databases, reported) {
  try {
    // Collect trusted domain names from both sources
    const trustedDomains = [];

    // 1. Community-voted trusted/verified domains from the blocklist collection
    const community = await databases.listDocuments(
      DATABASE_ID,
      BLOCKLIST_COLLECTION_ID,
      [
        Query.equal('status', ['trusted', 'verified']),
        Query.limit(5000),
        Query.select(['domain']),
      ]
    );
    for (const doc of community.documents) trustedDomains.push(doc.domain);

    // 2. Curated Tranco domains from the trusted_domains collection
    if (TRUSTED_DOMAINS_COLLECTION_ID) {
      let offset = 0;
      const batchSize = 500;
      while (true) {
        const batch = await databases.listDocuments(
          DATABASE_ID,
          TRUSTED_DOMAINS_COLLECTION_ID,
          [
            Query.limit(batchSize),
            Query.offset(offset),
            Query.select(['domain']),
          ]
        );
        for (const doc of batch.documents) trustedDomains.push(doc.domain);
        if (batch.documents.length < batchSize) break;
        offset += batchSize;
      }
    }

    if (!trustedDomains.length) return null;

    const reportedBase = extractBase(reported);
    let bestMatch = null;
    let bestScore = 0;

    for (const trustedDomain of trustedDomains) {
      if (reported === trustedDomain) continue;
      // Subdomains of a trusted domain are legitimate, not lookalikes
      if (reported.endsWith('.' + trustedDomain)) continue;
      const trustedBase = extractBase(trustedDomain);
      if (reportedBase === trustedBase) {
        return { domain: trustedDomain, score: 1.0 };
      }
      const sim = similarity(reportedBase, trustedBase);
      if (sim > bestScore && sim >= LOOKALIKE_SIMILARITY_MIN) {
        bestScore = sim;
        bestMatch = trustedDomain;
      }
    }

    return bestMatch ? { domain: bestMatch, score: Math.round(bestScore * 100) / 100 } : null;
  } catch {
    return null; // Don't block the vote if lookalike detection fails
  }
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

function similarity(a, b) {
  const maxLen = Math.max(a.length, b.length);
  return maxLen === 0 ? 1 : 1 - levenshtein(a, b) / maxLen;
}

// ── Risk scoring ────────────────────────────────────────────────────
// Heuristic score (0-100) assigned when a domain is first reported.
// Higher = more likely to be malicious. Factors:
//   +10  base (every reported domain starts here)
//   +50  if it looks like a known trusted domain (lookalike score × 50)
//   +15  if TLD is commonly abused (.xyz, .top, .buzz, etc.)
//   +10  if base label is unusually long (>20 chars)
//   +5   if base label contains hyphens
//   +5   if base label contains digits

function extractBase(domain) {
  const parts = domain.split('.');
  if (parts.length >= 3 && parts[parts.length - 1].length <= 3 && parts[parts.length - 2].length <= 3) {
    return parts[parts.length - 3];
  }
  return parts.length >= 2 ? parts[parts.length - 2] : parts[0];
}

function computeInitialRisk(domain, lookalike) {
  let score = 10;
  if (lookalike) score += Math.round(lookalike.score * 50);
  const riskyTLDs = ['.xyz', '.top', '.buzz', '.club', '.icu', '.global', '.info', '.click', '.link', '.online', '.site', '.fun', '.space', '.pw'];
  if (riskyTLDs.some(tld => domain.endsWith(tld))) score += 15;
  const base = extractBase(domain);
  if (base.length > 20) score += 10;
  if (base.includes('-')) score += 5;
  if (/\d/.test(base)) score += 5;
  return Math.min(score, 100);
}

// ── Email normalization ─────────────────────────────────────────────
// Strips +suffix (all providers) and dots (Gmail) so alias accounts
// are recognized as the same real person.

function normalizeEmail(email) {
  let [local, domain] = email.split('@');
  if (!local || !domain) return email;
  local = local.split('+')[0];
  if (domain === 'gmail.com' || domain === 'googlemail.com') {
    local = local.replace(/\./g, '');
    domain = 'gmail.com';
  }
  return `${local}@${domain}`;
}
