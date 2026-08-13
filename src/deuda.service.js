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
const valuacion = require('./valuacion');

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
  // Los pagos que esperan el TC del mes se valúan ACÁ, al leer. Si no, un cliente que pagó en
  // pesos figuraría debiendo todo hasta que se cierre el mes — debiendo plata que ya pagó.
  const movs = valuacion.valuarLista(mov.list({ cliente_id }));
  const cli = clientes.get(cliente_id);
  const moneda = (cli && cli.moneda_cuenta === 'ARS') ? 'ARS' : 'USDT';
  const col = moneda === 'ARS' ? 'monto_ars' : 'monto_usdt';
  const otra = moneda === 'ARS' ? 'monto_usdt' : 'monto_ars';
  let fichas = '0', proveedores = '0', pagos = '0', bonif = '0';
  let enOtraMoneda = 0;
  // Cuántos de esos pagos todavía se están contando con un TC que puede cambiar, y cuántos no se
  // pudieron pasar porque el mes no tiene ningún tipo de cambio. Los dos van a la pantalla: un
  // saldo provisorio se mira distinto que uno cerrado.
  let esperandoTC = 0, sinValuar = 0;
  for (const m of movs) {
    const u = m[col] || '0';
    if (m.tc_modo === 'mes') { if (m.sinValuar) sinValuar += 1; else if (m.provisional) esperandoTC += 1; }
    // Un movimiento sin nada en la columna de su moneda pero con algo en la otra está mal cargado.
    if ((m[col] == null || m[col] === '') && m[otra] != null && m[otra] !== '') enOtraMoneda += 1;
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
  return {
    cliente_id,
    moneda,
    fichas_pendientes: money.round(fichas, 2),
    proveedores_pendientes: money.round(proveedores, 2),
    pagos: money.round(pagos, 2),
    total: money.round(total, 2),
    // Cuántos movimientos quedaron cargados en la otra moneda y por eso NO entran en este total.
    // Cero es lo normal; cualquier otro número es algo para mirar, no para tapar.
    enOtraMoneda,
    // Pagos valuados con el TC del mes todavía abierto: el saldo es correcto pero va a moverse
    // un poco cuando se cierre. `sinValuar` es peor: esos NO están contados en el total.
    esperandoTC, sinValuar,
    provisional: esperandoTC > 0 || sinValuar > 0,
  };
}

module.exports = { cuentaCorriente };
