/* Prueba end-to-end del esqueleto: levanta el server, ejercita el flujo y lo baja. */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const axios = require('axios');

const ROOT = path.join(__dirname, '..');
const BASE = 'http://localhost:4699';
const TESTDB = path.join(ROOT, 'data', 'test-smoke.sqlite');
/* CHAT_AVISOS_OFF: el suite hace POST a /chat/aviso de verdad, y sin esto cada uno saldría por
   Telegram al grupo de la matriz. Va en el env del hijo Y en el del proceso del test, porque
   los checks también llaman al store en proceso. */
process.env.CHAT_AVISOS_OFF = '1';
const env = { ...process.env, PORT: '4699', PANEL_PASSWORD: 'admin', SESSION_SECRET: 'test', CRED_KEY: 'testkey', DB_PATH: TESTDB, CHAT_AVISOS_OFF: '1' };

// DB de prueba AISLADA (no toca la base del server en vivo)
for (const f of [TESTDB, TESTDB + '-wal', TESTDB + '-shm']) { try { fs.rmSync(f, { force: true }); } catch (e) {} }

const srv = spawn('node', ['src/index.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
let srvlog = '';
srv.stdout.on('data', (d) => { srvlog += d; });
srv.stderr.on('data', (d) => { srvlog += d; });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let cookie = '';
const H = () => ({ validateStatus: () => true, headers: cookie ? { Cookie: cookie } : {} });
// `extra` deja mandar cabeceras propias — hace falta para probar la cuenta del cliente, que va
// con su token en Authorization y no con la cookie del panel.
const get = (p, extra) => axios.get(BASE + p, extra ? { ...H(), headers: { ...(H().headers || {}), ...extra } } : H());
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

  // ── Pago a proveedores: la fórmula, contra una fila REAL de la planilla que el dueño hacía
  // a mano (Henry [henry_support] junio 2026): 3OAKS_OP · Europa · ARS.
  {
    const mo = require('../src/lib/money');
    const monto = mo.round(mo.pct('907286', '8.5'), 2);
    const usdt = mo.round(mo.div(monto, '1420.0'), 2);
    check('pago-proveedores: ganancia × costo = monto de la planilla', monto === '77119.31', monto);
    check('pago-proveedores: monto ÷ TC = USDT de la planilla', Math.abs(Number(usdt) - 54.3) < 0.05, usdt);
    const csv = require('../src/pago-proveedores.service').csv({
      mes: '2026-06', totales: { usdt: '54.31' },
      proveedores: [{ proveedor: '3OAKS OP', costo: '8.5', lineas: [{ conexion: 'Europa', divisa: 'ARS', profit: '907286', monto, tc: '1420.0', usdt }] }],
    });
    check('pago-proveedores: el CSV sale con el formato de siempre',
      csv.includes('Month/Year,Server,Currency') && csv.includes('3OAKS OP') && csv.includes('77119.31'), csv.split('\n')[1]);

    // El TC de externos NO es el del cliente: en pesos manda el del proveedor, salvo SL2 y BVS.
    const tcArs = require('../src/tc-store'); const tcU = require('../src/tc-unico.service');
    tcArs.addSnapshot({ tc_ars_usdt: '1574.42', fecha: '2026-04-15', hora: '18:00' });
    tcArs.setTcProveedor('2026-04', '1473.5');
    check('TC externos: en ARS manda el del proveedor', tcU.tcExternos('ARS', '2026-04', 'RUBYPLAY OP').valor === '1473.5',
      tcU.tcExternos('ARS', '2026-04', 'RUBYPLAY OP').valor);
    check('TC externos: SL2 va con el promedio del mes', tcU.tcExternos('ARS', '2026-04', 'PRAGMATIC SL2').valor === '1574.42',
      tcU.tcExternos('ARS', '2026-04', 'PRAGMATIC SL2').valor);
    check('TC externos: BVS también', tcU.tcExternos('ARS', '2026-04', '3OAKS BVS').valor === '1574.42');
    check('TC externos: SL (que NO es SL2) usa el del proveedor', tcU.tcExternos('ARS', '2026-04', 'WAZDAN SL').valor === '1473.5');
    check('TC externos: otra moneda no se toca',
      tcU.tcExternos('UYU', '2026-04', 'X').valor === tcU.tcDelMes('UYU', '2026-04').valor);
    // 🔑 Y la factura del CLIENTE no usa esa tasa: va siempre con el promedio del mes.
    check('TC cliente: la factura al cliente NO usa el del proveedor',
      tcU.tcDelMes('ARS', '2026-04').valor === '1574.42', tcU.tcDelMes('ARS', '2026-04').valor);
  }

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

    // Qué fila de la matriz le toca a cada grupo de TBS. Es lo que decide el COSTO, así que lo
    // que hay que probar es que no invente cuando la matriz es ambigua.
    const pp = require('../src/pago-proveedores.service');
    const filas = ['PRAGMATIC SZ', 'PLAYSON SZ', 'PRAGMATIC SL2', '3OAKS SL2', 'KAGAMING OP', 'RED TIGER OP', 'RED_TIGER OP', 'ALTENTE RL'];
    const costos = { 'pragmatic sz': '1', 'playson sz': '1', 'pragmatic sl2': '0.5', '3oaks sl2': '0.5', 'kagaming op': '10.5', 'red tiger op': '9.5', 'red_tiger op': '9.5', 'altente rl': '4' };
    let f = pp.filaDeGrupo({ id: 78, nombre: 'goldenneo' }, costos, filas);
    check('TBS: el grupo 78 es Slot Zona y cuesta 1', f.costo === '1' && /Slot Zona/.test(f.nombre), JSON.stringify(f));
    f = pp.filaDeGrupo({ id: 60, nombre: 'slgames2' }, costos, filas);
    check('TBS: el grupo 60 es SL2 y cuesta 0,5', f.costo === '0.5', JSON.stringify(f));
    f = pp.filaDeGrupo({ id: 84, nombre: 'op_kagaming' }, costos, filas);
    check('TBS: op_kagaming cae en KAGAMING OP', f.nombre === 'KAGAMING OP' && f.costo === '10.5', JSON.stringify(f));
    f = pp.filaDeGrupo({ id: 52, nombre: 'op_red_tiger' }, costos, filas);
    check('TBS: con dos filas iguales no elige, avisa', !!f.error && !f.nombre, f.error);
    f = pp.filaDeGrupo({ id: 999, nombre: 'lo_que_sea' }, costos, filas);
    check('TBS: un grupo desconocido no se factura', !!f.error && !f.nombre, f.error);
    f = pp.filaDeGrupo({ id: 78, nombre: 'goldenneo' }, { ...costos, 'playson sz': '3' }, filas);
    check('TBS: si las filas SZ no cuestan igual, no factura el paquete', !!f.error && /PLAYSON SZ/.test(f.error), f.error);
    // Las mesas en vivo llevan el mismo apellido pero cuestan 10: no fijan el precio del paquete.
    f = pp.filaDeGrupo({ id: 78, nombre: 'goldenneo' }, { ...costos, 'pragmatic_live_slot_zona': '10' },
      [...filas, 'PRAGMATIC_LIVE_SLOT_ZONA']);
    check('TBS: el vivo no le cambia el precio al paquete Slot Zona', f.costo === '1', JSON.stringify(f));
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

  // ── CADA MONEDA CON SU TIPO DE CAMBIO ────────────────────────────────────────────────────────
  // Esta pantalla dividía TODO por el TC del peso, incluso lo vendido en guaraníes o uruguayos.
  // En julio 2026 repartió 97.536,44 USDT cuando lo correcto eran 80.748,53 — a Fran, que vende
  // sólo en guaraníes, le contaba 15.246,61 en vez de 3.996,42.
  //
  // El probe usa DOS monedas con tasas bien separadas (1476 y 6000) a propósito: con una sola no
  // se distingue "convierte por divisa" de "convierte todo con la misma", que es justo el bug.
  await post('/api/os/cierre/tc', { moneda: 'PYG', mes: mesTC, tasa: '6000' });
  await post('/api/os/_dev/seed-ventas', { reset: true, items: [
    { codigo: 'L210', monto: '20000000', divisa: 'ARS' },   // 20.000.000 / 1476 = 13.550,14 USDT
    { codigo: 'L210', monto: '60000000', divisa: 'PYG' },   // 60.000.000 / 6000 = 10.000,00 USDT
  ] });
  r = await get('/api/os/reportes/distribucion?mes=' + curMes);
  const espVentas = 20000000 / 1476 + 60000000 / 6000;      // 23.550,14 — con el TC del peso daría 54.200,54
  check('reparto: cada divisa se pasa a USDT con SU tipo de cambio',
    Math.abs(Number(r.data.ventas_total) - espVentas) < 0.05,
    'ventas_total=' + r.data.ventas_total + ' esperado=' + espVentas.toFixed(2));
  check('reparto: el fee sale del total bien convertido',
    Math.abs(Number(r.data.total) - espVentas * 0.11) < 0.05,
    'total=' + r.data.total + ' esperado=' + (espVentas * 0.11).toFixed(2));
  check('reparto: informa qué tasa usó por moneda',
    (r.data.tcPorDivisa || []).some((t) => t.divisa === 'PYG' && Number(t.tc) === 6000)
    && (r.data.tcPorDivisa || []).some((t) => t.divisa === 'ARS' && Number(t.tc) === 1476),
    JSON.stringify(r.data.tcPorDivisa));

  // Una moneda SIN tasa cargada no se cuenta como si el TC fuera 1: se avisa y queda afuera. Antes
  // el `|| '1'` de la ruta hacía valer cada guaraní un dólar sin decir nada.
  await post('/api/os/_dev/seed-ventas', { reset: true, items: [
    { codigo: 'L210', monto: '20000000', divisa: 'ARS' },
    { codigo: 'L210', monto: '99999999', divisa: 'BOB' },   // sin TC cargado en el mes de prueba
  ] });
  r = await get('/api/os/reportes/distribucion?mes=' + curMes);
  check('reparto: la moneda sin TC se avisa y NO entra en el total',
    Math.abs(Number(r.data.ventas_total) - 20000000 / 1476) < 0.05
    && (r.data.problemas || []).some((p) => p.estado === 'sin_tc' && /BOB/.test(p.divisas || '')),
    'ventas_total=' + r.data.ventas_total + ' problemas=' + JSON.stringify(r.data.problemas));

  // Se deja como estaba para lo que venga después.
  await post('/api/os/_dev/seed-ventas', { reset: true, items: [{ codigo: 'L210', monto: '20000000', divisa: 'ARS' }] });

  // ── LA FACTURA, TAMBIÉN EN LA MONEDA DEL CLIENTE ─────────────────────────────────────────────
  // Se cobra en USDT pero el cliente vende en su moneda: quiere ver los 2.200.000 ARS al lado de
  // los 1.490,51 USDT. La comisión local es EXACTA (el % sobre lo vendido en su moneda), no la
  // conversión del total redondeado — convertir de vuelta da 2.200.005,64 y esos 5,64 no se
  // pueden explicar.
  {
    r = await get('/api/os/factura/' + cli.id + '?mes=' + curMes);
    const lo = (r.data.consumo || {}).local;
    check('factura: la comisión también en la moneda del cliente',
      !!lo && lo.divisa === 'ARS' && Math.abs(Number(lo.comision) - 2200000) < 0.01,
      JSON.stringify(lo));
    check('factura: la local es el % exacto, no el USDT convertido de vuelta',
      !!lo && Number(lo.comision) !== Number((Number(r.data.consumo.total_usdt) * 1476).toFixed(2)),
      'local=' + (lo || {}).comision + ' convertido=' + (Number(r.data.consumo.total_usdt) * 1476).toFixed(2));
    check('factura: el total del mes lleva su equivalente local',
      !!r.data.totalMes_local && r.data.totalMes_local.divisa === 'ARS'
      && Math.abs(Number(r.data.totalMes_local.monto) - 2200000) < 0.01,
      JSON.stringify(r.data.totalMes_local));
    check('factura: el texto para mandar dice las dos monedas',
      /1\.490,51 USDT/.test(r.data.texto) && /2\.200\.000,00 ARS/.test(r.data.texto),
      (r.data.texto || '').split('\n').filter((l) => /USDT/.test(l)).join(' | '));
  }

  // Con DOS monedas no hay un total local que signifique nada: sumar guaraníes con pesos es el
  // error que ya nos costó el Reparto. Se muestra el de cada renglón y NINGÚN total inventado.
  {
    await post('/api/os/_dev/seed-ventas', { reset: true, items: [
      { codigo: 'L210', monto: '20000000', divisa: 'ARS' },
      { codigo: 'L210', monto: '60000000', divisa: 'PYG' },
    ] });
    r = await get('/api/os/factura/' + cli.id + '?mes=' + curMes);
    check('factura: con dos monedas NO se inventa un total local',
      (r.data.consumo || {}).local === null && r.data.totalMes_local === null,
      'local=' + JSON.stringify((r.data.consumo || {}).local) + ' total=' + JSON.stringify(r.data.totalMes_local));

    // Lo que SÍ se puede mostrar con varias monedas: la comisión exacta de cada una.
    // ARS 20.000.000 × 11% = 2.200.000 / 1476 = 1.490,51 USDT
    // PYG 60.000.000 × 11% = 6.600.000 / 6000 = 1.100,00 USDT
    const cpd = (r.data.consumo || {}).comisionPorDivisa || [];
    const porDiv = {}; cpd.forEach((c) => { porDiv[c.divisa] = c; });
    check('factura: la comisión de cada moneda, en esa moneda',
      cpd.length === 2
      && Math.abs(Number((porDiv.ARS || {}).monto) - 2200000) < 0.01
      && Math.abs(Number((porDiv.PYG || {}).monto) - 6600000) < 0.01,
      JSON.stringify(cpd));
    // 🔑 LA INVARIANTE: los USDT de cada moneda suman el total. Es la cuenta que el cliente rehace
    // renglón por renglón; si no cerrara, el desglose contradiría al total de arriba.
    check('factura: los USDT de cada moneda suman el total',
      cpd.length > 1
      && Math.abs(cpd.reduce((a, c) => a + Number(c.usdt || 0), 0) - Number(r.data.consumo.total_usdt)) < 0.02,
      'suma=' + cpd.reduce((a, c) => a + Number(c.usdt || 0), 0) + ' total=' + (r.data.consumo || {}).total_usdt);
    check('factura: el texto muestra el desglose por moneda',
      /PYG 6\.600\.000,00 → 1\.100,00 USDT/.test(r.data.texto),
      (r.data.texto || '').split('\n').filter((l) => /PYG|ARS/.test(l)).join(' | '));
    await post('/api/os/_dev/seed-ventas', { reset: true, items: [{ codigo: 'L210', monto: '20000000', divisa: 'ARS' }] });
  }

  // ── UN PAGO QUE ESPERA EL TIPO DE CAMBIO DEL CIERRE ──────────────────────────────────────────
  // Hay clientes que pagan en pesos todo el mes y el cambio recién se acuerda al cerrarlo. Antes
  // había que elegir entre inventar un TC —guardando un número que no es el real— o no aprobar el
  // pago, dejando al cliente como deudor de algo que ya pagó.
  //
  // Con tc_modo:'mes' se guarda SÓLO los pesos y los dólares se derivan al leer. Lo que este check
  // mide es justamente eso: que cambiar el TC del mes cambie lo que vale el pago, SIN tocarlo.
  {
    const antes = Number((await get('/api/os/clientes/' + cli.id + '/cuenta')).data.cuenta.total);
    r = await post('/api/comprobante', { codigo: 'L210', via: 'cvu', monto: '1476000', divisa: 'ARS' });
    const cid = r.data && r.data.comprobante && r.data.comprobante.id;
    check('pago sin TC: el comprobante entra', !!cid, JSON.stringify(r.data).slice(0, 200));

    r = await post('/api/os/comprobantes/' + cid + '/resolver', { estado: 'aprobado', monto: '1476000', tc_modo: 'mes' });
    check('pago sin TC: se aprueba sin pedir tipo de cambio', r.status === 200 && r.data.ok, JSON.stringify(r.data.error || ''));
    const mv = r.data.movimiento || {};
    check('pago sin TC: guarda los pesos y NO inventa los dólares',
      String(mv.monto_ars) === '1476000' && (mv.monto_usdt == null || mv.monto_usdt === '') && mv.tc_modo === 'mes',
      'ars=' + mv.monto_ars + ' usdt=' + mv.monto_usdt + ' modo=' + mv.tc_modo);

    // Con el TC del mes en 1476, ese pago vale 1000 USDT y baja la deuda en 1000.
    let cta = (await get('/api/os/clientes/' + cli.id + '/cuenta')).data.cuenta;
    check('pago sin TC: igual cuenta en el saldo, valuado con el TC del mes',
      Math.abs((antes - Number(cta.total)) - 1000) < 0.01,
      'antes=' + antes + ' ahora=' + cta.total + ' (esperaba bajar 1000)');
    check('pago sin TC: con el TC cargado a mano NO figura como provisorio',
      cta.esperandoTC === 0 && cta.sinValuar === 0,
      'esperandoTC=' + cta.esperandoTC + ' sinValuar=' + cta.sinValuar);

    // 🔑 LO QUE PIDIÓ LA DUEÑA: se carga el TC definitivo del cierre y el pago se ajusta SOLO.
    await post('/api/os/cierre/tc', { moneda: 'ARS', mes: mesTC, tasa: '1500' });
    cta = (await get('/api/os/clientes/' + cli.id + '/cuenta')).data.cuenta;
    check('pago sin TC: al cambiar el TC del mes, el pago se revalúa solo',
      Math.abs((antes - Number(cta.total)) - (1476000 / 1500)) < 0.01,
      'bajó ' + (antes - Number(cta.total)).toFixed(2) + ', esperaba ' + (1476000 / 1500).toFixed(2));

    await post('/api/os/cierre/tc', { moneda: 'ARS', mes: mesTC, tasa: '1476' });   // como estaba

    // ── LO QUE EL CLIENTE RECIBE TIENE QUE DECIR LO MISMO QUE EL SALDO ─────────────────────────
    // La primera versión valuaba sólo en la cuenta corriente: el saldo bajaba 1.000 pero la
    // factura listaba ese pago en "0,00" y no imprimía el renglón "pagado este mes". El documento
    // se contradecía a sí mismo. Ahora la valuación vive en el store, así que la ve todo el mundo.
    r = await get('/api/os/factura/' + cli.id + '?mes=' + curMes);
    // Se busca ESTE pago por su comprobante: el mes puede tener otros y contar filas no dice nada.
    const pg = (r.data.pagosDelMes || []).find((x) => String(x.notas || '').includes(cid));
    check('pago sin TC: la factura lo lista por su valor, no en cero',
      !!pg && Math.abs(Number(pg.usdt) - 1000) < 0.01,
      'la fila de ' + cid + ' = ' + JSON.stringify(pg) + ' · todas: ' + JSON.stringify(r.data.pagosDelMes));
    check('pago sin TC: el texto que se manda no lo muestra en 0,00',
      !/· 0,00/.test(r.data.texto), (r.data.texto || '').split('\n').filter((l) => /0,00/.test(l)).join(' | '));

    // Un pago en la MISMA moneda de la cuenta no depende de ningún TC, aunque se apriete el ⏳.
    // Marcarlo como provisorio decía "este pago no entra en el saldo" sobre uno íntegramente
    // contado — que es una invitación a acreditarlo dos veces.
    r = await post('/api/comprobante', { codigo: 'L210', via: 'usdt', monto: '50', divisa: 'USDT' });
    const cid2 = r.data && r.data.comprobante && r.data.comprobante.id;
    r = await post('/api/os/comprobantes/' + cid2 + '/resolver', { estado: 'aprobado', monto: '50', tc_modo: 'mes' });
    check('pago sin TC: si pagó en la moneda de la cuenta, no queda nada pendiente',
      r.status === 200 && r.data.ok && !r.data.movimiento.tc_modo,
      'tc_modo=' + (r.data.movimiento || {}).tc_modo);
    const cta2 = (await get('/api/os/clientes/' + cli.id + '/cuenta')).data.cuenta;
    check('pago sin TC: no avisa "provisorio" sobre un pago que sí está contado',
      cta2.esperandoTC === 0 && cta2.sinValuar === 0,
      'esperandoTC=' + cta2.esperandoTC + ' sinValuar=' + cta2.sinValuar);

    // La pantalla manda en qué moneda cree que está el monto; si no coincide, se frena. Sin esto
    // un número en pesos entra como dólares —1.476.000 en vez de 1.000— y nadie se entera.
    r = await post('/api/comprobante', { codigo: 'L210', via: 'cvu', monto: '100000', divisa: 'ARS' });
    const cid3 = r.data && r.data.comprobante && r.data.comprobante.id;
    r = await post('/api/os/comprobantes/' + cid3 + '/resolver', { estado: 'aprobado', monto: '100000', moneda: 'USDT', tc_modo: 'mes' });
    check('pago sin TC: si la pantalla y el servidor no coinciden en la moneda, se frena',
      r.status === 400 && /ARS/.test(r.data.error || ''), 'HTTP ' + r.status + ' ' + (r.data.error || ''));
    await post('/api/os/comprobantes/' + cid3 + '/resolver', { estado: 'rechazado', motivo: 'prueba' });
  }

  // ── LA TARJETA DEL COMPROBANTE TIENE QUE ENTRAR EN LA PANTALLA ───────────────────────────────
  // El CSS pone `.row > div { flex:1; min-width:120px }`, así que un renglón con 7 elementos pide
  // 924px de mínimo. Con el panel lateral eso no entra: el renglón se partía, el botón "⏳ Con el
  // TC del mes" quedaba FUERA DE LA VISTA y lo que se apretaba era el de al lado — que pide el
  // monto en OTRA moneda. Un botón que no se ve es un botón que no existe.
  //
  // Se evalúa el trozo REAL que genera la tarjeta, no se busca texto: lo que se mide es la
  // estructura que va a ver la dueña.
  {
    const html3 = require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'os.html'), 'utf8');
    const ini = html3.indexOf('      + (pend\n');
    // El corte va por la ESTRUCTURA —el `: ` del ternario, a su indentación— y no por el texto de
    // la rama de al lado: ese texto cambia cada vez que se toca la tarjeta resuelta, y entonces el
    // recorte devuelve vacío. La primera versión cortaba por texto y se rompió al primer cambio.
    const fin = html3.indexOf('\n        : ', ini);
    const trozo = html3.slice(ini, fin) + '\n        : \'\')';
    const esc = (x) => String(x == null ? '' : x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const _cmpMoneda = () => 'USDT';
    const c = { id: 'cmp_t', codigo: 'L210', monto: '200000', divisa: 'ARS' };
    const pend = true;
    let marca = '';
    try { marca = eval('(function(){return \'\' ' + trozo + ';})()'); } catch (e) { marca = 'ERROR ' + e.message; }

    check('comprobante: el recorte de la tarjeta encontró algo que medir',
      fin > ini && /<button/.test(marca), 'ini=' + ini + ' fin=' + fin + ' largo=' + marca.length);
    check('comprobante: la tarjeta cierra todos sus divs',
      (marca.match(/<div/g) || []).length === (marca.match(/<\/div>/g) || []).length,
      (marca.match(/<div/g) || []).length + ' abiertos / ' + (marca.match(/<\/div>/g) || []).length + ' cerrados');

    // Cuántos hijos DIRECTOS tiene cada .row: es lo que decide el ancho mínimo del renglón.
    const filas = [];
    for (let i = marca.indexOf('class="row"'); i >= 0; i = marca.indexOf('class="row"', i + 1)) {
      let d = 0, hijos = 0, j = marca.indexOf('>', i);
      for (let k = j; k < marca.length; k++) {
        if (marca.startsWith('<div', k)) { if (d === 0) hijos++; d++; }
        else if (marca.startsWith('</div>', k)) { if (d === 0) break; d--; }
      }
      filas.push(hijos);
    }
    const maxAncho = Math.max(...filas.map((n) => n * 120 + (n - 1) * 10));
    check('comprobante: ningún renglón pide más ancho del que hay',
      filas.length > 0 && maxAncho <= 700,
      'hijos por renglón: [' + filas + '] → hasta ' + maxAncho + 'px de mínimo');

    // Cada botón, con el campo que lee. El ⏳ acredita en la moneda del PAGO y el ✅ en la de la
    // CUENTA: si se mezclan, se acredita un número en la moneda equivocada.
    const iU = marca.indexOf('cmp-u-'), iOk = marca.indexOf('Aprobar y acreditar');
    const iM = marca.indexOf('cmp-m-'), iMes = marca.indexOf('Aprobar con el TC del mes');
    check('comprobante: cada botón va con su propio campo',
      iU > 0 && iM > 0 && iOk > iU && iMes > iM && iM > iOk,
      'acreditar=' + iU + ' ✅=' + iOk + ' entraron=' + iM + ' ⏳=' + iMes);
  }

  // ── VER LOS COMPROBANTES DE UN CLIENTE ───────────────────────────────────────────────────────
  // El filtro va al SERVIDOR: la lista viene con tope, así que recortarla en pantalla filtraría
  // sólo un pedazo el día que haya cientos. Y el desplegable se arma con un resumen aparte que
  // viene ENTERO aunque se filtre — armado con la lista filtrada, elegir un cliente dejaría el
  // desplegable con ese solo y no habría cómo volver a otro.
  {
    const todos = await get('/api/os/comprobantes');
    check('comprobantes: la respuesta trae el resumen por cliente',
      Array.isArray(todos.data.porCliente) && todos.data.porCliente.length > 0
      && todos.data.porCliente.every((x) => x.codigo && typeof x.total === 'number'),
      JSON.stringify((todos.data.porCliente || []).slice(0, 2)));
    const filtrado = await get('/api/os/comprobantes?codigo=L210');
    check('comprobantes: filtrar por cliente devuelve sólo los suyos',
      (filtrado.data.comprobantes || []).length > 0
      && (filtrado.data.comprobantes || []).every((c) => c.codigo === 'L210'),
      'n=' + (filtrado.data.comprobantes || []).length);
    check('comprobantes: el resumen sigue completo aunque se filtre',
      (filtrado.data.porCliente || []).length === (todos.data.porCliente || []).length,
      'sin filtro=' + (todos.data.porCliente || []).length + ' filtrado=' + (filtrado.data.porCliente || []).length);
    const h7 = require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'os.html'), 'utf8');
    check('comprobantes: la pantalla manda el filtro al servidor',
      /_cmpCli \? 'codigo=' \+ encodeURIComponent\(_cmpCli\)/.test(h7)
      && /<select id="cmp-cli"/.test(h7));
    // "No hay nada" con un filtro puesto es mentira: hay, pero de otro cliente.
    check('comprobantes: el vacío con filtro dice que es por el filtro',
      /Ese cliente no tiene comprobantes/.test(h7) && /Ver todos los clientes/.test(h7));
  }

  // ── LA PANTALLA DEL REPORTE DIARIO DE TBS ────────────────────────────────────────────────────
  {
    const h12 = require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'os.html'), 'utf8');
    check('tbs diario: tiene su pestaña y su vista', /\['tbsdiario','📅 Reporte diario'\]/.test(h12)
      && /VIEWS\.tbsdiario = async/.test(h12));
    // EN SERIE y no en paralelo: son consultas caras contra el panel de un tercero, y dispararle
    // 31 de golpe es cómo se corta la conexión o vuelve basura.
    check('tbs diario: la captura va de a un día, en orden',
      /for\(let i=0;i<dias\.length;i\+\+\)/.test(h12) && !/Promise\.all\(dias/.test(h12));
    check('tbs diario: si un día falla, frena y dice cuál',
      /Se frenó en/.test(h12) && /if\(!r\.ok\)/.test(h12));
    // Un botón que se puede apretar dos veces dispara dos recorridas sobre el mismo panel.
    check('tbs diario: no se puede disparar dos veces a la vez',
      /if\(_tdCapturando\) return;/.test(h12) && /_tdCapturando = true/.test(h12));
    // La pantalla es POR CLIENTE: la pregunta es cómo viene cada uno, no cuánto movió el panel.
    check('tbs diario: la pantalla arma la tabla por cliente',
      /const vivos = \(dat\.clientes\|\|\[\]\)/.test(h12)
      && !/Total del mes por divisa/.test(h12));

    /* ── LA LÓGICA, PROBADA CON NÚMEROS Y NO MIRANDO EL ARCHIVO ─────────────────────────────
       Los checks de esta pantalla eran todos expresiones regulares sobre el HTML: verificaban
       que el texto estuviera escrito, no que la cuenta diera bien. Las tres funciones que
       deciden qué dice cada fila están sueltas arriba del archivo justamente para poder
       sacarlas y correrlas. Se extraen por nombre; si alguna dejara de existir, `armar` tira y
       el check falla, que es lo que tiene que pasar — no puede pasar en el vacío. */
    const armar = (nombres) => {
      const cuerpo = nombres.map((n) => {
        const i = h12.indexOf('\nfunction ' + n + '(');
        if (i < 0) throw new Error('no está la función ' + n);
        // Se corta en la próxima llave que cierra a nivel 0: es JS de verdad, no un recorte por
        // línea que se rompe con el siguiente edit.
        let d = 0, arr = false, j = h12.indexOf('{', i);
        for (let k = j; k < h12.length; k++) {
          const ch = h12[k];
          if (ch === '{') d++;
          else if (ch === '}') { d--; if (!d) { arr = k; break; } }
        }
        if (arr === false) throw new Error('no cierra la función ' + n);
        return h12.slice(i, arr + 1);
      }).join('\n');
      const money = (n, dd = 2) => Number(n || 0).toLocaleString('es-AR',
        { minimumFractionDigits: dd, maximumFractionDigits: dd });
      // eslint-disable-next-line no-new-func
      return new Function('money', cuerpo + '\nreturn {' + nombres.join(',') + '};')(money);
    };
    const TD = armar(['tdMesAnterior', 'tdComparar', 'tdVeredicto', 'tdDelta']);

    // El mes anterior se calcula a mano y no con Date(): 'YYYY-MM' pasado por Date se corre de mes
    // según la zona del navegador, y el reporte compararía contra el mes equivocado.
    check('tbs diario: el mes anterior cruza bien el año',
      TD.tdMesAnterior('2026-08') === '2026-07' && TD.tdMesAnterior('2026-01') === '2025-12'
      && TD.tdMesAnterior('2026-10') === '2026-09',
      TD.tdMesAnterior('2026-01'));

    /* EL CASO QUE ORIGINÓ TODO. Con datos reales de agosto contra julio: un cliente puede bajar el
       profit por dos motivos opuestos, y con el profit solo se ven iguales.
         · trae menos jugado  → se le está yendo el negocio, hay que llamarlo
         · ganaron los jugadores → juega lo mismo, es racha, se da vuelta solo */
    const seVa = TD.tdComparar({ bet: 61, win: 56, profit: 5 }, { bet: 100, win: 92, profit: 8 });
    const racha = TD.tdComparar({ bet: 100, win: 96, profit: 4 }, { bet: 100, win: 88, profit: 12 });
    /* El cartel nombra los DOS movimientos —jugado y profit— y el TONO lo sigue decidiendo el
       jugado, que es el único que significa que se está yendo el cliente. */
    check('tbs diario: distingue perder el negocio de perder una racha',
      TD.tdVeredicto(seVa, 'julio').tono === 'mal'
      && /menos jugado, menos profit/.test(TD.tdVeredicto(seVa, 'julio').txt)
      && TD.tdVeredicto(racha, 'julio').tono === 'ojo'
      && /ganaron los jugadores/.test(TD.tdVeredicto(racha, 'julio').det),
      'jugado −39% → ' + TD.tdVeredicto(seVa, 'julio').txt
      + ' | queda 12%→4% con el mismo jugado → ' + TD.tdVeredicto(racha, 'julio').txt);
    // Y el que crece, y el que no se movió.
    const sube = TD.tdComparar({ bet: 200, win: 180, profit: 20 }, { bet: 100, win: 90, profit: 10 });
    const igual = TD.tdComparar({ bet: 102, win: 92, profit: 10 }, { bet: 100, win: 90, profit: 10 });
    /* El detalle de "ganaron los jugadores" decía "juega lo mismo", y era falso cuando el jugado
       había subido ×10 —el caso real de TBSEcuaB—. La conclusión no cambia (el negocio no se fue),
       pero el motivo escrito al lado tiene que ser el de ESTE cliente. */
    const subeYpierde = TD.tdComparar({ bet: 6300, win: 6362, profit: -62 }, { bet: 605, win: 481, profit: 124 });
    const vSube = TD.tdVeredicto(subeYpierde, 'julio');
    const vIgual = TD.tdVeredicto(racha, 'julio');
    check('tbs diario: no dice "juega lo mismo" de uno que jugó diez veces más',
      /más jugado, menos profit/.test(vSube.txt) && /ganaron los jugadores/.test(vSube.det)
      && /mismo jugado, menos profit/.test(vIgual.txt) && /juega lo mismo/.test(vIgual.det),
      vSube.txt + ' — ' + vSube.det + '  ·  ' + vIgual.txt + ' — ' + vIgual.det);

    check('tbs diario: el que crece y el que no se movió',
      /más jugado, más profit/.test(TD.tdVeredicto(sube, 'julio').txt)
      && TD.tdVeredicto(igual, 'julio').txt === 'igual que en julio',
      TD.tdVeredicto(sube, 'julio').txt + ' · ' + TD.tdVeredicto(igual, 'julio').txt);

    /* ── EL CASO QUE PIDIÓ ESTE CAMBIO ────────────────────────────────────────────────────
       NachoAPI: jugaron 11% menos y aun así quedó 11% más. El cartel decía «estable», que es
       verdad de ninguna de las dos cosas y escondía la única noticia del renglón. */
    const menosMas = TD.tdComparar({ bet: 59176, win: 52408, profit: 6768 },
                                   { bet: 66497, win: 60406, profit: 6091 });
    const vMM = TD.tdVeredicto(menosMas, 'julio');
    /* ── LA COMPARATIVA QUE SE MANDA POR TELEGRAM ────────────────────────────────────────────
       Es el mensaje que se escribía a mano. Dos cosas tienen que ser ciertas siempre:
       el tramo es el que está capturado en LOS DOS meses, y el texto lo arma el SERVIDOR. */
    {
      const CMP = require('../src/tbs-comparativa');
      check('comparativa: el mes anterior cruza bien el año',
        CMP.mesAnterior('2026-01') === '2025-12' && CMP.mesAnterior('2026-08') === '2026-07');
      // El % sobre una base negativa o en cero apunta para el lado contrario: va la diferencia sola.
      const d = { ok: true, mes: '2026-08', mesAnt: '2026-07', dias: 2, desde: '01', hasta: '02',
        sinDatos: [], filas: [{ nombre: 'X', moneda: 'ARS', dentroDe: null, otras: [],
          nue: { bet: 100, win: 40, profit: 60 }, ant: { bet: 200, win: 210, profit: -10 } }] };
      const t = CMP.textoPlano(d);
      const lProfit = t.split('\n').find((x) => x.startsWith('PROFIT')) || '';
      const lIn = t.split('\n').find((x) => x.startsWith('IN')) || '';
      check('comparativa: no pone un porcentaje sobre una base negativa',
        // el IN va de 200 a 100 y sí lleva %; el PROFIT viene de −10 y ahí el % mentiría,
        // así que en el paréntesis va la diferencia en plata.
        /\(−50%\)/.test(lIn) && !/%/.test(lProfit) && /\(\+70,00\)/.test(lProfit),
        lIn + '  ||  ' + lProfit);
      check('comparativa: dice contra qué tramo se está comparando',
        /los mismos 2 días de los dos meses/.test(t), t.split('\n').slice(-2).join(' | '));
    }

    check('tbs diario: "menos jugado, más profit" no se dice "estable"',
      vMM.txt === 'menos jugado, más profit' && /lo puso el RTP/.test(vMM.det),
      vMM.txt + ' — ' + vMM.det);

    /* La dirección del profit sale de los números crudos, no del porcentaje: cuando el mes pasado
       dio pérdida no hay porcentaje posible y antes eso se leía como "mismo profit". */
    const salioDePerdida = TD.tdComparar({ bet: 100, win: 80, profit: 20 }, { bet: 100, win: 110, profit: -10 });
    check('tbs diario: sin porcentaje posible igual sabe para qué lado se movió el profit',
      /más profit/.test(TD.tdVeredicto(salioDePerdida, 'julio').txt),
      TD.tdVeredicto(salioDePerdida, 'julio').txt);

    /* ── EL QUE NO JUGABA EL MES PASADO ────────────────────────────────────────────────────
       Una cuenta que arrancó de cero daba +1.716.225% y otra +25.079%. No es un error de cálculo
       —es literalmente lo que creció— pero al lado del −39% sobre 98 millones de colones se
       llevaba toda la atención, y el −39% es el que hay que atender. */
    const cero = TD.tdComparar({ bet: 100000, win: 90000, profit: 10000 }, { bet: 6, win: 5, profit: 1 });
    check('tbs diario: el que no jugaba el mes pasado lo dice, no muestra un porcentaje absurdo',
      cero.nuevo === true && cero.vol === null && cero.volP === null
      && TD.tdVeredicto(cero, 'julio').txt === 'nuevo');
    // Pero uno que sí jugaba y creció mucho NO es "nuevo": es un cliente que creció, y hay que verlo.
    const crecio = TD.tdComparar({ bet: 1000, win: 900, profit: 100 }, { bet: 100, win: 90, profit: 10 });
    check('tbs diario: crecer mucho no es lo mismo que arrancar de cero',
      crecio.nuevo === false && Math.round(crecio.vol) === 900 && Math.round(crecio.rVol) === 10);
    // Y a partir de 6 veces se cambia de unidad: "+900%" hay que traducirlo, "×10" no.
    check('tbs diario: los saltos grandes se dicen en veces, no en porcentaje',
      TD.tdDelta(900, 10) === '×10' && TD.tdDelta(2, 1.02) === '+2%' && TD.tdDelta(-39, 0.61) === '-39%',
      TD.tdDelta(900, 10) + ' / ' + TD.tdDelta(2, 1.02) + ' / ' + TD.tdDelta(-39, 0.61));
    // Redondear −0,4% daba "-0%", que se lee como una caída y no es ninguna.
    check('tbs diario: no se moverse no se muestra como "-0%"',
      TD.tdDelta(-0.4, 0.996) === '0%' && TD.tdDelta(0.2, 1.002) === '0%',
      TD.tdDelta(-0.4, 0.996));
    // Comparar el profit contra una pérdida no se entiende ("cayó 300%" desde −62).
    const desdePerdida = TD.tdComparar({ bet: 100, win: 110, profit: -10 }, { bet: 100, win: 105, profit: -5 });
    check('tbs diario: no compara el profit contra un mes que perdió plata',
      desdePerdida.volP === null && desdePerdida.vol === 0);
    /* De ganar a perder no es "−150%": es haber dado vuelta el signo. Pasó de verdad —TBSEcuaB
       hizo +124 USD en julio y −62 en agosto— y el porcentaje ahí no dice nada. */
    const dioVuelta = TD.tdComparar({ bet: 6300, win: 6362, profit: -62 }, { bet: 605, win: 481, profit: 124 });
    check('tbs diario: pasar de ganancia a pérdida se dice, no se pone un porcentaje',
      dioVuelta.aPerdida === true && /pasó a pérdida/.test(h12),
      'profit ' + dioVuelta.volP.toFixed(0) + '% → se muestra como "pasó a pérdida"');
    // Y el que sigue ganando menos NO es "pasó a pérdida": ahí el porcentaje sí se entiende.
    check('tbs diario: ganar menos sigue siendo un porcentaje',
      TD.tdComparar({ bet: 100, win: 95, profit: 5 }, { bet: 100, win: 90, profit: 10 }).aPerdida === false);
    // Sin mes anterior no se inventa una tendencia: se dice que no hay contra qué comparar.
    check('tbs diario: sin mes anterior no inventa una tendencia',
      TD.tdComparar({ bet: 100, win: 90, profit: 10 }, null).hay === false
      && TD.tdVeredicto({ hay: false }, 'junio').txt === ''
      && /No hay días guardados de/.test(h12));

    /* ── CONTRA EL MISMO TRAMO DEL MES PASADO ──────────────────────────────────────────────
       Antes se partía el mes al medio (01–09 contra 10–19) porque era lo único posible con un solo
       mes guardado. La pregunta real es "¿cómo veníamos el mes pasado a esta altura?". */
    check('tbs diario: compara contra el mismo tramo del mes pasado',
      /api\('\/api\/os\/tbs\/diario\?mes='\+mesAnt\)/.test(h12)
      && /el mismo tramo de \$\{esc\(nomAnt\)\}/.test(h12)
      && !/1ª mitad/.test(h12) && !/tdMitades/.test(h12));
    // Sólo los días que están en LOS DOS meses: 19 contra 18 daría una caída inventada.
    check('tbs diario: sólo compara los días que están en los dos meses',
      /const comunes = dias\.map\(dd\)\.filter\(x => sAnt\.has\(x\)\)/.test(h12)
      && /for \(const n of comunes\)/.test(h12)
      && /no entran en la\s*\n?\s*comparación de ninguno de los dos lados/.test(h12));
    // El cruce es por agente_id, no por login: un cliente renombrado dejaría de encontrarse.
    check('tbs diario: cruza los dos meses por id de agente, no por nombre',
      /idxAnt\.set\(c\.agente_id\+'\|'\+c\.moneda/.test(h12)
      && /idxAnt\.get\(c\.agente_id\+'\|'\+c\.moneda\)/.test(h12));

    // Y ordena por lo que hay que atender, no por volumen.
    check('tbs diario: ordena por lo que hay que mirar primero',
      /const peso = \{ mal:0, ojo:1/.test(h12));
    // La forma se ve de un vistazo: una línea por cliente con el jugado de cada día.
    /* La línea muestra la FORMA de adentro del mes; el color lo pone el VEREDICTO de la fila.
       Se pintaba comparando las dos mitades del mes, y contra el mes pasado eso se contradecía en
       el mismo renglón: TBSDavidLatam trae +230% contra julio —"creciendo", en verde— y adentro de
       agosto viene bajando desde el pico del día 6, así que la línea salía roja al lado de la
       palabra verde. Los dos datos son ciertos; dos colores peleados en un renglón, no. */
    check('tbs diario: una línea muestra la forma del jugado',
      /function tdSpark\(vals, tono, ancho=90, alto=22\)/.test(h12) && /<polyline points=/.test(h12));
    check('tbs diario: el color de la línea lo pone el veredicto, no las mitades del mes',
      /const col = \{ mal:'var\(--red\)', ojo:'var\(--gold\)', bien:'var\(--green\)' \}\[tono\]/.test(h12)
      && /tdSpark\(vals, a\.v && a\.v\.tono\)/.test(h12)
      // y ya no queda la comparación de mitades que la pintaba antes
      && !/const col = b<a\*0\.85/.test(h12));
    // "Traer los 1 que faltan" no está escrito en castellano.
    check('tbs diario: el botón dice bien el singular',
      /falt===1\?'Traer el día que falta'/.test(h12));
    // Un renglón por CLIENTE con su moneda principal; las demás se despliegan.
    check('tbs diario: una fila por cliente, las otras monedas plegadas',
      /g\.principal = g\.filas\[0\]/.test(h12) && /g\.otras = g\.filas\.slice\(1\)/.test(h12)
      && /function tdToggle/.test(h12));
    // Una fila de ceros no es información.
    check('tbs diario: esconde lo que no movió nada en todo el mes',
      /c\.bet !== 0 \|\| c\.win !== 0 \|\| c\.profit !== 0/.test(h12)
      && /Se ocultaron/.test(h12));
    // Sin nada medido no se inventa un tiempo.
    check('tbs diario: sin medición no muestra una estimación falsa', /seg!=null \?/.test(h12));

    /* ── JUGADO Y PROFIT, PEGADOS ──────────────────────────────────────────────────────────
       Había cuatro columnas entre los dos números —vs, margen, margen 1ª→2ª— y leer un cliente
       era cruzar toda la pantalla. Cada número lleva su comparación DEBAJO, en chico: lo que se
       compara con algo va junto a ese algo. */
    const enc = h12.slice(h12.indexOf('<th>Cliente</th><th>Div</th>'), h12.indexOf('</tr></thead><tbody>\n      ${grupos.map'));
    check('tbs diario: jugado y profit quedan uno al lado del otro', (() => {
      // Se cuentan las COLUMNAS que hay entre los dos, no los caracteres: medir por distancia de
      // texto se rompía sola en cuanto un encabezado ganaba un subtítulo, sin que nada se hubiera
      // movido de lugar.
      const i = enc.indexOf('Jugado (in)'), j = enc.indexOf('>Profit');
      if (i < 0 || j < 0 || j < i) return false;
      return (enc.slice(i, j).match(/<th\b/g) || []).length === 1;   // sólo el <th> del propio Profit
    })(), enc.replace(/\s+/g, ' ').slice(0, 150));
    /* Se llamó "margen" (nadie lo entiende), después "te queda de cada 100", y ahora RTP — que
       es el nombre que la dueña ya usa en los paneles del casino. Lo pidió así de explícito:
       "no necesito que me muestre te queda 9% de cada 100 jugados, quiero el RTP normal".
       "Margen" sigue prohibido. */
    check('tbs diario: la columna se llama RTP y dice qué es',
      />RTP</.test(h12) && /se llevan los jugadores/.test(h12) && !/>Margen</.test(h12));

    /* ⚠️ Y EL RTP VA AL REVÉS QUE LAS OTRAS DOS COLUMNAS. En jugado y profit subir es bueno; acá
       subir es que los jugadores se llevaron más. Cambiar el rótulo sin dar vuelta el color
       dejaría un ▲ verde justo donde el mes fue peor, que es peor que no mostrarlo. */
    check('tbs diario: en el RTP el verde y el rosa están dados vuelta',
      /const rtpNue = 100 - a\.queda/.test(h12)
      && /d > 0 \? 'var\(--rosa\)' : 'var\(--verde2\)'/.test(h12),
      'el RTP quedó con el color al derecho: subir aparecería como bueno');

    /* ── EL DÍA A DÍA, HACIA ABAJO ─────────────────────────────────────────────────────────
       Los días eran columnas: a partir del día 12 la tabla se salía de la pantalla y seguir a un
       cliente era barrer con la vista de izquierda a derecha. */
    check('tbs diario: el día a día va hacia abajo, con in/out/profit arriba',
      /function tdDetalle\(c, dias, ref\)/.test(h12)
      && /<th class="right" style="font-size:10px">Jugado \(in\)<\/th>/.test(h12)
      && /<th class="right" style="font-size:10px">Premios \(out\)<\/th>/.test(h12)
      && /<td class="muted" style="font-size:12px;width:30px">\$\{String\(f\)\.slice\(8,10\)\}<\/td>/.test(h12)
      && !/<th class="right" style="font-size:10px">\$\{dd\(f\)\}<\/th>/.test(h12));
    // La barra es lo que hace visible el sube y baja sin leer un número.
    check('tbs diario: cada día lleva su barra proporcional al jugado',
      /const max = Math\.max\(\.\.\.bets, 1\)/.test(h12)
      && /Math\.round\(\(d\.bet\/max\)\*100\)/.test(h12));
    // Y abajo los dos totales, uno debajo del otro, para el mismo tramo de los dos meses.
    check('tbs diario: el detalle cierra con los dos meses uno debajo del otro',
      /\$\{tot\('Este mes', tb, tw, tp, true\)\}/.test(h12)
      && /\$\{ref \? tot\(ref\.lab, ref\.bet, ref\.win, ref\.profit, false\) : ''\}/.test(h12));
  }

  /* ── LA COPIA DE SEGURIDAD ───────────────────────────────────────────────────────────────────
     Un respaldo que nadie probó restaurar no es un respaldo: es un archivo. Estos checks no miran
     que el código esté escrito — hacen la copia, la abren y buscan la plata adentro.

     El respaldo que había exportaba 3 tablas de 41. Afuera quedaban los movimientos (la cuenta
     corriente de los 45 clientes), los comprobantes, la matriz del cierre y los tipos de cambio
     históricos — y ésos son los únicos datos del sistema que NO se pueden reconstruir con trabajo:
     la cotización de un día que ya pasó no se vuelve a pedir. */
  {
    const Database = require('better-sqlite3');
    const bk = require('../src/backup.service');
    const { db: baseViva } = require('../src/db');

    const inv = bk.inventario();
    // Cubre TODA la base, no una lista escrita a mano: una tabla nueva entra sola. Nombrar las
    // tablas a mano es exactamente cómo el respaldo viejo llegó a exportar tres.
    const enBase = baseViva.prepare(`SELECT COUNT(*) n FROM sqlite_master WHERE type='table'
        AND name NOT LIKE 'sqlite_%'`).get().n;
    check('backup: el inventario cuenta TODAS las tablas de la base',
      inv.cuantasTablas === enBase && inv.cuantasTablas > 30,
      inv.cuantasTablas + ' tablas · ' + inv.filas + ' filas');
    // Las que guardan plata tienen que estar sí o sí. Si alguna se renombra, este check cae.
    const CON_PLATA = ['movimientos', 'comprobantes', 'cierre_pct', 'cierre_mes_snapshot',
      'reporte_diario', 'tbs_diario', 'tc_snapshots', 'tc_divisa_snapshots', 'participaciones',
      'paneles', 'clientes', 'pedidos'];
    const nombres = new Set(inv.tablas.map((t) => t.nombre));
    const faltan = CON_PLATA.filter((t) => !nombres.has(t));
    check('backup: están adentro las tablas donde vive la plata', !faltan.length, faltan.join(',') || 'las 12');

    /* ── LA PRUEBA DE VERDAD: IDA Y VUELTA ────────────────────────────────────────────────────
       Se escribe un movimiento con un importe reconocible, se hace la copia, se la abre como una
       base aparte y se busca ESE importe. Es lo único que distingue "se generó un archivo" de "se
       puede volver atrás con este archivo". */
    const marca = 'BK-PRUEBA-' + Date.now();
    baseViva.prepare(`INSERT INTO movimientos (id,cliente_id,tipo,monto_usdt,fecha,notas)
        VALUES (?,?,?,?,?,?)`).run(marca, 'c_prueba_backup', 'pago', '50098.35', '2026-08-20', marca);
    let snap = null, err = null;
    try { snap = await bk.snapshot(); } catch (e) { err = e.message; }
    check('backup: la copia se genera y pasa su propio control de integridad', !!snap && !err,
      err || (Math.round(snap.bytes / 1024) + ' KB · ' + snap.control.tablas + ' tablas · '
        + snap.control.filas + ' filas, todas coincidiendo con la base viva'));

    if (snap) {
      /* Se escribe el Buffer a un archivo y se abre DESDE AHÍ, que es exactamente lo que va a
         hacer ella: bajar el archivo y ponerlo en el servidor. Abrirlo como Buffer en memoria
         probaría otra cosa — y de hecho ése fue el camino que falló: `serialize()` sobre una base
         en WAL devuelve una imagen que no vuelve a abrir. */
      const tmpBk = require('path').join(require('os').tmpdir(), 'bk-check-' + process.pid + '.sqlite');
      require('fs').writeFileSync(tmpBk, snap.buffer);
      const copia = new Database(tmpBk, { readonly: true });
      const fila = copia.prepare('SELECT monto_usdt, notas FROM movimientos WHERE id=?').get(marca);
      check('backup: el pago que se acababa de registrar está adentro de la copia',
        !!fila && fila.monto_usdt === '50098.35', fila ? fila.monto_usdt : 'NO ESTÁ');
      // Y el resto de la base también, no sólo la fila de prueba.
      const enCopia = copia.prepare(`SELECT COUNT(*) n FROM sqlite_master WHERE type='table'
          AND name NOT LIKE 'sqlite_%'`).get().n;
      check('backup: la copia trae todas las tablas, no un pedazo', enCopia === enBase,
        enCopia + ' de ' + enBase);
      check('backup: la copia abierta está sana',
        JSON.stringify(copia.pragma('integrity_check')) === '[{"integrity_check":"ok"}]');
      copia.close();
      try { require('fs').unlinkSync(tmpBk); } catch (e) {}
    }
    baseViva.prepare('DELETE FROM movimientos WHERE id=?').run(marca);

    /* ── POR QUÉ NO ALCANZA CON COPIAR EL ARCHIVO DEL VOLUMEN ──────────────────────────────────
       Es lo primero que uno piensa y da una base VACÍA. La base corre en WAL: lo que se escribe va
       a `store.sqlite-wal` y recién pasa al principal en un checkpoint. Medido en esta base: 962 KB
       en el principal y 4 MB en el WAL. Este check REPRODUCE el error para que quede probado que
       `serialize` lo resuelve y que a nadie se le ocurra "simplificarlo" copiando el archivo. */
    {
      const os = require('os'); const fs = require('fs'); const path = require('path');
      const tmp = path.join(os.tmpdir(), 'bk-wal-' + process.pid + '.sqlite');
      [tmp, tmp + '-wal', tmp + '-shm'].forEach((f) => { try { fs.unlinkSync(f); } catch (e) {} });
      const d = new Database(tmp);
      d.pragma('journal_mode = WAL');
      d.exec('CREATE TABLE plata (id INTEGER, monto TEXT)');
      const ins = d.prepare('INSERT INTO plata VALUES (?,?)');
      d.transaction(() => { for (let i = 0; i < 8000; i++) ins.run(i, String(i)); })();
      ins.run(99999, 'EL-ULTIMO-PAGO');

      const soloPrincipal = tmp + '.copia';
      fs.copyFileSync(tmp, soloPrincipal);
      let seVe = null;
      try {
        const c = new Database(soloPrincipal, { readonly: true });
        seVe = c.prepare("SELECT COUNT(*) n FROM plata WHERE monto='EL-ULTIMO-PAGO'").get().n;
        c.close();
      } catch (e) { seVe = 'ni siquiera abre: ' + e.message; }
      check('backup: copiar sólo el archivo principal PIERDE los datos (por eso no se hace así)',
        seVe !== 1, 'copiando el archivo: ' + seVe);

      /* El camino corto era `db.serialize()`, y sobre una base en WAL NO SIRVE: devuelve una
         imagen que ya no vuelve a abrir, porque el modo WAL viaja en el encabezado y una base WAL
         necesita sus archivos al lado. Se deja probado para que nadie lo intente de nuevo. */
      let serializeAbre = null;
      try { const sv = new Database(d.serialize(), { readonly: true });
        serializeAbre = sv.prepare("SELECT COUNT(*) n FROM plata").get().n; sv.close();
      } catch (e) { serializeAbre = 'no abre: ' + e.message; }
      check('backup: db.serialize() no sirve sobre una base en WAL (por eso se usa db.backup)',
        serializeAbre !== 8001, String(serializeAbre));

      // Y el camino que SÍ se usa: el respaldo en caliente trae todo, WAL incluido.
      const destino = tmp + '.bk';
      await d.backup(destino);
      const c2 = new Database(destino, { readonly: true });
      const conBackup = c2.prepare("SELECT COUNT(*) n FROM plata WHERE monto='EL-ULTIMO-PAGO'").get().n;
      const todas = c2.prepare('SELECT COUNT(*) n FROM plata').get().n;
      check('backup: db.backup() sí trae lo que está en el WAL', conBackup === 1 && todas === 8001,
        todas + ' filas, último pago: ' + (conBackup ? 'sí' : 'NO'));
      c2.close(); d.close();
      [tmp, tmp + '-wal', tmp + '-shm', soloPrincipal, destino].forEach((f) => { try { fs.unlinkSync(f); } catch (e) {} });
    }

    // Se anota DESPUÉS de mandarla: una descarga que se cortó no cuenta como copia hecha.
    const hOs = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'os.routes.js'), 'utf8');
    check('backup: la fecha se anota recién cuando la descarga terminó',
      /res\.on\('finish', \(\) => \{ try \{ backup\.registrar\(snap\)/.test(hOs));
    // El error va en texto plano: navegando, un JSON de error se bajaría como archivo y parecería
    // una copia.
    check('backup: si falla, no baja un archivo que parezca una copia',
      /return res\.status\(500\)\.type\('text\/plain; charset=utf-8'\)/.test(hOs));
    // Bajo /api/os/* queda solo para el dueño: el operador no lo tiene en su lista blanca.
    const hAuth = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'auth.js'), 'utf8');
    check('backup: el operador no puede bajarse la base',
      /app\.get\('\/api\/os\/backup\/archivo'/.test(hOs)
      && !/backup/.test(hAuth.slice(hAuth.indexOf('const OPERADOR_PUEDE'), hAuth.indexOf('OPERADOR_PAGINAS'))));

    // La pantalla: reclama cuando hace mucho, y avisa que el archivo no se comparte.
    const hUi = require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'os.html'), 'utf8');
    check('backup: tiene su lugar propio en Config y reclama si está vieja',
      /\['backup','🛟 Copia de seguridad'\]/.test(hUi) && /CFG\.backup = async/.test(hUi)
      && /const BK_RECLAMA_DIAS = 7/.test(hUi) && /Última copia: \$\{cuando\}/.test(hUi));
    check('backup: la pantalla avisa que el archivo no se comparte',
      /Este archivo no se comparte/.test(hUi) && /contraseñas del casino/.test(hUi));
    // El botón del import baja OTRA cosa (3 tablas, para deshacer ese import). Que no se confunda
    // con la copia de seguridad del sistema es la mitad del arreglo.
    check('backup: el respaldo del import ya no se llama igual que la copia de seguridad',
      /⤓ Bajar deshacer del import/.test(hUi) && !/>⤓ Bajar respaldo</.test(hUi));

    /* ── EL RESPALDO EN JSON Y SU RESTORE VAN JUNTOS ──────────────────────────────────────────
       Un dump completo con un restore que entiende tres tablas es PEOR que lo que había: contesta
       ok y faltan 38 tablas sin que nada lo diga. */
    const hIdx = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'index.js'), 'utf8');
    check('backup json: exporta todas las tablas, leídas de la base',
      /tablas: backupSvc\.dumpTablas\(\)/.test(hIdx) && /version: 2/.test(hIdx));

    /* ── IDA Y VUELTA DEL RESPALDO JSON ───────────────────────────────────────────────────────
       La lógica vivía ADENTRO de la ruta y por eso no se podía probar sin pegarle a producción.
       Sacada a un módulo, se le puede hacer la única prueba que importa: sacar el respaldo, volver
       a meterlo entero, y comparar tabla por tabla. Si algo se pierde en el camino, se ve acá.

       Restaurar los MISMOS datos deja la base igual que antes, así que el resto de los checks no
       se entera — pero recorre el DELETE + INSERT de las 44 tablas de verdad. */
    const antes = {}; bk.tablas().forEach((t) => { antes[t] = baseViva.prepare(`SELECT COUNT(*) c FROM "${t}"`).get().c; });
    const dump = bk.dumpTablas();
    check('backup json: el dump trae las 44 tablas con sus filas',
      Object.keys(dump).length === bk.tablas().length
      && Object.keys(dump).every((t) => dump[t].length === antes[t]),
      Object.keys(dump).length + ' tablas');

    let rest = null, restErr = null;
    try { rest = bk.restaurarTablas(dump); } catch (e) { restErr = e.message; }
    check('backup json: se puede volver a meter entero, sin errores', !!rest && !restErr,
      restErr || Object.keys(rest.aplicado).length + ' tablas restauradas');

    const despues = {}; bk.tablas().forEach((t) => { despues[t] = baseViva.prepare(`SELECT COUNT(*) c FROM "${t}"`).get().c; });
    const perdidas = bk.tablas().filter((t) => antes[t] !== despues[t])
      .map((t) => `${t}: ${antes[t]}→${despues[t]}`);
    check('backup json: después de restaurar no falta ni sobra una sola fila', !perdidas.length,
      perdidas.join(', ') || Object.values(despues).reduce((a2, b2) => a2 + b2, 0) + ' filas intactas');

    // Y el contenido, no sólo la cantidad: un comprobante con su archivo adentro tiene que volver igual.
    const comp = baseViva.prepare('SELECT id, monto, archivo_datos FROM comprobantes WHERE archivo_datos IS NOT NULL LIMIT 1').get();
    if (comp) {
      const orig = (dump.comprobantes || []).find((c) => c.id === comp.id);
      check('backup json: el comprobante vuelve con su monto y su archivo intactos',
        !!orig && orig.monto === comp.monto && orig.archivo_datos === comp.archivo_datos,
        comp.id + ' · ' + Math.round(String(comp.archivo_datos).length / 1024) + ' KB de adjunto');
    }
    // Todo o nada: si una tabla explota a mitad, la transacción tiene que dejar la base como estaba.
    check('backup json: el restore es todo o nada, y apaga las claves foráneas mientras dura',
      /const correr = db\.transaction/.test(require('fs').readFileSync(
        require('path').join(__dirname, '..', 'src', 'backup.service.js'), 'utf8'))
      && /db\.pragma\('foreign_keys = OFF'\)/.test(require('fs').readFileSync(
        require('path').join(__dirname, '..', 'src', 'backup.service.js'), 'utf8')));
    // Un respaldo viejo se restaura igual, pero diciendo que es parcial.
    check('backup json: un respaldo del formato viejo avisa que restauró sólo una parte',
      /respaldo de formato viejo: sólo trae systems, clientes y pedidos/.test(hIdx)
      && /parcial: !dump\.tablas/.test(hIdx));
    // Y sigue pidiendo force para no pisar una base con datos.
    check('backup json: no pisa una base con datos sin force',
      /if \(noVacia && !body\.force\)/.test(hIdx));
  }
  /* ── EL MES QUE TOCA CERRAR ──────────────────────────────────────────────────────────────────
     Las seis pantallas del cierre abrían en el mes de HOY, y el cierre siempre es del anterior —
     lo dice la propia Foto: "a principio del mes siguiente, una vez". Lo caro no era la molestia:
     apretando "Sacar todo lo que falta" con el mes en curso, el casino contesta con lo que hay
     hasta hoy y esa foto CORTA queda archivada como buena; después el reporte de externos la lee
     y cobra de menos, en silencio y con un total que cuadra. */
  {
    const hUi = require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'os.html'), 'utf8');

    // Las funciones se sacan del archivo y se corren con fechas de verdad. Si alguna dejara de
    // existir, `armarUi` tira y el check falla: no puede pasar en el vacío.
    const armarUi = (nombres) => {
      const cuerpo = nombres.map((n) => {
        const i = hUi.indexOf('\nfunction ' + n + '(');
        if (i < 0) throw new Error('no está la función ' + n);
        let d = 0, fin = -1;
        for (let k = hUi.indexOf('{', i); k < hUi.length; k++) {
          const ch = hUi[k];
          if (ch === '{') d++;
          else if (ch === '}') { d--; if (!d) { fin = k; break; } }
        }
        if (fin < 0) throw new Error('no cierra ' + n);
        return hUi.slice(i, fin + 1);
      }).join('\n');
      const pre = "const CIERRE_DIAS = 10;\n"
        + "const MESES_UI = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];\n"
        + "const mesHoy = (d = new Date()) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2,'0');\n";
      // eslint-disable-next-line no-new-func
      return new Function(pre + cuerpo + '\nreturn {' + nombres.join(',') + ', mesHoy};')();
    };
    const UI = armarUi(['mesDeCierre']);
    // Las fechas se arman con new Date(a, m, d) — hora LOCAL, igual que el navegador de ella.
    const F = (a, m, d) => new Date(a, m - 1, d);

    check('cierre: los primeros días del mes se cierra el mes anterior',
      UI.mesDeCierre(F(2026, 9, 1)) === '2026-08' && UI.mesDeCierre(F(2026, 9, 10)) === '2026-08',
      '1-sep → ' + UI.mesDeCierre(F(2026, 9, 1)));
    check('cierre: pasados los 10 días vuelve al mes corriente',
      UI.mesDeCierre(F(2026, 9, 11)) === '2026-09' && UI.mesDeCierre(F(2026, 9, 30)) === '2026-09',
      '11-sep → ' + UI.mesDeCierre(F(2026, 9, 11)));
    // Cruzar el año a mano: en enero el mes que se cierra es diciembre del año pasado.
    check('cierre: en enero se cierra diciembre del año anterior',
      UI.mesDeCierre(F(2026, 1, 3)) === '2025-12' && UI.mesDeCierre(F(2026, 1, 20)) === '2026-01',
      '3-ene-2026 → ' + UI.mesDeCierre(F(2026, 1, 3)));

    /* LA TRAMPA QUE TENÍA LA VERSIÓN ANTERIOR. `_cieMesCruce` hacía setMonth(getMonth()-1) sobre
       toISOString(): el 31 de marzo eso da "31 de febrero", JavaScript lo corre solo a marzo, y el
       "mes anterior" salía igual al actual. Se deja probado el caso exacto. */
    const conBug = (d) => { const x = new Date(d.getTime()); x.setMonth(x.getMonth() - 1); return x.toISOString().slice(0, 7); };
    check('cierre: el 31 de marzo no devuelve marzo (era el bug de setMonth)',
      UI.mesDeCierre(F(2026, 3, 31)) === '2026-03' && conBug(F(2026, 3, 31)) === '2026-03',
      'la regla nueva da ' + UI.mesDeCierre(F(2026, 3, 31)) + ' (día 31 → mes corriente, correcto); '
      + 'el cálculo viejo daba ' + conBug(F(2026, 3, 31)) + ' creyendo que era febrero');
    // Y el 5 de marzo, donde el viejo SÍ tenía que dar febrero, comparado contra el nuevo.
    check('cierre: el 5 de marzo sí se cierra febrero, y el 5 de mayo no se salta abril',
      UI.mesDeCierre(F(2026, 3, 5)) === '2026-02' && UI.mesDeCierre(F(2026, 5, 5)) === '2026-04',
      '5-mar → ' + UI.mesDeCierre(F(2026, 3, 5)) + ' · 5-may → ' + UI.mesDeCierre(F(2026, 5, 5)));
    // La otra trampa: toISOString() es UTC. A las 22:00 del 31 de agosto acá, allá ya es septiembre.
    const finDeMesDeNoche = new Date(2026, 7, 31, 22, 0, 0);   // 31-ago-2026 22:00 hora local
    check('cierre: a la noche del último día del mes no se corre al siguiente (toISOString era UTC)',
      UI.mesDeCierre(finDeMesDeNoche) === '2026-08',
      'la regla nueva: ' + UI.mesDeCierre(finDeMesDeNoche)
      + ' · toISOString hubiera dado ' + finDeMesDeNoche.toISOString().slice(0, 7) + ' con un huso al este');

    // Las SEIS pantallas del cierre arrancan en el mes que toca cerrar, no en el de hoy.
    const ARRANQUES = [
      ['_fotoMes', 'let _fotoMes = mesDeCierre();'],
      ['_revMes', 'let _revMes = mesDeCierre();'],
      ['_pagoMes', 'let _pagoMes = mesDeCierre(),'],
      ['_venMes', 'let _venMes = mesDeCierre(),'],
      ['_extMes', "let _extCli = '', _extMes = mesDeCierre(),"],
      ['_facMes', 'let _facMes = mesDeCierre();'],
    ];
    const sinArreglar = ARRANQUES.filter(([, linea]) => !hUi.includes(linea)).map(([v]) => v);
    check('cierre: las seis pantallas del cierre abren en el mes que toca cerrar',
      !sinArreglar.length, sinArreglar.join(', ') || 'las 6');
    // Y las de mirar el día a día NO se tocaron: ahí el mes corriente es el correcto.
    check('cierre: las pantallas de seguimiento siguen abriendo en el mes corriente',
      /let _tdMes = new Date\(\)\.toISOString\(\)\.slice\(0,7\)/.test(hUi)
      && /const mes=_acMes\|\|new Date\(\)\.toISOString\(\)\.slice\(0,7\)/.test(hUi),
      'el reporte diario de TBS y el acumulado');

    // Cada una dice qué mes está mirando, con el otro a un clic: la regla acierta casi siempre y
    // cuando no acierta tiene que ser obvio y barato de corregir.
    const HANDLERS = ['fotoIrA', 'revIrA', 'pagoIrA', 'venIrA', 'extIrA', 'facIrA'];
    const sinBanner = HANDLERS.filter((h) => !(hUi.includes('function ' + h + '(') && hUi.includes("'" + h + "'")));
    check('cierre: las seis muestran qué mes miran y dejan cambiarlo de un clic',
      !sinBanner.length && /function bannerMes\(mes, handler\)/.test(hUi),
      sinBanner.join(', ') || 'los 6 carteles');

    /* ── LA FOTO DE UN MES QUE NO TERMINÓ ─────────────────────────────────────────────────────
       Es el mecanismo que cuesta plata: la foto corta se archiva como buena y el reporte de
       externos cobra de menos, en silencio. */
    const UI2 = armarUi(['fotoMesSinTerminar']);
    // Se arman contra el reloj real: hoy estamos a mitad de un mes, así que ESE mes no terminó y
    // el anterior sí. Escribir '2026-08' a mano hacía que el check dependiera de la fecha en que
    // se corriera — y de hecho falló el primer día, porque agosto era el mes corriente.
    const ahora = new Date();
    const mesEnCurso = UI2.mesHoy(ahora);
    const mesPasado = UI2.mesHoy(new Date(ahora.getFullYear(), ahora.getMonth() - 1, 15));
    const mesQueViene = UI2.mesHoy(new Date(ahora.getFullYear(), ahora.getMonth() + 1, 15));
    check('foto: reconoce un mes que todavía no terminó',
      UI2.fotoMesSinTerminar(mesEnCurso) === true
      && UI2.fotoMesSinTerminar(mesQueViene) === true
      && UI2.fotoMesSinTerminar(mesPasado) === false,
      mesEnCurso + ' sin terminar · ' + mesPasado + ' terminado');
    check('foto: avisa en pantalla y hace confirmar antes de sacar una foto cortada',
      /const AVISO_FOTO_EN_CURSO =/.test(hUi)
      && /Este mes todavía no terminó/.test(hUi)
      && /cortada queda guardada como si fuera la del mes entero/.test(hUi)
      && /if\(fotoMesSinTerminar\(_fotoMes\) && !confirm\(/.test(hUi)
      && /TODAVÍA NO TERMINÓ/.test(hUi));
  }
  /* ── LOS NÚMEROS QUE SE TIPEAN EN EL CIERRE ──────────────────────────────────────────────────
     Dos agujeros de la misma familia, y los dos ya estaban tapados para el tipo de cambio de la
     grilla — sobre los otros campos, no.

     · Los PORCENTAJES (celda de la matriz, % base del proveedor, descuento del cliente) se
       guardaban tal cual se tipeaban. "12,5" con coma no es un número: al calcular vale CERO. Ese
       proveedor pasa a costar cero, el vendedor paga cero por él, y el control de "costo bajo"
       tampoco lo agarra porque compara contra ese mismo cero.
     · El TC DEL PROVEEDOR tenía su control de salto escrito y funcionando, y la única pantalla que
       lo carga lo salteaba pasando `forzar` en true fijo. */
  {
    const cs = require('../src/cierre-store');
    const PROV = 'ZZ-PRUEBA-PCT', CLI = 'ZZ-CLIENTE-PCT';
    cs.addProveedor(PROV, '5'); cs.addCliente(CLI, '0');

    // El caso que originó todo: la coma decimal.
    const coma = cs.setCelda(PROV, CLI, '12,5');
    check('cierre: un porcentaje con coma se rechaza en vez de valer cero',
      coma.ok === false && /no es un número/.test(coma.error), coma.error);
    // Y con punto entra.
    check('cierre: con punto decimal entra bien', cs.setCelda(PROV, CLI, '12.5').ok === true);
    check('cierre: el valor que entró es el que quedó',
      cs.getMatriz().celdas[PROV][CLI] === '12.5', cs.getMatriz().celdas[PROV][CLI]);

    /* El otro modo de error: escribir "12,50" y que la coma se pierda en el camino → 1250. La
       cuenta es `profit × (celda − base)%`, así que 1250 con base 5 cobra 1245% del profit: doce
       veces la ganancia del mes de ese proveedor. */
    const mil = cs.setCelda(PROV, CLI, '1250');
    check('cierre: un porcentaje que pasa de 100 se rechaza',
      mil.ok === false && /pasa de 100/.test(mil.error), mil.error);
    // El mensaje sugiere el número que probablemente se quiso poner.
    check('cierre: y le sugiere el número que seguramente quiso poner', /12\.5/.test(mil.error), mil.error);
    // Negativo: invierte el cobro (le acredita al cliente en vez de cobrarle).
    const neg = cs.setCelda(PROV, CLI, '-5');
    check('cierre: un porcentaje negativo se rechaza',
      neg.ok === false && /negativo/.test(neg.error), neg.error);
    // 0 y 100 son válidos: 0 es "a este cliente no se le cobra este proveedor", que es una decisión.
    check('cierre: 0 y 100 siguen siendo válidos',
      cs.setCelda(PROV, CLI, '0').ok === true && cs.setCelda(PROV, CLI, '100').ok === true);
    // Vacío borra la celda, y eso también es válido.
    // Al borrar la última celda de ese proveedor, la fila entera desaparece del mapa.
    check('cierre: vacío borra la celda y no es un error',
      cs.setCelda(PROV, CLI, '').ok === true
      && (cs.getMatriz().celdas[PROV] || {})[CLI] === undefined);

    // Los tres campos, no sólo la celda.
    check('cierre: el % base del proveedor tiene el mismo control',
      cs.setBase(PROV, '7,5').ok === false && cs.setBase(PROV, '7.5').ok === true);
    check('cierre: el descuento del cliente tiene el mismo control',
      cs.setDescuento(CLI, '3,5').ok === false && cs.setDescuento(CLI, '3.5').ok === true);
    // Y las puertas de atrás: "agregar" no puede ser la forma de meter lo que "editar" rechaza.
    let tiroAdd = false;
    try { cs.addProveedor('ZZ-PRUEBA-ADD', '9,9'); } catch (e) { tiroAdd = /no es un número/.test(e.message); }
    check('cierre: agregar un proveedor con un % mal escrito tampoco entra', tiroAdd);

    /* EL LOTE ES TODO O NADA. Es el contrato que ya estaba escrito en el código y no se cumplía:
       setCelda devolvía false, el lote seguía, y quedaba a medias sin que nadie se enterara. */
    cs.setCelda(PROV, CLI, '10');
    const lote = cs.setCeldas([
      { proveedor: PROV, cliente: CLI, pct: '20' },
      { proveedor: PROV, cliente: CLI, pct: '30,5' },   // ← ésta rompe
    ]);
    check('cierre: si una celda del lote está mal, no entra ninguna',
      lote.ok === false && cs.getMatriz().celdas[PROV][CLI] === '10',
      'quedó en ' + cs.getMatriz().celdas[PROV][CLI] + ' (el valor de antes del lote)');
    // Un lote entero bien sí entra.
    check('cierre: un lote bien escrito entra completo',
      cs.setCeldas([{ proveedor: PROV, cliente: CLI, pct: '22' }]).escritas === 1
      && cs.getMatriz().celdas[PROV][CLI] === '22');

    // El import no se frena por una celda —es una planilla entera— pero dice cuáles dejó afuera.
    const imp = cs.importar({ celdas: [
      { proveedor: PROV, cliente: CLI, pct: '11' },
      { proveedor: PROV, cliente: 'ZZ-OTRO-PCT', pct: '9,9' },
    ] });
    check('cierre: el import saltea lo que está mal y lo informa',
      Array.isArray(imp.rechazadas) && imp.rechazadas.length === 1
      && cs.getMatriz().celdas[PROV][CLI] === '11',
      imp.rechazadas[0]);

    cs.removeProveedor(PROV); cs.removeProveedor('ZZ-PRUEBA-ADD'); cs.removeCliente(CLI);

    /* ── EL CONTROL DEL TC DEL PROVEEDOR, QUE ESTABA APAGADO ────────────────────────────────
       "1.473" tipeado pensando en 1473 ES un número válido —uno coma cuatro siete tres— así que el
       control de formato lo deja pasar. Lo que lo atrapa es compararlo con lo que esa moneda venía
       valiendo. Ese control existía y andaba; la ruta lo salteaba pasando forzar en true fijo. */
    const MON = 'ZZPRUEBA';
    cs.setTC(MON, 'Enero_2026', '1400', true);
    const salto = cs.setTC(MON, 'Febrero_2026', '1.473');
    check('cierre: el TC del proveedor frena un salto enorme y pide confirmación',
      salto.ok === false && salto.confirmar === true && salto.anterior === '1400',
      salto.error);
    check('cierre: con la confirmación explícita sí lo guarda',
      cs.setTC(MON, 'Febrero_2026', '1.473', true).ok === true);
    /* Y un cambio normal no molesta. Va sobre una moneda LIMPIA: en la de arriba quedó guardado
       1,473 (el valor forzado), así que cualquier número normal sería un salto enorme contra eso —
       el check pasaría por el motivo equivocado. */
    const MON2 = 'ZZPRUEBA2';
    cs.setTC(MON2, 'Enero_2026', '1400', true);
    const normal = cs.setTC(MON2, 'Febrero_2026', '1500');
    check('cierre: un cambio razonable no pregunta nada',
      normal.ok === true, '1400 → 1500 (7%): ' + (normal.ok ? 'pasa' : normal.error));
    cs.removeMonedaTC(MON); cs.removeMonedaTC(MON2);

    // La ruta ya NO pasa forzar en true fijo: lo manda la pantalla, y sólo con un sí explícito.
    const hOs = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'os.routes.js'), 'utf8');
    check('cierre: la ruta del TC ya no saltea el control',
      /const forzar = !!\(req\.body \|\| \{\}\)\.forzar;/.test(hOs)
      && /cierreStore\.FILA_PROVEEDOR, mesCierreLbl\(req\.params\.mes\), tc_proveedor_ext, forzar\)/.test(hOs)
      && !/tc_proveedor_ext, true\)/.test(hOs));
    // Y `confirmar` viaja al cliente: sin eso la pantalla no puede preguntar nada.
    check('cierre: el pedido de confirmación llega a la pantalla',
      /confirmar: !!r\.confirmar, anterior: r\.anterior \|\| null/.test(hOs));
    // Las cuatro rutas de porcentajes devuelven el motivo en vez de un ok:true con un false adentro.
    check('cierre: las rutas devuelven el motivo del rechazo',
      (hOs.match(/r\.ok \? ok\(res, \{ guardado: true \}\) : err\(res, 400, r\.error\)/g) || []).length === 3
      && /r\.ok \? ok\(res, \{ escritas: r\.escritas \}\) : err\(res, 400, r\.error\)/.test(hOs));

    /* LA PANTALLA TIENE QUE MOSTRARLO. Los seis lugares que guardan un % hacían `if(r.ok)` y en el
       else no hacían NADA: el número quedaba a la vista como si se hubiera guardado. */
    const hUi = require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'os.html'), 'utf8');
    check('cierre: un porcentaje rechazado queda marcado en rojo en la pantalla',
      /function _ciePct\(el, r\)\{/.test(hUi) && /\.cie-mal \{/.test(hUi)
      && /el\.classList\.add\('cie-mal'\)/.test(hUi));
    const SEIS = ['cliProvCell', 'cliProvDesc', 'cieCell', 'cieBase', 'cieDesc', 'saveCostoMatriz'];
    const sinMarca = SEIS.filter((f) => {
      const i = hUi.indexOf('function ' + f + '(');
      return i < 0 || !hUi.slice(i, i + 500).includes('_ciePct(');
    });
    check('cierre: los seis lugares que guardan un % marcan el error', !sinMarca.length,
      sinMarca.join(', ') || 'los 6');
    check('cierre: la pantalla del TC pregunta antes de forzar',
      /async function setTcProv\(mes, forzar\)\{/.test(hUi)
      && /if \(r\.confirmar && confirm\(r\.error \+ '\\n\\n¿Guardar ' \+ v \+ ' igual\?'\)\) return setTcProv\(mes, true\)/.test(hUi));
  }
  /* ── LA CARGA QUE NO PUEDE PASARSE A DÓLARES ─────────────────────────────────────────────────
     El agujero: cuenta en dólares + carga en una moneda que no es el peso ni el dólar + esa moneda
     sin tipo de cambio. La cara en pesos queda en null por definición (`divisa === 'ARS' ? deuda :
     null`) y sin TC la otra también: el movimiento se grababa con las DOS columnas vacías. Sumaba
     cero, la cuenta corriente cerraba perfecta, y esa comisión no se cobraba nunca.

     El ciclo entero se prueba acá: no se graba → aparece en Revisión → se carga el TC → entra →
     desaparece de Revisión. */
  {
    const clientesStore = require('../src/clientes-store');
    const pedidosStore = require('../src/pedidos-store');
    const movsStore = require('../src/movimientos-store');
    const deudaCarga = require('../src/deuda-carga.service');
    const revisionSvc = require('../src/revision.service');
    const cierreSt = require('../src/cierre-store');
    const { db: baseCarga } = require('../src/db');

    // Una moneda inventada, para que no haya forma de que tenga tipo de cambio de antes.
    const MONEDA = 'ZZK';
    const mesPrueba = '2026-08';
    const cli = clientesStore.createCliente({ codigo: 'ZZ-CARGA-TEST', nombre: 'Prueba carga' });
    // El % base no vive en el cliente: es versionado (historial.js). Sin cuenta declarada, la
    // moneda es USDT, que es justo el caso que se quiere probar.
    require('../src/historial').setValor('cliente', cli.id, 'precio_base_pct',
      { valor: '10', tipo_cambio: 'correccion', notas: 'prueba' });
    const ped = pedidosStore.create({ codigo: 'ZZ-CARGA-TEST', clienteNombre: 'Prueba carga',
      divisa: MONEDA, monto: 1000000 });
    pedidosStore.setEstado(ped.id, 'cargado');
    // La fecha manda para que caiga en el mes que se revisa.
    const conFecha = pedidosStore.list({ estado: 'cargado' }).find((p) => p.id === ped.id);

    // 1 · sin tipo de cambio, NO se graba
    const sinTC = await deudaCarga.porCarga({ ...conFecha, resueltoAt: mesPrueba + '-15T12:00:00.000Z' });
    check('carga sin TC: no genera un movimiento vacío',
      sinTC.ok === false && sinTC.sinTC === true && /no hay tipo de cambio de ZZK/.test(sinTC.motivo),
      sinTC.motivo);
    const trasFallo = movsStore.list({ cliente_id: cli.id, tipo: 'carga' });
    check('carga sin TC: no quedó ningún movimiento a medias', trasFallo.length === 0,
      trasFallo.length + ' movimiento(s)');

    // 2 · y el store lo rechaza aunque se lo pidan directo: es el respaldo, no el arreglo
    let tiroStore = false;
    try { movsStore.create({ cliente_id: cli.id, tipo: 'carga', divisa: MONEDA, monto_ars: null, monto_usdt: null }); }
    catch (e) { tiroStore = /sin importe en ninguna de las dos monedas/.test(e.message); }
    check('carga sin importe: el store la rechaza por cualquier camino', tiroStore);
    // Pero un ajuste en cero sigue siendo válido: no todo movimiento es una carga.
    const aj = movsStore.create({ cliente_id: cli.id, tipo: 'ajuste', monto_usdt: '0', notas: 'zz-prueba' });
    check('carga sin importe: un ajuste en cero sigue entrando', !!aj && aj.tipo === 'ajuste');
    baseCarga.prepare('DELETE FROM movimientos WHERE id=?').run(aj.id);

    // 3 · Revisión la muestra, con la moneda que hay que cargar
    const rev = revisionSvc.revisar(mesPrueba);
    const item = rev.items.find((i) => /sin su comisión registrada/.test(i.titulo));
    check('carga sin TC: 🩺 Revisión la lista como grave',
      !!item && item.nivel === 'grave' && new RegExp(MONEDA).test(item.detalle),
      item ? item.titulo : 'NO aparece');
    check('carga sin TC: Revisión dice qué cliente y cuánto',
      !!item && item.afectados.some((a) => /ZZ-CARGA-TEST/.test(a) && /ZZK/.test(a)),
      item ? item.afectados[0] : '');

    /* 3b · Y NO grita por lo que está bien. Es la mitad del valor del aviso: medido contra
       producción, de 996 cargas entre mayo y agosto hay 771 sin movimiento propio y NINGUNA es un
       problema — mayo/junio/julio se cobraron en el cierre mensual (la deuda carga por carga
       arrancó el 1 de agosto) y las 40 de agosto son de clientes con % base en CERO, que no
       generan comisión a propósito. Un aviso que grita por 771 cosas correctas se aprende a
       ignorar, y tapa el que importa. */
    const cli0 = clientesStore.createCliente({ codigo: 'ZZ-BASE-CERO', nombre: 'Base cero' });
    require('../src/historial').setValor('cliente', cli0.id, 'precio_base_pct',
      { valor: '0', tipo_cambio: 'correccion', notas: 'prueba' });
    const ped0 = pedidosStore.create({ codigo: 'ZZ-BASE-CERO', clienteNombre: 'Base cero',
      divisa: MONEDA, monto: 999999 });
    pedidosStore.setEstado(ped0.id, 'cargado');
    const rev0 = revisionSvc.revisar(mesPrueba);
    const item0 = rev0.items.find((i) => /sin su comisión registrada/.test(i.titulo));
    check('carga con base 0: NO aparece en Revisión (no genera comisión a propósito)',
      !!item0 && item0.cuantos === 1 && !item0.afectados.some((x) => /ZZ-BASE-CERO/.test(x)),
      item0 ? item0.cuantos + ' listada(s), y ninguna es la de base 0' : 'no hay item');
    pedidosStore.remove(ped0.id);
    require('../src/db').db.prepare("DELETE FROM config_valores WHERE entidad_id=?").run(cli0.id);
    require('../src/db').db.prepare("DELETE FROM historial_config WHERE entidad_id=?").run(cli0.id);
    clientesStore.removeCliente(cli0.id);

    // 4 · se carga el TC de esa moneda y la deuda entra
    cierreSt.setTC(MONEDA, 'Agosto_2026', '4000', true);
    const conTC = await deudaCarga.porCarga({ ...conFecha, resueltoAt: mesPrueba + '-15T12:00:00.000Z' });
    check('carga con TC: ahora sí genera la deuda',
      conTC.ok === true && !!conTC.movimiento, conTC.ok ? 'movimiento creado' : conTC.motivo);
    // 10% de 1.000.000 ZZK = 100.000 ZZK ÷ 4000 = 25 USDT
    check('carga con TC: la comisión queda bien calculada',
      conTC.movimiento && conTC.movimiento.monto_usdt === '25',
      '10% de 1.000.000 ZZK a 4000 → ' + (conTC.movimiento || {}).monto_usdt + ' USDT');

    // 5 · y el aviso de Revisión desaparece solo, sin que nadie lo tache
    const rev2 = revisionSvc.revisar(mesPrueba);
    check('carga con TC: el aviso de Revisión se borra solo',
      !rev2.items.some((i) => /sin su comisión registrada/.test(i.titulo)));

    // limpieza
    baseCarga.prepare('DELETE FROM movimientos WHERE cliente_id=?').run(cli.id);
    pedidosStore.remove(ped.id);
    require('../src/db').db.prepare("DELETE FROM config_valores WHERE entidad_id=?").run(cli.id);
    require('../src/db').db.prepare("DELETE FROM historial_config WHERE entidad_id=?").run(cli.id);
    clientesStore.removeCliente(cli.id);
    cierreSt.removeMonedaTC(MONEDA);

    /* ── EL PESO ERA LA ÚNICA DIVISA SIN RESPALDO ─────────────────────────────────────────────
       Las demás pasan por tcDelDia, que si no tiene la foto del día cae al TC del mes. El peso
       iba sólo por la cotización viva: si esa fallaba, se quedaba sin la cara en dólares para
       siempre. Ahora se marca tc_modo='mes' y se deriva al leer — el día que se carga el TC
       definitivo del cierre, esa carga pasa a valer lo que corresponde, sola. */
    const srcCarga = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'deuda-carga.service.js'), 'utf8');
    check('carga en pesos sin cotización viva: se valúa con el TC del mes, no se pierde',
      /\} else if \(divisa === 'ARS'\) \{[\s\S]{0,600}?tcModo = 'mes';/.test(srcCarga)
      && /tc_modo: tcModo,/.test(srcCarga));
    /* Y hay que enterarse EN EL MOMENTO, no sólo al revisar el mes. Las fichas ya salieron: la
       carga sigue estando bien, pero la comisión no quedó en la cuenta. Antes el único rastro era
       un console.warn en los logs de Railway. */
    const srcIdx = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'index.js'), 'utf8');
    check('carga sin TC: el aviso viaja en la respuesta de la carga',
      /const deudaFalla = deudaCarga && !deudaCarga\.ok && deudaCarga\.sinTC/.test(srcIdx)
      && /\.\.\.\(deudaFalla \? \{ avisoDeuda: deudaFalla \} : \{\}\)/.test(srcIdx));
    const srcOp = require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'index.html'), 'utf8');
    check('carga sin TC: la pantalla del operativo lo muestra al lado del pedido',
      /if \(d\.avisoDeuda\)/.test(srcOp)
      && /La comisión de esta carga no se registró/.test(srcOp));

    // Y el contador de la cuenta corriente ve los que hayan quedado de antes.
    const srcDeuda = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'deuda.service.js'), 'utf8');
    check('cuenta corriente: cuenta aparte los movimientos sin importe en ninguna moneda',
      /\(m\[otra\] == null \|\| m\[otra\] === ''\)\) sinImporte \+= 1;/.test(srcDeuda)
      && /^\s{4}sinImporte,$/m.test(srcDeuda));
  }
  /* ── LOS BOTONES DE "EMITIR A TODOS DE UNA" NO MIRABAN LOS AVISOS ────────────────────────────
     Tres pantallas, el mismo defecto: calculando cliente por cliente los problemas se ven; con el
     botón que emite a los 45 juntos, no viajaban y la factura salía igual. */
  {
    const srcExt = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'externos.service.js'), 'utf8');
    const srcRt = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'os.routes.js'), 'utf8');
    const srcUi = require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'os.html'), 'utf8');
    const srcFac = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'factura-html.js'), 'utf8');

    /* La guarda dice, con todas las letras, "un reporte INCOMPLETO no se emite: cobraría de menos
       y parecería correcto". Y la marca se encendía SÓLO con el reloj: `incompleto: sinTiempo > 0`.
       Hay cuatro formas más de salir corto y con ninguna se frenaba. */
    check('emitir: la marca de incompleto ya no mira sólo el reloj',
      !/incompleto: sinTiempo > 0/.test(srcExt)
      && /incompleto: motivosIncompleto\.length > 0/.test(srcExt));
    // Las cinco, contadas por separado — contar los textos de `avisos` se rompe al corregir una palabra.
    const CINCO = ['sinTiempo', 'sinConexion', 'noResponde', 'consultasFallidas', 'sinTasa'];
    const enFaltantes = srcExt.slice(srcExt.indexOf('faltantes: {'), srcExt.indexOf('porQueIncompleto:'));
    check('emitir: cuenta las cinco formas de quedar corto',
      CINCO.every((k) => enFaltantes.includes(k)),
      CINCO.filter((k) => !enFaltantes.includes(k)).join(',') || 'las 5');
    // Cada contador se incrementa donde corresponde, no sólo se declara.
    check('emitir: los contadores se incrementan en su lugar',
      /sin conexión de casino, no se pudo consultar`\); sinConexion\+\+;/.test(srcExt)
      && /no responde`\); noResponde\+\+;/.test(srcExt)
      && /if \(!r\.porTiempo\) consultasFallidas\+\+;/.test(srcExt));
    // Un timeout NO se cuenta dos veces: ya lo cuenta sinTiempo.
    check('emitir: un timeout no se cuenta dos veces', /if \(!r\.porTiempo\) consultasFallidas\+\+/.test(srcExt));
    // Una línea cobrable sin tipo de cambio entra al total valiendo CERO: es cobrar de menos.
    check('emitir: una línea cobrable sin tipo de cambio cuenta como incompleta',
      /const sinTasaN = filas\.filter\(\(f\) => f\.sinTasa\)\.length;/.test(srcExt)
      && /sin tipo de cambio: entran al total valiendo cero/.test(srcExt));

    // Y el motivo llega a la pantalla: un cliente salteado sin decir por qué no se puede destrabar.
    check('emitir: el motivo real llega a la pantalla, no "faltan N consultas"',
      !/la foto del mes está incompleta \(faltan \$\{r\.sinTiempo\} consultas\)/.test(srcRt)
      && (srcRt.match(/error: 'el reporte salió incompleto: ' \+ r\.porQueIncompleto\.join\(' · '\)/g) || []).length === 2
      && (srcRt.match(/faltantes: r\.faltantes, avisos: r\.avisos/g) || []).length === 2);

    /* ── LA FACTURA DE CONSUMO: NO SE EMITE UN TOTAL RECORTADO ────────────────────────────────
       Si falta el TC de una moneda, lo vendido en esa moneda queda afuera del total del cliente.
       Emitir así le cobra de menos, y como emitir es idempotente por cliente+origen+mes, la parte
       que falta ya NO se puede agregar: habría que anular el mes entero.
       No cobrar todavía se arregla cargando el TC y volviendo a emitir. Cobrar de menos, no. */
    check('consumo: la facturación dice a QUIÉN le falta el TC, no sólo qué monedas',
      /const sinTCCliente = \[\];/.test(srcRt)
      && /sinTC\.add\(div\); sinTCCliente\.push\(div\);/.test(srcRt)
      && /sinTC: sinTCCliente,/.test(srcRt));
    check('consumo: no se emite a un cliente con una moneda sin tipo de cambio',
      /if \(\(c\.sinTC \|\| \[\]\)\.length\) \{/.test(srcRt)
      && /recortados\.push\(/.test(srcRt)
      && /fallaron: recortados,/.test(srcRt));
    // Y la factura del cliente lo dice, en vez de un guioncito que se lee como cero.
    check('consumo: la factura del cliente avisa qué NO está incluido',
      /Este total no incluye/.test(srcFac)
      && /no incluido en este total/.test(srcFac)
      && !/\$\{d\.tc \? 'TC ' \+ \$\(d\.tc\) : '—'\}/.test(srcFac));

    /* ── LO QUE NO SE EMITIÓ QUEDA EN PANTALLA ────────────────────────────────────────────────
       Antes: "N con error" en un toast de 2,2 segundos y el detalle en console.warn. */
    check('emitir: hay un solo renderizador de lo que quedó sin cobrar',
      /function pintarSalteados\(id, r, quien\) \{/.test(srcUi)
      && /NO se les cobró este mes/.test(srcUi));
    const TRES = [['ext-emi-out', 'externos'], ['ven-emi-out', 'vendedores'], ['fac-emi-out', 'consumo']];
    const sinPanel = TRES.filter(([id]) => !(srcUi.includes(`id="${id}"`) && srcUi.includes(`pintarSalteados('${id}'`)));
    check('emitir: las tres emisiones lo muestran y lo dejan a la vista', !sinPanel.length,
      sinPanel.map((x) => x[1]).join(', ') || 'externos, vendedores y consumo');
    check('emitir: el detalle ya no se va a la consola del navegador',
      !/console\.warn\('externos que fallaron:'/.test(srcUi)
      && !/console\.warn\('vendedores que fallaron:'/.test(srcUi));
    // Y cuando salió todo bien, también lo dice: el silencio no distingue "salió bien" de "no corrió".
    check('emitir: cuando se emitió a todos, lo dice',
      /✅ Se emitió a todos\./.test(srcUi));
  }
  /* ── EL NIVEL DE UN PANEL NUEVO ──────────────────────────────────────────────────────────────
     Para bajarle fichas a un Agente hay que pasar por su Distribuidor y por su SuperAgente. Esa
     escala se resuelve contra el casino, porque el casino NO devuelve el padre de un nodo: hay que
     reconstruir el árbol desde la lista plana.

     Un panel recién creado nace con un nivel ELEGIDO —en el alta manual sale del desplegable, y al
     aprobar una caja está escrito fijo como 'SuperAgente'— y la cascada le cree. Un panel marcado
     SuperAgente carga DIRECTO, sin pasar por sus padres, y falla porque el padre real no tiene
     saldo. Pasó de verdad: GanamosM01, caja creada el 21 de agosto, marcada SuperAgente siendo
     Agente, único de los 204 paneles sin resolver. */
  {
    const arbol = require('../src/arbol.service');

    /* La lista del casino viene PLANA pero en orden jerárquico. Es el caso real de Fran:
       GanamosBot-SA → GanamosAlexa → GanamosF01 y GanamosM01. */
    const planos = [
      { id: '6825836', login: 'GanamosBot-SA', nivel: 'SuperAgente' },
      { id: '7156798', login: 'GanamosAlexa', nivel: 'Dealer' },
      { id: '7278879', login: 'GanamosF01', nivel: 'Agente' },
      { id: '7344299', login: 'GanamosM01', nivel: 'Agente' },
      { id: '7130908', login: 'GanamosTici', nivel: 'Dealer' },
      { id: '9999999', login: 'OtroAgente', nivel: 'Agente' },
    ];
    const idx = arbol.armar(planos);

    check('árbol: el padre sale del orden de la lista, no de un campo',
      idx.get('7344299').padre.login === 'GanamosAlexa'
      && idx.get('9999999').padre.login === 'GanamosTici',
      'GanamosM01 → ' + idx.get('7344299').padre.login + ' · OtroAgente → ' + idx.get('9999999').padre.login);
    // El casino dice "Dealer" y el OS dice "Distribuidor": es el mismo escalón, y mezclarlos es
    // una fuente segura de bugs. Todo sale traducido.
    check('árbol: "Dealer" del casino se traduce a "Distribuidor" del OS',
      idx.get('7156798').nivel === 'Distribuidor' && idx.get('7156798').nivelCasino === 'Dealer');
    // La escala completa, de arriba hacia abajo: es por donde van a pasar las fichas.
    const esc2 = arbol.escalaDe(idx.get('7344299')).map((x) => x.login + '/' + x.nivel);
    check('árbol: la escala de un Agente pasa por su Distribuidor y su SuperAgente',
      esc2.join(' → ') === 'GanamosBot-SA/SuperAgente → GanamosAlexa/Distribuidor',
      esc2.join(' → '));
    // Un SuperAgente no tiene por dónde pasar: carga directo, y eso está bien.
    check('árbol: un SuperAgente de verdad no lleva escala',
      arbol.escalaDe(idx.get('6825836')).length === 0);
    // Un hermano no se cuelga del otro: dos Agentes seguidos comparten padre.
    check('árbol: dos agentes seguidos comparten padre, no se cuelgan entre sí',
      idx.get('7278879').padre.id === idx.get('7344299').padre.id
      && idx.get('7344299').padre.id === '7156798');

    /* ── LO QUE HACE QUE LA CARGA FALLE ───────────────────────────────────────────────────────
       La cascada arma sus pasos con la escala GUARDADA. Sin resolver, la escala está vacía y el
       único paso es el destino: carga directa. */
    const cascada = require('../src/carga-cascada.service');
    const panelesSt = require('../src/paneles-store');
    const clientesSt2 = require('../src/clientes-store');
    const cli2 = clientesSt2.createCliente({ codigo: 'ZZ-ARBOL', nombre: 'Prueba árbol' });
    const pSinResolver = panelesSt.create({ cliente_id: cli2.id, nombre: 'ZZ-M01', sistema: 'Europa',
      nivel_usuario: 'SuperAgente', id_usuario: '7344299', divisas: ['ARS'] });
    const antes = cascada.pasosDe({ sistema: 'Europa', userId: '7344299', monto: 1000, divisa: 'ARS' });
    check('cascada: sin resolver, carga DIRECTO (un solo paso) — así fallaba',
      antes.pasos.length === 1 && antes.pasos[0].destino === true && antes.resuelto === false,
      antes.pasos.length + ' paso(s), resuelto=' + antes.resuelto);

    // Con la jerarquía resuelta, los pasos son tres y el destino queda último.
    panelesSt.setJerarquia(pSinResolver.id, {
      nivel: 'Agente',
      padre: idx.get('7344299').padre,
      superagente: arbol.escalaDe(idx.get('7344299'))[0],
      escala: arbol.escalaDe(idx.get('7344299')),
    });
    const despues = cascada.pasosDe({ sistema: 'Europa', userId: '7344299', monto: 1000, divisa: 'ARS' });
    check('cascada: resuelto, las fichas bajan por los tres escalones',
      despues.pasos.length === 3
      && despues.pasos[0].login === 'GanamosBot-SA' && despues.pasos[1].login === 'GanamosAlexa'
      && despues.pasos[2].destino === true && despues.resuelto === true,
      despues.pasos.map((x) => x.login).join(' → '));
    panelesSt.remove(pSinResolver.id);
    clientesSt2.removeCliente(cli2.id);

    /* ── QUE NO VUELVA A PASAR ────────────────────────────────────────────────────────────────
       Tres cosas: se puede resolver UNO solo, se ve cuando no está resuelto, y se resuelve solo
       al crearlo. */
    const srcArb = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'arbol.service.js'), 'utf8');
    check('árbol: se puede resolver un panel solo, sin re-sincronizar los 204',
      /async function sincronizar\(\{ soloConexion = null, soloPanel = null, dry = false \} = \{\}\)/.test(srcArb)
      && /const todos = uno \? \[uno\] : paneles\.list\(\);/.test(srcArb));
    // Y sin bajar el árbol de las conexiones que no hacen falta.
    check('árbol: para un panel puntual sólo baja el árbol de SU sistema',
      /\.filter\(\(c\) => !uno \|\| String\(c\.nombre \|\| ''\)\.toLowerCase\(\) === String\(uno\.sistema \|\| ''\)\.toLowerCase\(\)\)/.test(srcArb));
    // El modo mirar-sin-tocar: una sincronización reescribe los 204, conviene poder verla antes.
    check('árbol: se puede mirar qué cambiaría sin escribir nada',
      /if \(!dry\) \{\s*\n\s*paneles\.setJerarquia/.test(srcArb) && /dry: !!dry/.test(srcArb));

    const srcRt2 = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'os.routes.js'), 'utf8');
    check('árbol: un panel nuevo se resuelve solo, por los dos caminos de alta',
      /function _resolverJerarquia\(panel\)/.test(srcRt2)
      && (srcRt2.match(/_resolverJerarquia\(panel\);/g) || []).length === 2);
    // En segundo plano: baja el árbol entero y tarda; bloquear el alta sería peor.
    check('árbol: resolver no bloquea el alta ni tumba el proceso si falla',
      /arbolSvc\.sincronizar\(\{ soloPanel: panel\.id \}\)\s*\n\s*\.then/.test(srcRt2)
      && /\.catch\(\(e\) => console\.warn\('\[Árbol\] no se pudo resolver'/.test(srcRt2));

    const srcUi2 = require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'os.html'), 'utf8');
    check('árbol: un panel sin resolver se ve como tal, no como un nivel cualquiera',
      /function nivelPanel\(p\)\{/.test(srcUi2)
      && /if \(p\.arbol_at\) return esc\(p\.nivel_usuario\|\|''\);/.test(srcUi2)
      && /sin resolver<\/span>/.test(srcUi2)
      && /<td>\$\{sisPill\(p\.sistema\)\}<\/td><td>\$\{nivelPanel\(p\)\}<\/td>/.test(srcUi2));
    check('árbol: y tiene el botón para resolverlo ahí mismo',
      /async function resolverPanel\(id, nombre\)\{/.test(srcUi2)
      && /body: JSON\.stringify\(\{ panel_id: id \}\)/.test(srcUi2));
  }
  /* ── EL PEDIDO QUE QUEDA MUERTO SI EL SERVIDOR SE REINICIA A MITAD DE CARGA ───────────────────
     Antes de tocar el casino el pedido pasa a 'cargando' y eso queda escrito. La cascada tarda
     decenas de segundos. Si el proceso se cae o Railway redespliega en ese rato, nadie lo devolvía
     a 'pendiente': no había ninguna barrida al arrancar.

     Y ese estado no estaba contemplado en ningún lado: no aparecía en la cola, no se contaba, en el
     historial se dibujaba "✗ rechazado" —una mentira sobre un pedido cuyas fichas pueden estar
     cargadas— y el servidor rechazaba retomarlo. */
  {
    const ped = require('../src/pedidos-store');

    const p1 = ped.create({ codigo: 'ZZ-TRAB', clienteNombre: 'Prueba trabado', divisa: 'ARS', monto: 5000 });
    const p2 = ped.create({ codigo: 'ZZ-TRAB2', clienteNombre: 'Prueba trabado 2', divisa: 'ARS', monto: 7000 });

    // Se toma para cargar: es lo que pasa justo antes de tocar el casino.
    check('trabado: tomar un pedido lo pone en cargando', ped.tomarParaCargar(p1.id).estado === 'cargando');
    // Y un segundo intento no puede tomarlo: es el candado que evita cargar dos veces.
    check('trabado: no se puede tomar dos veces', ped.tomarParaCargar(p1.id) === null);

    /* Se simula el corte: la cascada alcanzó a hacer UN eslabón y quedó guardado (eso es lo que
       hace el `onPaso` nuevo), y el proceso se muere sin llegar a soltar el candado. */
    ped.setCascada(p1.id, [
      { id: '6825836', login: 'GanamosBot-SA', nivel: 'SuperAgente', estado: 'ok' },
      { id: '7156798', login: 'GanamosAlexa', nivel: 'Distribuidor', estado: 'pendiente' },
      { id: '7344299', login: 'GanamosM01', nivel: 'Agente', destino: true, estado: 'pendiente' },
    ], null);
    ped.tomarParaCargar(p2.id);   // éste se cortó sin mover nada

    // 'cargando' se contaba en NINGÚN lado: quedar trabado era quedar invisible.
    check('trabado: los pedidos en cargando ahora se cuentan', ped.counts().cargando === 2,
      JSON.stringify({ pendientes: ped.counts().pendientes, cargando: ped.counts().cargando }));

    /* ── LA BARRIDA AL ARRANCAR ────────────────────────────────────────────────────────────────
       Es segura sin mirar el reloj: si el proceso recién arranca, ninguna carga suya puede estar
       corriendo. */
    const libres = ped.destrabarAlArrancar();
    check('trabado: al arrancar vuelven todos a la cola', libres.length === 2
      && ped.get(p1.id).estado === 'pendiente' && ped.get(p2.id).estado === 'pendiente',
      libres.length + ' destrabado(s)');
    // Y dice cuántos eslabones habían salido: es lo que avisa si quedaron fichas en un padre.
    const l1 = libres.find((x) => x.id === p1.id), l2 = libres.find((x) => x.id === p2.id);
    check('trabado: dice cuántos eslabones ya habían salido',
      l1.pasosHechos === 1 && l2.pasosHechos === 0,
      'uno con 1 eslabón hecho, el otro sin mover nada');
    // El motivo queda escrito en el pedido: al mirarlo se entiende qué pasó.
    check('trabado: queda escrito por qué volvió a la cola',
      /el servidor se reinició mientras se cargaba/.test(ped.get(p1.id).error || ''));
    // Lo ya movido NO se pierde: es lo que hace que retomar no repita eslabones.
    check('trabado: lo que ya había salido queda guardado',
      (ped.get(p1.id).cascada || []).filter((x) => x.estado === 'ok').length === 1);
    // Y una barrida sobre una base sin trabados no hace nada.
    check('trabado: sin nada trabado, la barrida no toca nada', ped.destrabarAlArrancar().length === 0);

    /* ── DESTRABAR A MANO, CON EL SERVIDOR ANDANDO ─────────────────────────────────────────────
       Acá el reloj y el conjunto "en curso" SÍ importan: la carga puede estar corriendo, y
       destrabarla la haría cargar dos veces. */
    ped.tomarParaCargar(p1.id);
    ped.marcarEnCurso(p1.id);
    const vivo = ped.destrabarCarga(p1.id, 0);
    check('trabado: no se destraba una carga que se está ejecutando AHORA',
      vivo.ok === false && /se está cargando AHORA/.test(vivo.error), vivo.error);
    ped.quitarEnCurso(p1.id);
    // Sin ejecución viva pero recién tomado: tampoco, puede estar corriendo igual.
    const reciente = ped.destrabarCarga(p1.id, 5);
    check('trabado: tampoco si se tomó hace menos de 5 minutos',
      reciente.ok === false && /menos de 5 minutos/.test(reciente.error), reciente.error);
    // Pasado ese rato sí, y vuelve a la cola conservando lo ya hecho.
    const ok2 = ped.destrabarCarga(p1.id, 0);
    check('trabado: pasado el rato vuelve a la cola y conserva lo ya hecho',
      ok2.ok === true && ped.get(p1.id).estado === 'pendiente' && ok2.pasosHechos === 1);
    // Y no se puede destrabar algo que no está trabado.
    check('trabado: no se destraba un pedido que no está trabado',
      ped.destrabarCarga(p1.id, 0).ok === false);

    ped.remove(p1.id); ped.remove(p2.id);

    /* ── LO QUE HACE QUE RETOMAR SEA SEGURO ────────────────────────────────────────────────────
       Los pedidos guardaban la cascada recién AL TERMINAR. Si el proceso moría en el medio, los
       pasos ya salidos no quedaban escritos, y al retomar la cascada los volvía a ejecutar: el
       SuperAgente terminaba con un monto de más y un Distribuidor con fichas trabadas. */
    const srcIdx3 = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'index.js'), 'utf8');
    check('trabado: cada eslabón se guarda apenas sale, no al final',
      /onPaso: \(hechos\) => \{ try \{ pedidos\.setCascada\(p\.id, hechos, null\); \}/.test(srcIdx3));
    // Y la cascada saltea los que ya salieron: es lo que hace que retomar no cargue dos veces.
    const srcCas = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'carga-cascada.service.js'), 'utf8');
    check('trabado: la cascada saltea los pasos que ya salieron',
      /if \(paso\.estado === 'ok'\) continue;/.test(srcCas));
    // La barrida corre al arrancar, y si falla no impide que el servidor levante.
    check('trabado: la barrida corre al arrancar y no puede tumbar el arranque',
      /const destrabados = pedidos\.destrabarAlArrancar\(\);/.test(srcIdx3)
      && /catch \(e\) \{ console\.warn\('\[Pedido\] no se pudo destrabar al arrancar:'/.test(srcIdx3));
    // El conjunto "en curso" se marca y se quita por los tres caminos: éxito, error y soltar.
    check('trabado: la carga se marca en curso y se desmarca siempre',
      /pedidos\.marcarEnCurso\(p\.id\);/.test(srcIdx3)
      && /const soltar = \(\) => \{\s*\n\s*pedidos\.quitarEnCurso\(p\.id\);/.test(srcIdx3)
      && /if \(r\.ok\) \{\s*\n\s*pedidos\.quitarEnCurso\(p\.id\);/.test(srcIdx3));

    // La pantalla deja de mentir: 'cargando' ya no se dibuja como rechazado.
    const srcOp3 = require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'index.html'), 'utf8');
    check('trabado: el historial ya no dice "rechazado" sobre una carga en curso',
      /p\.estado === 'cargando' \? '<span style="color:#b26a00">⏳ cargando…<\/span>' : '✗ rechazado'/.test(srcOp3)
      && /trabado hace \$\{min\} min/.test(srcOp3));
    check('trabado: y ofrece devolverlo a la cola desde ahí mismo',
      /async function destrabarPedido\(id\)/.test(srcOp3)
      && /\/destrabar`, \{ method: 'POST' \}/.test(srcOp3));
    // El operador puede destrabar: es despachar, y no mueve fichas.
    const srcAuth3 = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'auth.js'), 'utf8');
    check('trabado: el operador puede destrabar (es despachar, no mueve fichas)',
      /\(cargar\|rechazar\|anular\|devolver-trabadas\|destrabar\)/.test(srcAuth3));
  }
  /* ── EL NOMBRE DEL CIERRE, Y LOS RESTOS DE LA MIGRACIÓN ──────────────────────────────────────
     `alias` nació para cruzar la planilla mientras se traía la gente del sistema viejo: TBS llama
     a las cuentas "TBSGerson", "API-MOISES2025", "TBS45Ar23" y la planilla escribía "GERSON",
     "Moises", "Colombians". Había una `buscarCliente` que encontraba una cuenta por login o por
     cualquiera de esos nombres — y NO LA LLAMABA NADIE: aparecía dos veces en todo el repo, su
     definición y la línea de exports. Las cuentas nuevas nacen en el OS, no vienen de ninguna
     planilla, así que no hay nada que cruzar. Se sacó.

     Lo único vivo del campo es el PRIMER valor: el nombre con el que la cuenta aparece en el
     cierre (api-resumen.service.js: comoLoLlama). */
  {
    const apiSt = require('../src/api-store');
    const srcApi = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'api-store.js'), 'utf8');

    check('nombre TBS: la búsqueda por nombres de la planilla ya no existe',
      !/function buscarCliente/.test(srcApi) && !/buscarCliente,/.test(srcApi));

    const ID = 'zz-nombre-test';
    apiSt.saveCliente({ id: ID, login: 'TBSPrueba', agente: 'zz', alias: [] });

    // Sin nota, la cuenta del mes se nombra por el login de TBS.
    const resumen = require('../src/api-resumen.service');
    check('nombre TBS: sin nota, la cuenta se nombra por el login de TBS',
      resumen.comoLoLlama(apiSt.getCliente(ID)) === 'TBSPrueba');

    /* Con la nota, la cuenta que se le manda dice "Cuenta Raul" en vez de "Cuenta Raul-API". Es un
       encabezado: el login sigue estando adentro del documento, sección por sección. */
    apiSt.setDeQuien(ID, 'Raul');
    check('nombre TBS: con la nota, la cuenta se nombra por la persona',
      resumen.comoLoLlama(apiSt.getCliente(ID)) === 'Raul'
      && apiSt.getCliente(ID).login === 'TBSPrueba',
      'se nombra Raul y en TBS sigue siendo TBSPrueba');

    // Ponerle el mismo login no se guarda: nombrarla igual que su login es no poner nada.
    apiSt.setDeQuien(ID, 'TBSPrueba');
    check('nombre TBS: la nota igual al login no se guarda, porque no cambia nada',
      apiSt.getCliente(ID).de_quien === ''
      && resumen.comoLoLlama(apiSt.getCliente(ID)) === 'TBSPrueba');

    /* ── LA MUDANZA NO CAMBIA LO QUE SE VE ─────────────────────────────────────────────────────
       El primer alias ERA el nombre que se mostraba, así que pasa a `de_quien` tal cual y sale de
       la lista para no quedar duplicado. Lo que queda en `alias` son restos que no hacen nada. */
    const ID2 = 'zz-mudanza-test';
    require('../src/db').db.prepare(`INSERT INTO api_cliente (id,login,alias,agente,activo,excluye,notas,createdAt)
      VALUES (?,?,?,?,1,'[]','',?)`).run(ID2, 'TBSViejo', JSON.stringify(['DAVID', 'David', 'tbsviejo']), 'zz', new Date().toISOString());
    // La mudanza corre al cargar el módulo; acá se simula el mismo paso sobre esta fila.
    const antesMud = apiSt.getCliente(ID2);
    check('nombre TBS: una fila vieja llega con todo adentro de alias',
      antesMud.de_quien === '' && antesMud.alias.length === 3);
    delete require.cache[require.resolve('../src/api-store')];
    const apiSt2 = require('../src/api-store');
    const despMud = apiSt2.getCliente(ID2);
    check('nombre TBS: la mudanza pasa el primero a la nota y no cambia lo que se ve',
      despMud.de_quien === 'DAVID' && despMud.alias.length === 2
      && resumen.comoLoLlama(despMud) === 'DAVID',
      'de_quien=' + despMud.de_quien + ' · restos=' + JSON.stringify(despMud.alias));
    // Y sacar los restos no toca la nota.
    const limp = apiSt2.limpiarNombresViejos(ID2);
    check('nombre TBS: sacar los restos no toca de quién es',
      limp.ok && limp.sacados.length === 2 && apiSt2.getCliente(ID2).alias.length === 0
      && apiSt2.getCliente(ID2).de_quien === 'DAVID',
      'sacó ' + limp.sacados.join(', '));

    apiSt2.removeCliente(ID2);
    apiSt.removeCliente(ID);

    /* La ruta va aparte de `saveCliente` a propósito: aquélla reescribe login, agente y notas con
       lo que venga en el cuerpo, así que mandarle sólo el nombre los borraría. */
    const srcRt4 = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'os.routes.js'), 'utf8');
    check('nombre TBS: se guarda por su propia ruta, no por la que reescribe toda la cuenta',
      /app\.put\('\/api\/os\/api\/clientes\/:id\/nombre'/.test(srcRt4)
      && /apiStore\.setDeQuien/.test(srcRt4)
      && /app\.delete\('\/api\/os\/api\/clientes\/:id\/nombres-viejos'/.test(srcRt4));

    const srcUi4 = require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'os.html'), 'utf8');
    check('nombre TBS: la pantalla pide de quién es, y muestra el login como la identidad',
      /function apiNombre\(c\)\{/.test(srcUi4) && /De quién es<\/label>/.test(srcUi4)
      && /En TBS se sigue llamando/.test(srcUi4)
      && !/Otros nombres<\/label>/.test(srcUi4));
    // Y dice qué son los que quedan, en vez de mostrarlos como si hubiera que mantenerlos.
    check('nombre TBS: los restos de la planilla se explican y se pueden sacar',
      /de cuando se traía la gente de la planilla/.test(srcUi4)
      && /apiNombresViejos\('\$\{c\.id\}'\)/.test(srcUi4));
    /* Al mudar los datos reales, en varias cuentas el nombre de la PERSONA quedó entre los restos y
       arriba quedó el login reescrito: Raul-API tiene "Raul-API" como nota y "Raul" abajo. Elegir
       el bueno tiene que ser un clic. */
    check('nombre TBS: cada resto se puede elegir con un clic',
      /async function apiUsarNombre\(id, v\)\{/.test(srcUi4)
      && /onclick="apiUsarNombre\('\$\{c\.id\}','\$\{esc\(v\)/.test(srcUi4));
  }
  /* ── LAS OFERTAS COMERCIALES ─────────────────────────────────────────────────────────────────
     La oferta ES el precio: se arma con paquetes, se manda como documento y al aplicarla escribe
     la matriz. Antes se cotizaba en una hoja aparte y después había que volver a tipear los mismos
     números para facturar — dos lugares con el mismo dato es cómo terminan distintos. */
  {
    const ofs = require('../src/api-ofertas-store');
    const ofHtml = require('../src/api-oferta-html');
    const apiSt2 = require('../src/api-store');
    const { db: dbOf } = require('../src/db');

    /* ── LOS NOMBRES QUE VE EL CLIENTE ─────────────────────────────────────────────────────────
       TBS mete hasta DOS aclaraciones entre paréntesis al final y marcadores internos de variante
       (OP/KN/EV/SZ). Sacando una sola quedaba "ELK Studios (Slot zona)" como si fuera el nombre de
       un proveedor. */
    check('oferta: saca las aclaraciones del final, incluso cuando son dos',
      ofs.proveedoresDe('EGT Digital, Pragmatic Play, NetEnt, ELK Studios (Slot zona) (prepayment)')
        .join('|') === 'EGT Digital|Pragmatic Play|NetEnt|ELK Studios',
      ofs.proveedoresDe('EGT Digital, Pragmatic Play, NetEnt, ELK Studios (Slot zona) (prepayment)').join(' · '));
    check('oferta: saca los marcadores internos de TBS del final del nombre',
      ofs.proveedoresDe('PGSOFT OP KN OP').join('|') === 'PG Soft'
      && ofs.proveedoresDe('EVOLUTION LOBBY PREMIUM OP').join('|') === 'Evolution Lobby Premium',
      ofs.proveedoresDe('PGSOFT OP KN OP') + ' · ' + ofs.proveedoresDe('EVOLUTION LOBBY PREMIUM OP'));
    /* La misma marca escrita distinto en dos sellos es UNA. Y el diccionario gana: son nombres de
       empresas reales y este documento va a un cliente — "Igt" y "Netent" se notan. */
    check('oferta: la misma marca escrita distinto aparece una sola vez, bien escrita',
      ofs.unicos(['Igt', 'IGT', 'Netent', 'NetEnt', 'Playngo', 'Playn GO']).join(' · ') === "IGT · NetEnt · Play'n GO",
      ofs.unicos(['Igt', 'IGT', 'Netent', 'NetEnt', 'Playngo', 'Playn GO']).join(' · '));

    // ── armar una oferta y resolver los precios ──
    const P1 = ofs.savePaquete({ nombre: 'ZZ Básico', sellos: ['ZZ-uno', 'ZZ-dos'] }).paquete;
    const P2 = ofs.savePaquete({ nombre: 'ZZ Live', sellos: ['ZZ-tres'] }).paquete;
    const O = ofs.saveOferta({ titulo: 'ZZ Prueba', lineas: [
      { paquete_id: P1.id, pct: '8' }, { paquete_id: P2.id, pct: '12' },
      { sello: 'ZZ-dos', pct: '15' },        // excepción suelta
    ] }).oferta;

    const r = ofs.resolver(O);
    check('oferta: el paquete le pone el precio a todos sus sellos',
      r.get('ZZ-uno').pct === '8' && r.get('ZZ-tres').pct === '12');
    /* El sello suelto le gana al paquete. Sin esa regla habría que sacar el sello del paquete y
       perder la agrupación del documento, que es justo lo que lo hace entendible. */
    check('oferta: un sello negociado aparte le gana al precio del paquete',
      r.get('ZZ-dos').pct === '15' && r.get('ZZ-dos').suelto === true
      && r.get('ZZ-dos').paquete_id === P1.id,
      'ZZ-dos va a 15% y sigue mostrándose dentro de ' + P1.nombre);
    // El % pasa el mismo control que la matriz del cierre, por el mismo motivo.
    check('oferta: un % mal escrito no entra',
      ofs.saveOferta({ titulo: 'ZZ mal', lineas: [{ paquete_id: P1.id, pct: '12,5' }] }).ok === false
      && ofs.saveOferta({ titulo: 'ZZ mal', lineas: [{ paquete_id: P1.id, pct: '120' }] }).ok === false);

    /* ── QUÉ CAMBIA ANTES DE ESCRIBIR ──────────────────────────────────────────────────────────
       Un cliente que ya venía facturando puede tener precios negociados que la oferta no menciona:
       pisarlos sin verlos es cobrarle distinto sin haberlo decidido. */
    const CID = 'zz-oferta-cli';
    apiSt2.saveCliente({ id: CID, login: 'ZZOferta', agente: 'zz', alias: [] });
    dbOf.prepare("INSERT INTO api_pct (cliente_id,sello,pct_cliente,origen) VALUES (?,?,?,'planilla')")
      .run(CID, 'ZZ-uno', '5');                       // ya tenía otro precio
    dbOf.prepare("INSERT INTO api_pct (cliente_id,sello,pct_cliente,origen) VALUES (?,?,?,'planilla')")
      .run(CID, 'ZZ-ajeno', '99');                    // algo que la oferta no menciona
    const d = ofs.diff(O, CID);
    check('oferta: dice qué precios cambian y desde cuánto',
      d.cambian.length === 1 && d.cambian[0].sello === 'ZZ-uno' && d.cambian[0].de === '5' && d.cambian[0].a === '8',
      'ZZ-uno: 5% → 8%');
    check('oferta: dice cuáles son nuevos', d.nuevos.length === 2);
    check('oferta: avisa de lo que el cliente tiene y la oferta NO menciona',
      d.fuera.length === 1 && d.fuera[0].sello === 'ZZ-ajeno');

    // ── aplicar: escribe la matriz y NO toca lo que no menciona ──
    const ap = ofs.aplicar(O, CID);
    const enMatriz = new Map(dbOf.prepare('SELECT sello, pct_cliente FROM api_pct WHERE cliente_id=?')
      .all(CID).map((x) => [x.sello, x.pct_cliente]));
    check('oferta: aplicarla escribe los precios en la matriz',
      ap.ok && enMatriz.get('ZZ-uno') === '8' && enMatriz.get('ZZ-dos') === '15' && enMatriz.get('ZZ-tres') === '12',
      ap.escritos + ' escritos');
    check('oferta: lo que la oferta no menciona queda como estaba',
      enMatriz.get('ZZ-ajeno') === '99');
    check('oferta: queda marcada como aplicada y enganchada a esa cuenta',
      ofs.getOferta(O.id).estado === 'aplicada' && ofs.getOferta(O.id).cliente_id === CID);
    // Y no se puede aplicar a una cuenta que no existe.
    check('oferta: no se aplica a una cuenta que no existe',
      ofs.aplicar(O, 'zz-no-existe').ok === false);

    /* ── EL DOCUMENTO NO PUEDE LLEVAR NADA INTERNO ─────────────────────────────────────────────
       Ni el costo del proveedor, ni el margen, ni los puntos de los socios, ni el nombre del sello,
       ni el grupo de TBS. El generador recibe sólo lo que `paraMostrar` devuelve. */
    const m = ofs.paraMostrar(ofs.getOferta(O.id));
    const html = ofHtml.pagina(m);
    check('oferta: el documento agrupa por paquete con el % de cada uno',
      /ZZ Básico/.test(html) && /ZZ Live/.test(html) && /12%/.test(html));
    check('oferta: el documento NO lleva costos, márgenes ni puntos de socios',
      !/costo|margen|pts_ib|pts_henry|pct_proveedor|grupo_id/i.test(html));
    // Un grupo con un solo precio muestra UN número; repetirlo en cada renglón no informa.
    check('oferta: con un precio único muestra un número y la lista de proveedores',
      (m.grupos.find((g) => g.nombre === 'ZZ Live') || {}).unico === '12');
    check('oferta: con precios distintos NO inventa un número único',
      (m.grupos.find((g) => g.nombre === 'ZZ Básico') || {}).unico === null,
      'ZZ Básico tiene 8% y 15%: no hay un número solo');

    // Los paquetes de arranque cubren el catálogo real y no se vuelven a sembrar si ya hay.
    check('oferta: sembrar de nuevo no pisa los paquetes que ya están',
      ofs.sembrarPaquetes().yaEstaban === true);

    ofs.removeOferta(O.id); ofs.removePaquete(P1.id); ofs.removePaquete(P2.id);
    dbOf.prepare('DELETE FROM api_pct WHERE cliente_id=?').run(CID);
    apiSt2.removeCliente(CID);

    // La ruta del documento tiene su propio cinturón: esto sale a un cliente y no hay vuelta atrás.
    const srcRt5 = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'os.routes.js'), 'utf8');
    check('oferta: la ruta del documento frena si detecta un dato interno',
      /el documento traía datos internos: NO se generó/.test(srcRt5));
    const srcUi5 = require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'os.html'), 'utf8');
    /* ⚠️ LA PESTAÑA TIENE QUE ESTAR EN LA BARRA DE TBS, no sólo escrita en algún lado del archivo.
       Este check antes buscaba el texto "💼 Ofertas" y lo encontraba... en `apiHeader`, que es la
       barra del espacio COMERCIAL y en /tbs no se dibuja nunca. Pasaba en verde con la pestaña
       invisible. Ahora se mira la barra de TBS y el registro de la vista, que son las dos cosas que
       de verdad la hacen aparecer. */
    const navTbs = srcUi5.slice(srcUi5.indexOf('const TABS_TBS = ['), srcUi5.indexOf('const ES_TBS'));
    check('oferta: la pestaña está en la barra de TBS, que es donde se trabaja',
      /\['tbsofertas','💼 Ofertas'\]/.test(navTbs), navTbs.replace(/\s+/g, ' ').slice(0, 120));
    check('oferta: y la vista tbsofertas está registrada',
      /\['ofertas','matriz','clientes','cuentas','resumen'\]\.forEach/.test(srcUi5));
    check('oferta: muestra los cambios antes de escribir',
      /API\.ofertas = async/.test(srcUi5) && /async function ofVerCambios\(id\)/.test(srcUi5)
      && /Escribir estos precios en la matriz/.test(srcUi5));
  }
  /* ── EL NAVEGADOR NO PUEDE QUEDARSE CON UNA COPIA VIEJA ──────────────────────────────────────
     `express.static` no manda ningún Cache-Control, y sin él el navegador aplica su propia regla:
     reutiliza la respuesta un rato SIN preguntar si cambió. Para un archivo que se reescribe en
     cada despliegue eso significa que un cambio ya subido no aparece — y desde la pantalla se ve
     idéntico a que no se hubiera desplegado.
     Pasó de verdad: la pestaña de Ofertas estaba en el servidor y en la pantalla no. */
  {
    for (const ruta of ['/os', '/tbs']) {
      const rr = await axios.get(BASE + ruta, H());
      check(`cache: ${ruta} se revalida siempre`,
        String(rr.headers['cache-control'] || '') === 'no-cache',
        ruta + ' → ' + (rr.headers['cache-control'] || '(sin cabecera)'));
    }
    // Y sigue mandando ETag, que es lo que hace que revalidar no cueste ancho de banda: la
    // respuesta a "¿cambió?" es un 304 sin cuerpo.
    const re = await axios.get(BASE + '/tbs', H());
    check('cache: sigue mandando ETag, así revalidar no cuesta nada', !!re.headers.etag,
      String(re.headers.etag || '').slice(0, 24));
    // Lo que NO es HTML sí puede cachearse: no cambia en cada despliegue.
    const srcIdx6 = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'index.js'), 'utf8');
    check('cache: sólo los HTML se revalidan; el resto se cachea',
      /\.html\?\$\/i\.test\(ruta\) \? 'no-cache' : 'public, max-age=3600'/.test(srcIdx6));
  }

  /* ── 💬 CHAT EXTERNO ─────────────────────────────────────────────────────────────────────────
     Un servicio de terceros que algunos paneles contratan. Los DOS lados tienen precios distintos
     y ésa es toda la razón de que exista: al cliente se le cobra lo negociado, al proveedor se le
     paga un % fijo, y la diferencia es el margen. La factura del cliente dice SU número.

     No es un sistema aparte porque no hay ningún dato nuevo: son clientes de Imperia que ya están
     cargados, con paneles que ya están cargados, y la ganancia YA se captura todas las noches en
     `reporte_diario`. Duplicarlo habría sido dos copias del mismo número. */
  {
    const ch = require('../src/chat-externo.store');
    const moneyCh = require('../src/lib/money');
    const { db: dbCh } = require('../src/db');
    const panSt = require('../src/paneles-store');
    const cliSt3 = require('../src/clientes-store');

    /* Restos de una corrida anterior que se cortó a la mitad. Esta base NO se borra entre corridas
       —el server corre con otra (DB_PATH), ésta es la de desarrollo— así que un panel que quedó
       colgado sigue ahí en la siguiente y se cobra dos veces en el cierre. Se limpia por nombre y
       por conexión, no por el id del cliente: borrar el cliente deja el panel huérfano. */
    cliSt3.list().clientes.filter((x) => x.codigo === 'ZZ-CHAT').forEach((x) => cliSt3.removeCliente(x.id));
    dbCh.prepare("DELETE FROM reporte_diario WHERE conexion_id='cx_zz'").run();
    dbCh.prepare(`DELETE FROM chat_panel WHERE panel_id IN
      (SELECT id FROM paneles WHERE nombre='ZZ-Panel-Chat' OR conexion_id='cx_zz')`).run();
    dbCh.prepare("DELETE FROM paneles WHERE nombre='ZZ-Panel-Chat' OR conexion_id='cx_zz'").run();
    const CLI = cliSt3.createCliente({ codigo: 'ZZ-CHAT', nombre: 'Prueba chat' });
    const PAN = panSt.create({ cliente_id: CLI.id, nombre: 'ZZ-Panel-Chat', sistema: 'Europa',
      nivel_usuario: 'SuperAgente', id_usuario: '9990001', conexion_id: 'cx_zz', divisas: ['ARS'] });

    // La ganancia sale de lo que el cron ya guarda: conexión + nodo, día por día.
    const insDia = dbCh.prepare(`INSERT INTO reporte_diario (id,conexion_id,fecha,grp,sa_id,login,in_amt,out_amt,profit,moneda,captured_at)
      VALUES (?,?,?,'superagent',?,?,?,?,?,?,?)`);
    ['2026-08-01', '2026-08-02'].forEach((f, i) => insDia.run('zzrd' + i, 'cx_zz', f, '9990001',
      'ZZ-Panel-Chat', '1000', '900', '100000', 'ARS', new Date().toISOString()));

    check('chat: la ganancia sale del acumulado ya guardado, no de una consulta nueva',
      ch.gananciaDelMes('2026-08').get('cx_zz|superagent|9990001|ARS') === 200000,
      '200.000 ARS entre los dos días');

    /* Sin tipo de cambio del mes no hay USDT y toda la cuenta da cero — que es el comportamiento
       correcto y está probado más abajo, pero acá hace falta uno para ejercitar la aritmética. */
    dbCh.prepare(`INSERT INTO tc_mes (mes,tc_cliente,updatedAt) VALUES ('2026-08','1000',?)
      ON CONFLICT(mes) DO UPDATE SET tc_cliente='1000'`).run(new Date().toISOString());

    // Config: el costo y la mensualidad son UNO para todo el servicio.
    ch.setConfig({ costo_pct: '2', mensualidad: '30', mensualidad_moneda: 'USDT' });
    check('chat: el costo y la mensualidad viven en un solo lugar',
      ch.config().costo_pct === '2' && ch.config().mensualidad === '30');
    /* La coma es como se escribe un número acá: "2,5" es 2.5 y se guarda normalizado. Un % no lleva
       separador de miles —nadie cobra el 1.500%— así que no hay nada que adivinar. */
    check('chat: un porcentaje con coma entra y se guarda con punto',
      ch.setConfig({ costo_pct: '2,5' }).ok === true && ch.config().costo_pct === '2.5');
    check('chat: un costo que no es un número no entra',
      ch.setConfig({ costo_pct: 'dos y medio' }).ok === false && ch.config().costo_pct === '2.5');
    ch.setConfig({ costo_pct: '2' });

    /* El % del cliente se guarda como el TOTAL que paga, no como el adicional: es el número que va
       en su factura y el que se piensa al negociar. El margen se calcula restando el costo. */
    ch.set({ panel_id: PAN.id, pct_cliente: '4', dia_cobro: 10 });
    const ci = ch.cierre('2026-08');
    const f = (ci.filas || [])[0];
    check('chat: se le cobra al cliente su precio y se paga el costo, sobre la MISMA ganancia',
      !!f && f.pct_cliente === '4' && f.pct_costo === '2',
      f ? `cobra ${f.pct_cliente}% · paga ${f.pct_costo}%` : 'sin filas');
    // 200.000 ARS ÷ el TC del mes → USDT; 4% de eso se cobra, 2% se paga, la diferencia es el margen.
    check('chat: el margen es la resta de los dos, no un número aparte',
      !!f && f.margen === moneyCh.sub(f.cobra, f.paga)
      && moneyCh.cmp(f.cobra, f.paga) > 0,
      f ? `cobra ${f.cobra} − paga ${f.paga} = ${f.margen} USDT` : '');

    /* Cobrarle MENOS de lo que cuesta se puede querer (una promoción) pero no por accidente: no se
       prohíbe, se marca. Ver sólo el total cobrado escondería justo este caso. */
    check('chat: no se puede cobrar menos de lo que te cuesta',
      ch.set({ panel_id: PAN.id, pct_cliente: '1' }).ok === false
      && ch.list().find((x) => x.panel_id === PAN.id).pct_cliente === '4',
      'es pagar de tu bolsillo para que el cliente tenga el servicio: no se guarda');
    check('chat: cobrar justo lo que te cuesta sí se puede',
      ch.set({ panel_id: PAN.id, pct_cliente: '2', dia_cobro: 10 }).ok === true);
    /* Pero el aviso sigue haciendo falta para el OTRO caso: que el costo SUBA después de haber
       puesto los precios. Ahí nadie tipeó nada mal y sin embargo estás perdiendo. */
    ch.setConfig({ costo_pct: '3' });
    const ci2 = ch.cierre('2026-08');
    check('chat: si el costo sube después, avisa que ese cliente pasó a perder',
      ci2.pierden.length === 1 && ci2.filas[0].pierde === true
      && moneyCh.isNeg(ci2.filas[0].margen),
      'cobra 2% y pasó a costar 3%: margen ' + ci2.filas[0].margen);
    ch.setConfig({ costo_pct: '2' });
    ch.set({ panel_id: PAN.id, pct_cliente: '4', dia_cobro: 10 });
    /* SIN PRECIO NO ES GRATIS. Cobrar cero sería regalar el servicio y pagarlo del bolsillo por un
       olvido; se cobra el MÍNIMO, que es lo que cuesta, y queda marcado para confirmarlo. */
    ch.set({ panel_id: PAN.id, pct_cliente: '', dia_cobro: 10 });
    const ciMin = ch.cierre('2026-08');
    check('chat: un panel sin precio se avisa, no se cobra en silencio',
      ciMin.sinPrecio.length === 1);
    check('chat: sin precio se cobra el mínimo, que es lo que te cuesta — no cero',
      ciMin.filas[0].pct_cliente === ciMin.costo_pct
      && moneyCh.cmp(ciMin.filas[0].cobra, '0') > 0
      && ciMin.filas[0].cobra === ciMin.filas[0].paga
      && ciMin.filas[0].margen === '0',
      `cobra ${ciMin.filas[0].cobra} = paga ${ciMin.filas[0].paga}`);
    check('chat: queda marcado que ese precio no está confirmado',
      ciMin.filas[0].pctMinimo === true && ciMin.filas[0].sinPrecio === true
      && ciMin.pierden.length === 0,
      'al mínimo, y no cuenta como "cobrás menos de lo que te cuesta"');

    /* Una ganancia negativa no genera cobro: cobrarle un % de una pérdida sería cobrarle por
       perder, y pagarle al proveedor por una pérdida tampoco tiene sentido. */
    dbCh.prepare('UPDATE reporte_diario SET profit=? WHERE conexion_id=?').run('-50000', 'cx_zz');
    ch.set({ panel_id: PAN.id, pct_cliente: '4' });
    const ciNeg = ch.cierre('2026-08');
    check('chat: un mes con pérdida no genera cobro ni pago',
      ciNeg.filas[0].cobra === '0' && ciNeg.filas[0].paga === '0',
      'ganancia negativa → no se cobra nada');

    /* La mensualidad NO va con el cierre: cada panel tiene su día porque no se cobran todas a
       principio de mes. Se cobra haya o no ganancias — es por tener el servicio, no por usarlo. */
    const m10 = ch.mensualidadesDe('2026-09-10'), m11 = ch.mensualidadesDe('2026-09-11');
    /* La mensualidad va a la cuenta del chat con SU fecha, y como un cliente con tres paneles paga
       tres, no puede compartir la llave única del cobro del mes. */
    const men1 = ch.cobrarMensualidad({ cliente_id: CLI.id, panel: 'ZZ-Panel-Chat', fecha: '2026-09-10' });
    const men2 = ch.cobrarMensualidad({ cliente_id: CLI.id, panel: 'ZZ-Panel-Chat-2', fecha: '2026-09-10' });
    check('chat: un cliente con dos paneles paga dos mensualidades',
      men1.ok && men2.ok
      && ch.cuentas('2026-09').clientes.find((x) => x.cliente_id === CLI.id).cobrado === '60',
      '30 + 30 = 60');
    /* "Mensualidad 30 USDT" no dice por qué mes se está cobrando, y a la tercera el cliente
       pregunta. El renglón tiene que explicarse solo dentro de seis meses. */
    check('chat: la mensualidad dice la caja y el período que cubre',
      men1.mov.nota === 'Mantenimiento ZZ-Panel-Chat · 10 sep – 9 oct',
      men1.mov.nota);
    // Cobrada un 31 de enero cubre hasta el 27 de febrero, no hasta marzo.
    check('chat: el período no se pasa de mes cuando el día no existe en el siguiente',
      ch.periodoDesde('2026-01-31').texto === '31 ene – 27 feb'
      && ch.periodoDesde('2026-12-15').texto === '15 dic – 14 ene',
      ch.periodoDesde('2026-01-31').texto);
    check('chat: la mensualidad cobrada se marca, para no cobrarla dos veces sin darse cuenta',
      ch.mensualidadesDe('2026-09-10').paneles.some((p) => p.cobrada === true));
    /* El aviso de la mensualidad va de a UNA: cada caja tiene su día, y mandarle las cuatro juntas
       el día de la primera sería cobrarle tres antes de tiempo. Y queda anotado: si no, "¿le
       avisaste a Ariel de la A3?" no tiene respuesta, y volver a mandarlo lo molesta dos veces. */
    ch.marcarAvisoMens(CLI.id, 'ZZ-Panel-Chat', '2026-09-10', { ok: false, error: 'chat not found' });
    check('chat: un aviso de mensualidad que falla queda anotado',
      ch.mensualidadesDe('2026-09-10').paneles.find((p) => p.panel === 'ZZ-Panel-Chat').aviso.ok === false);
    ch.marcarAvisoMens(CLI.id, 'ZZ-Panel-Chat', '2026-09-10', { ok: true });
    check('chat: el reintento que sale bien pisa al que falló, y sólo para esa caja',
      ch.mensualidadesDe('2026-09-10').paneles.find((p) => p.panel === 'ZZ-Panel-Chat').aviso.ok === true
      && !ch.avisosMensDe('2026-09-11')['ZZ-Panel-Chat']);
    dbCh.prepare('DELETE FROM chat_aviso_mens WHERE cliente_id=?').run(CLI.id);
    dbCh.prepare("DELETE FROM chat_mov WHERE tipo='mensualidad'").run();
    /* El acumulado tiene que BAJAR el nivel del agente, no sólo el de arriba: si no, la ganancia
       de una caja de agente no existe en la base y su mes da cero. */
    const acumCh = require('../src/acumulado.service');
    check('chat: el acumulado nocturno baja también el nivel de los agentes',
      require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'acumulado.service.js'), 'utf8')
        .includes("'superagent,distributor,agent'") && typeof acumCh.startCron === 'function');

    check('chat: la mensualidad se cobra el día de CADA panel, no a fin de mes',
      m10.paneles.length === 1 && m11.paneles.length === 0,
      'el 10 toca, el 11 no');
    check('chat: la mensualidad es la misma para todos y sale de la configuración',
      m10.monto === '30' && m10.moneda === 'USDT');
    // Entre 1 y 28 para que el día exista en todos los meses, febrero incluido.
    /* ── LA FECHA DE INICIO MANDA ────────────────────────────────────────────────────────────
       Si contrató el 20, se le cobra el 20 de cada mes y el período va del 20 al 19. Pedir la fecha
       y además el día era pedir dos veces el mismo dato, y el día que no coincidieran nadie sabría
       cuál manda. */
    /* La primera vez el día se completa solo con el de la fecha —el mantenimiento se cobra el día
       que arranca— pero si ya hay un día puesto, corregir la fecha no lo pisa: son dos datos. */
    ch.set({ panel_id: PAN.id, dia_cobro: '' });
    const rDesde = ch.set({ panel_id: PAN.id, desde: '2026-08-20' });
    check('chat: la primera vez, el día se completa con el de la fecha de inicio',
      rDesde.ok && rDesde.panel.dia_cobro === 20 && rDesde.panel.desde === '2026-08-20');
    check('chat: pero después la fecha ya no le pisa el día',
      ch.set({ panel_id: PAN.id, desde: '2026-08-05' }).panel.dia_cobro === 20,
      'eran dos datos mezclados en uno y no se sabía cuál mandaba');
    check('chat: el período va de fecha a fecha, no del 1 al 30',
      ch.periodoDesde('2026-08-20').texto === '20 ago – 19 sep');
    // Quien contrató un 31 se le cobra el 28: el día tiene que existir en todos los meses.
    ch.set({ panel_id: PAN.id, dia_cobro: '' });
    check('chat: una fecha 31 se recorta al 28',
      ch.set({ panel_id: PAN.id, desde: '2026-01-31' }).panel.dia_cobro === 28);
    check('chat: no se le cobra la mensualidad antes de que empiece',
      ch.cobrarMensualidad({ cliente_id: CLI.id, panel: 'ZZ-Panel-Chat', fecha: '2025-12-01' }).ok === false);
    /* Y tampoco APARECE en la lista de ese día. Faltaba: la lista salía igual y el botón invitaba a
       cobrarle un mes que la caja todavía no había tenido. */
    ch.set({ panel_id: PAN.id, dia_cobro: '' });
    ch.set({ panel_id: PAN.id, desde: '2026-08-20' });
    check('chat: antes de arrancar, la caja no figura en las mensualidades del día',
      ch.mensualidadesDe('2026-07-20').paneles.every((x) => x.panel !== 'ZZ-Panel-Chat')
      && ch.mensualidadesDe('2026-08-20').paneles.some((x) => x.panel === 'ZZ-Panel-Chat'),
      'el 20 de julio no, el 20 de agosto sí');
    ch.set({ panel_id: PAN.id, desde: '', dia_cobro: 10 });

    check('chat: no se puede poner un día que no existe en todos los meses',
      ch.set({ panel_id: PAN.id, dia_cobro: 31 }).ok === false
      && ch.set({ panel_id: PAN.id, dia_cobro: 28 }).ok === true);
    /* Y el mantenimiento se cobra POR ADELANTADO EL DÍA DEL ALTA, aunque el día de cobro sea otro:
       si no, una caja que arrancó el 25 con día de cobro 20 no pagaba nada hasta el mes siguiente. */
    dbCh.prepare("DELETE FROM chat_mov WHERE tipo='mensualidad'").run();
    ch.set({ panel_id: PAN.id, desde: '2026-08-25', dia_cobro: 20 });
    ch.devengarMensualidades('2026-08-27');
    const mAd = (ch.cuentas(null).clientes.find((x) => x.cliente_id === CLI.id) || { movs: [] })
      .movs.filter((m) => m.tipo === 'mensualidad');
    check('chat: el mantenimiento se cobra por adelantado el día que arranca',
      mAd.some((m) => m.fecha === '2026-08-25'),
      mAd.map((m) => m.fecha).join(' ') || 'ninguna');
    dbCh.prepare("DELETE FROM chat_mov WHERE tipo='mensualidad'").run();
    ch.set({ panel_id: PAN.id, dia_cobro: '' });

    /* ── EL MANTENIMIENTO SE DEVENGA SOLO ────────────────────────────────────────────────────
       Se paga por TENER el servicio, así que apenas arranca el período ya es plata que debe.
       Esperar a que alguien apretara un botón hacía que el cliente entrara a su portal y viera
       "estás al día" debiendo un mes — y que después le aparecieran tres juntas de golpe. */
    dbCh.prepare("DELETE FROM chat_mov WHERE tipo='mensualidad'").run();
    ch.set({ panel_id: PAN.id, dia_cobro: '' });
    ch.set({ panel_id: PAN.id, desde: '2026-08-20' });
    const dev1 = ch.devengarMensualidades('2026-08-19');
    check('chat: el día antes de arrancar todavía no debe nada',
      !ch.cuentas('2026-08').clientes.some((x) => x.cliente_id === CLI.id
        && x.movs.some((m) => m.tipo === 'mensualidad')),
      JSON.stringify(dev1));
    ch.devengarMensualidades('2026-08-20');
    const conMens = ch.cuentas(null).clientes.find((x) => x.cliente_id === CLI.id) || { movs: [] };
    check('chat: el día que arranca ya le aparece en lo que debe, sin apretar nada',
      conMens.movs.some((m) => m.tipo === 'mensualidad' && m.fecha === '2026-08-20'),
      'antes había que cobrarla a mano y hasta entonces el portal decía "estás al día"');
    const antes = ch.cuentas(null).clientes.find((x) => x.cliente_id === CLI.id).debe;
    ch.devengarMensualidades('2026-08-21');
    check('chat: pasarlo de nuevo no cobra dos veces',
      ch.cuentas(null).clientes.find((x) => x.cliente_id === CLI.id).debe === antes);
    ch.devengarMensualidades('2026-11-25');
    const tres = ch.cuentas(null).clientes.find((x) => x.cliente_id === CLI.id).movs
      .filter((m) => m.tipo === 'mensualidad');
    check('chat: si el proceso estuvo caído, se pone al día con los meses que faltan',
      tres.length === 4 && tres.map((m) => m.fecha).join(' ') === '2026-08-20 2026-09-20 2026-10-20 2026-11-20',
      tres.map((m) => m.fecha).join(' '));
    check('chat: y cada uno con su período de fecha a fecha',
      /20 ago – 19 sep/.test(tres[0].nota) && /20 nov – 19 dic/.test(tres[3].nota),
      tres[0].nota);
    dbCh.prepare("DELETE FROM chat_mov WHERE tipo='mensualidad'").run();
    ch.set({ panel_id: PAN.id, desde: '', dia_cobro: 28 });

    /* Tocar el precio no puede borrar el día de cobro: son dos pantallas distintas y el que guarda
       el % no está pensando en la mensualidad. Lo que no se manda, queda como estaba. */
    ch.set({ panel_id: PAN.id, pct_cliente: '5' });
    check('chat: guardar sólo el precio no borra el día de la mensualidad',
      ch.list().find((x) => x.panel_id === PAN.id).dia_cobro === 28);

    /* ── LA CUENTA SE LE MANDA AL CLIENTE, NO AL PANEL ────────────────────────────────────────
       Uno con dos paneles paga UNA cuenta con dos renglones. Antes de esto la pantalla mostraba
       dos filas sueltas y no había forma de saber cuánto le tocaba pagar al cliente. */
    dbCh.prepare('UPDATE reporte_diario SET profit=? WHERE conexion_id=?').run('100000', 'cx_zz');
    ch.set({ panel_id: PAN.id, pct_cliente: '4', dia_cobro: 28 });
    const PAN2 = panSt.create({ cliente_id: CLI.id, nombre: 'ZZ-Panel-Chat-2', sistema: 'Europa',
      nivel_usuario: 'SuperAgente', id_usuario: '9990002', conexion_id: 'cx_zz', divisas: ['ARS'] });
    ['2026-08-01', '2026-08-02'].forEach((f, i) => insDia.run('zzrdb' + i, 'cx_zz', f, '9990002',
      'ZZ-Panel-Chat-2', '1000', '900', '50000', 'ARS', new Date().toISOString()));
    ch.set({ panel_id: PAN2.id, pct_cliente: '4' });
    const pcZ = ch.porCliente('2026-08');
    const gZ = (pcZ.clientes || []).find((x) => x.cliente_id === CLI.id);
    check('chat: los paneles de un cliente se juntan en UNA cuenta',
      !!gZ && gZ.paneles.length === 2 && moneyCh.cmp(gZ.cobra, '0') > 0,
      gZ ? `${gZ.paneles.length} paneles · cobra ${gZ.cobra}` : 'no agrupó');
    // 200.000 + 100.000 en la misma moneda van en UN renglón, no dos: es lo que el cliente compara
    // contra su propio panel.
    check('chat: la ganancia en la misma moneda se suma en un solo renglón',
      !!gZ && gZ.monedas.length === 1 && gZ.monedas[0].moneda === 'ARS'
      && Number(gZ.monedas[0].profit) === 300000,
      gZ ? gZ.monedas.map((m) => m.moneda + '=' + m.profit).join(',') : '');

    /* ── VARIOS CHATS POR CLIENTE, CADA UNO COLGADO DE UN AGENTE ─────────────────────────────
       Fran tiene dos chats y Ariel cuatro. Cada uno se cobra sobre lo que ganó SU agente, así que
       la ganancia se lee EN EL NIVEL DEL PANEL. Leer todo como 'superagent' —como se hacía— daba
       cero para cualquier caja que no fuera la de más arriba: una factura de menos, sin aviso. */
    const AG = panSt.create({ cliente_id: CLI.id, nombre: 'ZZ-Agente-Chat', sistema: 'Europa',
      nivel_usuario: 'Agente', id_usuario: '9990003', conexion_id: 'cx_zz', divisas: ['ARS'] });
    // ⚠️ `insDia` graba a nivel superagente. Las filas del AGENTE van con su propio grp: es
    // justamente lo que se está probando.
    const insAg = dbCh.prepare(`INSERT INTO reporte_diario (id,conexion_id,fecha,grp,sa_id,login,in_amt,out_amt,profit,moneda,captured_at)
      VALUES (?,?,?,'agent',?,?,?,?,?,?,?)`);
    ['2026-08-01', '2026-08-02'].forEach((f, i) => insAg.run('zzrdag' + i, 'cx_zz', f, '9990003',
      'ZZ-Agente-Chat', '500', '400', '40000', 'ARS', new Date().toISOString()));
    // La MISMA fila a nivel superagente, con otro número: si se mezclaran, la caja se cobraría mal.
    const insSA = dbCh.prepare(`INSERT INTO reporte_diario (id,conexion_id,fecha,grp,sa_id,login,in_amt,out_amt,profit,moneda,captured_at)
      VALUES (?,?,?,'superagent',?,?,?,?,?,?,?)`);
    insSA.run('zzrdsa9', 'cx_zz', '2026-08-01', '9990003', 'ZZ-Agente-Chat', '1', '1', '999999', 'ARS', new Date().toISOString());
    ch.set({ panel_id: AG.id, pct_cliente: '3', dia_cobro: 15 });
    const ciAg = ch.cierre('2026-08');
    const fAg = ciAg.filas.find((x) => x.panel === 'ZZ-Agente-Chat');
    check('chat: un chat colgado de un agente se cobra sobre la ganancia DE ESE AGENTE',
      !!fAg && Number((fAg.detalle.find((d) => d.moneda === 'ARS') || {}).profit) === 80000,
      fAg ? `${(fAg.detalle[0] || {}).profit} (la del superagente es 999.999 y no se usa)` : 'no apareció');
    const gFran = ch.porCliente('2026-08').clientes.find((x) => x.cliente_id === CLI.id);
    check('chat: un cliente con varios chats los ve juntos en una sola cuenta',
      !!gFran && gFran.paneles.length === 3,
      gFran ? gFran.paneles.map((x) => x.panel).join(' + ') : '');
    /* Una caja sin NINGUNA fila en su nivel no es una caja sin ganancias: es una caja que el
       acumulado no está bajando. Cobrar cero sería regalar el mes en silencio. */
    const SIN = panSt.create({ cliente_id: CLI.id, nombre: 'ZZ-Agente-SinDatos', sistema: 'Europa',
      nivel_usuario: 'Agente', id_usuario: '9990004', conexion_id: 'cx_zz', divisas: ['ARS'] });
    ch.set({ panel_id: SIN.id, pct_cliente: '3' });
    /* Y el aviso dice CUÁL de los dos problemas es, porque se arreglan distinto: si el mes de ese
       nivel no se bajó, hay que capturar; si el mes está y la caja no figura, capturar de nuevo no
       cambia nada — el número de usuario no es el que el casino reporta. */
    {
      const SIN = panSt.create({ cliente_id: CLI.id, nombre: 'ZZ-Falta', sistema: 'Europa',
        nivel_usuario: 'SuperAgente', id_usuario: '9998888', conexion_id: 'cx_zz', divisas: ['ARS'] });
      ch.set({ panel_id: SIN.id, pct_cliente: '4' });
      const sal = (ch.cierre('2026-08').salteados || []).find((x) => x.panel === 'ZZ-Falta');
      check('chat: si el mes SÍ está bajado, el aviso apunta al número de usuario',
        !!sal && /no figura con el usuario 9998888/.test(sal.motivo) && sal.capturar === false,
        sal ? sal.motivo.slice(0, 70) : 'no salteó');
      const SIN2 = panSt.create({ cliente_id: CLI.id, nombre: 'ZZ-SinMes', sistema: 'Europa',
        nivel_usuario: 'Distribuidor', id_usuario: '9998889', conexion_id: 'cx_zz', divisas: ['ARS'] });
      ch.set({ panel_id: SIN2.id, pct_cliente: '4' });
      const sal2 = (ch.cierre('2026-08').salteados || []).find((x) => x.panel === 'ZZ-SinMes');
      check('chat: si NO se bajó ese nivel, el aviso manda a capturar el mes',
        !!sal2 && /todavía no se bajó el nivel Distribuidor/.test(sal2.motivo) && sal2.capturar === true,
        sal2 ? sal2.motivo.slice(0, 70) : 'no salteó');
      ch.quitar(SIN.id); panSt.remove(SIN.id);
      ch.quitar(SIN2.id); panSt.remove(SIN2.id);
    }
    check('chat: una caja de la que no hay datos se nombra, no se cobra en cero',
      (ch.cierre('2026-08').salteados || []).some((x) => x.panel === 'ZZ-Agente-SinDatos'),
      JSON.stringify(ch.cierre('2026-08').salteados));
    ch.quitar(SIN.id); panSt.remove(SIN.id);
    ch.quitar(AG.id); panSt.remove(AG.id);
    dbCh.prepare("DELETE FROM reporte_diario WHERE sa_id='9990003'").run();

    /* ── LOS DOS LINKS DE CADA CAJA ──────────────────────────────────────────────────────────
       Cada caja tiene un link para los jugadores y otro para el panel. NO se deducen del nombre ni
       del dominio de otra caja: hay muchos dominios y no hay relación entre la cuenta y el que le
       toca. Un link mal armado se descubre después de habérselo mandado a toda la gente. */
    check('chat: un link que no es un link no entra',
      ch.set({ panel_id: PAN.id, link_jugadores: 'preguntale a Fran' }).ok === false);
    const rL = ch.set({ panel_id: PAN.id, link_jugadores: 'juegan.ganamos.vip',
      link_panel: 'https://admin.ganamos.vip/login', usuario_admin: 'ZZadm' });
    check('chat: los links se guardan como se pegaron, con https si falta',
      rL.ok && rL.panel.link_jugadores === 'https://juegan.ganamos.vip'
      && rL.panel.link_panel === 'https://admin.ganamos.vip/login');
    check('chat: tocar el precio no borra los links de la caja',
      ch.set({ panel_id: PAN.id, pct_cliente: '4' }).panel.link_panel === 'https://admin.ganamos.vip/login');
    // El cliente los ve en su portal; la contraseña NO viaja, porque al portal se entra sin clave.
    const portZ = ch.portalDe(CLI.id);
    const cajaZ = (portZ.cajas || []).find((x) => x.caja === 'ZZ-Panel-Chat');
    check('chat: el cliente ve los links de su caja en el portal',
      !!cajaZ && cajaZ.link_jugadores === 'https://juegan.ganamos.vip'
      && cajaZ.usuario_admin === 'ZZadm');
    /* LA CONTRASEÑA DEL PANEL SÍ SE GUARDA —hay clientes con muchas cuentas y no se acuerdan cuál va
       con cuál— pero NO viaja al portal hasta que el cliente escribe la clave que vos le diste. Al
       portal se entra con el nombre de una caja y nada más: dejarla del otro lado de esa puerta
       sería regalarle el panel a cualquiera que adivine un nombre. */
    ch.set({ panel_id: PAN.id, clave_admin: 'ZZsecreta777' });
    check('chat: la contraseña del panel NO está en lo que el portal le manda al cliente',
      !JSON.stringify(ch.portalDe(CLI.id)).includes('ZZsecreta777'),
      'sólo viaja el usuario, que solo no abre nada');
    check('chat: sin clave cargada, los accesos no se muestran ni pidiéndolos',
      ch.accesosDe(CLI.id, '').ok === false && ch.accesosDe(CLI.id, 'loquesea').ok === false);
    check('chat: una clave demasiado corta no se puede poner',
      ch.setDestino({ cliente_id: CLI.id, clave_portal: 'abc' }).ok === false);
    ch.setDestino({ cliente_id: CLI.id, clave_portal: 'ZZclave2026' });
    check('chat: con la clave equivocada tampoco',
      ch.accesosDe(CLI.id, 'otra').ok === false
      && !JSON.stringify(ch.accesosDe(CLI.id, 'otra')).includes('ZZsecreta777'));
    const acc = ch.accesosDe(CLI.id, 'ZZclave2026');
    check('chat: con la clave, el cliente ve la contraseña de cada caja',
      acc.ok && acc.cajas.some((x) => x.caja === 'ZZ-Panel-Chat' && x.clave === 'ZZsecreta777'),
      JSON.stringify((acc.cajas || []).map((x) => x.caja)));
    ch.set({ panel_id: PAN.id, clave_admin: '' });
    ch.setDestino({ cliente_id: CLI.id, clave_portal: '' });

    /* ── LO QUE EL CLIENTE NO PUEDE VER NO ENTRA AL DOCUMENTO ─────────────────────────────────
       No se filtra al imprimir: no está en el objeto. Si mañana alguien agrega una columna al
       HTML, no tiene de dónde sacar el costo. */
    const chDoc = require('../src/chat-doc');
    const docCli = chDoc.paraCliente(gZ, { mes: '2026-08' });
    const crudoCli = JSON.stringify(docCli);
    check('chat: la hoja del cliente no lleva el costo, ni el margen, ni lo que pagás',
      !/paga|margen|costo|pct_costo|pierde/i.test(crudoCli),
      crudoCli.slice(0, 120));
    const htmlCli = chDoc.htmlCliente(docCli);
    check('chat: la hoja del cliente dice su ganancia, su % y lo que tiene que pagar',
      htmlCli.includes('Tu ganancia de agosto de 2026') && htmlCli.includes('Total a pagar')
      && htmlCli.includes('4%') && htmlCli.includes('ARS'));
    // El tipo de cambio va SIEMPRE: el 2% de pesos y el 2% de dólares no se parecen, y sin el TC
    // la cuenta no se puede rehacer con una calculadora.
    check('chat: la hoja del cliente muestra el tipo de cambio usado',
      /÷\s*1\.000/.test(htmlCli), htmlCli.slice(htmlCli.indexOf('ARS'), htmlCli.indexOf('ARS') + 160).replace(/\s+/g, ' '));

    const docProv = chDoc.paraProveedor(pcZ, { mes: '2026-08' });
    check('chat: la hoja del proveedor no dice qué le cobrás a cada cliente',
      !/pct_cliente|cobra/i.test(JSON.stringify(docProv)));
    check('chat: la hoja del proveedor cobra el costo, no el precio del cliente',
      docProv.pct === '2' && moneyCh.cmp(docProv.total, '0') > 0,
      `${docProv.pct}% · ${docProv.total} USDT`);

    /* ── EL LINK ─────────────────────────────────────────────────────────────────────────────
       Guarda la hoja YA PROYECTADA: lo que el cliente abre es lo que viste vos, aunque después
       cambie un tipo de cambio. Y el prefijo impide que un token de factura abra esta hoja. */
    const lk = chDoc.crearLink(docCli, CLI.id);
    const leido = chDoc.porToken(lk.token);
    check('chat: el link guarda la hoja congelada, no la manera de rehacerla',
      !!leido && leido.doc.total === docCli.total && !/paga|margen/i.test(JSON.stringify(leido.doc)),
      lk.token.slice(0, 8) + '…');
    check('chat: mandar dos veces no cambia el link que ya tiene el cliente',
      chDoc.crearLink(docCli, CLI.id).token === lk.token);
    const otroTok = require('../src/factura.service');
    check('chat: un token que no es del chat no abre la hoja del chat',
      chDoc.porToken('no-existe-este-token') === null && typeof otroTok.porToken === 'function');

    /* ── A DÓNDE SE MANDA ────────────────────────────────────────────────────────────────────
       Grupo propio de este servicio: el de las fichas es otro y tiene otra gente adentro. */
    ch.setDestino({ cliente_id: CLI.id, tg_grupo: '-1001234567890', enviar_a: 'a Raúl por privado' });
    check('chat: el grupo de este servicio es propio y no pisa el de las fichas',
      ch.destino(CLI.id).tg_grupo === '-1001234567890'
      && !(cliSt3.list().clientes.find((x) => x.id === CLI.id).telegram || {}).chatId,
      'chat: -100123… · fichas: (vacío)');
    check('chat: guardar la nota no borra el grupo',
      ch.setDestino({ cliente_id: CLI.id, enviar_a: 'otra nota' }).ok === true
      && ch.destino(CLI.id).tg_grupo === '-1001234567890');
    check('chat: avisa cuando eso no parece un grupo de Telegram',
      !!ch.setDestino({ cliente_id: CLI.id, tg_grupo: 'https://t.me/grupo' }).aviso);
    /* MÁS DE UN GRUPO: a veces el encargado tiene que enterarse y no está en el grupo del cliente.
       Se guardan separados por coma y se manda a todos. */
    ch.setDestino({ cliente_id: CLI.id, tg_grupo: '-1001234567890, -1009876543210' });
    check('chat: se le puede mandar a más de un grupo',
      ch.destino(CLI.id).grupos.length === 2
      && ch.destino(CLI.id).grupos[1] === '-1009876543210',
      ch.destino(CLI.id).grupos.join(' + '));
    check('chat: los grupos se separan igual con coma, con espacio o con renglón',
      ch.partirGrupos('-1001\n-1002, -1003  -1004').length === 4);
    check('chat: entre varios, avisa cuál es el que está mal',
      (ch.setDestino({ cliente_id: CLI.id, tg_grupo: '-1001234567890, pepe' }).aviso || '').includes('pepe'));
    ch.setDestino({ cliente_id: CLI.id, tg_grupo: '-1001234567890' });
    // Un cliente que todavía no facturó nada tiene que poder tener grupo cargado igual.
    check('chat: los destinos se pueden ver sin pasar por el cierre del mes',
      !!ch.destinos()[CLI.id] && ch.destinos()[CLI.id].grupos.length === 1);

    /* ── EL BOT DE ESTE SERVICIO ES OTRO ─────────────────────────────────────────────────────
       Y el token no sale nunca en una respuesta: un token que se lee de la pantalla es un token
       que se copia de una foto de la pantalla. */
    check('chat: un token que no tiene forma de token no entra',
      ch.setConfig({ bot_token: 'https://t.me/mibot' }).ok === false);
    ch.setConfig({ bot_token: '123456789:AAFtesttesttesttesttesttesttesttest' });
    const cfgBot = ch.config();
    check('chat: el token del bot no se devuelve nunca, sólo sus últimos dígitos',
      !JSON.stringify(cfgBot).includes('AAFtest') && cfgBot.bot_propio === true
      && cfgBot.bot_hint === '…sttest',
      JSON.stringify(cfgBot.bot_hint));
    check('chat: el bot propio se usa en vez del general',
      ch.botToken() === '123456789:AAFtesttesttesttesttesttesttesttest');
    ch.setConfig({ bot_token: '' });

    /* ── LA CUENTA DEL CHAT ES OTRA CUENTA ───────────────────────────────────────────────────
       Esta plata no es toda de ella: la mitad se le paga al proveedor del servicio, se cobra en
       otra wallet y se habla en otro grupo. Si entrara en `movimientos`, su cierre del mes
       mostraría un ingreso que en realidad es de otro. Textual: «no quiero que en mi cuenta de mes
       salga algo así como que recibí ese monto». */
    const emiCh = require('../src/emision.service');
    const deudaCh = require('../src/deuda.service');
    check('chat: NO se puede emitir el chat contra la cuenta de las fichas',
      emiCh.emitir({ mes: '2026-08', origen: 'chat', lineas: [] }).ok === false
      && emiCh.ORIGENES.chat === undefined,
      'origen "chat" no existe en las emisiones, a propósito');
    const antesCC = deudaCh.cuentaCorriente(CLI.id).total;
    const co1 = ch.cobrar('2026-08');
    const co2 = ch.cobrar('2026-08');
    check('chat: cobrar dos veces el mismo mes no cobra dos veces',
      co1.ok && co1.creados >= 1 && co2.ok && co2.creados === 0 && co2.yaEstaban === co1.creados,
      `1ª vez ${co1.creados} · 2ª vez ${co2.creados} (${co2.yaEstaban} ya estaban)`);
    check('chat: cobrar el chat NO mueve la cuenta corriente de las fichas',
      deudaCh.cuentaCorriente(CLI.id).total === antesCC
      && dbCh.prepare("SELECT COUNT(*) n FROM movimientos WHERE origen='chat'").get().n === 0,
      `saldo de fichas antes ${antesCC} · después ${deudaCh.cuentaCorriente(CLI.id).total}`);
    const ctaZ = ch.cuentas('2026-08');
    const gCta = ctaZ.clientes.find((x) => x.cliente_id === CLI.id);
    check('chat: lo cobrado queda en la cuenta DEL CHAT',
      !!gCta && moneyCh.cmp(gCta.cobrado, '0') > 0 && gCta.debe === gCta.cobrado,
      gCta ? `cobrado ${gCta.cobrado} · debe ${gCta.debe}` : 'sin fila');
    // Lo cobrado se congela: aunque cambie el tipo de cambio, lo que le mandaste no se mueve.
    dbCh.prepare("UPDATE tc_mes SET tc_cliente='2000' WHERE mes='2026-08'").run();
    check('chat: lo cobrado no cambia si después cambia el tipo de cambio',
      ch.cuentas('2026-08').clientes.find((x) => x.cliente_id === CLI.id).cobrado === gCta.cobrado,
      'sigue en ' + gCta.cobrado);
    dbCh.prepare("UPDATE tc_mes SET tc_cliente='1000' WHERE mes='2026-08'").run();
    // El pago del cliente por el chat va a esta cuenta, no a la de las fichas.
    const pgC = ch.pagarCliente({ cliente_id: CLI.id, mes: '2026-08', monto: '10', nota: 'wallet del chat' });
    check('chat: el pago del cliente baja lo que debe en la cuenta del chat',
      pgC.ok
      && ch.cuentas('2026-08').clientes.find((x) => x.cliente_id === CLI.id).debe
         === moneyCh.round(moneyCh.sub(gCta.cobrado, '10'), 2)
      && deudaCh.cuentaCorriente(CLI.id).total === antesCC,
      'y la cuenta de fichas sigue igual');
    check('chat: un pago mal cargado no entra',
      ch.pagarCliente({ cliente_id: CLI.id, mes: '2026-08', monto: '246,93' }).ok === false
      && ch.pagarCliente({ cliente_id: CLI.id, mes: '2026-08', monto: '0' }).ok === false);
    /* Deshacer va POR CLIENTE: arreglar el precio de uno no tiene por qué tocar a los demás.
       Sirve porque cobrar CONGELA y el índice único no deja cobrar dos veces encima: sin esto, un
       mes cobrado con un precio o un tipo de cambio que faltaba quedaba mal para siempre. */
    const otroC = cliSt3.createCliente({ codigo: 'ZZ-OTRO2', nombre: 'Otro más' });
    const otroP = panSt.create({ cliente_id: otroC.id, nombre: 'ZZ-Otro-Caja', sistema: 'Casino',
      nivel_usuario: 'SuperAgente', id_usuario: '9990001', conexion_id: 'cx_zz', divisas: ['ARS'] });
    ch.set({ panel_id: otroP.id, pct_cliente: '4' });
    ch.cobrar('2026-08');
    const antesOtro = (ch.cuentas('2026-08').clientes.find((x) => x.cliente_id === otroC.id) || {}).cobrado;
    ch.descobrar('2026-08', CLI.id);
    check('chat: deshacer el cobro de uno no toca el de los demás',
      !ch.cuentas('2026-08').clientes.some((x) => x.cliente_id === CLI.id && Number(x.cobrado) > 0)
      && (ch.cuentas('2026-08').clientes.find((x) => x.cliente_id === otroC.id) || {}).cobrado === antesOtro,
      `el otro sigue en ${antesOtro}`);
    check('chat: y después de arreglarlo se puede volver a cobrar',
      ch.cobrar('2026-08').creados === 1);
    ch.quitar(otroP.id); panSt.remove(otroP.id);
    dbCh.prepare('DELETE FROM chat_mov WHERE cliente_id=?').run(otroC.id);
    cliSt3.removeCliente(otroC.id);

    // Deshacer el cobro no borra los pagos: ésos pasaron de verdad.
    const desc = ch.descobrar('2026-08');
    check('chat: deshacer el cobro no borra los pagos que ya te hicieron',
      desc.ok && desc.borrados === co1.creados
      && ch.cuentas('2026-08').clientes.find((x) => x.cliente_id === CLI.id).pagado === '10',
      `borrados ${desc.borrados} cobros, el pago sigue`);
    ch.borrarMov(pgC.mov.id);
    /* El arrastre importa: alguien puede deber tres meses y eso no se ve mirando uno solo. */
    ch.pagarCliente({ cliente_id: CLI.id, mes: '2026-07', monto: '5' });
    check('chat: la cuenta sin mes muestra todo lo que arrastra',
      ch.cuentas(null).clientes.find((x) => x.cliente_id === CLI.id).pagado === '5'
      && !ch.cuentas('2026-08').clientes.some((x) => x.cliente_id === CLI.id));
    dbCh.prepare('DELETE FROM chat_mov WHERE cliente_id=?').run(CLI.id);

    /* Cómo se paga ESTE servicio va en la hoja: es otra wallet que la de las fichas y sin eso la
       hoja dice cuánto pagar y no dice adónde. La RED va en su propio campo: mandar USDT por la red
       equivocada es perder la plata, y el que copia una línea entera se lleva la red adentro de la
       dirección. */
    check('chat: una dirección con espacios no entra (la red va aparte)',
      ch.guardarWallet({ red: 'TRC20', direccion: 'TXwallet123 TRC20' }).ok === false);
    check('chat: una wallet sin red no entra',
      ch.guardarWallet({ direccion: 'TXwallet123' }).ok === false);
    const wA = ch.guardarWallet({ alias: 'Binance', red: 'trc20', direccion: 'TXwallet123' }).wallet;
    const wB = ch.guardarWallet({ alias: 'BSC', red: 'bep20', direccion: '0xwallet456' }).wallet;
    check('chat: la red se guarda aparte y en mayúsculas',
      wA.direccion === 'TXwallet123' && wA.red === 'TRC20' && ch.wallets().length >= 2);
    ch.setConfig({ wallet_ggr: wA.id, wallet_mens: wB.id, pago_nota: 'mandá el hash' });
    check('chat: cada cosa se paga a la wallet que elegiste',
      ch.walletDe(null, 'ggr').alias === 'Binance' && ch.walletDe(null, 'mens').alias === 'BSC');
    /* Y un cliente puede tener otra distinta: a uno se le manda una y a otro otra. */
    ch.setDestino({ cliente_id: CLI.id, wallet_ggr: wB.id });
    check('chat: un cliente puede pagar a una wallet distinta de la de siempre',
      ch.walletDe(CLI.id, 'ggr').alias === 'BSC' && ch.walletDe(null, 'ggr').alias === 'Binance');
    check('chat: volver a "la de siempre" es dejarla vacía',
      ch.setDestino({ cliente_id: CLI.id, wallet_ggr: '' }).ok
      && ch.walletDe(CLI.id, 'ggr').alias === 'Binance');
    check('chat: no se puede elegir una wallet que no existe',
      ch.setDestino({ cliente_id: CLI.id, wallet_ggr: 'chw_noexiste' }).ok === false
      && ch.setConfig({ wallet_ggr: 'chw_noexiste' }).ok === false);
    /* Borrar una wallet en uso dejaría al cliente sin adónde pagar y nadie se enteraría hasta que
       preguntara. Se apaga, que deja de ofrecerse y no rompe nada. */
    check('chat: una wallet en uso no se borra, se apaga',
      ch.borrarWallet(wA.id).ok === false);
    ch.guardarWallet({ ...wA, activa: false });
    check('chat: una wallet apagada no se reemplaza sola por otra',
      !ch.wallets().find((w) => w.id === wA.id).activa
      && ch.walletDe(null, 'ggr') === null
      && ch.walletsApagadasEnUso().some((x) => x.wallet === 'Binance'),
      'devuelve nada y lo avisa, en vez de mandarle al cliente a otra dirección sin que nadie lo decida');
    ch.guardarWallet({ ...wA, activa: true });
    const pagoCfg = ch.comoPagar(CLI.id);
    const htmlPago = chDoc.htmlCliente(chDoc.paraCliente(gZ, { mes: '2026-08' }), { pago: pagoCfg });
    check('chat: la hoja del cliente dice adónde pagar, con la red aparte y botón de copiar',
      htmlPago.includes('TXwallet123') && htmlPago.includes('Cómo pagar')
      && /Red <b>TRC20<\/b>/.test(htmlPago) && /Copiar la dirección/.test(htmlPago)
      && /function copiar/.test(htmlPago));
    // Dos wallets distintas → dos bloques rotulados; la misma para las dos → uno solo.
    check('chat: si el mes y el mantenimiento van a wallets distintas, se muestran las dos',
      /Servicio del mes/.test(htmlPago) && /Mantenimiento/.test(htmlPago)
      && htmlPago.includes('0xwallet456'));
    ch.setConfig({ wallet_mens: wA.id });
    const htmlUna = chDoc.htmlCliente(chDoc.paraCliente(gZ, { mes: '2026-08' }), { pago: ch.comoPagar(CLI.id) });
    check('chat: si es la misma wallet para las dos cosas, va un bloque solo',
      (htmlUna.match(/class="paga"/g) || []).length === 1 && !/Servicio del mes/.test(htmlUna));
    ch.setConfig({ wallet_mens: wB.id });
    // El plan B importa: fuera de https `navigator.clipboard` no existe y el botón no haría nada.
    check('chat: copiar funciona aunque no haya https',
      /execCommand\('copy'\)/.test(htmlPago));
    check('chat: sin wallet cargada la hoja no inventa un "cómo pagar" vacío',
      !chDoc.htmlCliente(chDoc.paraCliente(gZ, { mes: '2026-08' }), {}).includes('Cómo pagar'));

    /* ── MÁS DE UNA WALLET PARA LA MISMA COSA ────────────────────────────────────────────────
       El mantenimiento se cobra por TRC20 y por BEP20 y la red la elige el cliente. Lo que se
       guarda es una lista en el mismo campo; con un id solo el valor queda idéntico al de antes,
       que es lo que hace que no haya nada que migrar. */
    check('chat: se pueden ofrecer las dos redes para el mantenimiento',
      ch.setConfig({ wallet_mens: `${wA.id}, ${wB.id}` }).ok
      && ch.walletsDe(null, 'mens').length === 2);
    check('chat: con una sola elegida se guarda y se lee igual que antes',
      ch.setConfig({ wallet_ggr: wA.id }).ok && ch.config().wallet_ggr === wA.id
      && ch.walletDe(null, 'ggr').alias === 'Binance',
      'el valor guardado sigue siendo el id pelado: nada que migrar');
    check('chat: si una de la lista no existe, no se guarda ninguna',
      ch.setConfig({ wallet_mens: `${wA.id}, chw_noexiste` }).ok === false
      && ch.config().wallets_mens.length === 2,
      'media lista guardada es peor que ninguna');
    const htmlDos = chDoc.htmlCliente(chDoc.paraCliente(gZ, { mes: '2026-08' }), { pago: ch.comoPagar(CLI.id) });
    check('chat: la hoja muestra las dos direcciones del mantenimiento, cada una con su red',
      htmlDos.includes('TXwallet123') && htmlDos.includes('0xwallet456')
      && /Red <b>TRC20<\/b>/.test(htmlDos) && /Red <b>BEP20<\/b>/.test(htmlDos));
    /* ⚠️ copiar() busca por getElementById: dos bloques con el mismo id hacen que el segundo botón
       copie la PRIMERA dirección. El cliente manda por la red equivocada y esa plata no vuelve. */
    const idsDir = htmlDos.match(/id="dir\d+"/g) || [];
    check('chat: cada dirección tiene su propio id, o el botón copia la equivocada',
      idsDir.length >= 2 && new Set(idsDir).size === idsDir.length
      && (htmlDos.match(/class="copiar"/g) || []).length === idsDir.length,
      `${idsDir.length} direcciones, ${new Set(idsDir).size} ids distintos`);
    check('chat: cuando hay dos redes para lo mismo, se dice por qué',
      /Mandá por la red que uses/.test(htmlDos),
      'sin esto se leen como dos cuentas distintas y la pregunta vuelve por privado');
    check('chat: la segunda de la lista tampoco se puede borrar',
      ch.borrarWallet(wB.id).ok === false);
    /* El chequeo de "en uso" no puede ser por substring: «chw_ab» está adentro de «chw_ab1». */
    const wPref = ch.guardarWallet({ id: 'chw_zz', alias: 'Corta', red: 'TRC20', direccion: 'Tcorta1' }).wallet;
    const wLarga = ch.guardarWallet({ id: 'chw_zz9', alias: 'Larga', red: 'TRC20', direccion: 'Tlarga1' }).wallet;
    ch.setDestino({ cliente_id: CLI.id, wallet_mens: wLarga.id });
    check('chat: se borra la wallet que pediste, no la que se le parece',
      ch.borrarWallet(wPref.id).ok === true && ch.borrarWallet(wLarga.id).ok === false,
      'chw_zz está adentro de chw_zz9: comparar por substring borraría la equivocada');
    ch.setDestino({ cliente_id: CLI.id, wallet_mens: '' });
    ch.borrarWallet(wLarga.id);
    ch.guardarWallet({ ...wB, activa: false });
    check('chat: apagada una de las dos del mantenimiento, se sigue ofreciendo la otra',
      ch.walletsDe(null, 'mens').length === 1
      && ch.walletsApagadasEnUso().some((x) => x.wallet === 'BSC'));
    ch.guardarWallet({ ...wB, activa: true });
    ch.setConfig({ wallet_mens: wB.id });

    /* ── LO QUE VE EL CLIENTE ────────────────────────────────────────────────────────────────
       No alcanza con decirle cuánto salió el mes: tiene que ver cuánto debe HOY —puede arrastrar
       meses— y tener dónde avisar que pagó. Si no, lee un número y no puede hacer nada con él. */
    ch.cobrar('2026-08');
    ch.pagarCliente({ cliente_id: CLI.id, mes: '2026-07', monto: '7' });
    const saldoZ = ch.cuentas(null).clientes.find((x) => x.cliente_id === CLI.id);
    const hojaViva = chDoc.htmlCliente(chDoc.paraCliente(gZ, { mes: '2026-08' }),
      { saldo: saldoZ, comoPaga: 'wallet', token: 'tok123', avisos: [] });
    check('chat: la hoja le dice cuánto debe HOY, no sólo lo del mes',
      // El saldo vivo arriba, y lo de ESTE mes abajo — desglosado si hay movimientos, y si no,
      // en un solo renglón. Lo que no puede faltar es la mitad de abajo.
      hojaViva.includes('Tenés que pagar')
      && (/De este mes/.test(hojaViva) || /Total del mes/.test(hojaViva)),
      `saldo ${saldoZ.debe} · mes ${gZ.cobra}`);
    check('chat: con el link puede avisar que pagó desde la misma hoja',
      /¿Ya pagaste\?/.test(hojaViva) && /\/pague/.test(hojaViva) && /type="file"/.test(hojaViva));
    check('chat: la vista previa que mirás vos no lleva el formulario',
      !/¿Ya pagaste\?/.test(htmlPago));

    /* El aviso no mueve el saldo hasta que se aprueba: acreditar un pago porque alguien subió una
       imagen sería confiar en la imagen. */
    const debeAntes = ch.cuentas(null).clientes.find((x) => x.cliente_id === CLI.id).debe;
    const av = ch.avisarPago({ cliente_id: CLI.id, mes: '2026-08', monto: '12.50', referencia: 'hash abc' });
    check('chat: el aviso del cliente queda esperando y NO mueve el saldo',
      av.ok && ch.cuentas(null).clientes.find((x) => x.cliente_id === CLI.id).debe === debeAntes
      && ch.avisosPendientes().some((x) => x.id === av.aviso.id),
      `debe ${debeAntes} antes y después`);
    // El punto y la coma: "94.22" son noventa y cuatro, no nueve mil. Ese error ya pasó de verdad.
    const av100 = ch.avisarPago({ cliente_id: CLI.id, mes: '2026-08', monto: '94.22' });
    check('chat: el aviso lee bien el punto decimal (94.22 no es 9.422)',
      av100.ok && av100.aviso.monto === '94.22');
    check('chat: un monto que no es un número no entra',
      ch.avisarPago({ cliente_id: CLI.id, monto: 'ahí va' }).ok === false);
    // Un adjunto enorme se rechaza con un mensaje, no revienta la base.
    check('chat: una imagen gigante no entra',
      ch.avisarPago({ cliente_id: CLI.id, monto: '1',
        archivo: { nombre: 'x.jpg', tipo: 'image/jpeg', base64: 'A'.repeat(9 * 1024 * 1024) } }).ok === false);
    const res1 = ch.resolverAviso(av.aviso.id, true);
    check('chat: aprobarlo es lo que mueve el saldo',
      res1.ok && res1.estado === 'aprobado'
      && ch.cuentas(null).clientes.find((x) => x.cliente_id === CLI.id).debe
         === moneyCh.round(moneyCh.sub(debeAntes, '12.50'), 2));
    check('chat: el mismo aviso no se puede aprobar dos veces',
      ch.resolverAviso(av.aviso.id, true).ok === false);
    const res2 = ch.resolverAviso(av100.aviso.id, false);
    check('chat: rechazarlo no mueve nada y queda registrado',
      res2.ok && res2.estado === 'rechazado'
      && ch.avisosDe(CLI.id).some((x) => x.id === av100.aviso.id && x.estado === 'rechazado'));
    /* ── DE QUÉ ES EL PAGO ───────────────────────────────────────────────────────────────────
       Al cliente se le cobran DOS cosas —el % del mes y el mantenimiento— y hasta ahora avisaba
       "pagué 150" sin decir de cuál, así que había que adivinarlo mirando el monto. */
    const avM = ch.avisarPago({ cliente_id: CLI.id, mes: '2026-08', monto: '3', concepto: 'mantenimiento' });
    check('chat: el aviso guarda de qué es el pago',
      avM.ok && ch.avisosDe(CLI.id).find((x) => x.id === avM.aviso.id).concepto === 'mantenimiento');
    /* Los links que ya andan no mandan el concepto: rechazarlos sería romperle el aviso a alguien
       que sí pagó. Y un valor inventado tampoco puede tumbarlo. */
    const avSin = ch.avisarPago({ cliente_id: CLI.id, mes: '2026-08', monto: '4' });
    const avRaro = ch.avisarPago({ cliente_id: CLI.id, mes: '2026-08', monto: '5', concepto: 'cualquier cosa' });
    check('chat: un aviso sin concepto, o con uno inventado, se sigue aceptando',
      avSin.ok && avRaro.ok
      && ch.avisosDe(CLI.id).find((x) => x.id === avSin.aviso.id).concepto === null
      && ch.avisosDe(CLI.id).find((x) => x.id === avRaro.aviso.id).concepto === null);
    const antesConc = ch.saldoPorConcepto(CLI.id, '2026-08');
    ch.resolverAviso(avM.aviso.id, true);
    const luegoConc = ch.saldoPorConcepto(CLI.id, '2026-08');
    check('chat: aprobar un aviso de mantenimiento imputa el pago al mantenimiento',
      moneyCh.cmp(luegoConc.mantenimiento.pagado, antesConc.mantenimiento.pagado) > 0
      && luegoConc.ganancia.pagado === antesConc.ganancia.pagado,
      `mantenimiento ${antesConc.mantenimiento.pagado} → ${luegoConc.mantenimiento.pagado}`);
    check('chat: partir el saldo en dos no cambia el total',
      moneyCh.round(moneyCh.add(luegoConc.mantenimiento.debe, luegoConc.ganancia.debe), 2)
        === luegoConc.total.debe,
      `${luegoConc.mantenimiento.debe} + ${luegoConc.ganancia.debe} = ${luegoConc.total.debe}`);
    /* Un pago viejo no dice de qué era. Si quedara afuera, los dos números no darían el total y el
       cliente vería tres cifras que no cierran, que es peor que no partirlo. */
    dbCh.prepare(`INSERT INTO chat_mov (id,cliente_id,mes,tipo,monto,moneda,fecha,nota,createdAt)
      VALUES ('chm_viejo',?, '2026-08','pago','2','USDT','2026-08-10','', '2026-08-10T00:00:00Z')`).run(CLI.id);
    const conViejo = ch.saldoPorConcepto(CLI.id, '2026-08');
    check('chat: un pago viejo sin concepto no desaparece del saldo',
      moneyCh.round(moneyCh.add(conViejo.mantenimiento.debe, conViejo.ganancia.debe), 2)
        === conViejo.total.debe
      && moneyCh.cmp(conViejo.total.pagado, luegoConc.total.pagado) > 0,
      'se reparte en cascada, no se pierde');
    dbCh.prepare("DELETE FROM chat_mov WHERE id='chm_viejo'").run();
    /* "Todavía no lo generaste" y "lo generaste y te dio cero" NO son lo mismo: decir lo primero
       cuando es lo segundo es mentirle a alguien que va a mirar su cuenta el mes que viene. */
    const opSin = ch.opcionesDeConcepto('c_que_no_existe', '2026-11');
    check('chat: si el mes todavía no se cobró se dice, no sale un cero',
      opSin.opciones[1].rotulo === 'Servicio del mes — todavía no está'
      && /se calcula con el mes cerrado/.test(opSin.aclaracion),
      opSin.opciones[1].rotulo);
    const opCero = ch.opcionesDeConcepto('c_que_no_existe', '2026-08');
    check('chat: cuando el mes ya se cobró deja de decir que no está',
      opCero.opciones[1].rotulo === 'Servicio del mes — este mes no te cobramos nada'
      && opCero.aclaracion === '',
      opCero.opciones[1].rotulo);
    /* ── EL MANTENIMIENTO, CAJA POR CAJA ─────────────────────────────────────────────────────
       Un cliente con cuatro cajas no paga cuatro veces 150: paga una vez y elige cuáles cubre. */
    dbCh.prepare('DELETE FROM chat_mov WHERE cliente_id=?').run(CLI.id);
    let nMov = 0;
    const ponerMens = (panel) => dbCh.prepare(`INSERT INTO chat_mov
      (id,cliente_id,mes,tipo,monto,moneda,fecha,nota,createdAt,panel)
      VALUES (?,?, '2026-08','mensualidad','150','USDT','2026-08-22','', ?, ?)`)
      .run(`mq_${nMov += 1}`, CLI.id, `2026-08-22T00:0${nMov}:00Z`, panel);
    const ponerPago = (monto, cajas) => dbCh.prepare(`INSERT INTO chat_mov
      (id,cliente_id,mes,tipo,monto,moneda,fecha,nota,createdAt,concepto,cajas)
      VALUES (?,?, '2026-08','pago',?,'USDT','2026-08-25','', ?, 'mantenimiento', ?)`)
      .run(`mq_${nMov += 1}`, CLI.id, monto, `2026-08-25T00:0${nMov}:00Z`, cajas || null);
    ['CajaA', 'CajaB', 'CajaC', 'CajaD'].forEach(ponerMens);
    const porCaja1 = ch.mantenimientoPorCaja(CLI.id);
    check('chat: el mantenimiento se ve caja por caja',
      porCaja1.length === 4 && porCaja1.every((c) => c.debe === '150'),
      porCaja1.map((c) => `${c.panel}:${c.debe}`).join(' '));
    ponerPago('300', 'CajaA, CajaC');
    const d2 = Object.fromEntries(ch.mantenimientoPorCaja(CLI.id).map((c) => [c.panel, c.debe]));
    check('chat: pagando 300 y eligiendo dos, quedan al día ésas y sólo ésas',
      d2.CajaA === '0' && d2.CajaC === '0' && d2.CajaB === '150' && d2.CajaD === '150',
      JSON.stringify(d2));
    /* Los pagos viejos no dicen de qué cajas eran: si quedaran afuera, la suma por caja no daría el
       total y el cliente vería dos cuentas distintas de lo mismo. */
    ponerPago('150', null);
    const d3 = Object.fromEntries(ch.mantenimientoPorCaja(CLI.id).map((c) => [c.panel, c.debe]));
    check('chat: un pago que no elige cajas tapa la más vieja que deba',
      d3.CajaB === '0' && d3.CajaD === '150', JSON.stringify(d3));
    check('chat: la suma por caja da el mismo total que el saldo del cliente',
      ch.mantenimientoPorCaja(CLI.id).reduce((a, c) => a + Number(c.debe), 0)
        === Math.max(0, Number(ch.saldoPorConcepto(CLI.id, '2026-08').mantenimiento.debe)));
    ponerPago('9999', 'CajaD');
    check('chat: pagando de más, ninguna caja queda en negativo',
      ch.mantenimientoPorCaja(CLI.id).every((c) => Number(c.debe) >= 0));
    dbCh.prepare('DELETE FROM chat_mov WHERE cliente_id=?').run(CLI.id);
    ['CajaA', 'CajaB'].forEach(ponerMens);
    const opCajas = ch.opcionesDeConcepto(CLI.id, '2026-08');
    check('chat: al avisar el pago se le ofrecen las cajas que debe',
      opCajas.cajasMant.length === 2 && /CajaA — 150/.test(opCajas.cajasMant[0].texto)
      && opCajas.tituloCajas === '¿De qué cajas?');
    const portalCajas = require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'ganamos.html'), 'utf8');
    check('portal: el cliente puede elegir de qué cajas es el pago',
      /name="caja"/.test(portalCajas) && /datos\.cajas/.test(portalCajas)
      && /Si no marcás ninguna/.test(portalCajas));
    const hojaCajas = chDoc.htmlCliente(chDoc.paraCliente(gZ, { mes: '2026-08' }),
      { saldo: saldoZ, token: 'tok123', avisos: [], conceptos: opCajas });
    check('chat: y en la hoja también, con el mismo texto',
      /name="caja"/.test(hojaCajas) && /¿De qué cajas\?/.test(hojaCajas)
      && /datos\.cajas=/.test(hojaCajas));
    /* La aclaración es del SERVICIO DEL MES. Con el mantenimiento elegido no puede estar a la
       vista: le diría que algo "todavía no está" justo de lo que sí está y va a pagar. */
    check('chat: la aclaración del mes no se muestra mientras paga el mantenimiento',
      !/aclaraMes/.test(hojaCajas) || /id="aclaraMes" style="display:none"/.test(hojaCajas),
      'arranca oculta porque lo sugerido es el mantenimiento');
    check('portal: y ahí también se esconde al cambiar de concepto',
      /acl\.style\.display = esMant \? 'none'/.test(portalCajas));
    check('chat: elegir cajas no filtra datos internos',
      !/margen|costo|pct_costo|te cuesta|paga:/i.test(hojaCajas)
      && !/margen|costo|pct_costo|te cuesta|sin confirmar/i.test(hojaCajas));
    dbCh.prepare('DELETE FROM chat_mov WHERE cliente_id=?').run(CLI.id);

    /* ── EL PANEL DEL PROVEEDOR ──────────────────────────────────────────────────────────────
       Ve su liquidación y NADA MÁS. Lo que nunca puede ver es lo que ella le cobra al cliente:
       de la diferencia contra lo que él cobra sale el margen, que es el negocio entero. */
    const authSrc = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'auth.js'), 'utf8');
    /* ⚠️ LA HOJA DEL PROVEEDOR SUMABA SÓLO EL %. Le decía 169,40 cuando se le debían 1.219,40: el
       mantenimiento se le paga 100% a él y no estaba. Y ahora que tiene pantalla propia, las dos
       tienen que decir lo mismo o la primera discusión es sobre cuál miente. */
    const hojaProv = chDoc.paraProveedor(ch.porCliente('2026-08'),
      { mes: '2026-08', mantenimiento: ch.deudaProveedor('2026-08').mantenimiento });
    check('proveedor: la hoja suma el mantenimiento, no sólo el %',
      hojaProv.mantenimiento !== undefined
      && hojaProv.total === moneyCh.round(moneyCh.add(hojaProv.porGanancia, hojaProv.mantenimiento), 2),
      `${hojaProv.porGanancia} + ${hojaProv.mantenimiento} = ${hojaProv.total}`);
    check('proveedor: la hoja y lo que le debés dan el mismo número',
      hojaProv.total === ch.deudaProveedor('2026-08').total.debe,
      'si difieren, la hoja que le mandás contradice su pantalla');
    const idxSrc = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'index.js'), 'utf8');
    check('login: la puerta del panel tiene tope de intentos',
      /app\.post\('\/api\/login'/.test(idxSrc) && /demasiadosIntentos\(kIp\) \|\| demasiadosIntentos\(kUs\)/.test(idxSrc),
      'con tres usuarios adentro, probar contraseñas contra la puerta principal era gratis');
    check('login: uno que sale bien limpia la cuenta de intentos',
      /if \(body && body\.ok\) \{ limpiarIntentos\(kIp\); limpiarIntentos\(kUs\); \}/.test(idxSrc));

    check('proveedor: sin las dos variables puestas NO existe el usuario',
      /HAY_PROVEEDOR = !!\(PROVEEDOR_USER && PROVEEDOR_PASSWORD\)/.test(authSrc),
      'un usuario que aparece solo porque alguien deployó es una puerta que nadie pidió');
    check('proveedor: la contraseña se compara en tiempo constante, como las otras',
      /safeEqual\(user \|\| '', PROVEEDOR_USER\) && safeEqual\(password \|\| '', PROVEEDOR_PASSWORD\)/.test(authSrc));
    check('proveedor: su lista de permisos es de sólo lectura',
      /PROVEEDOR_PUEDE = \[/.test(authSrc)
      && !/\{ m: 'POST', re: \/\^\\\/api\\\/os\\\/proveedor/.test(authSrc),
      'él mira; lo que se cobra y se paga lo registra ella');
    const provDoc = ch.paraElProveedor('2026-08');
    const provTxt = JSON.stringify(provDoc);
    /* EL CHECK QUE MÁS IMPORTA DE TODO ESTE BLOQUE. */
    check('proveedor: NO se le filtra lo que ella le cobra al cliente',
      !/"cobra"/.test(provTxt) && !/"pct_cliente"/.test(provTxt)
      && !/margen|sinPrecio|precio sin confirmar/i.test(provTxt),
      'de la diferencia contra lo que él cobra sale el margen');
    check('proveedor: tampoco se le dice de qué plataforma es cada caja',
      !/"sistema"/.test(provTxt) && !/Casino|Europa/.test(provTxt));
    check('proveedor: ve el profit de cada caja y lo que le toca por ella',
      Array.isArray(provDoc.cajas)
      && provDoc.cajas.every((c) => c.profit !== undefined && c.paga !== undefined && !('cobra' in c)));
    check('proveedor: ve el mantenimiento caja por caja',
      Array.isArray(provDoc.mantenimiento));
    check('proveedor: y los pagos con dónde y cuándo',
      Array.isArray(provDoc.pagos)
      && provDoc.pagos.every((x) => 'fecha' in x && 'destino' in x && 'concepto' in x));
    check('proveedor: puede mirar meses anteriores',
      Array.isArray(ch.mesesDelProveedor()));
    const rutasSrc = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'os.routes.js'), 'utf8');
    check('proveedor: la ruta tiene un cinturón que frena una respuesta con datos internos',
      /_sinMargen/.test(rutasSrc) && /se frenó una respuesta que llevaba datos internos/.test(rutasSrc));
    const provHtml = require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'proveedor.html'), 'utf8');
    /* ⚠️ Los pagos se registran por MES y por concepto, no atados a una caja. Poner un tilde por
       caja sería inventar una precisión que el dato no tiene. */
    check('proveedor: la pantalla dice que el estado de pago es del mes, no de cada caja',
      /El estado de pago es del total del mes/.test(provHtml));
    /* Se buscan los NOMBRES DE CAMPO, no la palabra: "Te queda por cobrar" es texto legítimo y
       matchear la palabra suelta hace que el check grite por el motivo equivocado. */
    check('proveedor: la pantalla no lee ningún campo del negocio de ella',
      !/\.cobra\b|\['cobra'\]|"cobra"|pct_cliente|\bmargen\b/i.test(provHtml));

    check('chat: el rótulo lleva el monto y viene marcado el que más debe',
      /^Mantenimiento — (debés|tenés|estás)/.test(ch.opcionesDeConcepto(CLI.id, '2026-08').opciones[0].rotulo)
      && ch.opcionesDeConcepto(CLI.id, '2026-08').opciones.filter((o) => o.sugerida).length === 1);
    const hojaConc = chDoc.htmlCliente(chDoc.paraCliente(gZ, { mes: '2026-08' }),
      { saldo: saldoZ, token: 'tok123', avisos: [], conceptos: ch.opcionesDeConcepto(CLI.id, '2026-08') });
    check('chat: la hoja pregunta de qué es el pago y lo manda',
      /¿De qué es este pago\?/.test(hojaConc) && /name="concepto"/.test(hojaConc)
      && /datos\.concepto=f\.concepto\.value/.test(hojaConc));
    check('chat: la vista previa que mirás vos tampoco lleva el selector',
      !/¿De qué es este pago\?/.test(htmlPago),
      'el espejo del check del formulario: una hoja que se mira no trae nada que no se vea');
    /* EL CINTURÓN: el texto nuevo sale para afuera y hay DOS guards que lo pueden tumbar con un
       500 —el de la vista previa y el de la hoja del cliente—. Se corren las dos regex reales. */
    check('chat: el texto nuevo de la hoja no dispara los guards de datos internos',
      !/margen|costo|pct_costo|te cuesta|paga:/i.test(hojaConc)
      && !/margen|costo|pct_costo|te cuesta|sin confirmar/i.test(hojaConc),
      'por eso el campo se llama «concepto» y no «paga»');
    const portalHtml = require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'ganamos.html'), 'utf8');
    check('portal: el cliente también puede elegir de qué es el pago',
      /name="concepto"/.test(portalHtml) && /¿De qué es este pago\?|conc\.titulo/.test(portalHtml)
      && /nombreConcepto/.test(portalHtml));
    const osHtmlConc = require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'os.html'), 'utf8');
    check('panel: al aprobar un aviso se ve de qué dijo que era',
      /De qué es/.test(osHtmlConc) && /a\.concepto==='mantenimiento'/.test(osHtmlConc)
      && /no lo dijo/.test(osHtmlConc));
    check('panel: se puede marcar más de una wallet para cada cosa',
      /chatCfgWallets\(/.test(osHtmlConc) && /class="wsel"/.test(osHtmlConc)
      && osHtmlConc.includes('Para el servicio del mes, por defecto')
      && osHtmlConc.includes('Paga el mantenimiento a'));

    /* ── QUE A ELLA LE AVISEN ────────────────────────────────────────────────────────────────
       Antes, un aviso de pago quedaba esperando en Pendientes y ella se enteraba sólo si entraba
       a mirar; y una cuenta cobrada podía quedarse sin mandar un mes sin que nada lo dijera. */
    const avSvc = require('../src/chat-avisos.service');
    const cfgStore = require('../src/config-store');
    const avX = ch.avisarPago({ cliente_id: CLI.id, mes: '2026-08', monto: '7', concepto: 'ganancia', referencia: 'ref x' });
    const avLeido = ch.avisoPorId(avX.aviso.id);
    check('chat: el aviso se puede releer entero para armar el mensaje',
      !!avLeido && avLeido.concepto === 'ganancia' && !!avLeido.cliente && avLeido.referencia === 'ref x',
      'avisarPago sólo devuelve {id,monto,bytes}: el texto se arma releyendo la base');
    const tAv = avSvc.textoAvisoPago({ ...avLeido, sinResolver: 1 });
    check('chat: el aviso a la matriz dice quién, cuánto y de qué es',
      /dicen que pagaron/.test(tAv) && tAv.includes(avLeido.cliente)
      && /el servicio del mes/.test(tAv) && /agosto 2026/.test(tAv),
      'el mes va como «agosto 2026», igual que en la pantalla');
    check('chat: si no subió comprobante, el aviso lo dice',
      /SIN comprobante/.test(avSvc.textoAvisoPago({ ...avLeido, archivo_bytes: 0, sinResolver: 1 })));
    /* Un cliente apretando el botón no puede volverse una ráfaga de mensajes. */
    check('chat: del cuarto aviso sin resolver en adelante se deja de avisar',
      avSvc.textoAvisoPago({ ...avLeido, sinResolver: 3 }) !== null
      && avSvc.textoAvisoPago({ ...avLeido, sinResolver: 4 }) === null);
    /* ⚠️ Un aviso que NUNCA se intentó vale igual que uno que falló: los dos son "ella no se
       enteró". Con `aviso_ok=0` los NULL se escapaban de la lista sin que nada lo dijera. */
    check('chat: un aviso que nunca se intentó figura como no avisado',
      ch.avisosSinNotificar().some((x) => x.id === avX.aviso.id));
    ch.marcarAvisoPago(avX.aviso.id, { ok: true });
    check('chat: y cuando sale, desaparece de esa lista',
      !ch.avisosSinNotificar().some((x) => x.id === avX.aviso.id));
    ch.marcarAvisoPago(avX.aviso.id, { ok: false, error: 'chat not found' });
    check('chat: la pantalla puede ver que el aviso no salió y por qué',
      (ch.avisosPendientes().find((x) => x.id === avX.aviso.id) || {}).aviso_error === 'chat not found',
      'sin traer aviso_ok en el SELECT, el cartel de la pantalla era código muerto');

    /* ── LO QUE TE FALTA MANDAR ──────────────────────────────────────────────────────────────
       ⚠️ EL CASO QUE SE ESCAPABA: cobrar() saltea al que da cero, así que un cliente que sólo
       paga mantenimiento nunca tiene fila tipo='cobro' — y sin embargo debe plata y su cuenta se
       le manda igual. Mirando sólo 'cobro' quedaba callado para siempre. */
    dbCh.prepare('DELETE FROM chat_mov WHERE cliente_id=?').run(CLI.id);
    dbCh.prepare('DELETE FROM chat_envio WHERE cliente_id=?').run(CLI.id);
    dbCh.prepare(`INSERT INTO chat_mov (id,cliente_id,mes,tipo,monto,moneda,fecha,nota,createdAt)
      VALUES ('chm_solomant',?, '2026-08','mensualidad','25','USDT','2026-08-05','', ?)`)
      .run(CLI.id, new Date().toISOString());
    const L1 = ch.listasParaMandar();
    check('chat: una cuenta que es SÓLO mantenimiento también entra en lo que falta mandar',
      [...(L1.mandar || []), ...(L1.sinGrupo || [])].some((x) => x.cliente_id === CLI.id && x.mes === '2026-08'),
      'sin esto, el que sólo paga mantenimiento no se reclama nunca');
    ch.marcarEnviado(CLI.id, '2026-08', { ok: true });
    check('chat: una vez mandada, deja de reclamarse',
      ![...(ch.listasParaMandar().mandar || []), ...(ch.listasParaMandar().sinGrupo || [])]
        .some((x) => x.cliente_id === CLI.id && x.mes === '2026-08'));
    dbCh.prepare('DELETE FROM chat_envio WHERE cliente_id=?').run(CLI.id);
    /* Un cobro viejo se deja de reclamar: si no lo mandó en dos semanas, fue a propósito. */
    dbCh.prepare("UPDATE chat_mov SET createdAt=? WHERE id='chm_solomant'")
      .run(new Date(Date.now() - 40 * 864e5).toISOString());
    check('chat: pasadas dos semanas se deja de insistir',
      ![...(ch.listasParaMandar().mandar || []), ...(ch.listasParaMandar().sinGrupo || [])]
        .some((x) => x.cliente_id === CLI.id));
    dbCh.prepare("DELETE FROM chat_mov WHERE id='chm_solomant'").run();

    check('chat: si no hay nada para mandar, el recordatorio NO manda nada',
      avSvc.textoFaltaMandar({ mandar: [], sinGrupo: [] }) === null,
      'un mensaje diario que dice «no hay nada» se deja de leer, y el día que dice algo tampoco');
    /* ⚠️ Y si NINGUNA tiene grupo —que es como arranca todo— igual tiene que avisar. Si dependiera
       de que haya alguna mandable, una cuenta cobrada se quedaba un mes sin mandar en silencio. */
    const soloSinGrupo = avSvc.textoFaltaMandar({ mandar: [], sinGrupo: [{ cliente: 'Pepe', mes: '2026-08' }] });
    check('chat: aunque ninguna tenga grupo cargado, el recordatorio igual avisa',
      soloSinGrupo !== null && /Pepe/.test(soloSinGrupo) && /no tiene grupo/.test(soloSinGrupo));
    const tFalta = avSvc.textoFaltaMandar({ mandar: [{ cliente: 'Fran44', mes: '2026-08' }], sinGrupo: [] });
    /* El congelado y el vivo se separan solos (el acumulado se sana de noche, un TC se mueve). Un
       número en Telegram que no coincide con el de la pantalla, donde no se puede preguntar cuál
       es el bueno, es peor que ninguno. */
    check('chat: el recordatorio NO lleva montos, sólo a quién entrar',
      /Fran44/.test(tFalta) && /agosto 2026/.test(tFalta) && !/USDT/.test(tFalta));
    cfgStore.setUrlPublica('https://ejemplo.test');
    const conLink = avSvc.textoFaltaMandar({ mandar: [{ cliente: 'Fran44', mes: '2026-08' }], sinGrupo: [] });
    check('chat: el link del recordatorio lleva el mes, o se manda la cuenta equivocada',
      /\/chat-externo\?mes=2026-08/.test(conLink),
      'del día 11 en adelante la pantalla abre el mes corriente sola');
    const osFront = require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'os.html'), 'utf8');
    check('panel: y la pantalla respeta ese mes de la URL',
      /_mesDeLaURL/.test(osFront) && /_chatMes = _mesDeLaURL \|\| mesDeCierre\(\)/.test(osFront));
    check('panel: el mes se escribe igual en Telegram y en el cartel de confirmar',
      /su cuenta de '\+mesNombre\(_chatMes\)/.test(osFront),
      'agosto 2026 en los dos lados, no 2026-08 en uno');
    check('panel: se ve en pantalla lo que quedó cobrado y sin mandar',
      /cobrada\$\{m\.length>1\?'s':''\} y sin mandar/.test(osFront) && /pc\.listas/.test(osFront));
    check('panel: y se ve si el aviso a Telegram no salió',
      /a\.aviso_ok!==1/.test(osFront) && /Aviso a Telegram/.test(osFront));
    /* El interruptor existe porque el suite hace POST de verdad contra /chat/aviso. */
    check('chat: los avisos están apagados durante los tests',
      process.env.CHAT_AVISOS_OFF === '1');
    const rApagado = await avSvc.avisarPago(avX.aviso.id);
    check('chat: con el interruptor puesto no se manda nada, pero queda anotado',
      rApagado.ok === false && /apagados/.test(rApagado.error || '')
      && ch.avisosSinNotificar().some((x) => x.id === avX.aviso.id),
      'que esté apagado no es «no había que avisar»');
    cfgStore.setUrlPublica('');

    dbCh.prepare('DELETE FROM chat_comprobante WHERE cliente_id=?').run(CLI.id);
    dbCh.prepare('DELETE FROM chat_mov WHERE cliente_id=?').run(CLI.id);
    ch.setConfig({ wallet_ggr: '', wallet_mens: '', pago_nota: '' });
    ch.setDestino({ cliente_id: CLI.id, wallet_ggr: '', wallet_mens: '' });
    dbCh.prepare("DELETE FROM chat_wallet WHERE id IN (?,?)").run(wA.id, wB.id);

    /* ── LO QUE YA LE PAGASTE AL PROVEEDOR ───────────────────────────────────────────────────
       Antes un mes pagado y uno impago se veían idénticos. */
    check('chat: un pago sin monto usable no se guarda',
      ch.pagar({ mes: '2026-08', monto: '1.419,49' }).ok === false
      && ch.pagar({ mes: '2026-08', monto: '0' }).ok === false);
    const pg = ch.pagar({ mes: '2026-08', monto: '500', fecha: '2026-09-03', nota: 'transferencia' });
    check('chat: lo que le pagaste al proveedor queda registrado',
      pg.ok && ch.pagado('2026-08') === '500' && ch.pagos('2026-08').length === 1,
      'pagado 500 de ' + pcZ.totales.paga);
    ch.borrarPago(pg.pago.id);
    check('chat: un pago mal cargado se puede borrar', ch.pagado('2026-08') === '0');

    /* ── QUÉ SE MANDÓ Y SI LLEGÓ ─────────────────────────────────────────────────────────────
       La factura del mes hoy se manda y no deja rastro: "¿se la mandaste?" no tiene respuesta. */
    ch.marcarEnviado(CLI.id, '2026-08', { ok: false, error: 'chat not found' });
    check('chat: un envío que falla queda anotado, no se pierde',
      ch.envios('2026-08')[CLI.id].ok === false
      && ch.envios('2026-08')[CLI.id].error === 'chat not found');
    ch.marcarEnviado(CLI.id, '2026-08', { ok: true });
    check('chat: el reintento que sale bien pisa al que falló',
      ch.envios('2026-08')[CLI.id].ok === true && !ch.envios('2026-08')[CLI.id].error);

    /* ── LOS QUE QUEDAN AFUERA SE NOMBRAN ────────────────────────────────────────────────────
       Un panel desenganchado del casino no tiene ganancia que leer, pero el cliente igual tiene el
       servicio: descartarlo en silencio dejaba una factura de menos que nadie iba a buscar. */
    panSt.update(PAN2.id, { conexion_id: '' });
    const ciSalt = ch.cierre('2026-08');
    check('chat: un panel que no se puede calcular se nombra, no desaparece',
      (ciSalt.salteados || []).some((x) => x.panel === 'ZZ-Panel-Chat-2'),
      JSON.stringify(ciSalt.salteados));

    /* ── LO QUE ENCONTRÓ LA REVISIÓN ADVERSARIAL (26-ago-2026) ───────────────────────────────
       Cada una de estas estaba en el código que ya se había subido. Se prueban de a una para que
       no vuelvan por el camino de siempre: alguien "simplifica" y nadie se entera. */

    // 1. El botón que acredita un pago estaba MUERTO: JSON.stringify mete comillas dobles adentro
    //    de un atributo con comillas dobles y el onclick se corta a la mitad.
    const uiRev = require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'os.html'), 'utf8');
    check('revisión: ningún botón lleva los datos adentro del onclick',
      !/onclick="chat[A-Za-z]*\([^"]*\$\{(esc\(|JSON\.stringify)/.test(uiRev)
      && /data-monto="\$\{esc\(a\.monto\)\}"/.test(uiRev),
      'van en data-* y se leen con this.dataset');

    // 2. El texto que escribe el CLIENTE en el portal entraba en un onclick de la pantalla.
    check('revisión: el texto que manda el cliente no puede volverse código en tu pantalla',
      /data-caja="\$\{esc\(x\.caja\)\}"/.test(uiRev)
      && !/chatSolicitud\('\$\{x\.id\}',true,'\$\{esc/.test(uiRev));

    // 3. Dos cajas con el mismo nombre en clientes distintos abrían la cuenta del equivocado.
    const OTRO = cliSt3.list().clientes.filter((x) => x.codigo === 'ZZ-OTRO').forEach((x) => cliSt3.removeCliente(x.id));
    const CLI2 = cliSt3.createCliente({ codigo: 'ZZ-OTRO', nombre: 'Otro cliente' });
    const PANX = panSt.create({ cliente_id: CLI2.id, nombre: 'ZZ-Panel-Chat', sistema: 'Casino',
      nivel_usuario: 'SuperAgente', id_usuario: '9990009', conexion_id: 'cx_zz', divisas: ['ARS'] });
    ch.set({ panel_id: PANX.id, pct_cliente: '4' });
    check('revisión: un nombre de caja repetido no abre la cuenta de nadie',
      ch.quienEntra('ZZ-Panel-Chat') === null,
      'ante la duda la puerta se queda cerrada, en vez de elegir el primero de la lista');
    ch.quitar(PANX.id); panSt.remove(PANX.id); cliSt3.removeCliente(CLI2.id);
    check('revisión: con el nombre sin repetir vuelve a entrar',
      (ch.quienEntra('ZZ-Panel-Chat') || {}).cliente_id === CLI.id);

    // 4. La nota interna del cobro llegaba al portal del cliente.
    /* Se usa PAN, no PAN2: a esta altura PAN2 quedó sin conexión (lo pide la prueba de salteados)
       y una caja salteada no entra en el cierre, así que su falta de precio no marcaría nada. */
    ch.set({ panel_id: PAN.id, pct_cliente: '' });      // sin precio → cobra el mínimo y lo marca
    ch.descobrar('2026-08');                            // si ya había un cobro, el índice único no lo pisa
    ch.cobrar('2026-08');
    const mCobro = (ch.cuentas(null).clientes.find((x) => x.cliente_id === CLI.id) || {}).movs || [];
    check('revisión: la marca "precio sin confirmar" queda guardada para vos',
      mCobro.some((m) => m.tipo === 'cobro' && /sin confirmar/i.test(m.nota || '')),
      JSON.stringify(mCobro.filter((m) => m.tipo === 'cobro').map((m) => m.nota)));
    check('revisión: pero NO viaja al portal del cliente',
      !/sin confirmar/i.test(JSON.stringify(ch.portalDe(CLI.id))),
      'decirle que su precio está sin decidir es abrirle una negociación que nadie pidió');
    ch.descobrar('2026-08'); ch.set({ panel_id: PAN.id, pct_cliente: '4' });

    /* 4b. Cobrar un mes al que le falta un tipo de cambio congelaba el total CORTO, y como no se
       puede cobrar encima, cargar el TC al día siguiente ya no lo arreglaba. */
    dbCh.prepare("DELETE FROM tc_mes WHERE mes='2026-08'").run();
    const sinTc = ch.cobrar('2026-08');
    check('revisión: no se congela un mes al que le falta el tipo de cambio',
      sinTc.ok === false && sinTc.requiereConfirmar === true && (sinTc.sinTC || []).includes('ARS'),
      sinTc.error ? sinTc.error.slice(0, 70) : '');
    check('revisión: pero se puede cobrar igual si lo confirmás',
      ch.cobrar('2026-08', { confirmar: true }).ok === true);
    ch.descobrar('2026-08');
    dbCh.prepare(`INSERT INTO tc_mes (mes,tc_cliente,updatedAt) VALUES ('2026-08','1000',?)
      ON CONFLICT(mes) DO UPDATE SET tc_cliente='1000'`).run(new Date().toISOString());

    /* 8b. Un monto enorme entraba como "1e+21" y después el control de los pagos lo rechazaba: el
       aviso quedaba clavado en pendiente, imposible de aprobar. Lo que entra tiene que poder salir. */
    check('revisión: un monto que no se va a poder aprobar no se acepta',
      ch.avisarPago({ cliente_id: CLI.id, monto: '1000000000000000000000' }).ok === false);
    const avOk = ch.avisarPago({ cliente_id: CLI.id, monto: '94.22' });
    check('revisión: y el que entra se puede aprobar siempre',
      avOk.ok && avOk.aviso.monto === '94.22' && ch.resolverAviso(avOk.aviso.id, true).ok === true);
    dbCh.prepare('DELETE FROM chat_comprobante WHERE cliente_id=?').run(CLI.id);
    dbCh.prepare("DELETE FROM chat_mov WHERE cliente_id=? AND tipo='pago'").run(CLI.id);

    /* 1b. Y la mensualidad no se cobra dos veces la misma caja el mismo día: antes no había ningún
       control y dos clics dejaban dos filas. */
    const m1 = ch.cobrarMensualidad({ cliente_id: CLI.id, panel: 'ZZ-Panel-Chat' });
    check('revisión: la misma mensualidad no entra dos veces el mismo día',
      m1.ok && ch.cobrarMensualidad({ cliente_id: CLI.id, panel: 'ZZ-Panel-Chat' }).ok === false);
    dbCh.prepare("DELETE FROM chat_mov WHERE tipo='mensualidad'").run();

    /* 9b. La hoja mostraba el total recalculado abajo y el saldo vivo arriba: si cambiaba un TC
       entre una cosa y la otra, dos números distintos del mismo mes en la misma página. */
    const hojaDos = chDoc.htmlCliente(chDoc.paraCliente(gZ, { mes: '2026-08' }),
      { saldo: { cobrado: '100', pagado: '0', debe: '100' }, cobradoMes: '100' });
    check('revisión: la hoja muestra UN solo número del mes, el que está en su cuenta',
      (hojaDos.match(/100,00 USDT/g) || []).length >= 2
      && !/(De este mes|Total del mes)[\s\S]{0,80}8\.194/.test(hojaDos),
      'manda lo cobrado, no lo recalculado');

    // 5. Una caja de agente sin cliente se le pagaba al proveedor y no se le cobraba a nadie.
    check('revisión: una caja sin cliente se nombra al cobrar, no se saltea en silencio',
      Array.isArray(ch.cobrar('2026-08').sinCliente));
    ch.descobrar('2026-08');

    // 6. La fecha se guardaba en UTC y la pantalla la buscaba en hora argentina: entre las 21 y las
    //    24 la mensualidad quedaba con la fecha de mañana y se podía cobrar dos veces.
    const { fechaTZ: fTZ } = require('../src/lib/fechas');
    const mHoy = ch.cobrarMensualidad({ cliente_id: CLI.id, panel: 'ZZ-Panel-Chat' });
    check('revisión: la mensualidad se fecha en hora de acá, no en UTC',
      mHoy.mov.fecha === fTZ(),
      `guardó ${mHoy.mov.fecha} y acá es ${fTZ()}`);
    check('revisión: y por eso la pantalla la ve cobrada el mismo día',
      ch.mensualidadesDe(fTZ()).paneles.length === 0
      || ch.mensualidadesDe(fTZ()).paneles.every((p) => p.panel !== 'ZZ-Panel-Chat' || p.cobrada));

    // 7. "Ya cobrada" se decidía buscando el nombre adentro del texto de la nota, y "ZZ-Panel-Chat"
    //    está adentro de "ZZ-Panel-Chat-2": una caja quedaba marcada por el nombre de la otra.
    check('revisión: la mensualidad guarda de qué caja es, no se adivina del texto',
      mHoy.mov.panel === 'ZZ-Panel-Chat');
    const dia2 = Number(fTZ().slice(8, 10));
    ch.set({ panel_id: PAN2.id, dia_cobro: dia2 <= 28 ? dia2 : 28 });
    if (dia2 <= 28) {
      check('revisión: cobrar una caja no marca como cobrada a la de nombre parecido',
        (ch.mensualidadesDe(fTZ()).paneles.find((p) => p.panel === 'ZZ-Panel-Chat-2') || {}).cobrada !== true,
        'ZZ-Panel-Chat está adentro de ZZ-Panel-Chat-2');
    }
    dbCh.prepare("DELETE FROM chat_mov WHERE tipo='mensualidad'").run();

    // 8. El tipo del archivo lo elegía el cliente: text/html volvía a salir como página adentro de
    //    tu sesión cuando abrías el comprobante.
    const avHtml = ch.avisarPago({ cliente_id: CLI.id, monto: '1',
      archivo: { nombre: 'x.html', tipo: 'text/html', base64: Buffer.from('<script>alert(1)</script>').toString('base64') } });
    check('revisión: un comprobante que no es imagen no se guarda como página',
      avHtml.ok && ch.archivoDeAviso(avHtml.aviso.id).archivo_tipo === 'application/octet-stream',
      'el tipo lo decide el sistema, no el que sube el archivo');
    const avJpg = ch.avisarPago({ cliente_id: CLI.id, monto: '1',
      archivo: { nombre: 'x.jpg', tipo: 'image/jpeg', base64: 'AAAA' } });
    check('revisión: una imagen de verdad sí conserva su tipo',
      ch.archivoDeAviso(avJpg.aviso.id).archivo_tipo === 'image/jpeg');

    // 9. Sin tope: el portal público dejaba meter capturas de 6 MB hasta llenar la base.
    for (let i = 0; i < 9; i++) ch.avisarPago({ cliente_id: CLI.id, monto: '1' });
    check('revisión: hay tope de avisos sin resolver',
      ch.avisarPago({ cliente_id: CLI.id, monto: '1' }).ok === false,
      `${ch.avisosSinResolver(CLI.id)} esperando`);
    dbCh.prepare('DELETE FROM chat_comprobante WHERE cliente_id=?').run(CLI.id);

    // 10. Agregar una segunda wallet dejaba a todos sin dirección de pago, sin aviso.
    dbCh.prepare('DELETE FROM chat_wallet').run();
    ch.setConfig({ wallet_ggr: '', wallet_mens: '' });
    const w1 = ch.guardarWallet({ alias: 'Sola', red: 'TRC20', direccion: 'TQsola' }).wallet;
    check('revisión: la primera wallet queda elegida sola',
      ch.config().wallet_ggr === w1.id && ch.config().wallet_mens === w1.id);
    ch.guardarWallet({ alias: 'Segunda', red: 'BEP20', direccion: '0xsegunda' });
    check('revisión: agregar la segunda no le saca la dirección a nadie',
      (ch.walletDe(CLI.id, 'ggr') || {}).direccion === 'TQsola',
      'antes se quedaban todos sin adónde pagar');
    dbCh.prepare('DELETE FROM chat_wallet').run();
    ch.setConfig({ wallet_ggr: '', wallet_mens: '' });

    // 11. La mensualidad en pesos se sumaba al saldo como si fueran USDT.
    check('revisión: la mensualidad no se puede poner en una moneda que no se sabe sumar',
      ch.setConfig({ mensualidad_moneda: 'ARS' }).ok === false
      && ch.config().mensualidad_moneda === 'USDT');

    // 12. Borrar un cliente dejaba su deuda del chat sumando, sin cliente al lado.
    const casc = require('../src/clientes-cascada');
    const CLI3 = cliSt3.createCliente({ codigo: 'ZZ-BORRAR', nombre: 'Para borrar' });
    ch.setDestino({ cliente_id: CLI3.id, tg_grupo: '-100999' });
    ch.pagarCliente({ cliente_id: CLI3.id, mes: '2026-08', monto: '5' });
    casc.borrar(CLI3.id);
    check('revisión: borrar un cliente se lleva también lo del chat',
      !ch.cuentas(null).clientes.some((x) => x.cliente_id === CLI3.id)
      && !ch.destinos()[CLI3.id],
      'antes quedaba una deuda huérfana sumando en el total');

    ch.quitar(PAN2.id); panSt.remove(PAN2.id);
    dbCh.prepare('DELETE FROM chat_cliente WHERE cliente_id=?').run(CLI.id);
    dbCh.prepare('DELETE FROM chat_envio WHERE cliente_id=?').run(CLI.id);
    dbCh.prepare("DELETE FROM chat_pago_proveedor WHERE mes='2026-08'").run();
    dbCh.prepare("DELETE FROM factura_link WHERE cliente_id LIKE 'chat:%'").run();
    ch.quitar(PAN.id);
    dbCh.prepare("DELETE FROM reporte_diario WHERE conexion_id='cx_zz'").run();
    dbCh.prepare("DELETE FROM tc_mes WHERE mes='2026-08'").run();
    panSt.remove(PAN.id); cliSt3.removeCliente(CLI.id);

    /* ── LOS ACCESOS DE TODOS, EN UNA PANTALLA ───────────────────────────────────────────────
       Darle acceso a 45 clientes de a uno son 45 idas y vueltas, y en el medio se pierde la cuenta
       de quién ya tiene. Acá se hace de a varios, y el que no tiene contraseña sigue entrando con
       su código: darle acceso a uno no deja afuera a los demás. */
    {
      const c1 = (await post('/api/os/clientes', { codigo: 'ZZ-ACC1', nombre: 'Acceso Uno' })).data.cliente;
      const c2 = (await post('/api/os/clientes', { codigo: 'ZZ-ACC2', nombre: 'Acceso Dos' })).data.cliente;

      const lista = (await get('/api/os/accesos')).data.clientes || [];
      const f1 = lista.find((x) => x.id === c1.id);
      check('accesos: la pantalla lista a todos con lo que puede hacer cada uno',
        !!f1 && f1.acceso === false && f1.avisa_pagos === true && f1.mover_balance === false
        && f1.chat === false,
        f1 ? `${f1.nombre}: entra con ${f1.entra || 'su código'}` : 'no está');

      const gen = (await post('/api/os/accesos/generar', { ids: [c1.id, c2.id] })).data;
      check('accesos: se le da acceso a varios de una vez',
        gen.ok && gen.generadas === 2 && gen.claves.length === 2
        && gen.claves.every((k) => k.clave && k.clave.length >= 8),
        gen.claves.map((k) => k.cliente).join(', '));
      /* La clave viaja UNA vez y no vuelve: se guarda cifrada. Si volviera a salir en alguna
         respuesta, alcanzaría con mirar la pantalla para llevarse las 45. */
      const dosVeces = (await get('/api/os/accesos')).data.clientes.find((x) => x.id === c1.id);
      check('accesos: la contraseña no vuelve a salir por ningún lado',
        !JSON.stringify(dosVeces).includes(gen.claves[0].clave)
        && dosVeces.acceso === true && !!dosVeces.entra,
        'sólo se ve en el momento de generarla');
      /* Se prueba POR HTTP: el server corre con otra base (DB_PATH), así que el store de este
         proceso no ve al cliente que se creó por la API. */
      const rLogin = await axios.post(BASE + '/api/cuenta/login',
        { usuario: gen.claves[0].usuario, clave: gen.claves[0].clave }, { validateStatus: () => true });
      check('accesos: y con esa clave el cliente entra de verdad',
        rLogin.status === 200 && rLogin.data.ok === true && !!rLogin.data.token,
        'HTTP ' + rLogin.status);
      /* La puerta es pública y la clave son 10 caracteres: sin tope, probarlas todas es gratis. Y
         cada intento cuesta CPU de verdad, así que un aluvión también frena al resto. */
      const victima = 'zz-bruto-' + Date.now();
      let corte = 0;
      for (let i = 0; i < 14; i++) {
        const rr = await axios.post(BASE + '/api/cuenta/login',
          { usuario: victima, clave: 'x' + i }, { validateStatus: () => true });
        if (rr.status === 429) { corte = i + 1; break; }
      }
      check('accesos: probar muchas claves contra UNA cuenta se corta solo',
        corte > 0 && corte <= 12, `cortó al intento ${corte || '(nunca)'}`);
      /* Y el que no tiene nada que ver sigue entrando: el tope por IP es mucho más ancho, si no
         una equivocación de tres personas detrás del mismo internet deja afuera a todas. */
      check('accesos: el tope de uno no deja afuera a los demás',
        (await axios.post(BASE + '/api/cuenta/login',
          { usuario: gen.claves[0].usuario, clave: gen.claves[0].clave },
          { validateStatus: () => true })).status === 200);
      check('accesos: con la clave equivocada no entra, y no dice cuál de los dos falló',
        (await axios.post(BASE + '/api/cuenta/login',
          { usuario: gen.claves[0].usuario, clave: 'otra' }, { validateStatus: () => true }))
          .data.error === 'Usuario o contraseña incorrectos');

      /* Los permisos, también de a varios. Iban por updateCliente, que sólo toca código y nombre:
         se descartaban en silencio y la pantalla mostraba un cambio que no había pasado. */
      await post('/api/os/accesos/permiso', { ids: [c1.id, c2.id], campo: 'mover_balance', valor: true });
      const tras = (await get('/api/os/accesos')).data.clientes;
      check('accesos: un permiso se cambia para varios y QUEDA guardado',
        tras.find((x) => x.id === c1.id).mover_balance === true
        && tras.find((x) => x.id === c2.id).mover_balance === true);
      await post('/api/os/accesos/permiso', { ids: [c1.id], campo: 'avisa_pagos', valor: false });
      check('accesos: y se puede apagar',
        (await get('/api/os/accesos')).data.clientes.find((x) => x.id === c1.id).avisa_pagos === false);
      check('accesos: no se puede tocar cualquier campo del cliente desde acá',
        (await axios.post(BASE + '/api/os/accesos/permiso',
          { ids: [c1.id], campo: 'permite_deuda', valor: true }, H({ validateStatus: () => true })))
          .data.ok !== true);

      /* Quitarle el acceso lo devuelve a entrar con su código: no lo deja afuera del sistema. */
      await post('/api/os/accesos/quitar', { ids: [c1.id] });
      const sinAcc = (await get('/api/os/accesos')).data.clientes.find((x) => x.id === c1.id);
      check('accesos: quitar el acceso lo devuelve a su código, no lo deja afuera',
        sinAcc.acceso === false && sinAcc.entra === null
        && (await axios.post(BASE + '/api/cuenta/login',
          { usuario: gen.claves[0].usuario, clave: gen.claves[0].clave },
          { validateStatus: () => true })).status === 401);

      await axios.delete(BASE + '/api/os/clientes/' + c1.id, H());
      await axios.delete(BASE + '/api/os/clientes/' + c2.id, H());
    }
    // La pantalla existe y hace las cosas de a varios.
    const uiAcc = require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'os.html'), 'utf8');
    check('accesos: hay una pantalla propia y las acciones valen para los marcados',
      /\['accesos','🔐 Accesos'\]/.test(uiAcc) && /VIEWS\.accesos = async/.test(uiAcc)
      && /Dar acceso y generar contraseña/.test(uiAcc) && /accCopiar\(\)/.test(uiAcc));
    check('accesos: la pantalla avisa que la contraseña no se puede volver a ver',
      /No se pueden volver a ver/.test(uiAcc));

    /* ── EL PORTAL DEL CLIENTE, DE PUNTA A PUNTA ─────────────────────────────────────────────
       Contra el server de verdad: se crea el cliente y la caja por la API, se le da el chat, y se
       entra al portal escribiendo el usuario de la caja — que es lo que va a hacer el cliente. */
    {
      const cliP = (await post('/api/os/clientes', { codigo: 'ZZ-PORTAL', nombre: 'Portal Prueba' })).data.cliente;
      const panP = (await post('/api/os/paneles', { cliente_id: cliP.id, nombre: 'Fran44',
        sistema: 'Casino', nivel_usuario: 'SuperAgente', id_usuario: '9990777' })).data.panel;
      await put('/api/os/paneles/' + panP.id, { alias: 'Fran-44' });
      await post('/api/os/chat/paneles', { panel_id: panP.id, pct_cliente: '4', dia_cobro: 10 });

      /* La puerta de los accesos, por HTTP: sin clave contesta 403 y no manda nada. */
      const rAcc = await axios.post(BASE + '/chat/accesos', { usuario: 'Fran44', clave: 'x' },
        { validateStatus: () => true });
      check('portal: pedir los accesos sin la clave no devuelve nada',
        rAcc.status === 403 && rAcc.data.ok === false && !rAcc.data.cajas,
        'HTTP ' + rAcc.status);

      const rPortada = await axios.get(BASE + '/chat', { validateStatus: () => true });
      check('portal: la portada abre sin login y se llama GANAMOS x Latam',
        rPortada.status === 200 && /GANAMOS/.test(String(rPortada.data))
        && /Tu usuario/.test(String(rPortada.data)),
        'HTTP ' + rPortada.status);

      const rNo = await axios.post(BASE + '/chat/entrar', { usuario: 'nadie-asi' }, { validateStatus: () => true });
      check('portal: un usuario que no existe no entra',
        rNo.status === 404 && rNo.data.ok === false);
      /* El mensaje es el MISMO para "no existe" y "no tiene el chat": decir cuál de las dos es
         sería contarle a cualquiera qué usuarios existen. */
      const cliSin = (await post('/api/os/clientes', { codigo: 'ZZ-SINCHAT', nombre: 'Sin chat' })).data.cliente;
      const rSin = await axios.post(BASE + '/chat/entrar', { usuario: 'ZZ-SINCHAT' }, { validateStatus: () => true });
      check('portal: un cliente sin el chat recibe el mismo mensaje que uno que no existe',
        rSin.status === 404 && rSin.data.error === rNo.data.error,
        rSin.data.error);

      const rSi = await axios.post(BASE + '/chat/entrar', { usuario: 'fran44' }, { validateStatus: () => true });
      check('portal: entra con el usuario de su caja, escrito como sea',
        rSi.status === 200 && rSi.data.ok === true && rSi.data.portal.cliente === 'Portal Prueba',
        JSON.stringify((rSi.data.portal || {}).cliente));
      const rAlias = await axios.post(BASE + '/chat/entrar', { usuario: 'Fran-44' }, { validateStatus: () => true });
      check('portal: también entra con el otro nombre de la misma caja',
        rAlias.status === 200 && rAlias.data.ok === true);
      check('portal: ve sus cajas y su saldo, y nada de otro cliente',
        (rSi.data.portal.cajas || []).length === 1 && rSi.data.portal.cajas[0].caja === 'Fran44'
        && rSi.data.portal.saldo && rSi.data.portal.debe === undefined,
        JSON.stringify(rSi.data.portal.cajas));
      /* Lo que NO puede viajar al portal: el costo, el margen, lo que le cobrás a los demás. */
      check('portal: lo que le llega al cliente no trae nada interno',
        !/margen|costo|pct_costo|proveedor/i.test(JSON.stringify(rSi.data.portal)),
        JSON.stringify(rSi.data.portal).slice(0, 90));

      // Pedir un chat nuevo NO da de alta nada: llega como pedido.
      /* El pedido pregunta lo que hace falta para abrir la caja y que sólo sabe el cliente: en qué
         página juega su gente, con qué dominio y en qué moneda. Sin la página no entra: es el dato
         que arranca todo el trámite. */
      check('portal: un pedido sin decir qué página va a usar no entra',
        (await axios.post(BASE + '/chat/nuevo', { usuario: 'Fran44', caja: 'Fran55' },
          { validateStatus: () => true })).data.ok === false);
      const rPide = await axios.post(BASE + '/chat/nuevo',
        { usuario: 'Fran44', caja: 'Fran55', nota: 'para el lunes', pagina: 'Zeus',
          dominio: 'zeus.bet', divisa: 'ars', caja_nueva: true }, { validateStatus: () => true });
      const pend = (await get('/api/os/chat/por-cliente?mes=2026-08')).data.solicitudes || [];
      check('portal: pedir un chat nuevo llega como pedido y no abre nada',
        rPide.data.ok === true && pend.some((x) => x.caja === 'Fran55')
        && !((await get('/api/os/chat/paneles')).data.paneles || []).some((x) => x.panel === 'Fran55'),
        `${pend.length} pedido(s) esperando`);
      const laSol = pend.find((x) => x.caja === 'Fran55');
      check('portal: y lo que contestó el cliente te llega entero',
        !!laSol && laSol.pagina === 'Zeus' && laSol.dominio === 'zeus.bet'
        && laSol.divisa === 'ARS' && laSol.caja_nueva === 1,
        laSol ? `${laSol.pagina} · ${laSol.dominio} · ${laSol.divisa}` : 'sin pedido');
      check('portal: el pedido se marca resuelto y deja de aparecer',
        (await post('/api/os/chat/solicitudes/' + laSol.id, { listo: true })).data.ok === true
        && !((await get('/api/os/chat/por-cliente?mes=2026-08')).data.solicitudes || [])
          .some((x) => x.id === laSol.id));
      // Un pedido sin caja no se guarda: no habría a qué contestarle.
      check('portal: un pedido sin caja no entra',
        (await axios.post(BASE + '/chat/nuevo', { usuario: 'Fran44', caja: '' },
          { validateStatus: () => true })).data.ok === false);

      await axios.delete(BASE + '/api/os/chat/paneles/' + panP.id, H());
      await axios.delete(BASE + '/api/os/paneles/' + panP.id, H());
      await axios.delete(BASE + '/api/os/clientes/' + cliP.id, H());
      await axios.delete(BASE + '/api/os/clientes/' + cliSin.id, H());
    }

    /* ── EL DOMINIO DE LOS LINKS ─────────────────────────────────────────────────────────────
       Sin esto el link sale con el dominio por el que entró quien apretó el botón, así que la
       misma factura salía con dos direcciones distintas según desde dónde se mandara. */
    const cfgUrl = require('../src/config-store');
    check('links: no se acepta un dominio con una ruta pegada',
      cfgUrl.setUrlPublica('app.latamgames.online/os').ok === false);
    check('links: se guarda el dominio y se le pone https solo',
      cfgUrl.setUrlPublica('app.latamgames.online').ok === true
      && cfgUrl.getUrlPublica() === 'https://app.latamgames.online');
    cfgUrl.setUrlPublica('');

    /* ── LA PUERTA PÚBLICA ───────────────────────────────────────────────────────────────────
       Estas dos rutas las abre cualquiera con el link, sin usuario. Se prueban por HTTP contra el
       server de verdad: un token inventado no puede devolver otra cosa que "no está", y avisar un
       pago contra un link muerto no puede reventar. */
    const rTok = await axios.get(BASE + '/chat/no-existe-este-token', { validateStatus: () => true });
    check('chat: un token inventado no abre ninguna hoja',
      rTok.status === 404 && !/USDT/.test(String(rTok.data)),
      'HTTP ' + rTok.status);
    const rPag = await axios.post(BASE + '/chat/no-existe-este-token/pague', { monto: '10' },
      { validateStatus: () => true });
    check('chat: avisar un pago contra un link que no existe se rechaza sin romper nada',
      rPag.status === 404 && rPag.data && rPag.data.ok === false,
      'HTTP ' + rPag.status);
    /* Una captura de verdad pesa más que el límite normal del sistema. Si el pedido se corta antes
       de llegar a la ruta, el cliente ve "no se pudo enviar" con el archivo ya elegido y sin saber
       por qué. Se comprueba que 2 MB LLEGAN (404 = la ruta contestó, no un 413 del parser). */
    const rGrande = await axios.post(BASE + '/chat/no-existe-este-token/pague',
      { monto: '10', archivo: { nombre: 'x.jpg', tipo: 'image/jpeg', base64: 'A'.repeat(2 * 1024 * 1024) } },
      { validateStatus: () => true, maxBodyLength: Infinity, maxContentLength: Infinity });
    check('chat: una captura de 2 MB llega a destino (no la corta el servidor antes)',
      rGrande.status === 404, 'HTTP ' + rGrande.status);

    // La pestaña va en el espacio COMERCIAL: son clientes de Imperia, no de TBS.
    const uiCh = require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'os.html'), 'utf8');
    const navCom = uiCh.slice(uiCh.indexOf('const TABS_COMERCIAL'), uiCh.indexOf('const TABS_TBS'));
    /* EL CHAT TIENE SU PROPIO ESPACIO, como TBS. Metido como una pestaña más del comercial, sus
       pagos y sus pedidos llegaban al medio de todo lo demás y había que ir a buscarlos. */
    const navChat = uiCh.slice(uiCh.indexOf('const TABS_CHAT'), uiCh.indexOf('const ES_TBS'));
    check('chat: tiene su propio espacio, con su propia barra',
      /\['chatcuentas','🧾 Cuentas del mes'\]/.test(navChat)
      && /\['chatcajas','🏷 Cajas y clientes'\]/.test(navChat)
      && /ES_CHAT = location\.pathname/.test(uiCh) && /\/chat-externo/.test(uiCh),
      navChat.replace(/\s+/g, ' ').slice(0, 110));
    check('chat: y ya no es una pestaña perdida adentro del comercial',
      !/\['chat','💬 Chat Externo'\]/.test(uiCh));
    /* Lo que espera una decisión —los pagos avisados y los pedidos de caja— se anuncia en la
       pestaña: si hay que entrar a buscarlo, se atiende tarde. */
    check('chat: los pendientes se cuentan en la pestaña, no hay que ir a buscarlos',
      /\['chatpend', \(\)=>\{ const n=_chatPend\(\)/.test(navChat)
      && /_chatPendN = \(pc\.avisos\|\|\[\]\)\.length \+ \(pc\.solicitudes\|\|\[\]\)\.length/.test(uiCh));
    check('chat: cada pantalla del espacio elige sus tarjetas de un solo lugar',
      /const SUB_CHAT = \{/.test(uiCh) && /cuentas: \['cierre','cuenta'\]/.test(uiCh));
    // El espacio de adentro pide login; /chat (sin guión) es el portal público del cliente.
    const rutasCh = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'os.routes.js'), 'utf8');
    const authCh = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'auth.js'), 'utf8');
    check('chat: el espacio de adentro pide login; el portal del cliente no',
      /app\.get\('\/chat-externo'/.test(rutasCh) && !/chat-externo/.test(authCh));
    // La tabla muestra las dos columnas y el margen: ver sólo el total escondería el caso caro.
    /* Cada número en su renglón, con su nombre: ver sólo el total escondería el caso caro. */
    check('chat: la pantalla muestra lo que cobrás, lo que pagás y lo tuyo por separado',
      /<dt>Le cobrás<\/dt>/.test(uiCh) && /<dt>Pagás al proveedor<\/dt>/.test(uiCh)
      && /<dt>Te queda<\/dt>/.test(uiCh) && /<dt>Ganó<\/dt>/.test(uiCh));
    /* Y cada cliente arranca CERRADO: con cincuenta, abiertos son una pared. Lo que necesita
       atención se ve desde afuera — un problema no puede quedar escondido adentro de una tarjeta. */
    check('chat: cada cliente arranca cerrado y se abre al tocarlo',
      /<details class="plegable">/.test(uiCh) && /<summary class="fila">/.test(uiCh)
      && !/<details class="plegable" open>/.test(uiCh));
    check('chat: lo que necesita atención se ve con la tarjeta cerrada',
      /señal durazno" title="Falta un tipo de cambio/.test(uiCh)
      && /señal rosa" title="Le cobrás menos de lo que te cuesta/.test(uiCh)
      && /señal durazno" title="No le cargaste precio/.test(uiCh));
    /* Un botón lleno por tarjeta: el que hace la cosa. Antes «cobrar el mes» se veía igual que
       «ver una hoja» y nada decía cuál movía plata.
       Y desde que existe `.grave`, ese único botón lleno además va en durazno: «Enviársela» le
       llega de verdad al cliente por Telegram, así que no se puede ver igual que «Calcular». */
    const cuerpoCierre = uiCh.slice(uiCh.indexOf('S.cierre = `'), uiCh.indexOf('S.pedidos = `'));
    check('chat: en cada cliente hay un solo botón lleno, el que manda la cuenta',
      (cuerpoCierre.match(/<button class="grave small"/g) || []).length === 1
      && (cuerpoCierre.match(/<button class="small"/g) || []).length === 0
      && (cuerpoCierre.match(/<button class="outline small"/g) || []).length === 1,
      'el resto va en contorno');
    // La cuenta se manda desde la misma pantalla y queda anotado si salió.
    check('chat: desde la pantalla se ve la hoja y se manda la cuenta',
      /chatHoja\(/.test(uiCh) && /chatEnviar\(/.test(uiCh) && /✓ enviada/.test(uiCh));
    check('chat: la pantalla tiene el bot propio, el grupo de cada cliente y los pagos al proveedor',
      /Bot de Telegram de este servicio/.test(uiCh) && /chatDestino\(/.test(uiCh)
      && /chatPagar\(/.test(uiCh) && /Cobrar el mes/.test(uiCh));
    check('chat: la pantalla deja claro que es otra cuenta, no la de las fichas',
      /La cuenta del chat/.test(uiCh) && /es otra cuenta/.test(uiCh)
      && /ni entra en tu cierre del mes/.test(uiCh)
      && /es de otro negocio/.test(uiCh)
      && /Dónde te pagan/.test(uiCh) && /chatWalletNueva\(/.test(uiCh)
      && /Para el servicio del mes, por defecto/.test(uiCh)
      && /Paga el mantenimiento a/.test(uiCh));
    /* La pantalla no puede depender de que hayas pasado por otra: el desplegable de paneles salía
       vacío hasta visitar 👥 Clientes, y no había forma de empezar a usarla. */
    /* 204 cajas en una lista suelta no se recorren con el ojo: van agrupadas por sistema y
       alfabéticas adentro de cada grupo. */
    check('chat: primero se elige el sistema y después la caja',
      /id="chat-nuevo-sis" onchange="chatFiltrarCajas\(\)"/.test(uiCh)
      && /function chatFiltrarCajas\(\)/.test(uiCh)
      && /localeCompare\(String\(b\.nombre\|\|''\),'es',\{sensitivity:'base',numeric:true\}\)/.test(uiCh));
    check('chat: la pantalla carga los paneles sola',
      /if\(!_paneles\.length\)\{ const dp=await api\('\/api\/os\/paneles'\)/.test(uiCh));
    check('chat: los links, el usuario y la contraseña de cada caja se cargan desde la pantalla',
      /data-campo="link_jugadores"/.test(uiCh) && /data-campo="link_panel"/.test(uiCh)
      && /data-campo="usuario_admin"/.test(uiCh) && /data-campo="clave_admin"/.test(uiCh)
      && /clave_portal:this\.value/.test(uiCh));

    /* ── LOS CAMPOS DE UNA CAJA NO SE GUARDAN SOLOS ──────────────────────────────────────────
       Guardaban al salir de cada campo, y guardar repintaba la pantalla entera: se cerraban
       todas las cajas abiertas. Cargarle a una caja el link, el usuario y la contraseña eran
       tres recorridos. Se escriben los siete y se guarda una vez, sin repintar. */
    /* ── RENOMBRAR TIENE QUE VERSE EN TODOS LADOS ────────────────────────────────────────────
       Un cliente tiene `nombre` y `nombreVisible`. Fichas muestra y editaba SÓLO el segundo; el
       Panel, el Chat y la matriz del cierre muestran el primero. Renombrar desde el lápiz no se
       veía en ninguna otra pantalla: GANAMOS PISTACHO se pasó a «GANAMOS P» y siguió saliendo
       con el nombre viejo en todos lados menos en Fichas. */
    {
      const fichas = (await axios.get(BASE + '/', { headers: { Cookie: cookie } })).data;
      check('fichas: renombrar un cliente escribe los DOS nombres',
        /JSON\.stringify\(\{ codigo, nombre, nombreVisible: nombre \}\)/.test(fichas),
        'el lápiz volvió a escribir sólo nombreVisible y el rename no se vería en el Panel');
    }

    /* Renombrar vivía sólo en el lápiz de Fichas, que es el OTRO espacio: con la ficha del
       cliente abierta en el Panel, ir a buscarlo allá no se le ocurre a nadie. Y desde acá
       también se mandan los dos nombres. */
    {
      // `h10` no existe en este bloque: el panel se pide acá.
      const panel = (await axios.get(BASE + '/os', { headers: { Cookie: cookie } })).data;
      check('panel: se puede renombrar un cliente desde su propia ficha',
        /onclick="renombrarCliente\('\$\{c\.id\}'\)"/.test(panel)
        && /async function renombrarCliente\(id\)/.test(panel)
        && /codigo:codigo\.trim\(\), nombre:nombre\.trim\(\), nombreVisible:nombre\.trim\(\)/.test(panel),
        'o falta el botón, o volvió a escribir un solo nombre');
    }

    /* ── EL NAVEGADOR NO TIENE QUE RELLENAR ESTOS CAMPOS ────────────────────────────────────
       Chrome miró la etiqueta «Dirección» de la wallet, decidió que era un domicilio y le metió
       «Alexa» adentro. Un clic en Agregar y quedaba guardada una wallet cuya dirección es un
       nombre propio — plata mandada a la nada. Y al campo del bot, por ser type=password, le
       ofrecía una contraseña guardada. */
    /* ── LA HOJA DEL CLIENTE ─────────────────────────────────────────────────────────────────
       Se abre en una pestaña nueva, así que la flecha del navegador queda apagada: no hay a
       dónde volver. Y el nombre interno de la caja no le dice al cliente CUÁL es cuando tiene
       varias — el link de jugadores sí. */
    {
      const doc = require('../src/chat-doc');
      const base = { cliente: 'X', mes: '2026-08', monedas: [], total: '10', pct: '4',
        pctUnico: true, paneles: [
          { panel: 'CajaUno', pct: '4', ganancia: '100', cobra: '4', link: 'https://juega.test', monedas: [] },
          { panel: 'CajaDos', pct: '4', ganancia: '50', cobra: '2', link: '', monedas: [] }] };
      const conToken = doc.htmlCliente(base, { token: 'abc' });
      const sinToken = doc.htmlCliente(base, {});
      check('hoja del chat: hay cómo volver, y depende de quién mira',
        /href="\/chat"/.test(conToken) && /window\.close\(\)/.test(sinToken),
        'el cliente vuelve al portal; la dueña cierra la pestaña que abrió el panel');
      /* ── EL % Y EL MANTENIMIENTO SON DOS COBROS DISTINTOS ────────────────────────────────
         La hoja decía «De este mes · 4% de la ganancia» encima del total del mes. Con los datos
         reales de agosto ese total era PURO MANTENIMIENTO en los tres clientes —el % se cobra a
         mes cerrado— así que le decía al cliente que 300 USDT eran el 4% de su ganancia cuando
         eran dos mensualidades de 150. No era un dato repetido: era uno equivocado. */
      const conMant = doc.htmlCliente(base, { saldo: { cobrado: '300', pagado: '0', debe: '300' },
        cobradoMes: '300', movsMes: [
          { tipo: 'mensualidad', panel: 'CajaUno', monto: '150' },
          { tipo: 'mensualidad', panel: 'CajaDos', monto: '150' }] });
      check('hoja del chat: el mantenimiento no se rotula como el % de la ganancia',
        !/De este mes/.test(conMant)
        && /Mantenimiento · CajaUno/.test(conMant) && /Mantenimiento · CajaDos/.test(conMant)
        && /Total del mes/.test(conMant)
        && /todavía no se cobró/.test(conMant),
        'el total del mes volvió a salir rotulado como si fuera el porcentaje');

      const conAmbos = doc.htmlCliente(base, { saldo: { cobrado: '331', pagado: '0', debe: '331' },
        cobradoMes: '331', movsMes: [
          { tipo: 'cobro', panel: 'CajaUno', monto: '181' },
          { tipo: 'mensualidad', panel: 'CajaUno', monto: '150' }] });
      check('hoja del chat: cuando están los dos cobros, se ven los dos',
        /4% de la ganancia/.test(conAmbos) && /Mantenimiento · CajaUno/.test(conAmbos)
        && !/todavía no se cobró/.test(conAmbos),
        conAmbos.includes('181') ? 'ok' : 'falta el renglón del porcentaje');

      check('hoja del chat: cada caja muestra su link de jugadores',
        /juega\.test/.test(sinToken) && !/CajaDos<\/td>\s*<div class="lnk"/.test(sinToken),
        'la caja sin link cargado no tiene que mostrar un renglón vacío');
    }

    /* ── AL PROVEEDOR SE LE PAGAN DOS COSAS ──────────────────────────────────────────────────
       «Le debés del mes» era SÓLO el % sobre la ganancia. El mantenimiento no entraba, y va
       ENTERO al proveedor —a otra wallet y en otras fechas—. Con los datos de agosto la pantalla
       decía 169,44 cuando lo real eran 1.219,44: faltaban los 1.050 de las siete mensualidades. */
    {
      // El bloque de arriba borró las mensualidades: se crea una para tener qué medir.
      const mm = ch.cobrarMensualidad({ cliente_id: CLI.id, panel: 'ZZ-Panel-Chat' });
      const dpv = ch.deudaProveedor('2026-08');
      check('chat: lo que le debés al proveedor incluye el mantenimiento',
        mm.ok
        && Number(dpv.total.debe) === Number(dpv.ganancia.debe) + Number(dpv.mantenimiento.debe)
        && Number(dpv.mantenimiento.debe) > 0,
        `% ${dpv.ganancia.debe} + mantenimiento ${dpv.mantenimiento.debe} = ${dpv.total.debe}`);

      // Y cada pago dice de cuál de los dos es: si no, un saldo a medias no dice qué falta.
      const pg = ch.pagar({ mes: '2026-08', monto: '5', concepto: 'mantenimiento' });
      const dpv2 = ch.deudaProveedor('2026-08');
      check('chat: un pago se imputa al concepto que se eligió',
        pg.ok && Number(dpv2.mantenimiento.pagado) === 5 && Number(dpv2.ganancia.pagado) === 0,
        `mantenimiento pagado ${dpv2.mantenimiento.pagado} · ganancia pagado ${dpv2.ganancia.pagado}`);
      if (pg.ok) ch.borrarPago(pg.pago.id);
      dbCh.prepare("DELETE FROM chat_mov WHERE tipo='mensualidad'").run();
    }

    check('chat: la wallet y los tokens no se autocompletan solos', (() => {
      const inputs = uiCh.match(/<input[^>]*>/g) || [];
      const marcas = ['chat-w-dir', 'chat-w-alias', 'chat-w-red', 'chat-bot',
        'usuario_admin', 'clave_admin', 'clave_portal'];
      return /const NOFILL = 'autocomplete="off"/.test(uiCh)
        && marcas.every((m) => { const el = inputs.find((x) => x.includes(m)); return el && /NOFILL/.test(el); });
    })(), 'algún campo de wallet, token o credencial volvió a quedar autocompletable');

    check('chat: los campos de la caja no guardan solos — hay un botón',
      !/chatSet\('\$\{p\.panel_id\}',\{(pct_cliente|desde|dia_cobro|link_|usuario_admin|clave_admin)/.test(uiCh)
      && /function chatGuardar\(id\)/.test(uiCh)
      && /id="chat-guardar-\$\{p\.panel_id\}" disabled/.test(uiCh),
      'algún campo de la caja volvió a guardar por su cuenta');
    // Y al guardar no se repinta: el único dato que se ve afuera se actualiza a mano.
    check('chat: guardar no repinta la pantalla',
      /const h=document\.getElementById\('chat-pct-'\+id\)/.test(uiCh)
      && !/chatGuardar[^]{0,900}VIEWS\.chat\(\)/.test(uiCh),
      'chatGuardar volvió a repintar y se cierran las cajas abiertas');
    check('chat: y la pantalla explica que la contraseña va detrás de la clave del portal',
      /La contraseña no<\/b>:\s*\n?\s*al portal se entra/.test(uiCh)
      && /clave del portal<\/b> que le pusiste abajo/.test(uiCh));
    check('chat: desde la pantalla se le avisa la mensualidad a cada caja por separado',
      /chatAvisarMens\(/.test(uiCh) && />Avisarle</.test(uiCh)
      && /El aviso se manda <b>de a una<\/b>/.test(uiCh));
    check('chat: los avisos de pago que llegan se ven y se aprueban desde la pantalla',
      /Dicen que pagaron/.test(uiCh) && /chatAviso\(/.test(uiCh)
      && /No mueve el saldo hasta que lo apruebes/.test(uiCh));
    /* Una ficha por cosa, no una fila de tabla: cada una tiene su propio par de botones y en una
       tabla de cinco columnas el «aprobar» de una fila se confunde con el de la de al lado. */
    const pend = uiCh.slice(uiCh.indexOf('S.pedidos = `'), uiCh.indexOf('S.cuenta = `'));
    check('chat: lo que espera decisión va en fichas, con un solo botón lleno cada una',
      (pend.match(/<button class="small"/g) || []).length === 2
      && !/S\.avisos[\s\S]{0,400}<table/.test(pend),
      'uno en cada ficha: acreditar y dar por abierta');
    /* "¿dónde selecciono quiénes tienen el chat?" — estaba al fondo de la pantalla, después de
       tres tarjetas. Ahora es la primera cosa abajo de la configuración y el alta está arriba de
       todo dentro de la tarjeta. */
    const iCfg = uiCh.indexOf('Bot de Telegram de este servicio');
    const iQui = uiCh.indexOf('Quiénes tienen el chat');
    const iCie = uiCh.indexOf('Cierre del mes <span');
    check('chat: "quiénes tienen el chat" se ve antes que el cierre del mes',
      iQui > iCfg && iQui < iCie && iCfg > 0 && iCie > 0,
      `config ${iCfg} · quiénes ${iQui} · cierre ${iCie}`);
    check('chat: agregar una caja está arriba de la lista, no debajo',
      uiCh.indexOf('Agregar una caja al servicio') > iQui
      && uiCh.indexOf('Agregar una caja al servicio') < uiCh.indexOf('A dónde le mando la cuenta'));
    // La cuenta del chat en la pantalla del cliente tiene que llamarse por su nombre.
    const cuentaHtml = require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'cuenta.html'), 'utf8');
    const pedirHtml = require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'pedir.html'), 'utf8');
    /* Y en la pantalla del cliente el chat NO aparece: su cuenta de fichas es la de las fichas. */
    check('chat: la cuenta de fichas del cliente no menciona el chat',
      !/Chat Externo/i.test(cuentaHtml) && !/Chat Externo/i.test(pedirHtml));
  }
  // ── EL PUNTO Y LA COMA: EL ERROR DE LOS 100× ─────────────────────────────────────────────────
  // Un cliente avisó 9.422 USDT por una transferencia de 94,22. No lo escribió mal: escribió
  // "94.22" y el sistema borraba TODOS los puntos antes de leer el número. Y al revés, escribir
  // "94,22" —como se escribe acá— daba NaN y el aviso se rechazaba.
  {
    const { parseMonto, esAmbiguo } = require('../src/lib/monto');
    const casos = [
      ['94.22', 94.22, 'el caso real: punto con 2 dígitos es decimal'],
      ['94,22', 94.22, 'la coma, que antes se rechazaba'],
      ['9422', 9422, 'sin separador'],
      ['200.000', 200000, 'punto con 3 dígitos es de miles'],
      ['1.234,56', 1234.56, 'miles y decimal juntos'],
      ['1,234.56', 1234.56, 'la convención yanqui da lo mismo'],
      ['4.200', 4200, 'los 4200 USDT de un pago real'],
      ['0,5', 0.5, 'menos de uno'],
      ['abc', null, 'basura'],
      ['-5', null, 'negativo'],
      ['', null, 'vacío'],
    ];
    const mal = casos.filter(([t, esp]) => parseMonto(t) !== esp);
    check('monto: la regla del separador resuelve los 11 casos',
      mal.length === 0, mal.map(([t, e]) => `${t} → ${parseMonto(t)} (esperaba ${e})`).join(' · '));
    // Se avisa SÓLO cuando el punto pudo querer decir otra cosa. Preguntar siempre enseña a
    // apretar Aceptar sin leer, y entonces la pregunta deja de servir para nada.
    check('monto: avisa con el punto ambiguo y calla con la coma',
      esAmbiguo('94.22') === true && esAmbiguo('94,22') === false
      && esAmbiguo('200.000') === false && esAmbiguo('9422') === false);

    // Y el camino completo: lo que entra por la ruta pública se guarda interpretado.
    const rp1 = await post('/api/comprobante', { codigo: 'L210', via: 'usdt', monto: '94.22', divisa: 'USDT' });
    check('monto: "94.22" se guarda como 94,22 y no como 9422',
      rp1.status === 200 && Number(rp1.data.comprobante.monto) === 94.22,
      'guardó ' + ((rp1.data.comprobante || {}).monto));
    const rp2 = await post('/api/comprobante', { codigo: 'L210', via: 'usdt', monto: '94,22', divisa: 'USDT' });
    check('monto: con coma ya no se rechaza',
      rp2.status === 200 && Number(rp2.data.comprobante.monto) === 94.22,
      'HTTP ' + rp2.status + ' ' + ((rp2.data.error) || (rp2.data.comprobante || {}).monto));
    // Las dos pantallas usan la misma regla: si una interpreta distinto que el servidor, lo que se
    // muestra y lo que se guarda dejan de ser el mismo número. Y el patrón viejo —borrar todos los
    // puntos— no puede quedar en ninguna de las dos, ni siquiera en el camino de mover fichas.
    const ped3 = require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'pedir.html'), 'utf8');
    const h11 = require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'os.html'), 'utf8');
    check('monto: las dos pantallas usan la misma regla',
      /function montoNum/.test(ped3) && /function montoNum/.test(h11)
      && !/replace\(\/\\\.\/g, ''\)\.replace\(',', '\.'\)/.test(ped3));
    check('monto: mandan el número interpretado, no el texto crudo',
      /const monto = String\(n\);/.test(ped3) && /monto: nu == null \? u : String\(nu\)/.test(h11));
    // Mover fichas tenía el MISMO bug: "94.22" movía 9422 fichas.
    check('monto: mover fichas también usa la regla',
      /const monto = montoNum\(crudoMov\);/.test(ped3));
  }

  // ── EL REPORTE DIARIO DE TBS ─────────────────────────────────────────────────────────────────
  // Casino y Europa tienen su acumulado diario; TBS no, porque cada consulta tarda ~54s y armar el
  // mes en vivo son 31 llamadas. Se captura una vez por día y queda guardado.
  {
    const tbsd = require('../src/tbs-diario-store');
    // ⚠️ TABLA APARTE, y esto es lo más importante de todo el bloque. En el motor 463 se guarda
    // in/out (fichas cargadas y retiradas); en TBS bet/win (apostado y ganado). Escribir bet en la
    // columna `in` haría que el Pulso sume apuestas como si fueran cargas, y ninguna pantalla lo
    // delataría — es exactamente la forma del bug de los espejos, que tardó dos meses en salir.
    const { db: dbt } = require('../src/db');
    const colsTbs = dbt.prepare('PRAGMA table_info(tbs_diario)').all().map((x) => x.name);
    check('tbs diario: tiene su propia tabla con bet/win, no in/out',
      colsTbs.includes('bet') && colsTbs.includes('win') && colsTbs.includes('profit')
      && !colsTbs.includes('in_amt'), colsTbs.join(','));
    const rd = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'tbs-diario-store.js'), 'utf8');
    check('tbs diario: no escribe en la tabla del motor 463',
      !/reporte_diario/.test(rd.replace(/\/\*[\s\S]*?\*\//g, '')));

    // Un día se puede recapturar y tiene que REEMPLAZAR: el panel corrige datos de días pasados.
    const dia = '2020-01-15';   // fecha vieja a propósito: no choca con datos reales
    tbsd.guardarDia(dia, [
      { agente_id: 'TOTAL', login: 'TOTAL', moneda: 'ARS', bet: 1000, win: 400, profit: 600, salas: 3 },
      { agente_id: '999', login: 'Prueba', moneda: 'ARS', bet: 500, win: 200, profit: 300, salas: 1 },
    ]);
    tbsd.guardarDia(dia, [
      { agente_id: 'TOTAL', login: 'TOTAL', moneda: 'ARS', bet: 2000, win: 400, profit: 1600, salas: 3 },
    ]);
    const m = tbsd.delMes('2020-01');
    // Sólo quedan CLIENTES: el TOTAL del árbol no es uno, y sumarlo con ellos contaría todo dos
    // veces. Las filas viejas con ese id se ignoran al leer.
    check('tbs diario: recapturar un día reemplaza, no suma',
      m.clientes.length === 0, JSON.stringify({ cl: m.clientes.length }));
    tbsd.guardarDia('2020-01-20', [
      { agente_id: '77', login: 'Cli', moneda: 'ARS', bet: 100, win: 40, profit: 60, salas: 1 },
      { agente_id: 'TOTAL', login: 'TOTAL', moneda: 'ARS', bet: 999, win: 0, profit: 999, salas: 9 },
    ], 500);
    const m2 = tbsd.delMes('2020-01');
    check('tbs diario: el total del árbol no se mezcla con los clientes',
      m2.clientes.length === 1 && m2.clientes[0].login === 'Cli' && m2.clientes[0].profit === 60,
      JSON.stringify(m2.clientes.map((c) => c.login + ':' + c.profit)));
    // Cada cliente trae su día a día: es la pregunta que el reporte tiene que contestar.
    check('tbs diario: cada cliente trae el profit de cada día',
      m2.clientes[0].dias['2020-01-20'] && m2.clientes[0].dias['2020-01-20'].profit === 60,
      JSON.stringify(m2.clientes[0].dias));
    tbsd.borrarDia('2020-01-20');
    check('tbs diario: dice qué días ya están', tbsd.diasCapturados('2020-01').join() === dia);
    // La captura ya no pide ni guarda el total del árbol: 53 monedas por día de cuentas que no son
    // nuestras, para una pregunta que es sobre nuestros clientes.
    const rtT = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'os.routes.js'), 'utf8');
    check('tbs diario: la captura no guarda el total del árbol',
      !/agente_id: 'TOTAL'/.test(rtT));
    check('tbs diario: se puede borrar un día para rehacerlo', tbsd.borrarDia(dia) >= 1
      && tbsd.diasCapturados('2020-01').length === 0);

    // El plan dice qué falta y cuánto va a tardar, MEDIDO. La primera versión estimaba con una
    // constante de 54s —el tiempo de una consulta de un MES entero— y daba 28 minutos para algo
    // que tarda dos: con ese número, la decisión razonable era no hacerlo nunca.
    const plan = await get('/api/os/tbs/diario/plan?mes=2020-01');
    check('tbs diario: el plan dice qué días faltan',
      plan.status === 200 && plan.data.faltan.length === 31,
      JSON.stringify({ f: (plan.data.faltan || []).length }));
    check('tbs diario: sin nada medido no inventa un tiempo',
      plan.data.segundos_estimados === null && plan.data.medido_en === 0,
      JSON.stringify({ seg: plan.data.segundos_estimados, medido: plan.data.medido_en }));
    // Con un día medido, el promedio sale de ese número. Se comprueba EN PROCESO y no por HTTP:
    // el servidor de pruebas corre con otra base, así que una escritura de acá no la ve — mezclar
    // las dos cosas da un check que falla sin que nada esté roto.
    tbsd.guardarDia('2020-01-02', [{ agente_id: 'TOTAL', moneda: 'ARS', bet: 1, win: 0, profit: 1, salas: 1 }], 3000);
    check('tbs diario: el tiempo sale de lo medido, no de una constante',
      tbsd.msPromedio() === 3000, 'promedio=' + tbsd.msPromedio());
    tbsd.borrarDia('2020-01-02');
    const rtP = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'os.routes.js'), 'utf8');
    check('tbs diario: el plan estima con el promedio medido',
      /const ms = tbsDiario\.msPromedio\(\);/.test(rtP)
      && /segundos_estimados: ms \? Math\.ceil\(\(faltan\.length \* ms\) \/ 1000\) : null/.test(rtP));
    // No se piden días que todavía no pasaron: vendrían vacíos y habría que rehacerlos.
    const rt4 = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'os.routes.js'), 'utf8');
    check('tbs diario: el plan no pide días del futuro',
      /Math\.min\(ult, hoy\)/.test(rt4));
    // La captura vive en el SERVICIO: el cron nocturno y el botón piden lo mismo, y dos copias de
    // "cómo se arma un día" es cómo una se queda vieja sin que nadie lo note.
    const svc = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'tbs-diario.service.js'), 'utf8');
    check('tbs diario: capturar el mismo día dos veces no lo vuelve a pedir sin querer',
      /if \(!refrescar && tbsDiario\.diasCapturados/.test(svc));
    check('tbs diario: la ruta y el cron usan la misma captura',
      /tbsDiarioSvc\.capturarDia\(/.test(rt4) && /await capturarDia\(\{ fecha: ayer/.test(svc));

    // El total por divisa suma HOJAS: en TBS un padre trae su subárbol adentro.
    const ta = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'tbs-api.js'), 'utf8');
    check('tbs: el total por divisa reusa la suma de hojas, no recorre de nuevo',
      /async function totalPorDivisa/.test(ta)
      && /sumarPorDivisa\(\{ tree: r\.data\.tree \|\| \[\] \}\)/.test(ta));

    // ⚠️ EL DÍA SE PIDE UNA VEZ. La respuesta trae el árbol entero: el total por divisa y el
    // desglose por agente son dos LECTURAS del mismo árbol, no dos consultas. La primera versión
    // llamaba a las dos funciones seguidas — 108 segundos por día en vez de 54, y un mes de 56
    // minutos en vez de 28, preguntando dos veces exactamente lo mismo.
    check('tbs: hay una función que trae todo el día de una sola llamada',
      /async function diaCompleto/.test(ta)
      && /porDivisa: sumarPorDivisa\(\{ tree: raiz \}\), porAgente, faltantes/.test(ta));
    check('tbs diario: la captura hace UNA llamada al panel, no dos',
      (svc.match(/await t\.cli\./g) || []).length === 1 && /diaCompleto/.test(svc),
      'llamadas=' + ((svc.match(/await t\.cli\./g) || []).length));
    // Y la captura anota cuánto tardó: es de donde sale la estimación.
    check('tbs diario: cada captura anota su duración',
      /const ms = Date\.now\(\) - t0;/.test(svc) && /guardarDia\(f, filas, ms\)/.test(svc));

    // ── EL CRON DIARIO ────────────────────────────────────────────────────────────────────
    // TBS corta sus días en la zona del PANEL (GMT+2). Preguntarle "ayer" según la hora de acá
    // pediría un día que allá no terminó, y el día quedaría partido.
    check('tbs diario: el cron usa la zona del panel, no la nuestra',
      /const TZ_PANEL = process\.env\.TBS_TZ \|\| 'Africa\/Blantyre'/.test(svc)
      && /timeZone: TZ_PANEL/.test(svc));
    check('tbs diario: se dispara a las 6 de esa zona',
      /Number\(process\.env\.TBS_CRON_HOUR \|\| '6'\)/.test(svc)
      && /if \(horaPanel\(\) !== H \|\| _ultimo === hoy\) return;/.test(svc));
    // El intervalo corre cada 5 minutos: sin el guard entraría doce veces dentro de la misma hora.
    check('tbs diario: no se dispara doce veces dentro de la misma hora',
      /_ultimo = hoy;/.test(svc));
    // Un hueco que no se tapa queda para siempre: nadie mira un mes viejo hasta que lo necesita.
    check('tbs diario: el cron tapa los huecos del mes, no sólo ayer',
      /sanados \+= 1/.test(svc) && /if \(f >= hoy \|\| listos\.has\(f\)\) continue;/.test(svc));
    const svcTbs = require('../src/tbs-diario.service');
    check('tbs diario: ayer es el día anterior en la zona del panel',
      /^\d{4}-\d{2}-\d{2}$/.test(svcTbs.ayerPanel())
      && new Date(svcTbs.hoyPanel()) - new Date(svcTbs.ayerPanel()) === 86400000,
      svcTbs.ayerPanel() + ' → ' + svcTbs.hoyPanel());
  }

  // ── BUZÓN Y HISTORIAL SON DOS COSAS ──────────────────────────────────────────────────────────
  // 🔔 Pendientes y los botones de 👥 Clientes llamaban a las MISMAS funciones y mostraban lo
  // mismo: las listas completas, con las aprobadas y rechazadas adentro. O sea que una de las dos
  // pantallas no servía, y peor: en el buzón había que buscar lo que falta entre lo que ya se hizo.
  {
    const h10 = require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'os.html'), 'utf8');
    check('pendientes: las listas saben si son buzón o historial',
      /async function solicitudesCaja\(soloPendientes\)/.test(h10)
      && /async function movimientosPanel\(soloPendientes\)/.test(h10));
    // El modo se DEDUCE de la pestaña: pasándolo a mano, algún refresco se lo iba a olvidar y la
    // lista volvería al historial completo justo después de aprobar una.
    check('pendientes: el modo sale de la pestaña, no se pasa a mano',
      (h10.match(/if\(soloPendientes===undefined\) soloPendientes = \(_tab==='pendientes'\);/g) || []).length === 2);
    check('pendientes: el buzón pide sólo lo que espera',
      /'\/api\/os\/solicitudes-caja'\+\(soloPendientes\?'\?estado=pendiente':''\)/.test(h10)
      && /ms=ms\.filter\(m=>\['pendiente','a_medias','ejecutando'\]\.includes\(m\.estado\)\)/.test(h10));
    // Un movimiento A MEDIAS entra al buzón: ahí las fichas están a mitad de camino.
    check('pendientes: lo que quedó a medias cuenta como pendiente',
      /'pendiente','a_medias','ejecutando'/.test(h10));
    // Y en Clientes se dice que eso es el historial, para que no parezca lo mismo.
    check('clientes: los botones aclaran que son el historial',
      (h10.match(/\(historial\)/g) || []).length >= 2 && /se atiende en 🔔 Pendientes/.test(h10));

    /* ── LO QUE SALE PARA AFUERA NO SE PUEDE VER IGUAL QUE «CALCULAR» ────────────────────────
       «Calcular» y «Emitir a la deuda» eran el MISMO botón violeta, uno al lado del otro: uno se
       aprieta cien veces sin consecuencia y el otro le manda una factura a todos los clientes.
       `.grave` los separa. Si mañana alguien agrega otra emisión, este chequeo la reclama. */
    /* ── CONGELAR EL MES TIENE QUE VERSE ─────────────────────────────────────────────────────
       Estuvo adentro de un `<div style="display:none">` desde el 21/08/2026 y nadie lo notó: se
       agregó #ext-emi-out, hubo que cerrar el flex de los controles, y el <span> que quedaba
       suelto terminó envuelto en un div escondido. Sin congelar, la factura se calcula con los
       precios de HOY: tocar un % hoy cambia lo que ya cobraste el mes pasado, y el propio
       servidor contesta al emitir «conviene congelar el mes primero». */
    /* ── EL PUNTO CIEGO DEL GUARANÍ, OTRA VEZ ────────────────────────────────────────────────
       El casino sólo contesta por las monedas que le nombrás; las que no le nombrás vuelven SIN
       montos y en silencio. Por eso el reporte de proveedores no puede ofrecer una lista escrita
       a mano: tenía diez y dejaba afuera PYG (33 cajas) y COP (23), así que salía incompleto y
       parecía completo. Sale de lo que declaran las cajas. */
    /* ── EN TBS UN PADRE TRAE SU SUBÁRBOL ADENTRO ────────────────────────────────────────────
       Se capturan los agentes que le interesan a la dueña y alguno cuelga de otro que también se
       captura (hoy MULT2-CAL-ARS-PROD de NachoAPI). Cada fila por separado está bien; SUMARLAS
       todas cuenta a ese dos veces — el total daba 6.302.228 USDT cuando lo real son 5.360.000.
       La marca la pone el servidor (`dentroDe`) para que ninguna pantalla tenga que acordarse. */
    check('tbs: el que cuelga de otro capturado viene marcado, y el total lo saltea',
      /c\.dentroDe\b/.test(h10) && /if \(c\.dentroDe\) continue;/.test(h10),
      'el total del reporte diario de TBS volvería a contar dos veces');

    check('reportes: las monedas salen de las cajas, no de una lista escrita a mano',
      !/\['ARS','BRL','CLP','DOP','EUR','MXN','PEN','USD','UYU','VEF'\]/.test(h10)
      && /_paneles\.forEach\(p=>\(p\.divisas\|\|\[\]\)\.forEach/.test(h10),
      'volvió una lista fija de monedas al reporte de proveedores');

    check('externos: el botón de congelar el mes está a la vista', (() => {
      // `cieExternos` arma la pantalla como UNA sola cadena. Así que basta con mirar el tramo que
      // va del arranque de la función hasta el botón: cualquier `display:none` ahí adentro lo está
      // tapando. Mirar «cuántos caracteres antes» no servía — depende de cómo quede el HTML.
      const i = h10.indexOf('async function cieExternos');
      const j = h10.indexOf('extCongelar(', i);
      if (i < 0 || j < 0) return false;
      // Sin los comentarios: el que explica ESTE arreglo cita el `display:none` que lo tapaba, y
      // el chequeo se tropezaba con su propia explicación.
      const tramo = h10.slice(i, j).replace(/\/\*[^]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
      return !tramo.includes('display:none');
    })(), 'extCongelar quedó adentro de algo escondido');

    check('los botones que emiten o mandan van en .grave, no en el violeta de todos los días',
      /button\.grave \{/.test(h10)
      && ['venEmitir(false)', 'pagoEmitir()', 'extEmitir()', 'facEmitir()', 'chatCobrar()', 'chatEnviar(']
           .every((fn) => {
             // Se busca el ONCLICK, no el nombre suelto: `facEmitir()` aparece antes como
             // `async function facEmitir()` y mirar hacia atrás desde ahí caía en otro botón.
             const i = h10.indexOf('onclick="' + fn);
             if (i < 0) return false;
             // el <button ...> que lo dispara: se mira hacia atrás hasta abrir la etiqueta
             const tag = h10.slice(h10.lastIndexOf('<button', i), i);
             return /class="[^"]*\bgrave\b/.test(tag);
           }),
      'alguna emisión quedó con el botón de todos los días');
  }

  // ── LA CUENTA DE CADA CLIENTE, RENGLÓN POR RENGLÓN ───────────────────────────────────────────
  // El saldo solo no alcanza para hablar con el cliente: cuando pregunta "¿por qué debo esto?" hay
  // que poder abrir el renglón. Estaba el TOTAL (en la tabla de Clientes y en su ficha) pero no de
  // qué estaba hecho — para eso había que ir a la lista global de movimientos, mezclada con todos.
  {
    const perf = await get('/api/os/clientes/' + cli.id + '/perfil?meses=3');
    check('perfil: trae los movimientos que arman la deuda',
      perf.status === 200 && Array.isArray(perf.data.movimientos) && perf.data.movimientos.length > 0,
      'n=' + ((perf.data.movimientos || []).length));
    const mv = (perf.data.movimientos || [])[0] || {};
    check('perfil: cada movimiento trae con qué explicarlo',
      'fecha' in mv && 'tipo' in mv && 'monto_usdt' in mv && 'tc' in mv && 'notas' in mv,
      JSON.stringify(Object.keys(mv)));
    // Vienen del store, así que un pago que espera el TC del mes ya figura valuado y marcado.
    check('perfil: un pago que espera el TC se marca como tal',
      (perf.data.movimientos || []).every((m) => typeof m.tc_pendiente === 'boolean'));
    const h9 = require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'os.html'), 'utf8');
    check('perfil: la ficha muestra la cuenta corriente con sus renglones',
      /💳 Cuenta corriente/.test(h9) && /r\.movimientos\.map/.test(h9)
      && /Proveedores externos/.test(h9));
  }

  // ── AL CLIENTE SE LE DICE LA DIFERENCIA, EN UNA LÍNEA ────────────────────────────────────────
  // Declaró 300.000 y se le acreditaron 205.000: sin la aclaración recibe un mensaje con un número
  // distinto al que avisó y tiene que darse cuenta solo. Si no se da cuenta, la pregunta llega
  // igual, más tarde y peor.
  {
    const tg3 = require('../src/telegram');
    const q = (x) => x.replace(/<[^>]+>/g, '');
    const dif = q(tg3.abonoText({ monto: '205000', moneda: 'ARS', declarado: '300000' }));
    check('abono: cuando difiere, le dice lo que había avisado',
      /205\.000 ARS/.test(dif) && /habías avisado 300\.000 ARS/.test(dif)
      && dif.split('\n').length === 3, JSON.stringify(dif));
    // Cuando coinciden NO aparece: sería ruido en todos los pagos para explicar el caso raro.
    const igual = q(tg3.abonoText({ monto: '205000', moneda: 'ARS', declarado: null }));
    check('abono: cuando coinciden, no agrega ninguna línea',
      !/habías avisado/.test(igual) && igual.split('\n').length === 2, JSON.stringify(igual));
    // Y la decisión de cuándo mandarla vive en la ruta, con las dos condiciones que importan:
    // que difiera de verdad, y que sea la MISMA moneda (comparar entre monedas no dice nada).
    const idx7 = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'index.js'), 'utf8');
    check('abono: sólo se aclara si difiere y es la misma moneda',
      /String\(c\.divisa \|\| mon\)\.toUpperCase\(\) === mon/.test(idx7)
      && /Math\.abs\(Number\(c\.monto\) - Number\(m\[propia\]\)\) > 0\.009/.test(idx7));
  }

  // ── LO DECLARADO Y LO ACREDITADO SON DOS NÚMEROS ─────────────────────────────────────────────
  // El cliente escribe 300.000 y el comprobante dice 205.000: se acredita el del comprobante. Ese
  // número quedaba SÓLO adentro del movimiento —registrado pero invisible— y la tarjeta mostraba
  // el declarado y un id, así que para saber qué se cobró de verdad había que ir a buscarlo.
  {
    const cmps = (await get('/api/os/comprobantes?estado=aprobado')).data.comprobantes || [];
    const conMov = cmps.find((c) => c.movimiento_id);
    check('comprobantes: el aprobado trae lo que se acreditó, no sólo lo declarado',
      !!conMov && conMov.acreditado != null && !!conMov.acreditado_moneda,
      JSON.stringify(conMov ? { dec: conMov.monto, acr: conMov.acreditado, mon: conMov.acreditado_moneda } : null));
    // En la moneda en que PAGÓ: comparar 205.000 contra 300.000 es inmediato; contra USDT no.
    const rt3 = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'os.routes.js'), 'utf8');
    check('comprobantes: lo acreditado viene en la moneda del comprobante',
      /const enUsdt = c\.via === 'usdt';[\s\S]{0,200}const propio = enUsdt \? m\.monto_usdt : m\.monto_ars/.test(rt3));
    const h8 = require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'os.html'), 'utf8');
    check('comprobantes: la tarjeta marca cuando declarado y acreditado no coinciden',
      /el cliente había declarado/.test(h8)
      && /Math\.abs\(Number\(c\.acreditado\) - Number\(c\.monto\)\) > 0\.009/.test(h8));
  }

  // ── EL COMPROBANTE TAMBIÉN VA AL GRUPO DEL CLIENTE ───────────────────────────────────────────
  // Lo pidieron los clientes: quieren el respaldo —el recibo con su hora y su fecha— en la misma
  // conversación donde ven sus cargas, sin depender de que alguien se lo reenvíe.
  {
    const idx6 = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'index.js'), 'utf8');
    check('abono: al grupo del cliente le va el archivo, no sólo el texto',
      /r = await telegram\.sendArchivo\(tok, dest\.chatId, \{/.test(idx6)
      && /caption: telegram\.abonoText\(a\)/.test(idx6));
    check('abono: sin archivo sigue yendo el texto solo',
      /\} else r = await telegram\.sendMessage\(tok, dest\.chatId, telegram\.abonoText\(a\)\);/.test(idx6));
    // ⚠️ El blob se lee UNA vez para los dos avisos, y la variable tiene que estar en un alcance
    // donde el segundo la vea: declarada adentro del else, la llamada de abajo reventaba.
    const fn = idx6.slice(idx6.indexOf('async function avisarComprobante'), idx6.indexOf('async function avisarAbonoAlCliente'));
    const iDecl = fn.indexOf('const conArchivo = comprobantes.get(c.id, true);');
    const iElse = fn.indexOf('} else {');
    check('abono: el archivo se lee una vez y en un alcance que los dos avisos ven',
      iDecl > 0 && (iElse < 0 || iDecl < iElse)
      && (fn.match(/comprobantes\.get\(c\.id, true\)/g) || []).length === 1,
      'decl=' + iDecl + ' else=' + iElse + ' lecturas=' + (fn.match(/comprobantes\.get\(c\.id, true\)/g) || []).length);
    check('abono: el reintento sólo-cliente puede leer el archivo por su cuenta',
      /const arch = conArchivo !== undefined \? conArchivo : comprobantes\.get\(c\.id, true\)/.test(idx6));
  }

  // ── UN COMPROBANTE QUE NO SUBE NO PUEDE PASAR DESAPERCIBIDO ──────────────────────────────────
  // Pasó de verdad: el cliente adjuntó un PDF, el archivo no salió del teléfono, el aviso entró
  // igual y él vio "✅ Pago avisado" — del otro lado apareció "SIN comprobante". El sistema guarda
  // PDFs perfectamente; lo que faltaba era darse cuenta de que no llegó nada.
  {
    // El store acepta PDF, no sólo imágenes. Si esto se rompe, se rompe en silencio.
    const cps = require('../src/comprobantes-store');
    const pdf = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF');
    const rp = cps.crear({ codigo: 'L210', clienteNombre: 'Lu', via: 'cvu', monto: '1000', divisa: 'ARS',
      archivo: { nombre: 'recibo.pdf', tipo: 'application/pdf', base64: pdf.toString('base64') } });
    check('comprobante: un PDF se guarda igual que una foto',
      rp.ok && Number(rp.comprobante.archivo_bytes) === pdf.length
      && rp.comprobante.archivo_tipo === 'application/pdf',
      JSON.stringify(rp.ok ? { b: rp.comprobante.archivo_bytes, t: rp.comprobante.archivo_tipo } : rp.error));

    // La respuesta le dice a la pantalla cuántos bytes se guardaron: sin eso no puede darse cuenta.
    const idx5 = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'index.js'), 'utf8');
    check('comprobante: la respuesta dice si el archivo llegó',
      /archivo_bytes: c\.archivo_bytes \|\| 0/.test(idx5));
    const ped2 = require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'pedir.html'), 'utf8');
    check('comprobante: la pantalla avisa si adjuntó y no subió',
      /const sinArchivo = f && !Number\(\(d\.comprobante \|\| \{\}\)\.archivo_bytes\)/.test(ped2)
      && /el comprobante NO se subió/.test(ped2));
    // Un archivo que se lee vacío no se manda como si nada.
    check('comprobante: un archivo vacío no se manda en silencio',
      /if \(!b64\) return rej\(new Error\('el archivo llegó vacío/.test(ped2));

    // Y el permiso de mover fichas, junto al otro permiso — no enterrado en "datos de referencia".
    const h6 = require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'os.html'), 'utf8');
    const iAvisa = h6.indexOf('Puede avisar pagos');
    const iMover = h6.indexOf('Puede mover fichas');
    // El TÍTULO de la sección, no la frase suelta: el comentario que explica la mudanza la nombra.
    const iFicha = h6.indexOf('<h2>🧾 Ficha de cobro');
    check('permisos: mover fichas está junto a avisar pagos, no en "datos de referencia"',
      iMover > 0 && iAvisa > 0 && Math.abs(iMover - iAvisa) < 1200 && iMover < iFicha,
      'avisa=' + iAvisa + ' mover=' + iMover + ' seccion-ficha=' + iFicha);
  }

  // ── QUIÉN SE NOMBRA EN EL AVISO DE COBRANZA ──────────────────────────────────────────────────
  // El grupo de PESOS reconcilia por vendedor —tres nombres, no cuarenta— así que ahí va sólo el
  // vendedor y el cliente no se nombra. En USDT van los dos, vendedor arriba y cliente abajo.
  // El vendedor es el de MÁS ARRIBA: los que cuelgan de Juli entran como Alexa (lo decidió la dueña).
  {
    const tg2 = require('../src/telegram');
    const sinTags = (x) => x.replace(/<[^>]+>/g, '');
    const ars = sinTags(tg2.pagoText({ vendedor: 'Alexa', cliente: null, monto: '840000', moneda: 'ARS' }));
    check('aviso ARS: nombra al vendedor y NO al cliente',
      /Alexa/.test(ars) && !/Lucia/.test(ars) && /840\.000 ARS/.test(ars), JSON.stringify(ars));
    const usdt = sinTags(tg2.pagoText({ vendedor: 'Alexa', cliente: 'Fran', monto: '4200', moneda: 'USDT' }));
    check('aviso USDT: vendedor arriba y cliente abajo',
      usdt.indexOf('Alexa') < usdt.indexOf('Fran') && /4\.200 USDT/.test(usdt), JSON.stringify(usdt));
    // Un cliente sin vendedor no puede quedar sin ningún nombre: se lo nombra a él.
    const solo = sinTags(tg2.pagoText({ vendedor: 'Titan', cliente: null, monto: '100', moneda: 'USDT' }));
    check('aviso: sin vendedor se nombra al cliente, nunca queda anónimo', /Titan/.test(solo));

    // La cadena se sube ENTERA y no un escalón: Fran cuelga de Juli y Juli de Alexa.
    const td = require('../src/telegram-destino');
    const padron = { v1: { id: 'v1', nombre: 'Juli', vendedor_id: 'v2' }, v2: { id: 'v2', nombre: 'Alexa' } };
    check('vendedor: se sube toda la cadena, no un escalón',
      td.vendedorPrincipal({ id: 'c1', nombre: 'Fran', vendedor_id: 'v1' }, (id) => padron[id]) === 'Alexa');
    check('vendedor: un cliente directo no tiene vendedor',
      td.vendedorPrincipal({ id: 'c2', nombre: 'Solo' }, () => null) === null);
    // Si alguien queda como vendedor de su propio vendedor, esto NO puede colgarse: colgar el
    // aviso de un pago ya acreditado es peor que no encontrar el nombre.
    const ciclo = { a: { id: 'a', nombre: 'A', vendedor_id: 'b' }, b: { id: 'b', nombre: 'B', vendedor_id: 'a' } };
    check('vendedor: un ciclo no cuelga el aviso',
      ['A', 'B'].includes(td.vendedorPrincipal({ id: 'x', nombre: 'X', vendedor_id: 'a' }, (id) => ciclo[id])));

    // Y la ruta: pesos sin cliente, dólares con los dos.
    const idx4 = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'index.js'), 'utf8');
    check('aviso: la regla vive en la ruta, no en el texto',
      /vendedorPrincipal\(cli/.test(idx4) && /cliente: enUsdt && vend \? nombre : null/.test(idx4));
  }

  // ── LOS ESPEJOS DE CARGA NO SON UNA FUENTE DE REPORTES ───────────────────────────────────────
  // `Europa_Fichas` y `Casino_Fichas` son otra credencial al MISMO casino: existen para cargar
  // fichas y lo dice su campo `carga_de`. El acumulado capturaba por TODAS las conexiones 463, así
  // que cada nodo quedaba guardado dos veces con los mismos números. Verificado en producción:
  // Beting-SA con 410.080.611 idénticos en las dos, y 115 paneles listados "sin cliente asignado"
  // que sí tenían dueño, porque el panel vive en la conexión principal y la fila entraba por la
  // espejo — la clave `conexion:nodo` nunca cruzaba.
  {
    const acu = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'acumulado.service.js'), 'utf8');
    check('acumulado: no captura por los espejos de carga',
      /if \(String\(cx\.carga_de \|\| ''\)\.trim\(\)\) continue;/.test(acu));
    const pul = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'pulso.service.js'), 'utf8');
    // El filtro va también en la LECTURA: las filas duplicadas viejas siguen en la base.
    check('pulso: ignora lo que ya se guardó por un espejo',
      /function conexionesDeLectura/.test(pul)
      && !/SELECT id FROM casino_conexiones'\)\.all\(\)\.map/.test(pul.replace(/catch[\s\S]*?\}/g, '')),
      'quedó alguna lectura sin filtrar');
    // Se aplica en TODAS las lecturas de series, no en una: el pulso y la tendencia usan la misma.
    check('pulso: el filtro se usa en todas las lecturas de series',
      (pul.match(/conexionesDeLectura\(\)/g) || []).length >= 3);
  }

  // Borrar no se deshace. La limpieza SIMULA salvo que se pida a propósito, y nunca toca una fila
  // del espejo que no tenga su par del lado principal: sería el único registro de ese día.
  {
    const rd = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'reporte-diario-store.js'), 'utf8');
    check('limpiar espejos: simula salvo que se pida borrar',
      /function limpiarEspejos\(\{ simular = true \} = \{\}\)/.test(rd)
      && /if \(!simular && conPar\)/.test(rd));
    check('limpiar espejos: sólo borra lo que tiene par del lado principal',
      /AND EXISTS \(SELECT 1 FROM reporte_diario p WHERE p\.conexion_id=\?/.test(rd)
      && /sinPar: total - conPar/.test(rd));
    const rt2 = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'os.routes.js'), 'utf8');
    check('limpiar espejos: la ruta exige confirmar:true para borrar',
      /const simular = !\(\(req\.body \|\| \{\}\)\.confirmar === true\)/.test(rt2));
    // Y de punta a punta: sin confirmar no puede borrar nada.
    const sim = await post('/api/os/casino/acumulado/limpiar-espejos', {});
    check('limpiar espejos: sin confirmar no borra',
      sim.status === 200 && sim.data.simulado === true && sim.data.borradas === 0,
      JSON.stringify(sim.data).slice(0, 120));
  }

  // ── 🔔 LO QUE ESPERA UNA DECISIÓN, EN UN SOLO LUGAR ──────────────────────────────────────────
  // Comprobantes, cajas y movimientos de fichas necesitan que alguien diga que sí, y vivían en
  // pantallas distintas detrás de botones que había que ir a buscar: se atendían cuando el cliente
  // reclamaba. Ahora hay una pestaña con el total, la primera de la barra.
  {
    const h5 = require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'os.html'), 'utf8');
    check('pendientes: la pestaña existe y es la primera',
      /\['pendientes', \(\)=>/.test(h5)
      && h5.indexOf("['pendientes'") < h5.indexOf("['acumulado'"),
      'orden en la barra');
    check('pendientes: cuenta las TRES cosas',
      /_pendTotal/.test(h5) && /comprobantes\?estado=pendiente/.test(h5)
      && /solicitudes-caja\?estado=pendiente/.test(h5) && /movimientos-panel/.test(h5));
    // En serie, la más lenta retrasa el número de la barra. Y si una falla, las otras se cuentan.
    check('pendientes: las tres se piden en paralelo y una falla no tumba a las otras',
      /Promise\.all/.test(h5) && (h5.match(/\.catch\(\(\) => null\)/g) || []).length >= 3);
    // Los movimientos A MEDIAS son los que más urgen: las fichas ya salieron del panel del cliente.
    check('pendientes: los movimientos a medias cuentan como pendientes',
      /requierenAtencion/.test(h5));
    // Reusa las funciones que ya aprueban. Reescribirlas para dos pantallas es cómo una queda vieja.
    check('pendientes: reusa las pantallas que ya aprueban, no las duplica',
      /VIEWS\.pendientes/.test(h5) && /solicitudesCaja\(\)/.test(h5)
      && /movimientosPanel\(\)/.test(h5) && /pintarComprobantes\('pendiente'/.test(h5));
    check('pendientes: se refresca solo con la pantalla abierta',
      /setInterval\(refrescarTodoPendiente/.test(h5));
    // Con el OS en otra pestaña del navegador, el número tiene que verse igual.
    check('pendientes: el título del navegador lleva el número',
      /document\.title = \(n \? '\(' \+ n \+ '\) ' : ''\)/.test(h5));
    check('pendientes: el badge urgente tiene su estilo y respeta reduced-motion',
      /\.nb\.urg/.test(h5) && /prefers-reduced-motion/.test(h5));
  }

  // ── SABER QUÉ VERSIÓN ESTÁ CORRIENDO ─────────────────────────────────────────────────────────
  // La primera vez que agregué esto, el script de edición abortó antes de escribir el archivo: el
  // commit salió con el comentario y sin la ruta. Y no me di cuenta porque probé con curl y vi un
  // JSON de error — que lo devuelve el middleware de sesión para CUALQUIER /api/os/… inexistente.
  // Por eso el check pide el CONTENIDO, no que "conteste algo".
  {
    const r5 = await get('/api/os/version');
    check('version: la ruta existe y dice cuándo arrancó',
      r5.status === 200 && r5.data.ok === true && typeof r5.data.arranque === 'string'
      && /^\d{4}-\d{2}-\d{2}T/.test(r5.data.arranque),
      'HTTP ' + r5.status + ' ' + JSON.stringify(r5.data).slice(0, 120));
  }

  // ── LA CUENTA QUE VE EL CLIENTE ──────────────────────────────────────────────────────────────
  // Es la segunda cosa que un cliente ve de este sistema, después de pedir fichas. Lo que no puede
  // pasar es que le llegue algo que no es suyo: el nombre de la plataforma (Casino/Europa), los
  // proveedores, el reparto entre los socios o su vendedor. El servidor ya no lo manda; esta
  // pantalla tampoco lo pide — y el check mide las dos puntas.
  {
    const cta = require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'cuenta.html'), 'utf8');
    const ped = require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'pedir.html'), 'utf8');
    // SIN PREPROCESAR. La versión anterior filtraba comentarios para que el comentario que explica
    // qué está prohibido no hiciera fallar el check — y ese filtro se comía medio archivo, con lo
    // cual el check pasaba siempre sobre un texto vacío. Ahora los comentarios están escritos sin
    // usar esas palabras, y el check mira el archivo entero: no hay nada que pueda engañarlo.
    //
    // "Proveedores" NO está prohibido: al cliente se le cobran los proveedores externos y la
    // factura ya se los nombra. Lo prohibido es lo que no es asunto suyo.
    const prohibido = [/\bEuropa\b/, /\bCasino\b/i, /reparto/i, /participante/i, /vendedor/i,
      /superagente/i, /\bTBS\b/, /profit/i, /matriz/i];
    for (const [quien, txt] of [['cuenta.html', cta], ['pedir.html', ped]]) {
      const cuela = prohibido.filter((re) => re.test(txt)).map((re) => String(re));
      check(`cliente: ${quien} no nombra nada interno`, cuela.length === 0, cuela.join(' '));
    }
    check('cuenta del cliente: sólo pide sus propios datos',
      /\/api\/cuenta\/login/.test(cta) && /\/api\/cuenta\/mio/.test(cta)
      && !/\/api\/os\//.test(cta), 'no puede pedirle nada a /api/os/');

    // El token del cliente es de OTRA familia que el del panel: uno nunca abre lo del otro.
    const idx2 = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'index.js'), 'utf8');
    check('cuenta del cliente: la página se sirve en /cuenta',
      /app\.get\('\/cuenta',/.test(idx2) && /cuenta\.html/.test(idx2));
    const au = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'auth.js'), 'utf8');
    check('cuenta del cliente: /cuenta es pública pero el dato no',
      /\^\\\/cuenta\\\/\?\$/.test(au) && /clienteDeToken/.test(idx2));

    // Sin token válido no se ve NADA. Es la comprobación que importa: la ruta es pública.
    let r2 = await get('/api/cuenta/mio');
    check('cuenta del cliente: sin entrar no devuelve nada', r2.status === 401, 'HTTP ' + r2.status);

    // ── DE PUNTA A PUNTA, COMO LO HACE LA PANTALLA ─────────────────────────────────────────
    // Entrar y DESPUÉS pedir los datos con el token, exactamente como manda el navegador. Sin
    // este check, el login podía andar y el pedido siguiente devolver 401 —porque el servidor
    // leía otra cabecera— y la pantalla volvía sola al formulario: "el botón no hace nada".
    {
      const u = 'e2e' + Date.now();
      const alta = await post('/api/os/clientes/' + cli.id + '/acceso', { usuario: u });
      const login = await post('/api/cuenta/login', { usuario: u, clave: alta.data.clave });
      check('cuenta del cliente: el login devuelve token', login.status === 200 && !!login.data.token,
        'HTTP ' + login.status);
      const mio = await get('/api/cuenta/mio', { authorization: 'Bearer ' + login.data.token });
      check('cuenta del cliente: con ese token SÍ ve su cuenta',
        mio.status === 200 && mio.data.ok === true && !!mio.data.cuenta && !!mio.data.cliente,
        'HTTP ' + mio.status + ' ' + JSON.stringify(mio.data).slice(0, 140));
      // Cada carga tiene que traer con qué rehacer la cuenta: lo cargado, el %, el monto en su
      // moneda y el TC. Sin lo CARGADO, el cliente ve un fee suelto y no puede verificar nada.
      // Hace falta una carga de verdad, atada a un pedido: lo cargado sale del pedido.
      const peds = (await get('/api/pedidos?codigo=L210')).data.pedidos || [];
      const ped1 = peds.find((x) => x.estado === 'cargado');
      if (ped1) {
        await post('/api/os/movimientos', { cliente_id: cli.id, tipo: 'carga', pedido_id: ped1.id,
          base_pct_aplicado: '11', monto_ars: '2200000', monto_usdt: '1490.51', tc_momento: '1476', divisa: 'ARS' });
      }
      const mio2 = await get('/api/cuenta/mio', { authorization: 'Bearer ' + login.data.token });
      const carga = (mio2.data.movimientos || []).find((m) => m.tipo === 'carga');
      check('cuenta del cliente: cada carga trae su cuenta completa',
        !!carga && carga.cargado != null && carga.base_pct != null && carga.tc != null,
        'pedido base=' + (ped1 ? ped1.monto : 'sin pedido') + ' · mov=' + JSON.stringify(carga || null));
      check('cuenta del cliente: lo cargado es el monto del pedido, exacto',
        !!carga && !!ped1 && String(carga.cargado) === String(ped1.monto),
        'cargado=' + (carga || {}).cargado + ' pedido=' + (ped1 || {}).monto);
      // Lo cargado sale del PEDIDO, no de dividir el fee: dividir un redondeado da 1.999.999,93.
      const idx3 = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'index.js'), 'utf8');
      check('cuenta del cliente: lo cargado sale del pedido, no de dividir el fee',
        /pedidos\.get\(m\.pedido_id\)/.test(idx3));
      // El saldo anterior se explica solo: "deuda antes de 08/26", sin fecha ni jerga interna.
      const rt = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'os.routes.js'), 'utf8');
      // Se mira lo que se ASIGNA, no el texto del archivo: el comentario de al lado cita la
      // etiqueta vieja justamente para explicar por qué cambió, y buscarla ahí daría rojo siempre.
      check('saldo anterior: la etiqueta dice el período, no jerga interna',
        /const etiqueta = `deuda antes de \$\{mm\}\/\$\{aa\.slice\(2\)\}`/.test(rt)
        && /notas: etiqueta/.test(rt)
        && !/notas: 'saldo anterior/.test(rt));
      check('saldo anterior: el cliente lo ve por su nota y sin fecha',
        /m\.tipo === 'ajuste' && m\.notas/.test(ped) && /esAjuste \? '' : fecha\(m\.fecha\)/.test(cta));

      // Y con el código en vez del usuario, que es como entra desde la pantalla de pedidos.
      const porCod = await post('/api/cuenta/login', { usuario: 'L210', clave: alta.data.clave });
      check('cuenta del cliente: también entra con su código', porCod.status === 200 && porCod.data.ok === true,
        'HTTP ' + porCod.status);
      await post('/api/os/clientes/' + cli.id + '/acceso', { habilitado: false });
    }
    r2 = await post('/api/cuenta/login', { usuario: 'no_existe_' + Date.now(), clave: 'x' });
    check('cuenta del cliente: usuario inexistente da el MISMO error que clave mala',
      r2.status === 401 && /Usuario o contraseña incorrectos/.test(r2.data.error || ''),
      JSON.stringify(r2.data.error));

    // ── LA CUENTA, DONDE EL CLIENTE YA ESTÁ ────────────────────────────────────────────────
    // Una página aparte obliga a mandar un link y a recordar otro identificador. La cuenta vive
    // en la MISMA pantalla donde pide fichas: ya escribió su código ahí, y sólo se le pide la
    // contraseña. El código nunca fue secreto —con él pide fichas— y lo que protege es la clave.
    check('cuenta en /pedir: está la opción y pide la contraseña',
      /optCuenta/.test(ped) && /Ver mi cuenta/.test(ped) && /entrarCuenta/.test(ped)
      && /'\/api\/cuenta\/login'/.test(ped));
    check('cuenta en /pedir: entra con el código que ya escribió',
      /usuario: _codigo, clave/.test(ped));
    check('cuenta en /pedir: la opción sólo aparece si la tiene habilitada',
      /optCuenta'\)\.style\.display = d\.puedeVerCuenta/.test(ped));
    // El token NO va a localStorage en /pedir: el teléfono puede ser de otro, y además leer
    // localStorage tira excepción con el almacenamiento bloqueado — que fue justo lo que dejó
    // el botón "Entrar" sin hacer nada en la primera versión de la página suelta.
    // Acá no hace falta filtrar nada: se busca el USO de la API (getItem/setItem/removeItem),
    // que en prosa no aparece. Buscar la palabra suelta chocaba con el comentario que explica
    // justamente por qué no se usa.
    check('cuenta en /pedir: el token queda en memoria, no guardado',
      /let _ctaTok = ''/.test(ped) && !/localStorage\.(get|set|remove)Item/.test(ped),
      'usos reales: ' + (ped.match(/localStorage\.(get|set|remove)Item/g) || []).length);
    const cta2 = require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'cuenta.html'), 'utf8');
    check('cuenta suelta: todo acceso a localStorage va envuelto',
      (cta2.match(/localStorage\./g) || []).length === 3
      && /try \{ return localStorage\.getItem/.test(cta2)
      && /try \{ localStorage\.setItem/.test(cta2)
      && /try \{ localStorage\.removeItem/.test(cta2),
      'usos=' + (cta2.match(/localStorage\./g) || []).length);
    // Un pago avisado y sin aprobar tiene que VERSE. Si no, el cliente lo vuelve a subir.
    check('cuenta: los pagos sin aprobar se muestran como pendientes',
      /Esperando aprobación/.test(ped) && /Esperando aprobación/.test(cta2)
      && /pendientes/.test(idx2));
    check('cuenta: el pendiente NO se descuenta del saldo',
      /Todavía no está descontado/.test(ped) && /Todavía no está descontado/.test(cta2));

    // ── EL STORE DE CLIENTES BORRA LO QUE NO SABE QUE EXISTE ────────────────────────────────
    // Guarda con DELETE + INSERT: una columna de la tabla que el INSERT no menciona queda en NULL
    // PARA TODOS los clientes en cuanto se guarde cualquiera. Pasó de verdad con las cuatro
    // columnas del acceso: dar de alta un cliente borraba la contraseña de todos los que podían
    // ver su cuenta, sin un error, sin un log, sin nada.
    //
    // El check compara la tabla REAL contra el INSERT, así que cubre también la próxima columna
    // que alguien agregue. Es el único que puede atajar esto: no hay pantalla donde se note.
    {
      const { db: dbc } = require('../src/db');
      const cols = dbc.prepare('PRAGMA table_info(clientes)').all().map((x) => x.name);
      const st = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'clientes-store.js'), 'utf8');
      const lista = (st.match(/INSERT INTO clientes\s*\n?\s*\(([\s\S]*?)\)\s*\n\s*VALUES/) || [])[1] || '';
      const enInsert = lista.replace(/\s/g, '').split(',').filter(Boolean);
      const faltan = cols.filter((c) => !enInsert.includes(c));
      check('clientes: el guardado no pierde ninguna columna de la tabla',
        enInsert.length > 0 && faltan.length === 0,
        enInsert.length === 0 ? 'la regex no encontró el INSERT — el check no está mirando nada'
          : faltan.length ? 'se perderían: ' + faltan.join(', ')
          : enInsert.length + ' columnas, ninguna se pierde');
    }

    // Y la comprobación de verdad: dar acceso, guardar OTRO cliente, y que la clave siga sirviendo.
    {
      const r6 = await post('/api/os/clientes/' + cli.id + '/acceso', { usuario: 'probaacceso' + Date.now() });
      const clave = r6.data && r6.data.clave; const usr = r6.data && r6.data.usuario;
      check('acceso: se genera usuario y clave', !!clave && !!usr, JSON.stringify(r6.data.error || ''));
      // Guardar cualquier cliente dispara el DELETE + INSERT de TODA la tabla.
      await put('/api/os/clientes/' + cli.id + '/comercial', { estado: 'activo' });
      const r7 = await post('/api/cuenta/login', { usuario: usr, clave });
      check('acceso: sobrevive a que se guarde un cliente',
        r7.status === 200 && r7.data.ok === true, 'HTTP ' + r7.status + ' ' + JSON.stringify(r7.data.error || ''));
      await post('/api/os/clientes/' + cli.id + '/acceso', { habilitado: false });
    }

    // El interruptor en el OS: dar y quitar acceso, y que la clave se muestre UNA vez.
    const h4 = require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'os.html'), 'utf8');
    check('cuenta del cliente: el OS tiene el interruptor de acceso',
      /accHabilitar/.test(h4) && /accQuitar/.test(h4) && /Puede ver su cuenta/.test(h4)
      && /no se puede volver a ver/.test(h4));
    // Lo que se le dicta al cliente tiene que ser el camino que va a usar. Cuando la cuenta se
    // mudó adentro de /pedir, este cartel siguió mandándolo a /cuenta a escribir otro usuario.
    check('acceso: el cartel manda al camino real, no a la página vieja',
      /\/pedir/.test(h4) && /Ver mi cuenta<\/b>/.test(h4)
      && !/Entra en <b>'\+location\.origin\+'\/cuenta/.test(h4));
  }

  // El aviso al grupo saca la moneda de la columna que TIENE el dato, no de la cuenta del cliente:
  // con un pago en pesos sobre una cuenta en dólares mandaba "1.476.000 USDT" al grupo del cliente.
  {
    const idx = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'index.js'), 'utf8');
    check('aviso: el monto acreditado viaja con SU moneda',
      /return \{ monto: m\.monto_usdt, moneda: 'USDT' \}/.test(idx)
      && /return \{ monto: m\.monto_ars, moneda: 'ARS' \}/.test(idx)
      && !/montoAcreditado\(c\),\s*\n?\s*cli && cli\.moneda_cuenta/.test(idx));
  }

  // ── Corregir un costo DENTRO de una foto congelada. Lo peligroso no es el número que se
  // cambia, es todo lo que NO se tiene que mover: celdas, clientes y vínculos del mes cerrado.
  {
    await post('/api/os/cierre/proveedor', { nombre: 'PROV FOTO', base_pct: '9' });
    await post('/api/os/cierre/celda', { proveedor: 'PROV FOTO', cliente: 'Lu', pct: '12' });
    await post('/api/os/cierre/mes/2026-05/congelar', { notas: 'prueba', pisar: true });
    let f = await get('/api/os/cierre/mes/2026-05/congelado?full=1');
    const celdasAntes = JSON.stringify(f.data.celdas), provsAntes = (f.data.listaProveedores || []).length;

    r = await post('/api/os/cierre/mes/2026-05/costo', { proveedor: 'PROV FOTO', base_pct: '10.5', motivo: 'test' });
    check('foto: corrige el costo y dice de cuánto a cuánto', r.data.ok && r.data.antes === '9' && r.data.ahora === '10.5', JSON.stringify(r.data));
    f = await get('/api/os/cierre/mes/2026-05/congelado?full=1');
    const p2 = (f.data.listaProveedores || []).find((x) => x.nombre === 'PROV FOTO');
    check('foto: el costo quedó corregido en la foto', p2 && p2.base_pct === '10.5', p2 && p2.base_pct);
    check('foto: no se movió ninguna celda', JSON.stringify(f.data.celdas) === celdasAntes);
    check('foto: no se agregó ni se perdió ningún proveedor', (f.data.listaProveedores || []).length === provsAntes);
    check('foto: la corrección queda anotada', /corrección/.test(f.data.notas || '') && /9 → 10.5/.test(f.data.notas || ''), f.data.notas);

    // la matriz VIVA no se toca: corregir un mes cerrado no cambia el precio de hoy
    const mzv = await get('/api/os/cierre/matriz');
    const vivo = (mzv.data.proveedores || []).find((x) => x.nombre === 'PROV FOTO');
    check('foto: corregir el mes cerrado no cambia el precio de hoy', vivo && vivo.base_pct === '9', vivo && vivo.base_pct);

    r = await post('/api/os/cierre/mes/2026-05/costo', { proveedor: 'NO EXISTE', base_pct: '1' });
    check('foto: no inventa un proveedor que no estaba', r.status === 400 && /no está en la foto/.test(r.data.error || ''), r.data.error);
    r = await post('/api/os/cierre/mes/2030-01/costo', { proveedor: 'PROV FOTO', base_pct: '1' });
    check('foto: un mes sin congelar no se puede corregir', r.status === 400 && /no está congelado/.test(r.data.error || ''), r.data.error);
  }

  // ── TIPOS DE CAMBIO: ARS_OF y el "TC Proveedor" son el MISMO dato. Estaban en dos tablas y
  // se habían separado (julio con 1473,5 en una y vacío en la otra). Lo que se prueba es que
  // escribir por cualquiera de los dos lados deje los dos iguales.
  {
    r = await post('/api/os/cierre/tc', { moneda: 'ARS_OF', mes: 'Julio_2026', tasa: '1473.5', forzar: true });
    check('TC: se guarda el ARS del proveedor en la grilla', r.data.ok, JSON.stringify(r.data));
    r = await get('/api/os/tc/meses');
    let jul = (r.data.meses || []).find((x) => x.mes === '2026-07');
    check('TC: cargarlo en la grilla lo deja también en el cierre mensual', jul && jul.tc_proveedor_ext === '1473.5', jul && jul.tc_proveedor_ext);

    r = await put('/api/os/tc/mes/2026-07', { tc_proveedor_ext: '1500' });
    check('TC: cargarlo en el cierre mensual lo deja también en la grilla', r.data.ok, JSON.stringify(r.data.error || ''));
    r = await get('/api/os/cierre/tc');
    check('TC: la grilla quedó con el mismo número', (r.data.tasas.ARS_OF || {}).Julio_2026 === '1500', (r.data.tasas.ARS_OF || {}).Julio_2026);

    // La columna del mes se arma sola con los promedios, pero NO pisa lo cargado a mano.
    await post('/api/os/cierre/tc', { moneda: 'ARS', mes: 'Julio_2026', tasa: '1574.12', forzar: true });
    r = await post('/api/os/tc/columna', { mes: '2026-07' });
    check('TC: armar la columna respeta lo cargado a mano', r.data.ok && !r.data.escritas.some((e) => e.divisa === 'ARS'), JSON.stringify(r.data.escritas || r.data.error));
    check('TC: armar la columna nunca toca el TC del proveedor', r.data.ok && !r.data.escritas.some((e) => e.divisa === 'ARS_OF'));

    // Borrar una FILA se lleva sus tasas de todos los meses y la saca de las que se cotizan.
    await post('/api/os/cierre/tc', { moneda: 'PGY', mes: 'Julio_2026', tasa: '6005.38', forzar: true });
    const div = require('../src/tc-divisas.service');
    r = await axios.delete(BASE + '/api/os/cierre/tc/moneda/PGY', H());
    check('TC: se borra la fila de una moneda', r.data.ok && r.data.celdas >= 1, 'celdas=' + r.data.celdas);
    r = await get('/api/os/cierre/tc');
    check('TC: la fila borrada ya no está', !(r.data.monedas || []).includes('PGY'), JSON.stringify(r.data.monedas));

    // Borrar una columna entera se lleva las celdas de todas las monedas de ese mes.
    r = await axios.delete(BASE + '/api/os/cierre/tc/mes/Julio_2026', H());
    check('TC: se borra la columna entera', r.data.ok && r.data.celdas >= 2, 'celdas=' + r.data.celdas);
    r = await get('/api/os/cierre/tc');
    check('TC: la columna borrada ya no está', !(r.data.meses || []).includes('Julio_2026'), JSON.stringify(r.data.meses));
  }

  // ── El CRUCE entre Proveedores y Matriz. Lo que hay que probar no es que encuentre cosas,
  // es que NO grite por las que estan bien: los SL/XG cuestan 0 y esta decidido que no se cobran.
  {
    const rev = require('../src/revision.service');
    const cs = require('../src/cierre-store');
    cs.addProveedor('PRUEBA SL', '0');            // cuesta 0: no cobrarlo es correcto
    cs.addProveedor('PRUEBA OP', '9');            // cuesta 9: no cobrarlo es plata perdida
    cs.setCelda('PRUEBA SL', 'Lu', '0');
    const x = rev.cruceProveedores('2026-06');
    const f = (n) => (x.filas || []).find((y) => y.matriz === n) || {};
    check('cruce: sin ganancia guardada no inventa problemas', x.ok && !x.hayDatos, 'hayDatos=' + x.hayDatos);
    check('cruce: una fila en 0 que nadie reporta es "sin uso", no una alarma',
      f('PRUEBA SL').estado === 'sin_uso', f('PRUEBA SL').estado);
    cs.setCelda('PRUEBA SL', 'Lu', '5');   // ahora SÍ se le cobra a alguien y nadie la reporta
    check('cruce: si se le cobra a alguien y ningún panel la reporta, avisa',
      (rev.cruceProveedores('2026-06').filas.find((y) => y.matriz === 'PRUEBA SL') || {}).estado === 'sin_vinculo');
    check('cruce: la fila sin celdas ni vínculo no dice "sin configurar"',
      f('PRUEBA OP').estado === 'sin_uso', f('PRUEBA OP').estado);
  }

  // ── FACTURA DE CONSUMO: los VENDEDORES no van. No pagan un % de lo que cargan, pagan el costo
  // real de los proveedores. Estando adentro salían como "sin % base" y su movimiento del casino
  // inflaba el control, que es lo que hacía que el total dijera -66%.
  {
    const vend = (await post('/api/clientes', { codigo: 'VEND1', nombreVisible: 'Vendedor Uno' })).data.cliente;
    await put('/api/os/clientes/' + vend.id + '/comercial', { es_vendedor: true });
    r = await get('/api/os/facturacion?mes=' + curMes);
    check('factura: el vendedor no aparece entre los clientes',
      !(r.data.clientes || []).some((c) => c.codigo === 'VEND1'), JSON.stringify((r.data.clientes || []).map((c) => c.codigo)));
    check('factura: el vendedor tampoco figura como "sin % base"',
      !(r.data.sinBase || []).some((n) => /Vendedor Uno|VEND1/.test(n)), JSON.stringify(r.data.sinBase));
  }

  // ── ALIAS de panel: el sistema de pedidos escribe "463.life" y el OS tiene "463.live". Por esa
  // letra el pedido no cruzaba con ningún panel y se le facturaba al dueño del código.
  {
    const pstore = require('../src/paneles-store');
    r = await post('/api/os/paneles', { cliente_id: cli.id, nombre: '463.live', sistema: 'Casino', nivel_usuario: 'SuperAgente', id_usuario: '2628233' });
    const pid = r.data.panel.id;
    check('alias: un panel arranca sin otros nombres', Array.isArray(r.data.panel.alias) && !r.data.panel.alias.length, JSON.stringify(r.data.panel.alias));
    r = await put('/api/os/paneles/' + pid, { alias: '463.life, 463 life' });
    check('alias: se guardan varios separados por coma', r.data.ok && r.data.panel.alias.length === 2, JSON.stringify(r.data.panel.alias));
    // La búsqueda por nombre se prueba en ESTE proceso: el server corre con otra base (DB_PATH),
    // así que un panel creado por la API no lo ve el store de acá. Y como esa base NO se borra
    // entre corridas, el panel de prueba lleva un sufijo único y se limpia al final: si no, la
    // segunda corrida encontraba el de la primera y "sin alias no lo encuentra" fallaba sola.
    const suf = Date.now().toString(36);
    const nombreOk = `panel.live.${suf}`; const nombreOtro = `panel.life.${suf}`;
    const pl = pstore.create({ cliente_id: 'c_test', nombre: nombreOk, sistema: 'Casino', nivel_usuario: 'SuperAgente', id_usuario: '2628233' });
    check('alias: sin alias no lo encuentra por el nombre de al lado', !pstore.porNombre(nombreOtro));
    pstore.update(pl.id, { alias: `${nombreOtro}, otro ${suf}` });
    check('alias: ahora sí lo encuentra por el otro nombre', (pstore.porNombre(nombreOtro.toUpperCase()) || {}).id === pl.id);
    check('alias: y sigue encontrándolo por el suyo', (pstore.porNombre(nombreOk) || {}).id === pl.id);
    check('alias: no inventa con un nombre que no existe', !pstore.porNombre('no-existe-este-' + suf));
    pstore.remove(pl.id);
    check('alias: la prueba no deja basura en la base', !pstore.porNombre(nombreOtro) && !pstore.porNombre(nombreOk));
    // Guardar otra cosa del panel no puede borrar los alias en silencio.
    r = await put('/api/os/paneles/' + pid, { nivel_usuario: 'Distribuidor' });
    check('alias: editar otro campo no se los lleva puestos', (r.data.panel.alias || []).length === 2, JSON.stringify(r.data.panel.alias));
  }

  // ── PERMISO PARA AVISAR PAGOS. Lo que hay que probar no es que se esconda el botón —eso no es
  // un permiso— sino que el SERVIDOR lo rechace: /api/comprobante es pública y cualquiera que
  // sepa un código puede postearle a mano.
  {
    r = await get('/api/pedir/L210');
    check('comprobantes: por defecto el cliente puede avisar pagos', r.data.puedeAvisarPago === true, JSON.stringify(r.data.puedeAvisarPago));
    r = await post('/api/comprobante', { codigo: 'L210', via: 'usdt', monto: '100', divisa: 'USDT' });
    check('comprobantes: habilitado, el aviso entra', r.status === 200 && r.data.ok, JSON.stringify(r.data.error || ''));

    await put('/api/os/clientes/' + cli.id + '/comercial', { avisa_pagos: false });
    r = await get('/api/pedir/L210');
    check('comprobantes: apagado, la pantalla ya no ofrece la opción', r.data.puedeAvisarPago === false);
    r = await post('/api/comprobante', { codigo: 'L210', via: 'usdt', monto: '100', divisa: 'USDT' });
    check('comprobantes: apagado, el SERVIDOR lo rechaza aunque se postee a mano', r.status === 403, 'HTTP ' + r.status);

    // Y se puede apagar/prender a todos de una, que es como se usa.
    r = await post('/api/os/clientes/avisa-pagos', { valor: false });
    check('comprobantes: se apaga para todos de una', r.data.ok && r.data.cambiados >= 1, 'cambiados=' + r.data.cambiados);
    await put('/api/os/clientes/' + cli.id + '/comercial', { avisa_pagos: true });
    r = await post('/api/comprobante', { codigo: 'L210', via: 'usdt', monto: '100', divisa: 'USDT' });
    check('comprobantes: al volver a habilitarlo, entra de nuevo', r.status === 200 && r.data.ok, 'HTTP ' + r.status);
  }

  // ── API (TBS): la cuenta del cliente y la del proveedor salen del MISMO GGR. Lo que se prueba
  // es la cadena completa contra una fila REAL de la planilla del dueño (Ars1Api, junio 2026,
  // Slot Zona) y el guardarraíl del reparto.
  {
    const a = require('../src/api-store');
    const mo = require('../src/lib/money');
    // GGR 4.668.341,7 × 9% = 420.150,75 ; ÷ 1519,31 = 276,54 US$ ; el proveedor se lleva 1 de 9
    const ggr = '4668341.7';
    const mCli = mo.round(mo.pct(ggr, '9'), 2);
    check('API: GGR × % del cliente = el monto de la planilla', mCli === '420150.75', mCli);
    const usdCli = mo.round(mo.div(mCli, '1519.31'), 2);
    check('API: ÷ TC = los US$ de la planilla', Math.abs(Number(usdCli) - 276.5) < 0.05, usdCli);
    const usdProv = mo.round(mo.div(mo.round(mo.pct(ggr, '1'), 2), '1519.31'), 2);
    check('API: el proveedor se lleva su parte', Math.abs(Number(usdProv) - 30.7) < 0.05, usdProv);
    check('API: lo que queda para la empresa', Math.abs(Number(mo.sub(usdCli, usdProv)) - 245.8) < 0.1, mo.sub(usdCli, usdProv));

    a.saveCliente({ id: 'T1', login: 'CuentaTest' });
    a.saveSello({ nombre: 'Sello test', grupo_id: '999', corto: 'TEST' });
    let r = a.setPct('T1', 'Sello test', { pct_cliente: '9', pct_proveedor: '1', pts_ib: '5', pts_henry: '3' });
    check('API: el reparto que cierra se guarda', r.ok, r.error);
    r = a.setPct('T1', 'Sello test', { pct_cliente: '9', pct_proveedor: '1', pts_ib: '5', pts_henry: '9' });
    check('API: si Central + Henry no dan lo que queda, no guarda', !r.ok && /Tienen que dar lo mismo/.test(r.error || ''), r.error);
    // Un precio de planilla NO puede pisar uno verificado: el verificado ya se cobró así.
    a.setPct('T1', 'Sello test', { pct_cliente: '9', pct_proveedor: '1', pts_ib: '5', pts_henry: '3', origen: 'verificado' });
    const sem = a.sembrar({ precios: [{ cliente_id: 'T1', sello: 'Sello test', pct_cliente: '99', origen: 'planilla' }], pisar: true });
    check('API: la planilla no pisa un precio verificado', sem.salteados === 1 && a.getPct('T1', 'Sello test').pct_cliente === '9',
      a.getPct('T1', 'Sello test').pct_cliente);
    a.removeCliente('T1'); a.removeSello('Sello test');
  }

  // ── un grupo que TBS no conoce NO puede facturar ──
  // TBS, ante un id de grupo desconocido, ignora el filtro y devuelve el profit de TODOS los
  // proveedores juntos. Así, el sello "Pragmatic OP" (grupo 63, inexistente) facturaba el GGR
  // entero del cliente por segunda vez y le duplicaba la cuenta a David y a Ars1api.
  {
    const cuenta = require('../src/api-cuenta.service');
    const falso = { grupos: async () => ({ ok: true, grupos: [{ id: '24', nombre: 'tomhorn' }, { id: '62', nombre: 'op_pragmatic_live' }] }) };
    cuenta.olvidarGrupos();
    const v = await cuenta.gruposValidos(falso);
    check('API: se sabe qué grupos reconoce TBS', v && v.has('24') && v.has('62') && !v.has('63'), [...(v || [])].join(','));
    // si el panel no contesta la lista, no se bloquea nada: peor sería dejar de facturar todo
    cuenta.olvidarGrupos();
    const nula = await cuenta.gruposValidos({ grupos: async () => ({ ok: false, error: 'caído' }) });
    check('API: si TBS no da la lista de grupos, no bloquea', nula === null, String(nula));
    cuenta.olvidarGrupos();
    // y se tiene que poder DESMAPEAR un sello, que era justo lo que el COALESCE impedía
    const a2 = require('../src/api-store');
    a2.saveSello({ nombre: 'Sello desmap', grupo_id: '63', corto: 'SD', costo: '1' });
    a2.saveSello({ nombre: 'Sello desmap', corto: 'SD2' });                 // sin la clave: no toca
    check('API: un PUT parcial no borra el grupo', a2.listSellos().find((x) => x.nombre === 'Sello desmap').grupo_id === '63');
    a2.saveSello({ nombre: 'Sello desmap', grupo_id: null });               // con la clave en null: borra
    check('API: se puede desmapear un sello', a2.listSellos().find((x) => x.nombre === 'Sello desmap').grupo_id == null,
      String(a2.listSellos().find((x) => x.nombre === 'Sello desmap').grupo_id));
    a2.removeSello('Sello desmap');
  }

  // ── una celda que no paga lo que el sello cuesta tiene que chillar ──
  // El motor usa el pct_proveedor de la CELDA y nunca miraba el costo del SELLO: así 8 celdas de
  // SL2 dijeron "pago 0" sobre un sello que cuesta 0,50 y el costo se contó como ganancia.
  {
    const a3 = require('../src/api-store');
    const cuenta3 = require('../src/api-cuenta.service');
    a3.saveSello({ nombre: 'Sello caro', grupo_id: '999999', corto: 'SC', costo: '0.50', tipo: 'postpago' });
    a3.saveCliente({ id: 'T9', login: 'ClienteTest9', activo: 1 });
    a3.setPct('T9', 'Sello caro', { pct_cliente: '2', pct_proveedor: '0', origen: 'verificado' });
    let av = cuenta3.revisarCostos().avisos.join(' | ');
    check('API: avisa cuando la celda no paga lo que el sello cuesta',
      /no pagan lo que el sello cuesta/.test(av) && /ClienteTest9 \/ SC/.test(av), av.slice(0, 200));
    a3.setPct('T9', 'Sello caro', { pct_cliente: '0.2', pct_proveedor: '0.5', origen: 'verificado' });
    av = cuenta3.revisarCostos().avisos.join(' | ');
    check('API: avisa cuando se vende por debajo del costo', /POR DEBAJO del costo/.test(av), av.slice(0, 200));
    a3.setPct('T9', 'Sello caro', { pct_cliente: '2', pct_proveedor: '0.5', origen: 'verificado' });
    av = cuenta3.revisarCostos().avisos.join(' | ');
    check('API: cuando coincide con el costo, no molesta', !/ClienteTest9/.test(av), av.slice(0, 200));
    // Una celda puede estar "mal" a propósito: TBS45Ar23 vende Buffalo Thunder bajo el costo y el
    // dueño eligió apagarle el proveedor al cliente. Con nota deja de ser alarma y pasa a decisión.
    a3.setPct('T9', 'Sello caro', { pct_cliente: '0.2', pct_proveedor: '0.5', origen: 'verificado', nota: 'se apaga en TBS' });
    let rv = cuenta3.revisarCostos();
    check('API: una celda con nota no grita, queda como decisión',
      !rv.avisos.length && rv.aceptados.length === 1 && /se apaga en TBS/.test(rv.aceptados[0]), JSON.stringify(rv.aceptados));
    // y cambiar el precio no borra la explicación
    a3.setPct('T9', 'Sello caro', { pct_cliente: '0.3', pct_proveedor: '0.5', origen: 'verificado' });
    check('API: cambiar el precio no borra la nota', /se apaga en TBS/.test((a3.getPct('T9', 'Sello caro') || {}).nota || ''),
      String((a3.getPct('T9', 'Sello caro') || {}).nota));
    a3.removePct('T9', 'Sello caro'); a3.removeCliente('T9'); a3.removeSello('Sello caro');
  }

  // ── un proveedor en negativo va en CERO, nunca se resta ──
  // Regla del dueño para todos los clientes de TBS. Ojo: el TOTAL del panel SÍ netea los negativos,
  // así que va a dar menos que la suma de lo facturable. Eso no es un descuadre.
  {
    const mo = require('../src/lib/money');
    const provs = { SL: '767939922', XG: '227505447', SL2: '284225980', SlotZona: '-182513445' };
    const facturable = Object.values(provs).filter((v) => mo.isPos(v)).reduce((a, v) => mo.add(a, v), '0');
    const neto = Object.values(provs).reduce((a, v) => mo.add(a, v), '0');
    check('API: el negativo no se resta de lo facturable', facturable === '1279671349', facturable);
    check('API: pero el total del panel sí lo netea', neto === '1097157904', neto);
    check('API: la diferencia es exactamente la pérdida', mo.sub(facturable, neto) === '182513445', mo.sub(facturable, neto));
  }

  // ── los dos documentos: el del cliente NO puede llevar lo que le pagamos al proveedor ──
  {
    const doc = require('../src/api-cuenta-doc');
    const mo = require('../src/lib/money');
    const linea = (sello, divisa, ggr, ggrUsd, cli, prov) => ({
      sello, sello_largo: sello + ' (largo)', tipo: 'prepago', divisa,
      ggr, ggr_usd: ggrUsd, tc_cliente: '1000', pct_cliente: '10', monto_cliente: cli,
      usdt_cliente: cli, pct_proveedor: '4', costo_sello: '4', monto_proveedor: prov,
      tc_proveedor: '1100', usdt_proveedor: prov, usdt_empresa: mo.sub(cli, prov), origen: 'verificado',
    });
    const bloque = (ls) => ({ lineas: ls, porDivisa: [
      { divisa: 'ARS', tc_cliente: '1000', tc_proveedor: '1100', tc_proveedor_varios: false,
        ggr: '2000000', ggr_usd: '2000', usdt_cliente: '200', usdt_proveedor: '80', usdt_empresa: '120',
        lineas: ls },
    ], usdt_cliente: '200', usdt_proveedor: '77.77', usdt_empresa: '133.33', sinVerificar: 0 });
    const propio = bloque([linea('SL', 'ARS', '1200000', '1200', '120', '48')]);
    const caja = bloque([linea('XG', 'ARS', '800000', '800', '80', '32')]);
    const cuenta = { cliente_id: 'P1', login: 'Padre', propio,
      cajas: [{ cliente_id: 'C1', login: 'LaCaja', ...caja }],
      total: { ...bloque([...propio.lineas, ...caja.lineas]), usdt_cliente: '200' } };

    const dCli = doc.documento({ cuenta, mes: '2026-07', vista: 'cliente', alcance: 'total' });
    const txt = JSON.stringify(dCli);
    check('API/doc: la cuenta del cliente no lleva NADA del proveedor ni del reparto',
      !/proveedor|empresa|pts_|central|henry|costo_sello|origen/i.test(txt), txt.slice(0, 220));
    check('API/doc: pero sí lleva el GGR en las dos monedas',
      /"ggr":/.test(txt) && /"ggr_usd":/.test(txt) && /"tc_cliente":/.test(txt));
    // El total NO puede venir mezclado: con dos proyectos, SL/SL2/XG aparecen en los dos y sin
    // separarlos quedan filas repetidas que no se sabe de cuál son.
    check('API/doc: el total viene separado por proyecto, no mezclado',
      dCli.secciones.length === 2 && dCli.secciones[0].titulo === 'Padre' && dCli.secciones[1].titulo === 'LaCaja',
      JSON.stringify(dCli.secciones.map((x) => x.titulo)));
    check('API/doc: cada proyecto trae su propio subtotal',
      dCli.secciones.every((x) => x.usdt_cliente === '200'), JSON.stringify(dCli.secciones.map((x) => x.usdt_cliente)));
    check('API/doc: y una sola caja no se parte en secciones',
      doc.documento({ cuenta, mes: '2026-07', vista: 'cliente', alcance: 'caja', caja_id: 'C1' }).secciones.length === 1);
    const dInt = doc.documento({ cuenta, mes: '2026-07', vista: 'interno', alcance: 'total' });
    check('API/doc: la interna sí lleva el proveedor y la empresa',
      dInt.usdt_proveedor === '77.77' && dInt.usdt_empresa === '133.33', JSON.stringify([dInt.usdt_proveedor, dInt.usdt_empresa]));
    const dCaja = doc.documento({ cuenta, mes: '2026-07', vista: 'cliente', alcance: 'caja', caja_id: 'C1' });
    check('API/doc: se puede pedir sólo la caja', dCaja.ok && dCaja.caja === 'LaCaja' && dCaja.usdt_cliente === '200', JSON.stringify(dCaja.caja));
    const dProp = doc.documento({ cuenta, mes: '2026-07', vista: 'interno', alcance: 'propio' });
    check('API/doc: y el resto sin la caja', dProp.ok && dProp.alcance === 'propio', dProp.alcance);
    check('API/doc: la interna muestra las tres vistas juntas',
      dInt.desglose && dInt.desglose.cajas.length === 1 && dInt.desglose.total, JSON.stringify(dInt.desglose || {}).slice(0, 120));
    check('API/doc: una caja que no existe no rompe, avisa',
      doc.documento({ cuenta, mes: '2026-07', alcance: 'caja', caja_id: 'NOPE' }).ok === false);
    // el total en dólares es lo único sumable entre monedas
    check('API/doc: el total en US$ sale de sumar las secciones', dCli.ggr_usd === '4000', dCli.ggr_usd);

    // ── el texto que se le manda por Telegram ──
    // Sale del documento YA proyectado, nunca de la cuenta cruda. Un mensaje mandado no se puede
    // volver atrás: si acá se colara lo que le pagamos al proveedor, el cliente lo lee y listo.
    const txtCli = doc.aTexto(dCli, { titulo: 'Nacho' });
    check('API/telegram: el texto no lleva nada del proveedor ni del reparto',
      !/proveedor|empresa|henry|central|costo/i.test(txtCli), txtCli.slice(0, 200));
    // El mensaje es un RESUMEN: el desglose vive en la página del link. 40 líneas con subtotales
    // por divisa no se leen en un chat, y Telegram encima las parte en varios mensajes.
    check('API/telegram: el mensaje es corto, con el mes en castellano y el total',
      /Cuenta de consumo TBS Julio-2026/.test(txtCli) && /Total a pagar/.test(txtCli), txtCli.slice(0, 160));
    check('API/telegram: con dos proyectos, lista cada uno con su total',
      /· Padre: /.test(txtCli) && /· LaCaja: /.test(txtCli), txtCli.slice(0, 300));
    check('API/telegram: el desglose por divisa NO va en el mensaje',
      !/tipo de cambio/.test(txtCli), txtCli.slice(0, 200));
    const conLink = doc.aTexto(dCli, { titulo: 'Nacho', link: 'https://x.test/cuenta/abc' });
    check('API/telegram: el link va como enlace, no pegado como texto',
      /<a href="https:\/\/x\.test\/cuenta\/abc">/.test(conLink), conLink.slice(-140));

    // ── la página: un solo renderizador para el dueño y para el cliente ──
    const html = require('../src/api-cuenta-html');
    const pg = html.pagina(dCli);
    check('API/página: sale el detalle por divisa con su subtotal',
      /Subtotal ARS/.test(pg) && /tipo de cambio/.test(pg) && /Total a pagar/.test(pg));
    // "Proveedor" SÍ aparece: es el encabezado de la columna del sello. Lo que no puede aparecer
    // son las columnas internas ni los importes del proveedor y de la empresa.
    check('API/página: no lleva las columnas internas',
      !/Le pago|usdt_proveedor|usdt_empresa|pts_ib|pts_henry|costo_sello|tc_proveedor/i.test(pg), pg.slice(0, 200));
    check('API/página: no lleva los importes del proveedor ni de la empresa',
      !pg.includes('77,77') && !pg.includes('133,33'), 'los del fixture interno');
    check('API/página: no la indexa un buscador', /noindex/.test(pg));
    check('API/página: sin documento muestra un error, no se rompe',
      /No encontramos/.test(html.pagina(null)) && /No encontramos/.test(html.pagina({ ok: false })));
    const txtInt = doc.aTexto(dInt, { titulo: 'Nacho' });
    check('API/telegram: el texto se arma igual desde la vista interna (no filtra por venir de ahí)',
      !/usdt_proveedor|pts_ib/.test(txtInt));
    check('API/telegram: sin documento no inventa un mensaje', doc.aTexto(null) === '' && doc.aTexto({ ok: false }) === '');
    // el < de un nombre no puede romper el HTML del mensaje
    const raro = doc.documento({ cuenta: { ...cuenta, login: '<b>hack</b>' }, mes: '2026-07', vista: 'cliente', alcance: 'propio' });
    check('API/telegram: un nombre con HTML se escapa', /&lt;b&gt;hack/.test(doc.aTexto(raro)), doc.aTexto(raro).slice(0, 80));
  }

  // ── el grupo matriz: va siempre; el del cliente, sólo si se pide ──
  {
    const cfg = require('../src/config-store');
    cfg.setApiGrupoMatriz('-4721694040');
    check('API/matriz: el grupo matriz se guarda en la config global', cfg.getApiGrupoMatriz() === '-4721694040');
    cfg.setApiGrupoMatriz('  -111  ');
    check('API/matriz: se limpian los espacios', cfg.getApiGrupoMatriz() === '-111');
    cfg.setApiGrupoMatriz('');
    check('API/matriz: se puede vaciar', cfg.getApiGrupoMatriz() === '');
    // La regla que importa: mandar al cliente tiene que ser un pedido EXPLÍCITO. Si alcanzara con
    // que el cliente tenga grupo cargado, cargarle el grupo a alguien lo pondría a recibir facturas.
    const src = fs.readFileSync(path.join(ROOT, 'src', 'os.routes.js'), 'utf8');
    check('API/matriz: al cliente sólo con al_cliente === true', /const alCliente = b\.al_cliente === true;/.test(src));
    check('API/matriz: la matriz entra sola cuando está cargada', /if \(matriz\) destinos\.push/.test(src));
    check('API/matriz: no se manda dos veces si el cliente ES la matriz', /chatCli !== matriz/.test(src));
    check('API/matriz: sin ningún destino no manda y lo dice', /no hay a dónde mandar/.test(src));
    cfg.setApiGrupoMatriz('');
  }

  // ── editar un precio de la matriz ──
  // Las celdas nunca habían sido editables: los precios sólo entraban por importación y una
  // corrección puntual obligaba a tocar la base. Vaciar BORRA, que no es lo mismo que poner 0.
  {
    const a5 = require('../src/api-store');
    a5.saveSello({ nombre: 'Sello edit', grupo_id: '99', corto: 'SE', costo: '2' });
    a5.saveCliente({ id: 'TE', login: 'ClienteEdit', activo: 1 });
    a5.setPct('TE', 'Sello edit', { pct_cliente: '5', pct_proveedor: '2', origen: 'planilla' });
    check('matriz: se puede cambiar el % de una celda',
      (() => { a5.setPct('TE', 'Sello edit', { pct_cliente: '7', pct_proveedor: '2', origen: 'planilla' });
        return a5.getPct('TE', 'Sello edit').pct_cliente === '7'; })());
    check('matriz: 0 es un precio válido (cobrarle cero a propósito)',
      (() => { a5.setPct('TE', 'Sello edit', { pct_cliente: '0', pct_proveedor: '2', origen: 'planilla' });
        return a5.getPct('TE', 'Sello edit').pct_cliente === '0'; })());
    a5.removePct('TE', 'Sello edit');
    check('matriz: borrar el precio lo saca de la matriz, no lo deja en 0',
      a5.getPct('TE', 'Sello edit') === null, JSON.stringify(a5.getPct('TE', 'Sello edit')));
    a5.removeCliente('TE'); a5.removeSello('Sello edit');
  }

  // ── el cierre del mes: elegir qué entra en el total, y que la decisión sea por MES ──
  // En junio la caja de Nacho quedó afuera por un acuerdo puntual y en julio entra. Si la decisión
  // fuera una propiedad del cliente, sacar el cierre de junio otra vez daría otro número.
  {
    const a4 = require('../src/api-store');
    check('API/resumen: por defecto no hay nada excluido', a4.fueraDelResumen('2026-06').length === 0);
    a4.setEnResumen('2026-06', 'k_caja', false, 'acuerdo con el cliente');
    check('API/resumen: se puede sacar una unidad de un mes',
      a4.fueraDelResumen('2026-06').some((x) => x.clave === 'k_caja' && /acuerdo/.test(x.motivo)),
      JSON.stringify(a4.fueraDelResumen('2026-06')));
    check('API/resumen: y eso NO afecta a otro mes', a4.fueraDelResumen('2026-07').length === 0,
      JSON.stringify(a4.fueraDelResumen('2026-07')));
    a4.setEnResumen('2026-06', 'k_caja', true);
    check('API/resumen: se puede volver a meter', a4.fueraDelResumen('2026-06').length === 0);
    // lo que NO está en la tabla, entra: un cliente nuevo no puede quedar afuera en silencio
    a4.setEnResumen('2026-06', 'k_otro', false, 'monto insignificante');
    check('API/resumen: sólo se guardan las exclusiones',
      a4.fueraDelResumen('2026-06').length === 1 && a4.fueraDelResumen('2026-06')[0].clave === 'k_otro');
    a4.setEnResumen('2026-06', 'k_otro', true);
  }

  // ── y la ruta de verdad, por HTTP ──
  // El store andaba y la pantalla no: api() le pasa opts tal cual a fetch, así que mandar el body
  // como objeto llegaba "[object Object]". Los tests en proceso no lo veían. Este sí.
  {
    r = await post('/api/os/api/resumen/sel', { mes: '2026-06', clave: 'k_http', entra: false, motivo: 'test' });
    check('API/resumen: la ruta guarda la exclusión', r.status === 200 && r.data.ok, JSON.stringify(r.data));
    // La base de prueba no tiene conexión TBS, así que el resumen no puede calcular: lo que se
    // comprueba acá es que la ruta EXISTE y contesta, no el número (eso ya está más arriba).
    r = await get('/api/os/api/resumen?mes=2026-06');
    check('API/resumen: la ruta del resumen contesta',
      r.status === 200 || (r.status === 400 && /conexión con motor TBS/.test(r.data.error || '')),
      r.status + ' ' + (r.data.error || 'ok'));
    r = await post('/api/os/api/resumen/sel', { mes: '2026-06', clave: 'k_http', entra: true });
    check('API/resumen: y se puede volver a incluir', r.status === 200 && r.data.ok, JSON.stringify(r.data));
    r = await post('/api/os/api/resumen/sel', { entra: false });
    check('API/resumen: sin mes ni clave, 400 y no rompe', r.status === 400 && /falta/.test(r.data.error || ''), r.data.error);
  }

  // ── VIGENCIAS DEL REPARTO: cargar uno con fecha ANTERIOR a otro ya cargado tiene que
  // REEMPLAZARLO, no convivir con él. Cuando convivían, el mes devolvía los dos repartos juntos
  // y la Empresa aparecía dos veces — el reparto sumaba más que la base y nadie lo veía.
  {
    const parts = require('../src/participaciones-store');
    const pid = 'c_vig_test';
    parts.setReparto(pid, null, [{ persona_id: 'p1', porcentaje: '8' }, { persona_id: 'p2', porcentaje: '3' }], '2026-08-01', { esperado: '11' });
    let e = parts.repartoEfectivo(pid, null, '2026-08-15');
    check('vigencia: el reparto de agosto rige en agosto', e.items.length === 2, JSON.stringify(e.items.map((x) => x.porcentaje)));
    // ahora uno ANTERIOR, que es el caso que rompía
    parts.setReparto(pid, null, [{ persona_id: 'p1', porcentaje: '11' }], '2026-07-01', { esperado: '11' });
    e = parts.repartoEfectivo(pid, null, '2026-07-15');
    check('vigencia: en julio rige el nuevo y SOLO el nuevo', e.items.length === 1 && e.items[0].porcentaje === '11',
      JSON.stringify(e.items.map((x) => x.persona_id + ':' + x.porcentaje)));
    e = parts.repartoEfectivo(pid, null, '2026-08-15');
    check('vigencia: y también reemplaza al de agosto, que empezaba después', e.items.length === 1 && e.items[0].porcentaje === '11',
      JSON.stringify(e.items.map((x) => x.persona_id + ':' + x.porcentaje)));
    // guardar dos veces la MISMA fecha no duplica
    parts.setReparto(pid, null, [{ persona_id: 'p1', porcentaje: '11' }], '2026-07-01', { esperado: '11' });
    e = parts.repartoEfectivo(pid, null, '2026-07-15');
    check('vigencia: guardar dos veces la misma fecha no duplica', e.items.length === 1, JSON.stringify(e.items));
    // y una vigencia posterior no pisa el pasado
    parts.setReparto(pid, null, [{ persona_id: 'p2', porcentaje: '11' }], '2026-09-01', { esperado: '11' });
    e = parts.repartoEfectivo(pid, null, '2026-07-15');
    check('vigencia: una posterior no toca el pasado', e.items.length === 1 && e.items[0].persona_id === 'p1', JSON.stringify(e.items));
  }

  // ── la misma línea de tiempo, pero en los valores sueltos (precio base, costos, etc.) ──
  {
    const hist = require('../src/historial');
    const eid = 'test_vig_' + Date.now();
    const val = (f) => hist.getVigente('cliente', eid, 'precio_base_pct', f);
    // primero agosto, y DESPUÉS julio: el caso que dejaba el tramo dado vuelta
    hist.setVigencia('cliente', eid, 'precio_base_pct', '15', '2026-08-01');
    hist.setVigencia('cliente', eid, 'precio_base_pct', '14', '2026-07-01');
    check('valores: cargar una fecha anterior no rompe la posterior',
      val('2026-07-15') === '14' && val('2026-08-15') === '15', `jul=${val('2026-07-15')} ago=${val('2026-08-15')}`);
    const filas = hist.listValores('cliente', eid, 'precio_base_pct');
    check('valores: ningún tramo queda al revés',
      filas.every((f) => !f.vigente_hasta || f.vigente_hasta >= f.vigente_desde),
      JSON.stringify(filas.map((f) => f.vigente_desde + '→' + f.vigente_hasta)));
    // guardar dos veces la misma fecha pisa el valor, no agrega un tramo
    hist.setVigencia('cliente', eid, 'precio_base_pct', '13', '2026-07-01');
    check('valores: la misma fecha pisa y no duplica',
      hist.listValores('cliente', eid, 'precio_base_pct').length === 2 && val('2026-07-15') === '13',
      String(hist.listValores('cliente', eid, 'precio_base_pct').length));
    require('../src/db').db.prepare('DELETE FROM config_valores WHERE entidad_id=?').run(eid);
  }

  // ── el grupo del vendedor baja a su gente ──
  // Cuatro lugares distintos deciden a dónde mandar (aviso de carga público, aviso del OS, factura
  // y prueba). Si la herencia vive en dos de los cuatro, la factura llega y el aviso no, sin que
  // nada lo diga. Por eso está en una sola función y por eso se prueba acá.
  {
    const dest = require('../src/telegram-destino');
    const M = {
      v1: { id: 'v1', nombre: 'Henry', es_vendedor: true, telegram: { chatId: '-100HENRY', enabled: true } },
      c1: { id: 'c1', nombre: 'Juan', vendedor_id: 'v1', telegram: { chatId: '', enabled: false } },
      c2: { id: 'c2', nombre: 'Titan', vendedor_id: 'v1', telegram: { chatId: '-100PROPIO', enabled: true } },
      c3: { id: 'c3', nombre: 'Suelto', telegram: { chatId: '', enabled: true } },
      v0: { id: 'v0', nombre: 'Sarah', es_vendedor: true, telegram: { chatId: '', enabled: false } },
      c4: { id: 'c4', nombre: 'Hijo', vendedor_id: 'v0', telegram: { chatId: '', enabled: true } },
      cx: { id: 'cx', nombre: 'Ciclo', vendedor_id: 'cx', telegram: { chatId: '', enabled: true } },
    };
    const g = (id) => M[id];
    check('telegram: sin grupo propio, hereda el del vendedor',
      dest.destinoDe(M.c1, g).chatId === '-100HENRY' && dest.destinoDe(M.c1, g).de === 'Henry',
      JSON.stringify(dest.destinoDe(M.c1, g)));
    check('telegram: con grupo propio, manda el propio',
      dest.destinoDe(M.c2, g).chatId === '-100PROPIO' && dest.destinoDe(M.c2, g).heredado === false);
    check('telegram: sin vendedor y sin grupo, no hay a dónde', dest.destinoDe(M.c3, g).chatId === null);
    check('telegram: si el vendedor tampoco tiene, no inventa', dest.destinoDe(M.c4, g).chatId === null);
    check('telegram: un cliente que es su propio vendedor no cuelga', dest.destinoDe(M.cx, g).chatId === null);
    // Vendedores anidados: GanamosSarah y Julian son vendedores Y cuelgan de Alexa. Un cliente de
    // Julian tiene que poder terminar en el grupo de Alexa: si sólo se subiera un escalón, la
    // pantalla mostraría la jerarquía y el mensaje se perdería a mitad de camino.
    const N = {
      ale: { id: 'ale', nombre: 'Alexa', es_vendedor: true, telegram: { chatId: '-100ALEXA' } },
      jul: { id: 'jul', nombre: 'Julian', es_vendedor: true, vendedor_id: 'ale', telegram: { chatId: '' } },
      nieto: { id: 'nieto', nombre: 'Luxor', vendedor_id: 'jul', telegram: { chatId: '' } },
      a: { id: 'a', nombre: 'A', vendedor_id: 'b', telegram: { chatId: '' } },
      b: { id: 'b', nombre: 'B', vendedor_id: 'a', telegram: { chatId: '' } },
    };
    const gn = (id) => N[id];
    check('telegram: sube toda la cadena, no un solo escalón',
      dest.destinoDe(N.nieto, gn).chatId === '-100ALEXA' && dest.destinoDe(N.nieto, gn).de === 'Alexa',
      JSON.stringify(dest.destinoDe(N.nieto, gn)));
    check('telegram: un ciclo entre dos no cuelga el envío', dest.destinoDe(N.a, gn).chatId === null);
    // ── EL INTERRUPTOR SE HEREDA (cambiado el 10-ago-2026, lo decidió el dueño) ──
    // Antes NO se heredaba, para que prender el de un vendedor no pusiera a sus clientes a escribir
    // de golpe en un grupo real. En la práctica fue peor: 11 clientes tenían grupo y no avisaban
    // nunca, y parecía que el grupo no estaba cargado. Se le mostró la lista de a quiénes afectaba
    // y eligió que se herede.
    const H = {
      v: { id: 'v', nombre: 'Vendedor', es_vendedor: true, telegram: { chatId: '-100V', enabled: true } },
      vOff: { id: 'vOff', nombre: 'VendedorOff', es_vendedor: true, telegram: { chatId: '-100W', enabled: false } },
      hijo: { id: 'hijo', vendedor_id: 'v', telegram: {} },
      hijoOff: { id: 'hijoOff', vendedor_id: 'vOff', telegram: {} },
      propioOff: { id: 'propioOff', vendedor_id: 'v', telegram: { chatId: '-100P', enabled: false } },
    };
    const gh = (id) => H[id];
    check('telegram: el que hereda el grupo hereda el interruptor', dest.avisaCargas(H.hijo, gh) === true);
    check('telegram: si el del vendedor está apagado, el hijo tampoco avisa', dest.avisaCargas(H.hijoOff, gh) === false);
    // y el propio sigue mandando sobre el heredado: se puede apagar uno sin tocar al resto
    check('telegram: un cliente con grupo propio apagado NO avisa, aunque su vendedor esté prendido',
      dest.avisaCargas(H.propioOff, gh) === false);
    check('telegram: sin destino no avisa nunca', dest.avisaCargas(M.c3, g) === false);
    check('telegram: con interruptor propio prendido y destino heredado, sí avisa',
      dest.avisaCargas({ ...M.c1, telegram: { chatId: '', enabled: true } }, g) === true);
    check('telegram: sin destino no avisa aunque esté prendido', dest.avisaCargas(M.c4, g) === false);
  }

  // ── pegar varios chatId de Telegram de una vez ──
  // De una planilla nunca vienen escritos igual: con tab, con coma, con acentos, con espacios de
  // más. Si el parseo falla en silencio, el grupo queda sin cargar y ese cliente no recibe nada.
  {
    const K = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const ix = {}; ['Eli', 'Crazy-duck', 'Titán', 'PalmaReal', 'GA-Mati'].forEach((n) => { ix[K(n)] = n; });
    const leer = (l) => {
      const m = String(l).trim().match(/(-?\d{6,})\s*$/);
      if (!m) return null;
      const nombre = String(l).trim().slice(0, m.index).trim().replace(/[,;\t]+$/, '');
      return ix[K(nombre)] ? { cliente: ix[K(nombre)], chatId: m[1] } : null;
    };
    const casos = [
      ['Eli -1001234567890', 'Eli'], ['Crazy-duck\t-1009876543210', 'Crazy-duck'],
      ['Titan, -1005555555555', 'Titán'], ['  PalmaReal   -100111222333  ', 'PalmaReal'],
      ['GA MATI -100999888777', 'GA-Mati'], ['ga-mati;-100444', 'GA-Mati'],
    ];
    const bien = casos.filter(([l, esperado]) => (leer(l) || {}).cliente === esperado).length;
    check('telegram/pegar: reconoce tab, coma, acentos y espacios de más', bien === casos.length,
      bien + '/' + casos.length);
    check('telegram/pegar: un cliente que no existe no se carga', leer('Desconocido -100000') === null);
    check('telegram/pegar: una línea sin chatId no se carga', leer('Eli sin numero') === null);
    check('telegram/pegar: el chatId sale entero', (leer('Eli -1001234567890') || {}).chatId === '-1001234567890',
      String((leer('Eli -1001234567890') || {}).chatId));
  }

  // ── Foto del mes: los nombres de nivel que devuelve el servicio y los que dibuja la pantalla ──
  // La pantalla leía `x.grupo` (que no existe; el campo es `nivel`) y mapeaba superagent/distributor
  // en inglés contra superagente/distribuidor en español. Resultado: cada bloque decía "undefined".
  {
    const em = require('../src/estadisticas-mes.service');
    const niveles = em.NIVELES || [];
    check('foto: los niveles son superagente y distribuidor',
      niveles.length === 2 && niveles.includes('superagente') && niveles.includes('distribuidor'),
      JSON.stringify(niveles));
    const html = fs.readFileSync(path.join(ROOT, 'public', 'os.html'), 'utf8');
    const vista = html.slice(html.indexOf('VIEWS.foto ='), html.indexOf('async function fotoSacar'));
    check('foto: la pantalla mapea EXACTAMENTE esos nombres',
      niveles.every((n) => vista.includes(n + ':')), JSON.stringify(niveles.filter((n) => !vista.includes(n + ':'))));
    check('foto: la pantalla ya no lee el campo inexistente `grupo`',
      !/\.grupo\b/.test(vista) && /\.nivel\b/.test(vista));
  }

  // ── el nivel declarado: el candado cuando el casino ya no deja leerlo ──
  // El casino dejó de marcar con `selected` la opción de reports_user_group_by. Sin eso la foto
  // no se podía sacar más. Ahora el dueño puede declarar en qué nivel lo dejó — pero sólo vale
  // un nivel REAL: cualquier otra cosa tiene que seguir fallando, no colarse como válida.
  {
    const em = require('../src/estadisticas-mes.service');
    const niveles = em.NIVELES;
    check('foto/nivel: declarar un nivel válido es aceptable', niveles.includes('superagente') && niveles.includes('distribuidor'));
    check('foto/nivel: "superagent" en inglés NO es un nivel válido', !niveles.includes('superagent'));
    // el valor queda marcado como declarado, no como leído del casino: son cosas distintas
    const src = fs.readFileSync(path.join(ROOT, 'src', 'estadisticas-mes.service.js'), 'utf8');
    check('foto/nivel: lo declarado se anota como declarado', /declarado:/.test(src) && /NIVELES\.includes\(nivelDeclarado\)/.test(src));
    check('foto/nivel: sin declaración, sigue mandando lo que diga el casino',
      /if \(!modo\.ok && cli && nivelDeclarado/.test(src));
  }

  // ── la matriz de TBS: alfabética y con los baratos marcados ──
  // "Casi sin costo" es costo ≤ 1: SL, SL2, Slot Zona, XG y la familia postpago. Ahí lo que se
  // cobra es casi todo margen, y son los que el dueño necesita ubicar de un vistazo.
  {
    const orden = (a, b) => String(a).localeCompare(String(b), 'es', { sensitivity: 'base' });
    const nombres = ['Slot Zona', 'absolute live', 'Ávila', 'BVS', 'SL2', 'SL'];
    const ord = [...nombres].sort(orden);
    check('matriz: alfabético sin importar mayúsculas ni acentos',
      ord[0] === 'absolute live' && ord[1] === 'Ávila' && ord.indexOf('SL') < ord.indexOf('SL2'), ord.join(' · '));
    const barato = (x) => x.costo != null && Number(x.costo) <= 1;
    check('matriz: 0, 0,5 y 1 se marcan',
      barato({ costo: '0' }) && barato({ costo: '0.5' }) && barato({ costo: '1' }));
    check('matriz: 1,5 y más NO se marcan', !barato({ costo: '1.5' }) && !barato({ costo: '8.5' }));
    check('matriz: un sello sin costo cargado no se marca (no sé ≠ es gratis)', !barato({ costo: null }));

    // Una celda sticky con fondo translúcido deja ver lo que scrollea por debajo: las filas verdes
    // quedaban con los números de otras columnas encimados. Cualquier regla que le ponga fondo a
    // .cie-p tiene que ser opaca.
    const css = fs.readFileSync(path.join(ROOT, 'public', 'os.html'), 'utf8');
    // Sólo las reglas que le pegan a la CELDA en sí. Un input adentro puede ser transparente:
    // el que tiene que tapar lo de abajo es el td, no lo que lleva dentro.
    const reglas = (css.match(/\.ciet[^{}]*\.cie-(p|h0)\s*\{[^}]*\}/g) || []);
    const traslucidas = reglas.filter((x) => /background:\s*(rgba\([^)]*,\s*0?\.\d+\s*\)|transparent)/i.test(x));
    check('matriz: la columna fija tiene fondo opaco', !traslucidas.length,
      traslucidas.join(' | ').slice(0, 200) || reglas.length + ' regla(s) revisadas');
    check('matriz: y hay reglas de columna fija que revisar', reglas.length >= 2, String(reglas.length));
  }

  // ── el link que se le manda al cliente TIENE que abrir sin login ──
  // Creé la ruta /cuenta/:token pero me olvidé de la lista PUBLIC de auth.js: el cliente abría el
  // link y le aparecía la pantalla de ingreso del panel. Y el cliente no tiene usuario.
  {
    const sinCookie = { validateStatus: () => true, maxRedirects: 0 };
    const rc = await axios.get(BASE + '/cuenta/TOKENQUENOEXISTE', sinCookie);
    const redirige = rc.status === 302 || /login/i.test(String(rc.headers.location || ''));
    check('cuenta pública: el link NO manda al login', !redirige, rc.status + ' ' + (rc.headers.location || ''));
    check('cuenta pública: un token inventado da 404, no la página de nadie',
      rc.status === 404 && /No encontramos/.test(String(rc.data)), String(rc.status));
    // y lo de adentro sigue cerrado
    const rp = await axios.get(BASE + '/api/os/api/cuenta/x/pagina', sinCookie);
    check('cuenta pública: la vista previa del dueño sigue pidiendo login',
      rp.status === 302 || rp.status === 401 || /login/i.test(String(rp.headers.location || '')), String(rp.status));
  }

  // ── las divisas de un panel se pueden editar, y "sin datos" no es "no las usa" ──
  {
    // Se lee por la API y no por el store: el store cacheado dentro del proceso del test no ve lo
    // que escribió el server (está anotado más arriba, para el reparto).
    const pid = (await post('/api/os/paneles', { cliente_id: cli.id, nombre: 'PanelDiv',
      sistema: 'Casino', nivel_usuario: 'Agente', id_usuario: '999001', divisas: 'ARS,BRL,CLP' })).data.panel.id;
    const div = async () => (((await get('/api/os/paneles')).data.paneles || [])
      .find((x) => x.id === pid) || {}).divisas || [];
    check('divisas: se guardan como lista', (await div()).join(',') === 'ARS,BRL,CLP', JSON.stringify(await div()));
    await put('/api/os/paneles/' + pid, { divisas: 'ars , brl' });
    check('divisas: se normalizan a mayúsculas y sin espacios', (await div()).join(',') === 'ARS,BRL', JSON.stringify(await div()));
    await put('/api/os/paneles/' + pid, { nombre: 'PanelDiv2' });
    check('divisas: un PUT que no las manda NO las borra', (await div()).join(',') === 'ARS,BRL', JSON.stringify(await div()));
    // La regla del diagnóstico: si el panel no movió nada, no se puede afirmar que le sobren.
    const sinDatos = { usadas: [], sobran: ['ARS', 'BRL'] };
    const conDatos = { usadas: ['ARS'], sobran: ['BRL'] };
    const proponer = (g) => ((g.usadas && g.usadas.length) ? (g.sobran || []) : []);
    check('divisas: sin movimiento no se propone sacar ninguna', proponer(sinDatos).length === 0);
    check('divisas: con movimiento sí se propone', proponer(conDatos).join(',') === 'BRL');
    await axios.delete(BASE + '/api/os/paneles/' + pid, H());
  }

  // ── leer del casino qué divisas tiene habilitado un nodo ──
  // Se prueba contra un casino de mentira que sirve el MISMO html que la pantalla real (463.life,
  // nodo 2628233). Lo que se está cuidando acá no es el parseo sino qué pasa cuando falla: quien
  // llame va a comparar contra lo guardado, y una lista vacía leída como "no tiene ninguna divisa"
  // le borraría al panel las que sí tiene.
  {
    const http = require('http');
    const REAL = ['ARS', 'BRL', 'CLP', 'DOP', 'EUR', 'MXN', 'PEN', 'USD', 'UYU', 'VEF'];
    const PAGINA = REAL.map((d) => `<input type="hidden" name="currency" value="${d}">`).join('\n')
      + '<select name="add_currency"><option value="ADA">ADA</option><option value="AED">AED</option></select>';
    let modo = 'ok';
    const posts = [];
    const srv = http.createServer((rq, rs) => {
      if (rq.method !== 'GET') { posts.push(rq.url); rs.writeHead(200); return rs.end('guardado'); }
      if (modo === 'login') { rs.writeHead(200, { 'Content-Type': 'text/html' }); return rs.end('<form><input name="login"><input name="password"></form>'); }
      if (modo === 'redirect') { rs.writeHead(302, { Location: '/index.php?act=admin&area=login' }); return rs.end(); }
      if (modo === 'vacio') { rs.writeHead(200); return rs.end(''); }
      // El usuario con el que entra el OS ve las divisas pero NO puede agregarlas: la pantalla
      // viene sin el selector, y encima en inglés. Sigue siendo la página correcta.
      if (modo === 'soloLectura') { rs.writeHead(200, { 'Content-Type': 'text/html' });
        return rs.end('<h1>Currencies and gaming systems</h1>' + REAL.map((d) => `<input type="hidden" name="currency" value="${d}">`).join('')); }
      if (modo === 'sinDivisas') { rs.writeHead(200, { 'Content-Type': 'text/html' });
        return rs.end('<h1>Currencies and gaming systems</h1><select name="add_currency"><option value="ADA">ADA</option></select>'); }
      rs.writeHead(200, { 'Content-Type': 'text/html' }); rs.end(PAGINA);
    });
    await new Promise((r) => srv.listen(0, r));
    const cli = require('../src/casino-api').makeClient({ url: `http://127.0.0.1:${srv.address().port}/index.php`, token: 'x' });

    const r1 = await cli.divisasDeNodo('2628233');
    check('divisas casino: lee las 10 de 463.life', r1.ok && r1.divisas.join(',') === REAL.join(','), JSON.stringify(r1.divisas));
    check('divisas casino: no cuenta las del selector de agregar', r1.ok && !r1.divisas.includes('ADA'));

    // los tres modos de falla NO pueden devolver ok con lista vacía
    for (const m of ['login', 'redirect', 'vacio']) {
      modo = m;
      const r = await cli.divisasDeNodo('2628233');
      check(`divisas casino: si ${m} → error, NUNCA lista vacía`, r.ok === false && !!r.error, JSON.stringify(r).slice(0, 70));
    }
    modo = 'soloLectura';
    const rl = await cli.divisasDeNodo('2628233');
    check('divisas casino: sin permiso para agregar igual lee las 10',
      rl.ok && rl.divisas.join(',') === REAL.join(',') && rl.soloLectura === true, JSON.stringify(rl).slice(0, 80));
    modo = 'sinDivisas';
    check('divisas casino: pantalla correcta pero sin ninguna divisa → error',
      (await cli.divisasDeNodo('2628233')).ok === false);
    modo = 'ok';
    check('divisas casino: id no numérico se rechaza', (await cli.divisasDeNodo('../etc')).ok === false);
    // Lo más importante: esa pantalla también GUARDA (form por divisa + Guardar). Sólo se lee.
    check('divisas casino: NO manda ningún POST al casino', posts.length === 0, 'posts=' + posts.length);
    await new Promise((r) => srv.close(r));
  }

  // ── la regla del dueño: sólo un SuperAgente puede tener varias divisas ──
  // No corrige: vigila. Al leer los 201 paneles los 65 distribuidores trajeron exactamente 1, así
  // que si mañana uno vuelve con dos, algo cambió y hay que mirarlo — no escribirlo callado.
  {
    const regla = (nivel, leidas, guardadas) => {
      const esSuper = /superagente/i.test(String(nivel || ''));
      if (!esSuper && leidas.length > 1) return 'no se toca (rompe la regla)';
      if (!leidas.length) return 'no se toca (lectura vacía)';
      if (leidas.join(',') === guardadas.slice().sort().join(',')) return 'no se toca (ya está igual)';
      return 'escribe';
    };
    check('regla: un SuperAgente con varias divisas se escribe',
      regla('SuperAgente', ['ARS', 'USD'], ['ARS']) === 'escribe');
    check('regla: un Distribuidor con 1 divisa se escribe',
      regla('Distribuidor', ['MXN'], ['ARS']) === 'escribe');
    check('regla: un Distribuidor con 2 NO se toca, se avisa',
      regla('Distribuidor', ['ARS', 'USD'], ['ARS']) === 'no se toca (rompe la regla)');
    check('regla: un Agente con 2 tampoco (la regla es "no superagente")',
      regla('Agente', ['ARS', 'USD'], ['ARS']) === 'no se toca (rompe la regla)');
    check('regla: una lectura vacía nunca borra lo guardado',
      regla('SuperAgente', [], ['ARS', 'USD']) === 'no se toca (lectura vacía)');
    check('regla: si ya coincide no se escribe al pedo',
      regla('SuperAgente', ['ARS', 'USD'], ['USD', 'ARS']) === 'no se toca (ya está igual)');
  }

  // ── la limpieza de grupos viejos NO puede borrar los niveles vigentes ──
  // Estaba escrita en inglés de cuando los niveles se llamaban 'superagent'. Al renombrarlos al
  // español, 'superagente' dejó de coincidir y la limpieza borraba LOS DOS niveles: cada vez que
  // se arrancaba una captura se vaciaba el mes entero. Este test es el que no la deja desfasarse.
  {
    const { db } = require('../src/db');
    const em = require('../src/estadisticas-mes.service');
    const vigentes = [...em.NIVELES, 'nodo'];
    const hueco = vigentes.map(() => '?').join(',');
    const MES = '1999-01';
    db.prepare('DELETE FROM estad_mes WHERE mes=?').run(MES);
    const ins = db.prepare(`INSERT INTO estad_mes (id,conexion_id,mes,divisa,grupo,nodo_id,nodo_login,
      provider,label,vendor,bet,win,profit,capturado_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    // uno por nivel vigente, más dos de los grupos viejos que sí hay que barrer
    [...vigentes, 'distributor', 'agent'].forEach((g, i) => ins.run('t' + i, 'cx', MES, 'ARS', g,
      '1', 'x', 'p', 'l', 'v', '0', '0', '0', '2026-01-01'));
    db.prepare(`DELETE FROM estad_mes WHERE mes=? AND grupo NOT IN (${hueco})`).run(MES, ...vigentes);
    const quedan = db.prepare('SELECT grupo FROM estad_mes WHERE mes=?').all(MES).map((r) => r.grupo).sort();
    check('limpieza: sobreviven TODOS los niveles vigentes', quedan.join(',') === vigentes.slice().sort().join(','), quedan.join(','));
    check('limpieza: se van los grupos viejos', !quedan.includes('distributor') && !quedan.includes('agent'));
    // el desfasaje concreto que hubo, para que no vuelva disfrazado
    check('limpieza: "superagente" no se pierde por escribir "superagent"',
      quedan.includes('superagente'), quedan.join(','));
    db.prepare('DELETE FROM estad_mes WHERE mes=?').run(MES);
  }

  // ── los dos recortes de la Foto: nivel propio, y paneles marcados ──
  {
    const pid = (await post('/api/os/paneles', { cliente_id: cli.id, nombre: 'PanelFoto',
      sistema: 'Casino', nivel_usuario: 'Distribuidor', id_usuario: '999002', divisas: 'ARS' })).data.panel.id;
    const leer = async () => (((await get('/api/os/paneles')).data.paneles || []).find((x) => x.id === pid) || {});
    check('foto: un panel nuevo entra en la Foto por defecto', (await leer()).en_foto === true, JSON.stringify((await leer()).en_foto));
    await put('/api/os/paneles/' + pid, { en_foto: false });
    check('foto: se puede sacar de la Foto', (await leer()).en_foto === false);
    await put('/api/os/paneles/' + pid, { nombre: 'PanelFoto2' });
    check('foto: un PUT que no lo manda NO lo vuelve a meter', (await leer()).en_foto === false);
    await put('/api/os/paneles/' + pid, { en_foto: true });
    check('foto: se puede volver a meter', (await leer()).en_foto === true);
    await axios.delete(BASE + '/api/os/paneles/' + pid, H());
  }

  // ── la lista de superagentes para elegir sus distribuidores ──
  {
    const r = (await get('/api/os/paneles/foto-distribuidores')).data;
    check('lista SA: viene por conexión', Array.isArray(r.conexiones));
    const todos = require('../src/paneles-store').list().filter((p) => p.id_usuario);
    const enLista = new Set();
    (r.conexiones || []).forEach((cx) => {
      (cx.superagentes || []).forEach((sa) => { enLista.add(sa.id); (sa.hijos || []).forEach((h) => enLista.add(h.id)); });
      (cx.sueltos || []).forEach((x) => enLista.add(x.id));
    });
    // Lo que se cuida: un distribuidor que no cuelgue de ningún superagente cargado NO puede
    // desaparecer de la lista. Si no se ve, no se puede marcar, y "no lo veo" pasaría a ser
    // "no lo saco" sin que nadie lo haya decidido.
    const noSuper = todos.filter((p) => !/superagente/i.test(String(p.nivel_usuario || '')));
    const invisibles = noSuper.filter((p) => !enLista.has(p.id));
    check('lista SA: ningún distribuidor queda invisible', invisibles.length === 0,
      invisibles.slice(0, 5).map((x) => x.nombre).join(','));
    // y un hijo no puede aparecer además como suelto
    const sueltos = new Set((r.conexiones || []).flatMap((cx) => (cx.sueltos || []).map((x) => x.id)));
    const hijos = new Set((r.conexiones || []).flatMap((cx) => (cx.superagentes || []).flatMap((sa) => (sa.hijos || []).map((h) => h.id))));
    check('lista SA: nadie aparece dos veces', ![...hijos].some((id) => sueltos.has(id)));
  }

  // ── leer cómo agrupa el casino cuando NO viene ningún `selected` ──
  // Con "Datos generales" elegido, el casino manda las 9 <option> sin el atributo selected y el
  // navegador cae en la primera, que es esa misma. Tomar "ninguna marcada" como error dejaba la
  // vista general afuera de la foto para siempre.
  {
    const leer = (opciones) => {
      if (!opciones || !opciones.length) return { ok: false };
      const sel = opciones.find((o) => o.seleccionada) || opciones[0];
      return { ok: true, valor: sel.value, porDefecto: !opciones.some((o) => o.seleccionada) };
    };
    const OPS = [{ value: '', texto: 'Datos generales' }, { value: 'superagent', texto: 'Superagente' },
      { value: 'diller', texto: 'Distributor' }];
    let r = leer(OPS);
    check('modo: sin ningún selected cae en la primera (Datos generales)',
      r.ok && r.valor === '' && r.porDefecto === true, JSON.stringify(r));
    r = leer(OPS.map((o) => ({ ...o, seleccionada: o.value === 'diller' })));
    check('modo: con selected gana el marcado, no el primero',
      r.ok && r.valor === 'diller' && r.porDefecto === false, JSON.stringify(r));
    check('modo: sin opciones sigue siendo error (eso sí es un parseo roto)', leer([]).ok === false);

    const em = require('../src/estadisticas-mes.service');
    check('modo: el valor vacío es el nivel "general"', em.nivelDeModo('') === 'general');
    check('modo: superagent y diller no cambiaron', em.nivelDeModo('superagent') === 'superagente'
      && em.nivelDeModo('diller') === 'distribuidor');
    check('modo: un valor que no sirve para la foto sigue dando null', em.nivelDeModo('terminal') === null);
  }

  // ── la columna de orden tiene que EXISTIR en el reporte que se pide ──
  // El motor sólo acepta ordenar por una columna del resultado, y no lo dice: contesta una página
  // "Unknown error occurred." a todo. Primero fue sort=provider agrupando por Distributor; después
  // sort=id en "Datos generales", donde tampoco hay `id`. Las dos veces pareció un motor caído.
  {
    const CAMPOS = {
      general: ['provider', 'label', 'vendor', 'bet', 'win', 'profit', 'rtp'],
      porNivel: ['id', 'login', 'provider', 'label', 'vendor', 'profit'],
    };
    const orden = (general) => (general ? 'profit' : 'id');
    check('orden: en la vista general la columna pedida existe',
      CAMPOS.general.includes(orden(true)), orden(true));
    check('orden: por nivel la columna pedida existe',
      CAMPOS.porNivel.includes(orden(false)), orden(false));
    check('orden: NO se ordena por id en la general (ahí no hay id)',
      orden(true) !== 'id' && !CAMPOS.general.includes('id'));
    // el código real
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'casino-api.js'), 'utf8');
    check('orden: casino-api elige la columna según la vista',
      /sort:\s*general\s*\?\s*'profit'\s*:\s*'id'/.test(src));
    check('orden: ya no está hardcodeado sort=id', !/sort=id&order=desc/.test(src));
  }

  // ── la pantalla de la Foto no puede quedar llamando a lo que ya no existe ──
  // Los botones seguían apuntando a la extracción por panel y por eso daba error al apretar. Y al
  // sacar la sección de elegir superagentes hay que sacar TAMBIÉN sus funciones: una función que
  // quedó sin botón no molesta, pero un botón sin función revienta recién cuando alguien lo toca.
  {
    const html = require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'os.html'), 'utf8');
    const js = (html.match(/<script>([\s\S]*)<\/script>/) || [])[1] || '';
    check('foto: la pantalla usa capturar-global', /capturar-global/.test(js));
    check('foto: ya no llama a la extracción por panel', !/estadisticas\/capturar['"?]/.test(js));
    ['fotoDist', 'fotoDistSet', 'fotoAlcance'].forEach((fn) => {
      check(`foto: ${fn} no quedó ni definida ni llamada`, !new RegExp('\\b' + fn + '\\b').test(html), fn);
    });
    // toda función que un onclick invoque tiene que existir
    const llamadas = [...js.matchAll(/onclick=\\?["']([a-zA-Z_$][\w$]*)\(/g)].map((m) => m[1]);
    const faltan = [...new Set(llamadas)].filter((fn) => !new RegExp('function\\s+' + fn + '\\b').test(js));
    check('foto: no hay botones que llamen a funciones inexistentes', faltan.length === 0, faltan.join(','));
  }

  // ── una pantalla no puede depender de datos que carga OTRA pantalla ──
  // fotoSacar leía window._cxs, que llena la vista de Clientes. Entrando directo a la Foto la lista
  // venía vacía y el botón contestaba "No hay conexiones para sacar" — parecía que no había
  // conexiones configuradas cuando el problema era el orden en que se abrieron las pantallas.
  {
    const html = require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'os.html'), 'utf8');
    const js = (html.match(/<script>([\s\S]*)<\/script>/) || [])[1] || '';
    const crudo = (js.match(/async function fotoSacar[\s\S]*?\n}\n/) || [''])[0];
    // sin comentarios: el propio comentario que explica por qué NO se usa window._cxs lo nombra,
    // y el test lo leía como si fuera código. Una regla que se dispara con su propia explicación
    // es una regla que van a terminar borrando.
    const cuerpo = crudo.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
    check('foto: fotoSacar existe y se pudo aislar', crudo.length > 100, String(crudo.length));
    check('foto: fotoSacar NO lee window._cxs', !/window\._cxs/.test(cuerpo));
    check('foto: fotoSacar pide las conexiones por su cuenta', /casino\/conexiones/.test(cuerpo));
  }

  // ── la vista general va al MISMO lugar que la Foto, y a la vez al caché del pago a proveedores ──
  // Antes eran dos botones pidiéndole lo mismo al casino y guardando en almacenes distintos: un mes
  // podía figurar sacado en una pantalla y faltante en la otra.
  {
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'estadisticas-mes.service.js'), 'utf8');
    check('general: la pasada escribe también el caché del pago a proveedores',
      /_pago_general/.test(src) && /ganCache\.set/.test(src));
    // va troceado por divisa: cada tanda tiene que SUMAR, no pisar lo de las anteriores
    check('general: acumula por divisa en vez de pisar', /ganCache\.get\([^)]*_pago_general/.test(src));

    const html = require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'os.html'), 'utf8');
    check('general: ya no hay una sección aparte en la pantalla',
      !/fotoGeneral|foto-gen/.test(html));
    // Se mira la ESTRUCTURA, no el título: el texto se reescribió una vez y el test se cayó por
    // eso, no porque el bloque hubiera desaparecido. Un test que se rompe al cambiar una palabra
    // enseña a ignorarlo.
    check('general: el bloque de conexiones sigue en pie',
      /class="vcx/.test(html) && /fotoSacar\(/.test(html));
    // y la vista general tiene que ser una de las vueltas que se muestran
    check('general: aparece como una vuelta más en la pantalla', /Datos generales/.test(html));
  }

  // ── el mes son TRES vueltas, no dos ──
  // El plan contaba sólo superagente y distribuidor, así que un mes decía "completa" faltando
  // Datos generales — justo la que dice cuánto le debemos nosotros al proveedor.
  {
    const em = require('../src/estadisticas-mes.service');
    check('vueltas: son tres', (em.VUELTAS || []).length === 3, JSON.stringify(em.VUELTAS));
    check('vueltas: incluye la general', (em.VUELTAS || []).includes('nodo'));
    // y NIVELES sigue siendo sólo los niveles de cuenta: lo usa la limpieza de grupos viejos, y
    // meterle 'nodo' ahí no cambia nada, pero sacárselo borraría la vista general entera.
    check('vueltas: NIVELES sigue con los dos niveles de cuenta',
      (em.NIVELES || []).join(',') === 'superagente,distribuidor', JSON.stringify(em.NIVELES));
    check('vueltas: la limpieza conserva la general',
      [...em.NIVELES, 'nodo'].includes('nodo'));
  }

  // ── que el estado de cada vuelta SE LEA ──
  // Antes era un botón relleno de magenta con el detalle adentro en gris: el texto no se veía. La
  // regla que quedó es que el relleno marca el estado y el texto va oscuro sobre claro.
  {
    const html = require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'os.html'), 'utf8');
    const css = (html.match(/<style>([\s\S]*?)<\/style>/) || [])[1] || '';
    const reglas = [...css.matchAll(/\.(vcx|vtab|vta)[^{}]*\{[^}]*\}/g)].map((x) => x[0]);
    check('vueltas: hay reglas de estilo para el bloque', reglas.length > 5, String(reglas.length));
    const conAlfa = reglas.filter((r) => /background:\s*rgba\([^)]*0?\.\d+\)/.test(r));
    check('vueltas: ningún fondo translúcido', conAlfa.length === 0, conAlfa.join(' | ').slice(0, 90));
    // el estado tiene que distinguirse por algo más que el color: hay gente que no lo ve
    check('vueltas: el estado también se marca con un símbolo', /✅/.test(html) && /○/.test(html));
    // el botón va sólo en la vuelta que el casino tiene puesta
    const js = (html.match(/<script>([\s\S]*)<\/script>/) || [])[1] || '';
    check('vueltas: el botón Sacar va sólo en la vuelta activa',
      /vta-ahora/.test(js) && /es \? '<button/.test(js));
  }

  // ── las tres vistas de la factura de proveedores son la misma plata ──
  // Por proveedor, por etiqueta (SL2, OP, XG…) y por divisa. Si no dan el mismo total hay un error
  // de cálculo, y hasta ahora no había forma de notarlo: la planilla vieja se revisaba a ojo.
  {
    const money = require('../src/lib/money');
    const PROV = [
      { proveedor: 'PRAGMATIC SL2', usdt: '30.00', lineas: [
        { conexion: 'Casino', divisa: 'ARS', etiqueta: 'SL2', monto: '30000', tc: '1000', usdt: '30.00' }] },
      { proveedor: 'AMATIC BVS', usdt: '12.00', lineas: [
        { conexion: 'Europa', divisa: 'ARS', etiqueta: 'BVS', monto: '12000', tc: '1000', usdt: '12.00' }] },
      { proveedor: 'PLAYSON XG', usdt: '8.00', lineas: [
        { conexion: 'Casino', divisa: 'USD', etiqueta: 'XG', monto: '8', tc: '1', usdt: '5.00' },
        { conexion: 'Europa', divisa: 'ARS', etiqueta: 'XG', monto: '3000', tc: '1000', usdt: '3.00' }] },
    ];
    const armar = (clave) => {
      const g = new Map();
      PROV.forEach((p) => p.lineas.forEach((l) => {
        const k = clave(l, p) || '—';
        const a = g.get(k) || { clave: k, usdt: '0' };
        a.usdt = money.add(a.usdt, l.usdt); g.set(k, a);
      }));
      return [...g.values()].map((a) => ({ ...a, usdt: money.round(a.usdt, 2) }));
    };
    const sum = (arr) => money.round(money.sum(arr.map((x) => x.usdt)), 2);
    const porEtiqueta = armar((l) => l.etiqueta);
    const porDivisa = armar((l) => l.divisa);
    const totalProv = money.round(money.sum(PROV.map((p) => p.usdt)), 2);

    check('factura: por etiqueta agrupa SL2/BVS/XG', porEtiqueta.length === 3, JSON.stringify(porEtiqueta.map((x) => x.clave)));
    check('factura: por divisa junta las dos conexiones', porDivisa.length === 2, JSON.stringify(porDivisa.map((x) => x.clave)));
    check('factura: las tres vistas dan el mismo total',
      sum(porEtiqueta) === totalProv && sum(porDivisa) === totalProv,
      `prov ${totalProv} · etiq ${sum(porEtiqueta)} · div ${sum(porDivisa)}`);
    // un proveedor repartido en dos divisas no puede contarse dos veces en la vista por etiqueta
    const xg = porEtiqueta.find((x) => x.clave === 'XG');
    check('factura: un proveedor en dos divisas suma una sola vez por etiqueta', xg.usdt === '8', xg.usdt);
  }

  // ── no inventar clases de CSS ──
  // Escribí `class="nota nota-err"` cuatro veces; la clase real es `.nota.err`. No rompe nada:
  // el bloque se dibuja igual pero SIN el color, así que un aviso de error se ve como uno común.
  // Es el peor tipo de error de estilo — no falla, sólo deja de avisar.
  {
    const html = require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'os.html'), 'utf8');
    const css = (html.match(/<style>([\s\S]*?)<\/style>/) || [])[1] || '';
    // los modificadores que la hoja de estilos define para .nota
    const definidos = new Set([...css.matchAll(/\.nota\.([a-z0-9-]+)/g)].map((m) => m[1]));
    check('css: la hoja define modificadores de .nota', definidos.size >= 2, [...definidos].join(','));
    const usados = new Set();
    [...html.matchAll(/class="nota ([^"]*)"/g)].forEach((m) => {
      m[1].split(/\s+/).filter(Boolean).forEach((c) => usados.add(c));
    });
    const inventados = [...usados].filter((c) => !definidos.has(c));
    check('css: ningún class="nota …" usa un modificador inexistente',
      inventados.length === 0, inventados.join(','));
  }

  // ── deducir la etiqueta de las líneas de TBS, sin inventarla ──
  // El casino manda `vendor`; TBS no. Caían 17 proveedores en "—" por 10.781 USDT, varios
  // evidentemente OP. Se deduce del nombre de la matriz, que va "<PROVEEDOR> <ETIQUETA>", pero
  // SÓLO contra etiquetas que el casino informó de verdad: partir por el último espacio a secas
  // convertiría "EVOLUTION LIVE DEALERS" en "DEALERS".
  {
    const reales = new Set(['OP', 'SL2', 'BVS', 'HUB OR', 'OR', 'XG', 'SZ']);
    const A_MANO = [
      { busca: /original[\s_]*dima[\s_]*li/i, etiqueta: 'OR' },
      { busca: /^\s*sportbetting(?=[\s_·]|$)/i, etiqueta: 'SPORTBETTING' },
    ];
    const deducir = (nombre) => {
      const aMano = A_MANO.find((r) => r.busca.test(String(nombre || '')));
      if (aMano) return aMano.etiqueta;
      const limpio = String(nombre || '').replace(/\s*\(TBS\)\s*$/i, '')
        .replace(/[_·]+/g, ' ').replace(/\s+/g, ' ').trim();
      const partes = limpio.split(' ');
      const arriba = limpio.toUpperCase();
      if (reales.has(arriba)) return arriba;
      for (let n = Math.min(3, partes.length - 1); n >= 1; n--) {
        const fin = partes.slice(-n).join(' ').toUpperCase();
        if (reales.has(fin)) return fin;
        const ini = partes.slice(0, n).join(' ').toUpperCase();
        if (reales.has(ini)) return ini;
      }
      return null;
    };
    check('etiqueta: BOOMING OP (TBS) → OP', deducir('BOOMING OP (TBS)') === 'OP', String(deducir('BOOMING OP (TBS)')));
    check('etiqueta: PRAGMATIC SL2 → SL2', deducir('PRAGMATIC SL2') === 'SL2');
    check('etiqueta: prefiere el sufijo largo (HUB OR, no OR)',
      deducir('SA GAMING HUB OR') === 'HUB OR', String(deducir('SA GAMING HUB OR')));
    // lo que NO tiene que hacer
    check('etiqueta: no inventa con EVOLUTION LIVE DEALERS', deducir('EVOLUTION LIVE DEALERS') === null,
      String(deducir('EVOLUTION LIVE DEALERS')));
    check('etiqueta: no inventa con SLOT ZONA', deducir('SLOT ZONA') === null, String(deducir('SLOT ZONA')));
    check('etiqueta: un nombre de una sola palabra no se parte', deducir('Jacktop') === null, String(deducir('Jacktop')));
    // los nombres de TBS separan con guión bajo o con · , no siempre con espacio
    check('etiqueta: Platipus_OP (TBS) → OP', deducir('Platipus_OP (TBS)') === 'OP', String(deducir('Platipus_OP (TBS)')));
    check('etiqueta: el nombre que ES la etiqueta', deducir('SL2 (TBS)') === 'SL2', String(deducir('SL2 (TBS)')));
    check('etiqueta: también al principio (SZ · Slot Zona)',
      deducir('SZ · Slot Zona (TBS)') === 'SZ', String(deducir('SZ · Slot Zona (TBS)')));
    // y sigue sin inventar cuando no hay evidencia
    // Las que el dueño confirmó a mano: el casino no las informa y el nombre no las delata.
    // El de TBS y el del casino son el mismo proveedor y se pagan juntos.
    check('etiqueta: SPORTBETTING_ImperiumBet → SPORTBETTING',
      deducir('SPORTBETTING_ImperiumBet (TBS)') === 'SPORTBETTING', String(deducir('SPORTBETTING_ImperiumBet (TBS)')));
    check('etiqueta: los _Original_Dima_Li → OR',
      deducir('BOOMING_ASIA_KN_Original_Dima_Li (TBS)') === 'OR'
      && deducir('WS_SPORTS_Original_Dima_Li (TBS)') === 'OR');
    // y una regla a mano no puede pisar lo que el casino informa de verdad
    check('etiqueta: lo dicho a mano no se aplica a nombres que no le pegan',
      deducir('PRAGMATIC SL2') === 'SL2' && deducir('BOOMING OP (TBS)') === 'OP');
  }

  // ── LA PANTALLA DE MEDIOS DE PAGO GUARDA TODO LO QUE MUESTRA ──
  //
  // Guardaba 5 de los 12 valores. Los otros 7 —titular, mínimo, máximo, las dos advertencias y los
  // dos grupos de Telegram— existían, se usaban y no tenían dónde escribirse: quedaban de la
  // primera carga y para cambiarlos había que entrar a la API. Justo las advertencias, que son lo
  // que el cliente lee antes de mandar plata a un CVU.
  {
    const rutas = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'os.routes.js'), 'utf8');
    const html = require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'os.html'), 'utf8');
    const claves = (rutas.match(/const PAGOS_KEYS = \[([\s\S]*?)\];/) || [])[1] || '';
    const lista = [...claves.matchAll(/'([a-zA-Z]+)'/g)].map((m) => m[1]);
    check('medios de pago: hay 12 valores', lista.length === 12, String(lista.length));
    const guarda = html.slice(html.indexOf('async function savePagos()'), html.indexOf('async function savePagos()') + 900);
    const faltan = lista.filter((k) => !guarda.includes(k + ':'));
    check('medios de pago: la pantalla guarda TODOS los valores', faltan.length === 0, faltan.join(','));
    const pantalla = html.slice(html.indexOf('Medios de pago (global)'), html.indexOf('async function savePagos()'));
    const sinInput = lista.filter((k) => !pantalla.includes('p.' + k));
    check('medios de pago: la pantalla muestra TODOS los valores', sinInput.length === 0, sinInput.join(','));
  }

  // ── LA VUELTA GENERAL ES LA DE nodo_id VACÍO, NO TODAS LAS DE grupo='nodo' ──
  //
  // `grupo='nodo'` lo escriben dos cosas: la vuelta general —la plataforma entera, con nodo_id
  // vacío— y las capturas por panel, con el id del panel. Rearmar sin filtrar sumaba la plataforma
  // MÁS cada panel de adentro: junio se fue de 28.098,88 a 31.133,77 y siguió cuadrando, porque
  // las cuatro vistas estaban infladas igual. Lo agarró comparar contra el reporte anterior.
  {
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'estadisticas-mes.service.js'), 'utf8');
    const fn = src.slice(src.indexOf('function rehacerPagoGeneralDesdeFoto'),
      src.indexOf('function divisasDeLaFoto') + 400);
    // Se miran las CONSULTAS, no el texto: la primera versión de este check se enganchó con el
    // comentario de arriba, que también dice grupo='nodo', y salió en rojo sin que nada estuviera mal.
    const consultas = (fn.match(/FROM estad_mes[^`]*/g) || []);
    check('foto: la vuelta general se lee con nodo_id vacío',
      consultas.length >= 2 && consultas.every((q) => /nodo_id=''/.test(q)), consultas.join(' | '));
  }

  // ── EL CACHÉ DEL PAGO NO PIERDE DIVISAS ──
  //
  // Tenía dos escritores con listas distintas: la Foto lo llena divisa por divisa con la lista real
  // del panel, y el pago a proveedores lo escribía de una con CURRENCIES, diez códigos a mano que
  // no incluyen PYG, COP, CRC, HNL, USDT, VES, ZAR ni BOB. El segundo pisaba al primero, sin fallar
  // ni quedar a medias: un mes que parecía completo y al que le faltaban divisas enteras. En julio
  // 2026 escondió 1.492,70 USDT de guaraníes, y apareció al cruzar contra la planilla del dueño.
  {
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'pago-proveedores.service.js'), 'utf8');
    check('pago: el caché general se fusiona, no se reemplaza',
      /function guardarGeneral/.test(src) && /\.\.\.base, \.\.\.monedas/.test(src));
    check('pago: ningún set directo del caché general se quedó suelto',
      !/ganCache\.set\(cx\.id, '_pago_general'/.test(src));
    check('pago: la consulta en vivo usa las divisas de la Foto',
      /divisasDeLaFoto\(cx\.id, m\)/.test(src));
    check('pago: si a un mes le faltan divisas que la Foto tiene, se rearma solo',
      /rehacerPagoGeneralDesdeFoto/.test(src));

    // Y la lista explícita del que llama no se filtra contra la constante de diez.
    const api = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'casino-api.js'), 'utf8');
    check('casino: una lista de divisas explícita se respeta tal cual',
      /currencies && currencies\.length\) \? currencies\.slice\(\)/.test(api));
    /* ── Y LA LISTA YA NO ESTÁ ESCRITA A MANO ────────────────────────────────────────────────
       Este check era, hasta el 26-ago-2026, el TESTIGO del bug: dejaba escrito que la constante de
       diez no alcanzaba. La constante siguió ahí y volvió a morder en otro lado — el acumulado le
       pedía al casino sólo esas diez, así que dos cajas de un cliente con 172.892.679 PYG de
       ganancia en agosto simplemente NO APARECÍAN, y la pantalla decía «todavía no hay datos».
       Ahora la lista sale del catálogo de divisas del OS, que es donde ella las administra. */
    const { CURRENCIES_ACTIVAS, CURRENCIES_BASE } = require('../src/casino-api');
    const divSt = require('../src/divisas-store');
    check('casino: las divisas que se le piden salen del catálogo, no de una lista a mano',
      /CURRENCIES_ACTIVAS\(\)/.test(api) && !/const CURRENCIES = \[/.test(api));
    const activas = CURRENCIES_ACTIVAS();
    check('casino: se le piden TODAS las divisas activas del OS',
      divSt.listActivas().map((d) => d.codigo).filter((c) => c !== 'USDT')
        .every((c) => activas.includes(c)),
      `${activas.length} divisas`);
    check('casino: el guaraní entra (era la que faltaba)',
      activas.includes('PYG'),
      'dos cajas con 172.892.679 PYG en agosto no aparecían por esto');
    check('casino: USDT no se le pide al casino, es la unidad de la cuenta de acá',
      !activas.includes('USDT'));
    check('casino: si el catálogo viniera vacío, quedan las de siempre de piso',
      CURRENCIES_BASE.length === 10 && CURRENCIES_BASE.includes('ARS'));
  }

  // ── UN VÍNCULO NUEVO COMPLETA HUECOS, PERO NO PISA LA FOTO ──
  //
  // Titan: estaba vinculado, se lo revinculó, y junio se movió de 7.150 a 6.628 sin que nadie lo
  // pidiera. Por eso la foto manda. Pero un nombre que la foto NO resuelve no está bien resuelto:
  // su ganancia se cae del cálculo entera. El agregado sólo puede llenar huecos.
  {
    const ext = require('../src/externos.service');
    const { db } = require('../src/db');
    db.prepare("DELETE FROM cierre_link WHERE casino LIKE '_test%'").run();
    db.prepare("INSERT INTO cierre_link (casino, matriz) VALUES ('_test hueco', 'DESTINO NUEVO')").run();
    db.prepare("INSERT INTO cierre_link (casino, matriz) VALUES ('_test ya', 'DESTINO DE HOY')").run();

    // Una foto que YA resuelve "_test ya" de otra forma, y no sabe nada de "_test hueco".
    const precios = { costo: { 'ALGO SL2': '0.5' }, links: [{ casino: '_test ya', matriz: 'DESTINO DE LA FOTO' }] };
    const tr = ext.traductor(precios);
    check('vínculos: un nombre sin resolver en la foto toma el vínculo de hoy',
      tr({ label: '_test hueco', vendor: '' }) === 'DESTINO NUEVO');
    check('vínculos: un nombre que la foto YA resuelve no se toca',
      tr({ label: '_test ya', vendor: '' }) === 'DESTINO DE LA FOTO');
    check('vínculos: se informa cuáles se completaron con el vínculo de hoy',
      tr.vinculosNuevos.has('_test hueco') && !tr.vinculosNuevos.has('_test ya'));

    // Y un nombre del casino que coincide con una fila de la foto tampoco se desvía por un vínculo.
    db.prepare("INSERT INTO cierre_link (casino, matriz) VALUES ('_test algo sl2', 'OTRO LADO')").run();
    const tr2 = ext.traductor({ costo: { '_test ALGO SL2': '0.5' }, links: [] });
    check('vínculos: un nombre que ya coincide con una fila no se desvía',
      tr2({ label: '_test ALGO', vendor: 'SL2' }) === '_test ALGO SL2');

    // Sin foto (mes sin congelar) manda la tabla viva y no hay nada que completar.
    const tr3 = ext.traductor(null);
    check('vínculos: sin foto no hay lista de completados', tr3.vinculosNuevos.size === 0);

    db.prepare("DELETE FROM cierre_link WHERE casino LIKE '_test%'").run();
  }

  // ── EL COMPROBANTE ENTRA AUNQUE SEA UNA FOTO DE CELULAR ──
  //
  // La pantalla promete 6 MB y el store acepta 6 MB, pero el parser global cortaba en 1: una foto
  // de celular (2-4 MB, y base64 le suma un tercio) moría con "Unexpected token <", que al cliente
  // no le dice nada y deja el pago sin avisar. El tope grande vale sólo para esta ruta.
  {
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'index.js'), 'utf8');
    const iEsp = src.indexOf("'/api/comprobante', express.json");
    const iGen = src.indexOf("app.use(express.json({ limit: '1mb' }))");
    check('comprobante: tiene su propio límite de subida', iEsp > 0);

    // ── LOS BOTONES DE LA PANTALLA CORREN EN EL ÁMBITO DE LA PÁGINA ─────────────────────────
    // El botón "Aprobar y acreditar" se llama desde un onclick, o sea desde el ámbito global. Su
    // ayudante _cmpMoneda estaba declarado con const ADENTRO de pintarComprobantes: la etiqueta
    // "Acreditar (USDT)" se dibujaba bien —eso pasa adentro de esa función— pero al apretar el
    // botón tiraba ReferenceError y no pasaba NADA. Sin mensaje, sin pedido al servidor.
    // El check no mira dónde está escrito _cmpMoneda: mide lo que importa, que todo lo que usan
    // esos handlers esté declarado donde ellos lo pueden ver.
    {
      const html = require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'os.html'), 'utf8');
      const cuerpoDe = (nombre) => {
        const i = html.indexOf('function ' + nombre + '(');
        if (i < 0) return '';
        const j = html.slice(i + 1).search(/\n(?:async function |function |const |let )/);
        return j < 0 ? html.slice(i) : html.slice(i, i + 1 + j);
      };
      // Declaraciones en columna 0 = las que ve un onclick.
      const globales = new Set([...html.matchAll(/^(?:async )?function (\w+)|^(?:const|let) (\w+)/gm)]
        .map((m) => m[1] || m[2]));
      const usados = new Set();
      ['cmpEquiv', '_cmpResolver'].forEach((fn) => {
        [...cuerpoDe(fn).matchAll(/\b(_[a-zA-Z]\w*)\s*\(/g)].forEach((m) => usados.add(m[1]));
      });
      const huerfanos = [...usados].filter((u) => !globales.has(u));
      check('comprobantes: los handlers no usan ayudantes encerrados en otra función',
        usados.size > 0 && huerfanos.length === 0,
        'usados=[' + [...usados] + '] fuera de alcance=[' + huerfanos + ']');
    }

    // La lista de clientes es de donde sale si la cuenta va en ARS o en USDT. Si la solapa "Por
    // aprobar" no la carga, todos parecen USDT y se acredita con la etiqueta equivocada.
    {
      const html = require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'os.html'), 'utf8');
      const i = html.indexOf('async function pintarComprobantes(');
      const j = html.indexOf('const fila = (c) =>', i);
      check('comprobantes: la solapa carga los clientes antes de pintar',
        i > 0 && j > i && /_clientes\.length/.test(html.slice(i, j)),
        'no carga _clientes en pintarComprobantes');
    }
    check('comprobante: su parser se monta ANTES del general', iEsp > 0 && iEsp < iGen);
    check('comprobante: el resto de la API sigue con 1mb', iGen > 0);
    // El tope de la ruta tiene que dar para los 6 MB que promete la pantalla, más el 33% de base64.
    const lim = (src.match(/'\/api\/comprobante', express\.json\(\{ limit: '(\d+)mb' \}\)/) || [])[1];
    const store = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'comprobantes-store.js'), 'utf8');
    const maxMb = Number((store.match(/MAX_BYTES = (\d+) \* 1024 \* 1024/) || [])[1] || 0);
    check('comprobante: el límite del parser cubre el del store más el base64',
      Number(lim) >= Math.ceil(maxMb * 1.34), `parser ${lim}mb vs store ${maxMb}mb`);
    // Y si se pasa igual, que conteste JSON y no un HTML que el cliente no puede leer.
    check('comprobante: pasarse de tamaño contesta en castellano y en JSON',
      /entity\.too\.large/.test(src) && /demasiado grande/.test(src));
  }

  // ── LA RUTA POR LA QUE PIDEN TODOS LOS CLIENTES CONTESTA ──
  //
  // Este check existe por un 500 que puse yo: agregué la lista de paneles a /api/pedir y no importé
  // el store, así que la pantalla del cliente —la que usan TODOS para pedir fichas— reventaba. Los
  // tests de unidad no lo vieron porque nunca llamaban a la ruta. Ahora se la llama de verdad.
  {
    // Se crea POR LA API y no llamando al store: así el cliente existe en el proceso del server,
    // que es el que va a atender la request. Creándolo por el store desde acá el server no se
    // enteraba y la ruta contestaba 404, que es justo lo que este check NO quiere medir.
    const cod = '_TESTPEDIR';
    const creado = await post('/api/os/clientes', { codigo: cod, nombre: 'Cliente de prueba' });
    const rp = await axios.get(BASE + '/api/pedir/' + cod, { validateStatus: () => true });
    check('cliente: /api/pedir contesta y no explota', rp.status === 200 && rp.data && rp.data.ok === true,
      `${rp.status} ${JSON.stringify(rp.data).slice(0, 120)}`);
    check('cliente: /api/pedir trae lo que la pantalla necesita',
      rp.data && Array.isArray(rp.data.cajas) && 'puedeAvisarPago' in rp.data && 'puedeMoverBalance' in rp.data);
    // Y sin el permiso no se le mandan los paneles: son datos internos que no tiene por qué recibir.
    check('cliente: sin permiso de mover, no recibe la lista de paneles',
      rp.data && Array.isArray(rp.data.paneles) && rp.data.paneles.length === 0);
    const id = creado && creado.data && (creado.data.id || (creado.data.cliente || {}).id);
    if (id) await axios.delete(BASE + '/api/os/clientes/' + id, H());
  }

  // ── UN AVISO TIENE QUE LLEVAR A DONDE SE RESUELVE ──
  //
  // Pasó de verdad: llegó el aviso de un movimiento de fichas, el aviso abría el panel de carga,
  // ahí decía "0 pendientes" y parecía que el pedido se había perdido. Estaba, en el OS. Un aviso
  // que anuncia algo que no se ve donde te deja es peor que no avisar.
  {
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'push.js'), 'utf8');
    const urlDe = (fn) => {
      const i = src.indexOf('function ' + fn);
      const m = /url: '([^']+)'/.exec(src.slice(i, i + 700));
      return m ? m[1] : null;
    };
    check('avisos: el de un pedido abre el panel de carga', urlDe('notifyNewPedido') === '/');
    ['notifyNuevoComprobante', 'notifyNuevaSolicitud', 'notifyNuevoMovimiento'].forEach((fn) => {
      check(`avisos: ${fn} abre el OS, que es donde se aprueba`, urlDe(fn) === '/os', String(urlDe(fn)));
    });
    // Y el panel de carga muestra qué está esperando en el OS, para el que ya está mirando ahí.
    const panel = require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'index.html'), 'utf8');
    check('avisos: el panel dice qué espera en el OS', /function otrasColas/.test(panel));
    check('avisos: y no se lo muestra al operador, que no entra al OS',
      /if \(!box \|\| _soyOperador\) return;/.test(panel));
  }

  // ── EL PULSO COMPARA VENTANAS IGUALES ──
  //
  // Comparaba los 9 días que lleva el mes contra los 31 del anterior: medía el calendario, no el
  // negocio. Todo daba cerca de −71% (que es 1 − 9/31) y 95 de 100 paneles salían en rojo estando
  // la mayoría en alza. No fallaba: daba un número, que es la forma cara de estar mal.
  {
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'pulso.service.js'), 'utf8');
    check('pulso: seriesDe puede cortarse en un día del mes', /function seriesDe\(mes, hastaDia/.test(src));
    check('pulso: el mes anterior se corta en el mismo día',
      /seriesDe\(prev, ultimoDiaMes\)/.test(src));
    // Prorratear sería suponer que todos los días rinden igual, y un domingo no rinde como un martes.
    check('pulso: NO se prorratea multiplicando por los días',
      !/31 \/ dias|dias \/ 31|\* \(31/.test(src));
    check('pulso: dice contra qué comparó', /comparacion: \{[\s\S]{0,200}diasPrev/.test(src));
    check('pulso: avisa si al mes anterior le faltan días en ese tramo', /desparejo/.test(src));

    // Y la vista que pidió el dueño: quién vende menos, por CLIENTE y en dólares.
    check('pulso: hay una vista de venta por cliente', /clientesVenta/.test(src));
    check('pulso: ordenada por dólares perdidos, no por porcentaje',
      /sort\(\(a, b\) => b\.caidaUsdt - a\.caidaUsdt\)/.test(src));
    check('pulso: una moneda sin TC no se suma como cero', /sinTC \+= 1/.test(src));

    // Las dos vistas que faltaban: un panel que BAJA sale en las alertas, pero uno que pasó a CERO
    // desaparece de la lista y el mes siguiente parece que nunca existió. Y uno sin panel en el OS
    // mueve plata que no se le factura a nadie.
    check('pulso: lista los paneles que se apagaron', /const apagados =/.test(src));
    check('pulso: los apagados se miden contra el MISMO tramo', /activosPrev = sPrev\.filter/.test(src));
    check('pulso: lista los que mueven y no son de nadie', /const sinDueno =/.test(src));
    check('pulso: los sin dueño se detectan por no tener cliente', /!nombre\(x\)\.cliente/.test(src));
    const html = require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'os.html'), 'utf8');
    check('pulso: la pantalla muestra las dos', /Se apagaron/.test(html) && /Mueven y no son de nadie/.test(html));

    // El módulo tiene que CARGAR. Este check existe porque una vez declaré dos veces la misma
    // variable y el archivo dejó de parsear: los tests de arriba leen el texto, no lo ejecutan.
    let carga = true; try { require('../src/pulso.service'); } catch (e) { carga = String(e.message); }
    check('pulso: el módulo carga', carga === true, carga === true ? '' : String(carga));
  }

  // ── LA CUENTA PROPIA DE UN CLIENTE ──
  //
  // El código alcanza para pedir fichas —son acciones que después alguien aprueba— pero no para ver
  // plata. La factura ya se mandaba con un token largo justamente por eso; esto mantiene ese
  // estándar en vez de bajarlo a un código corto y adivinable.
  {
    const ac = require('../src/cliente-acceso');
    const h = ac.hashear('probando123');
    check('acceso: la clave se guarda hasheada, no en claro', !h.includes('probando123') && h.includes(':'));
    check('acceso: verifica la correcta', ac.verificar('probando123', h));
    check('acceso: rechaza la incorrecta', !ac.verificar('otra', h));
    check('acceso: no explota con un hash roto', ac.verificar('x', 'basura') === false);
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'cliente-acceso.js'), 'utf8');
    // scrypt y no un hash a secas: está hecho para ser lento, así que probar millones cuesta tiempo.
    check('acceso: usa scrypt', /scryptSync/.test(src));
    // Una comparación normal delata cuántos caracteres se acertaron por el tiempo que tarda.
    check('acceso: compara en tiempo constante', /timingSafeEqual/.test(src));
    // Una clave que se dicta por teléfono no puede tener 0/O ni 1/l/I.
    const cl = ac.generarClave();
    check('acceso: la clave generada no tiene caracteres ambiguos',
      cl.length === 10 && !/[0O1lI]/.test(cl), cl);

    // ── EL TOKEN DE CLIENTE NO SIRVE PARA ENTRAR AL OS ──
    const auth = require('../src/auth');
    /* El token vale mientras el cliente TENGA el acceso prendido: sacárselo lo echa en el momento,
       en vez de dejarlo adentro hasta que el token venza solo. Por eso la prueba usa un cliente de
       verdad y con acceso, no un id inventado. */
    const accT = require('../src/cliente-acceso');
    const cliT = require('../src/clientes-store');
    cliT.list().clientes.filter((x) => x.codigo === 'ZZ-TOK').forEach((x) => cliT.removeCliente(x.id));
    const cTok = cliT.createCliente({ codigo: 'ZZ-TOK', nombre: 'Token' });
    accT.habilitar(cTok.id, { usuario: 'zz-tok', clave: 'clave12345' });
    const t = auth.firmarCliente(cTok.id);
    check('acceso: el token de cliente se lee', auth.clienteDeToken({ headers: { 'x-cuenta': t } }) === cTok.id);
    accT.deshabilitar(cTok.id);
    check('acceso: sacarle el acceso corta la sesión que ya tenía abierta',
      auth.clienteDeToken({ headers: { 'x-cuenta': t } }) === null,
      'antes seguía adentro hasta que el token venciera solo');
    accT.habilitar(cTok.id, { usuario: 'zz-tok', clave: 'clave12345' });
    const t2 = auth.firmarCliente(cTok.id);
    check('acceso: y cambiarle la clave también corta las viejas',
      auth.clienteDeToken({ headers: { 'x-cuenta': t2 } }) === cTok.id
      && (accT.habilitar(cTok.id, { clave: 'otraclave123' }),
        auth.clienteDeToken({ headers: { 'x-cuenta': t2 } }) === null));
    check('acceso: regenerar la clave NO le cambia el usuario',
      accT.habilitar(cTok.id, {}).usuario === 'zz-tok',
      'antes volvía al código y el cliente entraba con un nombre que ya no existía');
    cliT.removeCliente(cTok.id);
    // ⚠️ El cambio tiene que ser SIEMPRE un cambio. Antes ponía 'ff' al final, y cuando la firma
    // ya terminaba en 'ff' —1 de cada 256 veces— el token "manipulado" era idéntico al bueno y el
    // check fallaba sin motivo. Un test que falla a veces enseña a correrlo de nuevo en vez de
    // mirar qué pasó, y el día que falle de verdad tampoco se va a mirar.
    const ultimo = t.slice(-1);
    const roto = t.slice(0, -1) + (ultimo === 'f' ? '0' : 'f');
    check('acceso: un token manipulado se rechaza',
      roto !== t && auth.clienteDeToken({ headers: { 'x-cuenta': roto } }) === null);
    // Otra familia de token a propósito: sin el prefijo, un bug de parseo haría admin a un cliente.
    check('acceso: un token del panel NO vale como cliente',
      auth.clienteDeToken({ headers: { 'x-cuenta': 'ok:admin:1.abc' } }) === null);
    check('acceso: y uno de cliente NO vale para el panel', !auth.isAuthed({ headers: { cookie: 'panel=' + t } }));

    // La ruta es pública pero el DATO no.
    const idx = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'index.js'), 'utf8');
    check('acceso: sin token válido la cuenta contesta 401', /Entrá de nuevo/.test(idx));
    // Nunca decir cuál de los dos falló: confirma qué usuarios existen.
    check('acceso: el login no dice si falló el usuario o la clave',
      /Usuario o contraseña incorrectos/.test(idx));
    const rutas = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'os.routes.js'), 'utf8');
    check('acceso: dos clientes no pueden tener el mismo usuario', /ya lo tiene otro cliente/.test(
      require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'cliente-acceso.js'), 'utf8')));
    check('acceso: hay ruta para prenderlo desde el OS', /clientes\/:id\/acceso/.test(rutas));
    // El estado que ve la pantalla no puede traer el hash.
    check('acceso: el estado no devuelve la clave',
      !/acceso_clave/.test(src.slice(src.indexOf('function estado'))));
  }

  // ── CADA CARGA SUMA SU DEUDA, CON EL TC CONGELADO ──
  //
  // Antes la deuda nacía una vez por mes y entre carga y carga la cuenta no se movía, así que no
  // había forma de decirle al cliente cuánto debía al acreditarle las fichas.
  {
    const dc = require('../src/deuda-carga.service');
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'deuda-carga.service.js'), 'utf8');

    check('deuda por carga: existe el servicio', typeof dc.porCarga === 'function');
    // La deuda es el % base sobre lo cargado, EN LA DIVISA DE LA CARGA. Convertir es otra decisión.
    check('deuda por carga: es el % base sobre lo cargado',
      /money\.pct\(monto, base\)/.test(src));

    // ── CADA DIVISA CON SU PROPIO TIPO DE CAMBIO ──
    // La primera versión tomaba SIEMPRE la cotización del peso y la aplicaba a cualquier moneda: a
    // un cliente con cargas en guaraníes le quedó una deuda de 10.679 USDT cuando eran 2.815 —
    // casi cuatro veces. Y no chillaba: daba un número perfectamente formateado.
    check('deuda por carga: el TC se busca POR DIVISA', /function tcDelDia\(fecha, divisa/.test(src));
    check('deuda por carga: el peso y el resto salen de tablas distintas',
      /tcStore\.listSnapshots/.test(src) && /tcDivisas\.listDias/.test(src));
    check('deuda por carga: tcAhora (que es sólo del peso) no se usa para otras divisas',
      /else if \(divisa === 'ARS'\) r = await tcSvc\.tcAhora/.test(src));
    check('deuda por carga: el dólar no se convierte', /if \(D === 'USD' \|\| D === 'USDT'\) return '1'/.test(src));
    check('deuda por carga: la generación hacia atrás pasa la divisa', /tcDelDia\(f, p\.divisa\)/.test(src));
    // Y si no hay TC de ninguna forma, no se convierte con cualquier cosa.
    check('deuda por carga: sin TC devuelve null en vez de un número cualquiera',
      /return \(t && t\.valor && money\.isPos\(String\(t\.valor\)\)\) \? String\(t\.valor\) : null/.test(src));
    // El TC se congela SÓLO para las cuentas en dólares: una cuenta en pesos no convierte nada.
    check('deuda por carga: sólo congela TC si la cuenta es en dólares',
      /if \(cuentaEn === 'USDT'\)/.test(src));
    check('deuda por carga: una cuenta en pesos no necesita TC',
      /cli\.moneda_cuenta === 'ARS' \? 'ARS' : 'USDT'/.test(src));
    // Y si la fuente no contesta NO se congela con una cotización vieja: se vería igual de bien y
    // estaría mal, y nadie va a volver a mirarla.
    check('deuda por carga: no congela con un TC viejo', /r\.vivo && money\.isPos/.test(src));
    /* ── SIN TC NO SE GRABA UNA CARGA VACÍA ───────────────────────────────────────────────────
       Antes se grababa igual con un texto en las notas ("falta pasarla a dólares"). Con la cuenta
       en dólares y una carga en una moneda que no es el peso ni el dólar, la cara en pesos queda
       en null por definición; sin TC la otra también, y el movimiento entraba con las DOS columnas
       vacías. Sumaba cero, la cuenta corriente cerraba perfecta, y esa comisión no se cobraba
       nunca. El contador que existía para pescarlo (`enOtraMoneda`) pide que la OTRA columna tenga
       algo, así que con las dos vacías no lo veía. */
    check('deuda por carga: sin TC no se graba una carga sin importe',
      /return \{ ok: false, sinTC: true, divisa,/.test(src)
      && /no hay tipo de cambio de \$\{divisa\} para pasar la comisión a dólares/.test(src)
      && !/falta pasarla a dólares/.test(src));
    // El peso era la única divisa sin respaldo: las demás caen al TC del mes dentro de tcDelDia.
    check('deuda por carga: el peso sin cotización viva se valúa con el TC del mes',
      /\} else if \(divisa === 'ARS'\) \{/.test(src) && /tcModo = 'mes';/.test(src));
    // Idempotente por pedido: la ruta de cargar se puede reintentar.
    check('deuda por carga: el mismo pedido no cobra dos veces',
      /m\.pedido_id === pedido\.id/.test(src) && /ya estaba/.test(src));

    // ── EL CIERRE DEL MES NO VUELVE A COBRAR LO QUE YA ESTÁ ──
    // Es el riesgo grande de todo esto: emitir el mes sobre un consumo que ya está en la cuenta
    // cobra lo mismo dos veces, y cuadra en todas las pantallas.
    const rutas = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'os.routes.js'), 'utf8');
    check('cierre: se saltea a los clientes que ya tienen su deuda carga por carga',
      /const yaEnCuenta = deudaCargaSvc\.delMes\(mes\)/.test(rutas)
      && /if \(ya && ya\.cargas\) \{/.test(rutas)
      && /su deuda ya está: no se emite/.test(rutas));
    check('cierre: informa la conciliación en vez de corregir en silencio',
      /conciliado, yaCargaPorCarga: conciliado\.length/.test(rutas));
    check('cierre: la diferencia que muestra es contra el cálculo del mes',
      /diferencia: money\.round\(money\.sub\(c\.fee_usdt, ya\.usdt\), 2\)/.test(rutas));

    // ── ANULAR DA DE BAJA LA DEUDA ──
    // Anular retira las fichas: el cliente no las tiene, así que no las debe. Sin esto la deuda
    // quedaba puesta y el error era invisible — el pedido decía "anulado" y la cuenta lo cobraba.
    check('anulación: existe la baja de la deuda', typeof dc.porAnulacion === 'function');
    // Se CONTRA-ASIENTA, no se borra: borrar deja una cuenta que cuadra y una historia ilegible.
    // El check mira SÓLO porAnulacion: el archivo tiene además un borrarMes que sí borra, y con
    // razón — son dos cosas distintas y la primera versión de este check las confundía.
    const fnAnul = src.slice(src.indexOf('function porAnulacion'), src.indexOf('function generarMes'));
    check('anulación: contra-asienta en vez de borrar',
      /tipo: 'correccion'/.test(fnAnul) && !/movs\.remove/.test(fnAnul));
    // Con el TC de la carga, no el de hoy: si no, anular una carga vieja deja una diferencia de
    // cambio que el cliente nunca pidió, nacida de un error administrativo.
    check('anulación: usa el TC de la carga original',
      /tc_momento: orig\.tc_momento/.test(src) && /el de la carga, no el de hoy/.test(src));
    check('anulación: anular dos veces no acredita dos veces', /ya estaba dada de baja/.test(src));
    // Un rechazado nunca llegó a 'cargado', así que nunca generó deuda: no hay nada que dar de baja.
    check('anulación: sólo aplica a lo que había generado deuda', /esa carga no había generado deuda/.test(src));

    const idx = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'index.js'), 'utf8');
    check('deuda por carga: se genera al cargar las fichas', /deudaCargaSvc\.porCarga\(upd\)/.test(idx));
    check('anulación: se dispara al anular la carga', /deudaCargaSvc\.porAnulacion\(upd\)/.test(idx));
    // Las fichas YA están en el casino: un problema anotando la deuda no puede deshacer eso.
    check('deuda por carga: un fallo no tumba la carga',
      /catch \(e\) \{ console\.warn\('\[Deuda\]/.test(idx));
  }

  // ── LA FACTURACIÓN NO PUEDE CAERSE PORQUE EL SISTEMA VIEJO NO CONTESTA ──
  //
  // El puente traía los pedidos del sistema en línea. Desde la migración los 848 pedidos viven en
  // esta base y el sistema viejo devuelve 401: la facturación mensual ENTERA cortaba con un error
  // y no se podía emitir nada. Nadie lo notó porque nadie había intentado facturar desde entonces.
  {
    const rutas = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'os.routes.js'), 'utf8');
    check('facturación: si el puente falla, usa los pedidos de acá', /avisoPuente = /.test(rutas));
    check('facturación: y lo dice en vez de disimularlo', /avisoPuente,/.test(rutas));
    // NO es un fallback silencioso: las dos fuentes son excluyentes, o los pedidos están allá o
    // están acá. Lo que no puede pasar es que se sumen las dos.
    check('facturación: no se mezclan las dos fuentes',
      /if \(!Object\.keys\(ventasCli\)\.length\) \{/.test(rutas));
    check('facturación: ya no corta con un error cuando el puente no contesta',
      !/no se pudieron traer los pedidos del sistema en línea/.test(rutas));
  }

  // ── LA CUENTA DE UN CLIENTE PUEDE LLEVARSE EN PESOS ──
  //
  // Hay clientes con los que se acuerda en pesos: pagan en USDT y lo que se lleva es el equivalente
  // que se declara al acreditar. Todo lo de acá protege una sola cosa: que NUNCA se sumen pesos con
  // dólares. Un total mezclado cuadra igual, y eso es lo que lo hace caro.
  {
    const d = require('../src/deuda.service');
    const cta = d.cuentaCorriente('no-existe');
    check('cuenta: dice en qué moneda está', cta.moneda === 'USDT');
    check('cuenta: por defecto es USDT', cta.moneda === 'USDT');
    check('cuenta: cuenta los movimientos que quedaron en la otra moneda', 'enOtraMoneda' in cta);

    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'deuda.service.js'), 'utf8');
    // Suma UNA columna, la de su moneda. Nunca las dos, y nunca convierte por su cuenta.
    check('cuenta: suma sólo la columna de su moneda',
      /const col = moneda === 'ARS' \? 'monto_ars' : 'monto_usdt'/.test(src));
    // La sonda anterior buscaba /tc/ y matcheaba cualquier palabra con esas letras — hasta "match".
    // Lo que importa es que no se llame a un servicio de tipo de cambio: convertir por su cuenta
    // sería inventar un número que nadie pidió.
    check('cuenta: no convierte de una moneda a la otra',
      !/tcUnico|tc-unico|tcDelMes/.test(src));

    const rutas = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'os.routes.js'), 'utf8');
    // Lo que resta la deuda es la cara de SU moneda; la otra queda guardada igual.
    check('cuenta: el comprobante se acredita en la moneda del cliente',
      /const moneda = cli\.moneda_cuenta === 'ARS' \? 'ARS' : 'USDT'/.test(rutas)
      && /enArs = monto;/.test(rutas) && /enUsdt = monto;/.test(rutas));
    // Cambiar la moneda no convierte nada: sólo cambia qué columna se suma. Con movimientos
    // cargados, el saldo quedaría en cero como si se hubiera perdido plata.
    check('cuenta: no se cambia la moneda si ya hay movimientos en la otra',
      /function puedeCambiarMoneda/.test(rutas) && /Cerrá la cuenta en/.test(rutas));
    check('cuenta: el candado se aplica al guardar la ficha',
      /puedeCambiarMoneda\(req\.params\.id, req\.body\.moneda_cuenta\)/.test(rutas));

    const html = require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'os.html'), 'utf8');
    check('cuenta: la ficha tiene el selector', /id="e-moneda"/.test(html));
    check('cuenta: el label de acreditar usa la moneda del cliente', /Acreditar \(' \+ esc\(_cmpMoneda/.test(html));
    // El texto que iba fijo en "USDT" era la forma más fácil de mentir sobre una cifra en pesos.
    check('cuenta: ya no dice USDT fijo al acreditar', !/Poné cuántos USDT se acreditan/.test(html));

    const tg = require('../src/telegram');
    // ── UN PAGO GUARDA LAS DOS CARAS Y EL TC ──
    // Es como la dueña lo lleva en su planilla: cada renglón tiene los pesos, el TC y los dólares.
    // Y el TC de un pago NO es la cotización del día — es a cuánto se cambió ESA plata, acordado
    // con quien la cambió. Si no se anota en el momento, después no se reconstruye.
    const rutas2 = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'os.routes.js'), 'utf8');
    check('pago: se guardan las dos caras y el tipo de cambio',
      /monto_usdt: enUsdt, monto_ars: enArs, tc_momento: tc/.test(rutas2));
    check('pago: con TC se completa la otra cara sola',
      /enUsdt = money\.round\(money\.div\(monto, tc\), 2\)/.test(rutas2)
      && /enArs = money\.round\(money\.mul\(monto, tc\), 2\)/.test(rutas2));
    // Sin TC se guarda sólo lo declarado: un dato faltante y visible es mejor que uno inventado
    // con la cotización del día, que NO es la que se usó.
    //
    // Hay DOS maneras de no tener TC y son distintas a propósito:
    //   · a secas          → la otra cara queda vacía y nadie la completa.
    //   · tc_modo:'mes'    → la otra cara se DERIVA al leer, del TC del cierre (src/valuacion.js).
    // Lo que no puede pasar en ninguna de las dos es que se CONGELE un número sacado de la
    // cotización del día. Por eso el check mira que las dos caras sólo se calculen `if (tc)`.
    check('pago: sin TC no se inventa la otra cara',
      /const tcNum = !porElMes && b\.tc != null/.test(rutas2)
      && /if \(tc\) enUsdt = money\.round/.test(rutas2)
      && /if \(tc\) enArs = money\.round/.test(rutas2));
    check('pago: con TC del mes NO se congela ningún tipo de cambio',
      /tc_modo: \(porElMes && monedaCargada !== moneda\) \? 'mes' : null/.test(rutas2)
      && /const porElMes = b\.tc_modo === 'mes'/.test(rutas2));
    check('pago: un TC en cero o negativo se rechaza', /el tipo de cambio tiene que ser mayor a cero/.test(rutas2));
    const html2 = require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'os.html'), 'utf8');
    check('pago: la pantalla pide el tipo de cambio', /cmp-tc-/.test(html2));
    // El equivalente se muestra mientras se escribe: un cero de más en el cambio da un número
    // absurdo, y absurdo se nota. Guardado, no.
    check('pago: muestra el equivalente antes de acreditar', /function cmpEquiv/.test(html2));

    check('cuenta: el aviso al grupo dice la moneda que corresponde',
      /100\.000 ARS/.test(tg.pagoText({ cliente: 'x', monto: '100000', moneda: 'ARS' })));
  }

  // ── UN AVISO QUE NO SALIÓ TIENE QUE VERSE ──
  //
  // Un comprobante no llegó al grupo porque el bot no estaba adentro. El envío falló en un
  // console.warn que se pierde entre despliegues: ni el cliente ni la dueña se enteraron, y lo que
  // se nota es un reclamo semanas después. De paso apareció un tercer grupo roto que nadie sabía.
  {
    const cs = require('../src/comprobantes-store');
    check('comprobante: se puede anotar si el aviso salió', typeof cs.marcarAviso === 'function');
    const store = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'comprobantes-store.js'), 'utf8');
    check('comprobante: la lista trae el estado del aviso', /aviso_ok, aviso_error, aviso_at/.test(store));

    const idx = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'index.js'), 'utf8');
    check('comprobante: el aviso vive en una función reusable', /async function avisarComprobante/.test(idx));

    // ── EL AVISO SALE CUANDO SE APRUEBA, NO CUANDO SE RECIBE ──
    // Antes salía al subirlo y decía "queda pendiente": el grupo se enteraba de algo que todavía no
    // había pasado, y después nadie confirmaba si pasó.
    const rutaCrear = idx.slice(idx.indexOf("app.post('/api/comprobante'"), idx.indexOf('async function avisarComprobante'));
    check('comprobante: al RECIBIRLO ya no se avisa al grupo', !/avisarComprobante\(/.test(rutaCrear));
    const rutas = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'os.routes.js'), 'utf8');
    const resolver = rutas.slice(rutas.indexOf("comprobantes/:id/resolver"), rutas.indexOf('LA FOTO DEL MES'));
    check('comprobante: al APROBARLO sí se avisa', /avisarComprobante/.test(resolver));
    check('comprobante: el aviso no puede tumbar un pago ya registrado',
      /Promise\.resolve\(avisar\(/.test(resolver) && /\.catch\(/.test(resolver));

    // ── VA LA FOTO, Y EL MONTO ACREDITADO ──
    const tg2 = require('../src/telegram');
    check('comprobante: se puede mandar el archivo al grupo', typeof tg2.sendArchivo === 'function');
    const tgSrc2 = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'telegram.js'), 'utf8');
    const fnA = tgSrc2.slice(tgSrc2.indexOf('async function sendArchivo'), tgSrc2.indexOf('/** Texto del aviso de carga'));
    // Una foto se recomprime y a un PDF Telegram lo rechaza como foto: no da lo mismo el método.
    check('comprobante: una imagen va como foto y lo demás como documento',
      /sendPhoto/.test(fnA) && /sendDocument/.test(fnA) && /\^image\\\//.test(fnA));
    const txt2 = tg2.pagoText({ cliente: 'Rafael', monto: '1000', moneda: 'USDT' });
    check('comprobante: el texto es corto — quién y cuánto',
      /Pago realizado/.test(txt2) && /Rafael/.test(txt2) && /1\.000 USDT/.test(txt2)
      && txt2.split('\n').length === 3, JSON.stringify(txt2));
    check('comprobante: no dice "queda pendiente" nunca más', !/queda.*pendiente/i.test(txt2));
    // El declarado y el acreditado son dos números distintos: va el que se acreditó.
    check('comprobante: el aviso usa el monto ACREDITADO', /montoAcreditado/.test(idx));
    check('comprobante: se anota SIEMPRE, salga o no', /comprobantes\.marcarAviso\(c\.id, aviso\)/.test(idx));
    // Sin grupo o sin bot no es "no se intentó": es un aviso que no salió, y hay que verlo igual.
    check('comprobante: sin bot o sin grupo también queda anotado como fallado',
      /el bot de Telegram no está configurado/.test(idx) && /no hay grupo cargado para/.test(idx));
    check('comprobante: hay forma de reintentar el aviso', /\/api\/os\/comprobantes\/:id\/reavisar/.test(idx));

    const html = require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'os.html'), 'utf8');
    // Un pago avisa a DOS grupos —cobranzas y el del cliente— y fallan por separado. La pantalla
    // tiene que mostrar los dos: con un solo cartel, el que falla queda tapado por el que salió.
    check('comprobante: la pantalla muestra los dos avisos por separado',
      /El aviso NO llegó /.test(html) && /c\.aviso_ok/.test(html) && /c\.aviso_cli_ok/.test(html)
      && /al grupo de cobranzas/.test(html) && /al grupo del cliente/.test(html)
      && /Reintentar los avisos/.test(html));
    // Tener los avisos apagados es una DECISIÓN, no una falla: mostrarlo en rojo haría buscar un
    // problema que no existe, y con el tiempo enseñaría a ignorar los carteles rojos.
    check('comprobante: "apagado" no se muestra como error',
      /apagados\|no tiene grupo/.test(html));
    // Reavisar por defecto manda los dos, pero se puede pedir SÓLO el del cliente: para los pagos
    // aprobados antes de que este aviso existiera, reintentar los dos duplicaría la foto en el
    // grupo de cobranzas — y un comprobante repetido ahí se lee como un pago nuevo.
    check('abono: se puede reavisar sólo al cliente, sin duplicar el de cobranzas',
      /solo \|\| ''\) === 'cliente'/.test(idx) && /avisarAbonoAlCliente\(c, cli/.test(idx));
    check('abono: al cliente le llega su propio mensaje, no el de cobranzas',
      /avisarAbonoAlCliente/.test(idx) && /abonoText/.test(idx)
      && /los avisos de ese cliente están apagados/.test(idx));
    // Al cliente se le dice lo que DEPOSITÓ, en su moneda: es lo que puede cruzar contra su
    // comprobante, y es el único número que no se mueve cuando se cierra el TC del mes.
    check('abono: se le dice el monto en la moneda en que pagó',
      /function abonoDelCliente/.test(idx)
      && /const enUsdt = c\.via === 'usdt'/.test(idx)
      && /const propia = enUsdt \? 'monto_usdt' : 'monto_ars'/.test(idx));
    check('comprobante: y ofrece reintentarlo', /function cmpReavisar/.test(html));

    // ── LA CARGA TAMBIÉN ANOTA SI AVISÓ ──
    // Es el otro aviso que salía fire-and-forget: si no llegaba, no quedaba rastro en ningún lado.
    const ps = require('../src/pedidos-store');
    check('carga: se puede anotar si el aviso salió', typeof ps.marcarAviso === 'function');
    check('carga: la carga anota el resultado del aviso', /pedidos\.marcarAviso\(p\.id, tr\)/.test(idx));
    check('carga: sin grupo o sin bot también queda anotado',
      /el cliente no tiene grupo \(ni lo hereda de su vendedor\)/.test(idx));
    check('carga: la anulación anota igual',
      (idx.match(/pedidos\.marcarAviso/g) || []).length >= 4, String((idx.match(/pedidos\.marcarAviso/g) || []).length));
    // La factura NO necesita esto: se manda con un botón y el resultado vuelve a la pantalla en el
    // momento. El problema del silencio es de los avisos automáticos, no de los que uno dispara.
    const rutasF = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'os.routes.js'), 'utf8');
    check('factura: el envío informa el resultado en el momento',
      /no tiene grupo de Telegram, ni él ni su vendedor/.test(rutasF));

    // Y el diagnóstico que encontró todo esto: pregunta sin escribirle a ningún grupo.
    const tg = require('../src/telegram');
    check('telegram: se puede comprobar un chat sin mandarle nada', typeof tg.verChat === 'function');
    const tgSrc = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'telegram.js'), 'utf8');
    const fn = tgSrc.slice(tgSrc.indexOf('async function verChat'), tgSrc.indexOf('/** Texto del aviso de carga'));
    check('telegram: verChat usa getChat y NO sendMessage',
      /getChat/.test(fn) && !/sendMessage/.test(fn));
  }

  // ── ANULAR CORRIGE EL AVISO QUE YA SALIÓ ──
  //
  // Al grupo le llegó "✅ Carga acreditada". Si después se retiran las fichas y no se dice nada, el
  // cliente se queda con un mensaje en el teléfono que dejó de ser cierto.
  {
    const tg = require('../src/telegram');
    const txt = tg.anulacionText({ cajaUsuario: 'LuckyDay-SA', divisa: 'ARS', monto: '50000' });
    check('anular: hay un aviso de anulación', typeof tg.anulacionText === 'function');
    check('anular: dice el usuario, el monto y que las fichas se retiraron',
      /LuckyDay-SA/.test(txt) && /50\.000/.test(txt) && /retiraron/.test(txt));
    check('anular: el nombre de la cuenta no queda como link', /<code>LuckyDay-SA<\/code>/.test(txt));

    const idx = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'index.js'), 'utf8');
    // Hasta la SIGUIENTE ruta, sea cual sea. La primera versión buscaba la próxima de /api/pedidos
    // y, para la última del grupo, caía en un tope fijo de 4000 caracteres: al crecer la ruta el
    // check se puso en rojo con el código intacto. Un recorte por tamaño no describe un bloque.
    const trozo = (ruta) => {
      const i = idx.indexOf(`app.post('/api/pedidos/:id/${ruta}'`);
      if (i < 0) return '';
      const sig = idx.slice(i + 10).search(/\napp\.(get|post|put|delete)\(/);
      return sig > 0 ? idx.slice(i, i + 10 + sig) : idx.slice(i);
    };
    const anular = trozo('anular');
    check('anular: manda el aviso al grupo', /telegram\.anulacionText/.test(anular));
    // Sólo DESPUÉS de que el casino confirmó: avisar una anulación que no se aplicó es peor que
    // no avisar. Se mira que el aviso esté DENTRO del bloque del retiro confirmado — la primera
    // versión de este check comparaba posiciones y se enredó con el `revertirAnulando` del rollback
    // del lock, que está antes. Comparar índices sueltos no describe un bloque.
    // El bloque se recorta contando llaves, no buscando la primera '\n    }': adentro hay
    // try/catch con su propio cierre a esa altura, y la primera versión de este check cortaba ahí
    // — se puso en rojo al agregar la baja de la deuda, con el comportamiento intacto.
    const iOk = anular.indexOf('if (r.ok) {');
    let prof = 0; let fin = iOk;
    for (let i = anular.indexOf('{', iOk); i < anular.length; i += 1) {
      if (anular[i] === '{') prof += 1;
      else if (anular[i] === '}') { prof -= 1; if (prof === 0) { fin = i; break; } }
    }
    const bloqueOk = anular.slice(iOk, fin);
    check('anular: el aviso está dentro del bloque del retiro confirmado',
      iOk > 0 && /telegram\.anulacionText/.test(bloqueOk));
    // Mismo grupo y mismo interruptor que la carga: es la corrección del mismo mensaje.
    check('anular: usa el destino heredado y su interruptor',
      /tgDestino\.destinoDe/.test(anular) && /destA\.enabled/.test(anular));
    // Y RECHAZAR no avisa: un pedido rechazado nunca se cargó, así que no hay nada que corregir.
    // Lo decidió la dueña — prefiere hablarlo por privado.
    check('rechazar: NO manda ningún aviso al grupo', !/telegram\.sendMessage/.test(trozo('rechazar')));
  }

  // ── NINGÚN NOMBRE DE CUENTA SE CONVIERTE EN UN LINK ──
  //
  // Telegram auto-enlaza lo que parece un dominio, y muchos paneles se llaman así: cash365.vip,
  // Ahora463.com, Argenbets.net. Quedaba un link tocable a un sitio de afuera adentro de un aviso
  // nuestro, en el grupo de un cliente. `<code>` es la única marca que Telegram no auto-enlaza.
  {
    const tg = require('../src/telegram');
    const dominio = 'cash365.vip';
    check('telegram: hay un helper para los nombres de cuenta', typeof tg.cuenta === 'function');
    check('telegram: el nombre va en <code>', tg.cuenta(dominio) === `<code>${dominio}</code>`);
    check('telegram: y sigue escapando el HTML', tg.cuenta('<b>x') === '<code>&lt;b&gt;x</code>');

    // Los dos avisos que llevan nombre de cuenta lo usan.
    const enCode = (txt, nom) => new RegExp(`<code>${nom.replace('.', '\\.')}</code>`).test(txt);
    check('telegram: el aviso de carga no enlaza el usuario',
      enCode(tg.cargaText({ cajaUsuario: dominio, divisa: 'ARS', monto: '1' }), dominio));
    const mov = tg.movimientoText({ origen: dominio, destino: 'Ahora463.com', divisa: 'ARS', monto: '1' });
    check('telegram: el aviso de movimiento no enlaza ninguno de los dos',
      enCode(mov, dominio) && enCode(mov, 'Ahora463.com'));
    // Un nombre con forma de dominio NO puede quedar suelto en negrita en ninguno de los dos.
    check('telegram: ningún nombre de cuenta queda fuera de <code>',
      !/<b>[^<]*\.(com|vip|net|online|bet)[^<]*<\/b>/i.test(mov + tg.cargaText({ cajaUsuario: dominio, divisa: 'ARS', monto: '1' })));

    // Y los textos largos que también salen por Telegram: la factura y la cuenta de TBS.
    const fs2 = require('fs'); const path2 = require('path');
    const fac = fs2.readFileSync(path2.join(__dirname, '..', 'src', 'factura.service.js'), 'utf8');
    const cta = fs2.readFileSync(path2.join(__dirname, '..', 'src', 'api-cuenta-doc.js'), 'utf8');
    check('telegram: la factura pasa los nombres de panel por el helper',
      /tg\.cuenta\(p\.panel\)/.test(fac) && /tg\.cuenta\(d\.panel\)/.test(fac));
    check('telegram: la cuenta de TBS también', /tg\.cuenta\(titulo \|\| doc\.cuenta\)/.test(cta));
  }

  // ── DOS COSAS QUE ENCONTRÓ LA REVISIÓN ADVERSARIA ──
  {
    const mv = require('../src/movimientos-panel');
    const svc = require('../src/movimientos-panel.service');
    const { db } = require('../src/db');

    // ── 1. EL MENSAJE AL CLIENTE NO NOMBRA LA PLATAFORMA ──
    // El interno decía «"juanito01" es de Casino y "juanito02" de Europa» y se le devolvía tal cual
    // al cliente por la ruta pública. A qué plataforma pertenece un panel es control interno: por
    // eso la pantalla del cliente recibe un `grupo` opaco y no el nombre del sistema.
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'movimientos-panel.service.js'), 'utf8');
    check('revisar: devuelve un texto interno y otro público', /publico: publico \|\| interno/.test(src));
    const idx = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'index.js'), 'utf8');
    check('revisar: la ruta pública manda el texto PÚBLICO', /aviso: mal \? mal\.publico : null/.test(idx));
    // Y ninguno de los públicos puede nombrar una plataforma.
    const publicos = [...src.matchAll(/no\([^,]+,\s*(`[^`]*`|'[^']*')/g)].map((m) => m[1]);
    check('revisar: ningún texto público nombra Casino ni Europa',
      publicos.length >= 5 && !publicos.some((t) => /casino|europa|sistema/i.test(t)),
      publicos.filter((t) => /casino|europa|sistema/i.test(t)).join(' | ') || `${publicos.length} textos`);

    // ── 2. NO SE PUEDE DESTRABAR ALGO QUE SIGUE VIVO ──
    // La cadena entra a una cola serializada por superagente que comparte con las cargas, y hay
    // superagentes usados por 12 clientes: un movimiento puede esperar minutos, vivo, con el
    // tomado_at viejo. Destrabarlo ahí larga una SEGUNDA corrida del mismo movimiento.
    db.prepare("DELETE FROM movimiento_panel WHERE cliente_id='_test2'").run();
    const r = mv.crear({ cliente_id: '_test2', origen_panel_id: 'pA', destino_panel_id: 'pB', divisa: 'ARS', monto: '10' });
    mv.tomar(r.movimiento.id, 'pendiente');
    db.prepare('UPDATE movimiento_panel SET tomado_at=? WHERE id=?')
      .run(new Date(Date.now() - 60 * 60000).toISOString(), r.movimiento.id);
    mv.marcarEnCurso(r.movimiento.id);
    const d1 = mv.destrabar(r.movimiento.id);
    check('destrabar: se niega si la ejecución sigue viva', !d1.ok && /ejecutando AHORA/.test(d1.error));
    check('destrabar: y no lo cuenta como trabado', mv.counts().trabados === 0);
    mv.quitarEnCurso(r.movimiento.id);
    check('destrabar: si el proceso murió, sí se destraba', mv.destrabar(r.movimiento.id).ok);
    // El registro se limpia pase lo que pase, o un movimiento fallido quedaría imposible de destrabar.
    check('destrabar: el registro se limpia en un finally', /finally \{[\s\S]{0,300}quitarEnCurso/.test(src));
    db.prepare("DELETE FROM movimiento_panel WHERE cliente_id='_test2'").run();
  }

  // ── EL AVISO AL GRUPO CUANDO SE MUEVEN FICHAS ──
  //
  // Va a un grupo REAL de un cliente, así que lo que dice importa tanto como cuándo se manda.
  {
    const tg = require('../src/telegram');
    const txt = tg.movimientoText({ origen: 'LuckyDay-SA', destino: 'cash365.vip', divisa: 'ARS', monto: '150000' });
    check('aviso mover: dice de dónde, a dónde y cuánto',
      /LuckyDay-SA/.test(txt) && /cash365\.vip/.test(txt) && /150\.000/.test(txt) && /ARS/.test(txt));
    // Mismo criterio que el aviso de carga: el grupo puede ser de un vendedor y servir a varios
    // clientes. Lo que identifica el movimiento son los usuarios, que son del cliente.
    check('aviso mover: NO lleva el nombre del cliente',
      !/cliente/i.test(txt.replace(/Fichas movidas/i, '')));
    // Casino/Europa es control interno y no viaja a un grupo de clientes.
    const conSistema = tg.movimientoText({ origen: 'A', destino: 'B', divisa: 'ARS', monto: '1' });
    check('aviso mover: no nombra la plataforma', !/casino|europa/i.test(conSistema));
    check('aviso mover: escapa el HTML de los nombres',
      /&lt;b&gt;/.test(tg.movimientoText({ origen: '<b>x', destino: 'y', divisa: 'ARS', monto: '1' })));

    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'movimientos-panel.service.js'), 'utf8');
    // SÓLO cuando terminó entero: avisar "fichas movidas" con las fichas a mitad de camino es peor
    // que no decir nada.
    const iHecho = src.indexOf('store.marcarHecho');
    const iAviso = src.indexOf('avisarAlGrupo({');
    check('aviso mover: sólo se manda cuando el movimiento terminó', iHecho > 0 && iAviso > iHecho);
    // La primera versión de este check medía CERCANÍA EN EL TEXTO y salía en rojo con el código
    // correcto: el camino de la falla está tres líneas arriba del aviso, pero corta con un return.
    // Ahora se mira el flujo: el bloque de la falla tiene que terminar en return.
    const bloqueFalla = src.slice(src.indexOf('if (!r.ok) {'), src.indexOf('store.marcarHecho'));
    check('aviso mover: el camino de la falla corta con return, antes del aviso',
      /return \{ ok: false/.test(bloqueFalla) && !/avisarAlGrupo/.test(bloqueFalla));
    // Mismo grupo y mismo interruptor que las cargas: para el cliente es la misma conversación.
    check('aviso mover: usa el destino heredado y su interruptor',
      /tgDestino\.destinoDe/.test(src) && /dest\.enabled/.test(src));
    // Que Telegram no conteste no puede tumbar un movimiento que YA se hizo.
    check('aviso mover: es fire-and-forget', /\.then\(/.test(src) && /catch \(e\)/.test(src));
  }

  // ── LA CADENA DE UN MOVIMIENTO ESTÁ BALANCEADA ──
  //
  // Es EL check de todo esto. La cascada de CARGA funde fichas desde el SuperAgente, que tiene
  // saldo ilimitado; usarla para mover regala fichas cuando los dos paneles están emparentados —
  // si el destino cuelga del origen, la carga pasa por el origen y le devuelve lo que se le acababa
  // de retirar. Un movimiento es un PASAJE: sube por una rama y baja por la otra, y cada nodo
  // intermedio recibe y entrega lo mismo.
  {
    const cc = require('../src/carga-cascada.service');
    const P = (nombre, id, nivel, escala) => ({ nombre, id_usuario: id, nivel_usuario: nivel,
      escala, arbol_at: 'x', divisas: ['ARS'], usuario: nombre });
    const cadena = (o, d) => {
      const r = cc.pasosDeMovimiento({ origen: o, destino: d, divisa: 'ARS' });
      return r.bloqueo ? 'BLOQUEO' : r.pasos.map((p) => `${p.op}(${p.login})`).join(' ');
    };
    const SA = { id: 'SA', login: 'sa', nivel: 'S' };
    const B = { id: 'B', login: 'b', nivel: 'D' };

    check('cadena: hermanos → sale de uno y entra al otro',
      cadena(P('A', '1', 'Agente', [SA, B]), P('C', '2', 'Agente', [SA, B])) === 'out(A) in(C)');
    check('cadena: ramas distintas → sube hasta el ancestro y baja',
      cadena(P('A', '1', 'Agente', [SA, { id: 'B1', login: 'b1', nivel: 'D' }]),
        P('C', '2', 'Agente', [SA, { id: 'B2', login: 'b2', nivel: 'D' }])) === 'out(A) out(b1) in(b2) in(C)');
    // Éste es el que regalaba fichas con la cascada de carga: un solo paso, no dos.
    check('cadena: si el destino es padre del origen, es UN solo retiro',
      cadena(P('A', '1', 'Agente', [SA, B]), P('B', 'B', 'Distribuidor', [SA])) === 'out(A)');
    check('cadena: si el origen es padre del destino, es UNA sola carga',
      cadena(P('B', 'B', 'Distribuidor', [SA]), P('A', '1', 'Agente', [SA, B])) === 'in(A)');
    check('cadena: dos SuperAgentes → la casa recibe y entrega',
      cadena(P('A', '1', 'SuperAgente', []), P('C', '2', 'SuperAgente', [])) === 'out(A) in(C)');

    // Cada nodo intermedio tiene que recibir y entregar lo mismo: si un nodo aparece sólo una vez
    // en el medio de la cadena, alguien gana o pierde fichas.
    const r = cc.pasosDeMovimiento({ origen: P('A', '1', 'Agente', [SA, { id: 'B1', login: 'b1', nivel: 'D' }]),
      destino: P('C', '2', 'Agente', [SA, { id: 'B2', login: 'b2', nivel: 'D' }]), divisa: 'ARS' });
    const salidas = r.pasos.filter((p) => p.op === 'out').length;
    const entradas = r.pasos.filter((p) => p.op === 'in').length;
    check('cadena: sale por una rama y entra por la otra, sin sobrantes', salidas >= 1 && entradas >= 1);
    check('cadena: el ancestro común NO es un paso',
      !r.pasos.some((p) => p.id === 'SA'), r.pasos.map((p) => p.id).join(','));

    // Fail-closed: sin árbol conocido no se mueve nada.
    const sinArbol = { ...P('A', '1', 'Agente', [SA, B]), arbol_at: null };
    check('cadena: sin el árbol sincronizado, BLOQUEA',
      cadena(sinArbol, P('C', '2', 'Agente', [SA, B])) === 'BLOQUEO');
    // Una divisa que falta en un eslabón del camino corta antes de mover.
    const sinDiv = P('B2', 'B2', 'Distribuidor', [SA]); sinDiv.divisas = ['USD'];
    const conCamino = P('C', '2', 'Agente', [SA, { id: 'B2', login: 'b2', nivel: 'D', divisas: ['USD'] }]);
    check('cadena: si a un eslabón del camino le falta la divisa, BLOQUEA',
      cadena(P('A', '1', 'Agente', [SA, B]), conCamino) === 'BLOQUEO');

    // Y el recorredor tiene que respetar la operación de cada paso.
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'carga-cascada.service.js'), 'utf8');
    check('cadena: el recorredor respeta el op de cada paso',
      /paso\.op === 'out' \? 'out' : 'in'/.test(src));
    check('cadena: una carga sin op sigue siendo "in"', /const op = paso\.op/.test(src));
  }

  // ── MOVER FICHAS ENTRE PANELES ──
  //
  // Son DOS operaciones contra el casino sin transacción que las abrace. Todo lo que se prueba acá
  // protege una sola cosa: que las fichas no se muevan dos veces ni se den por perdidas.
  {
    const mv = require('../src/movimientos-panel');
    const svc = require('../src/movimientos-panel.service');
    const { db } = require('../src/db');
    db.prepare("DELETE FROM movimiento_panel WHERE cliente_id='_test'").run();
    const base = { cliente_id: '_test', origen_panel_id: 'pA', destino_panel_id: 'pB', divisa: 'ARS', monto: '1000' };

    check('mover: no se mueve a sí mismo',
      !mv.crear({ ...base, destino_panel_id: 'pA' }).ok);
    check('mover: el monto tiene que ser positivo', !mv.crear({ ...base, monto: '0' }).ok);
    check('mover: hace falta la divisa', !mv.crear({ ...base, divisa: '' }).ok);

    const r1 = mv.crear(base, 'cliente');
    check('mover: se crea pendiente', r1.ok && r1.movimiento.estado === 'pendiente');
    // Dos clics no son dos movimientos.
    check('mover: no se puede pedir dos veces lo mismo', !mv.crear(base).ok);

    // ── EL CANDADO ──
    // Dos aprobaciones simultáneas: sólo una toma la fila. Sin esto se mueve dos veces y se
    // factura una — la misma lección que dejó escrita pedidos-store.tomarParaCargar.
    const t1 = mv.tomar(r1.movimiento.id, 'pendiente');
    const t2 = mv.tomar(r1.movimiento.id, 'pendiente');
    check('mover: el candado deja pasar a uno solo', !!t1 && !t2);

    // ── UN ESLABÓN QUE YA SALIÓ NO SE REPITE NUNCA ──
    // En esta cadena repetir no es "cargar de más": es descuadrar dos cuentas.
    mv.guardarPasos(r1.movimiento.id, [{ id: '1', op: 'out', estado: 'ok' }, { id: '2', op: 'in', estado: 'pendiente' }]);
    const suelto = mv.soltar(r1.movimiento.id, 'la cadena se cortó');
    check('mover: si la cadena se corta queda "a_medias", no "pendiente"', suelto.estado === 'a_medias');
    check('mover: y no se puede volver a tomar como pendiente', !mv.tomar(r1.movimiento.id, 'pendiente'));
    check('mover: pero sí se reintenta desde "a_medias"', !!mv.tomar(r1.movimiento.id, 'a_medias'));
    check('mover: los pasos ya hechos quedan guardados',
      (mv.pasosDe(r1.movimiento.id) || []).filter((p) => p.estado === 'ok').length === 1);

    // ── RECHAZAR SÓLO LO QUE NO MOVIÓ NADA ──
    // Rechazar algo ya retirado lo cerraría como si no hubiera pasado, con las fichas afuera.
    mv.soltar(r1.movimiento.id, null);
    const rech = mv.rechazar(r1.movimiento.id, 'probando');
    check('mover: no se rechaza uno que ya retiró las fichas', rech && rech.ok === false);

    // ── DESTRABAR VUELVE AL ESTADO QUE CORRESPONDE, NO AL QUE UNO QUIERA ──
    const r2 = mv.crear({ ...base, monto: '2000' });
    mv.tomar(r2.movimiento.id, 'pendiente');
    check('mover: no se destraba uno recién tomado', !mv.destrabar(r2.movimiento.id).ok);
    db.prepare('UPDATE movimiento_panel SET tomado_at=? WHERE id=?')
      .run(new Date(Date.now() - 60 * 60000).toISOString(), r2.movimiento.id);
    const d2 = mv.destrabar(r2.movimiento.id);
    check('mover: sin retiro hecho, destrabar vuelve a pendiente', d2.ok && d2.vuelveA === 'pendiente');
    mv.tomar(r2.movimiento.id, 'pendiente');
    mv.guardarPasos(r2.movimiento.id, [{ id: '1', op: 'out', estado: 'ok' }]);
    db.prepare('UPDATE movimiento_panel SET tomado_at=? WHERE id=?')
      .run(new Date(Date.now() - 60 * 60000).toISOString(), r2.movimiento.id);
    const d3 = mv.destrabar(r2.movimiento.id);
    check('mover: con pasos hechos, destrabar vuelve a a_medias', d3.ok && d3.vuelveA === 'a_medias');

    // ── LOS QUE PIDEN ATENCIÓN INCLUYEN LOS QUE QUEDARON A MEDIAS ──
    const c = mv.counts();
    check('mover: los "a medias" cuentan como que piden atención', c.requierenAtencion >= c.a_medias);

    // ── EL PERMISO SE MIRA AL MOVER, NO SÓLO AL PEDIR ──
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'movimientos-panel.service.js'), 'utf8');
    check('mover: el permiso mover_balance se comprueba al ejecutar', /cli\.mover_balance/.test(src));
    check('mover: se comprueba que los dos paneles sean del cliente', /no es de ese cliente/.test(src));
    /* Cruzar de plataforma SE PUEDE, pero lo origina ella. El cliente pide desde una pantalla
       donde ni se entera de que hay dos plataformas: un pedido suyo que cruzara sería un pedido
       que no entendió lo que estaba pidiendo. */
    check('mover: el cliente no puede pedir un pase entre plataformas',
      /permitirCruce/.test(src) && /pase entre plataformas/.test(src));
    check('mover: y ella sí, aprobándolo desde el panel',
      /revisar\(m0, \{ permitirCruce: true \}\)/.test(src));
    // ── LO QUE MÁS IMPORTA: UN MOVIMIENTO NO PUEDE USAR LA CASCADA DE CARGA ──
    // Esa cascada FUNDE fichas desde el SuperAgente, que tiene saldo ilimitado. Usarla para mover
    // regala fichas cuando los dos paneles están emparentados, y cuadra en todas las pantallas.
    check('mover: NO se usa la cascada de carga', !/pasosDe\(\{/.test(src) && /pasosDeMovimiento/.test(src));
    check('mover: los pasos se guardan después de cada uno',
      /onPaso:/.test(src) && /store\.guardarPasos\(id, pasos\)/.test(src));
    /* El orden NO es un detalle: si se cargara primero y se cortara, el cliente se quedaría con
       las fichas de regalo y ninguna pantalla lo diría. */
    check('mover: en un pase se saca primero y se pone después',
      /op === 'in'/.test(src) && src.indexOf('sis: origen.sistema') < src.indexOf('sis: destino.sistema'));
    check('mover: antes de sacar nada se comprueba que el destino pueda recibir',
      /destinoPuedeRecibir/.test(src) && /No se sacó nada del origen/.test(src));
    check('mover: el texto de dónde quedaron las fichas ya no nombra el nodo equivocado',
      /function dondeEstan/.test(src) && /al PADRE de X/.test(src),
      'un out(X) que salió bien NO deja las fichas en X');
    /* La cadena de un pase: dos pasos, y el SuperAgente de cada lado es el APOYO, no un paso. */
    const casc = require('../src/carga-cascada.service');
    const mkPan = (nom, sis, uid, saId, saNom) => ({ id: 'p_' + nom, nombre: nom, sistema: sis,
      arbol_at: 'x', id_usuario: uid, usuario: nom, nivel_usuario: 'Distribuidor', divisas: ['ARS'],
      escala: [{ id: saId, login: saNom, nivel: 'SuperAgente', divisas: ['ARS'] }] });
    const planPase = casc.pasosDeMovimiento({
      origen: mkPan('OrigCas', 'Casino', '111', '900', 'SA-Casino'),
      destino: mkPan('DestEur', 'Europa', '222', '901', 'SA-Europa'), divisa: 'ARS' });
    check('pase: la cadena entre plataformas son DOS pasos, uno por lado',
      planPase.cruce === true && !planPase.bloqueo && planPase.pasos.length === 2
      && planPase.pasos[0].op === 'out' && planPase.pasos[0].login === 'OrigCas'
      && planPase.pasos[1].op === 'in' && planPase.pasos[1].login === 'DestEur',
      planPase.pasos.map((x) => `${x.op}(${x.login})`).join(' → '));
    /* ⚠️ Arriba del SuperAgente no hay ninguna cuenta con saldo — las credenciales con las que el
       sistema se conecta son de administración y no tienen billetera. Si la cadena subiera más
       allá, las fichas quedarían donde no se pueden mirar. */
    check('pase: el SuperAgente de cada lado es donde descansan, no un paso',
      !planPase.pasos.some((x) => /^SA-/.test(x.login))
      && planPase.apoyoOrigen.login === 'SA-Casino' && planPase.apoyoDestino.login === 'SA-Europa');
    check('pase: cada paso sabe contra qué plataforma corre',
      planPase.pasos[0].sistema === 'Casino' && planPase.pasos[1].sistema === 'Europa',
      'sin la etiqueta no hay forma de saber qué mitad ya salió al retomar');
    /* Un movimiento del MISMO sistema tiene que salir igual que siempre. */
    const planMismo = casc.pasosDeMovimiento({
      origen: mkPan('A', 'Casino', '111', '900', 'SA-Casino'),
      destino: mkPan('B', 'Casino', '222', '900', 'SA-Casino'), divisa: 'ARS' });
    check('pase: un movimiento del mismo sistema no cambió en nada',
      planMismo.cruce === false && planMismo.pasos.length === 2
      && planMismo.pivote && planMismo.pivote.login === 'SA-Casino'
      && planMismo.pasos.every((x) => x.sistema === null),
      'el ancestro común sigue sin ser un paso');
    check('mover: al retomar se compara también la plataforma de cada paso',
      /String\(p\.sistema \|\| ''\) === String\(plan\.pasos\[i\]\.sistema \|\| ''\)/.test(src),
      'dos ids iguales de plataformas distintas comparan iguales y saltearían media cadena');

    // La ruta del cliente sólo CREA. Ejecutar vive en /api/os/*, que pide sesión.
    const auth = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'auth.js'), 'utf8');
    const publicas = (auth.match(/const PUBLIC = \[([\s\S]*?)\];/) || [])[1] || '';
    check('mover: pedir un movimiento es público (el cliente no tiene usuario)', /movimiento-panel/.test(publicas));
    const opera = (auth.match(/const OPERADOR_PUEDE = \[([\s\S]*?)\];/) || [])[1] || '';
    check('mover: el operador no mueve fichas entre paneles', !/movimiento-panel/.test(opera));

    db.prepare("DELETE FROM movimiento_panel WHERE cliente_id='_test'").run();
  }

  // ── EL ARCHIVO DE DOCUMENTOS EMITIDOS ──
  //
  // Lo que este bloque protege es una sola frase del dueño: "quiero siempre poder acceder a
  // EXACTAMENTE lo mismo que envié". Todo lo demás se puede rediseñar; esto no.
  {
    const docs = require('../src/documentos');
    const { db } = require('../src/db');
    // La base rechaza borrar (es el punto), así que para limpiar lo de la corrida anterior hay que
    // sacar el trigger y volver a ponerlo. Que limpiar sea incómodo es exactamente lo que se buscaba.
    db.exec('DROP TRIGGER IF EXISTS tr_doc_no_delete');
    db.prepare("DELETE FROM documento_emitido WHERE tipo='_test'").run();
    db.exec(`CREATE TRIGGER IF NOT EXISTS tr_doc_no_delete BEFORE DELETE ON documento_emitido
      BEGIN SELECT RAISE(ABORT, 'un documento emitido no se borra'); END;`);

    const datos = { ok: true, mes: '2026-06', cuadre: { proveedores: '100.50', cuadra: true },
      totales: { usdt: '100.50', proveedores: 2 } };
    const r1 = docs.emitir({ tipo: '_test', mes: '2026-06', datos, congelado: true, csv: 'a,b\n1,2',
      render: (e) => `<html>doc ${e.id} v${e.version}</html>`, por: 'admin', nota: 'primera' });
    check('documentos: emitir devuelve la versión 1', r1.ok && r1.documento.version === 1);
    check('documentos: guarda el total', r1.ok && r1.documento.total_usdt === '100.50');
    check('documentos: guarda si el mes estaba congelado', r1.documento.congelado === 1);
    check('documentos: guarda el CSV congelado', docs.contenido(r1.documento.id).csv === 'a,b\n1,2');

    // ── EMITIR DOS VECES LO MISMO NO CREA DOS DOCUMENTOS ──
    // Dos clics seguidos, o emitir tres días seguidos sin que haya entrado nada nuevo, son el mismo
    // documento. Se compara el JSON y no el HTML: el HTML lleva el id y la fecha adentro, así que
    // dos renders nunca son iguales byte a byte y compararlos no serviría de nada.
    const rDup = docs.emitir({ tipo: '_test', mes: '2026-06', datos,
      render: (e) => `<html>doc ${e.id} v${e.version}</html>`, por: 'admin' });
    check('documentos: emitir el mismo dato devuelve el que ya estaba',
      rDup.ok && rDup.yaEstaba === true && rDup.documento.id === r1.documento.id);
    check('documentos: y no creó una versión nueva', docs.versiones('_test', '2026-06') === 1);

    // ── CON DATOS DISTINTOS SÍ, Y NO PISA ──
    // Pisar la copia de lo que ya se mandó es exactamente lo que este archivo existe para impedir.
    const datos2 = { ...datos, cuadre: { proveedores: '200.00', cuadra: true } };
    const r2 = docs.emitir({ tipo: '_test', mes: '2026-06', datos: datos2,
      render: (e) => `<html>OTRA COSA ${e.version}</html>`, por: 'admin' });
    check('documentos: con datos distintos crea la versión 2', r2.ok && r2.documento.version === 2);
    const v1 = docs.contenido(r1.documento.id);
    check('documentos: la versión 1 sigue diciendo lo mismo', /doc .* v1/.test(v1.html));
    check('documentos: la versión 1 no se contaminó con la 2', !/OTRA COSA/.test(v1.html));

    // ── EL SELLO VA ADENTRO ──
    // Si el sello estuviera fuera del HTML, el papel impreso no diría cuál de las versiones es.
    check('documentos: el sello de emisión va dentro del documento',
      v1.html.includes(r1.documento.id) && /v1/.test(v1.html));

    // ── LA BASE RECHAZA MODIFICAR Y BORRAR ──
    // El módulo no tiene UPDATE ni DELETE, pero el módulo lo puede cambiar dentro de seis meses
    // alguien apurado. La tabla no.
    let bloqueoU = false; let bloqueoD = false;
    try { db.prepare('UPDATE documento_emitido SET nota=? WHERE id=?').run('x', r1.documento.id); }
    catch (e) { bloqueoU = /no se modifica/.test(String(e.message)); }
    try { db.prepare('DELETE FROM documento_emitido WHERE id=?').run(r1.documento.id); }
    catch (e) { bloqueoD = /no se borra/.test(String(e.message)); }
    check('documentos: la base rechaza modificar un documento emitido', bloqueoU);
    check('documentos: la base rechaza borrar un documento emitido', bloqueoD);

    // ── EL HASH SE VERIFICA, NO SE CONFÍA ──
    // Para probar que la huella delata un cambio hay que poder hacer el cambio: se saca el trigger,
    // se ensucia y se lo vuelve a poner. Es la única forma de comprobar que la verificación sirve.
    check('documentos: un documento recién emitido está intacto', v1.intacto === true);
    db.exec('DROP TRIGGER tr_doc_no_update');
    db.prepare('UPDATE documento_emitido SET html=? WHERE id=?').run('<html>manoseado</html>', r1.documento.id);
    db.exec(`CREATE TRIGGER IF NOT EXISTS tr_doc_no_update BEFORE UPDATE ON documento_emitido
      BEGIN SELECT RAISE(ABORT, 'un documento emitido no se modifica: emití una versión nueva'); END;`);
    check('documentos: si alguien toca el contenido, la huella lo delata',
      docs.contenido(r1.documento.id).intacto === false);

    check('documentos: se listan del más nuevo al más viejo',
      docs.list({ tipo: '_test' })[0].version === 2);
    check('documentos: list no arrastra el html ni los datos',
      docs.list({ tipo: '_test' }).every((d) => d.html === undefined && d.datos === undefined));
    check('documentos: versiones() cuenta las del mes', docs.versiones('_test', '2026-06') === 2);

    // ── NO SE EMITE CUALQUIER COSA ──
    const datos3 = { ...datos, cuadre: { proveedores: '300.00', cuadra: true } };
    check('documentos: no se emite sin mes válido',
      !docs.emitir({ tipo: '_test', mes: 'ayer', datos: datos3, render: () => 'x' }).ok);
    check('documentos: no se emite un documento vacío',
      !docs.emitir({ tipo: '_test', mes: '2026-06', datos: datos3, render: () => '   ' }).ok);
    // Un render que explota no puede dejar una fila a medias en el archivo.
    const antes = docs.list({ tipo: '_test' }).length;
    check('documentos: si el render falla, no se guarda nada',
      !docs.emitir({ tipo: '_test', mes: '2026-06', datos: datos3, render: () => { throw new Error('boom'); } }).ok
      && docs.list({ tipo: '_test' }).length === antes);

    // El módulo NO expone forma de borrar: es de sólo agregar, a propósito.
    check('documentos: no hay forma de borrar un documento emitido',
      typeof docs.remove !== 'function' && typeof docs.borrar !== 'function');
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'documentos.js'), 'utf8');
    check('documentos: el store no hace UPDATE ni DELETE', !/UPDATE documento_emitido|DELETE FROM documento_emitido/.test(src));

    db.exec('DROP TRIGGER IF EXISTS tr_doc_no_delete');
    db.prepare("DELETE FROM documento_emitido WHERE tipo='_test'").run();
    db.exec(`CREATE TRIGGER IF NOT EXISTS tr_doc_no_delete BEFORE DELETE ON documento_emitido
      BEGIN SELECT RAISE(ABORT, 'un documento emitido no se borra'); END;`);
  }

  // ── un documento emitido tampoco se sirve sin sesión: dice el margen del negocio ──
  {
    const rd = await axios.get(BASE + '/api/os/documentos?tipo=pago-proveedores',
      { validateStatus: () => true, maxRedirects: 0 });
    check('documentos: sin sesión no se listan', rd.status === 401 || rd.status === 302, String(rd.status));
    const auth = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'auth.js'), 'utf8');
    const opera = (auth.match(/const OPERADOR_PUEDE = \[([\s\S]*?)\];/) || [])[1] || '';
    // El operador ve y despacha pedidos. Emitir documentos con los márgenes adentro no es su trabajo.
    check('documentos: el operador no puede emitir ni verlos', !/documentos/.test(opera));
  }

  // ── la hoja de pago a proveedores es INTERNA ──
  // Dice cuánto se le paga a cada proveedor y a qué costo: el margen del negocio. A diferencia de
  // la cuenta de un cliente, NO puede tener link público — si mañana alguien agrega uno hay que
  // decidir antes qué columnas se muestran, como se hizo con la de TBS.
  {
    const auth = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'auth.js'), 'utf8');
    const publicas = (auth.match(/const PUBLIC = \[([\s\S]*?)\];/) || [])[1] || '';
    check('hoja: la ruta de pago a proveedores NO está entre las públicas',
      !/pago-proveedores/.test(publicas));
    const rc = await axios.get(BASE + '/api/os/pago-proveedores/hoja?mes=2026-07',
      { validateStatus: () => true, maxRedirects: 0 });
    check('hoja: sin sesión no se sirve', rc.status === 401 || rc.status === 302, String(rc.status));

    // y que arme algo legible aunque el reporte venga vacío
    const { hoja } = require('../src/pago-proveedores-html');
    const vacio = hoja({ ok: true, mes: '2026-07', proveedores: [], porEtiqueta: [], porDivisa: [],
      porConexion: {}, cuadre: { proveedores: '0', etiquetas: '0', divisas: '0', cuadra: true } });
    check('hoja: se arma con un mes vacío', /Pago a proveedores/.test(vacio) && vacio.length > 400);
    const roto = hoja({ ok: true, mes: '2026-07', proveedores: [], porEtiqueta: [], porDivisa: [],
      porConexion: {}, cuadre: { proveedores: '10', etiquetas: '9', divisas: '10', cuadra: false } });
    check('hoja: si no cuadra lo dice y avisa que no se pague', /NO cuadra/.test(roto) && /no pagar/i.test(roto));
  }

  // ── el agrupamiento que dictó el dueño ──
  // El vendor del casino es mas fino que los grupos con los que el paga: unos se juntan, otros se
  // llaman distinto, y "default" no es un grupo sino "sin integración".
  {
    const JUNTA = { 'OP PREMIUM': 'OP', 'HUB OR': 'GameHub', 'HUB OR PREMIUM': 'GameHub', TOMHORN: 'TH' };
    const POR_NOMBRE = [
      { busca: /^caleta\b/i, grupo: 'Caleta' }, { busca: /^dlv\b/i, grupo: 'DLV' },
      { busca: /^flg\b/i, grupo: 'FLG' }, { busca: /^holi[\s_]*bet\b/i, grupo: 'HOLI_BET' },
      { busca: /^jacktop\b/i, grupo: 'Jacktop' }, { busca: /^sport[\s_]*betting\b/i, grupo: 'SPORTBETTING' },
      { busca: /^ws[\s_]*sports\b/i, grupo: 'OR' },
    ];
    const grupoDe = (etiqueta, nombre) => {
      let e = etiqueta;
      if (!e || e === '—' || /^default$/i.test(e)) {
        const r = POR_NOMBRE.find((x) => x.busca.test(String(nombre || '').trim()));
        if (r) e = r.grupo;
      }
      return JUNTA[String(e || '').toUpperCase()] || JUNTA[e] || e;
    };
    check('grupos: OP PREMIUM se paga con OP', grupoDe('OP PREMIUM', 'EVOLUTION LOBBY OP PREMIUM') === 'OP');
    check('grupos: HUB OR y HUB OR PREMIUM son GameHub',
      grupoDe('HUB OR', 'EZUGI HUB OR') === 'GameHub' && grupoDe('HUB OR PREMIUM', 'EZUGI HUB OR PREMIUM') === 'GameHub');
    check('grupos: TOMHORN se llama TH', grupoDe('TOMHORN', 'TOM HORN TOMHORN') === 'TH');
    // "default" se abre por nombre: los siete que caían juntos van a siete lados
    check('grupos: CALETA default → Caleta', grupoDe('default', 'CALETA default') === 'Caleta');
    check('grupos: JACKTOP default → Jacktop', grupoDe('default', 'JACKTOP default') === 'Jacktop');
    check('grupos: SPORT BETTING default → SPORTBETTING', grupoDe('default', 'SPORT BETTING default') === 'SPORTBETTING');
    check('grupos: dos "default" distintos NO terminan juntos',
      grupoDe('default', 'CALETA default') !== grupoDe('default', 'DLV default'));
    // un vendor que no está en la tabla se queda con su nombre, no se mete en un grupo ajeno
    check('grupos: un vendor nuevo aparece solo', grupoDe('ZZZNUEVO', 'ALGO ZZZNUEVO') === 'ZZZNUEVO');
    check('grupos: WS SPORTS default → OR', grupoDe('default', 'WS SPORTS default') === 'OR');
  }

  // ── la hoja es un DOCUMENTO: una vista por página, cada una con su resumen adelante ──
  //
  // Los checks miran DENTRO de cada sección y no en el documento entero: las etiquetas ahora
  // aparecen en tres hojas distintas (proveedor, etiqueta, sistema), así que un indexOf global
  // mide cualquier cosa. Fue justo lo que pasó cuando la hoja pasó de tres tablas corridas a seis
  // páginas: el test seguía en verde por casualidad o en rojo sin que nada estuviera mal.
  {
    const { hoja } = require('../src/pago-proveedores-html');
    const REP = { ok: true, mes: '2026-06', congelado: true,
      porConexion: { Casino: { usdt: '6', filas: 1 }, TBS: { usdt: '4', filas: 1 } },
      proveedores: [
        { proveedor: 'ZETA OP', costo: '6', usdt: '2', lineas: [{ etiqueta: 'OP', conexion: 'Casino', divisa: 'USD', monto: '2', tc: '1', usdt: '2' }] },
        { proveedor: 'ALFA SL2', costo: '9', usdt: '8', lineas: [{ etiqueta: 'SL2', conexion: 'TBS', divisa: 'ARS', monto: '8000', tc: '1000', usdt: '8' }] }],
      porEtiqueta: [{ clave: 'SL2', usdt: '8', proveedores: ['ALFA SL2'], divisas: ['ARS'] },
        { clave: 'OP', usdt: '2', proveedores: ['ZETA OP'], divisas: ['USD'] }],
      porDivisa: [{ clave: 'USD', usdt: '2', montoLocal: '2', tc: '1' },
        { clave: 'ARS', usdt: '8', montoLocal: '8000', tc: '1000' }],
      porSistema: [{ clave: 'TBS', usdt: '8', proveedores: ['ALFA SL2'], divisas: ['ARS'] },
        { clave: 'Casino', usdt: '2', proveedores: ['ZETA OP'], divisas: ['USD'] }],
      tiposDeCambio: [
        { divisa: 'ARS', tcs: [{ tc: '1000', montoLocal: '8000', usdt: '8', cuantos: 1, proveedores: ['ALFA SL2'] }] },
        { divisa: 'USD', tcs: [{ tc: '1', montoLocal: '2', usdt: '2', cuantos: 1, proveedores: ['ZETA OP'] }] }],
      otros: [{ origen: 'TBS', nombre: 'ig', ref: 'grupo 2', motivo: 'grupo sin equivalencia en la matriz',
        porDivisa: { ARS: '342487.30' }, gananciaUsdt: '241.19', faltanTC: [] }],
      otrosTotal: { gananciaUsdt: '241.19', cuantos: 1 },
      totales: { usdt: '10', proveedores: 2 }, avisos: [],
      cuadre: { proveedores: '10', etiquetas: '10', divisas: '10', sistemas: '10', cuadra: true } };
    const h = hoja(REP);
    // el trozo de HTML de UNA sección, para no medir contra el documento entero
    // El título de cada hoja lleva el mes adentro del <b> ("Por etiqueta · Junio 2026"), así que se
    // busca por el arranque y no por el <b> cerrado.
    const abre = (titulo) => '<b>' + titulo + ' <span class="mes">';
    const seccion = (titulo) => {
      const i0 = h.indexOf(abre(titulo));
      if (i0 < 0) return '';
      const i1 = h.indexOf('<div class="pg">', i0);
      return h.slice(i0, i1 < 0 ? h.length : i1);
    };
    const ordenEn = (titulo, a, b) => { const t = seccion(titulo); return t.indexOf(a) >= 0 && t.indexOf(a) < t.indexOf(b); };

    check('hoja: una página por vista', ['Por proveedor', 'Por etiqueta', 'Por sistema', 'Por divisa']
      .every((t) => seccion(t).length > 0));
    check('hoja: las páginas se separan al imprimir', /\.pg\{page-break-before:always/.test(h));
    // el reporte llega ordenado por monto (SL2 8 antes que OP 2); la hoja tiene que darlo vuelta
    check('hoja: etiquetas en orden alfabético', ordenEn('Por etiqueta', '>OP<', '>SL2<'));
    check('hoja: divisas en orden alfabético', ordenEn('Por divisa', '>ARS<', '>USD<'));
    check('hoja: proveedores en orden alfabético', ordenEn('Por proveedor', 'ALFA SL2', 'ZETA OP'));
    check('hoja: el detalle de cada etiqueta va al pie de SU hoja',
      /Qué incluye cada etiqueta/.test(seccion('Por etiqueta')));
    // y ese detalle tiene que estar DESPUÉS de la tabla de números, no antes
    check('hoja: el detalle va después de los totales de la etiqueta',
      ordenEn('Por etiqueta', '>Total<', 'Qué incluye cada etiqueta'));

    // ── el resumen va ANTES de los datos, en TODAS las secciones ──
    // Es lo que pidió el dueño con estas palabras: "en todas las secciones antes de los datos, algo
    // visible con los resúmenes". Si una sección se agrega después sin resumen, esto lo cachea.
    ['Por proveedor', 'Por etiqueta', 'Por sistema', 'Por divisa', 'Otros'].forEach((t) => {
      const sec = seccion(t);
      check(`hoja: ${t} lleva resumen antes de la tabla`,
        sec.indexOf('<div class="sum">') >= 0 && sec.indexOf('<div class="sum">') < sec.indexOf('<table>'));
    });

    // ── por sistema: tabla cruzada proveedor × panel ──
    check('hoja: por sistema cruza proveedor contra cada panel',
      /<th class="r">Casino<\/th>/.test(seccion('Por sistema')) && /<th class="r">TBS<\/th>/.test(seccion('Por sistema')));

    // ── el pie con los TC usados ──
    check('hoja: al pie están los tipos de cambio usados', /Tipos de cambio usados/.test(h));
    check('hoja: el pie de TC va último', h.indexOf('Tipos de cambio usados') > h.indexOf('<b>Por divisa</b>'));

    // ── "Otros": se ve, y NO se suma al total ──
    // Es plata que existe pero de la que no se sabe el costo. Que aparezca es lo que pidió el dueño;
    // que NO entre al total es lo que impide pagar un número inventado.
    const otros = seccion('Otros');
    check('hoja: Otros lista lo que no se paga', /grupo sin equivalencia/.test(otros) && />ig</.test(otros));
    check('hoja: Otros dice que es ganancia y no lo que se debe', /[Gg]anancia/.test(otros));
    // El total a pagar es 10,00 aunque "Otros" traiga 241,19 de ganancia. Si alguna vez alguien suma
    // las dos cosas, este check es el que lo frena: 251,19 no puede aparecer en ningún lado.
    check('hoja: Otros NO entra en el total a pagar',
      /Total a pagar · Junio 2026<\/div><div class="v">10,00 USDT/.test(h) && !/251,19/.test(h));

    // ── el resumen de la portada ──
    check('hoja: la portada abre con el total y los tres sistemas',
      /Total a pagar/.test(h) && /Casino/.test(h) && /TBS/.test(h));
    check('hoja: el cuadre nombra las cuatro vistas', /cuatro vistas/.test(h));

    // una hoja sin "otros" no inventa la sección
    const hSin = hoja({ ...REP, otros: [], otrosTotal: { gananciaUsdt: '0', cuantos: 0 },
      sinCostoDetalle: [], sinCostoResumen: { cuantos: 0, revisar: 0, familias: [] } });
    check('hoja: sin Otros, no aparece la hoja de Otros', !hSin.includes(abre('Otros')));

    // ── EL MES VA EN CADA HOJA ──
    // Estas hojas se imprimen, se separan y se archivan sueltas. Una que diga "Por etiqueta —
    // 9.872,27 USDT" sin decir de cuándo es no sirve arriba de un escritorio con tres meses encima.
    ['Por proveedor', 'Por etiqueta', 'Por sistema', 'Por divisa', 'Otros', 'Tipos de cambio usados']
      .forEach((t) => check(`hoja: ${t} dice de qué mes es`, /Junio 2026/.test(seccion(t).slice(0, 300))));
    check('hoja: la caja del total dice el mes',
      /Total a pagar · Junio 2026/.test(h));
  }

  // ── la vista general no se puede cachear si el casino está en otro nivel ──
  // `userGroupBy: ''` NO fuerza nada: el casino usa lo que tenga puesto. Sin verificarlo, se traen
  // datos de otro nivel y quedan guardados como si fueran el total de la plataforma. Pasó de
  // verdad: junio quedó con Europa 5.753 en vez de 6.469 y no avisó nada.
  {
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'pago-proveedores.service.js'), 'utf8');
    // las dos puertas por las que se pide la general en vivo
    const llamadas = (src.match(/reporteProveedoresMonedas\(/g) || []).length;
    check('general: hay llamadas en vivo que proteger', llamadas >= 2, String(llamadas));
    const guardas = (src.match(/modoActual\(cli\)/g) || []).length;
    check('general: cada una tiene su chequeo de nivel', guardas >= 2, String(guardas));
    check('general: se exige que el casino esté en "general"', /nivel !== 'general'/.test(src));
    // el chequeo tiene que estar ANTES de la llamada, no después
    const iGuarda = src.indexOf("modoActual(cli)");
    const iLlamada = src.indexOf('reporteProveedoresMonedas(');
    check('general: el chequeo va antes de preguntarle al casino', iGuarda < iLlamada,
      iGuarda + ' vs ' + iLlamada);
  }

  // ── lo ya sacado no se pisa sin que alguien lo pida ──
  // Un mes cerrado ya no cambia: volver a preguntarle al casino solo puede empeorarlo. Si en ese
  // momento esta agrupando distinto, lo bueno se reemplaza por lo malo y no queda rastro. Paso de
  // verdad — junio quedo con Europa en 5.753 en vez de 6.469 por una corrida de mas.
  {
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'estadisticas-mes.service.js'), 'utf8');
    check('rehacer: capturarGlobal no escribe encima si ya está ok',
      /if \(guardar && !rehacer\)/.test(src) && /yaEstaba: true/.test(src));
    const pp = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'pago-proveedores.service.js'), 'utf8');
    check('rehacer: un mes cerrado exige confirmación explícita',
      /mesCerrado\(m\) && !confirmar/.test(pp) && /requiereConfirmar/.test(pp));
    const html = require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'os.html'), 'utf8');
    check('rehacer: la pantalla pregunta antes', /¿Rehacer '\+_fotoMes/.test(html));
    check('rehacer: y manda la bandera al server', /rehacer:!!rehacer/.test(html));

    // la lógica en sí
    const decidir = (yaOk, rehacer) => (yaOk && !rehacer ? 'no toca' : 'saca');
    check('rehacer: sin datos previos, saca', decidir(false, false) === 'saca');
    check('rehacer: con datos previos y sin pedirlo, NO toca', decidir(true, false) === 'no toca');
    check('rehacer: con datos previos y pidiéndolo, saca', decidir(true, true) === 'saca');
  }

  // ── dos funciones con el mismo nombre no fallan: gana la última ──
  // Declaré un apiToggle() para la pantalla de Clientes sin ver que ya existía otro para Cuentas
  // del mes. No da error: JavaScript se queda con la segunda, así que las flechas de una pantalla
  // llaman a la lógica de la otra y las dos dejan de andar, sin nada en la consola.
  {
    const html = require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'os.html'), 'utf8');
    const js = (html.match(/<script>([\s\S]*)<\/script>/) || [])[1] || '';
    const cuenta = {};
    [...js.matchAll(/(?:^|\n)\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g)]
      .forEach((m) => { cuenta[m[1]] = (cuenta[m[1]] || 0) + 1; });
    const repetidas = Object.entries(cuenta).filter(([, n]) => n > 1).map(([k, n]) => `${k}×${n}`);
    check('js: ninguna función declarada dos veces', repetidas.length === 0, repetidas.join(', '));
    // y lo mismo para const/let en el nivel de arriba
    const decl = {};
    [...js.matchAll(/(?:^|\n)(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=/g)]
      .forEach((m) => { decl[m[1]] = (decl[m[1]] || 0) + 1; });
    const dobles = Object.entries(decl).filter(([, n]) => n > 1).map(([k, n]) => `${k}×${n}`);
    check('js: ninguna const/let de arriba declarada dos veces', dobles.length === 0, dobles.join(', '));
  }

  // ── y que la regla se cumpla DE VERDAD contra el server, no sólo en la función ──
  // La función puede estar bien y el middleware no llamarla. Se entra con un operador real y se
  // golpean las rutas: las prohibidas tienen que dar 403, no datos.
  {
    const { spawn } = require('child_process');
    const PUERTO = 3999;
    const srv2 = spawn(process.execPath, [require('path').join(__dirname, '..', 'src', 'index.js')], {
      env: { ...process.env, CHAT_AVISOS_OFF: '1', PORT: String(PUERTO), OPERADOR_USER: 'opetest', OPERADOR_PASSWORD: 'clave-de-prueba-larga',
        DB_FILE: require('path').join(require('os').tmpdir(), 'smoke-roles-' + process.pid + '.sqlite') },
      stdio: 'ignore',
    });
    const B2 = 'http://127.0.0.1:' + PUERTO;
    for (let i = 0; i < 60; i++) {
      try { await axios.get(B2 + '/login', { timeout: 500, validateStatus: () => true }); break; }
      catch (e) { await new Promise((r) => setTimeout(r, 250)); }
    }
    const lg = await axios.post(B2 + '/api/login', { user: 'opetest', password: 'clave-de-prueba-larga' },
      { validateStatus: () => true });
    const ck = (lg.headers['set-cookie'] || []).map((c) => c.split(';')[0]).join('; ');
    check('operador real: puede entrar', lg.status === 200 && lg.data.rol === 'operador', JSON.stringify(lg.data));
    const H2 = { headers: { Cookie: ck }, validateStatus: () => true, maxRedirects: 0 };

    const permitido = await axios.get(B2 + '/api/pedidos', H2);
    check('operador real: ve los pedidos', permitido.status === 200, String(permitido.status));

    // Una PÁGINA que explica, no un redirect en silencio: volver al inicio sin decir nada hace
    // pensar que el botón está roto.
    for (const pag of ['/os', '/tbs']) {
      const rp = await axios.get(B2 + pag, H2);
      check(`operador real: ${pag} explica que no tiene permiso`,
        rp.status === 403 && /ver y aceptar pedidos/.test(String(rp.data))
        && /comunicate con Alexa/i.test(String(rp.data)), String(rp.status));
      check(`operador real: ${pag} NO redirige en silencio`, rp.status !== 302, String(rp.status));
    }
    // y el dueño sí entra
    const rl2 = await axios.post(B2 + '/api/login', { user: 'admin', password: 'admin' }, { validateStatus: () => true });
    const ckAdmin = (rl2.headers['set-cookie'] || []).map((c) => c.split(';')[0]).join('; ');
    const ro = await axios.get(B2 + '/os', { headers: { Cookie: ckAdmin }, validateStatus: () => true, maxRedirects: 0 });
    check('operador real: el dueño SÍ entra al comercial', ro.status === 200, String(ro.status));

    for (const ruta of ['/api/os/clientes', '/api/clientes', '/api/systems', '/api/config',
      '/api/_backup', '/api/os/pago-proveedores?mes=2026-06', '/api/os/api/matriz']) {
      const r2 = await axios.get(B2 + ruta, H2);
      check(`operador real: ${ruta} da 403`, r2.status === 403, String(r2.status));
    }
    srv2.kill();

    // ── la proyección, probada con un cliente COMPLETO ──
    // Contra el server de prueba la lista venía vacía, así que ese chequeo pasaba sin mirar nada.
    // Acá se arma un cliente con todos los campos sensibles y se aplica la misma lista blanca.
    const CAMPOS = ['id', 'codigo', 'nombreVisible', 'nombre', 'estado', 'divisa_fichas',
      'vendedor_id', 'es_vendedor'];
    const crudo = { id: 'c1', codigo: 'L1', nombreVisible: 'Lu', nombre: 'Lu', estado: 'activo',
      divisa_fichas: 'ARS', vendedor_id: 'v1', es_vendedor: false,
      margen_externos_pct: '12', tc_proveedor: '1400', permite_deuda: true,
      ajuste_usdt_pct: '-2.8', telegram: { chat: '-100123' }, momento_pago: 'despues',
      cajas: [{ id: 'k1', usuario: 'u', sistema: 'Casino', userId: '9', divisas: ['ARS'],
        montosRapidos: [1, 2], grupoId: 'g' }] };
    const proyectar = (c) => {
      const o = {};
      CAMPOS.forEach((k) => { if (c[k] !== undefined) o[k] = c[k]; });
      o.cajas = (c.cajas || []).map((k) => ({ id: k.id, usuario: k.usuario, sistema: k.sistema,
        userId: k.userId, divisas: k.divisas }));
      return o;
    };
    const salida = JSON.stringify(proyectar(crudo));
    check('proyección: pasa lo que hace falta para despachar',
      /L1/.test(salida) && /Casino/.test(salida) && /ARS/.test(salida));
    // sin esto la pantalla no arma el arbol y el operador ve una lista plana donde el dueño ve
    // vendedores con su gente adentro: dos pantallas que deberían decir lo mismo, distintas.
    check('proyección: incluye de quién cuelga cada cliente',
      /vendedor_id/.test(salida) && /es_vendedor/.test(salida));
    ['margen_externos_pct', 'tc_proveedor', 'permite_deuda', 'ajuste_usdt_pct', 'telegram',
      'momento_pago', 'grupoId'].forEach((campo) => {
      check(`proyección: NO deja pasar ${campo}`, !salida.includes(campo), salida.slice(0, 60));
    });
    // lo que importa de una lista blanca: un campo NUEVO no se cuela solo
    const conNuevo = proyectar({ ...crudo, secreto_futuro: 'no-deberia-salir' });
    check('proyección: un campo agregado mañana no aparece solo',
      !JSON.stringify(conNuevo).includes('secreto_futuro'));
  }

  // ── PERMISOS DEL OPERADOR ────────────────────────────────────────────────────────────────────
  // Es el test más importante del archivo: si esto falla, alguien que sólo tenía que despachar
  // pedidos está viendo márgenes, deudas y facturas. Se prueba la REGLA, no la pantalla — esconder
  // un botón no esconde nada, el JSON viaja igual.
  {
    const auth = require('../src/auth');
    const P = (m, path) => auth.puedeOperador({ method: m, path });

    // lo que TIENE que poder: despachar
    [['GET', '/api/pedidos'], ['GET', '/api/pedidos/p_1/cascada'],
      ['POST', '/api/pedidos/p_1/cargar'], ['POST', '/api/pedidos/p_1/rechazar'],
      ['POST', '/api/pedidos/p_1/anular'], ['POST', '/api/pedidos/p_1/devolver-trabadas'],
      ['GET', '/api/historial'], ['GET', '/api/despacho/clientes'], ['GET', '/api/despacho/sistemas'],
      ['GET', '/'], ['POST', '/api/logout']]
      .forEach(([m, p]) => check(`operador: puede ${m} ${p}`, P(m, p) === true));

    // lo que NO puede, una por cada cosa que expondría
    [['GET', '/api/os/clientes', 'el OS comercial entero'],
      ['GET', '/api/os/pago-proveedores', 'lo que pagás a proveedores'],
      ['GET', '/api/os/api/matriz', 'los precios de TBS'],
      ['GET', '/api/os/externos/Titan', 'el margen de un cliente'],
      ['GET', '/api/clientes', 'margen_externos_pct y tc_proveedor'],
      ['GET', '/api/systems', 'el usuario con el que se entra al casino'],
      ['GET', '/api/config', 'el token de Telegram'],
      ['GET', '/api/_backup', 'la base entera'],
      ['POST', '/api/_restore', 'reemplazar la base'],
      ['POST', '/api/clientes', 'crear clientes'],
      ['PUT', '/api/clientes/c_1', 'editar un cliente'],
      ['DELETE', '/api/clientes/c_1', 'borrar un cliente'],
      ['POST', '/api/systems', 'agregar un casino'],
      ['POST', '/api/test-credentials', 'probar credenciales'],
      ['PUT', '/api/config', 'cambiar la configuración'],
      ['GET', '/os', 'la pantalla comercial'], ['GET', '/tbs', 'la pantalla de TBS']]
      .forEach(([m, p, porque]) => check(`operador: NO puede ${m} ${p} (${porque})`, P(m, p) === false));

    // LA REGLA DE FONDO: lo que no está en la lista está prohibido. Una ruta inventada tiene que
    // dar false — si diera true, cada endpoint nuevo nacería abierto.
    check('operador: una ruta que no existe está prohibida', P('GET', '/api/loquesea') === false);
    check('operador: y una que se agregue mañana también', P('POST', '/api/os/algo-nuevo/2027') === false);
    // ni siquiera con otro método sobre algo permitido
    check('operador: no puede BORRAR un pedido aunque pueda verlo', P('DELETE', '/api/pedidos/p_1') === false);

    // el operador no existe si no se configuró: sin contraseña por defecto
    check('operador: no existe sin las dos variables de entorno', auth.HAY_OPERADOR === false);
  }

  // ── un panel sin caja es una cuenta a la que nadie puede pedirle fichas ──
  // Panel y caja son la MISMA cuenta del casino guardada dos veces, y se desincronizan sin avisar.
  {
    const pid = (await post('/api/os/paneles', { cliente_id: cli.id, nombre: 'PanelSinCaja',
      sistema: 'Casino', nivel_usuario: 'SuperAgente', id_usuario: '999777', divisas: 'ARS,USD' })).data.panel.id;
    // Crear el panel ya espeja la caja: para probar el repaso hacia atrás hay que sacarla, que es
    // la situación real de los 68 paneles viejos, creados antes de que ese espejo existiera.
    const antes = (await get('/api/clientes')).data.clientes.find((x) => x.id === cli.id);
    const kaja = (antes.cajas || []).find((k) => String(k.userId) === '999777');
    check('cajas: crear un panel ya espeja la caja', !!kaja, JSON.stringify((antes.cajas || []).length));
    await axios.delete(BASE + '/api/clientes/' + cli.id + '/cajas/' + kaja.id, H());
    let r = (await get('/api/os/cajas-faltantes')).data;
    const mio = (r.clientes || []).find((x) => x.cliente_id === cli.id);
    check('cajas: detecta el panel sin caja', !!mio && mio.faltan.some((f) => f.userId === '999777'),
      JSON.stringify((mio || {}).faltan || []).slice(0, 80));

    r = (await post('/api/os/cajas-faltantes', { panel_ids: [pid] })).data;
    check('cajas: la crea con los datos del panel', r.creadas === 1
      && r.hechas[0].userId === '999777' && r.hechas[0].sistema === 'Casino', JSON.stringify(r.hechas));

    // ⚠️ lo que NO puede pasar: dos cajas al mismo nodo. El cliente elegiría entre dos destinos
    // idénticos y la ficha se podría cargar dos veces.
    r = (await post('/api/os/cajas-faltantes', { panel_ids: [pid] })).data;
    check('cajas: no la crea dos veces', r.creadas === 0 && /ya tiene caja/.test(JSON.stringify(r.saltadas)),
      JSON.stringify(r.saltadas));

    const cl2 = (await get('/api/clientes')).data.clientes.find((x) => x.id === cli.id);
    const alNodo = (cl2.cajas || []).filter((k) => String(k.userId) === '999777');
    check('cajas: quedó UNA sola para ese nodo', alNodo.length === 1, String(alNodo.length));
    check('cajas: se copiaron las divisas del panel',
      (alNodo[0].divisas || []).join(',') === 'ARS,USD', JSON.stringify(alNodo[0].divisas));

    // ── mandar la caja a OTRO cliente que el dueño del panel ──
    // Pasa de verdad: el panel figura a nombre del vendedor pero las fichas las pide el cliente
    // final. Si el destino no se respetara, las fichas irían a la lista de pedidos equivocada.
    {
      const otro = (await post('/api/clientes', { codigo: 'OTRO9', nombreVisible: 'Otro' })).data.cliente;
      const p2 = (await post('/api/os/paneles', { cliente_id: cli.id, nombre: 'PanelAjeno',
        sistema: 'Europa', nivel_usuario: 'Distribuidor', id_usuario: '999888', divisas: 'ARS' })).data.panel.id;
      // sacarle la caja que el espejo creó en su dueño
      const d = (await get('/api/clientes')).data.clientes.find((x) => x.id === cli.id);
      const k2 = (d.cajas || []).find((k) => String(k.userId) === '999888');
      await axios.delete(BASE + '/api/clientes/' + cli.id + '/cajas/' + k2.id, H());

      const rr = (await post('/api/os/cajas-faltantes', { crear: [{ panel_id: p2, cliente_id: otro.id }] })).data;
      check('cajas: se puede mandar a otro cliente', rr.creadas === 1 && rr.hechas[0].aOtroCliente === true,
        JSON.stringify(rr.hechas));
      const dos = (await get('/api/clientes')).data.clientes;
      const enOtro = (dos.find((x) => x.id === otro.id).cajas || []).some((k) => String(k.userId) === '999888');
      const enDueno = (dos.find((x) => x.id === cli.id).cajas || []).some((k) => String(k.userId) === '999888');
      check('cajas: quedó en el cliente elegido', enOtro === true);
      check('cajas: y NO en el dueño del panel', enDueno === false);
      await axios.delete(BASE + '/api/os/paneles/' + p2, H());
    }

    // y ya no aparece como faltante
    r = (await get('/api/os/cajas-faltantes')).data;
    const m2 = (r.clientes || []).find((x) => x.cliente_id === cli.id);
    check('cajas: deja de figurar como faltante', !m2 || !m2.faltan.some((f) => f.userId === '999777'));
    await axios.delete(BASE + '/api/os/paneles/' + pid, H());
  }

  // ── con qué conexión se cargan las fichas ──
  // Son cuentas DISTINTAS de las de lectura a propósito: Alexa_support no puede bajar fichas. Elegir
  // mal la conexión carga fichas en el panel equivocado, y eso no se deshace solo.
  {
    const cxs = require('../src/casino-conexiones-store');
    const a = cxs.create({ nombre: 'CargaCasinoTest', url: 'https://x.test/index.php', usuario: 'u1', password: 'p1', motor: '463' });
    check('carga: una conexión nueva no carga nada por defecto',
      cxs.paraCargar('Casino') === null, JSON.stringify(cxs.paraCargar('Casino')));

    cxs.update(a.id, { carga_de: 'Casino' });
    const elegida = cxs.paraCargar('Casino');
    check('carga: al marcarla, es la que se usa', elegida && elegida.id === a.id, JSON.stringify(elegida && elegida.nombre));
    check('carga: no sirve para el otro sistema', cxs.paraCargar('Europa') === null);

    // ⚠️ lo que NO puede hacer: elegir entre dos. Cargar en el panel equivocado no se deshace.
    const b = cxs.create({ nombre: 'OtraCasinoTest', url: 'https://y.test/index.php', usuario: 'u2', password: 'p2', motor: '463' });
    cxs.update(b.id, { carga_de: 'Casino' });
    check('carga: con DOS marcadas no adivina, devuelve null', cxs.paraCargar('Casino') === null);

    cxs.update(b.id, { carga_de: '' });
    check('carga: al desmarcar una, vuelve a resolver', (cxs.paraCargar('Casino') || {}).id === a.id);
    // una conexión de TBS nunca carga fichas del casino
    const t = cxs.create({ nombre: 'TbsTest', url: 'https://t.test', usuario: 'u', password: 'p', motor: 'tbs' });
    cxs.update(t.id, { carga_de: 'Casino' });
    check('carga: una conexión de TBS no cuenta', (cxs.paraCargar('Casino') || {}).id === a.id);
    [a.id, b.id, t.id].forEach((id) => cxs.remove(id));
  }

  // ── traer los pedidos del sistema en línea ──
  // Los dos padrones NO comparten códigos: allá un pedido viene con "M526" y acá el cliente se
  // llama "Marcelo". Enganchar por el NODO del casino es lo único igual en los dos lados.
  {
    const pn = require('../src/paneles-store');
    const pid = (await post('/api/os/paneles', { cliente_id: cli.id, nombre: 'PanelImp',
      sistema: 'Casino', nivel_usuario: 'Agente', id_usuario: '555111', divisas: 'ARS' })).data.panel.id;

    const viejo = { id: 'p_viejo1', codigo: 'CODIGO-DE-ALLA', clienteNombre: 'Otro Nombre',
      sistema: 'Casino', userId: '555111', divisa: 'ARS', monto: 5000, estado: 'cargado',
      createdAt: '2026-05-10T10:00:00.000Z', resueltoAt: '2026-05-10T10:05:00.000Z' };

    let r = (await post('/api/os/importar-pedidos', { pedidos: [viejo] })).data;
    check('importar: en modo prueba no escribe', r.probar === true && r.entraron === 1, JSON.stringify(r.porVia));
    check('importar: engancha por el nodo del casino, no por el código',
      r.porVia && r.porVia['nodo del casino'] === 1, JSON.stringify(r.porVia));

    r = (await post('/api/os/importar-pedidos', { pedidos: [viejo], aplicar: true })).data;
    check('importar: lo trae', r.importados === 1, JSON.stringify(r));

    const ped = (await get('/api/pedidos')).data.pedidos.find((x) => x.id === 'p_viejo1');
    // ⚠️ lo que NO puede pasar: que vuelva como pendiente. Alguien lo cargaría de nuevo y serían
    // fichas entregadas dos veces.
    check('importar: conserva el estado original', ped && ped.estado === 'cargado', ped && ped.estado);
    check('importar: conserva la fecha original', ped && ped.createdAt === '2026-05-10T10:00:00.000Z', ped && ped.createdAt);
    check('importar: lo pasa al cliente de ACÁ', ped && ped.codigo === 'L210', ped && ped.codigo);
    check('importar: queda marcado de dónde vino', ped && ped.importado_de === 'app.latamgames.online');

    r = (await post('/api/os/importar-pedidos', { pedidos: [viejo], aplicar: true })).data;
    check('importar: no lo trae dos veces', r.importados === 0 && r.yaEstaban === 1, JSON.stringify(r));

    // uno cuyo nodo no existe acá: NO se importa, se informa
    const huerfano = { id: 'p_huerf', codigo: 'XX', sistema: 'Casino', userId: '000000', monto: 1, estado: 'pendiente' };
    r = (await post('/api/os/importar-pedidos', { pedidos: [huerfano], aplicar: true })).data;
    check('importar: uno sin cliente NO entra', r.importados === 0 && r.sinCliente.length === 1,
      JSON.stringify(r.sinCliente));
    await axios.delete(BASE + '/api/os/paneles/' + pid, H());
  }

  // ── una sola forma de resolver con qué se carga ──
  // Estaba copiada en TRES rutas (cargar, cascada, anular). Al agregar las conexiones del OS
  // arreglé una sola: el pedido se veía pero la vista previa decía "Sistema Casino no configurado"
  // y el botón no servía. Una regla escrita tres veces se corrige una vez y falla en las otras dos.
  {
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'index.js'), 'utf8');
    const copias = (src.match(/store\.list\(\)\.systems\.find/g) || []).length;
    check('carga: la búsqueda del sistema está en UN solo lugar', copias === 1, copias + ' copias');
    const usos = (src.match(/sistemaParaCargar\(/g) || []).length;
    check('carga: y las rutas la usan', usos >= 4, String(usos));
    check('carga: la conexión del OS tiene prioridad', /paraCargar\(nombreSistema\)/.test(src));
    // el mensaje viejo mandaba a un lugar donde ya no se configura
    check('carga: el error apunta a donde se configura hoy',
      !/no configurado \(cargalo en/.test(src) && /carga fichas de/.test(src));
  }

  // ── el historial va del más nuevo al más viejo, venga de donde venga el pedido ──
  // Antes alcanzaba el orden del array: create() mete cada uno adelante. Pero al importar los 875
  // del sistema en línea, que ya venían del más nuevo al más viejo, cada unshift los dio vuelta y
  // el historial mostraba 31/7 y después 1/8, avanzando hacia adelante.
  {
    const orden = (arr) => [...arr].sort((a, b) => {
      const fa = String(a.createdAt || ''); const fb = String(b.createdAt || '');
      if (fa !== fb) return fa < fb ? 1 : -1;
      return String(b.id).localeCompare(String(a.id));
    });
    const desordenados = [
      { id: 'p_a', createdAt: '2026-07-31T10:00:00.000Z' },
      { id: 'p_b', createdAt: '2026-08-10T07:00:00.000Z' },
      { id: 'p_c', createdAt: '2026-08-01T09:00:00.000Z' },
    ];
    const r = orden(desordenados).map((x) => x.id);
    check('historial: del más nuevo al más viejo', r.join(',') === 'p_b,p_c,p_a', r.join(','));
    // dos del mismo segundo no se pueden intercambiar entre una consulta y la siguiente
    const empate = [{ id: 'p_1', createdAt: 'X' }, { id: 'p_2', createdAt: 'X' }];
    check('historial: con la misma fecha el orden es estable',
      orden(empate).map((x) => x.id).join(',') === orden(empate.slice().reverse()).map((x) => x.id).join(','));
    // y contra el server de verdad
    const h = (await get('/api/pedidos')).data.pedidos || [];
    const fechas = h.map((p) => String(p.createdAt || ''));
    const bien = fechas.every((f, i) => i === 0 || fechas[i - 1] >= f);
    check('historial: el server los devuelve ordenados', bien, fechas.slice(0, 3).join(' | '));
  }

  // ── avisos al teléfono: pedidos Y comprobantes ──
  // Los comprobantes sólo avisaban por Telegram, a un grupo. El push llega a quien tiene el panel
  // instalado, que es quien lo va a aprobar.
  {
    const push = require('../src/push');
    check('push: avisa los pedidos', typeof push.notifyNewPedido === 'function');
    check('push: y ahora también los comprobantes', typeof push.notifyNuevoComprobante === 'function');
    check('push: y las solicitudes de caja', typeof push.notifyNuevaSolicitud === 'function');
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'index.js'), 'utf8');
    check('push: el alta de comprobante lo dispara', /push\.notifyNuevoComprobante\(/.test(src));
    check('push: y el alta de solicitud también', /push\.notifyNuevaSolicitud\(/.test(src));

    // ⚠️ tags distintos: si compartieran uno, el navegador reemplaza el aviso anterior y sólo se ve
    // el último. Un pedido y un comprobante que entran juntos son dos cosas que atender.
    const pj = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'push.js'), 'utf8');
    const tags = [...pj.matchAll(/tag:\s*'([a-z-]+)'/g)].map((m) => m[1]);
    check('push: cada aviso usa su propio tag', new Set(tags).size === tags.length && tags.length >= 3, tags.join(','));
  }

  // ── las cajas se tienen que poder ver ──
  // En un vendedor la flecha abre a SU GENTE, no sus cajas. Sin un control propio no habia forma
  // visible de llegar a ellas: habia que adivinar que el nombre era clickeable, y Carlos mostraba
  // "12 cajas" sin manera de ver ninguna.
  {
    const html = require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'index.html'), 'utf8');
    check('cajas: "N cajas" abre las cajas', /class="ver-cajas" onclick="toggleCli/.test(html));
    check('cajas: y tiene estilo de que se puede apretar', /\.ver-cajas\{[^}]*cursor:pointer/.test(html));
    // el operador las ve pero no las edita: un formulario que al guardar da 403 es peor que no tenerlo
    check('cajas: el operador las ve como texto', /if \(_soyOperador\)/.test(html) && /caja-row-ro/.test(html));
    check('cajas: y no le aparecen los botones de editar el cliente',
      /solo-despacho \.cli-head > button\{display:none/.test(html));
    // la flecha del vendedor sigue abriendo su gente: son dos cosas distintas y cada una su control
    check('cajas: la flecha del vendedor sigue siendo del árbol', /sub \? `toggleVend/.test(html));
  }

  // ── solicitudes para abrir una caja ──
  // Una caja es un destino al que se le cargan fichas y define a quién se le factura, así que quien
  // despacha la PIDE y el dueño aprueba.
  {
    const sc = require('../src/solicitudes-caja');
    // lo que no se acepta, y por qué
    check('solicitud: sin cliente no se crea', !sc.crear({ sistema: 'Casino', nodo: '1', login: 'x' }).ok);
    check('solicitud: el panel tiene que ser Casino o Europa',
      !sc.crear({ cliente_id: cli.id, sistema: 'Otro', nodo: '1', login: 'x' }).ok);
    // el id del casino es la identidad real: un nombre mal tipeado manda la ficha a otro lado
    check('solicitud: el id tiene que ser numérico',
      !sc.crear({ cliente_id: cli.id, sistema: 'Casino', nodo: 'abc', login: 'x' }).ok);
    check('solicitud: falta el login', !sc.crear({ cliente_id: cli.id, sistema: 'Casino', nodo: '1' }).ok);

    // ⚠️ La base del test PERSISTE entre corridas. Con un nodo fijo, la solicitud que queda
    // pendiente al final hace fallar la corrida siguiente: "ya hay una solicitud pendiente".
    // Se limpia al final, y además el nodo cambia en cada corrida por las dudas.
    const { db: dbt } = require('../src/db');
    dbt.prepare("DELETE FROM solicitud_caja WHERE login LIKE 'PruebaSol%' OR login IN ('Otra','EnEuropa','Reintento')").run();
    const NODO = '777' + String(process.pid).slice(-3);
    const r1 = sc.crear({ cliente_id: cli.id, sistema: 'casino', nodo: NODO, login: 'PruebaSol' }, 'operador');
    check('solicitud: se crea y queda pendiente', r1.ok && r1.solicitud.estado === 'pendiente', JSON.stringify(r1.error || ''));
    check('solicitud: normaliza el sistema', r1.ok && r1.solicitud.sistema === 'Casino', r1.ok && r1.solicitud.sistema);
    check('solicitud: anota quién la pidió', r1.ok && r1.solicitud.pedida_por === 'operador');

    // ⚠️ dos cajas al mismo nodo serían dos destinos idénticos: la ficha se podría cargar dos veces
    const r2 = sc.crear({ cliente_id: cli.id, sistema: 'Casino', nodo: NODO, login: 'Otra' }, 'operador');
    check('solicitud: no se pide dos veces el mismo nodo', !r2.ok && /pendiente/.test(r2.error), r2.error);
    // pero el mismo nodo en el OTRO panel sí es otra cuenta
    const r3 = sc.crear({ cliente_id: cli.id, sistema: 'Europa', nodo: NODO, login: 'EnEuropa' }, 'operador');
    check('solicitud: el mismo id en el otro panel sí se puede', r3.ok, r3.error);

    sc.resolver(r1.solicitud.id, { estado: 'rechazada', motivo: 'de prueba' });
    check('solicitud: al resolverla deja el motivo', sc.get(r1.solicitud.id).motivo === 'de prueba');
    check('solicitud: y libera el nodo para volver a pedirlo',
      sc.crear({ cliente_id: cli.id, sistema: 'Casino', nodo: NODO, login: 'Reintento' }).ok);
    // el operador puede pedir, pero no aprobar
    const auth2 = require('../src/auth');
    check('solicitud: el operador puede pedirla',
      auth2.puedeOperador({ method: 'POST', path: '/api/despacho/solicitud-caja' }) === true);
    check('solicitud: pero NO aprobarla',
      auth2.puedeOperador({ method: 'POST', path: '/api/os/solicitudes-caja/s_1/aprobar' }) === false);
    // no dejar nada pendiente: lo de una corrida no puede romper la siguiente
    dbt.prepare("DELETE FROM solicitud_caja WHERE nodo=?").run(NODO);
    check('solicitud: el test no deja nada pendiente', sc.list({ estado: 'pendiente' })
      .filter((x) => x.nodo === NODO).length === 0);
  }

  // ── el botón de avisos no puede desaparecer sin explicar ──
  // Safari en iPhone sólo expone Push a los sitios agregados a la pantalla de inicio. En una
  // pestaña común PushManager no existe, y el botón se escondía: quedaba pareciendo que el sistema
  // no tiene avisos, cuando lo que falta es un paso del teléfono.
  {
    const html = require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'index.html'), 'utf8');
    const js = (html.match(/<script>([\s\S]*)<\/script>/) || [])[1] || '';
    check('avisos: el botón no se esconde cuando no hay soporte',
      !/PushManager' in window\)\) \{ btn\.style\.display = 'none'/.test(js));
    check('avisos: explica el paso de iPhone', /Agregar a pantalla de inicio/.test(js));
    check('avisos: detecta iPhone', /iPad\|iPhone\|iPod/.test(js));
    // y que la app se pueda agregar a inicio, que es de lo que depende
    const man = JSON.parse(require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'manifest.json'), 'utf8'));
    check('avisos: el manifest permite instalarla', man.display === 'standalone' && (man.icons || []).length > 0,
      man.display + ' · ' + (man.icons || []).length + ' iconos');
  }

  // ── la Foto sólo mira las conexiones que tienen paneles ──
  // Europa_Fichas y Casino_Fichas existen para BAJAR fichas, no para leer reportes: no tienen ningún
  // panel, su plan es de cero consultas, y aun así aparecían con sus tres vueltas en 0/0 y un botón
  // "Sacar" que no iba a traer nada.
  {
    const em = require('../src/estadisticas-mes.service');
    const cxs = require('../src/casino-conexiones-store');
    const pn = require('../src/paneles-store');
    const conPaneles = new Set(pn.list().filter((p) => p.conexion_id).map((p) => p.conexion_id));
    const plan = em.planGlobal('2026-07');
    const enPlan = new Set(plan.map((x) => x.conexion_id));
    const sinPaneles = cxs.list463().filter((c) => !conPaneles.has(c.id));
    const colados = sinPaneles.filter((c) => enPlan.has(c.id));
    check('foto: no entran conexiones sin paneles', colados.length === 0,
      colados.map((c) => c.nombre).join(','));
    // Y la regla vive en UN solo lugar: la Foto, el pago a proveedores y la lectura de niveles
    // recorrían "todas las conexiones" cada una por su cuenta.
    const fs = require('fs'); const path = require('path');
    const leer = (f) => fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8');
    check('foto/pago: usan listDeReportes y no list463',
      /listDeReportes\(\)/.test(leer('estadisticas-mes.service.js'))
      && /listDeReportes\(\)/.test(leer('pago-proveedores.service.js')));
  }

  // ── la política de qué divisas se le piden a un panel ──
  // Se prueba la función sola: la base del test no tiene paneles linkeados, así que el plan sale
  // vacío y comparar 0 con 0 no prueba nada. Acá los casos son explícitos.
  {
    const { divisasDePanel } = require('../src/estadisticas-mes.service');
    const P = (divisas, id = 'p1') => ({ id, nombre: 'X', divisas });
    const U = (usadas, id = 'p1') => ({ [id]: usadas });

    let r = divisasDePanel(P(['ARS', 'BRL', 'CLP']), 'movidas', U(['ARS']));
    check('plan: pide sólo la que movió', r.pedir.join(',') === 'ARS', r.pedir.join(','));
    check('plan: y avisa las dos que deja afuera', r.fuera.join(',') === 'BRL,CLP', r.fuera.join(','));

    r = divisasDePanel(P(['ARS', 'BRL']), 'todas', U(['ARS']));
    check('plan: con "todas" las pide todas y no deja nada afuera',
      r.pedir.join(',') === 'ARS,BRL' && !r.fuera.length);

    // el caso que importa: sin movimiento NO se estrecha. "No tengo datos" no es "no usa ninguna".
    r = divisasDePanel(P(['ARS', 'BRL', 'CLP']), 'movidas', U([]));
    check('plan: un panel sin movimiento se pregunta ENTERO, no se saltea',
      r.pedir.join(',') === 'ARS,BRL,CLP' && !r.fuera.length, r.pedir.join(','));

    // movió algo que el casino ya no le habilita → no se pide esa, pero tampoco queda en cero
    r = divisasDePanel(P(['ARS']), 'movidas', U(['MXN']));
    check('plan: si lo movido ya no está habilitado, no queda sin consultas',
      r.pedir.length > 0, JSON.stringify(r));

    r = divisasDePanel(P([]), 'movidas', U([]));
    check('plan: un panel sin divisas cargadas cae en ARS', r.pedir.join(',') === 'ARS', r.pedir.join(','));
  }

  // ── el plan de la Foto pregunta sólo lo que el panel movió, pero dice qué deja afuera ──
  {
    const rt = await get('/api/os/estadisticas/plan?mes=2026-07&alcance=todas');
    const rm = await get('/api/os/estadisticas/plan?mes=2026-07&alcance=movidas');
    const T = rt.data.consultas, M = rm.data.consultas;
    check('plan: "movidas" pide menos que "todas"', M <= T, M + ' vs ' + T);
    check('plan: "todas" no deja nada afuera', rt.data.fueraTotal === 0, String(rt.data.fueraTotal));
    check('plan: dice cuántas serían si se pidieran todas', rm.data.siFueranTodas === T, rm.data.siFueranTodas + ' vs ' + T);
    // Lo que se está cuidando: un panel sin movimiento NO puede quedar sin consultas. "No tengo
    // datos" no es "no usa ninguna", y dejarlo en cero lo volvería invisible para siempre.
    const nodosT = new Set(rt.data.plan.map((x) => x.nodo));
    const nodosM = new Set(rm.data.plan.map((x) => x.nodo));
    const perdidos = [...nodosT].filter((n) => !nodosM.has(n));
    check('plan: ningún panel se queda sin ninguna consulta', perdidos.length === 0, perdidos.slice(0, 5).join(','));
    // y lo que sí se pide tiene que seguir siendo una divisa habilitada del panel
    const pn = require('../src/paneles-store');
    const porNodo = {}; pn.list().forEach((p) => { if (p.id_usuario) porNodo[String(p.id_usuario)] = p; });
    const intrusa = rm.data.plan.find((x) => {
      const p = porNodo[x.nodo]; if (!p || !(p.divisas || []).length) return false;
      return !p.divisas.map((d) => String(d).toUpperCase()).includes(x.divisa);
    });
    check('plan: no pide una divisa que el panel no tiene habilitada', !intrusa, JSON.stringify(intrusa || {}).slice(0, 60));
  }

  // panel /os se sirve (detrás de auth)
  r = await axios.get(BASE + '/os', H());
  /* El nombre va UNA sola vez y en el logo, no escrito a mano en cada pantalla: antes decía
     "LATAM Games" en el encabezado y "Latam Games" en el login, con la mezcla de mayúsculas que se
     ve en cuanto hay dos pantallas abiertas al lado. */
  check('panel /os sirve HTML', r.status === 200 && /Latam Games/.test(r.data) && /VIEWS/.test(r.data));
  check('panel: el nombre no se escribe a mano en el encabezado, va el logo',
    /<img src="\/logo\.png" alt="Latam Games" class="hd-logo"/.test(r.data)
    && !/LATAM Games/.test(r.data),
    'y si el logo no carga, cae a "Latam Games" escrito de una sola forma');
  /* Los espacios se llaman por lo que se hace adentro: "Comercial" y "Operativo" no le dicen a
     nadie qué hay del otro lado. */
  /* El logo se puede cambiar sin tocar el código, y se guarda en la BASE: el disco del servidor se
     borra en cada despliegue, así que uno subido a disco duraría hasta el próximo deploy. */
  const logoAntes = await axios.get(BASE + '/logo.png', { validateStatus: () => true, responseType: 'arraybuffer' });
  check('logo: el del repo se sirve mientras no subas otro', logoAntes.status === 200);
  const png1x1 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  check('logo: no entra cualquier archivo',
    (await axios.put(BASE + '/api/os/logo', { dataUri: 'data:text/html;base64,PGgxPmhvbGE8L2gxPg==' },
      H({ validateStatus: () => true }))).data.ok !== true);
  check('logo: y no entra uno pesado',
    (await axios.put(BASE + '/api/os/logo', { dataUri: 'data:image/png;base64,' + 'A'.repeat(600 * 1024) },
      H({ validateStatus: () => true }))).data.ok !== true);
  check('logo: se sube el propio y pasa a servirse ése',
    (await put('/api/os/logo', { dataUri: png1x1 })).data.propio === true
    && (await axios.get(BASE + '/logo.png', { validateStatus: () => true, responseType: 'arraybuffer' }))
      .data.length < logoAntes.data.length,
    'el subido pesa menos que el del repo, así que se nota cuál salió');
  check('logo: se puede volver al de siempre',
    (await put('/api/os/logo', { quitar: true })).data.propio === false
    && (await axios.get(BASE + '/logo.png', { validateStatus: () => true, responseType: 'arraybuffer' }))
      .data.length === logoAntes.data.length);

  /* En «/» se cargan FICHAS y «/os» es el PANEL. Estuvieron cruzados y el nombre mandaba al lugar
     equivocado, que es peor que no tener nombre. */
  /* LA LETRA DE MÁQUINA DE ESCRIBIR queda sólo donde se gana el lugar: algo que se copia carácter
     por carácter, donde la O y el 0 se tienen que distinguir. Estaba en 17 lugares —montos, ids de
     nodo, nombres de usuario, dominios— y ahí sólo endurece la lectura. Los números que se alinean
     en columna usan tabular-nums, que hace lo mismo sin cambiar la letra. */
  {
    const ui = r.data;
    const mono = (ui.match(/font-family:(ui-)?monospace|font-family:ui-monospace/g) || []).length;
    /* El séptimo es la VISTA PREVIA de la comparativa de TBS. Ahí no endurece la lectura: el
       mensaje sale con los números en <code>, que Telegram muestra en ancho fijo para que los dos
       meses queden alineados. Mostrar la vista previa en otra letra sería mostrar una cosa y
       mandar otra, que es justo lo que hace que después nadie confíe en el botón. */
    check('panel: la letra de máquina queda sólo donde se copia carácter por carácter',
      mono <= 7, `${mono} lugares`);
    check('panel: la contraseña generada SÍ la conserva',
      /title="Se copia carácter por carácter/.test(ui));
    check('panel: la dirección de la wallet también',
      /<td style="font-family:monospace;font-size:12px;word-break:break-all">\$\{esc\(w\.direccion\)\}/.test(ui));
    /* Y las tablas que quedan: una línea fina entre filas en vez de una marcada en cada celda. */
    check('panel: las tablas tienen una sola línea fina y más aire',
      /th,td \{ text-align:left; padding:10px 9px; border-bottom:1px solid var\(--bg3\); \}/.test(ui)
      && /tr:last-child td \{ border-bottom:none; \}/.test(ui)
      && /td\.right, th\.right \{ font-variant-numeric:tabular-nums; \}/.test(ui));
  }

  check('panel: los espacios se llaman por lo que hacen',
    /\['\/','🎰 Fichas'\]/.test(r.data) && /\['\/os','📊 Panel'\]/.test(r.data)
    && /\['\/chat-externo','💬 Chat'\]/.test(r.data));

  // ── que el JAVASCRIPT DE LA PÁGINA COMPILE ──
  // Faltaba, y se notó: un reemplazo mal cortado duplicó 179 líneas, el script tiró
  // "_apiRes has already been declared" y /tbs quedó en blanco. Los 180 checks pasaban igual,
  // porque ninguno miraba si el script parseaba. Servir HTML no es servir una página que anda.
  {
    const cuerpo = String(r.data);
    const bloques = cuerpo.match(/<script>([\s\S]*?)<\/script>/g) || [];
    let error = null;
    bloques.forEach((b) => {
      if (error) return;
      const js = b.replace(/^<script>/, '').replace(/<\/script>$/, '');
      try { new Function(js); } catch (e) { error = e.message; }
    });
    check('panel /os: el javascript compila', !error, error || bloques.length + ' bloque(s) de script');
    // y que no haya quedado una función o un global declarado dos veces
    const dup = ['function apiDoc', 'let _apiRes', 'function apiPintarCuentas', 'function renderNav']
      .filter((x) => cuerpo.split(x).length - 1 > 1);
    check('panel /os: nada declarado dos veces', !dup.length, dup.join(', '));
  }
  // TBS es su propio espacio: misma página, pero la barra se arma según por dónde se entró.
  r = await axios.get(BASE + '/tbs', H());
  check('panel /tbs sirve HTML', r.status === 200 && /Latam Games/.test(r.data) && /TABS_TBS/.test(r.data));
  check('/tbs decide el modo por la URL, no por un flag guardado',
    /location\.pathname[\s\S]{0,60}\/tbs/.test(r.data), 'ES_TBS sale de location.pathname');
  check('la pestaña API ya no está en el comercial', !/'api','🔌 API \(TBS\)'/.test(r.data));
  // sin sesión no se entra a ninguno de los dos
  const sinCookie = { validateStatus: () => true, maxRedirects: 0 };
  const rt = await axios.get(BASE + '/tbs', sinCookie);
  check('/tbs está detrás de auth igual que /os', rt.status === 302 || rt.status === 401 || /login/i.test(String(rt.headers.location || '')),
    String(rt.status) + ' ' + String(rt.headers.location || ''));

  const fail = asserts.filter((a) => !a.ok);
  console.log('\n=== ' + (asserts.length - fail.length) + '/' + asserts.length + ' checks OK ===');
  srv.kill();
  process.exit(fail.length ? 1 : 0);
}
main().catch((e) => { console.error('SMOKE FAIL:', e.message); srv.kill(); process.exit(1); });
