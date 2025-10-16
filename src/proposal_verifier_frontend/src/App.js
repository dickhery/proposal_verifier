// src/proposal_verifier_frontend/src/App.js
import { html, render } from 'lit-html';
import {
  proposal_verifier_backend as anon_backend,
  canisterId as backendCanisterId,
  createActor as createBackendActor,
} from 'declarations/proposal_verifier_backend';
import {
  sha256,
  hexToBytes,
  normalizeHex,
  bytesToHex,
  equalBytes,
  tryDecodeDoubleHex,
  looksLikeHexString,
  // NEW: compute a wallet-friendly Account Identifier (legacy address)
  principalToAccountIdentifier,
} from './utils.js';
import { FAQView } from './FAQ.js';
import { IDL } from '@dfinity/candid';
import { AuthClient } from '@dfinity/auth-client';
import { HttpAgent } from '@dfinity/agent';

// -----------------------------
// Constants / helpers
// -----------------------------

// CORS-friendly hosts for browser fetches
const CORS_ALLOWED_HOSTS = new Set([
  'ic-api.internetcomputer.org',
  'api.github.com',
  'raw.githubusercontent.com',
  'dashboard.internetcomputer.org',
]);

// Regex helper to spot release package links in payloads
const RELEASE_URL_RE =
  /https:\/\/download\.dfinity\.(?:systems|network)\/ic\/[0-9a-f]{40}\/[^"'\s]+/gi;

// Candid-ish text detection (coarse but useful for hints)
const CANDID_PATTERN =
  /(^|\W)(record\s*\{|variant\s*\{|opt\s|vec\s|principal\s|service\s|func\s|blob\s|text\s|nat(8|16|32|64)?\b|int(8|16|32|64)?\b|\(\s*\))/i;

// Add type-specific checklists (keys map to this.checklist fields)
const TYPE_CHECKLISTS = new Map([
  [
    'ProtocolCanisterManagement',
    [
      { label: 'Fetch Proposal', key: 'fetch' },
      { label: 'Commit Check', key: 'commit' },
      { label: 'Expected WASM Hash Present', key: 'expected' },
      { label: 'Arg Hash Verified', key: 'argsHash' },
      { label: 'WASM Rebuilt & Hash Matched', key: 'rebuild' },
    ],
  ],
  [
    'IcOsVersionDeployment',
    [
      { label: 'Fetch Proposal', key: 'fetch' },
      { label: 'Expected Release Hash Present', key: 'expected' },
      { label: 'Commit Check (if provided)', key: 'commit' },
      { label: 'Release Package Hash Verified', key: 'docHash' },
    ],
  ],
  [
    'ParticipantManagement',
    [
      { label: 'Fetch Proposal', key: 'fetch' },
      { label: 'All PDFs Hash-Matched', key: 'docHash' },
      { label: 'Forum/Wiki Context Checked', key: 'manual' },
    ],
  ],
  [
    'Governance',
    [
      { label: 'Fetch Proposal', key: 'fetch' },
      { label: 'Manual Policy Review', key: 'manual' },
    ],
  ],
]);

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
    // Trim obvious trailing punctuation/brackets
    while (/[)\]\}\.,;:'"`]$/.test(s)) s = s.slice(0, -1);
    // Balance parentheses if mismatched
    const left = (s.match(/\(/g) || []).length;
    const right = (s.match(/\)/g) || []).length;
    while (right > left && s.endsWith(')')) s = s.slice(0, -1);
    return s;
  });
  return [...new Set(sanitized)];
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
function parseBlobLiteral(text) {
  const m = text.trim().match(/^blob\s*"([\s\S]*)"$/i);
  if (!m) throw new Error('Not a blob literal; expected like: blob "\\ab\\cd..."');
  const s = m[1];
  const out = [];
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\') {
      const h1 = s[i + 1],
        h2 = s[i + 2];
      if (/[0-9a-fA-F]/.test(h1 || '') && /[0-9a-fA-F]/.test(h2 || '')) {
        out.push(parseInt(h1 + h2, 16));
        i += 2;
      } else {
        const next = s[i + 1];
        if (next) {
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

// Extract a recommended Argument Verification command from the summary (if present)
function extractArgVerificationCommand(summary) {
  const titleIdx = summary.toLowerCase().indexOf('argument verification');
  if (titleIdx < 0) return null;
  const after = summary.slice(titleIdx);
  const fence = after.match(/```[\s\S]*?```/);
  if (fence) {
    const code = fence[0].replace(/```/g, '').trim();
    if (/didc\s+encode/i.test(code) && /(sha256sum|shasum)/i.test(code)) return code;
  }
  const line = after.split('\n').find((l) => /didc\s+encode/i.test(l));
  return line ? line.trim() : null;
}

// Simple Candid encoders for common cases
function encodeNullHex() {
  const bytes = IDL.encode([IDL.Null], [null]);
  return bytesToHex(bytes);
}
function encodeUnitHex() {
  const bytes = IDL.encode([], []); // ()
  return bytesToHex(bytes);
}

class App {
  view = 'home'; // 'home' | 'faq'

  // --- backend/auth/billing state ---
  backend = anon_backend; // actor (anonymous by default, replaced after login)
  authClient = null;
  identity = null;
  userPrincipal = null;
  userBalance = 0; // in e8s

  // DEFAULT FEES bumped to 0.1 ICP per billed action (10_000_000 e8s)
  fees = { fetchProposal_e8s: 10_000_000n, httpOutcall_e8s: 10_000_000n }; // defaults, loaded from backend

  // Deposit/account state
  depositOwner = null; // canister principal (string)
  depositSubaccountHex = null; // subaccount (hex)
  depositAccountIdentifierHex = null; // legacy 32-byte address (64 hex)
  // NEW: live balances and auto-credit tracking
  depositLedgerBalance = 0; // Nat (as JS number for display)
  depositCreditedTotal = 0; // Nat64-ish (display)
  depositAvailableToCredit = 0; // Nat delta (display)

  // --- app state ---
  proposalData = null;
  commitStatus = '';
  hashMatch = false;
  hashError = '';
  docResults = [];
  rebuildScript = '';
  isFetching = false;
  isVerifyingArgs = false;
  cycleBalance = null;

  expectedHash = null; // expected wasm/release hash (from sources)
  expectedHashSource = null;

  argHash = null; // arg_hash (from dashboard/ic-api or backend)

  payloadSnippetFromDashboard = null;
  dashboardUrl = '';

  releasePackageUrls = [];

  // Arg UX state
  argInputType = 'text'; // 'text' | 'hex' | 'candid' | 'vec' | 'blob'
  argInputCurrent = '';
  argInputHint = '';
  extractedArgText = null;
  recommendedArgCmd = null; // from summary

  // Type-aware fields
  verificationSteps = null;
  requiredTools = null;
  typeChecklists = new Map();

  // New: interactive type-specific items (checkbox UI)
  typeChecklistItems = [];

  checklist = {
    fetch: false,
    commit: false,
    argsHash: false,
    docHash: false,
    expected: false,
    rebuild: false,
    manual: false, // for types that require manual review
  };

  // URL/text fetch verification
  docHashMatch = undefined;
  docHashError = '';
  docPreview = '';

  constructor() {
    this.#initAuth();
    this.#render();
  }

  // ----------------- auth & billing -----------------

  async #initAuth() {
    try {
      this.authClient = await AuthClient.create();
      // Always have an actor (anon) so the app renders even pre-login
      this.backend = anon_backend;
      await this.#loadFees(); // fees are public query; attempt even anon
      if (await this.authClient.isAuthenticated()) {
        await this.#onAuthenticated();
      }
    } catch (e) {
      // Gentler handling: don't block UI on bootstrap hiccups
      console.warn('Auth init warning:', e?.message || e);
    } finally {
      this.#render();
    }
  }

  async #login() {
    try {
      await this.authClient.login({
        identityProvider: 'https://id.ai/#authorize',
        onSuccess: async () => {
          try {
            await this.#onAuthenticated();
          } catch (e) {
            alert('Login completed but session setup failed: ' + (e?.message || String(e)));
          }
          this.#render();
        },
        onError: (err) => {
          alert('Login error: ' + (err?.message || String(err)));
        },
      });
    } catch (e) {
      alert('Login failed: ' + (e?.message || String(e)));
    }
  }

  async #logout() {
    try {
      await this.authClient.logout();
    } catch (e) {
      // Not fatal for UI but let the user know
      alert('Logout had an issue (continuing): ' + (e?.message || String(e)));
    }
    this.identity = null;
    this.userPrincipal = null;
    this.backend = anon_backend;
    this.userBalance = 0;

    // Clear deposit state
    this.depositOwner = null;
    this.depositSubaccountHex = null;
    this.depositAccountIdentifierHex = null;
    this.depositLedgerBalance = 0;
    this.depositCreditedTotal = 0;
    this.depositAvailableToCredit = 0;

    this.#render();
  }

  async #onAuthenticated() {
    const identity = await this.authClient.getIdentity();
    this.identity = identity;
    try {
      this.userPrincipal = identity.getPrincipal().toText();
    } catch {
      this.userPrincipal = '(unknown)';
    }

    // Create an authenticated actor
    const agent = new HttpAgent({ identity });
    this.backend = createBackendActor(backendCanisterId, { agent });

    await this.#refreshBalance();
    await this.#loadFees();
    // NEW: get owner/subaccount + live ledger/credited status
    await this.#loadDepositStatus();
  }

  async #refreshBalance() {
    try {
      this.userBalance = Number(await this.backend.getBalance());
    } catch {
      this.userBalance = 0;
    }
  }

  async #loadFees() {
    try {
      const f = await this.backend.getFees();
      this.fees = f;
    } catch {
      // keep defaults
    }
  }

  // ----------------- deposit status (new) -----------------

  async #loadDepositStatus() {
    try {
      const s = await this.backend.getDepositStatus();
      // owner + subaccount for address calculation
      this.depositOwner = String(s.owner);
      this.depositSubaccountHex = bytesToHex(new Uint8Array(s.subaccount));
      try {
        this.depositAccountIdentifierHex = principalToAccountIdentifier(
          this.depositOwner,
          this.depositSubaccountHex,
        );
      } catch {
        this.depositAccountIdentifierHex = null;
      }
      // balances
      this.depositLedgerBalance = Number(s.ledger_balance_e8s || 0);
      this.depositCreditedTotal = Number(s.credited_total_e8s || 0);
      this.depositAvailableToCredit = Number(s.available_to_credit_e8s || 0);
    } catch (e) {
      // Fallback to previous method if needed (owner+sub)
      await this.#loadDepositAccount(); // will populate owner/sub/address
      this.depositLedgerBalance = 0;
      this.depositCreditedTotal = 0;
      this.depositAvailableToCredit = 0;
    }
    this.#render();
  }

  // Legacy: load only owner/subaccount if status helper not available
  async #loadDepositAccount() {
    try {
      const acc = await this.backend.getDepositAccount();
      this.depositOwner = String(acc.owner);
      this.depositSubaccountHex = bytesToHex(new Uint8Array(acc.subaccount));
      try {
        this.depositAccountIdentifierHex = principalToAccountIdentifier(
          this.depositOwner,
          this.depositSubaccountHex,
        );
      } catch {
        this.depositAccountIdentifierHex = null;
      }
    } catch {
      this.depositOwner = null;
      this.depositSubaccountHex = null;
      this.depositAccountIdentifierHex = null;
    }
  }

  // Auto-credit whatever arrived on-chain (no amount field)
  async #recordAllDeposits() {
    if (!this.identity) return alert('Login required to record deposits.');
    try {
      const res = await this.backend.recordDepositAuto();
      if (res.ok !== undefined) {
        const r = res.ok;
        this.userBalance = Number(r.total_internal_balance_e8s || 0);
        this.depositLedgerBalance = Number(r.ledger_balance_e8s || 0);
        this.depositCreditedTotal = Number(r.credited_total_e8s || 0);
        this.depositAvailableToCredit = Math.max(
          0,
          this.depositLedgerBalance - this.depositCreditedTotal,
        );
        alert(
          `Credited ${(Number(r.credited_delta_e8s) / 1e8).toFixed(8)} ICP from your ledger subaccount.`,
        );
      } else {
        alert('Deposit error: ' + (res.err || 'unknown'));
      }
    } catch (e) {
      alert('Deposit failed: ' + (e?.message || String(e)));
    }
    this.#render();
  }

  // ----------------- helpers -----------------

  #setFetching(on) {
    this.isFetching = on;
    this.#render();
  }
  #normalizeHex(s) {
    return normalizeHex(s);
  }

  #updateChecklist() {
    this.checklist = {
      fetch: !!this.proposalData,
      commit: this.commitStatus.startsWith('✅'),
      argsHash: this.hashMatch,
      docHash: this.docResults.every((r) => r.match),
      expected: !!this.expectedHash,
      rebuild: this.checklist.rebuild || false,
      manual: this.checklist.manual || false,
    };
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
          setTimeout(() => {
            button.innerText = originalLabel;
          }, 2000);
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
        setTimeout(() => {
          button.innerText = originalLabel;
        }, 2000);
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
      // ignore ic-api failures
    }
  }

  async #handleFetchProposal(e) {
    e.preventDefault();
    if (this.isFetching) return;
    if (!this.identity) {
      alert('Login required to fetch (billed action).');
      return;
    }
    this.#setFetching(true);

    try {
      const idEl = document.getElementById('proposalId');
      const id = parseInt(idEl.value);

      const aug = await this.backend.getProposalAugmented(BigInt(id));
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

      // Pull a recommended arg verification command from the summary (if present)
      this.recommendedArgCmd = extractArgVerificationCommand(this.proposalData.summary);

      this.expectedHash =
        unwrap(data.expectedHashFromDashboard) || this.proposalData.extractedHash || null;
      this.expectedHashSource =
        unwrap(data.expectedHashSource) ||
        (this.proposalData.extractedHash ? 'proposal:summary' : null);

      this.argHash = unwrap(data.argHashFromDashboard) || this.argHash || null;

      this.payloadSnippetFromDashboard = unwrap(data.payloadSnippetFromDashboard);
      this.dashboardUrl = data.dashboardUrl;

      this.extractedArgText = unwrap(data.extractedArgText) || null;

      this.verificationSteps = unwrap(data.verificationSteps) || null;
      this.requiredTools = unwrap(data.requiredTools) || null;

      this.argInputHint = '';
      this.argInputType = 'text';
      if (this.extractedArgText && CANDID_PATTERN.test(this.extractedArgText)) {
        this.argInputCurrent = this.extractedArgText;
        this.argInputType = 'candid';
        this.argInputHint =
          'Detected Candid-like text. Encode with didc (or use the quick buttons), then paste the hex under "Hex Bytes".';
      } else if (
        this.payloadSnippetFromDashboard &&
        CANDID_PATTERN.test(this.payloadSnippetFromDashboard)
      ) {
        this.argInputCurrent = this.payloadSnippetFromDashboard.trim();
        this.argInputType = 'candid';
        this.argInputHint =
          'Detected possible Candid in payload snippet. Encode with didc before hashing.';
      } else {
        this.argInputCurrent = '';
      }

      await this.#prefillFromIcApi(id);

      // Commit check (billed): backend first, then browser fallback
      this.commitStatus = '';
      const repo = this.proposalData.extractedRepo || 'dfinity/ic';
      const commit = this.proposalData.extractedCommit || '';
      if (commit) {
        const commitResult = await this.backend.checkGitCommit(repo, commit);
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
      this.rebuildScript = await this.backend.getRebuildScript(
        this.proposalData.proposalType,
        this.proposalData.extractedCommit || '',
      );

      // Init per-doc results (verifiable entries only)
      this.docResults = this.proposalData.extractedDocs
        .filter((d) => d.hash != null)
        .map((d) => ({
          name: d.name,
          match: false,
          error: '',
          preview: '',
        }));

      // NEW: set interactive type checklist items
      this.typeChecklistItems =
        TYPE_CHECKLISTS.get(this.proposalData?.proposalType) || [];

      // Reflect billed deduction and refresh deposit status
      await this.#refreshBalance();
      await this.#loadDepositStatus();

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
          Accept: 'application/vnd.github.v3+json',
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

  async #handleFetchVerifyDoc() {
    if (!this.identity) {
      alert(
        'Login required to use canister fetch (billed). You can still use browser-only fallback for CORS-safe text URLs.',
      );
      // continue; we'll try backend first then fallback
    }
    const url =
      document.getElementById('docUrl').value || this.proposalData?.extractedDocUrl || '';
    const expected =
      document.getElementById('expectedDocHash').value || this.expectedHash || '';
    this.docHashError = '';
    this.docPreview = '';
    try {
      const result = await this.backend.fetchDocument(url);
      if (result.ok) {
        const bodyArray = new Uint8Array(result.ok.body);
        const computedHash = await sha256(bodyArray);
        this.docHashMatch =
          !!expected && this.#normalizeHex(computedHash) === this.#normalizeHex(expected);
        const contentType =
          result.ok.headers.find((h) => h.name.toLowerCase() === 'content-type')?.value || '';
        if (contentType.startsWith('text/')) {
          this.docPreview = new TextDecoder().decode(bodyArray).substring(0, 200) + '…';
        } else {
          this.docPreview = `${contentType || 'binary'} (${bodyArray.length} bytes)`;
        }
        // reflect billed outcall + update deposit status
        await this.#refreshBalance();
        await this.#loadDepositStatus();
      } else {
        // Fallback to browser fetch (no billing, but CORS-limited)
        const u = new URL(url);
        if (!CORS_ALLOWED_HOSTS.has(u.host))
          throw new Error(
            result.err || 'CORS blocked for browser fetch. Use canister fetch while logged in.',
          );
        const fallback = await fetch(url, { credentials: 'omit', mode: 'cors' });
        if (!fallback.ok) throw new Error(result.err || `HTTP ${fallback.status}`);
        const bytes = new Uint8Array(await fallback.arrayBuffer());
        const computedHash = await sha256(bytes);
        this.docHashMatch =
          !!expected && this.#normalizeHex(computedHash) === this.#normalizeHex(expected);
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
    this.docResults[docIndex] = {
      ...this.docResults[docIndex],
      error: '',
      preview: '',
      match: false,
    };
    this.#render();

    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const computedHash = await sha256(bytes);
      const match =
        !!expected && this.#normalizeHex(computedHash) === this.#normalizeHex(expected);
      const ct = file.type || 'binary';
      const preview = ct.startsWith('text/')
        ? new TextDecoder().decode(bytes).substring(0, 200) + '…'
        : `${ct} (${bytes.length} bytes) - Local file: ${file.name}`;
      this.docResults[docIndex] = { ...this.docResults[docIndex], match, preview };
    } catch (err) {
      this.docResults[docIndex] = {
        ...this.docResults[docIndex],
        error: err.message || String(err),
        match: false,
      };
    }
    this.#updateChecklist();
    this.#render();
  }

  async #handleCheckCycles() {
    try {
      this.cycleBalance = await this.backend.getCycleBalance();
    } catch (err) {
      this.cycleBalance = 'Error: ' + (err.message || String(err));
    }
    this.#render();
  }

  // --- rendering helpers ---

  #renderLinks() {
    const p = this.proposalData;
    if (!p) return null;

    const set = new Set();
    const push = (u) => {
      if (u && !set.has(u)) set.add(u);
    };

    push(p.url);
    push(this.dashboardUrl);
    push(p.extractedDocUrl);
    push(p.commitUrl);
    (p.extractedUrls || []).forEach(push);

    const links = [...set.values()];
    if (!links.length) return html`<p>(no links found)</p>`;

    return html`
      <ul class="links">
        ${links.map(
          (u) => html`<li><a href="${u}" target="_blank" rel="noreferrer">${u}</a></li>`,
        )}
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
        cmd: `curl -fsSL "${u}" -o ${fname}
sha256sum ${fname}  # Linux (expect ${expected})
shasum -a 256 ${fname}  # macOS (expect ${expected})`,
      };
    });
    return html`
      <section>
        <h2>Release Package URLs & Quick Verify</h2>
        <ul class="links">
          ${this.releasePackageUrls.map(
            (u) => html`<li><a href="${u}" target="_blank" rel="noreferrer">${u}</a></li>`,
          )}
        </ul>
        <p><b>Shell commands (download & hash locally):</b></p>
        <pre>${cmds.map((x) => `# ${x.url}\n${x.cmd}`).join('\n\n')}</pre>
        <button
          @click=${(e) =>
            this.#handleCopy(e, cmds.map((x) => x.cmd).join('\n\n'), 'Copy Commands')}
        >
          Copy Commands
        </button>
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
            <p>
              These proposals verify documents (PDFs). Download the exact file provided by the proposer from the wiki,
              upload below for each doc. Hashes must match the summary.
            </p>
          </details>
        `;
      case 'IcOsVersionDeployment':
        return html`
          <details class="type-guidance">
            <summary><b>Guidance for IC-OS Elections</b></summary>
            <p>
              Download release package (.tar.zst) using curl commands above. Hash locally with
              <code>sha256sum</code> (Linux) or <code>shasum - a 256</code> (macOS). Compare to
              <code>release_package_sha256_hex</code>.
            </p>
          </details>
        `;
      default:
        return null;
    }
  }

  // --- Arg UX ---

  #handleArgTypeChange(val) {
    this.argInputType = val;
    if (val === 'candid') {
      this.hashError =
        'Candid text must be encoded to bytes (e.g., with `didc encode`) before hashing. Use the quick buttons below or the command builder.';
    } else {
      this.hashError = '';
    }
    this.#render();
  }

  #handleArgInputChange(e) {
    const v = (e?.target?.value ?? '').trim();
    this.argInputCurrent = v;

    // Helpful hints and mistake detection
    if (/^blob\s*"/i.test(v)) {
      this.argInputHint =
        'This looks like a Candid blob literal (likely the on-chain hash). You must hash the *argument bytes*, not the hash itself.';
    } else if (this.argInputType !== 'candid' && CANDID_PATTERN.test(v)) {
      this.argInputHint =
        'Looks like Candid. Choose "Candid Text" and encode with didc first (or use the quick buttons).';
    } else if (/^vec\s*\{[\s\S]*\}$/i.test(v)) {
      this.argInputHint = 'Looks like a Candid vec nat8. Choose “vec nat8 list”.';
    } else if (looksLikeHexString(v)) {
      this.argInputHint =
        'Looks like hex. If this is the *hash* from the proposal, do not paste it here. Paste the *argument bytes* (hex from `didc encode`) instead.';
    } else {
      this.argInputHint = '';
    }
  }

  #buildDidcCommand() {
    // This builder is for producing HEX BYTES to paste, not hashing directly.
    // `didc encode` already outputs hex text, so no `xxd -p` here.
    const input = (this.argInputCurrent || '').trim();
    if (!input) return `didc encode '()' | tr -d '\\n'`;
    // If the user typed full tuple already "(...)", avoid double parens:
    const candidExpr = /^\s*\(.*\)\s*$/.test(input) ? input : `(${input})`;
    return `didc encode '${candidExpr}' | tr -d '\\n'`;
    // Note: for verification, turn hex back into bytes with `xxd -r -p` before hashing.
  }

  #renderArgShortcuts() {
    const p = this.proposalData;
    if (!p) return null;

    const hasRecommended = !!this.recommendedArgCmd;

    const fillNull = () => {
      try {
        const hex = encodeNullHex();
        this.argInputType = 'hex';
        this.argInputCurrent = hex;
        this.argInputHint =
          'Auto-encoded `(null)` with @dfinity/candid. These are the *argument bytes* in hex.';
        this.#render();
      } catch (e) {
        alert('Encoding failed: ' + (e?.message || String(e)));
      }
    };

    const fillUnit = () => {
      try {
        const hex = encodeUnitHex();
        this.argInputType = 'hex';
        this.argInputCurrent = hex;
        this.argInputHint =
          'Auto-encoded `()` with @dfinity/candid. These are the *argument bytes* in hex.';
        this.#render();
      } catch (e) {
        alert('Encoding failed: ' + (e?.message || String(e)));
      }
    };

    // Hash-verify command (platform aware)
    const candidExpr = (() => {
      const v = (this.argInputCurrent || '').trim();
      if (!v) return '(null)'; // default helpful example
      return /^\s*\(.*\)\s*$/.test(v) ? v : `(${v})`;
    })();
    const macVerify = `didc encode '${candidExpr}' | xxd -r -p | shasum -a 256 | awk '{print $1}'`;
    const linuxVerify = `didc encode '${candidExpr}' | xxd -r -p | sha256sum | awk '{print $1}'`;

    return html`
      <details>
        <summary><b>Quick helpers</b></summary>
        <div style="display:flex; gap:8px; flex-wrap:wrap; margin:8px 0;">
          <button class="btn secondary" @click=${fillNull}>
            Arg is <code>(null)</code> (auto-encode)
          </button>
          <button class="btn secondary" @click=${fillUnit}>
            Arg is <code>()</code> (auto-encode)
          </button>
        </div>

        ${hasRecommended
          ? html`
              <p><b>From summary (recommended hash-verify):</b></p>
              <pre class="cmd-pre">${this.recommendedArgCmd}</pre>
              <button
                class="btn secondary"
                @click=${(e) => this.#handleCopy(e, this.recommendedArgCmd, 'Copy Command')}
              >
                Copy Command
              </button>
            `
          : ''}

        <p><b>Hash-verify yourself:</b></p>
        <pre class="cmd-pre"># macOS
${macVerify}

# Linux
${linuxVerify}</pre>
        <div style="display:flex; gap:8px; flex-wrap:wrap;">
          <button
            class="btn secondary"
            @click=${(e) => this.#handleCopy(e, macVerify + '\n\n' + linuxVerify, 'Copy Commands')}
          >
            Copy Both
          </button>
        </div>
      </details>
    `;
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
        this.hashError = 'No expected arg hash found. Paste expected hash or refetch.';
        this.hashMatch = false;
        this.isVerifyingArgs = false;
        this.#updateChecklist();
        this.#render();
        return;
      }

      let bytes = null;

      switch (this.argInputType) {
        case 'hex': {
          if (!argsRaw)
            throw new Error(
              'Paste hex bytes (from `didc encode` or the auto-encode buttons).',
            );
          // Try to auto-fix if double-hex
          const maybe = tryDecodeDoubleHex(argsRaw);
          bytes = maybe || hexToBytes(argsRaw);
          if (maybe) this.argInputHint = 'Detected hex-of-hex. Auto-corrected to raw bytes.';
          break;
        }
        case 'vec': {
          if (!/^vec\s*\{[\s\S]*\}$/i.test(argsRaw))
            throw new Error('Expected a Candid vec nat8 literal like: vec {1; 2; 0xFF}');
          bytes = parseVecNat8Literal(argsRaw);
          break;
        }
        case 'blob': {
          if (!/^blob\s*"/i.test(argsRaw))
            throw new Error('Expected a Candid blob literal like: blob "\\22\\c4\\81..."');
          bytes = parseBlobLiteral(argsRaw);
          break;
        }
        case 'text': {
          if (!argsRaw) throw new Error('Paste text to hash, or choose a more specific mode.');
          bytes = new TextEncoder().encode(argsRaw);
          break;
        }
        case 'candid': {
          this.hashError =
            'Candid text must be encoded first (see builder/auto-encode), then paste the hex under "Hex Bytes".';
          this.hashMatch = false;
          this.isVerifyingArgs = false;
          this.#updateChecklist();
          this.#render();
          return;
        }
        default: {
          if (looksLikeHexString(argsRaw)) {
            const maybe = tryDecodeDoubleHex(argsRaw);
            bytes = maybe || hexToBytes(argsRaw);
            if (maybe) this.argInputHint = 'Detected hex-of-hex. Auto-corrected to raw bytes.';
          } else if (/^vec\s*\{[\s\S]*\}$/i.test(argsRaw)) {
            bytes = parseVecNat8Literal(argsRaw);
          } else if (/^blob\s*"/i.test(argsRaw)) {
            bytes = parseBlobLiteral(argsRaw);
          } else if (argsRaw) {
            bytes = new TextEncoder().encode(argsRaw);
          } else {
            throw new Error(
              'Provide arg bytes (hex), vec nat8, blob literal, or candid (encode first).',
            );
          }
          break;
        }
      }

      // Helpful warning: if user pasted the hash bytes themselves, warn.
      const expectedBytes = hexToBytes(inputExpected);
      if (bytes.length === 32 && equalBytes(bytes, expectedBytes)) {
        this.hashError =
          'You pasted the on-chain hash itself (32 bytes). Paste the *argument bytes* (e.g., hex from `didc encode`), not the hash.';
        this.hashMatch = false;
        this.isVerifyingArgs = false;
        this.#updateChecklist();
        this.#render();
        return;
      }

      const computedHash = await sha256(bytes);
      this.hashMatch =
        this.#normalizeHex(computedHash) === this.#normalizeHex(inputExpected);
      if (!this.hashMatch) {
        this.hashError =
          'No match. Most common causes:\n• You hashed text instead of bytes.\n• You pasted hex-of-hex. Use the auto-fix or re-run without `| xxd -p`.\n• You pasted the hash itself instead of the arg bytes.';
      }
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
        ${this.#renderArgShortcuts()}

        <details>
          <summary>How to choose an input</summary>
          <ol>
            <li>
              <b>Hex Bytes:</b> Paste the bytes as hex (<i>direct output</i> of
              <code>didc encode</code> or use the auto-encode buttons). We hash <b>bytes</b>.
            </li>
            <li>
              <b>vec nat8 list:</b> Paste a Candid list like <code>vec {1; 2; 0xFF}</code>. We
              parse to bytes and hash.
            </li>
            <li>
              <b>blob "…":</b> Paste a Candid <code>blob</code> literal with <code>\\xx</code>
              escapes.
            </li>
            <li>
              <b>Candid Text:</b> Paste human-readable Candid (e.g. <code>(null)</code> or
              <code>()</code>) <i>to build hex</i>. Run the command below or click the quick
              buttons, then paste the resulting <b>hex</b> under <b>Hex Bytes</b>.
            </li>
          </ol>

          <p><b>didc hex builder (copy/paste into the "Hex Bytes" box):</b></p>
          <pre class="cmd-pre">${didcCmd}</pre>
          <div style="display:flex; gap:8px; flex-wrap:wrap;">
            <button
              class="btn secondary"
              @click=${(e) => this.#handleCopy(e, didcCmd, 'Copy didc Command')}
            >
              Copy didc Command
            </button>
            <a
              class="btn secondary"
              href="https://github.com/dfinity/candid/tree/master/tools/didc"
              target="_blank"
              rel="noreferrer"
              >Install didc</a
            >
          </div>

          <p style="margin-top:6px;">
            <b>Important:</b> <code>didc encode</code> outputs <i>hex text</i>. To verify the
            on-chain <code>arg_hash</code>, hash the <b>bytes</b> by converting that hex back to
            bytes (<code>xxd -r -p</code>) before hashing.
          </p>
        </details>

        <div class="radio-group">
          <label
            ><input
              type="radio"
              name="argType"
              value="hex"
              ?checked=${this.argInputType === 'hex'}
              @change=${(e) => this.#handleArgTypeChange(e.target.value)}
            />
            Hex Bytes</label
          >
          <label
            ><input
              type="radio"
              name="argType"
              value="vec"
              ?checked=${this.argInputType === 'vec'}
              @change=${(e) => this.#handleArgTypeChange(e.target.value)}
            />
            vec nat8 list</label
          >
          <label
            ><input
              type="radio"
              name="argType"
              value="blob"
              ?checked=${this.argInputType === 'blob'}
              @change=${(e) => this.#handleArgTypeChange(e.target.value)}
            />
            blob literal</label
          >
          <label
            ><input
              type="radio"
              name="argType"
              value="candid"
              ?checked=${this.argInputType === 'candid'}
              @change=${(e) => this.#handleArgTypeChange(e.target.value)}
            />
            Candid Text (encode first)</label
          >
          <label
            ><input
              type="radio"
              name="argType"
              value="text"
              ?checked=${this.argInputType === 'text'}
              @change=${(e) => this.#handleArgTypeChange(e.target.value)}
            />
            Plain Text/JSON</label
          >
        </div>

        <textarea
          id="argInput"
          placeholder="Paste arg as hex / vec nat8 / blob literal / Candid (for didc)"
          @input=${(e) => this.#handleArgInputChange(e)}
        >${this.argInputCurrent}</textarea>

        ${this.argInputHint
          ? html`<p style="margin:6px 0 0;"><em>${this.argInputHint}</em></p>`
          : ''}

        <input
          id="expectedArgHash"
          placeholder="Expected Arg SHA-256"
          value=${this.argHash || p.proposal_arg_hash || ''}
        />

        <div style="display:flex; gap:8px; flex-wrap:wrap;">
          <button
            class="btn"
            @click=${() => this.#handleVerifyArgHash()}
            class=${this.isVerifyingArgs ? 'loading' : ''}
            ?disabled=${this.isVerifyingArgs}
          >
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

  // --- Type-specific checklist rendering (computed view) ---

  #renderTypeChecklist() {
    const items =
      this.typeChecklists.get(this.proposalData?.proposalType) || [
        { label: 'Fetch', checked: this.checklist.fetch },
        { label: 'Commit Check', checked: this.checklist.commit },
        { label: 'Arg Hash', checked: this.checklist.argsHash },
        { label: 'Doc / File Hash', checked: this.checklist.docHash },
        { label: 'Expected Hash from Sources', checked: this.checklist.expected },
        { label: 'Rebuild & Compare', checked: this.checklist.rebuild },
      ];
    return html`
      <ul>
        ${items.map((item) => html`<li>${item.label}: ${item.checked ? '✅' : '❌'}</li>`)}
      </ul>
      <div style="margin-top:8px;">
        <button
          class="btn secondary"
          @click=${() => {
            this.checklist.rebuild = true;
            this.#updateChecklist();
            this.#render();
          }}
        >
          Mark Rebuild Done
        </button>
      </div>
    `;
  }

  #updateTypeChecklist() {
    const type = this.proposalData?.proposalType || 'Unknown';
    let items;
    switch (type) {
      case 'ProtocolCanisterManagement':
        items = [
          { label: 'Fetch Proposal', checked: this.checklist.fetch },
          { label: 'Commit Check', checked: this.checklist.commit },
          { label: 'Expected WASM Hash Present', checked: this.checklist.expected },
          { label: 'Arg Hash Verified', checked: this.checklist.argsHash },
          { label: 'WASM Rebuilt & Hash Matched', checked: this.checklist.rebuild },
        ];
        break;
      case 'IcOsVersionDeployment':
        items = [
          { label: 'Fetch Proposal', checked: this.checklist.fetch },
          { label: 'Expected Release Hash Present', checked: this.checklist.expected },
          { label: 'Commit Check (if provided)', checked: this.checklist.commit },
          { label: 'Release Package Hash Verified', checked: this.checklist.docHash },
        ];
        break;
      case 'ParticipantManagement':
        items = [
          { label: 'Fetch Proposal', checked: this.checklist.fetch },
          { label: 'All PDFs Hash-Matched', checked: this.checklist.docHash },
          { label: 'Forum/Wiki Context Checked', checked: this.checklist.manual },
        ];
        break;
      case 'Governance':
        items = [
          { label: 'Fetch Proposal', checked: this.checklist.fetch },
          { label: 'Manual Policy Review', checked: this.checklist.manual },
        ];
        break;
      default:
        items = [
          { label: 'Fetch Proposal', checked: this.checklist.fetch },
          { label: 'Manual Review', checked: this.checklist.manual },
        ];
    }
    this.typeChecklists.set(type, items);
  }

  // ----------------- render -----------------

  #render() {
    if (this.view === 'faq') {
      const body = FAQView({
        onBack: () => {
          this.view = 'home';
          this.#render();
        },
      });
      return render(body, document.getElementById('root'));
    }

    const p = this.proposalData;
    const loading = this.isFetching;

    const body = html`
      <nav class="topbar">
        <h1 class="grow">IC Proposal Verifier</h1>

        <div style="display:flex; gap:8px; align-items:center;">
          ${this.identity
            ? html`
                <div style="text-align:right;">
                  <div style="font-size:12px;">
                    <b>User</b>: <code>${this.userPrincipal}</code>
                  </div>
                  <div style="font-size:12px;">
                    <b>Balance</b>: ${(this.userBalance / 1e8).toFixed(8)} ICP
                  </div>
                  <div style="font-size:12px;">
                    <b>Fees</b>:
                    fetch=${Number(this.fees.fetchProposal_e8s) / 1e8} ICP, outcall=${
                      Number(this.fees.httpOutcall_e8s) / 1e8
                    } ICP
                    <em>(+ 0.0001 ICP network fee each)</em>
                  </div>
                </div>
                <button class="btn secondary" @click=${() => this.#logout()}>
                  Logout
                </button>
              `
            : html`
                <button class="btn" @click=${() => this.#login()}>
                  Login with Internet Identity
                </button>
              `}
          ${this.view === 'home'
            ? html`
                <button
                  class="btn"
                  @click=${() => {
                    this.view = 'faq';
                    this.#render();
                  }}
                >
                  Open FAQ
                </button>
              `
            : html`
                <button
                  class="btn"
                  @click=${() => {
                    this.view = 'home';
                    this.#render();
                  }}
                >
                  &larr; Back
                </button>
              `}
        </div>
      </nav>

      ${this.identity
        ? html`
            <section class="advisory">
              <details open>
                <summary><b>Fund your balance</b></summary>
                <p>
                  Send ICP to <b>your deposit address</b> below. Fees are deducted automatically
                  from this address when you run billed actions (e.g. <b>Fetch Proposal</b>).
                </p>

                <ul>
                  <li>
                    <b>Your PID (principal):</b> <code>${this.userPrincipal}</code>
                  </li>
                  <li>
                    <b>Deposit Address (Account Identifier):</b><br />
                    ${this.depositAccountIdentifierHex
                      ? html`<code>${this.depositAccountIdentifierHex}</code>
                          <button
                            class="btn secondary"
                            @click=${(e) =>
                              this.#handleCopy(
                                e,
                                this.depositAccountIdentifierHex,
                                'Copy Address',
                              )}
                          >
                            Copy
                          </button>`
                      : '(calculating…)'}
                  </li>
                </ul>

                <details>
                  <summary><b>Advanced (principal + subaccount)</b></summary>
                  <ul>
                    <li>
                      <b>Owner (canister principal):</b>
                      <code>${this.depositOwner ?? '(loading...)'}</code>
                    </li>
                    <li>
                      <b>Your subaccount (hex):</b>
                      <code>${this.depositSubaccountHex ?? '(loading...)'}</code>
                      <br /><small
                        >(Only for wallets that support “send to principal + subaccount”.)</small
                      >
                    </li>
                  </ul>
                </details>

                <details>
                  <summary>How to send</summary>
                  <p>
                    <b>Most wallets (incl. NNS):</b> paste the <i>Deposit Address</i> above into the
                    “To” field and send ICP.
                  </p>
                  <p>
                    <b>Wallets with principal + subaccount:</b> send to the canister principal under
                    <b>Advanced</b>, and paste your subaccount hex under “Advanced”.
                  </p>
                  <p><b>CLI (dfx):</b></p>
                  <pre class="cmd-pre">dfx ledger transfer ${this.depositAccountIdentifierHex ||
                  '<ADDRESS>'} --icp 0.5 --memo 0</pre>
                </details>

                <div style="display:flex; gap:12px; flex-wrap:wrap; align-items:center;">
                  <button
                    class="btn secondary"
                    @click=${() => {
                      this.#loadDepositStatus();
                      this.#refreshBalance();
                    }}
                  >
                    Refresh balances
                  </button>
                  ${this.depositAvailableToCredit > 0
                    ? html`
                        <button class="btn" @click=${() => this.#recordAllDeposits()}>
                          Credit Now
                        </button>
                      `
                    : ''}
                </div>

                <div style="margin-top:8px;">
                  <div>
                    <b>On-chain (deposit subaccount):</b>
                    ${(this.depositLedgerBalance / 1e8).toFixed(8)} ICP
                  </div>
                  <div>
                    <b>Credited to app:</b>
                    ${(this.depositCreditedTotal / 1e8).toFixed(8)} ICP
                  </div>
                  <div>
                    <b>Available to credit:</b>
                    ${(this.depositAvailableToCredit / 1e8).toFixed(8)} ICP
                    ${this.depositAvailableToCredit > 0
                      ? html`<small style="margin-left:6px;">(click
                            <b>Credit Now</b> to add)</small>`
                      : ''}
                  </div>
                </div>
              </details>
            </section>
          `
        : ''}

      <section class="advisory">
        <p>
          <b>Advisory:</b> This tool surfaces links, hashes, and commands to assist verification.
          Always prefer <b>reproducible builds</b> and compare with on-chain metadata.
        </p>
      </section>

      <main>
        <form @submit=${(e) => this.#handleFetchProposal(e)}>
          <label>Proposal ID:</label>
          <input id="proposalId" type="number" placeholder="e.g. 138924" ?disabled=${loading} />
          <button type="submit" class=${loading ? 'loading btn' : 'btn'} ?disabled=${loading}>
            ${loading ? 'Fetching…' : 'Fetch Proposal'}
          </button>
          <button
            type="button"
            class="btn secondary"
            @click=${() => {
              this.view = 'faq';
              this.#render();
            }}
          >
            Open FAQ
          </button>
        </form>

        ${p
          ? html`
              <section>
                <h2>Proposal Details</h2>
                <p><b>ID:</b> ${p.id}</p>
                <p><b>Type:</b> ${p.proposalType}</p>
                <p><b>Title:</b> ${p.title || '(none)'} </p>
                <p><b>Summary (raw):</b></p>
                <pre>${p.summary}</pre>
                <button class="btn" @click=${(e) => this.#handleCopy(e, p.summary, 'Copy Summary')}>
                  Copy Summary
                </button>

                <p><b>Extracted Repo:</b> ${p.extractedRepo ?? 'None'}</p>
                <p>
                  <b>Extracted Commit:</b>
                  ${p.extractedCommit
                    ? p.commitUrl
                      ? html`<a
                          href="${p.commitUrl}"
                          target="_blank"
                          rel="noreferrer"
                          >${p.extractedCommit}</a
                        >`
                      : p.extractedCommit
                    : 'None'}
                </p>

                <p><b>Onchain WASM Hash:</b> ${p.proposal_wasm_hash ?? 'None'}</p>
                <p><b>Onchain Arg Hash:</b> ${p.proposal_arg_hash ?? 'None'}</p>

                <p>
                  <b>Expected WASM/Release Hash (from Sources):</b>
                  ${this.expectedHash ?? 'None'}
                  ${this.expectedHash
                    ? html`<em>(source: ${this.expectedHashSource || 'unknown'})</em>`
                    : ''}
                </p>

                <p><b>Arg Hash (from Dashboard/API):</b> ${this.argHash ?? 'None'}</p>

                <p>
                  <b>Extracted Doc URL:</b>
                  ${p.extractedDocUrl
                    ? html`<a
                        href="${p.extractedDocUrl}"
                        target="_blank"
                        rel="noreferrer"
                        >${p.extractedDocUrl}</a
                      >`
                    : 'None'}
                </p>
                <p><b>Artifact Path Hint:</b> ${p.extractedArtifact ?? 'None'}</p>

                <p>
                  <b>Commit Status:</b>
                  ${this.commitStatus}
                  ${p.commitUrl
                    ? html`&nbsp;(<a
                          href="${p.commitUrl}"
                          target="_blank"
                          rel="noreferrer"
                          >open</a
                        >)`
                    : ''}
                </p>

                ${this.dashboardUrl
                  ? html`<p>
                      <b>Dashboard:</b>
                      <a href="${this.dashboardUrl}" target="_blank" rel="noreferrer"
                        >${this.dashboardUrl}</a
                      >
                    </p>`
                  : ''}
              </section>

              <section>
                <h2>Relevant Links</h2>
                ${this.#renderLinks()}
              </section>

              ${this.#renderReleaseCommands()} ${this.#renderTypeGuidance()}
              ${this.#renderArgSection(p)}

              <section>
                <h2>Verify Documents / Local Files</h2>
                <details>
                  <summary>How to use</summary>
                  <p>
                    For PDFs/WASMs/tar.zst: download from links (e.g., wiki/forum), upload below.
                    Hashes must match the proposal summary or dashboard.
                  </p>
                </details>
                ${(() => {
                  const docs = (this.proposalData?.extractedDocs || []).filter(
                    (d) => d.hash != null,
                  );
                  if (!docs.length)
                    return html`<p>No documents extracted. Paste URL or upload manually.</p>`;
                  return html`
                    <ul class="doc-list">
                      ${docs.map((d, idx) => {
                        const res =
                          this.docResults[idx] || { match: false, error: '', preview: '' };
                        return html`
                          <li>
                            <b>${d.name}</b> (expected: ${d.hash || 'none'})
                            <input
                              type="file"
                              @change=${(e) => this.#handleFileUpload(e, idx)}
                            />
                            <p><b>Match:</b> ${res.match ? '✅ Yes' : '❌ No'}</p>
                            ${res.error ? html`<p class="error">${res.error}</p>` : ''}
                            <p><b>Preview:</b> ${res.preview}</p>
                          </li>
                        `;
                      })}
                    </ul>
                  `;
                })()}
                <input
                  id="docUrl"
                  placeholder="Document URL (text/JSON only)"
                  value=${p.extractedDocUrl ?? ''}
                />
                <input
                  id="expectedDocHash"
                  placeholder="Expected SHA-256"
                  value=${this.expectedHash || ''}
                />
                <button class="btn" @click=${() => this.#handleFetchVerifyDoc()}>
                  Fetch & Verify URL (text only)
                </button>
                ${this.docHashError
                  ? html`<p class="error" style="margin-top:8px;">${this.docHashError}</p>`
                  : ''}
                ${typeof this.docHashMatch === 'boolean'
                  ? html`<p>
                      <b>URL Hash Match:</b> ${this.docHashMatch ? '✅ Yes' : '❌ No'}
                    </p>`
                  : ''}
                ${this.docPreview ? html`<p><b>Preview:</b> ${this.docPreview}</p>` : ''}
              </section>

              <section>
                <h2>Payload (from Dashboard/API)</h2>
                <pre>${this.payloadSnippetFromDashboard ??
                '(no payload snippet found from ic-api)'}</pre>
                <button
                  class="btn"
                  @click=${(e) =>
                    this.#handleCopy(e, this.payloadSnippetFromDashboard || '', 'Copy Payload')}
                >
                  Copy Payload
                </button>
              </section>

              <section>
                <h2>Rebuild Locally</h2>
                ${p.extractedArtifact
                  ? html`<p><b>Artifact (expected):</b> ${p.extractedArtifact}</p>`
                  : ''}
                <pre>${this.rebuildScript}</pre>
                <button
                  class="btn"
                  @click=${(e) => this.#handleCopy(e, this.rebuildScript, 'Copy Script')}
                >
                  Copy Script
                </button>
                <p>
                  Compare your local <code>sha256sum</code>/<code>shasum - a 256</code> with the
                  <b>onchain WASM hash</b>: ${p.proposal_wasm_hash ?? 'N/A'}
                </p>
              </section>

              <section>
                <h2>Verification Steps for ${p.proposalType}</h2>
                ${(() => {
                  const steps = (this.verificationSteps || '').trim();
                  if (!steps)
                    return html`<p>No type-specific steps available for this proposal.</p>`;
                  const items = steps
                    .split('\n')
                    .map((s) => s.trim())
                    .filter(Boolean);
                  return html`<ol class="steps-list">
                    ${items.map((s) => html`<li>${s}</li>`)}
                  </ol>`;
                })()}
              </section>

              <section>
                <h2>Required Tools</h2>
                <pre>${this.requiredTools || 'No specific tools required for this type.'}</pre>
              </section>

              ${this.typeChecklistItems.length
                ? html`
                    <section>
                      <h2>Type-Specific Checklist (${p.proposalType})</h2>
                      <ul>
                        ${this.typeChecklistItems.map(
                          (item) => html`<li>
                            <label>
                              <input
                                type="checkbox"
                                ?checked=${this.checklist[item.key] || false}
                                @change=${(e) => {
                                  this.checklist[item.key] = e.target.checked;
                                  this.#render();
                                }}
                              />
                              ${item.label}
                            </label>
                          </li>`,
                        )}
                      </ul>
                    </section>
                  `
                : ''}

              <section>
                <h2>Checklist</h2>
                ${this.#renderTypeChecklist()}
              </section>
            `
          : ''}
      </main>
    `;
    render(body, document.getElementById('root'));
  }
}

export default App;
