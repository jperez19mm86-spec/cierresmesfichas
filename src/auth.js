/**
 * auth.js — login del PANEL por usuario + contraseña (cookie de sesión firmada).
 *
 * - Usuario/clave salen de variables de entorno (NO se hardcodean ni van al repo):
 *     PANEL_USER       (default "admin")
 *     PANEL_PASSWORD   (si no se setea → "admin" con advertencia; ¡setearla en producción!)
 *     SESSION_SECRET   (clave para firmar la cookie; setearla en producción)
 *
 * - La VISTA CLIENTE (/pedir, /api/pedir) queda PÚBLICA: el cliente solo entra su código,
 *   no necesita login. Solo el panel de admin (y sus APIs) pide usuario+contraseña.
 */
const crypto = require('crypto');

const COOKIE = 'vf_session';
const MAX_AGE_MS = 1000 * 60 * 60 * 24 * 7; // 7 días

const PANEL_USER = process.env.PANEL_USER || 'admin';
const PANEL_PASSWORD = process.env.PANEL_PASSWORD || 'admin';
const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-insecure-secret-cambiar-en-prod';
const USING_DEFAULT_PASSWORD = !process.env.PANEL_PASSWORD;

// Rutas públicas (sin login): vista cliente + login + assets mínimos.
const PUBLIC = [
  /^\/login\/?$/,
  /^\/api\/login\/?$/,
  /^\/api\/logout\/?$/,
  /^\/pedir\/?$/,
  /^\/api\/pedir(\/|$)/,
  /^\/logo\.png$/,
  /^\/favicon\.ico$/,
  // PWA: el navegador pide estos sin cookies → deben ser públicos.
  /^\/sw\.js$/,
  /^\/manifest\.json$/,
  /^\/icon-[\w-]*\.png$/,
];

function sign(value) {
  const mac = crypto.createHmac('sha256', SESSION_SECRET).update(value).digest('hex');
  return value + '.' + mac;
}

function verifyToken(token) {
  if (!token || typeof token !== 'string') return false;
  const i = token.lastIndexOf('.');
  if (i <= 0) return false;
  const value = token.slice(0, i);
  const mac = token.slice(i + 1);
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(value).digest('hex');
  if (mac.length !== expected.length) return false;
  let ok = false;
  try { ok = crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected)); } catch (e) { return false; }
  if (!ok) return false;
  // value = "ok:<issuedAtMs>"
  const m = /^ok:(\d+)$/.exec(value);
  if (!m) return false;
  const issued = Number(m[1]);
  if (!issued || (Date.now() - issued) > MAX_AGE_MS) return false;
  return true;
}

function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie;
  if (!raw) return out;
  raw.split(';').forEach((part) => {
    const idx = part.indexOf('=');
    if (idx > 0) out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  });
  return out;
}

function isAuthed(req) {
  return verifyToken(parseCookies(req)[COOKIE]);
}

// Comparación de strings en tiempo constante (evita timing attacks).
function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function isSecure(req) {
  return req.secure || req.headers['x-forwarded-proto'] === 'https';
}

/** Middleware: protege todo salvo las rutas públicas. */
function required(req, res, next) {
  if (req.method === 'OPTIONS') return next();
  if (PUBLIC.some((re) => re.test(req.path))) return next();
  if (isAuthed(req)) return next();
  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ ok: false, error: 'No autorizado. Iniciá sesión.' });
  }
  return res.redirect('/login');
}

/** POST /api/login  { user, password } */
function loginHandler(req, res) {
  const { user, password } = req.body || {};
  const okUser = safeEqual(user || '', PANEL_USER);
  const okPass = safeEqual(password || '', PANEL_PASSWORD);
  if (!okUser || !okPass) {
    return res.status(401).json({ ok: false, error: 'Usuario o contraseña incorrectos' });
  }
  const token = sign('ok:' + Date.now());
  const attrs = [
    `${COOKIE}=${encodeURIComponent(token)}`,
    'HttpOnly',
    'Path=/',
    'SameSite=Lax',
    `Max-Age=${Math.floor(MAX_AGE_MS / 1000)}`,
  ];
  if (isSecure(req)) attrs.push('Secure');
  res.setHeader('Set-Cookie', attrs.join('; '));
  res.json({ ok: true });
}

/** POST /api/logout */
function logoutHandler(req, res) {
  const attrs = [`${COOKIE}=`, 'HttpOnly', 'Path=/', 'SameSite=Lax', 'Max-Age=0'];
  if (isSecure(req)) attrs.push('Secure');
  res.setHeader('Set-Cookie', attrs.join('; '));
  res.json({ ok: true });
}

module.exports = { required, loginHandler, logoutHandler, isAuthed, USING_DEFAULT_PASSWORD, PANEL_USER };
