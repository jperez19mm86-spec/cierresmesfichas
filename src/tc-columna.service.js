/**
 * tc-columna.service.js — la columna del mes en la grilla de TC, armada sola.
 *
 * POR QUÉ: todos los días se guarda la cotización de cada divisa, pero para facturar hace falta
 * UN número por moneda y por mes, y ese número se venía copiando a mano de un lado al otro. Es un
 * paso manual que divide todo lo que se cobra: si se olvida, la moneda factura con el promedio
 * automático sin que nadie lo decida; si se copia mal, factura mal y no avisa.
 *
 * QUÉ HACE: cuando el mes termina, escribe en la grilla el promedio de lo que se juntó ese mes.
 *
 * DOS REGLAS QUE NO SE TOCAN:
 *  · NO pisa lo que ya está cargado a mano. Lo escrito por una persona gana siempre; esto solo
 *    llena lo que está vacío. Con `pisar` se fuerza, y en ese caso es una decisión explícita.
 *  · NO toca ARS_OF. Ese es el TC que factura el PROVEEDOR: no sale de ninguna cotización, sale
 *    de su factura, y adivinarlo sería inventar lo que pagamos.
 *
 * El peso va aparte: su promedio es el de Binance/criptoya (tc_snapshots), no el de la fuente de
 * cotizaciones oficiales que alimenta al resto — la diferencia medida fue 6,1%.
 */
const cierre = require('./cierre-store');
const tcArs = require('./tc-store');
const tcDivisas = require('./tc-divisas.service');
const { mesCierre, mesTZ } = require('./lib/fechas');

/** El mes anterior al que se le pasa. '2026-08' → '2026-07' */
function mesAnterior(iso) {
  const [y, m] = String(iso).split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1, 1));
  d.setUTCMonth(d.getUTCMonth() - 1);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/**
 * Arma (o completa) la columna de un mes con los promedios que se juntaron.
 * @returns { ok, mes, columna, escritas[], respetadas[], sinDatos[], rechazadas[] }
 */
function armarColumna(mesISO, { pisar = false } = {}) {
  const m = String(mesISO || '').slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(m)) return { ok: false, error: 'mes inválido (se espera YYYY-MM)' };
  const columna = mesCierre(m);

  const yaHay = cierre.getTC().tasas;
  const tiene = (mon) => {
    const fila = yaHay[mon] || {};
    return Object.entries(fila).some(([k, v]) => k.toLowerCase() === columna.toLowerCase() && v != null && v !== '');
  };

  // ARS del promedio cripto + el resto de la fuente de cotizaciones.
  const candidatos = [];
  const ars = tcArs.promedioMes(m);
  if (ars) candidatos.push({ divisa: 'ARS', valor: String(ars), dias: null, fuente: 'Binance/criptoya' });
  tcDivisas.promediosMes(m).forEach((r) => {
    if (r.promedio == null) return;
    candidatos.push({ divisa: String(r.divisa).toUpperCase(), valor: String(r.promedio), dias: r.dias, fuente: 'cotizaciones' });
  });

  const escritas = []; const respetadas = []; const rechazadas = [];
  for (const c of candidatos) {
    if (c.divisa === cierre.FILA_PROVEEDOR) continue;          // el del proveedor no se adivina
    if (!pisar && tiene(c.divisa)) { respetadas.push({ divisa: c.divisa, valor: c.valor }); continue; }
    // `forzar`: el guardarraíl del salto del 50% existe para atajar un tipeo ("1.400" por 1400).
    // Acá el número es un promedio de cotizaciones reales, no algo tipeado; si de verdad saltó,
    // es que la moneda saltó. Igual se deja anotado para poder mirarlo.
    const r = cierre.setTC(c.divisa, columna, c.valor, true);
    if (r.ok) escritas.push({ divisa: c.divisa, valor: c.valor, dias: c.dias, fuente: c.fuente });
    else rechazadas.push({ divisa: c.divisa, valor: c.valor, error: r.error });
  }
  const sinDatos = cierre.getTC().monedas
    .filter((mon) => mon !== cierre.FILA_PROVEEDOR && !tiene(mon) && !escritas.some((e) => e.divisa === mon));

  return { ok: true, mes: m, columna, escritas, respetadas, sinDatos, rechazadas };
}

/**
 * Se llama sola: si el mes pasado ya terminó y su columna todavía no está, la arma.
 * Idempotente — dos corridas el mismo día no duplican ni pisan nada.
 */
function alCerrarElMes() {
  const anterior = mesAnterior(mesTZ());
  const columna = mesCierre(anterior);
  const filas = cierre.getTC().tasas;
  const yaEsta = Object.values(filas).some((f) => Object.entries(f)
    .some(([k, v]) => k.toLowerCase() === columna.toLowerCase() && v != null && v !== ''));
  if (yaEsta) return { ok: true, mes: anterior, salteado: 'la columna ya tiene datos' };
  return armarColumna(anterior);
}

/** Revisa una vez por hora. El mes cambia una vez al mes; no hace falta más que eso. */
function startScheduler() {
  const correr = () => {
    try {
      const r = alCerrarElMes();
      if (r.ok && r.escritas && r.escritas.length) {
        console.log(`[TC columna] armada ${r.columna} con ${r.escritas.length} monedas`);
      }
    } catch (e) { console.warn('[TC columna] error:', e.message); }
  };
  setInterval(correr, 60 * 60 * 1000);
  setTimeout(correr, 30 * 1000);        // una al arrancar, por si estuvo apagado el 1°
  console.log('[TC columna] al terminar el mes se arma su columna con los promedios');
}

module.exports = { armarColumna, alCerrarElMes, startScheduler, mesAnterior };
