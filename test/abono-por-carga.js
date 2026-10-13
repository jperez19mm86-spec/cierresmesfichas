/**
 * abono-por-carga.js — CADA CARGA DE ARIEL LE ABONA 2 PUNTOS A FRAN.
 *
 * Ariel paga sus fichas al 14% y 2 de esos puntos son de Fran. El abono es una bonificación en la
 * cuenta de Fran, del mismo cambio que la carga, que no se duplica al reintentar y que se descuenta
 * si la carga se anula.
 */
const assert = require('assert');
process.env.DB_PATH = require('path').join(require('os').tmpdir(), `test-abono-${Date.now()}.sqlite`);

const { db } = require('../src/db');
const clientes = require('../src/clientes-store');
const pedidos = require('../src/pedidos-store');
const movs = require('../src/movimientos-store');
const historial = require('../src/historial');
const deudaCarga = require('../src/deuda-carga.service');
const deuda = require('../src/deuda.service');

let ok = 0, fail = 0;
const check = (t, c, extra) => { if (c) { ok++; console.log('✅ ' + t + (extra ? '  → ' + extra : '')); }
  else { fail++; console.log('❌ ' + t + (extra ? '  → ' + extra : '')); } };

const fran = clientes.createCliente({ codigo: 'FRANA', nombre: 'FranA' });
const ariel = clientes.createCliente({ codigo: 'ARIELA', nombre: 'ArielA' });
const otro = clientes.createCliente({ codigo: 'OTROA', nombre: 'OtroA' });
historial.setValor('cliente', ariel.id, 'precio_base_pct', { valor: '14', tipo_cambio: 'correccion' });
historial.setValor('cliente', otro.id, 'precio_base_pct', { valor: '10', tipo_cambio: 'correccion' });

const meter = (codigo, monto, divisa = 'ARS') => {
  const p = pedidos.create({ codigo, userId: '900001', divisa, monto: String(monto), cajaUsuario: 'GanamosM01', clienteNombre: codigo });
  const fila = db.prepare('SELECT data FROM pedidos WHERE id=?').get(p.id);
  const d = JSON.parse(fila.data); d.estado = 'cargado'; d.resueltoAt = '2026-10-10T12:00:00.000Z';
  db.prepare('UPDATE pedidos SET data=? WHERE id=?').run(JSON.stringify(d), p.id);
  return pedidos.get(p.id);
};
const bonifs = (c) => movs.list({ cliente_id: c.id, tipo: 'bonificacion' });

(async () => {
  console.log('\n🎁 abono por carga\n');

  // 1 · sin configurar, nada
  const p0 = meter('ARIELA', 1000000);
  await deudaCarga.porCarga(p0, { tcFijo: '1600' });
  check('sin abono configurado no se le acredita nada a nadie', bonifs(fran).length === 0);

  // 2 · la ficha guarda el abono y sobrevive a otro guardado (la tabla se reescribe entera)
  clientes.updateComercial(ariel.id, { abona_a: fran.id, abona_pts: '2' });
  clientes.updateComercial(otro.id, { estado: 'activo' });
  const a2 = clientes.get(ariel.id);
  check('el abono queda guardado en la ficha', a2.abona_a === fran.id && a2.abona_pts === '2');
  clientes.updateComercial(ariel.id, { abona_pts: '1,5' });
  check('los puntos aceptan coma', clientes.get(ariel.id).abona_pts === '1.5');
  clientes.updateComercial(ariel.id, { abona_pts: '2' });

  // 3 · carga nueva: 15.000.000 ARS al 14% = 2.100.000 ARS → 2 puntos = 300.000 ARS
  const p1 = meter('ARIELA', 15000000);
  const r1 = await deudaCarga.porCarga(p1, { tcFijo: '1600' });
  const b1 = bonifs(fran).find((m) => m.pedido_id === p1.id);
  check('la carga de Ariel crea el abono en la cuenta de Fran', !!b1);
  check('el abono es 2/14 de lo que se le cobró a Ariel, en pesos', b1 && b1.monto_ars === '300000', b1 && b1.monto_ars);
  check('y en dólares, con el mismo cambio que la carga',
    b1 && b1.monto_usdt === '187.5' && b1.tc_momento === r1.movimiento.tc_momento, b1 && (b1.monto_usdt + ' · TC ' + b1.tc_momento));
  check('la nota es corta: de quién y de cuándo', b1 && b1.notas === 'Abono de ArielA · 10/10', b1 && b1.notas);
  check('la deuda de Ariel no cambia: paga su 14 entero', r1.movimiento.monto_ars === '2100000');

  // 4 · reintentar no duplica
  await deudaCarga.porCarga(p1, { tcFijo: '1600' });
  check('reintentar la carga no abona dos veces', bonifs(fran).filter((m) => m.pedido_id === p1.id).length === 1);

  // 5 · la carga de antes de configurarlo se completa al repasarla
  const r0 = await deudaCarga.porCarga(p0, { tcFijo: '1600' });
  check('una carga vieja recibe su abono al volver a pasar', r0.abono && r0.abono.ok && bonifs(fran).some((m) => m.pedido_id === p0.id));

  // 6 · baja la deuda de Fran
  const antes = Number(deuda.cuentaCorriente(fran.id).total);
  check('el abono le baja la deuda a Fran', antes < 0, String(antes));

  // 7 · anular la carga descuenta el abono
  deudaCarga.porAnulacion(p1);
  deudaCarga.porAnulacion(p1);
  const bajas = movs.list({ cliente_id: fran.id, tipo: 'ajuste' }).filter((m) => m.pedido_id === p1.id);
  check('anular la carga devuelve el abono, una sola vez', bajas.length === 1 && bajas[0].monto_ars === '300000');
  const despues = Number(deuda.cuentaCorriente(fran.id).total);
  check('y la cuenta de Fran vuelve a quedar como sin esa carga', Math.abs(despues - (antes + 187.5)) < 0.01, `${antes} → ${despues}`);

  // 8 · guaraníes: sin cara en pesos, sólo dólares
  const p2 = meter('ARIELA', 50000000, 'PYG');
  const r2 = await deudaCarga.porCarga(p2, { tcFijo: '5800' });
  const b2 = bonifs(fran).find((m) => m.pedido_id === p2.id);
  check('en guaraníes el abono va en dólares y sin pesos', b2 && b2.monto_ars == null && b2.monto_usdt === String(Math.round(Number(r2.movimiento.monto_usdt) * 2 / 14 * 100) / 100), b2 && b2.monto_usdt);

  // 9 · puntos que no son menos que la base: no se abona
  clientes.updateComercial(otro.id, { abona_a: fran.id, abona_pts: '10' });
  const p3 = meter('OTROA', 1000000);
  const r3 = await deudaCarga.porCarga(p3, { tcFijo: '1600' });
  check('si los puntos igualan la base no se abona nada', !bonifs(fran).some((m) => m.pedido_id === p3.id) && r3.abono && !r3.abono.ok, r3.abono && r3.abono.motivo);

  console.log(`\n${ok} chequeos OK, ${fail} fallaron\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
