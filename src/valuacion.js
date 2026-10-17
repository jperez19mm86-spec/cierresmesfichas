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
const { mesTZ } = require('./lib/fechas');

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
  if (m.tipo !== 'pago') return valuarCarga(m);
  const tieneArs = m.monto_ars != null && String(m.monto_ars) !== '';
  const tieneUsdt = m.monto_usdt != null && String(m.monto_usdt) !== '';
  // Ya tiene las dos caras: no hay nada que derivar. Pasa cuando se le fijó el TC después.
  if (tieneArs && tieneUsdt) return m;
  if (!tieneArs && !tieneUsdt) return m;                    // no hay de dónde partir

  /* ⚠️ EL MES DE CIERRE, NO EL DE LA FECHA. Un pago del 3 de septiembre puede estar asignado al
     cierre de AGOSTO, y entonces tiene que valuarse con el TC de agosto — que ya está cerrado y no
     se mueve. Con el de la fecha pasaban dos cosas, las dos malas: dos pagos idénticos de 130.000
     al mismo cierre daban distinto (82,04 y 81,91), y el de septiembre seguía CAMBIANDO todos los
     días con el promedio del mes en curso, así que el cierre de agosto nunca terminaba de cuajar.
     La regla es la misma que `movimientos-store.mesDe`; se repite acá porque ese módulo importa a
     éste y no puede haber ida y vuelta. */
  const mes = m.mes_cierre
    ? String(m.mes_cierre).slice(0, 7)
    : String(m.fecha || m.createdAt || '').slice(0, 7);
  // Un PAGO en pesos se vale al cambio del trader de ese mes (el cargado a mano), no al promedio.
  const t = mes ? tcUnico.tcPagosDelMes('ARS', mes) : null;
  // `derivada` dice CUÁL de las dos caras salió de un tipo de cambio. Sin ese dato no se puede
  // avisar bien: un pago en dólares sobre una cuenta en dólares deriva la cara en pesos, que nadie
  // suma, y marcarlo como provisorio decía "este pago no entra en el saldo" sobre un pago
  // íntegramente contado — que es una invitación a acreditarlo dos veces.
  const derivada = tieneArs ? 'monto_usdt' : 'monto_ars';
  if (!t || !t.valor || !money.isPos(String(t.valor))) {
    return { ...m, tc_usado: null, derivada, provisional: true, sinValuar: true };
  }
  const tc = String(t.valor);
  // En pesos la fuente dice «… (trader)»: lo que cuenta es que sea el cargado a mano.
  const provisional = !String(t.fuente || '').startsWith(ES_DEFINITIVO);
  return {
    ...m,
    monto_ars: tieneArs ? m.monto_ars : money.round(money.mul(String(m.monto_usdt), tc), 2),
    monto_usdt: tieneUsdt ? m.monto_usdt : money.round(money.div(String(m.monto_ars), tc), 2),
    tc_usado: tc, tcFuente: t.fuente, derivada, provisional, sinValuar: false,
  };
}

/**
 * ── LAS CARGAS DE QUIEN RECIBE LA CUENTA A FIN DE MES (18-oct-2026) ─────────────────────────────
 * Regla del dueño: al cliente que se le manda la cuenta al cierre, sus cargas valen con el PROMEDIO
 * del mes de su moneda —el mismo de la factura—, no con el cambio del momento. Se guarda la deuda en
 * la moneda de la carga (`monto_ars` si es el peso, `monto_local` si es otra) y la cara en dólares se
 * deriva acá, con `tcDelMes` (el de las cuentas, no el del trader). Mientras el mes está abierto el
 * promedio se mueve: queda `provisional`. Lo mismo vale para lo que acompaña a esa carga y copia su
 * modo: el abono a otro cliente, la anulación y la baja del abono.
 */
function valuarCarga(m) {
  const D = String(m.divisa || 'ARS').toUpperCase();
  const local = D === 'ARS' ? m.monto_ars : m.monto_local;
  const tieneUsdt = m.monto_usdt != null && String(m.monto_usdt) !== '';
  if (tieneUsdt || local == null || String(local) === '') return m;
  const mes = m.mes_cierre ? String(m.mes_cierre).slice(0, 7) : String(m.fecha || m.createdAt || '').slice(0, 7);
  const t = mes ? tcUnico.tcDelMes(D, mes) : null;
  if (!t || !t.valor || !money.isPos(String(t.valor))) {
    return { ...m, tc_usado: null, derivada: 'monto_usdt', provisional: true, sinValuar: true };
  }
  const tc = String(t.valor);
  return {
    ...m,
    monto_usdt: money.round(money.div(String(local), tc), 2),
    tc_usado: tc, tcFuente: t.fuente, derivada: 'monto_usdt',
    // El promedio de un mes que todavía no terminó cambia todos los días.
    provisional: mes >= mesTZ(), sinValuar: false,
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
