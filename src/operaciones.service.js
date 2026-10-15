/**
 * operaciones.service.js — OPERACIONES EN TANDA CONTRA EL CASINO, desde el OS.
 *
 * Nació de mover 2.748 jugadores de CajaF01Zeus a ZeusChat02 (14-oct-2026): a mano en el panel
 * del casino son 2.748 fichas abiertas; con un script suelto, alguien tiene que tener Node, un
 * token y la consola. Acá es una pantalla.
 *
 * NO es un lugar para pegar código. Es un CATÁLOGO de operaciones escritas de antemano, y todas
 * pasan por los mismos tres pasos:
 *
 *   1. REVISAR  — sólo lee. Arma la lista de lo que se va a tocar y avisa lo raro (saldo, en línea,
 *                 otra divisa, cambia de cliente del OS). Queda guardada como una operación nueva.
 *   2. PILOTO   — hace UNO, lo verifica releyendo el casino y frena.
 *   3. SEGUIR   — hace el resto, de a POCOS a la vez, verificando cada uno. Se puede cancelar.
 *
 * Cada renglón queda con su estado (pendiente / hecho / fallido / salteado) y lo fallido se puede
 * reintentar. NO se confía en la respuesta del guardado —este motor contesta «Success» en casos en
 * que no hizo nada—: se da por hecho solamente lo que se releyó.
 *
 * Si el servidor se reinicia en el medio, la operación queda «interrumpida» con lo que llegó a
 * hacer; seguirla retoma desde los pendientes.
 */
const { db } = require('./db');
const casinoConex = require('./casino-conexiones-store');

db.exec(`CREATE TABLE IF NOT EXISTS operacion (
  id TEXT PRIMARY KEY,
  tipo TEXT,
  titulo TEXT,
  params TEXT,            -- JSON: lo que se pidió
  contexto TEXT,          -- JSON: lo que resolvió la revisión (ids, árboles, avisos)
  items TEXT,             -- JSON: [{ id, login, saldo, online, estado, motivo, at }]
  estado TEXT,            -- revisada | piloto | esperando | corriendo | pausada | terminada | interrumpida
  por TEXT,
  creado TEXT, actualizado TEXT, terminado TEXT
)`);

// Lo que estaba corriendo cuando se apagó el servidor no sigue solo: queda a la vista.
db.prepare(`UPDATE operacion SET estado='interrumpida' WHERE estado IN ('piloto','corriendo')`).run();

const nowISO = () => new Date().toISOString();
const nuevoId = () => 'op_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const num = (v) => Number(String(v ?? '0').replace(/,/g, '')) || 0;   // el motor escribe «7,425.00»
const A_LA_VEZ = Number(process.env.OPERACIONES_A_LA_VEZ) || 3;

// ═══════════════════════════════════════════════════════════════════════════════
// Ayudas contra el motor 463
// ═══════════════════════════════════════════════════════════════════════════════

/** Usuario por login o id exacto → { id, login, padre }. `area=search` pagina de a 10. */
async function buscarUsuario(cli, loginOId) {
  const objetivo = String(loginOId || '').trim().toLowerCase();
  if (!objetivo) return null;
  for (let page = 1; page <= 10; page++) {
    const r = await cli.apiCall('search', { search_login: objetivo, page: String(page) });
    if (!r.ok) throw new Error(r.error || 'el casino no contestó la búsqueda');
    const us = (r.data && r.data.users) || [];
    const x = us.find((u) => String(u.login).toLowerCase() === objetivo || String(u.id) === objetivo);
    if (x) return { id: String(x.id), login: x.login, grupo: String(x.group || ''), padre: String(x.create || '') };
    if (us.length < 10) break;
  }
  return null;
}

/** La rama de un usuario, de la raíz hasta él: [{ id, nombre }]. */
async function arbol(cli, id) {
  const r = await cli.apiCall('breadcrumbs', {}, { safe_content: 'true', module: 'base', id: String(id), pageArea: 'usersettings' });
  if (!r.ok) throw new Error(r.error || 'el casino no devolvió la rama');
  return ((r.data && r.data.userTree) || []).map((n) => ({ id: String(n.id), nombre: n.name }));
}

/** Divisas que lleva un nodo. */
async function divisasDe(cli, id) {
  const r = await cli.apiCall('users', { show_users: '1', provider: 'all', deleted_users: 'undelete', inactive_users: 'all' }, { id: String(id) });
  return (r.ok && Array.isArray(r.data && r.data.currencies)) ? r.data.currencies.map(String) : [];
}

/**
 * TODOS los hijos directos de un nodo. `area=users` devuelve los primeros 1000 e ignora la página;
 * la tabla de la pantalla Usuarios (`statisticstable`) sí pagina por `offset`. Medido 14-oct.
 */
async function hijosDe(cli, id) {
  const m = new Map();
  for (let off = 0; off < 200000; off += 1000) {
    const r = await cli.apiCall('statisticstable', {}, { id: String(id), template: 'users', safe_content: '1',
      without_filters: '1', sort: 'id', order: 'asc', offset: String(off), limit: '1000' });
    if (!r.ok) throw new Error(r.error || 'el casino no devolvió la lista de jugadores');
    const rows = (r.data && r.data.rows) || [];
    rows.forEach((x) => m.set(String(x.id), x));
    if (!rows.length || off + 1000 >= num(r.data.total)) break;
  }
  return [...m.values()];
}

/** El panel del OS más cercano en la rama (el propio nodo o un ancestro) → su cliente. */
function clienteDeRama(rama) {
  const paneles = require('./paneles-store');
  const clientes = require('./clientes-store');
  const porId = new Map(paneles.list().filter((p) => p.id_usuario).map((p) => [String(p.id_usuario), p]));
  for (let i = rama.length - 1; i >= 0; i--) {
    const p = porId.get(rama[i].id);
    if (p && p.cliente_id) {
      const c = clientes.get ? clientes.get(p.cliente_id) : null;
      return { panel: p.nombre || rama[i].nombre, cliente_id: p.cliente_id, cliente: (c && (c.nombre || c.codigo)) || p.cliente_id };
    }
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// EL CATÁLOGO
// ═══════════════════════════════════════════════════════════════════════════════
const CATALOGO = {
  'mover-jugadores': {
    titulo: 'Mover jugadores de caja',
    descripcion: 'Pasa jugadores de una caja a otra del mismo casino (el «Cambiar senior» de la ficha). '
      + 'El saldo viaja con el jugador.',
    campos: [
      { k: 'conexion_id', tipo: 'conexion', label: 'Casino' },
      { k: 'origen', tipo: 'texto', label: 'Caja de origen (login)' },
      { k: 'destino', tipo: 'texto', label: 'Caja de destino (login)' },
      { k: 'solo', tipo: 'lista', label: 'Sólo estos jugadores (opcional: uno por renglón; vacío = todos)' },
      { k: 'saltearEnLinea', tipo: 'si-no', label: 'Saltear a los que están en línea', def: false },
    ],

    async revisar(cli, p) {
      const avisos = [];
      if (!p.origen || !p.destino) throw new Error('falta la caja de origen o la de destino');
      const [o, d] = [await buscarUsuario(cli, p.origen), await buscarUsuario(cli, p.destino)];
      if (!o) throw new Error(`la caja «${p.origen}» no existe en este casino`);
      if (!d) throw new Error(`la caja «${p.destino}» no existe en este casino`);
      if (o.id === d.id) throw new Error('el origen y el destino son la misma caja');
      if (d.grupo === '5') throw new Error(`«${d.login}» es un jugador, no una caja`);

      const [ramaO, ramaD] = [await arbol(cli, o.id), await arbol(cli, d.id)];
      if (ramaD.some((n) => n.id === o.id)) throw new Error(`«${d.login}» cuelga de «${o.login}»: no se puede mover a los jugadores adentro de su propia rama`);
      const [divO, divD] = [await divisasDe(cli, o.id), await divisasDe(cli, d.id)];
      const fueraDivisa = divO.filter((m) => divD.length && !divD.includes(m));
      if (fueraDivisa.length) avisos.push({ grave: true, txt: `La caja de origen lleva ${fueraDivisa.join(', ')} y ${d.login} no. Los jugadores en esa divisa pueden quedar sin poder jugar.` });

      const cliO = clienteDeRama(ramaO), cliD = clienteDeRama(ramaD);
      if (cliO && cliD && cliO.cliente_id !== cliD.cliente_id) {
        avisos.push({ grave: true, txt: `Cambian de cliente del OS: de ${cliO.cliente} (${cliO.panel}) a ${cliD.cliente} (${cliD.panel}). Lo que jueguen desde ahora se le factura a ${cliD.cliente}.` });
      }

      let hijos = (await hijosDe(cli, o.id)).filter((x) => x.is_deleted_user !== '1' && x.full_deleted !== '1');
      const conHijos = hijos.filter((x) => String(x.terminal || x.id) !== String(x.id));
      if (conHijos.length) hijos = hijos.filter((x) => !conHijos.includes(x));

      let noEstan = [];
      const solo = String(p.solo || '').split(/[\n,;]+/).map((s) => s.trim()).filter(Boolean);
      if (solo.length) {
        const pedido = new Set(solo.map((s) => s.toLowerCase()));
        const hallados = new Set();
        hijos = hijos.filter((x) => {
          const k = [String(x.login).toLowerCase(), String(x.id)].find((v) => pedido.has(v));
          if (k) hallados.add(k);
          return !!k;
        });
        noEstan = solo.filter((s) => !hallados.has(s.toLowerCase()));
        if (noEstan.length) avisos.push({ grave: false, txt: `${noEstan.length} de la lista no cuelgan de ${o.login}: ${noEstan.slice(0, 10).join(', ')}${noEstan.length > 10 ? '…' : ''}` });
      }

      const items = hijos.map((x) => {
        const it = { id: String(x.id), login: x.login, saldo: num(x.balance), online: num(x.is_user_online) > 0,
          juego: (x.open_games || []).length > 0, estado: 'pendiente' };
        if (p.saltearEnLinea && it.online) { it.estado = 'salteado'; it.motivo = 'estaba en línea'; }
        return it;
      });
      const conSaldo = items.filter((i) => i.saldo !== 0);
      return {
        contexto: {
          origen: { ...o, rama: ramaO, divisas: divO, cliente: cliO },
          destino: { ...d, rama: ramaD, divisas: divD, cliente: cliD },
          resumen: {
            jugadores: items.length,
            conSaldo: conSaldo.length,
            saldoTotal: Math.round(conSaldo.reduce((a, i) => a + i.saldo, 0) * 100) / 100,
            divisa: divO.join('/') || '',
            enLinea: items.filter((i) => i.online).length,
            enJuego: items.filter((i) => i.juego).length,
            noEstan: noEstan.length,
          },
          avisos,
        },
        items,
      };
    },

    /** Mueve UNO y lo verifica. Devuelve null si quedó, o el motivo si no. */
    async hacer(cli, it, ctx) {
      const r = await cli.apiCall('usersettings', { 'setting[name][]': ['create_login'], 'setting[value]': ctx.destino.login },
        { module: 'base', id: it.id });
      const rama = await arbol(cli, it.id);
      const padre = rama.length > 1 ? rama[rama.length - 2] : null;
      if (padre && padre.id === ctx.destino.id) return null;
      const dijo = r.ok ? '' : ` (el casino dijo: ${r.error})`;
      return `sigue colgando de ${padre ? padre.nombre : '¿?'}${dijo}`;
    },
  },
};

// ═══════════════════════════════════════════════════════════════════════════════
// Guardado
// ═══════════════════════════════════════════════════════════════════════════════
function _fila(r, conItems = true) {
  if (!r) return null;
  const items = JSON.parse(r.items || '[]');
  const cuenta = { pendiente: 0, hecho: 0, fallido: 0, salteado: 0 };
  items.forEach((i) => { cuenta[i.estado] = (cuenta[i.estado] || 0) + 1; });
  return {
    id: r.id, tipo: r.tipo, titulo: r.titulo, params: JSON.parse(r.params || '{}'),
    contexto: JSON.parse(r.contexto || '{}'), estado: r.estado, por: r.por,
    creado: r.creado, actualizado: r.actualizado, terminado: r.terminado,
    total: items.length, cuenta, corriendo: _vivas.has(r.id),
    ...(conItems ? { items } : {}),
  };
}
function get(id, conItems = true) { return _fila(db.prepare('SELECT * FROM operacion WHERE id=?').get(String(id)), conItems); }
function list(limite = 50) {
  return db.prepare('SELECT * FROM operacion ORDER BY creado DESC LIMIT ?').all(limite).map((r) => _fila(r, false));
}
function _guardar(op) {
  db.prepare('UPDATE operacion SET items=?, estado=?, actualizado=?, terminado=? WHERE id=?')
    .run(JSON.stringify(op.items), op.estado, nowISO(), op.terminado || null, op.id);
}

function catalogo() {
  return Object.entries(CATALOGO).map(([tipo, o]) => ({ tipo, titulo: o.titulo, descripcion: o.descripcion, campos: o.campos }));
}

function _cliente(conexionId) {
  const c = casinoConex.get(conexionId);
  if (!c) throw new Error('elegí con qué casino');
  if ((c.motor || '463') !== '463') throw new Error('esta operación es sólo para los casinos del motor 463');
  const cli = casinoConex.client(conexionId);
  if (!cli) throw new Error(`la conexión «${c.nombre}» no tiene credenciales`);
  return cli;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Los tres pasos
// ═══════════════════════════════════════════════════════════════════════════════
async function revisar({ tipo, params = {}, por = null }, { clienteDe = _cliente } = {}) {
  const def = CATALOGO[tipo];
  if (!def) throw new Error('esa operación no existe');
  const cli = clienteDe(params.conexion_id);
  const { contexto, items } = await def.revisar(cli, params);
  const conex = casinoConex.get(params.conexion_id);
  contexto.conexion = conex ? conex.nombre : params.conexion_id;
  const id = nuevoId();
  db.prepare(`INSERT INTO operacion (id,tipo,titulo,params,contexto,items,estado,por,creado,actualizado)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(id, tipo, def.titulo, JSON.stringify(params), JSON.stringify(contexto),
    JSON.stringify(items), 'revisada', por, nowISO(), nowISO());
  return get(id);
}

const _vivas = new Map();    // id → { cancelar: bool, promesa }

/**
 * Corre los pendientes de una operación. `cuantos` = 1 para el piloto.
 * No espera a que termine: devuelve enseguida y la pantalla pregunta el avance.
 */
function correr(id, { cuantos = Infinity, reintentar = false } = {}, { clienteDe = _cliente } = {}) {
  if (_vivas.has(id)) throw new Error('ya está corriendo');
  const op = get(id);
  if (!op) throw new Error('esa operación no existe');
  if (op.estado === 'terminada' && !reintentar) throw new Error('ya terminó');
  const def = CATALOGO[op.tipo];
  const cli = clienteDe(op.params.conexion_id);

  if (reintentar) op.items.forEach((i) => { if (i.estado === 'fallido') { i.estado = 'pendiente'; delete i.motivo; } });
  const cola = op.items.filter((i) => i.estado === 'pendiente').slice(0, cuantos);
  if (!cola.length) throw new Error('no queda nada pendiente');

  const piloto = cuantos === 1;
  op.estado = piloto ? 'piloto' : 'corriendo';
  _guardar(op);

  const viva = { cancelar: false };
  _vivas.set(id, viva);
  let ultimo = Date.now();
  const tal = () => { if (Date.now() - ultimo > 1500) { ultimo = Date.now(); _guardar(op); } };

  viva.promesa = (async () => {
    let k = 0;
    const trabajador = async () => {
      while (k < cola.length && !viva.cancelar) {
        const it = cola[k++];
        try {
          const motivo = await def.hacer(cli, it, op.contexto);
          it.estado = motivo ? 'fallido' : 'hecho';
          if (motivo) it.motivo = motivo; else delete it.motivo;
        } catch (e) {
          it.estado = 'fallido'; it.motivo = e.message || String(e);
        }
        it.at = nowISO();
        tal();
      }
    };
    await Promise.all(Array.from({ length: Math.min(piloto ? 1 : A_LA_VEZ, cola.length) }, trabajador));
    const quedan = op.items.some((i) => i.estado === 'pendiente');
    if (viva.cancelar) op.estado = 'pausada';
    else if (piloto && quedan) op.estado = 'esperando';
    else if (quedan) op.estado = 'pausada';
    else { op.estado = 'terminada'; op.terminado = nowISO(); }
    _guardar(op);
    _vivas.delete(id);
  })().catch((e) => {
    op.estado = 'pausada'; _guardar(op); _vivas.delete(id);
    console.error('[operaciones]', id, e.message);
  });
  return get(id, false);
}

function cancelar(id) {
  const v = _vivas.get(id);
  if (!v) return false;
  v.cancelar = true;
  return true;
}

/** Para las pruebas: esperar a que termine lo que está corriendo. */
async function esperar(id) { const v = _vivas.get(id); if (v) await v.promesa; }

module.exports = { catalogo, revisar, correr, cancelar, get, list, esperar, CATALOGO, _ayudas: { buscarUsuario, arbol, hijosDe } };
