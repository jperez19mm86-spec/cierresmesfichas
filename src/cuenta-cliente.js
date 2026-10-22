/**
 * cuenta-cliente.js — LOS MOVIMIENTOS QUE VE EL CLIENTE, ARMADOS UNA SOLA VEZ.
 *
 * Los usan las dos pantallas del cliente: el portal (/pedir → /api/cuenta/mio) y Mi Caja (puente
 * /v1/mi-cuenta). Antes cada una armaba su lista y decían cosas distintas: el portal mostraba a qué
 * login fue cada carga y Mi Caja no; el portal cortaba en 40 y Mi Caja en 25.
 *
 * Cada movimiento lleva lo que la pantalla necesita para que el cliente pueda AUDITAR (pedido del
 * dueño, 13-oct-2026): cuánto se cargó, en qué moneda y a qué login; lo que pagó por eso en su
 * moneda; y, si es una anulación, a qué carga da de baja (`anula`), para mostrar las dos en un solo
 * renglón tachado en vez de un cargo y una devolución.
 *
 * Lo que es nuestro y no del cliente NO viaja: lo que dio el trader por un pago en pesos y la
 * diferencia de cambio que pone la empresa (ver pesos-cancelan-pesos.js).
 */
const movsStore = require('./movimientos-store');
const { mesDe } = require('./lib/mes-de');
const pedidos = require('./pedidos-store');
const money = require('./lib/money');

function movimientosDe(cli) {
  if (!cli) return [];
  const etq = {}; (cli.cajas || []).forEach((k) => { if (k.etiqueta) etq[k.id] = k.etiqueta; });
  const etiquetaDe = (p) => (p && (p.cajaEtiqueta || etq[p.cajaId])) || '';
  const lista = movsStore.list({ cliente_id: cli.id });
  // La carga de cada pedido, para atar su anulación (mismo pedido) a ella.
  const cargaDelPedido = {};
  lista.forEach((m) => { if (m.tipo === 'carga' && m.pedido_id) cargaDelPedido[m.pedido_id] = m.id; });
  return lista.map((m) => {
    let cargado = null; let usuario = null; let etiqueta = '';
    if (m.pedido_id) {
      try { const p = pedidos.get(m.pedido_id); if (p) { cargado = p.monto; usuario = p.cajaUsuario || null; etiqueta = etiquetaDe(p); } } catch (e) { /* sin pedido, sin login */ }
    }
    // A qué mes pertenece, que no siempre es el de su fecha: la deuda de julio se cargó en septiembre.
    // `origen_ref` primero: es el mes al que se anotó a propósito (la deuda vieja cargada después).
    const mes = m.origen_ref || mesDe(m);
    // Lo que paga en la moneda de esa carga: en guaraníes no hay cara en pesos.
    const divPropia = String(m.divisa || 'ARS').toUpperCase();
    let propio = divPropia === 'ARS' ? m.monto_ars : (divPropia === 'USDT' ? m.monto_usdt : null);
    if (propio == null && cargado != null && m.base_pct_aplicado) {
      try { propio = money.round(money.pct(String(cargado), String(m.base_pct_aplicado)), 2); } catch (e) { propio = null; }
    }
    let anula = null;
    if (m.tipo === 'correccion') {
      anula = (m.pedido_id && cargaDelPedido[m.pedido_id]) || ((String(m.notas || '').match(/da de baja (mov_\w+)/) || [])[1]) || null;
    }
    return {
      id: m.id, fecha: String(m.fecha || '').slice(0, 10), tipo: m.tipo, mes,
      propio_monto: propio, propio_divisa: divPropia,
      monto_ars: m.monto_ars != null ? m.monto_ars : null, monto_usdt: m.monto_usdt != null ? m.monto_usdt : null,
      tc: m.tc_momento || null, divisa: m.divisa || null, notas: m.notas || null, medio: m.medio || null,
      base_pct: m.base_pct_aplicado || null, cargado, usuario, etiqueta, anula,
    };
  });
}

module.exports = { movimientosDe };
