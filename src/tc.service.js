/**
 * tc.service.js — obtención del Tipo de Cambio ARS/USDT + scheduler del snapshot diario 18:00.
 *
 * Fuente: criptoya (promedia Binance P2P). Configurable por env TC_SOURCE_URL.
 * El doc dice "Binance"; criptoya agrega Binance P2P (Binance no tiene spot ARS/USDT directo).
 * Si la fuente falla, el snapshot se puede cargar a mano (endpoint /api/tc/snapshot).
 */
const axios = require('axios');
const tc = require('./tc-store');
const { horaNum, fechaTZ, TZ } = require('./lib/fechas');

const SOURCE_URL = process.env.TC_SOURCE_URL || 'https://criptoya.com/api/usdt/ars/1';

function pickAsk(o) { if (!o || typeof o !== 'object') return null; return o.totalAsk || o.ask || o.bid || null; }

/** Trae el TC actual de la fuente. {ok, tc, fuente} | {ok:false, error} */
async function fetchTC() {
  try {
    const r = await axios.get(SOURCE_URL, { timeout: 12000, validateStatus: () => true });
    const d = r.data || {};
    let v = pickAsk(d.binancep2p) || pickAsk(d.binance) || null;
    if (v == null) { // promedio de todos los proveedores que devuelvan precio
      const vals = Object.values(d).map(pickAsk).filter((n) => typeof n === 'number' && n > 0);
      if (vals.length) v = vals.reduce((a, b) => a + b, 0) / vals.length;
    }
    if (v == null) return { ok: false, error: 'no se pudo parsear el TC de la fuente' };
    return { ok: true, tc: Number(v), fuente: 'criptoya' };
  } catch (e) { return { ok: false, error: e.message }; }
}

/** Trae el TC y lo guarda como snapshot. */
async function snapshotNow() {
  const r = await fetchTC();
  if (!r.ok) return r;
  return { ok: true, snapshot: tc.addSnapshot({ tc_ars_usdt: r.tc, fuente: r.fuente }) };
}

/** TC en tiempo real para una carga: intenta la API; si falla, usa el último snapshot. */
async function tcAhora() {
  const r = await fetchTC();
  if (r.ok) return { tc: String(r.tc), fuente: r.fuente, vivo: true };
  return { tc: tc.ultimoTC(), fuente: 'snapshot', vivo: false };
}

/** Scheduler: snapshot 1×/día a la hora configurada (default 18:00 ART). Chequea cada 5 min. */
let _lastSnapDay = null;
function startScheduler() {
  const HOUR = Number(process.env.TC_SNAPSHOT_HOUR || '18');
  setInterval(async () => {
    try {
      const day = fechaTZ();
      if (horaNum() === HOUR && _lastSnapDay !== day) {
        _lastSnapDay = day;
        const r = await snapshotNow();
        console.log('[TC] snapshot diario →', r.ok ? ('TC ' + r.snapshot.tc_ars_usdt) : ('FALLÓ ' + r.error));
      }
    } catch (e) { console.warn('[TC] scheduler error:', e.message); }
  }, 5 * 60 * 1000);
  console.log(`[TC] scheduler activo (snapshot diario ${HOUR}:00 ${TZ})`);
}

module.exports = { fetchTC, snapshotNow, tcAhora, startScheduler };
