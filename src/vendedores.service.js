/**
 * vendedores.service.js — LA CUENTA DE UN VENDEDOR.
 *
 * Un vendedor no es un cliente: no se le cobra un % sobre lo que carga. Paga **al costo** por todos
 * los proveedores que use, en sus paneles y en los de sus clientes. Esa cuenta es interna —
 * sirve para saber cuánto nos tiene que pagar él, no para facturarle a nadie.
 *
 * Lo que junta, por mes:
 *   · CARGAS EJECUTADAS   lo que se cargó en sus paneles y en los de sus clientes (punto 6).
 *   · PROVEEDORES         lo que paga al costo por los proveedores que usó (punto 7).
 *
 * ⚠️ Un panel de un cliente que cuelga del superagente del vendedor aparece en LAS DOS cuentas, y
 * está bien: el cliente paga su %, el vendedor paga el costo. No es doble cobro — son dos cobros
 * distintos sobre el mismo movimiento, que es exactamente el modelo del negocio.
 */
const clientes = require('./clientes-store');
const paneles = require('./paneles-store');
const externosSvc = require('./externos.service');
const ventasOnline = require('./ventas-online.service');
const tcUnico = require('./tc-unico.service');
const money = require('./lib/money');

const K = (s) => String(s || '').trim().toLowerCase();

/** Los clientes que cuelgan de un vendedor: por `vendedor_id`, o por colgar de sus paneles. */
function clientesDe(vendedorId) {
  const todos = clientes.list().clientes;
  const vend = todos.find((c) => c.id === vendedorId);
  if (!vend) return [];
  const directos = todos.filter((c) => c.vendedor_id === vendedorId && c.id !== vendedorId);

  // los que no tienen `vendedor_id` cargado se deducen del árbol: si su panel cuelga de un panel
  // del vendedor, es suyo. Es el mismo cruce que resolvió el mapeo de códigos.
  const nodosDelVendedor = new Set(
    paneles.list().filter((p) => p.cliente_id === vendedorId && p.id_usuario).map((p) => String(p.id_usuario)),
  );
  const porArbol = todos.filter((c) => {
    if (c.id === vendedorId || directos.some((d) => d.id === c.id)) return false;
    return paneles.list({ cliente_id: c.id })
      .some((p) => nodosDelVendedor.has(String(p.padre_id || '')) || nodosDelVendedor.has(String(p.sa_id || '')));
  });

  return [
    ...directos.map((c) => ({ ...c, _via: 'asignado en la ficha' })),
    ...porArbol.map((c) => ({ ...c, _via: 'cuelga de su panel' })),
  ];
}

/**
 * La cuenta del vendedor para un mes.
 * @param conProveedores  consultar el casino para el costo de proveedores (lento). Sin esto sale
 *                        solo la parte de cargas, que es instantánea.
 */
async function cuenta({ vendedorId, mes, conProveedores = true, facturacion = null }) {
  const vend = clientes.get(vendedorId);
  if (!vend) return { ok: false, error: 'no existe ese vendedor' };
  const m = String(mes || '').slice(0, 7);
  const suyos = clientesDe(vendedorId);

  // ── cargas ejecutadas ──────────────────────────────────────────────────
  // Sale de la MISMA facturación que ve el panel: si acá diera otro número, no habría forma de
  // saber cuál de los dos está bien.
  const linea = (c) => (facturacion && (facturacion.clientes || []).find((x) => x.cliente_id === c.id)) || null;
  const propio = linea(vend);
  const deClientes = suyos.map((c) => ({ cliente: c.nombre || c.codigo, via: c._via, l: linea(c) })).filter((x) => x.l);

  let vendidoPropio = propio ? propio.vendido_usdt : '0';
  let vendidoClientes = '0';
  deClientes.forEach((x) => { vendidoClientes = money.add(vendidoClientes, x.l.vendido_usdt || '0'); });

  // ── proveedores, al costo ──────────────────────────────────────────────
  let prov = null;
  if (conProveedores) {
    try {
      const r = await externosSvc.reporte({ clienteNombre: vend.nombre, mes: m });
      if (r.ok) {
        const acc = {};
        (r.paneles || []).forEach((p) => (p.items || []).filter((i) => i.cobra).forEach((i) => {
          const a = acc[i.proveedor] = acc[i.proveedor] || { proveedor: i.proveedor, costo: i.costo, usdt: '0' };
          a.usdt = money.add(a.usdt, i.usdt);
        }));
        prov = {
          total_usdt: r.totalUsdt,
          incompleto: !!r.incompleto,
          items: Object.values(acc).map((a) => ({ ...a, usdt: money.round(a.usdt, 2) }))
            .sort((a, b) => Number(b.usdt) - Number(a.usdt)),
        };
      } else prov = { error: r.error };
    } catch (e) { prov = { error: String((e && e.message) || e) }; }
  }

  return {
    ok: true,
    vendedor: { id: vend.id, codigo: vend.codigo, nombre: vend.nombre || vend.nombreVisible },
    mes: m,
    clientes: deClientes.map((x) => ({
      cliente: x.cliente, via: x.via,
      cargas: x.l.pedidos || 0,
      vendido_usdt: x.l.vendido_usdt,
      // lo que ESE cliente paga por su cuenta: no es del vendedor, se muestra para tener la foto
      cobrado_al_cliente_usdt: x.l.fee_usdt,
    })).sort((a, b) => Number(b.vendido_usdt) - Number(a.vendido_usdt)),
    propio: propio ? { cargas: propio.pedidos || 0, vendido_usdt: propio.vendido_usdt } : null,
    totales: {
      vendido_propio_usdt: money.round(vendidoPropio, 2),
      vendido_clientes_usdt: money.round(vendidoClientes, 2),
      vendido_total_usdt: money.round(money.add(vendidoPropio, vendidoClientes), 2),
      proveedores_usdt: prov && prov.total_usdt ? prov.total_usdt : '0',
    },
    proveedores: prov,
    tc: tcUnico.tcDelMes('ARS', m).valor,
  };
}

/** Quiénes son vendedores. */
function lista() {
  return clientes.list().clientes
    .filter((c) => c.es_vendedor)
    .map((c) => ({ id: c.id, codigo: c.codigo, nombre: c.nombre || c.nombreVisible, clientes: clientesDe(c.id).length }))
    .sort((a, b) => b.clientes - a.clientes);
}

module.exports = { cuenta, lista, clientesDe };
