/**
 * prepago.js — clientes que pagan primero y piden contra su saldo a favor (6-oct-2026).
 *
 * Mismos módulos que producción (puente de Mi Caja + servicio), con una base temporal y el dólar
 * cripto fijo en 1.000 (sin red). Lo que se prueba:
 *  · a un cliente que NO es prepago no le cambia nada;
 *  · prepago con saldo 0 no pide; un pago aprobado lo habilita; los pendientes reservan;
 *  · el margen en % del saldo; el lote del distribuidor entra entero o no entra;
 *  · en qué divisas puede pagar; y que los campos nuevos sobreviven al DELETE+INSERT del store.
 */
const fs = require('fs'); const os = require('os'); const path = require('path');
process.env.DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'prepago-')), 'p.sqlite');
process.env.ENLACE_TOKEN = 'token-de-prueba-largo-1234567890';

// El dólar cripto, fijo: 1 USDT = 1.000 ARS. Se reemplaza ANTES de que lo tome nadie.
const tcSvc = require('../src/tc.service');
tcSvc.tcAhora = async () => ({ tc: '1000', fuente: 'test', vivo: true });

const express = require('express');
const clientes = require('../src/clientes-store');
const participaciones = require('../src/participaciones-store');
const personas = require('../src/personas-store');
const historial = require('../src/historial');
const movs = require('../src/movimientos-store');
const pedidos = require('../src/pedidos-store');
const prepago = require('../src/prepago.service');
const enlace = require('../src/enlace.routes');

const v = []; const check = (n, c, d) => { v.push({ ok: !!c }); console.log((c ? '✅' : '❌') + ' ' + n + (d ? '  → ' + d : '')); };

// Dos clientes configurados (% de reparto + Telegram), al 10% de base, cuenta en USDT.
const per = personas.create({ nombre: 'EmpresaTest' });
function nuevo(codigo, usuario, userId) {
  const c = clientes.createCliente({ codigo, nombreVisible: codigo, nombre: codigo });
  clientes.addCaja(c.id, { usuario, sistema: 'europa', userId, divisas: ['ARS'], permisos: { pedir: true, pagos: true, cuenta: true } });
  participaciones.setReparto(c.id, null, [{ persona_id: per.id, porcentaje: 100 }], '2026-09-01');
  clientes.setTelegram(c.id, { chatId: '-100123', enabled: false });
  historial.setValor('cliente', c.id, 'precio_base_pct', { valor: '10', tipo_cambio: 'vigencia', vigente_desde: '2026-09-01' });
  return clientes.get(c.id);
}
const post = nuevo('POST1', 'AgentePost', '80001');
let pre = nuevo('PRE1', 'AgentePre', '80002');
clientes.addCaja(pre.id, { usuario: 'DistPre', sistema: 'europa', userId: '80010', divisas: ['ARS'], rol: 'distribuidor', permisos: { pedir: true, pagos: false, cuenta: false } });
clientes.addCaja(pre.id, { usuario: 'AgentePre2', sistema: 'europa', userId: '80003', divisas: ['ARS'], permisos: { pedir: true, pagos: false, cuenta: false } });
clientes.updateComercial(pre.id, { prepago: true });

(async () => {
  const app = express(); app.use(express.json({ limit: '5mb' })); enlace.mount(app);
  const srv = app.listen(0); const U = `http://127.0.0.1:${srv.address().port}/api/enlace/v1`;
  const tok = { authorization: 'Bearer ' + process.env.ENLACE_TOKEN };
  const J = (m, p, b) => fetch(U + p, { method: m, headers: { 'content-type': 'application/json', ...tok }, body: b ? JSON.stringify(b) : undefined }).then((r) => r.json());

  /* ── 1 · al que no es prepago no le cambia nada ─────────────────────────────────────────── */
  const p0 = await J('POST', '/pedido', { usuario: 'AgentePost', userId: '80001', monto: 1000000, divisa: 'ARS' });
  check('postpago: pide sin saldo, como siempre', p0.creado === true, JSON.stringify(p0.motivo || ''));

  /* ── 2 · prepago sin saldo no pide ──────────────────────────────────────────────────────── */
  const p1 = await J('POST', '/pedido', { usuario: 'AgentePre', userId: '80002', monto: 1000, divisa: 'ARS' });
  check('prepago con saldo 0: no pide (sin_saldo)', p1.creado === false && p1.motivo === 'sin_saldo' && p1.prepago && p1.prepago.disponible === 0, JSON.stringify(p1));

  /* ── 3 · un pago aprobado le da saldo; el costo es monto × % ÷ TC ──────────────────────── */
  movs.create({ cliente_id: pre.id, tipo: 'pago', monto_usdt: '100', monto_ars: null, divisa: 'USDT', medio: 'usdt', notas: 'test' });
  const c1 = await prepago.costoDe(clientes.get(pre.id), { sistema: 'europa', userId: '80002', monto: 1000000, divisa: 'ARS' });
  check('costo de 1.000.000 en fichas al 10% con TC 1.000 = 100 USDT', c1.costo === 100 && c1.cuentaEn === 'USDT', JSON.stringify(c1));
  const e1 = await J('GET', '/estado-cliente?usuario=AgentePre&userId=80002');
  check('estado-cliente: 100 USDT disponibles, que alcanzan para 1.000.000 en fichas',
    e1.prepago && e1.prepago.prepago && e1.prepago.disponible === 100 && e1.prepago.alcanza === 1000000, JSON.stringify(e1.prepago));
  check('…y dicho en la moneda de su caja: ARS 100.000 disponibles (al dólar de hoy, 1.000)',
    e1.prepago.enCaja && e1.prepago.enCaja.moneda === 'ARS' && e1.prepago.enCaja.disponible === 100000 && e1.prepago.enCaja.saldoAFavor === 100000, JSON.stringify(e1.prepago.enCaja));
  const p2 = await J('POST', '/pedido', { usuario: 'AgentePre', userId: '80002', monto: 600000, divisa: 'ARS' });
  check('pide 600.000 (60 USDT): entra', p2.creado === true);

  /* ── 4 · lo pendiente reserva ───────────────────────────────────────────────────────────── */
  const p3 = await J('POST', '/pedido', { usuario: 'AgentePre', userId: '80002', monto: 500000, divisa: 'ARS' });
  check('con 60 reservados, 500.000 (50 USDT) no entra; dice que alcanza para 400.000',
    p3.creado === false && p3.motivo === 'sin_saldo' && p3.prepago.reservado === 60 && p3.prepago.disponible === 40 && p3.alcanza === 400000, JSON.stringify(p3));

  /* ── 5 · el margen es un % del ÚLTIMO PAGO (monto fijo hasta que vuelva a pagar) ────────────────────────────────────────────────────── */
  clientes.updateComercial(pre.id, { prepago_margen_pct: '20' });
  const p4 = await J('POST', '/pedido', { usuario: 'AgentePre', userId: '80002', monto: 500000, divisa: 'ARS' });
  check('con 20% del último pago (100 → 20 USDT de margen, tope 120) entra', p4.creado === true, JSON.stringify(p4.motivo || ''));
  const p5 = await J('POST', '/pedido', { usuario: 'AgentePre', userId: '80002', monto: 200000, divisa: 'ARS' });
  check('y ya no entra más: 110 reservados, quedan 10 (100.000 en fichas)', p5.creado === false && p5.alcanza === 100000, JSON.stringify(p5.prepago));

  /* ── 6 · el lote del distribuidor entra entero o no entra ───────────────────────────────── */
  const antes = pedidos.list({ estado: 'pendiente' }).length;
  const lote = await J('POST', '/pedido-agentes', { usuario: 'DistPre', userId: '80010', divisa: 'ARS', pedidos: [
    { userId: '80002', monto: 50000 }, { userId: '80003', monto: 80000 }] });
  check('lote de 130.000 (13 USDT) con 10 disponibles: no crea ninguno', lote.motivo === 'sin_saldo' && lote.creados.length === 0
    && pedidos.list({ estado: 'pendiente' }).length === antes, JSON.stringify(lote));
  const lote2 = await J('POST', '/pedido-agentes', { usuario: 'DistPre', userId: '80010', divisa: 'ARS', pedidos: [
    { userId: '80002', monto: 40000 }, { userId: '80003', monto: 50000 }] });
  check('lote de 90.000 (9 USDT): entra entero', lote2.creados && lote2.creados.length === 2, JSON.stringify(lote2.motivo || ''));

  /* ── 7 · al cargar, el pendiente deja de reservar y pasa a deuda (el saldo baja igual) ──── */
  const unP = pedidos.list({ estado: 'pendiente' }).find((x) => x.codigo === 'PRE1');
  const estAntes = await prepago.estado(clientes.get(pre.id));
  pedidos.setEstado(unP.id, 'cargado');
  await require('../src/deuda-carga.service').porCarga(pedidos.get(unP.id));
  const estDesp = await prepago.estado(clientes.get(pre.id));
  check('al cargarse, lo reservado pasa a deuda: lo disponible no cambia (el margen no se achica)', Math.abs(estAntes.disponible - estDesp.disponible) < 0.02
    && estDesp.reservado < estAntes.reservado && estDesp.saldoAFavor < estAntes.saldoAFavor, `${JSON.stringify(estAntes)} → ${JSON.stringify(estDesp)}`);

  /* ── 8 · en qué divisas puede pagar ─────────────────────────────────────────────────────── */
  clientes.updateComercial(pre.id, { divisas_pago: ['USDT'] });
  const ev = await J('GET', '/estado-cliente?usuario=AgentePre&userId=80002');
  check('estado-cliente dice que sólo paga en USDT', JSON.stringify(ev.divisasPago) === '["USDT"]', JSON.stringify(ev.divisasPago));
  const pagoArs = await J('POST', '/avisar-pago', { usuario: 'AgentePre', userId: '80002', via: 'ars', monto: '1000', divisa: 'ARS',
    archivo: { nombre: 'c.png', tipo: 'image/png', base64: 'iVBORw0KGgo=' } });
  check('un pago en pesos se rechaza (divisa_no_habilitada)', pagoArs.creado === false && pagoArs.motivo === 'divisa_no_habilitada', JSON.stringify(pagoArs));
  const evPost = await J('GET', '/estado-cliente?usuario=AgentePost&userId=80001');
  check('a un cliente sin elegir se le ofrecen las dos', JSON.stringify(evPost.divisasPago) === '["ARS","USDT"]' && evPost.prepago.prepago === false);

  /* ── 9 · los campos nuevos sobreviven al DELETE+INSERT del store ────────────────────────── */
  clientes.updateComercial(post.id, { nombre: 'POST1 renombrado' });
  pre = clientes.get(pre.id);
  check('guardar OTRO cliente no le borra el prepago, el margen ni las divisas',
    pre.prepago === true && pre.prepago_margen_pct === '20' && JSON.stringify(pre.divisas_pago) === '["USDT"]', JSON.stringify({ p: pre.prepago, m: pre.prepago_margen_pct, d: pre.divisas_pago }));
  clientes.updateComercial(pre.id, { prepago: false });
  const pFin = await J('POST', '/pedido', { usuario: 'AgentePre', userId: '80002', monto: 9000000, divisa: 'ARS' });
  check('apagado el prepago, vuelve a pedir como siempre', pFin.creado === true);

  srv.close();
  const fallan = v.filter((x) => !x.ok).length;
  console.log(`\n${v.length - fallan}/${v.length} verificaciones pasaron`);
  process.exit(fallan ? 1 : 0);
})().catch((e) => { console.error('SE ROMPIÓ:', e); process.exit(1); });
