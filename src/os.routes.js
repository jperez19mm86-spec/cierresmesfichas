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
const deudaSvc = require('./deuda.service');
const tcSvc = require('./tc.service');
const tcDivisas = require('./tc-divisas.service');
const notify = require('./notify.service');
const casinoConex = require('./casino-conexiones-store');
const acumSvc = require('./acumulado.service');
const reporteDiarioStore = require('./reporte-diario-store');
const pedidosStore = require('./pedidos-store');
const cierreStore = require('./cierre-store');
const arbolSvc = require('./arbol.service');
const externosSvc = require('./externos.service');
const tcUnico = require('./tc-unico.service');
const revision = require('./revision.service');
const estadMes = require('./estadisticas-mes.service');
const clientesCascada = require('./clientes-cascada');
const cierreMesSvc = require('./cierre-mes.service');
const ganCache = require('./ganancias-cache');
const divisasStore = require('./divisas-store');
const configStore = require('./config-store');
const importSheet = require('./import-sheet.service');
const { db } = require('./db');
const money = require('./lib/money');
const { fechaTZ, mesTZ, fechaUTC, mesUTC } = require('./lib/fechas'); // fechaTZ/mesTZ=ART (billing) · fechaUTC/mesUTC=UTC (casino)

const ok = (res, extra = {}) => res.json(Object.assign({ ok: true }, extra));
const err = (res, code, msg) => res.status(code).json({ ok: false, error: msg });
const wrap = (fn) => async (req, res) => { try { await fn(req, res); } catch (e) { err(res, 400, e.message); } };

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

/**
 * Base % efectivo de un cliente/panel PARA UN MES.
 * Es un atajo a `externosSvc.baseDelMes`, que es la única función que resuelve este número en todo
 * el sistema. Antes cada pantalla lo hacía a su manera y el mismo cliente-mes daba tres resultados.
 * Siempre hay que pasarle el mes que se está facturando; si no, factura con el % de hoy.
 */
function basePctEfectivo(cliente, panel, mes = mesTZ()) {
  return externosSvc.baseDelMes(cliente, mes, panel).valor;
}

function mount(app) {
  splitBase.seedIfEmpty();
  tcSvc.startScheduler();
  tcDivisas.startScheduler();
  acumSvc.startCron();

  // Panel del OS (HTML estático, detrás del gate de auth)
  const path = require('path');
  app.get('/os', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'os.html')));

  // ───────── CLIENTES (comercial) ─────────
  app.get('/api/os/clientes', (_req, res) => {
    const list = clientes.list().clientes.map((c) => ({
      id: c.id, codigo: c.codigo, nombre: c.nombre || c.nombreVisible, estado: c.estado,
      telegram: c.telegram, paga_proveedores: c.paga_proveedores, permite_deuda: c.permite_deuda,
      mezcla_pago_usdt: c.mezcla_pago_usdt, ajuste_usdt_pct: c.ajuste_usdt_pct,
      // v3.0 ficha
      divisa_fichas: c.divisa_fichas, moneda_cobro: c.moneda_cobro, momento_pago: c.momento_pago,
      disparador: c.disparador, tc_aplicar: c.tc_aplicar, tc_proveedor: c.tc_proveedor,
      // v3.0 §7-10 (planilla). Si no viajan acá, el modal los renderiza vacíos y al Guardar los pisa con null.
      mover_balance: c.mover_balance, margen_externos_pct: c.margen_externos_pct,
      es_vendedor: c.es_vendedor, vendedor_id: c.vendedor_id, externos_modo: c.externos_modo, saldo_inicial: c.saldo_inicial,
      saldo_inicial_divisa: c.saldo_inicial_divisa, saldo_inicial_mov_id: c.saldo_inicial_mov_id,
      precio_base_pct: historial.getVigente('cliente', c.id, 'precio_base_pct'),
      paneles: paneles.list({ cliente_id: c.id }).length,
      deuda: deudaSvc.cuentaCorriente(c.id),
    }));
    ok(res, { clientes: list });
  });

  // ───────── CATÁLOGO DE DIVISAS (v3.0) ─────────
  app.get('/api/os/divisas', (req, res) => ok(res, { divisas: req.query.activas === '1' ? divisasStore.listActivas() : divisasStore.list() }));
  app.post('/api/os/divisas', wrap((req, res) => { const b = req.body || {}; ok(res, { divisa: divisasStore.upsert({ codigo: b.codigo, nombre: b.nombre, activa: b.activa }) }); }));
  app.put('/api/os/divisas/:codigo/activa', wrap((req, res) => ok(res, { ok: divisasStore.setActiva(req.params.codigo, !!(req.body && req.body.activa)) })));
  app.delete('/api/os/divisas/:codigo', (req, res) => divisasStore.remove(req.params.codigo) ? ok(res) : err(res, 404, 'no encontrada'));

  // ───────── MEDIOS DE PAGO GLOBALES (v3.0): CVU + dirección USDT + notas ─────────
  const PAGOS_KEYS = ['cvuVigente', 'cvuNota', 'usdtAddress', 'usdtRed', 'usdtNota'];
  app.get('/api/os/config/pagos', (_req, res) => { const o = {}; PAGOS_KEYS.forEach((k) => { o[k] = configStore.getCfg(k) || ''; }); ok(res, { pagos: o }); });
  app.put('/api/os/config/pagos', wrap((req, res) => { const b = req.body || {}; PAGOS_KEYS.forEach((k) => { if (b[k] !== undefined) configStore.setCfg(k, String(b[k])); }); const o = {}; PAGOS_KEYS.forEach((k) => { o[k] = configStore.getCfg(k) || ''; }); ok(res, { pagos: o }); }));

  // ALTA de cliente desde el OS (código + nombre). Los campos comerciales se editan luego.
  app.post('/api/os/clientes', wrap((req, res) => {
    const codigo = String((req.body && req.body.codigo) || '').trim();
    const nombre = String((req.body && req.body.nombre) || '').trim();
    if (!codigo) return err(res, 400, 'falta el código del cliente');
    const c = clientesCascada.crear({ codigo, nombre }); // + su columna en la matriz del Cierre
    ok(res, { cliente: c });
  }));
  // BAJA de cliente (cascada: borra sus paneles, % de proveedores, participaciones, config y movimientos).
  app.delete('/api/os/clientes/:id', (req, res) =>
    clientesCascada.borrar(req.params.id) ? ok(res) : err(res, 404, 'cliente no encontrado'));
  app.put('/api/os/clientes/:id/comercial', wrap((req, res) => {
    const antes = clientes.get(req.params.id);
    const c = clientes.updateComercial(req.params.id, req.body || {});
    if (!c) return err(res, 404, 'cliente no encontrado');
    // Renombrar ARRASTRA su columna de la matriz y su % base por mes: la matriz se referencia por
    // NOMBRE, así que sin esto el cliente pierde todos sus % en silencio.
    clientesCascada.arrastrarRenombre(antes, c);
    ok(res, { cliente: c });
  }));
  // Chequeo de coherencia: columnas de la matriz sin cliente, y clientes sin columna.
  app.get('/api/os/cierre/coherencia', (_req, res) => ok(res, cierreStore.inconsistencias()));
  // 🩺 TODO lo que puede hacer que un mes salga con un número equivocado, en una sola respuesta.
  app.get('/api/os/revision', (req, res) => ok(res, revision.revisar(req.query.mes)));
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
    // Cargas/profit del acumulado GUARDADO (no consulta el casino en vivo → instantáneo; el cron lo mantiene al día).
    // Para meses sin backfill aparece 0 — backfillear ese mes en el Acumulado para poblarlo.
    const GRP_DE_NIVEL = { SuperAgente: 'superagent', Distribuidor: 'distributor', Agente: 'agent' };
    const panelKeys = cPaneles.map((p) => ({ conexion_id: p.conexion_id, grp: GRP_DE_NIVEL[p.nivel_usuario] || 'superagent', sa_id: String(p.id_usuario) }));
    const filas = [];
    for (const mes of mesesList) {
      // Antes esto sumaba SOLO pesos argentinos: un cliente con paneles en pesos uruguayos aparecía
      // más chico y no había forma de notarlo. Ahora se suma cada moneda por separado y se pasa a
      // USDT con SU tipo de cambio, que es la única unidad en la que se pueden sumar entre sí.
      const porDivisa = {};
      for (const r of reporteDiarioStore.filasPanelesMes(panelKeys, mes)) {
        const d = String(r.moneda || 'ARS').toUpperCase();
        const o = porDivisa[d] = porDivisa[d] || { divisa: d, cargas: '0', profit: '0' };
        o.cargas = money.add(o.cargas, r.in_amt || '0');
        o.profit = money.add(o.profit, r.profit || '0');
      }
      const baseMes = externosSvc.baseDelMes(c, mes).valor || baseActual || '0';
      let cargas = '0', profit = '0', fee = '0'; const sinTC = [];
      for (const o of Object.values(porDivisa)) {
        const t = tcUnico.tcDelMes(o.divisa, mes);
        o.tc = t.valor; o.tcFuente = t.fuente;
        o.fee = money.pct(o.cargas, baseMes);
        if (!t.valor) { sinTC.push(o.divisa); continue; }   // sin TC no se puede sumar: se informa
        cargas = money.add(cargas, money.div(o.cargas, t.valor));
        profit = money.add(profit, money.div(o.profit, t.valor));
        fee = money.add(fee, money.div(o.fee, t.valor));
        o.cargasUsdt = money.round(money.div(o.cargas, t.valor), 2);
      }
      const pagos = money.sum(movs.list({ cliente_id: c.id, tipo: 'pago', mes }).map((mv) => mv.monto_usdt || '0'));
      filas.push({
        mes, base: baseMes, moneda: 'USDT',
        cargas: money.round(cargas, 2), fee: money.round(fee, 2),
        pagos: money.round(pagos, 2), profit: money.round(profit, 2),
        porDivisa: Object.values(porDivisa), sinTC,
      });
    }
    // Lista de plataformas (superagentes/paneles) del cliente → control de que estén todas.
    const plataformas = paneles.list({ cliente_id: c.id }).map((p) => ({
      id: p.id, nombre: p.nombre || p.usuario || '', usuario: p.usuario || '',
      sistema: p.sistema || '', nivel: p.nivel_usuario || '', id_usuario: p.id_usuario || '',
      conectada: !!(p.conexion_id && p.id_usuario),
    })).sort((a, b) => (a.sistema + a.usuario).localeCompare(b.sistema + b.usuario));
    ok(res, {
      cliente: { id: c.id, codigo: c.codigo, nombre: c.nombre || c.nombreVisible, estado: c.estado, paneles: cPaneles.length },
      base_actual: baseActual, deuda, historial_pct: histPct, auditoria_pct: auditPct, meses: filas, plataformas,
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
  // Espeja un panel del OS → CAJA operativa (para /pedir y las cargas de fichas). Idempotente por (userId, sistema).
  const _espejarCaja = (p) => {
    if (!p || !p.cliente_id || !p.id_usuario) return false;
    const c = clientes.get(p.cliente_id); if (!c) return false;
    if ((c.cajas || []).some((k) => String(k.userId) === String(p.id_usuario) && (k.sistema || '') === (p.sistema || ''))) return false;
    clientes.addCaja(p.cliente_id, { usuario: p.usuario || p.nombre, sistema: p.sistema, userId: p.id_usuario, divisas: p.divisas, montosRapidos: [], grupoId: '' });
    return true;
  };
  app.post('/api/os/paneles', wrap((req, res) => { const panel = paneles.create(req.body || {}); _espejarCaja(panel); ok(res, { panel }); }));
  app.put('/api/os/paneles/:id', wrap((req, res) => {
    const p = paneles.update(req.params.id, req.body || {}); if (!p) return err(res, 404, 'no encontrado'); _espejarCaja(p); ok(res, { panel: p });
  }));
  app.delete('/api/os/paneles/:id', (req, res) => {
    const p = paneles.get(req.params.id);
    const borrado = paneles.remove(req.params.id);
    if (borrado && p && p.cliente_id && p.id_usuario) { // remover la caja espejo
      const c = clientes.get(p.cliente_id);
      const k = c && (c.cajas || []).find((x) => String(x.userId) === String(p.id_usuario) && (x.sistema || '') === (p.sistema || ''));
      if (k) clientes.removeCaja(p.cliente_id, k.id);
    }
    borrado ? ok(res) : err(res, 404, 'no encontrado');
  });
  // Sincroniza TODOS los paneles del OS → cajas operativas (one-shot; puebla lo ya cargado). Idempotente.
  app.post('/api/os/paneles/sync-cajas', wrap((_req, res) => {
    let creadas = 0, ya = 0;
    for (const c of clientes.list().clientes) {
      for (const p of paneles.list({ cliente_id: c.id })) { if (!p.id_usuario) continue; _espejarCaja(p) ? creadas++ : ya++; }
    }
    ok(res, { creadas, ya });
  }));
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
  // Importar el catálogo desde el REPORTE de proveedores (los que aparecen en el cierre): 1 entrada
  // por (provider|label|vendor). ?conexion=<id>|todas (default todas) — UNIÓN de conexiones activas,
  // dedupe por codigo (misma marca en Europa y Casino = 1 sola). No pisa los que ya tienen % costo.
  app.post('/api/os/proveedores/importar-reporte', wrap(async (req, res) => {
    const q = Object.assign({}, req.query, req.body || {});
    const conexion = q.conexion || 'todas';
    const to = q.to || (fechaTZ() + ' 23:59:59');
    const from = q.from || (fechaTZ(new Date(Date.now() - 45 * 864e5)) + ' 00:00:00'); // default: últimos 45 días
    const curs = String(q.currencies || 'ARS').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
    const conns = casinoConex.list();
    const ids = conexion === 'todas' ? conns.filter((c) => c.activa).map((c) => c.id) : [conexion];
    if (!ids.length) return err(res, 400, 'No hay conexiones de casino activas para importar.');
    const seen = new Map(); // codigo(label|vendor) → nombre(label) — identidad = PROVEEDOR + VENDOR
    const porConexion = [];
    for (const id of ids) {
      const cx = conns.find((c) => c.id === id);
      const cli = casinoConex.client(id);
      if (!cli) { porConexion.push({ id, nombre: cx && cx.nombre, ok: false, error: 'conexión no encontrada' }); continue; }
      const errs = []; let filas = 0;
      for (const cur of curs) {
        const r = await cli.reporteProveedores({ from, to, currency: cur, userGroupBy: '' }); // vista GENERAL (agrega por proveedor)
        if (!r.ok) { errs.push(cur + ': ' + r.error); continue; }
        for (const f of (r.filas || [])) {
          const label = String(f.label == null ? '' : f.label).trim();   // PROVEEDOR (la marca)
          const vendor = String(f.vendor == null ? '' : f.vendor).trim(); // VENDOR
          const codigo = `${label}|${vendor}`; // identidad = PROVEEDOR + VENDOR (sin el "Sistema"/provider)
          if (!codigo.replace(/[|\s]/g, '')) continue; // fila sin datos
          const nombre = label || vendor || String(f.provider == null ? '' : f.provider).trim() || codigo;
          if (!seen.has(codigo)) seen.set(codigo, nombre);
          filas++;
        }
      }
      porConexion.push({ id, nombre: cx && cx.nombre, ok: errs.length === 0, filas, error: errs.join('; ') || undefined });
    }
    const entries = [...seen.entries()].map(([codigo, nombre]) => ({ codigo, nombre }));
    // 'todas' = refresco total → limpia entradas del reporte sin % costo (identidad vieja / ya no aparecen)
    const stats = proveedores.importarCatalogo(entries, { limpiarSinCosto: conexion === 'todas' });
    ok(res, {
      from, to, ...stats, total: entries.length, porConexion,
      // para el dropdown de alta manual (shape {code,label,sub} que ya usa el front)
      proveedores: entries.map((e) => ({ code: e.codigo, label: e.nombre, sub: true })),
    });
  }));
  // ───────── CIERRE DE MES (matriz % proveedor×cliente, réplica editable de la planilla) ─────────
  app.get('/api/os/cierre/matriz', (_req, res) => ok(res, cierreStore.getMatriz()));
  app.get('/api/os/cierre/tc', (_req, res) => ok(res, cierreStore.getTC()));
  app.post('/api/os/cierre/celda', wrap((req, res) => {
    const { proveedor, cliente, pct } = req.body || {};
    ok(res, { guardado: cierreStore.setCelda(proveedor, cliente, pct) });
  }));
  // Mantenimiento de precios en lote (SL2/SZ a 0, tope, copiar la lista de un cliente a otro…).
  // Una sola transacción; devuelve cuántas celdas se escribieron.
  app.post('/api/os/cierre/celdas-lote', wrap((req, res) => {
    const cambios = (req.body || {}).cambios;
    if (!Array.isArray(cambios)) return err(res, 400, 'falta el arreglo "cambios"');
    if (cambios.length > 20000) return err(res, 400, 'demasiados cambios en una sola llamada');
    ok(res, { escritas: cierreStore.setCeldas(cambios) });
  }));
  app.post('/api/os/cierre/base', wrap((req, res) => ok(res, { guardado: cierreStore.setBase((req.body || {}).proveedor, (req.body || {}).base_pct) })));
  app.post('/api/os/cierre/descuento', wrap((req, res) => ok(res, { guardado: cierreStore.setDescuento((req.body || {}).cliente, (req.body || {}).descuento) })));
  app.post('/api/os/cierre/proveedor', wrap((req, res) => ok(res, { nombre: cierreStore.addProveedor((req.body || {}).nombre, (req.body || {}).base_pct) })));
  app.delete('/api/os/cierre/proveedor/:nombre', (req, res) => ok(res, { borrado: cierreStore.removeProveedor(req.params.nombre) }));
  app.post('/api/os/cierre/cliente', wrap((req, res) => ok(res, { nombre: cierreStore.addCliente((req.body || {}).nombre, (req.body || {}).descuento) })));
  app.delete('/api/os/cierre/cliente/:nombre', (req, res) => ok(res, { borrado: cierreStore.removeCliente(req.params.nombre) }));
  app.post('/api/os/cierre/tc', wrap((req, res) => { const b = req.body || {}; ok(res, { guardado: cierreStore.setTC(b.moneda, b.mes, b.tasa) }); }));
  app.post('/api/os/cierre/importar', wrap((req, res) => ok(res, cierreStore.importar(req.body || {}))));
  // vinculación proveedor del casino ↔ matriz
  app.get('/api/os/cierre/cliente/:nombre', (req, res) => ok(res, cierreStore.getClienteColumna(req.params.nombre)));
  app.get('/api/os/cierre/links', (_req, res) => ok(res, cierreStore.getLinks()));
  app.post('/api/os/cierre/link', wrap((req, res) => { const b = req.body || {}; ok(res, { guardado: cierreStore.setLink(b.casino, b.matriz) }); }));
  app.post('/api/os/cierre/auto-vincular', wrap((_req, res) => ok(res, cierreStore.autoVincular())));
  // Agrega a la matriz TODOS los proveedores del casino que falten (fila sin % base).
  app.post('/api/os/cierre/agregar-faltantes', wrap((_req, res) => ok(res, cierreStore.agregarFaltantesDeCatalogo())));
  // Vendors SL/XG (o los que se pasen) → celda = descuento del cliente (%neto 0). ?vendors=SL,XG
  app.post('/api/os/cierre/vendors-a-descuento', wrap((req, res) => {
    const vendors = req.query.vendors ? String(req.query.vendors).split(',').map((s) => s.trim()).filter(Boolean) : ['SL', 'XG'];
    ok(res, cierreStore.igualarVendorsADescuento(vendors));
  }));

  // El % de proveedor POR CLIENTE vive en la MATRIZ del Cierre (cierre_pct), que es la que usa
  // Proveedores externos. Acá vivía un SEGUNDO motor que calculaba lo mismo con otros porcentajes,
  // leyendo tablas propias (cliente_proveedores / panel_proveedores). No lo llamaba ninguna pantalla
  // y tener dos respuestas para la misma pregunta es justo lo que hay que evitar, así que se fue.
  // Las tablas quedan en la base por si hay que mirarlas, pero ya no las lee nadie.


  // ───────── 📸 LA FOTO DEL MES ─────────
  // Un mes cerrado ya no cambia: se le pregunta al casino UNA vez y después todos los reportes
  // salen de la base. Antes cada reporte eran 525 consultas en vivo; ahora son 180, una vez al mes.
  app.get('/api/os/estadisticas/estado', (req, res) => ok(res, estadMes.estado(req.query.mes || mesTZ())));
  app.get('/api/os/estadisticas/meses', (_req, res) => ok(res, { meses: estadMes.meses() }));
  app.get('/api/os/estadisticas/plan', (req, res) => ok(res, { plan: estadMes.plan(req.query.mes || mesTZ()) }));
  app.post('/api/os/estadisticas/capturar', wrap(async (req, res) => {
    const b = req.body || {};
    const r = await estadMes.capturar({ mes: b.mes, conexionId: b.conexion_id || null, refrescar: !!b.refrescar });
    r.ok ? ok(res, r) : err(res, 400, r.error);
  }));
  app.delete('/api/os/estadisticas/:mes', (req, res) => { estadMes.borrarMes(req.params.mes); ok(res); });
  // ───────── TIPOS DE CAMBIO ─────────
  app.get('/api/os/tc/ahora', wrap(async (_req, res) => ok(res, await tcSvc.tcAhora())));
  app.post('/api/os/tc/snapshot', wrap(async (_req, res) => {
    const r = await tcSvc.snapshotNow(); r.ok ? ok(res, { snapshot: r.snapshot }) : err(res, 502, r.error);
  }));
  app.get('/api/os/tc/snapshots', (req, res) => ok(res, { snapshots: tcStore.listSnapshots(req.query.mes) }));
  app.get('/api/os/tc/meses', (_req, res) => ok(res, { meses: tcStore.listMeses() }));
  // EL tipo de cambio de un mes, resuelto con la regla única + dónde las fuentes no coinciden.
  app.get('/api/os/tc/del-mes', (req, res) => {
    const mes = req.query.mes || mesTZ();
    if (req.query.divisa) return ok(res, tcUnico.tcDelMes(req.query.divisa, mes));
    ok(res, { mes, ars: tcUnico.tcDelMes('ARS', mes), discrepancias: tcUnico.discrepancias(mes) });
  });

  // ── TC del resto de las divisas (ARS sale de Binance, arriba) ──
  // Snapshot diario automático; acá se puede forzar y consultar el promedio del mes.
  app.post('/api/os/tc/divisas/snapshot', wrap(async (req, res) => {
    const r = await tcDivisas.snapshotHoy(req.body && req.body.fecha);
    r.ok ? ok(res, { fecha: r.fecha, divisas: r.divisas }) : err(res, 502, r.error);
  }));
  app.get('/api/os/tc/divisas/promedios', (req, res) => {
    const mes = req.query.mes || new Date().toISOString().slice(0, 7);
    const lista = tcDivisas.promediosMes(mes);
    // ARS no sale de esta fuente: se toma el promedio de los snapshots de Binance
    const ars = tcStore.promedioMes(mes);
    if (ars) lista.unshift({ divisa: 'ARS', dias: tcStore.listSnapshots(mes).length, promedio: ars, fuente: 'binance/criptoya' });
    ok(res, { mes, promedios: lista });
  });
  app.get('/api/os/tc/divisas/dias', (req, res) => {
    const mes = req.query.mes || new Date().toISOString().slice(0, 7);
    ok(res, { mes, dias: tcDivisas.listDias(mes, req.query.divisa) });
  });
  app.put('/api/os/tc/mes/:mes', wrap((req, res) => {
    const { tc_proveedor_ext } = req.body || {};
    if (tc_proveedor_ext === undefined) return err(res, 400, 'falta tc_proveedor_ext');
    ok(res, { mes: tcStore.setTcProveedor(req.params.mes, tc_proveedor_ext) });
  }));

  // ───────── CONGELAR LA MATRIZ DE UN MES ─────────
  // Los precios cambian (costo del proveedor y % del cliente). Sin congelar, tocar un precio hoy
  // cambia lo que calcula un mes YA FACTURADO y deja de poder auditarse.
  app.get('/api/os/cierre/meses-congelados', (_req, res) => ok(res, { meses: cierreMesSvc.listar() }));
  app.get('/api/os/cierre/mes/:mes/congelado', (req, res) => {
    const g = cierreMesSvc.get(req.params.mes);
    // ?full=1 devuelve TAMBIÉN las celdas: hace falta para poder auditar un mes ya cerrado.
    const full = req.query.full === '1' && g;
    ok(res, { congelado: !!g, mes: req.params.mes, createdAt: g ? g.createdAt : null, notas: g ? g.notas : null,
      proveedores: g ? (g.proveedores || []).length : 0, links: g ? (g.links || []).length : 0,
      celdas: full ? g.celdas : undefined, listaProveedores: full ? g.proveedores : undefined });
  });
  app.post('/api/os/cierre/mes/:mes/congelar', wrap((req, res) => {
    const b = req.body || {};
    const r = cierreMesSvc.congelar(req.params.mes, { notas: b.notas, matriz: b.matriz || null, pisar: !!b.pisar });
    r.ok ? ok(res, r) : err(res, r.yaExiste ? 409 : 400, r.error);
  }));
  app.delete('/api/os/cierre/mes/:mes/congelar', (req, res) => {
    const r = cierreMesSvc.descongelar(req.params.mes);
    r.ok ? ok(res, r) : err(res, 404, 'ese mes no estaba congelado');
  });

  // El casino tarda 50-120s por reporte. Las ganancias quedan cacheadas: un mes cerrado no cambia.
  app.get('/api/os/externos/_cache', (_req, res) => ok(res, { meses: ganCache.resumen(), vigenciaMesEnCursoMin: ganCache.VIGENCIA_MIN }));
  // Llenar el cache de a UN panel: el reporte entero se pasa del timeout, pero un panel solo entra
  // holgado. El front (o un script) recorre los paneles del cliente y despues pide el reporte, que
  // ya sale instantaneo porque esta todo cacheado.
  app.post('/api/os/externos/_cache/panel', wrap(async (req, res) => {
    const b = req.body || {};
    const p = paneles.get(b.panel_id);
    if (!p) return err(res, 404, 'panel no encontrado');
    const mes = b.mes || new Date().toISOString().slice(0, 7);
    const cx = casinoConex.list().find((c) => c.id === p.conexion_id)
      || casinoConex.list().find((c) => String(c.nombre).toLowerCase() === String(p.sistema).toLowerCase());
    if (!cx) return err(res, 400, 'el panel no tiene conexion de casino');
    const cli = casinoConex.client(cx.id);
    if (!cli) return err(res, 502, 'la conexion no responde');
    const [y, m] = mes.split('-').map(Number);
    const ult = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const from = mes + '-01', to = mes + '-' + String(ult).padStart(2, '0');
    const divisas = (b.divisa ? [b.divisa] : ((p.divisas || []).length ? p.divisas : ['ARS']));
    const hechas = [];
    for (const d of divisas) {
      if (!b.refrescar && ganCache.get(cx.id, p.id_usuario, mes, d)) { hechas.push({ divisa: d, deCache: true }); continue; }
      const r = await cli.reporteProveedoresNodo({ nodoId: p.id_usuario, from, to, currency: d });
      if (r.ok) { ganCache.set(cx.id, p.id_usuario, mes, d, r.filas); hechas.push({ divisa: d, filas: r.filas.length }); }
      else hechas.push({ divisa: d, error: r.error });
    }
    ok(res, { panel: p.nombre, mes, divisas: hechas });
  }));
  app.delete('/api/os/externos/_cache', (req, res) => ok(res, ganCache.limpiar(req.query.mes || null)));

  // ───────── §9 PROVEEDORES EXTERNOS ─────────
  // Cuánto hay que cobrarle a un cliente por los proveedores que cuestan más que su % base.
  app.get('/api/os/externos/:cliente', wrap(async (req, res) => {
    const mes = req.query.mes || new Date().toISOString().slice(0, 7);
    const r = await externosSvc.reporte({ clienteNombre: req.params.cliente, mes, basePct: req.query.base, refrescar: req.query.refrescar === '1' });
    // 409 + faltaBase → el front pregunta "este cliente trabaja al X%, ¿es correcto?" antes de calcular
    if (!r.ok) return res.status(r.faltaBase ? 409 : 404).json({ ok: false, error: r.error, faltaBase: !!r.faltaBase });
    ok(res, r);
  }));
  // El % base con el que trabajó ESE mes (se confirma antes de calcular; no toca el histórico).
  app.get('/api/os/externos/:cliente/base', (req, res) => {
    const mes = req.query.mes || new Date().toISOString().slice(0, 7);
    const g = externosSvc.baseGuardada(req.params.cliente, mes);
    const cli = clientes.list().clientes.find((c) => String(c.nombre).toLowerCase() === String(req.params.cliente).toLowerCase());
    // el sugerido sale de la misma función que usan Facturación, Reparto y Perfil
    const r = cli ? externosSvc.baseDelMes(cli, mes) : { valor: null, fuente: 'SIN CARGAR' };
    const vig = r.valor;
    ok(res, {
      mes, confirmada: !!g, baseFuente: r.fuente,
      base: g ? g.base_pct : (vig != null ? String(vig) : null),
      confirmadoAt: g ? g.confirmadoAt : null,
      deLaFicha: vig != null ? String(vig) : null,
    });
  });
  app.post('/api/os/externos/:cliente/base', wrap((req, res) => {
    const { mes, base_pct } = req.body || {};
    if (!mes) return err(res, 400, 'falta mes');
    if (base_pct === undefined || base_pct === null || base_pct === '') return err(res, 400, 'falta base_pct');
    ok(res, { confirmada: externosSvc.confirmarBase(req.params.cliente, mes, base_pct) });
  }));
  // Resumen de TODOS los clientes del mes (para ver el total y quién falta confirmar).
  app.get('/api/os/externos', wrap(async (req, res) => {
    const mes = req.query.mes || new Date().toISOString().slice(0, 7);
    const soloVendedor = req.query.vendedor || null;
    const lista = clientes.list().clientes
      .filter((c) => !soloVendedor || String(c.vendedor_id) === String(soloVendedor))
      .map((c) => {
        const g = externosSvc.baseGuardada(c.nombre, mes);
        return {
          cliente: c.nombre, id: c.id, esVendedor: !!c.es_vendedor, vendedor_id: c.vendedor_id || null,
          base: g ? g.base_pct : (c.precio_base_pct != null ? String(c.precio_base_pct) : null),
          confirmada: !!g, margenExtra: c.margen_externos_pct ?? null,
        };
      });
    ok(res, { mes, clientes: lista });
  }));

  // ───────── MOVIMIENTOS ─────────
  app.get('/api/os/movimientos', (req, res) => ok(res, { movimientos: movs.list({ cliente_id: req.query.cliente_id, tipo: req.query.tipo, mes: req.query.mes }) }));
  app.post('/api/os/movimientos', wrap((req, res) => ok(res, { movimiento: movs.create(req.body || {}) })));
  app.delete('/api/os/movimientos/:id', (req, res) => movs.remove(req.params.id) ? ok(res) : err(res, 404, 'no encontrado'));

  // ───────── IMPORTAR LA PLANILLA "BASE DE DATOS CLIENTES" (v3.0) ─────────
  // Flujo obligado: previsualizar → revisar → aplicar con el hash de esa previsualización.
  // Nada se escribe sin haber mirado antes qué cambia, y siempre queda el snapshot para deshacer.
  app.get('/api/os/import/snapshot', (_req, res) => ok(res, { snapshot: importSheet.snapshot() }));

  app.post('/api/os/import/sheet', wrap(async (req, res) => {
    const { sheetId, dryRun, confirmHash, incluirBasePct, incluirTelegram } = req.body || {};
    const opts = { sheetId: sheetId || importSheet.SHEET_ID_DEFAULT, incluirBasePct: !!incluirBasePct, incluirTelegram: !!incluirTelegram };
    if (dryRun !== false) return ok(res, { plan: await importSheet.planificar(opts) });
    const r = await importSheet.aplicar({ ...opts, confirmHash, historial });
    ok(res, { resultado: r });
  }));

  app.post('/api/os/import/rollback', wrap((req, res) => {
    const { snapshot, force } = req.body || {};
    if (!force) return err(res, 400, 'para deshacer hay que mandar force:true');
    ok(res, { restaurado: importSheet.restaurar(snapshot) });
  }));

  // SALDO ANTERIOR (v3.0): la deuda que el cliente ya traía antes de que el sistema empiece a
  // facturar. La cuenta corriente se arma SOLO con movimientos (deuda.service.js), así que la
  // columna `saldo_inicial` por sí sola no suma nada: hay que materializarla como un movimiento
  // de tipo 'ajuste'. Guardamos su id para poder REEMPLAZARLO (no duplicarlo) si se re-aplica.
  app.post('/api/os/clientes/:id/saldo-inicial', wrap(async (req, res) => {
    const cli = clientes.get(req.params.id); if (!cli) return err(res, 404, 'cliente no encontrado');
    const { monto, divisa, tc } = req.body || {};
    const div = String(divisa || '').toUpperCase();
    if (!money.isPos(monto)) return err(res, 400, 'monto inválido');
    if (!div) return err(res, 400, 'falta la divisa del saldo anterior');

    let tcUsado = null, montoUsdt;
    if (div === 'USDT') {
      montoUsdt = money.round(monto, 6); // ya está en USDT: no se convierte
    } else {
      tcUsado = tc;
      if (!tcUsado) { const t = await tcSvc.tcAhora(); tcUsado = t.tc; }
      if (!money.isPos(tcUsado)) return err(res, 400, 'no hay TC disponible para convertir a USDT (pasá tc)');
      montoUsdt = money.round(money.div(monto, tcUsado), 6);
    }

    // Idempotente: si ya había un saldo anterior aplicado, se borra ese movimiento y se crea el nuevo.
    if (cli.saldo_inicial_mov_id) movs.remove(cli.saldo_inicial_mov_id);
    const movimiento = movs.create({
      cliente_id: cli.id, tipo: 'ajuste', monto_ars: div === 'ARS' ? monto : null, monto_usdt: montoUsdt,
      tc_momento: tcUsado, divisa: div, notas: 'saldo anterior (deuda previa al sistema)',
    });
    clientes.updateComercial(cli.id, { saldo_inicial: String(monto), saldo_inicial_divisa: div, saldo_inicial_mov_id: movimiento.id });
    ok(res, { movimiento_id: movimiento.id, monto_usdt: montoUsdt, tc: tcUsado, deuda: deudaSvc.cuentaCorriente(cli.id) });
  }));

  // carga COMERCIAL: calcula base→fee→USDT, registra movimiento, deuda y avisa por Telegram
  app.post('/api/os/movimientos/carga', wrap(async (req, res) => {
    const { cliente_id, panel_id, carga, divisa, tc, fecha } = req.body || {};
    const cli = clientes.get(cliente_id); if (!cli) return err(res, 404, 'cliente no encontrado');
    const pan = panel_id ? paneles.get(panel_id) : null;
    const base = basePctEfectivo(cli, pan, String(fecha || mesTZ()).slice(0, 7));
    if (base == null) return err(res, 400, 'el cliente/panel no tiene precio base configurado (cargalo con vigencia)');
    if (!money.isPos(carga)) return err(res, 400, 'carga inválida');
    // ⚠ el TC tiene que ser el de LA DIVISA de la carga. Antes se usaba siempre el del peso
    // argentino, así que un fee en pesos uruguayos salía ~30 veces más chico sin que se notara.
    const _div = String(divisa || 'ARS').toUpperCase();
    let tcUsado = tc;
    if (!tcUsado) {
      const t = tcUnico.tcDelMes(_div, String(fecha || mesTZ()).slice(0, 7));
      tcUsado = t.valor;
      if (!tcUsado && _div === 'ARS') { const viv = await tcSvc.tcAhora(); tcUsado = viv.tc; } // el vivo, solo para ARS
    }
    if (!money.isPos(tcUsado)) return err(res, 400, `no hay tipo de cambio para ${_div} en ese mes — cargalo en 💱 Tipos de cambio`);
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
    const r = await arbolSvc.sincronizar({ soloConexion: (req.body || {}).conexion_id || null });
    r.ok ? ok(res, r) : err(res, 502, r.error);
  }));
  // La escala de UN panel: por dónde pasan las fichas, de arriba hacia abajo.
  app.get('/api/os/paneles/:id/escala', (req, res) => {
    const p = paneles.get(req.params.id);
    if (!p) return err(res, 404, 'panel no encontrado');
    const pasos = [...(p.escala || []), { id: String(p.id_usuario), login: p.usuario || p.nombre, nivel: p.nivel_usuario, destino: true }];
    ok(res, {
      panel: { id: p.id, nombre: p.nombre, sistema: p.sistema, id_usuario: String(p.id_usuario), nivel: p.nivel_usuario },
      resueltoEn: p.arbol_at || null,
      superagente: p.sa_id ? { id: p.sa_id, login: p.sa_login } : null,
      padre: p.padre_id ? { id: p.padre_id, login: p.padre_login, nivel: p.padre_nivel } : null,
      pasos,                       // el recorrido completo, el último es el panel destino
      saltos: pasos.length - 1,    // cuántas transferencias hay que hacer
    });
  });

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

  // SONDA: corre el reporte con parámetros crudos. Solo para investigar cómo pedirle al casino que
  // abra por distribuidor; no lo usa ningún cálculo.
  app.post('/api/os/casino/conexiones/:id/sonda-reporte', wrap(async (req, res) => {
    const cli = casinoConex.client(req.params.id); if (!cli) return err(res, 404, 'conexión no encontrada');
    const b = req.body || {};
    const r = await cli.sondaReporte({ from: b.from, to: b.to, nodoId: b.nodo || null, campos: b.campos || null, params: b.params || {} });
    r.ok ? ok(res, r) : err(res, 502, r.error);
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
  // Ver el acumulado del mes de TODAS las conexiones juntas (todos los GOD en simultáneo).
  app.get('/api/os/casino/acumulado-todos', (req, res) => {
    ok(res, reporteDiarioStore.getMatrizTodos(req.query.group || 'superagent', req.query.mes || mesUTC(), req.query.moneda || 'ARS'));
  });
  // Limpia el acumulado de conexiones que ya no existen (IDs viejos) → saca superagentes duplicados.
  app.post('/api/os/casino/acumulado/limpiar-huerfanos', wrap((_req, res) => ok(res, { borradas: reporteDiarioStore.limpiarHuerfanos() })));
  // Capturar HOY (o un día) en TODAS las conexiones activas a la vez.
  app.post('/api/os/casino/capturar-hoy-todos', wrap(async (req, res) => {
    const dia = req.query.dia || (req.body && req.body.dia) || fechaUTC(); // casino corta días en UTC
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
    const mes = req.query.mes || (req.body && req.body.mes) || mesUTC(); // casino corta meses en UTC
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
    // El 'hasta' sale del MES elegido, no de hoy: si no, facturar un mes cerrado suma todo lo que
    // pasó después (pedir junio en agosto traía junio+julio+agosto en una sola línea, rotulada 'Junio').
    const _ultDia = new Date(Date.UTC(Number(mes.slice(0, 4)), Number(mes.slice(5, 7)), 0)).getUTCDate();
    const to = req.query.to || `${mes}-${String(_ultDia).padStart(2, '0')} 23:59:59`;
    const linked = paneles.list().filter((p) => p.conexion_id && p.id_usuario);
    const byConn = {};
    linked.forEach((p) => { (byConn[p.conexion_id] = byConn[p.conexion_id] || []).push(p); });
    const nodeMap = {}; const errores = [];
    for (const cid of Object.keys(byConn)) {
      const cli = casinoConex.client(cid); if (!cli) { errores.push(`conexión ${cid} no disponible`); continue; }
      // multiMoneda: la respuesta del casino YA trae todas las monedas; sin esto se leía solo la
      // columna de pesos argentinos y un cliente que factura en pesos uruguayos salía en cero.
      const r = await cli.nodos({ from, to, soloActivos: true, multiMoneda: true }); // activos: mismo total, mucho más rápido
      if (!r.ok) { errores.push(`conexión ${cid}: ${r.error}`); continue; }
      const m = {}; r.nodos.forEach((n) => { m[String(n.id)] = n; }); nodeMap[cid] = m;
    }
    const _tc = tcUnico.tcDelMes('ARS', mes);   // misma regla que Externos y Reparto
    const tc = _tc.valor;
    const out = []; let totFee = '0', totIn = '0', totProfit = '0';
    const sinBase = new Set();  // clientes sin % cargado: se informan en vez de facturarlos al 0%
    const sinTCGlobal = new Set();
    for (const c of clientes.list().clientes) {
      const cps = linked.filter((p) => p.cliente_id === c.id);
      if (!cps.length) continue;
      let cIn = '0', cProfit = '0', cFee = '0'; const panelRows = []; const porDivisaCli = {};
      for (const p of cps) {
        const node = (nodeMap[p.conexion_id] || {})[String(p.id_usuario)];
        // el % del MES que se está facturando (no el de hoy) y avisando si el cliente no tiene
        const rb = externosSvc.baseDelMes(c, mes, p);
        const base = rb.valor || '0';
        if (rb.valor == null) sinBase.add(c.nombre || c.nombreVisible || c.codigo);
        // TODO en USDT: es la única unidad en la que se pueden sumar monedas distintas.
        const montos = (node && node.montos && Object.keys(node.montos).length)
          ? node.montos
          : (node ? { ARS: { in: node.in, profit: node.profit } } : {});
        let pIn = '0', pProfit = '0', pFee = '0'; const pDiv = [];
        for (const [div, v] of Object.entries(montos)) {
          const t = tcUnico.tcDelMes(div, mes);
          const fee = money.pct(v.in || '0', base);
          if (!t.valor) { sinTCGlobal.add(div); pDiv.push({ divisa: div, in: v.in, profit: v.profit, tc: null }); continue; }
          const inU = money.div(v.in || '0', t.valor);
          const prU = money.div(v.profit || '0', t.valor);
          const feU = money.div(fee, t.valor);
          pIn = money.add(pIn, inU); pProfit = money.add(pProfit, prU); pFee = money.add(pFee, feU);
          pDiv.push({ divisa: div, in: v.in, profit: v.profit, tc: t.valor, inUsdt: money.round(inU, 2), feeUsdt: money.round(feU, 2) });
          const g = porDivisaCli[div] = porDivisaCli[div] || { divisa: div, in: '0', fee: '0', tc: t.valor };
          g.in = money.add(g.in, v.in || '0'); g.fee = money.add(g.fee, fee);
        }
        cIn = money.add(cIn, pIn); cProfit = money.add(cProfit, pProfit); cFee = money.add(cFee, pFee);
        panelRows.push({ panel: p.nombre, nodo: p.id_usuario, base, baseFuente: rb.fuente, in: money.round(pIn, 2), profit: money.round(pProfit, 2), fee: money.round(pFee, 2), porDivisa: pDiv, encontrado: !!node });
      }
      out.push({
        cliente_id: c.id, codigo: c.codigo, nombre: c.nombre || c.nombreVisible, moneda: 'USDT',
        in: money.round(cIn, 2), profit: money.round(cProfit, 2), fee_usdt: money.round(cFee, 2),
        porDivisa: Object.values(porDivisaCli).map((g) => ({ ...g, in: money.round(g.in, 2), fee: money.round(g.fee, 2) })),
        paneles: panelRows,
      });
      totIn = money.add(totIn, cIn); totProfit = money.add(totProfit, cProfit); totFee = money.add(totFee, cFee);
    }
    ok(res, {
      mes, from, to, tc, tcFuente: _tc.fuente, tcConflicto: _tc.conflicto,
      sinBase: [...sinBase], sinTC: [...sinTCGlobal], moneda: 'USDT',
      totales: { in: money.round(totIn, 2), profit: money.round(totProfit, 2), fee_usdt: money.round(totFee, 2) },
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
  // DISTRIBUCIÓN del profit (empresa / LATAM / socios) según las VENTAS DE FICHAS reales del mes.
  // Fuente = pedidos CARGADOS (compra prepaga) por cliente. fee = base% × ventas; split por la tabla
  // Split; LATAM se reparte entre socios por las participaciones vigentes. En el live, los pedidos
  // reales llenan esto solos; el % se cobra sobre lo VENDIDO, no sobre el `in` de jugadores.
  app.get('/api/os/reportes/distribucion', (req, res) => {
    const mes = req.query.mes || mesTZ();
    const fecha = `${mes}-15`; // fecha media del mes para vigencias (base + participaciones)
    const nombres = {}; personas.list().forEach((p) => { nombres[p.id] = p.nombre; });
    const _tc = tcUnico.tcDelMes('ARS', mes);   // misma regla que Facturación y Externos
    const tc = _tc.valor || '1';
    const ventas = pedidosStore.ventasCargadasMes(mes); // { codigo: { monto, ... } }
    let empresa = '0', latam = '0', sinSplit = '0', totVentas = '0';
    const porSocio = {}, porCliente = {};
    for (const c of clientes.list().clientes) {
      const vc = ventas[c.codigo];
      const carga = vc ? String(vc.monto) : '0';
      if (!money.isPos(carga)) continue;
      totVentas = money.add(totVentas, carga);
      const base = externosSvc.baseDelMes(c, mes).valor || '0';
      const feeUsdt = money.div(money.pct(carga, base), tc);
      const k = c.id;
      porCliente[k] = { cliente_id: k, codigo: c.codigo, nombre: c.nombre || c.nombreVisible, ventas: money.round(carga, 2), base, empresa: '0', latam: '0', fee: money.round(feeUsdt, 2) };
      const el = splitSvc.empresaLatam(base, carga);
      if (!el.ok) { sinSplit = money.add(sinSplit, feeUsdt); continue; } // base <8 = caso individual
      const empUsdt = money.div(el.empresa, tc);
      const latUsdt = money.div(el.latam, tc);
      empresa = money.add(empresa, empUsdt);
      latam = money.add(latam, latUsdt);
      porCliente[k].empresa = money.round(empUsdt, 2);
      porCliente[k].latam = money.round(latUsdt, 2);
      const rep = participaciones.repartoEfectivo(c.id, null, fecha);
      splitSvc.distribuirLatam(latUsdt, rep.items).forEach((d) => {
        porSocio[d.persona_id] = money.add(porSocio[d.persona_id] || '0', d.monto);
      });
    }
    const socios = Object.keys(porSocio).map((id) => ({ persona_id: id, nombre: nombres[id] || id, monto: money.round(porSocio[id], 2) }))
      .sort((a, b) => Number(b.monto) - Number(a.monto));
    const clientesArr = Object.values(porCliente);
    ok(res, {
      mes, tc, ventas_total: money.round(totVentas, 2),
      empresa: money.round(empresa, 2), latam: money.round(latam, 2),
      total: money.round(money.add(empresa, latam), 2), sin_split: money.round(sinSplit, 2),
      socios, clientes: clientesArr,
      _nota: 'En USDT, de las VENTAS DE FICHAS reales (pedidos cargados) del mes. fee = base% × ventas. "sin_split" = base <8% (caso individual).',
    });
  });

  // DEV/DEMO: sembrar VENTAS de prueba = pedidos 'cargado' directo en la DB (NO toca el casino, no hace
  // carga real). Para ver Facturación/Reparto con datos en pruebas; en el live ya están los pedidos reales.
  // body: { items:[{codigo, monto, userId?, cajaUsuario?, sistema?, divisa?}], reset?:bool }
  app.post('/api/os/_dev/seed-ventas', wrap((req, res) => {
    // seed-ventas sólo en desarrollo: con reset:true hace DELETE FROM pedidos, y los pedidos son
    // la base de lo que se le cobra a cada cliente. En producción no existe.
    if (process.env.NODE_ENV === 'production' || process.env.RAILWAY_ENVIRONMENT === 'production') {
      return err(res, 403, 'seed-ventas está deshabilitado en producción: borraría pedidos reales');
    }
    const body = req.body || {};
    if (body.reset) pedidosStore.seed({ pedidos: [] }); // limpia todos (solo entorno de pruebas)
    const items = body.items || [];
    const ids = [];
    for (const it of items) {
      const p = pedidosStore.create({
        codigo: it.codigo, clienteNombre: it.clienteNombre || it.codigo, monto: it.monto,
        userId: it.userId || '', cajaUsuario: it.cajaUsuario || '', sistema: it.sistema || '', divisa: it.divisa || 'ARS',
      });
      pedidosStore.setEstado(p.id, 'cargado', {}); // marca cargado SIN llamar al casino (es siembra)
      ids.push(p.id);
    }
    ok(res, { creados: ids.length, ids, _nota: 'Pedidos de prueba marcados "cargado" sin tocar el casino (siembra DB).' });
  }));

  // Diario: STUB (depende de la API del panel)
  app.get('/api/os/reportes/diario', (req, res) => ok(res, {
    fecha: req.query.fecha || fechaTZ(), pendiente: true,
    _nota: 'Reporte diario (IN/OUT/Profit/RTP + alertas) requiere la API del panel — Fase 5',
  }));

  console.log('[OS] rutas comerciales/financieras montadas (/api/os/*)');
}

module.exports = { mount, basePctEfectivo };
