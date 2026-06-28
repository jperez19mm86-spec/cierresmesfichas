/**
 * personas-store.js — los SOCIOS que reciben participación del profit LATAM (Ale, Henry, Carlos…).
 * Tabla independiente, no hardcodeada (sección 2.3 del doc).
 */
const crypto = require('crypto');
const { db } = require('./db');

const newId = () => 'per_' + crypto.randomBytes(5).toString('hex');
const obj = (r) => (r ? { ...r, activo: !!r.activo } : null);

function list() {
  return db.prepare('SELECT * FROM personas ORDER BY ord ASC, nombre ASC').all().map(obj);
}
function get(id) { return obj(db.prepare('SELECT * FROM personas WHERE id=?').get(id)); }

function create({ nombre }) {
  const n = String(nombre || '').trim();
  if (!n) throw new Error('nombre requerido');
  const id = newId();
  const ord = db.prepare('SELECT COUNT(*) c FROM personas').get().c;
  db.prepare('INSERT INTO personas (id,nombre,activo,createdAt,ord) VALUES (?,?,1,?,?)')
    .run(id, n, new Date().toISOString(), ord);
  return get(id);
}
function update(id, patch) {
  const p = get(id); if (!p) return null;
  const nombre = patch.nombre !== undefined ? String(patch.nombre).trim() : p.nombre;
  const activo = patch.activo !== undefined ? (patch.activo ? 1 : 0) : (p.activo ? 1 : 0);
  db.prepare('UPDATE personas SET nombre=?, activo=? WHERE id=?').run(nombre, activo, id);
  return get(id);
}
function remove(id) { return db.prepare('DELETE FROM personas WHERE id=?').run(id).changes > 0; }

module.exports = { list, get, create, update, remove };
