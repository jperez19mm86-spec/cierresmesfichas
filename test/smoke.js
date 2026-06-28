/* Prueba end-to-end del esqueleto: levanta el server, ejercita el flujo y lo baja. */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const axios = require('axios');

const ROOT = path.join(__dirname, '..');
const BASE = 'http://localhost:4699';
const TESTDB = path.join(ROOT, 'data', 'test-smoke.sqlite');
const env = { ...process.env, PORT: '4699', PANEL_PASSWORD: 'admin', SESSION_SECRET: 'test', CRED_KEY: 'testkey', DB_PATH: TESTDB };

// DB de prueba AISLADA (no toca la base del server en vivo)
for (const f of [TESTDB, TESTDB + '-wal', TESTDB + '-shm']) { try { fs.rmSync(f, { force: true }); } catch (e) {} }

const srv = spawn('node', ['src/index.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
let srvlog = '';
srv.stdout.on('data', (d) => { srvlog += d; });
srv.stderr.on('data', (d) => { srvlog += d; });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let cookie = '';
const H = () => ({ validateStatus: () => true, headers: cookie ? { Cookie: cookie } : {} });
const get = (p) => axios.get(BASE + p, H());
const post = (p, b) => axios.post(BASE + p, b, H());
const put = (p, b) => axios.put(BASE + p, b, H());

async function waitUp() {
  for (let i = 0; i < 40; i++) {
    try { const r = await axios.get(BASE + '/login', { validateStatus: () => true, timeout: 1000 }); if (r.status) return true; } catch (e) {}
    await sleep(250);
  }
  throw new Error('server no levantó\n' + srvlog);
}

const asserts = [];
function check(name, cond, detail) { asserts.push({ name, ok: !!cond, detail }); console.log((cond ? '✅' : '❌') + ' ' + name + (detail ? '  → ' + detail : '')); }

async function main() {
  await waitUp();
  let r = await post('/api/login', { user: 'admin', password: 'admin' });
  cookie = (r.headers['set-cookie'] || []).map((c) => c.split(';')[0]).join('; ');
  check('login', r.data && r.data.ok && cookie);

  r = await get('/api/os/split-base');
  check('split_base seedeada', r.data.ok && r.data.split_base.length === 9, r.data.split_base.length + ' filas');
  check('split_base 11→empresa7/latam4', r.data.split_base.some((x) => x.pct_base === '11' && x.pct_empresa === '7' && x.pct_latam === '4'));

  const ale = (await post('/api/os/personas', { nombre: 'Ale' })).data.persona;
  const henry = (await post('/api/os/personas', { nombre: 'Henry' })).data.persona;
  check('personas creadas', ale && henry && ale.id && henry.id);

  const cli = (await post('/api/clientes', { codigo: 'L210', nombreVisible: 'Lu' })).data.cliente;
  check('cliente creado', cli && cli.id);
  await put('/api/os/clientes/' + cli.id + '/comercial', { mezcla_pago_usdt: '80', ajuste_usdt_pct: '-2.8', paga_proveedores: true });

  r = await put('/api/os/clientes/' + cli.id + '/precio-base', { valor: '11', tipo_cambio: 'vigencia', vigente_desde: '2026-06-01' });
  check('precio base vigencia 11%', r.data.ok && r.data.precio_base_pct === '11', r.data.precio_base_pct);

  r = await post('/api/os/participaciones', { cliente_id: cli.id, items: [{ persona_id: ale.id, porcentaje: '50' }, { persona_id: henry.id, porcentaje: '50' }], vigente_desde: '2026-06-01' });
  check('participaciones 50/50 ok', r.status === 200 && r.data.ok);
  r = await post('/api/os/participaciones', { cliente_id: cli.id, items: [{ persona_id: ale.id, porcentaje: '60' }] });
  check('participaciones !=100 rechazada', r.status === 400 && /100/.test(r.data.error || ''), r.data.error);

  const pan = (await post('/api/os/paneles', { cliente_id: cli.id, nombre: 'Ganamos', sistema: 'Casino', nivel_usuario: 'Agente', id_usuario: '7845834' })).data.panel;
  check('panel creado', pan && pan.id);

  // carga: 20.000.000 ARS al 11%, TC 1476 → fee 2.200.000 ARS → 1490.51 USDT
  r = await post('/api/os/movimientos/carga', { cliente_id: cli.id, panel_id: pan.id, carga: '20000000', tc: '1476', divisa: 'ARS' });
  const feeUsdt = r.data.equivUsdt;
  check('carga registrada', r.data.ok && r.data.movimiento, 'fee=' + feeUsdt + ' USDT');
  check('fee USDT correcto (~1490.5)', Math.abs(Number(feeUsdt) - (2200000 / 1476)) < 0.01, feeUsdt);

  r = await get('/api/os/clientes/' + cli.id + '/cuenta');
  check('deuda = fee de la carga', Math.abs(Number(r.data.cuenta.total) - Number(feeUsdt)) < 0.01, 'total=' + r.data.cuenta.total);

  r = await post('/api/os/movimientos/pago', { cliente_id: cli.id, monto_usdt: '1000' });
  check('pago baja deuda', Math.abs(Number(r.data.deuda.total) - (Number(feeUsdt) - 1000)) < 0.01, 'saldo=' + r.data.deuda.total);

  // split service directo
  const split = require('../src/split.service');
  const el = split.empresaLatam('11', '20000000');
  check('split empresa 7% = 1.400.000', el.ok && el.empresa === '1400000', el.empresa);
  check('split latam 4% = 800.000', el.latam === '800000', el.latam);
  const dist = split.distribuirLatam(el.latam, [{ persona_id: ale.id, porcentaje: '50' }, { persona_id: henry.id, porcentaje: '50' }]);
  check('latam repartido 400k c/u', dist[0].monto === '400000' && dist[1].monto === '400000');

  // proveedor diferencial: base 11, tarifa 17 (Sportbetting), profit 100000 → (17-11)% = 6% → 6000
  const provsvc = require('../src/proveedores.service');
  const dif = provsvc.diferencial({ base: '11', tarifa: '17', profitProveedor: '100000' });
  check('diferencial 6% sobre profit = 6000', dif.cobra && dif.monto === '6000', dif.monto);
  const dif0 = provsvc.diferencial({ base: '11', tarifa: '17', profitProveedor: '-50' });
  check('diferencial con profit<=0 no cobra', !dif0.cobra && dif0.monto === '0');

  r = await get('/api/os/reportes/mensual?mes=2026-06');
  check('reporte mensual arma por cliente', r.data.ok && r.data.clientes.length >= 1);

  // distribución empresa/LATAM/socios (de la carga 20M@11%, tc 1476)
  const curMes = new Date().toISOString().slice(0, 7);
  r = await get('/api/os/reportes/distribucion?mes=' + curMes);
  check('distribución empresa = 1.4M/1476', Math.abs(Number(r.data.empresa) - (1400000 / 1476)) < 0.1, 'empresa=' + r.data.empresa);
  check('distribución LATAM = 800k/1476', Math.abs(Number(r.data.latam) - (800000 / 1476)) < 0.1, 'latam=' + r.data.latam);
  check('socios 50/50 = mitad de LATAM c/u', (r.data.socios || []).length === 2 && Math.abs(Number(r.data.socios[0].monto) - (800000 / 1476 / 2)) < 0.1, JSON.stringify(r.data.socios));

  // panel /os se sirve (detrás de auth)
  r = await axios.get(BASE + '/os', H());
  check('panel /os sirve HTML', r.status === 200 && /LATAM Games/.test(r.data) && /VIEWS/.test(r.data));

  const fail = asserts.filter((a) => !a.ok);
  console.log('\n=== ' + (asserts.length - fail.length) + '/' + asserts.length + ' checks OK ===');
  srv.kill();
  process.exit(fail.length ? 1 : 0);
}
main().catch((e) => { console.error('SMOKE FAIL:', e.message); srv.kill(); process.exit(1); });
