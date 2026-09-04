/**
 * tc-unico.service.js — ⭐ EL TIPO DE CAMBIO DE UN MES, RESUELTO EN UN SOLO LUGAR.
 *
 * El problema que resuelve: había TRES tablas de TC viviendo en paralelo y cada pantalla leía una
 * distinta, así que las dos mitades de la MISMA factura podían salir con tipos de cambio diferentes:
 *
 *   · `tc_snapshots` → `tc_mes`     SOLO pesos argentinos, automático (criptoya), mes en ISO.
 *                                   La usaban Facturación y Reparto.
 *   · `cierre_tc`                   TODAS las divisas, cargado A MANO, mes tipo "Julio_2026".
 *                                   La usaba Proveedores externos.
 *   · `tc_divisa_snapshots`         TODAS las divisas, automático todos los días, mes en ISO.
 *                                   No la mostraba ninguna pantalla.
 *
 * Y encima una carga en una moneda que no fuera el peso argentino se pasaba a USDT con el TC del
 * peso: un fee en pesos uruguayos salía ~30 veces más chico y nadie se enteraba.
 *
 * REGLA ÚNICA (la misma idea que el % base: lo que el dueño confirmó a mano manda):
 *   1) el CARGADO A MANO para el cierre de ese mes (`cierre_tc`) — es la decisión explícita
 *   2) el PROMEDIO AUTOMÁTICO del mes de esa divisa, y de dónde sale depende de la moneda:
 *        · PESO ARGENTINO → Binance/criptoya (`tc_snapshots` → `tc_mes`). Es el mercado real:
 *          el peso se cotiza contra el dólar cripto, no contra el oficial.
 *        · TODAS LAS DEMÁS → la fuente de cotizaciones oficiales (`tc_divisa_snapshots`).
 *   3) el dólar y el USDT valen 1
 *
 * Siempre devuelve DE DÓNDE salió y QUÉ DECÍAN LAS OTRAS FUENTES, para que la pantalla pueda avisar
 * cuando no coinciden en vez de elegir una en silencio.
 */
const tcArs = require('./tc-store');
const tcDivisas = require('./tc-divisas.service');
const cierre = require('./cierre-store');
const money = require('./lib/money');

const MESES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
const K = (s) => String(s || '').trim().toLowerCase();

/** '2026-07' → 'Julio_2026'. Los meses del cierre se llaman así, no en ISO. */
function mesCierre(iso) {
  const [y, m] = String(iso || '').split('-');
  return MESES[Number(m) - 1] ? `${MESES[Number(m) - 1]}_${y}` : String(iso);
}

/** El TC cargado a mano en el cierre. Tolera cómo se escribió el mes (Julio_2026, JULIO_26…). */
function manual(divisa, mes) {
  const D = String(divisa || '').toUpperCase();
  const t = cierre.getTC();
  const fila = t.tasas[D];
  if (!fila) return null;
  const buscado = K(mesCierre(mes));
  const corto = buscado.replace(/_20/, '_');
  for (const [m, tasa] of Object.entries(fila)) {
    const k = K(m);
    if (k === buscado || k === corto) {
      // Si lo cargado a mano no es un número usable, se trata como QUE NO HAY: así cae al automático
      // y aparece en los avisos de 'sin tipo de cambio', en vez de dividir por 0 y facturar cero.
      return money.isPos(tasa) ? String(tasa) : null;
    }
  }
  return null;
}

/**
 * EL TC de una divisa para un mes.
 * @returns { valor, fuente, divisa, mes, fuentes:{manual,automatico,arsHistorico}, conflicto }
 *   `conflicto` viene cargado cuando dos fuentes difieren más de un 1%: no cambia el número que se
 *   usa (manda el de la regla), pero deja que la pantalla lo muestre.
 */
/* 🇻🇪 VES y VEF son la MISMA moneda con dos códigos, y el casino devuelve las dos.
   Regla de la dueña (3-sep-2026): «con VES, tenés, como regla, que usar el mismo que usemos en VEF».
   Sin esto, un mes con el TC cargado sólo en VEF dejaba lo movido en VES fuera del total —
   sin error, sin aviso, simplemente sin cobrar. Se resuelve en el único lugar donde se pide un TC
   para que no dependa de que alguien se acuerde de cargar las dos. */
const ALIAS_DIVISA = { VES: 'VEF' };

function tcDelMes(divisa, mes) {
  const D = String(divisa || 'ARS').toUpperCase();
  const m = String(mes || '').slice(0, 7);
  if (D === 'USD' || D === 'USDT') {
    return { valor: '1', fuente: 'el dólar es la unidad', divisa: D, mes: m, fuentes: {}, conflicto: null };
  }
  // Si la moneda tiene alias, se prueba primero con la suya y se cae a la del alias. Al revés no:
  // se informa con qué se resolvió, para que en pantalla no parezca que VES tenía su propio TC.
  if (ALIAS_DIVISA[D]) {
    const propio = _tcCrudo(D, m);
    if (propio.valor != null) return propio;
    const alias = _tcCrudo(ALIAS_DIVISA[D], m);
    if (alias.valor != null) {
      return { ...alias, divisa: D, fuente: `${alias.fuente} (de ${ALIAS_DIVISA[D]}: es la misma moneda)` };
    }
    return { ...propio, divisa: D };
  }
  return _tcCrudo(D, m);
}

function _tcCrudo(D, m) {

  // 🔑 El PESO se cotiza contra el dólar cripto, no contra el oficial: su promedio automático es
  // el de Binance/criptoya (tc_snapshots → tc_mes), NO el de la fuente de cotizaciones oficiales
  // que alimenta al resto de las divisas. Antes ARS entraba por las dos y ganaba la oficial:
  // agosto resolvía 1488,45 en vez de 1579,68 — 6,1% abajo, y como se DIVIDE por este número,
  // todo lo facturado en pesos salía 6,1% de más. Ver el comentario en tc-divisas.service.js.
  const esPeso = D === 'ARS';
  const binance = esPeso ? ((tcArs.getMes(m) || {}).tc_cliente || null) : null;
  const f = {
    manual: manual(D, m),
    automatico: esPeso ? binance : tcDivisas.promedioMes(D, m),
    arsHistorico: binance,
  };

  let valor = null; let fuente = 'SIN CARGAR';
  if (f.manual != null) { valor = String(f.manual); fuente = 'cargado a mano en el cierre'; }
  else if (f.automatico != null) { valor = String(f.automatico); fuente = 'promedio automático del mes'; }
  else if (f.arsHistorico != null) { valor = String(f.arsHistorico); fuente = 'promedio histórico (ARS)'; }

  // ¿las fuentes se contradicen? se avisa, no se corrige sola
  let conflicto = null;
  if (valor != null) {
    for (const [nombre, v] of Object.entries(f)) {
      if (v == null || String(v) === valor) continue;
      const difPct = money.D(money.div(money.sub(v, valor), valor)).abs().times(100);
      if (difPct.gt(1)) {                                  // más de 1% de diferencia: se avisa
        conflicto = conflicto || [];
        conflicto.push({ fuente: nombre, valor: String(v), difPct: money.round(difPct.toString(), 1) });
      }
    }
  }
  return { valor, fuente, divisa: D, mes: m, fuentes: f, conflicto };
}

/**
 * ⭐ EL TC DE LOS PROVEEDORES EXTERNOS — que NO es el mismo que el del cliente.
 *
 * Regla del dueño (4-ago-2026): en PESOS, los proveedores externos se liquidan con el
 * **tipo de cambio que informa el proveedor** (`tc_mes.tc_proveedor_ext`, la columna
 * "TC PROVEEDOR (FACTURA)"), no con el promedio del mes. Julio: proveedor 1.473,5 contra
 * cliente 1.574,42 — un 6,4% de diferencia, y como se DIVIDE por él, mueve la factura un 6,85%.
 *
 * Las excepciones, también suyas:
 *   · **SL2 y BVS** van con el **promedio del mes**, el mismo que se usa para las cuentas de
 *     los clientes. (En su planilla figuraban como una moneda aparte, `ARS_SL2_BVS`.)
 *   · **SL y XG** cuestan 0, así que nunca generan un cobro y da igual con qué TC se conviertan.
 *
 * Fuera del peso no hay TC de proveedor: se usa el del mes.
 * Si el mes no tiene TC de proveedor cargado, cae al del mes y lo DICE — no inventa uno.
 *
 * ⚠️ NO LO USA LA FACTURA DEL CLIENTE. Hay TRES cuentas de externos y no todas convierten igual:
 *   · la que se le COBRA AL CLIENTE (Marcelo, Titan…) → SIEMPRE el promedio del mes (`tcDelMes`)
 *   · la INTERNA, por vendedor (Henry, Alexa…)        → esta función
 *   · la GLOBAL, lo que le pagamos al proveedor       → esta función
 * Las dos últimas son plata que el dueño realmente paga. Al cliente se le cobra con el promedio:
 * la diferencia entre las dos tasas es margen suyo, no un costo que se traslade.
 */
function tcExternos(divisa, mes, nombreProveedor) {
  const D = String(divisa || 'ARS').toUpperCase();
  const base = tcDelMes(D, mes);
  if (D !== 'ARS') return base;
  // el sufijo ES el producto: SL2 y BVS son grupos propios, no variantes de SL
  if (/(^|[\s_])(SL2|BVS)([\s_]|$)/i.test(String(nombreProveedor || ''))) {
    return { ...base, fuente: base.fuente + ' (SL2/BVS van con el promedio del mes)' };
  }
  const prov = (tcArs.getMes(String(mes).slice(0, 7)) || {}).tc_proveedor_ext;
  if (prov != null && prov !== '' && money.isPos(String(prov))) {
    return { valor: String(prov), fuente: 'TC del proveedor (factura)', divisa: D, mes: String(mes).slice(0, 7), fuentes: base.fuentes, conflicto: base.conflicto };
  }
  return { ...base, fuente: base.fuente + ' ⚠ sin TC de proveedor cargado para este mes' };
}

/** Todas las divisas de un mes donde las fuentes NO coinciden. Para mostrarlo en Tipos de cambio. */
function discrepancias(mes) {
  const m = String(mes || '').slice(0, 7);
  const divisas = new Set(['ARS']);
  cierre.getTC().monedas.forEach((d) => divisas.add(String(d).toUpperCase()));
  tcDivisas.promediosMes(m).forEach((r) => divisas.add(String(r.divisa).toUpperCase()));
  const out = [];
  for (const d of [...divisas].sort()) {
    const r = tcDelMes(d, m);
    if (r.conflicto) out.push(r);
  }
  return out;
}

/**
 * El TC resuelto de TODAS las divisas del mes, para poder mirarlas de un vistazo.
 * ARS_OF no entra: no es una moneda, es el ARS que factura el proveedor (ver `tcExternos`).
 */
function resumenMes(mes) {
  const m = String(mes || '').slice(0, 7);
  const divisas = new Set(['ARS']);
  cierre.getTC().monedas.forEach((d) => divisas.add(String(d).toUpperCase()));
  tcDivisas.promediosMes(m).forEach((r) => divisas.add(String(r.divisa).toUpperCase()));
  divisas.delete(String(cierre.FILA_PROVEEDOR).toUpperCase());
  return [...divisas].sort().map((d) => {
    const r = tcDelMes(d, m);
    return { divisa: d, valor: r.valor, fuente: r.fuente, conflicto: !!r.conflicto };
  });
}

/** Las divisas de un mes que no tienen NINGÚN TC: todo lo que se facture en ellas queda sin pasar a USDT. */
function faltantes(mes, divisasUsadas = []) {
  return [...new Set(divisasUsadas.map((d) => String(d || '').toUpperCase()))]
    .filter((d) => d && tcDelMes(d, mes).valor == null)
    .sort();
}

module.exports = { tcDelMes, tcExternos, discrepancias, resumenMes, faltantes, mesCierre };
