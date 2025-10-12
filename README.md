# Proposal Verifier

This project is a tool designed to help users verify proposals on the Internet Computer Protocol (ICP) blockchain, specifically those submitted to the Network Nervous System (NNS) governance canister. It assists in fetching proposal details, extracting key information like Git commits, hashes, and URLs, and guiding users through verification steps. The tool aims to make proposal verification accessible to beginners by automating parts of the process and providing clear instructions for manual steps.

Verification ensures that proposals (e.g., canister upgrades, IC OS updates, or governance changes) match their descriptions, preventing tampering and promoting transparency in ICP governance. Anyone can use this tool to check proposals before voting or following them.

## Features

- Fetch proposal details from the NNS governance canister.
- Extract Git commits, expected hashes, document URLs, and other metadata from proposal summaries.
- Check if Git commits exist on repositories (e.g., GitHub).
- Verify hashes of proposal arguments or documents (via canister or browser).
- Generate rebuild scripts for IC OS or Wasm modules based on proposal type.
- Provide a checklist for verification progress.
- Support for manual steps when automated fetches are limited (e.g., due to dynamic content or CORS restrictions).

The backend is written in Motoko and uses HTTPS outcalls to fetch external data (e.g., from GitHub or ICP APIs). The frontend is a simple web interface built with JavaScript and Lit-HTML.

## Prerequisites

To run this project locally, you'll need:

- **DFX SDK**: The ICP developer toolkit. Install it by following the [Quick Start guide](https://internetcomputer.org/docs/current/developer-docs/setup/deploy-locally).
- **Node.js and npm**: Version 16+ and npm 7+. Download from [nodejs.org](https://nodejs.org/).
- **Git**: For cloning repositories during verification. Install via your package manager (e.g., `sudo apt install git` on Ubuntu).
- **Docker**: Required for rebuilding IC OS versions. Install from [docker.com](https://www.docker.com/).
- **SHA-256 Tool**: For manual hashing (built-in on most systems: `sha256sum` on Linux/Mac, or online tools like [fileformat.info](https://www.fileformat.info/tool/hash.htm)).
- **Browser**: For manual fetches where canister outcalls are restricted (e.g., non-CORS sites).

For advanced verification:
- Access to a terminal (e.g., Bash on Linux/Mac or WSL on Windows).
- Basic knowledge of command-line tools (guides provided below).

## Installation and Local Deployment

1. Clone the repository (if not already done):
   ```
   git clone <your-repo-url>
   cd proposal_verifier
   ```

2. Install dependencies:
   ```
   npm install
   ```

3. Start the local ICP replica:
   ```
   dfx start --background
   ```

4. Deploy the canisters:
   ```
   dfx deploy
   ```

5. Start the frontend development server:
   ```
   npm start
   ```

   The app will be available at `http://localhost:3000` (or the port specified in `vite.config.js`).

   - API requests are proxied to the local replica at port 4943.
   - For production-like deployment to ICP mainnet, use `dfx deploy --network ic`.

If you make changes to the backend (Motoko code), regenerate the Candid interface:
```
npm run generate
dfx deploy
```

## Usage: Verifying a Proposal with the App

The app simplifies verification by fetching and analyzing proposal data. Follow these steps:

1. **Enter Proposal ID**: In the app's input field, enter a valid NNS proposal ID (e.g., 138887) and click "Fetch Proposal".
   - The app queries the NNS governance canister (rrkah-fqaaa-aaaaa-aaaaq-cai) for details.
   - It extracts: summary, type, commit hash, expected SHA-256 hash, repo, artifact paths, and URLs.

2. **Review Extracted Data**:
   - **Proposal Details**: Check title, type (e.g., IcOsVersionDeployment, ProtocolCanisterManagement), and raw summary.
   - **Extracted Commit & Repo**: Verifies if the commit exists on GitHub (via canister or browser fallback).
   - **Expected Hash**: Pulled from summary, dashboard API, or linked docs.
   - **Links**: All extracted URLs (e.g., dashboard, GitHub, docs). Click to open.

3. **Verify Args Hash** (if proposal includes arguments like config params):
   - Paste the args (from summary or payload snippet) into the "Args to Hash" textarea.
   - Enter/update the expected hash (pre-filled if extracted).
   - Click "Verify". Green ✅ means match; red ❌ means mismatch.

4. **Verify Document or File** (e.g., self-declarations, PDFs):
   - Enter the document URL (pre-filled if extracted) or upload a local file.
   - Enter the expected hash (from proposal).
   - Click "Fetch & Verify URL" or select a file.
   - Preview shows content snippet; check for ✅ match.
   - If fetch fails (e.g., non-deterministic site), download manually in your browser and upload the file.

5. **Rebuild Locally** (for code/Wasm/IC OS proposals):
   - Copy the generated script (tailored to proposal type).
   - Run it in a terminal (e.g., save as `rebuild.sh`, `chmod +x rebuild.sh`, `./rebuild.sh`).
   - Compute SHA-256 of the built artifact (e.g., `sha256sum artifacts/canisters/*.wasm`).
   - Compare to the expected hash. Mark "Done" in the checklist if it matches.

6. **Checklist**: Tracks progress. Aim for all ✅.
   - If complete, the proposal is verified! Share results publicly (e.g., on the DFINITY forum).

## When the App Doesn't Return All Info

The app uses HTTPS outcalls, which require deterministic responses across replicas. Some sites (e.g., dynamic content) may fail:

- **Missing Commit/Hash**: Search the summary manually for "commit/" or "sha256". Use browser to fetch non-CORS URLs.
- **Dynamic Domains**: If "Domain likely dynamic" error, open the URL in your browser, copy content, and paste into "Args to Hash" for verification.
- **No Extracted URLs**: Use proposal's official URL or search summary for links.
- **Manual Hashing**: For any file/arg:
  - Download file.
  - Run `sha256sum yourfile` (Linux/Mac) or use online tools.
  - Compare to proposal's hash.

For proposal types:
- **IcOsVersionDeployment**: Rebuild with script; verify GuestOS/HostOS image hash.
- **ProtocolCanisterManagement**: Build Wasm; check against proposal hash.
- **ParticipantManagement**: Download self-declaration PDF; hash and compare.
- **Others**: Refer to proposal summary for custom steps.

Full verification guides per type: See [ICP Docs: Verify Proposals](https://internetcomputer.org/docs/current/developer-docs/governance/verifying-proposals).

## Dependencies for Rebuilding and Manual Tasks

- **Environment Setup**:
  - Ubuntu 22.04+ (recommended; tested for reproducibility).
  - For Windows: Use WSL (Windows Subsystem for Linux).
  - macOS/Linux: Native terminal.

- **Tools**:
  - `curl`, `git`, `docker` (install: `sudo apt install curl git docker.io` on Ubuntu).
  - For hashing: `sha256sum` (built-in on Unix-like systems).
  - For building IC code: Follow script; pulls from GitHub.

Example for IC OS rebuild (from GitHub: https://github.com/dfinity/ic#verifying-releases):
```
sudo apt-get install -y curl git docker.io
curl --proto '=https' --tlsv1.2 -sSLO https://raw.githubusercontent.com/dfinity/ic/<commit>/gitlab-ci/tools/repro-check.sh
chmod +x repro-check.sh
./repro-check.sh -c <commit>
sha256sum artifacts/canisters/*.wasm  # Compare hash
```

## Troubleshooting

- **Outcall Failed**: Check cycles (query "getCycleBalance" in Candid UI). Add via `dfx canister call <canister> --with-cycles <amount>`.
- **CORS Errors**: Fetch in browser; paste into app.
- **No Hash Found**: Scan summary for "sha256" or "hash".
- **Script Errors**: Ensure Docker runs; check Git commit validity.
- **App Not Loading**: Run `npm install` and `dfx deploy` again.

For issues, check browser console or replica logs (`dfx start --background`).

## Contributing

Feel free to fork and improve! Focus on beginner-friendliness. Submit PRs with clear descriptions.

## References

- [ICP Governance Docs](https://internetcomputer.org/docs/current/developer-docs/governance)
- [Proposal Topics & Types](https://internetcomputer.org/docs/current/developer-docs/governance/proposal-topics-and-types)
- [HTTPS Outcalls](https://internetcomputer.org/docs/current/references/https-outcalls-how-it-works)
- [GitHub API](https://docs.github.com/en/rest)
- [DFINITY Forum: Proposal Discussions](https://forum.dfinity.org/c/governance/nns-proposal-discussion/33)

This tool promotes decentralized governance—verify proposals to contribute!
