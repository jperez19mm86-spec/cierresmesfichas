/**
 * tc-comprobante-4pct.js — APROBAR UN COMPROBANTE ES ACEPTAR SU TIPO DE CAMBIO.
 *
 * Regla del dueño (26-oct-2026): se compara contra el cambio de HOY —no contra el del cierre, que
 * puede ser de hace semanas— y hasta 4% está bien. Más arriba hay que aprobarlo a propósito.
 *
 * Y si nadie escribe un cambio, se SELLA el del día. Antes quedaba null para siempre: un pago en
 * USDT sin TC no tenía cara en pesos y al cliente le salía la deuda inflada.
 */
const fs = require('fs'); const os = require('os'); const path = require('path');
process.env.DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tc4-')), 'p.sqlite');
// Sin red: `tcAhora` cae al último snapshot, que es lo que sembramos. Determinista.
process.env.TC_SOURCE_URL = 'http://127.0.0.1:1/nada';

const express = require('express');
const clientes = require('../src/clientes-store');
const comprobantes = require('../src/comprobantes-store');
const movs = require('../src/movimientos-store');
const deuda = require('../src/deuda.service');
const tcStore = require('../src/tc-store');

let ok = 0, fail = 0;
const check = (t, c, extra) => { if (c) { ok++; console.log('✅ ' + t + (extra != null ? '  → ' + extra : '')); }
  else { fail++; console.log('❌ ' + t + (extra != null ? '  → ' + extra : '')); } };

console.log('\n💱 el cambio de un comprobante contra el de hoy\n');
tcStore.addSnapshot({ tc_ars_usdt: '1600', fecha: '2026-10-26', hora: '12:00' });

const app = express();
app.use(express.json());
require('../src/rutas/cuenta.routes').mount(app);

(async () => {
  const srv = app.listen(0); const U = `http://127.0.0.1:${srv.address().port}`;
  const cli = clientes.createCliente({ codigo: 'TC4', nombre: 'TC Cuatro', moneda_cuenta: 'USDT' });
  const nuevo = (divisa) => comprobantes.crear({ codigo: 'TC4', clienteNombre: 'TC Cuatro',
    via: divisa === 'USDT' ? 'usdt' : 'cvu', monto: '100', divisa, notas: 'de prueba' }).comprobante;
  const aprobar = (id, body) => fetch(`${U}/api/os/comprobantes/${id}/resolver`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ estado: 'aprobado', ...body }) })
    .then(async (r) => ({ status: r.status, ...(await r.json()) }));
  const movDe = (r) => movs.list({ cliente_id: cli.id }).find((m) => (m.notas || '').includes(r.id));

  // ── 1 · dentro del 4% pasa ────────────────────────────────────────────────────────────────
  const c1 = nuevo('USDT');
  const r1 = await aprobar(c1.id, { monto: '100', tc: '1630' });   // +1,9%
  check('un cambio 1,9% arriba del de hoy pasa solo', r1.ok === true, 'status ' + r1.status);
  check('y guarda la cara en pesos', movDe(c1) && movDe(c1).monto_ars === '163000', movDe(c1) && movDe(c1).monto_ars);

  // ── 2 · fuera del 4% se frena, con los números ────────────────────────────────────────────
  const c2 = nuevo('USDT');
  const r2 = await aprobar(c2.id, { monto: '100', tc: '1750' });   // +9,4%
  check('un cambio 9,4% arriba se frena', r2.status === 409 && r2.tc_fuera_de_rango === true, 'status ' + r2.status);
  check('y dice los dos números y el tope', r2.tc === '1750' && r2.tc_hoy === '1600' && r2.dif_pct === 9.4 && r2.limite_pct === 4,
    `${r2.tc} vs ${r2.tc_hoy} · ${r2.dif_pct}% · tope ${r2.limite_pct}%`);
  check('frenado NO acredita nada', comprobantes.get(c2.id).estado === 'pendiente' && !movDe(c2));
  check('también frena para el otro lado', (await aprobar(nuevo('USDT').id, { monto: '100', tc: '1400' })).status === 409);

  // ── 3 · se puede aprobar igual, a propósito, y queda escrito ──────────────────────────────
  const r3 = await aprobar(c2.id, { monto: '100', tc: '1750', forzar: true });
  check('con forzar sí entra', r3.ok === true);
  check('y el movimiento deja dicho cuánto se separó', /\+9\.4% vs el de hoy \(1600\), aprobado igual/.test(movDe(c2).notas || ''),
    (movDe(c2).notas || '').slice(-60));

  // ── 4 · sin cambio escrito se sella el de hoy (el bug de Nahuel) ──────────────────────────
  const c4 = nuevo('USDT');
  const antes = deuda.cuentaCorriente(cli.id).total;
  const r4 = await aprobar(c4.id, { monto: '100' });
  check('sin TC escrito, el pago entra igual', r4.ok === true);
  check('y YA NO queda sin cara en pesos', movDe(c4) && movDe(c4).monto_ars === '160000', movDe(c4) && movDe(c4).monto_ars);
  check('el movimiento dice que el TC lo puso el sistema', /TC 1600 del día/.test(movDe(c4).notas || ''));
  check('sellar el TC NO mueve la deuda (sólo llena la cara que se muestra)',
    deuda.cuentaCorriente(cli.id).total === require('../src/lib/money').sub(antes, '100'),
    `${antes} → ${deuda.cuentaCorriente(cli.id).total}`);
  check('y la cuenta en pesos deja de estar incompleta', deuda.cuentaCorriente(cli.id).otra_completa === true);

  // ── 5 · el camino del TC del mes no se toca ───────────────────────────────────────────────
  const c5 = nuevo('ARS');
  const r5 = await aprobar(c5.id, { monto: '150000', moneda: 'ARS', tc_modo: 'mes' });
  check('con tc_modo=mes sigue sin pedir ni sellar cambio', r5.ok === true && movDe(c5).tc_modo === 'mes', r5.error || '');
  check('y guarda sólo los pesos, como antes', movDe(c5).monto_ars === '150000' && movs.getCrudo(movDe(c5).id).monto_usdt == null);

  srv.close();
  console.log(`\n${fail ? '❌' : '✅'}  ${ok} bien, ${fail} mal\n`);
  process.exit(fail ? 1 : 0);
})();
