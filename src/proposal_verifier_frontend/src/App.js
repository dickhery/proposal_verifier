import { html, render } from 'lit-html';
import { proposal_verifier_backend } from 'declarations/proposal_verifier_backend';
import { sha256, parseEscapedToBytes, bytesToHex } from './utils.js';
import { FAQView } from './FAQ.js';

// CORS-friendly hosts for browser fetches
const CORS_ALLOWED_HOSTS = new Set([
  'ic-api.internetcomputer.org',
  'api.github.com',
  'raw.githubusercontent.com',
  'dashboard.internetcomputer.org',
]);

// Regex helper to spot release package links in payloads
const RELEASE_URL_RE = /https:\/\/download\.dfinity\.(?:systems|network)\/ic\/[0-9a-f]{40}\/[^"'\s]+/ig;

// Candid-ish text detection (coarse but useful for hints)
const CANDID_PATTERN = /(^|\W)(record\s*\{|variant\s*\{|opt\s|vec\s|principal\s|service\s|func\s|blob\s|text\s|nat(8|16|32|64)?\b|int(8|16|32|64)?\b)/i;

// Unwrap a Candid optional represented as [] | [T]
const unwrap = (opt) => (Array.isArray(opt) ? (opt[0] ?? null) : (opt ?? null));

// Normalize a list of Candid optionals to strings (dropping invalids)
const normalizeDocs = (docs) =>
  (Array.isArray(docs) ? docs : []).map((d) => ({
    name: String(d?.name ?? ''),
    hash: unwrap(d?.hash), // -> string | null
  }));

// Find a 64-hex near helpful markers
function extractHexFromTextAroundMarkers(
  text,
  markers = [
    'wasm_module_hash',
    'release_package_sha256_hex',
    'expected_hash',
    'sha256',
    'hash',
  ],
) {
  if (typeof text !== 'string') return null;
  const HEX64 = /[A-Fa-f0-9]{64}/g;
  for (const m of markers) {
    const idx = text.toLowerCase().indexOf(m.toLowerCase());
    if (idx >= 0) {
      const start = Math.max(0, idx - 600);
      const end = Math.min(text.length, idx + 1200);
      const seg = text.slice(start, end);
      const match = seg.match(HEX64);
      if (match && match.length) return match[0];
    }
  }
  const any = text.match(HEX64);
  return any ? any[0] : null;
}

// Conservative URL extractor + sanitization
export function extractAllUrls(text) {
  if (typeof text !== 'string') return [];
  const raw = text.match(/\bhttps?:\/\/[^\s]+/gi) || [];
  const sanitized = raw.map((u) => {
    let s = u;
    while (/[)\]\}\.,;:'"`]$/.test(s)) s = s.slice(0, -1);
    const left = (s.match(/\(/g) || []).length;
    const right = (s.match(/\)/g) || []).length;
    while (right > left && s.endsWith(')')) s = s.slice(0, -1);
    return s;
  });
  return [...new Set(sanitized)];
}

// Small helper: hex string ➜ Uint8Array
function hexToBytes(hex) {
  const s = String(hex ?? '').replace(/^0x/i, '').trim();
  if (!/^[0-9a-fA-F]*$/.test(s) || s.length % 2 !== 0) throw new Error('Invalid hex input');
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.substr(i * 2, 2), 16);
  return out;
}

class App {
  view = 'home'; // 'home' | 'faq'

  proposalData = null;
  commitStatus = '';
  hashMatch = false;
  hashError = '';
  docResults = []; // [{name, match, error, preview}]
  rebuildScript = '';
  isFetching = false;
  isVerifyingArgs = false;
  cycleBalance = null;

  expectedHash = null;          // expected WASM/release hash
  expectedHashSource = null;
  argHash = null;               // arg_hash (from dashboard/api)
  payloadSnippetFromDashboard = null;
  dashboardUrl = '';

  releasePackageUrls = [];      // always an array

  // Arg Hash UX
  argInputType = 'text';        // 'text' | 'hex' | 'candid'
  argInputCurrent = '';
  argInputHint = '';
  extractedArgText = null;

  // Parsed from dfx paste
  extractedArgHex = null;
  computedArgHash = null;
  argHashMatch = false;

  checklist = {
    fetch: false,
    commit: false,
    argsHash: false,
    docHash: false,
    expected: false,
    rebuild: false,
  };

  constructor() {
    this.releasePackageUrls = [];
    this.payloadSnippetFromDashboard = null;
    this.extractedArgText = null;
    this.docResults = [];
    this.#render();
  }

  #setFetching(on) { this.isFetching = on; this.#render(); }
  #normalizeHex(s) { return String(s ?? '').trim().toLowerCase(); }

  #updateChecklist() {
    const hasDocs = Array.isArray(this.docResults) && this.docResults.length > 0;
    this.checklist = {
      fetch: !!this.proposalData,
      commit: this.commitStatus.startsWith('✅'),
      argsHash: !!(this.hashMatch || this.argHashMatch),
      docHash: hasDocs ? this.docResults.every((r) => r.match) : false,
      expected: !!this.expectedHash,
      rebuild: this.checklist.rebuild || false,
    };
  }

  async #handleCopy(e, text, originalLabel) {
    const button = e?.target;
    const toCopy = String(text ?? '');
    const fallbackCopy = () => {
      const ta = document.createElement('textarea');
      ta.value = toCopy;
      ta.style.position = 'fixed';
      ta.style.opacity = 0;
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      try {
        const ok = document.execCommand('copy');
        if (ok && button) {
          button.innerText = 'Copied!';
          setTimeout(() => { button.innerText = originalLabel; }, 2000);
        }
      } finally {
        document.body.removeChild(ta);
      }
    };
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(toCopy);
        if (button) {
          button.innerText = 'Copied!';
          setTimeout(() => { button.innerText = originalLabel; }, 2000);
        }
      } else {
        fallbackCopy();
      }
    } catch {
      fallbackCopy();
    }
  }

  async #prefillFromIcApi(id) {
    try {
      const url = `https://ic-api.internetcomputer.org/api/v3/proposals/${id}`;
      const res = await fetch(url, { credentials: 'omit', mode: 'cors' });
      if (!res.ok) return;

      const text = await res.text();

      const maybe = extractHexFromTextAroundMarkers(text);
      if (maybe) {
        this.expectedHash = maybe;
        this.expectedHashSource = 'ic-api';
      }

      const argMaybe = extractHexFromTextAroundMarkers(text, ['arg_hash']);
      if (argMaybe) {
        this.argHash = argMaybe;
      }

      const urls = new Set();
      const payloadUrls = text.match(RELEASE_URL_RE) || [];
      payloadUrls.forEach((u) => urls.add(u));
      extractAllUrls(text)
        .filter((u) => /https:\/\/download\.dfinity\.(systems|network)\//.test(u))
        .forEach((u) => urls.add(u));
      this.releasePackageUrls = Array.from(urls);

      this.#render();
    } catch {
      // ignore ic-api failures; UI still works
    }
  }

  async #handleFetchProposal(e) {
    e.preventDefault();
    if (this.isFetching) return;
    this.#setFetching(true);

    try {
      const idEl = document.getElementById('proposalId');
      const id = parseInt(idEl?.value ?? '0', 10);
      if (!Number.isFinite(id) || id <= 0) throw new Error('Enter a valid proposal id');

      const aug = await proposal_verifier_backend.getProposalAugmented(BigInt(id));
      if (aug?.err) throw new Error(aug.err || 'Unknown error from backend');

      const data = aug.ok;
      const base = data.base;

      // Normalize all fields to primitives
      const p = {
        id: Number(base.id),
        summary: String(base.summary ?? ''),
        url: String(base.url ?? ''),
        title: unwrap(base.title) ?? null,
        extractedCommit: unwrap(base.extractedCommit) ?? null,
        extractedHash: unwrap(base.extractedHash) ?? null,
        extractedDocUrl: unwrap(base.extractedDocUrl) ?? null,
        extractedRepo: unwrap(base.extractedRepo) ?? null,
        extractedArtifact: unwrap(base.extractedArtifact) ?? null,
        proposalType: String(base.proposalType ?? 'Unknown'),
        extractedUrls: Array.isArray(base.extractedUrls) ? base.extractedUrls : [],
        commitUrl: unwrap(base.commitUrl) ?? null,
        extractedDocs: normalizeDocs(base.extractedDocs),
        proposal_wasm_hash: unwrap(base.proposal_wasm_hash) ?? null,
        proposal_arg_hash: unwrap(base.proposal_arg_hash) ?? null,
      };

      this.proposalData = p;

      // Expected hashes from dashboard/api override summary heuristic
      this.expectedHash =
        unwrap(data.expectedHashFromDashboard) ??
        p.extractedHash ??
        null;

      this.expectedHashSource =
        unwrap(data.expectedHashSource) ??
        (p.extractedHash ? 'proposal:summary' : null);

      // Separate arg_hash from api (if provided)
      this.argHash = unwrap(data.argHashFromDashboard) ?? this.argHash ?? null;

      this.payloadSnippetFromDashboard = unwrap(data.payloadSnippetFromDashboard);
      this.dashboardUrl = String(data.dashboardUrl ?? '');

      // Optional extracted Candid-like text
      this.extractedArgText = unwrap(data.extractedArgText) ?? null;

      // Arg input defaults
      this.argInputHint = '';
      this.argInputType = 'text';
      if (this.extractedArgText && CANDID_PATTERN.test(this.extractedArgText)) {
        this.argInputCurrent = this.extractedArgText;
        this.argInputType = 'candid';
        this.argInputHint = 'Detected Candid-like text. Encode with didc, then paste the hex as "Hex Bytes".';
      } else if (this.payloadSnippetFromDashboard && CANDID_PATTERN.test(this.payloadSnippetFromDashboard)) {
        this.argInputCurrent = this.payloadSnippetFromDashboard.trim();
        this.argInputType = 'candid';
        this.argInputHint = 'Detected possible Candid in payload snippet. Encode with didc before hashing.';
      } else {
        this.argInputCurrent = '';
      }

      // Reset per-fetch arg verification state
      this.extractedArgHex = null;
      this.computedArgHash = null;
      this.argHashMatch = false;

      // Ensure array before we render anything that maps it
      this.releasePackageUrls = [];

      // Prefill from ic-api (async)
      await this.#prefillFromIcApi(id);

      // Commit existence check
      this.commitStatus = '';
      const repo = p.extractedRepo || 'dfinity/ic';
      const commit = p.extractedCommit || '';
      if (commit) {
        const commitResult = await proposal_verifier_backend.checkGitCommit(repo, commit);
        if (commitResult.ok) {
          this.commitStatus = `✅ Commit exists on ${repo}@${commit.substring(0, 12)}`;
        } else {
          // Browser fallback
          const ok = await this.#checkCommitInBrowser(repo, commit);
          this.commitStatus = ok
            ? `✅ Commit exists on ${repo}@${commit.substring(0, 12)} (browser fallback)`
            : `❌ ${commitResult.err || 'Commit not found'}`;
        }
      } else {
        this.commitStatus = '❌ No commit found in summary';
      }

      // Rebuild guidance
      this.rebuildScript = await proposal_verifier_backend.getRebuildScript(
        p.proposalType,
        p.extractedCommit || ''
      );

      // Initialize doc results only for docs with a valid 64-hex hash
      const validDocs = (p.extractedDocs || []).filter(
        (d) => typeof d.hash === 'string' && d.hash.length === 64
      );

      this.docResults = validDocs.map((d) => ({
        name: d.name,
        match: false,
        error: '',
        preview: '',
      }));

      this.#updateChecklist();
    } catch (err) {
      alert(err?.message || String(err));
    }

    this.#setFetching(false);
  }

  async #checkCommitInBrowser(repo, commit) {
    try {
      const url = `https://api.github.com/repos/${repo}/commits/${commit}`;
      const res = await fetch(url, {
        headers: {
          'Accept': 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'proposal-verifier-frontend',
        },
      });
      if (!res.ok) return false;
      const json = await res.json();
      return !!json?.sha;
    } catch {
      return false;
    }
  }

  async #handleFetchVerifyDoc() {
    const url =
      (document.getElementById('docUrl')?.value || '') ||
      (this.proposalData?.extractedDocUrl || '');
    const expected =
      (document.getElementById('expectedDocHash')?.value || '').trim() ||
      (this.expectedHash || '');

    this.docHashError = '';
    this.docPreview = '';

    try {
      const result = await proposal_verifier_backend.fetchDocument(url);
      if (result.ok) {
        const bodyArray = new Uint8Array(result.ok.body);
        const computedHash = await sha256(bodyArray);
        this.docHashMatch = !!expected && (this.#normalizeHex(computedHash) === this.#normalizeHex(expected));
        const contentType = (result.ok.headers || []).find(
          (h) => String(h?.name ?? '').toLowerCase() === 'content-type'
        )?.value || '';
        if (String(contentType).startsWith('text/')) {
          this.docPreview = new TextDecoder().decode(bodyArray).substring(0, 200) + '…';
        } else {
          this.docPreview = `${contentType || 'binary'} (${bodyArray.length} bytes)`;
        }
      } else {
        // Non-deterministic domain; try browser (CORS) fallback
        const { hostname } = new URL(url);
        if (!CORS_ALLOWED_HOSTS.has(hostname)) {
          throw new Error(`CORS likely blocked by ${hostname}. Use the shell commands below to download, then upload the file here.`);
        }
        const fallback = await fetch(url, { credentials: 'omit', mode: 'cors' });
        if (!fallback.ok) throw new Error(result.err || `HTTP ${fallback.status}`);
        const bytes = new Uint8Array(await fallback.arrayBuffer());
        const computedHash = await sha256(bytes);
        this.docHashMatch = !!expected && (this.#normalizeHex(computedHash) === this.#normalizeHex(expected));
        const ct = fallback.headers.get('content-type') || '';
        if (ct.startsWith('text/')) {
          this.docPreview = new TextDecoder().decode(bytes).substring(0, 200) + '…';
        } else {
          this.docPreview = `${ct || 'binary'} (${bytes.length} bytes)`;
        }
      }
    } catch (err) {
      this.docHashError = err?.message || String(err);
      this.docHashMatch = false;
    }
    this.#updateChecklist();
    this.#render();
  }

  async #handleFileUpload(e, docIndex) {
    const file = e?.target?.files?.[0];
    if (!file) return;

    const docs = Array.isArray(this.proposalData?.extractedDocs) ? this.proposalData.extractedDocs : [];
    const doc = docs[docIndex];
    if (!doc || typeof doc.hash !== 'string' || doc.hash.length !== 64) return;

    const expected = doc.hash || this.expectedHash || '';
    this.docResults[docIndex] = { ...this.docResults[docIndex], error: '', preview: '', match: false };
    this.#render();

    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const computedHash = await sha256(bytes);
      const match = !!expected && (this.#normalizeHex(computedHash) === this.#normalizeHex(expected));
      const ct = file.type || 'binary';
      const preview = ct.startsWith('text/')
        ? new TextDecoder().decode(bytes).substring(0, 200) + '…'
        : `${ct} (${bytes.length} bytes) - Local file: ${file.name}`;
      this.docResults[docIndex] = { ...this.docResults[docIndex], match, preview };
    } catch (err) {
      this.docResults[docIndex] = { ...this.docResults[docIndex], error: err.message || String(err), match: false };
    }
    this.#updateChecklist();
    this.#render();
  }

  async #handleCheckCycles() {
    try {
      this.cycleBalance = await proposal_verifier_backend.getCycleBalance();
    } catch (err) {
      this.cycleBalance = 'Error: ' + (err.message || String(err));
    }
    this.#render();
  }

  #renderLinks() {
    const p = this.proposalData;
    if (!p) return null;

    const set = new Set();
    const push = (u) => { if (u && !set.has(u)) set.add(u); };

    push(p.url);
    push(this.dashboardUrl);
    push(p.extractedDocUrl);
    push(p.commitUrl);
    (Array.isArray(p.extractedUrls) ? p.extractedUrls : []).forEach(push);

    const links = [...set.values()];
    if (!links.length) return html`<p>(no links found)</p>`;

    return html`
      <ul class="links">
        ${links.map((u) => html`<li><a href="${u}" target="_blank" rel="noreferrer">${u}</a></li>`)}
      </ul>
    `;
  }

  #renderReleaseCommands() {
    if (!Array.isArray(this.releasePackageUrls) || this.releasePackageUrls.length === 0) return null;

    const cmds = this.releasePackageUrls.map((u, idx) => {
      const fname = `update-img-${idx + 1}.tar.zst`;
      return {
        url: u,
        cmd: `curl -fsSL "${u}" -o ${fname}\nsha256sum ${fname}  # expect ${this.expectedHash || ''}`
      };
    });
    return html`
      <section>
        <h2>Release Package URLs & Quick Verify</h2>
        <ul class="links">
          ${this.releasePackageUrls.map((u) => html`<li><a href="${u}" target="_blank" rel="noreferrer">${u}</a></li>`)}
        </ul>
        <p><b>Shell commands (download & hash locally):</b></p>
        <pre>${cmds.map((x) => `# ${x.url}\n${x.cmd}`).join('\n\n')}</pre>
        <button @click=${(e) => this.#handleCopy(e, cmds.map((x) => x.cmd).join('\n\n'), 'Copy Commands')}>Copy Commands</button>
      </section>
    `;
  }

  #renderTypeGuidance() {
    const type = this.proposalData?.proposalType || '';
    switch (type) {
      case 'ParticipantManagement':
        return html`
          <details>
            <summary><b>Guidance for Node Provider Proposals</b></summary>
            <p>These proposals verify documents (PDFs). Download the exact file provided by the proposer from the wiki (<a href="https://wiki.internetcomputer.org" target="_blank">IC Wiki</a>), upload below for each doc. Hashes must match summary.</p>
            <p>Check forum announcement for context.</p>
          </details>
        `;
      case 'IcOsVersionDeployment':
        return html`
          <details>
            <summary><b>Guidance for IC-OS Elections</b></summary>
            <p>Download release package (.tar.zst) using curl commands above. Upload to "Verify Document" or hash locally with sha256sum. Compare to expected <code>release_package_sha256_hex</code>.</p>
          </details>
        `;
      default: return null;
    }
  }

  #buildDidcCommand() {
    const input = (this.argInputCurrent || '').trim();
    if (!input) return `didc encode '()' | xxd -p -c0 | tr -d '\\n'`;
    return `didc encode '(${input})' | xxd -p -c0 | tr -d '\\n'`;
  }

  #handleArgTypeChange(val) {
    this.argInputType = val;
    this.hashError = (val === 'candid')
      ? 'Candid text must be Candid-encoded to bytes (e.g. with `didc encode`) before hashing.'
      : '';
    this.#render();
  }

  #handleArgInputChange(e) {
    const v = (e?.target?.value ?? '').trim();
    this.argInputCurrent = v;

    if (this.argInputType !== 'candid' && CANDID_PATTERN.test(v)) {
      this.argInputHint = 'Looks like Candid text. Choose "Candid Text" and encode with didc first.';
    } else if (/^(0x)?[0-9a-fA-F]+$/.test(v) && (v.replace(/^0x/i, '').length % 2 === 0)) {
      this.argInputHint = 'This looks like hex bytes. Choose "Hex Bytes" before verifying.';
    } else {
      this.argInputHint = '';
    }
  }

  async #handleVerifyArgHash() {
    this.isVerifyingArgs = true;
    this.hashError = '';
    this.#render();

    const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
    const argsRaw = (this.argInputCurrent || '').trim();
    const inputExpected =
      (document.getElementById('expectedArgHash')?.value || '').trim() ||
      this.argHash ||
      '';

    try {
      let computedHash = '';

      if (!argsRaw) {
        computedHash = EMPTY_SHA256;
        this.hashError = 'Blank input: checked against empty-blob hash.';
      } else if (this.argInputType === 'hex') {
        const bytes = hexToBytes(argsRaw);
        computedHash = await sha256(bytes);
      } else if (this.argInputType === 'text') {
        computedHash = await sha256(argsRaw);
      } else if (this.argInputType === 'candid') {
        this.hashError = 'Candid text detected—encode with didc first, then paste the resulting hex under "Hex Bytes".';
        this.hashMatch = false;
        this.isVerifyingArgs = false;
        this.#updateChecklist();
        this.#render();
        return;
      } else {
        if (/^(0x)?[0-9a-fA-F]+$/.test(argsRaw) && (argsRaw.replace(/^0x/i, '').length % 2 === 0)) {
          computedHash = await sha256(hexToBytes(argsRaw));
        } else {
          computedHash = await sha256(argsRaw);
        }
      }

      this.hashMatch = !!inputExpected && (this.#normalizeHex(computedHash) === this.#normalizeHex(inputExpected));
    } catch (err) {
      this.hashError = err.message || String(err);
      this.hashMatch = false;
    }

    this.#updateChecklist();
    this.isVerifyingArgs = false;
    this.#render();
  }

  // Parse dfx output (opt blob "...\x..") → bytes → hex → hash → compare to onchain arg_hash
  async #extractArgFromDfx() {
    const paste = (document.getElementById('dfxPaste')?.value || '').trim();
    if (!paste) {
      this.hashError = 'Paste the full dfx response first.';
      this.#render();
      return;
    }

    const blobMatch = paste.match(/arg\s*=\s*opt\s*blob\s*"([^"]*)"/i);
    if (!blobMatch || !blobMatch[1]) {
      this.hashError = 'No opt blob found in pasted response.';
      this.extractedArgHex = null;
      this.computedArgHash = null;
      this.argHashMatch = false;
      this.#updateChecklist();
      this.#render();
      return;
    }

    const escaped = blobMatch[1];
    try {
      const bytes = parseEscapedToBytes(escaped);
      this.extractedArgHex = bytesToHex(bytes);
      this.computedArgHash = await sha256(bytes);

      const onchain = this.proposalData?.proposal_arg_hash || this.argHash || '';

      this.argHashMatch = !!onchain && (this.#normalizeHex(this.computedArgHash) === this.#normalizeHex(onchain));
      this.hashError = '';
    } catch (err) {
      this.hashError = 'Parse failed: ' + (err.message || String(err));
      this.extractedArgHex = null;
      this.computedArgHash = null;
      this.argHashMatch = false;
    }
    this.#updateChecklist();
    this.#render();
  }

  #renderDocVerification() {
    const docs = (Array.isArray(this.proposalData?.extractedDocs) ? this.proposalData.extractedDocs : [])
      .filter((d) => typeof d.hash === 'string' && d.hash.length === 64);

    if (!docs.length) return html`<p>No verifiable documents were found in the summary.</p>`;

    return html`
      <ul class="doc-list">
        ${docs.map((d, idx) => {
          const res = this.docResults[idx] || { match: false, error: '', preview: '' };
          return html`
            <li>
              <b>${d.name}</b> (expected: ${d.hash})
              <input type="file" @change=${(e) => this.#handleFileUpload(e, idx)} />
              <p><b>Match:</b> ${res.match ? '✅ Yes' : '❌ No'}</p>
              ${res.error ? html`<p class="error">${res.error}</p>` : ''}
              <p><b>Preview:</b> ${res.preview}</p>
            </li>
          `;
        })}
      </ul>
    `;
  }

  #renderTopbar() {
    return html`
      <nav class="topbar">
        <h1 class="grow">IC Proposal Verifier</h1>
        ${this.view === 'home'
          ? html`<button class="btn" @click=${() => { this.view = 'faq'; this.#render(); }}>Open FAQ</button>`
          : html`<button class="btn" @click=${() => { this.view = 'home'; this.#render(); }}>&larr; Back</button>`
        }
      </nav>
    `;
  }

  #renderArgSection(p) {
    const didcCmd = this.#buildDidcCommand();
    return html`
      <section>
        <h2>Verify Arg Hash (Binary Field)</h2>

        <details style="margin-bottom:8px;">
          <summary>What goes here?</summary>
          <ol>
            <li><b>Empty arg?</b> Leave blank or click <i>Check Empty Arg</i>. The empty blob hashes to <code>e3b0c4...b855</code>.</li>
            <li><b>Text/JSON:</b> Select “Text/JSON”, paste it, and we hash UTF-8 bytes directly.</li>
            <li><b>Hex bytes:</b> Select “Hex Bytes” and paste a hex string (with or without <code>0x</code>).</li>
            <li><b>Candid text (e.g. <code>record { ... }</code>):</b> Select “Candid Text”, copy the didc command below, run locally, then paste the resulting <b>hex</b> under “Hex Bytes”.</li>
          </ol>
          <p><b>didc command builder (based on your input):</b></p>
          <pre class="cmd-pre">${didcCmd}</pre>
          <div style="display:flex; gap:8px; flex-wrap:wrap;">
            <button class="btn secondary" @click=${(e) => this.#handleCopy(e, didcCmd, 'Copy didc Command')}>Copy didc Command</button>
            <a class="btn secondary" href="https://github.com/dfinity/candid/tree/master/tools/didc" target="_blank" rel="noreferrer">Install didc</a>
          </div>
          <p style="margin-top:6px;"><b>Tip:</b> Proposals store binary args; any Candid you see in summaries must be encoded before hashing.</p>
        </details>

        <div style="display:flex; gap:16px; flex-wrap:wrap; align-items:center;">
          <label><input type="radio" name="argType" value="text" ?checked=${this.argInputType === 'text'} @change=${(e) => this.#handleArgTypeChange(e.target.value)} /> Text/JSON</label>
          <label><input type="radio" name="argType" value="hex" ?checked=${this.argInputType === 'hex'} @change=${(e) => this.#handleArgTypeChange(e.target.value)} /> Hex Bytes</label>
          <label><input type="radio" name="argType" value="candid" ?checked=${this.argInputType === 'candid'} @change=${(e) => this.#handleArgTypeChange(e.target.value)} /> Candid Text (encode first)</label>
        </div>

        <textarea
          id="argInput"
          placeholder="Paste arg (text / hex / Candid)"
          @input=${(e) => this.#handleArgInputChange(e)}
        >${this.argInputCurrent}</textarea>

        ${this.argInputHint ? html`<p style="margin:6px 0 0;"><em>${this.argInputHint}</em></p>` : ''}

        <input id="expectedArgHash" placeholder="Expected Arg SHA-256" value=${this.argHash || p.proposal_arg_hash || ''} />

        <div style="display:flex; gap:8px; flex-wrap:wrap;">
          <button class="btn" @click=${() => this.#handleVerifyArgHash()} class=${this.isVerifyingArgs ? 'loading' : ''} ?disabled=${this.isVerifyingArgs}>
            ${this.isVerifyingArgs ? 'Verifying...' : 'Verify Arg Hash'}
          </button>
          <button class="btn secondary" @click=${() => { this.argInputCurrent = ''; this.argInputType = 'text'; this.#handleVerifyArgHash(); }}>
            Check Empty Arg
          </button>
        </div>

        <p><b>Match:</b> ${this.hashMatch ? '✅ Yes' : '❌ No'}</p>
        ${this.hashError ? html`<p class="error">${this.hashError}</p>` : ''}

        <h3>Manual Onchain Query (for Binary Arg)</h3>
        <pre>dfx canister call rrkah-fqaaa-aaaaa-aaaaq-cai get_proposal_info '(${p.id})' --network ic
# Find in the Candid response the field:
#    action = opt variant { InstallCode = record { arg = opt blob "...\x.." } }
# Paste the full response below to extract arg as hex bytes.</pre>

        <textarea id="dfxPaste" placeholder="Paste dfx get_proposal_info response here" @input=${() => {}}></textarea>
        <button class="btn" @click=${() => this.#extractArgFromDfx()}>Extract Arg Hex from dfx</button>

        <p><b>Extracted Arg Hex:</b> ${this.extractedArgHex ?? 'None'}</p>
        <p><b>Computed Hash:</b> ${this.computedArgHash ?? ''}</p>
        <p><b>Matches Onchain:</b> ${this.argHashMatch ? '✅ Yes' : '❌ No'}</p>

        <h3>Low-level (vec nat8) note</h3>
        <p>If your output shows <code>arg = opt vec nat8</code> instead of a blob, convert the <i>bytes</i> to hex and hash the raw bytes. Blob and <code>vec nat8</code> are equivalent byte-for-byte.</p>
      </section>
    `;
  }

  #render() {
    // FAQ view
    if (this.view === 'faq') {
      const body = FAQView({ onBack: () => { this.view = 'home'; this.#render(); } });
      return render(body, document.getElementById('root'));
    }

    const p = this.proposalData;
    const loading = this.isFetching;

    const body = html`
      ${this.#renderTopbar()}

      <section class="advisory">
        <p>
          <b>Advisory:</b> This tool assists verification by surfacing links, hashes, and
          commands. <b>Manual checks and reproducible builds</b> remain the most reliable method.
          See <button class="linklike" @click=${() => { this.view = 'faq'; this.#render(); }}>FAQ</button>.
        </p>
      </section>

      <main>
        <form @submit=${(e) => this.#handleFetchProposal(e)}>
          <label>Proposal ID:</label>
          <input id="proposalId" type="number" placeholder="e.g. 138924" ?disabled=${loading} />
          <button type="submit" class=${loading ? 'loading btn' : 'btn'} ?disabled=${loading}>
            ${loading ? 'Fetching…' : 'Fetch Proposal'}
          </button>
          <button type="button" class="btn secondary" @click=${() => { this.view = 'faq'; this.#render(); }}>
            Open FAQ
          </button>
        </form>

        ${p ? html`
          <section>
            <h2>Proposal Details</h2>
            <p><b>ID:</b> ${p.id}</p>
            <p><b>Type:</b> ${p.proposalType}</p>
            <p><b>Title:</b> ${p.title || '(none)'} </p>
            <p><b>Summary (raw):</b></p>
            <pre>${p.summary}</pre>
            <button class="btn" @click=${(e) => this.#handleCopy(e, p.summary, 'Copy Summary')}>Copy Summary</button>

            <p><b>Extracted Repo:</b> ${p.extractedRepo ?? 'None'}</p>
            <p><b>Extracted Commit:</b>
              ${p.extractedCommit
                ? p.commitUrl
                  ? html`<a href="${p.commitUrl}" target="_blank" rel="noreferrer">${p.extractedCommit}</a>`
                  : p.extractedCommit
                : 'None'}
            </p>

            <p><b>Onchain WASM Hash:</b> ${p.proposal_wasm_hash ?? 'None'}</p>
            <p><b>Onchain Arg Hash:</b> ${p.proposal_arg_hash ?? 'None'}</p>

            <p><b>Expected WASM Hash (from Sources):</b> ${this.expectedHash ?? 'None'}
              ${this.expectedHash ? html`<em>(source: ${this.expectedHashSource || 'unknown'})</em>` : ''}</p>

            <p><b>Arg Hash (from Dashboard/API):</b> ${this.argHash ?? 'None'}</p>

            <p><b>Extracted Doc URL:</b>
              ${p.extractedDocUrl
                ? html`<a href="${p.extractedDocUrl}" target="_blank" rel="noreferrer">${p.extractedDocUrl}</a>`
                : 'None'}
            </p>
            <p><b>Artifact Path Hint:</b> ${p.extractedArtifact ?? 'None'}</p>

            <p><b>Commit Status:</b>
              ${this.commitStatus}
              ${p.commitUrl ? html`&nbsp;(<a href="${p.commitUrl}" target="_blank" rel="noreferrer">open</a>)` : ''}
            </p>

            ${this.dashboardUrl
              ? html`<p><b>Dashboard:</b> <a href="${this.dashboardUrl}" target="_blank" rel="noreferrer">${this.dashboardUrl}</a></p>`
              : ''}
          </section>

          <section>
            <h2>Relevant Links</h2>
            ${this.#renderLinks()}
          </section>

          ${this.#renderReleaseCommands()}

          ${this.#renderTypeGuidance()}

          ${this.#renderArgSection(p)}

          <section>
            <h2>Verify Documents / Local Files</h2>
            <details style="margin-bottom:8px;">
              <summary>What goes here?</summary>
              <p>
                For PDFs/WASMs/tar.zst: Download from links (e.g. wiki/forum), upload below. For each doc, expected hash from summary.
              </p>
            </details>
            ${this.#renderDocVerification()}
            <input id="docUrl" placeholder="Document URL (for text/JSON only)" value=${p.extractedDocUrl ?? ''} />
            <input id="expectedDocHash" placeholder="Expected SHA-256" value=${this.expectedHash || ''} />
            <button class="btn" @click=${() => this.#handleFetchVerifyDoc()}>Fetch & Verify URL (text only)</button>
          </section>

          <section>
            <h2>Payload (from Dashboard/API)</h2>
            <pre>${this.payloadSnippetFromDashboard ?? '(no payload snippet found from ic-api)'}</pre>
            <button class="btn" @click=${(e) => this.#handleCopy(e, this.payloadSnippetFromDashboard || '', 'Copy Payload')}>Copy Payload</button>
          </section>

          <section>
            <h2>Rebuild Locally</h2>
            ${p.extractedArtifact ? html`<p><b>Artifact (expected):</b> ${p.extractedArtifact}</p>` : ''}
            <pre>${this.rebuildScript}</pre>
            <button class="btn" @click=${(e) => this.#handleCopy(e, this.rebuildScript, 'Copy Script')}>Copy Script</button>
            <p>Compare your local <code>sha256sum</code> with the <b>onchain WASM hash</b>: ${p.proposal_wasm_hash ?? 'N/A'}</p>
          </section>

          <section>
            <h2>Checklist</h2>
            <ul>
              <li>Fetch: ${this.checklist.fetch ? '✅' : '❌'}</li>
              <li>Commit Check: ${this.checklist.commit ? '✅' : '❌'}</li>
              <li>Arg Hash: ${this.checklist.argsHash ? '✅' : '❌'}</li>
              <li>Doc / File Hash: ${this.checklist.docHash ? '✅' : '❌'}</li>
              <li>Expected WASM Hash from Sources: ${this.checklist.expected ? '✅' : '❌'}</li>
              <li>Rebuild & Compare: (Manual) ${this.checklist.rebuild ? '✅' : '❌'} <button class="btn secondary" @click=${() => { this.checklist.rebuild = true; this.#render(); }}>Mark Done</button></li>
            </ul>
          </section>
        ` : ''}
      </main>
    `;
    render(body, document.getElementById('root'));
  }
}

export default App;
