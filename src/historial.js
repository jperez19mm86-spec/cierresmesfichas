/**
 * historial.js — MOTOR DE VIGENCIAS + AUDITORÍA (sección 5 del doc: "Historial y Vigencias — CRÍTICO").
 *
 * Dos tablas:
 *  - config_valores: valores escalares VERSIONADOS por entidad (precio_base_pct, mezcla_pago_usdt, ...).
 *      Cada cambio "vigencia" cierra la fila vigente (vigente_hasta) e inserta una nueva.
 *  - historial_config: auditoría universal (quién, cuándo, valor anterior→nuevo, corrección|vigencia).
 *      La usan también participaciones / proveedores / split_base para dejar rastro.
 *
 * Dos tipos de cambio:
 *  - VIGENCIA  ("desde el 1/6 pasa a X")  → cierra la actual + inserta nueva. Histórico intacto.
 *  - CORRECCIÓN ("siempre fue X, me equivoqué") → corrige la fila vigente EN SU LUGAR (retroactivo).
 *
 * getVigente(...) devuelve el valor que regía en una FECHA dada → los reportes históricos
 * se recalculan con el valor de esa fecha, nunca con el actual.
 */
const crypto = require('crypto');
const { db } = require('./db');
const { fechaTZ, nowISO } = require('./lib/fechas');

const newId = (p) => p + '_' + crypto.randomBytes(6).toString('hex');

/** YYYY-MM-DD del día anterior a `fecha`. */
function diaAnterior(fecha) {
  const d = new Date(fecha + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

// ─────────── config_valores (escalares versionados) ───────────

/** Valor vigente en una fecha (default hoy). null si no hay. */
function getVigente(entidad_tipo, entidad_id, campo, fecha = fechaTZ()) {
  const r = db.prepare(`
    SELECT valor FROM config_valores
    WHERE entidad_tipo=? AND entidad_id=? AND campo=?
      AND vigente_desde <= ?
      AND (vigente_hasta IS NULL OR vigente_hasta >= ?)
    ORDER BY vigente_desde DESC LIMIT 1
  `).get(entidad_tipo, entidad_id, campo, fecha, fecha);
  return r ? r.valor : null;
}

/** Fila vigente "hoy" (vigente_hasta NULL). */
function getFilaActual(entidad_tipo, entidad_id, campo) {
  return db.prepare(`
    SELECT * FROM config_valores
    WHERE entidad_tipo=? AND entidad_id=? AND campo=? AND vigente_hasta IS NULL
    ORDER BY vigente_desde DESC LIMIT 1
  `).get(entidad_tipo, entidad_id, campo) || null;
}

/** Todas las versiones de un campo (para mostrar la línea de tiempo). */
function listValores(entidad_tipo, entidad_id, campo) {
  return db.prepare(`
    SELECT * FROM config_valores
    WHERE entidad_tipo=? AND entidad_id=? AND campo=?
    ORDER BY vigente_desde ASC
  `).all(entidad_tipo, entidad_id, campo);
}

/** Escribe una fila de auditoría. */
function logCambio({ entidad_tipo, entidad_id, campo, valor_anterior, valor_nuevo, tipo_cambio, vigente_desde = null, usuario_id = null, notas = null }) {
  db.prepare(`
    INSERT INTO historial_config
      (id, entidad_tipo, entidad_id, campo, valor_anterior, valor_nuevo, tipo_cambio, vigente_desde, fecha_registro, usuario_id, notas)
    VALUES (@id,@et,@eid,@campo,@va,@vn,@tc,@vd,@fr,@uid,@notas)
  `).run({
    id: newId('h'), et: entidad_tipo, eid: entidad_id, campo,
    va: valor_anterior == null ? null : String(valor_anterior),
    vn: valor_nuevo == null ? null : String(valor_nuevo),
    tc: tipo_cambio, vd: vigente_desde, fr: nowISO(), uid: usuario_id, notas,
  });
}

/**
 * VIGENCIA: cierra la fila vigente (vigente_hasta = día anterior a `vigente_desde`) e inserta la nueva.
 */
const setVigencia = db.transaction((entidad_tipo, entidad_id, campo, valor, vigente_desde, opts = {}) => {
  const actual = getFilaActual(entidad_tipo, entidad_id, campo);
  if (actual) {
    db.prepare('UPDATE config_valores SET vigente_hasta=? WHERE id=?').run(diaAnterior(vigente_desde), actual.id);
  }
  db.prepare(`
    INSERT INTO config_valores (id, entidad_tipo, entidad_id, campo, valor, vigente_desde, vigente_hasta, createdAt)
    VALUES (@id,@et,@eid,@campo,@valor,@vd,NULL,@ca)
  `).run({ id: newId('cv'), et: entidad_tipo, eid: entidad_id, campo, valor: String(valor), vd: vigente_desde, ca: nowISO() });
  logCambio({ entidad_tipo, entidad_id, campo, valor_anterior: actual ? actual.valor : null, valor_nuevo: valor, tipo_cambio: 'vigencia', vigente_desde, usuario_id: opts.usuario_id, notas: opts.notas });
});

/**
 * CORRECCIÓN: corrige la fila vigente EN SU LUGAR (retroactivo). Si no existe, crea una desde "época".
 */
const setCorreccion = db.transaction((entidad_tipo, entidad_id, campo, valor, opts = {}) => {
  const actual = getFilaActual(entidad_tipo, entidad_id, campo);
  if (actual) {
    db.prepare('UPDATE config_valores SET valor=? WHERE id=?').run(String(valor), actual.id);
    logCambio({ entidad_tipo, entidad_id, campo, valor_anterior: actual.valor, valor_nuevo: valor, tipo_cambio: 'correccion', usuario_id: opts.usuario_id, notas: opts.notas });
  } else {
    setVigencia(entidad_tipo, entidad_id, campo, valor, opts.vigente_desde || '2020-01-01', { usuario_id: opts.usuario_id, notas: opts.notas });
  }
});

/**
 * Setter genérico de UI: el front siempre manda { tipo_cambio, valor, vigente_desde? }.
 */
function setValor(entidad_tipo, entidad_id, campo, { valor, tipo_cambio, vigente_desde, usuario_id, notas }) {
  if (tipo_cambio === 'vigencia') {
    if (!vigente_desde) throw new Error('vigencia requiere vigente_desde');
    setVigencia(entidad_tipo, entidad_id, campo, valor, vigente_desde, { usuario_id, notas });
  } else {
    setCorreccion(entidad_tipo, entidad_id, campo, valor, { usuario_id, notas, vigente_desde });
  }
  return getVigente(entidad_tipo, entidad_id, campo);
}

/** Auditoría filtrable. */
function listHistorial({ entidad_tipo, entidad_id, campo } = {}) {
  const w = [], p = [];
  if (entidad_tipo) { w.push('entidad_tipo=?'); p.push(entidad_tipo); }
  if (entidad_id) { w.push('entidad_id=?'); p.push(entidad_id); }
  if (campo) { w.push('campo=?'); p.push(campo); }
  const sql = 'SELECT * FROM historial_config' + (w.length ? ' WHERE ' + w.join(' AND ') : '') + ' ORDER BY fecha_registro DESC';
  return db.prepare(sql).all(...p);
}

module.exports = {
  newId, diaAnterior,
  getVigente, getFilaActual, listValores,
  setVigencia, setCorreccion, setValor,
  logCambio, listHistorial,
};
