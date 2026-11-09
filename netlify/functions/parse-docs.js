// AI document parser proxy: forwards a signed-in user's request to the Anthropic API.
//
// Access control (all three must pass):
//   1. The request carries a valid Firebase ID token for this project (Authorization: Bearer <token>).
//   2. That account's email is in ALLOWED_EMAILS (comma-separated Netlify env var). If the var is
//      missing, every request is refused (fail closed).
//   3. Browser requests must come from one of ALLOWED_ORIGINS.
//
// Env vars: ANTHROPIC_API_KEY (required), ALLOWED_EMAILS (required),
//           ALLOWED_ORIGINS, ANTHROPIC_MODEL, FIREBASE_WEB_API_KEY (optional overrides).
const https = require('https');

const DEFAULT_ORIGINS = [
  'https://ap-warehouse-management.netlify.app',
  'https://main--ap-warehouse-management.netlify.app',
  'https://wm.venzaura.com',
];
// Public Firebase web API key (same value the app ships in index.html); used only to verify ID tokens.
const DEFAULT_FIREBASE_WEB_API_KEY = 'AIzaSyCpMhFNUUTGi5CGNuZSuIsRgMCVcov8n9Y';
const DEFAULT_MODEL = 'claude-sonnet-5-5'; // claude-sonnet-4-20250514 was retired (API returned 404 not_found_error)

const list = v => (v || '').split(',').map(s => s.trim()).filter(Boolean);
const ALLOWED_ORIGINS = list(process.env.ALLOWED_ORIGINS).length ? list(process.env.ALLOWED_ORIGINS) : DEFAULT_ORIGINS;
const ALLOWED_EMAILS = list(process.env.ALLOWED_EMAILS).map(e => e.toLowerCase());
const FIREBASE_WEB_API_KEY = process.env.FIREBASE_WEB_API_KEY || DEFAULT_FIREBASE_WEB_API_KEY;
const MODEL = process.env.ANTHROPIC_MODEL || DEFAULT_MODEL;

function postJson(hostname, path, payload, extraHeaders, timeoutMs) {
  const data = JSON.stringify(payload);
  return new Promise(resolve => {
    const req = https.request({
      hostname, port: 443, path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...extraHeaders },
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', e => resolve({ status: 0, body: JSON.stringify({ error: e.message }) }));
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve({ status: 0, body: JSON.stringify({ error: 'Timeout' }) }); });
    req.write(data);
    req.end();
  });
}

// Returns the account's email if the Firebase ID token is valid for this project, else null.
async function verifyFirebaseToken(idToken) {
  if (!idToken) return null;
  const r = await postJson(
    'identitytoolkit.googleapis.com',
    '/v1/accounts:lookup?key=' + encodeURIComponent(FIREBASE_WEB_API_KEY),
    { idToken },
    { Referer: DEFAULT_ORIGINS[0] + '/' },
    8000
  );
  if (r.status !== 200) return null;
  try {
    const user = (JSON.parse(r.body).users || [])[0];
    return user && user.email ? String(user.email).toLowerCase() : null;
  } catch (e) {
    return null;
  }
}

exports.handler = async function (event) {
  const hdr = event.headers || {};
  const origin = hdr.origin || hdr.Origin || '';
  const originAllowed = !origin || ALLOWED_ORIGINS.includes(origin);
  const headers = {
    'Content-Type': 'application/json',
    'Vary': 'Origin',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
  if (origin && originAllowed) headers['Access-Control-Allow-Origin'] = origin;
  const reply = (statusCode, obj) => ({ statusCode, headers, body: JSON.stringify(obj) });

  if (event.httpMethod === 'OPTIONS') return { statusCode: originAllowed ? 204 : 403, headers, body: '' };
  if (event.httpMethod !== 'POST') return reply(405, { error: 'Method not allowed' });
  if (!originAllowed) return reply(403, { error: 'Origin not allowed' });

  // Authenticate before reading or forwarding anything.
  const auth = hdr.authorization || hdr.Authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  const email = await verifyFirebaseToken(token);
  if (!email) return reply(401, { error: 'Sign in required' });
  if (!ALLOWED_EMAILS.length) return reply(403, { error: 'AI reader is locked: ALLOWED_EMAILS is not set in Netlify' });
  if (!ALLOWED_EMAILS.includes(email)) return reply(403, { error: 'This account is not allowed to use the AI reader' });

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch (e) { return reply(400, { error: 'Bad JSON' }); }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (body._ping) return reply(200, { status: 'ok', keySet: !!apiKey });
  if (!apiKey) return reply(500, { error: 'ANTHROPIC_API_KEY not set' });
  if (!Array.isArray(body.messages) || !body.messages.length) return reply(400, { error: 'messages required' });

  const r = await postJson(
    'api.anthropic.com',
    '/v1/messages',
    { model: MODEL, max_tokens: 4000, system: typeof body.system === 'string' ? body.system : '', messages: body.messages },
    { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'anthropic-beta': 'pdfs-2024-09-25' },
    25000
  );
  return { statusCode: r.status || 500, headers, body: r.body };
};
