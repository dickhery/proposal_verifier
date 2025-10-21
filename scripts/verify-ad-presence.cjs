/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');

const FRONTEND_DIR = path.join(__dirname, '..', 'src', 'proposal_verifier_frontend');
const INDEX_HTML = path.join(FRONTEND_DIR, 'index.html');
const ASSETS_POLICY = path.join(FRONTEND_DIR, 'assets', '.ic-assets.json5');

function die(msg) {
  console.error('\n[verify-ads] ' + msg + '\n');
  process.exit(1);
}

function ok(msg) {
  console.log('[verify-ads] ' + msg);
}

if (!fs.existsSync(INDEX_HTML)) die(`Cannot find ${INDEX_HTML}`);

const html = fs.readFileSync(INDEX_HTML, 'utf8');

// Look for the specific library and a data attribute that signals intent.
const HAS_AD_SCRIPT =
  /<script[^>]+src=["']https:\/\/cdn\.jsdelivr\.net\/gh\/dickhery\/Ad-Network-Embed@[^"']+\/ad-network-embed-bundled\.js["'][^>]*>/i.test(
    html,
  ) && /data-(project|site)-id=/i.test(html);

if (!HAS_AD_SCRIPT) {
  die(
    `Ad embed not found in index.html.

Add this (or an allowed functional equivalent) before the root element:

  <script src="https://cdn.jsdelivr.net/gh/dickhery/Ad-Network-Embed@3c07f3bd238b8d7fd516a95ba26cb568ba0e7b3f/ad-network-embed-bundled.js"
          data-project-id="Proposal Verifier"
          data-ad-type="Horizontal Banner Portrait"></script>`,
  );
}

ok('Ad script tag detected in index.html');

if (fs.existsSync(ASSETS_POLICY)) {
  const policy = fs.readFileSync(ASSETS_POLICY, 'utf8');
  const allowsCdn = /cdn\.jsdelivr\.net/.test(policy) || /script-src-elem[^"]+cdn\.jsdelivr\.net/i.test(policy);
  if (!allowsCdn) {
    die(
      `.ic-assets.json5 CSP appears to block cdn.jsdelivr.net. Add it to "script-src-elem" to allow the embed to load.`,
    );
  }
  ok('CSP allows cdn.jsdelivr.net in assets policy');
} else {
  ok('No .ic-assets.json5 found (skipping CSP check)');
}

ok('Ad presence verification passed.');
