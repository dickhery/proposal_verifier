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

  constructor() {
    this.#render();
  }

  #handleFetchProposal = async (e) => {
    e.preventDefault();
    const id = parseInt(document.getElementById('proposalId').value);
    const result = await proposal_verifier_backend.getProposal(BigInt(id));
    if (result.ok) {
      const data = result.ok;
      const unwrap = (opt) => opt[0] ?? null;
      this.proposalData = {
        id: Number(data.id),  // Use BigInt(data.id) if IDs are very large
        summary: data.summary,
        url: data.url,
        title: unwrap(data.title),
        extractedCommit: unwrap(data.extractedCommit),
        extractedHash: unwrap(data.extractedHash),
        extractedDocUrl: unwrap(data.extractedDocUrl),
        extractedRepo: unwrap(data.extractedRepo),
        proposalType: data.proposalType,
      };
      const repo = this.proposalData.extractedRepo ?? 'dfinity/ic';
      const commit = this.proposalData.extractedCommit ?? '';
      const commitResult = await proposal_verifier_backend.checkGitCommit(repo, commit);
      this.commitStatus = commitResult.ok ? `Commit valid: ${commitResult.ok}` : commitResult.err;
      this.rebuildScript = await proposal_verifier_backend.getRebuildScript(this.proposalData.proposalType, commit);
    } else {
      alert(result.err);
    }
    this.#render();
  };

  #handleVerifyHash = async () => {
    const args = document.getElementById('args').value || this.proposalData.extractedHash || '';
    const expectedHash = document.getElementById('expectedHash').value;
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
    const url = document.getElementById('docUrl').value || this.proposalData.extractedDocUrl || '';
    const expectedHash = document.getElementById('expectedDocHash').value || this.proposalData.extractedHash || '';
    this.docHashError = '';
    this.docPreview = '';
    try {
      const result = await proposal_verifier_backend.fetchDocument(url);
      if (result.ok) {
        const bodyArray = new Uint8Array(result.ok.body);
        const computedHash = await sha256(bodyArray);
        this.docHashMatch = computedHash === expectedHash;
        // Preview if text
        const contentType = result.ok.headers.find(h => h.name.toLowerCase() === 'content-type')?.value || '';
        if (contentType.startsWith('text/')) {
          this.docPreview = new TextDecoder().decode(bodyArray).substring(0, 100) + '...';
        } else {
          this.docPreview = 'Binary file, preview not available';
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
    const body = html`
      <main>
        <h1>Proposal Verifier Dashboard</h1>
        <form @submit=${this.#handleFetchProposal}>
          <label>Proposal ID:</label>
          <input id="proposalId" type="number" />
          <button type="submit">Fetch Proposal</button>
        </form>
        ${this.proposalData ? html`
          <section>
            <h2>Proposal Details</h2>
            <p>ID: ${this.proposalData.id}</p>
            <p>Type: ${this.proposalData.proposalType}</p>
            <p>Summary: ${this.proposalData.summary}</p>
            <p>Extracted Repo: ${this.proposalData.extractedRepo ?? 'None'}</p>
            <p>Extracted Commit: ${this.proposalData.extractedCommit ?? 'None'}</p>
            <p>Extracted Hash: ${this.proposalData.extractedHash ?? 'None'}</p>
            <p>Extracted Doc URL: ${this.proposalData.extractedDocUrl ?? 'None'}</p>
            <p>Commit Status: ${this.commitStatus}</p>
          </section>
          <section>
            <h2>Verify Args Hash</h2>
            <input id="args" placeholder="Proposal Args" value=${this.proposalData.extractedHash ?? ''} />
            <input id="expectedHash" placeholder="Expected Hash" />
            <button @click=${this.#handleVerifyHash}>Verify</button>
            <p>Match: ${this.hashMatch ? 'Yes' : 'No'}</p>
            ${this.hashError ? html`<p class="error">${this.hashError}</p>` : ''}
          </section>
          <section>
            <h2>Verify Document</h2>
            <input id="docUrl" placeholder="Document URL" value=${this.proposalData.extractedDocUrl ?? ''} />
            <input id="expectedDocHash" placeholder="Expected Document Hash" value=${this.proposalData.extractedHash ?? ''} />
            <button @click=${this.#handleFetchVerifyDoc}>Fetch & Verify</button>
            <p>Match: ${this.docHashMatch ? 'Yes' : 'No'}</p>
            ${this.docHashError ? html`<p class="error">${this.docHashError}</p>` : ''}
            <p>Preview: ${this.docPreview}</p>
          </section>
          <section>
            <h2>Rebuild Locally</h2>
            <pre>${this.rebuildScript}</pre>
            <p>Run in terminal (Ubuntu recommended), compare output hash to proposal's.</p>
          </section>
          <section>
            <h2>Checklist</h2>
            <ul>
              <li>Fetch: ✅</li>
              <li>Commit Check: ${this.commitStatus.includes('valid') ? '✅' : '❌'}</li>
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