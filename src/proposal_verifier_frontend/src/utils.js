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
