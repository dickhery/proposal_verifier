// src/proposal_verifier_frontend/src/FAQ.js
import { html } from 'lit-html';
import { unsafeHTML } from 'lit-html/directives/unsafe-html.js';

export function FAQView({ onBack }) {
  return html`
    <main>
      <nav class="topbar">
        <button class="btn" @click=${onBack}>&larr; Back to Verifier</button>
        <h1 class="grow">IC Proposal Verification – FAQ</h1>
      </nav>

      <section class="advisory">
        <h2>Important Advisory</h2>
        <p>
          The <b>IC Proposal Verifier</b> is a helper tool. It surfaces proposal data, URLs, and
          helps you compute and compare hashes. <b>Manual, independent verification</b> (shell,
          reproducible builds, and careful reading of sources) remains the most reliable way to
          ensure proposal integrity. Use this app to accelerate and document your work—not to
          replace it.
        </p>
      </section>

      ${section('1. Purpose & Context', [
        qa(
          '1) What does “proposal verification” mean on the Internet Computer?',
          `
            It’s the process of independently confirming that the <em>payload</em> of an NNS
            proposal (e.g., a Wasm upgrade, IC-OS release image, or a set of PDF documents) and
            any linked source (e.g., Git commit) are exactly what the proposer claims. At minimum,
            you: (a) fetch the referenced artifact(s), (b) compute a cryptographic hash
            (typically SHA-256), and (c) compare against the hash in the proposal or official docs.
          `,
          helper()
        ),
        qa(
          '2) Why should I care about verifying proposals if the system already works?',
          `
            Decentralization depends on <em>many eyes</em>. Independent verification reduces
            central points of trust and catches accidental or malicious mismatches. It also
            teaches the community how to reproduce builds, increasing transparency and resilience.
          `,
          helper()
        ),
        qa(
          '3) How does proposal verification strengthen decentralization and trust?',
          `
            When multiple community members independently rebuild/rehash artifacts and reach the
            same result, it forms a distributed attestation that’s hard to subvert. Over time,
            reproducibility and public verification reports become a norm.
          `,
          helper()
        ),
        qa(
          '4) What risks exist if proposals are not independently verified?',
          `
            Risks include unverified binaries running in governance-critical places, tampered
            documents, or reference commits that don’t match the artifact. These reduce trust and
            can lead to governance capture or operational regressions.
          `,
          helper()
        ),
      ])}

      ${section('2. Proposal Basics', [
        qa(
          '5) What is a proposal in the NNS (Network Nervous System)?',
          `
            An on-chain request for a governance action (e.g., upgrade a canister, adopt an IC-OS
            version, add a node provider, etc.). It contains metadata (title, summary, links),
            a <em>payload</em> (arguments), and often <em>hashes</em> of referenced artifacts.
          `,
          helper('We fetch the summary, links, payload snippet, and hashes to prefill your checklist.')
        ),
        qa(
          '6) What kinds of proposals exist (IC-OS, canister upgrades, SNS elections, Node Participant Management, governance motions)?',
          `
            Common classes include: <b>IC-OS version elections</b> (replica/guestOS images),
            <b>Protocol canister upgrades</b> (e.g., NNS canisters), <b>SNS management</b>,
            <b>Subnet/Node admin</b>, <b>Participant management</b> (e.g., node-provider
            onboarding with PDF hashes), <b>Application canister</b> upgrades, and <b>governance
            motions</b> (text-only intent).
          `,
          helper('We try to classify from text and surface type-specific tips.')
        ),
        qa(
          '7) Which types of proposals need technical verification and which do not?',
          `
            <b>IC-OS</b> and <b>Protocol Canister</b> upgrades require technical verification
            (repro-build or reproducible hashing). <b>Participant management</b> requires document
            hashing checks. <b>Motion</b> proposals are typically policy statements (manual review).
          `,
          helper()
        ),
        qa(
          '8) What information does a proposal contain (metadata, payload, hashes)?',
          `
            You’ll usually see a summary/links, payload arguments (often Candid-encoded),
            and <em>hash fields</em> like <code>expected_hash</code>, <code>wasm_module_hash</code>,
            or a PDF’s SHA-256 in the summary/docs. The dashboard/API exposes these and links to
            the forum/wiki for context.
          `,
          helper('We show a payload snippet (when available) and look for nearby 64-hex hashes and official release URLs.')
        ),
      ])}

      ${section('3. Key Components', [
        qa(
          '9) What is the <code>args_hash</code> and why is it important?',
          `
            It’s the SHA-256 digest of the proposal’s <em>arguments</em> (payload). Matching it
            confirms the payload wasn’t altered. For text/JSON-style args, hash the exact bytes you
            would submit; for Candid, encode first, then hash the bytes.
          `,
          helper('Paste args into the app to hash. For Candid, prepare the precise bytes first, then hash.')
        ),
        qa(
          '10) What is the <code>wasm_hash</code> and how is it different from the <code>args_hash</code>?',
          `
            <code>wasm_hash</code> fingerprints the code being installed (Wasm module). It differs
            from <code>args_hash</code>, which fingerprints the <em>parameters</em> to that code.
            For upgrades you typically compare both (where applicable).
          `,
          helper('Use the app to re-hash local Wasm files (or confirm expected Wasm hash from the proposal/dashboard).')
        ),
        qa(
          '11) What is the proposal payload and how do I decode it?',
          `
            The payload is the action’s parameters (Candid). To decode/encode consistently,
            use standard tools (<code>didc</code>, <code>ic-repl</code>) with the exact .did.
            Then hash the <em>bytes</em> of the encoded payload, not the pretty-printed text.
          `,
          helper('We display a payload snippet to orient you, but hashing must use the exact bytes you submit on-chain.')
        ),
        qa(
          '12) Why do some proposals include a Git commit hash or repository link?',
          `
            To tie binaries (IC-OS image or Wasm) to a specific source snapshot. You should confirm
            the commit exists upstream and, for IC-OS, run the published verification/build script
            pinned to that commit.
          `,
          helper('We check the commit via GitHub API and link to the precise commit page when detected.')
        ),
      ])}

      ${section('4. Tools & Setup', [
        qa(
          '13) What tools do I need to verify proposals?',
          `
            <b>General</b>: <code>curl</code>, <code>sha256sum</code>, <code>jq</code>.<br/>
            <b>Canister upgrades</b>: <code>dfx</code>, <code>didc</code>, <code>ic-repl</code> (optional),
            and sometimes <code>docker</code>/<code>podman</code> if you rebuild.<br/>
            <b>IC-OS</b>: Docker/Podman and the IC repo’s pinned <code>repro-check</code> command/script.
          `,
          helper('The app displays quick shell lines and expected hashes you can copy.')
        ),
        qa(
          '14) How do I install and configure these tools?',
          `
            Use your OS package manager for basics (<code>curl</code>, <code>sha256sum</code>, <code>jq</code>).
            Install <code>dfx</code> from DFINITY docs, and Docker/Podman from their official instructions.
            For <code>didc</code>/<code>ic-repl</code>, see their GitHub releases or cargo installs.
          `,
          helper()
        ),
        qa(
          '15) Environment setup on WSL, macOS, Linux?',
          `
            <b>WSL</b>: Ubuntu 22.04+ recommended; ensure Docker Desktop integration if using Docker.
            <b>macOS</b>: Docker Desktop/Colima, Homebrew for CLI tools.
            <b>Linux</b>: Ubuntu 22.04+ is the reference for IC-OS verification.
          `,
          helper()
        ),
        qa(
          '16) Common environment issues & fixes?',
          `
            Disk space (IC-OS builds are large), memory (16GB+ recommended), proper Docker/Podman
            permissions, and using the <em>commit-pinned</em> repro-script to avoid mismatches with
            evolving build scripts. If a curl script 404s, verify the commit and path.
          `,
          helper('We surface the commit and provide curl commands with the pinned commit ID if present.')
        ),
      ])}

      ${section('5. Workflow: General Steps', [
        qa(
          '17) What are the standard steps in verifying any proposal?',
          `
            (1) Read the summary; collect URLs, commits, expected hashes.<br/>
            (2) Fetch artifacts (doc, Wasm, tar.zst).<br/>
            (3) Compute <code>sha256</code> of the artifact.<br/>
            (4) Compare to the proposal/dashboard.<br/>
            (5) If necessary, rebuild from source and compare hash.<br/>
            (6) Publish a short, reproducible report.
          `,
          helper('The app extracts links/hashes, gives quick hash helpers, and a checklist you can mark off.')
        ),
        qa(
          '18) How do I fetch a proposal from the dashboard versus the CLI?',
          `
            Dashboard: open the proposal page; copy links/hashes. CLI: query governance canister or the public
            dashboard API to retrieve proposal JSON. Your goal is to identify text, payload, and referenced URLs.
          `,
          helper('Enter a proposal ID; the app pulls key data and links for you.')
        ),
        qa(
          '19) How do I check the <code>args_hash</code> against the arguments provided?',
          `
            Compute SHA-256 over the exact <em>bytes</em> of the encoded arguments. For JSON-ish payloads, ensure byte-for-byte reproduction (spacing, encoding). For Candid, encode with the correct .did first, then hash.
          `,
          helper('Paste arguments text for quick hashing; for Candid, hash the encoded bytes you provide on-chain.')
        ),
        qa(
          '20) How do I rebuild and check the <code>wasm_hash</code> for a canister upgrade?',
          `
            Clone the repo at the referenced commit; follow the README/build instructions to produce the Wasm.
            Then run <code>sha256sum</code> on the produced file and compare with the proposal’s <code>wasm_hash</code>.
          `,
          helper('We show an artifact path hint (when present) and a type-specific rebuild guide block.')
        ),
        qa(
          '21) How do I verify an IC-OS release and Protocol Canister Management proposal?',
          `
            IC-OS: use the commit-pinned <code>repro-check</code> command from the IC repo, or the commands posted
            in the proposal summary. Compare the resulting image’s hash. Protocol canisters: rebuild Wasm or verify the published hash and provenance.
          `,
          helper('We show release URLs and a command block to copy, including expected hash comparison.')
        ),
        qa(
          '22) How do I verify Node Provider Rewards / Participant Management proposals?',
          `
            Download the exact documents (self-declaration, identity proofs) from the wiki/forum link. Compute SHA-256 of each file and confirm each hash matches the proposal’s listed values. Sanity-check identity and context.
          `,
          helper('Per-doc upload fields let you hash locally and visually confirm each match.')
        ),
        qa(
          '23) How do verification steps differ across types?',
          `
            IC-OS focuses on reproducible build of the update image; canister upgrades on Wasm hashing/rebuild;
            participant management on document hash checks; motions on human reasoning and references.
          `,
          helper()
        ),
      ])}

      ${section('6. Source Code & Git Verification', [
        qa(
          '24) How do I find the source code referenced in a proposal?',
          `
            Look for GitHub links in the summary (often to <code>dfinity/ic</code> or relevant repo) and a commit SHA.
            If absent, check the forum post linked from the proposal for the commit reference.
          `,
          helper('We extract repo/commit from the summary and link the commit page when available.')
        ),
        qa(
          '25) How do I check out the correct Git commit for rebuilding?',
          `
            <code>git clone</code>, <code>git checkout &lt;commit&gt;</code>. Always use the <em>exact</em> commit hash from the proposal text or official post to avoid drift.
          `,
          helper('We show the detected commit and link it, plus an IC-OS rebuild snippet pinned to that commit (when applicable).')
        ),
        qa(
          '26) How do I verify that the Git commit has not been tampered with?',
          `
            Use the GitHub REST API or the web UI to confirm the commit exists on the upstream and review the diff.
            Optionally, check maintainer signatures/tags for authenticity in sensitive repos.
          `,
          helper('We call <code>GET /repos/{owner}/{repo}/commits/{ref}</code> and show an explicit “Commit exists” indicator.')
        ),
        qa(
          '27) What role do signed commits or tags play in ensuring authenticity?',
          `
            A verified signature demonstrates the author controls certain keys/identity. While not always used,
            it increases confidence. For releases, signed tags or reproducible builds are common assurance methods.
          `,
          helper()
        ),
        qa(
          '28) How do I confirm that the source matches the published binary or wasm?',
          `
            Rebuild deterministically from the commit and compare the output’s SHA-256 to the proposal/on-chain hash.
            For IC-OS, follow the IC repo’s pinned script; for canisters, follow the repo’s build instructions.
          `,
          helper()
        ),
      ])}

      ${section('7. Builds & Binaries', [
        qa(
          '29) What does it mean to perform a reproducible build?',
          `
            If independent builders on clean machines—following the same steps—produce bit-identical artifacts
            (same hash). This is the gold standard for trust-minimized upgrades.
          `,
          helper()
        ),
        qa(
          '30) Why does DFINITY use Podman/Docker and how does it help reproducibility?',
          `
            Containerized environments control toolchain and dependencies, reducing differences across machines and
            improving the chance of byte-identical outputs from the same commit.
          `,
          helper()
        ),
        qa(
          '31) How do I compare my locally built wasm with the on-chain <code>wasm_hash</code>?',
          `
            Run <code>sha256sum</code> on your local output (or <code>shasum -a 256</code> on macOS) and compare to
            the hash shown in the dashboard/proposal summary.
          `,
          helper('We surface the expected hash and show where it was found (dashboard/API/summary).')
        ),
        qa(
          '32) How do I verify IC-OS binaries against source code and published hashes?',
          `
            Use the IC repo’s repro-check command pinned to the proposal’s commit. It downloads/builds the right bits
            and prints the image’s hash to compare with the proposal’s expected value.
          `,
          helper('We auto-display “Release Package Commands” if we detect official release links in the payload.')
        ),
        qa(
          '33) What should I do if the binary hash does not match the on-chain proposal?',
          `
            Double-check your environment (OS, RAM, disk space, container engine), the exact commit, and the exact
            script/flags used. If the mismatch persists, share logs and steps publicly; it might reveal an error in
            either your process or the proposal materials.
          `,
          helper('We can’t fix a mismatch, but the app helps you gather URLs/hashes and produce a clean, copyable report.')
        ),
      ])}

      ${section('8. Hashing & Integrity', [
        qa(
          '34) How do I compute a hash (sha256sum, shasum, etc.) for wasm or args?',
          `
            Examples: <code>sha256sum file.wasm</code> (Linux), <code>shasum -a 256 file.wasm</code> (macOS).
            For arguments, hash the <em>exact bytes</em> to be submitted (Candid-encoded or raw JSON).
          `,
          helper('Upload or paste content to compute SHA-256 in the browser (WebCrypto) for quick checks.')
        ),
        qa(
          '35) How do I confirm I am hashing the correct file and not a modified version?',
          `
            Always obtain artifacts from the canonical URL (wiki, GitHub release, DFINITY “download” host, etc.),
            and avoid re-saving or re-encoding. Keep a clean workspace and record exact commands/URLs.
          `,
          helper()
        ),
        qa(
          '36) Why is SHA-256 used as the hashing algorithm for ICP proposals?',
          `
            SHA-256 is widely supported, collision-resistant for practical purposes, and standardized across tools.
            It’s a pragmatic, secure default for integrity checks.
          `,
          helper()
        ),
        qa(
          '37) How do I hash Candid arguments for comparison with <code>args_hash</code>?',
          `
            Encode arguments to their binary Candid representation with the correct .did and <em>then</em> hash those bytes.
            Pretty-printed Candid text is not the same as the submitted bytes.
          `,
          helper()
        ),
      ])}

      ${section('9. Troubleshooting', [
        qa(
          '38) What should I do if my hash does not match the proposal’s <code>args_hash</code>?',
          `
            Confirm you used the exact byte encoding (Candid vs JSON), identical field ordering and whitespace (if JSON),
            and the correct input file. Try re-fetching the artifact and diffing bytes.
          `,
          helper()
        ),
        qa(
          '39) What should I do if my wasm build does not match the on-chain <code>wasm_hash</code>?',
          `
            Clean and rebuild in the recommended environment (often Ubuntu 22.04+). Ensure toolchain versions match,
            use the pinned scripts, and rebuild from the exact commit. Share a minimal log if mismatch persists.
          `,
          helper()
        ),
        qa(
          '40) How do I resolve issues unique to WSL, Linux, or macOS?',
          `
            WSL: enable Docker integration and sufficient memory/disk. Linux: confirm user is in <code>docker</code>
            group or use rootless podman. macOS: sometimes prefer Colima; use <code>shasum -a 256</code>.
          `,
          helper()
        ),
        qa(
          '41) When should I conclude that the mismatch might be in the proposal itself?',
          `
            When independent verifiers, using the official commit/script, all get the same different hash. Escalate
            with a public write-up so the proposer can correct the record or explain the difference.
          `,
          helper()
        ),
      ])}

      ${section('10. Automation & Reporting', [
        qa(
          '42) Can proposal verification be automated with scripts or tooling?',
          `
            Yes—scripts can fetch proposals, extract URLs/hashes, run <code>sha256sum</code>, and store results.
            For IC-OS, orchestration can invoke the pinned repro command automatically.
          `,
          helper('Our app’s output and commands are easily copyable for your scripts; you can also print the checklist result.')
        ),
        qa(
          '43) What existing tools or dashboards help automate verification?',
          `
            The ICP Dashboard exposes proposal pages and JSON APIs; GitHub APIs help verify commits; the IC repo
            provides repro-scripts for IC-OS. Community dashboards sometimes summarize weekly releases and hashes.
          `,
          helper()
        ),
        qa(
          '44) How can I write a simple script to check <code>args_hash</code> and <code>wasm_hash</code>?',
          `
            Use <code>curl</code> to fetch proposal JSON; parse out expected hashes (with <code>jq</code>), download the
            referenced file(s), compute <code>sha256sum</code>, and diff values. For Candid args, use <code>didc</code>
            to encode first, then hash.
          `,
          helper()
        ),
        qa(
          '45) How do I structure a verification report so others can reproduce it?',
          `
            Include: proposal ID, links, commit, commands used (with versions), exact hashes observed, and a short
            checklist result. Keep it concise and copy-pastable.
          `,
          helper('Use the app’s “Relevant Links”, “Release Commands”, and “Checklist” sections as a starter for your report.')
        ),
        qa(
          '46) Where can I publish and share my verification results?',
          `
            Post on the DFINITY forum thread for the proposal, GitHub gists/repos, and governance community channels.
            The goal is discoverability and reproducibility.
          `,
          helper()
        ),
      ])}

      ${section('11. Security & Best Practices', [
        qa(
          '47) How do I ensure I am not downloading tampered binaries or source code?',
          `
            Prefer official hosts: GitHub (correct org/repo/commit), DFINITY download endpoints, the IC wiki,
            and the links embedded in the proposal summary/dashboard. Beware shortened or third-party mirrors.
          `,
          helper()
        ),
        qa(
          '48) What precautions should I take when building from source (sandboxing, isolation)?',
          `
            Use containers or VMs, restrict privileges, and dedicate a clean workspace. Capture a log of commands
            and output for traceability.
          `,
          helper()
        ),
        qa(
          '49) Why should I never rely only on published binaries without verification?',
          `
            Binaries can be swapped or corrupted in transit. Hashes and reproducible builds provide integrity and
            provenance guarantees that simple downloads do not.
          `,
          helper()
        ),
        qa(
          '50) How do I cross-check official artifacts published by DFINITY or other developers?',
          `
            Match the download URL, commit, and hash against the proposal text, IC Dashboard, forum announcement,
            and repository README. They should all agree on commit and expected hash.
          `,
          helper()
        ),
        qa(
          '51) What community standards or norms exist for verification transparency?',
          `
            Publish minimal, reproducible logs and hashes; link to the exact commit; pin commands to specific versions;
            and collaborate on public threads to converge on shared, verifiable results.
          `,
          helper()
        ),
      ])}
    </main>
  `;
}

function section(title, content) {
  return html`
    <section>
      <h2>${title}</h2>
      ${content}
    </section>
  `;
}

function qa(question, answerHtml, appHelpHtml) {
  return html`
    <details class="faq">
      <summary><b>${unsafe(question)}</b></summary>
      <div class="qa">
        <p>${unsafe(answerHtml)}</p>
        <p class="helper"><b>How this app helps:</b> ${unsafe(appHelpHtml)}</p>
      </div>
    </details>
  `;
}

function helper(extra = 'It reduces copy/paste errors by surfacing links and expected hashes and gives you copyable shell snippets.') {
  return extra;
}

function unsafe(str) {
  // We only ever pass our own hard-coded strings here (no user input).
  return unsafeHTML(str);
}
