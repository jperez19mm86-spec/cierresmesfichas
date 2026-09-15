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

  srv.close();
  const fallan = v.filter((x) => !x.ok).length;
  console.log(`\n${v.length - fallan}/${v.length} verificaciones pasaron`);
  if (fallan) process.exit(1);
})();
