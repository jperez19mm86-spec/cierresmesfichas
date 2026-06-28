/**
 * proveedores-store.js — catálogo GLOBAL de proveedores (sección 3.3) + su config por panel.
 *  - proveedores: nombre + categoria (incluido | extra | interno) + tc_aplica.
 *  - panel_proveedores: qué proveedores tiene cada panel + su tarifa_pct.
 * Dinámico, nunca hardcodear nombres (instrucción del doc).
 */
const crypto = require('crypto');
const { db } = require('./db');
const money = require('./lib/money');
const { nowISO } = require('./lib/fechas');

const CATEGORIAS = ['incluido', 'extra', 'interno'];
const newId = (p) => p + '_' + crypto.randomBytes(5).toString('hex');

// ── catálogo ──
function list() { return db.prepare('SELECT * FROM proveedores ORDER BY ord ASC, nombre ASC').all().map((r) => ({ ...r, activo: !!r.activo })); }
function get(id) { const r = db.prepare('SELECT * FROM proveedores WHERE id=?').get(id); return r ? { ...r, activo: !!r.activo } : null; }

function create(d) {
  const id = newId('prov');
  const ord = db.prepare('SELECT COUNT(*) c FROM proveedores').get().c;
  const cat = CATEGORIAS.includes(d.categoria) ? d.categoria : 'extra';
  db.prepare('INSERT INTO proveedores (id,nombre,categoria,tc_aplica,activo,createdAt,ord,tarifa_pct,codigo) VALUES (?,?,?,?,1,?,?,?,?)')
    .run(id, String(d.nombre || '').trim(), cat, d.tc_aplica || (cat === 'incluido' ? 'na' : 'tc_cliente'), nowISO(), ord,
      d.tarifa_pct != null && d.tarifa_pct !== '' ? String(d.tarifa_pct) : null, String(d.codigo || '').trim() || null);
  return get(id);
}
function update(id, patch) {
  const p = get(id); if (!p) return null;
  const cat = patch.categoria !== undefined && CATEGORIAS.includes(patch.categoria) ? patch.categoria : p.categoria;
  db.prepare('UPDATE proveedores SET nombre=?, categoria=?, tc_aplica=?, activo=?, tarifa_pct=?, codigo=? WHERE id=?').run(
    patch.nombre !== undefined ? String(patch.nombre).trim() : p.nombre, cat,
    patch.tc_aplica !== undefined ? patch.tc_aplica : p.tc_aplica,
    patch.activo !== undefined ? (patch.activo ? 1 : 0) : (p.activo ? 1 : 0),
    patch.tarifa_pct !== undefined ? (patch.tarifa_pct === '' ? null : String(patch.tarifa_pct)) : (p.tarifa_pct || null),
    patch.codigo !== undefined ? String(patch.codigo).trim() : (p.codigo || null), id);
  return get(id);
}
function remove(id) { return db.prepare('DELETE FROM proveedores WHERE id=?').run(id).changes > 0; }

// ── config por panel ──
function listPorPanel(panel_id) {
  return db.prepare(`
    SELECT pp.*, pr.nombre AS proveedor_nombre, pr.categoria AS proveedor_categoria
    FROM panel_proveedores pp JOIN proveedores pr ON pr.id = pp.proveedor_id
    WHERE pp.panel_id=? ORDER BY pr.nombre ASC
  `).all(panel_id).map((r) => ({ ...r, habilitado: !!r.habilitado }));
}

/** Upsert de un proveedor en un panel (tarifa + habilitado). */
function setPanelProveedor({ panel_id, proveedor_id, tarifa_pct, habilitado }) {
  const existing = db.prepare('SELECT id FROM panel_proveedores WHERE panel_id=? AND proveedor_id=?').get(panel_id, proveedor_id);
  if (existing) {
    db.prepare('UPDATE panel_proveedores SET tarifa_pct=?, habilitado=? WHERE id=?')
      .run(money.round(tarifa_pct || 0, 4), habilitado ? 1 : 0, existing.id);
    return existing.id;
  }
  const id = newId('pp');
  db.prepare('INSERT INTO panel_proveedores (id,panel_id,proveedor_id,tarifa_pct,habilitado,vigente_desde,createdAt) VALUES (?,?,?,?,?,?,?)')
    .run(id, panel_id, proveedor_id, money.round(tarifa_pct || 0, 4), habilitado ? 1 : 0, null, nowISO());
  return id;
}
function removePanelProveedor(id) { return db.prepare('DELETE FROM panel_proveedores WHERE id=?').run(id).changes > 0; }

// ── config POR CLIENTE (el % de cada proveedor rige para TODOS los paneles del cliente) ──
/**
 * Catálogo COMPLETO de proveedores con el % de ESTE cliente.
 * item: { proveedor_id, nombre, categoria, codigo, tarifa_global, tarifa_cliente(override|null),
 *         tarifa_efectiva (cliente si hay, si no global), habilitado }.
 */
function catalogoParaCliente(cliente_id) {
  const ov = {};
  db.prepare('SELECT * FROM cliente_proveedores WHERE cliente_id=?').all(cliente_id).forEach((r) => { ov[r.proveedor_id] = r; });
  return list().map((p) => {
    const o = ov[p.id];
    const tarifa_cliente = o && o.tarifa_pct != null && o.tarifa_pct !== '' ? o.tarifa_pct : null;
    return {
      proveedor_id: p.id, nombre: p.nombre, categoria: p.categoria, codigo: p.codigo || null,
      tarifa_global: p.tarifa_pct || null,
      tarifa_cliente,
      tarifa_efectiva: tarifa_cliente != null ? tarifa_cliente : (p.tarifa_pct || null),
      habilitado: o ? !!o.habilitado : true,
    };
  });
}

/** % efectivo de un proveedor para un cliente (override del cliente → global del catálogo). */
function tarifaParaCliente(cliente_id, proveedor_id) {
  const o = db.prepare('SELECT tarifa_pct FROM cliente_proveedores WHERE cliente_id=? AND proveedor_id=?').get(cliente_id, proveedor_id);
  if (o && o.tarifa_pct != null && o.tarifa_pct !== '') return o.tarifa_pct;
  const p = get(proveedor_id);
  return p ? (p.tarifa_pct || null) : null;
}

/** Upsert del % de un proveedor para un cliente. Vacío/null = borra el override (vuelve al global). */
function setClienteProveedor({ cliente_id, proveedor_id, tarifa_pct, habilitado }) {
  const existing = db.prepare('SELECT id FROM cliente_proveedores WHERE cliente_id=? AND proveedor_id=?').get(cliente_id, proveedor_id);
  const blank = tarifa_pct === '' || tarifa_pct == null;
  if (blank && habilitado !== false) { // sin % propio y habilitado → no hace falta override
    if (existing) db.prepare('DELETE FROM cliente_proveedores WHERE id=?').run(existing.id);
    return null;
  }
  const tarifa = blank ? null : String(money.round(tarifa_pct, 4));
  if (existing) {
    db.prepare('UPDATE cliente_proveedores SET tarifa_pct=?, habilitado=? WHERE id=?').run(tarifa, habilitado === false ? 0 : 1, existing.id);
    return existing.id;
  }
  const id = newId('cp');
  db.prepare('INSERT INTO cliente_proveedores (id,cliente_id,proveedor_id,tarifa_pct,habilitado,createdAt) VALUES (?,?,?,?,?,?)')
    .run(id, cliente_id, proveedor_id, tarifa, habilitado === false ? 0 : 1, nowISO());
  return id;
}
function removeClienteProveedor(cliente_id, proveedor_id) {
  return db.prepare('DELETE FROM cliente_proveedores WHERE cliente_id=? AND proveedor_id=?').run(cliente_id, proveedor_id).changes > 0;
}

module.exports = {
  CATEGORIAS, list, get, create, update, remove,
  listPorPanel, setPanelProveedor, removePanelProveedor,
  catalogoParaCliente, tarifaParaCliente, setClienteProveedor, removeClienteProveedor,
};
