/**
 * api-cuenta.service.js — LAS DOS CUENTAS DEL MES, del negocio de API (TBS).
 *
 * Del MISMO GGR salen dos documentos que nunca se pueden desincronizar:
 *
 *   CUENTA DEL CLIENTE     GGR × su %        → lo que se le cobra
 *   CUENTA DEL PROVEEDOR   GGR × el costo    → lo que le pagamos al proveedor
 *   la diferencia          = la ganancia, que se reparte entre Central y Henry
 *
 * Verificado contra la planilla del dueño (API 2026, 6 meses) y contra sus CUENTAS POSTPAGO.
 *
 * ── TRES COSAS QUE NO SON OBVIAS ───────────────────────────────────────────────────────────
 *
 * 1. EL TC DE CADA CUENTA ES DISTINTO. La del cliente va con el promedio del mes; la del
 *    proveedor, en pesos, con el TC que factura el proveedor — salvo SL2 y BVS, que van con el
 *    promedio. No lo inventé: está a la vista en la cuenta de junio de Nacho, donde el mismo
 *    bloque usa 1.420 para Slot Zona y 1.519,31 para SL2.
 *
 * 2. TBS DEVUELVE EL SUBÁRBOL COMPLETO. El profit de una cuenta incluye el de todas sus cajas.
 *    Si una caja se factura aparte (Nacho tiene una), hay que RESTARLA del padre; si no, se le
 *    cobra dos veces: una en su cuenta propia y otra adentro del total de su dueño.
 *
 * 3. ES LENTO. Una consulta por sello, y son ~40. Por eso el GGR se guarda igual que el del
 *    casino: un mes cerrado no cambia, así que se pregunta una vez.
 */
const apiStore = require('./api-store');
const casinoConex = require('./casino-conexiones-store');
const tcUnico = require('./tc-unico.service');
const ganCache = require('./ganancias-cache');
const money = require('./lib/money');

/** El rango del mes tal como lo espera el panel. */
function rango(mes) {
  const m = String(mes).slice(0, 7);
  const ult = new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0)).getUTCDate();
  return { desde: `${m}-01 00:00:00`, hasta: `${m}-${String(ult).padStart(2, '0')} 23:59:59` };
}

function conexionTBS() {
  const cx = casinoConex.list().find((c) => c.motor === 'tbs' && c.activa);
  if (!cx) return { ok: false, error: 'no hay ninguna conexión con motor TBS configurada' };
  const cli = casinoConex.client(cx.id);
  if (!cli) return { ok: false, error: `"${cx.nombre}" no tiene credenciales cargadas` };
  return { ok: true, cx, cli };
}

/** Los sellos que hace falta consultar: los que alguien tiene con precio. */
function sellosEnUso() {
  const { sellos, celdas } = apiStore.matriz();
  const usados = new Set();
  Object.values(celdas).forEach((ss) => Object.keys(ss).forEach((s) => usados.add(s)));
  return sellos.filter((s) => s.grupo_id && usados.has(s.nombre));
}

/**
 * LOS GRUPOS QUE TBS RECONOCE DE VERDAD.
 *
 * Esto existe por una razón cara. El sello "Pragmatic OP" estaba mapeado al grupo 63, que no
 * figura en el desplegable del panel. TBS, ante un id que no conoce, NO devuelve vacío ni un
 * error: IGNORA EL FILTRO y devuelve el profit de todos los proveedores juntos. O sea que ese
 * sello facturaba el GGR entero del cliente una segunda vez, encima de las líneas buenas. A
 * David le duplicaba la cuenta (1.095,92 en vez de 547,96) y lo mismo a Ars1api.
 *
 * Un filtro que no filtra tiene que ser un error ruidoso, no una línea más en la factura.
 */
let _validos = null;
async function gruposValidos(cli) {
  if (_validos) return _validos;
  const r = await cli.grupos();
  if (!r.ok || !Array.isArray(r.grupos) || !r.grupos.length) return null;  // sin lista, no bloqueo
  _validos = new Set(r.grupos.map((g) => String(g.id)));
  return _validos;
}
function olvidarGrupos() { _validos = null; }

/**
 * Trae el GGR del mes de a pedazos y lo deja guardado.
 * Una consulta por sello devuelve el profit de TODAS las cuentas a la vez, así que se pide por
 * sello y no por cliente: son ~40 llamadas en vez de ~400.
 */
async function precargar({ mes, desde: desdeIdx = 0, limite = 8, refrescar = false,
  confirmar = false } = {}) {
  const m = String(mes || '').slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(m)) return { ok: false, error: 'mes inválido (se espera YYYY-MM)' };
  // ⚠️ Igual que la Foto del comercial: un mes cerrado ya no cambia, y volver a preguntarle a TBS
  // reemplaza lo guardado. Si en el medio falla una llamada, lo bueno se pierde y hay que sacar los
  // ~40 sellos de nuevo, a 2s cada uno. Rehacerlo se puede; hay que pedirlo.
  if (refrescar && ganCache.mesCerrado(m) && !confirmar) {
    return { ok: false, requiereConfirmar: true,
      error: `${m} es un mes cerrado y ya está guardado. Volver a consultarle a TBS REEMPLAZA lo que hay. `
        + 'Confirmá si querés rehacerlo igual.' };
  }
  const c = conexionTBS();
  if (!c.ok) return c;
  const { desde, hasta } = rango(m);

  const sellos = sellosEnUso();
  // Todas las cuentas, incluidas las que se facturan aparte: hay que preguntar por ellas para
  // poder restarlas del padre.
  const agentes = apiStore.listClientes().map((x) => String(x.id));
  const trozo = sellos.slice(desdeIdx, desdeIdx + limite);
  const avisos = [];
  const validos = await gruposValidos(c.cli);

  for (const s of trozo) {
    if (validos && !validos.has(String(s.grupo_id))) {
      avisos.push(`${s.corto || s.nombre}: el grupo ${s.grupo_id} no existe en TBS. NO se factura: `
        + 'con un id desconocido el panel ignora el filtro y devuelve el GGR de todos los proveedores juntos.');
      continue;
    }
    if (!refrescar && ganCache.get(c.cx.id, `_api_${s.grupo_id}`, m, '_todas')) continue;
    try {
      const r = await c.cli.profitDeAgentes({ desde, hasta, agentes, grupos: [String(s.grupo_id)] });
      if (!r.ok) { avisos.push(`${s.corto}: ${r.error}`); continue; }
      const porCuenta = {};
      Object.entries(r.porAgente || {}).forEach(([id, a]) => {
        const d = {};
        Object.entries(a.porDivisa || {}).forEach(([div, v]) => { d[div] = String(v.profit); });
        if (Object.keys(d).length) porCuenta[id] = d;
      });
      ganCache.set(c.cx.id, `_api_${s.grupo_id}`, m, '_todas', porCuenta);
    } catch (e) { avisos.push(`${s.corto}: ${String((e && e.message) || e)}`); }
  }
  const hechos = Math.min(desdeIdx + trozo.length, sellos.length);
  return { ok: true, mes: m, hechos, total: sellos.length, faltan: Math.max(0, sellos.length - hechos), avisos };
}

/**
 * LO QUE SE PAGA CONTRA LO QUE CUESTA.
 *
 * El motor calcula el pago al proveedor con el pct_proveedor de la CELDA, y nunca miraba el costo
 * del SELLO. Por eso 8 celdas de SL2 dijeron "pago 0" durante meses sobre un sello que cuesta 0,50:
 * nadie los cruzaba. Eran ~4.800 USD por mes de costo escondido, contados como ganancia.
 *
 * Cruzarlos no cambia ningún número: sólo hace ruido cuando no coinciden. Va aparte de cuentas()
 * a propósito — no necesita TBS, así que sirve aunque el panel esté caído.
 */
function revisarCostos() {
  const { clientes, sellos, celdas } = apiStore.matriz();
  const porNombre = {}; sellos.forEach((s) => { porNombre[s.nombre] = s; });
  const desalineados = []; const bajoCosto = []; const aceptados = []; const avisos = [];
  clientes.forEach((cl) => {
    if (!cl.activo) return;
    Object.entries(celdas[cl.id] || {}).forEach(([nombre, p]) => {
      const s = porNombre[nombre]; if (!s || s.costo == null) return;
      const quien = `${cl.login} / ${s.corto || nombre}`;
      let falla = null;
      if (p.pct_cliente == null || p.pct_cliente === '') falla = { d: `${quien}: sin precio de cliente`, tipo: 'des' };
      else if (Number(p.pct_proveedor || 0) > Number(p.pct_cliente)) {
        falla = { d: `${quien}: cobra ${p.pct_cliente}% y paga ${p.pct_proveedor}%`, tipo: 'bajo' };
      } else if (Math.abs(Number(p.pct_proveedor || 0) - Number(s.costo)) > 0.001) {
        falla = { d: `${quien}: paga ${p.pct_proveedor || 0}% pero el sello cuesta ${s.costo}%`, tipo: 'des' };
      }
      if (!falla) return;
      // Con nota, es una decisión tomada y no una alarma: sigue a la vista pero no grita.
      if (p.nota) { aceptados.push(`${falla.d} — ${p.nota}`); return; }
      (falla.tipo === 'bajo' ? bajoCosto : desalineados).push(falla.d);
    });
  });
  if (bajoCosto.length) {
    avisos.push(`${bajoCosto.length} celda(s) venden POR DEBAJO del costo, o sea que cada GGR es pérdida: ${bajoCosto.join(' · ')}`);
  }
  if (desalineados.length) {
    avisos.push(`${desalineados.length} celda(s) no pagan lo que el sello cuesta: ${desalineados.join(' · ')}`);
  }
  return { ok: true, desalineados, bajoCosto, aceptados, avisos };
}

/**
 * CORTE POR DIVISA.
 *
 * Una regla que no se puede violar: el GGR local sólo se suma DENTRO de la misma divisa. Sumar
 * los GGR de ARS y PYG da un número que no significa nada. Entre divisas lo único sumable es el
 * equivalente en dólares. Por eso el subtotal lleva las dos cosas y el total del cliente sólo la
 * segunda.
 *
 * El TC del cliente es uno por divisa y por mes, así que va en la cabecera del bloque. El del
 * proveedor puede variar entre sellos de la misma divisa (SL2 va con el promedio y Slot Zona con
 * el del proveedor), y cuando eso pasa se dice en vez de mostrar uno cualquiera.
 */
function porDivisaDe(lineas) {
  const ix = new Map();
  lineas.forEach((l) => {
    let g = ix.get(l.divisa);
    if (!g) {
      g = { divisa: l.divisa, tc_cliente: l.tc_cliente, tc_proveedor: null, tc_proveedor_varios: false,
        ggr: '0', ggr_usd: '0', usdt_cliente: '0', usdt_proveedor: '0', usdt_empresa: '0', lineas: [] };
      ix.set(l.divisa, g);
    }
    g.lineas.push(l);
    g.ggr = money.add(g.ggr, l.ggr);
    g.ggr_usd = money.add(g.ggr_usd, l.ggr_usd || '0');
    g.usdt_cliente = money.add(g.usdt_cliente, l.usdt_cliente);
    g.usdt_proveedor = money.add(g.usdt_proveedor, l.usdt_proveedor);
    g.usdt_empresa = money.add(g.usdt_empresa, l.usdt_empresa);
    if (l.tc_proveedor) {
      if (g.tc_proveedor == null) g.tc_proveedor = l.tc_proveedor;
      else if (g.tc_proveedor !== l.tc_proveedor) g.tc_proveedor_varios = true;
    }
  });
  return [...ix.values()].sort((a, b) => Number(b.usdt_cliente) - Number(a.usdt_cliente));
}

/** Suma dos bloques de cuenta (la caja + el resto = el total). */
function sumarBloques(a, b) {
  const lineas = [...a.lineas, ...b.lineas];
  return {
    lineas,
    porDivisa: porDivisaDe(lineas),
    usdt_cliente: money.round(money.add(a.usdt_cliente, b.usdt_cliente), 2),
    usdt_proveedor: money.round(money.add(a.usdt_proveedor, b.usdt_proveedor), 2),
    usdt_empresa: money.round(money.add(a.usdt_empresa, b.usdt_empresa), 2),
    sinVerificar: (a.sinVerificar || 0) + (b.sinVerificar || 0),
  };
}

/**
 * Las dos cuentas del mes.
 * @returns { ok, mes, cuentas[], totales, sinPrecio[], sinTC[], avisos[] }
 */
function cuentas({ mes, cliente_id = null } = {}) {
  const m = String(mes || '').slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(m)) return { ok: false, error: 'mes inválido (se espera YYYY-MM)' };
  const c = conexionTBS();
  if (!c.ok) return c;

  const { clientes, sellos, celdas } = apiStore.matriz();
  const porNombre = {}; sellos.forEach((s) => { porNombre[s.nombre] = s; });

  // El GGR guardado, sello por sello: { grupo → { cuenta → { divisa → profit } } }
  const ggr = {}; const sinTraer = [];
  sellosEnUso().forEach((s) => {
    const hit = ganCache.get(c.cx.id, `_api_${s.grupo_id}`, m, '_todas');
    if (hit) ggr[s.grupo_id] = hit.filas; else sinTraer.push(s.corto);
  });

  const out = []; const sinPrecio = []; const sinTC = new Set(); const avisos = [];
  let totCli = '0'; let totProv = '0';

  for (const cl of clientes) {
    if (!cl.activo) continue;
    if (cliente_id && String(cl.id) !== String(cliente_id)) continue;
    const precios = celdas[cl.id] || {};
    const lineas = []; let uCli = '0'; let uProv = '0';

    for (const [nombre, p] of Object.entries(precios)) {
      const s = porNombre[nombre];
      if (!s || !s.grupo_id) continue;
      const porCuenta = ggr[s.grupo_id];
      if (!porCuenta) continue;                       // ese sello todavía no se trajo
      const mio = porCuenta[String(cl.id)] || {};

      for (const [divisa, profitRaw] of Object.entries(mio)) {
        let profit = String(profitRaw);
        // Las cajas que se facturan aparte se restan: TBS ya las contó adentro de su dueño.
        (cl.excluye || []).forEach((id) => {
          const suyo = (porCuenta[String(id)] || {})[divisa];
          if (suyo) profit = money.sub(profit, String(suyo));
        });
        // UN PROVEEDOR EN NEGATIVO VA EN CERO, NUNCA SE RESTA. Regla del dueño, para todos los
        // clientes de TBS: si en un mes los jugadores le ganaron a un proveedor, ese proveedor no
        // se factura y listo — la pérdida no le baja la cuenta al cliente. Ojo al verificar contra
        // el TOTAL del panel: ese total SÍ netea los negativos, así que va a dar menos que la suma
        // de los proveedores facturados. No es un descuadre. En julio la caja de Nacho perdió
        // 182.513.445 ARS en Slot Zona y por eso su total cierra 182M por debajo de lo facturable.
        if (!money.isPos(profit)) continue;

        const tcC = tcUnico.tcDelMes(divisa, m);
        // El TC del proveedor: en pesos el suyo, salvo SL2 y BVS. Se le pasa el nombre CORTO
        // porque es el que dice de qué familia es.
        const tcP = tcUnico.tcExternos(divisa, m, s.corto || s.nombre);
        if (!tcC.valor) { sinTC.add(divisa); continue; }

        const mCli = money.round(money.pct(profit, String(p.pct_cliente || '0')), 2);
        const mProv = money.round(money.pct(profit, String(p.pct_proveedor || '0')), 2);
        const usdCli = money.round(money.div(mCli, tcC.valor), 2);
        const usdProv = tcP.valor ? money.round(money.div(mProv, tcP.valor), 2) : '0';
        const usdEmp = money.round(money.sub(usdCli, usdProv), 2);

        // El GGR en dólares se saca del profit CRUDO, no del redondeado: si no, los centavos no
        // cierran contra usdt_cliente y el número que sirve para auditar es justo el que miente.
        const ggrUsd = money.round(money.div(profit, tcC.valor), 2);

        uCli = money.add(uCli, usdCli); uProv = money.add(uProv, usdProv);
        lineas.push({
          sello: s.corto || s.nombre, sello_largo: s.nombre, tipo: s.tipo, divisa,
          ggr: money.round(profit, 2), ggr_crudo: profit,
          pct_cliente: p.pct_cliente, pct_proveedor: p.pct_proveedor, origen: p.origen,
          monto_cliente: mCli, tc_cliente: tcC.valor, usdt_cliente: usdCli,
          monto_proveedor: mProv, tc_proveedor: tcP.valor || null, usdt_proveedor: usdProv,
          // usdt_empresa ya es "Henry incluido": Henry dejó de ser participante y se fusionó
          // adentro de Empresa, así que la partición en central/henry se fue. La columna que el
          // dueño quiere ver es una sola.
          usdt_empresa: usdEmp, ggr_usd: ggrUsd, costo_sello: s.costo == null ? null : String(s.costo),
        });
      }
    }
    // Lo que produjo GGR y no tiene precio: es plata que no se le está cobrando.
    Object.entries(ggr).forEach(([grupo, porCuenta]) => {
      const mio = porCuenta[String(cl.id)];
      if (!mio) return;
      const s = sellos.find((x) => String(x.grupo_id) === String(grupo));
      if (!s || precios[s.nombre]) return;
      const hay = Object.values(mio).some((v) => money.isPos(String(v)));
      if (hay) sinPrecio.push({ cuenta: cl.login, sello: s.corto, porDivisa: mio });
    });

    if (!lineas.length) continue;
    lineas.sort((a, b) => Number(b.usdt_cliente) - Number(a.usdt_cliente));
    out.push({
      cliente_id: cl.id, login: cl.login, alias: cl.alias, agente: cl.agente,
      padre_id: cl.padre_id || null,
      lineas, porDivisa: porDivisaDe(lineas),
      usdt_cliente: money.round(uCli, 2),
      usdt_proveedor: money.round(uProv, 2),
      usdt_empresa: money.round(money.sub(uCli, uProv), 2),
      sinVerificar: lineas.filter((l) => l.origen !== 'verificado').length,
    });
    totCli = money.add(totCli, uCli); totProv = money.add(totProv, uProv);
  }

  // ── LAS CAJAS ADENTRO DE SU DUEÑO ──────────────────────────────────────────────────────────
  // MULT2-CAL-ARS-PROD no es otro cliente: es la caja de Nacho, a la que se le entrega una cuenta
  // aparte. Con padre_id deja de figurar como un cliente suelto y pasa a ser un bloque adentro del
  // suyo, con las tres vistas que hacen falta: la caja sola, el resto solo, y el TOTAL de las dos.
  // El `excluye` NO se toca: es lo que hace que las líneas del padre sean el neto (TBS devuelve el
  // subárbol completo). Por eso caja + resto da exactamente el mismo total que antes.
  const porId = {}; out.forEach((c) => { porId[String(c.cliente_id)] = c; });
  const anidados = [];
  out.forEach((c) => {
    if (!c.padre_id) return;
    const padre = porId[String(c.padre_id)];
    if (!padre) return;                      // el padre no facturó este mes: la caja queda suelta
    (padre.cajas = padre.cajas || []).push(c);
    anidados.push(String(c.cliente_id));
  });
  const raiz = out.filter((c) => !anidados.includes(String(c.cliente_id)));
  raiz.forEach((c) => {
    if (!c.cajas) return;
    c.propio = { lineas: c.lineas, porDivisa: c.porDivisa, usdt_cliente: c.usdt_cliente,
      usdt_proveedor: c.usdt_proveedor, usdt_empresa: c.usdt_empresa, sinVerificar: c.sinVerificar };
    c.total = c.cajas.reduce((acc, k) => sumarBloques(acc, k), c.propio);
  });

  if (sinTraer.length) {
    avisos.push(`${sinTraer.length} sello(s) todavía sin traer de TBS (${sinTraer.slice(0, 6).join(', ')}${sinTraer.length > 6 ? '…' : ''}). El total está incompleto hasta traerlos.`);
  }
  // Un sello con precio pero sin grupo no se le puede preguntar a TBS: no factura, y en silencio.
  // Mejor decirlo, que es plata que alguien está usando y no se está cobrando.
  const conPrecio = new Set();
  Object.values(celdas).forEach((ss) => Object.keys(ss).forEach((n) => conPrecio.add(n)));
  const sinGrupo = sellos.filter((s) => !s.grupo_id && conPrecio.has(s.nombre)).map((s) => s.corto || s.nombre);
  if (sinGrupo.length) {
    avisos.push(`${sinGrupo.length} sello(s) tienen precio cargado pero no están mapeados a ningún grupo de TBS `
      + `(${sinGrupo.join(', ')}). No se factura nada de eso hasta saber a qué proveedor corresponden.`);
  }

  const rev = revisarCostos();
  avisos.push(...rev.avisos);
  const { desalineados, bajoCosto, aceptados } = rev;
  raiz.sort((a, b) => Number((b.total || b).usdt_cliente) - Number((a.total || a).usdt_cliente));
  return {
    ok: true, mes: m,
    cuentas: raiz,
    totales: {
      cliente: money.round(totCli, 2),
      proveedor: money.round(totProv, 2),
      empresa: money.round(money.sub(totCli, totProv), 2),
    },
    sinPrecio, sinTC: [...sinTC], faltanSellos: sinTraer, desalineados, bajoCosto, aceptados, avisos,
  };
}

module.exports = { precargar, cuentas, rango, sellosEnUso, gruposValidos, olvidarGrupos, revisarCostos };
