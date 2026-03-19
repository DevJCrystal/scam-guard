# URL Monitor – Phishing & Scam Shield

A Chrome extension that protects users from zero-day phishing and scam websites using a community-maintained blocklist backed by [Appwrite Cloud](https://appwrite.io/).

Users can **report** suspicious domains and **vouch** for safe ones. The extension checks every page you visit against the community list and shows a warning banner on known-bad sites.

## Features

- **Real-time protection** — warning banners on blocked and suspicious sites
- **Community voting** — report or vouch for any domain
- **Lookalike detection** — flags domains that impersonate trusted brands (e.g. `paypa1.com` ↔ `paypal.com`)
- **Risk scoring** — heuristic score based on TLD, domain structure, and lookalike similarity
- **Verified status** — domains earn "verified" after 500+ qualified vouches and 30 days of trust
- **Trusted baseline** — daily import of [Tranco top-1000](https://tranco-list.eu/) for lookalike comparison
- **Auth-optional UI** — domain status is always visible; sign-in only required to vote
- **Dark mode** — follows system preference

## Architecture

```
┌──────────────────────────────────────────────────────┐
│  Chrome Extension (Manifest V3)                      │
│                                                      │
│  popup.html / popup.js   ← domain info + voting UI   │
│  background.js           ← syncs lists, badge colors │
│  content.js              ← warning banner injection  │
│  db.js                   ← shared IndexedDB helper   │
│  config.js               ← Appwrite IDs & settings   │
└───────────────┬──────────────────────────────────────┘
                │  REST API
┌───────────────▼──────────────────────────────────────┐
│  Appwrite Cloud                                      │
│                                                      │
│  Functions:                                          │
│    SubmitReport       ← handles report/vouch votes   │
│    FetchBlocklist     ← single-domain & bulk lookup  │
│    BuildBlocklists    ← compiles JSON (cron 4h)      │
│    PromoteDomains     ← trusted→verified (cron 24h)  │
│    SyncTrustedDomains ← Tranco import (cron 24h)     │
│                                                      │
│  Database:                                           │
│    domains      ← status, risk, vote counts          │
│    votes        ← per-user vote records              │
│    trusted_domains ← curated trusted list            │
│                                                      │
│  Storage:                                            │
│    url_monitor_lists ← compiled JSON files           │
└──────────────────────────────────────────────────────┘
```

## Domain Status Lifecycle

```
  First report          3+ net reports
    ┌───┐                  ┌───┐
    │   ▼                  │   ▼
 Unknown ──► Reported ─────► Blocked
                │                │
                │ vouch          │ vouch majority
                ▼                ▼
             Trusted ──────► Verified
               ▲       500+ qualified vouches
               │       + 30 days trusted
               │
          vouch with net <= 0
```

## Quick Start (Use the Existing Instance)

1. Clone this repo
2. Open `chrome://extensions` → enable **Developer mode**
3. Click **Load unpacked** → select this folder
4. The extension icon appears in your toolbar — click it to see the status of any site

The default `config.js` points to the public Appwrite instance. You can start using it immediately.

## Self-Hosting (Run Your Own Backend)

### Prerequisites

- [Appwrite Cloud](https://cloud.appwrite.io/) account (or self-hosted Appwrite 1.5+)
- [Appwrite CLI](https://appwrite.io/docs/tooling/command-line/installation) (`npm install -g appwrite-cli`)
- Node.js 18+

### 1. Create Appwrite Resources

1. Create a new project
2. Create a database with three collections:

   **`domains`** collection — attributes:
   | Attribute | Type | Required |
   |-----------|------|----------|
   | `domain` | string (255) | yes |
   | `status` | string (20) | yes |
   | `riskScore` | integer | no |
   | `reportCount` | integer | no |
   | `vouchCount` | integer | no |
   | `qualifiedVouchCount` | integer | no |
   | `firstReportedAt` | string (30) | no |
   | `lookalikeDomain` | string (255) | no |
   | `lookalikeScore` | float | no |
   | `trustedSince` | string (30) | no |
   | `verifiedAt` | string (30) | no |
   | `scamType` | string (50) | no |
   | `evidence` | string (1000) | no |

   **`votes`** collection — attributes:
   | Attribute | Type | Required |
   |-----------|------|----------|
   | `domain` | string (255) | yes |
   | `userId` | string (36) | yes |
   | `type` | string (20) | yes |
   | `reason` | string (500) | no |
   | `createdAt` | string (30) | yes |

   **`trusted_domains`** collection — attributes:
   | Attribute | Type | Required |
   |-----------|------|----------|
   | `domain` | string (255) | yes |
   | `rank` | integer | no |
   | `firstSeen` | string (30) | no |

3. Create a Storage bucket named `url_monitor_lists` with public read access
4. Enable Email/Password authentication

### 2. Deploy Functions

Each function is in `functions/<name>/`. See the `.env.example` in each directory for required environment variables.

```bash
# Login to Appwrite CLI
npx appwrite login

# Deploy all functions
npx appwrite functions create-deployment \
  --function-id YOUR_SUBMIT_REPORT_ID \
  --entrypoint src/main.js \
  --commands "npm install" \
  --code functions/SubmitReport \
  --activate true

# Repeat for FetchBlocklist, BuildBlocklists, PromoteDomains, SyncTrustedDomains
```

Set environment variables for each function in the Appwrite console (see `.env.example` files).

### 3. Configure the Extension

Edit `config.js` with your own Appwrite project ID, endpoint, and function IDs:

```javascript
const UM_CONFIG = Object.freeze({
  APPWRITE_ENDPOINT: "https://your-appwrite-instance/v1",
  APPWRITE_PROJECT_ID: "your_project_id",
  SUBMIT_REPORT_FUNCTION_ID: "your_function_id",
  FETCH_BLOCKLIST_FUNCTION_ID: "your_function_id",
  LISTS_BUCKET_ID: "your_bucket_id",
  // ...
});
```

### 4. Load the Extension

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked** → select this folder

## Project Structure

```
├── manifest.json          # Chrome extension manifest (MV3)
├── config.js              # Appwrite IDs and settings (edit this)
├── popup.html / popup.js  # Extension popup UI
├── background.js          # Service worker (sync, badge)
├── content.js             # Content script (warning banner)
├── db.js                  # Shared IndexedDB helper
├── icons/                 # Extension icons
├── appwrite.config.json   # Appwrite CLI deployment config
├── functions/
│   ├── SubmitReport/      # Vote handler
│   ├── FetchBlocklist/    # Domain lookup + bulk fetch
│   ├── BuildBlocklists/   # Compile JSON from DB (cron)
│   ├── PromoteDomains/    # Trusted → Verified sweep (cron)
│   └── SyncTrustedDomains/# Tranco top-1000 import (cron)
└── .editorconfig          # Code style settings
```

## How Voting Works

- **Report** — flags a domain as suspicious. Optionally include a reason.
- **Vouch** — marks a domain as safe. Changes your previous vote if you reported it.
- **Re-evaluate** — request review of a verified domain (counts as a report vote).

A domain is **blocked** when net reports (reports − vouches) reach 3 or more. It becomes **trusted** when at least 2 users vouch and net reports are 0 or below. After 500+ qualified vouches and 30+ days as trusted, it is promoted to **verified**.

A “qualified voter” is someone who has voted on 3+ different domains — this prevents manipulation through single-use accounts.

## Privacy

URL Monitor checks every page you visit against a **locally cached** blocklist. No browsing data is sent to any server during normal operation.

- **Domain lookups** — the extension downloads compiled JSON lists from Appwrite Storage on a schedule (every 15 minutes). Lookups happen locally in IndexedDB. A server request is only made if the domain is not found in the local cache.
- **Voting** — when you report or vouch for a domain, the domain name and your authenticated user ID are sent to the Appwrite backend. No other browsing information is included.
- **No tracking** — the extension does not collect, store, or transmit browsing history, page content, cookies, or any personal data beyond the vote itself.
- **Localhost / internal IPs** — the extension skips `localhost`, `127.*`, `10.*`, `192.168.*`, and other private addresses entirely.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

[GNU GPL v3](LICENSE)
