// src/proposal_verifier_frontend/src/App.js
import { html, render } from 'lit-html';
import { unsafeHTML } from 'lit-html/directives/unsafe-html.js';
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
import { Principal } from '@dfinity/principal'; // <-- NEW
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { jsPDF } from 'jspdf';
import { fetchProposalJson, extractPayloadRendering, fetchPayloadEndpoint } from './icApi.js';

const REQUIRED_ANCHOR_REL_ATTRS = ['noopener', 'noreferrer'];

DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank');
    const relTokens = new Set(
      (node.getAttribute('rel') || '')
        .split(/\s+/)
        .map((token) => token.trim())
        .filter(Boolean),
    );
    for (const attr of REQUIRED_ANCHOR_REL_ATTRS) {
      relTokens.add(attr);
    }
    node.setAttribute('rel', Array.from(relTokens).join(' '));
  }
});

const markedRenderer = new marked.Renderer();
const originalLinkRenderer = markedRenderer.link;
markedRenderer.link = function (href, title, text) {
  const html = originalLinkRenderer.call(this, href, title, text);
  if (!html || html.includes('target=')) {
    return html;
  }
  return html.replace('<a ', '<a target="_blank" rel="noopener noreferrer" ');
};
marked.use({ renderer: markedRenderer });

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

const LONG_SESSION_TTL = 365n * 24n * 60n * 60n * 1_000_000_000n; // one year in nanoseconds

const DASHBOARD_LABEL_VARIANTS = {
  proposalType: ['proposal type'],
  targetCanister: ['target canister', 'canister', 'target canister id'],
  targetCanisterName: ['target canister name', 'canister name'],
  controllers: ['controllers', 'controller'],
  subnetId: ['subnet id', 'subnet'],
  sourceRepository: ['source repository', 'source repo', 'repository'],
  sourceCommit: ['source commit', 'commit'],
  proposer: ['proposer', 'submitted by'],
  argumentPayload: ['argument payload', 'argument'],
  wasmHash: ['proposed wasm (gz) sha-256', 'proposed wasm sha-256', 'wasm sha-256', 'wasm hash'],
};

function cleanDashboardValue(value) {
  if (value == null) return '';
  const str = String(value).replace(/\u00a0/g, ' ');
  return str.replace(/\s+/g, ' ').trim();
}

function normalizeListDisplay(value) {
  const cleaned = cleanDashboardValue(value);
  if (!cleaned) return '';
  if ((cleaned.startsWith('[') && cleaned.endsWith(']')) || cleaned.startsWith('{')) {
    try {
      const parsed = JSON.parse(cleaned);
      if (Array.isArray(parsed)) {
        return parsed
          .map((entry) => cleanDashboardValue(entry))
          .filter(Boolean)
          .join(', ');
      }
    } catch {
      // ignore JSON parse errors
    }
  }
  return cleaned.replace(/\s*•\s*/g, ', ').replace(/\s*,\s*/g, ', ');
}

function parseCanisterField(value) {
  const parsed = { id: '', name: '' };
  const cleaned = cleanDashboardValue(value);
  if (!cleaned) return parsed;
  const nameMatch = cleaned.match(/\(([^)]+)\)/);
  if (nameMatch) parsed.name = cleanDashboardValue(nameMatch[1]);
  const tokens = cleaned
    .replace(/[(),]/g, ' ')
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean);
  for (const token of tokens) {
    try {
      Principal.fromText(token);
      parsed.id = token;
      break;
    } catch {
      // ignore tokens that are not principals
    }
  }
  if (!parsed.id) {
    const fallback = cleaned.match(/[a-z0-9-]{27,}/i);
    if (fallback) parsed.id = fallback[0];
  }
  return parsed;
}

function findFirstStringValue(node, keys = []) {
  if (!node || typeof node !== 'object') return '';
  const queue = [node];
  const seen = new Set();
  while (queue.length) {
    const current = queue.shift();
    if (!current || typeof current !== 'object') continue;
    if (seen.has(current)) continue;
    seen.add(current);
    if (Array.isArray(current)) {
      queue.push(...current);
      continue;
    }
    for (const key of keys) {
      const value = current[key];
      if (typeof value === 'string' && value.trim()) {
        return cleanDashboardValue(value);
      }
    }
    for (const value of Object.values(current)) {
      if (value && typeof value === 'object') queue.push(value);
    }
  }
  return '';
}

function isLikelyBareIdentifier(value) {
  if (!value) return true;
  const trimmed = String(value).trim();
  if (!trimmed) return true;
  if (/^n\/?a$/i.test(trimmed)) return true;
  if (/^\d+$/.test(trimmed)) return true;
  // Principal text representations are base32-ish with hyphens and at least 27 chars
  if (/^[a-z0-9-]{27,63}$/i.test(trimmed) && trimmed.includes('-')) {
    return true;
  }
  return false;
}

function extractProposerFromSummary(summary) {
  if (!summary || typeof summary !== 'string') return '';
  const match = summary.match(/proposer\s*[:：]\s*([^\n\r]+)/i);
  if (!match) return '';
  const value = cleanDashboardValue(match[1]);
  return value;
}

function extractDashboardReportFields(rawText) {
  if (!rawText || typeof rawText !== 'string') return {};
  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    const first = rawText.indexOf('{');
    const last = rawText.lastIndexOf('}');
    if (first >= 0 && last > first) {
      try {
        parsed = JSON.parse(rawText.slice(first, last + 1));
      } catch {
        return {};
      }
    } else {
      return {};
    }
  }

  const labelMap = new Map();
  const labelKeys = ['label', 'title', 'name', 'heading', 'key', 'field', 'label_text'];
  const valueKeys = ['value', 'values', 'text', 'content', 'description', 'body', 'data', 'children', 'details'];

  const gatherValue = (input) => {
    const results = [];
    const stack = [{ value: input, depth: 0 }];
    const visited = new WeakSet();
    while (stack.length) {
      const { value, depth } = stack.pop();
      if (value === null || value === undefined) continue;
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        const str = cleanDashboardValue(value);
        if (str) results.push(str);
        continue;
      }
      if (typeof value === 'object') {
        if (visited.has(value) || depth > 6) continue;
        visited.add(value);
        if (Array.isArray(value)) {
          for (const item of value) stack.push({ value: item, depth: depth + 1 });
        } else {
          for (const key of valueKeys) {
            if (Object.prototype.hasOwnProperty.call(value, key)) {
              stack.push({ value: value[key], depth: depth + 1 });
            }
          }
        }
      }
    }
    return results;
  };

  const visitedNodes = new WeakSet();
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (visitedNodes.has(node)) return;
    visitedNodes.add(node);
    if (Array.isArray(node)) {
      node.forEach((child) => walk(child));
      return;
    }
    let label = null;
    for (const key of labelKeys) {
      const candidate = node[key];
      if (typeof candidate === 'string' && candidate.trim()) {
        label = cleanDashboardValue(candidate);
        if (label) break;
      }
    }
    if (label) {
      const valueParts = [];
      for (const key of valueKeys) {
        if (Object.prototype.hasOwnProperty.call(node, key)) {
          valueParts.push(...gatherValue(node[key]));
        }
      }
      const combined = cleanDashboardValue(valueParts.join(' '));
      if (combined) {
        const normalized = label.toLowerCase();
        const existing = labelMap.get(normalized);
        if (!existing || combined.length > existing.length) {
          labelMap.set(normalized, combined);
        }
      }
    }
    for (const value of Object.values(node)) {
      if (value && typeof value === 'object') walk(value);
    }
  };

  walk(parsed);

  const getLabelValue = (variants = []) => {
    for (const variant of variants) {
      const normalized = variant.toLowerCase();
      if (labelMap.has(normalized)) {
        return labelMap.get(normalized);
      }
    }
    return '';
  };

  const result = {};

  const typeValue = getLabelValue(DASHBOARD_LABEL_VARIANTS.proposalType);
  if (typeValue) {
    const parts = typeValue
      .split(/→|->|=>|›|»|>|:/)
      .map((part) => part.trim())
      .filter(Boolean);
    const filtered = parts.filter((part) => !/^governance$/i.test(part));
    if (filtered.length >= 2) {
      result.proposalCategory = filtered[filtered.length - 2];
      result.proposalAction = filtered[filtered.length - 1];
    } else if (filtered.length === 1) {
      result.proposalAction = filtered[0];
    }
  }

  const targetValue = getLabelValue(DASHBOARD_LABEL_VARIANTS.targetCanister);
  if (targetValue) {
    const { id, name } = parseCanisterField(targetValue);
    if (id) result.targetCanisterId = id;
    if (name) result.targetCanisterName = name;
  }
  const targetNameValue = getLabelValue(DASHBOARD_LABEL_VARIANTS.targetCanisterName);
  if (targetNameValue && !result.targetCanisterName) {
    result.targetCanisterName = cleanDashboardValue(targetNameValue);
  }

  const controllersValue = getLabelValue(DASHBOARD_LABEL_VARIANTS.controllers);
  if (controllersValue) {
    result.controllers = normalizeListDisplay(controllersValue);
  }

  const subnetValue = getLabelValue(DASHBOARD_LABEL_VARIANTS.subnetId);
  if (subnetValue) {
    result.subnetId = cleanDashboardValue(subnetValue);
  }

  const repoValue = getLabelValue(DASHBOARD_LABEL_VARIANTS.sourceRepository);
  if (repoValue) {
    result.sourceRepository = cleanDashboardValue(repoValue);
  }

  const commitValue = getLabelValue(DASHBOARD_LABEL_VARIANTS.sourceCommit);
  if (commitValue) {
    result.sourceCommit = cleanDashboardValue(commitValue);
  }

  const proposerValue =
    getLabelValue(DASHBOARD_LABEL_VARIANTS.proposer) ||
    findFirstStringValue(parsed, ['proposer', 'submitted_by', 'proposer_principal']);
  if (proposerValue) {
    result.proposer = cleanDashboardValue(proposerValue);
  }

  const wasmValue = getLabelValue(DASHBOARD_LABEL_VARIANTS.wasmHash);
  if (wasmValue) {
    const match = wasmValue.match(/[A-Fa-f0-9]{64}/);
    if (match) {
      result.wasmHash = match[0];
    }
  }

  const argumentValue = getLabelValue(DASHBOARD_LABEL_VARIANTS.argumentPayload);
  if (argumentValue) {
    const cleanedArgument = cleanDashboardValue(argumentValue);
    const hexMatch = cleanedArgument.match(/[A-Fa-f0-9]{64,}/);
    if (hexMatch) {
      result.argumentValue = hexMatch[0];
      result.argumentType = /hash|sha|hex/i.test(cleanedArgument) ? 'Hex' : result.argumentType;
    } else if (cleanedArgument) {
      result.argumentValue = cleanedArgument;
    }
    if (!result.argumentType) {
      if (/candid/i.test(cleanedArgument)) {
        result.argumentType = 'Candid';
      } else if (/hex|sha-?256|hash/i.test(cleanedArgument)) {
        result.argumentType = 'Hex';
      }
    }
  }

  return result;
}

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

const REPORT_HEADER_KEYS = [
  'proposalId',
  'proposalTitle',
  'proposalCategory',
  'proposalAction',
  'targetCanisterId',
  'targetCanisterName',
  'controllers',
  'subnetId',
  'sourceRepository',
  'sourceCommit',
  'wasmHash',
  'argumentType',
  'argumentValue',
  'proposer',
  'verificationDate',
  'verifiedBy',
  'generatedBy',
  'linkNns',
  'linkDashboard',
];

const GUIDE_URL = 'https://github.com/dickhery/proposal_verifier/blob/main/GUIDE.md';

const REPORT_HEADER_INPUTS = [
  { key: 'proposalTitle', label: 'Proposal Title', placeholder: 'Enter the proposal title' },
  {
    key: 'proposalCategory',
    label: 'Proposal Category',
    placeholder: 'e.g. ProtocolCanisterManagement',
  },
  { key: 'proposalAction', label: 'Action Type', placeholder: 'e.g. InstallCode' },
  {
    key: 'targetCanisterId',
    label: 'Target Canister ID',
    placeholder: 'e.g. ryjl3-tyaaa-aaaaa-aaaba-cai',
  },
  { key: 'targetCanisterName', label: 'Target Canister Name', placeholder: 'Friendly name' },
  {
    key: 'controllers',
    label: 'Controllers',
    placeholder: 'Comma-separated controller principals or canisters',
  },
  { key: 'subnetId', label: 'Subnet ID', placeholder: 'Subnet identifier' },
  {
    key: 'sourceRepository',
    label: 'Source Repository',
    placeholder: 'owner/repo or repository URL',
  },
  { key: 'sourceCommit', label: 'Source Commit or Tag', placeholder: 'Commit hash or release tag' },
  { key: 'wasmHash', label: 'WASM Hash', placeholder: '64-character SHA-256 hash' },
  { key: 'argumentType', label: 'Argument Type', placeholder: 'Candid, Raw Hex, etc.' },
  {
    key: 'argumentValue',
    label: 'Argument Hash or Value',
    placeholder: 'Payload hash or encoded value',
  },
  { key: 'proposer', label: 'Proposer', placeholder: 'Entity or participant' },
  { key: 'verificationDate', label: 'Verification Date', placeholder: 'YYYY-MM-DD' },
  { key: 'verifiedBy', label: 'Verified By', placeholder: 'Verifier or group' },
  {
    key: 'linkNns',
    label: 'NNS dapp view URL',
    placeholder: 'https://nns.ic0.app/proposal/?u=qoctq-giaaa-aaaaa-aaaea-cai&proposal=<id>',
  },
  { key: 'linkDashboard', label: 'ICP Dashboard URL', placeholder: 'https://...' },
];

const NNS_DAPP_PROPOSAL_BASE_URL =
  'https://nns.ic0.app/proposal/?u=qoctq-giaaa-aaaaa-aaaea-cai&proposal=';

function buildNnsProposalUrl(proposalId) {
  if (proposalId === null || proposalId === undefined) return '';
  let idString;
  if (typeof proposalId === 'number' && Number.isFinite(proposalId)) {
    idString = Math.trunc(proposalId).toString();
  } else if (typeof proposalId === 'bigint') {
    idString = proposalId.toString();
  } else {
    idString = String(proposalId).trim();
  }
  if (!/^\d+$/.test(idString)) return '';
  return `${NNS_DAPP_PROPOSAL_BASE_URL}${idString}`;
}

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

// NEW: Simple Candid-like stringifier for metadata export
function stringifyToCandid(obj, indent = '') {
  if (obj === null || obj === undefined) return 'null';
  if (typeof obj === 'bigint' || typeof obj === 'number') return String(obj);
  if (typeof obj === 'boolean') return obj ? 'true' : 'false';
  if (typeof obj === 'string') return `"${obj.replace(/"/g, '\\"')}"`;
  // Principals (from @dfinity/principal)
  if (
    obj &&
    typeof obj === 'object' &&
    typeof obj.toText === 'function' &&
    typeof obj.toUint8Array === 'function'
  ) {
    try {
      return `principal "${obj.toText()}"`;
    } catch {
      // fall through
    }
  }
  if (obj instanceof Uint8Array) {
    return `blob "${Array.from(obj)
      .map((b) => '\\' + b.toString(16).padStart(2, '0'))
      .join('')}"`;
  }
  if (Array.isArray(obj)) {
    if (obj.length === 0) return 'vec {}';
    return `vec { ${obj.map((v) => stringifyToCandid(v, indent + '  ')).join('; ')} }`;
  }
  if (typeof obj === 'object') {
    const entries = Object.entries(obj);
    if (entries.length === 0) return 'record {}';
    const lines = entries.map(
      ([k, v]) => `${indent}  ${k} = ${stringifyToCandid(v, indent + '  ')}`,
    );
    return `record {\n${lines.join(';\n')}\n${indent}}`;
  }
  return String(obj); // fallback
}

const NETWORK_FEE_E8S = 10_000; // 0.0001 ICP
const BENEFICIARY_ACCOUNT_IDENTIFIER =
  '2ec3dee16236d389ebdff4346bc47d5faf31db393dac788e6a6ab5e10ade144e';

class App {
  view = 'home'; // 'home' | 'faq'

  // --- backend/auth/billing state ---
  backend = anon_backend; // actor (anonymous by default, replaced after login)
  authClient = null;
  identity = null;
  isAuthenticating = false;
  userPrincipal = null;
  userBalance = 0; // in e8s

  // DEFAULT FEES (dynamic quote fetched from backend; fallback remains 0.2 ICP)
  fees = { fetchProposal_e8s: 20_000_000n, httpOutcall_e8s: 0n }; // defaults, loaded from backend
  feesDynamicInfo = null;

  // Deposit/account state
  depositOwner = null; // canister principal (string)
  depositSubaccountHex = null; // subaccount (hex)
  depositAccountIdentifierHex = null; // legacy 32-byte address (64 hex)
  // NEW: live balances and auto-credit tracking
  depositLedgerBalance = 0; // Nat (as JS number for display)
  depositCreditedTotal = 0; // Nat64-ish (display)
  depositAvailableToCredit = 0; // Nat delta (display)
  isAutoCrediting = false;

  // --- app state ---
  proposalData = null;
  fullProposalInfo = null; // NEW: raw ProposalInfo for export (.txt)
  reportOverrides = {};
  reportNotes = '';
  reportHeaderAutofill = {};
  reportGenerationDate = '';
  commitStatus = '';
  hashMatch = false;
  hashError = '';
  docResults = [];
  docExpectation = 'unknown';
  rebuildScript = '';
  isFetching = false;
  isVerifyingArgs = false;
  cycleBalance = null;
  lastFetchCyclesBurned = null;
  fetchCyclesAverage = null;
  fetchCyclesCount = 0;

  expectedHash = null; // expected wasm/release hash (from sources)
  expectedHashSource = null;

  argHash = null; // arg_hash (from dashboard/ic-api or backend)

  payloadSnippetFromDashboard = null;
  payloadSnippetRawFromDashboard = null;
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

  checklistManualOverrides = {};

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
      this.authClient = await AuthClient.create({
        idleOptions: {
          disableIdle: true,
          disableDefaultIdleCallback: true,
        },
      });
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
    if (!this.authClient) return;
    this.isAuthenticating = true;
    this.#render();
    try {
      await this.authClient.login({
        identityProvider: 'https://id.ai/#authorize',
        maxTimeToLive: LONG_SESSION_TTL,
        onSuccess: async () => {
          try {
            await this.#onAuthenticated();
          } catch (e) {
            alert('Login completed but session setup failed: ' + (e?.message || String(e)));
          }
          this.isAuthenticating = false;
          this.#render();
        },
        onError: (err) => {
          alert('Login error: ' + (err?.message || String(err)));
          this.isAuthenticating = false;
          this.#render();
        },
      });
    } catch (e) {
      alert('Login failed: ' + (e?.message || String(e)));
      this.isAuthenticating = false;
      this.#render();
    }
  }

  async #logout() {
    this.isAuthenticating = false;
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
    this.fees = { fetchProposal_e8s: 20_000_000n, httpOutcall_e8s: 0n };
    this.feesDynamicInfo = null;

    this.proposalData = null;
    this.fullProposalInfo = null;
    this.reportOverrides = {};
    this.reportHeaderAutofill = {};
    this.reportGenerationDate = '';
    this.reportNotes = '';
    this.checklistManualOverrides = {};

    // Clear deposit state
    this.depositOwner = null;
    this.depositSubaccountHex = null;
    this.depositAccountIdentifierHex = null;
    this.depositLedgerBalance = 0;
    this.depositCreditedTotal = 0;
    this.depositAvailableToCredit = 0;

    this.lastFetchCyclesBurned = null;
    this.fetchCyclesAverage = null;
    this.fetchCyclesCount = 0;
    // Also clear the cached owner blob used by utils.principalToAccountIdentifier
    try {
      // eslint-disable-next-line no-undef
      delete window.__ownerBlob; // <-- NEW (nice-to-have)
    } catch {}
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
    await this.#loadCycleStats();
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
      const fetchRaw = f?.fetchProposal_e8s;
      const outcallRaw = f?.httpOutcall_e8s;
      const fetch =
        typeof fetchRaw === 'bigint'
          ? fetchRaw
          : BigInt(fetchRaw ?? 20_000_000);
      const outcall =
        typeof outcallRaw === 'bigint'
          ? outcallRaw
          : BigInt(outcallRaw ?? 0);
      this.fees = {
        fetchProposal_e8s: fetch,
        httpOutcall_e8s: outcall,
      };
      this.feesDynamicInfo = f?.dynamic_info ?? null;
    } catch {
      // keep defaults
    }
  }

  async #quoteNow() {
    try {
      const q = await this.backend.quoteFetchProposalFee();
      const icp = Number(q.fee_e8s) / 1e8;
      const lines = [
        `Live quote: ${icp.toFixed(8)} ICP`,
        `— avg cycles: ${q.avg_cycles}`,
        `— xdr_permyriad_per_icp: ${q.xdr_permyriad_per_icp}`,
        `— cycles_per_icp: ${q.cycles_per_icp}`,
        `— margin: ${q.margin_bps} bps`,
      ];
      if (q.rate_timestamp_seconds) {
        lines.push(`— rate timestamp: ${new Date(Number(q.rate_timestamp_seconds) * 1000).toISOString()}`);
      }
      alert(lines.join('\n'));
      await this.#loadFees();
    } catch (e) {
      alert('Quote failed: ' + (e?.message || String(e)));
    }
  }

  // ----------------- deposit status (new) -----------------

  async #loadDepositStatus({ autoCredit = true, silentCredit = true } = {}) {
    try {
      const s = await this.backend.getDepositStatus();
      // owner + subaccount for address calculation
      this.depositOwner = String(s.owner);

      // ---- NEW: set owner blob for utils.principalToAccountIdentifier ----
      try {
        const ownerBlob = Principal.fromText(this.depositOwner).toUint8Array();
        // eslint-disable-next-line no-undef
        window.__ownerBlob = ownerBlob;
      } catch (e) {
        console.warn('Failed to set owner blob:', e?.message || e);
      }

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
      // Fallback to previous method if status helper not available
      await this.#loadDepositAccount(); // will populate owner/sub/address
      this.depositLedgerBalance = 0;
      this.depositCreditedTotal = 0;
      this.depositAvailableToCredit = 0;
    }
    if (autoCredit && this.depositAvailableToCredit > 0) {
      await this.#recordAllDeposits({ silent: silentCredit });
    } else {
      this.#render();
    }
  }

  // Legacy: load only owner/subaccount if status helper not available
  async #loadDepositAccount() {
    try {
      const acc = await this.backend.getDepositAccount();
      this.depositOwner = String(acc.owner);

      // ---- NEW: set owner blob for utils.principalToAccountIdentifier ----
      try {
        const ownerBlob = Principal.fromText(this.depositOwner).toUint8Array();
        // eslint-disable-next-line no-undef
        window.__ownerBlob = ownerBlob;
      } catch (e) {
        console.warn('Failed to set owner blob (legacy path):', e?.message || e);
      }

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

  async #loadCycleStats() {
    if (typeof this.backend?.getFetchCycleStats === 'function') {
      try {
        const stats = await this.backend.getFetchCycleStats();
        this.lastFetchCyclesBurned = stats?.last ?? null;
        const rawCount = stats?.count ?? 0n;
        const countNumber = Number(rawCount);
        this.fetchCyclesCount = Number.isFinite(countNumber) ? countNumber : 0;
        this.fetchCyclesAverage = this.fetchCyclesCount > 0 ? stats?.average ?? null : null;
        return;
      } catch (err) {
        const message = err?.message || 'Unavailable';
        this.lastFetchCyclesBurned = message;
        this.fetchCyclesAverage = message;
        this.fetchCyclesCount = 0;
        return;
      }
    }

    this.fetchCyclesCount = 0;
    if (typeof this.backend?.getLastFetchCyclesBurned === 'function') {
      try {
        const burned = await this.backend.getLastFetchCyclesBurned();
        this.lastFetchCyclesBurned = burned;
        this.fetchCyclesAverage = null;
      } catch (cyclesErr) {
        const message = cyclesErr?.message || 'Unavailable';
        this.lastFetchCyclesBurned = message;
        this.fetchCyclesAverage = message;
      }
    } else {
      this.lastFetchCyclesBurned = 'N/A';
      this.fetchCyclesAverage = null;
    }
  }

  // Auto-credit whatever arrived on-chain (no amount field)
  async #recordAllDeposits({ silent = false } = {}) {
    if (!this.identity) {
      if (!silent) alert('Login required to record deposits.');
      return;
    }
    if (this.isAutoCrediting) return;
    this.isAutoCrediting = true;
    try {
      const res = await this.backend.recordDepositAuto();
      if (res.ok !== undefined) {
        const r = res.ok;
        const deltaE8s = Number(r.credited_delta_e8s || 0);
        this.userBalance = Number(r.total_internal_balance_e8s || 0);
        this.depositLedgerBalance = Number(r.ledger_balance_e8s || 0);
        this.depositCreditedTotal = Number(r.credited_total_e8s || 0);
        this.depositAvailableToCredit = Math.max(
          0,
          this.depositLedgerBalance - this.depositCreditedTotal,
        );
        if (!silent && deltaE8s > 0) {
          alert(
            `Credited ${(deltaE8s / 1e8).toFixed(8)} ICP from your ledger subaccount.`,
          );
        }
        await this.#refreshBalance();
      } else if (!silent) {
        alert('Deposit error: ' + (res.err || 'unknown'));
      }
    } catch (e) {
      if (!silent) alert('Deposit failed: ' + (e?.message || String(e)));
    } finally {
      this.isAutoCrediting = false;
      this.#render();
    }
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
    const base = {
      fetch: !!this.proposalData,
      commit: this.commitStatus.startsWith('✅'),
      argsHash: this.hashMatch,
      docHash:
        this.docResults.length > 0 && this.docResults.every((r) => r.match),
      expected: !!this.expectedHash,
      rebuild: false,
      manual: false,
    };
    const overrides = this.checklistManualOverrides || {};
    for (const [key, value] of Object.entries(overrides)) {
      if (typeof value === 'boolean') {
        base[key] = value;
      }
    }
    this.checklist = base;
    this.#updateTypeChecklist();
  }

  #setChecklistOverride(key, value) {
    if (!key) return;
    const next = { ...this.checklistManualOverrides };
    if (typeof value === 'boolean') {
      next[key] = value;
    } else {
      delete next[key];
    }
    this.checklistManualOverrides = next;
    this.#updateChecklist();
    this.#render();
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
      const { json, text } = await fetchProposalJson(id);
      if (!text) return;

      const extractedFields = extractDashboardReportFields(text);
      if (extractedFields && Object.keys(extractedFields).length) {
        this.reportHeaderAutofill = { ...this.reportHeaderAutofill, ...extractedFields };
      }

      const maybe = extractHexFromTextAroundMarkers(text);
      if (maybe) {
        this.expectedHash = maybe;
        this.expectedHashSource = 'ic-api';
      }

      const argMaybe = extractHexFromTextAroundMarkers(text, ['arg_hash']);
      if (argMaybe) {
        this.argHash = argMaybe;
      }

      let rendered = extractPayloadRendering(json) || extractPayloadRendering(text);
      if (!rendered) {
        rendered = await fetchPayloadEndpoint(id);
      }
      if (rendered && !this.payloadSnippetFromDashboard) {
        const normalized = this.#normalizeDashboardPayloadSnippet(rendered);
        this.payloadSnippetFromDashboard = normalized || rendered;
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

  #consumeJsonStringLiteral(source) {
    if (!source || source[0] !== '"') return null;
    let escaped = false;
    for (let i = 1; i < source.length; i += 1) {
      const ch = source[i];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        continue;
      }
      if (ch === '"') {
        return source.slice(0, i + 1);
      }
    }
    return null;
  }

  #consumeBalancedJson(source) {
    if (!source || source[0] !== '{') return null;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = 0; i < source.length; i += 1) {
      const ch = source[i];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (ch === '\\') {
          escaped = true;
        } else if (ch === '"') {
          inString = false;
        }
        continue;
      }
      if (ch === '"') {
        inString = true;
        continue;
      }
      if (ch === '{') {
        depth += 1;
      } else if (ch === '}') {
        depth -= 1;
        if (depth === 0) {
          return source.slice(0, i + 1);
        }
      }
    }
    return null;
  }

  #decodeJsonEscapes(text) {
    if (!text || typeof text !== 'string') return '';
    try {
      const escaped = text
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/\r/g, '\\r')
        .replace(/\n/g, '\\n')
        .replace(/\t/g, '\\t');
      return JSON.parse(`"${escaped}"`);
    } catch {
      return text;
    }
  }

  #prettifyJsonText(text) {
    if (typeof text !== 'string') return '';
    const trimmed = text.trim();
    if (!trimmed) return '';
    try {
      const parsed = JSON.parse(trimmed);
      return JSON.stringify(parsed, null, 2);
    } catch {
      return '';
    }
  }

  #normalizeDashboardPayloadSnippet(snippet) {
    if (!snippet || typeof snippet !== 'string') return '';
    let text = snippet.trim();
    if (!text) return '';

    const lower = text.toLowerCase();
    const keyCandidates = ['"payload_text_rendering"', '"payload"', 'payload_text_rendering', 'payload'];
    let keyIdx = -1;
    for (const k of keyCandidates) {
      const idx = lower.indexOf(k.toLowerCase());
      if (idx >= 0) {
        keyIdx = idx;
        break;
      }
    }
    if (keyIdx >= 0) {
      const fromKey = text.slice(keyIdx);
      const colonIdx = fromKey.indexOf(':');
      if (colonIdx >= 0) {
        text = fromKey.slice(colonIdx + 1).trim();
      }
    }

    if (text.startsWith('"')) {
      const literal = this.#consumeJsonStringLiteral(text);
      if (literal) {
        try {
          const decoded = JSON.parse(literal);
          const pretty = this.#prettifyJsonText(decoded);
          return (pretty || decoded || '').toString();
        } catch {
          const inner = literal.slice(1, -1);
          return this.#decodeJsonEscapes(inner).trim();
        }
      }
    }

    if (text.startsWith('{')) {
      const balanced = this.#consumeBalancedJson(text);
      if (balanced) {
        const pretty = this.#prettifyJsonText(balanced);
        if (pretty) return pretty;
        return this.#decodeJsonEscapes(balanced).trim();
      }
    }

    return this.#decodeJsonEscapes(text).trim();
  }

  #inferDashboardPayloadType(snippet) {
    if (!snippet || typeof snippet !== 'string') return '';
    const trimmed = snippet.trim();
    if (!trimmed) return '';
    if (CANDID_PATTERN.test(trimmed)) {
      return 'Candid';
    }
    if (/^[{\[]/.test(trimmed) || trimmed.includes('":')) {
      return 'JSON';
    }
    return 'Text';
  }

  async #handleFetchProposal(e) {
    e.preventDefault();
    if (this.isFetching) return;
    if (!this.identity) {
      alert('Login required to fetch (billed action).');
      return;
    }

    const idEl = document.getElementById('proposalId');
    const id = parseInt(idEl.value);

    const fetchFeeE8s = Number(this.fees?.fetchProposal_e8s ?? 0n);
    const fetchFee = fetchFeeE8s / 1e8;
    const formattedFetchFee = fetchFee.toFixed(fetchFee >= 1 ? 2 : 1);
    const requiredE8s = fetchFeeE8s + NETWORK_FEE_E8S;
    if (this.userBalance < requiredE8s) {
      const requiredIcp = (requiredE8s / 1e8).toFixed(4);
      alert(
        `Insufficient deposit balance. You need at least ${requiredIcp} ICP (including the 0.0001 ICP network fee) available before fetching a proposal.\n\nFund your deposit address first.`,
      );
      return;
    }
    const depositAddressMessage = this.depositAccountIdentifierHex
      ? `\n\nDeposit address:\n${this.depositAccountIdentifierHex}`
      : '';

    const confirmed = window.confirm(
      `Fetching this proposal will charge ${formattedFetchFee} ICP from your deposit balance (plus the 0.0001 ICP network fee). The fee is forwarded to account identifier ${BENEFICIARY_ACCOUNT_IDENTIFIER}. You must fund your deposit address first.${depositAddressMessage}\n\nDo you want to continue?`,
    );
    if (!confirmed) return;

    this.lastFetchCyclesBurned = null;
    this.fetchCyclesAverage = null;
    this.fetchCyclesCount = 0;
    this.#setFetching(true);
    this.docExpectation = 'unknown';

    try {
      const aug = await this.backend.getProposalAugmented(BigInt(id));
      if (aug.err) throw new Error(aug.err || 'Unknown error from backend');

      const unwrap = (opt) => opt?.[0] ?? null;
      const data = aug.ok;
      const base = data.base;

      const extractedUrls = base.extractedUrls || [];

      const billing = data.billingSnapshot;

      if (billing) {
        const remaining = Number(billing.remaining_balance_e8s ?? 0n);
        const credited = Number(billing.credited_total_e8s ?? 0n);
        this.userBalance = remaining;
        this.depositLedgerBalance = remaining;
        this.depositCreditedTotal = credited;
        this.depositAvailableToCredit = Math.max(0, remaining - credited);
      }

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
      this.docExpectation = base.docExpectation || 'unknown';

      if (!this.proposalData.url || !this.proposalData.url.trim()) {
        const inferredNnsUrl = buildNnsProposalUrl(this.proposalData.id);
        if (inferredNnsUrl) {
          this.proposalData.url = inferredNnsUrl;
        }
      }

      this.reportGenerationDate = new Date().toISOString().slice(0, 10);
      this.reportHeaderAutofill = {};
      // NEW: capture full raw ProposalInfo for export (.txt)
      this.fullProposalInfo = unwrap(data.fullProposalInfo);
      this.reportOverrides = {};
      this.reportNotes = '';
      this.checklistManualOverrides = {};

      this.#resolveHashesFromSources();

      // Pull a recommended arg verification command from the summary (if present)
      this.recommendedArgCmd = extractArgVerificationCommand(this.proposalData.summary);

      this.expectedHash =
        unwrap(data.expectedHashFromDashboard) || this.proposalData.extractedHash || null;
      this.expectedHashSource =
        unwrap(data.expectedHashSource) ||
        (this.proposalData.extractedHash ? 'proposal:summary' : null);

      this.argHash = unwrap(data.argHashFromDashboard) || this.argHash || null;

      const rawPayloadSnippet = unwrap(data.payloadSnippetFromDashboard);
      this.payloadSnippetRawFromDashboard = rawPayloadSnippet;
      const normalizedPayload = this.#normalizeDashboardPayloadSnippet(rawPayloadSnippet);
      this.payloadSnippetFromDashboard = normalizedPayload || rawPayloadSnippet || null;
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

      this.#resolveHashesFromSources();

      await this.#prefillFromIcApi(id);

      this.#resolveHashesFromSources();

      // Commit check: prefer browser request to avoid burning canister cycles
      this.commitStatus = '';
      const repo = this.proposalData.extractedRepo || 'dfinity/ic';
      const commit = this.proposalData.extractedCommit || '';

      if (!this.proposalData.commitUrl && commit && repo) {
        this.proposalData.commitUrl = `https://github.com/${repo}/commit/${commit}`;
      }
      if (commit) {
        const shortCommit = commit.substring(0, 12);
        const browserOk = await this.#checkCommitInBrowser(repo, commit);
        if (browserOk) {
          this.commitStatus = `✅ Commit exists on ${repo}@${shortCommit} (browser)`;
        } else if (typeof this.backend.checkGitCommit === 'function') {
          try {
            const commitResult = await this.backend.checkGitCommit(repo, commit);
            if (commitResult.ok) {
              this.commitStatus = `✅ Commit exists on ${repo}@${shortCommit} (canister)`;
            } else {
              this.commitStatus = `❌ ${commitResult.err || 'Commit not found'}`;
            }
          } catch (commitErr) {
            const message = commitErr?.message || 'Unable to verify commit via canister';
            this.commitStatus = `❌ ${message}`;
          }
        } else {
          this.commitStatus = '⚠️ Unable to verify commit (canister method unavailable)';
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
      this.typeChecklistItems = TYPE_CHECKLISTS.get(this.proposalData?.proposalType) || [];

      this.#updateChecklist();
    } catch (err) {
      alert(err?.message || String(err));
    }

    await this.#loadCycleStats();
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
        'Login required to use canister fetch. You can still use browser-only fallback for CORS-safe text URLs.',
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
        // stay in sync with canister-side balance state
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

  #formatCyclesDisplay(value) {
    if (value === null || value === undefined) return 'N/A';
    try {
      const big =
        typeof value === 'bigint'
          ? value
          : typeof value === 'number'
          ? BigInt(Math.round(value))
          : BigInt(String(value));
      const formatted = big
        .toString()
        .replace(/\B(?=(\d{3})+(?!\d))/g, ',');
      let approx = '';
      const maxSafe = BigInt(Number.MAX_SAFE_INTEGER);
      if (big >= 1_000_000_000_000n && big <= maxSafe) {
        const trillions = Number(big) / 1e12;
        const digits = trillions >= 10 ? 1 : 3;
        approx = ` (~${trillions.toFixed(digits)} T cycles)`;
      }
      return `${formatted}${approx}`;
    } catch (err) {
      return typeof value === 'string' ? value : String(value);
    }
  }

  #formatDocExpectationLabel() {
    switch (this.docExpectation) {
      case 'expected':
        return 'Documents required for verification (hash match recommended).';
      case 'optional':
        return 'Documents may be provided but are not strictly required.';
      case 'not_applicable':
        return 'No supporting documents expected for this proposal (e.g., removal/deregistration).';
      default:
        return 'Document expectation unknown.';
    }
  }

  // --- rendering helpers ---

  #renderLinks() {
    const p = this.proposalData;
    if (!p) return null;

    const set = new Set();
    const push = (u) => {
      if (u && !set.has(u)) set.add(u);
    };

    const nnsUrl = (typeof p.url === 'string' ? p.url.trim() : '') || buildNnsProposalUrl(p.id);
    push(nnsUrl);
    push(this.dashboardUrl);
    push(p.extractedDocUrl);
    push(p.commitUrl);
    (p.extractedUrls || []).forEach(push);

    const links = [...set.values()];
    if (!links.length) return html`<p>(no links found)</p>`;

    return html`
      <ul class="links">
        ${links.map(
          (u) =>
            html`<li><a href="${u}" target="_blank" rel="noreferrer noopener">${u}</a></li>`,
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
            (u) =>
              html`<li><a href="${u}" target="_blank" rel="noreferrer noopener">${u}</a></li>`,
          )}
        </ul>
        <p><b>Shell commands (download & hash locally):</b></p>
        <pre>${cmds.map((x) => `# ${x.url}\n${x.cmd}`).join('\n\n')}</pre>
        <button
          @click=${(e) => this.#handleCopy(e, cmds.map((x) => x.cmd).join('\n\n'), 'Copy Commands')}
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
              <code>sha256sum</code> (Linux) or <code>shasum -a 256</code> (macOS). Compare to
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

  #recommendedEncodeCommand() {
    const raw = (this.recommendedArgCmd || '').trim();
    if (!raw) return null;
    const lines = raw.split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (/^didc\s+encode/i.test(trimmed)) {
        const pipeIdx = trimmed.indexOf('|');
        return pipeIdx >= 0 ? trimmed.slice(0, pipeIdx).trim() : trimmed;
      }
    }
    return null;
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
      (document.getElementById('expectedArgHash')?.value || '').trim() || this.argHash || '';

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
            throw new Error('Paste hex bytes (from `didc encode` or the auto-encode buttons).');
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
            'Candid text must be encoded to bytes (e.g., with `didc encode`) before hashing. Use the quick buttons below or the command builder.';
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
      this.hashMatch = this.#normalizeHex(computedHash) === this.#normalizeHex(inputExpected);
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
    const encodeLine =
      this.#recommendedEncodeCommand() ||
      "didc encode -d path/to/service.did -t '(candid-type)' \"$UPGRADE_ARG\"";
    const macVerifyFromEncode = `${encodeLine} | xxd -r -p | shasum -a 256 | awk '{print $1}'`;
    const linuxVerifyFromEncode = `${encodeLine} | xxd -r -p | sha256sum | awk '{print $1}'`;
    const repoUrl = (p?.extractedRepo || '').trim();
    const commitHash = (p?.extractedCommit || '').trim();
    const defaultRepoUrl = repoUrl || 'https://github.com/<org>/<repo>';
    const cloneCommand =
      defaultRepoUrl.startsWith('http') || defaultRepoUrl.startsWith('git@')
        ? `git clone ${defaultRepoUrl}`
        : `git clone https://github.com/${defaultRepoUrl.replace(/^\/?/, '')}`;
    const repoDirName = (() => {
      const source = defaultRepoUrl;
      if (source.startsWith('git@')) {
        const afterColon = source.split(':')[1] || '';
        const candidate = afterColon.split('/').pop() || '';
        const sanitized = candidate.replace(/\.git$/i, '');
        return sanitized || '<repo-directory>';
      }
      try {
        const url = new URL(source);
        const segments = url.pathname.split('/').filter(Boolean);
        if (segments.length) {
          const candidate = segments[segments.length - 1].replace(/\.git$/i, '');
          return candidate || '<repo-directory>';
        }
      } catch (err) {
        const parts = source.split('/').filter(Boolean);
        if (parts.length) {
          const candidate = parts[parts.length - 1].replace(/\.git$/i, '');
          if (!candidate.includes('<') && candidate !== 'github.com') {
            return candidate;
          }
        }
      }
      return '<repo-directory>';
    })();
    const checkoutCommand = commitHash ? `git checkout ${commitHash}` : 'git checkout <commit-hash>';
    const checkoutSnippet = `${cloneCommand}\ncd ${repoDirName}\n${checkoutCommand}`;
    const expectedArgHash = this.argHash || p?.proposal_arg_hash || 'the expected arg hash';

    return html`
      <section>
        <h2>Verify Arg Hash (Binary)</h2>
        ${this.#renderArgShortcuts()}

        <details>
          <summary>How to choose an input</summary>
          <p>
            Follow these core steps whenever you verify an <code>arg_hash</code> from a proposal:
          </p>
          <ol class="steps-list">
            <li>
              <strong>Locate the expected hash.</strong> Use the fetch button above or run the manual
              on-chain check below to copy the <code>arg_hash</code> (32-byte SHA-256 digest).
            </li>
            <li>
              <strong>Recreate the exact argument bytes.</strong> Start from the proposal summary,
              forum post, or linked repository, then use the input helpers here to construct the
              <em>binary</em> argument exactly as it was sent on-chain.
            </li>
            <li>
              <strong>Hash the bytes.</strong> Either press <b>Verify Arg Hash</b> here or run the
              shell commands provided to double-check locally. The computed digest must match the
              expected hash.
            </li>
          </ol>
          <p>
            Need broader context? The <a
              href="https://internetcomputer.org/docs/building-apps/governing-apps/nns/concepts/proposals/verify-proposals/"
              target="_blank"
              rel="noreferrer noopener"
              >proposal verification guide</a
            > explains how these steps fit into end-to-end NNS reviews.
          </p>

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
              rel="noreferrer noopener"
            >Install didc</a
            >
          </div>

          <p style="margin-top:6px;">
            <b>Important:</b> <code>didc encode</code> outputs <i>hex text</i>. To verify the
            on-chain <code>arg_hash</code>, hash the <b>bytes</b> by converting that hex back to
            bytes (<code>xxd -r -p</code>) before hashing.
          </p>
        </details>

        <details>
          <summary>Step-by-step: encode args with didc (macOS/Linux)</summary>
          <ol class="steps-list">
            <li>
              <strong>Prepare your tools (one-time).</strong>
              <ul>
                <li>
                  <b>Git:</b> macOS <code>xcode-select --install</code>; Linux
                  <code>sudo apt update && sudo apt install git</code>.
                </li>
                <li>
                  <b>didc:</b> install Rust with
                  <code>curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh</code>, then
                  <code>cargo install --git https://github.com/dfinity/candid didc</code>. Verify with
                  <code>didc --version</code>.
                </li>
                <li>
                  <b>Hex/hash helpers:</b> macOS provides <code>shasum -a 256</code>; Linux can use
                  <code>sha256sum</code> and install <code>xxd</code> via <code>sudo apt install vim-common</code>
                  if missing.
                </li>
              </ul>
            </li>
            <li>
              <strong>Check out the proposal sources.</strong>
              <ul>
                <li><b>Repository:</b> <code>${defaultRepoUrl}</code></li>
                <li><b>Commit:</b> <code>${commitHash || '<commit-hash>'}</code></li>
              </ul>
              <p>Run:</p>
              <pre class="cmd-pre">${checkoutSnippet}</pre>
            </li>
            <li>
              <strong>Encode the Candid args to hex bytes.</strong>
              <p>
                Copy the Candid text from the proposal summary or repo into a shell variable (single quotes
                keep multi-line values intact):
              </p>
              <pre class="cmd-pre">UPGRADE_ARG='(paste Candid text here)'</pre>
              <p>Then encode it with <code>didc</code> (drop any hashing pipes from summary commands):</p>
              <pre class="cmd-pre">${encodeLine}</pre>
              <p>The command prints the raw hex bytes—paste that output into the <b>Hex Bytes</b> box below.</p>
            </li>
            <li>
              <strong>Verify in the app.</strong> Select <b>Hex Bytes</b>, paste the hex, and press
              <b>Verify Arg Hash</b>. The computed digest must equal the expected value shown here.
            </li>
            <li>
              <strong>Optional: confirm the digest locally.</strong>
              <pre class="cmd-pre"># macOS
${macVerifyFromEncode}

# Linux
${linuxVerifyFromEncode}</pre>
              <p>The output should match <code>${expectedArgHash}</code>.</p>
            </li>
          </ol>
          <p style="margin-top:8px;">
            <b>Windows tip:</b> Use Git Bash or WSL so that <code>didc</code>, <code>xxd</code>, and
            <code>sha256sum</code>/<code>shasum</code> are available.
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

        ${this.#renderArgTypeHelp()}

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

  #renderArgTypeHelp() {
    const common = html`<p>
      Switch the selector above to match the format of the data you currently have. The helpers
      above explain what to paste for each option and how to get to the canonical bytes that the NNS
      hashed on-chain.
    </p>`;

    const specific = (() => {
      switch (this.argInputType) {
        case 'hex':
          return html`
            <p>
              Paste a contiguous hex string (no <code>0x</code> prefixes). This should usually be the
              output of <code>didc encode</code> or a build script. If you copied hex that still has
              spaces or newlines, we strip them automatically.
            </p>
            <ul>
              <li>
                If you ran <code>didc encode '(...)'</code>, paste the output here <em>without</em>
                piping through <code>xxd -r -p</code>—we convert the hex back to bytes for you.
              </li>
              <li>
                Detected "hex of hex" is auto-corrected and we surface a hint so you know what was
                changed.
              </li>
            </ul>
          `;
        case 'vec':
          return html`
            <p>
              Provide a Candid <code>vec nat8</code> literal such as <code>vec {1; 2; 0xFF}</code>.
              We parse each entry, respecting decimal or hex notation, and then hash the resulting
              bytes.
            </p>
            <ul>
              <li>Keep the surrounding <code>vec { ... }</code> syntax.</li>
              <li>Separate values with semicolons exactly as shown in proposal payloads.</li>
            </ul>
          `;
        case 'blob':
          return html`
            <p>
              Paste a Candid <code>blob "..."</code> literal. Escape bytes using
              <code>\xx</code> sequences (for example <code>\ef</code>) exactly as generated by
              the tooling that produced the proposal.
            </p>
            <ul>
              <li>
                Leave the opening and closing quotes intact—removing them changes the parsed bytes.
              </li>
            </ul>
          `;
        case 'candid':
          return html`
            <p>
              Enter human-readable Candid here only when you need help generating the binary args.
              Use <code>didc encode</code> (see the command builder above) or the quick helper
              buttons to turn this text into hex, then switch back to <b>Hex Bytes</b> to verify.
            </p>
            <ul>
              <li>
                We intentionally do not hash Candid text directly—hashing must always operate on the
                encoded bytes.
              </li>
              <li>
                After encoding, paste the produced hex under the Hex Bytes option to continue.
              </li>
            </ul>
          `;
        case 'text':
          return html`
            <p>
              Use this mode only when the proposal explicitly states that the argument was raw text
              or JSON. The text is UTF-8 encoded and then hashed.
            </p>
            <ul>
              <li>
                If you expected Candid arguments, switch to the appropriate mode above—Candid text
                should not be hashed directly.
              </li>
            </ul>
          `;
        default:
          return html``;
      }
    })();

    return html`<div class="arg-help">${common}${specific}</div>`;
  }

  #renderTypeChecklist() {
    const items =
      this.typeChecklists.get(this.proposalData?.proposalType) || [
        { label: 'Fetch', key: 'fetch', checked: this.checklist.fetch },
        { label: 'Commit Check', key: 'commit', checked: this.checklist.commit },
        { label: 'Arg Hash', key: 'argsHash', checked: this.checklist.argsHash },
        { label: 'Doc / File Hash', key: 'docHash', checked: this.checklist.docHash },
        { label: 'Expected Hash from Sources', key: 'expected', checked: this.checklist.expected },
        { label: 'Rebuild & Compare', key: 'rebuild', checked: this.checklist.rebuild },
      ];
    return html`
      <ul>
        ${items.map(
          (item) => {
            const display =
              item.key === 'docHash' && this.docExpectation === 'not_applicable'
                ? 'N/A'
                : item.checked
                ? '✅'
                : '❌';
            return html`<li>${item.label}: ${display}</li>`;
          },
        )}
      </ul>
      <div style="margin-top:8px;">
        <button
          class="btn secondary"
          @click=${() => {
            this.#setChecklistOverride('rebuild', true);
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
          { label: 'Fetch Proposal', key: 'fetch', checked: this.checklist.fetch },
          { label: 'Commit Check', key: 'commit', checked: this.checklist.commit },
          { label: 'Expected WASM Hash Present', key: 'expected', checked: this.checklist.expected },
          { label: 'Arg Hash Verified', key: 'argsHash', checked: this.checklist.argsHash },
          { label: 'WASM Rebuilt & Hash Matched', key: 'rebuild', checked: this.checklist.rebuild },
        ];
        break;
      case 'IcOsVersionDeployment':
        items = [
          { label: 'Fetch Proposal', key: 'fetch', checked: this.checklist.fetch },
          { label: 'Expected Release Hash Present', key: 'expected', checked: this.checklist.expected },
          { label: 'Commit Check (if provided)', key: 'commit', checked: this.checklist.commit },
          { label: 'Release Package Hash Verified', key: 'docHash', checked: this.checklist.docHash },
        ];
        break;
      case 'ParticipantManagement':
        items = [
          { label: 'Fetch Proposal', key: 'fetch', checked: this.checklist.fetch },
          { label: 'All PDFs Hash-Matched', key: 'docHash', checked: this.checklist.docHash },
          { label: 'Forum/Wiki Context Checked', key: 'manual', checked: this.checklist.manual },
        ];
        break;
      case 'Governance':
        items = [
          { label: 'Fetch Proposal', key: 'fetch', checked: this.checklist.fetch },
          { label: 'Manual Policy Review', key: 'manual', checked: this.checklist.manual },
        ];
        break;
      default:
        items = [
          { label: 'Fetch Proposal', key: 'fetch', checked: this.checklist.fetch },
          { label: 'Manual Review', key: 'manual', checked: this.checklist.manual },
        ];
    }
    this.typeChecklists.set(type, items);
  }

  // ----------------- NEW: Export helpers -----------------

  #nat8ArrayToUint8Array(value) {
    if (!value) return null;
    if (value instanceof Uint8Array) return value;
    if (Array.isArray(value)) return Uint8Array.from(value);
    if (value.buffer instanceof ArrayBuffer) return new Uint8Array(value.buffer);
    return null;
  }

  #principalToText(value) {
    if (!value) return '';
    try {
      if (typeof value === 'string') return value;
      if (value instanceof Uint8Array) {
        return Principal.fromUint8Array(value).toText();
      }
      if (Array.isArray(value)) {
        return Principal.fromUint8Array(Uint8Array.from(value)).toText();
      }
      if (typeof value.toText === 'function') {
        return value.toText();
      }
    } catch (e) {
      console.warn('Unable to decode principal', e?.message || e);
    }
    return '';
  }

  #getActionVariantName(fullInfo) {
    if (!fullInfo) return '';
    try {
      const proposal = fullInfo.proposal?.[0];
      if (!proposal) return '';
      const action = proposal.action?.[0];
      if (!action) return '';
      const [entry] = Object.entries(action);
      return entry ? entry[0] : '';
    } catch {
      return '';
    }
  }

  #extractInstallCodeAction(fullInfo) {
    if (!fullInfo) return null;
    try {
      const proposal = fullInfo.proposal?.[0];
      if (!proposal) return null;
      const action = proposal.action?.[0];
      if (!action) return null;
      if (action.InstallCode) return action.InstallCode;
    } catch {
      // ignore
    }
    return null;
  }

  #extractInstallCodeHashes(fullInfo) {
    const install = this.#extractInstallCodeAction(fullInfo);
    const toHex = (value) => {
      if (!value) return '';
      const bytes = this.#nat8ArrayToUint8Array(value);
      return bytes ? bytesToHex(bytes) : '';
    };
    if (!install) {
      return { wasm: '', arg: '' };
    }
    const wasm = toHex(install.wasm_module_hash?.[0]);
    const arg = toHex(install.arg_hash?.[0]);
    return { wasm, arg };
  }

  #resolveHashesFromSources() {
    if (!this.proposalData) return;

    const { wasm: installWasm, arg: installArg } = this.#extractInstallCodeHashes(
      this.fullProposalInfo,
    );

    const normalize = (value) => {
      if (!value) return '';
      const str = String(value).trim();
      return looksLikeHexString(str) ? str.toLowerCase() : str;
    };
    const restore = (value) => {
      if (!value) return '';
      return String(value).trim();
    };

    const candidateList = (...values) => values.map(restore).filter((v) => v && v.length);

    const eq = (a, b) => normalize(a) === normalize(b);

    const wasmCandidates = candidateList(
      installWasm,
      this.proposalData.proposal_wasm_hash,
      this.reportHeaderAutofill?.wasmHash,
      this.expectedHash,
    );
    const onchainArgCandidates = candidateList(installArg, this.proposalData.proposal_arg_hash);
    const dashboardArgCandidates = candidateList(
      this.reportHeaderAutofill?.argumentValue,
      this.argHash,
    );

    let wasm = wasmCandidates.find((v) => v.length) || '';

    if (
      installWasm &&
      installArg &&
      eq(this.proposalData.proposal_wasm_hash, installArg) &&
      eq(this.proposalData.proposal_arg_hash, installWasm)
    ) {
      wasm = restore(installWasm);
    }

    if (installWasm && !eq(wasm, installWasm)) {
      const installCandidate = restore(installWasm);
      if (installCandidate) wasm = installCandidate;
    }

    const onchainArg = onchainArgCandidates.length ? onchainArgCandidates[0] : null;
    const normalizedOnchainArg = onchainArg && onchainArg.length ? onchainArg : null;
    this.proposalData.proposal_arg_hash = normalizedOnchainArg || null;

    const preferredArgCandidates = [
      ...dashboardArgCandidates,
      ...(normalizedOnchainArg ? [normalizedOnchainArg] : []),
    ];

    const arg = preferredArgCandidates.find((v) => v && !eq(v, wasm)) || preferredArgCandidates[0] || null;

    if (wasm) {
      this.proposalData.proposal_wasm_hash = wasm;
      if (!this.expectedHash || eq(this.expectedHash, this.proposalData.proposal_arg_hash)) {
        this.expectedHash = wasm;
      }
    }

    this.argHash = arg || null;
  }

  #computeReportHeaderDefaults() {
    const p = this.proposalData;
    if (!p) return null;

    const existingNnsUrl = typeof p.url === 'string' ? p.url.trim() : '';
    const derivedNnsUrl = buildNnsProposalUrl(p.id);

    const defaults = {
      proposalId: p.id != null ? String(p.id) : '',
      proposalTitle: p.title || '',
      proposalCategory: p.proposalType && p.proposalType !== 'Unknown' ? p.proposalType : '',
      proposalAction: '',
      targetCanisterId: '',
      targetCanisterName: '',
      controllers: '',
      subnetId: '',
      sourceRepository: p.extractedRepo || '',
      sourceCommit: p.extractedCommit || '',
      sourceCommitUrl: p.commitUrl || '',
      wasmHash: p.proposal_wasm_hash || '',
      argumentType: '',
      argumentValue: p.proposal_arg_hash || '',
      proposer: '',
      verificationDate: '',
      verifiedBy: '',
      generatedBy: this.userPrincipal || '',
      linkNns: existingNnsUrl || derivedNnsUrl || '',
      linkDashboard: this.dashboardUrl || '',
    };

    if (this.reportGenerationDate) {
      defaults.verificationDate = this.reportGenerationDate;
    }

    const auto = this.reportHeaderAutofill || {};
    const applyAuto = (key, transform) => {
      const value = auto[key];
      if (value === null || value === undefined) return;
      const str = typeof value === 'string' ? value.trim() : value;
      if (!defaults[key] && String(str).trim().length) {
        defaults[key] = transform ? transform(str) : str;
      }
    };

    const actionName = this.#getActionVariantName(this.fullProposalInfo);
    if (actionName) {
      defaults.proposalAction = actionName;
    }

    applyAuto('proposalCategory');
    applyAuto('proposalAction');

    const { wasm: installWasm, arg: installArg } = this.#extractInstallCodeHashes(
      this.fullProposalInfo,
    );

    const installCode = this.#extractInstallCodeAction(this.fullProposalInfo);
    if (installCode) {
      const canisterPrincipal = installCode.canister_id?.[0];
      const canisterText = this.#principalToText(canisterPrincipal);
      if (canisterText) defaults.targetCanisterId = canisterText;
    }

    if (installWasm) {
      defaults.wasmHash = installWasm;
    } else if (!defaults.wasmHash && this.reportHeaderAutofill?.wasmHash) {
      defaults.wasmHash = this.reportHeaderAutofill.wasmHash;
    } else if (!defaults.wasmHash && this.expectedHash) {
      defaults.wasmHash = this.expectedHash;
    }

    if (installArg) {
      defaults.argumentValue = installArg;
    } else if (!defaults.argumentValue && this.reportHeaderAutofill?.argumentValue) {
      defaults.argumentValue = this.reportHeaderAutofill.argumentValue;
    } else if (!defaults.argumentValue && this.argHash) {
      defaults.argumentValue = this.argHash;
    }

    applyAuto('targetCanisterId');
    applyAuto('targetCanisterName');
    applyAuto('controllers');
    applyAuto('subnetId');
    applyAuto('sourceRepository');
    applyAuto('sourceCommit');
    if (!installWasm) applyAuto('wasmHash');
    if (!installArg) applyAuto('argumentValue');

    const payloadForReport =
      typeof this.payloadSnippetFromDashboard === 'string'
        ? this.payloadSnippetFromDashboard.trim()
        : '';
    if (payloadForReport) {
      defaults.argumentValue = payloadForReport;
      const inferredType = this.#inferDashboardPayloadType(payloadForReport);
      if (inferredType) {
        defaults.argumentType = inferredType;
      } else if (!defaults.argumentType) {
        defaults.argumentType = 'Text';
      }
    }
    applyAuto('proposer');

    if (isLikelyBareIdentifier(defaults.proposer)) {
      const detailedProposer = extractProposerFromSummary(p.summary);
      if (detailedProposer) {
        defaults.proposer = detailedProposer;
      }
    }

    if (!defaults.argumentType) {
      if (this.extractedArgText) {
        defaults.argumentType = 'Candid';
      } else if (this.argInputType === 'candid') {
        defaults.argumentType = 'Candid';
      } else if (defaults.argumentValue) {
        defaults.argumentType = 'Hex';
      }
    }

    applyAuto('argumentType');

    if (!defaults.proposalCategory && p.proposalType) {
      defaults.proposalCategory = p.proposalType;
    }

    return defaults;
  }

  #applyReportOverrides(defaults = {}) {
    const final = {};
    for (const key of REPORT_HEADER_KEYS) {
      const base = defaults?.[key] ?? '';
      const overrideRaw = this.reportOverrides?.[key];
      const override = typeof overrideRaw === 'string' ? overrideRaw.trim() : '';
      final[key] = override.length ? override : typeof base === 'string' ? base : '';
    }
    final.sourceCommitUrl = defaults?.sourceCommitUrl || '';
    return final;
  }

  #formatReportHeaderMarkdown(final, defaults = {}, notes = '') {
    if (!final) return '';
    const valueOrNA = (value) => {
      if (value === null || value === undefined) return 'N/A';
      const str = String(value).trim();
      return str.length ? str : 'N/A';
    };

    const idValue = valueOrNA(final.proposalId);
    const idDisplay = idValue === 'N/A' ? 'N/A' : `#${idValue}`;
    const title = valueOrNA(final.proposalTitle);
    const category = valueOrNA(final.proposalCategory);
    const action = valueOrNA(final.proposalAction);
    const targetId = valueOrNA(final.targetCanisterId);
    const targetName = valueOrNA(final.targetCanisterName);
    const controllers = valueOrNA(final.controllers);
    const subnet = valueOrNA(final.subnetId);
    const repo = valueOrNA(final.sourceRepository);
    const commitValue = valueOrNA(final.sourceCommit);
    const wasmHash = valueOrNA(final.wasmHash);
    const argType = valueOrNA(final.argumentType);
    const argValue = valueOrNA(final.argumentValue);
    const proposer = valueOrNA(final.proposer);
    const verificationDate = valueOrNA(final.verificationDate);
    const verifiedBy = valueOrNA(final.verifiedBy);

    let commitDisplay = commitValue;
    const commitUrl = defaults?.sourceCommitUrl;
    if (commitValue !== 'N/A' && commitUrl) {
      commitDisplay = `[${commitValue}](${commitUrl})`;
    }

    const generatedBy = valueOrNA(final.generatedBy);

    const linkNns = final.linkNns && final.linkNns.trim().length
      ? `[NNS dapp view](${final.linkNns.trim()})`
      : '[NNS dapp view]';
    const linkDashboard = final.linkDashboard && final.linkDashboard.trim().length
      ? `[ICP Dashboard record](${final.linkDashboard.trim()})`
      : '[ICP Dashboard record]';

    const typeSegments = ['Governance'];
    if (category !== 'N/A') typeSegments.push(category);
    if (action !== 'N/A') typeSegments.push(action);
    const typeDisplay = typeSegments.join(' → ');

    let targetDisplay = 'N/A';
    if (targetId !== 'N/A' && targetName !== 'N/A') {
      targetDisplay = `${targetId} - ${targetName}`;
    } else if (targetId !== 'N/A') {
      targetDisplay = targetId;
    } else if (targetName !== 'N/A') {
      targetDisplay = targetName;
    }

    const sections = [
      `**Proposal Verification Report - ${idDisplay} (${title})**`,
      `**Proposal Type:** ${typeDisplay}`,
      `**Target Canister:** ${targetDisplay}`,
      `**Controllers:** ${controllers}`,
      `**Subnet ID:** ${subnet}`,
      `**Source Repository:** ${repo}`,
      `**Source Commit:** ${commitDisplay}`,
      `**Proposed Wasm (gz) SHA-256:** ${wasmHash}`,
    ];

    if (argValue !== 'N/A') {
      if (/\n/.test(argValue)) {
        const heading = argType !== 'N/A' ? `**Argument Payload:** (${argType})` : '**Argument Payload:**';
        const lowerType = argType.toLowerCase();
        const fence = lowerType.includes('json') ? '```json' : '```';
        sections.push([heading, fence, argValue.trimEnd(), '```'].join('\n'));
      } else {
        const prefix = argType !== 'N/A' ? `(${argType}) ` : '';
        sections.push(`**Argument Payload:** ${prefix}${argValue}`);
      }
    } else if (argType !== 'N/A') {
      sections.push(`**Argument Payload:** (${argType})`);
    } else {
      sections.push('**Argument Payload:** N/A');
    }

    sections.push(
      `**Proposer:** ${proposer}`,
      `**Verification Date:** ${verificationDate}`,
      `**Verified by:** ${verifiedBy}`,
      `**Generated by:** ${generatedBy}`,
      `**Links:** ${linkNns} • ${linkDashboard}`,
    );

    const notesTrimmed = typeof notes === 'string' ? notes.trim() : '';
    if (notesTrimmed) {
      const noteLines = notesTrimmed.split(/\r?\n/);
      const noteBlock = [
        '**Reviewer Notes:**',
        ...noteLines.map((line) => {
          const content = line.trim();
          return content ? `> ${content}` : '>';
        }),
      ].join('\n');
      sections.push(noteBlock);
    }

    return sections.join('\n\n');
  }

  #formatReportHeaderPlainText(final, defaults = {}, notes = '') {
    if (!final) return '';
    const valueOrNA = (value) => {
      if (value === null || value === undefined) return 'N/A';
      const str = String(value).trim();
      return str.length ? str : 'N/A';
    };

    const idValue = valueOrNA(final.proposalId);
    const idDisplay = idValue === 'N/A' ? 'N/A' : `#${idValue}`;
    const title = valueOrNA(final.proposalTitle);
    const category = valueOrNA(final.proposalCategory);
    const action = valueOrNA(final.proposalAction);
    const targetId = valueOrNA(final.targetCanisterId);
    const targetName = valueOrNA(final.targetCanisterName);
    const controllers = valueOrNA(final.controllers);
    const subnet = valueOrNA(final.subnetId);
    const repo = valueOrNA(final.sourceRepository);
    const commitValue = valueOrNA(final.sourceCommit);
    const wasmHash = valueOrNA(final.wasmHash);
    const argType = valueOrNA(final.argumentType);
    const argValue = valueOrNA(final.argumentValue);
    const proposer = valueOrNA(final.proposer);
    const verificationDate = valueOrNA(final.verificationDate);
    const verifiedBy = valueOrNA(final.verifiedBy);
    const generatedBy = valueOrNA(final.generatedBy);
    const linkNnsValue = valueOrNA(final.linkNns);
    const linkDashboardValue = valueOrNA(final.linkDashboard);

    let commitDisplay = commitValue;
    const commitUrl = defaults?.sourceCommitUrl;
    if (commitValue !== 'N/A' && commitUrl) {
      commitDisplay = `${commitValue} (${commitUrl})`;
    }

    const typeSegments = ['Governance'];
    if (category !== 'N/A') typeSegments.push(category);
    if (action !== 'N/A') typeSegments.push(action);
    const typeDisplay = typeSegments.join(' → ');

    let targetDisplay = 'N/A';
    if (targetId !== 'N/A' && targetName !== 'N/A') {
      targetDisplay = `${targetId} - ${targetName}`;
    } else if (targetId !== 'N/A') {
      targetDisplay = targetId;
    } else if (targetName !== 'N/A') {
      targetDisplay = targetName;
    }

    const sections = [
      `Proposal Verification Report - ${idDisplay} (${title})`,
      `Proposal Type: ${typeDisplay}`,
      `Target Canister: ${targetDisplay}`,
      `Controllers: ${controllers}`,
      `Subnet ID: ${subnet}`,
      `Source Repository: ${repo}`,
      `Source Commit: ${commitDisplay}`,
      `Proposed Wasm (gz) SHA-256: ${wasmHash}`,
    ];

    if (argValue !== 'N/A') {
      if (/\n/.test(argValue)) {
        const heading = argType !== 'N/A' ? `Argument Payload (${argType}):` : 'Argument Payload:';
        const payloadLines = argValue
          .trimEnd()
          .split(/\r?\n/)
          .map((line) => `  ${line}`);
        sections.push([heading, ...payloadLines].join('\n'));
      } else {
        const prefix = argType !== 'N/A' ? ` (${argType})` : '';
        sections.push(`Argument Payload${prefix}: ${argValue}`);
      }
    } else if (argType !== 'N/A') {
      sections.push(`Argument Payload (${argType}): N/A`);
    } else {
      sections.push('Argument Payload: N/A');
    }

    sections.push(
      `Proposer: ${proposer}`,
      `Verification Date: ${verificationDate}`,
      `Verified by: ${verifiedBy}`,
      `Generated by: ${generatedBy}`,
      `Links: NNS dapp view - ${linkNnsValue}; ICP Dashboard record - ${linkDashboardValue}`,
    );

    const notesTrimmed = typeof notes === 'string' ? notes.trim() : '';
    if (notesTrimmed) {
      const noteLines = notesTrimmed.split(/\r?\n/).map((line) => `  ${line.trim()}` || '');
      sections.push(['Reviewer Notes:', ...noteLines].join('\n'));
    }

    return sections.join('\n\n');
  }

  #buildReportHeaderDisplay(final, defaults = {}, notes = '') {
    if (!final) return null;

    const valueOrNA = (value) => {
      if (value === null || value === undefined) return 'N/A';
      const str = String(value).trim();
      return str.length ? str : 'N/A';
    };

    const idValue = valueOrNA(final.proposalId);
    const idDisplay = idValue === 'N/A' ? 'N/A' : `#${idValue}`;
    const title = valueOrNA(final.proposalTitle);
    const category = valueOrNA(final.proposalCategory);
    const action = valueOrNA(final.proposalAction);
    const targetId = valueOrNA(final.targetCanisterId);
    const targetName = valueOrNA(final.targetCanisterName);
    const controllers = valueOrNA(final.controllers);
    const subnet = valueOrNA(final.subnetId);
    const repo = valueOrNA(final.sourceRepository);
    const commitValue = valueOrNA(final.sourceCommit);
    const wasmHash = valueOrNA(final.wasmHash);
    const argType = valueOrNA(final.argumentType);
    const argValue = valueOrNA(final.argumentValue);
    const proposer = valueOrNA(final.proposer);
    const verificationDate = valueOrNA(final.verificationDate);
    const verifiedBy = valueOrNA(final.verifiedBy);
    const generatedBy = valueOrNA(final.generatedBy);
    const linkNnsValue = valueOrNA(final.linkNns);
    const linkDashboardValue = valueOrNA(final.linkDashboard);

    const commitUrl = defaults?.sourceCommitUrl;
    const commitDisplay = commitValue;

    const typeSegments = ['Governance'];
    if (category !== 'N/A') typeSegments.push(category);
    if (action !== 'N/A') typeSegments.push(action);
    const typeDisplay = typeSegments.join(' → ');

    let targetDisplay = 'N/A';
    if (targetId !== 'N/A' && targetName !== 'N/A') {
      targetDisplay = `${targetId} - ${targetName}`;
    } else if (targetId !== 'N/A') {
      targetDisplay = targetId;
    } else if (targetName !== 'N/A') {
      targetDisplay = targetName;
    }

    const metadata = [
      { label: 'Proposal Type', value: typeDisplay },
      { label: 'Target Canister', value: targetDisplay },
      { label: 'Controllers', value: controllers },
      { label: 'Subnet ID', value: subnet },
      { label: 'Source Repository', value: repo },
      {
        label: 'Source Commit',
        value: commitDisplay,
        link: commitUrl && commitValue !== 'N/A' ? commitUrl : undefined,
      },
      { label: 'Proposed Wasm (gz) SHA-256', value: wasmHash },
    ];

    const argument = {
      label: 'Argument Payload',
      type: argType !== 'N/A' ? argType : '',
      value: argValue,
    };

    const summary = {
      proposer,
      verificationDate,
      verifiedBy,
      generatedBy,
      links: {
        nns: linkNnsValue,
        dashboard: linkDashboardValue,
      },
    };

    const notesTrimmed = typeof notes === 'string' ? notes.trim() : '';
    const notesLines = notesTrimmed
      ? notesTrimmed
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter((line) => line.length)
      : [];

    return {
      title: `Proposal Verification Report - ${idDisplay} (${title})`,
      metadata,
      argument,
      summary,
      notes: notesLines,
    };
  }

  #updateReportOverride(key, value) {
    const next = { ...this.reportOverrides };
    if (typeof value === 'string' && value.length) {
      next[key] = value;
    } else {
      delete next[key];
    }
    this.reportOverrides = next;
    this.#render();
  }

  #updateReportNotes(value) {
    this.reportNotes = typeof value === 'string' ? value : '';
    this.#render();
  }

  #getExportData() {
    const p = this.proposalData;
    if (!p) return null;
    const headerDefaults = this.#computeReportHeaderDefaults() || {};
    const headerFinal = this.#applyReportOverrides(headerDefaults);
    return {
      id: p.id,
      type: p.proposalType,
      title: p.title,
      summary: p.summary,
      url:
        (typeof p.url === 'string' && p.url.trim()) || buildNnsProposalUrl(p.id) || '',
      extractedRepo: p.extractedRepo,
      extractedCommit: p.extractedCommit,
      commitUrl: p.commitUrl,
      extractedUrls: p.extractedUrls,
      extractedDocs: p.extractedDocs,
      docExpectation: this.docExpectation,
      docExpectationLabel: this.#formatDocExpectationLabel(),
      onchainWasmHash: p.proposal_wasm_hash,
      onchainArgHash: p.proposal_arg_hash,
      expectedHash: this.expectedHash,
      expectedHashSource: this.expectedHashSource,
      argHashFromDashboard: this.argHash,
      payloadSnippet: this.payloadSnippetFromDashboard,
      payloadSnippetRaw: this.payloadSnippetRawFromDashboard,
      dashboardUrl: this.dashboardUrl,
      extractedArgText: this.extractedArgText,
      verificationSteps: this.verificationSteps,
      requiredTools: this.requiredTools,
      checklist: this.checklist,
      commitStatus: this.commitStatus,
      argMatch: this.hashMatch,
      docResults: this.docResults,
      lastFetchCyclesBurned: this.lastFetchCyclesBurned,
      rebuildScript: this.rebuildScript,
      // NEW: full metadata for plain-text export
      fullProposalInfo: this.fullProposalInfo,
      reportHeader: headerFinal,
      reportHeaderDefaults: headerDefaults,
      reportNotes: this.reportNotes?.trim() || '',
    };
  }

  #buildPlainTextReport(data) {
    const headerText = this.#formatReportHeaderPlainText(
      data.reportHeader,
      data.reportHeaderDefaults,
      data.reportNotes,
    );

    const ensureValue = (value) => {
      if (value === null || value === undefined) return 'N/A';
      if (typeof value === 'string') {
        const trimmed = value.trim();
        return trimmed.length ? trimmed : 'N/A';
      }
      if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
        return String(value);
      }
      try {
        return JSON.stringify(value);
      } catch {
        return 'N/A';
      }
    };

    const toBlock = (value) => {
      if (value === null || value === undefined) return '';
      if (typeof value === 'string') return value;
      if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
        return String(value);
      }
      if (Array.isArray(value)) return value.join('\n');
      try {
        return JSON.stringify(value, null, 2);
      } catch {
        return String(value);
      }
    };

    const indentBlock = (value, indent = '  ', fallback = 'N/A') => {
      const block = toBlock(value).trimEnd();
      if (!block.trim()) {
        return `${indent}${fallback}`;
      }
      return block.split(/\r?\n/).map((line) => `${indent}${line}`).join('\n');
    };

    const commitStatusText = data.commitStatus
      ? data.commitUrl
        ? `${data.commitStatus} (${data.commitUrl})`
        : data.commitStatus
      : 'N/A';

    const docExpectation = ensureValue(data.docExpectationLabel);
    const docLines = (Array.isArray(data.extractedDocs) ? data.extractedDocs : []).map((doc) => {
      const name = ensureValue(doc?.name);
      const hash = ensureValue(doc?.hash);
      return `  - ${name}: ${hash}`;
    });

    const docResultLines = (Array.isArray(data.docResults) ? data.docResults : []).map((doc, idx) => {
      const source = (data.extractedDocs && data.extractedDocs[idx]) || {};
      const name = ensureValue(source?.name || doc?.name);
      const match = doc?.match === true ? 'Match' : doc?.match === false ? 'No Match' : 'Unknown';
      const error = doc?.error ? ` (Error: ${doc.error})` : '';
      return `  - ${name}: ${match}${error}`;
    });

    const extractedUrlLines = (Array.isArray(data.extractedUrls) ? data.extractedUrls : [])
      .filter((url) => typeof url === 'string' && url.trim().length)
      .map((url) => `  - ${url.trim()}`);

    const checklistEntries = Object.entries(data.checklist || {}).filter(([key]) => key !== 'manual');
    const checklistLines = checklistEntries.map(([key, value]) => {
      if (key === 'docHash' && this.docExpectation === 'not_applicable') {
        return `  - ${key}: N/A`;
      }
      return `  - ${key}: ${value ? 'Completed' : 'Incomplete'}`;
    });

    const lines = [];
    if (headerText) {
      lines.push(headerText, '----------------------------------------');
    }

    lines.push(`Proposal ${data.id} Verification Report`, '');

    lines.push('Details:');
    lines.push(`  Type: ${ensureValue(data.type)}`);
    lines.push(`  Title: ${ensureValue(data.title)}`);
    lines.push(`  URL: ${ensureValue(data.url)}`);
    lines.push('  Summary:');
    lines.push(indentBlock(data.summary));
    lines.push('');

    lines.push('Extracted Info:');
    lines.push(`  Repository: ${ensureValue(data.extractedRepo)}`);
    lines.push(`  Commit: ${ensureValue(data.extractedCommit)}`);
    lines.push(`  Commit URL: ${ensureValue(data.commitUrl)}`);
    lines.push(`  Commit Status: ${ensureValue(commitStatusText)}`);
    lines.push('');

    lines.push('Hashes:');
    lines.push(`  Onchain WASM: ${ensureValue(data.onchainWasmHash)}`);
    lines.push(`  Onchain Argument: ${ensureValue(data.onchainArgHash)}`);
    lines.push(`  Expected Hash: ${ensureValue(data.expectedHash)}`);
    lines.push(`  Expected Hash Source: ${ensureValue(data.expectedHashSource)}`);
    lines.push(`  Argument Hash Match: ${data.argMatch ? 'Yes' : 'No'}`);
    lines.push('');

    lines.push('Dashboard:');
    lines.push(`  URL: ${ensureValue(data.dashboardUrl)}`);
    lines.push('  Snippet:');
    lines.push(indentBlock(data.payloadSnippet));
    lines.push('');

    lines.push('Documents:');
    lines.push(`  Expectation: ${docExpectation}`);
    if (docLines.length) {
      lines.push(...docLines);
    } else {
      lines.push('  None');
    }
    if (docResultLines.length) {
      lines.push('  Verification Results:');
      lines.push(...docResultLines);
    }
    lines.push('');

    if (extractedUrlLines.length) {
      lines.push('Extracted URLs:');
      lines.push(...extractedUrlLines);
      lines.push('');
    }

    lines.push('Checklist:');
    if (checklistLines.length) {
      lines.push(...checklistLines);
    } else {
      lines.push('  None');
    }
    lines.push('');

    lines.push('Steps and Tools:');
    lines.push('  Verification Steps:');
    lines.push(indentBlock(data.verificationSteps));
    lines.push('  Required Tools:');
    lines.push(indentBlock(data.requiredTools));
    lines.push('');

    lines.push('Rebuild Script:');
    lines.push(indentBlock(data.rebuildScript, '    '));

    return lines.join('\n');
  }

  #handleExportJson() {
    const data = this.#getExportData();
    if (!data) {
      alert('No proposal data to export.');
      return;
    }
    const json = JSON.stringify(
      data,
      (key, value) => (typeof value === 'bigint' ? value.toString() : value),
      2,
    );
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `proposal_${data.id}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  #handleExportMarkdown() {
    this.reportGenerationDate = new Date().toISOString().slice(0, 10);
    const data = this.#getExportData();
    if (!data) {
      alert('No proposal data to export.');
      return;
    }
    const headerText = this.#formatReportHeaderMarkdown(
      data.reportHeader,
      data.reportHeaderDefaults,
      data.reportNotes,
    );
    const commitStatusMarkdown = data.commitStatus
      ? data.commitUrl
        ? `[${data.commitStatus}](${data.commitUrl})`
        : data.commitStatus
      : 'N/A';
    let md = headerText ? `${headerText}\n\n---\n\n` : '';
    md += `# Proposal ${data.id} Verification Report\n\n`;
    md += `## Details\n- **Type**: ${data.type}\n- **Title**: ${data.title || 'N/A'}\n- **URL**: ${data.url}\n- **Summary**: \n${data.summary}\n\n`;
    md += `## Extracted Info\n- **Repo**: ${data.extractedRepo || 'N/A'}\n- **Commit**: ${data.extractedCommit || 'N/A'} (${data.commitUrl || ''})\n- **Commit Status**: ${commitStatusMarkdown}\n\n`;
    md += `## Hashes\n- **Onchain WASM**: ${data.onchainWasmHash || 'N/A'}\n- **Onchain Arg**: ${data.onchainArgHash || 'N/A'}\n- **Expected**: ${data.expectedHash || 'N/A'} (source: ${data.expectedHashSource || 'N/A'})\n- **Arg Match**: ${data.argMatch ? '✅' : '❌'}\n\n`;
    md += `## Dashboard\n- **URL**: ${data.dashboardUrl}\n- **Snippet**: \n${data.payloadSnippet || 'N/A'}\n\n`;
    const docExpectationLabel = this.#formatDocExpectationLabel();
    const docLines = (data.extractedDocs || [])
      .map((d) => `- ${d.name}: ${d.hash || 'N/A'}`)
      .join('\n');
    md += `## Documents\n- Expectation: ${docExpectationLabel}\n${docLines || 'None'}\n\n`;
    const checklistEntries = Object.entries(data.checklist || {}).filter(
      ([key]) => key !== 'manual',
    );
    const checklistSection = checklistEntries
      .map(([k, v]) => {
        if (k === 'docHash' && this.docExpectation === 'not_applicable') {
          return `- ${k}: N/A`;
        }
        return `- ${k}: ${v ? '✅' : '❌'}`;
      })
      .join('\n');
    md += `## Checklist\n${checklistSection || 'None'}\n\n`;
    md += `## Steps/Tools\n- **Steps**: ${data.verificationSteps || 'N/A'}\n- **Tools**: ${data.requiredTools || 'N/A'}\n\n`;
    md += `## Rebuild Script\n\`\`\`bash\n${data.rebuildScript || 'N/A'}\n\`\`\`\n`;
    const blob = new Blob([md], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `proposal_${data.id}_report.md`;
    a.click();
    URL.revokeObjectURL(url);
    this.#render();
  }

  #handleExportPdf() {
    this.reportGenerationDate = new Date().toISOString().slice(0, 10);
    const data = this.#getExportData();
    if (!data) {
      alert('No proposal data to export.');
      return;
    }

    const doc = new jsPDF({ unit: 'pt', format: 'a4' });
    const rendered = this.#renderStyledPdfReport(doc, data);

    if (!rendered) {
      alert('Unable to generate the PDF report.');
      return;
    }

    const filename = `proposal_${data.id}_report.pdf`;
    doc.save(filename);
    this.#render();
  }

  #renderStyledPdfReport(doc, data) {
    if (!doc || !data) return false;

    const pageWidth = doc.internal.pageSize.getWidth();
    const pageHeight = doc.internal.pageSize.getHeight();
    const margin = 48;
    const contentWidth = pageWidth - margin * 2;
    const defaultLineHeight = 16;
    let cursorY = margin;

    const ensureValue = (value, fallback = 'N/A') => {
      if (value === null || value === undefined) return fallback;
      const str = String(value).trim();
      return str.length ? str : fallback;
    };

    const ensureSpace = (needed = defaultLineHeight) => {
      if (cursorY + needed > pageHeight - margin) {
        doc.addPage();
        cursorY = margin;
      }
    };

    const addSpacer = (amount = 10) => {
      ensureSpace(amount);
      cursorY += amount;
    };

    const addTitle = (text) => {
      if (!text) return;
      ensureSpace(28);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(18);
      doc.setTextColor(17, 24, 39);
      doc.text(text, margin, cursorY);
      cursorY += 28;
    };

    const addSectionHeading = (text) => {
      if (!text) return;
      ensureSpace(24);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(14);
      doc.setTextColor(30, 41, 59);
      doc.text(text, margin, cursorY);
      cursorY += 14;
      doc.setDrawColor(220, 220, 220);
      doc.setLineWidth(0.5);
      doc.line(margin, cursorY + 4, margin + contentWidth, cursorY + 4);
      cursorY += 12;
    };

    const addParagraph = (text, { indent = 0, fontSize = 11, fontStyle = 'normal', lineHeight = defaultLineHeight, color = [55, 65, 81] } = {}) => {
      const trimmed = typeof text === 'string' ? text.trim() : '';
      if (!trimmed.length) return;
      doc.setFont('helvetica', fontStyle);
      doc.setFontSize(fontSize);
      doc.setTextColor(...color);
      const lines = doc.splitTextToSize(trimmed, contentWidth - indent);
      for (const line of lines) {
        ensureSpace(lineHeight);
        doc.text(line, margin + indent, cursorY);
        cursorY += lineHeight;
      }
      cursorY += 4;
    };

    const addKeyValue = (
      label,
      value,
      {
        indent = 0,
        bullet = false,
        lineHeight = defaultLineHeight,
        link,
        prefixIcon,
        after = 6,
        showPlaceholder = true,
      } = {},
    ) => {
      const rawValue = value;
      const safeValue = ensureValue(value);
      const labelPrefix = bullet ? '• ' : '';
      const labelText = `${labelPrefix}${label}:`;

      ensureSpace(lineHeight);

      doc.setFont('helvetica', 'bold');
      doc.setFontSize(11);
      doc.setTextColor(30, 41, 59);
      const labelX = margin + indent;
      doc.text(labelText, labelX, cursorY);

      const labelWidth = doc.getTextWidth(`${labelText} `);
      const hasContent =
        rawValue !== null &&
        rawValue !== undefined &&
        !(typeof rawValue === 'string' && rawValue.trim().length === 0);

      let valueText = safeValue;
      if (prefixIcon) {
        valueText = `${prefixIcon} ${safeValue}`;
      }

      if (!showPlaceholder && !hasContent) {
        valueText = '';
      }

      doc.setFont('helvetica', 'normal');
      doc.setFontSize(11);
      doc.setTextColor(55, 65, 81);

      const lines = valueText
        ? doc.splitTextToSize(
            valueText,
            Math.max(contentWidth - indent - labelWidth, contentWidth * 0.4),
          )
        : [];
      let currentY = cursorY;
      const firstLine = lines.shift();
      if (firstLine) {
        if (link && safeValue !== 'N/A') {
          doc.textWithLink(firstLine, labelX + labelWidth, currentY, { url: link });
        } else {
          doc.text(firstLine, labelX + labelWidth, currentY);
        }
        currentY += lineHeight;
      } else {
        currentY += lineHeight;
      }

      for (const line of lines) {
        if (currentY > pageHeight - margin) {
          doc.addPage();
          currentY = margin;
        }
        doc.text(line, margin + indent + (bullet ? 16 : 12), currentY);
        currentY += lineHeight;
      }

      cursorY = currentY + after;
    };

    const addBulletList = (items = [], options = {}) => {
      for (const item of items) {
        if (!item) continue;
        addKeyValue(item.label, item.value, { ...options, ...item.options, bullet: true });
      }
    };

    const addCodeBlock = (text, { indent = 0, title } = {}) => {
      const safeText = ensureValue(text, '').trim();
      const hasContent = safeText.length > 0;
      const lines = hasContent
        ? doc.splitTextToSize(safeText, contentWidth - indent - 16)
        : ['N/A'];
      const blockHeight = lines.length * 14 + 16;

      if (title) {
        addKeyValue(title, '', { indent, bullet: false, after: 0, showPlaceholder: false });
        addSpacer(4);
      }

      ensureSpace(blockHeight + 4);
      doc.setFillColor(248, 250, 252);
      doc.roundedRect(margin + indent, cursorY, contentWidth - indent, blockHeight, 4, 4, 'F');
      doc.setFont('courier', 'normal');
      doc.setFontSize(10);
      doc.setTextColor(51, 65, 85);

      let textY = cursorY + 16;
      for (const line of lines) {
        if (textY > pageHeight - margin) {
          doc.addPage();
          textY = margin + 16;
        }
        doc.text(line, margin + indent + 8, textY);
        textY += 14;
      }

      cursorY = textY + 6;
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(11);
      doc.setTextColor(55, 65, 81);
    };

    const headerDisplay = this.#buildReportHeaderDisplay(
      data.reportHeader,
      data.reportHeaderDefaults,
      data.reportNotes,
    );

    if (headerDisplay) {
      addTitle(headerDisplay.title);
      addSpacer(4);
      addBulletList(headerDisplay.metadata.map((entry) => ({
        label: entry.label,
        value: entry.value,
        options: { link: entry.link },
      })));

      if (headerDisplay.argument) {
        const arg = headerDisplay.argument;
        const heading = arg.type ? `${arg.label} (${arg.type})` : arg.label;
        addCodeBlock(arg.value, { title: heading });
      }

      const summaryItems = [
        { label: 'Proposer', value: headerDisplay.summary.proposer },
        { label: 'Verification Date', value: headerDisplay.summary.verificationDate },
        { label: 'Verified by', value: headerDisplay.summary.verifiedBy },
        { label: 'Generated by', value: headerDisplay.summary.generatedBy },
      ];

      addBulletList(summaryItems);

      const links = headerDisplay.summary.links || {};
      const linkItems = [];
      if (links.nns && links.nns !== 'N/A') {
        linkItems.push({ label: 'NNS dapp view', value: links.nns, options: { link: links.nns } });
      }
      if (links.dashboard && links.dashboard !== 'N/A') {
        linkItems.push({ label: 'ICP Dashboard record', value: links.dashboard, options: { link: links.dashboard } });
      }
      if (linkItems.length) {
        addKeyValue('Links', '', { after: 0, showPlaceholder: false });
        addSpacer(4);
        addBulletList(linkItems, { indent: 12 });
      }

      if (headerDisplay.notes?.length) {
        addKeyValue('Reviewer Notes', '', { after: 0, showPlaceholder: false });
        addSpacer(4);
        for (const noteLine of headerDisplay.notes) {
          addParagraph(noteLine, { indent: 16, fontStyle: 'italic' });
        }
      }

      addSpacer(4);
    } else {
      addTitle(`Proposal ${ensureValue(data.id)} Verification Report`);
    }

    addSectionHeading(`Proposal ${ensureValue(data.id)} Verification Report`);

    const detailsItems = [
      { label: 'Type', value: ensureValue(data.type) },
      { label: 'Title', value: ensureValue(data.title) },
      { label: 'URL', value: ensureValue(data.url), options: { link: data.url } },
      { label: 'Summary', value: ensureValue(data.summary) },
    ];
    addBulletList(detailsItems);

    addSectionHeading('Extracted Info');
    const commitDisplay = data.commitUrl
      ? `${ensureValue(data.extractedCommit)} (${data.commitUrl})`
      : ensureValue(data.extractedCommit);
    const extractedItems = [
      { label: 'Repo', value: ensureValue(data.extractedRepo) },
      {
        label: 'Commit',
        value: commitDisplay,
        options: { link: data.commitUrl },
      },
      {
        label: 'Commit Status',
        value: ensureValue(data.commitStatus),
      },
    ];
    addBulletList(extractedItems);

    addSectionHeading('Hashes');
    const hashItems = [
      { label: 'Onchain WASM', value: ensureValue(data.onchainWasmHash) },
      { label: 'Onchain Arg', value: ensureValue(data.onchainArgHash) },
      {
        label: 'Expected',
        value: `${ensureValue(data.expectedHash)} (source: ${ensureValue(data.expectedHashSource)})`,
      },
      {
        label: 'Arg Match',
        value: data.argMatch ? 'Match confirmed' : 'Mismatch',
        options: { prefixIcon: data.argMatch ? '✅' : '❌' },
      },
    ];
    addBulletList(hashItems);

    addSectionHeading('Dashboard');
    addBulletList([
      { label: 'URL', value: ensureValue(data.dashboardUrl), options: { link: data.dashboardUrl } },
    ]);
    addCodeBlock(ensureValue(data.payloadSnippetRaw || data.payloadSnippet), {
      indent: 12,
    });

    addSectionHeading('Documents');
    const docExpectationLabel = this.#formatDocExpectationLabel();
    addBulletList([
      { label: 'Expectation', value: ensureValue(docExpectationLabel) },
    ]);

    const docs = Array.isArray(data.extractedDocs) ? data.extractedDocs : [];
    if (docs.length) {
      addKeyValue('Provided Documents', '', { after: 0, showPlaceholder: false });
      addSpacer(4);
      docs.forEach((docItem) => {
        const name = ensureValue(docItem?.name);
        const hash = ensureValue(docItem?.hash);
        addParagraph(`${name}: ${hash}`, { indent: 18 });
      });
    } else {
      addParagraph('None provided', { indent: 12, fontStyle: 'italic' });
    }

    const docResults = Array.isArray(data.docResults) ? data.docResults : [];
    if (docResults.length) {
      addKeyValue('Verification Results', '', { after: 0, showPlaceholder: false });
      addSpacer(4);
      docResults.forEach((result, idx) => {
        const source = docs[idx] || {};
        const name = ensureValue(source?.name || result?.name);
        const match =
          result?.match === true ? 'Match' : result?.match === false ? 'No Match' : 'Unknown';
        const icon = result?.match === true ? '✅' : result?.match === false ? '❌' : 'ℹ️';
        const error = result?.error ? ` (Error: ${result.error})` : '';
        addParagraph(`${icon} ${name}: ${match}${error}`, { indent: 18 });
      });
    }

    const urlLines = (Array.isArray(data.extractedUrls) ? data.extractedUrls : [])
      .filter((url) => typeof url === 'string' && url.trim().length)
      .map((url) => url.trim());
    if (urlLines.length) {
      addSectionHeading('Extracted URLs');
      urlLines.forEach((url) => {
        addParagraph(`• ${url}`, { indent: 12, color: [30, 64, 175] });
      });
    }

    addSectionHeading('Checklist');
    const checklistEntries = Object.entries(data.checklist || {}).filter(([key]) => key !== 'manual');
    if (checklistEntries.length) {
      checklistEntries.forEach(([key, value]) => {
        if (key === 'docHash' && this.docExpectation === 'not_applicable') {
          addParagraph(`• ${key}: N/A`, { indent: 12 });
        } else {
          const icon = value ? '✅' : '❌';
          const label = value ? 'Completed' : 'Incomplete';
          addParagraph(`• ${key}: ${icon} ${label}`, { indent: 12 });
        }
      });
    } else {
      addParagraph('No checklist items recorded.', { indent: 12, fontStyle: 'italic' });
    }

    addSectionHeading('Steps & Tools');
    addKeyValue('Verification Steps', ensureValue(data.verificationSteps), { bullet: true });
    addKeyValue('Required Tools', ensureValue(data.requiredTools), { bullet: true });

    addSectionHeading('Rebuild Script');
    addCodeBlock(ensureValue(data.rebuildScript));

    if (data.lastFetchCyclesBurned) {
      addParagraph(`Last fetch cycles burned: ${ensureValue(data.lastFetchCyclesBurned)}`, {
        indent: 4,
        fontStyle: 'italic',
      });
    }

    return true;
  }

  // NEW: Export full metadata as plain text (Candid-like)
  #handleExportMetadata() {
    const data = this.#getExportData();
    if (!data) {
      alert('No proposal data to export.');
      return;
    }
    const full = data.fullProposalInfo;
    if (!full) {
      alert('Full metadata not available.');
      return;
    }
    const text = stringifyToCandid(full);
    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `proposal_${data.id}_metadata.txt`;
    a.click();
    URL.revokeObjectURL(url);
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
    const headerDefaults = p ? this.#computeReportHeaderDefaults() || {} : null;
    const headerFinal = headerDefaults ? this.#applyReportOverrides(headerDefaults) : null;
    const headerPreviewMarkdown = headerDefaults
      ? this.#formatReportHeaderMarkdown(headerFinal, headerDefaults, this.reportNotes)
      : '';
    const headerPreviewHtml = headerPreviewMarkdown
      ? DOMPurify.sanitize(marked.parse(headerPreviewMarkdown))
      : '';
    const manualReportInputs = headerDefaults
      ? REPORT_HEADER_INPUTS.filter((field) => {
          if (field.alwaysShow) return true;
          const base = headerDefaults[field.key];
          return !base;
        })
      : [];

    const fetchFeeE8s = this.fees?.fetchProposal_e8s ?? 0n;
    const fetchFeeIcp = Number(fetchFeeE8s) / 1e8;
    const dynamicInfo = this.feesDynamicInfo;
    const marginPercent = dynamicInfo?.margin_bps
      ? Number(dynamicInfo.margin_bps) / 100
      : 5;
    const xdrPerIcp = dynamicInfo?.xdr_permyriad_per_icp
      ? Number(dynamicInfo.xdr_permyriad_per_icp) / 10_000
      : null;

    const loginButton = html`
      <button
        class=${`btn${this.identity ? ' secondary' : ''}`}
        ?disabled=${this.isAuthenticating && !this.identity}
        @click=${() => (this.identity ? this.#logout() : this.#login())}
      >
        ${this.identity
          ? 'Logout'
          : this.isAuthenticating
          ? 'Authenticating…'
          : 'Login with Internet Identity'}
      </button>
    `;

    const quoteButton = html`
      <button
        class="btn secondary"
        style="font-size:12px; padding:4px 8px;"
        @click=${() => this.#quoteNow()}
      >
        Refresh price
      </button>
    `;

    const body = html`
      <nav class="topbar">
        <h1 class="grow">IC Proposal Verifier</h1>

        <div style="display:flex; gap:8px; align-items:center;">
          ${this.identity
            ? html`
                <div style="text-align:right; display:flex; flex-direction:column; gap:4px; align-items:flex-end;">
                  <div style="font-size:12px;">
                    <b>Balance</b>: ${(this.userBalance / 1e8).toFixed(8)} ICP
                  </div>
                  <div
                    style="font-size:12px; display:flex; gap:6px; flex-wrap:wrap; justify-content:flex-end; align-items:center;"
                  >
                    <span>
                      <b>Fees</b>: Fetch Proposal ≈ ${fetchFeeIcp.toFixed(6)} ICP
                      <em>(+ 0.0001 ICP network fee)</em>
                    </span>
                    ${quoteButton}
                  </div>
                  <div style="font-size:12px;">
                    <b>Pricing basis</b>:
                    ${this.#formatCyclesDisplay(dynamicInfo?.avg_cycles ?? this.fetchCyclesAverage)}
                    cycles avg, margin ≈ ${marginPercent.toFixed(2)}%
                  </div>
                  ${xdrPerIcp !== null
                    ? html`<div style="font-size:12px;">
                        <b>Cached rate</b>: ${xdrPerIcp.toFixed(4)} XDR/ICP
                      </div>`
                    : null}
                  <div style="font-size:12px;">
                    <b>Average cycles burned</b>
                    ${this.fetchCyclesCount > 0
                      ? html`<span>
                          (last ${this.fetchCyclesCount} fetch${this.fetchCyclesCount === 1 ? '' : 'es'})
                        </span>`
                      : null}
                    : ${this.#formatCyclesDisplay(this.fetchCyclesAverage)}
                  </div>
                  <div style="font-size:12px;">
                    <b>Last fetch cycles burned</b>:
                    ${this.#formatCyclesDisplay(this.lastFetchCyclesBurned)}
                  </div>
                </div>
              `
            : null}
          ${loginButton}
          <a
            class="btn secondary"
            href=${GUIDE_URL}
            target="_blank"
            rel="noopener noreferrer"
          >
            Guide
          </a>
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
              <details>
                <summary><b>Fund your balance</b></summary>
                <p>
                  Send ICP to <b>your deposit address</b> below. Fees are deducted automatically
                  from this address when you run billed actions (e.g. <b>Fetch Proposal</b>).
                </p>
                <p>
                  Each Fetch Proposal transfer debits the <b>current dynamic quote</b> (average
                  cycles burned per fetch + ${marginPercent.toFixed(2)}% margin, converted using the
                  latest ICP/XDR rate) plus the 0.0001 ICP network fee, forwarding it to account
                  identifier <code>${BENEFICIARY_ACCOUNT_IDENTIFIER}</code> to fund the canister's
                  cycles.
                </p>

                <div class="deposit-highlight">
                  <p class="label">Deposit Address (Account Identifier)</p>
                  <p class="address">
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
                  </p>
                  <p class="note">
                    <b>Important:</b> After making a deposit, click <i>Refresh balances</i> below to
                    apply the funds to your Proposal Verifier account.
                  </p>
                </div>

                <ul>
                  <li>
                    <b>Your PID (DO NOT SEND ICP HERE):</b> <code>${this.userPrincipal}</code>
                  </li>
                  <li>
                    <b>Need it later?</b> You can always reopen this panel to copy the same address.
                  </li>
                </ul>

                <details>
                  <summary>How to send</summary>
                  <p>
                    <b>Most wallets (incl. NNS):</b> paste the <i>Deposit Address</i> above into the
                    “To” field and send ICP.
                  </p>
                  <p><b>CLI (dfx):</b></p>
                  <pre class="cmd-pre">dfx ledger transfer ${this.depositAccountIdentifierHex ||
                  '<ADDRESS>'} --icp 0.5 --memo 0</pre>
                </details>

                <div style="display:flex; gap:12px; flex-wrap:wrap; align-items:center;">
                  <button
                    class="btn secondary"
                    @click=${async () => {
                      await this.#loadDepositStatus({ autoCredit: true, silentCredit: false });
                      await this.#refreshBalance();
                    }}
                  >
                    Refresh balances
                  </button>
                </div>

                <div style="margin-top:8px;">
                  <div>
                    <b>On-chain (deposit subaccount):</b>
                    ${(this.depositLedgerBalance / 1e8).toFixed(8)} ICP
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
          <a
            class="btn secondary"
            href=${GUIDE_URL}
            target="_blank"
            rel="noopener noreferrer"
          >
            Guide
          </a>
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
                    ? html`<a href="${p.commitUrl}" target="_blank" rel="noreferrer noopener"
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
                    ? html`<a href="${p.extractedDocUrl}" target="_blank" rel="noreferrer noopener"
                        >${p.extractedDocUrl}</a
                      >`
                    : 'None'}
                </p>
                <p><b>Document Expectation:</b> ${this.#formatDocExpectationLabel()}</p>
                <p><b>Artifact Path Hint:</b> ${p.extractedArtifact ?? 'None'}</p>

                <p>
                  <b>Commit Status:</b>
                  ${p.commitUrl && this.commitStatus
                    ? html`&nbsp;<a href="${p.commitUrl}" target="_blank" rel="noreferrer noopener"
                        >${this.commitStatus}</a
                      >`
                    : html`&nbsp;${this.commitStatus}`}
                </p>

                ${this.dashboardUrl
                  ? html`<p>
                      <b>Dashboard:</b>
                      <a href="${this.dashboardUrl}" target="_blank" rel="noreferrer noopener"
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
                  const docs = (this.proposalData?.extractedDocs || []).filter((d) => d.hash != null);
                  if (!docs.length)
                    return this.docExpectation === 'not_applicable'
                      ? html`<p>No documents expected for this proposal (removal/deregistration).</p>`
                      : html`<p>
                          No documents were auto-extracted. Provide hashes from the proposal summary or upload files manually for
                          verification.
                        </p>`;
                  return html`
                    <ul class="doc-list">
                      ${docs.map((d, idx) => {
                        const res = this.docResults[idx] || { match: false, error: '', preview: '' };
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
                })()}
                <input id="docUrl" placeholder="Document URL (text/JSON only)" value=${p.extractedDocUrl ?? ''} />
                <input id="expectedDocHash" placeholder="Expected SHA-256" value=${this.expectedHash || ''} />
                <button class="btn" @click=${() => this.#handleFetchVerifyDoc()}>
                  Fetch & Verify URL (text only)
                </button>
                ${this.docHashError ? html`<p class="error" style="margin-top:8px;">${this.docHashError}</p>` : ''}
                ${typeof this.docHashMatch === 'boolean'
                  ? html`<p><b>URL Hash Match:</b> ${this.docHashMatch ? '✅ Yes' : '❌ No'}</p>`
                  : ''}
                ${this.docPreview ? html`<p><b>Preview:</b> ${this.docPreview}</p>` : ''}
              </section>

              <section>
                <h2>Payload (from Dashboard/API)</h2>
                <pre>${this.payloadSnippetFromDashboard ?? '(no payload snippet found from ic-api)'}</pre>
                <button
                  class="btn"
                  @click=${(e) => this.#handleCopy(e, this.payloadSnippetFromDashboard || '', 'Copy Payload')}
                >
                  Copy Payload
                </button>
              </section>

              <section>
                <h2>Rebuild Locally</h2>
                ${p.extractedArtifact ? html`<p><b>Artifact (expected):</b> ${p.extractedArtifact}</p>` : ''}
                <pre>${this.rebuildScript}</pre>
                <button class="btn" @click=${(e) => this.#handleCopy(e, this.rebuildScript, 'Copy Script')}>
                  Copy Script
                </button>
                <p>
                  Compare your local <code>sha256sum</code>/<code>shasum -a 256</code> with the
                  <b>onchain WASM hash</b>: ${p.proposal_wasm_hash ?? 'N/A'}
                </p>
              </section>

              <section>
                <h2>Verification Steps for ${p.proposalType}</h2>
                ${(() => {
                  const steps = (this.verificationSteps || '').trim();
                  if (!steps) return html`<p>No type-specific steps available for this proposal.</p>`;
                  const normalizeStepText = (line) => {
                    const trimmed = line.trim();
                    if (!trimmed) return '';
                    const withoutPrefix = trimmed.replace(/^(?:\d+\s*[.)]|[-*•])\s*/, '');
                    return withoutPrefix.trim() || trimmed;
                  };
                  const items = steps
                    .split('\n')
                    .map((s) => normalizeStepText(s))
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
                                ?disabled=${
                                  item.key === 'docHash' &&
                                  this.docExpectation === 'not_applicable'
                                }
                                @change=${(e) => this.#setChecklistOverride(item.key, e.target.checked)}
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

              <!-- NEW: Export section -->
              <section>
                <h2>Export Report</h2>
                ${headerDefaults
                  ? html`
                      <h3>Summary Preview</h3>
                      <div class="report-preview markdown-preview">
                        ${unsafeHTML(headerPreviewHtml)}
                      </div>
                    `
                  : ''}
                ${headerDefaults
                  ? manualReportInputs.length
                    ? html`
                        <h3>Fill Missing Details</h3>
                        <div class="report-manual-fields">
                          ${manualReportInputs.map(
                            (field) => html`<label>
                              <span>${field.label}</span>
                              <input
                                type="text"
                                .value=${this.reportOverrides[field.key] ?? ''}
                                placeholder=${field.placeholder || ''}
                                @input=${(e) =>
                                  this.#updateReportOverride(field.key, e.target.value)}
                              />
                            </label>`,
                          )}
                        </div>
                      `
                    : html`<p>All summary fields were populated automatically.</p>`
                  : ''}
                ${this.proposalData
                  ? html`
                      <div class="report-notes">
                        <label>
                          <span>Reviewer Notes (optional)</span>
                          <textarea
                            .value=${this.reportNotes}
                            placeholder="Add any remarks, concerns, or follow-up items for this proposal."
                            @input=${(e) => this.#updateReportNotes(e.target.value)}
                          ></textarea>
                        </label>
                      </div>
                    `
                  : ''}
                <div class="export-buttons">
                  <button class="btn" @click=${() => this.#handleExportJson()}>
                    Download JSON
                  </button>
                  <button class="btn secondary" @click=${() => this.#handleExportMarkdown()}>
                    Download Markdown
                  </button>
                  <button class="btn secondary" @click=${() => this.#handleExportPdf()}>
                    Download PDF
                  </button>
                  <button
                    class="btn secondary"
                    @click=${() => this.#handleExportMetadata()}
                    ?disabled=${!this.fullProposalInfo}
                    title=${this.fullProposalInfo ? '' : 'Fetch a proposal first'}
                  >
                    Export Metadata (.txt)
                  </button>
                </div>
              </section>
            `
          : ''}
      </main>
    `;
    render(body, document.getElementById('root'));
  }
}

export default App;
