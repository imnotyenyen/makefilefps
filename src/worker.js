/* =========================================================
   YOUNJ CONFIG WORKER
   Endpoints:
     GET  /config   → public config (maintenance + meta)
     POST /auth     → { password } → { ok, token? }
     POST /verify   → { token } → { valid }
   ========================================================= */

import CONFIG from './config.json';

const TOKEN_TTL_MS = 2 * 60 * 60 * 1000;   // Token sống 2h
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_LOCK_MINUTES = 3;

export default {
  async fetch(request, env) {
    const cors = buildCors();
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    try {
      if (path === '/config' && request.method === 'GET') {
        return handleConfig(cors);
      }
      if (path === '/auth' && request.method === 'POST') {
        return await handleAuth(request, env, cors);
      }
      if (path === '/verify' && request.method === 'POST') {
        return await handleVerify(request, env, cors);
      }
      return json({ ok: false, error: 'not_found' }, 404, cors);
    } catch (e) {
      return json({ ok: false, error: 'server_error', msg: e.message }, 500, cors);
    }
  }
};

/* ---------- CORS ---------- */
function buildCors() {
  const origin = CONFIG.allowedOrigin || '*';
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  };
}
function json(data, status, cors) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: {
      ...cors,
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    }
  });
}

/* ---------- GET /config ---------- */
function handleConfig(cors) {
  const auth = CONFIG.auth || {};
  return json({
    maintenance: CONFIG.maintenance || { enabled: false },
    auth: {
      maxAttempts: Number(auth.maxAttempts) || DEFAULT_MAX_ATTEMPTS,
      lockMinutes: Number(auth.lockMinutes) || DEFAULT_LOCK_MINUTES,
      mode: Array.isArray(auth.passwords) && auth.passwords.length ? 'plain' : 'none'
    }
  }, 200, cors);
}

/* ---------- POST /auth ---------- */
async function handleAuth(request, env, cors) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const rateKey = 'rate:' + ip;

  const rl = await readRate(env, rateKey);
  if (rl.lockUntil && rl.lockUntil > Date.now()) {
    return json({
      ok: false,
      reason: 'locked',
      remainSeconds: Math.ceil((rl.lockUntil - Date.now()) / 1000)
    }, 200, cors);
  }

  let body;
  try { body = await request.json(); }
  catch { return json({ ok: false, reason: 'bad_request' }, 400, cors); }

  const password = String(body.password || '').slice(0, 200);
  if (!password) return json({ ok: false, reason: 'empty' }, 200, cors);

  const auth = CONFIG.auth || {};
  const maxAttempts = Number(auth.maxAttempts) || DEFAULT_MAX_ATTEMPTS;
  const lockMs = (Number(auth.lockMinutes) || DEFAULT_LOCK_MINUTES) * 60 * 1000;

  let valid = false;
  if (Array.isArray(auth.passwords) && auth.passwords.length) {
    valid = auth.passwords.some(x => timingSafeEqual(String(x), password));
  }

  if (valid) {
    await writeRate(env, rateKey, { attempts: 0, lockUntil: 0 }, 120);
    const token = await signToken(env, {
      iat: Date.now(),
      exp: Date.now() + TOKEN_TTL_MS,
      ip
    });
    return json({
      ok: true,
      token,
      expiresIn: Math.floor(TOKEN_TTL_MS / 1000)
    }, 200, cors);
  }

  const attempts = rl.attempts + 1;
  let lockUntil = 0;
  if (attempts >= maxAttempts) {
    lockUntil = Date.now() + lockMs;
  }

  await writeRate(env, rateKey, {
    attempts: lockUntil ? 0 : attempts,
    lockUntil
  }, Math.max(120, Math.ceil(lockMs / 1000) + 120));

  return json({
    ok: false,
    reason: lockUntil ? 'locked' : 'invalid',
    remainAttempts: lockUntil ? 0 : Math.max(0, maxAttempts - attempts),
    remainSeconds: lockUntil ? Math.ceil(lockMs / 1000) : 0
  }, 200, cors);
}

/* ---------- POST /verify ---------- */
async function handleVerify(request, env, cors) {
  let body;
  try { body = await request.json(); }
  catch { return json({ valid: false }, 400, cors); }
  const result = await verifyToken(env, String(body.token || ''));
  return json(result, 200, cors);
}

/* ---------- Rate limit (KV + fallback in-memory) ---------- */
const memRate = new Map();

async function readRate(env, key) {
  if (env.RATE_LIMIT) {
    try {
      const raw = await env.RATE_LIMIT.get(key);
      if (raw) return JSON.parse(raw);
    } catch {}
  }
  const m = memRate.get(key);
  if (m && (!m.lockUntil || m.lockUntil > Date.now())) return m;
  return { attempts: 0, lockUntil: 0 };
}
async function writeRate(env, key, data, ttl) {
  if (env.RATE_LIMIT) {
    try {
      await env.RATE_LIMIT.put(key, JSON.stringify(data), { expirationTtl: ttl });
      return;
    } catch {}
  }
  memRate.set(key, data);
}

/* ---------- Crypto ---------- */
function timingSafeEqual(a, b) {
  a = String(a); b = String(b);
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

async function signToken(env, payload) {
  const secret = env.TOKEN_SECRET;
  if (!secret || secret.length < 16) throw new Error('weak_token_secret');
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const payloadStr = b64urlEncode(JSON.stringify(payload));
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(payloadStr));
  return payloadStr + '.' + b64urlEncodeBytes(new Uint8Array(sig));
}

async function verifyToken(env, token) {
  if (!token || typeof token !== 'string') return { valid: false };
  const parts = token.split('.');
  if (parts.length !== 2) return { valid: false };
  const secret = env.TOKEN_SECRET;
  if (!secret) return { valid: false };

  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']
  );

  let sigBytes;
  try { sigBytes = b64urlDecodeBytes(parts[1]); }
  catch { return { valid: false }; }

  let ok = false;
  try {
    ok = await crypto.subtle.verify('HMAC', key, sigBytes, enc.encode(parts[0]));
  } catch { return { valid: false }; }
  if (!ok) return { valid: false };

  try {
    const payload = JSON.parse(b64urlDecode(parts[0]));
    if (!payload.exp || payload.exp < Date.now()) {
      return { valid: false, reason: 'expired' };
    }
    return { valid: true, exp: payload.exp };
  } catch { return { valid: false }; }
}

/* ---------- base64url helpers ---------- */
function b64urlEncode(str) {
  return btoa(unescape(encodeURIComponent(str)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return decodeURIComponent(escape(atob(str)));
}
function b64urlEncodeBytes(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecodeBytes(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
