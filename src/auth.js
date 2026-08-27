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
  // Pedir mover fichas de un panel propio a otro es parte de la vista cliente, por el mismo
  // razonamiento: sólo puede CREAR el pedido, que no mueve nada. Ejecutarlo —que sí mueve fichas—
  // exige estar adentro del panel, y encima el cliente tiene que tener el permiso `mover_balance`,
  // que se comprueba en el servidor y no escondiendo el botón.
  /^\/api\/movimiento-panel(\/|$)/,
  // La cuenta del cliente: entra con SU usuario y contraseña, no con la sesión del panel. La ruta
  // es pública pero el dato no: sin un token de cliente válido, /api/cuenta/mio contesta 401.
  /^\/api\/cuenta(\/|$)/,
  /^\/cuenta\/?$/,
  // La FACTURA que se le manda al cliente por link. Es pública a propósito: el cliente no tiene
  // usuario. La llave es el token, que es al azar y largo — sin él no se llega a nada, y cada
  // token abre UNA factura de UN cliente, nunca un listado.
  /^\/factura\/[A-Za-z0-9_-]+(\/planilla\.csv)?\/?$/,
  // Lo mismo para la CUENTA DEL MES de un cliente de API (TBS). Mismo razonamiento y misma forma
  // de llave: el token es al azar y largo, abre UNA cuenta de UN mes, y no lleva a ningún listado.
  // Sin esto el link que se le manda al cliente cae en el login — y el cliente no tiene usuario.
  /^\/cuenta\/[A-Za-z0-9_-]+\/?$/,
  /* Y lo mismo para la hoja del CHAT EXTERNO, con una diferencia: además de leerla, el cliente
     puede avisar que pagó (…/pague). Sólo puede CREAR el aviso, que no mueve el saldo — acreditarlo
     exige estar adentro del panel, igual que con los comprobantes de fichas. El token es al azar y
     largo, abre UNA hoja de UN cliente y no lleva a ningún listado.
     Sin esto el link cae en el login, y el cliente no tiene usuario. */
  /^\/chat\/?$/,
  /^\/chat\/(entrar|aviso|nuevo|accesos)\/?$/,
  /^\/chat\/[A-Za-z0-9_-]+(\/pague)?\/?$/,
  /^\/ganamos\.html$/,
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
  // 'destrabar' entra en lo que puede el operador: es despachar. No mueve fichas — devuelve a
  // 'pendiente' un pedido que quedó tomado por un corte, y el store no lo deja si la carga vive.
  { m: 'POST', re: /^\/api\/pedidos\/[\w-]+\/(cargar|rechazar|anular|devolver-trabadas|destrabar)\/?$/ },
  { m: 'GET', re: /^\/api\/historial\/?$/ },
  // la lista recortada de clientes y paneles: sólo lo que hace falta para despachar
  { m: 'GET', re: /^\/api\/despacho\/(clientes|sistemas|solicitudes-caja)\/?$/ },
  // Puede PEDIR que se abra una caja, no crearla: eso lo aprueba el dueño.
  { m: 'POST', re: /^\/api\/despacho\/solicitud-caja\/?$/ },
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

/**
 * ── TOKEN DE CLIENTE ─────────────────────────────────────────────────────────────────────────
 *
 * Otra familia de token, a propósito. Va con el prefijo `cli:` y se verifica con una función
 * distinta, así que un token de cliente NO puede entrar al OS ni al revés — aunque los dos usen el
 * mismo secreto. Sin ese prefijo, un bug de parseo convertiría a un cliente en administrador.
 *
 * Dura una semana: es su cuenta, no una sesión operativa, y pedirle la clave todos los días para
 * mirar un saldo termina en una clave escrita en un papel.
 */
/* Y SE RENUEVA SOLA MIENTRAS LA USE. Con 7 días fijos, el cliente que entra todos los días igual
   volvía al formulario cada semana — y una clave que hay que escribir seguido termina anotada en un
   papel o en el chat. Ahora vale 60 días desde la última vez que entró: el que la usa no la escribe
   nunca más, y el que no aparece en dos meses sí. */
const CLIENTE_TTL_MS = 60 * 24 * 60 * 60 * 1000;
/* Pasada la mitad de la vida se le manda uno nuevo, para que no se le venza a alguien que está
   entrando seguido. Antes no se renovaba nunca: el reloj arrancaba en el login y no se movía más. */
const CLIENTE_RENOVAR_MS = 30 * 24 * 60 * 60 * 1000;

function firmarCliente(clienteId) {
  const value = `cli:${clienteId}:${Date.now()}`;
  const mac = crypto.createHmac('sha256', SESSION_SECRET).update(value).digest('hex');
  return value + '.' + mac;
}

/** El id del cliente que trae la request, o null. Lee el header o el cuerpo, nunca una cookie. */
function clienteDeToken(req) {
  // ── DE DÓNDE SE SACA EL TOKEN ──────────────────────────────────────────────────────────────
  // `Authorization: Bearer …` es la forma estándar y es la que manda cualquier cliente que se
  // escriba. Al principio sólo se leía `x-cuenta`, y el resultado fue el peor de los posibles: el
  // login entraba —devolvía el token y todo— y el pedido siguiente contestaba 401, así que la
  // pantalla volvía sola al formulario. Para quien lo usaba, "el botón no hace nada".
  // Se siguen aceptando las otras dos formas: ya estaban y no molestan.
  const auth = String((req.headers && (req.headers.authorization || req.headers.Authorization)) || '').trim();
  const bearer = /^Bearer\s+(.+)$/i.exec(auth);
  const raw = String((bearer && bearer[1])
    || (req.headers && req.headers['x-cuenta'])
    || (req.body && req.body.token) || '').trim();
  if (!raw || !raw.includes('.')) return null;
  const i = raw.lastIndexOf('.');
  const value = raw.slice(0, i); const mac = raw.slice(i + 1);
  const esperado = crypto.createHmac('sha256', SESSION_SECRET).update(value).digest('hex');
  if (mac.length !== esperado.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(esperado))) return null;
  const m = /^cli:([\w-]+):(\d+)$/.exec(value);
  if (!m) return null;
  const emitido = Number(m[2]);
  if (Date.now() - emitido > CLIENTE_TTL_MS) return null;
  /* ⚠️ EL CORTE. Sacarle el acceso a un cliente —o cambiarle la clave— tiene que echarlo YA. Sin
     esto, el token seguía firmado y válido: "le saqué el acceso" era mentira hasta que venciera
     solo. Ahora un token emitido antes del corte no vale, y el que tenía la sesión puesta en el
     teléfono queda afuera en el momento. */
  try {
    const { corte, habilitado } = require('./cliente-acceso').corteDe(m[1]);
    if (!habilitado) return null;
    if (corte && emitido < corte) return null;
  } catch (e) { /* si no se puede consultar, manda la firma y el vencimiento */ }
  return m[1];
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

/** Lo que ve el operador cuando toca una parte que no le corresponde. */
function paginaSinPermiso() {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>Sin permiso</title>
    <style>
      body{font:15px/1.6 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#2b2230;background:#fdf7fb;
           display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:24px}
      .c{max-width:440px;background:#fff;border:1px solid #ead6e6;border-radius:12px;padding:26px 28px;
         box-shadow:0 1px 3px rgba(0,0,0,.05)}
      h1{font-size:19px;margin:0 0 8px}
      p{margin:0 0 14px;color:#5c4f57}
      a{display:inline-block;padding:9px 16px;background:#c456ad;color:#fff;text-decoration:none;border-radius:7px;font-weight:600}
    </style></head><body><div class="c">
    <h1>🔒 No tenés permiso para entrar acá</h1>
    <p>Tu usuario puede <b>ver y aceptar pedidos</b> únicamente.</p>
    <p style="font-size:13px">Si necesitás entrar, comunicate con Alexa.</p>
    <a href="/">← Volver a los pedidos</a>
    </div></body></html>`;
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
      return res.status(403).json({ ok: false,
        error: 'Tu usuario puede ver y aceptar pedidos únicamente. Si necesitás entrar, comunicate con Alexa.' });
    }
    // Una PÁGINA, no un redirect. Mandarlo de vuelta al inicio en silencio parece que el botón
    // está roto: aprieta Comercial y vuelve a donde estaba, sin saber por qué. Que diga qué pasó.
    return res.status(403).type('html').send(paginaSinPermiso());
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
  firmarCliente, clienteDeToken, CLIENTE_RENOVAR_MS,
  USING_DEFAULT_PASSWORD, PANEL_USER, HAY_OPERADOR };
