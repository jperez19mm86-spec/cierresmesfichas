/* Paso 2c del relevamiento del panel (30-oct-2026): cabeceras de protección, sesiones que se pueden
   cortar, y los topes de intentos contando la IP de verdad detrás del proxy.
   Levanta el servidor con una base vacía, dos veces: la segunda con OTRA contraseña, para ver que
   cambiarla echa a quien ya estaba adentro. */
const { spawn } = require('child_process');
const fs = require('fs'); const os = require('os'); const path = require('path');

const ROOT = path.join(__dirname, '..');
const DB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sesiones-')), 's.sqlite');
const PORT = 4688; const BASE = `http://localhost:${PORT}`;
let ok = 0; let fail = 0;
const check = (t, c, x) => { if (c) { ok++; console.log('✅ ' + t); } else { fail++; console.log('❌ ' + t + (x ? '  → ' + x : '')); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function levantar(clave) {
  const env = { ...process.env, PORT: String(PORT), PANEL_USER: 'Duena', PANEL_PASSWORD: clave,
    OPERADOR_USER: 'Opera', OPERADOR_PASSWORD: 'op-1', SESSION_SECRET: 'test', CRED_KEY: 'testkey',
    DB_PATH: DB, CHAT_AVISOS_OFF: '1' };
  const srv = spawn('node', ['src/index.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  srv.log = ''; srv.stdout.on('data', (d) => { srv.log += d; }); srv.stderr.on('data', (d) => { srv.log += d; });
  return srv;
}
async function arriba() {
  for (let i = 0; i < 60; i++) { try { const r = await fetch(BASE + '/login'); if (r.status) return; } catch (e) { /* todavía no */ } await sleep(250); }
  throw new Error('el servidor no levantó');
}
const apagar = (srv) => new Promise((r) => { srv.on('exit', r); srv.kill(); });
async function entrar(user, password, extra = {}) {
  const r = await fetch(BASE + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json', ...extra }, body: JSON.stringify({ user, password }) });
  return { status: r.status, cookie: (r.headers.get('set-cookie') || '').split(';')[0] };
}
const con = (cookie, p, o = {}) => fetch(BASE + p, { ...o, headers: { ...(o.headers || {}), Cookie: cookie } });

(async () => {
  let srv = levantar('clave-1');
  try {
    await arriba();

    // ── Cabeceras ──
    const panel = await fetch(BASE + '/login');
    check('el panel no se deja meter en otra página (X-Frame-Options)', panel.headers.get('x-frame-options') === 'SAMEORIGIN');
    check('…y lo mismo con frame-ancestors', /frame-ancestors 'self'/.test(panel.headers.get('content-security-policy') || ''));
    check('nosniff en todo', panel.headers.get('x-content-type-options') === 'nosniff');
    check('HSTS', /max-age=\d+/.test(panel.headers.get('strict-transport-security') || ''));
    check('no dice que es Express', !panel.headers.get('x-powered-by'));
    const pedir = await fetch(BASE + '/pedir');
    check('las páginas de clientes sí se pueden mostrar adentro de otro sitio', !pedir.headers.get('x-frame-options'));

    // ── La IP de verdad ──
    const a = await entrar('Duena', 'clave-1');
    check('entra la dueña', a.status === 200 && /vf_session=/.test(a.cookie));
    const q = await (await con(a.cookie, '/api/quien', { headers: { 'x-forwarded-for': '9.9.9.9, 203.0.113.7' } })).json();
    check('detrás del proxy se toma la IP que agregó el proxy, no la que escribió el navegador', q.ip === '203.0.113.7', q.ip);

    // ── Topes: diez intentos fallidos desde OTRA dirección no dejan afuera a la dueña ──
    for (let i = 0; i < 11; i++) await entrar('Duena', 'mal', { 'x-forwarded-for': '198.51.100.' + (i % 2) });
    const desdeLaSuya = await entrar('Duena', 'clave-1', { 'x-forwarded-for': '203.0.113.7' });
    check('probar claves desde otro lado no bloquea a la dueña', desdeLaSuya.status === 200, desdeLaSuya.status);
    for (let i = 0; i < 11; i++) await entrar('Duena', 'mal', { 'x-forwarded-for': '198.51.100.50' });
    check('…pero sí al que las está probando', (await entrar('Duena', 'clave-1', { 'x-forwarded-for': '198.51.100.50' })).status === 429);

    // ── Cerrar todas las sesiones ──
    const vieja = (await entrar('Duena', 'clave-1')).cookie;
    const op = (await entrar('Opera', 'op-1')).cookie;
    check('la operadora entra', (await con(op, '/api/pedidos')).status === 200);
    await sleep(5);
    const corte = await con(a.cookie, '/api/os/sesiones/cerrar-todas', { method: 'POST' });
    const nueva = (corte.headers.get('set-cookie') || '').split(';')[0];
    check('cerrar todas contesta bien', corte.status === 200);
    check('quien lo aprieta sigue adentro con su sesión nueva', (await con(nueva, '/api/os/personas')).status === 200);
    check('la otra sesión de la dueña quedó afuera', (await con(vieja, '/api/os/personas')).status === 401);
    check('la operadora quedó afuera', (await con(op, '/api/pedidos')).status === 401);
    check('la operadora vuelve a entrar con su clave', (await con((await entrar('Opera', 'op-1')).cookie, '/api/pedidos')).status === 200);
    check('la operadora no puede cerrar las sesiones de nadie',
      (await con((await entrar('Opera', 'op-1')).cookie, '/api/os/sesiones/cerrar-todas', { method: 'POST' })).status === 403);

    // ── Cambiar la contraseña echa a quien estaba adentro ──
    const antesDelCambio = (await entrar('Duena', 'clave-1')).cookie;
    const opAntes = (await entrar('Opera', 'op-1')).cookie;
    await apagar(srv); await sleep(20);
    srv = levantar('clave-2'); await arriba();
    check('con la contraseña cambiada, la sesión de antes no vale', (await con(antesDelCambio, '/api/os/personas')).status === 401);
    check('la de la operadora (que no cambió su clave) sigue', (await con(opAntes, '/api/pedidos')).status === 200);
    check('con la nueva entra', (await entrar('Duena', 'clave-2')).status === 200);
    check('el arranque lo dice en el log', /cambió la contraseña de admin/.test(srv.log));
    const sigue = (await entrar('Duena', 'clave-2')).cookie;
    await apagar(srv); srv = levantar('clave-2'); await arriba();
    check('reiniciar sin cambiar la clave no echa a nadie', (await con(sigue, '/api/os/personas')).status === 200);
  } catch (e) { fail++; console.log('❌ ' + e.message + '\n' + srv.log.slice(-800)); }
  await apagar(srv);
  console.log(`\n${ok} chequeos OK, ${fail} fallaron\n`); process.exit(fail ? 1 : 0);
})();
