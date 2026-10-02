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

  /* ── EN QUÉ SECCIÓN DEL DOCUMENTO SE MUESTRA UN PROVEEDOR ─────────────────────────────────
     TBS vende de a bolsas y una bolsa puede mezclar productos distintos: el sello
     "MICROGAMING LIVE, PLATIPUS, MICROGAMING" trae una mesa en vivo y dos catálogos de slots,
     y se compra y se factura entero. Mover el sello a Live metía los dos de slots adentro de
     Live; dejarlo en Premium ponía una mesa en vivo en la sección de slots.

     Esto rompe el empate: el SELLO no se mueve —la bolsa, el costo y la factura quedan como
     están— y lo que se manda a otra sección es el PROVEEDOR, sólo en el documento. Se lleva su
     propio precio con él, que es el del sello: como el documento ya está cortado por precio, el
     chip aterriza en el bloque que le corresponde y el número que el cliente lee es el que se le
     va a cobrar. Si no hubiera un bloque a ese precio, se abre uno. */
  CREATE TABLE IF NOT EXISTS api_prov_seccion (
    clave TEXT PRIMARY KEY,       -- el nombre del proveedor, normalizado
    prov TEXT,                    -- cómo se escribe, para poder mostrarlo
    paquete_id TEXT               -- a qué sección va en el documento
  );
`);

/* Los topes y los puntos viven en la oferta: son de ESE cliente, no del catálogo. */
for (const c of ['puntos TEXT', 'min_ext TEXT', 'max_ext TEXT', 'excluidos TEXT', 'base TEXT']) {
  try { db.exec('ALTER TABLE api_oferta ADD COLUMN ' + c); } catch (e) { /* ya la tiene */ }
}

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
  return s.split(',').map((x) => x.trim()).filter(Boolean).map(_bonito)
    .filter((n) => !_NO_ES_PROVEEDOR.has(_clave(n)));
}

/* ── LO QUE NO ES UN PROVEEDOR ────────────────────────────────────────────────────────────────
   TBS tiene bolsas de descarte —"Others (lobby)"— para lo que no entra en ninguna otra. Adentro
   son útiles; en la lista que lee el cliente, "Others" se lee como si le estuvieras vendiendo una
   marca llamada Others. El sello se sigue cotizando igual: lo que desaparece es el chip. */
const _NO_ES_PROVEEDOR = new Set(['others', 'otros', 'lobby', 'varios', 'otherslobby']);

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

/* ── LA MISMA MARCA, ESCRITA CORTA ────────────────────────────────────────────────────────────
   Adentro de un sello TBS escribe "Pragmatic" y adentro de otro "Pragmatic Play". Son la misma
   empresa, pero el deduplicador no puede saberlo: para él son dos claves distintas, y en el
   documento salían los dos chips uno al lado del otro como si le estuvieras vendiendo dos
   proveedores. Acá se dice, marca por marca, cuál es el nombre de verdad.
   Sólo van las que se comprobaron: adivinar acá funde dos proveedores que sí son distintos. */
[
  ['pragmatic', 'Pragmatic Play'],
].forEach(([k, n]) => { _MARCAS[k] = n; });

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

// ── en qué sección se muestra cada proveedor ─────────────────────────────────
/** @returns Map(clave del proveedor → paquete_id donde se muestra) */
function seccionesDeProveedor() {
  return new Map(db.prepare('SELECT clave, paquete_id FROM api_prov_seccion').all()
    .map((r) => [r.clave, r.paquete_id]));
}
function listSecciones() {
  return db.prepare('SELECT * FROM api_prov_seccion ORDER BY prov ASC').all();
}
/** Con `paquete_id` vacío se borra la excepción y el proveedor vuelve a la sección de su sello. */
function setSeccion(prov, paqueteId) {
  const nombre = String(prov || '').trim();
  const clave = _clave(nombre);
  if (!clave) return { ok: false, error: 'falta el proveedor' };
  const pid = String(paqueteId || '').trim();
  if (!pid) {
    db.prepare('DELETE FROM api_prov_seccion WHERE clave=?').run(clave);
    return { ok: true, borrada: true };
  }
  if (!listPaquetes().some((p) => p.id === pid)) return { ok: false, error: 'esa sección no existe' };
  db.prepare(`INSERT INTO api_prov_seccion (clave,prov,paquete_id) VALUES (?,?,?)
    ON CONFLICT(clave) DO UPDATE SET prov=excluded.prov, paquete_id=excluded.paquete_id`)
    .run(clave, nombre, pid);
  return { ok: true };
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
    .map((r) => ({ ...r, lineas: J(r.lineas, []), excluidos: J(r.excluidos, []) }));
}
function getOferta(id) {
  const r = db.prepare('SELECT * FROM api_oferta WHERE id=?').get(String(id));
  return r ? { ...r, lineas: J(r.lineas, []), excluidos: J(r.excluidos, []) } : null;
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
  /* Vacío NO es cero: un tope sin poner es "no hay tope". Guardar 0 sería ponerle precio cero a
     todos los externos, que es justo el error que el campo tiene que evitar. */
  const opt = (v, ant) => (v === undefined ? (ant == null ? null : String(ant))
    : (v === '' || v === null ? null : String(v).trim()));
  /* Los sacados se guardan por su clave normalizada: "Play'n GO" y "Playngo" son el mismo, y si
     se guardara el nombre tal cual, sacarlo en un sello no lo sacaría del otro. */
  const excl = d.excluidos === undefined
    ? ((prev && prev.excluidos) || '[]')
    : JSON.stringify([...new Set((Array.isArray(d.excluidos) ? d.excluidos : [])
        .map((x) => _clave(x)).filter(Boolean))]);
  db.prepare(`INSERT INTO api_oferta (id,titulo,cliente_id,lineas,notas,estado,createdAt,aplicadaAt,
      puntos,min_ext,max_ext,excluidos,base)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET titulo=excluded.titulo, cliente_id=excluded.cliente_id,
      lineas=excluded.lineas, notas=excluded.notas, puntos=excluded.puntos,
      min_ext=excluded.min_ext, max_ext=excluded.max_ext, excluidos=excluded.excluidos,
      base=excluded.base`)
    .run(id, titulo, d.cliente_id || (prev && prev.cliente_id) || null, JSON.stringify(lineas),
      String(d.notas || ''), (prev && prev.estado) || 'borrador',
      (prev && prev.createdAt) || nowISO(), (prev && prev.aplicadaAt) || null,
      opt(d.puntos, prev && prev.puntos), opt(d.min_ext, prev && prev.min_ext),
      opt(d.max_ext, prev && prev.max_ext), excl, opt(d.base, prev && prev.base));
  return { ok: true, oferta: getOferta(id) };
}
/**
 * ── CAMBIARLE EL PRECIO A UNO SOLO, ANTES DE MANDAR LA OFERTA ────────────────────────────────
 *
 * La tarifa es una regla pareja y la negociación no lo es: "me lo dejás a 9 y cerramos". Esto
 * escribe el precio de UN sello como línea suelta, que le gana al paquete, sin tocar el resto.
 *
 * ⚠️ LA UNIDAD DE PRECIO ES EL SELLO, NO EL PROVEEDOR. Si el sello trae uno solo, cambiarlo es
 *    exactamente cambiar ese proveedor. Si trae varios —"Galaxsys, OneTouch, 3 Oaks" se compran
 *    juntos— no hay forma de cobrarle distinto a uno de ellos: el precio se mueve para los tres.
 *    La pantalla lo dice antes de tocar, porque descubrirlo después es haberle cotizado a un
 *    cliente un número que no existe.
 *
 * El piso de costo + MARGEN_MINIMO NO se fuerza acá: si el dueño decide vender algo al costo para
 * cerrar una cuenta, es su decisión y el sistema no está para discutírsela. Lo que sí hace es
 * devolver el aviso, para que sea una decisión y no un descuido.
 */
function precioDeSello(oferta, sello, pct) {
  const nombre = String(sello || '').trim();
  if (!nombre) return { ok: false, error: 'falta el sello' };
  const meta = apiStore.listSellos().find((s) => s.nombre === nombre);
  if (!meta) return { ok: false, error: 'ese sello no existe' };

  const lineas = (oferta.lineas || []).filter((l) => l.sello !== nombre);
  const vacio = pct == null || String(pct).trim() === '';
  /* ⚠️ VACIARLO NO PUEDE SER "QUE CAIGA AL PAQUETE". La línea de paquete de un externo es un
     relleno —`costo 0 + tus puntos`— que existe sólo para un sello nuevo todavía sin costo. Si al
     borrar la excepción el sello cayera ahí, Betsoft pasaba de 18% a 3% costando 15, en silencio y
     con un campo que el dueño vació para "volver atrás". Volver atrás es volver al precio que la
     regla le daba, así que se recalcula con la base y los puntos de ESTA oferta. */
  if (vacio) {
    const n = (v) => (v == null || v === '' ? null : Number(String(v).replace(',', '.')));
    const b = n(oferta.base);
    const t = tipoDePaquete((listPaquetes().find((p) => (p.sellos || []).includes(nombre)) || {}).nombre);
    if (b != null && t && t !== 'base' && t !== 'base+') {
      const costo0 = Number(String(meta.costo ?? '').replace(',', '.')) || 0;
      const puntos = n(oferta.puntos) != null ? n(oferta.puntos) : puntosDeBase(b);
      const vuelta = Math.round(precioExterno(costo0, puntos, n(oferta.min_ext), n(oferta.max_ext)) * 10) / 10;
      lineas.push({ paquete_id: null, sello: nombre, pct: String(vuelta) });
    }
  }
  if (!vacio) {
    const v = String(pct).trim();
    if (!money.esNumero(v)) return { ok: false, error: `"${v}" no es un número. Usá punto para los decimales: 12.5` };
    if (money.isNeg(v)) return { ok: false, error: `${v} es negativo` };
    if (money.cmp(v, '100') > 0) return { ok: false, error: `${v} pasa de 100%` };
    lineas.push({ paquete_id: null, sello: nombre, pct: v });
  }
  const r = saveOferta({ ...oferta, lineas });
  if (!r.ok) return r;

  const costo = Number(String(meta.costo ?? '').replace(',', '.')) || 0;
  const avisos = [];
  if (!vacio && Number(pct) < costo + MARGEN_MINIMO) {
    avisos.push(`${meta.corto} cuesta ${costo}%: a ${pct}% te quedan ${(Number(pct) - costo).toFixed(1)} puntos.`);
  }
  const provs = proveedoresDe(nombre);
  if (provs.length > 1) {
    avisos.push(`Ese precio es del sello ${meta.corto}, que trae ${provs.length} proveedores juntos: `
      + `${provs.join(', ')}. Se movieron todos.`);
  }
  return { ...r, avisos, vuelveAlPaquete: vacio };
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
/**
 * ── SACAR UN PROVEEDOR DE UNA OFERTA ─────────────────────────────────────────────────────────
 *
 * No todo lo que está en el catálogo se le ofrece a todos. Un proveedor sacado desaparece de la
 * hoja de ESE cliente —la lista es de la oferta, no del catálogo— y no se le cotiza.
 *
 * ⚠️ PERO EL SELLO SE COMPRA EN BOLSA. Si el sello trae un solo proveedor, sacarlo lo saca de
 *    verdad: no se cotiza, no entra en la matriz, el cliente no lo tiene. Si el sello trae varios
 *    —"Galaxsys, OneTouch, 3 Oaks" se compran juntos— sacar a uno NO saca a los otros, así que el
 *    sello se sigue vendiendo y lo único que pasa es que ese nombre no figura en la hoja. El
 *    cliente lo va a tener igual. Por eso la pantalla lo dice con todas las letras: esconder algo
 *    que el cliente igual va a recibir es una verdad a medias, y la que se descubre sola.
 *
 * @returns Set de nombres de sello que quedan fuera por completo (todos sus proveedores sacados)
 */
function sellosSacados(oferta) {
  const fuera = new Set((oferta.excluidos || []).map((x) => _clave(x)));
  const out = new Set();
  if (!fuera.size) return out;
  for (const s of apiStore.listSellos()) {
    const provs = proveedoresDe(s.nombre);
    if (provs.length && provs.every((p) => fuera.has(_clave(p)))) out.add(s.nombre);
  }
  return out;
}

/**
 * @param oferta
 * @param opts  `ignorarSacados` devuelve TODO lo que la oferta cotizaría si no hubieras sacado a
 *              nadie. Lo usa la lista de casillas: si se armara con lo que queda, el proveedor que
 *              acabás de destildar desaparecería de la lista y no habría forma de volver a
 *              ponerlo. Una casilla que al apagarse se borra a sí misma es una puerta de una sola
 *              dirección, y no se ve hasta que la cruzás.
 */
function resolver(oferta, opts) {
  const paq = new Map(listPaquetes().map((p) => [p.id, p]));
  /* Lo que se sacó entero no se cotiza. Va acá y no sólo en el documento: `diff` y `aplicar` salen
     de esta misma función, así que un sello sacado tampoco entra en la matriz — si sólo lo
     escondiera la hoja, se lo seguiría facturando. */
  const sacados = (opts && opts.ignorarSacados) ? new Set() : sellosSacados(oferta);
  const out = new Map();
  for (const l of oferta.lineas || []) {
    if (!l.paquete_id || l.pct == null) continue;
    const p = paq.get(l.paquete_id);
    if (!p) continue;
    for (const s of p.sellos) {
      if (sacados.has(s)) continue;
      out.set(s, { pct: l.pct, paquete_id: p.id, suelto: false });
    }
  }
  for (const l of oferta.lineas || []) {
    if (!l.sello || l.pct == null || sacados.has(l.sello)) continue;
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

  /* ── CADA PROVEEDOR A SU SECCIÓN ───────────────────────────────────────────────────────────
     Por defecto un proveedor se muestra donde está su sello. La tabla `api_prov_seccion` lo
     manda a otra —sin tocar el sello, el costo ni la factura— y se lleva su precio con él. Si la
     sección de destino no está cotizada en ESTA oferta, se queda donde estaba: mostrarlo en una
     sección que el cliente no compró sería ofrecerle algo que no le vendiste. */
  const seccion = seccionesDeProveedor();
  const hay = new Set(grupos.map((g) => g.paquete_id).filter(Boolean));
  const porGrupo = new Map(grupos.map((g) => [g.paquete_id, []]));
  /* Los sacados que SOBREVIVEN acá son los que comparten sello con otros que sí van: el sello se
     vende igual y lo único que se puede hacer es no nombrarlos. Los que estaban solos en su sello
     ya no llegaron: `resolver` los dejó sin precio. */
  const fuera = new Set((oferta.excluidos || []).map((x) => _clave(x)));
  for (const g of grupos) {
    for (const i of g.items) {
      for (const prov of i.proveedores) {
        if (fuera.has(_clave(prov))) continue;
        const destino = seccion.get(_clave(prov));
        const id = destino && hay.has(destino) ? destino : g.paquete_id;
        porGrupo.get(id).push({ prov, pct: i.pct });
      }
    }
  }

  /* Cada grupo, resuelto en NIVELES DE PRECIO. Ver `_niveles`. */
  const armados = grupos.map((g) => {
    const niveles = _niveles(porGrupo.get(g.paquete_id) || []);
    const provs = unicos(niveles.flatMap((n) => n.proveedores));
    return { ...g, niveles, proveedores: provs,
      desde: niveles.length ? Number(niveles[0].pct) : Infinity,
      hasta: niveles.length ? Number(niveles[niveles.length - 1].pct) : Infinity };
  }).filter((g) => g.proveedores.length);   // un grupo sin proveedores que mostrar no es una fila

  /* ── EL BARATO ARRIBA ──────────────────────────────────────────────────────────────────────
     Lo que se vende es el Básico: es la puerta de entrada y el número que el cliente compara con
     el de al lado. Arrancar por el paquete caro lo deja al final de la hoja, leído después de
     veinte números grandes, como si fuera el resto. Se ordena por precio de entrada, más barato
     primero; los sellos que no caen en ningún paquete van últimos, porque son la excepción. */
  armados.sort((a, b) => (a.paquete_id ? 0 : 1) - (b.paquete_id ? 0 : 1) || a.desde - b.desde);

  /* Las excepciones que aplican a ESTA oferta, con el nombre tal como se muestra: es lo que la
     pantalla necesita para dibujar cada desplegable en su valor actual. */
  const secciones = {};
  for (const g of grupos) for (const i of g.items) for (const prov of i.proveedores) {
    if (fuera.has(_clave(prov))) continue;
    const d = seccion.get(_clave(prov));
    if (d && hay.has(d)) secciones[prov] = d;
  }

  /* Para cada proveedor de la oferta: en qué sellos viene y si alguno de ésos lo trae SOLO. Es lo
     que la pantalla necesita para avisar, casilla por casilla, si destildarlo lo saca de verdad o
     nada más lo borra de la hoja. */
  const enSellos = new Map();
  for (const [nombre] of resolver(oferta, { ignorarSacados: true })) {
    const meta = sellos.get(nombre) || {};
    const provs = proveedoresDe(nombre);
    for (const prov of provs) {
      const k = _clave(prov);
      if (!enSellos.has(k)) enSellos.set(k, { prov, sellos: [], solo: false });
      const e = enSellos.get(k);
      e.sellos.push(meta.corto || nombre);
      if (provs.length === 1) e.solo = true;
    }
  }

  return { titulo: oferta.titulo, notas: oferta.notas || '', grupos: armados,
    proveedores: unicos(armados.flatMap((g) => g.proveedores)),
    repetidos: _repetidos(armados), secciones,
    excluidos: oferta.excluidos || [],
    catalogo: [...enSellos.values()].sort((a, b) => a.prov.localeCompare(b.prov, 'es')) };
}

/**
 * ── LOS QUE APARECEN DOS VECES, Y POR QUÉ ────────────────────────────────────────────────────
 *
 * Microgaming está en Básico a 8% y otra vez en Premium a 15%. Pragmatic Live está dos veces
 * adentro de Live, a 18,5% y a 25%. Adentro no es un error: el mismo proveedor llega por
 * integraciones distintas, o en más de una versión —una más completa y más cara que la otra—.
 * En la hoja del cliente, en cambio, se lee como dos precios para lo mismo.
 *
 * Con el corte por sello esto no se veía, porque el precio estaba al costado de cada fila. Ahora
 * el precio es el título y la repetición salta: hay que explicarla. Lo que se devuelve es la lista
 * de los que repiten, para que el documento sólo ponga la aclaración CUANDO LA HAY — una oferta
 * sin repetidos no tiene por qué cargar con una nota que no le corresponde.
 */
function _repetidos(grupos) {
  const m = new Map();
  for (const g of grupos) {
    for (const n of g.niveles || []) {
      for (const p of n.proveedores) {
        const k = _clave(p);
        if (!m.has(k)) m.set(k, { nombre: p, pcts: new Set() });
        m.get(k).pcts.add(String(n.pct));
      }
    }
  }
  return [...m.values()].filter((x) => x.pcts.size > 1)
    .map((x) => x.nombre).sort((a, b) => a.localeCompare(b, 'es'));
}
/** Si todo el grupo va al mismo %, se muestra UN número arriba en vez de repetirlo en cada renglón. */
function _unico(items) {
  const p = [...new Set(items.map((i) => String(i.pct)))];
  return p.length === 1 ? p[0] : null;
}

/**
 * ── UN PRECIO, UNA LISTA DE PROVEEDORES ──────────────────────────────────────────────────────
 *
 * Un sello de TBS puede traer tres proveedores adentro —"Galaxsys, OneTouch, 3 Oaks"— y así se
 * mostraba: una fila con los tres pegados y un precio al costado. Adentro eso es correcto, porque
 * los tres se compran y se facturan juntos. Para el que lee la oferta no: lo que quiere saber es
 * CUÁNTOS proveedores le estás dando, y una fila con tres nombres se cuenta como uno.
 *
 * Acá se deshace la bolsa. Los sellos se juntan por PRECIO —todos los de 15 juntos, los de 17,5
 * juntos— y de cada grupo sale una lista plana de proveedores, cada uno una vez. El precio pasa a
 * ser el título y el proveedor la unidad, que es el orden en el que se lee la oferta.
 *
 * De paso desaparecen las repeticiones: "Platipus" estaba suelto y otra vez adentro de
 * "Microgaming Live", los dos a 15 — un proveedor, un lugar.
 */
function _niveles(entradas) {
  const m = new Map();
  for (const e of entradas) {
    const k = String(e.pct);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(e.prov);
  }
  return [...m.entries()]
    .map(([pct, provs]) => ({ pct, proveedores: unicos(provs) }))
    .filter((n) => n.proveedores.length)
    .sort((a, b) => Number(a.pct) - Number(b.pct));
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
 * ── QUÉ PAQUETE ES ÉSTE, SIN DEPENDER DE CÓMO SE LLAME HOY ───────────────────────────────────
 *
 * Media docena de reglas preguntan "¿éste es el Básico?" y lo hacían comparando el nombre letra
 * por letra contra 'básico'. El nombre es del dueño: el día que los renombró a "Slots Base" para
 * que se entendieran mejor, el Básico dejó de cobrarse a la base y pasó a lista, en silencio —
 * un nombre que no matchea no es un error, cae en el `else`.
 *
 * Acá se traduce el nombre a un TIPO, que es lo que las reglas de verdad preguntan. Aguanta el
 * "Slots" adelante, el acento, y Base o Básico. Lo que no reconoce devuelve null y se trata como
 * un paquete cualquiera, que es lo correcto para uno inventado por el dueño.
 */
function tipoDePaquete(nombre) {
  const k = K(nombre).replace(/^slots\s+/, '');
  if (/^(b[áa]sico|base)\s*\+/.test(k)) return 'base+';
  if (/^(b[áa]sico|base)$/.test(k)) return 'base';
  if (k === 'premium') return 'premium';
  if (k === 'live') return 'live';
  if (k === 'sport' || k === 'deportes') return 'sport';
  return null;
}

/**
 * ── EL PRECIO DEL EXTERNO SALE DE LO QUE CUESTA ──────────────────────────────────────────────
 *
 * Antes todo el Premium/Live/Sport salía 15% plano, con diez excepciones escritas a mano. Medido
 * sobre el catálogo real, ese 15% plano cae sobre costos que van de 4% a 15%: te dejaba ONCE
 * puntos en Altente y CERO en Betsoft, al mismo precio. No era una tarifa, era un promedio.
 *
 * Y no bajaba nunca. Los diez números fijos salieron de las ofertas de 2025, de clientes con base
 * 10 ó 12; cotizándole a uno de base 3 el mismo 25% de Pragmatic Live, el cliente veía un salto de
 * ×8 entre lo que le vendías y lo que le cobrabas por el resto.
 *
 * Ahora el precio del externo es `lo que te cuesta + tus puntos`. Te quedás lo mismo en todos, el
 * caro se cotiza caro, y al bajar la base baja todo junto sin tocar nada más.
 *
 * 🔑 CUÁNTO VALE ESTA DECISIÓN, MEDIDO: en julio los externos fueron el 0,21% del GGR —9.856 USD
 *    contra 4.596.505 de la base—. Todo su margen son 806 USD al mes: 0,011 puntos de base. Lo que
 *    se decide acá NO es plata, es cómo se lee la hoja. Por eso el default es generoso con el
 *    cliente: lo que se protege es la base, que es donde está el 99,8%.
 */
const MARGEN_MINIMO = 2;

/* Tus puntos siguen a la base —te quedás afuera lo mismo que adentro— pero con techo. Sin él, a
   base 12 serían 12 puntos sobre el costo y suben 36 de los 37 externos: Betsoft se iría a 27%.
   El 7 es el margen mediano que ya cobrabas con la tarifa vieja. */
const PUNTOS_TECHO = 7;
const puntosDeBase = (base) => Math.min(Math.max(Number(base) || 0, MARGEN_MINIMO), PUNTOS_TECHO);

/**
 * ── LOS DOS TOPES, POR CLIENTE ───────────────────────────────────────────────────────────────
 *
 * Los puntos son una regla pareja y a veces el caso no lo es. Con `minExt` ningún externo sale por
 * debajo de ese precio aunque de ese proveedor quisieras ganar un solo punto; con `maxExt` ninguno
 * pasa de ese precio aunque quisieras ganarle catorce. Son del CLIENTE, no del catálogo: el mismo
 * proveedor sale a un precio en una oferta y a otro en la de al lado, que es lo que pasa cuando
 * negociás de verdad.
 *
 * ⚠️ EL PISO LE GANA AL TECHO, SIEMPRE. Evolution Expensive cuesta 15%: un máximo de 14 no lo
 *    abarata, lo vende a pérdida. Cuando chocan, manda `costo + MARGEN_MINIMO` y el proveedor
 *    queda POR ENCIMA del máximo que pediste — y eso se devuelve en `avisos`, con nombre y
 *    apellido, para que decidas vos si lo sacás de la oferta. Un tope que se aplica en silencio
 *    rompiendo el piso es la forma más cara de que el sistema te dé la razón.
 */
function precioExterno(costo, puntos, minExt, maxExt) {
  let p = costo + puntos;
  if (minExt != null) p = Math.max(p, minExt);
  if (maxExt != null) p = Math.min(p, maxExt);
  return Math.max(p, costo + MARGEN_MINIMO);          // el piso, sobre todo lo anterior
}

/**
 * @param {number} base   el único número que se negocia
 * @param {object} opts   { puntos, minExt, maxExt } — todos opcionales
 * @returns {{lineas:Array, avisos:Array}} las líneas listas para guardar, y qué tuvo que corregir
 */
function armarDesdeBase(base, opts) {
  const b = Number(base);
  if (!Number.isFinite(b) || b <= 0) return { error: 'La base tiene que ser un número mayor que cero' };
  const o = opts || {};
  const n = (v) => (v == null || v === '' ? null : Number(String(v).replace(',', '.')));
  const puntos = n(o.puntos) != null ? n(o.puntos) : puntosDeBase(b);
  const minExt = n(o.minExt), maxExt = n(o.maxExt);
  if (puntos < 0) return { error: 'Los puntos no pueden ser negativos' };
  if (minExt != null && maxExt != null && minExt > maxExt) {
    return { error: `El mínimo (${minExt}) no puede ser mayor que el máximo (${maxExt})` };
  }

  const paquetes = listPaquetes();
  const sellos = apiStore.listSellos();
  /* El costo viene como texto y puede traer coma decimal: se normaliza acá una sola vez. */
  const aNum = (v) => Number(String(v ?? '').replace(',', '.')) || 0;
  const r1 = (x) => Math.round(x * 10) / 10;

  /* El detalle sale de acá y no se recalcula en la pantalla. Si el navegador repitiera la fórmula
     para dibujar la tabla, habría dos lugares con el mismo precio — y es cuestión de tiempo que
     uno de los dos quede viejo y le muestres al cliente un número que no es el que vas a cobrar. */
  const lineas = [], avisos = [], detalle = [];
  for (const p of paquetes) {
    const t = tipoDePaquete(p.nombre);
    /* La base y la base+ son catálogo propio: no tienen costo que pasar, y su precio ES la base.
       Van como línea de paquete, un número para todo el grupo. */
    if (t === 'base')  { lineas.push({ paquete_id: p.id, pct: b }); continue; }
    if (t === 'base+') { lineas.push({ paquete_id: p.id, pct: b + 2 }); continue; }
    /* Los externos se cotizan de a uno: cada uno cuesta distinto, así que cada uno vale distinto.
       La línea de paquete igual se escribe, para que el grupo tenga precio si mañana le entra un
       sello nuevo que todavía no tiene costo cargado. */
    lineas.push({ paquete_id: p.id, pct: r1(precioExterno(0, puntos, minExt, maxExt)) });
  }

  const enPaquete = new Map();
  paquetes.forEach((p) => (p.sellos || []).forEach((s) => enPaquete.set(s, p)));
  for (const s of sellos) {
    const p = enPaquete.get(s.nombre);
    if (!p) continue;
    const t = tipoDePaquete(p.nombre);
    const costo = aNum(s.costo);
    if (t === 'base' || t === 'base+') {
      /* Los de la base casi no cuestan, pero alguno sí —Buffalo Thunder cuesta 5— y a la base
         pelada se vendería a pérdida. Sólo ésos salen como línea suelta. */
      const piso = costo + MARGEN_MINIMO;
      const delGrupo = t === 'base' ? b : b + 2;
      if (costo <= 0 || delGrupo >= piso) continue;
      lineas.push({ sello: s.nombre, pct: r1(piso) });
      avisos.push({ sello: s.nombre, corto: s.corto, costo, queda: r1(piso), tipo: 'piso',
        porque: `cuesta ${costo}% y a ${delGrupo}% lo vendías a pérdida` });
      continue;
    }
    const pct = r1(precioExterno(costo, puntos, minExt, maxExt));
    lineas.push({ sello: s.nombre, pct });
    detalle.push({ sello: s.nombre, corto: s.corto, grupo: p.nombre, tipo: t, costo,
      pct, mg: r1(pct - costo), tope: minExt != null && pct === minExt ? 'min'
        : maxExt != null && pct === maxExt ? 'max'
        : pct === r1(costo + MARGEN_MINIMO) && costo + puntos < costo + MARGEN_MINIMO ? 'piso' : null });
    if (maxExt != null && pct > maxExt) {
      avisos.push({ sello: s.nombre, corto: s.corto, costo, queda: pct, tipo: 'pasa-el-maximo',
        porque: `cuesta ${costo}% y tu máximo es ${maxExt}%: por debajo de ${r1(costo + MARGEN_MINIMO)}% lo vendés a pérdida` });
    }
  }

  detalle.sort((a, b2) => b2.mg - a.mg);
  return { lineas, avisos, detalle, base: b, puntos, minExt, maxExt };
}

/**
 * ── RECOMPONER LOS PAQUETES POR LO QUE CUESTAN ───────────────────────────────────────────────
 *
 * Los paquetes son bolsas de proveedores, y si adentro de una hay costos muy distintos el precio
 * único regala unos y aprieta otros. Pasaba en Básico +: convivían Amusnet (2%) con Betsoft (15%),
 * los dos vendidos a 12 — uno dejaba 10 puntos y el otro perdía 3.
 *
 * 🔑 EL CRITERIO SALE DE LO QUE YA SE COBRABA, no de una idea nueva. En las 13 ofertas de 2025 los
 *    externos baratos se vendieron sistemáticamente entre base+1 y base+4, casi siempre base+2:
 *    Aviator a 11–13 para clientes con base 10, Spribe a 11–13, Yggdrasil a 11–14. Eso es
 *    exactamente el Básico +. Los que cuestan más nunca estuvieron en esa bolsa.
 *
 * ⚠️ NO TOCA nada que no haga falta: sólo mueve proveedores entre Básico + y Premium según su
 *    costo, y deja Básico y Live como están. Y devuelve el detalle de qué movería ANTES de mover,
 *    porque esto cambia lo que ve el cliente en el documento.
 */
/* 🔑 EL CORTE SALE DE LO QUE SE COBRABA, y está entre 3 y 4 — no en un número redondo:
     Aviator (1,5) se vendió a 12 · Spribe SR (3) a 12   → base+2, son Básico +
     Altente (4) se vendió a 14   · Tom Horn (5) a 14    → base+4, ésos son Premium
   Con el techo en 5 se bajaban Altente y Tom Horn dos puntos por debajo de lo que siempre
   costaron, que es regalar sin que nadie lo pida. */
const TECHO_BASICO_PLUS = 3;

function recomponerPorCosto({ aplicar = false, excluir = [] } = {}) {
  const paquetes = listPaquetes();
  const bplus = paquetes.find((p) => tipoDePaquete(p.nombre) === 'base+');
  const premium = paquetes.find((p) => tipoDePaquete(p.nombre) === 'premium');
  if (!bplus || !premium) return { error: 'no encontré los paquetes Base + y Premium' };

  const aNum = (v) => Number(String(v ?? '').replace(',', '.')) || 0;
  const sellos = apiStore.listSellos();
  const fuera = new Set(excluir.map(K));
  const esExterno = (s) => s.tipo !== 'postpago';

  /* Los que no se tocan. Sport entra en la lista por el mismo motivo que Live: es otro producto,
     no un escalón de precio de los slots, y meterlo en la bolsa de al lado por lo que cuesta lo
     haría desaparecer de su sección. */
  const quietos = new Set(paquetes.filter((p) => ['base', 'live', 'sport'].includes(tipoDePaquete(p.nombre)))
    .flatMap((p) => p.sellos));

  const nuevoBplus = [], nuevoPremium = [], movimientos = [];
  for (const s of sellos) {
    if (quietos.has(s.nombre)) continue;                            // ésos no se tocan
    if (!esExterno(s)) continue;
    const costo = aNum(s.costo);
    const estaba = bplus.sellos.includes(s.nombre) ? 'Básico +'
      : premium.sellos.includes(s.nombre) ? 'Premium' : null;

    /* Un proveedor dado de baja no se cotiza: si entra al paquete, aparece en el documento y el
       cliente lo pide. Se reconoce por el nombre, que es como lo marca TBS. */
    if (/dado de baja|de baja|discontinuad/i.test(s.nombre) || /dado de baja/i.test(s.corto)) {
      if (bplus.sellos.includes(s.nombre) || premium.sellos.includes(s.nombre)) {
        movimientos.push({ corto: s.corto, costo: aNum(s.costo),
          de: bplus.sellos.includes(s.nombre) ? 'Básico +' : 'Premium', a: 'sin paquete',
          porque: 'está dado de baja: no se cotiza' });
      }
      continue;
    }
    if (fuera.has(K(s.nombre)) || fuera.has(K(s.corto))) {
      if (estaba) movimientos.push({ corto: s.corto, costo, de: estaba, a: 'sin paquete',
        porque: 'lo dejaste afuera hasta confirmar su costo' });
      continue;                       // sin paquete: no se cotiza solo, y eso es a propósito
    }
    const destino = costo <= TECHO_BASICO_PLUS ? 'Básico +' : 'Premium';
    (destino === 'Básico +' ? nuevoBplus : nuevoPremium).push(s.nombre);
    if (estaba !== destino) {
      movimientos.push({ corto: s.corto, costo, de: estaba || 'sin paquete', a: destino,
        porque: costo <= TECHO_BASICO_PLUS
          ? `cuesta ${costo}%, que es lo que siempre se vendió a base+2`
          : `cuesta ${costo}%: a base+2 dejaba ${(12 - costo).toFixed(1)} puntos` });
    }
  }

  if (!aplicar) return { movimientos, bplus: nuevoBplus.length, premium: nuevoPremium.length };
  savePaquete({ ...bplus, sellos: nuevoBplus });
  savePaquete({ ...premium, sellos: nuevoPremium });
  return { aplicado: true, movimientos, bplus: nuevoBplus.length, premium: nuevoPremium.length };
}

module.exports = {
  armarDesdeBase, MARGEN_MINIMO, PUNTOS_TECHO, puntosDeBase, precioExterno,
  recomponerPorCosto, TECHO_BASICO_PLUS, tipoDePaquete,
  proveedoresDe, unicos, listPaquetes, savePaquete, removePaquete, sembrarPaquetes,
  sellosSacados,
  listSecciones, setSeccion, seccionesDeProveedor,
  listOfertas, getOferta, saveOferta, removeOferta, precioDeSello,
  resolver, diff, aplicar, paraMostrar,
};
