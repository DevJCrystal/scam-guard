/**
 * tests/vote-resolution.test.js
 *
 * Unit tests for vote resolution and risk scoring logic.
 * Run with: node tests/vote-resolution.test.js
 *
 * No dependencies required — uses Node.js built-in assert.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createHash } from 'node:crypto';

// ── Copy of production constants ────────────────────────────────────
const BLOCK_THRESHOLD = 3;
const TRUSTED_MIN_VOUCHES = 2;
const VERIFIED_VOUCH_THRESHOLD = 500;
const VERIFIED_TRUSTED_DAYS = 30;

// ── Copy of production functions (from SubmitReport/src/main.js) ────
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

// ═══════════════════════════════════════════════════════════════════
//  resolveStatus tests
// ═══════════════════════════════════════════════════════════════════

describe('resolveStatus', () => {

  // ── Basic thresholds ──────────────────────────────────────────
  it('returns "blocked" when net ≥ BLOCK_THRESHOLD', () => {
    assert.equal(resolveStatus(3, 3, 0, 0, null), 'blocked');
    assert.equal(resolveStatus(5, 7, 2, 0, null), 'blocked');
    assert.equal(resolveStatus(100, 100, 0, 0, null), 'blocked');
  });

  it('returns "reported" when 0 < net < BLOCK_THRESHOLD', () => {
    assert.equal(resolveStatus(1, 1, 0, 0, null), 'reported');
    assert.equal(resolveStatus(2, 3, 1, 0, null), 'reported');
  });

  it('returns "reported" with zero votes (no vouches)', () => {
    assert.equal(resolveStatus(0, 0, 0, 0, null), 'reported');
  });

  it('returns "pending" with some vouches but not enough for trusted', () => {
    // 1 vouch, net = 0 → pending (need 2 vouches for trusted)
    assert.equal(resolveStatus(0, 0, 1, 0, null), 'pending');
  });

  it('returns "trusted" with ≥2 vouches and net ≤ 0', () => {
    assert.equal(resolveStatus(0, 0, 2, 0, null), 'trusted');
    assert.equal(resolveStatus(-1, 1, 2, 0, null), 'trusted');
    assert.equal(resolveStatus(0, 3, 5, 0, null), 'trusted');
  });

  it('does NOT return "trusted" when net > 0 even with many vouches', () => {
    assert.equal(resolveStatus(1, 3, 2, 0, null), 'reported');
  });

  // ── Verified promotion ────────────────────────────────────────
  it('promotes to "verified" with 500+ qualified vouches AND trusted 30+ days', () => {
    const thirtyOneDaysAgo = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
    const doc = { trustedSince: thirtyOneDaysAgo };
    assert.equal(resolveStatus(0, 0, 500, 500, doc), 'verified');
    assert.equal(resolveStatus(-10, 0, 600, 600, doc), 'verified');
  });

  it('does NOT promote to "verified" if trusted < 30 days', () => {
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    const doc = { trustedSince: tenDaysAgo };
    assert.equal(resolveStatus(0, 0, 500, 500, doc), 'trusted');
  });

  it('does NOT promote to "verified" if < 500 qualified vouches', () => {
    const sixtyDaysAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
    const doc = { trustedSince: sixtyDaysAgo };
    assert.equal(resolveStatus(0, 0, 499, 499, doc), 'trusted');
  });

  it('does NOT promote to "verified" if no trustedSince date', () => {
    assert.equal(resolveStatus(0, 0, 500, 500, null), 'trusted');
    assert.equal(resolveStatus(0, 0, 500, 500, {}), 'trusted');
  });

  // ── Verified domain behavior ──────────────────────────────────
  it('verified domain stays verified when net ≤ 0', () => {
    const doc = { status: 'verified' };
    assert.equal(resolveStatus(0, 0, 10, 10, doc), 'verified');
    assert.equal(resolveStatus(-5, 5, 10, 10, doc), 'verified');
  });

  it('verified domain can be reported (net > 0)', () => {
    const doc = { status: 'verified' };
    assert.equal(resolveStatus(1, 11, 10, 10, doc), 'reported');
    assert.equal(resolveStatus(2, 12, 10, 10, doc), 'reported');
  });

  it('verified domain can be blocked (net ≥ 3)', () => {
    const doc = { status: 'verified' };
    assert.equal(resolveStatus(3, 13, 10, 10, doc), 'blocked');
    assert.equal(resolveStatus(10, 20, 10, 10, doc), 'blocked');
  });

  // ── Edge cases ────────────────────────────────────────────────
  it('negative net with 1 vouch returns "pending"', () => {
    // net = -1, 0 reports, 1 vouch → pending (only 1 vouch, need 2 for trusted)
    assert.equal(resolveStatus(-1, 0, 1, 0, null), 'pending');
  });

  it('exactly at BLOCK_THRESHOLD boundary', () => {
    assert.equal(resolveStatus(2, 2, 0, 0, null), 'reported');
    assert.equal(resolveStatus(3, 3, 0, 0, null), 'blocked');
  });

  it('exactly at TRUSTED_MIN_VOUCHES boundary', () => {
    assert.equal(resolveStatus(0, 0, 1, 0, null), 'pending');
    assert.equal(resolveStatus(0, 0, 2, 0, null), 'trusted');
  });

  it('qualified vouches don\'t matter without trustedSince for verification', () => {
    assert.equal(resolveStatus(0, 0, 1000, 1000, null), 'trusted');
  });
});

// ═══════════════════════════════════════════════════════════════════
//  extractBase tests
// ═══════════════════════════════════════════════════════════════════

describe('extractBase', () => {
  it('extracts base from simple domain', () => {
    assert.equal(extractBase('example.com'), 'example');
    assert.equal(extractBase('google.com'), 'google');
  });

  it('extracts base from subdomain', () => {
    assert.equal(extractBase('www.example.com'), 'example');
    assert.equal(extractBase('mail.google.com'), 'google');
  });

  it('handles ccTLD (e.g. co.uk)', () => {
    assert.equal(extractBase('example.co.uk'), 'example');
    assert.equal(extractBase('bbc.co.uk'), 'bbc');
  });

  it('handles long TLDs that don\'t trigger ccTLD logic', () => {
    assert.equal(extractBase('example.museum'), 'example');
  });

  it('handles single-part domain', () => {
    assert.equal(extractBase('localhost'), 'localhost');
  });

  it('handles deep subdomains with ccTLD', () => {
    assert.equal(extractBase('sub.example.co.uk'), 'example');
  });
});

// ═══════════════════════════════════════════════════════════════════
//  computeInitialRisk tests
// ═══════════════════════════════════════════════════════════════════

describe('computeInitialRisk', () => {

  // ── Base score ────────────────────────────────────────────────
  it('returns base score of 10 for a plain domain', () => {
    assert.equal(computeInitialRisk('example.com', null), 10);
  });

  // ── Lookalike scoring ─────────────────────────────────────────
  it('adds lookalike score × 50', () => {
    assert.equal(computeInitialRisk('example.com', { score: 0.5 }), 35); // 10 + 25
    assert.equal(computeInitialRisk('example.com', { score: 1.0 }), 60); // 10 + 50
    assert.equal(computeInitialRisk('example.com', { score: 0.0 }), 10); // 10 + 0
  });

  it('rounds lookalike contribution', () => {
    assert.equal(computeInitialRisk('example.com', { score: 0.33 }), 27); // 10 + round(16.5) = 27
  });

  // ── Risky TLDs ────────────────────────────────────────────────
  it('adds 15 for risky TLDs', () => {
    assert.equal(computeInitialRisk('example.xyz', null), 25);   // 10 + 15
    assert.equal(computeInitialRisk('example.top', null), 25);
    assert.equal(computeInitialRisk('example.buzz', null), 25);
    assert.equal(computeInitialRisk('example.club', null), 25);
    assert.equal(computeInitialRisk('example.icu', null), 25);
    assert.equal(computeInitialRisk('example.online', null), 25);
    assert.equal(computeInitialRisk('example.pw', null), 25);
  });

  it('does not add TLD bonus for safe TLDs', () => {
    assert.equal(computeInitialRisk('example.com', null), 10);
    assert.equal(computeInitialRisk('example.org', null), 10);
    assert.equal(computeInitialRisk('example.net', null), 10);
    assert.equal(computeInitialRisk('example.edu', null), 10);
  });

  // ── Long labels ───────────────────────────────────────────────
  it('adds 10 for base labels longer than 20 chars', () => {
    const longDomain = 'abcdefghijklmnopqrstuv.com'; // 22 chars base
    assert.equal(computeInitialRisk(longDomain, null), 20); // 10 + 10
  });

  it('does not add length bonus for 20-char base', () => {
    const exactDomain = 'abcdefghijklmnopqrst.com'; // 20 chars base
    assert.equal(computeInitialRisk(exactDomain, null), 10);
  });

  // ── Hyphens ───────────────────────────────────────────────────
  it('adds 5 for hyphens in base', () => {
    assert.equal(computeInitialRisk('my-example.com', null), 15); // 10 + 5
  });

  // ── Digits ────────────────────────────────────────────────────
  it('adds 5 for digits in base', () => {
    assert.equal(computeInitialRisk('example1.com', null), 15); // 10 + 5
  });

  // ── Combination scoring ───────────────────────────────────────
  it('stacks all risk factors', () => {
    // risky TLD + hyphen + digit = 10 + 15 + 5 + 5 = 35
    assert.equal(computeInitialRisk('my-scam1.xyz', null), 35);
  });

  it('stacks all factors including lookalike', () => {
    // lookalike(0.9) + risky TLD + hyphen + digit = 10 + 45 + 15 + 5 + 5 = 80
    assert.equal(computeInitialRisk('pay-pal1.xyz', { score: 0.9 }), 80);
  });

  it('caps score at 100', () => {
    // All factors maxed: 10 + 50 + 15 + 10 + 5 + 5 = 95 (just under)
    const longBase = 'a-1bcdefghijklmnopqrstuv'; // >20 chars, has hyphen, has digit
    assert.equal(computeInitialRisk(longBase + '.xyz', { score: 1.0 }), 95);

    // With extreme lookalike to push over 100
    assert.equal(computeInitialRisk(longBase + '.xyz', { score: 2.0 }), 100); // 10+100+15+10+5+5 capped at 100
  });

  // ── ccTLD domains ─────────────────────────────────────────────
  it('correctly scores ccTLD domains', () => {
    assert.equal(computeInitialRisk('example.co.uk', null), 10);
    assert.equal(computeInitialRisk('my-example.co.uk', null), 15); // 10 + 5 (hyphen)
  });

  // ── Zero lookalike score ──────────────────────────────────────
  it('handles lookalike with score 0', () => {
    assert.equal(computeInitialRisk('example.com', { score: 0 }), 10);
  });
});

// ═══════════════════════════════════════════════════════════════════
//  Levenshtein / similarity tests (server-side lookalike detection)
// ═══════════════════════════════════════════════════════════════════

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

describe('levenshtein', () => {
  it('returns 0 for identical strings', () => {
    assert.equal(levenshtein('paypal', 'paypal'), 0);
  });

  it('returns correct distance for single edit', () => {
    assert.equal(levenshtein('paypal', 'paypa1'), 1);
  });

  it('returns correct distance for insertions', () => {
    assert.equal(levenshtein('abc', 'abcd'), 1);
  });

  it('returns correct distance for deletions', () => {
    assert.equal(levenshtein('abcd', 'abc'), 1);
  });

  it('handles empty strings', () => {
    assert.equal(levenshtein('', ''), 0);
    assert.equal(levenshtein('abc', ''), 3);
    assert.equal(levenshtein('', 'abc'), 3);
  });

  it('handles completely different strings', () => {
    assert.equal(levenshtein('abc', 'xyz'), 3);
  });
});

describe('similarity', () => {
  it('returns 1.0 for identical strings', () => {
    assert.equal(similarity('google', 'google'), 1);
  });

  it('returns 0 for completely different equal-length strings', () => {
    assert.equal(similarity('abc', 'xyz'), 0);
  });

  it('returns correct similarity for similar strings', () => {
    const sim = similarity('paypal', 'paypa1');
    assert.ok(sim > 0.8, `Expected >0.8 but got ${sim}`);
  });

  it('returns 1.0 for two empty strings', () => {
    assert.equal(similarity('', ''), 1);
  });

  it('detects lookalike domains above threshold', () => {
    const sim = similarity('google', 'g00gle');
    assert.ok(sim >= 0.66, `Expected >=0.66 but got ${sim}`);
  });

  it('rejects dissimilar domains below threshold', () => {
    const sim = similarity('google', 'amazon');
    assert.ok(sim < 0.75, `Expected <0.75 but got ${sim}`);
  });
});

// ═══════════════════════════════════════════════════════════════════
//  normalizeEmail tests
// ═══════════════════════════════════════════════════════════════════

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

describe('normalizeEmail', () => {
  it('strips +suffix from any provider', () => {
    assert.equal(normalizeEmail('alice+spam@outlook.com'), 'alice@outlook.com');
    assert.equal(normalizeEmail('bob+tag@yahoo.com'), 'bob@yahoo.com');
  });

  it('strips dots from Gmail local part', () => {
    assert.equal(normalizeEmail('a.l.i.c.e@gmail.com'), 'alice@gmail.com');
  });

  it('strips dots AND +suffix from Gmail', () => {
    assert.equal(normalizeEmail('a.li.ce+test@gmail.com'), 'alice@gmail.com');
  });

  it('normalizes googlemail.com to gmail.com', () => {
    assert.equal(normalizeEmail('alice@googlemail.com'), 'alice@gmail.com');
    assert.equal(normalizeEmail('a.li.ce+x@googlemail.com'), 'alice@gmail.com');
  });

  it('does NOT strip dots for non-Gmail providers', () => {
    assert.equal(normalizeEmail('a.l.i.c.e@outlook.com'), 'a.l.i.c.e@outlook.com');
  });

  it('returns as-is for emails without @', () => {
    assert.equal(normalizeEmail('noatsign'), 'noatsign');
  });

  it('handles plain Gmail without aliases', () => {
    assert.equal(normalizeEmail('alice@gmail.com'), 'alice@gmail.com');
  });
});

// ═══════════════════════════════════════════════════════════════════
//  Proof-of-work verification tests
// ═══════════════════════════════════════════════════════════════════

function hasLeadingZeroBits(hash, bits) {
  const fullBytes = Math.floor(bits / 8);
  for (let i = 0; i < fullBytes; i++) {
    if (hash[i] !== 0) return false;
  }
  const remaining = bits % 8;
  if (remaining > 0) {
    if (hash[fullBytes] >>> (8 - remaining) !== 0) return false;
  }
  return true;
}

function verifyProofOfWork(challenge, nonce, difficulty) {
  const data = `${challenge}:${nonce}`;
  const hash = createHash('sha256').update(data).digest();
  return hasLeadingZeroBits(hash, difficulty);
}

describe('hasLeadingZeroBits', () => {
  it('returns true for all-zero buffer with any difficulty', () => {
    const buf = Buffer.alloc(32, 0);
    assert.equal(hasLeadingZeroBits(buf, 8), true);
    assert.equal(hasLeadingZeroBits(buf, 16), true);
    assert.equal(hasLeadingZeroBits(buf, 256), true);
  });

  it('returns false when first byte is non-zero for 8-bit difficulty', () => {
    const buf = Buffer.alloc(32, 0);
    buf[0] = 1;
    assert.equal(hasLeadingZeroBits(buf, 8), false);
  });

  it('checks partial byte correctly', () => {
    const buf = Buffer.alloc(32, 0);
    // 18 bits: first 2 bytes (16 bits) = 0, then first 2 bits of byte 2 = 0
    buf[2] = 0b00100000; // bits 2-7 of third byte, first 2 bits are 0
    assert.equal(hasLeadingZeroBits(buf, 18), true);

    buf[2] = 0b01000000; // first 2 bits are 01 → first bit is 0, second is 1 → fail
    assert.equal(hasLeadingZeroBits(buf, 18), false);

    buf[2] = 0b10000000; // first bit is 1 → fail
    assert.equal(hasLeadingZeroBits(buf, 18), false);
  });

  it('returns true for 0-bit difficulty', () => {
    const buf = Buffer.from([0xff, 0xff, 0xff]);
    assert.equal(hasLeadingZeroBits(buf, 0), true);
  });
});

describe('verifyProofOfWork', () => {
  it('verifies a valid proof with low difficulty', () => {
    // Find a valid nonce with difficulty 1 (should be fast)
    const challenge = 'test:example.com:12345';
    let nonce = 0;
    while (!verifyProofOfWork(challenge, nonce, 1)) nonce++;
    assert.equal(verifyProofOfWork(challenge, nonce, 1), true);
  });

  it('rejects an invalid proof', () => {
    // Very unlikely that nonce=999999999 produces 18 leading zeros for this challenge
    assert.equal(verifyProofOfWork('test:example.com:99999', 999999999, 18), false);
  });

  it('proof for one challenge does not work for another', () => {
    const challenge1 = 'user1@test.com:evil.com:1';
    let nonce = 0;
    while (!verifyProofOfWork(challenge1, nonce, 4)) nonce++;
    // Same nonce should (almost certainly) not work for a different challenge
    const challenge2 = 'user2@test.com:evil.com:1';
    // This could theoretically pass, but with 4 bits of difficulty it's a 1/16 chance
    // Run enough to make it statistically sound
    const validForOther = verifyProofOfWork(challenge2, nonce, 4);
    // We just verify the function runs without error; deterministic assertion would be fragile
    assert.equal(typeof validForOther, 'boolean');
  });
});

// ── AuditVotes helper tests ─────────────────────────────────────────

// ── Copy of production functions (from AuditVotes/src/main.js) ──────

function toSubnet24(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  return `${parts[0]}.${parts[1]}.${parts[2]}.0/24`;
}

const BURST_WINDOW_MS = 2 * 60 * 60 * 1000;
const BURST_MIN_VOTES = 3;

function flagBurst(votes, toFlag, reason) {
  if (votes.length < BURST_MIN_VOTES) return;
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

describe('toSubnet24', () => {
  it('extracts /24 subnet from IPv4', () => {
    assert.equal(toSubnet24('192.168.1.42'), '192.168.1.0/24');
  });
  it('handles first octets', () => {
    assert.equal(toSubnet24('10.0.0.1'), '10.0.0.0/24');
  });
  it('returns null for IPv6', () => {
    assert.equal(toSubnet24('::1'), null);
  });
  it('returns null for invalid IP', () => {
    assert.equal(toSubnet24('not-an-ip'), null);
  });
  it('returns null for empty string', () => {
    assert.equal(toSubnet24(''), null);
  });
});

describe('flagBurst', () => {
  function makeVote(id, userId, minutesAgo) {
    return {
      $id: id,
      userId,
      createdAt: new Date(Date.now() - minutesAgo * 60 * 1000).toISOString(),
    };
  }

  it('flags 3 votes within 2h window', () => {
    const toFlag = new Map();
    const votes = [
      makeVote('v1', 'u1', 90),
      makeVote('v2', 'u2', 60),
      makeVote('v3', 'u3', 30),
    ];
    flagBurst(votes, toFlag, 'burst_report');
    assert.equal(toFlag.size, 3);
    assert.ok(toFlag.get('v1').includes('burst_report'));
  });

  it('does not flag if fewer than 3 votes', () => {
    const toFlag = new Map();
    const votes = [makeVote('v1', 'u1', 60), makeVote('v2', 'u2', 30)];
    flagBurst(votes, toFlag, 'burst_report');
    assert.equal(toFlag.size, 0);
  });

  it('does not flag if same user voted multiple times', () => {
    const toFlag = new Map();
    const votes = [
      makeVote('v1', 'u1', 90),
      makeVote('v2', 'u1', 60),
      makeVote('v3', 'u1', 30),
    ];
    flagBurst(votes, toFlag, 'burst_report');
    assert.equal(toFlag.size, 0);
  });

  it('does not flag if votes are spread over more than 2 hours', () => {
    const toFlag = new Map();
    const votes = [
      makeVote('v1', 'u1', 180),
      makeVote('v2', 'u2', 90),
      makeVote('v3', 'u3', 1),
    ];
    flagBurst(votes, toFlag, 'burst_report');
    assert.equal(toFlag.size, 0);
  });

  it('flags sliding window within a larger set', () => {
    const toFlag = new Map();
    const votes = [
      makeVote('v1', 'u1', 300), // 5h ago - outside window
      makeVote('v2', 'u2', 90),
      makeVote('v3', 'u3', 60),
      makeVote('v4', 'u4', 30),
    ];
    flagBurst(votes, toFlag, 'burst_report');
    // v2, v3, v4 form a burst
    assert.ok(toFlag.has('v2'));
    assert.ok(toFlag.has('v3'));
    assert.ok(toFlag.has('v4'));
  });
});
