/**
 * tc-binance.js — LAS DIVISAS SALEN DE BINANCE P2P, Y EL OFICIAL QUEDA DE RESPALDO.
 *
 * UYU oficial ~40,2 contra Binance P2P ~42,3 (14-oct-2026): con el oficial lo de UYU se cobraba ~5%
 * de más. Se simulan las dos fuentes para no depender de la red.
 */
process.env.DB_PATH = require('path').join(require('os').tmpdir(), `test-tcb-${Date.now()}.sqlite`);
const { db } = require('../src/db');
const tcDivisas = require('../src/tc-divisas.service');

let ok = 0, fail = 0;
const check = (t, c, extra) => { if (c) { ok++; console.log('✅ ' + t + (extra != null ? '  → ' + extra : '')); }
  else { fail++; console.log('❌ ' + t + (extra != null ? '  → ' + extra : '')); } };

// Las dos fuentes, de mentira: el oficial tiene todo; Binance tiene UYU y PYG, y CLP falla.
global.fetch = async (url) => {
  const u = String(url);
  if (u.includes('open.er-api.com')) return { ok: true, json: async () => ({ rates: { UYU: 40.2, PYG: 5930, CLP: 950, VES: 190, ARS: 1400 } }) };
  if (u.includes('criptoya.com/api/usdt/uyu')) return { ok: true, json: async () => ({ binancep2p: { ask: 42.3, bid: 41.65 } }) };
  if (u.includes('criptoya.com/api/usdt/pyg')) return { ok: true, json: async () => ({ binancep2p: { ask: 5764, bid: 5689 } }) };
  if (u.includes('criptoya.com/api/usdt/ves')) return { ok: true, json: async () => ({ binancep2p: { ask: 205 } }) };
  if (u.includes('criptoya.com')) return { ok: false, status: 404, json: async () => ({}) };
  throw new Error('url inesperada ' + u);
};

(async () => {
  console.log('\n🟡 divisas desde Binance P2P\n');
  // un día viejo con el oficial, como quedó todo hasta hoy
  db.prepare("INSERT INTO tc_divisa_snapshots (fecha,divisa,tasa,fuente,createdAt) VALUES ('2026-10-05','UYU','40.05','open.er-api.com','x')").run();
  check('con sólo días oficiales, el promedio es el oficial', tcDivisas.promedioMes('UYU', '2026-10') === '40.05');

  const r = await tcDivisas.snapshotHoy('2026-10-14');
  check('el snapshot del día sale bien', r.ok, JSON.stringify(r));
  const dia = (d) => db.prepare("SELECT tasa, fuente FROM tc_divisa_snapshots WHERE fecha='2026-10-14' AND divisa=?").get(d);
  check('UYU sale de Binance', dia('UYU').tasa === '42.3' && dia('UYU').fuente === tcDivisas.FUENTE_BINANCE, JSON.stringify(dia('UYU')));
  check('PYG sale de Binance', dia('PYG').tasa === '5764' && dia('PYG').fuente === tcDivisas.FUENTE_BINANCE);
  check('si Binance no tiene la moneda, queda el oficial', dia('CLP').tasa === '950' && dia('CLP').fuente === 'open.er-api.com');
  check('VEF copia a VES, y con su fuente', dia('VEF') && dia('VEF').tasa === '205' && dia('VEF').fuente === tcDivisas.FUENTE_BINANCE);
  check('el peso no se guarda acá', !dia('ARS'));
  check('el promedio del mes usa SÓLO los días de Binance', tcDivisas.promedioMes('UYU', '2026-10') === '42.3', tcDivisas.promedioMes('UYU', '2026-10'));
  const pm = tcDivisas.promediosMes('2026-10').find((x) => x.divisa === 'UYU');
  check('y la pantalla dice de dónde sale', pm && pm.fuente === 'Binance P2P' && pm.dias === 1, JSON.stringify(pm));

  console.log(`\n${ok} chequeos OK, ${fail} fallaron\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
