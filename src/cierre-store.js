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
const money = require('./lib/money');
const { mesISO } = require('./lib/fechas');

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
/**
 * Renombrar un cliente tiene que ARRASTRAR su columna. La matriz se referencia por NOMBRE, así
 * que sin esto el cliente queda con la columna huérfana y PIERDE todos sus % sin avisar.
 * Lo mismo con el % base confirmado de cada mes.
 */
function renombrarCliente(viejo, nuevo) {
  const a = clean(viejo), b = clean(nuevo);
  if (!a || !b || a === b) return { movidas: 0 };
  const tx = db.transaction(() => {
    // si ya existe una columna con el nombre nuevo, se fusiona: gana lo que ya tenía el nuevo
    const yaEsta = db.prepare('SELECT nombre FROM cierre_cliente WHERE nombre=?').get(b);
    if (yaEsta) {
      db.prepare('DELETE FROM cierre_pct WHERE cliente=? AND proveedor IN (SELECT proveedor FROM cierre_pct WHERE cliente=?)').run(a, b);
      db.prepare('UPDATE cierre_pct SET cliente=? WHERE cliente=?').run(b, a);
      db.prepare('DELETE FROM cierre_cliente WHERE nombre=?').run(a);
    } else {
      db.prepare('UPDATE cierre_cliente SET nombre=? WHERE nombre=?').run(b, a);
      db.prepare('UPDATE cierre_pct SET cliente=? WHERE cliente=?').run(b, a);
    }
    db.prepare('UPDATE externos_base_mes SET cliente=? WHERE cliente=?').run(b, a);
  });
  tx();
  return { movidas: db.prepare('SELECT COUNT(*) c FROM cierre_pct WHERE cliente=?').get(b).c };
}

/** Columnas de la matriz que ya no corresponden a ningún cliente (y clientes sin columna). */
function inconsistencias() {
  const cols = db.prepare('SELECT nombre FROM cierre_cliente').all().map((r) => r.nombre);
  const cls = db.prepare('SELECT nombre, nombreVisible FROM clientes').all()
    .map((r) => String(r.nombre || r.nombreVisible || '').trim().toLowerCase()).filter(Boolean);
  const set = new Set(cls);
  const huerfanas = cols.filter((n) => !set.has(String(n).trim().toLowerCase()))
    .map((n) => ({ nombre: n, celdas: db.prepare('SELECT COUNT(*) c FROM cierre_pct WHERE cliente=?').get(n).c }));
  const nomCols = new Set(cols.map((n) => String(n).trim().toLowerCase()));
  const sinColumna = [...new Set(cls)].filter((n) => !nomCols.has(n));
  return { huerfanas, sinColumna, columnas: cols.length, clientes: set.size };
}

function removeCliente(nombre) {
  const n = clean(nombre); if (!n) return false;
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM cierre_pct WHERE cliente=?').run(n);
    db.prepare('DELETE FROM cierre_cliente WHERE nombre=?').run(n);
    db.prepare('DELETE FROM externos_base_mes WHERE cliente=?').run(n);
  }); tx();
  return true;
}

// ── Exchange Rate ──
/** La fila de la grilla que guarda el ARS del PROVEEDOR (el de su factura, no el promedio). */
const FILA_PROVEEDOR = 'ARS_OF';

function getTC() {
  const rows = db.prepare('SELECT moneda, mes, tasa FROM cierre_tc').all();
  const monedas = [...new Set(rows.map((r) => r.moneda))].sort();
  const meses = [...new Set(rows.map((r) => r.mes))];
  const tasas = {};
  for (const r of rows) (tasas[r.moneda] = tasas[r.moneda] || {})[r.mes] = r.tasa;
  return { monedas, meses, tasas };
}
function setTC(moneda, mes, tasa, forzar = false) {
  const m = clean(moneda), me = clean(mes), t = clean(tasa);
  if (!m || !me) return { ok: false, error: 'falta la moneda o el mes' };
  if (t == null) { db.prepare('DELETE FROM cierre_tc WHERE moneda=? AND mes=?').run(m, me); return { ok: true, borrado: true }; }
  // ⚠️ SE VALIDA EL FORMATO. Este campo se tipea a mano y es el divisor de TODO lo que se cobra:
  //    "1.400,50" se interpreta como 0   → esa moneda factura CERO y no avisa
  //    "1.400"    se interpreta como 1,4 → el fee sale MIL VECES más grande
  // Descubrirlo con la factura emitida es tarde, así que se rechaza al escribirlo.
  if (!money.esNumero(t)) {
    return { ok: false, error: `"${t}" no es un número válido. Usá punto para los decimales y no pongas separador de miles: 1400.50, no 1.400,50` };
  }
  if (!money.isPos(t)) return { ok: false, error: 'el tipo de cambio tiene que ser mayor que cero' };

  // Queda un caso que el formato no puede distinguir: "1.400" ES un número válido (1,4), pero casi
  // seguro se quiso escribir 1400 con separador de miles. No hay forma de saberlo mirando el valor
  // solo — sí comparándolo con lo que esa misma moneda venía valiendo. Un salto de más del 50% se
  // frena y pide confirmación explícita.
  if (!forzar) {
    const otros = db.prepare('SELECT tasa FROM cierre_tc WHERE moneda=? AND mes<>? ORDER BY rowid DESC LIMIT 1').get(m, me);
    if (otros && money.isPos(otros.tasa)) {
      const salto = money.D(money.div(money.sub(t, otros.tasa), otros.tasa)).abs();
      if (salto.gt('0.5')) {
        return {
          ok: false, confirmar: true, anterior: String(otros.tasa),
          error: `${m} venía en ${otros.tasa} y estás poniendo ${t} — es ${salto.times(100).toFixed(0)}% de diferencia. `
            + `Si escribiste "1.400" pensando en 1400, el punto es DECIMAL y quedaría 1,4. Confirmá si es correcto.`,
        };
      }
    }
  }
  db.prepare('INSERT INTO cierre_tc (moneda,mes,tasa) VALUES (?,?,?) ON CONFLICT(moneda,mes) DO UPDATE SET tasa=excluded.tasa').run(m, me, t);
  // ARS_OF ES el TC del proveedor: el mismo número que la tarjeta "Cierre mensual". Estaban en
  // dos tablas distintas y se habían separado — julio tenía 1473,5 en una y nada en la otra, y la
  // factura de externos lee la otra. Se escribe en las dos de una vez para que no vuelva a pasar.
  if (m.toUpperCase() === FILA_PROVEEDOR) {
    const iso = mesISO(me);
    if (iso) { try { require('./tc-store').setTcProveedor(iso, t); } catch (e) { /* no romper la carga por esto */ } }
  }
  return { ok: true };
}

/** Borra una columna entera (un mes) de la grilla de TC. */
function removeMesTC(mes) {
  const me = clean(mes); if (!me) return { ok: false, error: 'falta el mes' };
  const n = db.prepare('DELETE FROM cierre_tc WHERE mes=?').run(me).changes;
  return { ok: true, mes: me, celdas: n };
}

/** Borra una fila entera (una moneda) de la grilla de TC. */
function removeMonedaTC(moneda) {
  const mo = clean(moneda); if (!mo) return { ok: false, error: 'falta la moneda' };
  const n = db.prepare('DELETE FROM cierre_tc WHERE moneda=?').run(mo).changes;
  return { ok: true, moneda: mo, celdas: n };
}

/** Renombra una columna (Enero_26 → Enero_2026) sin perder los valores. */
function renombrarMesTC(viejo, nuevo) {
  const a = clean(viejo), b = clean(nuevo);
  if (!a || !b) return { ok: false, error: 'faltan los nombres' };
  if (getTC().meses.includes(b)) return { ok: false, error: `ya existe una columna "${b}"` };
  const n = db.prepare('UPDATE cierre_tc SET mes=? WHERE mes=?').run(b, a).changes;
  return { ok: true, de: a, a: b, celdas: n };
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

/**
 * Escribe muchas celdas de una (mantenimiento de precios: poner los SL2/SZ en 0, aplicar un tope,
 * copiar la lista de un cliente a otro…). Una sola transacción: o entran todas o ninguna.
 * cambios = [{ proveedor, cliente, pct }]  (pct '' o null borra la celda)
 */
const _lote = db.transaction((cambios) => {
  let n = 0;
  for (const c of cambios) if (setCelda(c.proveedor, c.cliente, c.pct)) n++;
  return n;
});
function setCeldas(cambios) {
  if (!Array.isArray(cambios) || !cambios.length) return 0;
  return _lote(cambios);
}

module.exports = {
  removeMesTC, removeMonedaTC, renombrarMesTC, FILA_PROVEEDOR,
  getMatriz, setCelda, setCeldas, addProveedor, setBase, removeProveedor,
  addCliente, setDescuento, removeCliente, renombrarCliente, inconsistencias, getTC, setTC, importar,
  getLinks, setLink, autoVincular, getClienteColumna, agregarFaltantesDeCatalogo, igualarVendorsADescuento,
};
