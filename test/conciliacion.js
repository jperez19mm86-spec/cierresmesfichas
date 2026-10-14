/**
 * conciliacion.js — LA TABLA «YA TENÍAN SU DEUDA CARGADA CARGA POR CARGA».
 * «En su cuenta» tiene que restar las cargas anuladas (TITAN86 salía 10.000 USDT de diferencia
 * sólo por una anulada) y una cuenta en pesos se compara en pesos (Ru98 salía «en su cuenta 0»).
 */
process.env.DB_PATH = require('path').join(require('os').tmpdir(), `test-conc-${Date.now()}.sqlite`);
require('../src/db');
const clientes = require('../src/clientes-store');
const movs = require('../src/movimientos-store');
const deudaCarga = require('../src/deuda-carga.service');
let ok = 0, fail = 0;
const check = (t, c, x) => { if (c) { ok++; console.log('✅ ' + t + (x != null ? '  → ' + x : '')); } else { fail++; console.log('❌ ' + t + (x != null ? '  → ' + x : '')); } };
console.log('\n🧮 conciliación del mes\n');
const ti = clientes.createCliente({ codigo: 'TIT', nombre: 'Tit' });
movs.create({ cliente_id: ti.id, tipo: 'carga', pedido_id: 'p1', monto_ars: '15857142.86', monto_usdt: '10000', divisa: 'ARS', fecha: '2026-09-09T10:00:00.000Z' });
movs.create({ cliente_id: ti.id, tipo: 'carga', pedido_id: 'p2', monto_ars: '7928571.43', monto_usdt: '5000', divisa: 'ARS', fecha: '2026-09-09T11:00:00.000Z' });
movs.create({ cliente_id: ti.id, tipo: 'correccion', pedido_id: 'p1', monto_ars: '-15857142.86', monto_usdt: '-10000', divisa: 'ARS', fecha: '2026-10-02T10:00:00.000Z' });
let d = deudaCarga.delMes('2026-09')[ti.id];
check('la carga anulada no cuenta «en su cuenta», aunque se haya anulado otro mes', d.usdt === '5000' && d.cargas === 1 && d.anuladas === 1, JSON.stringify(d));
check('y la anulación no cuenta en el mes en que se hizo', !deudaCarga.delMes('2026-10')[ti.id]);
const ru = clientes.createCliente({ codigo: 'RUX', nombre: 'Rux' });
movs.create({ cliente_id: ru.id, tipo: 'carga', pedido_id: 'p3', monto_ars: '142500.3', divisa: 'ARS', fecha: '2026-09-12T10:00:00.000Z' });
d = deudaCarga.delMes('2026-09')[ru.id];
check('una cuenta en pesos guarda lo suyo en pesos para comparar', d.ars === '142500.3' && d.usdt === '0', JSON.stringify(d));
console.log(`\n${ok} chequeos OK, ${fail} fallaron\n`); process.exit(fail ? 1 : 0);
