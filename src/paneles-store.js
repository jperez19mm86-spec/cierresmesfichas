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
    escala: parseJson(r.escala, []),
  };
}

/**
 * Guarda la jerarquía que resolvió arbol.service.js contra el casino.
 * Es un UPDATE acotado a propósito: NO pasa por update(), que reescribe todas las columnas y
 * pisaría divisas/montos/notas con lo que tenga en memoria quien lo llame.
 */
function setJerarquia(id, { nivel, padre, superagente, escala }) {
  const p = get(id); if (!p) return null;
  db.prepare(`UPDATE paneles SET nivel_usuario=@nivel, padre_id=@pid, padre_login=@plogin,
      padre_nivel=@pnivel, sa_id=@said, sa_login=@salogin, escala=@escala, arbol_at=@at WHERE id=@id`).run({
    id,
    nivel: NIVELES.includes(nivel) ? nivel : p.nivel_usuario,
    pid: padre ? String(padre.id) : null,
    plogin: padre ? String(padre.login || '') : null,
    pnivel: padre ? String(padre.nivel || '') : null,
    said: superagente ? String(superagente.id) : null,
    salogin: superagente ? String(superagente.login || '') : null,
    escala: JSON.stringify(escala || []),
    at: new Date().toISOString(),
  });
  return get(id);
}
// Guard de formato: un código de divisa son 3-4 letras (ARS, USDT). El split de abajo parte también
// por ESPACIO, así que una celda mal tipeada como "AR,S BRL" o "PEN. PYG" generaría tokens basura
// ('AR', 'S', 'PEN.') que después aparecen en el catálogo y en los selectores. Se descartan.
const ES_DIVISA = /^[A-Z]{3,4}$/;
function normDivisas(v) {
  const arr = Array.isArray(v) ? v : String(v || '').split(/[,;\s]+/);
  return arr.map((s) => String(s).trim().toUpperCase()).filter((s) => ES_DIVISA.test(s));
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
  // Las divisas habilitadas las define el panel REAL del proveedor, no su nivel: hay Distribuidores
  // con 17 monedas. Antes se recortaba a la primera si el nivel no era SuperAgente, lo que borraba
  // en silencio el resto (y se volvía a disparar al linkear la conexión, que hace un update).
  const divisas = normDivisas(d.divisas);
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
  // Igual que en create(): NO recortar por nivel. Clave acá porque linkPanel() hace un update
  // con solo {conexion_id, id_usuario} y el recorte borraba las divisas ya cargadas.
  const divisas = patch.divisas !== undefined ? normDivisas(patch.divisas) : p.divisas;
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

module.exports = { list, get, create, update, remove, setJerarquia, NIVELES };
