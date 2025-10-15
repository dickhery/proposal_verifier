// src/proposal_verifier_frontend/src/utils.js

// Normalize a hex string: remove 0x, whitespace, newlines, tabs, and stray '%' at EOL.
export function normalizeHex(input) {
  if (!input) return "";
  let s = String(input)
    .trim()
    .replace(/^0x/i, "")
    .replace(/\s+/g, "");       // strip all whitespace
  // Drop a trailing '%' (common when copying from some terminals)
  if (s.endsWith("%")) s = s.slice(0, -1);
  return s;
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
