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
const { db, ensureColumns } = require('./db');
const casinoConex = require('./casino-conexiones-store');

db.exec(`CREATE TABLE IF NOT EXISTS pase (
  id TEXT PRIMARY KEY,
  sitio_viejo TEXT, sitio_nuevo TEXT,
  conexion_id TEXT,
  caja_origen TEXT, caja_destino TEXT,     -- logins; destino vacío = no se cambia de caja
  activo INTEGER DEFAULT 1,
  creado TEXT, ord INTEGER
)`);
// `boton`: además del link, mostrar «Nos actualizamos · Probá ahora» ADENTRO del casino. Nació con
// Zeus (16-oct): ahí el casino corre dentro de la página del chat viejo, la sesión vive en ese
// recuadro y un link abierto aparte llega sin sesión. El botón está donde está la sesión.
ensureColumns('pase', { boton: 'INTEGER DEFAULT 0' });
// `todos`: pasar a TODOS los jugadores logueados del sitio viejo, no sólo a los de la caja de origen
// (Zeus, 16-oct: el sitio es de un solo cliente y parte ya se había movido de caja). Los de la caja
// de origen se cambian de caja; los demás se pasan de sitio sin tocarles la caja.
ensureColumns('pase', { todos: 'INTEGER DEFAULT 0' });
// Los textos de la franja, por pase (Zeus y Ganamos dicen cosas distintas). Vacío = el de siempre.
ensureColumns('pase', { titulo: 'TEXT', subtitulo: 'TEXT', texto_boton: 'TEXT' });
// Fichas de regalo al pasarse (Zeus, 16-oct: 1000). Salen de la CAJA DE DESTINO: el jugador cuelga
// de ella, así que cargarle a él se lo descuenta a ella (como el «in(B)» de un movimiento cuando el
// origen es padre del destino, ver carga-cascada). Una sola vez por jugador: tabla pase_regalo.
ensureColumns('pase', { fichas_regalo: 'REAL DEFAULT 0' });
db.exec(`CREATE TABLE IF NOT EXISTS pase_regalo (
  pase_id TEXT, jugador_id TEXT, login TEXT, monto REAL, divisa TEXT,
  estado TEXT,             -- dando | dado | fallo | dudoso
  detalle TEXT, at TEXT,
  PRIMARY KEY (pase_id, jugador_id)
)`);
db.exec(`CREATE TABLE IF NOT EXISTS pase_evento (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pase_id TEXT, sitio TEXT, jugador_id TEXT, login TEXT,
  resultado TEXT,          -- pasado | ya_pasado | sin_sesion | fuera | error
  detalle TEXT, at TEXT
)`);

/* 16-oct: los primeros regalos se «dieron» con la conexión de Alexa_support, que NO puede cambiar
   saldos: el casino contestó «Success» y no movió nada (PaulaTips quedó con 16). Se marcan como no
   entregados, una sola vez, para darlos con «Dar los regalos pendientes». */
{
  const { db: _db } = require('./db');
  const hecho = _db.prepare("SELECT value FROM meta WHERE key='pase_regalo_mig_16oct'").get();
  if (!hecho) {
    _db.prepare("UPDATE pase_regalo SET estado='fallo', detalle='se dio con una cuenta sin permiso para cargar: no entró' WHERE estado='dado'").run();
    _db.prepare("INSERT OR REPLACE INTO meta (key,value) VALUES ('pase_regalo_mig_16oct', ?)").run(new Date().toISOString());
  }
}

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
    caja_origen: r.caja_origen || '', caja_destino: r.caja_destino || '', activo: !!r.activo, boton: !!r.boton, todos: !!r.todos, titulo: r.titulo || '', subtitulo: r.subtitulo || '', texto_boton: r.texto_boton || '', fichas_regalo: Number(r.fichas_regalo) || 0, creado: r.creado };
}
function list() {
  const filas = db.prepare('SELECT * FROM pase ORDER BY ord ASC, creado ASC').all().map(_fila);
  const cuenta = db.prepare(`SELECT pase_id, resultado, COUNT(DISTINCT COALESCE(jugador_id, id)) n FROM pase_evento GROUP BY pase_id, resultado`).all();
  const ultimo = db.prepare('SELECT pase_id, MAX(at) at FROM pase_evento GROUP BY pase_id').all();
  return filas.map((p) => {
    const c = {}; cuenta.filter((x) => x.pase_id === p.id).forEach((x) => { c[x.resultado] = x.n; });
    const reg = db.prepare(`SELECT estado, COUNT(*) n, SUM(monto) m FROM pase_regalo WHERE pase_id=? GROUP BY estado`).all(p.id);
    const regalos = {}; reg.forEach((x) => { regalos[x.estado] = { n: x.n, monto: x.m }; });
    return { ...p, cuenta: c, regalos, ultimo: (ultimo.find((x) => x.pase_id === p.id) || {}).at || null };
  });
}
function get(id) { return _fila(db.prepare('SELECT * FROM pase WHERE id=?').get(String(id))); }

function _validar(d) {
  const p = { sitio_viejo: host(d.sitio_viejo), sitio_nuevo: host(d.sitio_nuevo), conexion_id: String(d.conexion_id || ''),
    caja_origen: String(d.caja_origen || '').trim(), caja_destino: String(d.caja_destino || '').trim(), activo: d.activo !== false, boton: !!d.boton, todos: !!d.todos,
    titulo: String(d.titulo || '').trim().slice(0, 60), subtitulo: String(d.subtitulo || '').trim().slice(0, 90), texto_boton: String(d.texto_boton || '').trim().slice(0, 40),
    fichas_regalo: Math.max(0, Math.round(Number(String(d.fichas_regalo || 0).replace(',', '.')) || 0)) };
  if (!p.sitio_viejo || !p.sitio_nuevo) throw new Error('falta el link viejo o el nuevo');
  for (const h of [p.sitio_viejo, p.sitio_nuevo]) {
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(h)) throw new Error(`«${h}» no es un link completo: falta el final (.com, .net, .org…)`);
  }
  if (p.sitio_viejo === p.sitio_nuevo) throw new Error('el link viejo y el nuevo son el mismo');
  if (!p.caja_origen) throw new Error('falta la caja de origen: es la que dice qué jugadores se pasan');
  if (p.caja_destino && !p.conexion_id) throw new Error('para cambiar de caja hay que elegir el casino');
  if (p.caja_destino && p.caja_destino.toLowerCase() === p.caja_origen.toLowerCase()) throw new Error('la caja de origen y la de destino son la misma');
  if (p.fichas_regalo > 0 && !p.caja_destino) throw new Error('para regalar fichas hace falta la caja de destino: salen de ella');
  if (p.fichas_regalo > 100000) throw new Error('el regalo es de más de 100.000 fichas: ¿no sobra un cero?');
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
  db.prepare(`INSERT INTO pase (id,sitio_viejo,sitio_nuevo,conexion_id,caja_origen,caja_destino,activo,boton,todos,titulo,subtitulo,texto_boton,fichas_regalo,creado,ord) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, p.sitio_viejo, p.sitio_nuevo, p.conexion_id, p.caja_origen, p.caja_destino, p.activo ? 1 : 0, p.boton ? 1 : 0, p.todos ? 1 : 0, p.titulo, p.subtitulo, p.texto_boton, p.fichas_regalo, nowISO(), ord);
  _cacheCajas.clear();
  return get(id);
}
async function editar(id, d, deps) {
  const viejo = get(id); if (!viejo) throw new Error('ese pase no existe');
  const p = _validar({ ...viejo, ...d });
  // Prender o apagar no vuelve a preguntarle al casino; cambiar casino o cajas, sí.
  if (['conexion_id', 'caja_origen', 'caja_destino'].some((k) => d[k] !== undefined && String(d[k]) !== String(viejo[k] || ''))) await _cajasEnCasino(p, deps);
  db.prepare(`UPDATE pase SET sitio_viejo=?, sitio_nuevo=?, conexion_id=?, caja_origen=?, caja_destino=?, activo=?, boton=?, todos=?, titulo=?, subtitulo=?, texto_boton=?, fichas_regalo=? WHERE id=?`)
    .run(p.sitio_viejo, p.sitio_nuevo, p.conexion_id, p.caja_origen, p.caja_destino, p.activo ? 1 : 0, p.boton ? 1 : 0, p.todos ? 1 : 0, p.titulo, p.subtitulo, p.texto_boton, p.fichas_regalo, id);
  _cacheCajas.clear(); _consultas.clear();
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
/* ── DNS: Zeus le contesta 0.0.0.0 al resolvedor de Railway (medido el 16-oct en los registros
   de red: «casinozeuschat.com A → 0.0.0.0»), mientras a cualquier otro le da 5.9.119.173 u
   88.99.136.161. Los de Ganamos no. Cuando el DNS local da 0.0.0.0 o falla, se le pregunta al DNS
   público de Google y se conecta a esa dirección con el MISMO nombre (el certificado sigue valiendo). */
const https = require('https');
const dnsMod = require('dns');
const _doh = new Map();   // host → { ip, exp }
/* Ojo: Google le pasa al DNS de Zeus la ZONA de quien pregunta, y Zeus también bloquea las de
   Google Cloud (donde corre Railway): «0.0.0.0» otra vez. Por eso se le pide a Google que pregunte
   como desde Argentina (de donde juegan), y si no, a Cloudflare, que no manda zona. Medido 16-oct:
   los dos dan 88.99.136.161 y la sesión vale ahí igual que en 5.9.119.173. */
const _DOH = [
  (h) => ['https://dns.google/resolve?type=A&edns_client_subnet=181.0.0.0/24&name=' + encodeURIComponent(h), {}],
  (h) => ['https://cloudflare-dns.com/dns-query?type=A&name=' + encodeURIComponent(h), { headers: { accept: 'application/dns-json' } }],
];
async function _porGoogle(host) {
  const ya = _doh.get(host);
  if (ya && ya.exp > Date.now()) return ya.ip;
  for (const armar of _DOH) {
    try {
      const [url, op] = armar(host);
      const j = await (await fetch(url, op)).json();
      const ip = ((j && j.Answer) || []).map((a) => a.data).find((d) => /^\d+\.\d+\.\d+\.\d+$/.test(d) && d !== '0.0.0.0');
      if (ip) { _doh.set(host, { ip, exp: Date.now() + 5 * 60 * 1000 }); return ip; }
    } catch (e) { /* se prueba el siguiente */ }
  }
  throw new Error('ni Google ni Cloudflare dan una dirección para ' + host);
}
function _lookup(host, opts, cb) {
  dnsMod.lookup(host, { family: 4 }, (err, addr) => {
    if (!err && addr && addr !== '0.0.0.0') return cb(null, opts && opts.all ? [{ address: addr, family: 4 }] : addr, 4);
    _porGoogle(host).then((ip) => cb(null, opts && opts.all ? [{ address: ip, family: 4 }] : ip, 4), (e) => cb(err || e));
  });
}
/** POST JSON a un sitio del casino con el DNS de respaldo. Devuelve { status, text }. */
function _postSitio(url, headers, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method: 'POST', headers: { ...headers, 'Content-Length': Buffer.byteLength(body) }, lookup: _lookup, timeout: 15000 }, (res) => {
      let txt = ''; res.setEncoding('utf8');
      res.on('data', (c) => { txt += c; });
      res.on('end', () => resolve({ status: res.statusCode, text: async () => txt }));
    });
    req.on('timeout', () => req.destroy(new Error('el sitio tardó más de 15 s')));
    req.on('error', reject);
    req.end(body);
  });
}

/** Quién es el dueño de esta sesión, preguntándole al propio sitio. null si no vale. */
async function quienEs(sitio, token, fetchImpl = null) {
  if (!/^[a-f0-9]{16,64}$/i.test(String(token || ''))) return null;
  const o = 'https://' + sitio;
  const pedir = fetchImpl || ((url, op) => _postSitio(url, op.headers, op.body));
  try {
    const r = await pedir(o + '/api.php?type=query', {
      method: 'POST',
      headers: { 'User-Agent': UA, 'Content-Type': 'application/json', Origin: o, Referer: o + '/' },
      body: JSON.stringify({ cmd: 'terminalInfo', version: 9, domain: o, token }),
    });
    const txt = await r.text();
    let j = null; try { j = JSON.parse(txt); } catch (e) { /* abajo se anota */ }
    const c = (j && j.content) || {};
    if (c.login) return { id: String(c.id), login: String(c.login), divisa: String(c.currency || 'ARS') };
    // Que quede escrito QUÉ contestó: el 16-oct Zeus le decía que no al servidor y sí al navegador.
    console.log(`[pase] ${sitio} no reconoció la sesión: HTTP ${r.status} · ${String(txt).replace(/\s+/g, ' ').slice(0, 200)}`);
    return null;
  } catch (e) { console.log(`[pase] ${sitio} no contestó: ${e.message}`); return null; }
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

/** Qué pase le toca a un jugador: el de la caja de la que cuelga (o a la que ya se pasó). */
async function _reglaDe(reglas, jug, clienteDe) {
  const ops = require('./operaciones.service');
  for (const p of reglas) {
    try {
      const cli = clienteDe(p.conexion_id);
      if (!cli) continue;
      const yo = await ops._ayudas.buscarUsuario(cli, jug.login);
      if (!yo) continue;
      const origen = await _caja(cli, p.conexion_id, p.caja_origen);
      const destino = p.caja_destino ? await _caja(cli, p.conexion_id, p.caja_destino) : null;
      if (yo.padre === origen.id || (destino && yo.padre === destino.id)) return { regla: p, padre: yo.padre, cli, origen, destino };
    } catch (e) { /* se prueba la regla siguiente */ }
  }
  return null;
}

/**
 * Carga el regalo UNA vez. Se anota «dando» ANTES de pedirlo: si el proceso se corta en el medio,
 * queda «dudoso» a la vista y no se repite solo (regalar dos veces no se deshace). Un error claro
 * del casino (sin saldo, etc.) queda «fallo» y se vuelve a intentar la próxima vez que toque.
 * Devuelve el texto para el detalle del evento.
 */
/** Saldo de un jugador leído en el casino (la lista de su caja). null si no se pudo leer. */
async function _saldo(cli, cajaId, jug, divisa) {
  try {
    const r = await cli.apiCall('statisticstable', {}, { id: String(cajaId), template: 'users', safe_content: '1',
      without_filters: '1', search: String(jug.login), limit: '50' });
    const row = ((r.data && r.data.rows) || []).find((x) => String(x.id) === String(jug.id));
    if (!row) return null;
    const v = Number(String(row.balance ?? '').replace(/,/g, ''));
    return Number.isFinite(v) ? v : null;
  } catch (e) { return null; }
}

async function _darRegalo(regla, jug, cli, destino) {
  const ya = db.prepare('SELECT * FROM pase_regalo WHERE pase_id=? AND jugador_id=?').get(regla.id, String(jug.id));
  if (ya && ya.estado !== 'fallo') return ya.estado === 'dado' ? '' : 'regalo en duda de un intento anterior: revisar a mano';
  const monto = regla.fichas_regalo, divisa = jug.divisa || (ya && ya.divisa) || 'ARS';
  // Que el que está arriba sea la caja de destino (si no, el casino se lo sacaría a otra).
  const ops = require('./operaciones.service');
  const yo = await ops._ayudas.buscarUsuario(cli, jug.login);
  if (!yo || yo.padre !== destino.id) return 'regalo no dado: no cuelga de ' + destino.login;
  db.prepare(`INSERT OR REPLACE INTO pase_regalo (pase_id,jugador_id,login,monto,divisa,estado,detalle,at) VALUES (?,?,?,?,?,'dando','',?)`)
    .run(regla.id, String(jug.id), jug.login, monto, divisa, nowISO());
  /* NO se confía en la respuesta: con una cuenta sin permiso el casino contesta «Success» y no carga
     nada (16-oct). Se lee el saldo antes y después. */
  const antes = await _saldo(cli, destino.id, jug, divisa);
  let r;
  try {
    r = await cli.apiCall('balance', { balance_currency: divisa, amount: String(monto), send: 'true', all: 'false', operation: 'in' },
      { type: 'frame', printing: 'true', id: String(jug.id) });
  } catch (e) { r = { ok: false, dudoso: true, error: e.message }; }
  const despues = await _saldo(cli, destino.id, jug, divisa);
  const d = (r && r.data) || {};
  const err = (r && r.error) || d.errorMessage || '';
  let estado, det;
  if (antes != null && despues != null) {
    const subio = Math.round((despues - antes) * 100) / 100;
    if (subio >= monto - 0.01 && subio <= monto + 0.01) { estado = 'dado'; det = ''; }
    else if (subio === 0) { estado = 'fallo'; det = err || 'el casino contestó que sí pero el saldo no se movió (¿la conexión puede cargar?)'; }
    else { estado = 'dudoso'; det = `el saldo cambió ${subio} en vez de ${monto} (quizás estaba jugando): revisar a mano`; }
  } else {
    estado = 'dudoso'; det = 'no se pudo leer el saldo para confirmar: revisar a mano';
  }
  db.prepare('UPDATE pase_regalo SET estado=?, detalle=?, at=? WHERE pase_id=? AND jugador_id=?').run(estado, det.slice(0, 200), nowISO(), regla.id, String(jug.id));
  if (estado === 'dado') return `🎁 ${monto} ${divisa} de regalo (de ${destino.login})`;
  return estado === 'fallo' ? `regalo NO dado (${det})` : `regalo en duda (${det})`;
}

/**
 * «Dar los regalos pendientes»: vuelve a intentar los que quedaron sin entregar (`fallo`) sin que
 * el jugador tenga que tocar nada — ya se pasó y la franja no le vuelve a aparecer.
 */
async function darPendientes(paseId, deps = {}) {
  const clienteDe = deps.clienteDe || ((id) => casinoConex.client(id));
  const regla = list().find((p) => p.id === paseId);
  if (!regla) throw new Error('ese pase no existe');
  if (!(regla.fichas_regalo > 0) || !regla.caja_destino) throw new Error('este pase no tiene regalo');
  const cli = clienteDe(regla.conexion_id);
  if (!cli) throw new Error('el casino del pase no tiene credenciales');
  const destino = await _caja(cli, regla.conexion_id, regla.caja_destino);
  const filas = db.prepare("SELECT * FROM pase_regalo WHERE pase_id=? AND estado='fallo'").all(paseId);
  const out = { dados: 0, fallidos: 0, dudosos: 0 };
  for (const f of filas) {
    const t = await _darRegalo(regla, { id: f.jugador_id, login: f.login, divisa: f.divisa }, cli, destino);
    if (/^🎁/.test(t)) out.dados++; else if (/en duda/.test(t)) out.dudosos++; else out.fallidos++;
  }
  return out;
}

/** «cuelga de X: no se le cambió la caja», para el detalle de un pase «para todos». */
async function _cajaActual(p, jug, clienteDe) {
  try {
    const ops = require('./operaciones.service');
    const cli = clienteDe(p.conexion_id);
    const yo = cli && await ops._ayudas.buscarUsuario(cli, jug.login);
    const padre = yo && yo.padre && await ops._ayudas.buscarUsuario(cli, yo.padre);
    return `cuelga de ${padre ? padre.login : (yo ? yo.padre : 'otra caja')}: no se le cambió la caja`;
  } catch (e) { return 'de otra caja: no se le cambió la caja'; }
}

/**
 * ¿Le mostramos el botón a este jugador? Lo pregunta pase.js en CADA carga del casino en los sitios
 * viejos, así que: sin pase con botón en ese sitio no se le pregunta nada al casino, y la respuesta
 * se guarda 10 minutos por sesión (el jugador cambia de página todo el tiempo).
 */
const _consultas = new Map();   // sitio|token → { mostrar, exp }
async function consultar({ origin, token }, deps = {}) {
  const fetchImpl = deps.fetch || null;
  const clienteDe = deps.clienteDe || ((id) => casinoConex.client(id));
  const sitio = host(origin);
  const reglas = list().filter((p) => p.activo && p.boton && p.sitio_viejo === sitio);
  if (!reglas.length || !/^[a-f0-9]{16,64}$/i.test(String(token || ''))) return { mostrar: false };
  const k = sitio + '|' + token;
  const ya = _consultas.get(k);
  if (ya && ya.exp > Date.now()) return ya.r;
  const jug = await quienEs(sitio, token, fetchImpl);
  let regla = null;
  if (jug) { const m = await _reglaDe(reglas, jug, clienteDe); regla = m ? m.regla : reglas.find((p) => p.todos) || null; }
  const r = regla ? { mostrar: true, textos: { titulo: regla.titulo, subtitulo: regla.subtitulo, boton: regla.texto_boton } } : { mostrar: false };
  if (_consultas.size > 20000) _consultas.clear();
  // Un «sí» o un «no es de la caja» valen 10 min; un «no reconoció la sesión» sólo 30 s (puede ser un corte).
  _consultas.set(k, { r, exp: Date.now() + (jug ? 10 * 60 * 1000 : 30 * 1000) });
  return r;
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
  const fetchImpl = deps.fetch || null;
  const clienteDe = deps.clienteDe || ((id) => casinoConex.client(id));
  const sitio = host(origin);
  const reglas = list().filter((p) => p.activo && p.sitio_viejo === sitio);
  if (!reglas.length) return { motivo: 'sin_regla' };

  const jug = await quienEs(sitio, token, fetchImpl);
  if (!jug) { _anotar(reglas[0], sitio, null, 'sin_sesion'); return { motivo: 'sin_sesion' }; }

  let m = await _reglaDe(reglas, jug, clienteDe);
  let nota = '';
  if (!m) {
    const paraTodos = reglas.find((p) => p.todos);
    if (!paraTodos) { _anotar(reglas[0], sitio, jug, 'fuera'); return { motivo: 'fuera' }; }
    // Pase «para todos»: es de otra caja (o ya lo movieron) → se pasa de sitio sin tocarle la caja.
    m = { regla: paraTodos, padre: null, cli: null, destino: null };
    nota = await _cajaActual(paraTodos, jug, clienteDe);
  }
  const { regla, padre, cli, destino } = m;

  // Cambio de caja, si la regla lo pide y todavía no se hizo.
  let resultado = 'pasado';
  if (destino && padre !== destino.id) {
    const ops = require('./operaciones.service');
    let motivo;
    try { motivo = await ops.CATALOGO['mover-jugadores'].hacer(cli, { id: jug.id }, { destino }); }
    catch (e) { motivo = e.message; }
    if (motivo) { _anotar(regla, sitio, jug, 'error', 'no se pudo cambiar de caja: ' + motivo); return { motivo: 'error' }; }
  } else if (destino) resultado = 'ya_pasado';

  // Regalo: sólo si quedó en la caja de destino (así sale de ella y de ninguna otra).
  if (regla.fichas_regalo > 0 && destino) {
    const r = await _darRegalo(regla, jug, cli, destino);
    if (r) nota = [nota, r].filter(Boolean).join(' · ');
  }

  // ¿La sesión sirve en el sitio nuevo? (otro servidor del casino, o el cambio de caja la cerró).
  // Se lo manda igual —ya está en su caja nueva—, pero queda escrito para verlo en la pantalla.
  const enNuevo = await quienEs(regla.sitio_nuevo, token, fetchImpl);
  const detalle = [nota, enNuevo ? '' : 'llegó sin sesión: el sitio nuevo no aceptó su sesión, va a tener que entrar con usuario y clave'].filter(Boolean).join(' · ');

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

/** Corregir a mano el estado de un regalo (p. ej. uno que sí entró y figura como no entregado). */
function marcarRegalo(paseId, jugadorId, estado, quien = '') {
  if (!['dado', 'fallo'].includes(estado)) throw new Error('estado inválido');
  const ch = db.prepare('UPDATE pase_regalo SET estado=?, detalle=?, at=? WHERE pase_id=? AND jugador_id=?')
    .run(estado, `marcado «${estado}» a mano` + (quien ? ' por ' + quien : ''), nowISO(), String(paseId), String(jugadorId)).changes;
  if (!ch) throw new Error('ese regalo no existe');
  return db.prepare('SELECT * FROM pase_regalo WHERE pase_id=? AND jugador_id=?').get(String(paseId), String(jugadorId));
}
function regalos(paseId) { return db.prepare('SELECT * FROM pase_regalo WHERE pase_id=? ORDER BY at DESC').all(String(paseId)); }

module.exports = { list, get, crear, editar, borrar, eventos, emitir, canjear, consultar, darPendientes, marcarRegalo, regalos, sitios, host, _codigos, _quienEs: quienEs };
