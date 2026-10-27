/**
 * cuenta-mes-a-mes.js — LA CUENTA MES A MES CON LA MISMA REGLA QUE LO QUE DEBE (fase 4, 27-oct-2026).
 *
 * /api/os/cuenta/:id agrupaba por la FECHA, sumaba sólo dólares y ponía las anulaciones en «otros».
 * Ahora: cada movimiento va al mes de la deuda (mesDe), en la moneda de la cuenta, y la anulación de
 * una carga se resta dentro de «consumo». La suma de los meses tiene que dar lo que debe.
 */
process.env.DB_PATH = require('path').join(__dirname, '..', 'data', 'test-cuenta-mes.sqlite');
['', '-wal', '-shm'].forEach((x) => { try { require('fs').unlinkSync(process.env.DB_PATH + x); } catch (e) {} });
const clientes = require('../src/clientes-store');
const movs = require('../src/movimientos-store');
const deuda = require('../src/deuda.service');

let ok = 0, fail = 0;
const check = (t, c, x) => { if (c) { ok++; console.log('✅ ' + t); } else { fail++; console.log('❌ ' + t + (x !== undefined ? '  → ' + x : '')); } };
console.log('\n📒 la cuenta mes a mes\n');

// La ruta, montada en un app de mentira.
const rutas = {};
const app = { get: (p, h) => { rutas['GET ' + p] = h; }, post() {}, put() {}, delete() {}, use() {}, set() {} };
require('../src/rutas/cuenta.routes').mount(app);
const cuentaDe = (id) => new Promise((fin) => rutas['GET /api/os/cuenta/:clienteId']({ params: { clienteId: id } }, { status() { return this; }, json: fin }));
const mesDe = (r, m) => r.meses.find((x) => x.mes === m) || {};
const n = (x) => Number(x || 0);

(async () => {
  // Una cuenta en dólares: una carga anulada, otra que queda, y un pago del 2-oct que es de septiembre.
  const u = clientes.createCliente({ codigo: 'MESUSD', nombre: 'Mes Usd' });
  movs.create({ cliente_id: u.id, tipo: 'carga', monto_usdt: '1000', divisa: 'USDT', fecha: '2026-09-09T10:00:00.000Z', pedido_id: 'p1' });
  movs.create({ cliente_id: u.id, tipo: 'correccion', monto_usdt: '-1000', divisa: 'USDT', fecha: '2026-09-09T10:05:00.000Z', pedido_id: 'p1', notas: 'Anulación de la carga' });
  movs.create({ cliente_id: u.id, tipo: 'carga', monto_usdt: '300', divisa: 'USDT', fecha: '2026-09-20T10:00:00.000Z', pedido_id: 'p2' });
  movs.create({ cliente_id: u.id, tipo: 'ajuste', monto_usdt: '-20', divisa: 'USDT', fecha: '2026-09-30T23:00:00.000Z', notas: 'un ajuste de verdad' });
  movs.create({ cliente_id: u.id, tipo: 'pago', monto_usdt: '250', divisa: 'USDT', fecha: '2026-10-02T12:00:00.000Z', mes_cierre: '2026-09' });
  const r = await cuentaDe(u.id);
  const sep = mesDe(r, '2026-09');
  check('la anulación se resta dentro de las cargas, no en «otros»', n(sep.consumo) === 300 && n(sep.otros) === -20, JSON.stringify(sep));
  check('el pago del 2-oct que es de septiembre cae en septiembre', n(sep.pagos) === 250 && !n(mesDe(r, '2026-10').pagos), JSON.stringify(r.meses));
  const suma = r.meses.reduce((a, m) => a + n(m.facturado) - n(m.pagos), 0);
  check('la suma de los meses da lo que debe', Math.abs(suma - n(deuda.cuentaCorriente(u.id).total)) < 0.01 && Math.abs(suma - 30) < 0.01, suma);
  // Una cuenta en pesos: antes daba todo cero.
  const a = clientes.createCliente({ codigo: 'MESARS', nombre: 'Mes Ars' });
  clientes.updateComercial(a.id, { moneda_cuenta: 'ARS' });
  movs.create({ cliente_id: a.id, tipo: 'carga', monto_ars: '150000', divisa: 'ARS', fecha: '2026-10-05T10:00:00.000Z', pedido_id: 'p3' });
  movs.create({ cliente_id: a.id, tipo: 'pago', monto_ars: '100000', divisa: 'ARS', fecha: '2026-10-06T10:00:00.000Z' });
  const ra = await cuentaDe(a.id);
  const oct = mesDe(ra, '2026-10');
  check('cuenta en pesos: el mes a mes sale en pesos (no en cero)', ra.moneda === 'ARS' && n(oct.consumo) === 150000 && n(oct.pagos) === 100000 && n(oct.saldo_acumulado) === 50000, JSON.stringify(oct));
  check('y la suma da lo que debe en pesos', Math.abs(n(oct.saldo_acumulado) - n(deuda.cuentaCorriente(a.id).total)) < 0.01);
  console.log(`\n${ok} chequeos OK, ${fail} fallaron\n`); process.exit(fail ? 1 : 0);
})();
