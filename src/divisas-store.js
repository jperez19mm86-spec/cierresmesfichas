/**
 * divisas-store.js — catálogo EDITABLE de divisas (v3.0). El campo "Divisa de fichas" del cliente
 * se completa desde acá (solo las activas). Se pueden agregar/dar de baja sin tocar código.
 */
const { db } = require('./db');

const clean = (v) => String(v == null ? '' : v).trim();

function list() { return db.prepare('SELECT codigo, nombre, activa, ord FROM divisas ORDER BY ord ASC, codigo ASC').all().map((r) => ({ ...r, activa: !!r.activa })); }
function listActivas() { return list().filter((d) => d.activa); }

function upsert({ codigo, nombre, activa }) {
  const cod = clean(codigo).toUpperCase(); if (!cod) return null;
  const ex = db.prepare('SELECT codigo FROM divisas WHERE codigo=?').get(cod);
  const ord = ex ? undefined : db.prepare('SELECT COALESCE(MAX(ord),-1)+1 n FROM divisas').get().n;
  if (ex) {
    db.prepare('UPDATE divisas SET nombre=COALESCE(?,nombre), activa=? WHERE codigo=?')
      .run(nombre !== undefined ? clean(nombre) : null, activa === undefined ? 1 : (activa ? 1 : 0), cod);
  } else {
    db.prepare('INSERT INTO divisas (codigo,nombre,activa,ord) VALUES (?,?,?,?)')
      .run(cod, clean(nombre), activa === undefined ? 1 : (activa ? 1 : 0), ord);
  }
  return db.prepare('SELECT codigo, nombre, activa, ord FROM divisas WHERE codigo=?').get(cod);
}
function setActiva(codigo, activa) { return db.prepare('UPDATE divisas SET activa=? WHERE codigo=?').run(activa ? 1 : 0, clean(codigo).toUpperCase()).changes > 0; }
function remove(codigo) { return db.prepare('DELETE FROM divisas WHERE codigo=?').run(clean(codigo).toUpperCase()).changes > 0; }

// Seed inicial (solo si la tabla está vacía) con las divisas más usadas del fleet.
function seedSiVacio() {
  if (db.prepare('SELECT COUNT(*) n FROM divisas').get().n) return 0;
  const base = [['ARS', 'Peso argentino'], ['MXN', 'Peso mexicano'], ['UYU', 'Peso uruguayo'], ['PYG', 'Guaraní'],
    ['CLP', 'Peso chileno'], ['PEN', 'Sol peruano'], ['BRL', 'Real'], ['USD', 'Dólar'], ['USDT', 'Tether'], ['VEF', 'Bolívar'], ['EUR', 'Euro']];
  const tx = db.transaction(() => { base.forEach((d, i) => db.prepare('INSERT INTO divisas (codigo,nombre,activa,ord) VALUES (?,?,1,?)').run(d[0], d[1], i)); });
  tx();
  return base.length;
}
seedSiVacio();

module.exports = { list, listActivas, upsert, setActiva, remove, seedSiVacio };
