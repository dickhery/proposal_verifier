// src/proposal_verifier_frontend/src/utils.js
import { sha256 as _sha256, sha224 as _sha224 } from 'js-sha256';
import { Principal } from '@dfinity/principal';

// ---------- Hex helpers ----------
export function normalizeHex(input) {
  if (!input) return '';
  let s = String(input).trim().replace(/^0x/i, '').replace(/\s+/g, '');
  if (s.endsWith('%')) s = s.slice(0, -1);
  return s;
}
export function looksLikeHexString(s) {
  if (!s) return false;
  const t = normalizeHex(s);
  return /^[0-9a-fA-F]+$/.test(t) && t.length % 2 === 0;
}
export function hexToBytes(hex) {
  const cleaned = normalizeHex(hex);
  if (!/^[0-9a-fA-F]*$/.test(cleaned)) throw new Error('Invalid hex string');
  if (cleaned.length % 2) throw new Error('Hex string must have even length');
  const out = new Uint8Array(cleaned.length / 2);
  for (let i = 0; i < cleaned.length; i += 2) {
    out[i / 2] = parseInt(cleaned.slice(i, i + 2), 16);
  }
  return out;
}
export function bytesToHex(bytes) {
  const lut = [];
  for (let i = 0; i < 256; i++) lut[i] = (i + 256).toString(16).slice(1);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += lut[bytes[i]];
  return s;
}
export function equalBytes(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
export function tryDecodeDoubleHex(s) {
  // If user pasted hex-of-hex, return the inner bytes; else null
  try {
    const b = hexToBytes(s);
    // If those bytes are ASCII hex chars, decode again
    const asText = new TextDecoder().decode(b).trim();
    if (/^[0-9a-fA-F]+$/.test(asText) && asText.length % 2 === 0) {
      return hexToBytes(asText);
    }
    return null;
  } catch {
    return null;
  }
}

// ---------- Hash helpers ----------
export async function sha256(bytesOrText) {
  const bytes =
    typeof bytesOrText === 'string' ? new TextEncoder().encode(bytesOrText) : bytesOrText;
  // js-sha256 accepts Uint8Array directly
  return _sha256(bytes);
}
function sha224(bytes) {
  return _sha224(bytes);
}

// ---------- CRC32 (for Account Identifier) ----------
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
  return new Uint8Array([ (c >>> 24) & 0xff, (c >>> 16) & 0xff, (c >>> 8) & 0xff, c & 0xff ]);
}

// ---------- Account Identifier (owner + subaccount) ----------
function principalToBytes(text) {
  return new Uint8Array(Principal.fromText(text).toUint8Array());
}
function subaccountToBytes(subaccountHex) {
  const raw = hexToBytes(subaccountHex || '');
  if (raw.length === 0) {
    // all-zero (32 bytes)
    return new Uint8Array(32);
  }
  if (raw.length !== 32) throw new Error('Subaccount must be 32 bytes (hex length 64)');
  return raw;
}
/**
 * Compute the legacy 64-hex "Account Identifier" (wallet address) for (owner, subaccount).
 * CAI = CRC32(sha224("\x0Aaccount-id" ++ owner ++ subaccount)) ++ sha224(...)
 */
export function principalToAccountIdentifier(ownerPrincipalText, subaccountHex) {
  const owner = principalToBytes(ownerPrincipalText);
  const sub = subaccountToBytes(subaccountHex);
  const domainSep = new Uint8Array([0x0a, ...new TextEncoder().encode('account-id')]);
  const data = new Uint8Array(domainSep.length + owner.length + sub.length);
  data.set(domainSep, 0);
  data.set(owner, domainSep.length);
  data.set(sub, domainSep.length + owner.length);
  const hash = hexToBytes(sha224(data)); // 28 bytes
  const check = crc32(hash);             // 4 bytes
  const out = new Uint8Array(32);
  out.set(check, 0);
  out.set(hash, 4);
  return bytesToHex(out);
}
