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
// ── EL SEGUNDO USUARIO: EL OPERADOR ───────────────────────────────────────────────────────────
// Sólo existe si las DOS variables están puestas. Sin contraseña por defecto a propósito: un
// "operador/operador" que aparece solo porque alguien deployó es una puerta abierta que nadie pidió.
const OPERADOR_USER = process.env.OPERADOR_USER || '';
const OPERADOR_PASSWORD = process.env.OPERADOR_PASSWORD || '';
const HAY_OPERADOR = !!(OPERADOR_USER && OPERADOR_PASSWORD);
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
  // Avisar un pago es parte de la vista cliente: entra con su código y sube el comprobante.
  // Solo puede CREAR uno, y queda pendiente — aprobarlo (que es lo que mueve la deuda) exige
  // estar adentro del panel.
  /^\/api\/comprobante\/?$/,
  // La FACTURA que se le manda al cliente por link. Es pública a propósito: el cliente no tiene
  // usuario. La llave es el token, que es al azar y largo — sin él no se llega a nada, y cada
  // token abre UNA factura de UN cliente, nunca un listado.
  /^\/factura\/[A-Za-z0-9_-]+(\/planilla\.csv)?\/?$/,
  // Lo mismo para la CUENTA DEL MES de un cliente de API (TBS). Mismo razonamiento y misma forma
  // de llave: el token es al azar y largo, abre UNA cuenta de UN mes, y no lleva a ningún listado.
  // Sin esto el link que se le manda al cliente cae en el login — y el cliente no tiene usuario.
  /^\/cuenta\/[A-Za-z0-9_-]+\/?$/,
  /^\/logo\.png$/,
  /^\/favicon\.ico$/,
  // PWA: el navegador pide estos sin cookies → deben ser públicos.
  /^\/sw\.js$/,
  /^\/manifest\.json$/,
  /^\/icon-[\w-]*\.png$/,
];

/**
 * ── QUÉ PUEDE TOCAR EL OPERADOR ───────────────────────────────────────────────────────────────
 *
 * LISTA BLANCA, NO LISTA NEGRA. Todo lo que no esté acá le está prohibido, incluso lo que se
 * agregue mañana. Al revés —prohibir lo conocido— cada ruta nueva nacería abierta, y nadie se
 * acuerda de volver a esta lista al agregar un endpoint.
 *
 * Lo que puede: ver los pedidos, cargarlos, rechazarlos y anularlos, y ver el historial. Eso es
 * despachar, que es para lo que está.
 *
 * Lo que NO puede, y por qué:
 *  · /api/os/*  → el OS comercial y TBS enteros: márgenes, precios, deudas, facturas.
 *  · /api/clientes y /api/systems en crudo → traen `margen_externos_pct`, `tc_proveedor`,
 *    `permite_deuda` y el usuario del casino. Ve una versión recortada por otra ruta.
 *  · aprobar comprobantes → da por cobrada plata que quizás no entró.
 *  · config, backup, restore, credenciales → llaves del negocio.
 */
const OPERADOR_PUEDE = [
  { m: 'GET', re: /^\/api\/pedidos\/?$/ },
  { m: 'GET', re: /^\/api\/pedidos\/[\w-]+\/cascada\/?$/ },
  { m: 'POST', re: /^\/api\/pedidos\/[\w-]+\/(cargar|rechazar|anular|devolver-trabadas)\/?$/ },
  { m: 'GET', re: /^\/api\/historial\/?$/ },
  // la lista recortada de clientes y paneles: sólo lo que hace falta para despachar
  { m: 'GET', re: /^\/api\/despacho\/(clientes|sistemas)\/?$/ },
  // avisos al teléfono: si no los recibe, no se entera de que hay un pedido
  { m: 'GET', re: /^\/api\/push\/vapid-key\/?$/ },
  { m: 'POST', re: /^\/api\/push\/(subscribe|unsubscribe)\/?$/ },
  { m: 'POST', re: /^\/api\/logout\/?$/ },
  { m: 'GET', re: /^\/api\/quien\/?$/ },
];

/** Los archivos de la app (no APIs). El operador entra al operativo y a nada más. */
const OPERADOR_PAGINAS = [/^\/$/, /^\/index\.html$/, /^\/[\w.-]+\.(css|js|png|ico|json|svg|webmanifest)$/];

function puedeOperador(req) {
  const p = req.path;
  if (OPERADOR_PUEDE.some((r) => r.m === req.method && r.re.test(p))) return true;
  if (req.method === 'GET' && OPERADOR_PAGINAS.some((re) => re.test(p))) return true;
  return false;
}

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
  // value = "ok:<issuedAtMs>"  (viejo, sin rol → admin)  |  "ok:<rol>:<issuedAtMs>"
  // ⚠️ El rol va en ASCII. Se llamaba "dueño" y este [a-z] no acepta la ñ: el token no verificaba
  // y TODO daba 401 después de un login exitoso. Los nombres que viajan en una cookie firmada no
  // son texto para leer — para eso está la pantalla.
  const m = /^ok:(?:([a-z]+):)?(\d+)$/.exec(value);
  if (!m) return false;
  const issued = Number(m[2]);
  if (!issued || (Date.now() - issued) > MAX_AGE_MS) return false;
  return { rol: m[1] || 'admin' };
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
  return !!verifyToken(parseCookies(req)[COOKIE]);
}

/** Qué rol trae la sesión. Sin sesión válida devuelve null. */
function rolDe(req) {
  const v = verifyToken(parseCookies(req)[COOKIE]);
  return v ? v.rol : null;
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
  const rol = rolDe(req);
  if (rol === 'operador') {
    if (puedeOperador(req)) return next();
    // Se dice qué pasó, no "no existe": esconderlo no agrega seguridad —el operador tiene una
    // sesión válida— y sí hace que un permiso mal puesto parezca un bug de la app.
    if (req.path.startsWith('/api/')) {
      return res.status(403).json({ ok: false, error: 'Tu usuario sólo puede ver y despachar pedidos.' });
    }
    return res.redirect('/');
  }
  if (rol) return next();
  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ ok: false, error: 'No autorizado. Iniciá sesión.' });
  }
  return res.redirect('/login');
}

/** POST /api/login  { user, password } */
function loginHandler(req, res) {
  const { user, password } = req.body || {};
  let rol = null;
  if (safeEqual(user || '', PANEL_USER) && safeEqual(password || '', PANEL_PASSWORD)) rol = 'admin';
  else if (HAY_OPERADOR && safeEqual(user || '', OPERADOR_USER) && safeEqual(password || '', OPERADOR_PASSWORD)) rol = 'operador';
  if (!rol) {
    return res.status(401).json({ ok: false, error: 'Usuario o contraseña incorrectos' });
  }
  const token = sign(`ok:${rol}:${Date.now()}`);
  const attrs = [
    `${COOKIE}=${encodeURIComponent(token)}`,
    'HttpOnly',
    'Path=/',
    'SameSite=Lax',
    `Max-Age=${Math.floor(MAX_AGE_MS / 1000)}`,
  ];
  if (isSecure(req)) attrs.push('Secure');
  res.setHeader('Set-Cookie', attrs.join('; '));
  res.json({ ok: true, rol });
}

/** POST /api/logout */
function logoutHandler(req, res) {
  const attrs = [`${COOKIE}=`, 'HttpOnly', 'Path=/', 'SameSite=Lax', 'Max-Age=0'];
  if (isSecure(req)) attrs.push('Secure');
  res.setHeader('Set-Cookie', attrs.join('; '));
  res.json({ ok: true });
}

module.exports = { required, loginHandler, logoutHandler, isAuthed, rolDe, puedeOperador,
  USING_DEFAULT_PASSWORD, PANEL_USER, HAY_OPERADOR };
