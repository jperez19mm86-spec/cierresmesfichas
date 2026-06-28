/**
 * proveedores.service.js — diferencial de PROVEEDORES EXTERNOS (sección 3.3).
 *
 * El cliente paga X% base sobre la carga. Si un proveedor extra cuesta Y% y Y > X →
 * se cobra (Y−X)% sobre el PROFIT de ese proveedor (no sobre la carga). Si el profit ≤ 0 →
 * no se cobra nada y NO hay arrastre al mes siguiente.
 *
 * ⚠️ AGUJERO: `profitProveedor` viene de la API del panel del proveedor (a integrar en Fase 3).
 * Acá se recibe como dato (manual o futuro feed). Ver memory proyecto-fichas-latamgames.
 */
const prov = require('./proveedores-store');
const money = require('./lib/money');

/** Diferencial de UN proveedor. {cobra, pct, monto} */
function diferencial({ base, tarifa, profitProveedor }) {
  const dif = money.sub(tarifa, base);
  if (money.cmp(dif, '0') <= 0) return { cobra: false, pct: '0', monto: '0', motivo: 'tarifa <= base' };
  if (money.cmp(profitProveedor || '0', '0') <= 0) return { cobra: false, pct: dif, monto: '0', motivo: 'profit <= 0 (sin arrastre)' };
  return { cobra: true, pct: dif, monto: money.round(money.pct(profitProveedor, dif), 2) };
}

/**
 * Calcula los diferenciales de todos los proveedores EXTRA habilitados de un panel.
 * @param profitsPorProveedor {proveedor_id|nombre: profit} — del API del panel (Fase 3).
 */
function calcularPanel(panel_id, base, profitsPorProveedor = {}) {
  const items = prov.listPorPanel(panel_id)
    .filter((pp) => pp.habilitado && pp.proveedor_categoria === 'extra')
    .map((pp) => {
      const profit = profitsPorProveedor[pp.proveedor_id] || profitsPorProveedor[pp.proveedor_nombre] || '0';
      const d = diferencial({ base, tarifa: pp.tarifa_pct, profitProveedor: profit });
      return { proveedor_id: pp.proveedor_id, proveedor: pp.proveedor_nombre, tarifa: pp.tarifa_pct, profit, ...d };
    });
  const total = money.sum(items.filter((i) => i.cobra).map((i) => i.monto));
  return { items, total };
}

module.exports = { diferencial, calcularPanel };
