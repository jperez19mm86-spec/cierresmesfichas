/**
 * os.routes.js — endpoints del núcleo comercial/financiero (LATAM Games OS v3).
 * Se montan DESPUÉS del gate de auth de la MATRIZ (todo /api/os/* requiere sesión de admin).
 * mount(app) también siembra split_base y arranca el scheduler de TC.
 */
const clientes = require('./clientes-store');
const personas = require('./personas-store');
const paneles = require('./paneles-store');
const participaciones = require('./participaciones-store');
const splitBase = require('./split-base-store');
const proveedores = require('./proveedores-store');
const tcStore = require('./tc-store');
const movs = require('./movimientos-store');
const historial = require('./historial');
const splitSvc = require('./split.service');
const provSvc = require('./proveedores.service');
const deudaSvc = require('./deuda.service');
const tcSvc = require('./tc.service');
const notify = require('./notify.service');
const casinoConex = require('./casino-conexiones-store');
const acumSvc = require('./acumulado.service');
const reporteDiarioStore = require('./reporte-diario-store');
const money = require('./lib/money');
const { fechaTZ, mesTZ } = require('./lib/fechas');

const ok = (res, extra = {}) => res.json(Object.assign({ ok: true }, extra));
const err = (res, code, msg) => res.status(code).json({ ok: false, error: msg });
const wrap = (fn) => async (req, res) => { try { await fn(req, res); } catch (e) { err(res, 400, e.message); } };

// Cache del árbol de nodos por conexión (algunas cuentas GOD ven decenas de miles de nodos y
// el pull al casino tarda ~20s). Se cachea unos minutos para que cambiar de nivel sea instantáneo.
const _nodosCache = {};
async function _nodosCacheados(cli, key, from, to, cur) {
  const e = _nodosCache[key];
  if (e && e.exp > Date.now()) return e.nodos;
  const r = await cli.nodos({ from, to, cur });
  if (!r.ok) throw new Error(r.error || 'no se pudieron traer los nodos');
  _nodosCache[key] = { nodos: r.nodos, exp: Date.now() + 180000 }; // 3 min
  return r.nodos;
}

/** Base % efectivo de un panel: override del panel (si no hereda) o el del cliente. */
function basePctEfectivo(cliente, panel, fecha = fechaTZ()) {
  if (panel && panel.usa_config_cliente === false) {
    const ov = historial.getVigente('panel', panel.id, 'precio_base_pct', fecha);
    if (ov != null) return ov;
  }
  return historial.getVigente('cliente', cliente.id, 'precio_base_pct', fecha);
}

function mount(app) {
  splitBase.seedIfEmpty();
  tcSvc.startScheduler();
  acumSvc.startCron();

  // Panel del OS (HTML estático, detrás del gate de auth)
  const path = require('path');
  app.get('/os', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'os.html')));

  // ───────── CLIENTES (comercial) ─────────
  app.get('/api/os/clientes', (_req, res) => {
    const list = clientes.list().clientes.map((c) => ({
      id: c.id, codigo: c.codigo, nombre: c.nombre || c.nombreVisible, estado: c.estado,
      paga_proveedores: c.paga_proveedores, permite_deuda: c.permite_deuda,
      mezcla_pago_usdt: c.mezcla_pago_usdt, ajuste_usdt_pct: c.ajuste_usdt_pct,
      precio_base_pct: historial.getVigente('cliente', c.id, 'precio_base_pct'),
      paneles: paneles.list({ cliente_id: c.id }).length,
      deuda: deudaSvc.cuentaCorriente(c.id),
    }));
    ok(res, { clientes: list });
  });
  app.put('/api/os/clientes/:id/comercial', wrap((req, res) => {
    const c = clientes.updateComercial(req.params.id, req.body || {});
    if (!c) return err(res, 404, 'cliente no encontrado'); ok(res, { cliente: c });
  }));
  // precio base con vigencia/corrección
  app.put('/api/os/clientes/:id/precio-base', wrap((req, res) => {
    const { valor, tipo_cambio, vigente_desde, notas } = req.body || {};
    if (valor === undefined) return err(res, 400, 'falta valor');
    const v = historial.setValor('cliente', req.params.id, 'precio_base_pct', { valor, tipo_cambio, vigente_desde, notas });
    ok(res, { precio_base_pct: v });
  }));
  app.get('/api/os/clientes/:id/precio-base/historial', (req, res) =>
    ok(res, { historial: historial.listValores('cliente', req.params.id, 'precio_base_pct') }));
  app.get('/api/os/clientes/:id/cuenta', (req, res) => ok(res, { cuenta: deudaSvc.cuentaCorriente(req.params.id) }));

  // PERFIL del cliente: header + historial de % (vigencias) + resumen MES A MES (cargas/fee/pagos/profit reales).
  app.get('/api/os/clientes/:id/perfil', wrap(async (req, res) => {
    const c = clientes.get(req.params.id); if (!c) return err(res, 404, 'cliente no encontrado');
    const nMeses = Math.min(Math.max(Number(req.query.meses) || 6, 1), 12);
    const baseActual = historial.getVigente('cliente', c.id, 'precio_base_pct');
    const histPct = historial.listValores('cliente', c.id, 'precio_base_pct');
    const auditPct = historial.listHistorial({ entidad_tipo: 'cliente', entidad_id: c.id, campo: 'precio_base_pct' });
    const deuda = deudaSvc.cuentaCorriente(c.id);
    const cPaneles = paneles.list({ cliente_id: c.id }).filter((p) => p.conexion_id && p.id_usuario);
    // lista de meses (actual hacia atrás)
    const mesesList = [];
    let [y, m] = mesTZ().split('-').map(Number);
    for (let i = 0; i < nMeses; i++) { mesesList.push(`${y}-${String(m).padStart(2, '0')}`); m--; if (m < 1) { m = 12; y--; } }
    const filas = [];
    for (const mes of mesesList) {
      const [yy, mm] = mes.split('-').map(Number);
      const lastDay = new Date(yy, mm, 0).getDate();
      const from = `${mes}-01 00:00:00`;
      const to = (mes === mesTZ()) ? `${fechaTZ()} 23:59:59` : `${mes}-${String(lastDay).padStart(2, '0')} 23:59:59`;
      let cargas = '0', profit = '0';
      const byConn = {}; cPaneles.forEach((p) => { (byConn[p.conexion_id] = byConn[p.conexion_id] || []).push(p); });
      for (const cid of Object.keys(byConn)) {
        const cliApi = casinoConex.client(cid); if (!cliApi) continue;
        const r = await cliApi.nodos({ from, to }); if (!r.ok) continue;
        const mp = {}; r.nodos.forEach((n) => { mp[String(n.id)] = n; });
        byConn[cid].forEach((p) => { const n = mp[String(p.id_usuario)]; if (n) { cargas = money.add(cargas, n.in || '0'); profit = money.add(profit, n.profit || '0'); } });
      }
      const baseMes = historial.getVigente('cliente', c.id, 'precio_base_pct', `${mes}-15`) || baseActual || '0';
      const fee = money.pct(cargas, baseMes);
      const pagos = money.sum(movs.list({ cliente_id: c.id, tipo: 'pago', mes }).map((mv) => mv.monto_usdt || '0'));
      filas.push({ mes, base: baseMes, cargas: money.round(cargas, 2), fee: money.round(fee, 2), pagos: money.round(pagos, 2), profit: money.round(profit, 2) });
    }
    ok(res, {
      cliente: { id: c.id, codigo: c.codigo, nombre: c.nombre || c.nombreVisible, estado: c.estado, paneles: cPaneles.length },
      base_actual: baseActual, deuda, historial_pct: histPct, auditoria_pct: auditPct, meses: filas,
    });
  }));

  // ───────── PERSONAS ─────────
  app.get('/api/os/personas', (_req, res) => ok(res, { personas: personas.list() }));
  app.post('/api/os/personas', wrap((req, res) => ok(res, { persona: personas.create(req.body || {}) })));
  app.put('/api/os/personas/:id', wrap((req, res) => {
    const p = personas.update(req.params.id, req.body || {}); if (!p) return err(res, 404, 'no encontrada'); ok(res, { persona: p });
  }));
  app.delete('/api/os/personas/:id', (req, res) => personas.remove(req.params.id) ? ok(res) : err(res, 404, 'no encontrada'));

  // ───────── PANELES ─────────
  app.get('/api/os/paneles', (req, res) => {
    const list = paneles.list({ cliente_id: req.query.cliente_id }).map((p) => ({
      ...p, precio_base_override: p.usa_config_cliente ? null : historial.getVigente('panel', p.id, 'precio_base_pct'),
    }));
    ok(res, { paneles: list });
  });
  app.post('/api/os/paneles', wrap((req, res) => ok(res, { panel: paneles.create(req.body || {}) })));
  app.put('/api/os/paneles/:id', wrap((req, res) => {
    const p = paneles.update(req.params.id, req.body || {}); if (!p) return err(res, 404, 'no encontrado'); ok(res, { panel: p });
  }));
  app.delete('/api/os/paneles/:id', (req, res) => paneles.remove(req.params.id) ? ok(res) : err(res, 404, 'no encontrado'));
  app.put('/api/os/paneles/:id/precio-base', wrap((req, res) => {
    const { valor, tipo_cambio, vigente_desde, notas } = req.body || {};
    const v = historial.setValor('panel', req.params.id, 'precio_base_pct', { valor, tipo_cambio, vigente_desde, notas });
    ok(res, { precio_base_pct: v });
  }));

  // ───────── PARTICIPACIONES ─────────
  app.get('/api/os/participaciones', (req, res) => {
    const { cliente_id, panel_id } = req.query;
    if (!cliente_id) return err(res, 400, 'cliente_id requerido');
    ok(res, {
      efectivo: participaciones.repartoEfectivo(cliente_id, panel_id || null),
      vigente: participaciones.listVigente(cliente_id, panel_id || null),
    });
  });
  app.post('/api/os/participaciones', wrap((req, res) => {
    const { cliente_id, panel_id, items, vigente_desde } = req.body || {};
    if (!cliente_id || !Array.isArray(items)) return err(res, 400, 'cliente_id + items[] requeridos');
    const r = participaciones.setReparto(cliente_id, panel_id || null, items, vigente_desde);
    ok(res, { reparto: r });
  }));
  app.get('/api/os/participaciones/historial', (req, res) =>
    ok(res, { historial: participaciones.listHistorial(req.query.cliente_id, req.query.panel_id || null) }));

  // ───────── SPLIT_BASE ─────────
  app.get('/api/os/split-base', (_req, res) => ok(res, { split_base: splitBase.list() }));
  app.put('/api/os/split-base/:pct', wrap((req, res) => ok(res, { row: splitBase.upsert(Object.assign({ pct_base: req.params.pct }, req.body || {})) })));
  app.delete('/api/os/split-base/:pct', (req, res) => splitBase.remove(req.params.pct) ? ok(res) : err(res, 404, 'no encontrado'));

  // ───────── PROVEEDORES ─────────
  app.get('/api/os/proveedores', (_req, res) => ok(res, { proveedores: proveedores.list() }));
  app.post('/api/os/proveedores', wrap((req, res) => ok(res, { proveedor: proveedores.create(req.body || {}) })));
  app.put('/api/os/proveedores/:id', wrap((req, res) => {
    const p = proveedores.update(req.params.id, req.body || {}); if (!p) return err(res, 404, 'no encontrado'); ok(res, { proveedor: p });
  }));
  app.delete('/api/os/proveedores/:id', (req, res) => proveedores.remove(req.params.id) ? ok(res) : err(res, 404, 'no encontrado'));
  app.get('/api/os/paneles/:id/proveedores', (req, res) => ok(res, { proveedores: proveedores.listPorPanel(req.params.id) }));
  app.post('/api/os/paneles/:id/proveedores', wrap((req, res) => {
    const id = proveedores.setPanelProveedor(Object.assign({ panel_id: req.params.id }, req.body || {}));
    ok(res, { id });
  }));
  app.delete('/api/os/panel-proveedores/:id', (req, res) => proveedores.removePanelProveedor(req.params.id) ? ok(res) : err(res, 404, 'no encontrado'));
  // diferencial: profits por proveedor vienen del body (AGUJERO: futura API del panel)
  app.post('/api/os/paneles/:id/diferencial', wrap((req, res) => {
    const { base, profits } = req.body || {};
    if (base === undefined) return err(res, 400, 'base requerido');
    ok(res, provSvc.calcularPanel(req.params.id, String(base), profits || {}));
  }));

  // % de proveedores POR CLIENTE (rige para TODOS sus paneles/superagentes)
  app.get('/api/os/clientes/:id/proveedores', (req, res) => ok(res, { proveedores: proveedores.catalogoParaCliente(req.params.id) }));
  app.post('/api/os/clientes/:id/proveedores', wrap((req, res) => {
    const id = proveedores.setClienteProveedor(Object.assign({ cliente_id: req.params.id }, req.body || {}));
    ok(res, { id });
  }));
  app.delete('/api/os/clientes/:id/proveedores/:proveedorId', (req, res) =>
    proveedores.removeClienteProveedor(req.params.id, req.params.proveedorId) ? ok(res) : err(res, 404, 'no encontrado'));
  // diferencial del cliente (su % rige en todos los paneles); profits por proveedor por ahora del body
  app.post('/api/os/clientes/:id/diferencial', wrap((req, res) => {
    const { base, profits } = req.body || {};
    if (base === undefined) return err(res, 400, 'base requerido');
    ok(res, provSvc.calcularCliente(req.params.id, String(base), profits || {}));
  }));

  // ───────── TIPOS DE CAMBIO ─────────
  app.get('/api/os/tc/ahora', wrap(async (_req, res) => ok(res, await tcSvc.tcAhora())));
  app.post('/api/os/tc/snapshot', wrap(async (_req, res) => {
    const r = await tcSvc.snapshotNow(); r.ok ? ok(res, { snapshot: r.snapshot }) : err(res, 502, r.error);
  }));
  app.get('/api/os/tc/snapshots', (req, res) => ok(res, { snapshots: tcStore.listSnapshots(req.query.mes) }));
  app.get('/api/os/tc/meses', (_req, res) => ok(res, { meses: tcStore.listMeses() }));
  app.put('/api/os/tc/mes/:mes', wrap((req, res) => {
    const { tc_proveedor_ext } = req.body || {};
    if (tc_proveedor_ext === undefined) return err(res, 400, 'falta tc_proveedor_ext');
    ok(res, { mes: tcStore.setTcProveedor(req.params.mes, tc_proveedor_ext) });
  }));

  // ───────── MOVIMIENTOS ─────────
  app.get('/api/os/movimientos', (req, res) => ok(res, { movimientos: movs.list({ cliente_id: req.query.cliente_id, tipo: req.query.tipo, mes: req.query.mes }) }));
  app.post('/api/os/movimientos', wrap((req, res) => ok(res, { movimiento: movs.create(req.body || {}) })));
  app.delete('/api/os/movimientos/:id', (req, res) => movs.remove(req.params.id) ? ok(res) : err(res, 404, 'no encontrado'));

  // carga COMERCIAL: calcula base→fee→USDT, registra movimiento, deuda y avisa por Telegram
  app.post('/api/os/movimientos/carga', wrap(async (req, res) => {
    const { cliente_id, panel_id, carga, divisa, tc, fecha } = req.body || {};
    const cli = clientes.get(cliente_id); if (!cli) return err(res, 404, 'cliente no encontrado');
    const pan = panel_id ? paneles.get(panel_id) : null;
    const base = basePctEfectivo(cli, pan);
    if (base == null) return err(res, 400, 'el cliente/panel no tiene precio base configurado (cargalo con vigencia)');
    if (!money.isPos(carga)) return err(res, 400, 'carga inválida');
    let tcUsado = tc;
    if (!tcUsado) { const t = await tcSvc.tcAhora(); tcUsado = t.tc; }
    if (!money.isPos(tcUsado)) return err(res, 400, 'no hay TC disponible (cargá un snapshot o pasá tc)');
    const montoDivisa = money.pct(carga, base);           // fee en ARS
    const equivUsdt = money.round(money.div(montoDivisa, tcUsado), 6); // fee en USDT = deuda generada
    const movimiento = movs.create({
      cliente_id, panel_id: panel_id || null, tipo: 'carga', monto_ars: carga, monto_usdt: equivUsdt,
      tc_momento: tcUsado, base_pct_aplicado: base, divisa: divisa || 'ARS', fecha,
    });
    const deuda = deudaSvc.cuentaCorriente(cliente_id);
    const aviso = await notify.avisarCarga(cli, {
      panel: pan ? pan.nombre : (cli.nombre || cli.codigo), carga, basePct: base, montoDivisa, divisa: divisa || 'ARS', tc: tcUsado, equivUsdt, deuda,
    });
    ok(res, { movimiento, deuda, tc: tcUsado, equivUsdt, aviso });
  }));

  // PAGO: registra el pago en USDT, recalcula saldo, avisa
  app.post('/api/os/movimientos/pago', wrap(async (req, res) => {
    const { cliente_id, monto_usdt, fecha, notas } = req.body || {};
    const cli = clientes.get(cliente_id); if (!cli) return err(res, 404, 'cliente no encontrado');
    if (!money.isPos(monto_usdt)) return err(res, 400, 'monto inválido');
    const antes = deudaSvc.cuentaCorriente(cliente_id).total;
    const movimiento = movs.create({ cliente_id, tipo: 'pago', monto_usdt, fecha, notas });
    const despues = deudaSvc.cuentaCorriente(cliente_id);
    const aviso = await notify.avisarPago(cli, { nombre: cli.nombre || cli.codigo, pago: monto_usdt, deudaAnterior: antes, saldo: despues.total });
    ok(res, { movimiento, deuda: despues, aviso });
  }));

  // ───────── HISTORIAL / AUDITORÍA ─────────
  app.get('/api/os/historial', (req, res) => ok(res, {
    historial: historial.listHistorial({ entidad_tipo: req.query.entidad_tipo, entidad_id: req.query.entidad_id, campo: req.query.campo }),
  }));

  // ───────── CASINO (conexiones api_token + lectura de nodos) ─────────
  app.get('/api/os/casino/conexiones', (_req, res) => ok(res, { conexiones: casinoConex.list() }));
  app.post('/api/os/casino/conexiones', wrap((req, res) => ok(res, { conexion: casinoConex.create(req.body || {}) })));
  app.put('/api/os/casino/conexiones/:id', wrap((req, res) => {
    const c = casinoConex.update(req.params.id, req.body || {}); if (!c) return err(res, 404, 'conexión no encontrada'); ok(res, { conexion: c });
  }));
  app.delete('/api/os/casino/conexiones/:id', (req, res) => casinoConex.remove(req.params.id) ? ok(res) : err(res, 404, 'conexión no encontrada'));
  app.post('/api/os/casino/conexiones/:id/test', wrap(async (req, res) => {
    const cli = casinoConex.client(req.params.id); if (!cli) return err(res, 404, 'conexión no encontrada');
    const r = await cli.test(); r.ok ? ok(res, { login: r.login, balances: r.balances }) : err(res, 502, r.error);
  }));
  // listar nodos: sin id = root (todos, c/total); ?id= = subárbol de ese nodo
  app.get('/api/os/casino/conexiones/:id/nodos', wrap(async (req, res) => {
    const cli = casinoConex.client(req.params.id); if (!cli) return err(res, 404, 'conexión no encontrada');
    const r = await cli.nodos({ from: req.query.from, to: req.query.to, id: req.query.id, cur: req.query.cur || 'ARS' });
    r.ok ? ok(res, { nodos: r.nodos }) : err(res, 502, r.error);
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
    const r = await cli.superagentes({ from: req.query.from, to: req.query.to, cur: req.query.cur || 'ARS' });
    r.ok ? ok(res, { superagentes: r.superagentes }) : err(res, 502, r.error);
  }));
  // Nodos POR NIVEL (cacheado) — para el asignador level-flexible SIN bajar el árbol entero (cuentas
  // GOD ven decenas de miles). Devuelve el tally de niveles + SOLO los nodos del nivel pedido (cap 2000).
  app.get('/api/os/casino/conexiones/:id/nodos-nivel', wrap(async (req, res) => {
    const cli = casinoConex.client(req.params.id); if (!cli) return err(res, 404, 'conexión no encontrada');
    const from = req.query.from || '', to = req.query.to || '', cur = req.query.cur || 'ARS';
    const nodos = await _nodosCacheados(cli, `${req.params.id}|${from}|${to}|${cur}`, from, to, cur);
    const niveles = {};
    nodos.forEach((n) => { const k = n.nivel || 'Terminal/Caja'; niveles[k] = (niveles[k] || 0) + 1; });
    const orden = Object.keys(niveles).sort((a, b) => niveles[a] - niveles[b]); // top (menos nodos) primero
    const nivel = req.query.nivel || orden.find((k) => k !== 'Terminal/Caja') || orden[0] || '';
    const filtrados = nodos.filter((n) => (n.nivel || 'Terminal/Caja') === nivel);
    const CAP = 2000;
    ok(res, { niveles, nivel, total: filtrados.length, truncado: filtrados.length > CAP, nodos: filtrados.slice(0, CAP) });
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
    const r = await cli.reporte({ groupBy: req.query.group || 'superagent', from: req.query.from, to: req.query.to, currency: req.query.cur || 'ARS' });
    r.ok ? ok(res, { groupBy: r.groupBy, filas: r.filas }) : err(res, 502, r.error);
  }));

  // REPORTE DE PROVEEDORES: profit/bet/win/rtp por proveedor, en UNA o VARIAS monedas, vista
  // 'general' (toda la plataforma) o 'superagent'. on_bets + reports_group_by=provider_label.
  // ?view=general|superagent  ?currencies=ARS,USD,BRL  ?from=&to=  ?template=
  app.get('/api/os/casino/conexiones/:id/reporte-proveedores', wrap(async (req, res) => {
    const cli = casinoConex.client(req.params.id); if (!cli) return err(res, 404, 'conexión no encontrada');
    const ug = req.query.view === 'superagent' ? 'superagent' : ''; // default: general
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
    const cli = casinoConex.client(req.params.id); if (!cli) return err(res, 404, 'conexión no encontrada');
    const mes = req.query.mes || mesTZ();
    const group = req.query.group || 'superagent';
    const cur = req.query.cur || 'ARS';
    const [y, m] = mes.split('-').map(Number);
    const lastDay = new Date(y, m, 0).getDate();
    const hoy = fechaTZ();
    const dias = [];
    for (let d = 1; d <= lastDay; d++) { const ds = `${mes}-${String(d).padStart(2, '0')}`; if (ds <= hoy) dias.push(ds); }
    await cli.test(); // login 1 vez (las reporte() reusan la cookie)
    const porDia = {};
    const runDay = (d) => cli.reporte({ groupBy: group, from: `${d} 00:00:00`, to: `${d} 23:59:59`, currency: cur }).then((r) => ({ d, r })).catch((e) => ({ d, r: { ok: false, error: e.message } }));
    const CONC = 3;
    let errDias = [];
    for (let i = 0; i < dias.length; i += CONC) {
      const rs = await Promise.all(dias.slice(i, i + CONC).map(runDay));
      rs.forEach(({ d, r }) => { if (r.ok) porDia[d] = r.filas; else errDias.push(d); });
    }
    // reintento secuencial de los días que fallaron (timeouts transitorios del casino)
    const errores = [];
    for (const d of errDias) { const { r } = await runDay(d); if (r.ok) porDia[d] = r.filas; else { porDia[d] = []; errores.push(d + ': ' + r.error); } }
    const saMap = {};
    Object.values(porDia).forEach((fs) => fs.forEach((f) => { saMap[f.id] = f.login; }));
    const superagentes = Object.keys(saMap).map((id) => ({ id, login: saMap[id] }));
    const matriz = {}; const totales = {};
    superagentes.forEach((s) => { totales[s.id] = { in: 0, out: 0, profit: 0 }; });
    dias.forEach((d) => {
      matriz[d] = {};
      (porDia[d] || []).forEach((f) => {
        matriz[d][f.id] = { in: f.in, out: f.out, profit: f.profit };
        totales[f.id].in += f.in; totales[f.id].out += f.out; totales[f.id].profit += f.profit;
      });
    });
    Object.keys(totales).forEach((id) => { const t = totales[id]; t.rtp = t.in ? (t.out / t.in * 100) : 0; });
    ok(res, { mes, group, dias, superagentes, matriz, totales, errores });
  }));

  // ───────── ACUMULADO (solapa que se llena día a día — datos GUARDADOS) ─────────
  // Ver el acumulado del mes (rápido, desde la DB; no consulta el casino).
  app.get('/api/os/casino/conexiones/:id/acumulado', (req, res) => {
    ok(res, reporteDiarioStore.getMatriz(req.params.id, req.query.group || 'superagent', req.query.mes || mesTZ()));
  });
  // Ver el acumulado del mes de TODAS las conexiones juntas (todos los GOD en simultáneo).
  app.get('/api/os/casino/acumulado-todos', (req, res) => {
    ok(res, reporteDiarioStore.getMatrizTodos(req.query.group || 'superagent', req.query.mes || mesTZ()));
  });
  // Capturar HOY (o un día) en TODAS las conexiones activas a la vez.
  app.post('/api/os/casino/capturar-hoy-todos', wrap(async (req, res) => {
    const dia = req.query.dia || (req.body && req.body.dia) || fechaTZ();
    const group = req.query.group || (req.body && req.body.group) || 'superagent';
    const out = [];
    for (const cx of casinoConex.list()) {
      if (!cx.activa) continue;
      try { const r = await acumSvc.captureDia(cx.id, dia, group); out.push({ conexion: cx.nombre, ...r }); }
      catch (e) { out.push({ conexion: cx.nombre, ok: false, error: e.message }); }
    }
    ok(res, { conexiones: out, capturados: out.filter((x) => x.ok).length });
  }));
  // Backfill de TODAS las conexiones activas a la vez (secuencial por conexión).
  app.post('/api/os/casino/capturar-mes-todos', wrap(async (req, res) => {
    const mes = req.query.mes || (req.body && req.body.mes) || mesTZ();
    const group = req.query.group || (req.body && req.body.group) || 'superagent';
    const out = [];
    for (const cx of casinoConex.list()) {
      if (!cx.activa) continue;
      try { const r = await acumSvc.captureMes(cx.id, mes, group); out.push({ conexion: cx.nombre, ...r }); }
      catch (e) { out.push({ conexion: cx.nombre, ok: false, error: e.message }); }
    }
    ok(res, { conexiones: out });
  }));
  // Capturar UN día (manual) y guardarlo en el acumulado.
  app.post('/api/os/casino/conexiones/:id/capturar', wrap(async (req, res) => {
    const dia = req.query.dia || (req.body && req.body.dia) || fechaTZ();
    const group = req.query.group || (req.body && req.body.group) || 'superagent';
    const r = await acumSvc.captureDia(req.params.id, dia, group);
    r.ok ? ok(res, { dia: r.dia, filas: r.filas }) : err(res, 502, r.error);
  }));
  // Backfill: capturar todos los días del mes (hasta hoy) y guardarlos.
  app.post('/api/os/casino/conexiones/:id/capturar-mes', wrap(async (req, res) => {
    const mes = req.query.mes || (req.body && req.body.mes) || mesTZ();
    const group = req.query.group || (req.body && req.body.group) || 'superagent';
    const r = await acumSvc.captureMes(req.params.id, mes, group);
    r.ok ? ok(res, { capturados: r.capturados, errores: r.errores }) : err(res, 502, r.error);
  }));

  // ───────── PANEL ↔ CASINO (stats reales por nodo linkeado) ─────────
  app.get('/api/os/paneles/:id/casino', wrap(async (req, res) => {
    const p = paneles.get(req.params.id); if (!p) return err(res, 404, 'panel no encontrado');
    if (!p.conexion_id || !p.id_usuario) return err(res, 400, 'el panel no está linkeado a un nodo del casino');
    const cli = casinoConex.client(p.conexion_id); if (!cli) return err(res, 404, 'conexión no encontrada');
    const r = await cli.totalNodo({ nodeId: p.id_usuario, from: req.query.from, to: req.query.to });
    r.ok ? ok(res, { nodo: r.nodo }) : err(res, 502, r.error);
  }));

  // ───────── FACTURACIÓN (cierre con datos REALES del casino) ─────────
  // Para cada cliente con paneles linkeados: trae el `in` (carga) y `profit` reales del casino y
  // calcula el fee = base% × carga. Una llamada al casino por conexión (eficiente).
  app.get('/api/os/facturacion', wrap(async (req, res) => {
    const mes = req.query.mes || mesTZ();
    const from = req.query.from || `${mes}-01 00:00:00`;
    const to = req.query.to || `${fechaTZ()} 23:59:59`;
    const linked = paneles.list().filter((p) => p.conexion_id && p.id_usuario);
    const byConn = {};
    linked.forEach((p) => { (byConn[p.conexion_id] = byConn[p.conexion_id] || []).push(p); });
    const nodeMap = {}; const errores = [];
    for (const cid of Object.keys(byConn)) {
      const cli = casinoConex.client(cid); if (!cli) { errores.push(`conexión ${cid} no disponible`); continue; }
      const r = await cli.nodos({ from, to });
      if (!r.ok) { errores.push(`conexión ${cid}: ${r.error}`); continue; }
      const m = {}; r.nodos.forEach((n) => { m[String(n.id)] = n; }); nodeMap[cid] = m;
    }
    const tcMes = tcStore.getMes(mes);
    const tc = (tcMes && tcMes.tc_cliente) || tcStore.ultimoTC() || null;
    const out = []; let totIn = '0', totProfit = '0', totFee = '0';
    for (const c of clientes.list().clientes) {
      const cps = linked.filter((p) => p.cliente_id === c.id);
      if (!cps.length) continue;
      let cIn = '0', cProfit = '0', cFee = '0'; const panelRows = [];
      for (const p of cps) {
        const node = (nodeMap[p.conexion_id] || {})[String(p.id_usuario)];
        const inAmt = node ? node.in : '0';
        const profit = node ? node.profit : '0';
        const base = basePctEfectivo(c, p) || '0';
        const fee = money.pct(inAmt, base);
        cIn = money.add(cIn, inAmt); cProfit = money.add(cProfit, profit); cFee = money.add(cFee, fee);
        panelRows.push({ panel: p.nombre, nodo: p.id_usuario, base, in: money.round(inAmt, 2), profit: money.round(profit, 2), fee: money.round(fee, 2), encontrado: !!node });
      }
      out.push({
        cliente_id: c.id, codigo: c.codigo, nombre: c.nombre || c.nombreVisible,
        in: money.round(cIn, 2), profit: money.round(cProfit, 2), fee_ars: money.round(cFee, 2),
        fee_usdt: tc ? money.round(money.div(cFee, tc), 2) : null, paneles: panelRows,
      });
      totIn = money.add(totIn, cIn); totProfit = money.add(totProfit, cProfit); totFee = money.add(totFee, cFee);
    }
    ok(res, {
      mes, from, to, tc,
      totales: { in: money.round(totIn, 2), profit: money.round(totProfit, 2), fee_ars: money.round(totFee, 2), fee_usdt: tc ? money.round(money.div(totFee, tc), 2) : null },
      clientes: out, errores,
    });
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
  // DISTRIBUCIÓN del profit (empresa / LATAM / socios) EN TIEMPO REAL, según las cargas del período.
  app.get('/api/os/reportes/distribucion', (req, res) => {
    const mes = req.query.mes || mesTZ();
    const cargas = movs.list({ mes, tipo: 'carga' });
    const nombres = {}; require('./personas-store').list().forEach((p) => { nombres[p.id] = p.nombre; });
    let empresa = '0', latam = '0', sinSplit = '0';
    const porSocio = {}, porCliente = {};
    for (const m of cargas) {
      const carga = m.monto_ars || '0';
      const base = m.base_pct_aplicado;
      const tc = (m.tc_momento && money.isPos(m.tc_momento)) ? m.tc_momento : '1';
      const feeUsdt = m.monto_usdt || money.div(money.pct(carga, base || '0'), tc);
      const k = m.cliente_id || '—';
      porCliente[k] = porCliente[k] || { cliente_id: k, empresa: '0', latam: '0', fee: '0' };
      porCliente[k].fee = money.add(porCliente[k].fee, feeUsdt);
      const el = splitSvc.empresaLatam(base, carga);
      if (!el.ok) { sinSplit = money.add(sinSplit, feeUsdt); continue; } // base <8 = caso individual
      const empUsdt = money.div(el.empresa, tc);
      const latUsdt = money.div(el.latam, tc);
      empresa = money.add(empresa, empUsdt);
      latam = money.add(latam, latUsdt);
      porCliente[k].empresa = money.add(porCliente[k].empresa, empUsdt);
      porCliente[k].latam = money.add(porCliente[k].latam, latUsdt);
      const fecha = (m.fecha || '').slice(0, 10) || fechaTZ();
      const rep = participaciones.repartoEfectivo(m.cliente_id, m.panel_id, fecha);
      splitSvc.distribuirLatam(latUsdt, rep.items).forEach((d) => {
        porSocio[d.persona_id] = money.add(porSocio[d.persona_id] || '0', d.monto);
      });
    }
    const socios = Object.keys(porSocio).map((id) => ({ persona_id: id, nombre: nombres[id] || id, monto: money.round(porSocio[id], 2) }))
      .sort((a, b) => Number(b.monto) - Number(a.monto));
    const clientes = Object.values(porCliente).map((c) => ({ cliente_id: c.cliente_id, empresa: money.round(c.empresa, 2), latam: money.round(c.latam, 2), fee: money.round(c.fee, 2) }));
    ok(res, {
      mes, empresa: money.round(empresa, 2), latam: money.round(latam, 2),
      total: money.round(money.add(empresa, latam), 2), sin_split: money.round(sinSplit, 2),
      socios, clientes,
      _nota: 'En USDT, calculado de las cargas del mes. "sin_split" = cargas con base <8% (caso individual).',
    });
  });

  // Diario: STUB (depende de la API del panel)
  app.get('/api/os/reportes/diario', (req, res) => ok(res, {
    fecha: req.query.fecha || fechaTZ(), pendiente: true,
    _nota: 'Reporte diario (IN/OUT/Profit/RTP + alertas) requiere la API del panel — Fase 5',
  }));

  console.log('[OS] rutas comerciales/financieras montadas (/api/os/*)');
}

module.exports = { mount, basePctEfectivo };
