/**
 * pases.service.js — PASAR JUGADORES DE UN SITIO A OTRO SIN QUE TENGAN QUE LOGUEARSE.
 *
 * El caso (15-oct-2026): jugadores de 4 cajas que juegan en sitios con el chat de otro proveedor
 * (ganamoschat.com, …) se pasan a sitios con el nuestro (ganamoschatt.com, …) y a otra caja. No
 * saben su usuario ni su clave: sólo están logueados. Un link común los dejaría afuera.
 *
 * Cómo se hace (medido el 15-oct): la sesión del casino (`ig_token` en el localStorage del sitio)
 * vale en los dos dominios — los dos son skins de la misma instalación. El sitio no la toma de la
 * URL, así que la lleva `public/pase.js`, que va pegado en los sitios viejos Y en los nuevos:
 *
 *   1. En el viejo, el jugador entra por `?pasar` (el link que se le manda por el chat viejo).
 *      pase.js lee su sesión y la manda a POST /api/pase/emitir.
 *   2. Acá se valida contra el casino (terminalInfo), se busca la regla del sitio, se lo mueve de
 *      caja si hace falta (lo mismo que 🛠 Operaciones, verificado releyendo) y se da un CÓDIGO de
 *      un solo uso que vence en 2 minutos. La sesión NUNCA va en la URL.
 *   3. pase.js lo manda a `<sitio nuevo>/?cw_pase=<código>`. Allá pase.js canjea el código
 *      (POST /api/pase/canjear, sólo desde el sitio nuevo de esa regla), guarda la sesión y recarga:
 *      el jugador queda logueado y nuestro chat lo reconoce solo.
 *
 * Los códigos viven en memoria a propósito: duran 2 minutos y llevan una sesión del casino. Si el
 * servidor se reinicia en esos 2 minutos, el jugador toca el link de nuevo.
 */
const crypto = require('crypto');
const { db } = require('./db');
const casinoConex = require('./casino-conexiones-store');

db.exec(`CREATE TABLE IF NOT EXISTS pase (
  id TEXT PRIMARY KEY,
  sitio_viejo TEXT, sitio_nuevo TEXT,
  conexion_id TEXT,
  caja_origen TEXT, caja_destino TEXT,     -- logins; destino vacío = no se cambia de caja
  activo INTEGER DEFAULT 1,
  creado TEXT, ord INTEGER
)`);
db.exec(`CREATE TABLE IF NOT EXISTS pase_evento (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pase_id TEXT, sitio TEXT, jugador_id TEXT, login TEXT,
  resultado TEXT,          -- pasado | ya_pasado | sin_sesion | fuera | error
  detalle TEXT, at TEXT
)`);

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const VIDA_CODIGO_MS = 2 * 60 * 1000;
const nowISO = () => new Date().toISOString();

/** «https://www.GanamosChat.com/x» → «ganamoschat.com». */
function host(s) {
  let h = String(s || '').trim().toLowerCase();
  try { if (/^https?:\/\//.test(h)) h = new URL(h).hostname; } catch (e) { /* queda como vino */ }
  return h.replace(/\/.*$/, '').replace(/^www\./, '');
}

// ═══════════════════════════════════════════════════════════════════════════════
// Reglas
// ═══════════════════════════════════════════════════════════════════════════════
function _fila(r) {
  if (!r) return null;
  return { id: r.id, sitio_viejo: r.sitio_viejo, sitio_nuevo: r.sitio_nuevo, conexion_id: r.conexion_id,
    caja_origen: r.caja_origen || '', caja_destino: r.caja_destino || '', activo: !!r.activo, creado: r.creado };
}
function list() {
  const filas = db.prepare('SELECT * FROM pase ORDER BY ord ASC, creado ASC').all().map(_fila);
  const cuenta = db.prepare(`SELECT pase_id, resultado, COUNT(DISTINCT COALESCE(jugador_id, id)) n FROM pase_evento GROUP BY pase_id, resultado`).all();
  const ultimo = db.prepare('SELECT pase_id, MAX(at) at FROM pase_evento GROUP BY pase_id').all();
  return filas.map((p) => {
    const c = {}; cuenta.filter((x) => x.pase_id === p.id).forEach((x) => { c[x.resultado] = x.n; });
    return { ...p, cuenta: c, ultimo: (ultimo.find((x) => x.pase_id === p.id) || {}).at || null };
  });
}
function get(id) { return _fila(db.prepare('SELECT * FROM pase WHERE id=?').get(String(id))); }

function _validar(d) {
  const p = { sitio_viejo: host(d.sitio_viejo), sitio_nuevo: host(d.sitio_nuevo), conexion_id: String(d.conexion_id || ''),
    caja_origen: String(d.caja_origen || '').trim(), caja_destino: String(d.caja_destino || '').trim(), activo: d.activo !== false };
  if (!p.sitio_viejo || !p.sitio_nuevo) throw new Error('falta el link viejo o el nuevo');
  for (const h of [p.sitio_viejo, p.sitio_nuevo]) {
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(h)) throw new Error(`«${h}» no es un link completo: falta el final (.com, .net, .org…)`);
  }
  if (p.sitio_viejo === p.sitio_nuevo) throw new Error('el link viejo y el nuevo son el mismo');
  if (!p.caja_origen) throw new Error('falta la caja de origen: es la que dice qué jugadores se pasan');
  if (p.caja_destino && !p.conexion_id) throw new Error('para cambiar de caja hay que elegir el casino');
  if (p.caja_destino && p.caja_destino.toLowerCase() === p.caja_origen.toLowerCase()) throw new Error('la caja de origen y la de destino son la misma');
  return p;
}
/**
 * Que las cajas existan en el casino elegido. Sin esto, un pase con el casino equivocado (pasó el
 * 16-oct: cajas de Europa cargadas con Casino_Fichas) queda guardado y no pasa a nadie, sin aviso.
 * Si no está, se busca en las otras conexiones para decir en cuál sí.
 */
async function _cajasEnCasino(p, deps = {}) {
  const clienteDe = deps.clienteDe || ((id) => casinoConex.client(id));
  const ops = require('./operaciones.service');
  const cli = clienteDe(p.conexion_id);
  if (!cli) throw new Error('ese casino no tiene credenciales');
  for (const caja of [p.caja_origen, p.caja_destino].filter(Boolean)) {
    if (await ops._ayudas.buscarUsuario(cli, caja)) continue;
    const otras = (deps.conexiones || casinoConex.list463()).filter((c) => c.id !== p.conexion_id && c.activa !== false);
    let donde = null;
    for (const c of otras) { try { const o = clienteDe(c.id); if (o && await ops._ayudas.buscarUsuario(o, caja)) { donde = c.nombre; break; } } catch (e) { /* sigue */ } }
    throw new Error(`la caja «${caja}» no está en ese casino` + (donde ? `: está en «${donde}». Elegí ese.` : '.'));
  }
}

async function crear(d, deps) {
  const p = _validar(d);
  await _cajasEnCasino(p, deps);
  const id = 'pase_' + crypto.randomBytes(5).toString('hex');
  const ord = (db.prepare('SELECT MAX(ord) m FROM pase').get().m || 0) + 1;
  db.prepare(`INSERT INTO pase (id,sitio_viejo,sitio_nuevo,conexion_id,caja_origen,caja_destino,activo,creado,ord) VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(id, p.sitio_viejo, p.sitio_nuevo, p.conexion_id, p.caja_origen, p.caja_destino, p.activo ? 1 : 0, nowISO(), ord);
  _cacheCajas.clear();
  return get(id);
}
async function editar(id, d, deps) {
  const viejo = get(id); if (!viejo) throw new Error('ese pase no existe');
  const p = _validar({ ...viejo, ...d });
  // Prender o apagar no vuelve a preguntarle al casino; cambiar casino o cajas, sí.
  if (['conexion_id', 'caja_origen', 'caja_destino'].some((k) => d[k] !== undefined && String(d[k]) !== String(viejo[k] || ''))) await _cajasEnCasino(p, deps);
  db.prepare(`UPDATE pase SET sitio_viejo=?, sitio_nuevo=?, conexion_id=?, caja_origen=?, caja_destino=?, activo=? WHERE id=?`)
    .run(p.sitio_viejo, p.sitio_nuevo, p.conexion_id, p.caja_origen, p.caja_destino, p.activo ? 1 : 0, id);
  _cacheCajas.clear();
  return get(id);
}
function borrar(id) { return db.prepare('DELETE FROM pase WHERE id=?').run(String(id)).changes > 0; }

/** Los últimos movimientos de un pase, para la pantalla. */
function eventos(paseId, limite = 200) {
  return db.prepare('SELECT * FROM pase_evento WHERE pase_id=? ORDER BY id DESC LIMIT ?').all(String(paseId), limite);
}
function _anotar(pase, sitio, jugador, resultado, detalle = '') {
  db.prepare('INSERT INTO pase_evento (pase_id,sitio,jugador_id,login,resultado,detalle,at) VALUES (?,?,?,?,?,?,?)')
    .run(pase ? pase.id : null, sitio, jugador ? String(jugador.id) : null, jugador ? jugador.login : null, resultado, detalle, nowISO());
}

// ═══════════════════════════════════════════════════════════════════════════════
// Casino
// ═══════════════════════════════════════════════════════════════════════════════
/** Quién es el dueño de esta sesión, preguntándole al propio sitio. null si no vale. */
async function quienEs(sitio, token, fetchImpl = fetch) {
  if (!/^[a-f0-9]{16,64}$/i.test(String(token || ''))) return null;
  const o = 'https://' + sitio;
  try {
    const r = await fetchImpl(o + '/api.php?type=query', {
      method: 'POST',
      headers: { 'User-Agent': UA, 'Content-Type': 'application/json', Origin: o, Referer: o + '/' },
      body: JSON.stringify({ cmd: 'terminalInfo', version: 9, domain: o, token }),
    });
    const j = await r.json();
    const c = (j && j.content) || {};
    return c.login ? { id: String(c.id), login: String(c.login) } : null;
  } catch (e) { return null; }
}

const _cacheCajas = new Map();   // conexion|login → { id, login }
async function _caja(cli, conexionId, login) {
  const k = conexionId + '|' + login.toLowerCase();
  if (_cacheCajas.has(k)) return _cacheCajas.get(k);
  const ops = require('./operaciones.service');
  const c = await ops._ayudas.buscarUsuario(cli, login);
  if (!c) throw new Error(`la caja «${login}» no existe en ese casino`);
  _cacheCajas.set(k, c);
  return c;
}

// ═══════════════════════════════════════════════════════════════════════════════
// El pase
// ═══════════════════════════════════════════════════════════════════════════════
const _codigos = new Map();   // código → { token, sitio, exp }

function _limpiar() { const t = Date.now(); for (const [k, v] of _codigos) if (v.exp < t) _codigos.delete(k); }

/**
 * Lo llama pase.js desde el sitio VIEJO. Devuelve { ir } con el link al sitio nuevo, o { motivo }
 * para que la página le diga al jugador qué hacer.
 */
async function emitir({ origin, token }, deps = {}) {
  const fetchImpl = deps.fetch || fetch;
  const clienteDe = deps.clienteDe || ((id) => casinoConex.client(id));
  const sitio = host(origin);
  const reglas = list().filter((p) => p.activo && p.sitio_viejo === sitio);
  if (!reglas.length) return { motivo: 'sin_regla' };

  const jug = await quienEs(sitio, token, fetchImpl);
  if (!jug) { _anotar(reglas[0], sitio, null, 'sin_sesion'); return { motivo: 'sin_sesion' }; }

  // Qué regla le toca: la de la caja de la que cuelga (o a la que ya se pasó).
  let regla = null, padre = null, cli = null, origen = null, destino = null;
  for (const p of reglas) {
    try {
      cli = clienteDe(p.conexion_id);
      if (!cli) continue;
      const ops = require('./operaciones.service');
      const yo = await ops._ayudas.buscarUsuario(cli, jug.login);
      if (!yo) continue;
      origen = await _caja(cli, p.conexion_id, p.caja_origen);
      destino = p.caja_destino ? await _caja(cli, p.conexion_id, p.caja_destino) : null;
      if (yo.padre === origen.id || (destino && yo.padre === destino.id)) { regla = p; padre = yo.padre; break; }
    } catch (e) { /* se prueba la regla siguiente */ }
  }
  if (!regla) { _anotar(reglas[0], sitio, jug, 'fuera'); return { motivo: 'fuera' }; }

  // Cambio de caja, si la regla lo pide y todavía no se hizo.
  let resultado = 'pasado';
  if (destino && padre !== destino.id) {
    const ops = require('./operaciones.service');
    let motivo;
    try { motivo = await ops.CATALOGO['mover-jugadores'].hacer(cli, { id: jug.id }, { destino }); }
    catch (e) { motivo = e.message; }
    if (motivo) { _anotar(regla, sitio, jug, 'error', 'no se pudo cambiar de caja: ' + motivo); return { motivo: 'error' }; }
  } else if (destino) resultado = 'ya_pasado';

  // ¿La sesión sirve en el sitio nuevo? (otro servidor del casino, o el cambio de caja la cerró).
  // Se lo manda igual —ya está en su caja nueva—, pero queda escrito para verlo en la pantalla.
  const enNuevo = await quienEs(regla.sitio_nuevo, token, fetchImpl);
  const detalle = enNuevo ? '' : 'llegó sin sesión: el sitio nuevo no aceptó su sesión, va a tener que entrar con usuario y clave';

  _limpiar();
  const codigo = crypto.randomBytes(24).toString('hex');
  _codigos.set(codigo, { token, sitio: regla.sitio_nuevo, exp: Date.now() + VIDA_CODIGO_MS });
  _anotar(regla, sitio, jug, resultado, detalle);
  return { ir: `https://${regla.sitio_nuevo}/?cw_pase=${codigo}` };
}

/** Lo llama pase.js desde el sitio NUEVO. Quema el código y devuelve la sesión. */
function canjear({ origin, codigo }) {
  _limpiar();
  const c = _codigos.get(String(codigo || ''));
  if (!c) return null;
  if (host(origin) !== c.sitio) return null;     // un código sólo se canjea en el sitio al que iba
  _codigos.delete(String(codigo));
  return { token: c.token };
}

/** Los sitios que tienen que tener pase.js pegado: viejos y nuevos de TODOS los pases. También los
    apagados: ahí el script no hace nada, y prenderlo después no obliga a pedirle nada al programador. */
function sitios() {
  const s = new Set();
  list().forEach((p) => { s.add(p.sitio_viejo); s.add(p.sitio_nuevo); });
  return [...s];
}

module.exports = { list, get, crear, editar, borrar, eventos, emitir, canjear, sitios, host, _codigos };
