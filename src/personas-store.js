/**
 * personas-store.js — los PARTICIPANTES del reparto (§12 del addendum v3).
 *
 * Antes era solo "los socios": el reparto iba en dos pasos y la Empresa se llevaba su parte
 * en la tabla split_base, aparte. Ahora es un solo paso y la EMPRESA es un participante más
 * de esta misma lista — con `es_empresa=1`, que la marca como la casa y evita que se borre.
 */
const crypto = require('crypto');
const { db } = require('./db');

const newId = () => 'per_' + crypto.randomBytes(5).toString('hex');
const obj = (r) => (r ? { ...r, activo: !!r.activo, es_empresa: !!r.es_empresa } : null);

/** La fila de la Empresa. Se crea sola la primera vez; siempre va primera en la lista. */
function empresa() {
  const r = db.prepare('SELECT * FROM personas WHERE es_empresa=1').get();
  if (r) return obj(r);
  const id = newId();
  db.prepare('INSERT INTO personas (id,nombre,activo,createdAt,ord,es_empresa) VALUES (?,?,1,?,-1,1)')
    .run(id, 'Empresa', new Date().toISOString());
  console.log('[personas] participante EMPRESA creado (reparto de un solo paso)');
  return get(id);
}

function list() {
  empresa(); // garantiza que exista antes de listar
  return db.prepare('SELECT * FROM personas ORDER BY es_empresa DESC, ord ASC, nombre ASC').all().map(obj);
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
function remove(id) {
  const p = get(id);
  // La Empresa cobra en casi todos los repartos: borrarla dejaría a cada cliente sin cerrar
  // contra su % base, en silencio. Se puede renombrar, no eliminar.
  if (p && p.es_empresa) throw new Error('La Empresa no se puede borrar: es parte de todo reparto');
  return db.prepare('DELETE FROM personas WHERE id=?').run(id).changes > 0;
}

module.exports = { list, get, create, update, remove, empresa };
