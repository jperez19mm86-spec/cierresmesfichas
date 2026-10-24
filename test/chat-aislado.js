/**
 * chat-aislado.js — UN ERROR DEL CHAT EXTERNO NO PUEDE TIRAR EL OS.
 *
 * El chat es otro producto que vive en el mismo servidor. Hasta el 24-oct-2026, si su archivo de
 * rutas no cargaba o su recordatorio no arrancaba, no arrancaba nada del OS. Ver `_montarChat` en
 * src/os.routes.js. Acá se rompe el chat a propósito y se mira que el resto siga.
 */
process.env.DB_PATH = require('path').join(__dirname, '..', 'data', 'test-chat-aislado.sqlite');
process.env.CHAT_AVISOS_OFF = '1';
['', '-wal', '-shm'].forEach((x) => { try { require('fs').unlinkSync(process.env.DB_PATH + x); } catch (e) {} });
const fs = require('fs');
const path = require('path');
const Module = require('module');

let ok = 0, fail = 0;
const check = (t, c, x) => { if (c) { ok++; console.log('✅ ' + t); } else { fail++; console.log('❌ ' + t + (x !== undefined ? '  → ' + x : '')); } };
console.log('\n🧯 el chat no tira el OS\n');

// Sin crons de verdad: no tienen que correr durante la prueba.
global.setInterval = () => ({ unref() {}, ref() {} });
const _st = global.setTimeout;
global.setTimeout = (f, ms, ...a) => (ms >= 2000 ? { unref() {}, ref() {} } : _st(f, ms, ...a));

// Un app que anota cada ruta y deja llamarla.
function appFalso() {
  const rutas = []; const cfg = {};
  const app = { set: (k, v) => (cfg[k] = v) };
  for (const m of ['get', 'post', 'put', 'patch', 'delete', 'use', 'all']) app[m] = (p, ...h) => {
    if (m === 'get' && !h.length) return cfg[p];
    rutas.push({ m, p, h });
  };
  return { app, rutas };
}
const llamar = (r) => new Promise((fin) => {
  const res = { statusCode: 200, status(c) { res.statusCode = c; return res; }, json: (b) => fin({ status: res.statusCode, b }) };
  r.h[r.h.length - 1]({ params: {}, query: {}, body: {} }, res);
});

// ── 1. El chat sano: monta como siempre, último ───────────────────────────────────────────────
const base = appFalso();
require('../src/os.routes').mount(base.app);
const ultimas = base.rutas.slice(-3).map((r) => r.p);
check('con el chat sano se montan sus rutas', base.rutas.some((r) => r.p === '/api/os/chat/config'));
check('y van al final, como antes', ultimas.every((p) => /chat|proveedor/.test(p)), ultimas.join(' '));
check('sin rutas de «no está»', !base.rutas.some((r) => r.m === 'all'));

// ── 2. El archivo del chat no carga ───────────────────────────────────────────────────────────
for (const k of Object.keys(require.cache)) if (/src[\\/](os\.routes|rutas[\\/])/.test(k)) delete require.cache[k];
const cargar = Module._load;
Module._load = function (pedido, ...resto) {
  if (/rutas[\\/]chat\.routes$/.test(pedido) || /\.\/rutas\/chat\.routes$/.test(pedido)) throw new Error('chat roto a propósito');
  if (/chat-avisos\.service$/.test(pedido)) return { startCron() { throw new Error('recordatorio roto a propósito'); } };
  return cargar.call(this, pedido, ...resto);
};
const roto = appFalso();
let tiro = null;
const _err = console.error; console.error = () => {};
try { require('../src/os.routes').mount(roto.app); } catch (e) { tiro = e.message; }
console.error = _err;
Module._load = cargar;
check('con el chat roto el OS monta igual', tiro === null, tiro);
const sinChat = (l) => l.filter((r) => !/\/chat|\/proveedor\//.test(r.p)).map((r) => r.m + ' ' + r.p);
check('y están todas las demás rutas, en el mismo orden', JSON.stringify(sinChat(roto.rutas)) === JSON.stringify(sinChat(base.rutas)),
  `${sinChat(roto.rutas).length} de ${sinChat(base.rutas).length}`);
const noEsta = roto.rutas.filter((r) => r.m === 'all');
check('las pantallas del chat contestan que no está', noEsta.map((r) => r.p).join(',') === '/api/os/chat/*,/api/os/proveedor/*,/chat-externo');
(async () => {
  const r = await llamar(noEsta[0]);
  check('con un 503 y un texto para la pantalla', r.status === 503 && r.b.ok === false && /chat no está disponible/.test(r.b.error), JSON.stringify(r));

  // ── 3. Lo que corre después de contestar, fuera del wrap ──────────────────────────────────
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'rutas', 'chat.routes.js'), 'utf8');
  const fin = src.split("res.on('finish', () => {").slice(1);
  check('los avisos de después de contestar están dentro de un try', fin.length === 2 && fin.every((b) => /^\s*(\/\/[^\n]*)?\s*try \{/.test(b)), fin.length);

  console.log(`\n${ok} chequeos OK, ${fail} fallaron\n`); process.exit(fail ? 1 : 0);
})();
