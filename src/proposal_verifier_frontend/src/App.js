import { html, render } from 'lit-html';
import { proposal_verifier_backend } from 'declarations/proposal_verifier_backend';
import { sha256 } from './utils.js';

class App {
  proposalId = '';
  proposalData = null;
  commitStatus = '';
  hashMatch = false;
  hashError = '';
  docHashMatch = false;
  docHashError = '';
  docPreview = '';
  rebuildScript = '';

  constructor() { this.#render(); }

  #handleFetchProposal = async (e) => {
    e.preventDefault();
    const idEl = document.getElementById('proposalId');
    const id = parseInt(idEl.value);
    const result = await proposal_verifier_backend.getProposal(BigInt(id));
    if (result.ok) {
      const data = result.ok;
      const unwrap = (opt) => opt[0] ?? null;
      this.proposalData = {
        id: Number(data.id),
        summary: data.summary,
        url: data.url,
        title: unwrap(data.title),
        extractedCommit: unwrap(data.extractedCommit),
        extractedHash: unwrap(data.extractedHash),
        extractedDocUrl: unwrap(data.extractedDocUrl),
        extractedRepo: unwrap(data.extractedRepo),
        extractedArtifact: unwrap(data.extractedArtifact),
        proposalType: data.proposalType,
      };

      // Validate commit if we have repo+commit
      this.commitStatus = '';
      const repo = this.proposalData.extractedRepo || 'dfinity/ic';
      const commit = this.proposalData.extractedCommit || '';
      if (commit) {
        const commitResult = await proposal_verifier_backend.checkGitCommit(repo, commit);
        this.commitStatus = commitResult.ok
          ? `✅ Commit exists on ${repo}@${commit.substring(0, 12)}`
          : `❌ ${commitResult.err}`;
      } else {
        this.commitStatus = '❌ No commit found in summary';
      }

      // Tailored rebuild script
      this.rebuildScript = await proposal_verifier_backend.getRebuildScript(
        this.proposalData.proposalType,
        this.proposalData.extractedCommit || ''
      );
    } else {
      alert(result.err);
    }
    this.#render();
  };

  #handleVerifyHash = async () => {
    const args = document.getElementById('args').value || '';
    const expectedHash = document.getElementById('expectedHash').value || (this.proposalData?.extractedHash || '');
    this.hashError = '';
    try {
      const computedHash = await sha256(args);
      this.hashMatch = computedHash === expectedHash;
    } catch (err) {
      this.hashError = err.message || String(err);
      this.hashMatch = false;
    }
    this.#render();
  };

  #handleFetchVerifyDoc = async () => {
    const url = document.getElementById('docUrl').value || this.proposalData?.extractedDocUrl || '';
    const expectedHash = document.getElementById('expectedDocHash').value || this.proposalData?.extractedHash || '';
    this.docHashError = '';
    this.docPreview = '';
    try {
      const result = await proposal_verifier_backend.fetchDocument(url);
      if (result.ok) {
        const bodyArray = new Uint8Array(result.ok.body);
        const computedHash = await sha256(bodyArray);
        this.docHashMatch = computedHash === expectedHash;
        const contentType = result.ok.headers.find(h => h.name.toLowerCase() === 'content-type')?.value || '';
        if (contentType.startsWith('text/')) {
          this.docPreview = new TextDecoder().decode(bodyArray).substring(0, 200) + '…';
        } else {
          this.docPreview = `${contentType || 'binary'} (${bodyArray.length} bytes)`;
        }
      } else {
        this.docHashError = result.err;
      }
    } catch (err) {
      this.docHashError = err.message || String(err);
      this.docHashMatch = false;
    }
    this.#render();
  };

  #render() {
    const p = this.proposalData;
    const body = html`
      <main>
        <h1>IC Proposal Verifier</h1>

        <form @submit=${this.#handleFetchProposal}>
          <label>Proposal ID:</label>
          <input id="proposalId" type="number" placeholder="e.g. 138822" />
          <button type="submit">Fetch Proposal</button>
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
            <p><b>Extracted SHA256:</b> ${p.extractedHash ?? 'None'}</p>
            <p><b>Extracted Doc URL:</b> ${p.extractedDocUrl ?? 'None'}</p>
            <p><b>Artifact Path Hint:</b> ${p.extractedArtifact ?? 'None'}</p>
            <p><b>Commit Status:</b> ${this.commitStatus}</p>
          </section>

          <section>
            <h2>Verify Args Hash</h2>
            <input id="args" placeholder="Paste proposal args (or doc text) to hash" />
            <input id="expectedHash" placeholder="Expected SHA-256 (hex, 64 chars)" value=${p.extractedHash ?? ''} />
            <button @click=${this.#handleVerifyHash}>Verify</button>
            <p><b>Match:</b> ${this.hashMatch ? '✅ Yes' : '❌ No'}</p>
            ${this.hashError ? html`<p class="error">${this.hashError}</p>` : ''}
          </section>

          <section>
            <h2>Verify Linked Document</h2>
            <input id="docUrl" placeholder="Document URL" value=${p.extractedDocUrl ?? ''} />
            <input id="expectedDocHash" placeholder="Expected SHA-256" value=${p.extractedHash ?? ''} />
            <button @click=${this.#handleFetchVerifyDoc}>Fetch & Verify</button>
            <p><b>Match:</b> ${this.docHashMatch ? '✅ Yes' : '❌ No'}</p>
            ${this.docHashError ? html`<p class="error">${this.docHashError}</p>` : ''}
            <p><b>Preview:</b> ${this.docPreview}</p>
          </section>

          <section>
            <h2>Rebuild Locally</h2>
            ${p.extractedArtifact ? html`<p><b>Artifact (expected):</b> ${p.extractedArtifact}</p>` : ''}
            <pre>${this.rebuildScript}</pre>
            <p>Compare your local <code>sha256sum</code> with the on-chain hash in the proposal.</p>
          </section>

          <section>
            <h2>Checklist</h2>
            <ul>
              <li>Fetch: ✅</li>
              <li>Commit Check: ${this.commitStatus.startsWith('✅') ? '✅' : '❌'}</li>
              <li>Args Hash: ${this.hashMatch ? '✅' : '❌'}</li>
              <li>Document Hash: ${this.docHashMatch ? '✅' : '❌'}</li>
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
