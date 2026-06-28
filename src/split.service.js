/**
 * split.service.js — reparto EMPRESA / LATAM / SOCIOS (secciones 3.2 y "División de costos").
 *
 * split_base: por cada % base, pct_empresa + pct_latam (absolutos sobre la carga; suman el base).
 *   ej base 11 → empresa 7, latam 4  (7/11 y 4/11 son los ratios para repartir costos).
 */
const splitBase = require('./split-base-store');
const money = require('./lib/money');

/** Reparto del profit de una carga: empresa y LATAM en plata. */
function empresaLatam(base, carga) {
  const row = splitBase.forBase(base);
  if (!row) return { ok: false, error: `base ${base}% sin split (caso individual / <8%)` };
  return {
    ok: true,
    pct_empresa: row.pct_empresa, pct_latam: row.pct_latam,
    empresa: money.pct(carga, row.pct_empresa),
    latam: money.pct(carga, row.pct_latam),
  };
}

/** Distribuye un monto LATAM entre los socios según el reparto (items [{persona_id, porcentaje}]). */
function distribuirLatam(latamMonto, repartoItems) {
  return (repartoItems || []).map((it) => ({
    persona_id: it.persona_id,
    porcentaje: it.porcentaje,
    monto: money.pct(latamMonto, it.porcentaje),
  }));
}

/**
 * División de costos de proveedores (sección "División de costos"):
 * empresa paga pct_empresa/base del costo, LATAM paga pct_latam/base, y dentro de LATAM cada socio su %.
 */
function costoProveedores(base, costoTotal, repartoItems) {
  const row = splitBase.forBase(base);
  if (!row) return { ok: false, error: `base ${base}% sin split` };
  const empresaRatio = money.div(row.pct_empresa, base);   // ej 7/11
  const latamRatio = money.div(row.pct_latam, base);        // ej 4/11
  const empresa = money.mul(costoTotal, empresaRatio);
  const latam = money.mul(costoTotal, latamRatio);
  const socios = (repartoItems || []).map((it) => ({
    persona_id: it.persona_id, porcentaje: it.porcentaje, paga: money.pct(latam, it.porcentaje),
  }));
  return { ok: true, empresa: money.round(empresa, 2), latam: money.round(latam, 2), empresaRatio, latamRatio, socios };
}

module.exports = { empresaLatam, distribuirLatam, costoProveedores };
