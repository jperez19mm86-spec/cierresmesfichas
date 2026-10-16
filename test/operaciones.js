/**
 * operaciones.js — 🛠 Operaciones: mover jugadores de caja contra un casino de mentira.
 *
 * El casino de mentira contesta como el real (medido el 14-oct-2026 en admin.admbet888.com):
 * `statisticstable` pagina de a 1000 con `offset`, `breadcrumbs` da la rama, y el guardado de
 * `create_login` contesta «Success». Un jugador está trabado a propósito: el casino dice Success y
 * no lo mueve — tiene que quedar FALLIDO, no hecho.
 */
const assert = require('assert');
process.env.OPERACIONES_PAUSA_MS = '0';            // en la prueba no hace falta cuidar al casino
process.env.OPERACIONES_ESPERA_BLOQUEO_MS = '5';
process.env.DB_PATH = require('path').join(require('os').tmpdir(), 'test-operaciones-' + Date.now() + '.sqlite');
const ops = require('../src/operaciones.service');

let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; console.log('  ✓', m); };

function casinoDeMentira({ jugadores = 2500, trabado = 'j7', conSaldo = 3 } = {}) {
  const nodos = new Map([
    ['1', { id: '1', login: 'SA', padre: null, group: '1', currencies: ['ARS'] }],
    ['10', { id: '10', login: 'CajaOrigen', padre: '1', group: '4', currencies: ['ARS'] }],
    ['20', { id: '20', login: 'CajaDestino', padre: '1', group: '4', currencies: ['ARS'] }],
  ]);
  for (let i = 1; i <= jugadores; i++) {
    nodos.set('j' + i, { id: 'j' + i, login: 'jug' + i, padre: '10', group: '5', saldo: i <= conSaldo ? '1,250.50' : '0.00', online: i === 2 ? 1 : 0 });
  }
  const llamadas = { guardar: 0 };
  const rama = (id) => { const out = []; let x = nodos.get(id); while (x) { out.unshift({ id: x.id, name: x.login }); x = nodos.get(x.padre); } return out; };
  return {
    llamadas, nodos,
    async apiCall(area, body = {}, q = {}) {
      if (area === 'search') {
        const s = String(body.search_login).toLowerCase();
        const us = [...nodos.values()].filter((u) => u.login.toLowerCase() === s || u.id === s)
          .map((u) => ({ id: u.id, login: u.login, group: u.group, create: u.padre }));
        return { ok: true, data: { users: us } };
      }
      if (area === 'breadcrumbs') return { ok: true, data: { userTree: rama(q.id) } };
      if (area === 'users') return { ok: true, data: { currencies: nodos.get(q.id).currencies, users: [] } };
      if (area === 'statisticstable') {
        const hijos = [...nodos.values()].filter((u) => u.padre === q.id);
        const off = Number(q.offset) || 0;
        return { ok: true, data: { total: hijos.length, rows: hijos.slice(off, off + Number(q.limit)).map((u) => ({
          id: u.id, terminal: u.id, login: u.login, balance: u.saldo, is_user_online: u.online, is_deleted_user: '0', full_deleted: '0', open_games: [] })) } };
      }
      if (area === 'usersettings') {
        llamadas.guardar++;
        assert.deepStrictEqual(body['setting[name][]'], ['create_login']);
        const dest = [...nodos.values()].find((u) => u.login === body['setting[value]']);
        if (q.id !== trabado) nodos.get(q.id).padre = dest.id;
        return { ok: true, data: { successMessage: 'Success' } };
      }
      throw new Error('área inesperada ' + area);
    },
  };
}

(async () => {
  console.log('\n🛠  operaciones: mover jugadores de caja\n');
  const cas = casinoDeMentira();
  const conCasino = { clienteDe: () => cas };

  // ── revisar: sólo lee ───────────────────────────────────────────────────────
  let op = await ops.revisar({ tipo: 'mover-jugadores', params: { conexion_id: 'x', origen: 'CajaOrigen', destino: 'cajadestino' }, por: 'Alexa' }, conCasino);
  ok(cas.llamadas.guardar === 0, 'revisar no toca nada');
  ok(op.total === 2500, 'trae los 2.500, pasando de la página de 1000');
  ok(op.contexto.resumen.conSaldo === 3 && op.contexto.resumen.saldoTotal === 3751.5, 'cuenta los que tienen saldo y lee «1,250.50» bien');
  ok(op.contexto.resumen.enLinea === 1, 'cuenta los que están en línea');
  ok(op.estado === 'revisada' && op.por === 'Alexa', 'queda guardada como revisada, con quién la pidió');

  await assert.rejects(ops.revisar({ tipo: 'mover-jugadores', params: { conexion_id: 'x', origen: 'CajaOrigen', destino: 'jug5' } }, conCasino), /es un jugador/);
  ok(true, 'no deja mandar jugadores adentro de otro jugador');
  await assert.rejects(ops.revisar({ tipo: 'mover-jugadores', params: { conexion_id: 'x', origen: 'CajaOrigen', destino: 'NoExiste' } }, conCasino), /no existe/);
  ok(true, 'avisa si la caja de destino no existe');

  // ── piloto: uno y frena ─────────────────────────────────────────────────────
  ops.correr(op.id, { cuantos: 1 }, conCasino); await ops.esperar(op.id);
  op = ops.get(op.id);
  ok(cas.llamadas.guardar === 1 && op.cuenta.hecho === 1, 'el piloto mueve uno solo');
  ok(op.estado === 'esperando', 'y queda esperando que se diga «seguir»');
  ok(cas.nodos.get(op.items.find((i) => i.estado === 'hecho').id).padre === '20', 'el del piloto quedó de verdad en el destino');

  // ── seguir: el resto, con el trabado ────────────────────────────────────────
  ops.correr(op.id, {}, conCasino); await ops.esperar(op.id);
  op = ops.get(op.id);
  ok(op.cuenta.hecho === 2499 && op.cuenta.fallido === 1, 'mueve el resto y deja UNO fallido');
  const tr = op.items.find((i) => i.estado === 'fallido');
  ok(tr.id === 'j7' && /sigue colgando de CajaOrigen/.test(tr.motivo), 'el que el casino dijo «Success» sin mover queda fallido, con el motivo');
  ok(op.estado === 'terminada', 'sin pendientes, termina');

  // ── reintentar sólo lo fallido ──────────────────────────────────────────────
  const antes = cas.llamadas.guardar;
  ops.correr(op.id, { reintentar: true }, conCasino); await ops.esperar(op.id);
  ok(cas.llamadas.guardar - antes === 1, 'reintentar vuelve a probar sólo el fallido');

  // ── «sólo estos» y saltear en línea ─────────────────────────────────────────
  const cas2 = casinoDeMentira({ jugadores: 30 });
  op = await ops.revisar({ tipo: 'mover-jugadores', params: { conexion_id: 'x', origen: 'CajaOrigen', destino: 'CajaDestino',
    solo: 'jug1\njug2, jug3\nnadie', saltearEnLinea: true } }, { clienteDe: () => cas2 });
  ok(op.total === 3, '«sólo estos» se queda con los de la lista');
  ok(op.contexto.resumen.noEstan === 1 && op.contexto.avisos.some((a) => /nadie/.test(a.txt)), 'y avisa los que no cuelgan de la caja');
  ok(op.items.find((i) => i.login === 'jug2').estado === 'salteado', 'el que está en línea queda salteado');

  // ── el casino bloquea por exceso de pedidos: se espera y se reintenta el mismo ──
  const cas4 = casinoDeMentira({ jugadores: 5 });
  let bloqueos = 2;
  const conBloqueo = { clienteDe: () => ({ ...cas4, apiCall: async (area, body, q) => {
    if (area === 'usersettings' && bloqueos > 0) { bloqueos--; return { ok: false, error: '<b>Su solicitud fue bloqueada porque actualizó la página con demasiada frecuencia</b>' }; }
    return cas4.apiCall(area, body, q); } }) };
  op = await ops.revisar({ tipo: 'mover-jugadores', params: { conexion_id: 'x', origen: 'CajaOrigen', destino: 'CajaDestino' } }, conBloqueo);
  ops.correr(op.id, {}, conBloqueo); await ops.esperar(op.id);
  op = ops.get(op.id);
  ok(op.cuenta.hecho === 5 && op.cuenta.fallido === 0, 'si el casino bloquea por exceso de pedidos, espera y reintenta: ninguno queda fallido');

  // ── cancelar ────────────────────────────────────────────────────────────────
  const cas3 = casinoDeMentira({ jugadores: 200 });
  const lento = { clienteDe: () => ({ ...cas3, apiCall: async (...a) => { await new Promise((r) => setTimeout(r, 2)); return cas3.apiCall(...a); } }) };
  op = await ops.revisar({ tipo: 'mover-jugadores', params: { conexion_id: 'x', origen: 'CajaOrigen', destino: 'CajaDestino' } }, lento);
  ops.correr(op.id, {}, lento);
  setTimeout(() => ops.cancelar(op.id), 30);
  await ops.esperar(op.id);
  op = ops.get(op.id);
  ok(op.estado === 'pausada' && op.cuenta.pendiente > 0 && op.cuenta.hecho > 0, 'cancelar frena en el medio y deja los pendientes para seguir');
  assert.throws(() => ops.correr(op.id + 'x', {}, lento), /no existe/);

  console.log(`\n${n} chequeos OK\n`);
})().catch((e) => { console.error('❌', e); process.exit(1); });
