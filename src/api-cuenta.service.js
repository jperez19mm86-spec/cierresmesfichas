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
async function precargar({ mes, desde: desdeIdx = 0, limite = 8, refrescar = false } = {}) {
  const m = String(mes || '').slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(m)) return { ok: false, error: 'mes inválido (se espera YYYY-MM)' };
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

        // El reparto: los puntos suman lo que queda, así que reparten esa ganancia y nada más.
        const ib = Number(p.pts_ib || 0); const hen = Number(p.pts_henry || 0);
        const pts = ib + hen;
        const usdIb = pts ? money.round(money.mul(usdEmp, String(ib / pts)), 2) : null;
        const usdHen = pts ? money.round(money.sub(usdEmp, usdIb), 2) : null;

        uCli = money.add(uCli, usdCli); uProv = money.add(uProv, usdProv);
        lineas.push({
          sello: s.corto || s.nombre, sello_largo: s.nombre, tipo: s.tipo, divisa,
          ggr: money.round(profit, 2),
          pct_cliente: p.pct_cliente, pct_proveedor: p.pct_proveedor, origen: p.origen,
          monto_cliente: mCli, tc_cliente: tcC.valor, usdt_cliente: usdCli,
          monto_proveedor: mProv, tc_proveedor: tcP.valor || null, usdt_proveedor: usdProv,
          usdt_empresa: usdEmp, usdt_central: usdIb, usdt_henry: usdHen,
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
      lineas,
      usdt_cliente: money.round(uCli, 2),
      usdt_proveedor: money.round(uProv, 2),
      usdt_empresa: money.round(money.sub(uCli, uProv), 2),
      sinVerificar: lineas.filter((l) => l.origen !== 'verificado').length,
    });
    totCli = money.add(totCli, uCli); totProv = money.add(totProv, uProv);
  }

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
  out.sort((a, b) => Number(b.usdt_cliente) - Number(a.usdt_cliente));
  return {
    ok: true, mes: m,
    cuentas: out,
    totales: {
      cliente: money.round(totCli, 2),
      proveedor: money.round(totProv, 2),
      empresa: money.round(money.sub(totCli, totProv), 2),
    },
    sinPrecio, sinTC: [...sinTC], faltanSellos: sinTraer, avisos,
  };
}

module.exports = { precargar, cuentas, rango, sellosEnUso, gruposValidos, olvidarGrupos };
