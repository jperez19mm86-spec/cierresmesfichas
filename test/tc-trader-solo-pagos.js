/**
 * tc-trader-solo-pagos.js — EN PESOS HAY DOS CAMBIOS POR MES.
 *
 * El del trader (cargado a mano en el cierre) vale SÓLO para los pagos en pesos de ese mes. Lo que
 * se le cobra al cliente —proveedores externos, el cálculo del mes— va con el promedio del mes.
 * Septiembre 2026: trader 1.679,88, promedio 1.596,39.
 */
process.env.DB_PATH = require('path').join(require('os').tmpdir(), `test-tc-${Date.now()}.sqlite`);
require('../src/db');
const tcStore = require('../src/tc-store');
const cierre = require('../src/cierre-store');
const tcUnico = require('../src/tc-unico.service');
const clientes = require('../src/clientes-store');
const movs = require('../src/movimientos-store');

let ok = 0, fail = 0;
const check = (t, c, extra) => { if (c) { ok++; console.log('✅ ' + t + (extra != null ? '  → ' + extra : '')); }
  else { fail++; console.log('❌ ' + t + (extra != null ? '  → ' + extra : '')); } };

console.log('\n💱 el cambio del trader, sólo para los pagos\n');
tcStore.addSnapshot({ tc_ars_usdt: '1590', fecha: '2026-09-05', hora: '12:00' });
tcStore.addSnapshot({ tc_ars_usdt: '1602.7846', fecha: '2026-09-20', hora: '12:00' });
const prom = tcStore.getMes('2026-09').tc_cliente;

// 1 · sin cargado a mano, las dos cosas usan el promedio
check('sin cambio del trader, la cuenta usa el promedio', tcUnico.tcDelMes('ARS', '2026-09').valor === String(prom), prom);
check('y los pagos también', tcUnico.tcPagosDelMes('ARS', '2026-09').valor === String(prom));

// 2 · con el del trader cargado
const r = cierre.setTC('ARS', 'Septiembre_2026', '1679.88', true, true);
check('se puede cargar el cambio del trader', r.ok !== false, JSON.stringify(r).slice(0, 80));
const cta = tcUnico.tcDelMes('ARS', '2026-09');
check('la cuenta sigue con el PROMEDIO del mes', cta.valor === String(prom) && /promedio/.test(cta.fuente), cta.valor + ' · ' + cta.fuente);
const pag = tcUnico.tcPagosDelMes('ARS', '2026-09');
check('los pagos van con el del TRADER', pag.valor === '1679.88' && /trader/.test(pag.fuente), pag.valor + ' · ' + pag.fuente);

// 3 · un pago en pesos del mes se vale al del trader y cuenta como definitivo
const cli = clientes.createCliente({ codigo: 'TCP', nombre: 'TCP' });
const p = movs.create({ cliente_id: cli.id, tipo: 'pago', monto_ars: '600000', divisa: 'USDT', medio: 'cvu', tc_modo: 'mes', fecha: '2026-09-14T12:00:00.000Z' });
const v = movs.get(p.id);
check('un pago en pesos se pasa a dólares con el del trader', v.monto_usdt === '357.17', v.monto_usdt);
check('y no queda como provisorio', v.provisional === false);

// 4 · fuera del peso no cambia nada: manda el cargado a mano
cierre.setTC('PYG', 'Septiembre_2026', '5930.9473', true, true);
check('en guaraníes manda el cargado a mano, para las dos cosas',
  tcUnico.tcDelMes('PYG', '2026-09').valor === '5930.9473' && tcUnico.tcPagosDelMes('PYG', '2026-09').valor === '5930.9473');

// 5 · mes sin promedio (no hubo cotizaciones): la cuenta cae al cargado a mano en vez de quedar sin cambio
cierre.setTC('ARS', 'Junio_2026', '1450', true, true);
check('si el mes no tiene promedio, la cuenta usa el cargado a mano', tcUnico.tcDelMes('ARS', '2026-06').valor === '1450');

console.log(`\n${ok} chequeos OK, ${fail} fallaron\n`);
process.exit(fail ? 1 : 0);
