// src/proposal_verifier_frontend/src/icApi.js

// Fetch the proposal JSON (as object + raw text)
export async function fetchProposalJson(id) {
  const url = `https://ic-api.internetcomputer.org/api/v3/proposals/${id}`;
  const res = await fetch(url, { credentials: 'omit', mode: 'cors' });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch (err) {
    // ignore parse errors; caller can fall back to raw text
  }
  return { json, text };
}

// Walk any JSON-looking object to find the human-readable payload rendering
export function extractPayloadRendering(source) {
  const keys = ['payload_text_rendering', 'payloadTextRendering', 'payload_rendering'];

  let root = source;
  if (typeof source === 'string') {
    try {
      root = JSON.parse(source);
    } catch (err) {
      return null;
    }
  }
  if (!root || typeof root !== 'object') return null;

  const seen = new Set();
  const stack = [root];

  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== 'object') continue;
    if (seen.has(node)) continue;
    seen.add(node);

    // Preferred keys first
    for (const k of keys) {
      if (Object.prototype.hasOwnProperty.call(node, k)) {
        const v = node[k];
        if (typeof v === 'string' && v.trim()) return v.trim();
      }
    }

    // Fallback: sometimes 'payload' is already a string, or a small object
    if (Object.prototype.hasOwnProperty.call(node, 'payload')) {
      const v = node.payload;
      if (typeof v === 'string' && v.trim()) return v.trim();
      if (v && typeof v === 'object') {
        try {
          return JSON.stringify(v, null, 2);
        } catch (err) {
          // ignore stringify issues
        }
      }
    }

    for (const v of Object.values(node)) {
      if (v && typeof v === 'object') stack.push(v);
    }
  }
  return null;
}

// Last-chance fetchers some deployments use
export async function fetchPayloadEndpoint(id) {
  const candidates = [
    `https://ic-api.internetcomputer.org/api/v3/proposals/${id}/payload`,
    `https://ic-api.internetcomputer.org/api/v3/proposals/${id}?include=payload_text_rendering`,
  ];
  for (const url of candidates) {
    try {
      const r = await fetch(url, { credentials: 'omit', mode: 'cors' });
      if (!r.ok) continue;
      const text = await r.text();
      try {
        const j = JSON.parse(text);
        const s = extractPayloadRendering(j);
        if (s) return s;
      } catch (err) {
        if (text.trim()) return text.trim();
      }
    } catch (err) {
      // ignore network failures and keep trying other endpoints
    }
  }
  return null;
}
