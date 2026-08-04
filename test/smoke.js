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

  // §12 — reparto de UN paso: los puntos suman el % BASE del cliente (11), no 100.
  // Este reparto es el equivalente exacto del viejo de dos pasos (split 11→empresa 7 / latam 4,
  // socios 50/50 de esos 4) escrito de un tirón: 7 + 2 + 2 = 11.
  const emp = (await get('/api/os/personas')).data.personas.find((p) => p.es_empresa);
  check('participante Empresa existe', !!emp, emp && emp.nombre);
  r = await post('/api/os/participaciones', { cliente_id: cli.id, mes: '2026-06', vigente_desde: '2026-06-01', items: [
    { persona_id: emp.id, porcentaje: '7' }, { persona_id: ale.id, porcentaje: '2' }, { persona_id: henry.id, porcentaje: '2' },
  ] });
  check('reparto 7+2+2 = base 11 ok', r.status === 200 && r.data.ok, 'suma=' + (r.data.suma || r.data.error));
  r = await post('/api/os/participaciones', { cliente_id: cli.id, mes: '2026-06', items: [{ persona_id: ale.id, porcentaje: '20' }] });
  check('reparto por ENCIMA de la base rechazado', r.status === 400 && /más de lo que paga/.test(r.data.error || ''), r.data.error);
  r = await post('/api/os/participaciones', { cliente_id: cli.id, mes: '2026-06', items: [{ persona_id: ale.id, porcentaje: '5' }] });
  check('reparto incompleto rechazado sin parcial', r.status === 400 && /debe sumar el 11%/.test(r.data.error || ''), r.data.error);
  // Con parcial:true se puede guardar a medio configurar; lo que falta queda "sin asignar".
  r = await post('/api/os/participaciones', { cliente_id: cli.id, mes: '2026-06', parcial: true, vigente_desde: '2026-06-02', items: [{ persona_id: emp.id, porcentaje: '7' }] });
  check('reparto parcial se guarda y avisa el resto', r.status === 200 && r.data.ok && r.data.resto === '4', 'resto=' + r.data.resto);
  // Volver al reparto completo para las comprobaciones de plata de más abajo.
  await post('/api/os/participaciones', { cliente_id: cli.id, mes: '2026-06', vigente_desde: '2026-06-01', items: [
    { persona_id: emp.id, porcentaje: '7' }, { persona_id: ale.id, porcentaje: '2' }, { persona_id: henry.id, porcentaje: '2' },
  ] });

  const pan = (await post('/api/os/paneles', { cliente_id: cli.id, nombre: 'Ganamos', sistema: 'Casino', nivel_usuario: 'Agente', id_usuario: '7845834' })).data.panel;
  check('panel creado', pan && pan.id);

  // ⚠️ Acá había un bloque que probaba POST /api/os/movimientos/carga (la "carga comercial"
  // manual). Esa ruta se SACÓ el 2-ago: calculaba el fee de una venta y lo sumaba a la deuda,
  // justo lo que ahora hace sola la Factura de consumo, y tenerla duplicada permitía cobrar dos
  // veces. El test quedó llamando a una ruta inexistente y fallando desde entonces.
  // Lo que sí sigue vivo es el registro de PAGOS, que es lo que se prueba ahora.
  r = await post('/api/os/movimientos/pago', { cliente_id: cli.id, monto_usdt: '1000' });
  check('pago registrado', r.status === 200 && r.data.ok, JSON.stringify(r.data.deuda || r.data.error));
  r = await get('/api/os/clientes/' + cli.id + '/cuenta');
  check('el pago deja la cuenta en -1000', Math.abs(Number(r.data.cuenta.total) + 1000) < 0.01, 'total=' + r.data.cuenta.total);

  // reparto de un paso — por la API, que corre en el proceso del server (el store cacheado
  // dentro del proceso del test no ve lo que el server escribió).
  r = await get('/api/os/reparto/' + cli.id + '?mes=2026-06');
  const rc = r.data.reparto || {};
  check('reparto cierra contra la base', rc.cierra && rc.base === '11' && rc.suma === '11', rc.estado + ' suma=' + rc.suma);
  check('el reparto tiene a la Empresa adentro', (rc.items || []).some((i) => i.es_empresa && i.pct === '7'), JSON.stringify(rc.items));

  // ── TBS: el tercer motor. Se prueba la lógica de lectura del árbol (lo que puede salir mal),
  // sin tocar la red: buscar un agente a cualquier profundidad y sumar SOLO sus hojas.
  {
    const tbs = require('../src/tbs-api');
    check('TBS normaliza la URL', tbs.normUrl('tbs2api.dark-a.com/index.php?act=diller') === 'https://tbs2api.dark-a.com',
      tbs.normUrl('tbs2api.dark-a.com/index.php?act=diller'));
    const c = tbs.makeClient({ url: 'tbs2api.dark-a.com', user: 'x', password: 'y' });
    const arbol = [{ id: 'raiz', tree: [
      { id: 'AG1', login: 'Agente1', tree: [{ id: 'sub', tree: [
        { id: 'h1', currency: 'ARS', bet: 100, win: 60 },
        { id: 'h2', currency: 'PYG', bet: 1000, win: 900 },
        { id: 'h3', currency: 'ARS', bet: 50, win: 20 }] }] },
      { id: 'AG2', login: 'Agente2', tree: [{ id: 'h4', currency: 'ARS', bet: 7, win: 2 }] }] }];
    const n = c.buscarNodo(arbol, 'AG1');
    check('TBS encuentra el agente anidado', n && n.login === 'Agente1', n && n.login);
    const s = c.sumarPorDivisa(n);
    check('TBS suma el profit por divisa (bet − win)', s.ARS.profit === 70 && s.PYG.profit === 100, JSON.stringify(s));
    check('TBS no mezcla los nodos de otro agente', s.ARS.bet === 150 && s.ARS.salas === 2, 'bet=' + s.ARS.bet);
    check('TBS devuelve null si el agente no está', c.buscarNodo(arbol, 'NOEXISTE') === null);
  }

  // ── emisión de VENDEDORES: es plata, así que lo que se prueba es que no se pueda cobrar dos
  // veces y que se pueda deshacer sin llevarse puesta la factura de externos del cliente.
  {
    const emision = require('../src/emision.service');
    const L = [{ cliente_id: cli.id, monto_usdt: '159620.69', base_pct: '0', notas: 'costo (vendedor)' }];
    const e1 = emision.emitir({ mes: '2026-05', origen: 'vendedores', lineas: L });
    check('emisión de vendedores crea el movimiento', e1.ok && e1.creados === 1, 'total=' + e1.total);
    const e2 = emision.emitir({ mes: '2026-05', origen: 'vendedores', lineas: L });
    check('emitir de nuevo NO duplica', e2.creados === 0 && e2.yaEstaban === 1, 'creados=' + e2.creados);
    const e3 = emision.emitir({ mes: '2026-05', origen: 'externos', lineas: [{ cliente_id: cli.id, monto_usdt: '50' }] });
    check('la factura de externos del cliente convive sin chocar', e3.creados === 1, 'creados=' + e3.creados);
    const an = emision.anular({ mes: '2026-05', origen: 'vendedores' });
    const queda = emision.emitido('2026-05');
    check('anular borra SOLO lo del vendedor', an.borrados === 1 && (queda.porOrigen.externos || {}).cantidad === 1 && !queda.porOrigen.vendedores,
      'borrados=' + an.borrados + ' queda=' + JSON.stringify(queda.porOrigen));
    emision.anular({ mes: '2026-05', origen: 'externos' });   // limpieza
  }

  // ⚠️ Acá se probaba `src/proveedores.service` (el diferencial de proveedores). Ese archivo se
  // BORRÓ el 2-ago (commit a3a155c): era un segundo motor de externos que calculaba lo mismo con
  // otros %, y no lo llamaba ninguna pantalla. El motor bueno es `externos.service`. El test
  // quedó requiriendo un módulo inexistente y se caía con "Cannot find module" desde entonces.

  // El mes REAL, no uno fijo: el reporte lee movimientos y el único que crea el smoke (el pago)
  // se sella con la fecha de hoy. Pedirle 2026-06 sólo pasaba si había datos de una corrida vieja.
  r = await get('/api/os/reportes/mensual?mes=' + new Date().toISOString().slice(0, 7));
  check('reporte mensual arma por cliente', r.data.ok && r.data.clientes.length >= 1, (r.data.clientes || []).length + ' clientes');

  // distribución por participante. Se facturan los PEDIDOS, así que hay que sembrar una venta:
  // sin esto el bloque no probaba nada (devolvía todo en cero y los checks pasaban vacíos).
  const curMes = new Date().toISOString().slice(0, 7);
  // El TC del mes: sin esto tcDelMes devuelve "SIN CARGAR" y la distribución sale en ARS crudos.
  // ⚠️ El TC del cierre se guarda con el mes en formato "Agosto_2026", NO ISO — `manual()` en
  // tc-unico.service busca por esa clave. Pasarle "2026-08" guarda una fila que nadie encuentra.
  const MESES_CIERRE = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
  const mesTC = MESES_CIERRE[Number(curMes.slice(5, 7)) - 1] + '_' + curMes.slice(0, 4);
  r = await post('/api/os/cierre/tc', { moneda: 'ARS', mes: mesTC, tasa: '1476' });
  check('TC del mes fijado en 1476', r.status === 200 && r.data.ok, mesTC + ' ' + JSON.stringify(r.data.error || ''));
  await post('/api/os/_dev/seed-ventas', { reset: true, items: [{ codigo: 'L210', monto: '20000000', divisa: 'ARS' }] });
  await post('/api/os/participaciones', { cliente_id: cli.id, mes: curMes, vigente_desde: curMes + '-01', items: [
    { persona_id: emp.id, porcentaje: '7' }, { persona_id: ale.id, porcentaje: '2' }, { persona_id: henry.id, porcentaje: '2' },
  ] });
  await put('/api/os/clientes/' + cli.id + '/precio-base', { valor: '11', tipo_cambio: 'vigencia', vigente_desde: curMes + '-01' });
  r = await get('/api/os/reportes/distribucion?mes=' + curMes);
  const byName = {}; (r.data.participantes || []).forEach((p) => { byName[p.nombre] = Number(p.monto); });
  check('distribución: Empresa = 1.4M/1476', Math.abs((byName.Empresa || 0) - (1400000 / 1476)) < 0.1, JSON.stringify(r.data.participantes));
  check('distribución: cada socio = 400k/1476', Math.abs((byName.Ale || 0) - (400000 / 1476)) < 0.1 && Math.abs((byName.Henry || 0) - (400000 / 1476)) < 0.1, JSON.stringify(r.data.participantes));
  check('el total del mes no cambió (2.2M/1476)', Math.abs(Number(r.data.total) - (2200000 / 1476)) < 0.1, 'total=' + r.data.total);
  check('nada quedó sin asignar', r.data.sin_asignar === '0', 'sin_asignar=' + r.data.sin_asignar);

  // panel /os se sirve (detrás de auth)
  r = await axios.get(BASE + '/os', H());
  check('panel /os sirve HTML', r.status === 200 && /LATAM Games/.test(r.data) && /VIEWS/.test(r.data));

  const fail = asserts.filter((a) => !a.ok);
  console.log('\n=== ' + (asserts.length - fail.length) + '/' + asserts.length + ' checks OK ===');
  srv.kill();
  process.exit(fail.length ? 1 : 0);
}
main().catch((e) => { console.error('SMOKE FAIL:', e.message); srv.kill(); process.exit(1); });
