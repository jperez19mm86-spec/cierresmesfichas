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
    const { CURRENCIES } = require('../src/casino-api');
    // El testigo del bug: la constante NO alcanza. Si algún día la completan, este check avisa que
    // se puede simplificar; mientras no la completen, deja escrito por qué no se la puede usar sola.
    check('casino: la constante de divisas sigue sin cubrir las que los paneles usan',
      ['PYG', 'COP', 'CRC', 'HNL', 'USDT', 'VES', 'ZAR', 'BOB'].some((d) => !CURRENCIES.includes(d)));
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

    // ── EL RETIRO NO SE REPITE NUNCA ──
    // Después de retirar, el punto de retorno deja de ser 'pendiente' para siempre: si volviera,
    // el próximo intento sacaría el monto DOS VECES del origen.
    mv.marcarRetiroOk(r1.movimiento.id, { newBalance: '5000' });
    const suelto = mv.soltar(r1.movimiento.id, 'la carga falló');
    check('mover: si falla la carga queda en "retirado", no en "pendiente"', suelto.estado === 'retirado');
    check('mover: y no se puede volver a tomar como pendiente', !mv.tomar(r1.movimiento.id, 'pendiente'));
    check('mover: pero sí se reintenta desde "retirado"', !!mv.tomar(r1.movimiento.id, 'retirado'));

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
    mv.marcarRetiroOk(r2.movimiento.id, {});
    db.prepare('UPDATE movimiento_panel SET tomado_at=? WHERE id=?')
      .run(new Date(Date.now() - 60 * 60000).toISOString(), r2.movimiento.id);
    const d3 = mv.destrabar(r2.movimiento.id);
    check('mover: con el retiro hecho, destrabar vuelve a retirado', d3.ok && d3.vuelveA === 'retirado');

    // ── LOS QUE PIDEN ATENCIÓN INCLUYEN LOS QUE QUEDARON A MEDIAS ──
    const c = mv.counts();
    check('mover: los "a medias" cuentan como que piden atención', c.requierenAtencion >= c.retirado);

    // ── EL PERMISO SE MIRA AL MOVER, NO SÓLO AL PEDIR ──
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'movimientos-panel.service.js'), 'utf8');
    check('mover: el permiso mover_balance se comprueba al ejecutar', /cli\.mover_balance/.test(src));
    check('mover: se comprueba que los dos paneles sean del cliente', /no es de ese cliente/.test(src));
    check('mover: no se cruzan sistemas', /entre sistemas distintos/.test(src));
    check('mover: se retira ANTES de cargar', src.indexOf("'out'") < src.indexOf('cascada.ejecutar'));

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
      env: { ...process.env, PORT: String(PUERTO), OPERADOR_USER: 'opetest', OPERADOR_PASSWORD: 'clave-de-prueba-larga',
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
  check('panel /os sirve HTML', r.status === 200 && /LATAM Games/.test(r.data) && /VIEWS/.test(r.data));

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
  check('panel /tbs sirve HTML', r.status === 200 && /LATAM Games/.test(r.data) && /TABS_TBS/.test(r.data));
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
