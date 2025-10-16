// src/proposal_verifier_frontend/src/utils.js
import { sha256 as _sha256, sha224 as _sha224 } from 'js-sha256';
import { Principal } from '@dfinity/principal';

/* -----------------------------------------------------------------------------
 * HEX HELPERS
 * -------------------------------------------------------------------------- */
export function normalizeHex(input) {
  if (!input) return '';
  let s = String(input).trim().replace(/^0x/i, '').replace(/\s+/g, '');
  // NNS sometimes shows a trailing '%' in copy-pastes; strip it if present.
  if (s.endsWith('%')) s = s.slice(0, -1);
  return s.toLowerCase();
}

export function looksLikeHexString(s) {
  if (!s) return false;
  const t = normalizeHex(s);
  return /^[0-9a-f]+$/.test(t) && t.length % 2 === 0;
}

export function hexToBytes(hex) {
  const cleaned = normalizeHex(hex);
  if (!/^[0-9a-f]*$/.test(cleaned)) throw new Error('Invalid hex string');
  if (cleaned.length % 2) throw new Error('Hex string must have even length');
  const out = new Uint8Array(cleaned.length / 2);
  for (let i = 0; i < cleaned.length; i += 2) {
    out[i / 2] = parseInt(cleaned.slice(i, i + 2), 16);
  }
  return out;
}

// Fast LUT-accelerated encoding (module-scoped LUT so it isn't rebuilt each call)
const HEX_LUT = (() => {
  const lut = new Array(256);
  for (let i = 0; i < 256; i++) lut[i] = (i + 256).toString(16).slice(1);
  return lut;
})();

export function bytesToHex(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += HEX_LUT[bytes[i]];
  return s;
}

export function equalBytes(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// If a user pasted "hex-of-hex", decode once to text, check if it's hex, then decode again.
export function tryDecodeDoubleHex(s) {
  try {
    const b = hexToBytes(s);
    const asText = new TextDecoder().decode(b).trim();
    if (/^[0-9a-fA-F]+$/.test(asText) && asText.length % 2 === 0) {
      return hexToBytes(asText);
    }
    return null;
  } catch {
    return null;
  }
}

/* -----------------------------------------------------------------------------
 * HASH HELPERS
 * -------------------------------------------------------------------------- */
// Returns lowercase hex string. Kept async for call-sites already using `await`.
export async function sha256(bytesOrText) {
  const bytes =
    typeof bytesOrText === 'string' ? new TextEncoder().encode(bytesOrText) : bytesOrText;
  // js-sha256 accepts Uint8Array directly and returns hex (lowercase).
  return _sha256(bytes);
}

// Internal helper: returns lowercase hex string.
function sha224(bytes) {
  // js-sha256's sha224 also accepts Uint8Array and returns hex.
  return _sha224(bytes);
}

/* -----------------------------------------------------------------------------
 * CRC32 (BIG-ENDIAN) FOR ACCOUNT IDENTIFIER CHECKSUM
 * -------------------------------------------------------------------------- */
const CRC32_TABLE = (() => {
  let c;
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC32_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  c = (c ^ 0xffffffff) >>> 0;
  // big-endian 4 bytes
  return new Uint8Array([
    (c >>> 24) & 0xff,
    (c >>> 16) & 0xff,
    (c >>> 8) & 0xff,
    c & 0xff,
  ]);
}

/* -----------------------------------------------------------------------------
 * ACCOUNT IDENTIFIER (owner principal + subaccount)  ->  64-HEX ADDRESS
 *
 * CAI = CRC32(sha224("\x0Aaccount-id" ++ owner ++ subaccount)) ++ sha224(...)
 * - owner: Principal (bytes of Principal.fromText(ownerText).toUint8Array())
 * - subaccount: 32 bytes (hex string input; all-zeros if omitted)
 * - output: 32-byte address returned as 64-char lowercase hex
 * -------------------------------------------------------------------------- */
function principalToBytes(text) {
  return new Uint8Array(Principal.fromText(text).toUint8Array());
}

function subaccountToBytes(subaccountHex) {
  const raw = hexToBytes(subaccountHex || '');
  if (raw.length === 0) {
    // all-zero 32-byte subaccount
    return new Uint8Array(32);
  }
  if (raw.length !== 32) throw new Error('Subaccount must be 32 bytes (hex length 64)');
  return raw;
}

/**
 * Compute the legacy 64-hex "Account Identifier" (wallet address) for (owner, subaccount).
 * Most wallets (incl. NNS) want this 64-hex address — NOT the raw subaccount hex.
 *
 * @param {string} ownerPrincipalText - Principal text (e.g., canister principal)
 * @param {string} [subaccountHex] - 64-hex for a 32-byte subaccount; default = all zeros
 * @returns {string} 64-hex, lowercase (includes 4-byte CRC32 prefix)
 */
export function principalToAccountIdentifier(ownerPrincipalText, subaccountHex) {
  if (!ownerPrincipalText) throw new Error('Owner principal is required');
  const owner = principalToBytes(ownerPrincipalText);
  const sub = subaccountToBytes(subaccountHex);

  // Domain separator: single length byte 0x0A + "account-id"
  const domainSep = new Uint8Array([0x0a, ...new TextEncoder().encode('account-id')]);

  const data = new Uint8Array(domainSep.length + owner.length + sub.length);
  data.set(domainSep, 0);
  data.set(owner, domainSep.length);
  data.set(sub, domainSep.length + owner.length);

  // sha224 returns hex → convert to bytes for CRC step
  const hash = hexToBytes(sha224(data)); // 28 bytes
  const check = crc32(hash);             // 4 bytes

  const out = new Uint8Array(32);
  out.set(check, 0);
  out.set(hash, 4);

  return bytesToHex(out); // 64-hex, lowercase
}
