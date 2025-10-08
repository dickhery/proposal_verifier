import { html, render } from 'lit-html';
import { proposal_verifier_backend } from 'declarations/proposal_verifier_backend';
import { sha256 } from './utils.js';

class App {
  proposalId = '';
  proposalData = null;
  commitStatus = '';
  hashMatch = false;
  hashError = '';
  rebuildScript = '';

  constructor() {
    this.#render();
  }

  #handleFetchProposal = async (e) => {
    e.preventDefault();
    const id = parseInt(document.getElementById('proposalId').value);
    const result = await proposal_verifier_backend.getProposal(BigInt(id));
    if (result.ok) {
      this.proposalData = result.ok;
      // Extract commit from summary (regex example; adjust based on format)
      const commitMatch = this.proposalData.summary.match(/git commit: (\w+)/);
      const commit = commitMatch ? commitMatch[1] : '';
      // Check commit on GitHub (assume dfinity/ic repo)
      const commitResult = await proposal_verifier_backend.checkGitCommit('dfinity/ic', commit);
      this.commitStatus = commitResult.ok ? `Commit valid: ${commitResult.ok}` : commitResult.err;
      // Get rebuild script
      this.rebuildScript = await proposal_verifier_backend.getRebuildScript('IC-OS', commit);
    } else {
      alert(result.err);
    }
    this.#render();
  };

  #handleVerifyHash = async () => {
    const args = document.getElementById('args').value;
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
            <p>Summary: ${this.proposalData.summary}</p>
            <p>Commit Status: ${this.commitStatus}</p>
          </section>
          <section>
            <h2>Verify Args Hash</h2>
            <input id="args" placeholder="Proposal Args" />
            <input id="expectedHash" placeholder="Expected Hash" />
            <button @click=${this.#handleVerifyHash}>Verify</button>
            <p>Match: ${this.hashMatch ? 'Yes' : 'No'}</p>
            ${this.hashError ? html`<p class="error">${this.hashError}</p>` : ''}
          </section>
          <section>
            <h2>Rebuild Locally</h2>
            <pre>${this.rebuildScript}</pre>
            <p>Run this script locally, build WASM/IC-OS, compare hash with proposal.</p>
          </section>
          <section>
            <h2>Checklist</h2>
            <ul>
              <li>Fetch: ✅</li>
              <li>Commit Check: ${this.commitStatus.includes('valid') ? '✅' : '❌'}</li>
              <li>Hash Verify: ${this.hashMatch ? '✅' : '❌'}</li>
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