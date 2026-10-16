/**
 * pases.js — 🔀 Pases: de un sitio a otro sin re-login, con cambio de caja.
 *
 * El casino de mentira contesta como el real (medido el 15-oct-2026): `terminalInfo` con la sesión
 * devuelve el jugador en cualquiera de los dos sitios, `search` da el padre en `create`, y el
 * «Cambiar senior» mueve. Se prueba lo que tiene que pasar y lo que NO: un código no se canjea
 * dos veces ni en otro sitio, un jugador de otra caja no se pasa, una sesión falsa no entra.
 */
const assert = require('assert');
process.env.DB_PATH = require('path').join(require('os').tmpdir(), 'test-pases-' + Date.now() + '.sqlite');
const pases = require('../src/pases.service');

let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; console.log('  ✓', m); };

const SESIONES = { aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa: { id: '501', login: 'juan501' }, bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb: { id: '777', login: 'otro777' } };
const nodos = new Map([
  ['10', { id: '10', login: 'CajaF01Zeus', padre: '1', group: '4' }],
  ['20', { id: '20', login: 'ZeusChat02', padre: '1', group: '4' }],
  ['30', { id: '30', login: 'OtraCaja', padre: '1', group: '4' }],
  ['501', { id: '501', login: 'juan501', padre: '10', group: '5' }],
  ['777', { id: '777', login: 'otro777', padre: '30', group: '5' }],
]);
let movidas = 0;
const cli = {
  async apiCall(area, body = {}, q = {}) {
    if (area === 'search') {
      const s = String(body.search_login).toLowerCase();
      return { ok: true, data: { users: [...nodos.values()].filter((u) => u.login.toLowerCase() === s || u.id === s).map((u) => ({ id: u.id, login: u.login, group: u.group, create: u.padre })) } };
    }
    if (area === 'usersettings') { movidas++; nodos.get(q.id).padre = [...nodos.values()].find((u) => u.login === body['setting[value]']).id; return { ok: true, data: {} }; }
    if (area === 'breadcrumbs') { const out = []; let x = nodos.get(q.id); while (x) { out.unshift({ id: x.id, name: x.login }); x = nodos.get(x.padre); } return { ok: true, data: { userTree: out } }; }
    throw new Error('área ' + area);
  },
};
const sitiosVistos = [];
const fetchFalso = async (url, op) => {
  sitiosVistos.push(new URL(url).hostname);
  const j = JSON.parse(op.body); const s = SESIONES[j.token];
  return { json: async () => (s ? { status: 'success', content: s } : { status: 'fail', error: 'Autorización fallida' }) };
};
const deps = { fetch: fetchFalso, clienteDe: () => cli };

(async () => {
  console.log('\n🔀 pases\n');
  await assert.rejects(pases.crear({ sitio_viejo: 'a.com', sitio_nuevo: 'a.com', caja_origen: 'x' }, deps), /el mismo/);
  await assert.rejects(pases.crear({ sitio_viejo: 'a.com', sitio_nuevo: 'b.com' }, deps), /caja de origen/);
  await assert.rejects(pases.crear({ sitio_viejo: 'ganamosclub', sitio_nuevo: 'b.com', caja_origen: 'CajaF01Zeus' }, deps), /no es un link completo/);
  ok(true, 'no acepta un link sin el final (.org) — pasó el 16-oct con «ganamosclub»');
  const otroCasino = { id: 'cx2', nombre: 'Europa_Fichas' };
  const vacio = { async apiCall() { return { ok: true, data: { users: [] } }; } };
  await assert.rejects(pases.crear({ sitio_viejo: 'a.com', sitio_nuevo: 'b.com', conexion_id: 'cxMal', caja_origen: 'CajaF01Zeus', caja_destino: 'ZeusChat02' },
    { clienteDe: (id) => (id === 'cxMal' ? vacio : cli), conexiones: [{ id: 'cxMal', nombre: 'Casino_Fichas' }, otroCasino] }), /está en «Europa_Fichas»/);
  ok(true, 'con el casino equivocado no guarda, y dice en cuál está la caja');
  ok(true, 'no deja cargar un pase sin caja de origen ni con el mismo link a los dos lados');

  const p = await pases.crear({ sitio_viejo: 'https://www.GanamosChat.com/', sitio_nuevo: 'ganamoschatt.com', conexion_id: 'cx', caja_origen: 'CajaF01Zeus', caja_destino: 'ZeusChat02' }, deps);
  ok(p.sitio_viejo === 'ganamoschat.com', 'el link se guarda limpio (sin https, www ni barra)');

  let r = await pases.emitir({ origin: 'https://ganamoschat.com', token: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }, deps);
  ok(/^https:\/\/ganamoschatt\.com\/\?cw_pase=[a-f0-9]{48}$/.test(r.ir || ''), 'un jugador de la caja de origen recibe el link al sitio nuevo con un código');
  ok(!String(r.ir).includes('aaaaaaaa'), 'la sesión NO va en el link');
  ok(sitiosVistos[0] === 'ganamoschat.com', 'la sesión se valida contra el sitio de donde viene');
  ok(sitiosVistos.includes('ganamoschatt.com'), 'y se comprueba que sirva en el sitio nuevo antes de mandarlo');
  ok(nodos.get('501').padre === '20' && movidas === 1, 'y lo pasó a la caja de destino');

  const cod = new URL(r.ir).searchParams.get('cw_pase');
  ok(pases.canjear({ origin: 'https://otro-sitio.com', codigo: cod }) === null, 'el código no se canjea en otro sitio');
  const t = pases.canjear({ origin: 'https://ganamoschatt.com', codigo: cod });
  ok(t && t.token === 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'en el sitio nuevo el código devuelve la sesión');
  ok(pases.canjear({ origin: 'https://ganamoschatt.com', codigo: cod }) === null, 'y no se puede usar dos veces');

  r = await pases.emitir({ origin: 'https://ganamoschat.com', token: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }, deps);
  ok(r.ir && movidas === 1, 'si toca el link otra vez (ya en la caja nueva) pasa igual y no lo mueve de nuevo');

  r = await pases.emitir({ origin: 'https://ganamoschat.com', token: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' }, deps);
  ok(r.motivo === 'fuera' && nodos.get('777').padre === '30', 'un jugador de otra caja no se pasa ni se mueve');
  r = await pases.emitir({ origin: 'https://ganamoschat.com', token: 'cccccccccccccccccccccccccccccccc' }, deps);
  ok(r.motivo === 'sin_sesion', 'una sesión que el casino no reconoce no entra');
  r = await pases.emitir({ origin: 'https://ganamoschat.com', token: '<script>' }, deps);
  ok(r.motivo === 'sin_sesion', 'algo que no parece una sesión ni se le pregunta al casino');
  r = await pases.emitir({ origin: 'https://sitio-sin-pase.com', token: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }, deps);
  ok(r.motivo === 'sin_regla', 'desde un sitio sin pase no pasa nada');

  const l = pases.list()[0];
  ok(l.cuenta.pasado === 1 && l.cuenta.ya_pasado === 1 && l.cuenta.fuera === 1 && l.cuenta.sin_sesion === 2, 'la pantalla cuenta pasados, repetidos, de otra caja y sin sesión');
  ok(pases.sitios().join() === 'ganamoschat.com,ganamoschatt.com', 'y sabe en qué sitios tiene que estar pegado el script');
  await pases.editar(p.id, { activo: false }); ok(pases.sitios().length === 2, 'un pase apagado sigue en la lista de sitios (el script ahí no hace nada)'); await pases.editar(p.id, { activo: true });

  await pases.editar(p.id, { activo: false });
  r = await pases.emitir({ origin: 'https://ganamoschat.com', token: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }, deps);
  ok(r.motivo === 'sin_regla', 'un pase apagado no pasa a nadie');

  // vencimiento
  await pases.editar(p.id, { activo: true });
  r = await pases.emitir({ origin: 'https://ganamoschat.com', token: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }, deps);
  const c2 = new URL(r.ir).searchParams.get('cw_pase');
  pases._codigos.get(c2).exp = Date.now() - 1;
  ok(pases.canjear({ origin: 'https://ganamoschatt.com', codigo: c2 }) === null, 'un código vencido no sirve');

  // ── el botón adentro del casino (Zeus, 16-oct) ───────────────────────────────
  let c = await pases.consultar({ origin: 'https://ganamoschat.com', token: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }, deps);
  ok(c.mostrar === false, 'sin el botón prendido en el pase, la franja no aparece');
  await pases.editar(p.id, { boton: true });
  ok(pases.get(p.id).boton === true, 'el botón se prende por pase');
  const antes = sitiosVistos.length;
  c = await pases.consultar({ origin: 'https://ganamoschat.com', token: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }, deps);
  ok(c.mostrar === true, 'a un jugador del pase le aparece');
  c = await pases.consultar({ origin: 'https://ganamoschat.com', token: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }, deps);
  ok(c.mostrar === true && sitiosVistos.length === antes + 1, 'la segunda vez no se le pregunta al casino (guardado 10 min)');
  c = await pases.consultar({ origin: 'https://ganamoschat.com', token: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' }, deps);
  ok(c.mostrar === false, 'a uno de otra caja no le aparece');
  c = await pases.consultar({ origin: 'https://otro.com', token: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }, deps);
  ok(c.mostrar === false, 'en un sitio sin pase con botón ni se pregunta');
  await pases.editar(p.id, { caja_origen: 'CajaF01Zeus' }, deps);
  ok(pases.get(p.id).boton === true, 'editar otra cosa no apaga el botón');

  // ── «para todos» (Zeus, 16-oct): también los de otra caja, sin moverlos ─────────
  c = await pases.consultar({ origin: 'https://ganamoschat.com', token: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' }, deps);
  ok(c.mostrar === false, 'sin «todos», a uno de otra caja no le aparece');
  await pases.editar(p.id, { todos: true });
  ok(pases.get(p.id).todos === true && pases.get(p.id).boton === true, '«todos» se prende sin apagar el botón');
  c = await pases.consultar({ origin: 'https://ganamoschat.com', token: 'cccccccccccccccccccccccccccccccc' }, deps);
  ok(c.mostrar === false, 'con «todos», a una sesión que el casino no reconoce igual no le aparece');
  r = await pases.emitir({ origin: 'https://ganamoschat.com', token: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' }, deps);
  ok(/cw_pase=/.test(r.ir || '') && nodos.get('777').padre === '30', 'con «todos», el de otra caja se pasa de sitio y NO se le cambia la caja');
  ok(/cuelga de OtraCaja/.test(pases.eventos(p.id)[0].detalle), 'y en «Ver quiénes» dice de qué caja era');
  await pases.editar(p.id, { todos: false });

  // la franja en el navegador (jsdom si está a mano)
  let JSDOM = null; try { ({ JSDOM } = require(process.env.JSDOM_DIR || 'jsdom')); } catch (e) {}
  if (JSDOM) {
    const fs = require('fs'); const src = fs.readFileSync(require('path').join(__dirname, '..', 'public', 'pase.js'), 'utf8');
    const dom = new JSDOM('<body></body>', { url: 'https://casinozeuschat.com/', runScripts: 'outside-only' });
    const w = dom.window; const llamadas = [];
    w.localStorage.setItem('ig_token', 'a'.repeat(32));
    w.fetch = async (url, op) => { llamadas.push(url.split('/api/')[1]); return { json: async () => (url.includes('consultar') ? { ok: true, mostrar: true } : { ok: true, ir: 'https://casinozeuschat.net/?cw_pase=x' }) }; };
    let fueA = null;
    // casino adentro de otra página: jsdom no deja cambiar window.top, se le pone otro nombre en la copia
    w.__TOP = { location: { set href(v) { fueA = v; } } };
    w.eval(src.replace(/window\.top/g, 'window.__TOP'));
    await new Promise((r) => setTimeout(r, 50));
    const f = w.document.getElementById('lg-pase-franja');
    ok(f && /Nos actualizamos/.test(f.textContent) && /Probá ahora/.test(f.textContent), 'la franja dice «Nos actualizamos» y «Probá ahora»');
    f.querySelector('[data-ir]').click();
    await new Promise((r) => setTimeout(r, 50));
    ok(llamadas.join() === 'pase/consultar,pase/emitir' && fueA === 'https://casinozeuschat.net/?cw_pase=x', 'al tocarla pide el pase y cambia la página de ARRIBA (sale del chat viejo)');
  } else console.log('  (sin jsdom: se saltea la prueba de la franja en el navegador)');

  console.log(`\n${n} chequeos OK\n`);
})().catch((e) => { console.error('❌', e); process.exit(1); });
