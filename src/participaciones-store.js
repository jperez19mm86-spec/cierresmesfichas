/**
 * participaciones-store.js — reparto del profit LATAM entre PERSONAS (sección 2.3).
 *
 * Scope: por CLIENTE (panel_id=null) o por PANEL (override). Regla de herencia: si el panel
 * no tiene reparto propio vigente → usa el del cliente.
 * Reglas duras: el reparto de un scope SIEMPRE debe sumar 100% antes de guardar.
 * Versionado: setReparto cierra el reparto vigente del scope e inserta el nuevo (vigencia).
 */
const crypto = require('crypto');
const { db } = require('./db');
const money = require('./lib/money');
const { fechaTZ, nowISO } = require('./lib/fechas');
const { diaAnterior, logCambio } = require('./historial');

const newId = () => 'part_' + crypto.randomBytes(5).toString('hex');

/** Reparto vigente de un scope en una fecha. panel_id=null = nivel cliente. */
function listVigente(cliente_id, panel_id = null, fecha = fechaTZ()) {
  return db.prepare(`
    SELECT * FROM participaciones
    WHERE cliente_id=? AND ${panel_id ? 'panel_id=?' : 'panel_id IS NULL'}
      AND vigente_desde <= ? AND (vigente_hasta IS NULL OR vigente_hasta >= ?)
    ORDER BY createdAt ASC
  `).all(...(panel_id ? [cliente_id, panel_id, fecha, fecha] : [cliente_id, fecha, fecha]));
}

/**
 * Reparto EFECTIVO de un panel (herencia): si el panel tiene reparto propio vigente lo usa;
 * si no, cae al del cliente. Devuelve { scope:'panel'|'cliente', items:[...] }.
 */
function repartoEfectivo(cliente_id, panel_id, fecha = fechaTZ()) {
  if (panel_id) {
    const propio = listVigente(cliente_id, panel_id, fecha);
    if (propio.length) return { scope: 'panel', items: propio };
  }
  return { scope: 'cliente', items: listVigente(cliente_id, null, fecha) };
}

/** Valida que una lista [{persona_id, porcentaje}] sume 100. */
function validarSuma(items) {
  const total = money.sum((items || []).map((i) => i.porcentaje));
  return { ok: money.cmp(total, '100') === 0, total };
}

/** Historial de repartos de un scope (todas las versiones). */
function listHistorial(cliente_id, panel_id = null) {
  return db.prepare(`
    SELECT * FROM participaciones
    WHERE cliente_id=? AND ${panel_id ? 'panel_id=?' : 'panel_id IS NULL'}
    ORDER BY vigente_desde ASC, createdAt ASC
  `).all(...(panel_id ? [cliente_id, panel_id] : [cliente_id]));
}

/**
 * Setea el reparto de un scope (cliente o panel) con VIGENCIA.
 * items: [{persona_id, porcentaje}]. Valida 100% o tira error.
 */
const setReparto = db.transaction((cliente_id, panel_id, items, vigente_desde, opts = {}) => {
  const v = validarSuma(items);
  if (!v.ok) throw new Error(`Las participaciones deben sumar 100% (suman ${v.total}%)`);
  const desde = vigente_desde || fechaTZ();
  // cerrar las vigentes del scope
  const vigentes = db.prepare(`
    SELECT id FROM participaciones
    WHERE cliente_id=? AND ${panel_id ? 'panel_id=?' : 'panel_id IS NULL'} AND vigente_hasta IS NULL
  `).all(...(panel_id ? [cliente_id, panel_id] : [cliente_id]));
  const hasta = diaAnterior(desde);
  vigentes.forEach((r) => db.prepare('UPDATE participaciones SET vigente_hasta=? WHERE id=?').run(hasta, r.id));
  // insertar las nuevas
  const ins = db.prepare(`INSERT INTO participaciones
    (id,cliente_id,panel_id,persona_id,porcentaje,vigente_desde,vigente_hasta,createdAt)
    VALUES (?,?,?,?,?,?,NULL,?)`);
  items.forEach((it) => ins.run(newId(), cliente_id, panel_id || null, it.persona_id, money.round(it.porcentaje, 4), desde, nowISO()));
  logCambio({
    entidad_tipo: 'participacion', entidad_id: panel_id || cliente_id, campo: 'reparto',
    valor_anterior: JSON.stringify(vigentes.map((x) => x.id)), valor_nuevo: JSON.stringify(items),
    tipo_cambio: 'vigencia', vigente_desde: desde, usuario_id: opts.usuario_id, notas: opts.notas,
  });
  return repartoEfectivo(cliente_id, panel_id, desde);
});

module.exports = { listVigente, repartoEfectivo, validarSuma, listHistorial, setReparto };
