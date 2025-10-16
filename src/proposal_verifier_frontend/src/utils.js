// src/proposal_verifier_frontend/src/utils.js

// Normalize a hex string: remove 0x, whitespace, newlines, tabs, and stray '%' at EOL.
export function normalizeHex(input) {
  if (!input) return "";
  let s = String(input)
    .trim()
    .replace(/^0x/i, "")
    .replace(/\s+/g, "");       // strip all whitespace
  // Drop a trailing '%' (common when copying from zsh when there's no final newline)
  if (s.endsWith("%")) s = s.slice(0, -1);
  return s;
}

export function looksLikeHexString(s) {
  if (!s) return false;
  const t = normalizeHex(s);
  return /^[0-9a-fA-F]+$/.test(t) && t.length % 2 === 0;
}

// Convert hex string -> Uint8Array; strict about hex chars but tolerant of spacing.
export function hexToBytes(hex) {
  const cleaned = normalizeHex(hex);
  if (!/^[0-9a-fA-F]*$/.test(cleaned)) {
    throw new Error("Invalid hex input (contains non-hex characters).");
  }
  if (cleaned.length % 2 !== 0) {
    throw new Error("Invalid hex input (odd number of nibbles). Did you miss a leading 0 or copy the whole line?");
  }
  const out = new Uint8Array(cleaned.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(cleaned.substr(i * 2, 2), 16);
  }
  return out;
}

export function bytesToHex(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  return Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
}

export function equalBytes(a, b) {
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// If someone pasted hex-of-hex (e.g., ran `didc encode ... | xxd -p`) we try to auto-fix.
export function tryDecodeDoubleHex(hexText) {
  try {
    const once = hexToBytes(hexText);
    // Are these bytes ASCII hex? If yes, decode again.
    const allAsciiHex =
      once.length % 2 === 0 &&
      once.every((c) =>
        (c >= 0x30 && c <= 0x39) || // 0-9
        (c >= 0x41 && c <= 0x46) || // A-F
        (c >= 0x61 && c <= 0x66)    // a-f
      );
    if (!allAsciiHex) return null;
    const inner = new TextDecoder().decode(once);
    if (!looksLikeHexString(inner)) return null;
    return hexToBytes(inner);
  } catch {
    return null;
  }
}

export async function sha256(message) {
  if (message == null) return "";

  if (typeof crypto === "undefined" || !crypto.subtle) {
    throw new Error("Web Crypto API is not available in this environment.");
  }

  let data;
  if (message instanceof ArrayBuffer || message instanceof Uint8Array) {
    data = message; // bytes or file
  } else if (typeof message === "string") {
    data = new TextEncoder().encode(message);
  } else {
    data = new TextEncoder().encode(String(message));
  }

  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

import { Principal } from "@dfinity/principal";
import { sha224 } from "js-sha256";

// crc32 of a byte array (returns unsigned 32-bit number)
export function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    let c = (crc ^ bytes[i]) & 0xff;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// Compute legacy Account Identifier (64-hex) for (owner principal, 32-byte subaccount)
export function principalToAccountIdentifier(ownerPrincipalText, subaccountHex) {
  const owner = Principal.fromText(ownerPrincipalText).toUint8Array();
  const sub = hexToBytes(subaccountHex); // 32 bytes expected
  if (sub.length !== 32) throw new Error("Subaccount must be 32 bytes.");

  // "\x0Aaccount-id" domain separator
  const padding = new Uint8Array([0x0a, 0x61, 0x63, 0x63, 0x6f, 0x75, 0x6e, 0x74, 0x2d, 0x69, 0x64]);
  const data = new Uint8Array(padding.length + owner.length + sub.length);
  data.set(padding, 0);
  data.set(owner, padding.length);
  data.set(sub, padding.length + owner.length);

  const hashHex = sha224.create().update(data).hex();      // 28-byte hash (56 hex)
  const hashBytes = hexToBytes(hashHex);
  const c = crc32(hashBytes);

  const out = new Uint8Array(4 + hashBytes.length);
  out[0] = (c >>> 24) & 0xff; out[1] = (c >>> 16) & 0xff; out[2] = (c >>> 8) & 0xff; out[3] = c & 0xff;
  out.set(hashBytes, 4);
  return bytesToHex(out);
}
