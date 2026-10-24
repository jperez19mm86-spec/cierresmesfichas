/**
 * nuestro-chat.js — El cobro de NUESTRO chat (reglas de Alexa del 22 y 24-oct-2026), contra una
 * base de prueba. Cada chequeo es una regla de plata: si uno falla, el cobro está mal.
 */
const assert = require('assert');
process.env.DB_PATH = require('path').join(require('os').tmpdir(), 'test-nuestro-chat-' + Date.now() + '.sqlite');
process.env.NC_HOY = '2026-10-22';
const { db } = require('../src/db');
const clientes = require('../src/clientes-store');
const rd = require('../src/reporte-diario-store');
const tcStore = require('../src/tc-store');
const nc = require('../src/nuestro-chat.store');

let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; console.log('  ✓', m); };
const eq = (a, b, m) => { assert.strictEqual(String(a), String(b), m + ` (dio ${a}, se esperaba ${b})`); n++; console.log('  ✓', m); };
const rechaza = (r, m) => { assert.ok(r && r.ok === false, m + ' (no lo rechazó)'); n++; console.log('  ✓', m, '→', r.error); };

/* ── el escenario ───────────────────────────────────────────────────────────────────────────── */
db.prepare("INSERT INTO casino_conexiones (id, nombre, url, activa, createdAt, ord) VALUES ('cx_eu','Europa','https://europa.test',1,'2026-01-01',1)").run();
const fran = clientes.createCliente({ codigo: 'FRAN74', nombre: 'Fran' });
const bet = clientes.createCliente({ codigo: 'BET30', nombre: 'Bet30' });
const celu = clientes.createCliente({ codigo: 'CELU', nombre: 'Celuapuestas' });
/* El cambio del peso: el promedio del mes sale de los snapshots de Binance. */
for (const f of ['2026-09-10', '2026-09-20']) tcStore.addSnapshot({ tc_ars_usdt: '1450', fecha: f, hora: '18:00' });
for (const f of ['2026-10-10']) tcStore.addSnapshot({ tc_ars_usdt: '1450', fecha: f, hora: '18:00' });
/* Como el acumulado: todas las cajas de un día se guardan JUNTAS (upsertDia reemplaza el día entero). */
const _dias = {};
const ganancia = (sala, mes, porDia) => { for (const [d, profit] of Object.entries(porDia)) {
  const k = `${mes}-${d}`; (_dias[k] = _dias[k] || []).push({ id: sala, login: 'c' + sala, in: 0, out: 0, profit });
  rd.upsertDia('cx_eu', k, 'chat', 'ARS', _dias[k]); } };

console.log('\nConfiguración');
rechaza(nc.setConfig({ trc20: 'TRRfhjjgLjagrov3oB6879dovHiU3KB4gD' }), 'una TRC20 con una letra cambiada no entra');
rechaza(nc.setConfig({ bep20: '0x123' }), 'una BEP20 corta no entra');
rechaza(nc.setConfig({ pct: '5' }), 'el % no puede ser 5');
ok(nc.setConfig({ trc20: 'TRRfhjjgLjagrov3oB6879dovHiU3KB4gC', bep20: '0xf019E44a7c6c682FD427216b532bd7A9d21ddb8F' }).ok, 'las dos wallets del chat entran');

console.log('\nClientes y cajas');
ok(nc.sumarCliente(fran.id).ok && nc.sumarCliente(bet.id).ok && nc.sumarCliente(celu.id).ok, 'se suman los clientes');
rechaza(nc.guardarCaja({ cliente: fran.id, caja: 'X', sala: 'abc', conexion: 'cx_eu' }), 'el número de caja tiene que ser un número');
rechaza(nc.guardarCaja({ cliente: fran.id, caja: 'X', sala: '123456', conexion: 'nada' }), 'hay que elegir Europa o Casino');
const f1 = nc.guardarCaja({ cliente: fran.id, caja: 'FranChat01', sala: '7505635', conexion: 'cx_eu', desde: '2026-08-01', entrada: '0', pct: '1' });
const f2 = nc.guardarCaja({ cliente: fran.id, caja: 'FranChat02', sala: '7505636', conexion: 'cx_eu', desde: '2026-08-01', entrada: '0', pct: '1' });
ok(f1.ok && f2.ok, 'Fran tiene dos cajas al 1 %');
rechaza(nc.guardarCaja({ cliente: bet.id, caja: 'Copia', sala: '7505635', conexion: 'cx_eu' }), 'la misma caja de Imperia no se carga dos veces');
const b1 = nc.guardarCaja({ cliente: bet.id, caja: 'Bet30Caja1', sala: '8000001', conexion: 'cx_eu', desde: '2026-08-01', entrada: '0' });
const c1 = nc.guardarCaja({ cliente: celu.id, caja: 'CeluCaja01', sala: '8000002', conexion: 'cx_eu', entrada: '200' });   // sin fecha de inicio
ok(nc.salasActivas('cx_eu').includes('7505635'), 'el acumulado sabe qué cajas leer de noche');

nc._recaptura.estado = {}; nc._recaptura.cola.length = 0;   // (en la prueba no hay casino: se limpia lo pedido)
console.log('\nGanancia de septiembre (de Imperia)');
ganancia('7505635', '2026-09', { '05': 10000000, '20': 4500000 });       // 14,5 M
ganancia('7505636', '2026-09', { '10': 7300000 });
ganancia('8000001', '2026-09', { '10': 1000000, '11': -3340000 });       // pérdida

console.log('\nEl cobro del 1 de octubre');
const a = nc.armarMes('2026-10');
eq(a.creados, 2, 'salen dos cobros (Fran y Bet30); Celuapuestas no empezó');
const docs = nc.listarCobros();
const dF = docs.find((d) => d.clienteId === fran.id), dB = docs.find((d) => d.clienteId === bet.id);
eq(Number(dF.total).toFixed(2), '450.34', 'Fran: 2 × 150 por adelantado + 1 % de 14,5 M y de 7,3 M al 1.450');
eq(Number(dB.total).toFixed(2), '150.00', 'Bet30: el mes dio pérdida, paga solo el mantenimiento');
ok(dF.cajas[0].lineas.some((l) => /Mantenimiento de octubre/.test(l.k)), 'el mantenimiento es el del mes que empieza');
ok(dF.cajas[0].lineas.some((l) => /ganancia de septiembre/.test(l.k)), 'el % es del mes que cerró');
ok(dF.exacto !== dB.exacto && money(dF.exacto) > money(dF.total), 'cada cobro lleva sus centavos y no se repiten');
eq(nc.armarMes('2026-10').creados, 0, 'armar de nuevo no cobra dos veces');
eq(db.prepare("SELECT COUNT(*) n FROM nc_cobro WHERE tipo='mes' AND ref='2026-10'").get().n, 2, 'la base tiene un solo cobro por cliente y mes');

console.log('\nVencido, cartel y prórroga (hoy es 22-oct)');
ok(nc.cartelDe(bet.id, nc.listarCobros()).activo, 'Bet30 no pagó: desde el 6 le aparece el cartel');
eq(nc.cartelDe(bet.id, nc.listarCobros()).desde, '2026-10-06', 'el cartel arranca el día después del vencimiento');
ok(nc.prorroga(bet.id, '2026-10-25').ok && !nc.cartelDe(bet.id, nc.listarCobros()).activo, 'con prórroga no le aparece');
rechaza(nc.prorroga(bet.id, '2026-10-01'), 'una prórroga en el pasado no entra');
nc.prorroga(bet.id, null);

console.log('\nPagos');
rechaza(nc.registrarPago({ cobro: dF.id, monto: '0' }), 'un pago en cero no entra');
rechaza(nc.registrarPago({ cobro: dF.id, monto: '900' }), 'un pago de más del doble no entra');
const h = 'a'.repeat(64);
ok(nc.registrarPago({ cobro: dF.id, monto: '100', red: 'TRC20', hash: h }).ok, 'Fran paga una parte');
rechaza(nc.registrarPago({ cobro: dB.id, monto: '10', red: 'TRC20', hash: h }), 'el mismo código de transferencia no paga dos veces');
let x = nc.listarCobros().find((d) => d.id === dF.id);
eq(Number(x.debe).toFixed(2), (money(dF.exacto) - 100).toFixed(2), 'le queda lo que falta');
ok(nc.registrarPago({ cobro: dF.id, monto: x.debe }).ok, 'paga el resto');
eq(nc.listarCobros().find((d) => d.id === dF.id).estado, 'pagado', 'y queda pagado');

console.log('\nEl link del cliente');
const tokBet = db.prepare('SELECT token FROM nc_cliente WHERE cliente_id=?').get(bet.id).token;
ok(tokBet.length >= 20, 'el link tiene un código largo');
ok(nc.cuentaCliente('no-existe-este-token-xx').ok === false, 'un link inventado no muestra nada');
const cb = nc.cuentaCliente(tokBet);
ok(cb.ok && cb.abierto && cb.abierto.estado === 'vencido' && cb.cartel, 'Bet30 ve lo que debe y que está vencido');
eq(cb.wallets.length, 2, 've las dos wallets');
ok(!JSON.stringify(cb).includes(fran.id) && !JSON.stringify(cb).includes('FranChat'), 'no ve nada de otro cliente');
rechaza(nc.avisarHash(tokBet, cb.abierto.id, 'corto'), 'un código incompleto no entra');
ok(nc.avisarHash(tokBet, cb.abierto.id, '0x' + 'b'.repeat(64)).ok, 'pega el código de su transferencia');
ok(nc.cuentaCliente(tokBet).abierto.revisando, 'y ve que lo estamos revisando');
const av = nc.pagos().avisos[0];
ok(av && av.red === 'BEP20', 'a Alexa le aparece para aprobar');
ok(nc.resolverAviso(av.id, { aprobar: true }).ok, 'lo aprueba');
eq(nc.cuentaCliente(tokBet).abierto, null, 'Bet30 queda al día');
ok(!nc.cartelDe(bet.id, nc.listarCobros()).activo, 'y se le va el cartel');
const est = nc.estadoParaElChat(tokBet);
ok(est.ok && est.cartel === false && est.debe === 0, 'lo que le va a preguntar el panel del chat');

console.log('\nFecha de inicio y conexión');
ok(nc.marcarInicio(c1.id, '2026-10-29').ok, 'Celuapuestas empieza el 29');
eq(nc.armarConexiones('2026-10-22').creados, 0, 'el 29 es de los últimos 7 días: la conexión no sale aparte');
const t = nc.tablero();
const tc = t.clientes.find((c) => c.id === celu.id);
ok(tc && tc.cajas[0].lineas.some((l) => l.cat === 'entrada' && Number(l.v) === 200), 'va con el cobro del 1 de noviembre');
ok(tc.cajas[0].lineas.some((l) => /Mantenimiento de noviembre/.test(l.k)), 'con noviembre por adelantado (octubre no paga)');
const z = nc.guardarCaja({ cliente: bet.id, caja: 'Bet30Caja2', sala: '8000003', conexion: 'cx_eu', entrada: '50' });
ok(nc.marcarInicio(z.id, '2026-10-24').ok, 'una caja de Bet30 empieza el 24 con 50 de conexión');
eq(nc.armarConexiones('2026-10-22').creados, 0, 'antes del 24 no se cobra nada');
process.env.NC_HOY = '2026-10-24';
nc.guardarCaja({ id: z.id, cliente: bet.id, entrada: '50' });
const y = nc.guardarCaja({ cliente: bet.id, caja: 'Bet30Caja3', sala: '8000004', conexion: 'cx_eu', entrada: '50', desde: '2026-10-10' });
eq(nc.armarConexiones('2026-10-24').creados, 2, 'la del 24 y la que empezó el 10 pagan su conexión aparte');
const cy = nc.listarCobros().find((d) => d.tipo === 'conexion' && d.ref === y.id);
eq(cy.vence, '2026-10-29', 'la que se cargó después de empezar vence a los 5 días de hoy, no ya vencida');
eq(cy.estado, 'pendiente', 'y no queda vencida (sin cartel por esto)');
ok(nc._recaptura.cola.some((k) => k === 'cx_eu|2026-10-10') && nc._recaptura.cola.some((k) => k === 'cx_eu|2026-10-23'), 'se le pide a Imperia la ganancia desde su inicio hasta ayer');
ok(nc.recapturando(y.id), 'mientras tanto el % dice que la está trayendo (no calcula de menos)');
nc._recaptura.estado = {}; nc._recaptura.cola.length = 0;
rechaza(nc.guardarCaja({ id: y.id, cliente: bet.id, desde: '2026-10-12' }), 'con su conexión ya cobrada, la fecha de inicio no se puede mover');
eq(nc.armarConexiones('2026-10-24').creados, 0, 'y no se cobra dos veces');

console.log('\nSin conexión: los días del primer mes');
const sc = nc.guardarCaja({ cliente: celu.id, caja: 'CeluCaja02', sala: '8000010', conexion: 'cx_eu', entrada: '0', desde: '2026-10-10' });
const rg = nc.guardarCaja({ cliente: celu.id, caja: 'CeluCaja03', sala: '8000011', conexion: 'cx_eu', entrada: '0', desde: '2026-10-10', regalo: true });
nc._recaptura.estado = {}; nc._recaptura.cola.length = 0;
const tl = nc.tablero().clientes.find((c) => c.id === celu.id);
const l2 = tl.cajas.find((x) => x.caja === 'CeluCaja02').lineas, l3 = tl.cajas.find((x) => x.caja === 'CeluCaja03').lineas;
ok(l2.some((l) => /Días de octubre, del 10 al 31/.test(l.k) && Number(l.v) === 106.45), 'sin conexión, del 10 al 31 de octubre: 22 de 31 días de 150 = 106,45 con el cobro del 1');
ok(!l3.some((l) => /Días de octubre/.test(l.k)), 'con «primer mes de regalo», esos días no se cobran');
ok(!tl.cajas.find((x) => x.caja === 'CeluCaja01').lineas.some((l) => /Días de/.test(l.k)), 'con conexión, la conexión cubre el primer mes');
nc.darDeBaja(sc.id); nc.darDeBaja(rg.id);

console.log('\nNoviembre: lo que falta frena el cobro');
const nov = nc.armarMes('2026-11');
ok(nov.problemas.some((p) => p.clienteId === fran.id && /sin datos/.test(p.texto)), 'Fran sin ganancia de octubre en Imperia: no sale');
ok(nc.armarMes('2026-11', { cliente: fran.id, sinDatosEsCero: true }).creados === 1, '«sin movimiento» lo arma con el % en cero');

console.log('\nLo que corre solo');
(() => {
  const antes = db.prepare('SELECT COUNT(*) n FROM nc_cobro').get().n;
  return nc.tick({ ahoraFecha: new Date('2026-12-15T15:00:00Z'), enviar: async () => ({ ok: true }) }).then(() => {
    eq(db.prepare("SELECT COUNT(*) n FROM nc_cobro WHERE tipo='mes' AND ref='2026-12'").get().n, 0, 'recién subido el 15: no arma el mes en curso');
    ok(antes >= 0, '(se empieza a cobrar solo el 1 que viene)');
  });
})();
rechaza(nc.anotarGasto({ fecha: '2026-10-05', concepto: 'x', monto: '1.400' }), '«1.400» no se lee como 1,40');

console.log('\nLa cuenta del chat');
ok(nc.anotarGasto({ fecha: '2026-10-02', concepto: 'Suscripción de Claude', cat: 'Herramientas', pago: 'alexa', monto: '200' }).ok, 'gasto pagado por Alexa');
ok(nc.anotarGasto({ fecha: '2026-10-05', concepto: 'Railway', cat: 'Servidores', pago: 'prog', monto: '20' }).ok, 'gasto pagado por el programador');
rechaza(nc.anotarGasto({ fecha: '2026-10-05', concepto: 'x', monto: 'mil' }), 'un monto que no es número no entra');
const cu = nc.cuenta('2026-10');
const entro = cu.porCliente.reduce((s, c) => s + c.total, 0);
eq(cu.totales.entro.toFixed(2), entro.toFixed(2), 'lo que entró es la suma de lo que pagó cada cliente');
eq(cu.totales.neto.toFixed(2), (entro - 220).toFixed(2), 'lo que queda descuenta los gastos');
eq((cu.totales.parteAlexa + cu.totales.parteProg).toFixed(2), cu.totales.neto.toFixed(2), 'mitad y mitad suma exacto lo que quedó');
eq(cu.prog.leToca.toFixed(2), (cu.totales.parteProg + 20).toFixed(2), 'al programador le toca su mitad más el gasto que pagó él');
const sumaPartes = cu.porCliente.reduce((s, c) => s + c.entrada + c.mant + c.variable, 0);
eq(sumaPartes.toFixed(2), entro.toFixed(2), 'conexión + mantenimiento + % cierran al centavo con lo que entró');
const g = cu.gastos.find((x) => x.concepto === 'Railway');
ok(nc.borrarGasto(g.id, 'admin').ok && nc.cuenta('2026-10').gastos.length === 1, 'borrar un gasto lo saca de la cuenta');
ok(db.prepare('SELECT borrado_por FROM nc_gasto WHERE id=?').get(g.id).borrado_por === 'admin', 'pero queda anotado quién lo borró');

console.log('\nEl envío por Telegram');
(async () => {
  const salieron = [];
  const enviar = async (gid, texto) => { salieron.push({ gid, texto }); return { ok: true }; };
  nc.setCliente(bet.id, { tg: '-1001234567890' });
  rechaza(nc.setCliente(bet.id, { tg: 'grupo de bet' }), 'el grupo de Telegram tiene que ser un número');
  const r = await nc.mandarMes('2026-10', { enviar });
  ok(r.ok, 'se manda el mes');
  ok(salieron.every((s) => s.gid === '-1001234567890'), 'solo le llega al grupo de Bet30 (los otros no tienen grupo)');
  ok(salieron.length && /mi-chat\//.test(salieron[0].texto), 'con su link de pago');
  const antes = salieron.length;
  await nc.mandarMes('2026-10', { enviar });
  eq(salieron.length, antes, 'mandar de nuevo no repite lo que ya salió');
  console.log(`\n${n} chequeos en verde`);
})().catch((e) => { console.error(e); process.exit(1); });

function money(s) { return Number(s); }
