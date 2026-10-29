/**
 * clientes-cajas-frenos.js — AGREGAR UNA CAJA DESDE EL CASINO, Y LO QUE NO SE PUEDE HACER (29-oct-2026).
 *
 * «➕ Agregar una caja» de la ficha busca la cuenta por login y el servidor trae sus divisas: nadie
 * las tipea. La auditoría de ese día encontró tres agujeros que esto controla:
 *   · ofrecer conexiones que leen el MISMO casino con otro nombre creaba la misma cuenta dos veces;
 *   · «Aplicar» el saldo anterior de un cliente cuyo movimiento ya no existe lo cobraba dos veces;
 *   · borrar un cliente con historia (o un vendedor con gente) se llevaba todo sin preguntar.
 */
process.env.DB_PATH = require('path').join(__dirname, '..', 'data', 'test-cajas-frenos.sqlite');
['', '-wal', '-shm'].forEach((x) => { try { require('fs').unlinkSync(process.env.DB_PATH + x); } catch (e) {} });
// Sin casino de verdad: el árbol no se resuelve y las divisas las contesta uno de mentira.
require.cache[require.resolve('../src/arbol.service')] = { exports: { resolverEnSegundoPlano: () => {} } };

const express = require('express');
const clientes = require('../src/clientes-store');
const paneles = require('../src/paneles-store');
const movs = require('../src/movimientos-store');
const conex = require('../src/casino-conexiones-store');
const cascada = require('../src/clientes-cascada');
conex.client = () => ({ divisasDeNodo: async (n) => (String(n) === '999'
  ? { ok: false, error: 'no existe' } : { ok: true, divisas: ['ARS', 'USD'] }) });

let ok = 0, fail = 0;
const check = (t, c, x) => { if (c) { ok++; console.log('✅ ' + t); } else { fail++; console.log('❌ ' + t + (x !== undefined ? '  → ' + x : '')); } };

(async () => {
  console.log('\n🗂 agregar caja desde el casino, y los frenos\n');
  const app = express(); app.use(express.json());
  require('../src/rutas/clientes.routes').mount(app);
  const srv = app.listen(0); const B = 'http://127.0.0.1:' + srv.address().port;
  const post = async (u, b) => { const r = await fetch(B + u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b || {}) }); return r.json(); };
  const del = async (u) => (await fetch(B + u, { method: 'DELETE' })).json();

  const europa = conex.create({ nombre: 'Europa', url: 'http://x', motor: '463' });
  conex.create({ nombre: 'Europa_Token', url: 'http://x', motor: '463' });   // el mismo casino, otro nombre
  const A = clientes.createCliente({ codigo: 'CA', nombre: 'Cliente A' });
  const V = clientes.createCliente({ codigo: 'CV', nombre: 'Vendedor V' });
  paneles.create({ cliente_id: V.id, nombre: 'Base-SA', sistema: 'Europa', id_usuario: '100', conexion_id: europa.id, divisas: ['ARS'] });

  // ── Agregar una caja ──────────────────────────────────────────────────────────────────────────
  let r = await post(`/api/os/clientes/${A.id}/cajas-del-casino`, { sistema: 'Europa', nodo: '200', login: 'Nueva-SA' });
  check('agrega la caja con las divisas que trae el casino', r.ok && r.divisas.join(',') === 'ARS,USD', JSON.stringify(r));
  check('y nace también su caja de Mi Caja', (clientes.get(A.id).cajas || []).some((k) => String(k.userId) === '200'));
  r = await post(`/api/os/clientes/${A.id}/cajas-del-casino`, { sistema: 'Europa', nodo: '100', login: 'Base-SA' });
  check('no deja agregar una cuenta que ya es caja de otro, y dice de quién', !r.ok && /Vendedor V/.test(r.error), r.error);
  r = await post(`/api/os/clientes/${A.id}/cajas-del-casino`, { sistema: 'Europa_Token', nodo: '100', login: 'Base-SA', igual: true });
  check('no acepta un casino sin cajas (la misma cuenta con otro nombre)', !r.ok && /no es un casino de cajas/.test(r.error), r.error);
  r = await post(`/api/os/clientes/${A.id}/cajas-del-casino`, { sistema: 'Europa', nodo: '999', login: 'Fantasma' });
  check('si el casino no confirma la cuenta, pide decidir', !r.ok && r.requiereForzar === true, JSON.stringify(r));
  r = await post(`/api/os/clientes/${A.id}/cajas-del-casino`, { sistema: 'Europa', nodo: 'abc' });
  check('el número tiene que ser un número', !r.ok);

  // ── Saldo anterior ────────────────────────────────────────────────────────────────────────────
  const m = movs.create({ cliente_id: A.id, tipo: 'ajuste', monto_usdt: '100', divisa: 'USDT', notas: 'deuda vieja' });
  clientes.updateComercial(A.id, { saldo_inicial: '100', saldo_inicial_divisa: 'USDT', saldo_inicial_mov_id: m.id });
  r = await post(`/api/os/clientes/${A.id}/saldo-inicial`, { monto: '100', divisa: 'USDT' });
  check('aplicar el mismo saldo anterior otra vez no toca nada', r.ok && r.yaEstaba && movs.list({ cliente_id: A.id }).length === 1, JSON.stringify(r));
  clientes.updateComercial(A.id, { saldo_inicial_mov_id: 'mov_que_no_existe' });
  r = await post(`/api/os/clientes/${A.id}/saldo-inicial`, { monto: '100', divisa: 'USDT' });
  check('si su movimiento ya no existe, no lo cobra dos veces', !r.ok && movs.list({ cliente_id: A.id }).length === 1, JSON.stringify(r));

  // ── Borrar ────────────────────────────────────────────────────────────────────────────────────
  clientes.updateComercial(A.id, { vendedor_id: V.id });
  r = await del(`/api/os/clientes/${V.id}`);
  check('no borra un vendedor con gente colgando', !r.ok && /depend/.test(r.error) && !!clientes.get(V.id), r.error);
  r = await del(`/api/os/clientes/${A.id}`);
  check('no borra un cliente con movimientos', !r.ok && /movimiento/.test(r.error) && !!clientes.get(A.id), r.error);
  const Z = cascada.crear({ codigo: 'CZ', nombre: 'Cargado por error' });
  r = await del(`/api/os/clientes/${Z.id}`);
  check('uno cargado por error, sin nada, sí se borra', r.ok && !clientes.get(Z.id), JSON.stringify(r));

  // ── Dar de baja (fase 4.3) ────────────────────────────────────────────────────────────────────
  const bloqueo = require('../src/bloqueo-pedir');
  const deudaAntes = JSON.stringify(require('../src/deuda.service').cuentaCorriente(A.id));
  r = await post(`/api/os/clientes/${A.id}/baja`, {});
  check('la baja pide el motivo', !r.ok && /por qué/.test(r.error));
  r = await post(`/api/os/clientes/${A.id}/baja`, { motivo: 'dejó de trabajar' });
  const a2 = clientes.get(A.id);
  check('queda dado de baja con fecha y motivo', r.ok && a2.estado === 'baja' && !!a2.baja_at && a2.baja_motivo === 'dejó de trabajar');
  check('su cuenta no cambia ni un centavo', JSON.stringify(require('../src/deuda.service').cuentaCorriente(A.id)) === deudaAntes);
  check('y no puede pedir fichas', (bloqueo.bloqueo(a2) || {}).motivo === 'baja');
  r = await fetch(B + `/api/os/clientes/${V.id}/comercial`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ estado: 'baja' }) }).then((x) => x.json());
  check('no se da de baja por el selector de estado (sin fecha ni motivo)', !r.ok && clientes.get(V.id).estado !== 'baja');
  r = await post(`/api/os/clientes/${A.id}/reactivar`);
  check('reactivar lo deja pedir otra vez', r.ok && clientes.get(A.id).estado === 'activo' && !bloqueo.bloqueo(clientes.get(A.id)));

  srv.close();
  console.log(`\n${ok} chequeos OK, ${fail} fallaron\n`); process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('ERROR', e.stack); process.exit(1); });
