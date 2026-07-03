/**
 * cierre-store.js — réplica EDITABLE de la planilla de cierre de Alexa.
 *  - cierre_proveedor : filas de la matriz ("MARCA VENDOR") + su % base.
 *  - cierre_cliente   : columnas de la matriz + su descuento (1_Cliente).
 *  - cierre_pct       : celdas proveedor×cliente (%).
 *  - cierre_tc        : Exchange Rate (moneda × mes → USDT).
 * Todo keyeado por NOMBRE (igual que la planilla). Vacío = se borra la fila (no guarda ''),
 * así el grid queda limpio. Se cruza con el catálogo/paneles recién al calcular el cierre.
 */
const { db } = require('./db');

const clean = (v) => (v == null || String(v).trim() === '' ? null : String(v).trim());

// ── matriz ──
function getMatriz() {
  const proveedores = db.prepare('SELECT nombre, base_pct FROM cierre_proveedor ORDER BY ord ASC, nombre ASC').all();
  const clientes = db.prepare('SELECT nombre, descuento FROM cierre_cliente ORDER BY ord ASC, nombre ASC').all();
  const celdas = {}; // celdas[proveedor][cliente] = pct
  for (const r of db.prepare('SELECT proveedor, cliente, pct FROM cierre_pct').all()) {
    (celdas[r.proveedor] = celdas[r.proveedor] || {})[r.cliente] = r.pct;
  }
  return { proveedores, clientes, celdas };
}

function setCelda(proveedor, cliente, pct) {
  const p = clean(proveedor), c = clean(cliente), v = clean(pct);
  if (!p || !c) return false;
  if (v == null) { db.prepare('DELETE FROM cierre_pct WHERE proveedor=? AND cliente=?').run(p, c); return true; }
  db.prepare('INSERT INTO cierre_pct (proveedor,cliente,pct) VALUES (?,?,?) ON CONFLICT(proveedor,cliente) DO UPDATE SET pct=excluded.pct').run(p, c, v);
  return true;
}

function _nextOrd(table) { return db.prepare(`SELECT COALESCE(MAX(ord),-1)+1 n FROM ${table}`).get().n; }

function addProveedor(nombre, base_pct) {
  const n = clean(nombre); if (!n) return null;
  db.prepare('INSERT INTO cierre_proveedor (nombre,base_pct,ord) VALUES (?,?,?) ON CONFLICT(nombre) DO UPDATE SET base_pct=COALESCE(excluded.base_pct, cierre_proveedor.base_pct)')
    .run(n, clean(base_pct), _nextOrd('cierre_proveedor'));
  return n;
}
function setBase(nombre, base_pct) {
  const n = clean(nombre); if (!n) return false;
  db.prepare('INSERT INTO cierre_proveedor (nombre,base_pct,ord) VALUES (?,?,?) ON CONFLICT(nombre) DO UPDATE SET base_pct=excluded.base_pct').run(n, clean(base_pct), _nextOrd('cierre_proveedor'));
  return true;
}
function removeProveedor(nombre) {
  const n = clean(nombre); if (!n) return false;
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM cierre_pct WHERE proveedor=?').run(n);
    db.prepare('DELETE FROM cierre_proveedor WHERE nombre=?').run(n);
  }); tx();
  return true;
}

function addCliente(nombre, descuento) {
  const n = clean(nombre); if (!n) return null;
  db.prepare('INSERT INTO cierre_cliente (nombre,descuento,ord) VALUES (?,?,?) ON CONFLICT(nombre) DO UPDATE SET descuento=COALESCE(excluded.descuento, cierre_cliente.descuento)')
    .run(n, clean(descuento), _nextOrd('cierre_cliente'));
  return n;
}
function setDescuento(nombre, descuento) {
  const n = clean(nombre); if (!n) return false;
  db.prepare('INSERT INTO cierre_cliente (nombre,descuento,ord) VALUES (?,?,?) ON CONFLICT(nombre) DO UPDATE SET descuento=excluded.descuento').run(n, clean(descuento), _nextOrd('cierre_cliente'));
  return true;
}
function removeCliente(nombre) {
  const n = clean(nombre); if (!n) return false;
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM cierre_pct WHERE cliente=?').run(n);
    db.prepare('DELETE FROM cierre_cliente WHERE nombre=?').run(n);
  }); tx();
  return true;
}

// ── Exchange Rate ──
function getTC() {
  const rows = db.prepare('SELECT moneda, mes, tasa FROM cierre_tc').all();
  const monedas = [...new Set(rows.map((r) => r.moneda))].sort();
  const meses = [...new Set(rows.map((r) => r.mes))];
  const tasas = {};
  for (const r of rows) (tasas[r.moneda] = tasas[r.moneda] || {})[r.mes] = r.tasa;
  return { monedas, meses, tasas };
}
function setTC(moneda, mes, tasa) {
  const m = clean(moneda), me = clean(mes), t = clean(tasa);
  if (!m || !me) return false;
  if (t == null) { db.prepare('DELETE FROM cierre_tc WHERE moneda=? AND mes=?').run(m, me); return true; }
  db.prepare('INSERT INTO cierre_tc (moneda,mes,tasa) VALUES (?,?,?) ON CONFLICT(moneda,mes) DO UPDATE SET tasa=excluded.tasa').run(m, me, t);
  return true;
}

/** Columna de UN cliente: su descuento + el % de cada proveedor de la matriz (para editar desde el cliente). */
function getClienteColumna(nombre) {
  const n = clean(nombre); if (!n) return { nombre: null, existe: false, descuento: null, proveedores: [], celdas: {} };
  const cli = db.prepare('SELECT nombre, descuento FROM cierre_cliente WHERE nombre=?').get(n);
  const proveedores = db.prepare('SELECT nombre, base_pct FROM cierre_proveedor ORDER BY ord ASC, nombre ASC').all();
  const celdas = {};
  db.prepare('SELECT proveedor, pct FROM cierre_pct WHERE cliente=?').all(n).forEach((r) => { celdas[r.proveedor] = r.pct; });
  return { nombre: n, existe: !!cli, descuento: cli ? cli.descuento : null, proveedores, celdas };
}

/** Para todo proveedor cuyo VENDOR sea SL o XG: pone en cada celda el DESCUENTO de ese cliente
 *  (→ %neto = %celda − descuento = 0). Sobrescribe lo que hubiera. vendors = ['SL','XG'] por default. */
function igualarVendorsADescuento(vendors = ['SL', 'XG']) {
  const set = new Set(vendors.map((s) => String(s).toUpperCase()));
  const provs = db.prepare('SELECT nombre FROM cierre_proveedor').all()
    .map((r) => r.nombre).filter((n) => set.has(String(n).split(' ').pop().toUpperCase()));
  const clientes = db.prepare('SELECT nombre, descuento FROM cierre_cliente').all();
  let celdas = 0;
  const tx = db.transaction(() => {
    for (const prov of provs) for (const c of clientes) { setCelda(prov, c.nombre, c.descuento); celdas++; }
  });
  tx();
  return { proveedores: provs.length, clientes: clientes.length, celdas, vendors: [...set] };
}

/** Agrega a la matriz TODOS los proveedores del casino (catálogo Casino+Europa) que falten,
 *  como fila nueva SIN % base ni celdas → así el 100% de los del casino figura en el Cierre. */
function agregarFaltantesDeCatalogo() {
  const enMatriz = new Set(db.prepare('SELECT nombre FROM cierre_proveedor').all().map((r) => r.nombre));
  let agregados = 0; const seen = new Set();
  const tx = db.transaction(() => {
    for (const p of _casinoProvs()) { // [{casino:'MARCA VENDOR', marca, vendor}] del catálogo
      const n = p.casino;
      if (!n || enMatriz.has(n) || seen.has(n)) continue;
      addProveedor(n, null); // fila nueva, sin % base
      seen.add(n); agregados++;
    }
  });
  tx();
  return { agregados, total_matriz: db.prepare('SELECT COUNT(*) n FROM cierre_proveedor').get().n };
}

// ── VINCULACIÓN proveedor del casino ↔ proveedor de la matriz ──
// El casino trae "MARCA VENDOR" (ej "RUBYPLAY XG"); la matriz de Alexa usa otro vendor (ej "RUBYPLAY OP").
// Vinculamos cada proveedor del casino (= catálogo, codigo "label|vendor") a una fila de la matriz.
function _casinoProvs() {
  return db.prepare("SELECT nombre, codigo FROM proveedores WHERE codigo LIKE '%|%' ORDER BY nombre").all()
    .map((p) => { const vendor = p.codigo.slice(p.codigo.lastIndexOf('|') + 1); return { casino: `${p.nombre} ${vendor}`.trim(), marca: p.nombre, vendor }; });
}
function _porMarca() {
  const map = {};
  for (const r of db.prepare('SELECT nombre FROM cierre_proveedor').all()) {
    const marca = r.nombre.split(' ').slice(0, -1).join(' ') || r.nombre;
    (map[marca] = map[marca] || []).push(r.nombre);
  }
  return map;
}
/** Devuelve cada proveedor del casino con su vínculo actual + sugerencia + estado, y la lista de la matriz. */
function getLinks() {
  const matrizProvs = db.prepare('SELECT nombre FROM cierre_proveedor ORDER BY nombre').all().map((r) => r.nombre);
  const matrizSet = new Set(matrizProvs);
  const porMarca = _porMarca();
  const links = {}; db.prepare('SELECT casino, matriz, origen FROM cierre_link').all().forEach((r) => { links[r.casino] = r; });
  const rows = _casinoProvs().map((p) => {
    const l = links[p.casino];
    let matriz = l ? l.matriz : null, origen = l ? l.origen : null, sugerido = null, estado;
    if (matriz) estado = 'vinculado';
    else if (matrizSet.has(p.casino)) { sugerido = p.casino; estado = 'exacto'; }
    else { const c = porMarca[p.marca]; if (c && c.length === 1) { sugerido = c[0]; estado = 'sugerido'; } else if (c && c.length > 1) { estado = 'ambiguo'; } else estado = 'sin_match'; }
    return { ...p, matriz, origen, sugerido, estado, opciones: porMarca[p.marca] || [] };
  });
  return { rows, matriz: matrizProvs };
}
function setLink(casino, matriz) {
  const c = clean(casino); if (!c) return false;
  const m = clean(matriz);
  if (m == null) { db.prepare('DELETE FROM cierre_link WHERE casino=?').run(c); return true; }
  db.prepare("INSERT INTO cierre_link (casino,matriz,origen) VALUES (?,?,'manual') ON CONFLICT(casino) DO UPDATE SET matriz=excluded.matriz, origen='manual'").run(c, m);
  return true;
}
/** Auto-vincula SOLO match EXACTO (Marca+Vendor idéntico). El resto queda para hacerlo A MANO.
 *  Saca los vínculos viejos "por marca" (no exactos, no manuales) → vuelven a "sin vincular". */
function autoVincular() {
  const matrizSet = new Set(db.prepare('SELECT nombre FROM cierre_proveedor').all().map((r) => r.nombre));
  const manuales = new Set(db.prepare("SELECT casino FROM cierre_link WHERE origen='manual'").all().map((r) => r.casino));
  let exactos = 0, quitados = 0;
  const tx = db.transaction(() => {
    quitados = db.prepare("DELETE FROM cierre_link WHERE origen='marca'").run().changes; // los aproximados van a mano
    for (const p of _casinoProvs()) {
      if (manuales.has(p.casino)) continue; // no pisar los hechos a mano
      if (matrizSet.has(p.casino)) {
        db.prepare("INSERT INTO cierre_link (casino,matriz,origen) VALUES (?,?,'exacto') ON CONFLICT(casino) DO UPDATE SET matriz=excluded.matriz, origen='exacto'").run(p.casino, p.casino);
        exactos++;
      }
    }
  });
  tx();
  return { exactos, quitados, porMarca: 0 };
}

/**
 * Seed masivo (duplicar la planilla). payload = { proveedores:[{nombre,base_pct}], clientes:[{nombre,descuento}],
 * celdas:[{proveedor,cliente,pct}], tc:[{moneda,mes,tasa}], reset:bool }.
 * reset=true vacía primero (re-import limpio). Sin reset = upsert aditivo (conserva ediciones manuales previas
 * salvo las celdas que vengan en el payload). Devuelve conteos.
 */
function importar(payload = {}) {
  const { proveedores = [], clientes = [], celdas = [], tc = [], reset = false } = payload;
  const tx = db.transaction(() => {
    if (reset) { db.exec('DELETE FROM cierre_pct; DELETE FROM cierre_proveedor; DELETE FROM cierre_cliente; DELETE FROM cierre_tc;'); }
    let op = _nextOrd('cierre_proveedor');
    for (const p of proveedores) { const n = clean(p.nombre); if (!n) continue;
      db.prepare('INSERT INTO cierre_proveedor (nombre,base_pct,ord) VALUES (?,?,?) ON CONFLICT(nombre) DO UPDATE SET base_pct=COALESCE(excluded.base_pct, cierre_proveedor.base_pct)').run(n, clean(p.base_pct), op++); }
    let oc = _nextOrd('cierre_cliente');
    for (const c of clientes) { const n = clean(c.nombre); if (!n) continue;
      db.prepare('INSERT INTO cierre_cliente (nombre,descuento,ord) VALUES (?,?,?) ON CONFLICT(nombre) DO UPDATE SET descuento=COALESCE(excluded.descuento, cierre_cliente.descuento)').run(n, clean(c.descuento), oc++); }
    for (const k of celdas) { const p = clean(k.proveedor), c = clean(k.cliente), v = clean(k.pct); if (!p || !c || v == null) continue;
      db.prepare('INSERT INTO cierre_pct (proveedor,cliente,pct) VALUES (?,?,?) ON CONFLICT(proveedor,cliente) DO UPDATE SET pct=excluded.pct').run(p, c, v); }
    for (const t of tc) { const m = clean(t.moneda), me = clean(t.mes), ta = clean(t.tasa); if (!m || !me || ta == null) continue;
      db.prepare('INSERT INTO cierre_tc (moneda,mes,tasa) VALUES (?,?,?) ON CONFLICT(moneda,mes) DO UPDATE SET tasa=excluded.tasa').run(m, me, ta); }
  });
  tx();
  return {
    proveedores: db.prepare('SELECT COUNT(*) n FROM cierre_proveedor').get().n,
    clientes: db.prepare('SELECT COUNT(*) n FROM cierre_cliente').get().n,
    celdas: db.prepare('SELECT COUNT(*) n FROM cierre_pct').get().n,
    tc: db.prepare('SELECT COUNT(*) n FROM cierre_tc').get().n,
  };
}

module.exports = {
  getMatriz, setCelda, addProveedor, setBase, removeProveedor,
  addCliente, setDescuento, removeCliente, getTC, setTC, importar,
  getLinks, setLink, autoVincular, getClienteColumna, agregarFaltantesDeCatalogo, igualarVendorsADescuento,
};
