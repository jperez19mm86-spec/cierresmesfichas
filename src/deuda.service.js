/**
 * deuda.service.js — CUENTA CORRIENTE por cliente (sección 4.3).
 * No hay tabla de saldo: la deuda se DERIVA de los movimientos (en USDT), separada en:
 *   - fichas pendientes   (fees de cargas + ajustes − bonificaciones)
 *   - proveedores ext.    (diferenciales de proveedores externos)
 *   menos los pagos.
 *
 * Convención: cada movimiento guarda monto_usdt = el impacto en deuda EN USDT
 * (carga = fee en USDT; proveedor_extra = diferencial en USDT; pago = monto pagado en USDT).
 */
const mov = require('./movimientos-store');
const money = require('./lib/money');
const clientes = require('./clientes-store');

/**
 * ── LA CUENTA SE LLEVA EN LA MONEDA DEL CLIENTE ───────────────────────────────────────────────
 *
 * Casi todos están en USDT y esa sigue siendo la regla por defecto. Pero hay clientes con los que
 * se acuerda en pesos: pagan en dólares y lo que se lleva es el equivalente en pesos que se
 * declara al acreditar.
 *
 * Devuelve la MONEDA junto con los números, y eso no es decorativo: es lo único que impide que
 * alguien imprima "USDT" arriba de una cifra en pesos. Un total con la etiqueta equivocada es
 * peor que un error de cálculo, porque cuadra.
 *
 * Y suma UNA sola columna: la de su moneda. Nunca las dos. Si un movimiento quedó cargado en la
 * otra, no se convierte ni se ignora en silencio — se cuenta aparte en `enOtraMoneda` para que se
 * vea que hay algo mal en vez de que el total mienta.
 */
function cuentaCorriente(cliente_id) {
  // Los pagos que esperan el TC del mes ya vienen valuados del store (ver movimientos-store.get):
  // si no, un cliente que pagó en pesos figuraría debiendo todo hasta que se cierre el mes.
  const movs = mov.list({ cliente_id });
  const cli = clientes.get(cliente_id);
  const moneda = (cli && cli.moneda_cuenta === 'ARS') ? 'ARS' : 'USDT';
  const col = moneda === 'ARS' ? 'monto_ars' : 'monto_usdt';
  const otra = moneda === 'ARS' ? 'monto_usdt' : 'monto_ars';
  let fichas = '0', proveedores = '0', pagos = '0', bonif = '0';
  /* ── EL MISMO SALDO, EN LA MONEDA EN QUE SE CARGÓ ────────────────────────────────────────────
     La cuenta se lleva en una sola moneda, y el cliente que cargó siempre en pesos ve «858,82
     USDT» y no lo puede comparar con nada de lo que hizo. La otra cara ya está guardada en cada
     movimiento, y la suma la hace `totalesEnMoneda` — una sola cuenta para todo el sistema, la
     misma que usa Mi Caja. Acá sólo se cuenta si a algún movimiento le FALTA esa cara: con uno que
     falte el total queda corto y se lee como un descuento, así que la pantalla lo esconde. */
  let sinOtra = 0;
  let enOtraMoneda = 0;
  // Cuántos de esos pagos todavía se están contando con un TC que puede cambiar, y cuántos no se
  // pudieron pasar porque el mes no tiene ningún tipo de cambio. Los dos van a la pantalla: un
  // saldo provisorio se mira distinto que uno cerrado.
  let esperandoTC = 0, sinValuar = 0, sinImporte = 0;
  for (const m of movs) {
    const u = m[col] || '0';
    // ⚠️ Se mira la columna QUE SUMA, no la que se derivó. Un pago en USDT sobre una cuenta en
    // USDT no depende de ningún tipo de cambio aunque tenga tc_modo='mes': la cara en pesos se
    // deriva igual, pero nadie la usa. Contarlo avisaba "este pago NO entra en el saldo" sobre un
    // pago íntegramente contado, que es una invitación a acreditarlo dos veces.
    if (m.derivada === col) {
      if (m.sinValuar) sinValuar += 1;          // no se pudo: ese pago NO está en el total
      else if (m.provisional) esperandoTC += 1; // está en el total, con un TC que puede cambiar
    }
    // Un movimiento sin nada en la columna de su moneda pero con algo en la otra está mal cargado.
    if ((m[col] == null || m[col] === '') && m[otra] != null && m[otra] !== '') enOtraMoneda += 1;
    /* Y uno sin nada en NINGUNA de las dos es peor: suma cero y no lo delata nada. `enOtraMoneda`
       no lo veía —pide que la otra columna tenga algo— así que quedaba invisible. Hoy ya no se
       puede grabar (movimientos-store lo rechaza), pero los que hayan quedado de antes tienen que
       aparecer en vez de seguir sumando cero en silencio. */
    if ((m[col] == null || m[col] === '') && (m[otra] == null || m[otra] === '')) sinImporte += 1;
    const u2 = m[otra];
    if (u2 == null || u2 === '') sinOtra += 1;
    switch (m.tipo) {
      case 'carga': fichas = money.add(fichas, u); break;
      case 'ajuste': fichas = money.add(fichas, u); break;       // ajuste puede ser +/-
      case 'bonificacion': bonif = money.add(bonif, u); break;   // baja deuda
      case 'proveedor_extra': proveedores = money.add(proveedores, u); break;
      case 'pago': pagos = money.add(pagos, u); break;
      // 'correccion' es un tipo válido y se puede grabar, pero no movía el saldo: quedaba
      // registrada y no corregía nada. Suma como una carga (positiva o negativa).
      case 'correccion': fichas = money.add(fichas, u); break;
      default: break;
    }
  }
  fichas = money.sub(fichas, bonif);
  const total = money.sub(money.add(fichas, proveedores), pagos);
  const otraMoneda = otra === 'monto_ars' ? 'ARS' : 'USDT';
  const otraCara = totalesEnMoneda(cliente_id, otraMoneda);
  return {
    cliente_id,
    moneda,
    fichas_pendientes: money.round(fichas, 2),
    proveedores_pendientes: money.round(proveedores, 2),
    pagos: money.round(pagos, 2),
    total: money.round(total, 2),
    // La otra cara del mismo saldo, cada movimiento al cambio de su día. `otra_completa` en false
    // significa que a algún movimiento le falta esa cara: entonces el número está corto y no se muestra.
    otra_moneda: otraMoneda,
    total_otra: (otraCara && otraCara.total) || '0',
    otra_completa: sinOtra === 0,
    // Cuántos movimientos quedaron cargados en la otra moneda y por eso NO entran en este total.
    // Cero es lo normal; cualquier otro número es algo para mirar, no para tapar.
    enOtraMoneda,
    sinImporte,
    // Pagos valuados con el TC del mes todavía abierto: el saldo es correcto pero va a moverse
    // un poco cuando se cierre. `sinValuar` es peor: esos NO están contados en el total.
    esperandoTC, sinValuar,
    provisional: esperandoTC > 0 || sinValuar > 0,
  };
}

/* ── LA CARA DEL SALDO EN OTRA MONEDA ─────────────────────────────────────────────────────────
   `cuentaCorriente` lleva el saldo en UNA moneda (la del cliente) y ésa es la autoridad — la deuda
   que se cobra. Para mostrarle al cliente el MISMO saldo también en la divisa de su caja, se suma
   la otra columna: la cara que cada movimiento ya guardó derivada al TC de SU día. No convierte
   nada nuevo, sólo suma caras existentes. Por eso mezcla TCs de días distintos: es una REFERENCIA
   para leer en la divisa de la caja, no un segundo saldo. Sólo hay cara para las monedas con
   columna propia (ARS, USDT); una divisa sin columna (PYG, BRL) devuelve null.
   ⚠️ El switch de tipos tiene que quedar IGUAL al de `cuentaCorriente`: si cambia uno, cambian los dos. */
const COLUMNA_DE = { ARS: 'monto_ars', USDT: 'monto_usdt' };
function totalesEnMoneda(cliente_id, monedaPedida) {
  const col = COLUMNA_DE[String(monedaPedida || '').toUpperCase()];
  if (!col) return null;
  const movs = mov.list({ cliente_id });
  let fichas = '0', proveedores = '0', pagos = '0', bonif = '0';
  for (const m of movs) {
    const u = m[col] || '0';
    switch (m.tipo) {
      case 'carga': case 'ajuste': case 'correccion': fichas = money.add(fichas, u); break;
      case 'bonificacion': bonif = money.add(bonif, u); break;
      case 'proveedor_extra': proveedores = money.add(proveedores, u); break;
      case 'pago': pagos = money.add(pagos, u); break;
      default: break;
    }
  }
  fichas = money.sub(fichas, bonif);
  const total = money.sub(money.add(fichas, proveedores), pagos);
  return {
    moneda: String(monedaPedida).toUpperCase(),
    fichas_pendientes: money.round(fichas, 2),
    proveedores_pendientes: money.round(proveedores, 2),
    pagos: money.round(pagos, 2),
    total: money.round(total, 2),
  };
}

module.exports = { cuentaCorriente, totalesEnMoneda };
