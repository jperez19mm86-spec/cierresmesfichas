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

function cuentaCorriente(cliente_id) {
  const movs = mov.list({ cliente_id });
  let fichas = '0', proveedores = '0', pagos = '0', bonif = '0';
  for (const m of movs) {
    const u = m.monto_usdt || '0';
    switch (m.tipo) {
      case 'carga': fichas = money.add(fichas, u); break;
      case 'ajuste': fichas = money.add(fichas, u); break;       // ajuste puede ser +/-
      case 'bonificacion': bonif = money.add(bonif, u); break;   // baja deuda
      case 'proveedor_extra': proveedores = money.add(proveedores, u); break;
      case 'pago': pagos = money.add(pagos, u); break;
      default: break;
    }
  }
  fichas = money.sub(fichas, bonif);
  const total = money.sub(money.add(fichas, proveedores), pagos);
  return {
    cliente_id,
    fichas_pendientes: money.round(fichas, 2),
    proveedores_pendientes: money.round(proveedores, 2),
    pagos: money.round(pagos, 2),
    total: money.round(total, 2),
  };
}

module.exports = { cuentaCorriente };
