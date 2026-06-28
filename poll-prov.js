// Poller: reintenta el reporte de proveedores GENERAL (toda la plataforma, ARS) hasta que el motor
// de reportes del casino se recupere. Al recuperarse, imprime filas para validar el mapeo de campos.
require('dotenv').config();
const conex = require('./src/casino-conexiones-store');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ID = process.argv[2] || 'cx_af7a0b4f01';
const FROM = process.argv[3] || '2026-05-01 00:00:00';
const TO = process.argv[4] || '2026-05-31 23:59:59';
const MAX = Number(process.argv[5] || 20);
const GAP = Number(process.argv[6] || 120000);

(async () => {
  const cli = conex.client(ID);
  if (!cli) return console.log('conexión no encontrada');
  for (let i = 1; i <= MAX; i++) {
    let p; try { p = await cli.reporteProveedores({ from: FROM, to: TO, currency: 'ARS', userGroupBy: '' }); } catch (e) { p = { ok: false, error: e.message }; }
    if (p.ok && p.filas && p.filas.length) {
      console.log(`\n✅ RECUPERADO en intento ${i}. filas=${p.filas.length} (vista general, ARS)`);
      const emptyMap = p.filas.every((x) => !x.provider && !x.label && !x.vendor);
      console.log('mapeo provider/label/vendor', emptyMap ? '⚠️ TODO VACÍO (revisar nombres de campo del reportstable)' : 'OK (poblado)');
      p.filas.slice(0, 12).forEach((x) => console.log('   ', JSON.stringify(x)));
      const prof = p.filas.reduce((a, x) => a + x.profit, 0);
      const bet = p.filas.reduce((a, x) => a + x.bet, 0);
      console.log('bet total', bet, '| profit total', prof);
      return;
    }
    console.log(`intento ${i}/${MAX}: ${p.ok ? ('ok pero ' + (p.filas ? p.filas.length : 0) + ' filas') : ('ERR ' + p.error)}`);
    if (i < MAX) await sleep(GAP);
  }
  console.log('\n⏳ se agotaron los intentos — el motor de reportes del casino sigue caído.');
})().catch((e) => console.log('ERR', e.message));
