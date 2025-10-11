# IC Proposal Verifier

Welcome to the IC Proposal Verifier—a tool built on the Internet Computer (ICP) to assist in verifying NNS proposals. This app automates key steps in the verification process, such as fetching proposal data from the NNS governance canister, extracting Git commits, hashes, repositories, and document URLs from summaries, checking commit existence via GitHub API, and verifying argument or document hashes. It is designed to support governance decentralization by making proposal verification more accessible, especially for beginners.

The app leverages Motoko for the backend (with HTTPS outcalls for stable domains) and a simple JavaScript frontend. It aligns with ICP documentation on verifying proposals (e.g., checking Git commits, rebuilding binaries, comparing hashes) and handles limitations like consensus requirements for outcalls.

## What the App Does

### Backend (Motoko Canister)
- **Fetching Proposals**: Queries the NNS governance canister (`rrkah-fqaaa-aaaaa-aaaaq-cai`) using its IDL to retrieve proposal info (ID, summary, URL, title).
- **Text Extraction**: Parses the summary using Motoko's text utilities (e.g., `indexOf`, slicing) to extract GitHub repos/commits (e.g., from "https://github.com/dfinity/ic/commit/..."), SHA-256 hashes (64-hex near markers like "sha256", "wasm_module_hash"), document URLs, and artifact paths (e.g., "./artifacts/canisters/*.wasm").
- **Proposal Classification**: Categorizes types based on keywords in the summary (e.g., "IC OS" → IcOsVersionDeployment, from proposal-topics-and-types.txt).
- **HTTPS Outcalls**: Makes GET requests to stable/deterministic domains (e.g., GitHub API for commit checks, ic-api for dashboard JSON). Follows http-outcalls.txt: Adds cycles (~100B per call), strips all headers in transform function for consensus. Limits to domains like api.github.com, raw.githubusercontent.com, ic-api.internetcomputer.org to avoid divergence.
- **Rebuild Scripts**: Generates type-specific scripts (e.g., repro-check.sh for IC-OS from GitHub's ic repo; sha256sum for docs).
- **Hash Verification**: Placeholder for client-side (keeps Candid stable); actual SHA-256 is computed in frontend.

### Frontend (JavaScript)
- **User Interface**: Input proposal ID, fetch/display data, verify args/docs hashes client-side (using Web Crypto API for SHA-256), upload local files for hashing.
- **Checks**: Auto commit validation (canister or browser fallback), checklist for progress (fetch, commit, hash, expected, rebuild).
- **Fallbacks**: Browser fetch for non-stable domains (requires CORS); manual upload for large/dynamic docs.

The backend ensures safe outcalls (no dynamic content that could cause consensus failure). All extracted data is from proposal summaries or stable APIs.

## Limitations
- **Outcalls Restricted**: Only to deterministic/stable domains (e.g., GitHub, ic-api)—dynamic sites (e.g., forums, variable APIs) may fail consensus. Use browser/manual fallback.
- **Consensus Risks**: If responses vary (e.g., timestamps), outcalls fail with "responses different across replicas". Advise retry or manual verification.
- **Hashing**: Client-side only (secure via Web Crypto)—for very large files, use local tools like `sha256sum`.
- **Rebuild**: App provides scripts but doesn't execute (resource limits)—run locally. For Wasm/IC-OS, requires Git/Docker setup.
- **Extraction**: Heuristic-based (e.g., first 40-hex for commits, 64-hex near "sha256" for hashes)—may miss malformed summaries. Manual review needed.
- **No Full Automation**: Rebuild/compare is manual for trust (user verifies binaries). If info can't be fetched (e.g., no URL), download manually from proposal links and hash locally (per Verify-Proposals.txt).
- **Cycles**: Local testing is free; mainnet outcalls consume cycles—monitor via "Check Cycles" button.

If extraction/fetch fails: 
- Manually inspect summary (copy from app).
- Download docs/binaries from extracted URLs.
- Compute hashes locally (e.g., `sha256sum file.wasm`).
- Check GitHub commits via browser.
- Compare to proposal/dashboard hashes.

## How to Use the App to Verify Proposals
Follow these steps to verify a proposal (e.g., NNS canister upgrade, IC-OS election from Verify-Proposals.txt). The app streamlines but doesn't replace manual checks—always cross-verify.

1. **Deploy and Run Locally**: See "Running the Project Locally" below.
2. **Input Proposal ID**: Enter an ID (e.g., 129394 from proposal examples) and click "Fetch Proposal". The backend queries governance and extracts data.
3. **Review Proposal Details**:
   - **Summary/Extracts**: Check title, type (e.g., ProtocolCanisterManagement), commit/repo/hash/URL/artifact.
   - **Commit Status**: ✅ if exists on GitHub (via API).
   - **Expected Hash**: From ic-api JSON, summary, or manual input (sources like "ic-api" shown).
   - **Dashboard Link**: Click to view full proposal on dashboard.internetcomputer.org.
4. **Verify Args Hash**:
   - Paste args (from dashboard payload snippet or summary).
   - Input expected hash (auto-filled if extracted).
   - Click "Verify"—✅ if matches (client-side SHA-256).
5. **Verify Linked Document/File**:
   - Input URL (auto from extracts) and hash—click "Fetch & Verify" (canister for stable; browser fallback).
   - Or upload local file (e.g., downloaded PDF)—hashes and previews content.
   - ✅ if matches (per Verify-Proposals.txt: Ensures integrity, e.g., for self-declarations).
6. **Rebuild and Compare**:
   - Copy the script (type-specific, e.g., for IcOsVersionElection: clones ic repo, runs repro-check.sh).
   - Run locally (setup below)—get sha256sum of built Wasm/IC-OS.
   - Compare to expected hash—mark "Done" in checklist.
7. **Checklist**: Tracks completion—aim for all ✅.
8. **Share Results**: Post in forum (e.g., "Verified ID 123: Commit exists, hashes match via app/local rebuild").

Use extracted info to guide manual steps (e.g., if type is ParticipantManagement, hash self-declaration PDF). For full verification (per Verify-Proposals.txt):
- Check forum post/commit (app extracts).
- Rebuild Wasm/IC-OS (script provided).
- Compare hashes (app + local).

## Setup to Run Rebuild Scripts Locally
Rebuilding verifies binaries match proposal hashes (e.g., Wasm for canisters, IC-OS images)—done locally for trust and to avoid canister limits. Scripts from app (e.g., repro-check.sh from ic GitHub repo) require Git/Docker. Why? Ensures code from commit produces expected artifact (per verifying-releases in ic repo).

### Windows (Using WSL for Ubuntu Environment)
1. **Enable WSL**: Search "Turn Windows features on or off" > Check "Windows Subsystem for Linux" > Restart.
2. **Install Ubuntu**: Open Microsoft Store > Search/install "Ubuntu" (free).
3. **Launch Ubuntu**: Open from Start menu—set username/password on first run.
4. **Update Packages**: In Ubuntu terminal: `sudo apt update && sudo apt upgrade -y`.
5. **Install Tools**: `sudo apt install curl git docker.io -y`.
6. **Start Docker**: If errors, install Docker Desktop (docker.com) and enable WSL integration (Settings > Resources > WSL).
7. **Run Script**: Paste app's script into terminal (e.g., for IC-OS: downloads/clones ic repo, builds via Docker, outputs sha256sum).
8. **Compare**: Match output hash to app's expected.

### Mac (Using Terminal)
1. **Open Terminal**: Spotlight (Cmd+Space) > "Terminal".
2. **Install Homebrew**: Paste `/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"` > Follow prompts.
3. **Install Tools**: `brew install curl git docker`.
4. **Install/Start Docker**: Download Docker Desktop (docker.com) > Install > Launch (sign in if needed).
5. **Run Script**: Paste into Terminal—builds via Docker.
6. **Compare**: As above.

Troubleshooting: Docker errors? Check running/enabled. Large builds? Ensure 8GB+ RAM. Output sha256sum (e.g., `sha256sum artifacts/canisters/*.wasm`)—compare to proposal.

For other types (e.g., docs): `sha256sum file.pdf` in terminal.

## Running the Project Locally
```bash
cd proposal_verifier/
dfx start --background  # Starts local replica
dfx deploy  # Deploys canisters, generates declarations
npm start  # Starts frontend at http://localhost:3000 (proxies to replica)
```

For frontend changes: `npm run generate` to update declarations.

To learn more before you start:
- [Quick Start](https://internetcomputer.org/docs/current/developer-docs/setup/deploy-locally)
- [SDK Developer Tools](https://internetcomputer.org/docs/current/developer-docs/setup/install)
- [Motoko Programming Language Guide](https://internetcomputer.org/docs/current/motoko/main/motoko)
- [Motoko Language Quick Reference](https://internetcomputer.org/docs/current/motoko/main/language-manual)
- [Verify Proposals](https://internetcomputer.org/docs/current/developer-docs/governance/verify-proposals)
- [HTTPS Outcalls](https://internetcomputer.org/docs/current/references/https-outcalls-how-it-works)
- [Proposal Topics and Types](https://internetcomputer.org/docs/current/references/proposal-topics-and-types)

If you encounter issues, check the forum or dfx help: `dfx help`.

If you want to deploy your own instance of IC Proposal Verifier, you might want to try the following commands:

```bash
cd proposal_verifier/
dfx help
dfx canister --help
```

## Running the project locally

If you want to test your project locally, you can use the following commands:

```bash
# Starts the replica, running in the background
dfx start --background

# Deploys your canisters to the replica and generates your candid interface
dfx deploy
```

Once the job completes, your application will be available at `http://localhost:4943?canisterId={asset_canister_id}`.

If you have made changes to your backend canister, you can generate a new candid interface with

```bash
npm run generate
```

at any time. This is recommended before starting the frontend development server, and will be run automatically any time you run `dfx deploy`.

If you are making frontend changes, you can start a development server with

```bash
npm start
```

Which will start a server at `http://localhost:8080`, proxying API requests to the replica at port 4943.

### Note on frontend environment variables

If you are hosting frontend code somewhere without using DFX, you may need to make one of the following adjustments to ensure your project does not fetch the root key in production:

- set`DFX_NETWORK` to `ic` if you are using Webpack
- use your own preferred method to replace `process.env.DFX_NETWORK` in the autogenerated declarations
  - Setting `canisters -> {asset_canister_id} -> declarations -> env_override to a string` in `dfx.json` will replace `process.env.DFX_NETWORK` with the string in the autogenerated declarations
- Write your own `createActor` constructor
