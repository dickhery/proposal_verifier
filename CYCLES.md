# Cycles Usage in the IC Proposal Verifier App

This document provides an in-depth explanation of how the IC Proposal Verifier app consumes cycles, with a focus on HTTPS outcalls (also known as canister HTTP requests). Cycles are the computational resource units on the Internet Computer Protocol (ICP) blockchain, used to pay for operations like message execution, storage, and external interactions. The app's primary billed action—fetching and augmenting a proposal—relies heavily on HTTPS outcalls to gather data from external sources, which drives most of its cycle consumption.

We'll cover:
- **How cycles are used**: The mechanics of HTTPS outcalls and cycle budgeting.
- **Outcalls per proposal fetch**: A breakdown of requests during a typical `getProposalAugmented` call.
- **Why cycles vary per proposal**: Factors like proposal type, response sizes, and retries.
- **Mitigations and best practices**: How the app optimizes and what users can do.

## Background: HTTPS Outcalls and Cycles on ICP

HTTPS outcalls allow canisters to make HTTP requests to external web servers (e.g., APIs like GitHub or the ICP Dashboard). Unlike traditional Web2 HTTP calls, ICP outcalls must achieve **consensus** across subnet replicas to ensure deterministic execution and prevent state divergence. This involves:

1. **Request preparation**: The canister builds an `HttpRequestArgs` with URL, headers, max response bytes, and an optional transform function (to normalize responses across replicas).
2. **Cycle escrow**: Before sending, the canister adds cycles via `Cycles.add` to cover the request. The amount is estimated based on ICP's public pricing formula (see below).
3. **Execution across replicas**: Each replica (typically 13 on the NNS subnet) independently sends the request, receives a response, applies the transform, and submits it to consensus.
4. **Consensus**: At least 2/3 of replicas (9/13) must agree on the exact response for success. If not, the call fails.
5. **Refund**: Unused cycles are refunded, but the base cost is burned regardless.

### Cycle Pricing Formula for Outcalls
ICP charges cycles based on:
- **Base fee**: 3,000,000 cycles (request) + 60,000 cycles per replica (consensus), multiplied by the number of replicas (N=13). Total base: (3M + 60K * N) * N ≈ 1.3B cycles.
- **Size fees**: 400 cycles per request byte + 800 cycles per response byte, multiplied by N.
- **Overhead**: The app adds a cushion (5M cycles) and enforces a minimum (200M cycles) to avoid failures.

The app uses a precise estimator (`estimateHttpOutcallCycles`) mirroring this formula, plus a retry buffer (10% extra or min 100M cycles) for up to 2 attempts if under-escrowed or transient errors.

**Key insight**: Cycles are charged based on the **maximum response bytes** specified (`max_response_bytes`), not the actual size received. This is why the app caps responses tightly (e.g., 200KB for GitHub commits) to minimize costs. Larger caps burn more cycles upfront, even for small responses.

For details on ICP's outcall architecture, see the [HTTPS outcalls documentation](https://internetcomputer.org/docs/building-apps/network-features/using-http/https-outcalls/overview).

## How Cycles Are Used in the App

The app's cycle burn is dominated by HTTPS outcalls in the backend canister (`proposal_verifier_backend`). These occur during:
- **Proposal augmentation** (`getProposalAugmented`): Fetches external data to enrich on-chain proposal info.
- **Git commit checks** (`checkGitCommit`): Verifies commit existence via GitHub API.
- **Document fetches** (`fetchDocument`): Retrieves files/checksums for hash verification.

Non-outcall operations (e.g., on-chain calls to NNS governance, local hashing) consume negligible cycles compared to outcalls.

### User Billing vs. Cycle Burn
- **ICP fee**: Users pay a flat 0.2 ICP (20M e8s) per fetch via ledger transfer to a beneficiary account (`2ec3dee16236d389ebdff4346bc47d5faf31db393dac788e6a6ab5e10ade144e`). This funds the canister's cycles indirectly.
- **Cycle source**: Outcalls burn cycles from the **canister's balance**, not the user's deposit. The app requires a minimum canister balance (3T cycles) before allowing fetches to avoid failures.
- **Why separate?**: Fees ensure sustainable operation; cycles are escrowed per call for ICP's execution model.

Historical burns are tracked (`fetchCyclesHistory`, up to 100 entries) for transparency (e.g., average/last via `getFetchCycleStats`).

## HTTPS Outcalls per Proposal Fetch

A single `getProposalAugmented` call (triggered by "Fetch Proposal") can make **3–8+ outcalls**, depending on the proposal. Here's the breakdown:

1. **Core Proposal Fetch (0 outcalls)**:
   - Calls `governance.get_proposal_info` (on-chain, no HTTPS).

2. **IC-API JSON Fetch (1 outcall)**:
   - `fetchIcApiProposalJsonText`: GET `https://ic-api.internetcomputer.org/api/v3/proposals/{id}`.
   - Capped at 300KB; extracts hashes, payload snippets, etc.
   - Cached (up to 16 entries, TTL 5min, 1MB total) to avoid repeats.

3. **Type-Specific Fetches (0–5+ outcalls)**:
   - **IcOsVersionDeployment**:
     - Fetch release HTML (1 outcall): `tryFetchDashboardReleaseHtml` (GET dashboard release page, capped at 512KB).
     - Extract/filter SHA256SUMS links (0–N): For each checksum URL, `fetchText` (GET, capped at 512KB). Typically 1–3 per release.
   - Other types: No extra here.

4. **Optional User-Triggered (post-fetch)**:
   - `checkGitCommit`: GET GitHub API (1 outcall, capped at 200KB). Triggered separately.
   - `fetchDocument`: GET user-provided URL (1+ outcalls, capped at 1MB). For docs/checksums; user-initiated.

**Total per fetch**: 
- Base: 1 (ic-api JSON).
- IcOsVersionDeployment: +1–4 (release page + checksums).
- Variability: Retries (up to 2 per outcall) if under-escrowed or transient errors.

Each outcall burns ~200M–1.5B cycles (depending on sizes), so a full fetch can burn 1–10B cycles total.

## Why Cycles Vary per Proposal

Cycle burn isn't fixed—it scales with **proposal type**, **data fetched**, and **runtime factors**. Here's why:

### 1. **Proposal Type Drives Outcall Count**
   - **Simple types** (e.g., Governance/Motion): 1 outcall (ic-api JSON). Low burn (~500M cycles).
   - **Complex types** (e.g., IcOsVersionDeployment): + Release page (large HTML) + Multiple SHA256SUMS files. 3–6 outcalls; higher burn (2–5B cycles).
   - **ParticipantManagement**: May involve manual doc fetches (user-triggered, 1+ outcalls per doc).
   - **ProtocolCanisterManagement**: Often 1–2 outcalls (ic-api + optional GitHub commit check).
   - **Unknown/Other**: Minimal (1 outcall), but user may add fetches.

   Example: A motion proposal burns ~40% less than an IC-OS upgrade with 3 checksum files.

### 2. **Response Sizes and Max Caps**
   - Cycles scale with `max_response_bytes` (even if actual < max).
   - App uses tight caps (e.g., 200KB GitHub, 300KB ic-api) but larger proposals (big HTML/JSON) need bigger caps → more cycles.
   - Variability: A proposal with verbose payload snippet (e.g., long Candid) may hit higher sizes, burning 20–50% more.

### 3. **Retries and Failures**
   - If initial escrow underestimates (e.g., unexpectedly large response), retry adds cycles (10% buffer + min 100M).
   - Network issues (timeouts, server errors) trigger up to 2 retries per outcall, multiplying burn.
   - Rare: Adds 10–100% overhead per failed call.

### 4. **Caching Effects**
   - ic-api JSON cached (TTL 5min): Repeat fetches for same ID skip outcall (0 cycles).
   - No cache hit? Full burn.
   - Variability: First fetch for an ID burns more; repeats are free (until TTL expires).

### 5. **Subnet Replica Count (Fixed but Noted)**
   - NNS subnet has 13 replicas; formula multiplies by N twice.
   - If ICP changes subnet size, burn scales (app hardcodes 13; upgradable).

### 6. **User Actions Post-Fetch**
   - Base fetch: Fixed per type.
   - Extra: Commit check (+1), doc fetches (+1 each) add variable burn.
   - Total session burn varies with exploration.

**Observed Range**: From logs (`fetchCyclesHistory`), averages ~1–3B cycles/fetch, but outliers (many docs/large responses) hit 5–10B. History (last 100) helps predict.

## Mitigations and Best Practices

- **Tight Caps**: App uses endpoint-specific `max_response_bytes` (e.g., 200KB GitHub) to minimize escrow.
- **Caching**: Reduces repeats; prune old entries to free memory.
- **Retries**: Buffer prevents most failures; logs (`getFetchCycleStats`) track burn.
- **Users**: Fetch once per proposal; use browser for non-stable domains (0 cycles).
- **Monitoring**: Canister warns at low balance (<3T cycles); top-up via beneficiary fees.
- **Upgrades**: If the subnet replica count (N=13) changes or pricing evolves, upgrade the estimator.

For HTTP outcall details, see the [HTTPS outcalls documentation](https://internetcomputer.org/docs/building-apps/network-features/using-http/https-outcalls/overview). App code: `main.mo` (search `httpRequestWithRetries`, `estimateHttpOutcallCycles`).