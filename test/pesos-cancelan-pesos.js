/**
 * pesos-cancelan-pesos.js — 600.000 PESOS COBRADOS Y 600.000 PESOS PAGADOS DAN CERO.
 *
 * El caso de Fran: la carga se pasa a dólares con el cripto del día (1.584,99 → 378,55) y el pago
 * con el cambio del trader (1.679,88 → 357,17). Desde agosto 2026 el pago en pesos salda las cargas
 * en pesos a lo que valieron, y la diferencia de cambio la pone la empresa.
 */
process.env.DB_PATH = require('path').join(require('os').tmpdir(), `test-pesos-${Date.now()}.sqlite`);
const { db } = require('../src/db');
const clientes = require('../src/clientes-store');
const movs = require('../src/movimientos-store');
const deuda = require('../src/deuda.service');

let ok = 0, fail = 0;
const check = (t, c, extra) => { if (c) { ok++; console.log('✅ ' + t + (extra != null ? '  → ' + extra : '')); }
  else { fail++; console.log('❌ ' + t + (extra != null ? '  → ' + extra : '')); } };
const debe = (c) => deuda.cuentaCorriente(c.id).total;
const carga = (c, ars, usd, fecha, pedido) => movs.create({ cliente_id: c.id, tipo: 'carga', monto_ars: ars, monto_usdt: usd, divisa: 'ARS', fecha, pedido_id: pedido || null });
const pagoPesos = (c, ars, usd, fecha) => movs.create({ cliente_id: c.id, tipo: 'pago', monto_ars: ars, monto_usdt: usd, divisa: 'USDT', medio: 'cvu', fecha });
const pago = (c, id) => movs.list({ cliente_id: c.id }).find((m) => m.id === id);

console.log('\n💱 los pesos cancelan pesos\n');

// 1 · el caso de Fran
const fran = clientes.createCliente({ codigo: 'FRANP', nombre: 'FranP' });
carga(fran, '600000', '378.55', '2026-09-06T12:00:00.000Z', 'ped1');
const p1 = pagoPesos(fran, '600000', '357.17', '2026-09-14T12:00:00.000Z');
const v1 = pago(fran, p1.id);
check('600.000 pesos pagados saldan la carga de 600.000 pesos a lo que valió', v1.monto_usdt === '378.55', v1.monto_usdt);
check('lo que entró por el trader queda guardado aparte', v1.usdt_recibido === '357.17' && v1.dif_cambio === '21.38', `${v1.usdt_recibido} · dif ${v1.dif_cambio}`);
check('Fran no debe nada', debe(fran) === '0', debe(fran));
check('la cuenta suma la diferencia que puso la empresa', deuda.cuentaCorriente(fran.id).dif_cambio === '21.38');
check('lo guardado en la base no cambia', movs.getCrudo(p1.id).monto_usdt === '357.17');
check('leer sólo los pagos da lo mismo que leer la cuenta entera',
  movs.list({ tipo: 'pago' }).find((m) => m.id === p1.id).monto_usdt === '378.55' && movs.get(p1.id).monto_usdt === '378.55');

// 2 · pago parcial y pago de más
carga(fran, '600000', '378.55', '2026-09-20T12:00:00.000Z', 'ped2');
const p2 = pagoPesos(fran, '300000', '178.59', '2026-09-21T12:00:00.000Z');
check('medio pago salda la mitad de la carga', pago(fran, p2.id).monto_usdt === '189.28', pago(fran, p2.id).monto_usdt);
const p3 = pagoPesos(fran, '900000', '535.76', '2026-09-25T12:00:00.000Z');
// 300.000 que faltaban de la carga (189,27) + 600.000 de sobra al cambio del pago (357,17)
check('lo que sobra se pasa con el cambio del propio pago', pago(fran, p3.id).monto_usdt === '546.44', pago(fran, p3.id).monto_usdt);

// 3 · un pago en dólares no toca la fila de pesos
const ana = clientes.createCliente({ codigo: 'ANAP', nombre: 'AnaP' });
carga(ana, '600000', '378.55', '2026-09-06T12:00:00.000Z');
const u = movs.create({ cliente_id: ana.id, tipo: 'pago', monto_usdt: '100', divisa: 'USDT', medio: 'usdt', fecha: '2026-09-10T12:00:00.000Z' });
check('un pago en USDT vale lo que dice', pago(ana, u.id).monto_usdt === '100' && pago(ana, u.id).usdt_recibido == null);
const p4 = pagoPesos(ana, '600000', '357.17', '2026-09-14T12:00:00.000Z');
check('y después los pesos siguen saldando la carga en pesos', pago(ana, p4.id).monto_usdt === '378.55');

// 4 · cuenta en pesos: no se toca
const ru = clientes.createCliente({ codigo: 'RUP', nombre: 'RuP' });
clientes.updateComercial(ru.id, { moneda_cuenta: 'ARS' });
carga(ru, '600000', '378.55', '2026-09-06T12:00:00.000Z');
const p5 = pagoPesos(ru, '600000', '357.17', '2026-09-14T12:00:00.000Z');
check('en una cuenta llevada en pesos no cambia nada', pago(ru, p5.id).monto_usdt === '357.17' && pago(ru, p5.id).usdt_recibido == null);

// 5 · julio queda como se cerró
const jul = clientes.createCliente({ codigo: 'JULP', nombre: 'JulP' });
carga(jul, '600000', '384.86', '2026-07-06T12:00:00.000Z');
const p6 = pagoPesos(jul, '600000', '375.30', '2026-07-20T12:00:00.000Z');
check('antes de agosto el pago vale lo que dio el trader', pago(jul, p6.id).monto_usdt === '375.30');

// 6 · una carga anulada sale de la fila
const an = clientes.createCliente({ codigo: 'ANUP', nombre: 'AnuP' });
carga(an, '120000', '75.04', '2026-08-30T12:00:00.000Z', 'pedA');
movs.create({ cliente_id: an.id, tipo: 'correccion', monto_ars: '-120000', monto_usdt: '-75.04', divisa: 'ARS', fecha: '2026-08-30T13:00:00.000Z', pedido_id: 'pedA' });
const p7 = pagoPesos(an, '120000', '71.43', '2026-09-02T12:00:00.000Z');
check('si la carga se anuló, no hay pesos que saldar: el pago vale lo que entró', pago(an, p7.id).monto_usdt === '71.43' && pago(an, p7.id).usdt_recibido == null);

// 7 · una bonificación en pesos también saca de la fila
const bo = clientes.createCliente({ codigo: 'BONP', nombre: 'BonP' });
carga(bo, '1200000', '755.19', '2026-08-22T12:00:00.000Z');
movs.create({ cliente_id: bo.id, tipo: 'bonificacion', monto_ars: '200000', monto_usdt: '125.87', divisa: 'ARS', fecha: '2026-08-22T13:00:00.000Z' });
const p8 = pagoPesos(bo, '1000000', '595.28', '2026-08-30T12:00:00.000Z');
check('después de la bonificación quedan 1.000.000 en la fila y el pago los salda', pago(bo, p8.id).monto_usdt === '629.32', pago(bo, p8.id).monto_usdt);
check('y la cuenta queda en cero', debe(bo) === '0', debe(bo));

db.close && db.close();
console.log(`\n${ok} chequeos OK, ${fail} fallaron\n`);
process.exit(fail ? 1 : 0);
