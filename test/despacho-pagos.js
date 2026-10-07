/**
 * despacho-pagos.js — la operadora acepta pagos en pesos de clientes prepago (8-oct-2026).
 * Se prueba la regla (qué puede y qué no) contra las rutas reales, y que el permiso de la operadora
 * abra SOLO estas rutas.
 */
const fs = require('fs'); const os = require('os'); const path = require('path');
process.env.DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'despacho-pagos-')), 'p.sqlite');

const express = require('express');
const clientes = require('../src/clientes-store');
const comprobantes = require('../src/comprobantes-store');
const movs = require('../src/movimientos-store');
const deudaSvc = require('../src/deuda.service');
const auth = require('../src/auth');
const despacho = require('../src/despacho-pagos');

const v = []; const check = (n, c, d) => { v.push(!!c); console.log((c ? '✅' : '❌') + ' ' + n + (d ? '  → ' + d : '')); };
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const pre = clientes.createCliente({ codigo: 'PREARS', nombreVisible: 'Prepago Pesos', nombre: 'Prepago Pesos' });
clientes.updateComercial(pre.id, { prepago: true, moneda_cuenta: 'ARS' });
const preUsd = clientes.createCliente({ codigo: 'PREUSD', nombreVisible: 'Prepago Dólar', nombre: 'Prepago Dólar' });
clientes.updateComercial(preUsd.id, { prepago: true });                       // cuenta en USDT
const post = clientes.createCliente({ codigo: 'POSTARS', nombreVisible: 'Postpago', nombre: 'Postpago' });
clientes.updateComercial(post.id, { moneda_cuenta: 'ARS' });

const comp = (codigo, via, monto) => comprobantes.crear({ codigo, clienteNombre: codigo, via, monto: String(monto),
  divisa: via === 'usdt' ? 'USDT' : 'ARS', notas: 'Agente: AgentePrueba', archivo: { nombre: 'c.png', tipo: 'image/png', base64: PNG } }).comprobante;

const ok1 = comp('PREARS', 'ars', 150000);
const grande = comp('PREARS', 'ars', 650000);
const enUsdt = comp('PREARS', 'usdt', 100);
const dePost = comp('POSTARS', 'ars', 10000);
const preCtaUsd = comp('PREUSD', 'ars', 10000);
const paraRechazar = comp('PREARS', 'ars', 20000);

(async () => {
  const app = express(); app.use(express.json({ limit: '5mb' }));
  const avisos = []; app.set('avisarComprobante', async (c, cli, monto, mon) => { avisos.push({ id: c.id, monto, mon, por: c.resuelto_por }); });
  // Igual que index.js: auth.quienEs devuelve { rol, usuario } y se guarda el NOMBRE.
  const quienEsReal = () => ({ rol: 'operador', usuario: 'Sophi' });
  despacho.mount(app, { quienEs: (req) => (quienEsReal(req) || {}).usuario });
  const srv = app.listen(0); const U = `http://127.0.0.1:${srv.address().port}/api/despacho/pagos-prepago`;
  const J = (m, p, b) => fetch(U + p, { method: m, headers: { 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined }).then(async (r) => ({ st: r.status, j: await r.json().catch(() => ({})) }));

  /* ── la lista: sólo lo que puede resolver ───────────────────────────────────────────────── */
  const l = await J('GET', '');
  const ids = (l.j.pagos || []).map((p) => p.id);
  check('la lista trae sólo pesos de prepago con cuenta en pesos', ids.includes(ok1.id) && ids.includes(grande.id) && ids.includes(paraRechazar.id)
    && !ids.includes(enUsdt.id) && !ids.includes(dePost.id) && !ids.includes(preCtaUsd.id), JSON.stringify(ids));
  check('marca el que pasa el tope, y dice quién lo subió', (l.j.pagos.find((p) => p.id === grande.id) || {}).superaTope === true
    && (l.j.pagos.find((p) => p.id === ok1.id) || {}).agente === 'AgentePrueba');
  check('no trae deudas ni saldos de nadie', !JSON.stringify(l.j).match(/deuda|saldo|precio|base_pct/i));
  const foto = await fetch(U + '/' + ok1.id + '/archivo');
  check('puede ver la foto de uno suyo', foto.status === 200 && /image\/png/.test(foto.headers.get('content-type') || ''));
  check('pero no la de un pago en USDT', (await fetch(U + '/' + enUsdt.id + '/archivo')).status === 403);

  /* ── aprobar ────────────────────────────────────────────────────────────────────────────── */
  check('sin confirmar que lo vio entrar, no aprueba', (await J('POST', '/' + ok1.id + '/aprobar', { monto: '150000' })).st === 400);
  check('un monto de más del tope no se aprueba (403)', (await J('POST', '/' + grande.id + '/aprobar', { monto: '650000', vioEntrar: true })).st === 403);
  check('tampoco bajando el monto a mano un comprobante grande… si lo que entró pasa el tope', (await J('POST', '/' + ok1.id + '/aprobar', { monto: '500001', vioEntrar: true })).st === 403);
  check('un pago en USDT: 403', (await J('POST', '/' + enUsdt.id + '/aprobar', { monto: '100', vioEntrar: true })).st === 403);
  check('un pago de un cliente postpago: 403', (await J('POST', '/' + dePost.id + '/aprobar', { monto: '10000', vioEntrar: true })).st === 403);
  check('un prepago con la cuenta en dólares: 403 (lleva tipo de cambio)', (await J('POST', '/' + preCtaUsd.id + '/aprobar', { monto: '10000', vioEntrar: true })).st === 403);
  const a = await J('POST', '/' + ok1.id + '/aprobar', { monto: '149.500', vioEntrar: true });
  check('aprueba lo que ENTRÓ (149.500, no lo declarado)', a.st === 200 && a.j.ok && a.j.monto === 149500, JSON.stringify(a.j));
  const cc = deudaSvc.cuentaCorriente(pre.id);
  check('queda como pago en pesos en su cuenta: saldo a favor ARS 149.500', Number(cc.total) === -149500, JSON.stringify({ total: cc.total, moneda: cc.moneda }));
  const cmp = comprobantes.get(ok1.id);
  check('el comprobante queda aprobado POR Sophi, con su movimiento', cmp.estado === 'aprobado' && cmp.resuelto_por === 'Sophi' && !!cmp.movimiento_id);
  const mv = movs.list({ cliente_id: pre.id, tipo: 'pago' })[0];
  check('el movimiento dice quién lo aprobó', /aprobado por Sophi/.test(mv.notas || ''), mv.notas);
  await new Promise((r) => setTimeout(r, 50));
  check('avisa al grupo de cobranzas con el monto que entró', avisos.some((x) => x.id === ok1.id && x.monto === '149500' && x.mon === 'ARS'), JSON.stringify(avisos));
  check('aprobarlo dos veces no suma dos pagos (409)', (await J('POST', '/' + ok1.id + '/aprobar', { monto: '149500', vioEntrar: true })).st === 409
    && movs.list({ cliente_id: pre.id, tipo: 'pago' }).length === 1);

  /* ── rechazar ───────────────────────────────────────────────────────────────────────────── */
  check('rechazar sin motivo: 400', (await J('POST', '/' + paraRechazar.id + '/rechazar', {})).st === 400);
  const rj = await J('POST', '/' + paraRechazar.id + '/rechazar', { motivo: 'no entró nada' });
  check('rechaza con motivo, queda rechazado por Sophi y no toca la cuenta', rj.st === 200 && comprobantes.get(paraRechazar.id).estado === 'rechazado'
    && comprobantes.get(paraRechazar.id).resuelto_por === 'Sophi' && Number(deudaSvc.cuentaCorriente(pre.id).total) === -149500);
  check('no puede rechazar uno en USDT', (await J('POST', '/' + enUsdt.id + '/rechazar', { motivo: 'x' })).st === 403);

  /* ── el permiso de la operadora abre SÓLO estas rutas ───────────────────────────────────── */
  const puede = (method, p) => auth.puedeOperador({ method, path: p });
  const idx = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8');
  check('index.js le pasa el NOMBRE (no el objeto { rol, usuario }) — si no, queda «[object Object]»',
    /despacho-pagos'\)\.mount\(app, \{ quienEs: \(req\) => \(auth\.quienEs\(req\) \|\| \{\}\)\.usuario \}\)/.test(idx));
  check('la operadora puede listar, ver la foto, aprobar y rechazar',
    puede('GET', '/api/despacho/pagos-prepago') && puede('GET', '/api/despacho/pagos-prepago/cmp_x/archivo')
    && puede('POST', '/api/despacho/pagos-prepago/cmp_x/aprobar') && puede('POST', '/api/despacho/pagos-prepago/cmp_x/rechazar'));
  check('y sigue sin poder aprobar en el OS ni ver comprobantes ni deudas',
    !puede('POST', '/api/os/comprobantes/cmp_x/resolver') && !puede('GET', '/api/os/comprobantes') && !puede('GET', '/api/os/clientes/c_x/prepago')
    && !puede('GET', '/api/os/comprobantes/cmp_x/archivo') && !puede('POST', '/api/despacho/pagos-prepago/cmp_x/borrar'));

  srv.close();
  const f = v.filter((x) => !x).length;
  console.log(`\n${v.length - f}/${v.length} verificaciones pasaron`);
  process.exit(f ? 1 : 0);
})().catch((e) => { console.error('SE ROMPIÓ:', e); process.exit(1); });
