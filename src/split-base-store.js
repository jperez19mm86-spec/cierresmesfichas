/**
 * split-base-store.js — tabla SPLIT_BASE (sección 3.2): por cada % base, cuánto va a EMPRESA
 * y cuánto a LATAM. Configurable, NO hardcodeada. Se siembra con la tabla del doc la 1ra vez.
 */
const { db } = require('./db');

const SEED = [
  ['15', '8', '7'], ['14', '8', '6'], ['13', '8', '5'], ['12', '8', '4'],
  ['11', '7', '4'], ['10', '6', '4'], ['9', '6', '3'], ['8', '5', '3'],
];

function seedIfEmpty() {
  const c = db.prepare('SELECT COUNT(*) c FROM split_base').get().c;
  if (c > 0) return;
  const ins = db.prepare('INSERT INTO split_base (pct_base,pct_empresa,pct_latam,notas) VALUES (?,?,?,?)');
  SEED.forEach(([b, e, l]) => ins.run(b, e, l, ''));
  ins.run('<8', '', '', 'Caso individual');
  console.log('[split_base] seed inicial cargado (tabla del doc v3)');
}

function list() {
  return db.prepare('SELECT * FROM split_base').all()
    .sort((a, b) => (parseFloat(b.pct_base) || -1) - (parseFloat(a.pct_base) || -1));
}
function get(pct) { return db.prepare('SELECT * FROM split_base WHERE pct_base=?').get(String(pct)) || null; }

function upsert({ pct_base, pct_empresa, pct_latam, notas }) {
  db.prepare(`INSERT INTO split_base (pct_base,pct_empresa,pct_latam,notas) VALUES (?,?,?,?)
    ON CONFLICT(pct_base) DO UPDATE SET pct_empresa=excluded.pct_empresa, pct_latam=excluded.pct_latam, notas=excluded.notas`)
    .run(String(pct_base), String(pct_empresa || ''), String(pct_latam || ''), String(notas || ''));
  return get(pct_base);
}
function remove(pct) { return db.prepare('DELETE FROM split_base WHERE pct_base=?').run(String(pct)).changes > 0; }

/** Split para un base dado. base<8 → null (caso individual). */
function forBase(base) {
  const b = parseFloat(base);
  if (isNaN(b) || b < 8) return null;
  return get(String(Math.trunc(b))) || get(String(base));
}

module.exports = { seedIfEmpty, list, get, upsert, remove, forBase };
