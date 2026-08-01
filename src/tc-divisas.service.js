/**
 * tc-divisas.service.js — tipo de cambio diario del RESTO de las divisas (ARS va aparte).
 *
 * Por qué existe: el cierre de proveedores externos convierte a USDT con el TC PROMEDIO DEL MES
 * de la divisa de cada panel, y los paneles usan ~36 monedas. Hasta ahora ese TC se cargaba a mano
 * mes a mes en una grilla. Guardando un snapshot por día, el promedio del mes sale solo.
 *
 * Fuente: open.er-api.com (gratis, sin clave, cubre 36 de las 38 divisas en uso).
 * exchange-rates.org NO se puede usar: está detrás de Cloudflare y bloquea la lectura automática.
 *
 * Reglas del negocio (decididas por el dueño):
 *   - ARS  → NO se toma de acá. Sale de Binance/criptoya (tc-store), que es el mercado real.
 *   - VEF  → se cobra igual que VES; la fuente no tiene VEF, así que se le copia el valor de VES.
 *            (En el panel del casino figuran como divisas distintas, pero valen lo mismo.)
 *   - BOB  → se usa el valor de la fuente, que es el PARALELO (el oficial ~6.9 no es el real).
 *   - ADA  → se ignora (es cripto, no se factura).
 */
const { db } = require('./db');
const money = require('./lib/money');
const { fechaTZ, nowISO } = require('./lib/fechas');

const FUENTE_URL = 'https://open.er-api.com/v6/latest/USD';
const IGNORAR = new Set(['ADA', 'USD', 'USDT']);   // USD/USDT valen 1; ADA no se factura
const ALIAS = { VEF: 'VES' };                       // VEF toma el valor de VES

/** Baja las cotizaciones del día. Devuelve { ok, tasas: {DIVISA: '1234.56'}, error? } */
async function fetchTasas() {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), 20000);
  try {
    const r = await fetch(FUENTE_URL, { signal: ctrl.signal });
    if (!r.ok) return { ok: false, error: `HTTP ${r.status}` };
    const j = await r.json();
    if (!j || !j.rates) return { ok: false, error: 'respuesta sin cotizaciones' };
    const tasas = {};
    for (const [div, val] of Object.entries(j.rates)) {
      if (IGNORAR.has(div)) continue;
      const n = Number(val);
      if (!Number.isFinite(n) || n <= 0) continue;
      tasas[div] = money.round(String(n), 6);
    }
    // VEF no existe en la fuente: se le copia VES (mismo valor, el dueño cobra igual)
    for (const [destino, origen] of Object.entries(ALIAS)) {
      if (tasas[destino] == null && tasas[origen] != null) tasas[destino] = tasas[origen];
    }
    return { ok: true, tasas };
  } catch (e) {
    return { ok: false, error: e.name === 'AbortError' ? 'timeout' : e.message };
  } finally { clearTimeout(to); }
}

const _guardar = db.transaction((fecha, tasas, fuente) => {
  const ins = db.prepare(`INSERT INTO tc_divisa_snapshots (fecha,divisa,tasa,fuente,createdAt)
    VALUES (?,?,?,?,?) ON CONFLICT(fecha,divisa) DO UPDATE SET tasa=excluded.tasa, fuente=excluded.fuente`);
  let n = 0;
  for (const [div, tasa] of Object.entries(tasas)) { ins.run(fecha, div, tasa, fuente, nowISO()); n++; }
  return n;
});

/** Toma el snapshot del día y lo guarda (idempotente: si ya corrió hoy, lo pisa). */
async function snapshotHoy(fecha) {
  const f = fecha || fechaTZ();
  const r = await fetchTasas();
  if (!r.ok) return r;
  const n = _guardar(f, r.tasas, 'open.er-api.com');
  return { ok: true, fecha: f, divisas: n };
}

/** Promedio del mes de una divisa. null si no hay ningún día guardado. */
function promedioMes(divisa, mes) {
  const d = String(divisa || '').toUpperCase();
  if (d === 'USDT' || d === 'USD') return '1';
  const rows = db.prepare("SELECT tasa FROM tc_divisa_snapshots WHERE divisa=? AND substr(fecha,1,7)=?").all(d, mes);
  if (!rows.length) return null;
  return money.round(money.div(money.sum(rows.map((x) => x.tasa)), String(rows.length)), 6);
}

/** Promedios de TODAS las divisas de un mes + cuántos días tiene cada una. */
function promediosMes(mes) {
  const rows = db.prepare(`SELECT divisa, COUNT(*) dias, GROUP_CONCAT(tasa) tasas
    FROM tc_divisa_snapshots WHERE substr(fecha,1,7)=? GROUP BY divisa ORDER BY divisa`).all(mes);
  return rows.map((r) => {
    const vals = String(r.tasas || '').split(',').filter(Boolean);
    return { divisa: r.divisa, dias: r.dias, promedio: vals.length ? money.round(money.div(money.sum(vals), String(vals.length)), 6) : null };
  });
}

function listDias(mes, divisa) {
  if (divisa) return db.prepare("SELECT * FROM tc_divisa_snapshots WHERE substr(fecha,1,7)=? AND divisa=? ORDER BY fecha DESC").all(mes, String(divisa).toUpperCase());
  return db.prepare("SELECT * FROM tc_divisa_snapshots WHERE substr(fecha,1,7)=? ORDER BY fecha DESC, divisa ASC").all(mes);
}

let _ultimoDia = null;
/** Cron: un snapshot por día. Comparte la hora con el de ARS (TC_SNAPSHOT_HOUR, 18 por defecto). */
function startScheduler() {
  const HOUR = Number(process.env.TC_SNAPSHOT_HOUR || '18');
  setInterval(async () => {
    try {
      const dia = fechaTZ();
      const hora = Number(new Date().toLocaleString('en-GB', { timeZone: 'America/Argentina/Buenos_Aires', hour: '2-digit', hour12: false }));
      if (hora === HOUR && _ultimoDia !== dia) {
        _ultimoDia = dia;
        const r = await snapshotHoy(dia);
        console.log('[TC divisas] snapshot diario →', r.ok ? `${r.divisas} divisas` : `FALLÓ ${r.error}`);
      }
    } catch (e) { console.warn('[TC divisas] scheduler error:', e.message); }
  }, 5 * 60 * 1000);
  console.log(`[TC divisas] scheduler activo (snapshot diario ${HOUR}:00 ART)`);
}

module.exports = { fetchTasas, snapshotHoy, promedioMes, promediosMes, listDias, startScheduler, ALIAS, IGNORAR };
