/**
 * mes-de.js — A QUÉ MES ENTRA UN MOVIMIENTO. La regla, escrita una sola vez.
 *
 * El mes de cierre si lo tiene: un pago del 3 de septiembre asignado al cierre de agosto es de
 * agosto, y se vale con el cambio de agosto. Si no, el de su fecha; si no tiene fecha, el de cuándo
 * se anotó. Sin dependencias a propósito: la usan movimientos-store y valuacion, que se requieren
 * entre ellos, y antes por eso cada uno tenía su copia.
 */
function mesDe(m) {
  if (m && m.mes_cierre) return String(m.mes_cierre).slice(0, 7);
  return String((m && (m.fecha || m.createdAt)) || '').slice(0, 7);
}

/** La misma regla en SQL, sobre la tabla movimientos (para filtrar por mes sin traer todo). */
const MES_SQL = "COALESCE(NULLIF(substr(mes_cierre,1,7),''), substr(COALESCE(fecha,createdAt),1,7))";

module.exports = { mesDe, MES_SQL };
