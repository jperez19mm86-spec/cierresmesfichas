/**
 * cara-pesos-pago-usdt.js — UN PAGO EN DÓLARES TAMBIÉN SE LEE EN PESOS.
 *
 * Un pago en USDT guarda su cara en pesos sólo si quien aprueba escribió el TC a mano. Si lo dejó
 * vacío, `monto_ars` queda null para siempre y el saldo en pesos sale INFLADO: a NahuelGanamosD
 * Mi Caja le decía ARS 2.110.000 sobre una deuda de 1.722.000 (26-oct-2026).
 *
 * La cara en pesos se deriva al leer, en `ars_referencia` — NUNCA en `monto_ars`, que la leen
 * veinte lugares de contabilidad. Lo que este suite ata es justamente eso: que la deuda en dólares,
 * lo guardado en la base y la fila de «los pesos cancelan pesos» queden EXACTAMENTE igual.
 */
process.env.DB_PATH = require('path').join(require('os').tmpdir(), `test-cara-${Date.now()}.sqlite`);
require('../src/db');
const tcStore = require('../src/tc-store');
const cierre = require('../src/cierre-store');
const clientes = require('../src/clientes-store');
const movs = require('../src/movimientos-store');
const deuda = require('../src/deuda.service');

let ok = 0, fail = 0;
const check = (t, c, extra) => { if (c) { ok++; console.log('✅ ' + t + (extra != null ? '  → ' + extra : '')); }
  else { fail++; console.log('❌ ' + t + (extra != null ? '  → ' + extra : '')); } };
const uno = (c, id) => movs.list({ cliente_id: c.id }).find((m) => m.id === id);

console.log('\n🪙 la cara en pesos de un pago en dólares\n');

tcStore.addSnapshot({ tc_ars_usdt: '1613', fecha: '2026-09-10', hora: '12:00' });
cierre.setTC('ARS', 'Septiembre_2026', '1631.35', true, true);

const n = clientes.createCliente({ codigo: 'NGD', nombre: 'NahuelGanamosD', moneda_cuenta: 'USDT' });
// Cargas con las dos caras, como las guarda el sistema.
movs.create({ cliente_id: n.id, tipo: 'carga', monto_ars: '2505000', monto_usdt: '1552.56', divisa: 'ARS', fecha: '2026-09-02T12:00:00.000Z' });
// El pago en dólares SIN tipo de cambio tipeado: así es como entra hoy.
const pUsdt = movs.create({ cliente_id: n.id, tipo: 'pago', monto_usdt: '237.84', monto_ars: null, divisa: 'USDT', medio: 'usdt', fecha: '2026-09-09T12:00:00.000Z' });

// ── 1 · lo que se arregla ────────────────────────────────────────────────────────────────────
const v = uno(n, pUsdt.id);
check('el pago en dólares recibe su cara en pesos derivada', v.ars_referencia === '388000.28', v.ars_referencia);
check('y dice con qué cambio se derivó', v.ars_referencia_tc === '1631.35', v.ars_referencia_tc);
check('con el TC del trader cargado, no se marca provisorio', v.ars_referencia_provisional === false);

const cc = deuda.cuentaCorriente(n.id);
check('la cuenta en pesos ya no cuenta corto', cc.otra_completa === true);
check('el saldo en pesos deja de estar inflado', cc.total_otra === '2116999.72', cc.total_otra);

// ── 2 · lo que NO se puede mover (la condición del dueño: no tocar meses pasados) ─────────────
check('la deuda en dólares queda igual', cc.total === '1314.72', cc.total);
check('lo pagado en dólares queda igual', cc.pagos === '237.84', cc.pagos);
check('`monto_ars` sigue vacío en la base', movs.getCrudo(pUsdt.id).monto_ars == null, String(movs.getCrudo(pUsdt.id).monto_ars));
check('y sigue vacío al leerlo: la referencia va aparte', v.monto_ars == null, String(v.monto_ars));

// Un pago en dólares NO puede empezar a comerse la fila de pesos: eso sí movería la deuda.
const pesos = require('../src/pesos-cancelan-pesos');
check('no pasa a contar como pago en pesos', pesos.esPagoEnPesos(v) === false);
check('no toca la fila de pesos', pesos.aplicar(movs.list({ cliente_id: n.id })).get(pUsdt.id) === undefined);

// ── 3 · un pago en pesos sigue funcionando como siempre ──────────────────────────────────────
const pArs = movs.create({ cliente_id: n.id, tipo: 'pago', monto_ars: '195000', monto_usdt: null, divisa: 'USDT', medio: 'cvu', tc_modo: 'mes', fecha: '2026-09-29T12:00:00.000Z' });
const w = uno(n, pArs.id);
check('el pago en pesos sigue derivando sus dólares', w.monto_usdt != null && w.monto_usdt !== '', w.monto_usdt);
check('y no se le inventa una referencia encima', w.ars_referencia == null, String(w.ars_referencia));
check('ese sí salda la fila de pesos', pesos.esPagoEnPesos(w) === true);

// ── 4 · sin cambio del mes no se inventa nada ────────────────────────────────────────────────
const otro = clientes.createCliente({ codigo: 'SINTC', nombre: 'SinTC', moneda_cuenta: 'USDT' });
const pSin = movs.create({ cliente_id: otro.id, tipo: 'pago', monto_usdt: '100', monto_ars: null, divisa: 'USDT', medio: 'usdt', fecha: '2021-03-09T12:00:00.000Z' });
check('sin TC del mes no hay referencia (dato faltante y visible)', uno(otro, pSin.id).ars_referencia == null);
check('y la cuenta lo dice', deuda.cuentaCorriente(otro.id).otra_completa === false);

console.log(`\n${fail ? '❌' : '✅'}  ${ok} bien, ${fail} mal\n`);
process.exit(fail ? 1 : 0);
