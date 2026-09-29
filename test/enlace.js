/**
 * enlace.js — el puente Mi Caja → OS (en main, sin depender del alta automática).
 *
 * Mismo módulo `src/enlace.routes.js` que corre en producción. Se prueban las dos cosas que
 * importan: la REGLA de «configurado» (existe + % vigente + grupo de Telegram) y el TOKEN de
 * servicio (sin token → 503, token malo → 401, token bueno → pasa), más pedido y mi-cuenta.
 */
const fs = require('fs'); const os = require('os'); const path = require('path');
process.env.DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'enlace-')), 'p.sqlite');
process.env.ENLACE_TOKEN = 'token-de-prueba-largo-1234567890';

const express = require('express');
const clientes = require('../src/clientes-store');
const participaciones = require('../src/participaciones-store');
const personas = require('../src/personas-store');
const deudaSvc = require('../src/deuda.service');
const enlace = require('../src/enlace.routes');

const v = []; const check = (n, c, d) => { v.push({ ok: !!c }); console.log((c ? '✅' : '❌') + ' ' + n + (d ? '  → ' + d : '')); };

// Un cliente con su caja del casino, todavía SIN % y SIN Telegram.
const cli = clientes.createCliente({ codigo: 'ENL1', nombreVisible: 'Enlace Uno', nombre: 'Enlace Uno' });
clientes.addCaja(cli.id, { usuario: 'GanamosPrueba', sistema: 'europa', userId: '90210', divisas: ['ARS'] });
/* Esta caja es un agente de ANTES de los permisos por agente: el deploy los congela con lo que podían
   hacer (todo). Se simula acá, y de paso se prueba que correrlo dos veces no toca nada. */
const congeladas = clientes.congelarPermisosActuales();
check('congelar permisos: la caja vieja queda con todo, y una segunda pasada no toca nada',
  congeladas >= 1 && clientes.congelarPermisosActuales() === 0);

/* ── 1 · encontrar al cliente y la regla de configurado ──────────────────────────────────────── */
check('lo encuentra por el nodo del casino (userId), sin depender del nombre',
  enlace.encontrarCliente({ userId: '90210', sistema: 'europa' }).cliente?.codigo === 'ENL1');
check('y por el usuario del casino, sin distinguir mayúsculas',
  enlace.encontrarCliente({ usuario: 'ganamosprueba' }).cliente?.codigo === 'ENL1');

let est = enlace.estadoDe({ usuario: 'GanamosPrueba' });
check('recién creado: existe pero NO está configurado (falta % y Telegram)',
  est.existe && !est.configurado && est.motivosFaltantes.includes('sin_porcentaje') && est.motivosFaltantes.includes('sin_telegram'));

// El % vigente (un participante al 100 basta para que haya reparto).
const per = personas.create({ nombre: 'EmpresaTest' });
participaciones.setReparto(cli.id, null, [{ persona_id: per.id, porcentaje: 100 }], '2026-09-01');
est = enlace.estadoDe({ usuario: 'GanamosPrueba' });
check('con % pero sin Telegram: sigue sin configurar, sólo falta el Telegram',
  est.existe && !est.configurado && est.tienePorcentaje && !est.tieneTelegram
  && est.motivosFaltantes.length === 1 && est.motivosFaltantes[0] === 'sin_telegram');

clientes.setTelegram(cli.id, { chatId: '-1009999', enabled: true });
est = enlace.estadoDe({ usuario: 'GanamosPrueba' });
check('con % y Telegram: queda CONFIGURADO', est.existe && est.configurado && est.motivosFaltantes.length === 0);

check('un usuario sin cliente: no existe',
  !enlace.estadoDe({ usuario: 'Fantasma' }).existe);

/* ── 2 · el token y las rutas (HTTP) ─────────────────────────────────────────────────────────── */
(async () => {
  const app = express(); app.use(express.json()); enlace.mount(app);
  const srv = app.listen(0); const port = srv.address().port;
  const U = `http://127.0.0.1:${port}/api/enlace/v1`;
  const tok = { authorization: 'Bearer ' + process.env.ENLACE_TOKEN };

  check('sin token: 401', (await fetch(`${U}/estado-cliente?usuario=GanamosPrueba`).then((r) => r.status)) === 401);
  check('con token correcto: 200', (await fetch(`${U}/estado-cliente?usuario=GanamosPrueba`, { headers: tok }).then((r) => r.status)) === 200);
  const guardado = process.env.ENLACE_TOKEN; delete process.env.ENLACE_TOKEN;
  check('sin ENLACE_TOKEN en el server: 503 (apagado, no abierto)', (await fetch(`${U}/estado-cliente?usuario=GanamosPrueba`).then((r) => r.status)) === 503);
  process.env.ENLACE_TOKEN = guardado;

  const pedir = (b) => fetch(`${U}/pedido`, { method: 'POST', headers: { 'content-type': 'application/json', ...tok }, body: JSON.stringify(b) }).then((r) => r.json());
  const p1 = await pedir({ usuario: 'GanamosPrueba', monto: 5000, divisa: 'ARS' });
  check('cliente configurado: crea el pedido en la cola del OS', p1.ok && p1.creado === true && p1.pedido && p1.pedido.monto === 5000);
  const p2 = await pedir({ usuario: 'Fantasma', monto: 1000 });
  check('usuario sin cliente: no crea pedido (no_existe)', p2.ok && p2.creado === false && p2.motivo === 'no_existe');

  const cta = await fetch(`${U}/mi-cuenta?usuario=GanamosPrueba`, { headers: tok }).then((r) => r.json());
  check('mi-cuenta: devuelve deuda y moneda, sin contraseña',
    cta.ok && cta.existe === true && typeof cta.deuda !== 'undefined' && Array.isArray(cta.movimientos));
  const cta401 = await fetch(`${U}/mi-cuenta?usuario=GanamosPrueba`).then((r) => r.status);
  check('mi-cuenta sin token: 401', cta401 === 401);

  const av = await fetch(`${U}/aviso-soporte`, { method: 'POST', headers: { 'content-type': 'application/json', ...tok }, body: '{"motivo":"soporte"}' }).then((r) => r.json());
  check('aviso-soporte sin bot: no se cuelga, enviado:false', av.ok === true && av.enviado === false);

  /* ── 3 · registrar un pago (comprobante) ─────────────────────────────────────────────────────── */
  const est2 = await fetch(`${U}/estado-cliente?usuario=GanamosPrueba`, { headers: tok }).then((r) => r.json());
  check('estado: trae los datos para pagar (ars/usdt) y que puede avisar pagos',
    est2.datosPago && typeof est2.datosPago.ars === 'object' && typeof est2.datosPago.usdt === 'object'
    && est2.puedeAvisarPago === true);

  const pagar = (b) => fetch(`${U}/avisar-pago`, { method: 'POST', headers: { 'content-type': 'application/json', ...tok }, body: JSON.stringify(b) });
  const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  const sinArch = await pagar({ usuario: 'GanamosPrueba', via: 'ars', monto: '480000', divisa: 'ARS' });
  check('pago sin comprobante: lo rechaza (obligatorio, 400)', sinArch.status === 400);

  const okPago = await pagar({ usuario: 'GanamosPrueba', via: 'ars', monto: '480000', divisa: 'ARS', archivo: { nombre: 'c.png', tipo: 'image/png', base64: PNG } }).then((r) => r.json());
  check('pago con comprobante: lo crea PENDIENTE, sin tocar la deuda',
    okPago.ok && okPago.creado === true && okPago.comprobante && okPago.comprobante.estado === 'pendiente' && okPago.comprobante.archivo_bytes > 0);

  const ccPost = deudaSvc.cuentaCorriente(cli.id);
  check('la deuda NO se movió por el aviso de pago (se acredita recién al aprobar)',
    ccPost && ccPost.pagos === '0');

  clientes.updateComercial(cli.id, { avisa_pagos: false });
  const noHab = await pagar({ usuario: 'GanamosPrueba', via: 'ars', monto: '1000', divisa: 'ARS', archivo: { nombre: 'c.png', tipo: 'image/png', base64: PNG } }).then((r) => r.json());
  check('cliente con avisar-pagos apagado: no crea (no_habilitado)', noHab.ok && noHab.creado === false && noHab.motivo === 'no_habilitado');
  clientes.updateComercial(cli.id, { avisa_pagos: true });

  const pago401 = await fetch(`${U}/avisar-pago`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).then((r) => r.status);
  check('avisar-pago sin token: 401', pago401 === 401);

  /* ── 3 · permisos POR AGENTE: dos agentes del mismo cliente ─────────────────────────────── */
  // Un agente NUEVO (cuenta creada después del congelado, nadie la configuró): sólo pide fichas.
  const cajaB = clientes.addCaja(cli.id, { usuario: 'AgenteSoloPide', sistema: 'europa', userId: '90211', divisas: ['ARS'] });
  const estB = await fetch(`${U}/estado-cliente?usuario=AgenteSoloPide&userId=90211`, { headers: tok }).then((r) => r.json());
  check('agente nuevo sin configurar: puede pedir, NO pagar, NO ver cuenta',
    estB.configurado && estB.puedePedir === true && estB.puedeAvisarPago === false && estB.puedeVerCuenta === false && estB.permisosConfigurados === false);
  const pedB = await pedir({ usuario: 'AgenteSoloPide', userId: '90211', monto: 5000, divisa: 'ARS' });
  check('agente nuevo: el pedido de fichas SÍ se crea', pedB.ok && pedB.creado === true);
  const pagB = await pagar({ usuario: 'AgenteSoloPide', userId: '90211', via: 'ars', monto: '1000', divisa: 'ARS', archivo: { nombre: 'c.png', tipo: 'image/png', base64: PNG } }).then((r) => r.json());
  check('agente nuevo: registrar un pago lo rechaza el servidor (no_habilitado)', pagB.creado === false && pagB.motivo === 'no_habilitado');
  const ctaB = await fetch(`${U}/mi-cuenta?usuario=AgenteSoloPide&userId=90211`, { headers: tok }).then((r) => r.json());
  check('agente nuevo: mi-cuenta NO devuelve la deuda (habilitado:false)', ctaB.existe === true && ctaB.habilitado === false && ctaB.deuda === undefined);
  // El agente viejo del mismo cliente sigue pudiendo todo.
  const estA = await fetch(`${U}/estado-cliente?usuario=GanamosPrueba&userId=90210`, { headers: tok }).then((r) => r.json());
  check('mismo cliente, el otro agente sigue pudiendo todo', estA.puedePedir && estA.puedeAvisarPago && estA.puedeVerCuenta);

  // Se le habilitan los pagos al agente B: ahora sí, y el comprobante dice quién lo mandó.
  clientes.updateCaja(cli.id, cajaB.id, { permisos: { pedir: true, pagos: true, cuenta: false } });
  const pagB2 = await pagar({ usuario: 'AgenteSoloPide', userId: '90211', via: 'ars', monto: '1000', divisa: 'ARS', notas: 'Monto en pesos (declarado): 1000', archivo: { nombre: 'c.png', tipo: 'image/png', base64: PNG } }).then((r) => r.json());
  const comp = require('../src/comprobantes-store').get(pagB2.comprobante && pagB2.comprobante.id);
  check('con pagos habilitados: crea el comprobante y las notas dicen el agente + lo que escribió',
    pagB2.creado === true && comp && /^Agente: AgenteSoloPide · Monto en pesos/.test(comp.notas || ''));

  // La llave general del cliente manda sobre el permiso del agente.
  clientes.updateComercial(cli.id, { avisa_pagos: false });
  const pagB3 = await pagar({ usuario: 'AgenteSoloPide', userId: '90211', via: 'ars', monto: '1000', divisa: 'ARS', archivo: { nombre: 'c.png', tipo: 'image/png', base64: PNG } }).then((r) => r.json());
  check('«Puede avisar pagos» del cliente apagado: ningún agente paga, aunque lo tenga habilitado', pagB3.creado === false && pagB3.motivo === 'no_habilitado');
  clientes.updateComercial(cli.id, { avisa_pagos: true });

  // Un agente al que se le saca «pedir».
  const cajaA = clientes.get(cli.id).cajas.find((k) => k.usuario === 'GanamosPrueba');
  clientes.updateCaja(cli.id, cajaA.id, { permisos: { pedir: false, pagos: true, cuenta: true } });
  const pedA = await pedir({ usuario: 'GanamosPrueba', userId: '90210', monto: 5000, divisa: 'ARS' });
  check('agente sin «pedir»: el pedido lo rechaza el servidor (no_habilitado)', pedA.creado === false && pedA.motivo === 'no_habilitado');

  // El espejo del panel reescribe usuario/divisas de la caja: los permisos tienen que sobrevivir.
  clientes.updateCaja(cli.id, cajaB.id, { usuario: 'AgenteSoloPide', divisas: ['ARS', 'USD'] });
  const kB = clientes.get(cli.id).cajas.find((k) => k.id === cajaB.id);
  check('los permisos sobreviven a una actualización de la caja (espejo del panel)', kB.permisos && kB.permisos.pagos === true && kB.permisos.cuenta === false);

  /* ── 4 · un DISTRIBUIDOR crea agentes desde Mi Caja ───────────────────────────────────────── */
  const alta = (b) => fetch(`${U}/agente-nuevo`, { method: 'POST', headers: { 'content-type': 'application/json', ...tok }, body: JSON.stringify(b) }).then((r) => r.json());
  // Sin la cuenta del distribuidor cargada en un cliente: no inventa nada.
  const sinCli = await alta({ usuario: 'DistFantasma', userId: '555000', login: 'AgNuevo0', id: '555001' });
  check('distribuidor que no está en ningún cliente: no registra (distribuidor_sin_cliente)', sinCli.registrado === false && sinCli.motivo === 'distribuidor_sin_cliente');
  // Se carga la cuenta del distribuidor en el cliente (identidad, sin panel).
  clientes.addCaja(cli.id, { usuario: 'DistPrueba', sistema: 'europa', userId: '555100', divisas: ['ARS'], rol: 'distribuidor', permisos: { pedir: false, pagos: false, cuenta: false } });
  const nuevo = await alta({ usuario: 'DistPrueba', userId: '555100', login: 'AgDelDist1', id: '555101' });
  const kN = clientes.get(cli.id).cajas.find((k) => k.userId === '555101');
  const pN = require('../src/paneles-store').list({ cliente_id: cli.id }).find((p) => String(p.id_usuario) === '555101');
  check('agente creado por el distribuidor: queda en el cliente, sólo pedir, mismo casino y moneda',
    nuevo.registrado === true && kN && kN.permisos && kN.permisos.pedir === true && kN.permisos.pagos === false && kN.permisos.cuenta === false
    && kN.sistema === 'europa' && kN.divisas.join() === 'ARS');
  check('…y como el distribuidor no factura, el agente nuevo SÍ lleva panel', nuevo.conPanel === true && pN && pN.nivel_usuario === 'Agente');
  const estN = await fetch(`${U}/estado-cliente?usuario=AgDelDist1&userId=555101`, { headers: tok }).then((r) => r.json());
  check('el agente nuevo ya puede pedir fichas (configurado, sólo pedir)', estN.configurado && estN.puedePedir === true && estN.puedeAvisarPago === false && estN.puedeVerCuenta === false);
  const otraVez = await alta({ usuario: 'DistPrueba', userId: '555100', login: 'AgDelDist1', id: '555101' });
  check('llamarlo dos veces no lo duplica', otraVez.yaEstaba === true && clientes.get(cli.id).cajas.filter((k) => k.userId === '555101').length === 1);
  // Si el distribuidor factura como panel, el agente va sólo como cuenta (no se cobra dos veces).
  require('../src/paneles-store').create({ cliente_id: cli.id, nombre: 'DistPrueba', sistema: 'europa', id_usuario: '555100', divisas: ['ARS'] });
  const nuevo2 = await alta({ usuario: 'DistPrueba', userId: '555100', login: 'AgDelDist2', id: '555102' });
  const pN2 = require('../src/paneles-store').list({ cliente_id: cli.id }).find((p) => String(p.id_usuario) === '555102');
  check('distribuidor que ya factura como panel: el agente nuevo va sin panel (no se cobra dos veces)', nuevo2.registrado === true && nuevo2.conPanel === false && !pN2);
  check('datos inválidos: 400', (await fetch(`${U}/agente-nuevo`, { method: 'POST', headers: { 'content-type': 'application/json', ...tok }, body: '{"usuario":"DistPrueba","login":"x","id":"abc"}' }).then((r) => r.status)) === 400);

  srv.close();
  const fallan = v.filter((x) => !x.ok).length;
  console.log(`\n${v.length - fallan}/${v.length} verificaciones pasaron`);
  if (fallan) process.exit(1);
})();
