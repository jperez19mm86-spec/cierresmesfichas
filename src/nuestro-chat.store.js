/**
 * nuestro-chat.store.js — LO QUE SE LE COBRA A CADA CLIENTE POR NUESTRO CHAT.
 *
 * ── LAS REGLAS (Alexa, 22 y 24-oct-2026) ─────────────────────────────────────────────────────
 *   · Cada caja del chat es UNA caja de Imperia: el nodo donde cuelgan los jugadores (la «sala»).
 *   · Fecha de inicio que marca ella (puede ser a futuro). Antes de esa fecha no se cobra nada.
 *   · Conexión, una vez, el día de inicio (monto por caja: 200, 50, 0…). Vence a los 5 días.
 *     Lo que queda de ese mes NO paga mantenimiento.
 *     Si empieza en los últimos días del mes (7 por defecto), la conexión va con el cobro del 1:
 *     no se le cobra «hoy y mañana igual».
 *   · Mantenimiento por caja y por mes, POR ADELANTADO: el cobro del 1 de noviembre lleva noviembre.
 *   · Un % (1 a 4; 2 por defecto) de la ganancia de la caja en Imperia del mes que cerró, desde el
 *     inicio. Mes con pérdida → 0. En otra moneda, al promedio del mes (tc-unico, como todo lo que
 *     se le cobra a un cliente). Sin dato o sin cambio, ese cobro NO sale: no se inventa un número.
 *   · Vence el día 5. Desde el 6, al que no pagó le aparece el cartel en el panel del chat (lo
 *     muestra el chat preguntando acá; nunca se tocan jugadores, cargas ni retiros).
 *   · Solo USDT por ahora. Todo entra a las wallets del chat y la «Cuenta del chat» reparte entre
 *     Alexa y su programador lo que queda después de los gastos.
 *
 * ── POR QUÉ ES OTRO LIBRO ────────────────────────────────────────────────────────────────────
 * Igual que el Chat Externo: no entra en `movimientos` (el libro de las fichas) ni en el cierre del
 * mes. Es otro producto, otra wallet, otro grupo. Lo que se comparte es lo que ya existe y es la
 * misma fuente: la ganancia nocturna de `reporte_diario` (grupo 'chat', ver acumulado.service.js)
 * y el tipo de cambio del mes.
 *
 * ── LO QUE CUIDA LA BASE, NO EL CÓDIGO ───────────────────────────────────────────────────────
 *   · Un cobro por cliente y por mes, y una conexión por caja: índice único. Apretar dos veces
 *     «Armar» no puede cobrar dos veces.
 *   · Un código de transferencia (hash) paga una sola vez: índice único.
 */
const crypto = require('crypto');
const { db } = require('./db');
const money = require('./lib/money');
const cfg = require('./config-store');
const clientesStore = require('./clientes-store');
const conexiones = require('./casino-conexiones-store');
const tcUnico = require('./tc-unico.service');
const chatExterno = require('./chat-externo.store');
const { fechaTZ, mesTZ } = require('./lib/fechas');

db.exec(`
  CREATE TABLE IF NOT EXISTS nc_cliente (
    cliente_id TEXT PRIMARY KEY,
    tg_grupo TEXT,                -- el grupo de Telegram de ESTE servicio (no el de las fichas)
    token TEXT UNIQUE,            -- su link de pago: /mi-chat/<token>
    prorroga TEXT,                -- YYYY-MM-DD: hasta ese día no le aparece el cartel
    pesos INTEGER DEFAULT 0,      -- puede pagar en pesos (apagado en general por ahora)
    createdAt TEXT
  );
  CREATE TABLE IF NOT EXISTS nc_caja (
    id TEXT PRIMARY KEY,
    cliente_id TEXT NOT NULL,
    caja TEXT,                    -- cómo se llama (el usuario de la caja en Imperia)
    sitio TEXT,                   -- el dominio del chat
    chat_id TEXT,                 -- el id de la caja en el chat (cj…)
    conexion_id TEXT,             -- Europa / Casino: la conexión del OS que lee su ganancia
    sala_id TEXT,                 -- el NODO de Imperia donde cuelgan los jugadores
    desde TEXT,                   -- fecha de inicio (vacío = todavía no tiene)
    entrada TEXT,                 -- la conexión, una vez (USD)
    mant TEXT,                    -- mantenimiento por mes (USD)
    pct TEXT,                     -- % de la ganancia
    activa INTEGER DEFAULT 1,
    baja TEXT,                    -- YYYY-MM-DD de la baja
    createdAt TEXT
  );
  CREATE INDEX IF NOT EXISTS ix_nc_caja_cli ON nc_caja(cliente_id);
  CREATE TABLE IF NOT EXISTS nc_cobro (
    id TEXT PRIMARY KEY,
    cliente_id TEXT NOT NULL,
    tipo TEXT NOT NULL,           -- mes | conexion
    ref TEXT NOT NULL,            -- YYYY-MM (mes) o el id de la caja (conexion)
    fecha TEXT,                   -- el día que se cobra
    vence TEXT,
    cajas TEXT,                   -- JSON: [{caja, sitio, chatId, lineas:[{k,v,cat,nota}], total}]
    total TEXT,
    exacto TEXT,                  -- total + los centavos que identifican su pago
    createdAt TEXT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS ux_nc_cobro ON nc_cobro(cliente_id, tipo, ref);
  CREATE TABLE IF NOT EXISTS nc_pago (
    id TEXT PRIMARY KEY,
    cobro_id TEXT NOT NULL,
    monto TEXT,
    red TEXT,                     -- TRC20 | BEP20 | Pesos
    hash TEXT,
    como TEXT,                    -- «registrado a mano», «código que pegó el cliente», …
    fecha TEXT,
    por TEXT,
    createdAt TEXT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS ux_nc_pago_hash ON nc_pago(hash) WHERE hash IS NOT NULL AND hash <> '';
  CREATE INDEX IF NOT EXISTS ix_nc_pago_cobro ON nc_pago(cobro_id);
  CREATE TABLE IF NOT EXISTS nc_aviso (
    id TEXT PRIMARY KEY,
    cobro_id TEXT NOT NULL,
    cliente_id TEXT,
    hash TEXT,
    estado TEXT DEFAULT 'pendiente', -- pendiente | aprobado | rechazado
    creado TEXT,
    resuelto TEXT,
    pago_id TEXT
  );
  CREATE TABLE IF NOT EXISTS nc_mes (
    mes TEXT PRIMARY KEY,
    armado TEXT, sale_solo TEXT, enviado TEXT, frenado INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS nc_envio (
    id TEXT PRIMARY KEY,
    cliente_id TEXT, ref TEXT,    -- el cobro, o «rec:<mes>:<día>» para un recordatorio
    ok INTEGER, error TEXT, at TEXT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS ux_nc_envio ON nc_envio(cliente_id, ref);
  CREATE TABLE IF NOT EXISTS nc_gasto (
    id TEXT PRIMARY KEY,
    fecha TEXT, concepto TEXT, cat TEXT, cliente_id TEXT,
    pago TEXT,                    -- alexa | prog: quién lo pagó
    monto TEXT, cada INTEGER DEFAULT 0,
    borrado TEXT, borrado_por TEXT, createdAt TEXT
  );
  CREATE TABLE IF NOT EXISTS nc_pago_prog (
    id TEXT PRIMARY KEY, fecha TEXT, monto TEXT, nota TEXT, createdAt TEXT
  );
`);

/* «Hoy» en hora argentina. NC_HOY existe solo para las pruebas (test/nuestro-chat.js): fija el día. */
const hoyAR = () => process.env.NC_HOY || fechaTZ();
const mesAR = () => hoyAR().slice(0, 7);
/* Primer mes de regalo (Alexa, 25-oct): sin conexión, los días del primer mes se cobran con el 1 que
   viene, salvo que la caja lo tenga marcado como regalo. */
try { db.exec('ALTER TABLE nc_caja ADD COLUMN regalo INTEGER DEFAULT 0'); } catch (e) { /* ya estaba */ }
const nid = (p) => p + '_' + crypto.randomBytes(5).toString('hex');
const ahora = () => new Date().toISOString();
const esFecha = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
const esMes = (s) => /^\d{4}-\d{2}$/.test(String(s || ''));
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const nm = (m) => MESES[Number(String(m).slice(5, 7)) - 1] || m;
const antes = (m) => { const d = new Date(Date.UTC(+m.slice(0, 4), +m.slice(5, 7) - 2, 1)); return d.toISOString().slice(0, 7); };
const despues = (m) => { const d = new Date(Date.UTC(+m.slice(0, 4), +m.slice(5, 7), 1)); return d.toISOString().slice(0, 7); };
const diasDelMes = (d) => new Date(Date.UTC(+d.slice(0, 4), +d.slice(5, 7), 0)).getUTCDate();
const masDias = (d, n) => new Date(Date.parse(d + 'T12:00:00Z') + n * 864e5).toISOString().slice(0, 10);
const fmt = (n) => Number(n).toLocaleString('es-AR', { maximumFractionDigits: 0 });
const fmt2 = (n) => Number(n).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
/* Plata tipeada: punto o coma decimal, nunca separador de miles (el formulario manda números). */
/* «1.400» se rechaza en vez de leerse como 1,40: con puntos de miles no se sabe qué quiso decir. */
const num = (v) => { const raw = String(v == null ? '' : v).trim(); if (/^\d{1,3}(\.\d{3})+$/.test(raw)) return null; const s = raw.replace(',', '.'); return money.esNumero(s) ? s : null; };

/* ── LA CONFIGURACIÓN ───────────────────────────────────────────────────────────────────────── */
const C = {
  trc20: ['ncTrc20', ''], bep20: ['ncBep20', ''], entrada: ['ncEntrada', '200'], mant: ['ncMant', '150'],
  pct: ['ncPct', '2'], venceDia: ['ncVenceDia', '5'], recordatorios: ['ncRecordatorios', '3,5'],
  esperaHoras: ['ncEsperaHoras', '24'], juntarDias: ['ncJuntarDias', '7'],
  cartelTexto: ['ncCartelTexto', 'Por favor regularizá tu pago del chat para seguir usando esta sección.'],
  programador: ['ncProgramador', 'Programador'], repartoProg: ['ncRepartoProg', '50'], repartoBase: ['ncRepartoBase', 'neto'],
  pesosOn: ['ncPesosOn', '0'], pesosComision: ['ncPesosComision', '4'], alias: ['ncAlias', ''], titular: ['ncTitular', ''],
};
function config() {
  const o = {};
  for (const [k, [key, def]] of Object.entries(C)) { const v = cfg.getCfg(key); o[k] = v == null || v === '' ? def : String(v); }
  return {
    ...o, venceDia: Number(o.venceDia), esperaHoras: Number(o.esperaHoras), juntarDias: Number(o.juntarDias),
    repartoProg: Number(o.repartoProg), pesosOn: o.pesosOn === '1', pesosComision: Number(o.pesosComision),
    recordatorios: String(o.recordatorios).split(/[\s,;]+/).map(Number).filter((n) => n >= 1 && n <= 28),
  };
}
/* Las direcciones se validan con su dígito de control: una letra mal copiada es plata que no vuelve. */
function trc20Valida(a) {
  const A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  if (!/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(String(a || ''))) return false;
  let n = 0n; for (const c of a) n = n * 58n + BigInt(A.indexOf(c));
  const b = Buffer.from(n.toString(16).padStart(50, '0'), 'hex');
  const h = crypto.createHash('sha256').update(crypto.createHash('sha256').update(b.subarray(0, 21)).digest()).digest();
  return b[0] === 0x41 && h.subarray(0, 4).equals(b.subarray(21));
}
const bep20Valida = (a) => /^0x[0-9a-fA-F]{40}$/.test(String(a || ''));
function setConfig(d) {
  d = d || {};
  if (d.trc20 != null && d.trc20 !== '' && !trc20Valida(String(d.trc20).trim())) return { ok: false, error: 'La dirección TRC20 no es válida: copiala de nuevo, entera.' };
  if (d.bep20 != null && d.bep20 !== '' && !bep20Valida(String(d.bep20).trim())) return { ok: false, error: 'La dirección BEP20 no es válida: empieza con 0x y tiene 40 letras y números más.' };
  const enteros = { venceDia: [1, 28], esperaHoras: [0, 240], juntarDias: [0, 15], repartoProg: [0, 100] };
  for (const [k, [a, b]] of Object.entries(enteros)) {
    if (d[k] == null) continue; const v = Number(d[k]);
    if (!Number.isInteger(v) || v < a || v > b) return { ok: false, error: `«${k}» va entre ${a} y ${b}.` };
  }
  for (const k of ['entrada', 'mant', 'pesosComision']) if (d[k] != null && (num(d[k]) == null || money.isNeg(num(d[k])))) return { ok: false, error: `«${k}» tiene que ser un número.` };
  if (d.pct != null && !(Number(num(d.pct)) >= 1 && Number(num(d.pct)) <= 4)) return { ok: false, error: 'El % va entre 1 y 4.' };
  if (d.repartoBase != null && !['neto', 'bruto'].includes(d.repartoBase)) return { ok: false, error: 'Reparto: «neto» o «bruto».' };
  for (const [k, [key]] of Object.entries(C)) {
    if (d[k] == null) continue;
    let v = d[k];
    if (k === 'pesosOn') v = v === true || v === '1' || v === 1 ? '1' : '0';
    else if (k === 'recordatorios') v = (Array.isArray(v) ? v : String(v).split(/[\s,;]+/)).map(Number).filter((n) => n >= 1 && n <= 28).join(',');
    else if (['entrada', 'mant', 'pct', 'pesosComision'].includes(k)) v = num(v);
    else v = String(v).trim().slice(0, k === 'cartelTexto' ? 140 : 120);
    cfg.setCfg(key, v);
  }
  return { ok: true, config: config() };
}

/* ── CLIENTES Y CAJAS ───────────────────────────────────────────────────────────────────────── */
const cliRow = (id) => db.prepare('SELECT * FROM nc_cliente WHERE cliente_id=?').get(String(id));
const nombreCli = (id) => { const c = clientesStore.get(id); return c ? (c.nombreVisible || c.nombre || c.codigo) : id; };
const codigoCli = (id) => { const c = clientesStore.get(id); return c ? c.codigo : ''; };
const cajasDe = (id) => db.prepare('SELECT * FROM nc_caja WHERE cliente_id=? ORDER BY createdAt').all(String(id));
const todasLasCajas = () => db.prepare('SELECT * FROM nc_caja').all();
function urlPublica() { return cfg.getUrlPublica() || 'https://app.latamgames.online'; }
const linkDe = (r) => urlPublica() + '/mi-chat/' + r.token;

function sumarCliente(clienteId) {
  if (!clientesStore.get(clienteId)) return { ok: false, error: 'Ese cliente no existe en el OS.' };
  if (cliRow(clienteId)) return { ok: true, ya: true };
  db.prepare('INSERT INTO nc_cliente (cliente_id, token, createdAt) VALUES (?,?,?)')
    .run(String(clienteId), crypto.randomBytes(18).toString('base64url'), ahora());
  return { ok: true };
}
function setCliente(clienteId, d) {
  if (!cliRow(clienteId)) return { ok: false, error: 'Ese cliente no tiene el chat.' };
  const tg = d.tg != null ? String(d.tg).split(/[\s,;]+/).filter((x) => /^-?\d{5,20}$/.test(x)).join(',') : null;
  if (d.tg != null && String(d.tg).trim() && !tg) return { ok: false, error: 'El grupo de Telegram es un número (ej. -1001234567890).' };
  db.prepare('UPDATE nc_cliente SET tg_grupo=COALESCE(?,tg_grupo), pesos=COALESCE(?,pesos) WHERE cliente_id=?')
    .run(tg, d.pesos == null ? null : (d.pesos ? 1 : 0), String(clienteId));
  return { ok: true };
}
/* Otro link: el anterior deja de servir (por si se lo pasaron a quien no debía). */
function nuevoToken(clienteId) {
  if (!cliRow(clienteId)) return { ok: false, error: 'Ese cliente no tiene el chat.' };
  db.prepare('UPDATE nc_cliente SET token=? WHERE cliente_id=?').run(crypto.randomBytes(18).toString('base64url'), String(clienteId));
  return { ok: true };
}
function clientePorToken(token) {
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(String(token || ''))) return null;
  return db.prepare('SELECT * FROM nc_cliente WHERE token=?').get(String(token)) || null;
}

function guardarCaja(d) {
  d = d || {};
  const cid = String(d.cliente || '');
  if (!cliRow(cid)) return { ok: false, error: 'Primero sumá el cliente.' };
  const prev = d.id ? db.prepare('SELECT * FROM nc_caja WHERE id=? AND cliente_id=?').get(String(d.id), cid) : null;
  if (d.id && !prev) return { ok: false, error: 'Esa caja no existe.' };
  const c = config();
  const v = {
    caja: String(d.caja != null ? d.caja : (prev ? prev.caja : '')).trim().slice(0, 60),
    sitio: String(d.sitio != null ? d.sitio : (prev ? prev.sitio : '')).trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').slice(0, 80),
    chat_id: String(d.chatId != null ? d.chatId : (prev ? prev.chat_id : '')).trim().slice(0, 40),
    conexion_id: String(d.conexion != null ? d.conexion : (prev ? prev.conexion_id : '')).trim(),
    sala_id: String(d.sala != null ? d.sala : (prev ? prev.sala_id : '')).trim(),
    desde: d.desde != null ? String(d.desde).trim() : (prev ? prev.desde || '' : ''),
    entrada: num(d.entrada != null ? d.entrada : (prev ? prev.entrada : c.entrada)),
    mant: num(d.mant != null ? d.mant : (prev ? prev.mant : c.mant)),
    pct: num(d.pct != null ? d.pct : (prev ? prev.pct : c.pct)),
    regalo: d.regalo != null ? (d.regalo === true || d.regalo === '1' || d.regalo === 1 ? 1 : 0) : (prev ? prev.regalo || 0 : 0),
  };
  if (!v.caja) return { ok: false, error: 'Falta el nombre de la caja.' };
  if (!/^\d{3,15}$/.test(v.sala_id)) return { ok: false, error: 'El número de la caja en Imperia son solo números (ej. 7505635).' };
  if (!conexiones.get(v.conexion_id)) return { ok: false, error: 'Elegí si la caja es de Europa o de Casino.' };
  if (v.desde && !esFecha(v.desde)) return { ok: false, error: 'La fecha de inicio no es válida.' };
  if (v.entrada == null || money.isNeg(v.entrada)) return { ok: false, error: 'La conexión es un monto (0 si no se cobra).' };
  if (v.mant == null || money.isNeg(v.mant)) return { ok: false, error: 'El mantenimiento es un monto.' };
  if (!(Number(v.pct) >= 1 && Number(v.pct) <= 4)) return { ok: false, error: 'El % va entre 1 y 4.' };
  const otra = db.prepare('SELECT c.id, c.cliente_id FROM nc_caja c WHERE c.conexion_id=? AND c.sala_id=? AND c.activa=1 AND c.id<>?').get(v.conexion_id, v.sala_id, String(d.id || ''));
  if (otra) return { ok: false, error: `Esa caja de Imperia ya está cargada${otra.cliente_id !== cid ? ' en ' + nombreCli(otra.cliente_id) : ''}.` };
  /* La fecha de inicio no se puede mover si ya salió un cobro que dependía de ella: el cobro ya está
     mandado y cambiaría por debajo. Se avisa en vez de recalcular en silencio. */
  if (prev && prev.desde && v.desde !== prev.desde) {
    const ya = db.prepare("SELECT COUNT(*) n FROM nc_cobro WHERE (tipo='conexion' AND ref=?) OR (tipo='mes' AND cliente_id=? AND ref>?)").get(prev.id, cid, prev.desde.slice(0, 7)).n;
    if (ya) return { ok: false, error: 'Ya salió un cobro con la fecha de inicio anterior: no se puede mover. Si está mal, escribime.' };
  }
  const pedir = !prev || prev.desde !== v.desde || prev.sala_id !== v.sala_id || prev.conexion_id !== v.conexion_id;
  if (prev) {
    db.prepare('UPDATE nc_caja SET caja=@caja, sitio=@sitio, chat_id=@chat_id, conexion_id=@conexion_id, sala_id=@sala_id, desde=@desde, entrada=@entrada, mant=@mant, pct=@pct, regalo=@regalo WHERE id=@id')
      .run({ ...v, id: prev.id });
    if (pedir) pedirRecaptura({ ...v, id: prev.id });
    return { ok: true, id: prev.id };
  }
  const id = nid('ncj');
  db.prepare(`INSERT INTO nc_caja (id, cliente_id, caja, sitio, chat_id, conexion_id, sala_id, desde, entrada, mant, pct, regalo, activa, createdAt)
    VALUES (@id,@cliente_id,@caja,@sitio,@chat_id,@conexion_id,@sala_id,@desde,@entrada,@mant,@pct,@regalo,1,@at)`).run({ ...v, id, cliente_id: cid, at: ahora() });
  pedirRecaptura({ ...v, id });
  return { ok: true, id };
}
/* LA GANANCIA DE LOS DÍAS PASADOS. De noche se junta solo «ayer»: si la caja se carga con un inicio
   de hace dos semanas, esos días no tienen la ganancia de su caja y el % saldría de menos sin avisar.
   Al guardar un inicio pasado se le vuelven a pedir a Imperia esos días, de a uno y en segundo plano
   (los mismos que el acumulado; captureDia guarda los niveles de siempre y las salas del chat). */
const _recaptura = { cola: [], corriendo: false, estado: {} };
function pedirRecaptura(c) {
  const ayer = masDias(hoyAR(), -1);
  if (!c.desde || c.desde > ayer) return;
  const desde = c.desde < masDias(hoyAR(), -62) ? masDias(hoyAR(), -62) : c.desde;   // como mucho dos meses
  for (let d = desde; d <= ayer; d = masDias(d, 1)) {
    const k = c.conexion_id + '|' + d;
    if (!_recaptura.cola.includes(k)) _recaptura.cola.push(k);
  }
  _recaptura.estado[c.id] = { desde, hasta: ayer, pendiente: true };
  if (process.env.NODE_ENV === 'test') return;
  _correrRecaptura();
}
async function _correrRecaptura() {
  if (_recaptura.corriendo) return;
  _recaptura.corriendo = true;
  const acum = require('./acumulado.service');
  try {
    while (_recaptura.cola.length) {
      const [cx, dia] = _recaptura.cola.shift().split('|');
      try { await acum.captureDia(cx, dia, 'superagent'); } catch (e) { console.warn('[nuestro-chat] recaptura', dia, e.message); }
      await new Promise((r) => setTimeout(r, 1500));   // de a uno, sin apurar al casino
    }
  } finally {
    _recaptura.corriendo = false;
    for (const k of Object.keys(_recaptura.estado)) _recaptura.estado[k].pendiente = false;
  }
}
const recapturando = (cajaId) => !!(_recaptura.estado[cajaId] && _recaptura.estado[cajaId].pendiente);

function marcarInicio(cajaId, fecha) {
  const c = db.prepare('SELECT * FROM nc_caja WHERE id=?').get(String(cajaId));
  if (!c) return { ok: false, error: 'Esa caja no existe.' };
  if (!esFecha(fecha)) return { ok: false, error: 'Elegí el día que empieza.' };
  const r = guardarCaja({ id: c.id, cliente: c.cliente_id, desde: fecha });
  if (!r.ok) return r;
  const n = { ...c, desde: fecha };
  const hoy = hoyAR();
  const texto = !money.isPos(n.entrada) ? 'Inicio guardado: no se cobra conexión.'
    : junta(n) ? 'Inicio guardado: la conexión va junto con el cobro del 1.'
    : fecha > hoy ? `Inicio guardado: la conexión se cobra el ${+fecha.slice(8)}/${+fecha.slice(5, 7)}.`
    : 'Inicio guardado: salió el cobro de la conexión.';
  armarConexiones(hoy);
  pedirRecaptura(n);
  return { ok: true, texto: texto + (fecha < hoy ? ' Estamos trayendo de Imperia la ganancia desde ese día.' : '') };
}
/* La baja no devuelve el mes ya pagado (es por adelantado): solo deja de cobrar desde el mes que viene. */
function darDeBaja(cajaId) {
  const c = db.prepare('SELECT * FROM nc_caja WHERE id=? AND activa=1').get(String(cajaId));
  if (!c) return { ok: false, error: 'Esa caja no existe o ya está dada de baja.' };
  db.prepare('UPDATE nc_caja SET activa=0, baja=? WHERE id=?').run(hoyAR(), c.id);
  return { ok: true };
}

/* Las salas que el acumulado tiene que guardar para esta conexión (acumulado.service.js). */
function salasActivas(conexionId) {
  return db.prepare("SELECT sala_id FROM nc_caja WHERE conexion_id=? AND (activa=1 OR baja >= date('now','-62 days'))")
    .all(String(conexionId)).map((r) => String(r.sala_id));
}

/* ── LOS RENGLONES DE UN COBRO ──────────────────────────────────────────────────────────────── */
function junta(c) {
  const J = config().juntarDias;
  return !!c.desde && J > 0 && Number(c.desde.slice(8)) > diasDelMes(c.desde) - J;
}
/* Sin conexión, nada cubre el primer mes: se cobran sus días (del inicio al fin de mes), proporcional. */
function lineaPrimerMes(c) {
  if (money.isPos(c.entrada) || c.regalo || !c.desde) return null;
  const dm = diasDelMes(c.desde), d = Number(c.desde.slice(8)), dias = dm - d + 1;
  return { k: `Días de ${nm(c.desde)}, del ${d} al ${dm} (sin conexión)`, v: money.round(money.div(money.mul(c.mant, String(dias)), String(dm)), 2), cat: 'mant',
    nota: `${dias} de ${dm} días de ${fmt(c.mant)} USD` };
}
const lineaConexion = (c) => ({ k: 'Conexión (una vez) · cubre hasta el fin de ' + nm(c.desde), v: money.round(c.entrada, 2), cat: 'entrada' });

/* El % de una caja sobre la ganancia de un mes, desde su inicio (y hasta su baja). `g` es la
   ganancia del mes ya leída una vez (chatExterno.gananciaDelMes), para no leerla por caja. */
function lineaPct(c, mes, g, { sinDatosEsCero = false } = {}) {
  const pctTxt = String(Number(c.pct)).replace('.', ',');
  const k = `${pctTxt} % de la ganancia de ${nm(mes)}` + (c.desde && c.desde.slice(0, 7) === mes ? ` (desde el ${+c.desde.slice(8)})` : '');
  const hoy = hoyAR();
  if (c.desde && c.desde > hoy && c.desde.slice(0, 7) === mes) return { l: { k, v: '0', cat: 'variable', nota: `empieza el ${+c.desde.slice(8)}: la ganancia cuenta desde ese día` } };
  const monedas = [];
  for (const [key, porDia] of g) {
    const [cx, grp, nodo, mon] = key.split('|');
    if (cx !== String(c.conexion_id) || grp !== 'chat' || nodo !== String(c.sala_id)) continue;
    let profit = 0; let dias = 0;
    for (const [dia, v] of porDia) {
      if (c.desde && dia < c.desde) continue;
      if (c.baja && dia > c.baja) continue;
      profit += v; dias += 1;
    }
    if (dias) monedas.push({ mon, profit });
  }
  if (recapturando(c.id)) {
    return { l: { k, cat: 'variable', falta: 'trayendo la ganancia de Imperia' },
      aviso: { tipo: 'sin-datos', corto: 'trayendo la ganancia', texto: `Estamos trayendo de Imperia la ganancia de ${c.caja} desde su fecha de inicio: en unos minutos se calcula.` } };
  }
  if (!monedas.length) {
    if (sinDatosEsCero) return { l: { k, v: '0', cat: 'variable', nota: 'sin movimiento en Imperia ese mes (confirmado a mano)' } };
    return { l: { k, cat: 'variable', falta: 'sin datos de Imperia' },
      aviso: { tipo: 'sin-datos', corto: 'sin datos de la caja', texto: `Imperia no tiene la ganancia de ${c.caja} en ${nm(mes)}: fijate que el número de la caja (${c.sala_id}) esté bien y capturá el mes. Si de verdad no tuvo movimiento, armalo con «sin movimiento».` } };
  }
  let usdt = '0'; const partes = [];
  for (const x of monedas) {
    const t = tcUnico.tcDelMes(x.mon, mes);
    if (!t || !t.valor || !money.isPos(String(t.valor))) {
      return { l: { k, cat: 'variable', falta: 'falta el cambio de ' + x.mon },
        aviso: { tipo: 'sin-tc', corto: 'falta el cambio de ' + x.mon, texto: `Falta el tipo de cambio de ${x.mon} de ${nm(mes)}: cargalo en Tipos de cambio y se calcula solo.` } };
    }
    const u = money.div(String(x.profit), String(t.valor));
    usdt = money.add(usdt, u);
    partes.push(x.mon === 'USDT' || x.mon === 'USD' ? `${fmt2(x.profit)} ${x.mon}` : `${fmt(x.profit)} ${x.mon} al cambio ${fmt2(t.valor)} (promedio de ${nm(mes)}) = ${fmt2(u)} USDT`);
  }
  if (!money.isPos(usdt)) return { l: { k, v: '0', cat: 'variable', nota: 'ganancia ' + partes.join(' + ') + ': el mes dio pérdida, el % es cero' } };
  return { l: { k, v: money.round(money.pct(usdt, c.pct), 2), cat: 'variable', nota: 'ganancia ' + partes.join(' + ') } };
}
function cajaDoc(c, lineas, avisos) {
  const total = lineas.some((l) => l.falta) ? null : money.round(money.sum(lineas.map((l) => l.v)), 2);
  return { cajaId: c.id, caja: c.caja, sitio: c.sitio, chatId: c.chat_id, lineas, avisos: avisos || [], total };
}
/* Las cajas que entran en el cobro del 1 de `M`: empezaron antes de ese día y no se dieron de baja
   antes del mes que cerró (una baja de octubre igual paga el % de octubre en noviembre). */
function cajasDelCobro(cajas, M) {
  return cajas.filter((c) => c.desde && c.desde < M + '-01' && (c.activa || (c.baja && c.baja >= antes(M) + '-01')));
}
function lineasDelMes(c, M, g, op) {
  const L = [];
  if (money.isPos(c.entrada) && junta(c) && c.desde.slice(0, 7) === antes(M)) L.push(lineaConexion(c));
  if (c.desde.slice(0, 7) === antes(M)) { const pm = lineaPrimerMes(c); if (pm) L.push(pm); }
  if (c.activa || (c.baja && c.baja >= M + '-01')) L.push({ k: `Mantenimiento de ${nm(M)} (por adelantado)`, v: money.round(c.mant, 2), cat: 'mant' });
  const p = lineaPct(c, antes(M), g, op);
  L.push(p.l);
  return { lineas: L, aviso: p.l.falta ? p.aviso : null };
}

/* Centavos que identifican el pago: ningún cobro abierto puede tener el mismo monto exacto. */
function exactoUnico(total) {
  const abiertos = new Set(listarCobros().filter((d) => d.estado !== 'pagado').map((d) => money.round(d.exacto, 2)));
  for (let c = 1; c <= 99; c++) {
    const e = money.round(money.add(total, String(c / 100)), 2);
    if (!abiertos.has(e)) return e;
  }
  for (let c = 1; c <= 999; c++) {     // más de 99 abiertos con el mismo total: se suma un dólar
    const e = money.round(money.add(total, String(1 + c / 1000)), 3);
    if (!abiertos.has(e)) return e;
  }
  return money.round(total, 2);
}
function insertarCobro({ cliente_id, tipo, ref, fecha, vence, cajas }) {
  const total = money.round(money.sum(cajas.map((c) => c.total)), 2);
  if (!money.isPos(total)) return { ok: false, motivo: 'en cero' };
  const id = nid('ncb');
  const r = db.prepare(`INSERT OR IGNORE INTO nc_cobro (id, cliente_id, tipo, ref, fecha, vence, cajas, total, exacto, createdAt)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(id, cliente_id, tipo, ref, fecha, vence, JSON.stringify(cajas), total, exactoUnico(total), ahora());
  return r.changes ? { ok: true, id } : { ok: false, motivo: 'ya estaba' };
}

/* El cobro del 1 de `M`, para todos o para un cliente. Idempotente: lo que ya salió no se toca. */
function armarMes(M, { cliente = null, sinDatosEsCero = false } = {}) {
  if (!esMes(M)) return { ok: false, error: 'mes inválido' };
  const g = chatExterno.gananciaDelMes(antes(M));
  const out = { ok: true, creados: 0, yaEstaban: 0, problemas: [] };
  const clis = db.prepare('SELECT * FROM nc_cliente').all().filter((r) => !cliente || r.cliente_id === cliente);
  const venceDia = String(config().venceDia).padStart(2, '0');
  for (const r of clis) {
    const cajas = cajasDelCobro(cajasDe(r.cliente_id), M);
    if (!cajas.length) continue;
    if (db.prepare("SELECT 1 FROM nc_cobro WHERE cliente_id=? AND tipo='mes' AND ref=?").get(r.cliente_id, M)) { out.yaEstaban++; continue; }
    const docs = []; let malo = null;
    for (const c of cajas) {
      const { lineas, aviso } = lineasDelMes(c, M, g, { sinDatosEsCero });
      if (aviso) malo = malo || aviso;
      docs.push(cajaDoc(c, lineas, aviso ? [aviso] : []));
    }
    if (malo) { out.problemas.push({ clienteId: r.cliente_id, cliente: nombreCli(r.cliente_id), texto: malo.corto, detalle: malo.texto }); continue; }
    const x = insertarCobro({ cliente_id: r.cliente_id, tipo: 'mes', ref: M, fecha: M + '-01', vence: `${M}-${venceDia}`, cajas: docs });
    if (x.ok) out.creados++; else if (x.motivo === 'ya estaba') out.yaEstaban++;
  }
  return out;
}
/* Las conexiones que vencen hoy o antes y no van con el cobro del 1. */
function armarConexiones(hoy = hoyAR()) {
  let creados = 0;
  for (const c of todasLasCajas()) {
    if (!c.activa || !c.desde || c.desde > hoy || !money.isPos(c.entrada) || junta(c)) continue;
    /* Todo cuenta desde la fecha de inicio que ella pone, aunque sea pasada (Alexa, 24-oct: «Fran
       comenzó hace un par de semanas»). Pero si se carga después de empezar, la conexión vence a los
       5 días de HOY: si no, saldría ya vencida y con el cartel puesto el mismo día. Al que no se le
       cobra conexión se le pone 0. */
    const x = insertarCobro({ cliente_id: c.cliente_id, tipo: 'conexion', ref: c.id, fecha: c.desde, vence: masDias(c.desde > hoy ? c.desde : hoy, 5),
      cajas: [cajaDoc(c, [lineaConexion(c)], [])] });
    if (x.ok) creados++;
  }
  return { creados };
}

/* ── LOS COBROS, CON SU ESTADO ──────────────────────────────────────────────────────────────── */
function listarCobros(where = '', params = []) {
  const hoy = hoyAR();
  return db.prepare('SELECT * FROM nc_cobro ' + where + ' ORDER BY fecha, createdAt').all(...params).map((d) => {
    const pagos = db.prepare('SELECT * FROM nc_pago WHERE cobro_id=? ORDER BY fecha, createdAt').all(d.id);
    const pagado = money.round(money.sum(pagos.map((p) => p.monto)), 2);
    const debe = money.round(money.max('0', money.sub(d.exacto, pagado)), 2);
    const estado = money.cmp(debe, '0.01') <= 0 ? 'pagado' : hoy > d.vence ? 'vencido' : 'pendiente';
    const titulo = d.tipo === 'mes' ? `Cobro del 1 de ${nm(d.ref)}` : 'Conexión · ' + ((JSON.parse(d.cajas || '[]')[0] || {}).caja || '');
    return { id: d.id, clienteId: d.cliente_id, tipo: d.tipo, ref: d.ref, titulo, fecha: d.fecha, vence: d.vence,
      cajas: JSON.parse(d.cajas || '[]'), total: d.total, exacto: d.exacto, pagado, debe, estado,
      pagos: pagos.map((p) => ({ id: p.id, t: p.fecha, monto: p.monto, red: p.red, hash: p.hash || '', como: p.como })) };
  });
}
function cartelDe(clienteId, docs) {
  const r = cliRow(clienteId) || {};
  const hoy = hoyAR();
  const mios = docs.filter((d) => d.clienteId === clienteId).sort((a, b) => (a.vence < b.vence ? -1 : 1));
  const venc = mios.find((d) => d.estado === 'vencido'), pend = mios.find((d) => d.estado === 'pendiente');
  const pr = r.prorroga && r.prorroga >= hoy ? r.prorroga : null;
  if (venc) return { activo: !pr, desde: masDias(venc.vence, 1), prorroga: pr };
  if (pend) return { activo: false, desde: masDias(pend.vence, 1) };
  return { activo: false };
}
function prorroga(clienteId, hasta) {
  if (!cliRow(clienteId)) return { ok: false, error: 'Ese cliente no tiene el chat.' };
  if (hasta && !esFecha(hasta)) return { ok: false, error: 'Elegí hasta qué día.' };
  if (hasta && hasta < hoyAR()) return { ok: false, error: 'La fecha ya pasó.' };
  db.prepare('UPDATE nc_cliente SET prorroga=? WHERE cliente_id=?').run(hasta || null, String(clienteId));
  return { ok: true };
}

function estadoMes(M) {
  const r = db.prepare('SELECT * FROM nc_mes WHERE mes=?').get(M) || {};
  if (r.armado === 'omitido') return { armado: null, saleSolo: null, enviado: null, frenado: false, omitido: true };
  return { armado: r.armado || null, saleSolo: r.sale_solo || null, enviado: r.enviado || null, frenado: !!r.frenado };
}
function cobrosDe(M) {
  if (!esMes(M)) M = mesAR();
  armarConexiones();
  const docs = listarCobros();
  const delMes = docs.filter((d) => d.fecha.slice(0, 7) === M);
  const c = config();
  const envios = db.prepare('SELECT * FROM nc_envio').all();
  const cls = db.prepare('SELECT * FROM nc_cliente').all().map((r) => {
    /* Lo que sigue abierto de meses anteriores va en la misma tarjeta: si no, un cliente «pagó» este
       mes debiendo la conexión de antes, y el cartel que tiene no se entiende. */
    const viejos = M === mesAR() ? docs.filter((d) => d.clienteId === r.cliente_id && d.fecha < M + '-01' && d.estado !== 'pagado').map((d) => ({ ...d, deAntes: true })) : [];
    const mis = viejos.concat(delMes.filter((d) => d.clienteId === r.cliente_id));
    if (!mis.length) return null;
    const exacto = money.round(money.sum(mis.map((d) => d.exacto)), 2), pagado = money.round(money.sum(mis.map((d) => d.pagado)), 2), debe = money.round(money.sum(mis.map((d) => d.debe)), 2);
    const venc = mis.filter((d) => d.estado === 'vencido');
    const estado = money.cmp(debe, '0.01') <= 0 ? 'pagado' : venc.length ? 'vencido' : 'pendiente';
    const diasVencido = venc.length ? Math.floor((Date.parse(hoyAR()) - Date.parse(venc.map((d) => d.vence).sort()[0])) / 864e5) : 0;
    const env = envios.filter((e) => e.cliente_id === r.cliente_id && mis.some((d) => d.id === e.ref)).sort((a, b) => (a.at < b.at ? 1 : -1))[0];
    const rec = envios.filter((e) => e.cliente_id === r.cliente_id && String(e.ref).startsWith('rec:' + M + ':'))
      .map((e) => ({ dia: Number(String(e.ref).split(':')[2]), ok: !!e.ok }));
    return { id: r.cliente_id, nombre: nombreCli(r.cliente_id), link: linkDe(r), ver: linkDe(r), docs: mis, exacto, pagado, debe, estado, diasVencido,
      cartel: M === mesAR() ? cartelDe(r.cliente_id, docs) : {},
      recordatorios: rec, envio: env ? { t: env.at, ok: !!env.ok, error: env.error || '' } : (r.tg_grupo ? null : { t: null, ok: false, error: 'no tiene grupo de Telegram: mandale el link a mano' }) };
  }).filter(Boolean);
  const meses = [...new Set(docs.map((d) => d.fecha.slice(0, 7)).concat([M, mesAR()]))].sort().reverse();
  const T = { total: '0', cobrado: '0', pendiente: '0', vencido: '0', clientes: cls.length, nPagaron: 0, nVencidos: 0, nCartel: 0 };
  for (const x of cls) {
    T.total = money.add(T.total, x.exacto); T.cobrado = money.add(T.cobrado, x.pagado); T.pendiente = money.add(T.pendiente, x.debe);
    if (x.estado === 'vencido') { T.vencido = money.add(T.vencido, x.debe); T.nVencidos++; }
    if (x.estado === 'pagado') T.nPagaron++;
    if (x.cartel && x.cartel.activo) T.nCartel++;
  }
  /* Los que no salieron (sin dato o sin cambio): se calculan acá, no se guardan. */
  const problemas = M === mesAR() ? armarMesSimulado(M) : [];
  return { ok: true, mes: M, meses, venceDia: c.venceDia, recordatorios: c.recordatorios, cartelTexto: c.cartelTexto, estado: estadoMes(M), totales: T, problemas,
    clientes: cls.sort((a, b) => money.cmp(b.debe, a.debe) || money.cmp(b.exacto, a.exacto)) };
}
/* Qué clientes deberían tener cobro del 1 de M y no lo tienen (sin guardar nada). */
function armarMesSimulado(M) {
  const g = chatExterno.gananciaDelMes(antes(M)); const out = [];
  for (const r of db.prepare('SELECT * FROM nc_cliente').all()) {
    const cajas = cajasDelCobro(cajasDe(r.cliente_id), M);
    if (!cajas.length || db.prepare("SELECT 1 FROM nc_cobro WHERE cliente_id=? AND tipo='mes' AND ref=?").get(r.cliente_id, M)) continue;
    for (const c of cajas) { const { aviso } = lineasDelMes(c, M, g); if (aviso) { out.push({ clienteId: r.cliente_id, cliente: nombreCli(r.cliente_id), texto: aviso.corto + ': ese cobro no sale hasta que lo arregles' }); break; } }
  }
  return out;
}

/* ── ESTE MES: lo que saldría el 1 si el mes terminara hoy ──────────────────────────────────── */
function tablero() {
  armarConexiones();
  const M = mesAR(), P = despues(M);
  const g = chatExterno.gananciaDelMes(M);
  const T = { total: '0', mant: '0', variable: '0', con: '0', clientes: 0, cajas: 0, sinCalcular: 0 };
  const clientes = db.prepare('SELECT * FROM nc_cliente').all().map((r) => {
    const cs = cajasDe(r.cliente_id).filter((c) => c.activa && c.desde && c.desde <= M + '-31');
    if (!cs.length) return null;
    const avisos = [];
    const cajas = cs.map((c) => {
      const L = [];
      if (money.isPos(c.entrada) && junta(c) && c.desde.slice(0, 7) === M) L.push(lineaConexion(c));
      if (c.desde.slice(0, 7) === M) { const pm = lineaPrimerMes(c); if (pm) L.push(pm); }
      L.push({ k: `Mantenimiento de ${nm(P)} (por adelantado)`, v: money.round(c.mant, 2), cat: 'mant' });
      const p = lineaPct(c, M, g); L.push(p.l);
      if (p.aviso && !avisos.some((a) => a.corto === p.aviso.corto)) avisos.push(p.aviso);
      return cajaDoc(c, L, p.aviso ? [p.aviso] : []);
    });
    if (!r.tg_grupo) avisos.push({ tipo: 'sin-tg', corto: 'sin grupo de Telegram', texto: 'Sin grupo de Telegram no le llega el cobro.' });
    const total = cajas.some((c) => c.total == null) ? null : money.round(money.sum(cajas.map((c) => c.total)), 2);
    T.clientes++;
    if (total == null) T.sinCalcular++;
    else {
      T.total = money.add(T.total, total);
      for (const c of cajas) { T.cajas++; for (const l of c.lineas) if (l.cat === 'mant') T.mant = money.add(T.mant, l.v); else if (l.cat === 'variable') T.variable = money.add(T.variable, l.v); else if (l.cat === 'entrada') T.con = money.add(T.con, l.v); }
    }
    return { id: r.cliente_id, nombre: nombreCli(r.cliente_id), codigo: codigoCli(r.cliente_id), total, avisos, cajas };
  }).filter(Boolean).sort((a, b) => money.cmp(b.total || '0', a.total || '0'));
  const ent = listarCobros("WHERE tipo='conexion' AND substr(fecha,1,7)=?", [M]);
  /* Hasta qué día tiene datos Imperia: el último día capturado con salas del chat. */
  const ult = db.prepare("SELECT MAX(fecha) f FROM reporte_diario WHERE grp='chat' AND substr(fecha,1,7)=?").get(M);
  return { ok: true, mes: M, proximo: P + '-01', datosHasta: (ult && ult.f) || null, totales: T,
    entradas: { n: ent.length, total: money.round(money.sum(ent.map((d) => d.total)), 2) }, clientes };
}

/* ── LOS PAGOS ──────────────────────────────────────────────────────────────────────────────── */
function hashValido(h, red) {
  h = String(h || '').trim();
  if (red === 'BEP20') return /^0x[0-9a-fA-F]{64}$/.test(h);
  if (red === 'TRC20') return /^[0-9a-fA-F]{64}$/.test(h);
  return /^(0x)?[0-9a-fA-F]{64}$/.test(h);
}
const redDeHash = (h) => (/^0x/i.test(String(h || '').trim()) ? 'BEP20' : 'TRC20');
function registrarPago({ cobro, monto, red, hash, como, fecha, por }) {
  const d = listarCobros('WHERE id=?', [String(cobro || '')])[0];
  if (!d) return { ok: false, error: 'Ese cobro no existe.' };
  const m = num(monto);
  if (m == null || !money.isPos(m)) return { ok: false, error: 'Poné cuánto pagó.' };
  if (money.cmp(m, money.add(d.debe, '1')) > 0) return { ok: false, error: `Es más de lo que debe (${d.debe}). Revisá el monto.` };
  const h = String(hash || '').trim();
  if (h && !hashValido(h, red)) return { ok: false, error: 'Ese código de transferencia no es válido: copialo entero.' };
  if (h && db.prepare('SELECT 1 FROM nc_pago WHERE lower(hash)=lower(?)').get(h)) return { ok: false, error: 'Ese código ya se usó para otro pago.' };
  const f = fecha && esFecha(fecha) ? fecha : hoyAR();
  const id = nid('ncp');
  db.prepare('INSERT INTO nc_pago (id, cobro_id, monto, red, hash, como, fecha, por, createdAt) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(id, d.id, money.round(m, 2), red || (h ? redDeHash(h) : 'TRC20'), h || null, String(como || 'registrado a mano').slice(0, 80), f, String(por || '').slice(0, 40), ahora());
  return { ok: true, id };
}
function borrarPago(id) {
  return { ok: db.prepare('DELETE FROM nc_pago WHERE id=?').run(String(id)).changes > 0 };
}
/* El cliente pega el código de su transferencia. En esta etapa NO se mira la red: queda para que
   Alexa lo apruebe (como el aviso con captura del Chat Externo). En la etapa 3 se comprueba solo. */
function avisarHash(token, cobroId, hash) {
  const r = clientePorToken(token);
  if (!r) return { ok: false, error: 'Ese link ya no sirve: pedí uno nuevo.' };
  const d = listarCobros('WHERE id=? AND cliente_id=?', [String(cobroId || ''), r.cliente_id])[0];
  if (!d) return { ok: false, error: 'No encontramos ese cobro.' };
  const h = String(hash || '').trim();
  if (h.length < 20) return { ok: false, error: 'Ese código está incompleto: copialo entero desde tu billetera.' };
  if (!hashValido(h)) return { ok: false, error: 'Ese código no es de una transferencia de USDT.' };
  if (db.prepare('SELECT 1 FROM nc_pago WHERE lower(hash)=lower(?)').get(h)) return { ok: false, error: 'Ese código ya se usó para otro pago.' };
  if (db.prepare("SELECT 1 FROM nc_aviso WHERE lower(hash)=lower(?) AND estado<>'rechazado'").get(h)) return { ok: true, estado: 'revisando', texto: 'Ya lo tenemos: lo estamos revisando.' };
  const pend = db.prepare("SELECT COUNT(*) n FROM nc_aviso WHERE cliente_id=? AND estado='pendiente'").get(r.cliente_id).n;
  if (pend >= 10) return { ok: false, error: 'Tenés muchos avisos sin revisar: esperá a que los revisemos.' };
  db.prepare('INSERT INTO nc_aviso (id, cobro_id, cliente_id, hash, estado, creado) VALUES (?,?,?,?,?,?)').run(nid('nca'), d.id, r.cliente_id, h, 'pendiente', ahora());
  return { ok: true, estado: 'revisando', texto: 'Recibimos el código: lo revisamos y te avisamos por tu grupo.' };
}
function resolverAviso(id, { aprobar, monto, por }) {
  const a = db.prepare("SELECT * FROM nc_aviso WHERE id=? AND estado='pendiente'").get(String(id));
  if (!a) return { ok: false, error: 'Ese aviso ya se resolvió.' };
  if (!aprobar) { db.prepare("UPDATE nc_aviso SET estado='rechazado', resuelto=? WHERE id=?").run(ahora(), a.id); return { ok: true }; }
  const d = listarCobros('WHERE id=?', [a.cobro_id])[0];
  const r = registrarPago({ cobro: a.cobro_id, monto: monto || d.debe, red: redDeHash(a.hash), hash: a.hash, como: 'código que pegó el cliente', por });
  if (!r.ok) return r;
  db.prepare("UPDATE nc_aviso SET estado='aprobado', resuelto=?, pago_id=? WHERE id=?").run(ahora(), r.id, a.id);
  return { ok: true };
}
function pagos() {
  const docs = listarCobros();
  const c = config();
  const movs = [];
  for (const d of docs) for (const p of d.pagos) {
    movs.push({ id: p.id, estado: 'asignado', t: p.t, red: p.red, monto: p.monto, hash: p.hash || '—', de: '—', cliente: nombreCli(d.clienteId), que: d.titulo,
      como: p.como, parcial: d.estado !== 'pagado', falta: d.debe,
      ver: !p.hash ? '' : (p.red === 'BEP20' ? 'https://bscscan.com/tx/' : 'https://tronscan.org/#/transaction/') + p.hash });
  }
  movs.sort((a, b) => (a.t < b.t ? 1 : -1));
  const avisos = db.prepare("SELECT * FROM nc_aviso WHERE estado='pendiente' ORDER BY creado").all().map((a) => {
    const d = docs.find((x) => x.id === a.cobro_id) || {};
    return { id: a.id, cliente: nombreCli(a.cliente_id), que: d.titulo, debe: d.debe, hash: a.hash, red: redDeHash(a.hash), t: a.creado,
      ver: (redDeHash(a.hash) === 'BEP20' ? 'https://bscscan.com/tx/' : 'https://tronscan.org/#/transaction/') + a.hash };
  });
  const M = mesAR(); const delMes = movs.filter((x) => String(x.t).slice(0, 7) === M);
  return { ok: true, avisos, pesos: [],
    /* Los saldos de las wallets se leen de la red en la etapa 3; hasta entonces, «—». */
    wallets: [{ red: 'TRC20', direccion: c.trc20, saldo: null, leido: null }, { red: 'BEP20', direccion: c.bep20, saldo: null, leido: null }].filter((w) => w.direccion),
    cuadre: { mes: M, entro: money.round(money.sum(delMes.map((x) => x.monto)), 2), registrado: money.round(money.sum(delMes.map((x) => x.monto)), 2) },
    movs };
}
function cobrosAbiertos() {
  return listarCobros().filter((d) => d.estado !== 'pagado').map((d) => ({ doc: d.id, nombre: nombreCli(d.clienteId), titulo: d.titulo, debe: d.debe }));
}

/* ── LO QUE VE EL CLIENTE (su link) ─────────────────────────────────────────────────────────── */
function cuentaCliente(token) {
  const r = clientePorToken(token);
  if (!r) return { ok: false, error: 'Ese link ya no sirve: pedí uno nuevo.' };
  armarConexiones();
  const all = listarCobros();
  const ds = all.filter((d) => d.clienteId === r.cliente_id);
  const abiertos = ds.filter((d) => d.estado !== 'pagado').sort((a, b) => (a.vence < b.vence ? -1 : 1)); const a = abiertos[0];
  const c = config(); const hoy = hoyAR();
  const revisando = a ? !!db.prepare("SELECT 1 FROM nc_aviso WHERE cobro_id=? AND estado='pendiente'").get(a.id) : false;
  return { ok: true, token: r.token, cliente: { nombre: nombreCli(r.cliente_id) }, otros: Math.max(0, abiertos.length - 1),
    abierto: a ? { id: a.id, titulo: a.titulo, exacto: Number(a.exacto), total: Number(a.total), pagado: Number(a.pagado), debe: Number(a.debe),
      vence: a.vence + 'T23:59:00-03:00', estado: a.estado, revisando,
      cajas: a.cajas.map((x) => ({ caja: x.caja, sitio: x.sitio, total: Number(x.total), lineas: x.lineas.map((l) => ({ k: l.k, v: Number(l.v || 0), cat: l.cat, nota: l.nota || '' })) })) } : null,
    cobros: ds.slice().sort((x, y) => (x.fecha < y.fecha ? 1 : -1)).map((d) => ({ titulo: d.titulo, vence: d.vence + 'T23:59:00-03:00', estado: d.estado,
      exacto: Number(d.exacto), debe: Number(d.debe), pagadoEl: d.estado === 'pagado' && d.pagos.length ? d.pagos[d.pagos.length - 1].t : null })),
    debeTotal: Number(money.round(money.sum(abiertos.map((d) => d.debe)), 2)), abrirCuenta: abiertos.length > 1,
    cartel: !!cartelDe(r.cliente_id, all).activo,
    cajas: cajasDe(r.cliente_id).filter((x) => x.activa).map((x) => ({ caja: x.caja, sitio: x.sitio, desde: x.desde, mant: Number(x.mant), pct: Number(x.pct), hoy })),
    wallets: [{ red: 'TRC20', direccion: c.trc20 }, { red: 'BEP20', direccion: c.bep20 }].filter((w) => w.direccion),
    pesos: null,      // apagado: por ahora solo USDT (22-oct)
    pagados: [] };
}
/* Lo mínimo que necesita el panel del chat (etapa del chat): cuánto debe y si va el cartel. */
function estadoParaElChat(token) {
  const x = cuentaCliente(token);
  if (!x.ok) return x;
  return { ok: true, cliente: x.cliente.nombre, debe: x.debeTotal, cartel: x.cartel, vence: x.abierto ? x.abierto.vence : null, estado: x.abierto ? x.abierto.estado : 'al-dia' };
}

/* ── CLIENTES Y CAJAS (pantalla) ────────────────────────────────────────────────────────────── */
function clientes() {
  const hoy = hoyAR();
  const conx = conexiones.list().map((x) => ({ id: x.id, nombre: x.nombre }));
  const conCobro = new Set(db.prepare("SELECT ref FROM nc_cobro WHERE tipo='conexion'").all().map((r) => r.ref));
  const pagadas = new Map(listarCobros("WHERE tipo='conexion'").filter((d) => d.estado === 'pagado').map((d) => [d.ref, d.pagos.length ? d.pagos[d.pagos.length - 1].t : d.fecha]));
  const lista = db.prepare('SELECT * FROM nc_cliente').all().map((r) => ({
    id: r.cliente_id, nombre: nombreCli(r.cliente_id), codigo: codigoCli(r.cliente_id), tg: r.tg_grupo || '', pesos: !!r.pesos, link: linkDe(r), ver: linkDe(r),
    cajas: cajasDe(r.cliente_id).map((c) => ({ id: c.id, caja: c.caja, sitio: c.sitio, chatId: c.chat_id, conexion: c.conexion_id, sala: c.sala_id,
      desde: c.desde || '', entrada: Number(c.entrada), mant: Number(c.mant), pct: Number(c.pct), regalo: !!c.regalo, activa: !!c.activa, hoy,
      entradaCobrada: pagadas.get(c.id) || '', conexionSalio: conCobro.has(c.id) })),
  })).sort((a, b) => a.nombre.localeCompare(b.nombre));
  const ya = new Set(lista.map((x) => x.id));
  const disponibles = (clientesStore.list().clientes || []).filter((c) => !ya.has(c.id)).map((c) => ({ id: c.id, nombre: c.nombreVisible || c.nombre || c.codigo }))
    .sort((a, b) => a.nombre.localeCompare(b.nombre));
  return { ok: true, clientes: lista, disponibles, conexiones: conx, pesosOn: config().pesosOn };
}

/* ── LA CUENTA DEL CHAT: lo que entró, los gastos y la parte de cada uno ────────────────────── */
function cuentaMes(M) {
  const docs = listarCobros(); const pc = {};
  const add = (cl, k, v) => { pc[cl] = pc[cl] || { entrada: '0', mant: '0', variable: '0' }; pc[cl][k] = money.add(pc[cl][k], v); };
  /* Un pago se parte entre conexión / mantenimiento / % en proporción a su cobro; los centavos van
     a la parte más grande, así la suma cierra al centavo. */
  for (const d of docs) for (const p of d.pagos) {
    if (String(p.t).slice(0, 7) !== M) continue;
    const v = { entrada: '0', mant: '0', variable: '0' };
    for (const c of d.cajas) for (const l of c.lineas) if (v[l.cat] != null) v[l.cat] = money.add(v[l.cat], l.v || '0');
    const tot = money.sum(Object.values(v));
    if (!money.isPos(tot)) { add(d.clienteId, 'mant', p.monto); continue; }
    const s = {}; let resto = p.monto;
    for (const k of Object.keys(v)) { s[k] = money.round(money.div(money.mul(p.monto, v[k]), tot), 2); resto = money.sub(resto, s[k]); }
    const mayor = Object.keys(v).sort((a, b) => money.cmp(v[b], v[a]))[0];
    s[mayor] = money.add(s[mayor], resto);
    for (const k of Object.keys(s)) add(d.clienteId, k, s[k]);
  }
  const g = db.prepare('SELECT * FROM nc_gasto WHERE borrado IS NULL AND substr(fecha,1,7)=? ORDER BY fecha').all(M);
  const ids = new Set(Object.keys(pc).concat(g.filter((x) => x.cliente_id).map((x) => x.cliente_id)));
  const porCliente = [...ids].map((id) => {
    const v = pc[id] || { entrada: '0', mant: '0', variable: '0' };
    const total = money.round(money.sum(Object.values(v)), 2);
    const gc = money.round(money.sum(g.filter((x) => x.cliente_id === id).map((x) => x.monto)), 2);
    return { id, nombre: nombreCli(id), entrada: Number(v.entrada), mant: Number(v.mant), variable: Number(v.variable), total: Number(total), gastos: Number(gc), deja: Number(money.sub(total, gc)) };
  }).sort((a, b) => b.total - a.total);
  const c = config();
  const entro = money.round(money.sum(porCliente.map((x) => String(x.total))), 2);
  const gastos = money.round(money.sum(g.map((x) => x.monto)), 2);
  const neto = money.sub(entro, gastos);
  const base = c.repartoBase === 'neto' ? neto : entro;
  const parteProg = money.round(money.pct(base, String(c.repartoProg)), 2);
  const gastosProg = c.repartoBase === 'neto' ? money.round(money.sum(g.filter((x) => x.pago === 'prog').map((x) => x.monto)), 2) : '0';
  const pagado = money.round(money.sum(db.prepare('SELECT monto FROM nc_pago_prog WHERE substr(fecha,1,7)=?').all(M).map((x) => x.monto)), 2);
  return { porCliente, g, entro, gastos, neto, parteProg, parteAlexa: money.sub(base, parteProg), gastosProg,
    gastosGenerales: money.round(money.sum(g.filter((x) => !x.cliente_id).map((x) => x.monto)), 2), leToca: money.add(parteProg, gastosProg), pagado };
}
function cuenta(M) {
  if (!esMes(M)) M = mesAR();
  const c = config();
  const mesesConDatos = db.prepare("SELECT DISTINCT substr(fecha,1,7) m FROM nc_pago UNION SELECT DISTINCT substr(fecha,1,7) FROM nc_gasto WHERE borrado IS NULL UNION SELECT DISTINCT substr(fecha,1,7) FROM nc_pago_prog").all().map((r) => r.m);
  /* Lo que le quedó debiendo de los meses anteriores. */
  let saldoAnterior = '0';
  for (const m of mesesConDatos.filter((x) => x < M).sort()) { const x = cuentaMes(m); saldoAnterior = money.add(saldoAnterior, money.sub(x.leToca, x.pagado)); }
  const x = cuentaMes(M);
  const meses = [...new Set(mesesConDatos.concat([M, mesAR()]))].sort().reverse();
  return { ok: true, mes: M, meses, programador: c.programador, reparto: { alexa: 100 - c.repartoProg, prog: c.repartoProg, base: c.repartoBase },
    clientes: db.prepare('SELECT cliente_id FROM nc_cliente').all().map((r) => ({ id: r.cliente_id, nombre: nombreCli(r.cliente_id) })),
    porCliente: x.porCliente,
    gastos: x.g.map((y) => ({ id: y.id, fecha: y.fecha, concepto: y.concepto, cat: y.cat, cliente: y.cliente_id, clienteNombre: y.cliente_id ? nombreCli(y.cliente_id) : '', pago: y.pago, monto: Number(y.monto), cada: !!y.cada })),
    totales: { entro: Number(x.entro), gastos: Number(x.gastos), neto: Number(x.neto), parteAlexa: Number(x.parteAlexa), parteProg: Number(x.parteProg), gastosProg: Number(x.gastosProg), gastosGenerales: Number(x.gastosGenerales) },
    prog: { saldoAnterior: Number(saldoAnterior), leToca: Number(x.leToca), pagado: Number(x.pagado),
      pagos: db.prepare('SELECT * FROM nc_pago_prog WHERE substr(fecha,1,7)=? ORDER BY fecha').all(M).map((p) => ({ id: p.id, fecha: p.fecha, monto: Number(p.monto), nota: p.nota })),
      queda: Number(money.sub(money.add(saldoAnterior, x.leToca), x.pagado)) } };
}
function anotarGasto(d) {
  const m = num(d.monto);
  if (!String(d.concepto || '').trim()) return { ok: false, error: 'Escribí qué es el gasto.' };
  if (m == null || !money.isPos(m)) return { ok: false, error: 'Poné cuánto fue, en dólares.' };
  if (!esFecha(d.fecha)) return { ok: false, error: 'Elegí el día.' };
  if (d.cliente && !cliRow(d.cliente)) return { ok: false, error: 'Ese cliente no tiene el chat.' };
  db.prepare('INSERT INTO nc_gasto (id, fecha, concepto, cat, cliente_id, pago, monto, cada, createdAt) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(nid('ncg'), d.fecha, String(d.concepto).trim().slice(0, 80), String(d.cat || 'Otros').slice(0, 20), d.cliente || null, d.pago === 'prog' ? 'prog' : 'alexa', money.round(m, 2), d.cada ? 1 : 0, ahora());
  return { ok: true };
}
/* Borrar un gasto no lo borra: queda marcado, con quién y cuándo. Un gasto que desaparece sin rastro
   cambia el reparto de un mes ya cerrado y nadie puede decir por qué. */
function borrarGasto(id, por) {
  return { ok: db.prepare('UPDATE nc_gasto SET borrado=?, borrado_por=? WHERE id=? AND borrado IS NULL').run(ahora(), String(por || ''), String(id)).changes > 0 };
}
function anotarPagoProg(d) {
  const m = num(d.monto);
  if (m == null || !money.isPos(m)) return { ok: false, error: 'Poné cuánto le pagaste.' };
  if (!esFecha(d.fecha)) return { ok: false, error: 'Elegí el día.' };
  db.prepare('INSERT INTO nc_pago_prog (id, fecha, monto, nota, createdAt) VALUES (?,?,?,?,?)').run(nid('ncq'), d.fecha, money.round(m, 2), String(d.nota || '').slice(0, 80), ahora());
  return { ok: true };
}

/* ── EL ENVÍO: armado el día 1, sale solo si no lo frenás ──────────────────────────────────── */
function frenar(M, si) {
  db.prepare('INSERT INTO nc_mes (mes, frenado) VALUES (?,?) ON CONFLICT(mes) DO UPDATE SET frenado=excluded.frenado').run(M, si ? 1 : 0);
  return { ok: true };
}
function textoCobro(nombre, docs, link) {
  const t = require('./telegram');
  const L = docs.map((d) => `• ${t.escapeHtml(d.titulo)}: <b>${fmt2(d.debe)} USDT</b> (vence el ${+d.vence.slice(8)}/${+d.vence.slice(5, 7)})`).join('\n');
  return `💬 <b>${t.escapeHtml(nombre)}</b> — tu cuenta del chat\n\n${L}\n\nMandá el monto EXACTO (con los centavos): así sabemos que es tuyo.\nTodo el detalle y a dónde pagar:\n${link}`;
}
async function mandarA(clienteId, refs, texto, enviar) {
  const r = cliRow(clienteId);
  const grupos = String(r.tg_grupo || '').split(',').filter(Boolean);
  let ok = false, error = grupos.length ? '' : 'no tiene grupo de Telegram';
  for (const gid of grupos) { const x = await enviar(gid, texto); if (x.ok) ok = true; else error = x.error || 'no salió'; }
  for (const ref of refs) {
    db.prepare(`INSERT INTO nc_envio (id, cliente_id, ref, ok, error, at) VALUES (?,?,?,?,?,?)
      ON CONFLICT(cliente_id, ref) DO UPDATE SET ok=excluded.ok, error=excluded.error, at=excluded.at`).run(nid('nce'), clienteId, ref, ok ? 1 : 0, ok ? null : error, ahora());
  }
  return ok;
}
function enviador() {
  const t = require('./telegram');
  const token = chatExterno.botToken();
  return (gid, texto) => t.sendMessage(token, gid, texto);
}
/* Manda los cobros abiertos del mes (los del 1 y las conexiones) que todavía no salieron. */
async function mandarMes(M, { enviar = enviador(), forzar = false } = {}) {
  const docs = listarCobros().filter((d) => d.fecha.slice(0, 7) === M && d.estado !== 'pagado');
  const yaSalieron = new Set(db.prepare('SELECT ref FROM nc_envio WHERE ok=1').all().map((r) => r.ref));
  let mandados = 0;
  const porCli = {};
  for (const d of docs) if (forzar || !yaSalieron.has(d.id)) (porCli[d.clienteId] = porCli[d.clienteId] || []).push(d);
  for (const [cid, ds] of Object.entries(porCli)) {
    const r = cliRow(cid);
    if (await mandarA(cid, ds.map((d) => d.id), textoCobro(nombreCli(cid), ds, linkDe(r)), enviar)) mandados++;
  }
  db.prepare('INSERT INTO nc_mes (mes, enviado) VALUES (?,?) ON CONFLICT(mes) DO UPDATE SET enviado=excluded.enviado, frenado=0').run(M, ahora());
  return { ok: true, mandados };
}
async function recordar(clienteId, M, { enviar = enviador(), dia = null } = {}) {
  const r = cliRow(clienteId); if (!r) return { ok: false, error: 'Ese cliente no tiene el chat.' };
  const ds = listarCobros('WHERE cliente_id=?', [clienteId]).filter((d) => d.estado !== 'pagado');
  if (!ds.length) return { ok: false, error: 'No debe nada.' };
  const ref = dia ? `rec:${M}:${dia}` : `rec:${M}:mano-${Date.now()}`;
  const ok = await mandarA(clienteId, [ref], '⏰ Recordatorio\n\n' + textoCobro(nombreCli(clienteId), ds, linkDe(r)), enviar);
  return ok ? { ok: true } : { ok: false, error: 'No salió: revisá el grupo de Telegram.' };
}
/* Lo que corre solo, cada hora: armar el día 1, mandar cuando corresponde, conexiones nuevas y
   recordatorios. Cada paso es idempotente (la base no deja repetir), así que correrlo de más no
   cobra ni manda dos veces. */
async function tick({ ahoraFecha = new Date(), enviar = enviador() } = {}) {
  const hoy = fechaTZ(ahoraFecha), M = hoy.slice(0, 7), dia = Number(hoy.slice(8)), hora = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Argentina/Buenos_Aires', hour: '2-digit', hour12: false }).format(ahoraFecha));
  const c = config(); const out = { armado: null, mandado: null, conexiones: null, recordatorios: 0 };
  out.conexiones = armarConexiones(hoy);
  const e = estadoMes(M);
  /* Recién subido a mitad de mes: NO se arma el mes en curso (saldría con fecha del 1, ya vencido, y
     con el cartel puesto). Se empieza a cobrar solo desde el 1 que viene; si ella quiere, lo arma a
     mano con «Armarlo ahora». */
  if (!e.armado && dia > 2) {
    db.prepare('INSERT INTO nc_mes (mes, armado, enviado) VALUES (?,?,?) ON CONFLICT(mes) DO NOTHING').run(M, 'omitido', 'omitido');
  } else if (!e.armado) {
    out.armado = armarMes(M);
    const sale = new Date(ahoraFecha.getTime() + c.esperaHoras * 3600e3).toISOString();
    db.prepare('INSERT INTO nc_mes (mes, armado, sale_solo) VALUES (?,?,?) ON CONFLICT(mes) DO UPDATE SET armado=excluded.armado, sale_solo=excluded.sale_solo').run(M, ahora(), sale);
  } else if (!e.enviado && !e.frenado && e.saleSolo && ahoraFecha.toISOString() >= e.saleSolo) {
    out.mandado = await mandarMes(M, { enviar });
  }
  /* Conexiones del día: salen en cuanto se arman (no esperan al día 1). */
  if (estadoMes(M).enviado) {
    const yaSalieron = new Set(db.prepare('SELECT ref FROM nc_envio WHERE ok=1').all().map((r) => r.ref));
    const nuevas = listarCobros("WHERE tipo='conexion'").filter((d) => d.estado !== 'pagado' && !yaSalieron.has(d.id) && !db.prepare('SELECT 1 FROM nc_envio WHERE ref=?').get(d.id));
    for (const d of nuevas) await mandarA(d.clienteId, [d.id], textoCobro(nombreCli(d.clienteId), [d], linkDe(cliRow(d.clienteId))), enviar);
  }
  if (c.recordatorios.includes(dia) && hora >= 10 && estadoMes(M).enviado) {
    for (const r of db.prepare('SELECT cliente_id FROM nc_cliente').all()) {
      if (db.prepare('SELECT 1 FROM nc_envio WHERE cliente_id=? AND ref=?').get(r.cliente_id, `rec:${M}:${dia}`)) continue;
      const debe = listarCobros('WHERE cliente_id=?', [r.cliente_id]).some((d) => d.estado !== 'pagado');
      if (debe && (await recordar(r.cliente_id, M, { enviar, dia })).ok) out.recordatorios++;
    }
  }
  return out;
}
let _cron = null;
function startCron() {
  if (_cron || process.env.NUESTRO_CHAT_OFF === '1') return;
  _cron = setInterval(() => { tick().catch((e) => console.error('[nuestro-chat] tick:', e.message)); }, 60 * 60 * 1000);
  if (_cron.unref) _cron.unref();
}

module.exports = {
  config, setConfig, trc20Valida, bep20Valida,
  sumarCliente, setCliente, nuevoToken, clientePorToken, clientes,
  guardarCaja, marcarInicio, darDeBaja, salasActivas, junta, recapturando, _recaptura,
  armarMes, armarConexiones, listarCobros, cobrosDe, tablero, cartelDe, prorroga, frenar,
  registrarPago, borrarPago, avisarHash, resolverAviso, pagos, cobrosAbiertos,
  cuentaCliente, estadoParaElChat,
  cuenta, anotarGasto, borrarGasto, anotarPagoProg,
  mandarMes, recordar, tick, startCron,
};
