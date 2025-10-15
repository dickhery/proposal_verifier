import { html, render } from 'lit-html';
import { proposal_verifier_backend } from 'declarations/proposal_verifier_backend';
import { sha256 } from './utils.js';
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
  const s = hex.replace(/^0x/i, '').trim();
  if (!/^[0-9a-fA-F]*$/.test(s) || s.length % 2 !== 0) throw new Error('Invalid hex input');
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.substr(i * 2, 2), 16);
  return out;
}

// Parse "vec { ... }" with decimal or 0x.. bytes
function parseVecNat8Literal(text) {
  const m = text.trim().match(/^vec\s*\{([\s\S]*)\}$/i);
  if (!m) throw new Error('Not a vec literal; expected like: vec {1; 2; 0xFF}');
  const inner = m[1];
  const parts = inner.split(/[,;]\s*|\s+/).filter(Boolean);
  const bytes = new Uint8Array(parts.length);
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i].trim();
    if (!p) continue;
    const v = p.toLowerCase().startsWith('0x') ? parseInt(p, 16) : parseInt(p, 10);
    if (Number.isNaN(v) || v < 0 || v > 255) throw new Error(`Invalid byte: ${p}`);
    bytes[i] = v;
  }
  return bytes;
}

// Parse Candid blob literal: blob "\xx\ab..."
// We decode \xx (hex) escapes and raw ASCII characters.
function parseBlobLiteral(text) {
  const m = text.trim().match(/^blob\s*"([\s\S]*)"$/i);
  if (!m) throw new Error('Not a blob literal; expected like: blob "\\ab\\cd..."');
  const s = m[1];
  const out = [];
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\') {
      const h1 = s[i + 1], h2 = s[i + 2];
      if (/[0-9a-fA-F]/.test(h1 || '') && /[0-9a-fA-F]/.test(h2 || '')) {
        out.push(parseInt(h1 + h2, 16));
        i += 2;
      } else {
        // Fallback: keep the char escaped as-is (e.g., \" or \\n)
        const next = s[i + 1];
        if (next) {
          // Basic escapes: treat as literal char
          out.push(next.charCodeAt(0));
          i += 1;
        }
      }
    } else {
      out.push(ch.charCodeAt(0));
    }
  }
  return new Uint8Array(out);
}

class App {
  view = 'home'; // 'home' | 'faq'

  proposalData = null;
  commitStatus = '';
  hashMatch = false;
  hashError = '';
  docResults = [];
  rebuildScript = '';
  isFetching = false;
  isVerifyingArgs = false;
  cycleBalance = null;

  expectedHash = null;          // expected wasm/release hash (from sources)
  expectedHashSource = null;

  argHash = null;               // arg_hash (from dashboard/ic-api or backend)

  payloadSnippetFromDashboard = null;
  dashboardUrl = '';

  releasePackageUrls = [];

  // Arg UX state
  argInputType = 'text';        // 'text' | 'hex' | 'candid' | 'vec' | 'blob'
  argInputCurrent = '';
  argInputHint = '';
  extractedArgText = null;

  // NEW: type-aware fields
  verificationSteps = null;     // string with newline-separated steps from backend
  requiredTools = null;         // string from backend
  typeChecklists = new Map();   // type -> [{label, checked}]

  checklist = {
    fetch: false,
    commit: false,
    argsHash: false,
    docHash: false,
    expected: false,
    rebuild: false,
  };

  constructor() { this.#render(); }

  #setFetching(on) { this.isFetching = on; this.#render(); }
  #normalizeHex(s) { return String(s || '').trim().toLowerCase(); }

  #updateChecklist() {
    this.checklist = {
      fetch: !!this.proposalData,
      commit: this.commitStatus.startsWith('✅'),
      argsHash: this.hashMatch,
      docHash: this.docResults.every(r => r.match),
      expected: !!this.expectedHash,
      rebuild: this.checklist.rebuild || false,
    };
    // Keep the type-specific checklist in sync with the latest flags
    this.#updateTypeChecklist();
  }

  async #handleCopy(e, text, originalLabel) {
    const button = e.target;
    const fallbackCopy = () => {
      const ta = document.createElement('textarea');
      ta.value = text || '';
      ta.style.position = 'fixed';
      ta.style.opacity = 0;
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      try {
        const ok = document.execCommand('copy');
        if (ok) {
          button.innerText = 'Copied!';
          setTimeout(() => { button.innerText = originalLabel; }, 2000);
        } else {
          alert('Copy failed. Select and press Ctrl/Cmd+C.');
        }
      } catch (err) {
        alert('Copy failed: ' + (err?.message || String(err)));
      } finally {
        document.body.removeChild(ta);
      }
    };

    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text || '');
        button.innerText = 'Copied!';
        setTimeout(() => { button.innerText = originalLabel; }, 2000);
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

      // 1) expected WASM/release hash (prefer wasm_module_hash)
      const maybe = extractHexFromTextAroundMarkers(text);
      if (maybe) {
        this.expectedHash = maybe;
        this.expectedHashSource = 'ic-api';
      }

      // 2) arg_hash (separate)
      const argMaybe = extractHexFromTextAroundMarkers(text, ['arg_hash']);
      if (argMaybe) {
        this.argHash = argMaybe;
      }

      // 3) release package URLs
      const urls = new Set();
      const payloadUrls = text.match(RELEASE_URL_RE) || [];
      payloadUrls.forEach(u => urls.add(u));
      extractAllUrls(text)
        .filter(u => /https:\/\/download\.dfinity\.(systems|network)\//.test(u))
        .forEach(u => urls.add(u));
      this.releasePackageUrls = Array.from(urls);

      this.#render();
    } catch {
      // ignore ic-api failures
    }
  }

  async #handleFetchProposal(e) {
    e.preventDefault();
    if (this.isFetching) return;
    this.#setFetching(true);

    try {
      const idEl = document.getElementById('proposalId');
      const id = parseInt(idEl.value);

      const aug = await proposal_verifier_backend.getProposalAugmented(BigInt(id));
      if (aug.err) throw new Error(aug.err || 'Unknown error from backend');

      const unwrap = (opt) => opt?.[0] ?? null;
      const data = aug.ok;
      const base = data.base;

      const extractedUrls = base.extractedUrls || [];

      this.proposalData = {
        id: Number(base.id),
        summary: base.summary,
        url: base.url,
        title: unwrap(base.title),
        extractedCommit: unwrap(base.extractedCommit),
        extractedHash: unwrap(base.extractedHash),
        extractedDocUrl: unwrap(base.extractedDocUrl),
        extractedRepo: unwrap(base.extractedRepo),
        extractedArtifact: unwrap(base.extractedArtifact),
        proposalType: base.proposalType,
        extractedUrls,
        commitUrl: unwrap(base.commitUrl),
        extractedDocs: base.extractedDocs || [],
        proposal_wasm_hash: unwrap(base.proposal_wasm_hash),
        proposal_arg_hash: unwrap(base.proposal_arg_hash),
      };

      // Source hashes
      this.expectedHash =
        unwrap(data.expectedHashFromDashboard) ||
        this.proposalData.extractedHash ||
        null;
      this.expectedHashSource =
        unwrap(data.expectedHashSource) ||
        (this.proposalData.extractedHash ? 'proposal:summary' : null);

      // Separate arg_hash (if exposed)
      this.argHash = unwrap(data.argHashFromDashboard) || this.argHash || null;

      this.payloadSnippetFromDashboard = unwrap(data.payloadSnippetFromDashboard);
      this.dashboardUrl = data.dashboardUrl;

      // Optional Candid-looking arg text
      this.extractedArgText = unwrap(data.extractedArgText) || null;

      // NEW: Type-specific content from backend
      this.verificationSteps = unwrap(data.verificationSteps) || null;
      this.requiredTools = unwrap(data.requiredTools) || null;

      // Initialize Arg input UX defaults (collapsed guidance by default)
      this.argInputHint = '';
      this.argInputType = 'text';
      if (this.extractedArgText && CANDID_PATTERN.test(this.extractedArgText)) {
        this.argInputCurrent = this.extractedArgText;
        this.argInputType = 'candid';
        this.argInputHint = 'Detected Candid-like text. Encode with didc, then paste the hex under "Hex Bytes".';
      } else {
        if (this.payloadSnippetFromDashboard && CANDID_PATTERN.test(this.payloadSnippetFromDashboard)) {
          this.argInputCurrent = this.payloadSnippetFromDashboard.trim();
          this.argInputType = 'candid';
          this.argInputHint = 'Detected possible Candid in payload snippet. Encode with didc before hashing.';
        } else {
          this.argInputCurrent = '';
        }
      }

      // Prefill from ic-api
      await this.#prefillFromIcApi(id);

      // Commit check
      this.commitStatus = '';
      const repo = this.proposalData.extractedRepo || 'dfinity/ic';
      const commit = this.proposalData.extractedCommit || '';
      if (commit) {
        const commitResult = await proposal_verifier_backend.checkGitCommit(repo, commit);
        if (commitResult.ok) {
          this.commitStatus = `✅ Commit exists on ${repo}@${commit.substring(0, 12)}`;
        } else {
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
        this.proposalData.proposalType,
        this.proposalData.extractedCommit || ''
      );

      // Init per-doc results (verifiable entries only)
      this.docResults = this.proposalData.extractedDocs
        .filter(d => d.hash != null)
        .map(d => ({
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
          'Accept': 'application/vnd.github.v3+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      });
      if (!res.ok) return false;
      const json = await res.json();
      return !!json?.sha;
    } catch {
      return false;
    }
  }

  async #tryClientSideHint(url) {
    try {
      const { hostname } = new URL(url);
      if (!CORS_ALLOWED_HOSTS.has(hostname)) return false;
      const res = await fetch(url, { credentials: 'omit', mode: 'cors' });
      if (!res.ok) return false;
      const ct = res.headers.get('content-type') || '';
      const bytes = new Uint8Array(await res.arrayBuffer());
      let text = '';
      if (ct.startsWith('text/') || ct.includes('json') || ct.includes('markdown') || ct.includes('html')) {
        text = new TextDecoder().decode(bytes);
      }
      const found = extractHexFromTextAroundMarkers(text || '');
      if (found) {
        this.expectedHash = found;
        this.expectedHashSource = new URL(url).hostname;
        this.#render();
        return true;
      }
    } catch {
      // ignore
    }
    return false;
  }

  async #handleFetchVerifyDoc() {
    const url = document.getElementById('docUrl').value || this.proposalData?.extractedDocUrl || '';
    const expected = document.getElementById('expectedDocHash').value || this.expectedHash || '';
    this.docHashError = '';
    this.docPreview = '';
    try {
      const result = await proposal_verifier_backend.fetchDocument(url);
      if (result.ok) {
        const bodyArray = new Uint8Array(result.ok.body);
        const computedHash = await sha256(bodyArray);
        this.docHashMatch = !!expected && (this.#normalizeHex(computedHash) === this.#normalizeHex(expected));
        const contentType = result.ok.headers.find(h => h.name.toLowerCase() === 'content-type')?.value || '';
        if (contentType.startsWith('text/')) {
          this.docPreview = new TextDecoder().decode(bodyArray).substring(0, 200) + '…';
        } else {
          this.docPreview = `${contentType || 'binary'} (${bodyArray.length} bytes)`;
        }
      } else {
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
      this.docHashError = err.message || String(err);
      this.docHashMatch = false;
    }
    this.#updateChecklist();
    this.#render();
  }

  async #handleFileUpload(e, docIndex) {
    const file = e.target.files[0];
    if (!file) return;
    const doc = this.proposalData.extractedDocs[docIndex];
    if (doc.hash == null) return;
    const expected = doc.hash || this.expectedHash || '';
    this.docResults[docIndex] = { ...this.docResults[docIndex], error: '', preview: '', match: false };
    this.#render();

    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const computedHash = await sha256(bytes);
      const match = !!expected && (this.#normalizeHex(computedHash) === this.#normalizeHex(expected));
      const ct = file.type || 'binary';
      const preview = ct.startsWith('text/') ? new TextDecoder().decode(bytes).substring(0, 200) + '…' : `${ct} (${bytes.length} bytes) - Local file: ${file.name}`;
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
    (p.extractedUrls || []).forEach(push);

    const links = [...set.values()];
    if (!links.length) return html`<p>(no links found)</p>`;

    return html`
      <ul class="links">
        ${links.map(u => html`<li><a href="${u}" target="_blank" rel="noreferrer">${u}</a></li>`)}
      </ul>
    `;
  }

  #renderReleaseCommands() {
    if (!this.releasePackageUrls.length) return null;
    const expected = this.expectedHash || '';
    const cmds = this.releasePackageUrls.map((u, idx) => {
      const fname = `update-img-${idx + 1}.tar.zst`;
      return {
        url: u,
        cmd: `curl -fsSL "${u}" -o ${fname}\nsha256sum ${fname}  # expect ${expected}`
      };
    });
    return html`
      <section>
        <h2>Release Package URLs & Quick Verify</h2>
        <ul class="links">
          ${this.releasePackageUrls.map(u => html`<li><a href="${u}" target="_blank" rel="noreferrer">${u}</a></li>`)}
        </ul>
        <p><b>Shell commands (download & hash locally):</b></p>
        <pre>${cmds.map(x => `# ${x.url}\n${x.cmd}`).join('\n\n')}</pre>
        <button @click=${(e) => this.#handleCopy(e, cmds.map(x => x.cmd).join('\n\n'), 'Copy Commands')}>Copy Commands</button>
      </section>
    `;
  }

  #renderTypeGuidance() {
    const type = this.proposalData?.proposalType || '';
    switch (type) {
      case 'ParticipantManagement':
        return html`
          <details class="type-guidance">
            <summary><b>Guidance for Node Provider Proposals</b></summary>
            <p>These proposals verify documents (PDFs). Download the exact file provided by the proposer from the wiki (<a href="https://wiki.internetcomputer.org" target="_blank">IC Wiki</a>), upload below for each doc. Hashes must match summary.</p>
            <p>Check forum announcement for context.</p>
          </details>
        `;
      case 'IcOsVersionDeployment':
        return html`
          <details class="type-guidance">
            <summary><b>Guidance for IC-OS Elections</b></summary>
            <p>Download release package (.tar.zst) using curl commands above. Hash locally with <code>sha256sum</code>. Compare to <code>release_package_sha256_hex</code>.</p>
          </details>
        `;
      default: return null;
    }
  }

  #renderDocVerification() {
    const docs = (this.proposalData?.extractedDocs || []).filter(d => d.hash != null);
    if (!docs.length) return html`<p>No documents extracted. Paste URL or upload manually.</p>`;

    return html`
      <ul class="doc-list">
        ${docs.map((d, idx) => {
          const res = this.docResults[idx] || {match: false, error: '', preview: ''};
          return html`
            <li>
              <b>${d.name}</b> (expected: ${d.hash || 'none'})
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

  // --- Arg UX ---

  #handleArgTypeChange(val) {
    this.argInputType = val;
    if (val === 'candid') {
      this.hashError = 'Candid text must be encoded to bytes (e.g., with `didc encode`) before hashing.';
    } else {
      this.hashError = '';
    }
    this.#render();
  }

  #handleArgInputChange(e) {
    const v = (e?.target?.value ?? '').trim();
    this.argInputCurrent = v;

    // Friendly hints / auto-detect
    if (this.argInputType !== 'candid' && CANDID_PATTERN.test(v)) {
      this.argInputHint = 'Looks like Candid text. Choose "Candid Text" and encode with didc first.';
    } else if (/^vec\s*\{[\s\S]*\}$/i.test(v)) {
      this.argInputHint = 'Looks like a Candid vec nat8. Choose “vec nat8 list”.';
    } else if (/^blob\s*"/i.test(v)) {
      this.argInputHint = 'Looks like a Candid blob literal. Choose “blob literal”.';
    } else if (/^(0x)?[0-9a-fA-F]+$/.test(v) && (v.replace(/^0x/i, '').length % 2 === 0)) {
      this.argInputHint = 'This looks like hex bytes. Choose "Hex Bytes".';
    } else {
      this.argInputHint = '';
    }
  }

  #buildDidcCommand() {
    const input = (this.argInputCurrent || '').trim();
    if (!input) return `didc encode '()' | xxd -p -c0 | tr -d '\\n'`;
    return `didc encode '(${input})' | xxd -p -c0 | tr -d '\\n'`;
    // NOTE: For complex types, you may need to specify an explicit type with didc.
  }

  async #handleVerifyArgHash() {
    this.isVerifyingArgs = true;
    this.hashError = '';
    this.#render();

    const argsRaw = (this.argInputCurrent || '').trim();
    const inputExpected =
      (document.getElementById('expectedArgHash')?.value || '').trim() ||
      this.argHash ||
      '';

    try {
      if (!inputExpected) {
        this.hashError = 'No expected arg hash found (dashboard/api). Paste expected hash or refetch.';
        this.hashMatch = false;
        this.isVerifyingArgs = false;
        this.#updateChecklist();
        this.#render();
        return;
      }

      let bytes = null;

      // Explicit type chosen by user
      switch (this.argInputType) {
        case 'hex':
          if (!argsRaw) throw new Error('Paste hex bytes (from didc output or other source).');
          bytes = hexToBytes(argsRaw);
          break;

        case 'vec':
          if (!/^vec\s*\{[\s\S]*\}$/i.test(argsRaw)) throw new Error('Expected a Candid vec nat8 literal like: vec {1; 2; 0xFF}');
          bytes = parseVecNat8Literal(argsRaw);
          break;

        case 'blob':
          if (!/^blob\s*"/i.test(argsRaw)) throw new Error('Expected a Candid blob literal like: blob "\\22\\c4\\81..."');
          bytes = parseBlobLiteral(argsRaw);
          break;

        case 'text':
          if (!argsRaw) throw new Error('Paste text to hash, or choose a more specific mode.');
          // Raw UTF-8 bytes of the pasted text (rarely correct for args)
          bytes = new TextEncoder().encode(argsRaw);
          break;

        case 'candid':
          this.hashError = 'Candid text must be encoded first (see didc command below), then paste the resulting hex under "Hex Bytes".';
          this.hashMatch = false;
          this.isVerifyingArgs = false;
          this.#updateChecklist();
          this.#render();
          return;

        default:
          // Try to auto-detect if no explicit choice
          if (/^(0x)?[0-9a-fA-F]+$/.test(argsRaw) && (argsRaw.replace(/^0x/i, '').length % 2 === 0)) {
            bytes = hexToBytes(argsRaw);
          } else if (/^vec\s*\{[\s\S]*\}$/i.test(argsRaw)) {
            bytes = parseVecNat8Literal(argsRaw);
          } else if (/^blob\s*"/i.test(argsRaw)) {
            bytes = parseBlobLiteral(argsRaw);
          } else if (argsRaw) {
            bytes = new TextEncoder().encode(argsRaw);
          } else {
            throw new Error('Provide arg bytes (hex), vec nat8, blob literal, or candid (encode first).');
          }
          break;
      }

      const computedHash = await sha256(bytes);
      this.hashMatch = (this.#normalizeHex(computedHash) === this.#normalizeHex(inputExpected));
    } catch (err) {
      this.hashError = err.message || String(err);
      this.hashMatch = false;
    }

    this.#updateChecklist();
    this.isVerifyingArgs = false;
    this.#render();
  }

  #renderArgSection(p) {
    const didcCmd = this.#buildDidcCommand();
    return html`
      <section>
        <h2>Verify Arg Hash (Binary)</h2>

        <details>
          <summary>How to choose an input</summary>
          <ol>
            <li><b>Hex Bytes:</b> Paste the bytes as hex (from <code>didc encode</code> or another tool). We hash bytes.</li>
            <li><b>vec nat8 list:</b> Paste a Candid list like <code>vec {34; 196; 0x81; ...}</code>. We parse to bytes and hash.</li>
            <li><b>blob "…":</b> Paste a Candid <code>blob</code> literal with <code>\\xx</code> escapes (like the strings <code>dfx</code> prints). We decode then hash.</li>
            <li><b>Candid Text:</b> Paste human-readable Candid such as <code>()</code> or <code>record {}</code> <i>only</i> to build the command below. Run it locally, then paste the <b>hex output</b> under <b>Hex Bytes</b>.</li>
          </ol>
          <p><b>didc command builder (based on your input):</b></p>
          <pre class="cmd-pre">${didcCmd}</pre>
          <div style="display:flex; gap:8px; flex-wrap:wrap;">
            <button class="btn secondary" @click=${(e) => this.#handleCopy(e, didcCmd, 'Copy didc Command')}>Copy didc Command</button>
            <a class="btn secondary" href="https://github.com/dfinity/candid/tree/master/tools/didc" target="_blank" rel="noreferrer">Install didc</a>
          </div>
          <p style="margin-top:6px;"><b>Note:</b> The governance API exposes <code>arg_hash</code> (bytes), not the original <code>arg</code>. You must reconstruct the exact bytes and hash them to match onchain.</p>
        </details>

        <div class="radio-group">
          <label><input type="radio" name="argType" value="hex" ?checked=${this.argInputType === 'hex'} @change=${(e) => this.#handleArgTypeChange(e.target.value)} /> Hex Bytes</label>
          <label><input type="radio" name="argType" value="vec" ?checked=${this.argInputType === 'vec'} @change=${(e) => this.#handleArgTypeChange(e.target.value)} /> vec nat8 list</label>
          <label><input type="radio" name="argType" value="blob" ?checked=${this.argInputType === 'blob'} @change=${(e) => this.#handleArgTypeChange(e.target.value)} /> blob literal</label>
          <label><input type="radio" name="argType" value="candid" ?checked=${this.argInputType === 'candid'} @change=${(e) => this.#handleArgTypeChange(e.target.value)} /> Candid Text (encode first)</label>
          <label><input type="radio" name="argType" value="text" ?checked=${this.argInputType === 'text'} @change=${(e) => this.#handleArgTypeChange(e.target.value)} /> Plain Text/JSON</label>
        </div>

        <textarea
          id="argInput"
          placeholder="Paste arg as hex / vec nat8 / blob literal / Candid (for didc)"
          @input=${(e) => this.#handleArgInputChange(e)}
        >${this.argInputCurrent}</textarea>

        ${this.argInputHint ? html`<p style="margin:6px 0 0;"><em>${this.argInputHint}</em></p>` : ''}

        <input id="expectedArgHash" placeholder="Expected Arg SHA-256" value=${this.argHash || p.proposal_arg_hash || ''} />

        <div style="display:flex; gap:8px; flex-wrap:wrap;">
          <button class="btn" @click=${() => this.#handleVerifyArgHash()} class=${this.isVerifyingArgs ? 'loading' : ''} ?disabled=${this.isVerifyingArgs}>
            ${this.isVerifyingArgs ? 'Verifying...' : 'Verify Arg Hash'}
          </button>
        </div>

        <p><b>Match:</b> ${this.hashMatch ? '✅ Yes' : '❌ No'}</p>
        ${this.hashError ? html`<p class="error">${this.hashError}</p>` : ''}

        <h3>Manual Onchain Check</h3>
        <pre>dfx canister call rrkah-fqaaa-aaaaa-aaaaq-cai get_proposal_info '( ${p.id} )' --network ic
# In the Candid response, look for:
#   action = opt variant { InstallCode = record { arg_hash = opt vec nat8 ... } }
# This is the onchain SHA-256 hash (bytes) of the binary arg that was sent.
# To match it, reconstruct the exact arg bytes locally (often Candid-encoded),
# compute SHA-256, and compare to: ${p.proposal_arg_hash ?? '(N/A)'}.</pre>
      </section>
    `;
  }

  // --- NEW: type-specific steps/checklist renderers ---

  #renderVerificationSteps() {
    const steps = (this.verificationSteps || '').trim();
    if (!steps) return html`<p>No type-specific steps available for this proposal.</p>`;
    // Split by newlines, filter empties
    const items = steps.split('\n').map(s => s.trim()).filter(Boolean);
    return html`
      <ol class="steps-list">
        ${items.map(s => html`<li>${s}</li>`)}
      </ol>
    `;
  }

  #renderTypeChecklist() {
    const items = this.typeChecklists.get(this.proposalData?.proposalType) || [
      {label: 'Fetch', checked: this.checklist.fetch},
      {label: 'Commit Check', checked: this.checklist.commit},
      {label: 'Arg Hash', checked: this.checklist.argsHash},
      {label: 'Doc / File Hash', checked: this.checklist.docHash},
      {label: 'Expected Hash from Sources', checked: this.checklist.expected},
      {label: 'Rebuild & Compare', checked: this.checklist.rebuild},
    ];
    return html`
      <ul>
        ${items.map(item => html`<li>${item.label}: ${item.checked ? '✅' : '❌'}</li>`)}
      </ul>
      <div style="margin-top:8px;">
        <button class="btn secondary" @click=${() => { this.checklist.rebuild = true; this.#updateChecklist(); this.#render(); }}>Mark Rebuild Done</button>
      </div>
    `;
  }

  #updateTypeChecklist() {
    const type = this.proposalData?.proposalType || 'Unknown';
    let items;
    switch (type) {
      case 'ProtocolCanisterManagement':
        items = [
          {label: 'Fetch Proposal', checked: this.checklist.fetch},
          {label: 'Commit Check', checked: this.checklist.commit},
          {label: 'Expected WASM Hash Present', checked: this.checklist.expected},
          {label: 'Arg Hash Verified', checked: this.checklist.argsHash},
          {label: 'WASM Rebuilt & Hash Matched', checked: this.checklist.rebuild},
        ];
        break;
      case 'IcOsVersionDeployment':
        items = [
          {label: 'Fetch Proposal', checked: this.checklist.fetch},
          {label: 'Expected Release Hash Present', checked: this.checklist.expected},
          {label: 'Commit Check (if provided)', checked: this.checklist.commit},
          {label: 'Release Package Hash Verified', checked: this.checklist.docHash}, // reuse docHash flag for files you verify
        ];
        break;
      case 'ParticipantManagement':
        items = [
          {label: 'Fetch Proposal', checked: this.checklist.fetch},
          {label: 'All PDFs Hash-Matched', checked: this.checklist.docHash},
          {label: 'Forum/Wiki Context Checked', checked: false}, // manual
        ];
        break;
      case 'Governance':
        items = [
          {label: 'Fetch Proposal', checked: this.checklist.fetch},
          {label: 'Manual Policy Review', checked: false},
        ];
        break;
      default:
        items = [
          {label: 'Fetch Proposal', checked: this.checklist.fetch},
          {label: 'Manual Review', checked: false},
        ];
    }
    this.typeChecklists.set(type, items);
  }

  #render() {
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
          <b>Advisory:</b> This tool surfaces links, hashes, and commands to assist verification.
          Always prefer <b>reproducible builds</b> and compare with onchain metadata.
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

            <p><b>Expected WASM/Release Hash (from Sources):</b> ${this.expectedHash ?? 'None'}
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
            <details>
              <summary>How to use</summary>
              <p>For PDFs/WASMs/tar.zst: download from links (e.g., wiki/forum), upload below. Hashes must match the proposal summary or dashboard.</p>
            </details>
            ${this.#renderDocVerification()}
            <input id="docUrl" placeholder="Document URL (text/JSON only)" value=${p.extractedDocUrl ?? ''} />
            <input id="expectedDocHash" placeholder="Expected SHA-256" value=${this.expectedHash || ''} />
            <button class="btn" @click=${() => this.#handleFetchVerifyDoc()}>Fetch & Verify URL (text only)</button>
            ${this.docHashError ? html`<p class="error" style="margin-top:8px;">${this.docHashError}</p>` : ''}
            ${typeof this.docHashMatch === 'boolean' ? html`<p><b>URL Hash Match:</b> ${this.docHashMatch ? '✅ Yes' : '❌ No'}</p>` : ''}
            ${this.docPreview ? html`<p><b>Preview:</b> ${this.docPreview}</p>` : ''}
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
            <h2>Verification Steps for ${p.proposalType}</h2>
            ${this.#renderVerificationSteps()}
          </section>

          <section>
            <h2>Required Tools</h2>
            <pre>${this.requiredTools || 'No specific tools required for this type.'}</pre>
          </section>

          <section>
            <h2>Checklist</h2>
            ${this.#renderTypeChecklist()}
          </section>
        ` : ''}
      </main>
    `;
    render(body, document.getElementById('root'));
  }
}

export default App;
