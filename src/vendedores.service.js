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
/* IGLatam es la cuenta de la casa: su costo no es deuda de nadie. La excepción la puso la dueña:
   «es casa a no ser que sus paneles estén asignados a un vendedor», y eso lo resuelve `grupoDe`
   mirando el vendedor del DUEÑO de cada panel, no de quién cuelga en el casino. */
const CASA = 'CASA';
const esLaCasa = (c) => String((c && c.nombre) || '').toLowerCase() === 'iglatam';

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

module.exports = { repartoCosto, cuenta, lista, clientesDe };

/* ══ EL REPARTO DEL COSTO DE PROVEEDORES ═══════════════════════════════════════════════════════
 *
 * El casino devuelve, para cada nodo, TODO lo que cuelga debajo. Así que el número de un vendedor
 * contiene el de los vendedores que tiene abajo: en agosto 2026 los 3.512,30 de IGLatam ya
 * incluían los 454,37 de Alexa y los 176,80 enteros de GanamosSarah. Cobrarlos a los dos es
 * cobrar dos veces, y la pantalla mostraba 5.534,87 cuando lo real eran 4.965,19.
 *
 * Dos reglas, dichas por la dueña:
 *   1) el consumo es del VENDEDOR ASIGNADO MÁS CERCANO subiendo por `vendedor_id`;
 *   2) lo que no tiene ninguno queda en la CASA. Que el árbol del casino baje de IGLatam es un
 *      hecho físico, no comercial: «Fran no genera consumo a IGLatam aunque su árbol baje de ahí».
 *
 * ⚠️ LA RESTA SE HACE CON `escala`, NO CON `padre_id`. La cadena de padres del OS se corta en los
 * nodos que no están cargados como panel —los tres de Ariel cuelgan de `GAF-ParD`, que no existe
 * acá— y ahí la resta nunca llegaba: sus 190,41 quedaban contados en su rama Y adentro de la casa.
 * `escala` trae la cadena entera desde el superagente, con los nodos intermedios aunque no sean
 * paneles, que es exactamente lo que hace falta.
 */
async function repartoCosto(mes) {
  const m = String(mes || '').slice(0, 7);
  const todos = clientes.list().clientes;
  const paneles = require('./paneles-store').list();
  const porNodo = {}; paneles.forEach((p) => { if (p.id_usuario) porNodo[String(p.id_usuario)] = p; });

  /** El vendedor asignado más cercano. Sin ninguno —o IGLatam, que es la casa— va a CASA. */
  const grupoDe = (clienteId) => {
    const byId = {}; todos.forEach((c) => { byId[c.id] = c; });
    let c = byId[clienteId]; let n = 0;
    while (c && n++ < 8) {
      if (c.es_vendedor && !esLaCasa(c)) return c.nombre;
      if (c.vendedor_id) { c = byId[c.vendedor_id]; continue; }
      return CASA;
    }
    return CASA;
  };

  // El COSTO de cada panel, moneda por moneda. Se le pide a cada cliente en modo vendedor: es la
  // misma cuenta que ya hace la pantalla, no un motor nuevo.
  const costo = {}; const fallaron = [];
  for (const c of todos) {
    let r;
    try { r = await externosSvc.reporte({ clienteNombre: c.nombre, mes: m, forzarModo: 'vendedor' }); }
    catch (e) { fallaron.push({ cliente: c.nombre, error: String((e && e.message) || e) }); continue; }
    if (!r || !r.ok) { if (r && r.error) fallaron.push({ cliente: c.nombre, error: r.error }); continue; }
    (r.paneles || []).forEach((p) => {
      const u = Number(p.usdt || 0); if (!u) return;
      const pan = paneles.find((x) => x.nombre === p.panel && x.cliente_id === c.id) || porNodo[String(p.nodo || '')];
      if (!pan || !pan.id_usuario) return;
      costo[pan.id_usuario + '|' + p.divisa] = { usdt: u, panel: pan, cliente_id: c.id };
    });
  }

  // Lo PROPIO de cada nodo: lo suyo menos lo de los nodos con costo que cuelgan debajo.
  const esDescendiente = (hijo, ancestroNodo) =>
    (hijo.escala || []).some((x) => String(x.id) === String(ancestroNodo));
  const filas = [];
  for (const [k, v] of Object.entries(costo)) {
    const [nodo, divisa] = k.split('|');
    let ajeno = 0;
    for (const [k2, v2] of Object.entries(costo)) {
      if (k2 === k) continue;
      const [, d2] = k2.split('|');
      if (d2 !== divisa) continue;
      if (esDescendiente(v2.panel, nodo)) ajeno += v2.usdt;
    }
    filas.push({ nodo, divisa, panel: v.panel.nombre, cliente_id: v.cliente_id,
      rama_usdt: money.round(String(v.usdt), 2),
      propio_usdt: money.round(String(v.usdt - ajeno), 2),
      grupo: grupoDe(v.cliente_id) });
  }

  const porGrupo = {};
  filas.forEach((f) => {
    const g = porGrupo[f.grupo] = porGrupo[f.grupo] || { grupo: f.grupo, propio_usdt: '0', paneles: [] };
    g.propio_usdt = money.add(g.propio_usdt, f.propio_usdt);
    if (Number(f.propio_usdt)) g.paneles.push(f);
  });
  const lista = Object.values(porGrupo)
    .map((g) => ({ ...g, propio_usdt: money.round(g.propio_usdt, 2) }))
    .sort((a, b) => Number(b.propio_usdt) - Number(a.propio_usdt));
  const total = lista.reduce((a, g) => money.add(a, g.propio_usdt), '0');
  const casa = (lista.find((g) => g.grupo === CASA) || {}).propio_usdt || '0';
  return { ok: true, mes: m, grupos: lista, fallaron,
    total_usdt: money.round(total, 2),
    casa_usdt: money.round(casa, 2),
    aCobrar_usdt: money.round(money.sub(total, casa), 2) };
}
