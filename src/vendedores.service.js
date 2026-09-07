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


/**
 * LO QUE MOVIÓ TODA LA LÍNEA DE UN VENDEDOR, PROVEEDOR POR PROVEEDOR.
 *
 * La pregunta, tal como la hizo la dueña: «lo que movieron todos los de Alexa —no importa si línea
 * directa o árbol— es X en este proveedor, y eso al precio real del proveedor es esto, y por el
 * tipo de cambio de cada divisa del panel es esto en dólares; sumatoria, esto».
 *
 * Tres cosas que la hacen distinta de `cuenta`:
 *
 *  1. Es TODA la rama, no sus paneles propios. El papel de Henry decía 89,84 cuando su línea movía
 *     15.386,48: mostraba una rebanada y parecía el total.
 *  2. Va por PROVEEDOR, no por panel ni por cliente. Un proveedor que aparece en catorce paneles de
 *     seis clientes es una línea sola, con su movimiento sumado por divisa.
 *  3. SIN CONTAR DOS VECES. En el casino un panel padre ya trae adentro lo de sus hijos, así que
 *     sumar los dos cuenta la misma plata dos veces — el mismo error que inflaba el total del
 *     reparto en 2.057,97 sobre 19.372,56. Acá la resta se hace por (nodo, divisa, PROVEEDOR), que
 *     es el grano fino: restar el total del panel no serviría para armar la fila de cada proveedor.
 *     Con piso en cero, por la misma razón de siempre: cada nivel del casino es una consulta aparte
 *     con su filtro `profit > 0` y los hijos pueden dar más que el padre.
 */
async function ramaPorProveedor(vendedorNombre, mes) {
  const m = String(mes || '').slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(m)) return { ok: false, error: 'mes inválido (se espera YYYY-MM)' };
  const todos = clientes.list().clientes;
  const pans = paneles.list();
  const byId = {}; todos.forEach((c) => { byId[c.id] = c; });

  const grupoDe = (clienteId) => {
    let c = byId[clienteId]; let n = 0;
    while (c && n++ < 8) {
      if (c.es_vendedor && !esLaCasa(c)) return c.nombre;
      if (c.vendedor_id) { c = byId[c.vendedor_id]; continue; }
      return CASA;
    }
    return CASA;
  };
  const objetivo = K(vendedorNombre);
  const mios = todos.filter((c) => K(grupoDe(c.id)) === objetivo);
  if (!mios.length) return { ok: false, error: `no encuentro clientes en la línea de "${vendedorNombre}"` };
  const esMio = {}; mios.forEach((c) => { esMio[c.id] = true; });

  /* Se le pide a cada cliente su reporte EN MODO VENDEDOR: ahí el número de cada proveedor es su
     COSTO REAL, no el diferencial que paga el cliente. Es la misma cuenta que ya hace el reparto,
     no un motor nuevo.

     ⚠️ SE RECORREN TODOS LOS CLIENTES, NO SÓLO LOS DE ESTA LÍNEA. Parece de más y es lo único que
     hace que el número cierre: para restar lo que ya está contado abajo hay que VER lo de abajo, y
     un panel de un vendedor puede tener colgados los de OTRO. `GanamosAlexa` es de Alexa y adentro
     tiene los de Fran y Ariel, que son de Julian: mirando sólo la línea de Alexa, esos hijos no
     existen, no se resta nada y su papel daba 2.183,80 cuando su rama son 1.803,65 — 380 de más,
     que es el panel entero contado dos veces. */
  const bruto = {};          // nodo|divisa|proveedor → { profit, usdt, costo, tasa, panel, cliente }
  const fallaron = [];
  for (const c of todos) {
    let r;
    try { r = await externosSvc.reporte({ clienteNombre: c.nombre, mes: m, forzarModo: 'vendedor' }); }
    catch (e) { fallaron.push({ cliente: c.nombre, error: String((e && e.message) || e) }); continue; }
    if (!r || !r.ok) { if (r && r.error) fallaron.push({ cliente: c.nombre, error: r.error }); continue; }
    (r.paneles || []).forEach((p) => {
      const pan = pans.find((x) => x.nombre === p.panel && x.cliente_id === c.id);
      if (!pan || !pan.id_usuario) return;         // sin nodo no se puede saber qué contiene a qué
      (p.items || []).forEach((it) => {
        const k = `${pan.id_usuario}|${it.divisa}|${it.proveedor}`;
        const a = bruto[k] || (bruto[k] = { nodo: String(pan.id_usuario), panelObj: pan, divisa: it.divisa,
          proveedor: it.proveedor, profit: 0, usdt: 0, costo: it.costo, tasa: it.tasa,
          panel: p.panel, cliente: c.nombre, cliente_id: c.id });
        a.profit += Number(it.profit || 0);
        a.usdt += Number(it.usdt || 0);
        if (a.costo == null) a.costo = it.costo;
        if (a.tasa == null) a.tasa = it.tasa;
      });
    });
  }

  const esDescendiente = (hijo, ancestroNodo) =>
    (hijo.escala || []).some((x) => String(x.id) === String(ancestroNodo));
  const neto = [];
  for (const a of Object.values(bruto)) {
    let bp = 0; let bu = 0;
    for (const b of Object.values(bruto)) {
      if (b === a || b.divisa !== a.divisa || b.proveedor !== a.proveedor) continue;
      if (!esDescendiente(b.panelObj, a.nodo)) continue;
      bp += b.profit; bu += b.usdt;
    }
    neto.push({ ...a, profit: Math.max(0, a.profit - bp), usdt: Math.max(0, a.usdt - bu) });
  }

  const porProv = {};
  neto.forEach((f) => {
    if (!esMio[f.cliente_id]) return;          // se miró todo para restar; se suma sólo lo suyo
    if (!(f.usdt > 0) && !(f.profit > 0)) return;
    const p = porProv[f.proveedor] || (porProv[f.proveedor] = {
      proveedor: f.proveedor, costo: f.costo, usdt: '0', divisas: {} });
    if (p.costo == null) p.costo = f.costo;
    const d = p.divisas[f.divisa] || (p.divisas[f.divisa] = {
      divisa: f.divisa, movimiento: '0', tasa: f.tasa, usdt: '0' });
    d.movimiento = money.add(d.movimiento, String(f.profit));
    d.usdt = money.add(d.usdt, String(f.usdt));
    p.usdt = money.add(p.usdt, String(f.usdt));
  });

  const proveedores = Object.values(porProv).map((p) => ({
    proveedor: p.proveedor,
    costo: p.costo == null ? null : String(p.costo),
    porDivisa: Object.values(p.divisas).map((d) => ({ ...d,
      movimiento: money.round(d.movimiento, 2), usdt: money.round(d.usdt, 2) }))
      .sort((a, b) => Number(b.usdt) - Number(a.usdt)),
    usdt: money.round(p.usdt, 2),
  })).sort((a, b) => Number(b.usdt) - Number(a.usdt));

  const totalUsdt = proveedores.reduce((a, p) => money.add(a, p.usdt), '0');
  return { ok: true, vendedor: vendedorNombre, mes: m, proveedores,
    clientes: mios.map((c) => c.nombre).sort(),
    totalUsdt: money.round(totalUsdt, 2), fallaron };
}

module.exports = { repartoCosto, cuenta, lista, clientesDe, ramaPorProveedor };

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
  /* ── LA RESTA SÓLO ENTRE VENDEDORES, Y NO ES UN ATAJO ────────────────────────────────────────
     Se probó restando TODO lo que cuelga debajo, de cualquier cliente, y no funciona: cada nivel
     del casino es una consulta aparte con su propio filtro `profit > 0`, así que los hijos suman
     MÁS que el padre y el resto da negativo. Medido en agosto 2026: `GanamosBot-SA` quedaba en
     −431,83 sobre una base de 1.820,96, un 24% restado de más. Para cobrar eso no sirve.

     Lo que SÍ es exacto y es el problema real: un vendedor cuyo panel cuelga del panel de OTRO
     vendedor se cobra dos veces —los 176,80 de GanamosSarah estaban enteros adentro de IGLatam—.
     Esa resta se hace entre pocos nodos, todos del mismo tipo, y cierra sin residuo.

     Lo de un cliente que no es vendedor (Fran bajo Alexa, que comercialmente es de Julian) queda
     como número INFORMATIVO en `rama_usdt`: saber cuánto vale esa rama se puede, atribuirlo al
     centavo no, y un número que no cierra es peor que uno que falta. */
  const esDeVendedor = {};
  todos.filter((c) => c.es_vendedor && !esLaCasa(c)).forEach((v) => {
    paneles.filter((p) => p.cliente_id === v.id).forEach((p) => { esDeVendedor[String(p.id_usuario)] = v.id; });
  });
  /* ── Y ADEMÁS, LO NETO: CUÁNTO GENERA ESA RAMA ──────────────────────────────────────────────
     La dueña lo dijo así: «por cada vendedor, jalás sus paneles, ves lo que generan y lo ponés al
     precio real — eso te dice cuánto genera. El único error está en la casa, porque pide balance
     para todos esos paneles».

     Y es exactamente lo que pasa: en julio 2026 los paneles de IGLatam declaraban 1.019,74 que
     ya estaban contados abajo —`GanamosBot-SA` son 954,48 que son Fran y Ariel, clientes de
     Julian—. Sumar todo daba 21.430,53 cuando lo real son 19.372,56: un 5,1% de más.

     `neto_usdt` resta TODO lo que cuelga con costo, no sólo los otros vendedores, y va con PISO
     EN CERO. El piso es lo que hace que se pueda: sin él da negativo, porque cada nivel del
     casino es una consulta aparte con su propio filtro `profit > 0` y los hijos suman más que el
     padre (GanamosBot-SA: 954,48 arriba, 964,58 abajo). Un cero de más es no cobrar por plata que
     ya se contó abajo; un negativo es inventar plata.

     ⚠️ `neto_usdt` es para MEDIR, no para cobrar. Cobrar sigue saliendo de `propio_usdt`, que
     resta sólo entre vendedores: hay clientes sin ninguna factura —Lucía, Yamila, Pablo bajo
     Alexa— cuyo costo NO lo paga nadie, y restarlos de la cuenta del vendedor haría desaparecer
     esa plata. Cuál de los dos se cobra es una decisión del negocio, no de este archivo. */
  const filas = [];
  for (const [k, v] of Object.entries(costo)) {
    const [nodo, divisa] = k.split('|');
    let ajeno = 0; let abajo = 0;
    for (const [k2, v2] of Object.entries(costo)) {
      if (k2 === k) continue;
      const [n2, d2] = k2.split('|');
      if (d2 !== divisa) continue;
      if (!esDescendiente(v2.panel, nodo)) continue;
      abajo += v2.usdt;                                                       // cualquiera
      if (!esDeVendedor[n2] || esDeVendedor[n2] === v.cliente_id) continue;   // sólo otro vendedor
      ajeno += v2.usdt;
    }
    filas.push({ nodo, divisa, panel: v.panel.nombre, cliente_id: v.cliente_id,
      rama_usdt: money.round(String(v.usdt), 2),
      propio_usdt: money.round(String(v.usdt - ajeno), 2),
      neto_usdt: money.round(String(Math.max(0, v.usdt - abajo)), 2),
      yaArriba_usdt: money.round(String(ajeno), 2),
      grupo: grupoDe(v.cliente_id) });
  }

  /* ── SON DOS PREGUNTAS DISTINTAS, Y CONFUNDIRLAS COBRA DE MÁS ────────────────────────────────
     · A COBRARLE: el costo de SUS PROPIOS paneles. Es lo que el vendedor paga.
     · SU RAMA: eso más el de todos los clientes que tiene asignados. Es «cuánto cuesta Julian con
       Fran y Ariel adentro» — sirve para saber cuánto vale esa rama, NO es deuda de él: cada
       cliente paga su diferencial por su cuenta.
     Sumar la rama y cobrarla le cargaría a Henry el costo de Titan, que Titan ya paga aparte. */
  const dueno = {}; todos.forEach((c) => { dueno[c.id] = c; });
  const porGrupo = {};
  const acc = (clave, campo, monto) => {
    const g = porGrupo[clave] = porGrupo[clave] || { grupo: clave, aCobrar_usdt: '0', rama_usdt: '0',
      rama_bruta_usdt: '0', paneles: [] };
    g[campo] = money.add(g[campo], monto);
  };
  filas.forEach((f) => {
    const d = dueno[f.cliente_id] || {};
    // a cobrar: sólo si el panel es DE un vendedor (y la casa no se cobra)
    const suyo = d.es_vendedor && !esLaCasa(d) ? d.nombre : (esLaCasa(d) || !d.es_vendedor ? null : null);
    // La rama va con el NETO: es «cuánto genera», y sumar padre e hijo cuenta la misma plata dos
    // veces. `rama_bruta_usdt` queda al lado para poder ver cuánto se estaba duplicando.
    acc(f.grupo, 'rama_usdt', f.neto_usdt);
    acc(f.grupo, 'rama_bruta_usdt', f.propio_usdt);
    if (suyo) acc(suyo, 'aCobrar_usdt', f.propio_usdt);
    else if (esLaCasa(d) || f.grupo === CASA) acc(CASA, 'aCobrar_usdt', f.propio_usdt);
    const g = porGrupo[f.grupo]; if (Number(f.propio_usdt) || Number(f.neto_usdt)) g.paneles.push(f);
  });
  const lista = Object.values(porGrupo)
    .map((g) => ({ ...g, aCobrar_usdt: money.round(g.aCobrar_usdt, 2), rama_usdt: money.round(g.rama_usdt, 2),
      rama_bruta_usdt: money.round(g.rama_bruta_usdt, 2) }))
    .sort((a, b) => Number(b.rama_usdt) - Number(a.rama_usdt));
  const total = filas.reduce((a, f) => money.add(a, f.neto_usdt), '0');
  const totalBruto = filas.reduce((a, f) => money.add(a, f.propio_usdt), '0');
  const casa = (lista.find((g) => g.grupo === CASA) || {}).aCobrar_usdt || '0';
  const aCobrar = lista.filter((g) => g.grupo !== CASA).reduce((a, g) => money.add(a, g.aCobrar_usdt), '0');
  /* ⚠️ EL RESIDUO NEGATIVO ES REAL Y SE INFORMA. Cada nivel del casino es una consulta aparte con
     su propio filtro de ganancias, y el motor esconde los negativos distinto en cada uno: restarle
     a un superagente lo de un agente puede dar por debajo de cero. No se corrige solo —taparlo
     sería inventar plata— se dice cuánto y dónde. */
  const negativos = filas.filter((f) => Number(f.propio_usdt) < 0)
    .map((f) => ({ panel: f.panel, divisa: f.divisa, propio_usdt: f.propio_usdt }));
  return { ok: true, mes: m, grupos: lista, fallaron, negativos,
    total_usdt: money.round(total, 2),
    // Lo que daba antes de descontar lo anidado, para poder ver de cuánto era el error.
    total_bruto_usdt: money.round(totalBruto, 2),
    duplicado_usdt: money.round(money.sub(totalBruto, total), 2),
    casa_usdt: money.round(casa, 2),
    aCobrar_usdt: money.round(aCobrar, 2) };
}
