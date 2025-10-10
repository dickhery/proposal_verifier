import { html, render } from 'lit-html';
import { proposal_verifier_backend } from 'declarations/proposal_verifier_backend';
import { sha256 } from './utils.js';

// Hosts that usually allow cross-origin browser fetches.
const CORS_ALLOWED_HOSTS = new Set([
  'ic-api.internetcomputer.org',
  'api.github.com',
  'raw.githubusercontent.com',
]);

// find any 64-hex near likely markers
function extractHexFromTextAroundMarkers(text, markers = ['expected_hash', 'wasm_module_hash', 'sha256', 'hash']) {
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

function extractAllUrls(text) {
  const re = /\bhttps?:\/\/[^\s)>"']+/gi;
  return [...new Set((text.match(re) || []).map(s => s.replace(/[),.]+$/, '')))];
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

  expectedHash = null;
  expectedHashSource = null;

  payloadSnippetFromDashboard = null;
  dashboardUrl = '';

  constructor() { this.#render(); }

  #setFetching(on) { this.isFetching = on; this.#render(); }
  #normalizeHex(s) { return (s || '').trim().toLowerCase(); }

  async #handleFetchProposal(e) {
    e.preventDefault();
    if (this.isFetching) return;
    this.#setFetching(true);

    try {
      const idEl = document.getElementById('proposalId');
      const id = parseInt(idEl.value);

      const aug = await proposal_verifier_backend.getProposalAugmented(BigInt(id));
      if (aug.err) throw new Error(aug.err);

      const unwrap = (opt) => opt?.[0] ?? null;
      const data = aug.ok;
      const base = data.base;

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
      };

      this.expectedHash = unwrap(data.expectedHashFromDashboard) || this.proposalData.extractedHash || null;
      this.expectedHashSource = unwrap(data.expectedHashSource) || (this.proposalData.extractedHash ? 'proposal:summary' : null);

      this.payloadSnippetFromDashboard = unwrap(data.payloadSnippetFromDashboard);
      this.dashboardUrl = data.dashboardUrl;

      // Commit check (canister first, then browser fallback on any error)
      this.commitStatus = '';
      const repo = this.proposalData.extractedRepo || 'dfinity/ic';
      const commit = this.proposalData.extractedCommit || '';
      if (commit) {
        const commitResult = await proposal_verifier_backend.checkGitCommit(repo, commit);
        if (commitResult.ok) {
          this.commitStatus = `✅ Commit exists on ${repo}@${commit.substring(0, 12)}`;
        } else {
          // Browser fallback if the canister failed to reach consensus or rate-limited
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

      // OPTIONAL: Try client-side fetch only from CORS-friendly hosts to discover expected hash
      if (!this.expectedHash) {
        const urls = extractAllUrls(this.proposalData.summary);
        for (const u of urls) {
          const { hostname } = new URL(u);
          if (!CORS_ALLOWED_HOSTS.has(hostname)) continue;
          const found = await this.#tryClientSideHint(u);
          if (found) break;
        }
      }
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
        // If canister refused (non-deterministic), try browser fetch (requires CORS)
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
    this.#render();
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

            <p><b>Extracted Repo:</b> ${p.extractedRepo ?? 'None'}</p>
            <p><b>Extracted Commit:</b> ${p.extractedCommit ?? 'None'}</p>

            <p><b>Expected Hash (from Sources):</b> ${this.expectedHash ?? 'None'}
              ${this.expectedHash ? html`<em>(source: ${this.expectedHashSource || 'unknown'})</em>` : ''}</p>

            <p><b>Extracted Doc URL:</b> ${p.extractedDocUrl ?? 'None'}</p>
            <p><b>Artifact Path Hint:</b> ${p.extractedArtifact ?? 'None'}</p>
            <p><b>Commit Status:</b> ${this.commitStatus}</p>

            ${this.dashboardUrl
              ? html`<p><b>Dashboard:</b> <a href="${this.dashboardUrl}" target="_blank" rel="noreferrer">${this.dashboardUrl}</a></p>`
              : ''}
          </section>

          <section>
            <h2>Verify Args Hash</h2>
            <input id="args" placeholder="Paste proposal args (or doc text) to hash" />
            <input id="expectedHash" placeholder="Expected SHA-256 (hex, 64 chars)" value=${this.expectedHash || ''} />
            <button @click=${() => this.#handleVerifyHash()}>Verify</button>
            <p><b>Match:</b> ${this.hashMatch ? '✅ Yes' : '❌ No'}</p>
            ${this.hashError ? html`<p class="error">${this.hashError}</p>` : ''}
          </section>

          <section>
            <h2>Verify Linked Document</h2>
            <input id="docUrl" placeholder="Document URL" value=${p.extractedDocUrl ?? ''} />
            <input id="expectedDocHash" placeholder="Expected SHA-256" value=${this.expectedHash || ''} />
            <button @click=${() => this.#handleFetchVerifyDoc()}>Fetch & Verify</button>
            <p><b>Match:</b> ${this.docHashMatch ? '✅ Yes' : '❌ No'}</p>
            ${this.docHashError ? html`<p class="error">${this.docHashError}</p>` : ''}
            <p><b>Preview:</b> ${this.docPreview}</p>
          </section>

          <section>
            <h2>Payload (from Dashboard/API)</h2>
            <pre>${this.payloadSnippetFromDashboard ?? '(no payload snippet found from ic-api)'}</pre>
          </section>

          <section>
            <h2>Rebuild Locally</h2>
            ${p.extractedArtifact ? html`<p><b>Artifact (expected):</b> ${p.extractedArtifact}</p>` : ''}
            <pre>${this.rebuildScript}</pre>
            <p>Compare your local <code>sha256sum</code> with the on-chain / dashboard hash.</p>
          </section>

          <section>
            <h2>Checklist</h2>
            <ul>
              <li>Fetch: ✅</li>
              <li>Commit Check: ${this.commitStatus.startsWith('✅') ? '✅' : '❌'}</li>
              <li>Args / Doc Hash: ${(this.hashMatch || this.docHashMatch) ? '✅' : '❌'}</li>
              <li>Expected Hash from Sources: ${this.expectedHash ? '✅' : '❌'}</li>
              <li>Rebuild & Compare: (Manual)</li>
            </ul>
          </section>
        ` : ''}
      </main>
    `;
    render(body, document.getElementById('root'));
  }
}

export default App;
