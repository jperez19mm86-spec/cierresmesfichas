/**
 * paneles-store.js — PANELES (unidad operativa del proveedor) — sección 2.2 del doc.
 * Un cliente tiene varios paneles. Es la evolución de la "caja" de la MATRIZ:
 * suma sistema/tipo/nivel_usuario/id_usuario + config propia o heredada del cliente.
 *
 * precio_base_override NO es columna acá: cuando usa_config_cliente=false el precio propio
 * vive versionado en config_valores (entidad_tipo='panel'). Ver historial.js.
 */
const crypto = require('crypto');
const { db } = require('./db');

const NIVELES = ['SuperAgente', 'Distribuidor', 'Agente'];
const newId = () => 'pan_' + crypto.randomBytes(5).toString('hex');

function parseJson(s, def) { try { return s ? JSON.parse(s) : def; } catch (e) { return def; } }
function obj(r) {
  if (!r) return null;
  return {
    ...r,
    usa_config_cliente: !!r.usa_config_cliente,
    divisas: parseJson(r.divisas, []),
    montosRapidos: parseJson(r.montosRapidos, []),
  };
}
function normDivisas(v) {
  if (Array.isArray(v)) return v.map((s) => String(s).trim().toUpperCase()).filter(Boolean);
  return String(v || '').split(/[,;\s]+/).map((s) => s.trim().toUpperCase()).filter(Boolean);
}

function list(filters = {}) {
  let sql = 'SELECT * FROM paneles'; const p = [];
  if (filters.cliente_id) { sql += ' WHERE cliente_id=?'; p.push(filters.cliente_id); }
  sql += ' ORDER BY ord ASC';
  return db.prepare(sql).all(...p).map(obj);
}
function get(id) { return obj(db.prepare('SELECT * FROM paneles WHERE id=?').get(id)); }

function create(d) {
  const id = newId();
  const ord = db.prepare('SELECT COUNT(*) c FROM paneles').get().c;
  const nivel = NIVELES.includes(d.nivel_usuario) ? d.nivel_usuario : 'Agente';
  let divisas = normDivisas(d.divisas);
  if (nivel !== 'SuperAgente' && divisas.length > 1) divisas = [divisas[0]]; // regla: solo SuperAgente multi-divisa
  db.prepare(`INSERT INTO paneles
      (id,cliente_id,nombre,sistema,tipo,nivel_usuario,id_usuario,usa_config_cliente,divisas,usuario,montosRapidos,notas,conexion_id,createdAt,ord)
      VALUES (@id,@cli,@nombre,@sistema,@tipo,@nivel,@idu,@ucc,@div,@usuario,@montos,@notas,@cxid,@ca,@ord)`).run({
    id, cli: d.cliente_id || null, nombre: String(d.nombre || '').trim(), sistema: d.sistema || '',
    tipo: d.tipo || 'exclusivo', nivel, idu: String(d.id_usuario || '').trim(),
    ucc: d.usa_config_cliente === false ? 0 : 1, div: JSON.stringify(divisas),
    usuario: String(d.usuario || '').trim(), montos: JSON.stringify(d.montosRapidos || []),
    notas: String(d.notas || '').trim(), cxid: d.conexion_id || null, ca: new Date().toISOString(), ord,
  });
  return get(id);
}

function update(id, patch) {
  const p = get(id); if (!p) return null;
  const f = (k, def) => (patch[k] !== undefined ? patch[k] : def);
  const nivel = NIVELES.includes(f('nivel_usuario', p.nivel_usuario)) ? f('nivel_usuario', p.nivel_usuario) : p.nivel_usuario;
  let divisas = patch.divisas !== undefined ? normDivisas(patch.divisas) : p.divisas;
  if (nivel !== 'SuperAgente' && divisas.length > 1) divisas = [divisas[0]];
  db.prepare(`UPDATE paneles SET cliente_id=@cli,nombre=@nombre,sistema=@sistema,tipo=@tipo,nivel_usuario=@nivel,
      id_usuario=@idu,usa_config_cliente=@ucc,divisas=@div,usuario=@usuario,montosRapidos=@montos,notas=@notas,conexion_id=@cxid WHERE id=@id`).run({
    id, cli: f('cliente_id', p.cliente_id), nombre: String(f('nombre', p.nombre)).trim(), sistema: f('sistema', p.sistema),
    tipo: f('tipo', p.tipo), nivel, idu: String(f('id_usuario', p.id_usuario)).trim(),
    ucc: (patch.usa_config_cliente !== undefined ? (patch.usa_config_cliente ? 1 : 0) : (p.usa_config_cliente ? 1 : 0)),
    div: JSON.stringify(divisas), usuario: String(f('usuario', p.usuario)).trim(),
    montos: JSON.stringify(f('montosRapidos', p.montosRapidos)), notas: String(f('notas', p.notas)).trim(),
    cxid: f('conexion_id', p.conexion_id),
  });
  return get(id);
}
function remove(id) { return db.prepare('DELETE FROM paneles WHERE id=?').run(id).changes > 0; }

module.exports = { list, get, create, update, remove, NIVELES };
