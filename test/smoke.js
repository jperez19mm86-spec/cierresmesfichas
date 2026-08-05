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

  // panel /os se sirve (detrás de auth)
  r = await axios.get(BASE + '/os', H());
  check('panel /os sirve HTML', r.status === 200 && /LATAM Games/.test(r.data) && /VIEWS/.test(r.data));

  const fail = asserts.filter((a) => !a.ok);
  console.log('\n=== ' + (asserts.length - fail.length) + '/' + asserts.length + ' checks OK ===');
  srv.kill();
  process.exit(fail.length ? 1 : 0);
}
main().catch((e) => { console.error('SMOKE FAIL:', e.message); srv.kill(); process.exit(1); });
