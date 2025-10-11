import { html, render } from 'lit-html';
import { proposal_verifier_backend } from 'declarations/proposal_verifier_backend';
import { sha256 } from './utils.js';

// Hosts that usually allow cross-origin browser fetches.
const CORS_ALLOWED_HOSTS = new Set([
  'ic-api.internetcomputer.org',
  'api.github.com',
  'raw.githubusercontent.com',
  'dashboard.internetcomputer.org',
]);

// find any 64-hex near likely markers
function extractHexFromTextAroundMarkers(
  text,
  markers = [
    'expected_hash',
    'wasm_module_hash',
    'sha256',
    'hash',
    'sha-256',
    'sha256sum',
    'wasm hash',
    'module hash',
    'sha256 hash',
    'module sha256',
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

// A stricter URL extractor for any UI parsing we still do client-side
export function extractAllUrls(text) {
  // whitespace-bounded raw URLs, then sanitize common trailing punctuation
  const raw = text.match(/\bhttps?:\/\/[^\s]+/gi) || [];
  const sanitized = raw.map((u) => {
    let s = u;
    // trim trailing punctuation
    while (/[)\]\}\.,;:'"`]$/.test(s)) s = s.slice(0, -1);
    // drop extra unmatched right parens
    const left = (s.match(/\(/g) || []).length;
    const right = (s.match(/\)/g) || []).length;
    while (right > left && s.endsWith(')')) {
      s = s.slice(0, -1);
      // eslint-disable-next-line no-loop-func
      const rr = (s.match(/\)/g) || []).length;
      const ll = (s.match(/\(/g) || []).length;
      if (rr <= ll) break;
    }
    return s;
  });
  return [...new Set(sanitized)];
}

class App {
  proposalData = null;
  commitStatus = '';
  hashMatch = false;
  hashError = '';
  docHashMatch = false;
  docHashError = '';
  docPreview = '';
  rebuildScript = '';
  isFetching = false;
  cycleBalance = null;

  expectedHash = null;
  expectedHashSource = null;

  payloadSnippetFromDashboard = null;
  dashboardUrl = '';

  checklist = {
    fetch: false,
    commit: false,
    hash: false,
    expected: false,
    rebuild: false,
  };

  constructor() { this.#render(); }

  #setFetching(on) { this.isFetching = on; this.#render(); }
  #normalizeHex(s) { return (s || '').trim().toLowerCase(); }

  #updateChecklist() {
    this.checklist = {
      fetch: !!this.proposalData,
      commit: this.commitStatus.startsWith('✅'),
      hash: this.hashMatch || this.docHashMatch,
      expected: !!this.expectedHash,
      rebuild: false,
    };
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
          alert('Copy failed. Select the text and press Ctrl/Cmd+C.');
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
        // NEW
        extractedUrls,
        commitUrl: unwrap(base.commitUrl),
      };

      this.expectedHash = unwrap(data.expectedHashFromDashboard) || this.proposalData.extractedHash || null;
      this.expectedHashSource = unwrap(data.expectedHashSource) || (this.proposalData.extractedHash ? 'proposal:summary' : null);

      this.payloadSnippetFromDashboard = unwrap(data.payloadSnippetFromDashboard);
      this.dashboardUrl = data.dashboardUrl;

      // Commit check (canister first, then browser fallback)
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

      // OPTIONAL: client-side discovery of expected hash from CORS-friendly URLs
      if (!this.expectedHash) {
        const urls = this.proposalData.extractedUrls.length
          ? this.proposalData.extractedUrls
          : extractAllUrls(this.proposalData.summary);
        for (const u of urls) {
          const { hostname } = new URL(u);
          if (!CORS_ALLOWED_HOSTS.has(hostname)) continue;
          const found = await this.#tryClientSideHint(u);
          if (found) break;
        }
      }

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
      // ignore CORS/network errors
    }
    return false;
  }

  async #handleVerifyHash() {
    const args = document.getElementById('args').value || '';
    const inputExpected = document.getElementById('expectedHash').value || this.expectedHash || '';
    this.hashError = '';
    try {
      const computedHash = await sha256(args);
      this.hashMatch = !!inputExpected && (this.#normalizeHex(computedHash) === this.#normalizeHex(inputExpected));
    } catch (err) {
      this.hashError = err.message || String(err);
      this.hashMatch = false;
    }
    this.#updateChecklist();
    this.#render();
  }

  async #handleFetchVerifyDoc() {
    const url = document.getElementById('docUrl').value || this.proposalData?.extractedDocUrl || '';
    const expected = document.getElementById('expectedDocHash').value || this.expectedHash || '';
    this.docHashError = '';
    this.docPreview = '';
    try {
      // Try canister fetch first (deterministic sources only)
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
          throw new Error(`CORS likely blocked by ${hostname}. Try downloading manually and hashing locally.`);
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

  async #handleFileUpload(e) {
    const file = e.target.files[0];
    if (!file) return;
    this.docHashError = '';
    this.docPreview = '';
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const computedHash = await sha256(bytes);
      const expected = document.getElementById('expectedDocHash').value || this.expectedHash || '';
      this.docHashMatch = !!expected && (this.#normalizeHex(computedHash) === this.#normalizeHex(expected));
      const ct = file.type || 'binary';
      if (ct.startsWith('text/')) {
        this.docPreview = new TextDecoder().decode(bytes).substring(0, 200) + '…';
      } else {
        this.docPreview = `${ct} (${bytes.length} bytes) - Local file: ${file.name}`;
      }
    } catch (err) {
      this.docHashError = err.message || String(err);
      this.docHashMatch = false;
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

  #render() {
    const p = this.proposalData;
    const loading = this.isFetching;

    const body = html`
      <main>
        <h1>IC Proposal Verifier</h1>
        <form @submit=${(e) => this.#handleFetchProposal(e)}>
          <label>Proposal ID:</label>
          <input id="proposalId" type="number" placeholder="e.g. 138887" ?disabled=${loading} />
          <button type="submit" class=${loading ? 'loading' : ''} ?disabled=${loading}>
            ${loading ? 'Fetching…' : 'Fetch Proposal'}
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
            <button @click=${(e) => this.#handleCopy(e, p.summary, 'Copy Summary')}>Copy Summary</button>

            <p><b>Extracted Repo:</b> ${p.extractedRepo ?? 'None'}</p>
            <p><b>Extracted Commit:</b>
              ${p.extractedCommit
                ? p.commitUrl
                  ? html`<a href="${p.commitUrl}" target="_blank" rel="noreferrer">${p.extractedCommit}</a>`
                  : p.extractedCommit
                : 'None'}
            </p>

            <p><b>Expected Hash (from Sources):</b> ${this.expectedHash ?? 'None'}
              ${this.expectedHash ? html`<em>(source: ${this.expectedHashSource || 'unknown'})</em>` : ''}</p>

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

          <section>
            <h2>Verify Args Hash</h2>
            <textarea id="args" placeholder="Paste proposal args (or doc text) to hash"></textarea>
            <input id="expectedHash" placeholder="Expected SHA-256 (hex, 64 chars)" value=${this.expectedHash || ''} />
            <button @click=${() => this.#handleVerifyHash()}>Verify</button>
            <p><b>Match:</b> ${this.hashMatch ? '✅ Yes' : '❌ No'}</p>
            ${this.hashError ? html`<p class="error">${this.hashError}</p>` : ''}
          </section>

          <section>
            <h2>Verify Linked Document / Local File</h2>
            <input id="docUrl" placeholder="Document URL" value=${p.extractedDocUrl ?? ''} />
            <input id="expectedDocHash" placeholder="Expected SHA-256" value=${this.expectedHash || ''} />
            <button @click=${() => this.#handleFetchVerifyDoc()}>Fetch & Verify URL</button>
            <input type="file" @change=${(e) => this.#handleFileUpload(e)} />
            <p><b>Match:</b> ${this.docHashMatch ? '✅ Yes' : '❌ No'}</p>
            ${this.docHashError ? html`<p class="error">${this.docHashError}</p>` : ''}
            <p><b>Preview:</b> ${this.docPreview}</p>
          </section>

          <section>
            <h2>Payload (from Dashboard/API)</h2>
            <pre>${this.payloadSnippetFromDashboard ?? '(no payload snippet found from ic-api)'}</pre>
            <button @click=${(e) => this.#handleCopy(e, this.payloadSnippetFromDashboard || '', 'Copy Payload')}>Copy Payload</button>
          </section>

          <section>
            <h2>Rebuild Locally</h2>
            ${p.extractedArtifact ? html`<p><b>Artifact (expected):</b> ${p.extractedArtifact}</p>` : ''}
            <pre>${this.rebuildScript}</pre>
            <button @click=${(e) => this.#handleCopy(e, this.rebuildScript, 'Copy Script')}>Copy Script</button>
            <p>Compare your local <code>sha256sum</code> with the on-chain / dashboard hash.</p>
          </section>

          <section>
            <h2>Checklist</h2>
            <ul>
              <li>Fetch: ${this.checklist.fetch ? '✅' : '❌'}</li>
              <li>Commit Check: ${this.checklist.commit ? '✅' : '❌'}</li>
              <li>Args / Doc Hash: ${this.checklist.hash ? '✅' : '❌'}</li>
              <li>Expected Hash from Sources: ${this.checklist.expected ? '✅' : '❌'}</li>
              <li>Rebuild & Compare: (Manual) ${this.checklist.rebuild ? '✅' : '❌'} <button @click=${() => { this.checklist.rebuild = true; this.#render(); }}>Mark Done</button></li>
            </ul>
          </section>
        ` : ''}
      </main>
    `;
    render(body, document.getElementById('root'));
  }
}

export default App;
