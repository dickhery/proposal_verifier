# IC Proposal Verification Guide

## Introduction: What Are NNS Proposals and Why Verify Them?

The Network Nervous System (NNS) is the decentralized governance system of the Internet Computer Protocol (ICP) blockchain. It allows neuron holders to vote on proposals that shape the network's evolution. Proposals are on-chain requests for actions such as upgrading canisters (smart contracts), electing new IC-OS versions (the software running on ICP nodes), adding node providers, or adjusting network economics. Each proposal includes metadata (title, summary, URLs), a payload (arguments like configuration parameters, WASM code hashes, or document hashes), and often references to Git commits or external resources.

**Why verify proposals?** Verification ensures the proposal’s payload matches what the proposer claims, preventing tampering, errors, or malicious changes. In a decentralized system like ICP, trust is distributed—relying on "many eyes" reduces risks like unverified binaries introducing bugs/backdoors, governance capture, or operational failures. As per DFINITY docs: “Decentralization depends on many eyes” (Verify-Proposals.txt). Independent verification builds resilience; if multiple verifiers rebuild artifacts and match hashes, it forms a tamper-resistant attestation.

**Key risks if unverified:** Tampered documents (e.g., fake node provider PDFs), mismatched commits (wrong code version), or altered payloads could lead to regressions or security holes.

**Hashes explained (beginner-friendly):** A hash like SHA-256 is a "digital fingerprint"—a fixed-length string (64 hex chars for SHA-256) unique to the input data. Change one byte, and the hash changes entirely. Proposals include hashes for WASM/binaries/docs; recompute them locally to verify integrity. Example: Hash a PDF with `sha256sum file.pdf` (Linux) or `shasum -a 256 file.pdf` (Mac). Tools: `sha256sum` (Linux), `shasum` (Mac), or online (but prefer local for security).

**Git commits:** Snapshots of code changes in repos (e.g., GitHub). Identified by 40-hex SHA-1 hashes (e.g., `ec35ebd252d4ffb151d2cfceba3a86c4fb87c6d6`). Proposals reference commits—verify existence via GitHub API (GitHub-rest-api-javascript.txt: `GET /repos/{owner}/{repo}/commits/{sha}`).

**Arguments (payload):** Data like Candid-encoded params or hex bytes. Verify by re-encoding (e.g., with `didc`) and hashing; match `arg_hash`.

**Binaries:** Executables like WASM (canisters) or IC-OS images (.tar.zst). Rebuild from commit (e.g., via `repro-check.sh` from ic repo README) and hash; match `wasm_module_hash` or `release_package_sha256_hex`.

From proposal-topics-and-types.txt: Proposals group by topics (e.g., ProtocolCanisterManagement for NNS upgrades). Verification varies by type (binaries for code, docs for providers).

**Rewards:** Participation earns voting rewards (governance topic = 20x weight).

## Workflow Diagram (ASCII)

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

1. **Fetch:** Use app or `dfx canister call` on governance canister (IDL in governance-canister-rrkah-fqaaa-aaaaa-aaaaq-cai-IDL.txt).
2. **Extract:** Parse for commits/hashes/URLs (app auto-does; manual: grep summary).
3. **Rebuild/Hash:** Type-specific (e.g., IC-OS: `repro-check.sh` from GitHub ic repo).
4. **Check Integrity:** Match hashes; review forum/wiki.
5. **Share:** Post results/logs to forum.dfinity.org (Governance > NNS proposal discussion).

**Common problems:** 
- **Hash mismatch:** Wrong encoding (use `didc` for Candid); mismatched file versions (download exact URL); commit errors (checkout precisely). Solution: Diff files, retry build.
- **Build fails:** Missing deps (e.g., Docker); wrong OS (use Ubuntu 22.04 VM). Solution: Follow setup; clean repo (`git clean -fdx`).
- **CORS blocks browser fetch:** Use canister HTTPS outcalls (http-outcalls.txt) for non-CORS URLs.

## Setup and Dependencies

Use a clean environment (VM/Docker) to avoid tampering risks. Ubuntu 22.04 recommended for repro-builds (ic GitHub README: verifying-releases).

### Windows (WSL for Linux-like setup)
1. Install WSL: PowerShell (admin): `wsl --install` (reboot).
2. In WSL (Ubuntu): `sudo apt update && sudo apt install git curl docker.io jq build-essential sha256sum xxd`.
3. Rust/didc: `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`, then `cargo install didc`.
4. Docker in WSL: Install Docker Desktop (Windows), enable WSL integration.

**Common issues:** Docker not starting—ensure WSL2 backend; low resources—increase VM limits in .wslconfig.

### macOS
1. Homebrew: `/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"`.
2. `brew install git curl docker jq rust sha256 shasum xxd`.
3. didc: Via Rust (`cargo install didc`).

**Common issues:** Docker permissions—add user to docker group; ARM vs x86—use Rosetta for x86 builds.

### Linux (Ubuntu 22.04+)
1. `sudo apt update && sudo apt install git curl docker.io jq build-essential sha256sum xxd`.
2. Rust/didc: `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`, then `cargo install didc`.
3. Docker: `sudo usermod -aG docker $USER` (logout/login).

**Common issues:** Docker without sudo—restart after group add; package conflicts—use `apt autoremove`.

**Tools explained:**
- `git`: Clone repos (e.g., `git clone https://github.com/dfinity/ic`).
- `docker`: Reproducible builds (e.g., IC-OS).
- `sha256sum`/`shasum -a 256`: Hash files.
- `didc`: Encode Candid (e.g., `didc encode '(record { ... })' | xxd -r -p | sha256sum`).
- `curl`: Download (e.g., packages).
- `jq`: Parse JSON (e.g., GitHub API).
- `xxd`: Hex ↔ bytes.

Test: `echo "test" > file.txt && sha256sum file.txt` (expect `f2ca1bb...`).

From GitHub-rest-api-javascript.txt: Use `curl` for API (e.g., commit check).

## Proposal Types and What to Verify

From proposal-topics-and-types.txt: Verify per topic/type. Use NNS dapp/dashboard.internetcomputer.org or app to view.

- **ProtocolCanisterManagement** (e.g., InstallCode): Rebuild WASM from commit (ic repo: `./ci/container/build-ic.sh -c`); match `wasm_module_hash`. Encode args with didc; match `arg_hash`. Check repo/commit on GitHub. Common: Build env mismatches—use Ubuntu/Docker.
  
- **ServiceNervousSystemManagement** (e.g., AddSnsWasm): Rebuild SNS WASM (sns repo README); match hash. Verify params. Common: Wrong branch—checkout commit precisely.

- **ApplicationCanisterManagement** (e.g., Bitcoin canister): App-specific rebuild (e.g., bitcoin-canister repo); match WASM hash/args. Common: Missing deps—install per README.

- **IcOsVersionElection** (e.g., ReviseElectedGuestosVersions): Verify commit; rebuild IC-OS (`repro-check.sh -c COMMIT` from ic GitHub README); match hashes. Common: Script fails—ensure Docker runs.

- **IcOsVersionDeployment** (e.g., DeployGuestosToAllSubnetNodes): Download package from URL; `sha256sum`; match `release_package_sha256_hex`. Common: Partial download—use `curl -fsSL URL -o file`.

- **Governance** (e.g., Motion): No binaries; review summary/forum (forum.dfinity.org). Common: Misinterpretation—discuss in threads.

- **SnsAndCommunityFund** (e.g., CreateServiceNervousSystem): Verify params/token dist/swap/Neurons' Fund; hash docs. Common: Complex params—parse JSON/Candid.

- **NetworkEconomics**: Review param changes (e.g., rewards); no hashes—manual rationale check.

- **SubnetManagement** (e.g., CreateSubnet): Verify IDs/configs; no hashes usually. Common: Invalid nodes—check topology.

- **ParticipantManagement** (e.g., AddNodeProvider): Hash PDFs from wiki; match proposal. Check forum/wiki. Common: Wrong file—download exact URL.

- **NodeAdmin** (e.g., UpdateNodeOperatorConfig): Verify IDs/allowances vs topology.

- **KYC** (e.g., ApproveGenesisKYC): Verify principals match list; manual.

- **NeuronManagement**: Verify target neuron/permissions; manual.

From Verify-Proposals.txt: For DFINITY proposals, check forum posts; rebuild from ic repo. Use HTTPS outcalls (http-outcalls.txt) for fetches if needed (app uses for GitHub/ic-api).

## Step-by-Step Verification with Proposal Verifier App

The app (dfx-deployed) fetches proposals, extracts data, assists hashing. Setup: `dfx new proposal_verifier`, add files, `dfx deploy`. Open frontend.

1. **Setup App:** `npm install` (frontend), `dfx deploy`. Open URL.

2. **Login:** Use Internet Identity (II) for auth/billing (II docs: InternetIdentity.txt).

3. **Fund Balance:** Copy deposit address; send ICP (0.5+). Click “Refresh balances” (credits from ledger subaccount). Common: Wrong address—double-check; low balance—send more.

4. **Fetch Proposal:** Enter ID (e.g., 129394); click “Fetch” (costs 0.2 ICP + fee). Common: Invalid ID—check dashboard; fee error—fund first.

5. **Review Extracted Data:** Check repo/commit (auto-verifies GitHub), hashes, URLs. Common: Missing commit—manual add from summary.

6. **Verify Arg Hash:**
   - Paste args (e.g., Candid from payload snippet).
   - Select type (Candid → encode with didc command from app).
   - Click “Verify”; match ✅. Common: Mismatch—wrong encoding; use `didc encode '(record { ... })' | xxd -r -p | sha256sum`.

7. **Verify Docs/Files:** Upload files (e.g., PDFs); app hashes & compares. Or fetch URLs (text only). Common: CORS block—use canister fetch; binary—upload local.

8. **Rebuild Locally:** Copy rebuild script; run in terminal; compare hash to expected. Common: Fails—check deps/OS; clean repo.

9. **Checklist:** Mark items (e.g., “Rebuild Done”); app tracks. Override for manual (e.g., policy review).

10. **Share:** Export JSON/Markdown; post to forum.dfinity.org with results/logs. Common: Incomplete—include mismatches.

From project files: Backend fetches from governance (main.mo: `get_proposal_info`); augments with ic-api (HTTPS outcalls). Frontend: lit-html UI (App.js).

## Step-by-Step Verification Manually (Without App)

Parallel to app; use tools from setup.

1. **Fetch Proposal:** `dfx canister call rrkah-fqaaa-aaaaa-aaaaq-cai get_proposal_info '(ID)' --network ic` (IDL: governance-canister-rrkah-fqaaa-aaaaa-aaaaq-cai-IDL.txt). Or dashboard.internetcomputer.org/proposal/ID. Common: Wrong network—use `--network ic`.

2. **Extract Data:** Parse Candid for summary/URLs/commit/hashes (use jq for JSON from ic-api.internetcomputer.org/api/v3/proposals/ID). Common: Candid parse—use `didc decode`.

3. **Verify Commit:** `curl https://api.github.com/repos/OWNER/REPO/commits/SHA` (GitHub-rest-api-javascript.txt); check 200. Common: Rate limit—use token.

4. **Verify Arg Hash:**
   - Extract args from payload (Candid? `didc encode ‘(record { … })’ | xxd -r -p | sha256sum`).
   - Compare to `arg_hash`. Common: Encoding error—match fields/order.

5. **Verify Docs/Files:** Download from URL; `sha256sum file.pdf`; match proposal (Verify-Proposals.txt). Common: Wrong URL—check summary.

6. **Rebuild Binaries:**
   - IC-OS: Clone ic repo, checkout commit, `repro-check.sh` (ic GitHub: verifying-releases).
   - WASM: Clone repo, build (`./ci/container/build-ic.sh -c`); `sha256sum artifact`. Match `wasm_module_hash`. Common: Env mismatch—use Ubuntu 22.04/Docker.

7. **Checklist:** Track manually (notes). Common: Miss steps—use diagram.

8. **Share:** Post hashes/results/logs to forum.dfinity.org (Governance > NNS proposal discussion). Common: Vague—include commands/outputs.

From http-outcalls.txt: For custom tools, use canister HTTPS (but manual uses curl; CORS-safe).

## Sharing Results

Post to forum.dfinity.org (Governance > NNS proposal discussion; tag topic). Include: ID, hashes (yours vs. proposal), rebuild logs, mismatches, commands/versions. Example: “Verified #129394: WASM hash matches [your hash]. Args match after didc encode.” Use Gist/GitHub for logs/scripts.

**Why share?** Builds community trust; enables reproduction. Common: Private—post publicly for decentralization.

## Troubleshooting

- **Hash Mismatch:** Wrong encoding (`didc` for Candid); file diffs (use `diff`); commit errors (verify GitHub). Solution: Re-encode; download exact; checkout commit.
- **Build Fails:** Missing deps (install per setup); wrong OS (Ubuntu VM); dirty repo (`git clean -fdx`). Solution: Follow README; retry.
- **CORS/Outcalls:** Dynamic sites—use browser; non-CORS—canister HTTPS (http-outcalls.txt: consensus agrees on response).
- **didc Errors:** Syntax—match Motoko grammar (motoko-grammar.txt); install Rust.
- **Proposal Not Found:** Wrong ID—check dashboard; network—use `--network ic`.
- **Balances/Fees:** Low—fund deposit; wrong subaccount—refresh.
- **App-Specific:** Fetch fails—login/fund; CORS—use canister fetch.

From FAQ.js: See FAQ for more (e.g., WSL issues: enable Docker; macOS: Colima alternative).

This guide (3 pages) ensures accessible verification, promoting ICP’s decentralization. For app: dfx project files integrate backend (Motoko: HTTPS outcalls for GitHub/ic-api) with frontend (JS: lit-html UI, sha256).