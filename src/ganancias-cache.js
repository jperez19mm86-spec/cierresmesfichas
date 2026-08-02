/**
 * ganancias-cache.js — guarda las ganancias por proveedor que devuelve el casino.
 *
 * POR QUÉ: el reporte de §9 le pregunta al casino panel por panel y divisa por divisa. Con 5-6
 * paneles eso son 50-120 segundos, y cuando el casino está lento se pasa del timeout y el reporte
 * no sale — no se puede ni verificar un número. Además se le vuelve a pedir lo MISMO en cada
 * corrida, aunque sea un mes ya cerrado que no puede cambiar.
 *
 * REGLA DE FRESCURA:
 *   · mes YA TERMINADO  → la ganancia es definitiva: el caché vale para siempre.
 *   · mes EN CURSO      → sigue moviéndose: el caché vale por un rato corto (VIGENCIA_MIN).
 *   · `refrescar` fuerza ir al casino igual.
 */
const { db } = require('./db');

const VIGENCIA_MIN = 30;          // minutos, sólo para el mes en curso

/** ¿El mes ya terminó? (comparado con el mes actual) */
function mesCerrado(mes) {
  return String(mes) < new Date().toISOString().slice(0, 7);
}

function get(conexion_id, nodo, mes, divisa, { refrescar = false } = {}) {
  if (refrescar) return null;
  const r = db.prepare(`SELECT datos, capturedAt FROM ganancias_cache
    WHERE conexion_id=? AND nodo=? AND mes=? AND divisa=?`).get(String(conexion_id), String(nodo), String(mes), String(divisa));
  if (!r) return null;
  if (!mesCerrado(mes)) {
    const edadMin = (Date.now() - new Date(r.capturedAt).getTime()) / 60000;
    if (!(edadMin < VIGENCIA_MIN)) return null;   // del mes en curso y ya viejo
  }
  try { return { filas: JSON.parse(r.datos), capturedAt: r.capturedAt }; } catch (e) { return null; }
}

function set(conexion_id, nodo, mes, divisa, filas) {
  db.prepare(`INSERT INTO ganancias_cache (conexion_id,nodo,mes,divisa,datos,capturedAt) VALUES (?,?,?,?,?,?)
    ON CONFLICT(conexion_id,nodo,mes,divisa) DO UPDATE SET datos=excluded.datos, capturedAt=excluded.capturedAt`)
    .run(String(conexion_id), String(nodo), String(mes), String(divisa), JSON.stringify(filas || []), new Date().toISOString());
}

/** Cuántas entradas hay y de qué meses (para mostrarlo y poder limpiarlo). */
function resumen() {
  return db.prepare(`SELECT mes, COUNT(*) n, MIN(capturedAt) desde, MAX(capturedAt) hasta
    FROM ganancias_cache GROUP BY mes ORDER BY mes DESC`).all();
}
function limpiar(mes) {
  const n = mes ? db.prepare('DELETE FROM ganancias_cache WHERE mes=?').run(String(mes)).changes
    : db.prepare('DELETE FROM ganancias_cache').run().changes;
  return { borradas: n };
}

module.exports = { get, set, resumen, limpiar, mesCerrado, VIGENCIA_MIN };
