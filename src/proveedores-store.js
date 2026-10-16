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

/**
 * Alta MASIVA desde el REPORTE de proveedores (los que aparecen en el cierre del mes).
 * entries = [{ codigo, nombre }] YA deduplicados. Upsert por `codigo`: si ya existe NO lo toca
 * (preserva su % costo y categoría); si es nuevo lo crea con categoría 'extra' y % vacío.
 * opts.limpiarSinCosto = borra primero las entradas del reporte (codigo con '|') SIN % costo, para
 * refrescar la identidad/nombres sin dejar huérfanos (las que tienen costo se preservan siempre).
 * Devuelve { creados, existentes, eliminados }.
 */
function importarCatalogo(entries, opts = {}) {
  let creados = 0, existentes = 0, eliminados = 0;
  const tx = db.transaction((list) => {
    if (opts.limpiarSinCosto) {
      eliminados = db.prepare("DELETE FROM proveedores WHERE codigo LIKE '%|%' AND (tarifa_pct IS NULL OR tarifa_pct='')").run().changes;
    }
    const existentesSet = new Set(
      db.prepare("SELECT codigo FROM proveedores WHERE codigo IS NOT NULL AND codigo<>''").all().map((r) => r.codigo)
    );
    for (const e of list) {
      const codigo = String(e.codigo || '').trim();
      if (!codigo) continue;
      if (existentesSet.has(codigo)) { existentes++; continue; }
      create({ nombre: e.nombre, codigo, categoria: 'extra' }); // tarifa_pct queda vacío
      existentesSet.add(codigo); creados++;
    }
  });
  tx(entries || []);
  return { creados, existentes, eliminados };
}

/* Las tarifas por panel y por cliente (panel_proveedores, cliente_proveedores) se retiraron con el
   motor que las usaba; las tablas quedan en la base. Ver os.routes «proveedores». */

module.exports = {
  CATEGORIAS, list, get, create, update, remove, importarCatalogo,
};
