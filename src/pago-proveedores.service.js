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
 *   suelto. Se resuelve aparte, en `lineasTBS` (ver el bloque TBS abajo), y se suma a este total.
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
 * ── TBS ────────────────────────────────────────────────────────────────────────────────────
 *
 * Reporta por GRUPO de proveedores, no por proveedor suelto: el panel expone 52 grupos con un
 * nombre interno (`slgames2`, `goldenneo`, `op_kagaming`…) que no se parece al de la matriz.
 *
 * El mapeo NO se adivinó por parecido de nombre. Se consultó junio-2026 grupo por grupo con los
 * 4 agentes del dueño y se comparó contra su planilla (`Henry [henry_support] - Profit.csv`).
 * Las divisas chicas son las que no dejan lugar a duda:
 *
 *   grupo  78 goldenneo → SZ (Slot Zona)   CRC 100 · BOB 82 · MXN 56 · USD 410 ≈ 413  ✔
 *   grupo  60 slgames2  → SL2              CRC 8.420 exacto, ARS a 0,13%              ✔
 *   grupo  10 slgames   → SL     · cuesta 0, no genera pago
 *   grupo  32 xgames    → XG     · cuesta 0, no genera pago
 *   grupo 118 BVS       → BVS    · lo dice el propio panel
 *
 * SZ es el 76% de lo que se paga por TBS, así que era el que había que identificar sí o sí.
 *
 * Los grupos `op_*` son proveedores sueltos y van contra SU fila de la matriz (KAGAMING OP,
 * BOOMING OP…), cada uno con su costo. Se resuelven por nombre pero con una regla ESTRICTA:
 * tiene que haber una sola fila que coincida. Si hay dos parecidas (RED TIGER OP y RED_TIGER OP)
 * se informa y no se factura, porque elegir una sería inventar el costo.
 */
const TBS_FAMILIAS = {
  // ⚠️ Slot Zona son SLOTS y cuestan 1. En la matriz hay además dos filas de MESAS EN VIVO con
  // el mismo apellido (PRAGMATIC_LIVE_SLOT_ZONA y EVOLUTION_SLOT_ZONA) que cuestan 10. Esas no
  // fijan el precio del paquete: en la planilla de junio, en los tres servidores, TODAS las filas
  // SLOT_ZONA se cobraron al 1% y esas dos no aparecen ni una vez. TBS reporta el vivo en sus
  // propios grupos (op_live, evolution_pragmatic_live), así que se excluyen acá.
  78: { fam: 'SZ', etiqueta: 'SZ · Slot Zona', re: /(^|[\s_])(SZ|SLOT[\s_]?ZONA)([\s_]|$)/i, excluir: /LIVE|EVOLUTION/i },
  60: { fam: 'SL2', etiqueta: 'SL2', re: /(^|[\s_])SL2([\s_]|$)/i },
  118: { fam: 'BVS', etiqueta: 'BVS', re: /(^|[\s_])BVS([\s_]|$)/i },
  10: { fam: 'SL', etiqueta: 'SL', re: /(^|[\s_])SL([\s_]|$)/i },
  32: { fam: 'XG', etiqueta: 'XG', re: /(^|[\s_])XG([\s_]|$)/i },
};

/** Los únicos agentes que el dueño factura por TBS. El resto del árbol no es suyo. */
const TBS_AGENTES = [
  { id: '3206986', nombre: 'Henry-Latam' },
  { id: '3206461', nombre: 'NachoAPI' },
  { id: '3210708', nombre: 'TBSDavidLatam' },
  { id: '3200138', nombre: 'Henry999' },
];

/**
 * Grupos sueltos que NO siguen el patrón `op_<proveedor>` y que se identificaron por número
 * contra la planilla de junio. La fila de la matriz va escrita tal cual, sin adivinanza.
 */
const TBS_SUELTOS = {
  11: 'SPORTBETTING_ImperiumBet',        // 499.083 ARS, exacto
  47: 'ALTENTE RL',                      //   6.180 ARS, exacto
  83: 'WS_SPORTS_Original_Dima_Li',      //  10.000 ARS, exacto
  59: 'PLAYSON EV',                      // 201.462 vs 201.463
  68: 'BOOMING_ASIA_KN_Original_Dima_Li',//  30.273 vs 30.693
  70: 'SA GAMING OP',                    // USD 1.678,80 vs 1.679, exacto
};

/** Para comparar nombres de proveedor: sin espacios, guiones ni mayúsculas. */
const norm = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

/**
 * Qué fila de la matriz le corresponde a un grupo de TBS.
 * Devuelve { nombre, costo } o { error } — nunca elige entre varias candidatas.
 */
function filaDeGrupo(g, costoDe, nombres) {
  const fam = TBS_FAMILIAS[g.id];
  if (fam) {
    // Una familia entera: todas sus filas tienen que costar lo mismo, si no el total sería una
    // mezcla y no se sabría de dónde salió.
    const filas = nombres.filter((n) => fam.re.test(n) && !(fam.excluir && fam.excluir.test(n)));
    if (!filas.length) return { error: `no hay ninguna fila ${fam.fam} en la matriz` };
    // Una fila SIN costo cargado no vale 0: es un dato que falta. Se la deja afuera de la
    // comparación en vez de tomarla como un costo distinto — si no, cualquier fila nueva
    // agregada después de congelar el mes tumbaba el paquete entero.
    const porCosto = new Map();
    filas.forEach((n) => { const c = String(costoDe[K(n)] ?? ''); if (c === '') return; porCosto.set(c, [...(porCosto.get(c) || []), n]); });
    const costos = [...porCosto.keys()];
    if (!costos.length) return { error: `ninguna fila ${fam.fam} tiene costo cargado` };
    if (costos.length > 1) {
      // Decir CUÁLES discrepan: con solo los porcentajes hay que ir a buscarlas a mano entre 239 filas.
      const detalle = costos.sort((a, b) => porCosto.get(b).length - porCosto.get(a).length)
        .map((c) => `${c}% → ${porCosto.get(c).slice(0, 4).join(', ')}${porCosto.get(c).length > 4 ? ` y ${porCosto.get(c).length - 4} más` : ''}`).join(' · ');
      return { error: `las filas ${fam.fam} no cuestan todas igual (${detalle}): no se puede facturar el paquete entero hasta emparejarlas` };
    }
    return { nombre: fam.etiqueta, costo: costos[0], filas: filas.length };
  }
  const suelto = TBS_SUELTOS[g.id];
  if (suelto) {
    const n = nombres.find((x) => K(x) === K(suelto));
    return n ? { nombre: n, costo: String(costoDe[K(n)] ?? '') } : { error: `"${suelto}" ya no está en la matriz` };
  }
  // `op_kagaming` → la fila que se llame exactamente "KAGAMING OP". Una sola, o nada.
  const m = /^op[_\s](.+)$/i.exec(g.nombre);
  if (!m) return { error: 'grupo sin equivalencia en la matriz' };
  const buscado = norm(m[1] + 'op');
  const hit = nombres.filter((n) => norm(n) === buscado);
  if (hit.length === 1) return { nombre: hit[0], costo: String(costoDe[K(hit[0])] ?? '') };
  if (hit.length > 1) return { error: `la matriz tiene ${hit.length} filas iguales (${hit.join(' / ')}): habría que dejar una sola` };
  return { error: 'grupo sin equivalencia en la matriz' };
}

/**
 * Lo que se le paga a TBS en el mes. Una consulta por grupo — el panel no sabe devolver el
 * profit desglosado por grupo en una sola pasada, y sumar todo junto perdería justamente el
 * dato que decide el costo.
 */
async function lineasTBS({ mes, desde, hasta, costoDe, avisos }) {
  const conexiones = casinoConex.list().filter((c) => c.motor === 'tbs' && c.activa);
  const out = { proveedores: [], usdt: '0', sinMapear: [], filas: 0, conexiones: [] };
  // costoDe está indexado en minúscula; para las expresiones hace falta el nombre como se escribió
  const matriz = cierre.getMatriz().proveedores;
  const lista = matriz.length ? matriz.map((p) => p.nombre) : Object.keys(costoDe);

  // Junio se congeló ANTES de que TBS estuviera conectado, así que la foto del mes no tiene el
  // costo de varios proveedores que TBS sí reporta. Para esos —y solo para esos— se usa el costo
  // de hoy, y se dice cuáles fueron: es la única forma de dar un número, pero no es la foto.
  const costos = {}; const delVivo = [];
  matriz.forEach((p) => { if (p.base_pct != null && p.base_pct !== '') costos[K(p.nombre)] = p.base_pct; });
  Object.keys(costos).forEach((k) => { if (costoDe[k] == null || costoDe[k] === '') delVivo.push(k); });
  Object.entries(costoDe).forEach(([k, v]) => { if (v != null && v !== '') costos[k] = v; });

  for (const cx of conexiones) {
    const cli = casinoConex.client(cx.id);
    if (!cli) { avisos.push(`${cx.nombre}: sin credenciales`); continue; }
    const g = await cli.grupos();
    if (!g.ok) { avisos.push(`${cx.nombre}: no se pudo leer la lista de grupos — ${g.error}`); continue; }
    out.conexiones.push(cx.nombre);

    const agentes = TBS_AGENTES.map((a) => a.id);
    // De a cinco: en serie son ~2 minutos y esto lo mira alguien esperando en pantalla.
    const tanda = 5;
    for (let i = 0; i < g.grupos.length; i += tanda) {
      const parte = await Promise.all(g.grupos.slice(i, i + tanda).map(async (grp) => {
        try { return { grp, r: await cli.profitDeAgentes({ desde, hasta, agentes, grupos: [grp.id] }) }; }
        catch (e) { return { grp, r: { ok: false, error: String((e && e.message) || e) } }; }
      }));
      for (const { grp, r } of parte) {
        if (!r.ok) { avisos.push(`${cx.nombre} grupo ${grp.nombre}: ${r.error}`); continue; }
        // sumar las divisas de los 4 agentes
        const porDivisa = {};
        Object.values(r.porAgente || {}).forEach((a) => Object.entries(a.porDivisa || {}).forEach(([d, v]) => {
          porDivisa[d] = money.add(porDivisa[d] || '0', String(v.profit));
        }));
        const conPlata = Object.entries(porDivisa).filter(([, v]) => money.isPos(v));
        if (!conPlata.length) continue;                       // sin ganancia, no se paga nada

        const fila = filaDeGrupo(grp, costos, lista);
        if (fila.error) {
          out.sinMapear.push({ grupo: grp.nombre, id: grp.id, motivo: fila.error, porDivisa: Object.fromEntries(conPlata.map(([d, v]) => [d, money.round(v, 2)])) });
          continue;
        }
        if (fila.costo === '' || fila.costo == null) { out.sinMapear.push({ grupo: grp.nombre, id: grp.id, motivo: `"${fila.nombre}" no tiene costo cargado en la matriz`, porDivisa: Object.fromEntries(conPlata.map(([d, v]) => [d, money.round(v, 2)])) }); continue; }
        if (!money.isPos(fila.costo)) continue;               // cuesta 0: no genera pago

        const a = { proveedor: `${fila.nombre} (TBS)`, costo: fila.costo, usdt: '0', lineas: [] };
        for (const [divisa, profit] of conPlata) {
          const tc = tcUnico.tcExternos(divisa, mes, fila.nombre);
          if (!tc.valor) { avisos.push(`TBS ${fila.nombre}: sin TC para ${divisa}`); continue; }
          const monto = money.round(money.pct(profit, fila.costo), 2);
          const usdt = money.round(money.div(monto, tc.valor), 2);
          a.usdt = money.add(a.usdt, usdt);
          a.lineas.push({ conexion: cx.nombre, divisa, profit: money.round(profit, 2), monto, tc: tc.valor, usdt });
        }
        if (!a.lineas.length) continue;
        a.usdt = money.round(a.usdt, 2);
        out.usdt = money.add(out.usdt, a.usdt);
        out.filas += a.lineas.length;
        out.proveedores.push(a);
      }
    }
  }
  out.usdt = money.round(out.usdt, 2);
  out.proveedores.sort((a, b) => Number(b.usdt) - Number(a.usdt));
  const usados = delVivo.filter((k) => out.proveedores.some((p) => p.lineas.length && K(p.proveedor).startsWith(k)));
  if (usados.length) avisos.push(`TBS: ${usados.length} proveedor(es) no estaban en la foto del mes congelado, así que se usó su costo de HOY: ${usados.slice(0, 8).join(', ')}${usados.length > 8 ? '…' : ''}`);
  return out;
}

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
        // El MISMO TC que usa la factura del cliente: en pesos, el del proveedor, salvo SL2 y BVS
        // que van con el promedio del mes. Las dos caras del negocio tienen que convertir igual.
        const tc = tcUnico.tcExternos(divisa, m, nombre);
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

  // TBS es el tercer motor: otro protocolo, otra granularidad. Se calcula aparte y se suma acá,
  // porque para el dueño es una sola cuenta: lo que paga en el mes.
  const tbs = await lineasTBS({ mes: m, desde, hasta, costoDe, avisos });
  tbs.proveedores.forEach((p) => {
    const a = acc.get(p.proveedor) || { proveedor: p.proveedor, costo: p.costo, usdt: '0', lineas: [] };
    a.usdt = money.add(a.usdt, p.usdt); a.lineas.push(...p.lineas); acc.set(p.proveedor, a);
  });
  tbs.conexiones.forEach((n) => { porConexion[n] = { usdt: '0', filas: 0 }; });
  tbs.proveedores.forEach((p) => p.lineas.forEach((l) => {
    porConexion[l.conexion].usdt = money.add(porConexion[l.conexion].usdt, l.usdt);
    porConexion[l.conexion].filas += 1;
  }));
  tbs.conexiones.forEach((n) => { porConexion[n].usdt = money.round(porConexion[n].usdt, 2); });
  if (tbs.sinMapear.length) {
    avisos.push(`TBS: ${tbs.sinMapear.length} grupo(s) con ganancia quedaron afuera del total porque no se sabe qué fila de la matriz les corresponde (ver "TBS sin mapear").`);
  }

  const proveedores = [...acc.values()]
    .map((a) => ({ ...a, usdt: money.round(a.usdt, 2), lineas: a.lineas.sort((x, y) => Number(y.usdt) - Number(x.usdt)) }))
    .sort((a, b) => Number(b.usdt) - Number(a.usdt));

  const total = money.round(money.sum(proveedores.map((p) => p.usdt)), 2);

  return {
    ok: true, mes: m, desde, hasta,
    congelado: !!(precios && precios.congelado),
    proveedores, porConexion,
    tbsSinMapear: tbs.sinMapear,
    totales: { usdt: total, proveedores: proveedores.length },
    sinVincular: [...sinVincular.values()].map((v) => ({ nombre: v.nombre, profit: money.round(v.profit, 2), conexiones: [...v.conexiones] }))
      .sort((a, b) => Number(b.profit) - Number(a.profit)),
    sinCosto: [...sinCosto], sinTC: [...sinTC], avisos,
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

module.exports = { reporte, csv, TBS_FAMILIAS, TBS_SUELTOS, TBS_AGENTES, filaDeGrupo };
