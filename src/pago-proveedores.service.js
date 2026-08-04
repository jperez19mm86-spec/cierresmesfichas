/**
 * pago-proveedores.service.js — CUÁNTO LE PAGAMOS NOSOTROS A CADA PROVEEDOR (§ punto 8).
 *
 * Es el otro lado de la factura de externos. Aquella cobra al cliente
 * `ganancia × (su celda − su % base)`; ésta paga al proveedor `ganancia × su COSTO`.
 * La ganancia es la misma, el porcentaje es otro.
 *
 * ── La cuenta, tal como la hacía el dueño a mano ───────────────────────────────────────────
 *     Profit × %costo = Monto en la divisa
 *     Monto ÷ TC de esa divisa = USDT
 * Verificado contra su planilla de junio (`Henry [henry_support] - Profit.csv`), fila por fila:
 *     3OAKS_OP Europa ARS → 907.286 × 8,5% = 77.119,31 ÷ 1420 = 54,3 ✓
 *
 * ── De dónde sale la ganancia ──────────────────────────────────────────────────────────────
 * · CASINO y EUROPA (engine 463): `reporteProveedores` en vista GENERAL (`userGroupBy: ''`),
 *   que da el profit de TODA la plataforma por proveedor. Es la misma consulta que hace el
 *   panel en Estadísticas → "Datos generales".
 * · TBS: otro motor y otra granularidad — reporta por GRUPO de proveedores, no por proveedor
 *   suelto. Se resuelve aparte (ver `TBS_PENDIENTE` abajo).
 *
 * ── El nombre del proveedor ────────────────────────────────────────────────────────────────
 * Se traduce casino→matriz con `externosSvc.traductor`, EL MISMO que usa la factura del cliente.
 * Si fueran dos traductores, los dos lados del mismo proveedor podrían resolverse distinto.
 *
 * ⚠️ El sufijo ES el producto: `3OAKS SL`, `3OAKS SL2` y `3OAKS OP` son proveedores distintos
 * y cuestan 0 / 0,5 / 8,5. Nunca emparejar por parecido de nombre.
 */
const casinoConex = require('./casino-conexiones-store');
const cierre = require('./cierre-store');
const cierreMes = require('./cierre-mes.service');
const externosSvc = require('./externos.service');
const tcUnico = require('./tc-unico.service');
const money = require('./lib/money');

const K = (s) => String(s || '').trim().toLowerCase();

/**
 * TBS reporta por GRUPO (53 grupos: el id 10 es el paquete SL, 118 el BVS, 60 el SL2…), no por
 * proveedor suelto. Para cobrarlo hace falta decir qué fila de la matriz corresponde a cada
 * grupo — típicamente las filas `_ALL`, que son justamente el costo por defecto del grupo.
 * Ese mapeo todavía no existe: hasta que el dueño lo defina, TBS se informa aparte y NO se suma,
 * en vez de inventar una correspondencia y facturar sobre una suposición.
 */
const TBS_PENDIENTE = 'TBS reporta por grupo de proveedores; falta decir qué fila de la matriz corresponde a cada grupo';

/**
 * Lo que le pagamos a cada proveedor en un mes.
 * @param mes      'YYYY-MM'
 * @param monedas  qué divisas consultar (null = las que el conector conoce)
 * @returns { ok, mes, proveedores[], totales, porConexion, sinCosto[], sinVincular[], sinTC[], avisos[] }
 */
async function reporte({ mes, monedas = null } = {}) {
  const m = String(mes || '').slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(m)) return { ok: false, error: 'mes inválido (se espera YYYY-MM)' };
  const { from, to } = externosSvc.rango(m);
  const desde = `${from} 00:00:00`; const hasta = `${to} 23:59:59`;

  // Los precios DEL MES: si está congelado manda la foto, para que un mes cerrado no se mueva.
  const precios = cierreMes.preciosDe(m);
  const traducir = externosSvc.traductor(precios);
  const costoDe = {};
  if (precios && precios.costo && Object.keys(precios.costo).length) {
    Object.entries(precios.costo).forEach(([n, c]) => { costoDe[K(n)] = c; });
  } else {
    cierre.getMatriz().proveedores.forEach((p) => { costoDe[K(p.nombre)] = p.base_pct; });
  }

  const acc = new Map();         // nombreMatriz → { proveedor, costo, lineas[], usdt }
  const porConexion = {};
  const sinVincular = new Map(); // lo que el casino informa y no está en la matriz
  const sinCosto = new Set();    // está en la matriz pero sin costo cargado
  const sinTC = new Set();
  const avisos = [];

  for (const cx of casinoConex.list463()) {
    if (!cx.activa) continue;
    const cli = casinoConex.client(cx.id);
    if (!cli) { avisos.push(`${cx.nombre}: sin credenciales`); continue; }
    let r;
    try { r = await cli.reporteProveedoresMonedas({ from: desde, to: hasta, currencies: monedas, userGroupBy: '' }); }
    catch (e) { avisos.push(`${cx.nombre}: ${String((e && e.message) || e)}`); continue; }
    if (!r || !r.ok) { avisos.push(`${cx.nombre}: ${(r && r.error) || 'no respondió'}`); continue; }

    porConexion[cx.nombre] = { usdt: '0', filas: 0 };
    for (const [divisa, res] of Object.entries(r.monedas || {})) {
      if (!res || !res.ok) { if (res && res.error) avisos.push(`${cx.nombre} ${divisa}: ${res.error}`); continue; }
      const tc = tcUnico.tcDelMes(divisa, m);
      for (const fila of res.filas || []) {
        const profit = String(fila.profit ?? '0');
        if (!money.isPos(profit)) continue;                    // pérdida o cero: no se paga
        const nombre = traducir(fila);
        if (!nombre) {
          const k = `${fila.label || fila.provider || ''} ${fila.vendor || ''}`.trim();
          const v = sinVincular.get(k) || { nombre: k, profit: '0', conexiones: new Set() };
          v.profit = money.add(v.profit, profit); v.conexiones.add(cx.nombre);
          sinVincular.set(k, v);
          continue;
        }
        const costo = costoDe[K(nombre)];
        if (costo == null || costo === '') { sinCosto.add(nombre); continue; }
        if (!money.isPos(String(costo))) continue;             // costo 0 = no nos cobra nada
        if (!tc.valor) { sinTC.add(divisa); continue; }

        const monto = money.round(money.pct(profit, String(costo)), 2);
        const usdt = money.round(money.div(monto, tc.valor), 2);
        const a = acc.get(nombre) || { proveedor: nombre, costo: String(costo), usdt: '0', lineas: [] };
        a.usdt = money.add(a.usdt, usdt);
        a.lineas.push({ conexion: cx.nombre, divisa, profit: money.round(profit, 2), monto, tc: tc.valor, usdt });
        acc.set(nombre, a);
        porConexion[cx.nombre].usdt = money.add(porConexion[cx.nombre].usdt, usdt);
        porConexion[cx.nombre].filas += 1;
      }
    }
    porConexion[cx.nombre].usdt = money.round(porConexion[cx.nombre].usdt, 2);
  }

  const proveedores = [...acc.values()]
    .map((a) => ({ ...a, usdt: money.round(a.usdt, 2), lineas: a.lineas.sort((x, y) => Number(y.usdt) - Number(x.usdt)) }))
    .sort((a, b) => Number(b.usdt) - Number(a.usdt));

  const total = money.round(money.sum(proveedores.map((p) => p.usdt)), 2);
  const tbs = casinoConex.list().filter((c) => c.motor === 'tbs' && c.activa);
  if (tbs.length) avisos.push(`${TBS_PENDIENTE} — ${tbs.map((c) => c.nombre).join(', ')} NO está incluido en este total`);

  return {
    ok: true, mes: m, desde, hasta,
    congelado: !!(precios && precios.congelado),
    proveedores, porConexion,
    totales: { usdt: total, proveedores: proveedores.length },
    sinVincular: [...sinVincular.values()].map((v) => ({ nombre: v.nombre, profit: money.round(v.profit, 2), conexiones: [...v.conexiones] }))
      .sort((a, b) => Number(b.profit) - Number(a.profit)),
    sinCosto: [...sinCosto], sinTC: [...sinTC], avisos,
    tbsPendiente: tbs.length ? TBS_PENDIENTE : null,
  };
}

/** El mismo reporte en el CSV que el dueño ya usa, para no perder el formato de siempre. */
function csv(rep) {
  const esc = (s) => { const t = String(s ?? ''); return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
  const filas = [['Month/Year', 'Server', 'Currency', 'Proveedor', '%', 'Profit', 'Monto Divisa', 'Ex Rate', 'Total USDT']];
  (rep.proveedores || []).forEach((p) => (p.lineas || []).forEach((l) => {
    filas.push([rep.mes, l.conexion, l.divisa, p.proveedor, p.costo, l.profit, l.monto, l.tc, l.usdt]);
  }));
  filas.push([]);
  filas.push(['', '', '', 'TOTAL', '', '', '', '', rep.totales.usdt]);
  return filas.map((f) => f.map(esc).join(',')).join('\n');
}

module.exports = { reporte, csv, TBS_PENDIENTE };
