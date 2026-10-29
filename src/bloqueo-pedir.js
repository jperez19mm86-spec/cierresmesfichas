/**
 * bloqueo-pedir.js — CUÁNDO UN CLIENTE NO PUEDE PEDIR FICHAS (pedido del dueño, 18-oct-2026).
 *
 *  · Suspendido o inactivo: no pide nunca. Antes el estado no lo leía nadie: un cliente suspendido
 *    seguía pidiendo por el portal, por Mi Caja y por el chat.
 *  · Con tope de deuda (ficha → 💳 Cómo paga): si lo que debe llegó al tope, no pide hasta acreditar.
 *    Sin tope, pide como siempre. El prepago tiene su propio freno (el saldo) y éste se suma.
 *
 * Una sola función para todos los caminos: si cada pantalla decidiera por su cuenta, el día que se
 * agregue una (pasó con el chat) el freno queda abierto por ahí.
 */
const money = require('./lib/money');
const deuda = require('./deuda.service');

const fmt = (v, moneda) => Number(v).toLocaleString('es-AR', { minimumFractionDigits: moneda === 'ARS' ? 0 : 2, maximumFractionDigits: moneda === 'ARS' ? 0 : 2 });

/** null si puede pedir; si no, { motivo: 'suspendido' | 'tope_deuda', mensaje, debe?, tope?, moneda? }. */
function bloqueo(cli) {
  if (!cli) return null;
  const est = String(cli.estado || 'activo').toLowerCase();
  if (est === 'baja') return { motivo: 'baja', mensaje: 'Tu cuenta está dada de baja. Escribinos si querés volver a trabajar.' };
  if (est === 'suspendido' || est === 'inactivo') {
    return { motivo: 'suspendido', mensaje: 'Tu cuenta está pausada. Escribinos para volver a pedir fichas.' };
  }
  if (cli.tope_deuda && money.isPos(String(cli.tope_deuda))) {
    const cc = deuda.cuentaCorriente(cli.id);
    if (money.cmp(String(cc.total), String(cli.tope_deuda)) >= 0) {
      return { motivo: 'tope_deuda', debe: cc.total, tope: String(cli.tope_deuda), moneda: cc.moneda,
        mensaje: `Tenés ${fmt(cc.total, cc.moneda)} ${cc.moneda} pendientes. Acreditá ese monto para seguir pidiendo fichas.` };
    }
  }
  return null;
}

module.exports = { bloqueo };
