// src/proposal_verifier_frontend/src/FAQ.js (elaborated)
import { html, nothing } from 'lit-html';
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
        <p>
          The app includes <b>Internet Identity authentication</b>, <b>built-in payments</b>, and an
          <b>end-to-end verification guide</b>. Logging in lets the backend attribute fetch costs to
          your deposit subaccount, while the guide walks you through every manual step so you can
          confidently verify proposals even outside the UI.
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
            <br/><br/>
            <b>Deep dive:</b>
            <ul>
              <li><b>Artifacts</b> include raw/gzipped Wasm files, IC-OS images, and human documents.</li>
              <li><b>Trust model</b>: do not assume provenance—prove it by reproducing bytes and hashes.</li>
              <li><b>Outcome</b>: a short report other community members can reproduce byte-for-byte.</li>
            </ul>
          `,
          helper()
        ),
        qa(
          '2) Why should I care about verifying proposals if the system already works?',
          `
            Decentralization depends on <em>many eyes</em>. Independent verification reduces
            central points of trust and catches accidental or malicious mismatches. It also
            teaches the community how to reproduce builds, increasing transparency and resilience.
            <br/><br/>
            <b>Deep dive:</b>
            <ul>
              <li><b>Risk reduction</b>: prevents supply-chain slips (wrong commit, wrong binary).</li>
              <li><b>Accountability</b>: public, reproducible logs make regressions easier to triage.</li>
              <li><b>Culture</b>: repeated community checks set expectations for publishable evidence.</li>
            </ul>
          `,
          helper()
        ),
        qa(
          '3) How does proposal verification strengthen decentralization and trust?',
          `
            When multiple community members independently rebuild/rehash artifacts and reach the
            same result, it forms a distributed attestation that’s hard to subvert. Over time,
            reproducibility and public verification reports become a norm.
            <br/><br/>
            <b>Deep dive:</b>
            <ul>
              <li><b>Multiple verifiers</b> → less reliance on a single operator or CI pipeline.</li>
              <li><b>Public artifacts</b>: commit IDs, scripts, and logs allow anyone to audit.</li>
              <li><b>Long-term memory</b>: reports form a searchable trail around critical upgrades.</li>
            </ul>
          `,
          helper()
        ),
        qa(
          '4) What risks exist if proposals are not independently verified?',
          `
            Risks include unverified binaries running in governance-critical places, tampered
            documents, or reference commits that don’t match the artifact. These reduce trust and
            can lead to governance capture or operational regressions.
            <br/><br/>
            <b>Deep dive (pitfalls):</b>
            <ul>
              <li>Hashing the <em>wrong file</em> (gz vs raw Wasm) and thinking it matches.</li>
              <li>Not pinning to the exact commit used in the proposal.</li>
              <li>Skipping argument <code>arg_hash</code> checks for install/upgrade proposals.</li>
            </ul>
          `,
          helper()
        ),
      ])}

      ${section('2. Proposal Basics', [
        qa(
          '5) What is a proposal in the NNS (Network Nervous System)?',
          `
            An on-chain request for a governance action (e.g., upgrade a canister, adopt an IC-OS
            version, add a node provider, etc.). It contains metadata (title, summary, links), a
            <em>payload</em> (arguments), and often <em>hashes</em> of referenced artifacts.
            <br/><br/>
            <b>What to look for:</b>
            <ul>
              <li>Proposal <b>ID</b>, <b>type</b>, and <b>status</b>.</li>
              <li>Payload (text rendering) and any <b>expected hashes</b> mentioned on the page.</li>
              <li>Forum/wiki links that expand on provenance or build steps.</li>
            </ul>
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
            <br/><br/>
            <b>Verification implications:</b>
            <ul>
              <li><b>IC-OS</b>: rebuild or verify release image + hash.</li>
              <li><b>Canisters</b>: rebuild Wasm, compare <code>wasm_hash</code>, check <code>arg_hash</code>.</li>
              <li><b>Participants</b>/Admin: verify document hashes and identities.</li>
            </ul>
          `,
          helper('We try to classify from text and surface type-specific tips.')
        ),
        qa(
          '7) Which types of proposals need technical verification and which do not?',
          `
            <b>IC-OS</b> and <b>Protocol Canister</b> upgrades require technical verification
            (repro-build or reproducible hashing). <b>Participant management</b> requires document
            hashing checks. <b>Motion</b> proposals are typically policy statements (manual review).
            <br/><br/>
            <b>Rule of thumb:</b> if bytes change on-chain (code or arguments), verify with hashes; if
            it’s human policy, verify with sources and reasoning.
          `,
          helper()
        ),
        qa(
          '8) What information does a proposal contain (metadata, payload, hashes)?',
          `
            You’ll usually see a summary/links, payload arguments (often Candid-encoded), and
            <em>hash fields</em> like <code>expected_hash</code>, <code>wasm_module_hash</code>, or a
            PDF’s SHA-256 in the summary/docs. The dashboard/API exposes these and links to the
            forum/wiki for context.
            <br/><br/>
            <b>Checklist:</b>
            <ul>
              <li>Capture <b>all hashes</b> shown (raw & gz).</li>
              <li>Note any <b>commit SHA</b> and repository links.</li>
              <li>Copy the <b>payload text</b> (or render) for later <code>arg_hash</code> work.</li>
            </ul>
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
            <br/><br/>
            <b>Practical tips:</b>
            <ul>
              <li>If payload is Candid, <b>never</b> hash human-readable pretty output—hash the
                  <em>encoded bytes</em> from <code>didc encode</code>.</li>
              <li>Beware whitespace/encoding differences in JSONish inputs; normalize precisely.</li>
            </ul>
          `,
          helper('Paste args into the app to hash. For Candid, prepare the precise bytes first, then hash.')
        ),
        qa(
          '10) What is the <code>wasm_hash</code> and how is it different from the <code>args_hash</code>?',
          `
            <code>wasm_hash</code> fingerprints the code being installed (Wasm module). It differs
            from <code>args_hash</code>, which fingerprints the <em>parameters</em> to that code.
            For upgrades you typically compare both (where applicable).
            <br/><br/>
            <b>Notes:</b>
            <ul>
              <li>Some proposals specify <b>gzipped</b> Wasm hash; compute for both raw and gz when in doubt.</li>
              <li>Match exact artifact names/paths from build scripts to avoid hashing the wrong file.</li>
            </ul>
          `,
          helper('Use the app to re-hash local Wasm files (or confirm expected Wasm hash from the proposal/dashboard).')
        ),
        qa(
          '11) What is the proposal payload and how do I decode it?',
          `
            The payload is the action’s parameters (Candid). To decode/encode consistently,
            use standard tools (<code>didc</code>, <code>ic-repl</code>) with the exact .did.
            Then hash the <em>bytes</em> of the encoded payload, not the pretty-printed text.
            <br/><br/>
            <b>Working recipe:</b>
            <ol>
              <li>Get the <code>.did</code> that defines the call.</li>
              <li>Use <code>didc encode '&lt;args&gt;'</code> to emit bytes.</li>
              <li>Pipe to <code>shasum -a 256</code> (mac) or <code>sha256sum</code> (Linux).</li>
            </ol>
          `,
          helper('We display a payload snippet to orient you, but hashing must use the exact bytes you submit on-chain.')
        ),
        qa(
          '12) Why do some proposals include a Git commit hash or repository link?',
          `
            To tie binaries (IC-OS image or Wasm) to a specific source snapshot. You should confirm
            the commit exists upstream and, for IC-OS, run the published verification/build script
            pinned to that commit.
            <br/><br/>
            <b>Good hygiene:</b>
            <ul>
              <li>Open the precise commit page and read the diff or tag notes.</li>
              <li>Prefer commands that <b>pin</b> the commit: <code>git checkout &lt;sha&gt;</code>.</li>
            </ul>
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
            <br/><br/>
            <b>Tip:</b> capture tool versions with <code>--version</code> in your report to help others reproduce.
          `,
          helper('The app displays quick shell lines and expected hashes you can copy.')
        ),
        qa(
          '14) How do I install and configure these tools?',
          `
            Use your OS package manager for basics (<code>curl</code>, <code>sha256sum</code>, <code>jq</code>).
            Install <code>dfx</code> from DFINITY docs, and Docker/Podman from their official instructions.
            For <code>didc</code>/<code>ic-repl</code>, see their GitHub releases or cargo installs.
            <br/><br/>
            <b>Environment hint:</b> add binaries to PATH and ensure Docker/Podman daemon is running before rebuilds.
          `,
          helper()
        ),
        qa(
          '15) Environment setup on WSL, macOS, Linux?',
          `
            <b>WSL</b>: Ubuntu 22.04+ recommended; ensure Docker Desktop integration if using Docker.
            <b>macOS</b>: Docker Desktop/Colima, Homebrew for CLI tools.
            <b>Linux</b>: Ubuntu 22.04+ is the reference for IC-OS verification.
            <br/><br/>
            <b>Resource planning:</b> IC-OS workflows may need tens of GBs of disk and &ge;16GB RAM.
          `,
          helper()
        ),
        qa(
          '16) Common environment issues & fixes?',
          `
            Disk space (IC-OS builds are large), memory (16GB+ recommended), proper Docker/Podman
            permissions, and using the <em>commit-pinned</em> repro-script to avoid mismatches with
            evolving build scripts. If a curl script 404s, verify the commit and path.
            <br/><br/>
            <b>Quick fixes:</b>
            <ul>
              <li>Add your user to the <code>docker</code>/<code>podman</code> group then re-login.</li>
              <li>Prune containers/images regularly; keep at least 30–50 GB free.</li>
              <li>Always use the <b>exact</b> repro script from the referenced commit.</li>
            </ul>
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
            <br/><br/>
            <b>Extra detail:</b>
            <ul>
              <li>Record commands and tool versions as you go.</li>
              <li>For mismatches, capture both your hash and the expected one for discussion.</li>
            </ul>
          `,
          helper('The app extracts links/hashes, gives quick hash helpers, and a checklist you can mark off.')
        ),
        qa(
          '18) How do I fetch a proposal from the dashboard versus the CLI?',
          `
            Dashboard: open the proposal page; copy links/hashes. CLI: query governance canister or the public
            dashboard API to retrieve proposal JSON. Your goal is to identify text, payload, and referenced URLs.
            <br/><br/>
            <b>CLI sketch:</b> use the public API, then parse <code>payload_text_rendering</code>, <code>wasm_hash</code>,
            and any URLs for artifacts or commits.
          `,
          helper('Enter a proposal ID; the app pulls key data and links for you.')
        ),
        qa(
          '19) How do I check the <code>args_hash</code> against the arguments provided?',
          `
            Compute SHA-256 over the exact <em>bytes</em> of the encoded arguments. For JSON-ish payloads, ensure byte-for-byte
            reproduction (spacing, encoding). For Candid, encode with the correct .did first, then hash.
            <br/><br/>
            <b>Example (macOS):</b> <code>didc encode '(opt principal "aaaaa-aa")' | shasum -a 256</code>
          `,
          helper('Paste arguments text for quick hashing; for Candid, hash the encoded bytes you provide on-chain.')
        ),
        qa(
          '20) How do I rebuild and check the <code>wasm_hash</code> for a canister upgrade?',
          `
            Clone the repo at the referenced commit; follow the README/build instructions to produce the Wasm.
            Then run <code>sha256sum</code> on the produced file and compare with the proposal’s <code>wasm_hash</code>.
            <br/><br/>
            <b>Tip:</b> some projects publish both raw and gzipped Wasm; compute both if the proposal mentions “(gz) SHA-256”.
          `,
          helper('We show an artifact path hint (when present) and a type-specific rebuild guide block.')
        ),
        qa(
          '21) How do I verify an IC-OS release and Protocol Canister Management proposal?',
          `
            IC-OS: use the commit-pinned <code>repro-check</code> command from the IC repo, or the commands posted
            in the proposal summary. Compare the resulting image’s hash. Protocol canisters: rebuild Wasm or verify the published hash and provenance.
            <br/><br/>
            <b>Sanity check:</b> ensure the release package filename and hash you compute match what the page claims.
          `,
          helper('We show release URLs and a command block to copy, including expected hash comparison.')
        ),
        qa(
          '22) How do I verify Node Provider Rewards / Participant Management proposals?',
          `
            Download the exact documents (self-declaration, identity proofs) from the wiki/forum link. Compute SHA-256 of each file and confirm each hash matches the proposal’s listed values. Sanity-check identity and context.
            <br/><br/>
            <b>Extra checks:</b>
            <ul>
              <li>Verify <b>principal IDs</b>, <b>account identifiers</b>, and dates/periods referenced.</li>
              <li>Spot-check PDFs for obvious edits (file size/date) and hash the <b>exact</b> bytes downloaded.</li>
            </ul>
          `,
          helper('Per-doc upload fields let you hash locally and visually confirm each match.')
        ),
        qa(
          '23) How do verification steps differ across types?',
          `
            IC-OS focuses on reproducible build of the update image; canister upgrades on Wasm hashing/rebuild;
            participant management on document hash checks; motions on human reasoning and references.
            <br/><br/>
            <b>Memory aid:</b> <em>OS → image</em>, <em>Canister → Wasm + args</em>, <em>Admin → docs</em>, <em>Motion → sources</em>.
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
            <br/><br/>
            <b>Tip:</b> prefer <em>commit links</em> over branches/tags to avoid drift during verification.
          `,
          helper('We extract repo/commit from the summary and link the commit page when available.')
        ),
        qa(
          '25) How do I check out the correct Git commit for rebuilding?',
          `
            <code>git clone</code>, <code>git checkout &lt;commit&gt;</code>. Always use the <em>exact</em> commit hash from the proposal text or official post to avoid drift.
            <br/><br/>
            <b>Sanity check:</b> run <code>git rev-parse HEAD</code> and paste it in your report.
          `,
          helper('We show the detected commit and link it, plus an IC-OS rebuild snippet pinned to that commit (when applicable).')
        ),
        qa(
          '26) How do I verify that the Git commit has not been tampered with?',
          `
            Use the GitHub REST API or the web UI to confirm the commit exists on the upstream and review the diff.
            Optionally, check maintainer signatures/tags for authenticity in sensitive repos.
            <br/><br/>
            <b>Extra step:</b> compare the tree for release tags with the commit referenced by the proposal.
          `,
          helper('We call <code>GET /repos/{owner}/{repo}/commits/{ref}</code> and show an explicit “Commit exists” indicator.')
        ),
        qa(
          '27) What role do signed commits or tags play in ensuring authenticity?',
          `
            A verified signature demonstrates the author controls certain keys/identity. While not always used,
            it increases confidence. For releases, signed tags or reproducible builds are common assurance methods.
            <br/><br/>
            <b>Note:</b> signed tags help, but reproducible <em>artifacts</em> are the ultimate check.
          `,
          helper()
        ),
        qa(
          '28) How do I confirm that the source matches the published binary or wasm?',
          `
            Rebuild deterministically from the commit and compare the output’s SHA-256 to the proposal/on-chain hash.
            For IC-OS, follow the IC repo’s pinned script; for canisters, follow the repo’s build instructions.
            <br/><br/>
            <b>Compare both</b> raw and gzipped Wasm if both are published.
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
            <br/><br/>
            <b>Practices:</b> pin toolchain versions, use containers/VMs, and avoid network-dependent steps.
          `,
          helper()
        ),
        qa(
          '30) Why does DFINITY use Podman/Docker and how does it help reproducibility?',
          `
            Containerized environments control toolchain and dependencies, reducing differences across machines and
            improving the chance of byte-identical outputs from the same commit.
            <br/><br/>
            <b>Tip:</b> prefer Podman/Docker <em>build scripts pinned to commits</em> over manually assembling envs.
          `,
          helper()
        ),
        qa(
          '31) How do I compare my locally built wasm with the on-chain <code>wasm_hash</code>?',
          `
            Run <code>sha256sum</code> on your local output (or <code>shasum -a 256</code> on macOS) and compare to
            the hash shown in the dashboard/proposal summary.
            <br/><br/>
            <b>Check both:</b> <code>*.wasm</code> and, if present, <code>*.wasm.gz</code>.
          `,
          helper('We surface the expected hash and show where it was found (dashboard/API/summary).')
        ),
        qa(
          '32) What if my local hash doesn’t match the expected <code>wasm_hash</code>?',
          `
            First, ensure you hashed the correct file (raw vs gz). Then confirm you built from the <b>exact</b> commit, with the
            proper tool versions. If still diverging, compare build logs, dependencies, and environment.
            <br/><br/>
            <b>Report both</b> your hash and the expected hash to help others diagnose.
          `,
          helper('The app shows which hash (raw/gz) it expects so you can align your calculation.')
        ),
        qa(
          '33) Do I need to hash the raw Wasm or the gzipped Wasm (or both)?',
          `
            Follow the proposal text/Dashboard. Some specify <b>Proposed WASM (gz) SHA-256</b>. In doubt, compute <em>both</em> and
            report them side by side.
            <br/><br/>
            <b>Rule</b>: never assume gz == raw; they are different bytes and will never match.
          `,
          helper()
        ),
      ])}

      ${section('8. Hashes & Arguments', [
        qa(
          '34) How do I compute the SHA-256 of a file?',
          `
            <code>sha256sum &lt;file&gt;</code> on Linux, <code>shasum -a 256 &lt;file&gt;</code> on macOS/WSL. Ensure you hash the
            <em>exact</em> artifact referenced (e.g., raw or gzipped Wasm, the IC-OS image, or a PDF).
            <br/><br/>
            <b>Extra:</b> print file size (<code>stat</code>) in your report to help sanity-check which bytes you hashed.
          `,
          helper()
        ),
        qa(
          '35) How do I compute the <code>args_hash</code> for a payload?',
          `
            Encode the payload to bytes (Candid via <code>didc encode</code>), then pipe the bytes to SHA-256. For text/JSON style,
            confirm byte-for-byte reproduction.
            <br/><br/>
            <b>Example:</b> <code>didc encode '(record { controller = principal "aaaaa-aa" })' | sha256sum</code>
          `,
          helper()
        ),
        qa(
          '36) What if a proposal’s arguments are empty or null?',
          `
            It may be a <em>reinstall</em> or a call that takes no parameters. Represent “empty” exactly as the canister expects (e.g.,
            <code>()</code> for no args). The <code>arg_hash</code> should then match the hash of the correctly encoded empty value.
            <br/><br/>
            <b>Pitfall:</b> hashing the literal word “null” or an empty string instead of the encoded empty Candid value.
          `,
          helper()
        ),
        qa(
          '37) My computed <code>args_hash</code> doesn’t match—what now?',
          `
            Double-check the .did and the exact textual form you encoded, including spacing and quoting. Ensure you’re hashing the
            <em>encoded bytes</em>, not a pretty printer’s output. Compare your pipeline with other verifiers.
            <br/><br/>
            <b>Trick:</b> write the bytes to a file and hash that file to avoid shell quoting mistakes.
          `,
          helper('The app’s hash helper reduces copy/paste errors by letting you paste args and see the digest live.')
        ),
      ])}

      ${section('9. Documents & Evidence', [
        qa(
          '38) How do I verify PDF or text documents linked in a proposal?',
          `
            Download the exact files from official links and compute SHA-256. Compare to the values listed in the proposal text or
            attachments. Do a quick visual scan for date/author consistency.
            <br/><br/>
            <b>Extra:</b> keep the originals as evidence; include filename + size + hash in your report.
          `,
          helper()
        ),
        qa(
          '39) What if the provided document hash doesn’t match what I downloaded?',
          `
            Re-download (no viewer), ensure the URL isn’t behind a converter, and confirm you didn’t hash a rendered version. If it still
            mismatches, raise it in the forum thread with both hashes and the exact URL used.
            <br/><br/>
            <b>Often</b> it’s a different PDF revision or an encoding/transfer quirk.
          `,
          helper()
        ),
        qa(
          '40) How should I reference sources and links in my report?',
          `
            Link to the proposal page, commit, release artifacts, and any forum posts. Use permalinks (commit SHAs, release tags) so future
            readers land on the exact versions you used.
            <br/><br/>
            <b>Tip:</b> paste short command blocks and hashes inline for scanability.
          `,
          helper()
        ),
        qa(
          '41) How do I compare two versions of a document (e.g., node-provider declaration)?',
          `
            Compute and compare each file’s SHA-256. For content differences, use <code>diff</code> or a PDF text extractor to compare
            semantic changes.
            <br/><br/>
            <b>Note:</b> prefer hashing the original binary bytes rather than extracted text when verifying integrity.
          `,
          helper()
        ),
      ])}

      ${section('10. Reports, Community & Sharing', [
        qa(
          '42) What is the recommended flow for collaborating on verification (forums, GitHub)?',
          `
            Post early notes on the forum thread; share your environment and initial hashes so others can replicate quickly. Use a GitHub gist
            or repo for longer transcripts/logs.
            <br/><br/>
            <b>Etiquette:</b> separate facts (commands, hashes) from opinions (risk/impact) to keep threads productive.
          `,
          helper()
        ),
        qa(
          '43) How do I cross-check my results with others and converge on consensus?',
          `
            Compare commit, environment (OS, tool versions), exact commands, and output hashes. If one person diverges, try to reproduce their
            steps in a clean environment.
            <br/><br/>
            <b>Converge via</b> small deltas—change one variable at a time.
          `,
          helper()
        ),
        qa(
          '44) How do I write a clear summary for voters (TL;DR)?',
          `
            State the proposal ID, what was verified (source, wasm, args, documents), the computed hashes, and whether they match. Add any
            notable caveats. Keep it under ~10 lines and link to full logs.
            <br/><br/>
            <b>For Candid args</b>, include the exact literal form you used for encoding.
          `,
          helper()
        ),
        qa(
          '45) How do I structure a verification report so others can reproduce it?',
          `
            Include: proposal ID, links, commit, commands used (with versions), exact hashes observed, and a short
            checklist result. Keep it concise and copy-pastable.
            <br/><br/>
            <b>Template:</b> “Env”, “Sources”, “Commands”, “Hashes (raw/gz)”, “Args”, “Conclusion”.
          `,
          helper('Use the app’s “Relevant Links”, “Release Commands”, and “Checklist” sections as a starter for your report.')
        ),
        qa(
          '46) Where can I publish and share my verification results?',
          `
            Post on the DFINITY forum thread for the proposal, GitHub gists/repos, and governance community channels.
            The goal is discoverability and reproducibility.
            <br/><br/>
            <b>Tip:</b> add searchable terms (proposal ID, commit SHA) so others find your write-up later.
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
            <br/><br/>
            <b>Good practice:</b> verify TLS (https), check checksums, and favor commits/releases over branches.
          `,
          helper()
        ),
        qa(
          '48) What precautions should I take when building from source (sandboxing, isolation)?',
          `
            Use containers or VMs, restrict privileges, and dedicate a clean workspace. Capture a log of commands
            and output for traceability.
            <br/><br/>
            <b>Extra</b>: snapshot your VM before long rebuilds so you can roll back and compare.
          `,
          helper()
        ),
        qa(
          '49) Why should I never rely only on published binaries without verification?',
          `
            Binaries can be swapped or corrupted in transit. Hashes and reproducible builds provide integrity and
            provenance guarantees that simple downloads do not.
            <br/><br/>
            <b>Remember</b>: “downloaded” ≠ “verified”.
          `,
          helper()
        ),
        qa(
          '50) How do I cross-check official artifacts published by DFINITY or other developers?',
          `
            Match the download URL, commit, and hash against the proposal text, IC Dashboard, forum announcement,
            and repository README. They should all agree on commit and expected hash.
            <br/><br/>
            <b>Mismatch?</b> Pause, collect evidence (links + hashes), and discuss before voting.
          `,
          helper()
        ),
        qa(
          '51) What community standards or norms exist for verification transparency?',
          `
            Publish minimal, reproducible logs and hashes; link to the exact commit; pin commands to specific versions;
            and collaborate on public threads to converge on shared, verifiable results.
            <br/><br/>
            <b>Norm</b>: keep verification artifacts available long-term (gists/repos).
          `,
          helper()
        ),
      ])}

      ${section('12. Accounts, Authentication & Payments', [
        qa(
          '52) How does authentication work in the Proposal Verifier app?',
          `
            The frontend integrates <b>Internet Identity</b> authentication. When you click “Login with Internet Identity”,
            you authenticate once through an II window and the session is remembered. After authenticating, paid actions
            (e.g., fetching proposals and related outcalls) can be attributed to <em>your</em> principal.
            <br/><br/>
            <b>Note:</b> logging out simply clears the session; you can log back in with the same II to resume.
          `,
          helper('The status pill in the navigation shows whether you are authenticated and able to trigger fetches.')
        ),
        qa(
          '53) What happens if I log out or my session expires?',
          `
            If you log out or your session expires, paid actions are disabled until you authenticate again. Your deposit
            subaccount and balance are unchanged. Just click “Login with Internet Identity” to continue.
            <br/><br/>
            <b>Heads-up:</b> background tabs may expire silently—refresh if a fetch button appears disabled.
          `,
          helper('The status pill in the navigation shows whether you are authenticated and able to trigger fetches.')
        ),
        qa(
          '54) How do payments and deposits work?',
          `
            Every authenticated principal receives a <b>dedicated ICP deposit subaccount</b>. When you initiate a paid action,
            the backend checks your balance, reserves the per-fetch fee (currently 0.2 ICP plus network fee), performs the work,
            and only then settles the transaction to the configured beneficiary. You can top up the subaccount from any wallet by
            sending ICP to the address displayed in the “Deposit” dialog. Deposits happen on the legacy ICP ledger so funds show
            up within a few blocks.
            <br/><br/>
            <b>Transparency:</b> the payments drawer shows your principal, subaccount, recent debits, and beneficiary preview.
          `,
          helper('The balance widget lists your subaccount, provides copy buttons, and links to the ledger explorer so you can track receipts.')
        ),
        qa(
          '55) How can I review or top up my balance?',
          `
            Open the <em>Fund your balance</em> drawer (at the top of the page). It lists your principal (do not deposit to your principal), the dedicated deposit subaccount, and current
            balance. Use any NNS wallet, hardware wallet,
            or the ledger CLI to send ICP directly to that subaccount. After you broadcast the transfer, give the ledger a few
            blocks to finalize and then click the <b>Refresh balances</b> button—the app calls the backend to resync your balance
            before enabling billed actions.
            <br/><br/>
            If you just authenticated, the drawer may briefly show “calculating…” while it derives your deposit address. Wait a
            couple of seconds (or reopen the drawer) until the address renders, then fund it and hit Refresh after the deposit
            settles. You can cross-check the on-chain amount via the ledger explorer linked in the drawer.
            <br/><br/>
            <b>Tip:</b> copy the account identifier directly from the UI to avoid transcription mistakes, and make sure the status
            pill shows you are logged in so the refreshed balance attaches to the correct principal.
          `,
          helper(
            'The drawer provides copy buttons and the Refresh balances control that triggers a new ledger query.'
          )
        ),
        qa(
          '56) Why does the app forward fees to a beneficiary address, and what cycle balance does the backend need?',
          `
            Cycles for HTTPS outcalls, GitHub API usage, and ledger queries must be funded. The backend transfers the collected
            ICP from your deposit subaccount to a configured beneficiary account so the operator can convert it into cycles and
            keep the service online. The verifier refuses to fetch proposals if the backend canister balance drops below
            <b>3&nbsp;trillion cycles</b>, so keeping deposits flowing (and converting them to cycles) is essential. If you see a
            “service temporarily unavailable” error, the cycle balance has likely fallen under that threshold—top it up and try
            again once the operator replenishes the canister.
            <br/><br/>
            <b>Self-hosters:</b> change the beneficiary constant before deploying so fees flow to your account, and make sure
            you pre-fund the backend with at least 3&nbsp;trillion cycles before inviting users.
          `,
          helper(
            'We display the beneficiary preview inside the payments drawer and surface recent cycle burn metrics in the top navigation so you can spot low-fuel warnings early.'
          )
        ),
      ])}

      ${section('13. Self-Hosting, Repository & Guide', [
        qa(
          '57) Where is the source code and can I deploy my own instance?',
          `
            Yes. The entire project is open source at <a href="https://github.com/dickhery/proposal_verifier" target="_blank" rel="noreferrer">github.com/dickhery/proposal_verifier</a>.
            Clone the repository, review the README for prerequisites (dfx, node, vessel/mops), and you can deploy identical frontend
            and backend canisters on your own Internet Computer account.
            <br/><br/>
            <b>Tip:</b> read <code>GUIDE.md</code> sections on local usage for end-to-end steps.
          `,
          helper('The app links to the repository from the footer so you can jump directly to the codebase.')
        ),
        qa(
          '58) What steps are required to self-host the Proposal Verifier?',
          `
            <ol>
              <li>
                <b>Clone</b> the repository and install dependencies (<code>npm install</code> for the frontend,
                <code>mops install</code> for Motoko libs).
              </li>
              <li>
                <b>Customize</b> configuration (beneficiary address, optional branding, guide links).
              </li>
              <li>
                <b>Deploy</b> the canisters via <code>dfx deploy --network ic</code> (or
                <code>--network local</code> for testing).
              </li>
              <li>
                <b>Update</b> the generated canister IDs inside the frontend <code>.env</code> or constants so the UI targets your
                backend.
              </li>
              <li>
                <b>Fund</b> the backend canister with cycles and test authentication + payment flows before inviting users.
              </li>
            </ol>
            <br/>
            <b>Verification:</b> ensure the payments drawer shows <em>your</em> beneficiary address before production use.
          `,
          helper('Our deployment checklist modal mirrors these steps and links to the README sections you need most often.')
        ),
        qa(
          '59) Which beneficiary address ships in the repo and what should I change?',
          `
            The default backend constant <code>BENEFICIARY_ACCOUNT_HEX</code> is set to <code>2ec3dee16236d389ebdff4346bc47d5faf31db393dac788e6a6ab5e10ade144e</code>.
            Before deploying your own instance, replace it with a 64-hex account identifier you control (for example, the subaccount
            from your NNS wallet). Update the constant in <code>src/proposal_verifier_backend/main.mo</code>, redeploy the backend, and
            confirm the payments drawer displays your address before onboarding users.
            <br/><br/>
            <b>Sanity:</b> paste the new address into a ledger explorer to confirm format/ownership.
          `,
          helper('The UI surfaces the active beneficiary so you can verify your customization worked.')
        ),
        qa(
          '60) Where can I find the comprehensive Proposal Verification Guide?',
          `
            The project ships a detailed walkthrough at <a href="https://github.com/dickhery/proposal_verifier/blob/main/GUIDE.md" target="_blank" rel="noreferrer">GUIDE.md</a>.
            It expands on every checklist item, shows shell transcripts for IC-OS rebuilds, explains payment wiring, and includes
            troubleshooting matrices for common mismatches. Keep it open alongside the app whenever you want extra context or
            need to double-check a manual step.
            <br/><br/>
            <b>Shortcut:</b> contextual “Learn more” links jump straight to the relevant section.
          `,
          helper('Contextual “Learn more” links in the UI jump straight into the relevant GUIDE.md section.')
        ),
        qa(
          '61) How do I troubleshoot a self-hosted deployment if authentication or payments fail?',
          `
            Start by confirming Internet Identity integration: ensure your frontend references the correct <code>canisterIds.json</code>
            and that the II origin is authorized. Next, inspect backend logs (<code>dfx canister log</code>) for ledger transfer errors or
            missing cycles. Verify that your customized beneficiary address is a valid account identifier (64 hex chars) and that
            the ledger fees are funded. Finally, re-run <code>dfx deploy</code> after any code changes to pick up new constants.
            <br/><br/>
            <b>Also verify:</b> CORS settings for HTTPS outcalls and that your node can reach GitHub/ledger endpoints.
          `,
          helper('The deployment checklist highlights missing env vars and warns if ledger transfers fail so you can react quickly.')
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

function qa(question, answerHtml, appHelpHtml = helper()) {
  return html`
    <details class="faq">
      <summary><b>${renderHtml(question)}</b></summary>
      <div class="qa">
        <p>${renderHtml(answerHtml)}</p>
        <p class="helper"><b>How this app helps:</b> ${renderHtml(appHelpHtml)}</p>
      </div>
    </details>
  `;
}

function helper(extra = 'It reduces copy/paste errors by surfacing links and expected hashes and gives you copyable shell snippets.') {
  return extra;
}

function renderHtml(value) {
  if (value == null) {
    return nothing;
  }
  return typeof value === 'string' ? unsafeHTML(value) : value;
}