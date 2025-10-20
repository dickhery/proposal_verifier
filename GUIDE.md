# IC Proposal Verification Guide

## Table of Contents

- [Introduction: What Are NNS Proposals and Why Verify Them?](#introduction-what-are-nns-proposals-and-why-verify-them)
- [Key Concepts: Hashes, Git Commits, Arguments, and Binaries](#key-concepts-hashes-git-commits-arguments-and-binaries)
- [Proposal Types and What Needs to Be Verified](#proposal-types-and-what-needs-to-be-verified)
- [Setup and Dependencies](#setup-and-dependencies)
  - [Windows (Using WSL)](#windows-using-wsl)
  - [macOS](#macos)
  - [Linux (Ubuntu Recommended)](#linux-ubuntu-recommended)
  - [Common Tools Across Platforms](#common-tools-across-platforms)
- [Using the Proposal Verifier App](#using-the-proposal-verifier-app)
  - [App Overview and Deployment](#app-overview-and-deployment)
  - [Costs and Cycles](#costs-and-cycles)
  - [Deploying Your Own Version](#deploying-your-own-version)
- [Step-by-Step Verification with the Proposal Verifier App](#step-by-step-verification-with-the-proposal-verifier-app)
  - [Fetch Proposal](#fetch-proposal)
  - [Review Extracted Data](#review-extracted-data)
  - [Verify Arg Hash](#verify-arg-hash)
  - [Verify Documents/Files](#verify-documentsfiles)
  - [Rebuild Locally](#rebuild-locally)
  - [Complete Checklist](#complete-checklist)
  - [Export and Share Results](#export-and-share-results)
- [Step-by-Step Verification Manually (Without the App)](#step-by-step-verification-manually-without-the-app)
  - [Fetch Proposal](#fetch-proposal-1)
  - [Extract Data](#extract-data)
  - [Verify Commit](#verify-commit)
  - [Verify Arg Hash](#verify-arg-hash-1)
  - [Verify Documents/Files](#verify-documentsfiles-1)
  - [Rebuild Binaries](#rebuild-binaries)
  - [Complete Checklist](#complete-checklist-1)
  - [Share Results](#share-results)
- [Verifying Proposals That Require Mostly Manual Review](#verifying-proposals-that-require-mostly-manual-review)
  - [Motion Proposals](#motion-proposals)
  - [Add/Remove Controllers](#addremove-controllers)
  - [Other Manual-Heavy Types](#other-manual-heavy-types)
- [Troubleshooting Common Problems](#troubleshooting-common-problems)
  - [Hash Mismatches](#hash-mismatches)
  - [Build Failures](#build-failures)
  - [CORS Blocks or Fetch Issues](#cors-blocks-or-fetch-issues)
  - [didc Errors](#didc-errors)
  - [Proposal Not Found](#proposal-not-found)
  - [Balances/Fees Issues](#balancesfees-issues)
  - [App-Specific Issues](#app-specific-issues)
  - [Verifying Null Arg Hashes](#verifying-null-arg-hashes)
- [Sharing Results](#sharing-results-1)
- [Additional Resources](#additional-resources)

## Introduction: What Are NNS Proposals and Why Verify Them?

The Network Nervous System (NNS) is the decentralized governance system of the Internet Computer Protocol (ICP) blockchain. It allows neuron holders (participants who stake ICP tokens) to vote on proposals that shape the network's evolution. Proposals are on-chain requests for actions such as upgrading canisters (smart contracts), electing new IC-OS versions (the software running on ICP nodes), adding node providers, or adjusting network economics. Each proposal includes metadata (title, summary, URLs), a payload (arguments like configuration parameters, WASM code hashes, or document hashes), and often references to Git commits or external resources.

**Why verify proposals?** Verification ensures the proposal’s payload matches what the proposer claims, preventing tampering, errors, or malicious changes. In a decentralized system like ICP, trust is distributed—relying on "many eyes" reduces risks like unverified binaries introducing bugs or backdoors, governance capture, or operational failures. Independent verification builds resilience; if multiple verifiers rebuild artifacts and match hashes, it forms a tamper-resistant attestation. Decentralization depends on community participation to maintain transparency and security.

**Key risks if unverified:** Tampered documents (e.g., fake node provider PDFs), mismatched commits (wrong code version), or altered payloads could lead to regressions or security holes. For example, an unverified WASM upgrade might introduce vulnerabilities to critical canisters like the NNS governance or ICP ledger.

**Rewards for participation:** Voting on proposals earns rewards, with governance topics weighted 20x higher than others (e.g., protocol upgrades).

The verification workflow typically follows this diagram (ASCII art for simplicity):

```
+-------------------+     +-------------------+     +-------------------+
| 1. Fetch Proposal | --> | 2. Extract Data   | --> | 3. Rebuild/Hash   |
|   (ID from NNS)   |     | (Commits, Hashes, |     |   & Compare       |
|                   |     |  URLs, Payload)   |     |   to On-Chain     |
+-------------------+     +-------------------+     +-------------------+
                             |                           |
                             v                           v
                   +-------------------+     +-------------------+
                   | 4. Check Docs/    | <-- | 5. Share Results  |
                   |    Args Integrity |     |   (Forum/Gist)    |
                   +-------------------+     +-------------------+
```

1. **Fetch:** Use the app, dashboard, or `dfx canister call` on the governance canister.
2. **Extract:** Parse for commits, hashes, URLs (app auto-does; manual: grep summary).
3. **Rebuild/Hash:** Type-specific (e.g., IC-OS: `repro-check.sh` from GitHub ic repo).
4. **Check Integrity:** Match hashes; review forum/wiki.
5. **Share:** Post results/logs to forum.dfinity.org (Governance > NNS proposal discussion).

This guide covers verification using the Proposal Verifier app (deployed on ICP) and manually (without the app). The app accelerates the process but burns cycles (ICP fees) for on-chain fetches. Manual methods are free but require more setup.

## Key Concepts: Hashes, Git Commits, Arguments, and Binaries

Understanding these basics is crucial for verification:

- **Hashes (e.g., SHA-256):** A hash is a "digital fingerprint"—a fixed-length string (64 hex characters for SHA-256) unique to the input data. Change one byte, and the hash changes entirely. Proposals include hashes for WASM/binaries/docs; recompute them locally to verify integrity. Example: Hash a PDF with `sha256sum file.pdf` (Linux) or `shasum -a 256 file.pdf` (Mac). Tools: `sha256sum` (Linux), `shasum` (Mac), or online (but prefer local for security). The `wasm_module_hash` fingerprints the code being installed (WASM module), while `arg_hash` fingerprints the parameters to that code. For upgrades, compare both.

- **Git Commits:** Snapshots of code changes in repositories (e.g., GitHub). Identified by 40-hex SHA-1 hashes (e.g., `ec35ebd252d4ffb151d2cfceba3a86c4fb87c6d6`). Proposals reference commits—verify existence via GitHub API (`GET /repos/{owner}/{repo}/commits/{sha}`) or browser. Ensure the commit matches the proposal's description to avoid wrong versions.

- **Arguments (Payload):** Data like Candid-encoded params or hex bytes. Verify by re-encoding (e.g., with `didc`) and hashing; match `arg_hash`. Candid is a serialization format for ICP interfaces—use `didc encode '(record { ... })' | xxd -r -p | sha256sum` to get the hash. Null args often hash to `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` (empty bytes) or other common values depending on encoding.

- **Binaries (e.g., WASM or IC-OS Images):** Executables like WASM (canisters) or IC-OS images (.tar.zst). Rebuild from commit (e.g., via `repro-check.sh` from ic repo README) and hash; match `wasm_module_hash` or `release_package_sha256_hex`. Reproducible builds ensure the binary matches the source code exactly.

These elements ensure proposals are tamper-proof. Mismatches indicate errors or foul play.

## Proposal Types and What Needs to Be Verified

Proposals group by topics (e.g., ProtocolCanisterManagement for NNS upgrades). Verification varies by type (binaries for code, docs for providers). Here's a breakdown:

- **ProtocolCanisterManagement:** Manage essential canisters (e.g., NNS governance, registry, ICP ledger).
  - Types: InstallCode (upgrade/reinstall canister), UpdateCanisterSettings, StopOrStartCanister, HardResetNnsRootToVersion.
  - Verify: Rebuild WASM from commit, hash and match `wasm_module_hash`. Encode args with `didc`, hash bytes, match `arg_hash`. Check commit exists.

- **ServiceNervousSystemManagement:** Manage SNS canisters (e.g., upgrades, SNS-W additions).
  - Types: InstallCode, UpdateCanisterSettings, StopOrStartCanister, AddSnsWasm, InsertSnsWasmUpgradePathEntries.
  - Verify: Similar to above—rebuild WASM, match hashes. For path entries, review parameters.

- **ApplicationCanisterManagement:** Manage other NNS-controlled canisters (e.g., Bitcoin, ckBTC).
  - Types: InstallCode, UpdateCanisterSettings, StopOrStartCanister, BitcoinSetConfig.
  - Verify: Rebuild from repo/commit, match WASM hash. For configs, review fields vs. topology.

- **IcOsVersionElection:** Elect new IC-OS versions (HostOS/GuestOS).
  - Types: ReviseElectedGuestosVersions, ReviseElectedHostosVersions.
  - Verify: Use `repro-check.sh` from ic repo at commit, hash artifacts, match proposal's `release_package_sha256_hex`.

- **IcOsVersionDeployment:** Deploy elected IC-OS versions to nodes/subnets.
  - Types: DeployHostosToSomeNodes, DeployGuestosToAllSubnetNodes, DeployGuestosToSomeApiBoundaryNodes, DeployGuestosToAllUnassignedNodes.
  - Verify: Download package from URL, `sha256sum`, match `release_package_sha256_hex`. Check targeted nodes/subnets.

- **Governance:** High-reward (20x) motions or defaults.
  - Types: Motion (polls, no on-chain effect), UninstallCode, SetDefaultFollowees, RegisterKnownNeuron.
  - Verify: Manual—read summary, check forum. No hashes/binaries.

- **SnsAndCommunityFund:** SNS swaps and Neurons' Fund.
  - Types: CreateServiceNervousSystem.
  - Verify: Review params (tokens, swap), match docs/hashes. High-reward (20x).

- **NetworkEconomics:** Adjust rewards/economics.
  - Types: UpdateNodeProviderRewardConfig, UpdateIcpXdrConversionRate.
  - Verify: Manual—compare tables/params to prior values.

- **SubnetManagement:** Change topology/config.
  - Types: CreateSubnet, UpdateConfigOfSubnet, AddNodeToSubnet, RemoveNodesFromSubnet, ChangeSubnetMembership, RecoverSubnet, SetFirewallConfig, etc.
  - Verify: Check IDs/config diffs. Manual for routing/firewall.

- **ParticipantManagement:** Administer node/data center providers.
  - Types: AddOrRemoveNodeProvider, AddOrRemoveDataCenters.
  - Verify: Download PDFs from wiki, hash, match proposal. Check forum intro, identity docs.

- **NodeAdmin:** Manage node machines.
  - Types: AssignNoid, UpdateNodeOperatorConfig, RemoveNodeOperators, RemoveNodes, UpdateSshReadonlyAccessForAllUnassignedNodes.
  - Verify: Check allowances/IDs vs. topology. Manual.

- **KYC:** KYC Genesis neurons.
  - Types: ApproveGenesisKYC.
  - Verify: Manual—principals match list.

- **NeuronManagement:** Restricted—followers manage neuron.
  - Types: ManageNeuron.
  - Verify: Manual—target neuron/permissions.

For all: Start with fetch/extract, end with share. Binaries need rebuilds; docs need hashes; motions need reading.

## Setup and Dependencies

Use a clean environment (VM/Docker) to avoid tampering. Ubuntu 22.04 recommended for repro-builds.

### Windows (Using WSL)

1. Install WSL: Open PowerShell as admin, run `wsl --install` (reboot if needed).
2. In WSL (Ubuntu): `sudo apt update && sudo apt install git curl docker.io jq build-essential sha256sum xxd`.
3. Rust/didc: `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`, then `cargo install didc`.
4. Docker: Install Docker Desktop (Windows), enable WSL integration.

**Issues:** Docker not starting—ensure WSL2 backend; low resources—edit .wslconfig for limits.

### macOS

1. Install Homebrew: `/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"`.
2. Tools: `brew install git curl docker jq coreutils sha2 shasum xxd`.
3. Rust/didc: `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`, then `cargo install didc`.
4. Docker: Use Docker Desktop or Colima as alternative.

**Issues:** Use `shasum -a 256` for hashes; Colima for Docker alternatives.

### Linux (Ubuntu Recommended)

1. `sudo apt update && sudo apt install git curl docker.io jq build-essential sha256sum xxd`.
2. Rust/didc: `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`, then `cargo install didc`.
3. Docker: Add user to docker group (`sudo usermod -aG docker $USER`), logout/login.

**Issues:** Docker fails—use rootless podman; clean repo with `git clean -fdx`.

### Common Tools Across Platforms

- **git:** For cloning repos.
- **curl:** Fetch URLs.
- **docker:** Builds/repros.
- **jq:** Parse JSON.
- **sha256sum/shasum:** Hashes.
- **xxd:** Hex/bytes conversion.
- **didc:** Candid encoding.
- **dfx:** ICP CLI for manual fetches (install from sdk.dfinity.org).

Test: `sha256sum --version`, `didc --version`.

## Using the Proposal Verifier App

### App Overview and Deployment

The Proposal Verifier app (https://g5ige-nyaaa-aaaap-an4rq-cai.icp0.io/) is deployed on the ICP blockchain. It fetches proposals, extracts data (commits/hashes/URLs), assists hashing, and tracks checklists. Backend uses HTTPS outcalls for GitHub/ic-api; frontend is lit-html UI.

Repo: https://github.com/dickhery/proposal_verifier. Clone/deploy your own to control costs.

### Costs and Cycles

Fetching burns cycles (e.g., 0.2 ICP + fee per fetch) for on-chain calls/outcalls. Fees forward to address `2ec3dee16236d389ebdff4346bc47d5faf31db393dac788e6a6ab5e10ade144e`. Fund your subaccount first.

### Deploying Your Own Version

1. Clone: `git clone https://github.com/dickhery/proposal_verifier`.
2. Change deposit address in main.mo (line ~561) to yours.
3. Replace frontend/backend canister references in dfx.json/package.json.
4. `dfx deploy` (see README for details).
5. Fund cycles as needed.

## Step-by-Step Verification with the Proposal Verifier App

Login with Internet Identity (fund balance first).

### Fetch Proposal

Enter ID (e.g., 129394), click “Fetch” (costs 0.2 ICP + fee). Snapshot balances post-bill.

**Issues:** Invalid ID—check dashboard; low balance—fund more.

### Review Extracted Data

Check repo/commit (auto-verifies GitHub), hashes, URLs. Status: ✅ if commit exists.

**Issues:** Missing commit—add from summary manually.

### Verify Arg Hash

1. Paste args (e.g., Candid from payload snippet).
2. Select type (Candid: encode with didc).
3. Click “Verify”; match ✅.

**Issues:** Mismatch—wrong encoding; use `didc encode '(record { ... })' | xxd -r -p | sha256sum`. Common null hashes: `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` (empty).

### Verify Documents/Files

Upload files (e.g., PDFs); app hashes & compares. Or fetch URLs (text only).

**Issues:** CORS block—use canister fetch; binary—upload local. Hash mismatch—wrong file; diff bytes.

### Rebuild Locally

Copy rebuild script; run in terminal; compare hash to expected.

**Issues:** Fails—check deps/OS; clean repo (`git clean -fdx`).

### Complete Checklist

Mark items (e.g., “Rebuild Done”); app tracks. Override for manual (e.g., policy review).

### Export and Share Results

Export JSON/Markdown; post to forum.dfinity.org with results/logs. Include: ID, hashes (yours vs. proposal), rebuild logs, mismatches, commands/versions.

## Step-by-Step Verification Manually (Without the App)

Parallel to app; use setup tools.

### Fetch Proposal

`dfx canister call rrkah-fqaaa-aaaaa-aaaaq-cai get_proposal_info '(ID)' --network ic`. Or dashboard.internetcomputer.org/proposal/ID.

**Issues:** Wrong network—use `--network ic`; Candid parse—use `didc decode`.

### Extract Data

Parse Candid for summary/URLs/commit/hashes (use jq for JSON from ic-api.internetcomputer.org/api/v3/proposals/ID).

**Issues:** Candid parse—use `didc decode`.

### Verify Commit

`curl https://api.github.com/repos/OWNER/REPO/commits/SHA`; check 200.

**Issues:** Rate limit—use token.

### Verify Arg Hash

Extract args from payload (Candid? `didc encode ‘(record { … })’ | xxd -r -p | sha256sum`). Compare to `arg_hash`.

**Issues:** Encoding error—match fields/order. Null: hash empty bytes.

### Verify Documents/Files

Download from URL; `sha256sum file.pdf`; match proposal.

**Issues:** Wrong URL—check summary.

### Rebuild Binaries

- IC-OS: Clone ic repo, checkout commit, `repro-check.sh`.
- WASM: Clone repo, build (`./ci/container/build-ic.sh -c`); `sha256sum artifact`. Match `wasm_module_hash`.

**Issues:** Env mismatch—use Ubuntu 22.04/Docker.

### Complete Checklist

Track manually (notes). Use workflow diagram.

### Share Results

Post hashes/results/logs to forum.dfinity.org (Governance > NNS proposal discussion). Include commands/outputs.

## Verifying Proposals That Require Mostly Manual Review

Some proposals lack binaries/hashes; focus on intent/policy.

### Motion Proposals

Text-only polls for strategy. No on-chain effect.

Verify: Read summary/forum; ensure matches title/context. No hashes—adopt if aligns with community.

### Add/Remove Controllers

Update canister controllers.

Verify: Check principals match proposal/topology. Manual review of changes.

### Other Manual-Heavy Types

- **NeuronManagement:** Verify target neuron/permissions.
- **KYC (ApproveGenesisKYC):** Principals match list.
- **NetworkEconomics:** Compare params to prior.
- **SubnetManagement:** IDs/config diffs valid.

## Troubleshooting Common Problems

### Hash Mismatches

- Wrong encoding (`didc` for Candid); file diffs (`diff`); commit errors (checkout precisely).
- Solution: Re-encode; download exact; retry build. Null args: hash empty (`e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`) or unit (`44e525001ffbc076eb1fcaa896 pon`—check encoding).

### Build Failures

- Missing deps (install per setup); wrong OS (Ubuntu VM); dirty repo (`git clean -fdx`).
- Solution: Follow README; retry.

### CORS Blocks or Fetch Issues

- Dynamic sites—use browser; non-CORS—canister HTTPS.
- Solution: App uses outcalls; manual: curl (CORS-safe).

### didc Errors

- Syntax—match Motoko grammar; install Rust.
- Solution: Check fields/order; test simple encodes.

### Proposal Not Found

- Wrong ID—check dashboard; network—use `--network ic`.

### Balances/Fees Issues

- Low—fund deposit; wrong subaccount—refresh.
- Solution: Send more ICP; double-check address.

### App-Specific Issues

- Fetch fails—login/fund; CORS—use canister fetch.
- Solution: Deploy own version; check README.

## Sharing Results

Post to forum.dfinity.org (Governance > NNS proposal discussion; tag topic). Include: ID, hashes (yours vs. proposal), rebuild logs, mismatches, commands/versions. Use Gist/GitHub for logs/scripts. Sharing builds trust; enables reproduction.

## Additional Resources

- ICP Dashboard: dashboard.internetcomputer.org
- Developer Forum: forum.dfinity.org (Governance category)
- IC Repo: github.com/dfinity/ic
- SNS Repo: github.com/dfinity/sns
- NNS dapp: nns.ic0.app
- Verify-Proposals Guide: internetcomputer.org/docs/current/developer-docs/daos/nns/concepts/proposals/verify-proposals