# IC Proposal Verifier

[![IC Proposal Verifier](https://img.shields.io/badge/ICP-Proposal%20Verifier-blue?style=flat-square)](https://g5ige-nyaaa-aaaap-an4rq-cai.icp0.io/)
[![GitHub license](https://img.shields.io/github/license/dfinity/ic?style=flat-square)](https://github.com/dickhery/proposal_verifier/blob/main/LICENSE)


## Table of Contents

- [Introduction](#introduction)
- [Project Overview](#project-overview)
- [How the App Works](#how-the-app-works)
  - [Data Gathering Process](#data-gathering-process)
  - [Verification Workflow](#verification-workflow)
- [Features](#features)
- [Installation and Setup](#installation-and-setup)
  - [Prerequisites](#prerequisites)
  - [Cloning the Repository](#cloning-the-repository)
  - [Installing Dependencies](#installing-dependencies)
  - [Environment Configuration](#environment-configuration)
- [Deployment](#deployment)
  - [Local Deployment](#local-deployment)
  - [Mainnet Deployment](#mainnet-deployment)
  - [Customizing Payment Beneficiary](#customizing-payment-beneficiary)
- [Usage](#usage)
  - [Logging In](#logging-in)
  - [Fetching a Proposal](#fetching-a-proposal)
  - [Verifying Hashes](#verifying-hashes)
  - [Rebuilding Artifacts](#rebuilding-artifacts)
  - [Exporting Reports](#exporting-reports)
- [Verifying Proposals Using the App](#verifying-proposals-using-the-app)
  - [Step-by-Step Verification Guide](#step-by-step-verification-guide)
  - [Type-Specific Verification](#type-specific-verification)
  - [Common Pitfalls and Troubleshooting](#common-pitfalls-and-troubleshooting)
- [Code Examples](#code-examples)
  - [Backend: Fetching Proposal Data](#backend-fetching-proposal-data)
  - [Frontend: Handling Authentication and Balance](#frontend-handling-authentication-and-balance)
  - [Utils: Hash Computation](#utils-hash-computation)
- [Dependencies](#dependencies)
  - [Project Dependencies](#project-dependencies)
  - [Verification Tool Dependencies](#verification-tool-dependencies)
- [Contributing](#contributing)
- [License](#license)
- [Acknowledgments](#acknowledgments)

## Introduction

The IC Proposal Verifier is a decentralized application (dApp) built on the Internet Computer Protocol (ICP) blockchain. It assists users in verifying Network Nervous System (NNS) proposals by fetching proposal data, extracting key elements like hashes, commits, and URLs, and providing tools to compare and validate them against on-chain values. This tool promotes transparency and decentralization in ICP governance by making proposal verification accessible to beginners and experts alike.

Verification is crucial for ICP's decentralized governance. Proposals can upgrade canisters, deploy IC-OS versions, or manage nodes/providers. By verifying them, you ensure the payload (e.g., WASM modules, arguments, documents) matches the proposer's claims, reducing trust in central entities and catching mismatches.

This project was developed to claim a bounty for creating resources and guides on proposal verification. It includes a backend canister (Motoko) for secure data fetching and a frontend (JavaScript with Lit-HTML) for user interaction. The app uses HTTPS outcalls for external data (e.g., GitHub APIs) and integrates with Internet Identity for authentication.

**Key Goals:**
- Lower the barrier to verifying proposals.
- Provide reproducible steps, scripts, and checklists.
- Support exporting verification reports for community sharing.

## Project Overview

The app is structured as a standard dfx project:
- **Backend (`src/proposal_verifier_backend`)**: Handles authenticated, billed actions like fetching proposals from the NNS Governance canister, performing HTTPS outcalls (e.g., to GitHub/ic-api), and managing user balances/fees.
- **Frontend (`src/proposal_verifier_frontend`)**: User interface for inputting proposal IDs, displaying extracted data, verifying hashes, and exporting reports. Uses Lit-HTML for rendering and AuthClient for II login.
- **Billing Model**: Fetches are billed (0.2 ICP + network fee) from user deposits, forwarded to a beneficiary (customizable) to fund cycles.
- **Data Flow**: User logs in → Deposits ICP → Fetches proposal → Extracts/validates → Exports report.

The project supports various proposal types (e.g., ProtocolCanisterManagement, IcOsVersionDeployment) with type-specific guidance, checklists, and rebuild scripts.

## How the App Works

The app streamlines proposal verification by automating data extraction and providing verification tools. It gathers data from multiple sources to cross-verify hashes, commits, and artifacts.

### Data Gathering Process

1. **Fetch Proposal (Billed Action)**:
   - User inputs a Proposal ID.
   - Backend queries the NNS Governance canister (`rrkah-fqaaa-aaaaa-aaaaq-cai`) using `get_proposal_info`.
   - Extracts: Summary, URL, Title, Action (e.g., InstallCode with on-chain `wasm_module_hash` and `arg_hash`).
   - Parses summary for Git commits (e.g., 40-hex), hashes (64-hex), repos (e.g., `dfinity/ic`), artifacts (e.g., `./artifacts/canisters/*.wasm`), and URLs (HTTPS only).
   - Identifies proposal type (e.g., by keywords like "IC OS", "wasm", "node provider").
   - Builds commit URL if repo/commit found (e.g., `https://github.com/dfinity/ic/commit/<commit>`).
   - Extracts documents (e.g., "* Name: hash" bullets for PDFs).

2. **Augment with ic-api (HTTPS Outcall)**:
   - Fetches JSON from `https://ic-api.internetcomputer.org/api/v3/proposals/<id>`.
   - Extracts expected hash near markers (e.g., "wasm_module_hash", "expected_hash").
   - Pulls separate `arg_hash` if present.
   - Grabs payload snippet (e.g., Candid-like text after `"payload"`).
   - Infers Candid arg text (e.g., `record { ... }`).
   - Parses additional fields (e.g., category, action, target canister, controllers) for report prefill.

3. **Commit Validation**:
   - Browser-first: Fetches `https://api.github.com/repos/<repo>/commits/<commit>` (CORS-safe).
   - Fallback: Backend outcall if browser fails (billed if enabled).

4. **Document/URL Fetch**:
   - Backend outcall for non-CORS URLs (stable domains only, e.g., ic-api, GitHub).
   - Browser fallback for CORS-safe text/JSON.
   - Computes SHA-256 and compares to expected (from summary/dashboard).

5. **Arg Hash Verification**:
   - User pastes arg (text/hex/Candid/vec nat8/blob).
   - Encodes (if Candid) via quick buttons or manual `didc`.
   - Hashes bytes and compares to on-chain `arg_hash` (or dashboard).

6. **Rebuild Guidance**:
   - Generates type-specific shell scripts (e.g., `repro-check.sh` for IC-OS).
   - User runs locally, compares hash to on-chain/expected.

7. **Type-Specific Logic**:
   - Checklists/steps/tools per type (e.g., PDFs for ParticipantManagement).
   - Interactive checkboxes for manual overrides (e.g., "Rebuild Done").

All outcalls use HTTPS with transforms for consensus (e.g., strip headers). Fees ensure sustainability; deposits use subaccounts for trustless balance checks.

### Verification Workflow

- **Automated Checks**: Commit existence, hash presence, arg match, doc hashes.
- **Manual Steps**: Rebuild (via script), compare local hashes.
- **Reports**: Export JSON/Markdown with prefilled headers, checklists, notes for forum sharing.

Example: For ProtocolCanisterManagement:
- Extract commit/repo.
- Verify commit on GitHub.
- Rebuild WASM with script.
- Hash local artifact vs. on-chain `wasm_module_hash`.
- Encode args (Candid) and hash vs. `arg_hash`.

## Features

- **Authenticated Fetch**: Securely fetch proposals (billed to fund cycles).
- **Data Extraction**: Auto-pull commits, hashes, URLs, docs from summary/ic-api.
- **Commit Check**: Validate Git commit existence (browser/canister).
- **Hash Tools**: SHA-256 for args/docs; compare to on-chain/expected.
- **Type-Aware Guidance**: Steps, tools, checklists per proposal type.
- **Rebuild Scripts**: Auto-generated commands for IC-OS/WASM.
- **Export Reports**: JSON/Markdown with customizable headers/notes.
- **Deposit System**: Fund via subaccount; auto-credit on refresh.
- **FAQ Integration**: Built-in beginner guide.
- **Cycle Stats**: Monitor backend usage (last/average burned).

## Installation and Setup

### Prerequisites

- **Node.js**: v18+ (with npm v8+).
- **dfx SDK**: Latest version (install via `sh -ci "$(curl -fsSL https://internetcomputer.org/install.sh)"`).
- **Git**: For cloning repos during verification.
- **Docker**: For rebuilding IC-OS/WASM (required for `build-ic.sh`).
- **sha256sum/shasum**: For hashing (Linux/macOS built-in).
- **didc**: For Candid encoding (`cargo install candid --locked`).
- **Internet Identity**: For login (built-in to app).

### Cloning the Repository

```bash
git clone <your-repo-url>  # Replace with your GitHub repo
cd proposal_verifier
```

### Installing Dependencies

```bash
npm install  # Installs root + frontend dependencies
```

- Root: `@dfinity/agent`, `@dfinity/auth-client`, etc.
- Frontend: `lit-html`, `js-sha256`.

For Motoko backend:
- Uses Mops: `base`, `candid`, `json`, `ic`.

### Environment Configuration

- `.env` (auto-generated by dfx): Sets canister IDs.
- No extra vars needed; customize beneficiary in backend code (see [Customizing Payment Beneficiary](#customizing-payment-beneficiary)).

## Deployment

### Local Deployment

1. Start local replica:
   ```bash
   dfx start --clean --background
   ```

2. Deploy canisters:
   ```bash
   dfx deploy
   ```

3. Open frontend: `http://localhost:4943/?canisterId=<frontend-id>` (from dfx output).

### Mainnet Deployment

1. Build:
   ```bash
   npm run build
   ```

2. Deploy:
   ```bash
   dfx deploy --network ic
   ```

- Fund backend cycles: Use `dfx canister deposit-cycles` or app deposits.
- Update `BENEFICIARY_ACCOUNT_HEX` in backend before deploy (see below).

### Customizing Payment Beneficiary

Fees are forwarded to a beneficiary account (legacy ICP Ledger). To direct to your account:

1. Open `src/proposal_verifier_backend/main.mo`.
2. Find `BENEFICIARY_ACCOUNT_HEX` (default: `"2ec3dee16236d389ebdff4346bc47d5faf31db393dac788e6a6ab5e10ade144e"`).
3. Replace with your 64-hex Account Identifier (e.g., from NNS wallet).
   - Compute: Use `principalToAccountIdentifier` in `utils.js` or online tools.
4. Redeploy backend: `dfx deploy proposal_verifier_backend --network ic`.

This ensures fees go to you, not the default. Verify in code: Search for `BENEFICIARY_ACCOUNT_ID`.

## Usage

### Logging In

- Click "Login with Internet Identity".
- Authenticates via II; enables billed actions.

### Fetching a Proposal

- Enter ID (e.g., 138924).
- Confirm fee (0.2 ICP + 0.0001 network).
- App fetches/extracts data.

### Verifying Hashes

- **Arg Hash**: Paste args (hex/Candid/vec/blob), click "Verify Arg Hash".
- **Doc/File**: Upload files; app hashes/compares.
- **Expected**: Auto-pulled from summary/ic-api; compare to local rebuild.

### Rebuilding Artifacts

- Copy script from "Rebuild Locally".
- Run in terminal (Ubuntu recommended).
- Hash output vs. on-chain/expected.

### Exporting Reports

- Customize headers/notes.
- Download JSON/Markdown/TXT.
- Share on forum (e.g., paste Markdown).

## Verifying Proposals Using the App

Verification ensures proposals match claims. App assists but doesn't replace manual checks.

### Step-by-Step Verification Guide

1. **Fetch Proposal**:
   - Input ID; app queries Governance, extracts summary/commit/hash/URLs.
   - Check "Commit Status" (✅ if exists on GitHub).

2. **Review Extracted Data**:
   - Summary/Title/Type.
   - Repo/Commit/URLs (click to open).
   - On-chain hashes (`wasm_module_hash`, `arg_hash`).

3. **Verify Arg Hash**:
   - If Candid: Paste text, use "didc encode" command (copy from helpers).
   - Paste hex bytes; click "Verify".
   - Match ✅ means args match on-chain hash.

4. **Verify Documents/Files**:
   - For extracted docs: Download from URLs, upload to app.
   - App hashes/compares to expected (from summary).

5. **Rebuild & Compare**:
   - Copy script from "Rebuild Locally".
   - Run on Ubuntu/Docker.
   - Hash output (e.g., `sha256sum *.wasm`).
   - Compare to on-chain/expected (manual ✅ in checklist).

6. **Type-Specific Checks**:
   - Follow "Verification Steps" section.
   - Mark manual items (e.g., "Rebuild Done").

7. **Export & Share**:
   - Fill missing headers (e.g., verifier name).
   - Add notes.
   - Download Markdown; post on forum.

### Type-Specific Verification

Based on [Proposal Topics and Types](proposal-topics-and-types.txt):

- **ProtocolCanisterManagement** (e.g., NNS upgrades):
  - Rebuild: `git clone https://github.com/dfinity/ic; git checkout <commit>; ./ci/container/build-ic.sh -c`.
  - Hash: `sha256sum ./artifacts/canisters/*.wasm`.
  - Args: Encode Candid with `didc`; hash bytes.
  - Tools: git, Docker, sha256sum, didc.

- **IcOsVersionElection/Deployment**:
  - Download package from URLs.
  - Hash: `sha256sum <file>`.
  - Repro: `./repro-check.sh -c <commit>`.
  - Tools: curl, git, Docker, sha256sum.

- **ParticipantManagement** (e.g., Node Providers):
  - Download PDFs from wiki.
  - Hash: `sha256sum <pdf>`.
  - Compare to summary hashes.
  - Check forum/wiki context.

- **Governance** (Motions):
  - No binaries; manual review of summary/forum.

- **SubnetManagement**:
  - Verify IDs/config diffs manually.

- **Others**: Use app's steps/tools; fallback to manual.

### Common Pitfalls and Troubleshooting

- **No Data**: Invalid ID or backend error; check console.
- **Commit ❌**: Wrong repo/commit; verify manually on GitHub.
- **Hash Mismatch**:
  - Wrong input (e.g., hash-of-hash): Use app's auto-fix.
  - Candid: Encode first (`didc encode`).
  - Text/JSON: Ensure exact bytes (UTF-8, no extra spaces).
- **CORS Blocked**: Use canister fetch (logged in) for non-CORS URLs.
- **Low Balance**: Deposit ICP; refresh.
- **Outcall Failed**: Unstable domain; fetch in browser.
- **Rebuild Fails**: Use Ubuntu 22.04; ensure Docker.
- **didc Errors**: Install latest; match Candid to proposal.

For HTTPS outcalls: Responses go through consensus; use transforms to strip varying headers (see [http-outcalls.txt](http-outcalls.txt)).

## Code Examples

### Backend: Fetching Proposal Data

From `main.mo`: Queries Governance, extracts/parses summary.

```motoko
func getProposalInternal(id : Nat64, caller : Principal) : async Result.Result<ProposalInternalBundle, Text> {
  // ... (billing logic)
  let responseOpt = await governance.get_proposal_info(id);
  switch (responseOpt) {
    case (?info) {
      // Extract commit, hash, URLs, docs, type
      let (repoFromUrlOpt, commitFromUrlOpt) = extractGithubRepoAndCommit(summary);
      // ... (build commitUrl, classify type, extract docs)
      // Return bundle with base info + full ProposalInfo
    };
  };
};
```

### Frontend: Handling Authentication and Balance

From `App.js`: Uses AuthClient for II; refreshes balance/status.

```javascript
async #initAuth() {
  this.authClient = await AuthClient.create({ ... });
  if (await this.authClient.isAuthenticated()) {
    await this.#onAuthenticated(); // Sets identity + authenticated actor
  }
  await this.#loadDepositStatus(); // Gets owner/sub/address + balances
}
```

### Utils: Hash Computation

From `utils.js`: SHA-256 for args/docs.

```javascript
export async function sha256(bytesOrText) {
  const bytes = typeof bytesOrText === 'string' ? new TextEncoder().encode(bytesOrText) : bytesOrText;
  return _sha256(bytes); // Returns lowercase hex
}
```

## Dependencies

### Project Dependencies

- **Root (`package.json`)**: `@dfinity/agent@^3.3.0`, `@dfinity/auth-client@^3.3.0`, etc.
- **Frontend (`src/proposal_verifier_frontend/package.json`)**: `lit-html@^2.8.0`, `js-sha256@^0.11.0`.
- **Backend (Mops)**: `base@0.16.0`, `candid@2.1.0`, `json@1.4.0`, `ic@3.2.0`.
- **Dev**: `vite@^4.3.9`, `typescript@^5.1.3`, etc.

Install: `npm install` (root + frontend).

### Verification Tool Dependencies

- **git**: Clone repos (e.g., `dfinity/ic`).
- **Docker**: Rebuild IC-OS/WASM.
- **curl**: Download packages.
- **sha256sum/shasum**: Hash files (Linux/macOS).
- **didc**: Candid encoding (`cargo install candid --locked`).
- **Ubuntu 22.04**: Recommended for repro builds.
- **Browser**: For GitHub/ic-api (CORS-safe).

## Contributing

- Fork/clone.
- Develop on branch.
- PR with changes.
- Test locally: `dfx deploy`.
- Include tests/docs updates.

## License

Apache-2.0 (see LICENSE).

## Acknowledgments

- DFINITY Foundation: ICP docs/tools.
- Bounty: Inspired by forum post for verification resources.
- Libraries: `@dfinity/*`, `lit-html`, `js-sha256`.