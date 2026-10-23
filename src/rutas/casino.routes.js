/**
 * casino.routes.js — Lo que se le pide al casino: conexiones, árbol, movimientos del panel, pulso, reportes y ventas online.
 * Sale de os.routes.js (fase 2): las rutas se movieron tal cual y en el mismo orden.
 */
const clientes = require('../clientes-store');
const personas = require('../personas-store');
const paneles = require('../paneles-store');
const tcStore = require('../tc-store');
const movs = require('../movimientos-store');
const repartoSvc = require('../reparto.service');
const { rolDe } = require('../auth');
const casinoConex = require('../casino-conexiones-store');
const acumSvc = require('../acumulado.service');
const reporteDiarioStore = require('../reporte-diario-store');
const pulsoSvc = require('../pulso.service');
const pedidosStore = require('../pedidos-store');
const movPanel = require('../movimientos-panel');
const movPanelSvc = require('../movimientos-panel.service');
const arbolSvc = require('../arbol.service');
const tcUnico = require('../tc-unico.service');
const ventasOnline = require('../ventas-online.service');
const money = require('../lib/money');
const { fechaTZ, mesTZ, fechaUTC, mesUTC } = require('../lib/fechas'); // fechaTZ/mesTZ=ART (billing) · fechaUTC/mesUTC=UTC (casino)
const { ok, err, wrap } = require('./comun');

// Cache del árbol de nodos por conexión (algunas cuentas GOD ven decenas de miles de nodos y
// el pull al casino tarda ~20s). Se cachea unos minutos para que cambiar de nivel sea instantáneo.
const _nodosCache = {};
async function _nodosCacheados(cli, key, from, to, cur, soloActivos = false) {
  const e = _nodosCache[key];
  if (e && e.exp > Date.now()) return e.nodos;
  const r = await cli.nodos({ from, to, cur, soloActivos });
  if (!r.ok) throw new Error(r.error || 'no se pudieron traer los nodos');
  _nodosCache[key] = { nodos: r.nodos, exp: Date.now() + 180000 }; // 3 min
  return r.nodos;
}

function mount(app) {
  /**
   * ── MOVER FICHAS ENTRE PANELES DE UN CLIENTE ─────────────────────────────────────────────────
   * El cliente pide, acá se aprueba y recién ahí se ejecuta. El porqué está en
   * src/movimientos-panel.js; el cómo, en el .service.
   */
  app.get('/api/os/movimientos-panel', (req, res) => {
    const filas = movPanel.list(req.query.estado ? { estado: req.query.estado } : {});
    const cli = {}; clientes.list().clientes.forEach((c) => { cli[c.id] = c.nombre || c.codigo; });
    const pan = {}; paneles.list().forEach((p) => { pan[p.id] = p; });
    ok(res, {
      movimientos: filas.map((m) => ({
        ...m,
        cliente: cli[m.cliente_id] || '(borrado)',
        origen: (pan[m.origen_panel_id] || {}).nombre || '(panel borrado)',
        destino: (pan[m.destino_panel_id] || {}).nombre || '(panel borrado)',
        sistema: (pan[m.origen_panel_id] || {}).sistema || '',
        // La del destino va aparte: si difiere de la de origen es un PASE, y la pantalla lo marca.
        sistemaDestino: (pan[m.destino_panel_id] || {}).sistema || '',
        // Por qué NO se va a poder ejecutar, dicho antes de apretar. Sólo para los que esperan algo.
        problema: (m.estado === 'pendiente' || m.estado === 'a_medias')
          ? ((movPanelSvc.revisar(m) || {}).interno || null) : null,
      })),
      counts: movPanel.counts(),
    });
  });
  /* ── EL PASE ENTRE PLATAFORMAS, QUE LO ORIGINA ELLA ──────────────────────────────────────
     Los movimientos de siempre los pide el cliente desde su pantalla. Un pase no: cruza de Casino
     a Europa, y el cliente ni se entera de que existen dos plataformas (recibe un grupo opaco a
     propósito). Además le mueve saldo de una cuenta de ella a la otra, así que es su decisión.
     Crea y ejecuta en una sola ida: no hay a quién aprobarle nada, ya lo aprobó al apretar. */
  app.post('/api/os/movimientos-panel/pase', wrap(async (req, res) => {
    const b = req.body || {};
    /* El cliente SALE del panel de origen, no lo manda la pantalla: si viniera de afuera, alguien
       podría pedir un pase entre paneles de dos clientes distintos poniendo el id que quisiera.
       `revisar()` igual comprueba que los dos sean de ese cliente; esto es el primer cerrojo. */
    const po = paneles.get(b.origen_panel_id);
    if (!po) return err(res, 400, 'no existe el panel de origen');
    const cr = movPanel.crear({
      cliente_id: po.cliente_id, origen_panel_id: b.origen_panel_id, destino_panel_id: b.destino_panel_id,
      divisa: b.divisa, monto: b.monto, nota: b.nota || 'pase entre plataformas',
    }, 'admin');
    if (!cr.ok) return err(res, 400, cr.error);
    const mal = movPanelSvc.revisar(cr.movimiento);
    if (mal) { movPanel.rechazar(cr.movimiento.id, mal.interno); return err(res, 400, mal.interno); }
    const r = await movPanelSvc.ejecutar(cr.movimiento.id, {
      sistemaParaCargar: req.app.get('sistemaParaCargar'), por: 'admin', log: console.log });
    return r.ok ? ok(res, r) : err(res, r.status || 502, r.error, { quedoAMedias: !!r.quedoAMedias, id: cr.movimiento.id });
  }));
  /* A qué paneles se le puede pasar el saldo de éste: los del MISMO cliente en la OTRA plataforma.
     Se resuelve en el servidor y no en la pantalla porque esconder una opción no impide postear. */
  app.get('/api/os/movimientos-panel/destinos/:panelId', (req, res) => {
    const o = paneles.get(req.params.panelId);
    if (!o) return err(res, 404, 'no existe ese panel');
    const otros = paneles.list().filter((p) => String(p.cliente_id) === String(o.cliente_id)
      && String(p.id) !== String(o.id)
      && String(p.sistema || '').toLowerCase() !== String(o.sistema || '').toLowerCase()
      && p.id_usuario);
    ok(res, { origen: { id: o.id, nombre: o.nombre, sistema: o.sistema, divisas: o.divisas || [] },
      destinos: otros.map((p) => ({ id: p.id, nombre: p.nombre, sistema: p.sistema, divisas: p.divisas || [] })) });
  });
  app.post('/api/os/movimientos-panel/:id/ejecutar', wrap(async (req, res) => {
    const r = await movPanelSvc.ejecutar(req.params.id, {
      sistemaParaCargar: req.app.get('sistemaParaCargar'),
      por: rolDe(req) || 'admin',
      log: (m) => console.log(m),
    });
    if (r.ok) return ok(res, r);
    return res.status(r.status || 400).json({ ok: false, error: r.error,
      mitad: r.mitad || null, quedoAMedias: !!r.quedoAMedias });
  }));
  app.post('/api/os/movimientos-panel/:id/rechazar', wrap((req, res) => {
    const r = movPanel.rechazar(req.params.id, (req.body || {}).motivo, rolDe(req) || 'admin');
    if (!r) return err(res, 404, 'no encontré ese movimiento');
    return r.ok ? ok(res, r) : err(res, 400, r.error);
  }));
  /** Destrabar uno que quedó tomado porque el server se reinició en el medio. */
  app.post('/api/os/movimientos-panel/:id/destrabar', wrap((req, res) => {
    const r = movPanel.destrabar(req.params.id);
    return r.ok ? ok(res, r) : err(res, 400, r.error);
  }));
  // ───────── CASINO (conexiones api_token + lectura de nodos) ─────────
  // Se agrega `paneles`: cuántos cuelgan de esta conexión. Config las quiere TODAS (hay que poder
  // editar la de carga), pero la Foto y el pago a proveedores sólo deben mirar las que facturan —
  // con este número la pantalla filtra sin tener que saber qué conexión es cuál.
  app.get('/api/os/casino/conexiones', (_req, res) => {
    const cuenta = new Map();
    paneles.list().forEach((x) => { if (x.conexion_id) cuenta.set(x.conexion_id, (cuenta.get(x.conexion_id) || 0) + 1); });
    ok(res, { conexiones: casinoConex.list().map((c) => ({ ...c, paneles: cuenta.get(c.id) || 0 })) });
  });
  app.post('/api/os/casino/conexiones', wrap((req, res) => ok(res, { conexion: casinoConex.create(req.body || {}) })));
  app.put('/api/os/casino/conexiones/:id', wrap((req, res) => {
    const c = casinoConex.update(req.params.id, req.body || {}); if (!c) return err(res, 404, 'conexión no encontrada'); ok(res, { conexion: c });
  }));
  app.delete('/api/os/casino/conexiones/:id', (req, res) => casinoConex.remove(req.params.id) ? ok(res) : err(res, 404, 'conexión no encontrada'));
  /* ⚠️ `fresco`: éste y sólo éste entra de nuevo al casino. Probar es preguntar si las
     credenciales sirven HOY — con la sesión guardada viva, una contraseña cambiada diría "anda". */
  app.post('/api/os/casino/conexiones/:id/test', wrap(async (req, res) => {
    const cli = casinoConex.client(req.params.id, { fresco: true }); if (!cli) return err(res, 404, 'conexión no encontrada');
    const r = await cli.test(); r.ok ? ok(res, { login: r.login, balances: r.balances }) : err(res, 502, r.error);
  }));
  // listar nodos: sin id = root (todos, c/total); ?id= = subárbol de ese nodo
  app.get('/api/os/casino/conexiones/:id/nodos', wrap(async (req, res) => {
    const cli = casinoConex.client(req.params.id); if (!cli) return err(res, 404, 'conexión no encontrada');
    const extra = {}; Object.keys(req.query).forEach((k) => { if (k.startsWith('flt_')) extra[k.slice(4)] = req.query[k]; }); // prueba de filtros server-side
    const soloActivos = req.query.activos === '1'; // ?activos=1 → filtro server-side (medir tiempo)
    const currencies = req.query.curs ? String(req.query.curs).split(',').map((s) => s.trim().toUpperCase()).filter(Boolean) : null; // ?curs=ARS (medir si pedir menos monedas acelera)
    const r = await cli.nodos({ from: req.query.from, to: req.query.to, id: req.query.id, cur: req.query.cur || 'ARS', soloActivos, currencies, extra });
    if (!r.ok) return err(res, 502, r.error);
    if (req.query.tally) { const niv = {}; r.nodos.forEach((n) => { const k = n.nivel || 'Terminal/Caja'; niv[k] = (niv[k] || 0) + 1; }); return ok(res, { count: r.nodos.length, niveles: niv }); }
    ok(res, { nodos: r.nodos });
  }));
  // ───────── JERARQUÍA (para cargar hay que bajar las fichas por los padres) ─────────
  // Resuelve contra el casino el nivel real de CADA panel y por qué padres hay que pasar.
  // Tarda ~2 min: baja el árbol completo de cada conexión (decenas de miles de nodos).
  app.post('/api/os/casino/arbol/sync', wrap(async (req, res) => {
    const b = req.body || {};
    /* `panel_id` resuelve UNO solo: es lo que hace falta cuando se crea una caja nueva. Antes había
       que re-sincronizar los 204 paneles —dos minutos y una reescritura de todos— para arreglar uno.
       `dry` calcula y no escribe: deja ver qué cambiaría antes de cambiarlo. */
    const r = await arbolSvc.sincronizar({
      soloConexion: b.conexion_id || null,
      soloPanel: b.panel_id || null,
      dry: !!b.dry,
    });
    r.ok ? ok(res, r) : err(res, 502, r.error);
  }));
  // total propio de un nodo
  app.get('/api/os/casino/conexiones/:id/nodo/:nodeId', wrap(async (req, res) => {
    const cli = casinoConex.client(req.params.id); if (!cli) return err(res, 404, 'conexión no encontrada');
    const r = await cli.totalNodo({ nodeId: req.params.nodeId, from: req.query.from, to: req.query.to, cur: req.query.cur || 'ARS' });
    r.ok ? ok(res, { nodo: r.nodo }) : err(res, 404, r.error);
  }));
  // buscar usuario por login (global)
  app.get('/api/os/casino/conexiones/:id/buscar', wrap(async (req, res) => {
    const cli = casinoConex.client(req.params.id); if (!cli) return err(res, 404, 'conexión no encontrada');
    const r = await cli.buscar({ login: req.query.login || '' }); r.ok ? ok(res, { users: r.users }) : err(res, 502, r.error);
  }));
  // SOLO los superagentes (plataformas que ve el GOD) → para el asignador con checkboxes del cliente
  app.get('/api/os/casino/conexiones/:id/superagentes', wrap(async (req, res) => {
    const cli = casinoConex.client(req.params.id); if (!cli) return err(res, 404, 'conexión no encontrada');
    const soloActivos = req.query.activos !== '0'; // ?activos=0 → TODOS (incluye inactivos), p/ matchear SA_Cliente completo
    const r = await cli.superagentes({ from: req.query.from, to: req.query.to, cur: req.query.cur || 'ARS', soloActivos });
    r.ok ? ok(res, { superagentes: r.superagentes }) : err(res, 502, r.error);
  }));
  // Nodos POR NIVEL (cacheado) — para el asignador level-flexible SIN bajar el árbol entero (cuentas
  // GOD ven decenas de miles). Devuelve el tally de niveles + SOLO los nodos del nivel pedido (cap 2000).
  app.get('/api/os/casino/conexiones/:id/nodos-nivel', wrap(async (req, res) => {
    const cli = casinoConex.client(req.params.id); if (!cli) return err(res, 404, 'conexión no encontrada');
    const from = req.query.from || '', to = req.query.to || '', cur = req.query.cur || 'ARS';
    const soloActivos = req.query.activos !== '0'; // default: SOLO activos (filtro server-side del casino, sin ruido). ?activos=0 = todos
    const nodos = await _nodosCacheados(cli, `${req.params.id}|${from}|${to}|${cur}|${soloActivos ? 'act' : 'all'}`, from, to, cur, soloActivos);
    const niveles = {};
    nodos.forEach((n) => { const k = n.nivel || 'Terminal/Caja'; niveles[k] = (niveles[k] || 0) + 1; });
    const orden = Object.keys(niveles).sort((a, b) => niveles[a] - niveles[b]); // top (menos nodos) primero
    const nivel = req.query.nivel || orden.find((k) => k !== 'Terminal/Caja') || orden[0] || '';
    const filtrados = nodos.filter((n) => (n.nivel || 'Terminal/Caja') === nivel);
    const CAP = 2000;
    ok(res, { niveles, nivel, soloActivos, total: filtrados.length, truncado: filtrados.length > CAP, nodos: filtrados.slice(0, CAP) });
  }));
  // profit por proveedor de un usuario (game history agregado)
  app.get('/api/os/casino/conexiones/:id/proveedores/:userId', wrap(async (req, res) => {
    const cli = casinoConex.client(req.params.id); if (!cli) return err(res, 404, 'conexión no encontrada');
    const r = await cli.profitPorProveedor({ userId: req.params.userId, from: req.query.from, to: req.query.to });
    r.ok ? ok(res, { proveedores: r.proveedores }) : err(res, 502, r.error);
  }));
  // catálogo de proveedores de la conexión (gamesSystem) → para el dropdown del catálogo del OS
  app.get('/api/os/casino/conexiones/:id/catalogo-proveedores', wrap(async (req, res) => {
    const cli = casinoConex.client(req.params.id); if (!cli) return err(res, 404, 'conexión no encontrada');
    const r = await cli.catalogoProveedores(); r.ok ? ok(res, { proveedores: r.proveedores }) : err(res, 502, r.error);
  }));
  // REPORTE DIARIO agrupado por superagent/distributor (reports → reportstable)
  app.get('/api/os/casino/conexiones/:id/reporte', wrap(async (req, res) => {
    const cli = casinoConex.client(req.params.id); if (!cli) return err(res, 404, 'conexión no encontrada');
    // Pivot a nodos() (VIVO) — el flujo reporte()→reportstable está roto del lado del casino.
    const group = req.query.group || 'superagent';
    const nivel = group === 'distributor' ? 'Distribuidor' : group === 'agent' ? 'Agente' : 'SuperAgente';
    const from = req.query.from || '', to = req.query.to || '', cur = req.query.cur || 'ARS';
    const soloActivos = req.query.activos !== '0'; // default: SOLO activos (filtro server-side, sin ruido). ?activos=0 = todos
    const nodos = await _nodosCacheados(cli, `${req.params.id}|${from}|${to}|${cur}|${soloActivos ? 'act' : 'all'}`, from, to, cur, soloActivos);
    const filas = nodos.filter((n) => n.nivel === nivel).map((n) => ({ id: n.id, login: n.login, in: n.in, out: n.out, profit: n.profit, rtp: n.rtp }));
    ok(res, { groupBy: group, filas, soloActivos });
  }));
  // REPORTE DE PROVEEDORES: profit/bet/win/rtp por proveedor, en UNA o VARIAS monedas, vista
  // 'general' (toda la plataforma) o 'superagent'. on_bets + reports_group_by=provider_label.
  // ?view=general|superagent  ?currencies=ARS,USD,BRL  ?from=&to=  ?template=
  // Reporte de proveedores DE UN NODO puntual (típicamente un DISTRIBUIDOR, que el agrupamiento
  // por 'distributor' no desglosa). ?nodo=<id de usuario del casino>
  /* LA GANANCIA DE UN NODO, tal cual la muestra el casino en Estadísticas → Efectivo → Datos
     generales. Es la pantalla que ella abre para discutir con el proveedor, así que es el número
     que tiene que dar el sistema. Una sola consulta por el mes entero: no hay que sumar días ni
     depender de que la captura nocturna los tenga todos. */
  app.get('/api/os/casino/conexiones/:id/ganancia-nodo', wrap(async (req, res) => {
    const cli = casinoConex.client(req.params.id); if (!cli) return err(res, 404, 'conexión no encontrada');
    if (!req.query.nodo) return err(res, 400, 'falta ?nodo=<id de usuario del casino>');
    const curs = String(req.query.currencies || req.query.cur || 'ARS').split(',')
      .map((x) => x.trim().toUpperCase()).filter(Boolean);
    const monedas = {};
    for (const cur of curs) {
      // eslint-disable-next-line no-await-in-loop
      const r = await cli.gananciaDeNodo({ nodoId: req.query.nodo, from: req.query.from, to: req.query.to, currency: cur,
        base: req.query.base === undefined ? 'users' : String(req.query.base),
        sort: req.query.sort || 'in', debug: req.query.debug === '1' });
      monedas[cur] = r.ok ? { ok: true, in: r.in, out: r.out, profit: r.profit, rtp: r.rtp, filas: r.filas, debug: r.debug }
        : { ok: false, error: r.error, debug: r.debug };
    }
    ok(res, { nodo: String(req.query.nodo), from: req.query.from, to: req.query.to, monedas });
  }));
  app.get('/api/os/casino/conexiones/:id/reporte-proveedores-nodo', wrap(async (req, res) => {
    const cli = casinoConex.client(req.params.id); if (!cli) return err(res, 404, 'conexión no encontrada');
    if (!req.query.nodo) return err(res, 400, 'falta ?nodo=<id de usuario del casino>');
    const curs = String(req.query.currencies || req.query.cur || 'ARS').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
    const monedas = {};
    for (const cur of curs) {
      const r = await cli.reporteProveedoresNodo({ nodoId: req.query.nodo, from: req.query.from, to: req.query.to, currency: cur, debug: req.query.debug === '1' });
      monedas[cur] = r.ok ? { ok: true, filas: r.filas, debug: r.debug } : { ok: false, error: r.error };
    }
    ok(res, { nodo: String(req.query.nodo), from: req.query.from, to: req.query.to, monedas });
  }));
  // Los selectores de la pantalla de reportes del casino, con su name y sus opciones: ahí está el
  // nombre del campo que controla la agrupación (Group by = Dealer).
  app.get('/api/os/casino/conexiones/:id/campos-reportes', wrap(async (req, res) => {
    const cli = casinoConex.client(req.params.id); if (!cli) return err(res, 404, 'conexión no encontrada');
    const r = await cli.camposDeReportes();
    r.ok ? ok(res, r) : err(res, 502, r.error);
  }));
  // SONDA CRUDA: POST a cualquier área del casino con la sesión ya abierta. Para reproducir lo que
  // hace la pantalla del casino al cambiar una opción. No la usa ningún cálculo.
  app.post('/api/os/casino/conexiones/:id/sonda-cruda', wrap(async (req, res) => {
    const cli = casinoConex.client(req.params.id); if (!cli) return err(res, 404, 'conexión no encontrada');
    const b = req.body || {};
    ok(res, await cli.sondaCruda({ area: b.area || 'info', params: b.params || {}, query: b.query || {} }));
  }));
  // SONDA: corre el reporte con parámetros crudos. Solo para investigar cómo pedirle al casino que
  // abra por distribuidor; no lo usa ningún cálculo.
  app.post('/api/os/casino/conexiones/:id/sonda-reporte', wrap(async (req, res) => {
    const cli = casinoConex.client(req.params.id); if (!cli) return err(res, 404, 'conexión no encontrada');
    const b = req.body || {};
    const r = await cli.sondaReporte({ from: b.from, to: b.to, nodoId: b.nodo || null, campos: b.campos || null,
      params: b.params || {}, ...(b.filtros !== undefined ? { filtros: b.filtros } : {}) });
    // El `debug` viaja también cuando falla: es una sonda, y sin lo que devolvió el casino no se
    // puede diagnosticar nada. Tirar el error pelado dejaba "devolvió un error" y nada más.
    r.ok ? ok(res, r) : err(res, 502, r.error, { debug: r.debug || null });
  }));
  // Las plantillas de reporte guardadas en el casino: la agrupación sale de ahí, no de un parámetro.
  app.get('/api/os/casino/conexiones/:id/plantillas', wrap(async (req, res) => {
    const cli = casinoConex.client(req.params.id); if (!cli) return err(res, 404, 'conexión no encontrada');
    const r = await cli.plantillas();
    r.ok ? ok(res, r) : err(res, 502, r.error);
  }));
  app.get('/api/os/casino/conexiones/:id/reporte-proveedores', wrap(async (req, res) => {
    const cli = casinoConex.client(req.params.id); if (!cli) return err(res, 404, 'conexión no encontrada');
    const ug = req.query.ug != null ? req.query.ug : (req.query.view === 'superagent' ? 'superagent' : ''); // ?ug= override p/ probar valores
    const curs = String(req.query.currencies || 'ARS').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
    const r = await cli.reporteProveedoresMonedas({
      from: req.query.from, to: req.query.to, currencies: curs,
      userGroupBy: ug, activeTemplate: req.query.template || '',
    });
    r.ok ? ok(res, { from: r.from, to: r.to, view: ug ? 'superagent' : 'general', monedas: r.monedas }) : err(res, 502, r.error);
  }));
  // REPORTE MENSUAL "matriz estilo Alexa": días × superagente × {in,out,profit} + totales + RTP.
  // Corre el reporte diario por cada día del mes (login 1 vez, batches de 5).
  app.get('/api/os/casino/conexiones/:id/reporte-mensual', wrap(async (req, res) => {
    // Lee de la DB (reporte_diario), igual que el Acumulado — el motor de reportes del casino
    // (reporte()→reportstable) está muerto. Para poblar/actualizar usar "Backfill mes" en el Acumulado
    // (o esperar el cron nocturno, que ahora auto-completa el mes).
    const group = req.query.group || 'superagent';
    const mes = req.query.mes || mesUTC(); // acumulado = datos del casino (UTC)
    ok(res, { ...reporteDiarioStore.getMatriz(req.params.id, group, mes, req.query.moneda || 'ARS'), errores: [] });
  }));
  // ───────── ACUMULADO (solapa que se llena día a día — datos GUARDADOS) ─────────
  // Ver el acumulado del mes (rápido, desde la DB; no consulta el casino).
  app.get('/api/os/casino/conexiones/:id/acumulado', (req, res) => {
    ok(res, reporteDiarioStore.getMatriz(req.params.id, req.query.group || 'superagent', req.query.mes || mesUTC(), req.query.moneda || 'ARS'));
  });
  // 📊 EL PULSO: el resumen y las alertas del mes, desde el acumulado guardado (no toca el casino).
  app.get('/api/os/pulso', wrap((req, res) => ok(res, pulsoSvc.pulso({ mes: req.query.mes }))));
  app.get('/api/os/pulso/tendencia', wrap((req, res) => ok(res, pulsoSvc.tendencia({ hasta: req.query.mes, meses: Number(req.query.meses) || 6 }))));
  // Ver el acumulado del mes de TODAS las conexiones juntas (todos los GOD en simultáneo).
  app.get('/api/os/casino/acumulado-todos', (req, res) => {
    ok(res, reporteDiarioStore.getMatrizTodos(req.query.group || 'superagent', req.query.mes || mesUTC(), req.query.moneda || 'ARS'));
  });
  // Limpia el acumulado de conexiones que ya no existen (IDs viejos) → saca superagentes duplicados.
  app.post('/api/os/casino/acumulado/limpiar-huerfanos', wrap((_req, res) => ok(res, { borradas: reporteDiarioStore.limpiarHuerfanos() })));
  // Borra lo capturado por un espejo de carga (Europa_Fichas / Casino_Fichas), que es una copia
  // exacta de lo del casino principal. SIMULA salvo que se pida borrar a propósito, y nunca toca
  // una fila que no tenga su par del lado principal: sería el único registro de ese día.
  app.post('/api/os/casino/acumulado/limpiar-espejos', wrap((req, res) => {
    const simular = !((req.body || {}).confirmar === true);
    ok(res, reporteDiarioStore.limpiarEspejos({ simular }));
  }));
  // Capturar HOY (o un día) en TODAS las conexiones activas a la vez.
  app.post('/api/os/casino/capturar-hoy-todos', wrap(async (req, res) => {
    const dia = req.query.dia || (req.body && req.body.dia) || fechaUTC(); // casino corta días en UTC
    const group = req.query.group || (req.body && req.body.group) || 'superagent';
    const out = [];
    for (const cx of casinoConex.list463()) {   // el acumulado se arma con nodos del engine 463
      if (!cx.activa) continue;
      try { const r = await acumSvc.captureDia(cx.id, dia, group); out.push({ conexion: cx.nombre, ...r }); }
      catch (e) { out.push({ conexion: cx.nombre, ok: false, error: e.message }); }
    }
    ok(res, { conexiones: out, capturados: out.filter((x) => x.ok).length });
  }));
  // Backfill de TODAS las conexiones activas a la vez (secuencial por conexión).
  app.post('/api/os/casino/capturar-mes-todos', wrap(async (req, res) => {
    const mes = req.query.mes || (req.body && req.body.mes) || mesUTC(); // casino corta meses en UTC
    const group = req.query.group || (req.body && req.body.group) || 'superagent';
    const out = [];
    for (const cx of casinoConex.list463()) {   // idem: TBS no tiene árbol de nodos
      if (!cx.activa) continue;
      try { const r = await acumSvc.captureMes(cx.id, mes, group); out.push({ conexion: cx.nombre, ...r }); }
      catch (e) { out.push({ conexion: cx.nombre, ok: false, error: e.message }); }
    }
    ok(res, { conexiones: out });
  }));
  // Capturar UN día (manual) y guardarlo en el acumulado.
  app.post('/api/os/casino/conexiones/:id/capturar', wrap(async (req, res) => {
    const dia = req.query.dia || (req.body && req.body.dia) || fechaUTC(); // casino corta días en UTC
    const group = req.query.group || (req.body && req.body.group) || 'superagent';
    const r = await acumSvc.captureDia(req.params.id, dia, group);
    r.ok ? ok(res, { dia: r.dia, filas: r.filas }) : err(res, 502, r.error);
  }));
  // Backfill: capturar todos los días del mes (hasta hoy) y guardarlos.
  app.post('/api/os/casino/conexiones/:id/capturar-mes', wrap(async (req, res) => {
    const mes = req.query.mes || (req.body && req.body.mes) || mesUTC(); // casino corta meses en UTC
    const group = req.query.group || (req.body && req.body.group) || 'superagent';
    const force = req.query.force === '1' || !!(req.body && req.body.force); // re-captura todos los días (multi-moneda)
    const r = await acumSvc.captureMes(req.params.id, mes, group, 8, null, force);
    r.ok ? ok(res, { capturados: r.capturados, faltan: r.faltan, total: r.total, ya_tenia: r.ya_tenia }) : err(res, 502, r.error);
  }));
  // ───────── PUENTE con el sistema en línea (de donde salen los pedidos) ─────────
  app.get('/api/os/ventas-online/config', (_req, res) => ok(res, { config: ventasOnline.getConfig() }));
  app.put('/api/os/ventas-online/config', wrap((req, res) => ok(res, { config: ventasOnline.setConfig(req.body || {}) })));
  app.get('/api/os/ventas-online/mapeo', (_req, res) => ok(res, { mapeo: ventasOnline.listMapeo() }));
  // Los pedidos de UN cliente, uno por uno. Hace falta cuando lo vendido no cuadra con lo que
  // registró el casino: sin ver pedido por pedido no se puede saber cuál entró con el código
  // equivocado (pasa cuando un panel se muda de un cliente a otro).
  // ¿Algún pedido entró con el código de un cliente pero se cargó en el panel de otro?
  app.get('/api/os/ventas-online/cruce', wrap(async (req, res) => {
    const r = await ventasOnline.cruceConPaneles(req.query.mes || mesTZ());
    r.ok ? ok(res, r) : err(res, 502, r.error);
  }));
  app.get('/api/os/ventas-online/detalle', wrap(async (req, res) => {
    const r = await ventasOnline.detalleDelMes(req.query.mes || mesTZ(), req.query.cliente_id);
    r.ok ? ok(res, r) : err(res, 502, r.error);
  }));
  app.post('/api/os/ventas-online/mapeo', wrap((req, res) => {
    const b = req.body || {};
    const filas = Array.isArray(b.filas) ? b.filas : [b];
    filas.forEach((f) => ventasOnline.setMapeo(f.codigo, f.cliente_id, f.origen || 'a mano'));
    ok(res, { mapeo: ventasOnline.listMapeo() });
  }));
  // Prueba de conexión: cuántos pedidos ve y de qué meses.
  app.get('/api/os/ventas-online/prueba', wrap(async (_req, res) => {
    const r = await ventasOnline._pedidos();
    if (!r.ok) return err(res, 502, r.error);
    const meses = {};
    (r.pedidos || []).filter((p) => p.estado === 'cargado').forEach((p) => {
      const m = String(p.resueltoAt || p.createdAt || '').slice(0, 7);
      meses[m] = (meses[m] || 0) + 1;
    });
    ok(res, { pedidos: (r.pedidos || []).length, meses });
  }));
  // ───────── REPORTES ─────────
  // Mensual (parcial, real): arma desde movimientos + tc_mes. Lo que falta (IN/OUT/RTP/profit) = API del panel.
  app.get('/api/os/reportes/mensual', (req, res) => {
    const mes = req.query.mes || mesTZ();
    const movimientos = movs.list({ mes });
    const porCliente = {};
    for (const m of movimientos) {
      const k = m.cliente_id || '—';
      porCliente[k] = porCliente[k] || { cliente_id: k, cargas: '0', fees_usdt: '0', proveedores_usdt: '0', pagos_usdt: '0' };
      if (m.tipo === 'carga') { porCliente[k].cargas = money.add(porCliente[k].cargas, m.monto_ars || '0'); porCliente[k].fees_usdt = money.add(porCliente[k].fees_usdt, m.monto_usdt || '0'); }
      else if (m.tipo === 'proveedor_extra') porCliente[k].proveedores_usdt = money.add(porCliente[k].proveedores_usdt, m.monto_usdt || '0');
      else if (m.tipo === 'pago') porCliente[k].pagos_usdt = money.add(porCliente[k].pagos_usdt, m.monto_usdt || '0');
    }
    ok(res, { mes, tc_mes: tcStore.getMes(mes), clientes: Object.values(porCliente), _nota: 'IN/OUT/Profit/RTP requieren la API del panel (Fase 3/5)' });
  });
  // DISTRIBUCIÓN por PARTICIPANTE según las VENTAS DE FICHAS reales del mes (§12).
  // Fuente = pedidos CARGADOS (compra prepaga) por cliente; el % se cobra sobre lo VENDIDO, no
  // sobre el `in` de jugadores. fee = base% × ventas, y ese fee se reparte en UN SOLO PASO entre
  // los participantes del cliente (la Empresa es uno más). Los puntos del base que todavía no
  // tienen dueño se informan como `sin_asignar` en vez de repartirse por su cuenta.
  app.get('/api/os/reportes/distribucion', (req, res) => {
    const mes = req.query.mes || mesTZ();
    const fecha = `${mes}-15`; // fecha media del mes para vigencias (base + participaciones)
    const nombres = {}; const esEmpresa = {};
    personas.list().forEach((p) => { nombres[p.id] = p.nombre; esEmpresa[p.id] = !!p.es_empresa; });
    // ⚠️ CADA MONEDA CON SU TIPO DE CAMBIO. Acá había UN solo TC —el del peso— aplicado a
    // `vc.monto`, que suma pesos con guaraníes y no significa nada (lo dice pedidos-store.js:237
    // con todas las letras). Los guaraníes salían 3,8× de más y los uruguayos 39× de menos: en
    // julio 2026 esta pantalla repartió 97.536,44 USDT cuando lo correcto era 80.748,53.
    // Es la misma regla que ya usaba Facturación, que por eso siempre estuvo bien.
    const _tcs = new Map();
    const tcDe = (divisa) => {
      const D = String(divisa || 'ARS').toUpperCase();
      if (!_tcs.has(D)) _tcs.set(D, tcUnico.tcDelMes(D, mes));
      return _tcs.get(D);
    };
    const ventas = pedidosStore.ventasCargadasMes(mes); // { codigo: { monto, porDivisa, ... } }
    let totVentas = '0', totFee = '0', totSinAsignar = '0';
    const porParticipante = {}, porCliente = [];
    const problemas = [];
    for (const c of clientes.list().clientes) {
      const vc = ventas[c.codigo];
      if (!vc) continue;

      // Lo vendido, moneda por moneda, pasado a USDT con LA TASA DE CADA UNA.
      let carga = '0'; const sinTC = [];
      for (const [divisa, monto] of Object.entries(vc.porDivisa || {})) {
        const m = String(monto);
        if (!money.isPos(m)) continue;
        const t = tcDe(divisa);
        // Sin tasa NO se inventa una. Esa moneda queda afuera del total y se avisa: un total
        // visiblemente incompleto se arregla, uno completado a ojo se cree y se liquida.
        if (!t.valor || !money.isPos(String(t.valor))) { sinTC.push(divisa); continue; }
        carga = money.add(carga, money.div(m, String(t.valor)));
      }
      if (sinTC.length) problemas.push({ codigo: c.codigo, estado: 'sin_tc', divisas: sinTC.join(', ') });
      if (!money.isPos(carga)) continue;
      totVentas = money.add(totVentas, carga);

      // UN SOLO PASO: los participantes del cliente se reparten su % base directo (§12).
      const d = repartoSvc.distribuir(carga, c, mes, fecha);
      totFee = money.add(totFee, d.fee_usdt);
      totSinAsignar = money.add(totSinAsignar, d.sin_asignar);
      d.items.forEach((it) => {
        porParticipante[it.persona_id] = money.add(porParticipante[it.persona_id] || '0', it.monto);
      });
      porCliente.push({
        cliente_id: c.id, codigo: c.codigo, nombre: c.nombre || c.nombreVisible,
        ventas: money.round(carga, 2), base: d.reparto.base, estado: d.estado,
        fee: d.fee_usdt, sin_asignar: d.sin_asignar,
        items: d.items.map((it) => ({ persona_id: it.persona_id, nombre: it.nombre, pct: it.pct, monto: it.monto, es_empresa: it.es_empresa })),
      });
      if (d.estado !== 'ok') {
        problemas.push({
          codigo: c.codigo, estado: d.estado, base: d.reparto.base,
          suma: d.reparto.suma, resto: d.reparto.resto, en_juego: d.sin_asignar,
        });
      }
    }
    const participantes = Object.keys(porParticipante).map((id) => ({
      persona_id: id, nombre: nombres[id] || id, es_empresa: !!esEmpresa[id], monto: money.round(porParticipante[id], 2),
    })).sort((a, b) => Number(b.monto) - Number(a.monto));
    // Las tasas que se usaron de verdad, para que la pantalla las muestre. No hay UN tc: hay uno
    // por moneda, y mostrarlos es lo que hace revisable el número de arriba.
    const tcPorDivisa = [..._tcs.entries()]
      .map(([divisa, t]) => ({ divisa, tc: t.valor || null, fuente: t.fuente || null }))
      .sort((a, b) => a.divisa.localeCompare(b.divisa));
    ok(res, {
      mes, tcPorDivisa, ventas_total: money.round(totVentas, 2),
      total: money.round(totFee, 2),
      repartido: money.round(money.sub(totFee, totSinAsignar), 2),
      sin_asignar: money.round(totSinAsignar, 2),
      participantes, clientes: porCliente, problemas,
      _nota: 'Todo en USDT, de las VENTAS DE FICHAS reales (pedidos cargados) del mes. Cada moneda se pasa a USDT con SU tipo de cambio (ver tcPorDivisa) — "ventas_total" es la suma ya convertida, no un monto en moneda local. Un solo paso: cada participante cobra SUS PUNTOS del % base del cliente (§12). "sin_asignar" = puntos del base que todavía no tienen dueño.',
    });
  });
  // Diario: STUB (depende de la API del panel)
  app.get('/api/os/reportes/diario', (req, res) => ok(res, {
    fecha: req.query.fecha || fechaTZ(), pendiente: true,
    _nota: 'Reporte diario (IN/OUT/Profit/RTP + alertas) requiere la API del panel — Fase 5',
  }));
}

module.exports = { mount };
