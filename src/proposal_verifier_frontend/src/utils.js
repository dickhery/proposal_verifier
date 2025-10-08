export function sha256(message) {
  // Simple SHA256 placeholder; use crypto.subtle in browser for real
  const encoder = new TextEncoder();
  // Note: Browser-only; for full impl, import crypto
  return crypto.subtle.digest('SHA-256', encoder.encode(message)).then(hash => {
    return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
  });
}