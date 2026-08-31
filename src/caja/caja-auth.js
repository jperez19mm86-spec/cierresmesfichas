/**
 * caja-auth.js — sesión de MI CAJA: el panel simple para agentes y cajeros.
 *
 * La identidad la manda el casino: el cliente entra con el MISMO usuario y clave que usa en el
 * panel de siempre. Acá no hay usuarios propios, ni altas, ni "olvidé mi contraseña".
 *
 * 🔑 Cómo se autentica (medido el 27-ago-2026 contra admin.ganamos-lat.com):
 *   1. La clave VERIFICA quién es — una sola vez, contra `area=login` del motor.
 *   2. De ahí en más se trabaja con el `api_token` de esa cuenta, que es sessionless.
 *   3. Las dos pantallas de Seguridad —cruces de IP e historial de cambios— NO funcionan con
 *      token (`0` resultados, probado con parámetros en body, en query y sin fechas), así que
 *      ésas usan la sesión del motor, que se guarda junto con el resto.
 *
 * ⚠️ La contraseña del casino NUNCA se guarda: se usa para el login y se descarta. Lo que queda
 *    en la cookie es un identificador de sesión firmado; los secretos del motor viven en memoria
 *    del proceso y se pierden al reiniciar (el cliente vuelve a entrar, y listo).
 */
const crypto = require('crypto');
const { makeClient } = require('../casino-api');
const { asegurarToken } = require('./caja-token');

const COOKIE = 'caja_sid';
const VIDA_MS = 1000 * 60 * 60 * 12;          // 12 h: un turno largo, no una semana
const SECRETO = process.env.SESSION_SECRET || 'dev-insecure-secret-cambiar-en-prod';

/* Las sesiones vivas, en memoria. Guardan el cliente del motor ya armado —con su cookie
   PHPSESSID adentro— para no volver a loguear en cada llamada. */
const vivas = new Map();

const firma = (v) => crypto.createHmac('sha256', SECRETO).update(v).digest('base64url');
const armar = (sid) => `${sid}.${firma(sid)}`;
function abrir(valor) {
  const i = String(valor || '').lastIndexOf('.');
  if (i < 1) return null;
  const sid = valor.slice(0, i);
  const esperada = firma(sid);
  const dada = valor.slice(i + 1);
  /* Comparación de tiempo constante: con === se puede adivinar la firma byte por byte. */
  if (dada.length !== esperada.length) return null;
  return crypto.timingSafeEqual(Buffer.from(dada), Buffer.from(esperada)) ? sid : null;
}

function leerCookie(req, nombre) {
  const crudo = req.headers.cookie || '';
  for (const parte of crudo.split(';')) {
    const [k, ...v] = parte.trim().split('=');
    if (k === nombre) return decodeURIComponent(v.join('='));
  }
  return null;
}

function limpiarVencidas() {
  const ahora = Date.now();
  for (const [sid, s] of vivas) if (s.vence <= ahora) vivas.delete(sid);
}

/**
 * Entra con las credenciales del casino y deja la sesión lista.
 * @param {{url:string, user:string, password:string, token?:string}} datos
 * @returns {Promise<{ok:boolean, error?:string, sesion?:object}>}
 */
async function entrar({ url, user, password, token, raiz = null, generar = true }) {
  if (!url) return { ok: false, error: 'falta la URL del casino' };
  if (!user || !password) return { ok: false, error: 'usuario y contraseña son obligatorios' };

  /* El login valida la identidad. Se usa sesión a propósito: es lo único que prueba que la
     persona sabe la clave — un token cualquiera no dice quién la escribió. */
  const conSesion = makeClient({ url, user, password });
  const t0 = Date.now();
  const info = await conSesion.apiCall('info');
  const tInfo = Date.now() - t0;
  if (!info.ok) {
    return { ok: false, error: info.error === 'sesión expirada / login inválido'
      ? 'Usuario o contraseña incorrectos' : (info.error || 'no se pudo entrar al casino') };
  }

  const main = (info.data && info.data.main) || {};
  const ficha = (info.data && info.data.editUser) || {};
  const group = String(main.group || '');

  /* 🔒 Mi Caja es SÓLO para agentes (3), cajeros (4), sub-agentes (6) y sub-cajeros (8).
     Un jugador no entra acá, y un distribuidor tampoco: para eso está el panel del motor. */
  const PERMITIDOS = { 3: 'agente', 4: 'cajero', 6: 'subagente', 8: 'subcajero' };
  if (!PERMITIDOS[group]) {
    return { ok: false, error: 'Esta cuenta no usa Mi Caja. Entrá por el panel de siempre.' };
  }

  /* ⭐ EL TOKEN DEL CLIENTE, buscado con la credencial raíz.
     Una cuenta no puede administrarse a sí misma (medido: `usersettings` sobre uno mismo devuelve
     HTML), así que el token se consigue desde arriba. Y como esa credencial llega a toda la red
     —un distribuidor leyó la configuración de un nieto—, con una sola alcanza.
     Si ya tiene token se LEE y no se toca nada; sólo se genera cuando está apagado. */
  let tokenPropio = token || null;
  let tokenGenerado = false;
  const t1 = Date.now();
  if (!tokenPropio && raiz) {
    const r = await asegurarToken(raiz, ficha.id || main.id, { permitirGenerar: generar });
    if (r.ok) { tokenPropio = r.token; tokenGenerado = r.generado; }
    else console.warn('[caja] sin token para', user, '→', r.error, '· se sigue con la sesión');
  }

  const sid = crypto.randomBytes(24).toString('base64url');
  const sesion = {
    sid,
    /* ⚡ El saldo ya vino en este mismo `info`: guardarlo evita que el panel lo pregunte otra vez
       apenas entra. Eran ~250 ms de una llamada idéntica a la que acabamos de hacer.
       Se guarda SÓLO para el arranque — de ahí en más `/yo` lo relee, porque cambia. */
    balanceInicial: Number((info.data.main || {}).balance) || 0,
    login: ficha.login || main.login || user,
    id: String(ficha.id || ''),
    group,
    rol: PERMITIDOS[group],
    moneda: main.currency || (Object.keys(main.balances || {})[0]) || '',
    url,
    /* El cliente con sesión queda vivo para lo que el token no puede: Seguridad. */
    conSesion,
    /* Y el de token, para todo lo demás. Si la cuenta no tiene token, se usa la sesión igual:
       anda, sólo que caduca. */
    conToken: tokenPropio ? makeClient({ url, token: tokenPropio }) : null,
    tokenGenerado,
    vence: Date.now() + VIDA_MS,
  };
  console.log('[caja/entrar] %s · login+info %s ms · token %s ms · TOTAL %s ms',
    user, tInfo, Date.now() - t1, Date.now() - t0);
  vivas.set(sid, sesion);
  limpiarVencidas();
  return { ok: true, sesion };
}

/** El cliente del motor que corresponde a cada pantalla. */
function clienteDe(sesion, { auditoria = false } = {}) {
  if (auditoria) return sesion.conSesion;        // cruces de IP e historial de cambios
  return sesion.conToken || sesion.conSesion;    // todo lo operativo
}

/** Middleware: exige sesión de Mi Caja. Responde 401 en JSON, nunca redirige. */
function requerida(req, res, next) {
  const bruto = leerCookie(req, COOKIE);
  const sid = bruto && abrir(bruto);
  const s = sid && vivas.get(sid);
  if (!s || s.vence <= Date.now()) {
    if (s) vivas.delete(sid);
    return res.status(401).json({ ok: false, error: 'sesión vencida', relogin: true });
  }
  s.vence = Date.now() + VIDA_MS;               // se renueva mientras trabaja
  req.caja = s;
  next();
}

function ponerCookie(res, sid) {
  const partes = [`${COOKIE}=${encodeURIComponent(armar(sid))}`, 'Path=/', 'HttpOnly',
    'SameSite=Lax', `Max-Age=${Math.floor(VIDA_MS / 1000)}`];
  if (process.env.NODE_ENV === 'production') partes.push('Secure');
  res.append('Set-Cookie', partes.join('; '));
}

function borrarCookie(res) {
  res.append('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

function salir(req) {
  const bruto = leerCookie(req, COOKIE);
  const sid = bruto && abrir(bruto);
  if (sid) vivas.delete(sid);
}

/** Lo que se le puede contar al navegador: nunca la url, el token ni el cliente. */
const publica = (s) => ({ login: s.login, id: s.id, group: s.group, rol: s.rol, moneda: s.moneda,
  /* Para saber, del lado del panel, si Seguridad va a andar: necesita sesión, no token. */
  conToken: !!s.conToken });

module.exports = { entrar, salir, requerida, clienteDe, ponerCookie, borrarCookie, publica, COOKIE };
