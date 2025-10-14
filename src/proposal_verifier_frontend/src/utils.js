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
    // Try to stringify objects as a convenience
    data = new TextEncoder().encode(String(message));
  }

  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function parseEscapedToBytes(escaped) {
  const out = [];
  let i = 0;
  const n = escaped.length;
  while (i < n) {
    if (escaped[i] === '\\') {
      i++;
      if (i < n && escaped[i] === 'x') {
        i++;
        if (i + 1 < n) {
          const hex = escaped.substr(i, 2);
          out.push(parseInt(hex, 16));
          i += 2;
          continue;
        }
      } else {
        // Other escapes (e.g. \n), but for blob assume mostly \x
        out.push(escaped.charCodeAt(i));
        i++;
      }
    } else {
      out.push(escaped.charCodeAt(i));
      i++;
    }
  }
  return new Uint8Array(out);
}

export function bytesToHex(bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}