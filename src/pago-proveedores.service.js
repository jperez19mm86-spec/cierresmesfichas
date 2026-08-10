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
const estadMes = require('./estadisticas-mes.service');
const tcUnico = require('./tc-unico.service');
const ganCache = require('./ganancias-cache');
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
  // ⚠️ ESTE CAMBIÓ. Antes decía 'Platipus_OP' con la nota "lo confirmó el dueño". Los datos de
  // junio que él mismo pasó dicen otra cosa, y el grueso va al 6,5%:
  //     TBS ARS PLATIPUS      6.5   915.265      ← el 96% de la plata
  //     TBS ARS Platipus_OP   8.0    36.404
  // TBS nos entrega UN solo grupo, con 935.903 — o sea los dos juntos, que él separa a mano en la
  // planilla. Cobrarlo entero al 8% daba 52,73 USDT contra los 44,07 de su hoja; al 6,5% da 42,84,
  // que es lo más cerca que se puede estar sin poder partir el grupo.
  41: 'PLATIPUS PLATIPUS',
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
async function lineasTBS({ mes, desde, hasta, costoDe, avisos, refrescar = false }) {
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
    // La lista de 52 grupos casi no cambia; pedirla cada vez es un viaje de más.
    let g = ganCache.get(cx.id, '_tbs_grupos', mes, '_lista', { refrescar });
    if (g) g = { ok: true, grupos: g.filas };
    else {
      g = await cli.grupos();
      if (g.ok) ganCache.set(cx.id, '_tbs_grupos', mes, '_lista', g.grupos);
    }
    if (!g.ok) { avisos.push(`${cx.nombre}: no se pudo leer la lista de grupos — ${g.error}`); continue; }
    out.conexiones.push(cx.nombre);

    const agentes = TBS_AGENTES.map((a) => a.id);
    // De a cinco: en serie son ~2 minutos y esto lo mira alguien esperando en pantalla.
    const tanda = 5;
    for (let i = 0; i < g.grupos.length; i += tanda) {
      const parte = await Promise.all(g.grupos.slice(i, i + tanda).map(async (grp) => {
        // Un mes cerrado no cambia: la ganancia de cada grupo se guarda y no se vuelve a pedir.
        // Son 52 consultas de ~2s; sin caché el reporte entero se pasaba del límite del proxy.
        const hit = ganCache.get(cx.id, `_tbs_g${grp.id}`, mes, '_todas', { refrescar });
        if (hit) return { grp, r: { ok: true, porDivisa: hit.filas, cacheado: true } };
        try {
          const r = await cli.profitDeAgentes({ desde, hasta, agentes, grupos: [grp.id] });
          if (r.ok) {
            const pd = {};
            Object.values(r.porAgente || {}).forEach((a) => Object.entries(a.porDivisa || {}).forEach(([d, v]) => {
              pd[d] = money.add(pd[d] || '0', String(v.profit));
            }));
            ganCache.set(cx.id, `_tbs_g${grp.id}`, mes, '_todas', pd);
            return { grp, r: { ok: true, porDivisa: pd } };
          }
          return { grp, r };
        } catch (e) { return { grp, r: { ok: false, error: String((e && e.message) || e) } }; }
      }));
      for (const { grp, r } of parte) {
        if (!r.ok) { avisos.push(`${cx.nombre} grupo ${grp.nombre}: ${r.error}`); continue; }
        const porDivisa = r.porDivisa || {};
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
          // La ETIQUETA (SL2, OP, XG, BVS, SLOT_ZONA…) es lo que el casino manda en `vendor`. Se
        // guarda en la línea y no se deduce del nombre de la matriz: "PRAGMATIC SL2" se puede
        // partir por el último espacio, pero "EVOLUTION LIVE DEALERS" o "SLOT ZONA" no.
        a.lineas.push({ conexion: cx.nombre, divisa, etiqueta: String(fila.vendor || '').trim() || '—',
          profit: money.round(profit, 2), monto, tc: tc.valor, usdt });
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
 * Llena el caché de UN panel, de a pedazos.
 *
 * El reporte entero no entra en una sola request: dos paneles de casino a 50-120s más 52
 * consultas a TBS se pasan del límite del proxy y la respuesta muere sin dejar nada guardado.
 * Acá se trae un pedazo, se guarda, y el que llama vuelve a pedir el siguiente. Cuando el mes
 * está completo el reporte sale de lo guardado en el acto.
 *
 * @returns { ok, conexion, motor, hechos, total, faltan, avisos }
 */
async function precargar({ mes, conexion_id, desde: desdeIdx = 0, limite = 12, refrescar = false } = {}) {
  const m = String(mes || '').slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(m)) return { ok: false, error: 'mes inválido (se espera YYYY-MM)' };
  const cx = casinoConex.list().find((c) => c.id === conexion_id);
  if (!cx) return { ok: false, error: 'no encontré esa conexión' };
  const cli = casinoConex.client(cx.id);
  if (!cli) return { ok: false, error: `"${cx.nombre}" no tiene credenciales cargadas` };
  const { from, to } = externosSvc.rango(m);
  const desde = `${from} 00:00:00`; const hasta = `${to} 23:59:59`;
  const avisos = [];

  if ((cx.motor || '463') !== 'tbs') {
    if (!refrescar && ganCache.get(cx.id, '_pago_general', m, '_todas')) {
      return { ok: true, conexion: cx.nombre, motor: '463', hechos: 1, total: 1, faltan: 0, yaEstaba: true, avisos };
    }
    // 🔒 EL CANDADO QUE FALTABA ACÁ.
    // `userGroupBy: ''` NO fuerza la vista general: el casino usa lo que tenga puesto en "Agrupar
    // por" e ignora lo que le mandemos (probado — la misma consulta dio 46 nodos con la pantalla en
    // Superagente y 232 en Distribuidor). Sin verificarlo, esto traía datos de OTRO nivel y los
    // guardaba en el caché como si fueran la general. Pasó de verdad: junio quedó con Europa en
    // 5.753 en vez de 6.469 y Casino en 10.001 en vez de 10.847, y no avisó nada.
    const modo = await estadMes.modoActual(cli);
    if (!modo.ok) return { ok: false, error: `${cx.nombre}: no se pudo leer cómo agrupa el casino — ${modo.error}` };
    if (modo.nivel !== 'general') {
      return { ok: false, reintentable: true,
        error: `${cx.nombre} está agrupando por ${modo.nivel}. Poné "Agrupar por" en `
          + '"Datos generales" dentro del casino y volvé a intentar — si no, lo que traiga no es el '
          + 'total de la plataforma y quedaría guardado como si lo fuera.' };
    }
    let r;
    try { r = await cli.reporteProveedoresMonedas({ from: desde, to: hasta, currencies: null, userGroupBy: '' }); }
    catch (e) { return { ok: false, error: `${cx.nombre}: ${String((e && e.message) || e)}` }; }
    if (!r || !r.ok) return { ok: false, error: `${cx.nombre}: ${(r && r.error) || 'no respondió'}` };
    const fallaron = Object.entries(r.monedas || {}).filter(([, x]) => !x || !x.ok).map(([d]) => d);
    if (fallaron.length) return { ok: false, error: `${cx.nombre}: el motor de reportes falló en ${fallaron.join(', ')} — probá de nuevo`, reintentable: true };
    ganCache.set(cx.id, '_pago_general', m, '_todas', r.monedas);
    return { ok: true, conexion: cx.nombre, motor: '463', hechos: 1, total: 1, faltan: 0, avisos };
  }

  // TBS: la lista de grupos primero, después el profit de cada uno, de a tandas.
  let lista = ganCache.get(cx.id, '_tbs_grupos', m, '_lista', { refrescar });
  if (lista) lista = lista.filas;
  else {
    const g = await cli.grupos();
    if (!g.ok) return { ok: false, error: `${cx.nombre}: no se pudo leer la lista de grupos — ${g.error}` };
    ganCache.set(cx.id, '_tbs_grupos', m, '_lista', g.grupos);
    lista = g.grupos;
  }
  const agentes = TBS_AGENTES.map((a) => a.id);
  const trozo = lista.slice(desdeIdx, desdeIdx + limite);
  const tanda = 5;
  for (let i = 0; i < trozo.length; i += tanda) {
    await Promise.all(trozo.slice(i, i + tanda).map(async (grp) => {
      if (!refrescar && ganCache.get(cx.id, `_tbs_g${grp.id}`, m, '_todas')) return;
      try {
        const r = await cli.profitDeAgentes({ desde, hasta, agentes, grupos: [grp.id] });
        if (!r.ok) { avisos.push(`grupo ${grp.nombre}: ${r.error}`); return; }
        const pd = {};
        Object.values(r.porAgente || {}).forEach((a) => Object.entries(a.porDivisa || {}).forEach(([d, v]) => {
          pd[d] = money.add(pd[d] || '0', String(v.profit));
        }));
        ganCache.set(cx.id, `_tbs_g${grp.id}`, m, '_todas', pd);
      } catch (e) { avisos.push(`grupo ${grp.nombre}: ${String((e && e.message) || e)}`); }
    }));
  }
  const hechos = Math.min(desdeIdx + trozo.length, lista.length);
  return { ok: true, conexion: cx.nombre, motor: 'tbs', hechos, total: lista.length, faltan: Math.max(0, lista.length - hechos), avisos };
}

/**
 * Lo que le pagamos a cada proveedor en un mes.
 * @param mes      'YYYY-MM'
 * @param monedas  qué divisas consultar (null = las que el conector conoce)
 * @returns { ok, mes, proveedores[], totales, porConexion, sinCosto[], sinVincular[], sinTC[], avisos[] }
 */
async function reporte({ mes, monedas = null, refrescar = false } = {}) {
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
    // Lo mismo que con TBS: el casino tarda 50-120s por conexión y un mes cerrado ya no se mueve.
    let r = null;
    const hit = ganCache.get(cx.id, '_pago_general', m, '_todas', { refrescar });
    if (hit) r = { ok: true, monedas: hit.filas };
    if (!r) {
      // Mismo candado que en precargar: sin esto se cachea el nivel equivocado como si fuera la
      // vista general, y el número queda mal para siempre sin que nadie se entere.
      const modo = await estadMes.modoActual(cli);
      if (!modo.ok || modo.nivel !== 'general') {
        avisos.push(`${cx.nombre}: no se consultó en vivo porque el casino está agrupando por `
          + `${modo.ok ? modo.nivel : '?'} y no por "Datos generales". Se usa lo que haya en la foto.`);
        continue;
      }
      try { r = await cli.reporteProveedoresMonedas({ from: desde, to: hasta, currencies: monedas, userGroupBy: '' }); }
      catch (e) { avisos.push(`${cx.nombre}: ${String((e && e.message) || e)}`); continue; }
      if (!r || !r.ok) { avisos.push(`${cx.nombre}: ${(r && r.error) || 'no respondió'}`); continue; }
      // Solo se guarda si vino COMPLETO: media respuesta cacheada es un número mal que se queda.
      const fallo = Object.values(r.monedas || {}).some((x) => !x || !x.ok);
      if (!fallo) ganCache.set(cx.id, '_pago_general', m, '_todas', r.monedas);
      else avisos.push(`${cx.nombre}: alguna divisa falló, así que no se guardó en caché — reintentá para completar el mes`);
    }
    if (!r || !r.ok) { avisos.push(`${cx.nombre}: no respondió`); continue; }

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
        // La ETIQUETA (SL2, OP, XG, BVS, SLOT_ZONA…) es lo que el casino manda en `vendor`. Se
        // guarda en la línea y no se deduce del nombre de la matriz: "PRAGMATIC SL2" se puede
        // partir por el último espacio, pero "EVOLUTION LIVE DEALERS" o "SLOT ZONA" no.
        a.lineas.push({ conexion: cx.nombre, divisa, etiqueta: String(fila.vendor || '').trim() || '—',
          profit: money.round(profit, 2), monto, tc: tc.valor, usdt });
        acc.set(nombre, a);
        porConexion[cx.nombre].usdt = money.add(porConexion[cx.nombre].usdt, usdt);
        porConexion[cx.nombre].filas += 1;
      }
    }
    porConexion[cx.nombre].usdt = money.round(porConexion[cx.nombre].usdt, 2);
  }

  // TBS es el tercer motor: otro protocolo, otra granularidad. Se calcula aparte y se suma acá,
  // porque para el dueño es una sola cuenta: lo que paga en el mes.
  const tbs = await lineasTBS({ mes: m, desde, hasta, costoDe, avisos, refrescar });
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

  // ── LAS OTRAS DOS FORMAS DE MIRAR LA MISMA PLATA ─────────────────────────────────────────────
  //
  // La cuenta que el dueño venía recibiendo trae tres vistas: por proveedor, por ETIQUETA (SL2,
  // SLOT_ZONA, OP, BVS…) y por DIVISA. Son la misma plata partida distinto, así que las tres tienen
  // que dar el mismo total — y eso es lo más útil que se puede agregar: si no cuadran, hay un error,
  // y hasta ahora no había forma de notarlo.
  //
  // La planilla vieja traía 129 renglones en cero sobre 200 (ATOMIC1..29, proveedores que nadie usó,
  // 70 divisas sin movimiento). Acá no se listan: si no tiene plata, no es una línea de una factura.
  const armar = (clave) => {
    const g = new Map();
    proveedores.forEach((p) => (p.lineas || []).forEach((l) => {
      const k = clave(l, p) || '—';
      const a = g.get(k) || { clave: k, usdt: '0', porConexion: {}, divisas: new Set(), proveedores: new Set(), lineas: 0 };
      a.usdt = money.add(a.usdt, l.usdt);
      a.porConexion[l.conexion] = money.add(a.porConexion[l.conexion] || '0', l.usdt);
      a.divisas.add(l.divisa); a.proveedores.add(p.proveedor); a.lineas += 1;
      g.set(k, a);
    }));
    return [...g.values()].map((a) => ({
      clave: a.clave, usdt: money.round(a.usdt, 2), lineas: a.lineas,
      porConexion: Object.fromEntries(Object.entries(a.porConexion).map(([k, v]) => [k, money.round(v, 2)])),
      divisas: [...a.divisas].sort(), proveedores: [...a.proveedores].sort(),
    })).sort((x, y) => Number(y.usdt) - Number(x.usdt));
  };

  // ── LAS LÍNEAS DE TBS NO TRAEN ETIQUETA, Y CAÍAN TODAS EN "—" ────────────────────────────────
  //
  // El casino manda `vendor` y ahí está la etiqueta; TBS es otro motor y no la manda. Resultado:
  // 17 proveedores juntos en "—" por 10.781,48 USDT, con cosas como "BOOMING OP (TBS)" que
  // evidentemente son OP.
  //
  // Se deduce del nombre de la matriz, que se escribe "<PROVEEDOR> <ETIQUETA>" — pero SÓLO contra
  // las etiquetas que el casino informó de verdad este mes. Partir el nombre por el último espacio
  // a secas convertiría "EVOLUTION LIVE DEALERS" en la etiqueta "DEALERS" y "SLOT ZONA" en "ZONA":
  // inventaría etiquetas que no existen, que es peor que dejarlas en "—".
  const etiquetasReales = new Set();
  proveedores.forEach((p) => (p.lineas || []).forEach((l) => {
    if (l.etiqueta && l.etiqueta !== '—') etiquetasReales.add(l.etiqueta.toUpperCase());
  }));
  // ── LAS QUE NO SE PUEDEN DEDUCIR, DICHAS A MANO ─────────────────────────────────────────────
  //
  // El casino no informa estas dos como `vendor`, y el nombre no las delata: "Original_Dima_Li" no
  // se parece a "OR", y en "SPORTBETTING_ImperiumBet" la etiqueta es ImperiumBet — SPORTBETTING es
  // el tipo de juego, no el proveedor. Leyéndolo de afuera parece al revés, y así lo puse primero.
  //
  // Van explícitas porque las confirmó el dueño, no porque el código las haya adivinado. Ese es
  // justo el motivo de tenerlas separadas de la deducción: si mañana el número de alguna de estas
  // dos sale raro, se sabe que salió de acá y no de una regla que acertó de casualidad.
  // ── EL AGRUPAMIENTO QUE USA EL DUEÑO ─────────────────────────────────────────────────────────
  //
  // El `vendor` del casino es más fino que los grupos con los que él paga. Tres casos:
  //
  //  · SE JUNTAN. "OP PREMIUM" es OP (EVOLUTION_LOBBY_PREMIUM_OP figura en su lista de OP), y
  //    "HUB OR" y "HUB OR PREMIUM" son los *_GameHub, todos en un grupo.
  //  · SE LLAMAN DISTINTO. Al de TOM_HORN + VIVO_LIVE_DEALERS_TH él le dice TH; el casino manda
  //    TOMHORN. Mismo contenido, otro nombre — y el nombre importa porque es el que concilia.
  //  · "default" NO ES UN GRUPO. Es lo que manda el casino cuando el proveedor no tiene
  //    integración: adentro caen siete que van a siete lados distintos (CALETA→Caleta, DLV→DLV,
  //    Jacktop y FLG y HOLI_BET sueltos…). Ahí hay que mirar el nombre del proveedor, no el vendor.
  //
  // Esta tabla la dictó el dueño. Cuando el casino agregue un vendor nuevo va a aparecer solo, con
  // su nombre crudo, en vez de meterse callado en un grupo que no le toca.
  const JUNTA = { 'OP PREMIUM': 'OP', 'HUB OR': 'GameHub', 'HUB OR PREMIUM': 'GameHub', TOMHORN: 'TH' };

  // Para los que el casino manda como "default" (o sin vendor): el grupo sale del NOMBRE.
  const POR_NOMBRE = [
    { busca: /^caleta\b/i, grupo: 'Caleta' },
    { busca: /^dlv\b/i, grupo: 'DLV' },
    { busca: /^(cq9|fishing[\s_]*games[\s_]*cq|fishing[\s_]*tbs)\b/i, grupo: 'CQ9' },
    { busca: /^flg\b/i, grupo: 'FLG' },
    { busca: /^holi[\s_]*bet\b/i, grupo: 'HOLI_BET' },
    { busca: /^jacktop\b/i, grupo: 'Jacktop' },
    { busca: /^tombala\b/i, grupo: 'TOMBALA' },
    { busca: /^tv[\s_]*bet\b/i, grupo: 'TVBET' },
    { busca: /^betgames/i, grupo: 'BetGamesTV' },
    { busca: /^evenbet/i, grupo: 'Evenbet_Poker' },
    { busca: /^inbet$/i, grupo: 'Inbet' },
    { busca: /^fishing[\s_]*games[\s_]*gg\b/i, grupo: 'FISHING_GAMES_GG' },
    { busca: /^playtech\b/i, grupo: 'PLAYTECH' },
    { busca: /^sport[\s_]*betting\b/i, grupo: 'SPORTBETTING' },
    // El casino lo manda sin integración ("default") y TBS como WS_SPORTS_Original_Dima_Li: son
    // las dos mitades del mismo proveedor. Confirmado contra la planilla de junio, donde la fila
    // WS_SPORTS_Original_Dima_Li trae Europa 0,19 — exactamente lo que da acá.
    { busca: /^ws[\s_]*sports\b/i, grupo: 'OR' },
  ];

  const A_MANO = [
    { busca: /original[\s_]*dima[\s_]*li/i, etiqueta: 'OR' },
    // \b no sirve acá: el guión bajo cuenta como letra, así que entre "SPORTBETTING" y "_Imperium"
    // no hay borde de palabra y la regla no pegaba nunca.
    // ImperiumBet y SPORTBETTING van JUNTOS, confirmado por el dueño: el del casino y el de TBS
    // son el mismo proveedor. En su planilla de junio figuran sumados en 336,81.
    { busca: /^\s*sportbetting(?=[\s_·]|$)/i, etiqueta: 'SPORTBETTING' },
  ];

  const deducir = (nombreProv) => {
    const aMano = A_MANO.find((r) => r.busca.test(String(nombreProv || '')));
    if (aMano) return aMano.etiqueta;
    // Los nombres de TBS separan con guión bajo o con "·", no siempre con espacio: "Platipus_OP",
    // "SZ · Slot Zona". Se normaliza antes de mirar, si no "Platipus_OP" es una sola palabra.
    const limpio = String(nombreProv || '').replace(/\s*\(TBS\)\s*$/i, '')
      .replace(/[_·]+/g, ' ').replace(/\s+/g, ' ').trim();
    const partes = limpio.split(' ');
    const arriba = limpio.toUpperCase();
    if (etiquetasReales.has(arriba)) return arriba;              // el nombre ES la etiqueta: "SL2"
    // De más largo a más corto para que "HUB OR" gane sobre "OR". Al final y al principio: unos
    // vienen "<PROVEEDOR> <ETIQUETA>" (Platipus OP) y otros al revés (SZ · Slot Zona).
    for (let n = Math.min(3, partes.length - 1); n >= 1; n--) {
      const fin = partes.slice(-n).join(' ').toUpperCase();
      if (etiquetasReales.has(fin)) return fin;
      const ini = partes.slice(0, n).join(' ').toUpperCase();
      if (etiquetasReales.has(ini)) return ini;
    }
    return null;
  };
  let deducidas = 0;
  proveedores.forEach((p) => (p.lineas || []).forEach((l) => {
    // 1) lo que no trae etiqueta (TBS): se deduce del nombre
    if (!l.etiqueta || l.etiqueta === '—') {
      const e = deducir(p.proveedor);
      if (e) { l.etiqueta = e; l.etiquetaDeducida = true; deducidas += 1; }
    }
    // 2) "default" no es un grupo: es "sin integración". El grupo sale del nombre del proveedor.
    if (!l.etiqueta || l.etiqueta === '—' || /^default$/i.test(l.etiqueta)) {
      const r = POR_NOMBRE.find((x) => x.busca.test(String(p.proveedor || '').trim()));
      if (r) { l.etiqueta = r.grupo; l.etiquetaDeducida = true; deducidas += 1; }
    }
    // 3) los que el dueño paga juntos, aunque el casino los separe
    const j = JUNTA[String(l.etiqueta || '').toUpperCase()] || JUNTA[l.etiqueta];
    if (j) l.etiqueta = j;
  }));

  const porEtiqueta = armar((l) => l.etiqueta);
  const porDivisa = armar((l) => l.divisa);
  // En la vista por divisa interesa además cuánto se movió EN ESA MONEDA y con qué TC se pasó a
  // dólares: la diferencia contra la planilla del proveedor casi siempre es el tipo de cambio, y
  // sin verlo hay que adivinar de dónde sale.
  porDivisa.forEach((d) => {
    const ls = proveedores.flatMap((p) => (p.lineas || []).filter((l) => l.divisa === d.clave));
    d.montoLocal = money.round(money.sum(ls.map((l) => l.monto)), 2);
    const tcs = [...new Set(ls.map((l) => String(l.tc)))];
    d.tc = tcs.length === 1 ? tcs[0] : null;      // null = se usó más de uno (SL2/BVS van con otro)
    d.tcs = tcs.length > 1 ? tcs : undefined;
  });

  const sumar = (arr) => money.round(money.sum(arr.map((x) => x.usdt)), 2);
  const cuadre = { proveedores: total, etiquetas: sumar(porEtiqueta), divisas: sumar(porDivisa),
    etiquetasDeducidas: deducidas };
  cuadre.cuadra = cuadre.proveedores === cuadre.etiquetas && cuadre.proveedores === cuadre.divisas;
  if (!cuadre.cuadra) {
    avisos.push(`⚠️ Las tres vistas no dan lo mismo: por proveedor ${cuadre.proveedores}, `
      + `por etiqueta ${cuadre.etiquetas}, por divisa ${cuadre.divisas}. Es un error de cálculo, no de datos.`);
  }

  return {
    ok: true, mes: m, desde, hasta,
    congelado: !!(precios && precios.congelado),
    proveedores, porConexion, porEtiqueta, porDivisa, cuadre,
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

module.exports = { reporte, precargar, csv, TBS_FAMILIAS, TBS_SUELTOS, TBS_AGENTES, filaDeGrupo };
