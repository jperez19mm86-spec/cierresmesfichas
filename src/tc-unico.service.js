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
 *   2) el PROMEDIO AUTOMÁTICO del mes de esa divisa (`tc_divisa_snapshots`)
 *   3) solo para el peso argentino: el promedio de `tc_mes` (histórico, es lo que ya se facturó)
 *   4) el dólar y el USDT valen 1
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
    if (k === buscado || k === corto) return tasa != null && tasa !== '' ? String(tasa) : null;
  }
  return null;
}

/**
 * EL TC de una divisa para un mes.
 * @returns { valor, fuente, divisa, mes, fuentes:{manual,automatico,arsHistorico}, conflicto }
 *   `conflicto` viene cargado cuando dos fuentes difieren más de un 1%: no cambia el número que se
 *   usa (manda el de la regla), pero deja que la pantalla lo muestre.
 */
function tcDelMes(divisa, mes) {
  const D = String(divisa || 'ARS').toUpperCase();
  const m = String(mes || '').slice(0, 7);
  if (D === 'USD' || D === 'USDT') {
    return { valor: '1', fuente: 'el dólar es la unidad', divisa: D, mes: m, fuentes: {}, conflicto: null };
  }

  const f = {
    manual: manual(D, m),
    automatico: tcDivisas.promedioMes(D, m),
    arsHistorico: D === 'ARS' ? ((tcArs.getMes(m) || {}).tc_cliente || null) : null,
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

/** Las divisas de un mes que no tienen NINGÚN TC: todo lo que se facture en ellas queda sin pasar a USDT. */
function faltantes(mes, divisasUsadas = []) {
  return [...new Set(divisasUsadas.map((d) => String(d || '').toUpperCase()))]
    .filter((d) => d && tcDelMes(d, mes).valor == null)
    .sort();
}

module.exports = { tcDelMes, discrepancias, faltantes, mesCierre };
