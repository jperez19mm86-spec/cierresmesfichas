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
const { mesDe } = require('./lib/mes-de');

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
function valuar(m, memo) {
  if (!m) return m;
  if (m.tc_modo !== 'mes') return conCaraDeReferencia(m, memo);
  if (m.tipo !== 'pago') return valuarCarga(m, memo);
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
     La regla vive en lib/mes-de.js, que no depende de nadie: así la usan este módulo y
     movimientos-store sin requerirse entre ellos. */
  const mes = mesDe(m);
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
 * ── LA CARA EN PESOS DE UN PAGO EN DÓLARES (26-oct-2026) ───────────────────────────────────────
 * Un pago en USDT guarda su cara en pesos SÓLO si quien aprueba escribió el tipo de cambio a mano
 * (ver `comprobantes/:id/resolver`: `if (tc) enArs = ...`). Si lo dejó vacío —que es lo que el
 * código prefiere antes que inventar un número— `monto_ars` queda null para siempre, porque la
 * derivación de arriba sólo corre con `tc_modo='mes'`, y un pago en la moneda de la cuenta no lo
 * lleva.
 *
 * El resultado se veía en Mi Caja: a NahuelGanamosD le decía que debía ARS 2.110.000 cuando debía
 * 1.722.000, porque su pago de USDT 237,84 no restaba del lado de los pesos. Y el cliente lee en
 * pesos: es su referencia.
 *
 * ⚠️ POR QUÉ NO SE ESCRIBE EN `monto_ars`. Esa columna la leen veinte lugares, y varios son
 * contabilidad: `pesos-cancelan-pesos` decide con ella si un pago SALDA LA FILA DE PESOS —y eso sí
 * movería la deuda en dólares y meses ya cerrados—, el aviso de Telegram elige con ella en qué
 * moneda rotular, y el cambio de moneda de cuenta la usa para reconvertir. Escribirla cambiaría
 * todos esos caminos de una vez.
 *
 * Por eso va en un campo APARTE, `ars_referencia`, que sólo mira lo que se le muestra al cliente en
 * pesos. `monto_ars` queda exactamente como estaba: ningún lector existente ve nada distinto, así
 * que ningún número del pasado se puede mover. Es una referencia, no un segundo saldo.
 */
function conCaraDeReferencia(m, memo) {
  if (m.tipo !== 'pago') return m;
  const tieneArs = m.monto_ars != null && String(m.monto_ars) !== '';
  const tieneUsdt = m.monto_usdt != null && String(m.monto_usdt) !== '';
  // Sólo al que le FALTA la cara en pesos y tiene de dónde sacarla.
  if (tieneArs || !tieneUsdt) return m;
  const mes = mesDe(m);
  /* ⚠️ EL PROMEDIO, NO EL DEL TRADER. `tcPagosDelMes` devuelve el cargado a mano en el cierre, que
     es el del trader — y ese número es NUESTRO: este archivo dice arriba que lo que dio el trader
     no viaja al cliente. Además la regla del sistema es «trader sólo para pagos, promedio para
     cuentas», y esto es una lectura de la cuenta, no la valuación de un pago. `tcDelMes` da el
     promedio de Binance/criptoya del mes, que es mercado público. */
  /* Un TC por MES, no uno por movimiento. Leer la cuenta entera de un cliente con 400 pagos en
     dólares hacía 400 consultas a la base: 1,6 ms pasaban a 53. El memo lo arma `valuarLista` y
     vive sólo lo que dura esa lectura, así que cargar el TC del cierre se ve en la siguiente. */
  const k = mes ? 'ARS|' + mes : null;
  let t;
  if (memo && k && memo.has(k)) t = memo.get(k);
  else { t = mes ? tcUnico.tcDelMes('ARS', mes) : null; if (memo && k) memo.set(k, t); }
  if (!t || !t.valor || !money.isPos(String(t.valor))) return m;
  const tc = String(t.valor);
  return {
    ...m,
    ars_referencia: money.round(money.mul(String(m.monto_usdt), tc), 2),
    ars_referencia_tc: tc,
    // El promedio de un mes que todavía no terminó se mueve todos los días (igual que valuarCarga).
    ars_referencia_provisional: mes >= mesTZ(),
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
function valuarCarga(m, memo) {
  const D = String(m.divisa || 'ARS').toUpperCase();
  const local = D === 'ARS' ? m.monto_ars : m.monto_local;
  const tieneUsdt = m.monto_usdt != null && String(m.monto_usdt) !== '';
  if (tieneUsdt || local == null || String(local) === '') return m;
  const mes = mesDe(m);
  /* Un TC por moneda y mes, igual que conCaraDeReferencia: abrir la lista de clientes buscaba el
     promedio una vez por CARGA (542 de 1.038 movimientos el 29-oct) y se llevaba ~0,3 s. */
  const k = mes ? D + '|' + mes : null;
  let t;
  if (memo && k && memo.has(k)) t = memo.get(k);
  else { t = mes ? tcUnico.tcDelMes(D, mes) : null; if (memo && k) memo.set(k, t); }
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

const valuarLista = (movs) => {
  // El memo dura lo que dura esta lista: ver `conCaraDeReferencia`.
  const memo = new Map();
  return (movs || []).map((m) => valuar(m, memo));
};

/** ¿Cuántos esperan el TC del mes y cuántos no se pudieron pasar? Para avisarlo en pantalla. */
function resumen(movs) {
  const v = valuarLista(movs);
  return {
    esperandoTC: v.filter((m) => m.tc_modo === 'mes' && m.provisional && !m.sinValuar).length,
    sinValuar: v.filter((m) => m.sinValuar).length,
  };
}

module.exports = { valuar, valuarLista, resumen, conCaraDeReferencia, ES_DEFINITIVO };
