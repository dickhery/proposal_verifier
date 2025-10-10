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