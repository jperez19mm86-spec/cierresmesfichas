/**
 * valuacion.js — LOS PAGOS QUE ESPERAN EL TIPO DE CAMBIO DEL MES.
 *
 * ── EL PROBLEMA ──────────────────────────────────────────────────────────────────────────────
 * Un pago se guarda con las dos caras y su tipo de cambio: pesos, TC, dólares. Eso es correcto
 * cuando el TC se sabe, porque no es una cotización sino a cuánto se cambió ESA plata.
 *
 * Pero hay clientes que pagan en pesos durante todo el mes y el cambio recién se define al
 * cerrarlo. Con la regla anterior había dos salidas y las dos malas: inventar un TC en el momento
 * —y entonces el número guardado no es el real—, o no aprobar el pago hasta fin de mes, con el
 * cliente figurando como deudor de algo que ya pagó.
 *
 * ── LA SALIDA ────────────────────────────────────────────────────────────────────────────────
 * El pago se aprueba con la cara que SÍ se sabe (los pesos que entraron) y se marca
 * `tc_modo = 'mes'`: "esto se valúa con el tipo de cambio del mes".
 *
 * La otra cara NO se guarda: se DERIVA al leer. Por eso el día que se carga el TC del mes en
 * 🧾 Tipos de cambio, todos los pagos que estaban esperando pasan a valer lo que corresponde,
 * solos, sin tocar nada y sin ningún proceso que haya que acordarse de correr. Un número guardado
 * habría que salir a actualizarlo, y el que no se actualice queda mal para siempre.
 *
 * Mientras tanto se usa el promedio del mes hasta hoy y se marca `provisional: true`. Eso es un
 * dato incompleto y visible, que es lo que hay que mostrar; la alternativa —no contar el pago—
 * haría que el cliente aparezca debiendo plata que ya pagó, que es un error peor y más caro.
 */
const money = require('./lib/money');
const tcUnico = require('./tc-unico.service');

/** Sólo el TC cargado a mano en el cierre es el definitivo; el resto es un promedio provisorio. */
const ES_DEFINITIVO = 'cargado a mano en el cierre';

/**
 * Devuelve el movimiento con las dos caras completas cuando se puede.
 *
 * No muta el original: quien guarda y quien muestra tienen que poder mirar lo mismo sin que uno le
 * cambie el dato al otro. Los movimientos que no esperan nada vuelven tal cual.
 *
 * Agrega:
 *   · `tc_usado`     el TC con el que se valuó (null si no se pudo)
 *   · `provisional`  true si ese TC todavía puede cambiar
 *   · `sinValuar`    true si el mes no tiene NINGÚN tipo de cambio y el pago no se pudo pasar
 */
function valuar(m) {
  if (!m || m.tc_modo !== 'mes') return m;
  const tieneArs = m.monto_ars != null && String(m.monto_ars) !== '';
  const tieneUsdt = m.monto_usdt != null && String(m.monto_usdt) !== '';
  // Ya tiene las dos caras: no hay nada que derivar. Pasa cuando se le fijó el TC después.
  if (tieneArs && tieneUsdt) return m;
  if (!tieneArs && !tieneUsdt) return m;                    // no hay de dónde partir

  const mes = String(m.fecha || m.createdAt || '').slice(0, 7);
  const t = mes ? tcUnico.tcDelMes('ARS', mes) : null;
  if (!t || !t.valor || !money.isPos(String(t.valor))) {
    return { ...m, tc_usado: null, provisional: true, sinValuar: true };
  }
  const tc = String(t.valor);
  const provisional = t.fuente !== ES_DEFINITIVO;
  return {
    ...m,
    monto_ars: tieneArs ? m.monto_ars : money.round(money.mul(String(m.monto_usdt), tc), 2),
    monto_usdt: tieneUsdt ? m.monto_usdt : money.round(money.div(String(m.monto_ars), tc), 2),
    tc_usado: tc, tcFuente: t.fuente, provisional, sinValuar: false,
  };
}

const valuarLista = (movs) => (movs || []).map(valuar);

/** ¿Cuántos esperan el TC del mes y cuántos no se pudieron pasar? Para avisarlo en pantalla. */
function resumen(movs) {
  const v = valuarLista(movs);
  return {
    esperandoTC: v.filter((m) => m.tc_modo === 'mes' && m.provisional && !m.sinValuar).length,
    sinValuar: v.filter((m) => m.sinValuar).length,
  };
}

module.exports = { valuar, valuarLista, resumen, ES_DEFINITIVO };
