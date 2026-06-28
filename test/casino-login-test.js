/* Prueba del login usuario/contraseña (2-pasos) contra la API real. Solo lectura.
   Uso: node test/casino-login-test.js <user> <password> [url] */
const { makeClient } = require('../src/casino-api');
const user = process.argv[2], password = process.argv[3];
const url = process.argv[4] || 'https://admin.463.life';
if (!user || !password) { console.error('uso: node test/casino-login-test.js <user> <password> [url]'); process.exit(1); }

const c = makeClient({ url, user, password }); // SIN token → modo sesión
const F = '2026-06-01 00:00:00', T = '2026-06-15 23:59:59';

(async () => {
  const t = await c.test();
  console.log('login user/pass → test:', t.ok, '| login:', t.login, '| ARS:', t.balances && t.balances.ARS);
  if (!t.ok) { console.log('ERROR:', t.error); process.exit(1); }
  const r = await c.nodos({ from: F, to: T });
  console.log('nodos vía cookie:', r.ok, '| count:', r.nodos && r.nodos.length);
  const m = r.ok && r.nodos.find((n) => n.id === '186350');
  if (m) console.log('MAGNATE 186350:', `in=${m.in} out=${m.out} profit=${m.profit} rtp=${m.rtp}`);
  console.log('USER/PASS MODE OK');
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
