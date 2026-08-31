/**
 * api-ofertas-store.js — LAS OFERTAS COMERCIALES DE TBS.
 *
 * ── QUÉ RESUELVE ─────────────────────────────────────────────────────────────────────────────
 * Cuando alguien pregunta "¿cuánto me cobrás por los proveedores?", la respuesta se armaba a mano
 * en una hoja de cálculo aparte, y después había que volver a tipear esos mismos precios en la
 * matriz para poder facturarle. Dos lugares con el mismo número es la forma más barata de que
 * terminen distintos: se cotiza 8% y se factura 12%, y nadie se entera hasta que el cliente
 * reclama.
 *
 * Acá la oferta ES el precio: se arma una vez, se manda como documento, y al aceptarla escribe la
 * matriz. Lo que se cotizó y lo que se factura salen del mismo dato.
 *
 * ── PAQUETES, NO 51 NÚMEROS ──────────────────────────────────────────────────────────────────
 * La matriz tiene 51 sellos. Cotizar sello por sello son 51 decisiones por cliente, y por eso hoy
 * está vacía en tres cuartas partes. Un paquete junta los sellos que se venden juntos —Básico,
 * Premium, Live— y lleva UN precio. Una oferta es "estos paquetes, a estos precios", más las
 * excepciones sueltas que hagan falta.
 *
 * El sello suelto le gana al paquete: si Live va a 12% pero Evolution se negoció a 15%, la línea
 * de Evolution manda. Sin esa regla habría que sacar el sello del paquete y perder la agrupación
 * en el documento, que es justamente lo que hace que se entienda.
 *
 * ── LOS NOMBRES QUE VE EL CLIENTE ────────────────────────────────────────────────────────────
 * El cliente no conoce los sellos: conoce los proveedores. "SL" no le dice nada; "Amatic, Apex,
 * Apollo, Aristocrat…" sí. Esos nombres ya están adentro del nombre largo del sello, que es como
 * los devuelve TBS. `proveedoresDe` los saca de ahí.
 */
const crypto = require('crypto');
const { db } = require('./db');
const apiStore = require('./api-store');
const money = require('./lib/money');

db.exec(`
  /* Un paquete = los sellos que se venden juntos. El precio NO vive acá: vive en cada oferta,
     porque el mismo paquete se vende a distinto precio según el cliente. */
  CREATE TABLE IF NOT EXISTS api_paquete (
    id TEXT PRIMARY KEY,
    nombre TEXT,                  -- 'Básico', 'Premium', 'Live'
    sellos TEXT,                  -- JSON array de api_sello.nombre
    ord INTEGER
  );

  /* Una oferta. "cliente_id" queda en null mientras es sólo una cotización: recién al aceptarla
     se engancha a una cuenta de API. Así se puede cotizarle a alguien que todavía no es cliente,
     que es el caso que hoy no existía en el sistema. */
  CREATE TABLE IF NOT EXISTS api_oferta (
    id TEXT PRIMARY KEY,
    titulo TEXT,                  -- a quién va: 'Almir', 'Raul'
    cliente_id TEXT,              -- null hasta que se acepta
    lineas TEXT,                  -- JSON [{ paquete_id, pct } | { sello, pct }]
    notas TEXT,
    estado TEXT,                  -- 'borrador' | 'aplicada'
    createdAt TEXT, aplicadaAt TEXT
  );
  CREATE INDEX IF NOT EXISTS ix_oferta_cliente ON api_oferta (cliente_id);
`);

const nowISO = () => new Date().toISOString();
const J = (t, d) => { try { const v = JSON.parse(t); return v == null ? d : v; } catch (e) { return d; } };
const K = (s) => String(s || '').trim().toLowerCase();

/**
 * Los proveedores que el cliente ve dentro de un sello.
 *
 * TBS devuelve el nombre largo con los proveedores separados por coma y una o DOS aclaraciones
 * entre paréntesis al final: "EGT Digital, Pragmatic Play, NetEnt, ELK Studios (Slot zona)
 * (prepayment)". Sacando una sola quedaba "ELK Studios (Slot zona)" pegado como si fuera el
 * nombre de un proveedor, así que se sacan todas las del final.
 */
function proveedoresDe(nombreSello) {
  let s = String(nombreSello || '').trim();
  let antes;
  do { antes = s; s = s.replace(/\s*\([^()]*\)\s*$/, '').trim(); } while (s !== antes);
  return s.split(',').map((x) => x.trim()).filter(Boolean).map(_bonito);
}

/* ── LOS NOMBRES, COMO SE LEEN AFUERA ─────────────────────────────────────────────────────────
   TBS los escribe como le queda cómodo y eso está bien adentro; en un documento que sale a un
   cliente, no. Dos cosas se arreglan acá:

   · MARCADORES INTERNOS al final: "PGSOFT OP KN OP", "EVOLUTION LOBBY PREMIUM OP". OP/KN/EV/SZ/SR
     son etiquetas de TBS para distinguir variantes del mismo proveedor, no parte de su nombre.
   · TODO EN MAYÚSCULAS: "AVIATOR", "BACKSEAT". En una grilla de cien nombres, la mitad gritando y
     la otra mitad no se lee como un error de armado. Se pasa a capital inicial, salvo las siglas
     que de verdad van en mayúscula. */
const _MARCA = /\s+(OP|KN|EV|SZ|SR|RL|SL|XG)$/i;
const _SIGLAS = new Set(['EGT', 'IGT', 'PG', 'TV', 'WS', 'SA', 'XG', 'DLV', 'ELK', 'KA', 'RTG', 'BVS', 'SL']);
function _bonito(nombre) {
  let s = String(nombre || '').trim();
  let antes;
  do { antes = s; s = s.replace(_MARCA, '').trim(); } while (s !== antes);
  if (!s) return String(nombre || '').trim();     // era sólo marcadores: se deja como vino
  /* El diccionario primero, y acá y no sólo al deduplicar: si no, el mismo proveedor sale escrito
     de una forma en la lista de un grupo y de otra en el renglón de otro. Un nombre, una
     escritura, en todos lados. */
  const dic = _MARCAS[_clave(s)];
  if (dic) return dic;
  // Si ya mezcla mayúsculas y minúsculas, el que lo escribió eligió: no se toca.
  if (s !== s.toUpperCase()) return s;
  return s.split(/\s+/).map((w) => (_SIGLAS.has(w.toUpperCase())
    ? w.toUpperCase()
    : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())).join(' ');
}

/* ── CÓMO SE ESCRIBEN DE VERDAD ───────────────────────────────────────────────────────────────
   TBS escribe "Igt", "Netent", "Pgsoft", "3oaks". Son nombres de empresas reales y este documento
   va a un cliente: escribirlos mal se nota, y una heurística no puede saber que IGT va en
   mayúscula y Netent no. Para las marcas conocidas hay diccionario; para el resto, la heurística.
   La clave ignora mayúsculas y todo lo que no sea letra o número, así que "Playn GO", "playngo" y
   "PLAYN GO" caen todas en la misma entrada. */
const _MARCAS = {};
[
  'IGT', 'NetEnt', 'InBet', 'PG Soft', "Play'n GO", 'EGT', 'EGT Digital', 'Pragmatic Play',
  '3 Oaks', 'JetX', 'Aviator', 'Aviatrix', 'Novomatic', 'Microgaming', 'Habanero', 'Igrosoft',
  'Amatic', 'Apex', 'Apollo', 'Aristocrat', 'Wazdan', 'Playson', 'Spribe', 'Endorphina',
  'Hacksaw Gaming', 'No Limit City', 'Red Tiger', 'RubyPlay', 'Scientific Games', 'Zitro', 'Kajot',
  'Ainsworth', 'Booming Games', 'Evolution', 'Ezugi', 'Vivo Live', 'TV Bet', 'SA Gaming', 'Merkur',
  'FireKirin', 'Galaxsys', 'OneTouch', 'Goldenrace', 'Mancala', 'SmartSoft', 'Platipus',
  'KA Gaming', 'Tom Horn', 'Yggdrasil', 'Quickspin', 'ELK Studios', 'Amusnet', 'Betsoft',
  'CreedRoomz', 'YeeBet', 'G-Club', 'Buffalo Thunder', 'Holi Bet', 'Backseat', 'Skywind',
  'Red Rake', 'Altente Gaming', 'Absolute Live Gaming', 'Sport Betting', 'Fishing World',
].forEach((n) => { _MARCAS[String(n).toLowerCase().replace(/[^a-z0-9]/g, '')] = n; });

/* La misma marca escrita distinto en dos sellos —"Igt" y "IGT", "Inbet" e "InBet", "Playngo" y
   "Playn GO"— es UN proveedor, y en la lista del cliente tiene que aparecer una vez. La clave de
   comparación ignora mayúsculas y todo lo que no sea letra o número; de las variantes se muestra
   la que NO está toda en mayúsculas, y entre ésas la más larga (suele ser la mejor escrita). */
const _clave = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
function unicos(nombres) {
  const m = new Map();
  for (const n of nombres) {
    const k = _clave(n);
    if (!k) continue;
    // El diccionario gana siempre: es el nombre que la marca usa, no el que quedó cargado en TBS.
    if (_MARCAS[k]) { m.set(k, _MARCAS[k]); continue; }
    const ya = m.get(k);
    if (!ya) { m.set(k, n); continue; }
    const gritaYa = ya === ya.toUpperCase(), grita = n === n.toUpperCase();
    if ((gritaYa && !grita) || (gritaYa === grita && n.length > ya.length)) m.set(k, n);
  }
  return [...m.values()].sort((a, b) => a.localeCompare(b, 'es', { sensitivity: 'base' }));
}

// ── paquetes ─────────────────────────────────────────────────────────────────
function listPaquetes() {
  return db.prepare('SELECT * FROM api_paquete ORDER BY ord ASC, nombre ASC').all()
    .map((r) => ({ ...r, sellos: J(r.sellos, []) }));
}
function savePaquete(d) {
  const nombre = String(d.nombre || '').trim();
  if (!nombre) return { ok: false, error: 'falta el nombre del paquete' };
  const id = String(d.id || '').trim() || 'paq_' + crypto.randomBytes(4).toString('hex');
  const sellos = Array.isArray(d.sellos) ? d.sellos.map((x) => String(x).trim()).filter(Boolean) : [];
  const ord = d.ord != null ? Number(d.ord)
    : (db.prepare('SELECT COALESCE(MAX(ord),-1)+1 n FROM api_paquete').get().n);
  db.prepare(`INSERT INTO api_paquete (id,nombre,sellos,ord) VALUES (?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET nombre=excluded.nombre, sellos=excluded.sellos, ord=excluded.ord`)
    .run(id, nombre, JSON.stringify([...new Set(sellos)]), ord);
  return { ok: true, paquete: listPaquetes().find((p) => p.id === id) };
}
function removePaquete(id) {
  return { ok: true, borrados: db.prepare('DELETE FROM api_paquete WHERE id=?').run(String(id)).changes };
}

// ── ofertas ──────────────────────────────────────────────────────────────────
function listOfertas() {
  return db.prepare('SELECT * FROM api_oferta ORDER BY createdAt DESC').all()
    .map((r) => ({ ...r, lineas: J(r.lineas, []) }));
}
function getOferta(id) {
  const r = db.prepare('SELECT * FROM api_oferta WHERE id=?').get(String(id));
  return r ? { ...r, lineas: J(r.lineas, []) } : null;
}
function saveOferta(d) {
  const titulo = String(d.titulo || '').trim();
  if (!titulo) return { ok: false, error: 'falta a quién va la oferta' };
  const id = String(d.id || '').trim() || 'of_' + crypto.randomBytes(5).toString('hex');
  const prev = getOferta(id);
  const lineas = (Array.isArray(d.lineas) ? d.lineas : [])
    .map((l) => ({
      paquete_id: l.paquete_id ? String(l.paquete_id) : null,
      sello: l.sello ? String(l.sello) : null,
      pct: l.pct == null || l.pct === '' ? null : String(l.pct).trim(),
    }))
    .filter((l) => (l.paquete_id || l.sello));
  // El % se escribe a mano: el mismo control que la matriz del cierre, por el mismo motivo.
  for (const l of lineas) {
    if (l.pct == null) continue;
    if (!money.esNumero(l.pct)) return { ok: false, error: `"${l.pct}" no es un número. Usá punto para los decimales: 12.5` };
    if (money.isNeg(l.pct)) return { ok: false, error: `${l.pct} es negativo` };
    if (money.cmp(l.pct, '100') > 0) return { ok: false, error: `${l.pct} pasa de 100%` };
  }
  db.prepare(`INSERT INTO api_oferta (id,titulo,cliente_id,lineas,notas,estado,createdAt,aplicadaAt)
      VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET titulo=excluded.titulo, cliente_id=excluded.cliente_id,
      lineas=excluded.lineas, notas=excluded.notas`)
    .run(id, titulo, d.cliente_id || (prev && prev.cliente_id) || null, JSON.stringify(lineas),
      String(d.notas || ''), (prev && prev.estado) || 'borrador',
      (prev && prev.createdAt) || nowISO(), (prev && prev.aplicadaAt) || null);
  return { ok: true, oferta: getOferta(id) };
}
function removeOferta(id) {
  return { ok: true, borrados: db.prepare('DELETE FROM api_oferta WHERE id=?').run(String(id)).changes };
}

/**
 * EL PRECIO EFECTIVO DE CADA SELLO, y de dónde salió.
 *
 * El sello suelto le gana al paquete: si Live va a 12% pero Evolution se negoció a 15%, manda la
 * línea de Evolution. Sin esa regla habría que sacar el sello del paquete y perder la agrupación
 * del documento, que es justo lo que lo hace entendible.
 *
 * @returns Map(nombreSello → { pct, paquete_id, suelto })
 */
function resolver(oferta) {
  const paq = new Map(listPaquetes().map((p) => [p.id, p]));
  const out = new Map();
  for (const l of oferta.lineas || []) {
    if (!l.paquete_id || l.pct == null) continue;
    const p = paq.get(l.paquete_id);
    if (!p) continue;
    for (const s of p.sellos) out.set(s, { pct: l.pct, paquete_id: p.id, suelto: false });
  }
  for (const l of oferta.lineas || []) {
    if (!l.sello || l.pct == null) continue;
    const ya = out.get(l.sello);
    out.set(l.sello, { pct: l.pct, paquete_id: ya ? ya.paquete_id : null, suelto: true });
  }
  return out;
}

/**
 * QUÉ CAMBIARÍA EN LA MATRIZ SI SE APLICA. No escribe nada.
 *
 * Se mira antes de tocar porque un cliente que ya venía facturando puede tener precios negociados
 * que no están en la oferta: pisarlos sin verlos es cobrarle distinto sin haberlo decidido.
 */
function diff(oferta, clienteId) {
  const cid = String(clienteId || oferta.cliente_id || '');
  const efect = resolver(oferta);
  const actuales = new Map(db.prepare('SELECT sello, pct_cliente FROM api_pct WHERE cliente_id=?')
    .all(cid).map((r) => [r.sello, r.pct_cliente]));
  const nuevos = [], cambian = [], iguales = [];
  for (const [sello, v] of efect) {
    const antes = actuales.get(sello);
    if (antes == null || antes === '') nuevos.push({ sello, pct: v.pct });
    else if (String(antes) !== String(v.pct)) cambian.push({ sello, de: String(antes), a: v.pct });
    else iguales.push({ sello, pct: v.pct });
  }
  // Los que el cliente tiene y la oferta NO menciona: no se tocan, pero hay que decirlo.
  const fuera = [...actuales.entries()].filter(([s]) => !efect.has(s))
    .map(([sello, pct]) => ({ sello, pct: String(pct) }));
  return { cliente_id: cid, nuevos, cambian, iguales, fuera };
}

/**
 * Escribe los precios de la oferta en la matriz. Sólo toca los sellos que la oferta menciona: lo
 * que el cliente tuviera aparte queda como estaba (y `diff` lo lista como "fuera").
 */
function aplicar(oferta, clienteId) {
  const cid = String(clienteId || oferta.cliente_id || '');
  if (!cid) return { ok: false, error: 'falta a qué cuenta aplicarla' };
  if (!apiStore.getCliente(cid)) return { ok: false, error: 'esa cuenta de API no existe' };
  const d = diff(oferta, cid);
  const efect = resolver(oferta);
  const up = db.prepare(`INSERT INTO api_pct (cliente_id,sello,pct_cliente,origen)
      VALUES (?,?,?,'planilla')
    ON CONFLICT(cliente_id,sello) DO UPDATE SET pct_cliente=excluded.pct_cliente, origen='planilla'`);
  const tx = db.transaction(() => {
    for (const [sello, v] of efect) up.run(cid, sello, String(v.pct));
    db.prepare("UPDATE api_oferta SET estado='aplicada', cliente_id=?, aplicadaAt=? WHERE id=?")
      .run(cid, nowISO(), oferta.id);
  });
  tx();
  return { ok: true, escritos: efect.size, ...d, oferta: getOferta(oferta.id) };
}

/**
 * La oferta armada para MOSTRARLA: por paquete, con los proveedores que el cliente reconoce.
 * Los sellos sueltos que no caen en ningún paquete van juntos al final.
 */
function paraMostrar(oferta) {
  const efect = resolver(oferta);
  const sellos = new Map(apiStore.listSellos().map((s) => [s.nombre, s]));
  const paquetes = listPaquetes();
  const grupos = [];
  for (const p of paquetes) {
    const items = p.sellos.filter((s) => efect.has(s)).map((s) => {
      const v = efect.get(s);
      const meta = sellos.get(s) || {};
      return { sello: s, corto: meta.corto || s, pct: v.pct, suelto: v.suelto,
        proveedores: proveedoresDe(s) };
    });
    if (items.length) grupos.push({ paquete_id: p.id, nombre: p.nombre, items, unico: _unico(items) });
  }
  const enPaquetes = new Set(paquetes.flatMap((p) => p.sellos));
  const sueltos = [...efect.entries()].filter(([s]) => !enPaquetes.has(s)).map(([s, v]) => {
    const meta = sellos.get(s) || {};
    return { sello: s, corto: meta.corto || s, pct: v.pct, suelto: true, proveedores: proveedoresDe(s) };
  });
  if (sueltos.length) grupos.push({ paquete_id: null, nombre: 'Otros', items: sueltos, unico: _unico(sueltos) });
  return { titulo: oferta.titulo, notas: oferta.notas || '', grupos,
    proveedores: unicos(grupos.flatMap((g) => g.items.flatMap((i) => i.proveedores))) };
}
/** Si todo el grupo va al mismo %, se muestra UN número arriba en vez de repetirlo en cada renglón. */
function _unico(items) {
  const p = [...new Set(items.map((i) => String(i.pct)))];
  return p.length === 1 ? p[0] : null;
}

/**
 * ── LOS PAQUETES DE ARRANQUE ─────────────────────────────────────────────────────────────────
 * Salen de la hoja de oferta que ya se usaba (Básico / Premium / Live / Básico+). Se siembran una
 * sola vez y sólo si no hay ninguno: si el dueño los cambia, no se vuelven a pisar.
 *
 * Los sellos se buscan por su nombre CORTO, que es el que se lee en la matriz, y los que no
 * existan se saltean sin romper: el catálogo de TBS cambia y un paquete con un sello de menos
 * sigue siendo útil.
 */
const SEMILLA = [
  { nombre: 'Básico', cortos: ['SL', 'SL2', 'BVS', 'XG', 'Firekirin', 'Merkur', 'Novomatic', 'Slot Zona', 'Buffalo Thunder', 'Others (lobby)'] },
  { nombre: 'Premium', cortos: ['Altente RL', 'Aviator/JetX OP', 'Aviatrix', 'Booming OP', 'Booming Original',
    'Galaxsys/3Oaks OP', 'Holi Bet', 'PGSoft OP', 'Platipus', 'Playson EV', 'Pragmatic Original',
    'Rubyplay/RedRake OP', 'SA Gaming OP', 'Spribe/Endorphina OP', 'Spribe SR', 'Tomhorn',
    'Hacksaw/NoLimit OP', 'Red Tiger/Amigo OP', 'KaGaming OP', 'Microgaming Live OP', 'Novomatic OP'] },
  { nombre: 'Live', cortos: ['Evolution Expensive EV', 'Evolution Lobby OP', 'Evolution OP', 'Evolution Original',
    'Pragmatic Live EV', 'Pragmatic Live OP', 'Pragmatic Live Original', 'Vivo Live', 'YeeBet Live',
    'Absolute Live', 'Creedroomz OP', 'TV Bet', 'Sport Betting', 'WS Sport'] },
  { nombre: 'Básico +', cortos: ['Amusnet EV', 'Betsoft OP', 'Yggdrasil/Playngo EV', 'Fishing World',
    'Microgaming Original', 'Pragmatic Virtual Sport'] },
];
function sembrarPaquetes() {
  if (db.prepare('SELECT COUNT(*) n FROM api_paquete').get().n) return { ok: true, yaEstaban: true };
  const porCorto = new Map(apiStore.listSellos().map((s) => [K(s.corto), s.nombre]));
  let n = 0;
  SEMILLA.forEach((p, i) => {
    const sellos = p.cortos.map((c) => porCorto.get(K(c))).filter(Boolean);
    if (!sellos.length) return;
    savePaquete({ nombre: p.nombre, sellos, ord: i });
    n += 1;
  });
  if (n) console.log(`[Ofertas] ${n} paquete(s) de arranque sembrados`);
  return { ok: true, creados: n };
}

/**
 * ── ARMAR UNA OFERTA CON UN SOLO NÚMERO ──────────────────────────────────────────────────────
 *
 * La tarifa salió de comparar las 13 ofertas que se armaron a mano durante 2025 (sin ALMIR, que
 * nunca arrancó y era una excepción para ganar la cuenta). Comparadas entre sí no son 13
 * negociaciones: son UNA lista y un escalón de base por cliente.
 *
 *     Básico    = la base          ← lo único que se negocia
 *     Básico +  = base + 2
 *     Premium   = 15
 *     Live      = 15
 *
 * 🔑 EL MERCADO NEGOCIA LA BASE, NO LOS EXTERNOS. Medido: NACHO paga 7 puntos menos en Básico y el
 *    precio de lista COMPLETO en Premium y Live; YASH paga 2 más en Básico y lo mismo que todos en
 *    los externos. Por eso la base es la palanca: bajarla de 12 a 6 son seis puntos de regalo que
 *    cuestan 1,63 de margen, porque sólo mueve 10 de los 52 sellos.
 *
 * 🔴 Y EL PISO CORRE SIEMPRE: ningún sello por debajo de su costo + MARGEN_MINIMO. Sin esto se
 *    vende a pérdida sin que nadie se entere — pasaba con Betsoft OP, que cuesta 15 y estaba en
 *    Básico + a 12. El piso lo levanta solo, y también cuando el proveedor suba su costo.
 *
 * Lo que sale de acá es un BORRADOR: se edita, se guarda, y recién al aplicarlo escribe la matriz.
 */
const MARGEN_MINIMO = 2;

/* Los caros van con precio propio: son los que el mercado ya paga por encima de su bolsa. Salen de
   lo que más se repite en las ofertas de 2025. El sello suelto le gana al paquete, así que alcanza
   con nombrarlos. */
const EXCEPCIONES = [
  { busca: 'red tiger premium', pct: 19.5 },
  { busca: 'spribe/endorphina', pct: 18.5 },
  { busca: 'red tiger/amigo',   pct: 17.5 },
  { busca: 'booming',           pct: 17.5 },
  { busca: 'evolution lobby',   pct: 23 },
  { busca: 'pragmatic live op', pct: 25 },
  { busca: 'evolution expensive', pct: 22 },
  { busca: 'evolution live',    pct: 20 },
];

/* Cuánto vale cada bolsa a partir de la base. Si algún día cambian los nombres de los paquetes,
   lo que no matchee cae en `PRECIO_LISTA` y queda a 15, que es la mediana de Premium y Live. */
const PRECIO_LISTA = 15;
function precioDePaquete(nombre, base) {
  const k = K(nombre);
  if (k === 'básico' || k === 'basico') return base;
  if (k.startsWith('básico +') || k.startsWith('basico +')) return base + 2;
  return PRECIO_LISTA;
}

/**
 * @param {number} base  el único número que se negocia
 * @returns {{lineas:Array, avisos:Array}} las líneas listas para guardar, y qué tuvo que corregir
 */
function armarDesdeBase(base) {
  const b = Number(base);
  if (!Number.isFinite(b) || b <= 0) return { error: 'La base tiene que ser un número mayor que cero' };

  const paquetes = listPaquetes();
  const sellos = apiStore.listSellos();
  /* El costo viene como texto y puede traer coma decimal: se normaliza acá una sola vez. */
  const aNum = (v) => Number(String(v ?? '').replace(',', '.')) || 0;
  const costoDe = new Map(sellos.map((s) => [s.nombre, aNum(s.costo)]));
  const paqDe = new Map();
  paquetes.forEach((p) => (p.sellos || []).forEach((s) => paqDe.set(s, p)));

  const lineas = paquetes.map((p) => ({ paquete_id: p.id, pct: precioDePaquete(p.nombre, b) }));
  const avisos = [];

  /* 1 · los caros, por nombre */
  for (const e of EXCEPCIONES) {
    const s = sellos.find((x) => K(x.nombre).includes(e.busca) || K(x.corto).includes(e.busca));
    if (!s) continue;
    if (lineas.some((l) => l.sello === s.nombre)) continue;
    lineas.push({ sello: s.nombre, pct: e.pct });
  }

  /* 2 · el piso, que manda sobre todo lo anterior */
  for (const s of sellos) {
    const costo = costoDe.get(s.nombre) || 0;
    const minimo = costo + MARGEN_MINIMO;
    const suelta = lineas.find((l) => l.sello === s.nombre);
    const p = paqDe.get(s.nombre);
    const actual = suelta ? suelta.pct : (p ? precioDePaquete(p.nombre, b) : null);
    if (actual == null || actual >= minimo) continue;
    if (suelta) suelta.pct = minimo;
    else lineas.push({ sello: s.nombre, pct: minimo });
    avisos.push({ sello: s.nombre, corto: s.corto, costo, era: actual, queda: minimo,
      porque: `cuesta ${costo}% y a ${actual}% te dejaba ${(actual - costo).toFixed(1)} puntos` });
  }

  return { lineas, avisos, base: b };
}

module.exports = {
  armarDesdeBase, MARGEN_MINIMO,
  proveedoresDe, unicos, listPaquetes, savePaquete, removePaquete, sembrarPaquetes,
  listOfertas, getOferta, saveOferta, removeOferta,
  resolver, diff, aplicar, paraMostrar,
};
