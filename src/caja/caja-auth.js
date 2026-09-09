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
/* 🔴 SIN CLAVE PROPIA, LA COOKIE SE FIRMA CON UN TEXTO QUE ESTÁ EN ESTE ARCHIVO. Cualquiera que
   lea el código puede fabricar una cookie válida. Y encima esa misma clave cifra las sesiones
   guardadas en disco, así que también quedarían cifradas con algo público.
   Antes esto caía a un valor por defecto y el sistema arrancaba igual, sin decir nada. Ahora en
   producción NO ARRANCA: fallar al arrancar se ve enseguida; andar mal en silencio, no. En
   desarrollo se sigue permitiendo, con aviso, para no obligar a configurar nada en la máquina. */
const SECRETO = process.env.SESSION_SECRET || (() => {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('SESSION_SECRET no está configurada. Sin ella la cookie de sesión se firma con '
      + 'una clave escrita en el código fuente y las sesiones guardadas se cifran con lo mismo.');
  }
  console.warn('[caja] ⚠️  SESSION_SECRET sin configurar: se usa una clave de desarrollo. '
    + 'En producción esto no arranca.');
  return 'dev-insecure-secret-cambiar-en-prod';
})();

/* Las sesiones vivas, en memoria. Guardan el cliente del motor ya armado —con su cookie
   PHPSESSID adentro— para no volver a loguear en cada llamada. */
const vivas = new Map();

/* ══════ Y ADEMÁS, EN DISCO ══════════════════════════════════════════════════════════════════
   🔴 CADA DESPLIEGUE ECHABA A TODO EL MUNDO. Las sesiones vivían sólo en este `Map`, así que
   levantar una versión nueva —cosa que pasó veinte veces en una semana— dejaba a los cajeros en
   la pantalla de acceso, a veces en mitad de una carga. Se guardan en la base, sobre el volumen
   del servicio, y al primer pedido después de un reinicio se reviven solas.

   🔒 QUÉ SE GUARDA Y QUÉ NO. Se guarda el PHPSESSID del casino y, si la cuenta lo tiene, su
   api_token. La CONTRASEÑA no se guarda nunca, ni cifrada: quien la escribió fue la persona y
   ahí se queda. La consecuencia está aceptada: cuando el casino vence esa cookie, la sesión
   revivida no puede volver a entrar sola y el panel manda al login, en vez de reloguear por
   detrás como hace la sesión recién creada.

   Todo va cifrado con AES-256-GCM (`crypto-util`), que toma su clave de CRED_KEY o SESSION_SECRET.
   ⚠️ Si esa clave cambia, las sesiones guardadas dejan de poder abrirse: no se rompe nada, todos
   entran de nuevo una vez. */
const { encrypt, decrypt } = require('../crypto-util');

let db = null;
try {
  db = require('../db').db;
  db.exec(`CREATE TABLE IF NOT EXISTS caja_sesiones (
    sid TEXT PRIMARY KEY,
    vence INTEGER NOT NULL,
    datos TEXT NOT NULL
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS caja_sesiones_vence ON caja_sesiones(vence)');
} catch (e) {
  /* Igual que el diario: si la base no abre, esto sigue andando en memoria como antes. Guardar
     sesiones no puede tumbar el panel que las usa. */
  console.warn('[caja] las sesiones no pudieron abrir la base, quedan sólo en memoria:', e.message);
  db = null;
}

/* Lo que se escribe: los datos, nunca los clientes armados —esos se rehacen al revivir. */
function guardarEnDisco(s) {
  if (!db) return;
  try {
    const plano = JSON.stringify({
      login: s.login, id: s.id, group: s.group, rol: s.rol, moneda: s.moneda, url: s.url,
      caja: s.caja || null,
      hide_hall_balance: s.hide_hall_balance === true,
      disable_statistic: s.disable_statistic === true,
      token: s.token || null,
      cookie: (s.conSesion && s.conSesion.cookieActual && s.conSesion.cookieActual()) || '',
    });
    db.prepare('INSERT OR REPLACE INTO caja_sesiones (sid, vence, datos) VALUES (?, ?, ?)')
      .run(s.sid, s.vence, encrypt(plano));
  } catch (e) { console.warn('[caja] no se pudo guardar la sesión:', e.message); }
}

function borrarDelDisco(sid) {
  if (!db) return;
  try { db.prepare('DELETE FROM caja_sesiones WHERE sid = ?').run(sid); } catch (e) { /* da igual */ }
}

/* Y lo que se lee: se rehacen los dos clientes y la sesión vuelve a estar viva. */
function revivir(sid) {
  if (!db) return null;
  let fila;
  try { fila = db.prepare('SELECT vence, datos FROM caja_sesiones WHERE sid = ?').get(sid); }
  catch (e) { return null; }
  if (!fila || fila.vence <= Date.now()) { if (fila) borrarDelDisco(sid); return null; }
  let d;
  try { d = JSON.parse(decrypt(fila.datos)); } catch (e) {
    /* Cambió la clave, o la fila está rota: se tira y esa persona entra de nuevo. */
    borrarDelDisco(sid);
    return null;
  }
  const s = {
    sid, vence: fila.vence, balanceInicial: 0,
    login: d.login, id: d.id, group: d.group, rol: d.rol, moneda: d.moneda, url: d.url,
    caja: d.caja || null,
    hide_hall_balance: d.hide_hall_balance === true,
    disable_statistic: d.disable_statistic === true,
    token: d.token || null,
    tokenGenerado: false,
    conSesion: d.cookie ? makeClient({ url: d.url, cookie: d.cookie }) : null,
    conToken: d.token ? makeClient({ url: d.url, token: d.token }) : null,
    revivida: true,
  };
  /* Sin ninguno de los dos no hay con qué hablarle al casino: mejor al login que a un error. */
  if (!s.conSesion && !s.conToken) { borrarDelDisco(sid); return null; }
  vivas.set(sid, s);
  return s;
}

function limpiarDelDisco() {
  if (!db) return;
  try { db.prepare('DELETE FROM caja_sesiones WHERE vence <= ?').run(Date.now()); }
  catch (e) { /* da igual */ }
}

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
    /* El token en crudo, para poder rearmar ese cliente después de un reinicio. */
    token: tokenPropio || null,
    tokenGenerado,
    /* 🔴 DE QUÉ CAJA CUELGA UN SUB-CAJERO. Se pregunta acá, una sola vez, y queda en la sesión.
       Antes el panel no lo recibía y usaba el valor ESCRITO A MANO de la maqueta —la caja
       7357557, que es de un cliente real—, así que TODO sub-cajero creía pertenecer a esa caja y
       veía sus cuentas eliminadas. Reportado el 2-sep-2026 entrando con SubbCajacc: le mostraba
       «2 eliminados · saldo ARS 100» de una caja que no era la suya.
       `null` es una respuesta honesta: significa «no lo sabemos». */
    caja: null,
    vence: Date.now() + VIDA_MS,
  };

  /* 🔴 LOS PERMISOS DE UN SUB-CAJERO SE PREGUNTAN, NO SE SUPONEN. La maqueta los traía escritos
     a mano —esconder el saldo y las estadísticas, siempre— y el panel se los aplicaba a cualquiera.
     El motor los tiene en `useredit`. Una llamada más, y sólo para este nivel.

     De qué CAJA cuelga, en cambio, el motor no lo dice por ninguna vía: se probó `info`, `useredit`
     y `sub` el 2-sep-2026 y ninguno lo trae. Queda en `null`, que es la verdad, y el panel no
     filtra por una caja ajena — el motor ya le muestra sólo lo suyo. */
  if (group === '8') {
    try {
      /* 🔴 CON LA CREDENCIAL RAÍZ, NO CON LA SUYA. Una cuenta no puede leer su propia ficha —el
         motor le contesta que no tiene permiso, igual que con los ajustes del sitio— así que
         preguntando con su propio cliente el permiso volvía siempre apagado. Medido el 2-sep-2026:
         encendido en el casino, la lectura propia devolvía «0» y la de la raíz «1». */
      const cli = raiz || (tokenPropio ? makeClient({ url, token: tokenPropio }) : conSesion);
      const ficha8 = await cli.apiCall('useredit', {}, { id: sesion.id });
      const campos = (ficha8 && ficha8.data && ficha8.data.fields) || {};
      const prendido = (c) => {
        const v = campos[c];
        const x = v && typeof v === 'object' ? v.value : v;
        return x === '1' || x === 1 || x === true;
      };
      sesion.hide_hall_balance = prendido('hide_hall_balance');
      sesion.disable_statistic = prendido('disable_statistic');
    } catch (e) {
      console.warn('[caja/entrar] no se pudieron leer los permisos de', sesion.login, '·', e.message);
    }
  }
  console.log('[caja/entrar] %s · login+info %s ms · token %s ms · TOTAL %s ms',
    user, tInfo, Date.now() - t1, Date.now() - t0);
  vivas.set(sid, sesion);
  guardarEnDisco(sesion);
  limpiarVencidas();
  limpiarDelDisco();
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
  /* 🔑 Y si no está en memoria, se busca en disco ANTES de rechazarla: eso es lo que hace que un
     despliegue ya no eche a nadie. La cookie del navegador sigue siendo la misma y válida. */
  const s = sid && (vivas.get(sid) || revivir(sid));
  if (!s || s.vence <= Date.now()) {
    if (s) { vivas.delete(sid); borrarDelDisco(sid); }
    return res.status(401).json({ ok: false, error: 'sesión vencida', relogin: true });
  }
  s.vence = Date.now() + VIDA_MS;               // se renueva mientras trabaja
  guardarEnDisco(s);
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
  if (sid) { vivas.delete(sid); borrarDelDisco(sid); }
}

/** Lo que se le puede contar al navegador: nunca la url, el token ni el cliente. */
const publica = (s) => ({ login: s.login, id: s.id, group: s.group, rol: s.rol, moneda: s.moneda,
  /* De qué caja cuelga, cuando corresponde. `null` significa «no lo sabemos», y el panel puede
     decidir no filtrar en vez de filtrar por una caja que no es. */
  caja: s.caja || null,
  hide_hall_balance: s.hide_hall_balance === true,
  disable_statistic: s.disable_statistic === true,
  /* Para saber, del lado del panel, si Seguridad va a andar: necesita sesión, no token. */
  conToken: !!s.conToken });

module.exports = { entrar, salir, requerida, clienteDe, ponerCookie, borrarCookie, publica, COOKIE };
