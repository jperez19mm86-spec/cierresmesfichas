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
 * VIGENCIA: inserta un tramo nuevo que arranca en `vigente_desde`.
 *
 * OJO con el orden. Antes esto cerraba "la fila abierta" a secas, y cargar un valor con fecha
 * ANTERIOR a uno que ya existía dejaba la vieja con vigente_hasta < vigente_desde: un tramo dado
 * vuelta, que después no lo levanta nadie. Le pasó a la base de Crazy-duck (agosto quedó
 * "desde 2026-08-01 hasta 2026-06-30"). La línea de tiempo se arma mirando a los dos lados:
 *   · el tramo que arranca EL MISMO día no es un tramo nuevo, es el mismo: se le pisa el valor
 *   · el de ANTES se cierra el día anterior
 *   · el de DESPUÉS no se toca (es un cambio futuro legítimo) y le pone el techo al nuevo
 */
const setVigencia = db.transaction((entidad_tipo, entidad_id, campo, valor, vigente_desde, opts = {}) => {
  const arg = [entidad_tipo, entidad_id, campo];
  const q = (cond, ord) => db.prepare(
    `SELECT * FROM config_valores WHERE entidad_tipo=? AND entidad_id=? AND campo=? AND ${cond}
     ORDER BY vigente_desde ${ord} LIMIT 1`);
  const misma = q('vigente_desde = ?', 'DESC').get(...arg, vigente_desde);
  const previa = q('vigente_desde < ?', 'DESC').get(...arg, vigente_desde);
  const siguiente = q('vigente_desde > ?', 'ASC').get(...arg, vigente_desde);
  const anterior = (misma || previa || null);
  const techo = siguiente ? diaAnterior(siguiente.vigente_desde) : null;

  if (previa) db.prepare('UPDATE config_valores SET vigente_hasta=? WHERE id=?').run(diaAnterior(vigente_desde), previa.id);
  if (misma) {
    db.prepare('UPDATE config_valores SET valor=?, vigente_hasta=? WHERE id=?').run(String(valor), techo, misma.id);
  } else {
    db.prepare(`
      INSERT INTO config_valores (id, entidad_tipo, entidad_id, campo, valor, vigente_desde, vigente_hasta, createdAt)
      VALUES (@id,@et,@eid,@campo,@valor,@vd,@vh,@ca)
    `).run({ id: newId('cv'), et: entidad_tipo, eid: entidad_id, campo, valor: String(valor), vd: vigente_desde, vh: techo, ca: nowISO() });
  }
  logCambio({ entidad_tipo, entidad_id, campo, valor_anterior: anterior ? anterior.valor : null, valor_nuevo: valor, tipo_cambio: 'vigencia', vigente_desde, usuario_id: opts.usuario_id, notas: opts.notas });
});

/**
 * Endereza los tramos que quedaron dados vuelta por el bug de arriba.
 * Corre una sola vez al levantar: es barato y deja la línea de tiempo consistente.
 */
function repararTramosDadosVuelta() {
  const malas = db.prepare(`SELECT * FROM config_valores
    WHERE vigente_hasta IS NOT NULL AND vigente_hasta < vigente_desde`).all();
  malas.forEach((f) => {
    const sig = db.prepare(`SELECT vigente_desde FROM config_valores
      WHERE entidad_tipo=? AND entidad_id=? AND campo=? AND vigente_desde > ?
      ORDER BY vigente_desde ASC LIMIT 1`).get(f.entidad_tipo, f.entidad_id, f.campo, f.vigente_desde);
    db.prepare('UPDATE config_valores SET vigente_hasta=? WHERE id=?')
      .run(sig ? diaAnterior(sig.vigente_desde) : null, f.id);
  });
  return malas.length;
}

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
function setValor(entidad_tipo, entidad_id, campo, opciones) {
  // El 4to argumento es un OBJETO. Pasarle el valor suelto dejaba todo en undefined y, peor, caía
  // en la rama de CORRECCIÓN: pisaba el valor vigente hacia atrás con 'undefined'.
  if (!opciones || typeof opciones !== 'object') throw new Error('setValor: el 4to argumento tiene que ser { valor, tipo_cambio, vigente_desde }');
  const { valor, tipo_cambio, vigente_desde, usuario_id, notas } = opciones;
  if (valor === undefined || valor === null || valor === '') throw new Error(`setValor: valor vacío para ${campo}`);
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
  repararTramosDadosVuelta,
};
