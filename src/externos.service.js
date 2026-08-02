/**
 * externos.service.js — §9 PROVEEDORES EXTERNOS: cuánto hay que cobrarle a cada cliente.
 *
 * IDEA: el cliente paga su % base sobre lo que carga. Pero algunos proveedores de juegos cuestan
 * más que ese %, así que la diferencia se le cobra aparte, sobre las GANANCIAS que ese proveedor
 * generó EN ESE PANEL.
 *
 *   Diferencial% = (% del proveedor PARA ESE CLIENTE)  −  (% base del cliente)     [piso 0]
 *   Monto        = Ganancias del proveedor en el panel × Diferencial%
 *   USDT         = Monto / TC promedio del mes de la divisa del panel
 *
 * Si el proveedor cuesta igual o menos que el % base, NO se cobra. Si el proveedor dio pérdida
 * tampoco se cobra, y NO se arrastra al mes siguiente.
 *
 * De dónde sale cada dato:
 *   · % del proveedor para el cliente → la MATRIZ del cierre (`cierre_pct`), que es la planilla.
 *   · % base del cliente              → se CONFIRMA por mes (cambia: un mes 6%, otro 7%).
 *   · ganancias por proveedor y panel → el casino (`reporteProveedoresNodo`).
 *   · TC del mes                      → `cierre_tc`.
 *
 * ⚠️ Los nombres de proveedor del casino NO son los de la matriz: se traducen con `cierre_link`.
 */
const paneles = require('./paneles-store');
const clientes = require('./clientes-store');
const cierre = require('./cierre-store');
const cierreMes = require('./cierre-mes.service');
const historial = require('./historial');
const casinoConex = require('./casino-conexiones-store');
const money = require('./lib/money');
const { db } = require('./db');

const K = (s) => String(s || '').trim().toLowerCase();
const MESES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];

/** '2026-07' → 'Julio_2026'. Los meses del cierre se llaman así, no en ISO. */
function mesCierre(iso) {
  const [y, m] = String(iso || '').split('-');
  return MESES[Number(m) - 1] ? `${MESES[Number(m) - 1]}_${y}` : String(iso);
}
/** Primer y último día del mes ISO, que es lo que pide el casino. */
function rango(iso) {
  const [y, m] = String(iso).split('-').map(Number);
  const ult = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${iso}-01`, to: `${iso}-${String(ult).padStart(2, '0')}` };
}

/**
 * TC del mes para una divisa. Tolerante con cómo se escribió el mes en el histórico
 * (Julio_2026, ABRIL_2026, Enero_26…). USD y USDT valen 1 aunque no estén cargados.
 */
function tcDe(moneda, iso) {
  const M = String(moneda || '').toUpperCase();
  if (M === 'USD' || M === 'USDT') return '1';
  const tc = cierre.getTC();
  const buscado = K(mesCierre(iso));
  const corto = buscado.replace(/_20/, '_');            // julio_2026 → julio_26
  const fila = tc.tasas[M] || tc.tasas[M.toUpperCase()];
  if (!fila) return null;
  for (const [mes, tasa] of Object.entries(fila)) {
    const k = K(mes);
    if (k === buscado || k === corto) return tasa;
  }
  return null;
}

/**
 * El % de proveedor que le corresponde a ESE cliente, CON LOS PRECIOS DE ESE MES.
 * Si el mes está congelado se usa su foto; si no, la matriz viva. Sin esto, cambiar un precio hoy
 * cambiaría lo que calcula un mes ya facturado.
 */
function pctsDelCliente(nombreCliente, mes) {
  const p = cierreMes.preciosDe(mes);
  const out = {};
  for (const [prov, fila] of Object.entries(p.celdas || {})) {
    const pct = fila && fila[nombreCliente];
    if (pct != null && pct !== '') out[K(prov)] = pct;
  }
  return {
    celdas: out,
    congelado: p.congelado, congeladoEn: p.congeladoEn,
    proveedores: Object.entries(p.costo).map(([nombre, base_pct]) => ({ nombre, base_pct })),
  };
}

/** Traduce el nombre de proveedor del casino al de la matriz (cierre_link). */
function traductor(precios) {
  // Los nombres válidos y los vínculos salen DEL MES: si están congelados se usan esos. Si no,
  // agregar un proveedor hoy haría que un nombre del casino se resuelva distinto y un mes ya
  // cerrado cambiaría de número (pasó: Titan junio se movió de 7.150 a 6.628).
  const links = {};
  const fuenteLinks = (precios && precios.links) || db.prepare('SELECT casino, matriz FROM cierre_link').all();
  fuenteLinks.forEach((r) => { if (r.matriz) links[K(r.casino)] = r.matriz; });
  const nombres = (precios && precios.costo) ? Object.keys(precios.costo)
    : db.prepare('SELECT nombre FROM cierre_proveedor').all().map((r) => r.nombre);
  const dela = new Set(nombres.map((n) => K(n)));
  return (fila) => {
    const marca = String(fila.label || fila.provider || '').trim();
    const vendor = String(fila.vendor || '').trim();
    const conVendor = `${marca} ${vendor}`.trim();
    if (links[K(conVendor)]) return links[K(conVendor)];
    if (dela.has(K(conVendor))) return conVendor;
    if (links[K(marca)]) return links[K(marca)];
    if (dela.has(K(marca))) return marca;
    return null;                                        // sin vincular: se informa aparte
  };
}

// ── % base confirmado por MES ────────────────────────────────────────────────
// El % de un cliente cambia de un mes a otro (un mes 6, otro 7) pero su costo de proveedores casi
// nunca. Por eso el % se confirma POR MES y no se toca el histórico hacia atrás.
function baseGuardada(cliente, mes) {
  const r = db.prepare('SELECT base_pct, confirmadoAt FROM externos_base_mes WHERE cliente=? AND mes=?').get(String(cliente), String(mes));
  return r || null;
}
function confirmarBase(cliente, mes, base_pct) {
  db.prepare(`INSERT INTO externos_base_mes (cliente,mes,base_pct,confirmadoAt) VALUES (?,?,?,?)
              ON CONFLICT(cliente,mes) DO UPDATE SET base_pct=excluded.base_pct, confirmadoAt=excluded.confirmadoAt`)
    .run(String(cliente), String(mes), String(base_pct), new Date().toISOString());
  return baseGuardada(cliente, mes);
}

/**
 * El reporte de un cliente para un mes.
 * @returns { cliente, mes, base, baseConfirmada, paneles[], totales, sinVincular[], avisos[] }
 */
async function reporte({ clienteNombre, mes, basePct = null }) {
  const cli = clientes.list().clientes.find((c) => K(c.nombre) === K(clienteNombre));
  if (!cli) return { ok: false, error: `no existe el cliente "${clienteNombre}"` };

  // % base: el que mandan, si no el confirmado del mes, si no el de la ficha del cliente
  const guardada = baseGuardada(cli.nombre, mes);
  const deLaFicha = historial.getVigente('cliente', cli.id, 'precio_base_pct');
  const base = basePct != null ? String(basePct) : (guardada ? guardada.base_pct : (deLaFicha != null ? String(deLaFicha) : null));
  if (base == null) {
    return { ok: false, error: `"${cli.nombre}" no tiene % base cargado. Confirmalo antes de calcular.`, faltaBase: true };
  }

  const { celdas, proveedores, congelado, congeladoEn } = pctsDelCliente(cli.nombre, mes);
  const costoDe = {}; proveedores.forEach((p) => { costoDe[K(p.nombre)] = p.base_pct; });
  const traducir = traductor(cierreMes.preciosDe(mes));
  const { from, to } = rango(mes);
  const mios = paneles.list().filter((p) => p.cliente_id === cli.id);

  // Cómo se lee la celda de la matriz para ESTE cliente.
  const modo = cli.es_vendedor ? 'vendedor' : (cli.externos_modo || 'total');

  const filas = [];            // una por panel+proveedor+divisa
  const sinVincular = new Map();
  const negativos = new Map(); // proveedor con % MENOR que la base → generaría negativo
  const avisos = [];
  const cache = new Map();

  for (const panel of mios) {
    const cx = casinoConex.list().find((c) => c.id === panel.conexion_id) || casinoConex.list().find((c) => K(c.nombre) === K(panel.sistema));
    if (!cx) { avisos.push(`${panel.nombre}: sin conexión de casino, no se pudo consultar`); continue; }
    const cliCx = casinoConex.client(cx.id);
    if (!cliCx) { avisos.push(`${panel.nombre}: la conexión "${cx.nombre}" no responde`); continue; }

    // Un SuperAgente puede tener varias divisas; de un Distribuidor/Agente para abajo hay UNA sola.
    const divisas = (panel.divisas || []).length ? panel.divisas : ['ARS'];
    for (const divisa of divisas) {
      const clave = `${cx.id}|${panel.id_usuario}|${mes}|${divisa}`;
      let r = cache.get(clave);
      if (!r) {
        r = await cliCx.reporteProveedoresNodo({ nodoId: panel.id_usuario, from, to, currency: divisa });
        cache.set(clave, r);
      }
      if (!r.ok) { avisos.push(`${panel.nombre} (${divisa}): ${r.error}`); continue; }
      const tasa = tcDe(divisa, mes);

      for (const f of (r.filas || [])) {
        const profit = String(f.profit || '0');
        if (money.cmp(profit, '0') <= 0) continue;              // pérdida o cero: no se cobra, sin arrastre
        const nombreMatriz = traducir(f);
        if (!nombreMatriz) {
          const k = `${f.label || f.provider} ${f.vendor}`.trim();
          sinVincular.set(k, money.add(sinVincular.get(k) || '0', profit));
          continue;
        }
        const pct = celdas[K(nombreMatriz)];
        if (pct == null) continue;                              // el cliente no tiene ese proveedor
        // La celda de la matriz se lee DISTINTO según el cliente (regla del dueño):
        //   · vendedor  → paga el PRECIO REAL del proveedor, sin importar la celda
        //   · adicional → la celda YA ES lo que se le suma (Oscar, Luis, Marcelo, JJ…)
        //   · total     → la celda es el precio final y se le resta su % base (Titan, Juan…)
        const costoProv = costoDe[K(nombreMatriz)];
        const dif = modo === 'vendedor' ? (costoProv ?? '0')
          : modo === 'adicional' ? pct
            : money.sub(pct, base);
        const cobra = money.cmp(dif, '0') > 0;
        // Aviso: un cliente que hoy trabaja al 7% no puede tener un proveedor en 6 → daría negativo.
        if (modo === 'total' && money.cmp(pct, base) < 0) {
          negativos.set(nombreMatriz, { proveedor: nombreMatriz, pct, base });
        }
        const monto = cobra ? money.round(money.pct(profit, dif), 2) : '0';
        filas.push({
          panel: panel.nombre, panel_id: panel.id, nivel: panel.nivel_usuario, sistema: panel.sistema,
          divisa, proveedor: nombreMatriz, proveedorCasino: `${f.label || f.provider} ${f.vendor}`.trim(),
          costo: costoDe[K(nombreMatriz)] ?? null,
          profit, pct, base, dif, cobra, monto,
          tasa, usdt: (cobra && tasa) ? money.round(money.div(monto, tasa), 2) : '0',
          sinTasa: cobra && !tasa,
        });
        if (cobra && !tasa) avisos.push(`falta el TC de ${divisa} para ${mesCierre(mes)} — ese monto no se pudo pasar a USDT`);
      }
    }
  }

  // agrupar por panel, como el PDF
  const porPanel = new Map();
  for (const f of filas) {
    if (!porPanel.has(f.panel)) porPanel.set(f.panel, { panel: f.panel, nivel: f.nivel, sistema: f.sistema, divisa: f.divisa, items: [], total: '0', usdt: '0' });
    const g = porPanel.get(f.panel);
    g.items.push(f);
    if (f.cobra) { g.total = money.add(g.total, f.monto); g.usdt = money.add(g.usdt, f.usdt); }
  }
  const listaPaneles = [...porPanel.values()].sort((a, b) => money.cmp(b.usdt, a.usdt));
  const totalUsdt = money.sum(filas.filter((f) => f.cobra).map((f) => f.usdt));

  return {
    ok: true,
    cliente: cli.nombre, clienteId: cli.id, mes, mesNombre: mesCierre(mes), from, to,
    congelado, congeladoEn,
    base, baseConfirmada: !!guardada, confirmadoAt: guardada ? guardada.confirmadoAt : null,
    modo,
    negativos: [...negativos.values()],
    esVendedor: !!cli.es_vendedor,
    margenExtra: cli.margen_externos_pct ?? null,
    paneles: listaPaneles,
    cobrables: filas.filter((f) => f.cobra).length,
    revisados: filas.length,
    totalUsdt: money.round(totalUsdt, 2),
    sinVincular: [...sinVincular.entries()].map(([nombre, profit]) => ({ nombre, profit })).sort((a, b) => money.cmp(b.profit, a.profit)),
    avisos: [...new Set(avisos)],
  };
}

module.exports = { reporte, baseGuardada, confirmarBase, tcDe, mesCierre, rango };
