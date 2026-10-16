/** externos-guardados.js — bajar sólo la cuenta de externos de un mes, tal cual se guardó. */
process.env.DB_PATH = require('path').join(require('os').tmpdir(), `test-extg-${Date.now()}.sqlite`);
require('../src/db');
const clientes = require('../src/clientes-store');
const fg = require('../src/facturas-guardadas');
const eg = require('../src/externos-guardados');
let ok = 0, fail = 0;
const check = (t, c, x) => { if (c) { ok++; console.log('✅ ' + t + (x != null ? '  → ' + x : '')); } else { fail++; console.log('❌ ' + t + (x != null ? '  → ' + x : '')); } };
console.log('\n📥 cuentas de externos guardadas\n');
const ti = clientes.createCliente({ codigo: 'TITX', nombre: 'Titán; "el grande"' });
const sin = clientes.createCliente({ codigo: 'SINX', nombre: 'SinExternos' });
const item = { proveedor: 'PRAGMATIC SL2', divisa: 'ARS', pct: '8', base: '7', excedente: '1', tc: '1596.3923', profit: '317267021.63', monto: '3172670.21', usdt: '1987.39', costo: '6', paneles: ['Beting-SA', '463.live'] };
fg.guardar({ ok: true, cliente: { id: ti.id, codigo: 'TITX', nombre: 'Titán; "el grande"' }, mes: '2026-09', consumo: { total_usdt: '100' }, totalMes_usdt: '2087.39',
  externos: { base: '7', total_usdt: '1987.39', items: [item], porPanel: [
    { panel: 'Beting-SA', divisa: 'ARS', tc: '1596.3923', monto: '2000000', usdt: '1252.83', items: [{ proveedor: 'PRAGMATIC SL2', pct: '8', base: '7', excedente: '1', profit: '200000000', monto: '2000000', usdt: '1252.83' }] },
    { panel: '463.live', divisa: 'ARS', tc: '1596.3923', monto: '1172670.21', usdt: '734.56', items: [{ proveedor: 'PRAGMATIC SL2', pct: '8', base: '7', excedente: '1', profit: '117267021.63', monto: '1172670.21', usdt: '734.56' }] },
    { panel: '463.live', divisa: 'MXN', tc: '18', monto: '0.001', usdt: '0', items: [] }] } });
// una factura vieja, sin el detalle por login
const vie = clientes.createCliente({ codigo: 'VIEX', nombre: 'Vieja' });
fg.guardar({ ok: true, cliente: { id: vie.id, codigo: 'VIEX', nombre: 'Vieja' }, mes: '2026-09', consumo: { total_usdt: '1' }, totalMes_usdt: '1', externos: { base: '7', total_usdt: '5', items: [{ ...item, usdt: '5' }] } });
fg.guardar({ ok: true, cliente: { id: sin.id, codigo: 'SINX', nombre: 'SinExternos' }, mes: '2026-09', consumo: { total_usdt: '50' }, totalMes_usdt: '50', externos: { total_usdt: '0', items: [] } });
const l = eg.delMes('2026-09');
check('la lista trae sólo a quien tiene externos', l.length === 2 && l[0].cliente_id === ti.id && l[0].externos_usdt === '1987.39' && !l.some((x) => x.cliente_id === sin.id), JSON.stringify(l));
const c = eg.csv('2026-09', ti.id);
check('el Excel arranca con BOM y usa «;», con login y moneda primero', c.charCodeAt(0) === 0xfeff && c.split('\r\n')[0].startsWith('\ufeffLogin;Moneda;Proveedor;Ganancia'), c.split('\r\n')[0]);
check('un renglón por login, moneda y proveedor, con coma decimal', /^Beting-SA;ARS;PRAGMATIC SL2;200\.000\.000,00;/m.test(c) && /^463\.live;ARS;PRAGMATIC SL2;117\.267\.021,63;/m.test(c), c.split('\r\n')[1]);
check('subtotal por login y moneda', /^Beting-SA;ARS;Subtotal;;;;;2\.000\.000,00;1\.596,3923;1\.252,83$/m.test(c));
check('las monedas en cero no aparecen', !/MXN/.test(c));
check('cierra con el total y el resumen por moneda', /^TOTAL;;;;;;;;;1\.987,39$/m.test(c) && /^Por moneda;ARS;;;;;;3\.172\.670,21;/m.test(c));
const cv = eg.csv('2026-09', vie.id);
check('una factura vieja sin detalle por login sale por proveedor', cv.split('\r\n')[0].startsWith('\ufeffProveedor;Moneda') && /TOTAL;;;;;;;;5,00;/.test(cv));
const todos = eg.csv('2026-09', null);
check('el de todos lleva el cliente en cada renglón, entre comillas si hace falta', /^"Titán; ""el grande""";Beting-SA;ARS;PRAGMATIC SL2/m.test(todos), todos.split('\r\n')[1]);
const h = eg.html('2026-09', ti.id);
check('la hoja para imprimir tiene el total y el botón', /1\.987,39 USDT/.test(h) && /window\.print\(\)/.test(h));
check('la hoja va por login, con su moneda y subtotal', /Login Beting-SA/.test(h) && /Login 463\.live/.test(h) && /Subtotal Beting-SA en ARS/.test(h) && /Por moneda/.test(h) && h.indexOf('Login Beting-SA') < h.indexOf('Login 463.live'));
check('y no muestra nada interno (el costo del proveedor)', !/costo/i.test(h.replace(/<style[\s\S]*?<\/style>/, '')) && !/;6;/.test(c));
check('sin factura guardada, no hay nada que bajar', eg.csv('2026-08', ti.id) === null && eg.html('2026-09', sin.id) === null);
console.log(`\n${ok} chequeos OK, ${fail} fallaron\n`); process.exit(fail ? 1 : 0);
