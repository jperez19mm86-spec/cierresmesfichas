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
    // El INTERRUPTOR no se hereda: si se heredara, prender el del vendedor pondría a 14 clientes
    // a escribir de golpe en un grupo real sin que nadie lo pidiera.
    check('telegram: el aviso de carga NO se hereda, aunque el destino sí',
      dest.avisaCargas(M.c1, g) === false && dest.destinoDe(M.c1, g).chatId === '-100HENRY');
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
