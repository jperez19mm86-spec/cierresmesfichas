/**
 * tc-cargas.js — CON QUÉ CAMBIO SE PASA CADA CARGA A DÓLARES (regla del dueño, 18-oct-2026).
 *
 *  · cuenta a fin de mes → promedio del mes de su moneda (provisorio mientras el mes está abierto)
 *  · va pagando (prepago / anticipado) → cambio del momento
 *  · cuenta en pesos → las fichas en pesos se debitan en pesos; las de otra moneda, deuda en DÓLARES aparte
 */
process.env.DB_PATH = require('path').join(require('os').tmpdir(), `test-tcc-${Date.now()}.sqlite`);
const { db } = require('../src/db');
const tcStore = require('../src/tc-store');
const clientes = require('../src/clientes-store');
const movs = require('../src/movimientos-store');
const deuda = require('../src/deuda.service');
const dc = require('../src/deuda-carga.service');
const tcUnico = require('../src/tc-unico.service');
const { mesTZ } = require('../src/lib/fechas');

let ok = 0, fail = 0;
const check = (t, c, x) => { if (c) { ok++; console.log('✅ ' + t + (x != null ? '  → ' + x : '')); } else { fail++; console.log('❌ ' + t + (x != null ? '  → ' + x : '')); } };
const hoy = mesTZ();
const igual = (a, b) => Math.abs(Number(a) - Number(b)) < 0.005;

(async () => {
  console.log('\n💱 el cambio de las cargas, según cómo paga el cliente\n');
  tcStore.addSnapshot({ tc_ars_usdt: '1500', fecha: '2026-09-05', hora: '12:00' });
  tcStore.addSnapshot({ tc_ars_usdt: '1700', fecha: '2026-09-25', hora: '12:00' });
  tcStore.addSnapshot({ tc_ars_usdt: '1450', fecha: hoy + '-02', hora: '12:00' });
  db.prepare("INSERT INTO tc_divisa_snapshots (fecha,divisa,tasa,fuente,createdAt) VALUES ('2026-09-10','PYG','6000','binancep2p (criptoya)','x')").run();
  const promSep = tcUnico.tcDelMes('ARS', '2026-09').valor;

  // quién va con qué, sin elegir
  const post = clientes.createCliente({ codigo: 'POST', nombre: 'Post' });
  const prep = clientes.createCliente({ codigo: 'PREP', nombre: 'Prep' });
  clientes.updateComercial(prep.id, { prepago: true });
  const anti = clientes.createCliente({ codigo: 'ANTI', nombre: 'Anti' });
  clientes.updateComercial(anti.id, { momento_pago: 'anticipado' });
  check('sin elegir: a fin de mes → promedio', clientes.tcCargasDe(clientes.get(post.id)) === 'promedio');
  check('sin elegir: prepago → momento', clientes.tcCargasDe(clientes.get(prep.id)) === 'momento');
  check('sin elegir: anticipado en la planilla → momento', clientes.tcCargasDe(clientes.get(anti.id)) === 'momento');
  clientes.updateComercial(anti.id, { tc_cargas: 'promedio' });
  check('lo elegido en la ficha gana', clientes.tcCargasDe(clientes.get(anti.id)) === 'promedio');
  const hist = require('../src/historial');
  const setBase = (id) => hist.setValor('cliente', id, 'precio_base_pct', { valor: '10', tipo_cambio: 'correccion' });
  [post, prep, anti].forEach((c) => setBase(c.id));
  check('el % base quedó cargado', dc.baseDe(clientes.get(post.id)) === '10', dc.baseDe(clientes.get(post.id)));

  // 1 · a fin de mes, en pesos, septiembre (mes cerrado)
  const r1 = await dc.porCarga({ id: 'p1', codigo: 'POST', monto: '3000000', divisa: 'ARS', resueltoAt: '2026-09-12T15:00:00.000Z' });
  const cr1 = movs.getCrudo(r1.movimiento.id);
  check('a fin de mes: se guardan los pesos, no un cambio', cr1.monto_ars === '300000' && cr1.monto_usdt == null && cr1.tc_modo === 'mes', JSON.stringify([cr1.monto_ars, cr1.monto_usdt, cr1.tc_modo]));
  const v1 = movs.get(r1.movimiento.id);
  check('y vale con el PROMEDIO de septiembre', igual(v1.monto_usdt, (300000 / Number(promSep)).toFixed(2)) && v1.provisional === false, v1.monto_usdt + ' @ ' + promSep);

  // 2 · a fin de mes, mes abierto → provisorio
  const r2 = await dc.porCarga({ id: 'p2', codigo: 'POST', monto: '1450000', divisa: 'ARS', resueltoAt: hoy + '-03T15:00:00.000Z' });
  const v2 = movs.get(r2.movimiento.id);
  check('en el mes abierto vale con el promedio de hasta hoy, provisorio', igual(v2.monto_usdt, 100) && v2.provisional === true, v2.monto_usdt);

  // 3 · guaraníes, a fin de mes
  const r3 = await dc.porCarga({ id: 'p3', codigo: 'POST', monto: '6000000', divisa: 'PYG', resueltoAt: '2026-09-12T15:00:00.000Z' });
  const cr3 = movs.getCrudo(r3.movimiento.id); const v3 = movs.get(r3.movimiento.id);
  check('en guaraníes se guarda la deuda en guaraníes', cr3.monto_local === '600000' && cr3.monto_ars == null && cr3.monto_usdt == null, JSON.stringify(cr3.monto_local));
  check('y vale en dólares con el promedio del guaraní', igual(v3.monto_usdt, 100), v3.monto_usdt);

  // 4 · va pagando: el cambio del momento
  const r4 = await dc.porCarga({ id: 'p4', codigo: 'PREP', monto: '1000000', divisa: 'ARS', resueltoAt: hoy + '-03T15:00:00.000Z' }, { tcFijo: '1250' });
  const cr4 = movs.getCrudo(r4.movimiento.id);
  check('va pagando: queda fijo con el cambio del momento', igual(cr4.monto_usdt, 80) && cr4.tc_momento === '1250' && cr4.tc_modo == null, cr4.monto_usdt);

  // 5 · anular una carga al promedio: la baja se mueve con ella y suman cero
  const a1 = dc.porAnulacion({ id: 'p1', codigo: 'POST' });
  const va = movs.get(a1.movimiento.id);
  check('anular deja la baja al mismo promedio', igual(va.monto_usdt, (-300000 / Number(promSep)).toFixed(2)) && va.tc_modo === 'mes', va.monto_usdt);

  // 5b · el abono a otro cliente sigue al promedio de su carga
  const fran = clientes.createCliente({ codigo: 'FRANX', nombre: 'FranX' });
  clientes.updateComercial(post.id, { abona_a: fran.id, abona_pts: '2' });
  const r5 = await dc.porCarga({ id: 'p5', codigo: 'POST', monto: '3000000', divisa: 'ARS', resueltoAt: '2026-09-14T15:00:00.000Z' });
  const ab = movs.list({ cliente_id: fran.id, tipo: 'bonificacion' })[0];
  check('el abono de una carga al promedio también va al promedio', ab && ab.tc_modo === 'mes' && igual(ab.monto_usdt, 60000 / Number(promSep)), ab && ab.monto_usdt);
  clientes.updateComercial(post.id, { abona_a: '', abona_pts: '' }); void r5;

  // 6 · cuenta en pesos
  const ars = clientes.createCliente({ codigo: 'CTAARS', nombre: 'CtaArs' });
  clientes.updateComercial(ars.id, { moneda_cuenta: 'ARS' }); setBase(ars.id);
  const r6 = await dc.porCarga({ id: 'p6', codigo: 'CTAARS', monto: '2000000', divisa: 'ARS', resueltoAt: hoy + '-03T15:00:00.000Z' });
  const cr6 = movs.getCrudo(r6.movimiento.id);
  check('cuenta en pesos: las fichas en pesos se debitan en pesos', cr6.monto_ars === '200000' && cr6.monto_usdt == null && cr6.tc_modo == null);
  const r7 = await dc.porCarga({ id: 'p7', codigo: 'CTAARS', monto: '500', divisa: 'USDT', resueltoAt: hoy + '-03T15:00:00.000Z' });
  check('y las de otra moneda generan deuda en dólares (antes no se anotaban)', r7.ok && igual(movs.getCrudo(r7.movimiento.id).monto_usdt, 50), JSON.stringify(r7.motivo || ''));
  const cc = deuda.cuentaCorriente(ars.id);
  check('la cuenta en pesos muestra esos dólares aparte, sin mezclarlos', igual(cc.total, 200000) && igual(cc.aparte_usdt, 50) && cc.enOtraMoneda === 0, JSON.stringify([cc.total, cc.aparte_usdt, cc.enOtraMoneda]));

  // 7 · el % que regía el día de la carga, no el de hoy
  const pct = clientes.createCliente({ codigo: 'PCT', nombre: 'Pct' });
  hist.setValor('cliente', pct.id, 'precio_base_pct', { valor: '10', tipo_cambio: 'correccion' });
  hist.setValor('cliente', pct.id, 'precio_base_pct', { valor: '15', tipo_cambio: 'vigencia', vigente_desde: '2026-10-01' });
  const r8 = await dc.porCarga({ id: 'p8', codigo: 'PCT', monto: '1000', divisa: 'USDT', resueltoAt: '2026-09-20T15:00:00.000Z' });
  const r9 = await dc.porCarga({ id: 'p9', codigo: 'PCT', monto: '1000', divisa: 'USDT', resueltoAt: '2026-10-05T15:00:00.000Z' });
  check('una carga de septiembre usa el % de septiembre aunque hoy sea otro', r8.base === '10' && r9.base === '15', r8.base + ' / ' + r9.base);

  // 8 · pasar al promedio lo que ya estaba anotado con el cambio del momento
  const vie = clientes.createCliente({ codigo: 'VIEJO', nombre: 'Viejo' }); setBase(vie.id);
  const fr2 = clientes.createCliente({ codigo: 'FR2', nombre: 'Fr2' });
  clientes.updateComercial(vie.id, { tc_cargas: 'momento', abona_a: fr2.id, abona_pts: '2' });
  const k1 = await dc.porCarga({ id: 'q1', codigo: 'VIEJO', monto: '3000000', divisa: 'ARS', resueltoAt: '2026-09-10T15:00:00.000Z' }, { tcFijo: '1500' });
  const k2 = await dc.porCarga({ id: 'q2', codigo: 'VIEJO', monto: '1500000', divisa: 'ARS', resueltoAt: '2026-09-11T15:00:00.000Z' }, { tcFijo: '1500' });
  dc.porAnulacion({ id: 'q2', codigo: 'VIEJO' });
  check('antes: con el cambio del momento', igual(movs.getCrudo(k1.movimiento.id).monto_usdt, 200));
  clientes.updateComercial(vie.id, { tc_cargas: 'promedio' });
  const sim = dc.pasarAlPromedio('2026-09');
  const sv = sim.clientes.find((x) => x.cliente === 'VIEJO'); const sf = sim.clientes.find((x) => x.cliente === 'FR2');
  check('la simulación dice cuánto cambia cada uno, sin tocar nada', sv && igual(sv.antes, 200) && igual(sv.despues, 300000 / Number(promSep))
    && sf && igual(sf.despues, -(60000 / Number(promSep))) && movs.getCrudo(k1.movimiento.id) != null, JSON.stringify([sv, sf]));
  const deb0 = deuda.cuentaCorriente(fr2.id).total;
  dc.pasarAlPromedio('2026-09', { aplicar: true });
  const cV = movs.list({ cliente_id: vie.id, tipo: 'carga' });
  check('aplicado: las cargas quedan al promedio', cV.length === 2 && cV.every((x) => x.tc_modo === 'mes') && !movs.getCrudo(k1.movimiento.id), cV.map((x) => x.monto_usdt).join(','));
  check('la anulada sigue sumando cero', igual(deuda.cuentaCorriente(vie.id).total, 300000 / Number(promSep)), deuda.cuentaCorriente(vie.id).total);
  check('y el abono a otro cliente pasó al promedio', igual(deuda.cuentaCorriente(fr2.id).total, -(60000 / Number(promSep))), deb0 + ' → ' + deuda.cuentaCorriente(fr2.id).total);
  check('correrlo de nuevo no hace nada', dc.pasarAlPromedio('2026-09').cargas === 0);

  // 9 · lo que ya se corrigió a mano se deja afuera (Titan, UYU de septiembre)
  const exc = clientes.createCliente({ codigo: 'EXC', nombre: 'Exc' }); setBase(exc.id);
  clientes.updateComercial(exc.id, { tc_cargas: 'momento' });
  const e1 = await dc.porCarga({ id: 'x1', codigo: 'EXC', monto: '3000000', divisa: 'ARS', resueltoAt: '2026-09-12T15:00:00.000Z' }, { tcFijo: '1500' });
  clientes.updateComercial(exc.id, { tc_cargas: 'promedio' });
  const sx = dc.pasarAlPromedio('2026-09', { excluir: ['exc:ars'] });
  check('excluir deja afuera esa moneda de ese cliente', !sx.clientes.some((x) => x.cliente === 'EXC') && sx.excluidos.includes('EXC:ARS'), JSON.stringify(sx.clientes));
  dc.pasarAlPromedio('2026-09', { aplicar: true, excluir: ['EXC:ARS'] });
  check('y aplicado no la toca', movs.getCrudo(e1.movimiento.id) != null && movs.getCrudo(e1.movimiento.id).tc_modo !== 'mes');
  check('sin excluir, la toma', dc.pasarAlPromedio('2026-09').clientes.some((x) => x.cliente === 'EXC'));

  console.log(`\n${ok} chequeos OK, ${fail} fallaron\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
