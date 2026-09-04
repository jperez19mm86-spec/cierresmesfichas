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
    // NULL = sí: un panel que ya existía antes de que esto se pudiera elegir sigue entrando.
    en_foto: r.en_foto === null || r.en_foto === undefined ? true : !!r.en_foto,
    alias: parseJson(r.alias, []),
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
  const alias = normAlias(d.alias);
  db.prepare(`INSERT INTO paneles
      (id,cliente_id,nombre,sistema,tipo,nivel_usuario,id_usuario,usa_config_cliente,divisas,alias,usuario,montosRapidos,notas,conexion_id,createdAt,ord)
      VALUES (@id,@cli,@nombre,@sistema,@tipo,@nivel,@idu,@ucc,@div,@alias,@usuario,@montos,@notas,@cxid,@ca,@ord)`).run({
    id, cli: d.cliente_id || null, nombre: String(d.nombre || '').trim(), sistema: d.sistema || '',
    tipo: d.tipo || 'exclusivo', nivel, idu: String(d.id_usuario || '').trim(),
    ucc: d.usa_config_cliente === false ? 0 : 1, div: JSON.stringify(divisas), alias: JSON.stringify(alias),
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
  const enFoto = patch.en_foto !== undefined ? (patch.en_foto ? 1 : 0) : (p.en_foto ? 1 : 0);
  const alias = patch.alias !== undefined ? normAlias(patch.alias) : (p.alias || []);
  db.prepare(`UPDATE paneles SET cliente_id=@cli,nombre=@nombre,sistema=@sistema,tipo=@tipo,nivel_usuario=@nivel,
      id_usuario=@idu,usa_config_cliente=@ucc,divisas=@div,alias=@alias,usuario=@usuario,montosRapidos=@montos,notas=@notas,conexion_id=@cxid,en_foto=@enfoto,consumo_a=@consumoA WHERE id=@id`).run({
    id, cli: f('cliente_id', p.cliente_id), nombre: String(f('nombre', p.nombre)).trim(), sistema: f('sistema', p.sistema),
    // sólo 'dueno' y 'ninguno' se guardan: cualquier otra cosa vuelve al default, que es el código
    consumoA: ['dueno', 'ninguno'].includes(f('consumo_a', p.consumo_a)) ? f('consumo_a', p.consumo_a) : null,
    tipo: f('tipo', p.tipo), nivel, idu: String(f('id_usuario', p.id_usuario)).trim(),
    ucc: (patch.usa_config_cliente !== undefined ? (patch.usa_config_cliente ? 1 : 0) : (p.usa_config_cliente ? 1 : 0)),
    enfoto: enFoto,
    div: JSON.stringify(divisas), alias: JSON.stringify(alias), usuario: String(f('usuario', p.usuario)).trim(),
    montos: JSON.stringify(f('montosRapidos', p.montosRapidos)), notas: String(f('notas', p.notas)).trim(),
    cxid: f('conexion_id', p.conexion_id),
  });
  return get(id);
}
function remove(id) { return db.prepare('DELETE FROM paneles WHERE id=?').run(id).changes > 0; }

/**
 * ── ¿LAS DIVISAS DE CADA PANEL SON LAS QUE DE VERDAD USA? ────────────────────────────────────
 *
 * Lo que se guarda en `divisas` viene del casino, pero es lo que la cuenta tiene HABILITADO, no
 * lo que mueve. RMIara-D figura con ARS, AUD, CLP, COP, DOP, EUR, MXN, PEN… y opera solo en
 * pesos. No es cosmético: esa lista es la que dispara el aviso de "moneda sin tipo de cambio",
 * así que media pantalla de alertas es por monedas que nadie usó nunca.
 *
 * Acá se compara contra el ACUMULADO ya guardado —lo que el cron baja todas las noches— así que
 * no consulta el casino ni tarda. Solo informa; cambiar el dato es una decisión de quien mira.
 *
 * @param meses  cuántos meses hacia atrás mirar (default 6)
 * @returns [{ panel_id, nombre, cliente_id, guardadas[], usadas[], sobran[], faltan[], meses }]
 */
/** Los alias, limpios y sin repetidos. Acepta CSV o array. */
function normAlias(v) {
  const arr = Array.isArray(v) ? v : String(v || '').split(/[,\n]+/);
  return [...new Set(arr.map((x) => String(x || '').trim()).filter(Boolean))];
}

/** El panel que responde a ese nombre, mirando el nombre real Y sus alias. */
function porNombre(nombre) {
  const k = String(nombre || '').trim().toLowerCase();
  if (!k) return null;
  return list().find((p) => String(p.nombre || '').trim().toLowerCase() === k
    || (p.alias || []).some((a) => String(a).trim().toLowerCase() === k)) || null;
}

function divisasUsadas(meses = 6) {
  const rd = require('./reporte-diario-store');
  const hoy = new Date();
  const lista = [];
  for (let i = 0; i < Math.max(1, meses); i++) {
    const d = new Date(Date.UTC(hoy.getUTCFullYear(), hoy.getUTCMonth() - i, 1));
    lista.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
  }
  const paneles = list().filter((p) => p.conexion_id && p.id_usuario);
  const keys = paneles.map((p) => ({ conexion_id: p.conexion_id, grp: 'superagent', sa_id: String(p.id_usuario) }));
  const usadasDe = {};
  for (const mes of lista) {
    for (const f of rd.filasPanelesMes(keys, mes)) {
      // Una moneda "se usa" si tuvo movimiento de verdad; una fila en cero no la habilita.
      const hay = Number(f.in_amt || 0) || Number(f.out_amt || 0) || Number(f.profit || 0);
      if (!hay) continue;
      const k = `${f.conexion_id}|${f.sa_id}`;
      (usadasDe[k] = usadasDe[k] || new Set()).add(String(f.moneda || '').toUpperCase());
    }
  }
  return paneles.map((p) => {
    const usadas = [...(usadasDe[`${p.conexion_id}|${p.id_usuario}`] || [])].sort();
    const guardadas = (p.divisas || []).map((x) => String(x).toUpperCase());
    return {
      panel_id: p.id, nombre: p.nombre, cliente_id: p.cliente_id, id_usuario: p.id_usuario,
      guardadas, usadas,
      sobran: guardadas.filter((d) => !usadas.includes(d)),
      faltan: usadas.filter((d) => !guardadas.includes(d)),
      sinDatos: !usadas.length,
      meses: lista,
    };
  });
}

module.exports = {
  divisasUsadas, porNombre, normAlias, list, get, create, update, remove, setJerarquia, NIVELES };
