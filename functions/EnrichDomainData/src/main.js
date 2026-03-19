import { Client, Databases, Query, ID } from 'node-appwrite';

// Triggered by event:
//   databases.69b3e54b0012e72d2461.collections.reports.documents.*.create
//
// When a new report is created, this function:
//   1. If the domain doesn't exist in the blocklist → creates it with status "reported"
//   2. If the domain already exists → increments reportCount
//   3. If reportCount crosses a threshold → escalates status to "blocked"
//   4. Performs lookalike detection against well-known domains
//
// Status lifecycle:  reported → blocked  (or → safe if manually cleared)
//
// Environment variables:
//   APPWRITE_DATABASE_ID       – the shared database
//   REPORTS_COLLECTION_ID      – the reports collection (source event)
//   BLOCKLIST_COLLECTION_ID    – the domains/blocklist collection (target)

const DATABASE_ID = process.env.APPWRITE_DATABASE_ID;
const BLOCKLIST_COLLECTION_ID = process.env.BLOCKLIST_COLLECTION_ID;

// Number of independent reports before auto-blocking
const BLOCK_THRESHOLD = 3;

export default async ({ req, res, log, error }) => {
  const doc = req.bodyJson ?? (typeof req.bodyText === 'string' ? JSON.parse(req.bodyText) : {});

  if (!doc?.$id || !doc?.domainId) {
    return res.json({ ok: false, message: 'No document payload' }, 400);
  }

  const domain = doc.domainId.toLowerCase().trim();

  const client = new Client()
    .setEndpoint(process.env.APPWRITE_FUNCTION_API_ENDPOINT)
    .setProject(process.env.APPWRITE_FUNCTION_PROJECT_ID)
    .setKey(req.headers['x-appwrite-key'] ?? '');

  const databases = new Databases(client);

  try {
    // Check if the domain already exists in the blocklist
    const existing = await databases.listDocuments(
      DATABASE_ID,
      BLOCKLIST_COLLECTION_ID,
      [Query.equal('domain', domain), Query.limit(1)]
    );

    // Lookalike analysis
    const lookalike = detectLookalike(domain);

    if (existing.documents.length > 0) {
      // Domain already tracked — increment report count & maybe escalate
      const domainDoc = existing.documents[0];
      const newCount = (domainDoc.reportCount || 1) + 1;

      const updates = { reportCount: newCount };

      // Auto-escalate after threshold, unless manually marked safe
      if (domainDoc.status === 'reported' && newCount >= BLOCK_THRESHOLD) {
        updates.status = 'blocked';
        log(`Domain ${domain} escalated to BLOCKED (${newCount} reports)`);
      }

      // Update lookalike info if we found a match and it wasn't set before
      if (lookalike && !domainDoc.lookalikeDomain) {
        updates.lookalikeDomain = lookalike.domain;
        updates.lookalikeScore = lookalike.score;
      }

      await databases.updateDocument(
        DATABASE_ID,
        BLOCKLIST_COLLECTION_ID,
        domainDoc.$id,
        updates
      );

      log(`Domain ${domain} report #${newCount} recorded (status: ${updates.status || domainDoc.status})`);
      return res.json({ ok: true, action: 'updated', reportCount: newCount, status: updates.status || domainDoc.status });
    }

    // New domain — create with initial risk assessment
    const riskScore = computeInitialRisk(domain, lookalike);

    const newDoc = await databases.createDocument(
      DATABASE_ID,
      BLOCKLIST_COLLECTION_ID,
      ID.unique(),
      {
        domain,
        status: 'reported',          // never auto-block on first report
        riskScore,
        reportCount: 1,
        firstReportedAt: new Date().toISOString(),
        ...(lookalike ? {
          lookalikeDomain: lookalike.domain,
          lookalikeScore: lookalike.score,
        } : {}),
      }
    );

    log(`Added ${domain} to blocklist as ${newDoc.$id} (status: reported, risk: ${riskScore}${lookalike ? `, lookalike: ${lookalike.domain}` : ''})`);
    return res.json({ ok: true, action: 'created', domainDocId: newDoc.$id, riskScore, lookalike });
  } catch (err) {
    error('Enrichment failed: ' + err.message);
    return res.json({ ok: false, message: err.message }, 500);
  }
};

// ── Lookalike detection ─────────────────────────────────────────────

// Well-known domains that scammers commonly impersonate.
// Extend this list over time or fetch from a maintained source.
const KNOWN_DOMAINS = [
  'google.com', 'facebook.com', 'amazon.com', 'apple.com', 'microsoft.com',
  'paypal.com', 'netflix.com', 'linkedin.com', 'twitter.com', 'instagram.com',
  'chase.com', 'bankofamerica.com', 'wellsfargo.com', 'usps.com', 'fedex.com',
  'ups.com', 'dhl.com', 'costco.com', 'walmart.com', 'target.com',
  'bestbuy.com', 'homedepot.com', 'lowes.com', 'ebay.com', 'etsy.com',
  'dropbox.com', 'github.com', 'zoom.us', 'slack.com', 'salesforce.com',
  'indeed.com', 'glassdoor.com', 'learningtree.com', 'coursera.org',
  'udemy.com', 'khanacademy.org',
];

/**
 * Detect if a domain looks like a known legitimate domain but uses a
 * different TLD, adds/removes characters, or uses common typosquatting tricks.
 *
 * Returns { domain, score } or null.
 */
function detectLookalike(reported) {
  const reportedBase = extractBase(reported);
  let bestMatch = null;
  let bestScore = 0;

  for (const known of KNOWN_DOMAINS) {
    const knownBase = extractBase(known);

    // Skip subdomains of the known domain (e.g. dash.cloudflare.com is not impersonating cloudflare.com)
    if (reported.endsWith('.' + known)) continue;

    // Exact base with different TLD (e.g. learningtree.global vs learningtree.com)
    if (reportedBase === knownBase && reported !== known) {
      return { domain: known, score: 1.0 };
    }

    // Levenshtein similarity on the base name
    const sim = similarity(reportedBase, knownBase);
    if (sim > bestScore && sim >= 0.75) {
      bestScore = sim;
      bestMatch = known;
    }
  }

  return bestMatch ? { domain: bestMatch, score: Math.round(bestScore * 100) / 100 } : null;
}

/** Extract the "base" name: strip TLD and any subdomain prefixes. */
function extractBase(domain) {
  const parts = domain.split('.');
  // For two-part domains like "google.com" → base is "google"
  // For three-part like "mail.google.com" → base is "google"
  // For two-part TLDs like "google.co.uk" → base is "google"
  if (parts.length >= 3 && parts[parts.length - 1].length <= 3 && parts[parts.length - 2].length <= 3) {
    // Likely a two-part TLD like co.uk, com.au
    return parts[parts.length - 3];
  }
  return parts.length >= 2 ? parts[parts.length - 2] : parts[0];
}

/** Levenshtein-based similarity (0–1). */
function similarity(a, b) {
  const dist = levenshtein(a, b);
  const maxLen = Math.max(a.length, b.length);
  return maxLen === 0 ? 1 : 1 - dist / maxLen;
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

/**
 * Compute an initial risk score (0–100) based on domain characteristics.
 * Higher = more suspicious.
 */
function computeInitialRisk(domain, lookalike) {
  let score = 10; // baseline for any reported domain

  // Lookalike match adds significant risk
  if (lookalike) {
    score += Math.round(lookalike.score * 50);
  }

  // Unusual TLDs are riskier
  const riskyTLDs = ['.xyz', '.top', '.buzz', '.club', '.icu', '.global', '.info', '.click', '.link', '.online', '.site', '.fun', '.space', '.pw'];
  if (riskyTLDs.some(tld => domain.endsWith(tld))) {
    score += 15;
  }

  // Very long domain names are suspicious
  const base = extractBase(domain);
  if (base.length > 20) score += 10;

  // Hyphens in base name
  if (base.includes('-')) score += 5;

  // Digits in base name (unless it's a known pattern)
  if (/\d/.test(base)) score += 5;

  return Math.min(score, 100);
}
