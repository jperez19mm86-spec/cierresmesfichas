/* Prueba del connector contra la API real. Uso: node test/casino-test.js <TOKEN> [url] */
const { makeClient } = require('../src/casino-api');
const token = process.argv[2];
const url = process.argv[3] || 'https://admin.463.life';
if (!token) { console.error('falta TOKEN: node test/casino-test.js <token> [url]'); process.exit(1); }

const c = makeClient({ url, token });
const F = '2026-06-01 00:00:00', T = '2026-06-15 23:59:59';

(async () => {
  const t = await c.test();
  console.log('test:', t.ok, '| login:', t.login, '| ARS:', t.balances && t.balances.ARS);
  if (!t.ok) { console.log('ERROR test:', t.error); process.exit(1); }

  const r = await c.nodos({ from: F, to: T });
  console.log('nodos root:', r.ok, '| count:', r.nodos && r.nodos.length);
  if (r.ok) {
    const m = r.nodos.find((n) => n.id === '186350');
    if (m) console.log('MAGNATE 186350:', `in=${m.in} out=${m.out} profit=${m.profit} rtp=${m.rtp}`);
  }

  const tot = await c.totalNodo({ nodeId: '186355', from: F, to: T });
  console.log('totalNodo 186355 (MAGNATE2):', tot.ok ? `in=${tot.nodo.in} profit=${tot.nodo.profit}` : tot.error);

  const hijos = await c.nodos({ from: F, to: T, id: '186350' });
  console.log('hijos de MAGNATE:', hijos.ok ? hijos.nodos.length : hijos.error);

  console.log('CONNECTOR OK');
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
