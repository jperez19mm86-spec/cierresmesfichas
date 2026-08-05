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
const repartoSvc = require('./reparto.service');
const pagoProv = require('./pago-proveedores.service');
const deudaSvc = require('./deuda.service');
const tcSvc = require('./tc.service');
const tcDivisas = require('./tc-divisas.service');
const tcColumna = require('./tc-columna.service');
const { mesCierre: mesCierreLbl } = require('./lib/fechas');
const notify = require('./notify.service');
const casinoConex = require('./casino-conexiones-store');
const acumSvc = require('./acumulado.service');
const reporteDiarioStore = require('./reporte-diario-store');
const pulsoSvc = require('./pulso.service');
const pedidosStore = require('./pedidos-store');
const cierreStore = require('./cierre-store');
const arbolSvc = require('./arbol.service');
const externosSvc = require('./externos.service');
const tcUnico = require('./tc-unico.service');
const revision = require('./revision.service');
const estadMes = require('./estadisticas-mes.service');
const comprobantes = require('./comprobantes-store');
const emision = require('./emision.service');
const ventasOnline = require('./ventas-online.service');
const facturaSvc = require('./factura.service');
const vendedoresSvc = require('./vendedores.service');
const clientesCascada = require('./clientes-cascada');
const cierreMesSvc = require('./cierre-mes.service');
const ganCache = require('./ganancias-cache');
const divisasStore = require('./divisas-store');
const configStore = require('./config-store');
const telegram = require('./telegram');
const importSheet = require('./import-sheet.service');
const { db } = require('./db');
const money = require('./lib/money');
const { fechaTZ, mesTZ, fechaUTC, mesUTC } = require('./lib/fechas'); // fechaTZ/mesTZ=ART (billing) · fechaUTC/mesUTC=UTC (casino)

const ok = (res, extra = {}) => res.json(Object.assign({ ok: true }, extra));
const err = (res, code, msg, extra) => res.status(code).json({ ok: false, error: msg, ...(extra || {}) });
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
  tcColumna.startScheduler();
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
  // Los datos con los que el cliente paga, y los avisos de seguridad que tiene que leer ANTES de
  // transferir. Los avisos no son decorativos: fuera del rango o en la red equivocada, la plata
  // se pierde y no se recupera.
  const PAGOS_KEYS = [
    'cvuVigente', 'cvuTitular', 'cvuNota', 'arsMin', 'arsMax', 'arsAviso',
    'usdtAddress', 'usdtRed', 'usdtNota', 'usdtAviso',
    'tgChatArs', 'tgChatUsdt',   // a qué grupo de Telegram avisa cada camino
  ];
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
  // El cruce entre Proveedores (el nombre resuelve) y Matriz (a quién se le cobra): lo que
  // ninguna de las dos contesta sola es si algo dio ganancia y no se le cobra a nadie.
  app.get('/api/os/cierre/cruce', (req, res) => ok(res, revision.cruceProveedores(req.query.mes)));
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
    const { cliente_id, panel_id, items, vigente_desde, mes, parcial } = req.body || {};
    if (!cliente_id || !Array.isArray(items)) return err(res, 400, 'cliente_id + items[] requeridos');
    // §12: el reparto cierra contra el % BASE del cliente, no contra 100. `parcial:true` deja
    // guardar un reparto a medio configurar — los puntos que faltan quedan visibles como
    // "sin asignar" en vez de bloquear el guardado y perder lo ya cargado.
    const c = clientes.get(cliente_id);
    if (!c) return err(res, 404, 'cliente no encontrado');
    const base = externosSvc.baseDelMes(c, mes || mesTZ()).valor;
    if (base == null || base === '') return err(res, 400, `${c.codigo} no tiene % base cargado: sin eso no hay contra qué cerrar el reparto`);
    const suma = money.sum(items.map((i) => i.porcentaje));
    if (money.cmp(suma, base) > 0) return err(res, 400, `El reparto suma ${suma}% y la base es ${base}%: se estaría repartiendo más de lo que paga el cliente`);
    if (!parcial && money.cmp(suma, base) !== 0) return err(res, 400, `El reparto debe sumar el ${base}% de base (suma ${suma}%)`);
    const r = participaciones.setReparto(cliente_id, panel_id || null, items, vigente_desde, { esperado: suma });
    ok(res, { reparto: r, base, suma: money.round(suma, 4), resto: money.round(money.sub(base, suma), 4) });
  }));
  app.get('/api/os/participaciones/historial', (req, res) =>
    ok(res, { historial: participaciones.listHistorial(req.query.cliente_id, req.query.panel_id || null) }));

  // ───────── SPLIT_BASE (JUBILADA — §12) ─────────
  // Era el 1er paso del reparto viejo: por cada % base, cuánto iba a Empresa y cuánto a LATAM.
  // Ahora el reparto es de un solo paso y la Empresa es un participante más (reparto.service).
  // Queda SOLO LECTURA: los datos siguen en la base y `sembrarDesdeSplit` los usa para
  // pre-cargar el reparto de cada cliente. Se sacaron el PUT y el DELETE a propósito —
  // editarla ya no cambiaría ningún cálculo, así que dejarlos era una trampa.
  app.get('/api/os/split-base', (_req, res) => ok(res, { split_base: splitBase.list(), jubilada: true }));

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
    const conns = casinoConex.list463();   // importar proveedores usa el reporte del engine 463
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
  app.post('/api/os/cierre/tc', wrap((req, res) => {
    const b = req.body || {};
    const r = cierreStore.setTC(b.moneda, b.mes, b.tasa, !!b.forzar);
    // El TC se tipea a mano y es el divisor de todo lo que se cobra: si viene mal escrito hay que
    // decirlo en el momento, no dejar que salga una factura en cero o mil veces más grande.
    if (r.ok) return ok(res, { guardado: true, borrado: !!r.borrado });
    // 409 = 'estás seguro?': la pantalla lo re-manda con forzar:true si el dueño confirma
    res.status(r.confirmar ? 409 : 400).json({ ok: false, error: r.error, confirmar: !!r.confirmar, anterior: r.anterior });
  }));
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



  // ───────── 🧾 COMPROBANTES DE PAGO ─────────
  // Los sube el cliente desde la pantalla pública. Quedan PENDIENTES: aprobar es a mano, porque
  // acreditar un pago porque alguien subió una imagen sería confiar en la imagen.
  app.get('/api/os/comprobantes', (req, res) => ok(res, {
    cuentas: comprobantes.cuentas(),
    comprobantes: comprobantes.list({ estado: req.query.estado, codigo: req.query.codigo }),
  }));
  app.get('/api/os/comprobantes/:id/archivo', (req, res) => {
    const c = comprobantes.get(req.params.id, true);
    if (!c || !c.archivo_datos) return err(res, 404, 'ese comprobante no tiene archivo');
    res.setHeader('Content-Type', c.archivo_tipo || 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename="${(c.archivo_nombre || 'comprobante').replace(/[^\w.\-]/g, '_')}"`);
    res.send(Buffer.from(c.archivo_datos, 'base64'));
  });
  // Aprobar → registra el PAGO (que es lo único que mueve la deuda). Rechazar → solo queda el motivo.
  app.post('/api/os/comprobantes/:id/resolver', wrap(async (req, res) => {
    const b = req.body || {};
    const c = comprobantes.get(req.params.id);
    if (!c) return err(res, 404, 'no existe ese comprobante');
    if (c.estado !== 'pendiente') return err(res, 409, `ya estaba ${c.estado}`);
    if (b.estado === 'rechazado') {
      const r = comprobantes.resolver(req.params.id, { estado: 'rechazado', por: 'panel', motivo: b.motivo });
      return r.ok ? ok(res, r) : err(res, 400, r.error);
    }
    if (b.estado !== 'aprobado') return err(res, 400, "estado inválido: 'aprobado' o 'rechazado'");
    // El monto que se acredita es el que CONFIRMA el panel, no el que declaró el cliente.
    const montoUsdt = b.monto_usdt != null ? String(b.monto_usdt) : null;
    if (!money.isPos(montoUsdt)) return err(res, 400, 'poné cuántos USDT se acreditan');
    // getByCodigo resuelve también los códigos VIEJOS (codigosAlias): si un cliente se renombró,
    // su comprobante viejo tiene que seguir encontrándolo.
    const cli = clientes.getByCodigo(c.codigo);
    if (!cli) return err(res, 404, `el código ${c.codigo} ya no corresponde a ningún cliente`);
    const mov = movs.create({ cliente_id: cli.id, tipo: 'pago', monto_usdt: montoUsdt, fecha: b.fecha, notas: `comprobante ${c.id}${b.motivo ? ' · ' + b.motivo : ''}` });
    const r = comprobantes.resolver(req.params.id, { estado: 'aprobado', por: 'panel', motivo: b.motivo, movimiento_id: mov.id });
    if (!r.ok) return err(res, 400, r.error);
    ok(res, { ...r, movimiento: mov, deuda: deudaSvc.cuentaCorriente(cli.id) });
  }));
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
    ok(res, { mes, ars: tcUnico.tcDelMes('ARS', mes), monedas: tcUnico.resumenMes(mes), discrepancias: tcUnico.discrepancias(mes) });
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
  // Qué monedas se siguen (salen de las filas de la grilla) + limpiar lo que sobró.
  app.get('/api/os/tc/divisas/seguidas', (_req, res) => ok(res, { monedas: [...tcDivisas.seguidas()].sort(), piso: tcDivisas.BASE_SEGUIDAS }));
  app.post('/api/os/tc/divisas/purgar', wrap((_req, res) => ok(res, { borradas: tcDivisas.purgarNoSeguidas(), monedas: [...tcDivisas.seguidas()].sort() })));
  app.get('/api/os/tc/divisas/dias', (req, res) => {
    const mes = req.query.mes || new Date().toISOString().slice(0, 7);
    ok(res, { mes, dias: tcDivisas.listDias(mes, req.query.divisa) });
  });
  // La columna del mes en la grilla, armada con los promedios que se juntaron.
  app.post('/api/os/tc/columna', wrap((req, res) => {
    const b = req.body || {};
    const r = tcColumna.armarColumna(b.mes || mesTZ(), { pisar: !!b.pisar });
    r.ok ? ok(res, r) : err(res, 400, r.error);
  }));
  // Borrar / renombrar una columna entera de la grilla.
  app.delete('/api/os/cierre/tc/mes/:mes', wrap((req, res) => {
    const r = cierreStore.removeMesTC(req.params.mes);
    r.ok ? ok(res, r) : err(res, 400, r.error);
  }));
  app.delete('/api/os/cierre/tc/moneda/:moneda', wrap((req, res) => {
    const r = cierreStore.removeMonedaTC(req.params.moneda);
    // La lista de monedas que se cotizan sale de estas filas: si se va una, se va su historial.
    if (r.ok) r.snapshotsBorrados = tcDivisas.purgarNoSeguidas();
    r.ok ? ok(res, r) : err(res, 400, r.error);
  }));
  app.post('/api/os/cierre/tc/renombrar', wrap((req, res) => {
    const b = req.body || {};
    const r = cierreStore.renombrarMesTC(b.de, b.a);
    r.ok ? ok(res, r) : err(res, 400, r.error);
  }));

  // El TC del proveedor entra SIEMPRE por acá: `setTC` lo escribe en la grilla (fila ARS_OF) y en
  // tc_mes de una sola vez. Guardarlo directo en tc_mes es lo que había dejado los dos lados
  // distintos — julio con 1473,5 en uno y vacío en el otro.
  app.put('/api/os/tc/mes/:mes', wrap((req, res) => {
    const { tc_proveedor_ext } = req.body || {};
    if (tc_proveedor_ext === undefined) return err(res, 400, 'falta tc_proveedor_ext');
    const r = cierreStore.setTC(cierreStore.FILA_PROVEEDOR, mesCierreLbl(req.params.mes), tc_proveedor_ext, true);
    if (!r.ok) return err(res, 400, r.error);
    ok(res, { mes: tcStore.getMes(req.params.mes) });
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
  // Corregir UN costo dentro de una foto ya congelada (no es cambiar de precio: es arreglar un
  // numero que salio mal en la foto). Deja rastro en las notas del mes.
  app.post('/api/os/cierre/mes/:mes/costo', wrap((req, res) => {
    const b = req.body || {};
    const r = cierreMesSvc.corregirCosto(req.params.mes, b.proveedor, b.base_pct, b.motivo);
    r.ok ? ok(res, r) : err(res, 400, r.error);
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

  // La CARGA COMERCIAL a mano se sacó (2-ago).
  //
  // Calculaba el fee de una venta y lo sumaba a la deuda. Ahora eso lo hace la Factura de consumo,
  // que sale sola de los pedidos y se emite una vez por mes con candado contra el doble cobro.
  // Tenerlas conviviendo era una fuga concreta: registrar la carga a mano Y emitir el mes cobraba
  // la MISMA venta dos veces, y ni el índice único ni el chequeo previo lo veían, porque solo miran
  // los movimientos que generó una emisión.
  //
  // Lo que sí queda es el LIBRO (la lista de movimientos) y el registro de PAGOS.

  // PAGO: registra el pago en USDT, recalcula saldo, avisa
  app.post('/api/os/movimientos/pago', wrap(async (req, res) => {
    const { cliente_id, monto_usdt, fecha, notas, medio } = req.body || {};
    const cli = clientes.get(cliente_id); if (!cli) return err(res, 404, 'cliente no encontrado');
    if (!money.isPos(monto_usdt)) return err(res, 400, 'monto inválido');
    const antes = deudaSvc.cuentaCorriente(cliente_id).total;
    // `medio` = por dónde entró la plata (CVU, USDT, efectivo…). Sin esto, al mes siguiente no
    // se puede reconstruir de dónde vino cada pago, que es lo primero que se pregunta cuando
    // un cliente reclama.
    const movimiento = movs.create({ cliente_id, tipo: 'pago', monto_usdt, fecha, notas, medio });
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

  // ───────── 💸 CUÁNTO LE PAGAMOS A LOS PROVEEDORES (punto 8) ─────────
  // El otro lado de la factura de externos: aquella cobra `ganancia × (celda − base)` al cliente,
  // ésta paga `ganancia × costo` al proveedor. Consulta el casino, así que tarda.
  app.get('/api/os/pago-proveedores', wrap(async (req, res) => {
    const r = await pagoProv.reporte({
      mes: req.query.mes || mesTZ(),
      monedas: req.query.monedas ? String(req.query.monedas).split(',').map((s) => s.trim().toUpperCase()).filter(Boolean) : null,
      refrescar: req.query.refrescar === '1',
    });
    r.ok ? ok(res, r) : err(res, 400, r.error);
  }));
  // El CSV con el mismo formato que el dueño ya usaba a mano.
  // Traer el mes de a pedazos y dejarlo guardado. El reporte entero no entra en una sola
  // request; esto se llama varias veces (una por panel, y TBS de a tandas de grupos) y despues
  // el reporte sale de lo guardado.
  app.post('/api/os/pago-proveedores/precargar', wrap(async (req, res) => {
    const b = req.body || {};
    const r = await pagoProv.precargar({
      mes: b.mes || mesTZ(), conexion_id: b.conexion_id,
      desde: Number(b.desde) || 0, limite: Number(b.limite) || 12, refrescar: !!b.refrescar,
    });
    r.ok ? ok(res, r) : err(res, 502, r.error, { reintentable: !!r.reintentable });
  }));

  app.get('/api/os/pago-proveedores/planilla.csv', wrap(async (req, res) => {
    const r = await pagoProv.reporte({ mes: req.query.mes || mesTZ(), refrescar: req.query.refrescar === '1' });
    if (!r.ok) return err(res, 400, r.error);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="pago-proveedores-${r.mes}.csv"`);
    res.send('﻿' + pagoProv.csv(r));   // BOM: si no, Excel rompe los acentos
  }));

  // TBS: los 53 grupos de proveedores con su id, para poder mapearlos contra la matriz.
  app.get('/api/os/tbs/grupos', wrap(async (_req, res) => {
    const cx = casinoConex.list().find((c) => c.motor === 'tbs' && c.activa);
    if (!cx) return err(res, 400, 'no hay ninguna conexión con motor TBS configurada');
    const cli = casinoConex.client(cx.id);
    if (!cli) return err(res, 400, `la conexión "${cx.nombre}" no tiene credenciales cargadas`);
    const r = await cli.grupos();
    r.ok ? ok(res, { conexion: cx.nombre, ...r }) : err(res, 502, r.error, { diag: r.diag || [] });
  }));

  /**
   * TBS: el profit de unos agentes puntuales, por grupo de proveedores y por moneda.
   * Es la base para calcular cuánto se le paga a cada proveedor (punto 8).
   *
   * ⏱ Tarda ~54s por llamada. `grupos` es un array y se piden TODOS en la misma pasada —
   * pedirlos de a uno serían 53 llamadas, casi una hora.
   */
  app.post('/api/os/tbs/profit', wrap(async (req, res) => {
    const b = req.body || {};
    const cx = casinoConex.list().find((c) => c.motor === 'tbs' && (!b.conexion_id || c.id === b.conexion_id));
    if (!cx) return err(res, 400, 'no hay ninguna conexión con motor TBS configurada');
    const cli = casinoConex.client(cx.id);
    if (!cli) return err(res, 400, `la conexión "${cx.nombre}" no tiene credenciales cargadas`);
    const mes = String(b.mes || mesTZ()).slice(0, 7);
    const ult = new Date(Date.UTC(Number(mes.slice(0, 4)), Number(mes.slice(5, 7)), 0)).getUTCDate();
    const desde = b.desde || `${mes}-01 00:00:00`;
    const hasta = b.hasta || `${mes}-${String(ult).padStart(2, '0')} 23:59:59`;
    const agentes = Array.isArray(b.agentes) ? b.agentes.map(String) : [];
    if (!agentes.length) return err(res, 400, 'hay que decir de qué agentes (agentes: ["3206986", …])');
    const r = await cli.profitDeAgentes({ desde, hasta, agentes, grupos: b.grupos || [] });
    if (!r.ok) return err(res, 502, r.error);
    ok(res, { conexion: cx.nombre, mes, desde, hasta, ...r });
  }));
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
  // 📊 EL PULSO: el resumen y las alertas del mes, desde el acumulado guardado (no toca el casino).
  app.get('/api/os/pulso', wrap((req, res) => ok(res, pulsoSvc.pulso({ mes: req.query.mes }))));
  app.get('/api/os/pulso/tendencia', wrap((req, res) => ok(res, pulsoSvc.tendencia({ hasta: req.query.mes, meses: Number(req.query.meses) || 6 }))));

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

  // ───────── PANEL ↔ CASINO (stats reales por nodo linkeado) ─────────
  app.get('/api/os/paneles/:id/casino', wrap(async (req, res) => {
    const p = paneles.get(req.params.id); if (!p) return err(res, 404, 'panel no encontrado');
    if (!p.conexion_id || !p.id_usuario) return err(res, 400, 'el panel no está linkeado a un nodo del casino');
    const cli = casinoConex.client(p.conexion_id); if (!cli) return err(res, 404, 'conexión no encontrada');
    const r = await cli.totalNodo({ nodeId: p.id_usuario, from: req.query.from, to: req.query.to });
    r.ok ? ok(res, { nodo: r.nodo }) : err(res, 502, r.error);
  }));

  // ───────── FACTURACIÓN ─────────
  //
  // ⭐ LO QUE SE COBRA SALE DE LOS PEDIDOS, no del casino (decisión del dueño).
  // Son dos números distintos por diseño: el casino informa todo lo que entró a los paneles
  // (incluidas cargas hechas por fuera del sistema, bonos y movimientos internos), y los pedidos
  // son lo que se le vendió al cliente. Se factura lo vendido.
  //
  // El casino se sigue trayendo AL LADO, como control: si los dos números se separan mucho, o falta
  // cargar pedidos o hubo cargas por fuera. Pero si el casino no responde, se factura igual —
  // antes una caída del casino dejaba sin facturar.
  // EL CÁLCULO DE LA FACTURACIÓN, en una función: lo usan la pantalla y la emisión a la deuda.
  // Si cada una lo calculara por su lado, el número que se muestra y el que se cobra podrían
  // separarse — que es exactamente lo que veníamos de arreglar en todo lo demás.
  async function _facturacionDe(mes, opciones = {}) {
    opciones = opciones || {};
    const from = opciones.from || `${mes}-01 00:00:00`;
    // El 'hasta' sale del MES elegido, no de hoy: si no, facturar un mes cerrado suma todo lo que
    // pasó después (pedir junio en agosto traía junio+julio+agosto en una sola línea, rotulada 'Junio').
    const _ultDia = new Date(Date.UTC(Number(mes.slice(0, 4)), Number(mes.slice(5, 7)), 0)).getUTCDate();
    const to = opciones.to || `${mes}-${String(_ultDia).padStart(2, '0')} 23:59:59`;
    const conControl = opciones.control !== false;

    // 1) LA BASE DE COBRO: los pedidos cargados del mes, por cliente y por moneda.
    //
    // Los pedidos se toman en el SISTEMA EN LÍNEA, no acá. Si el puente está configurado se traen
    // de allá, ya traducidos a clientes de este lado (los dos padrones usan códigos distintos: allá
    // "M526", acá "Marcelo"). Si no está configurado, se usan los pedidos locales — que en el OS
    // normalmente son cero, y por eso la factura salía vacía.
    let ventasCli = {}; let huerfanas = []; let origen = 'pedidos locales';
    const puente = ventasOnline.getConfig();
    if (puente && puente.url) {
      const vo = await ventasOnline.ventasDelMes(mes);
      if (!vo.ok) return { ok: false, error: `no se pudieron traer los pedidos del sistema en línea: ${vo.error}`, mes };
      ventasCli = vo.porCliente;
      huerfanas = (vo.sinMapeo || []).map((x) => ({ codigo: x.codigo, pedidos: x.count, porDivisa: Object.entries(x.porDivisa).map(([d, m]) => ({ divisa: d, monto: money.round(String(m), 2) })) }));
      origen = 'pedidos del sistema en línea';
    } else {
      const locales = pedidosStore.ventasDelMes(mes);
      const porCodigo = {};
      clientes.list().clientes.forEach((c) => { porCodigo[String(c.codigo).toLowerCase()] = c.id; });
      for (const [cod, v] of Object.entries(locales)) {
        const id = porCodigo[cod.toLowerCase()];
        if (!id) { huerfanas.push({ codigo: cod, pedidos: v.count, porDivisa: Object.entries(v.porDivisa).map(([d, m]) => ({ divisa: d, monto: money.round(String(m), 2) })) }); continue; }
        ventasCli[id] = { ...v, codigos: [cod] };
      }
    }

    // 2) EL CONTROL: lo que dice el casino. Si falla, se informa y se sigue.
    //
    // ⚡ Sale del ACUMULADO GUARDADO, no del casino en vivo. El cron nocturno ya baja esto todas
    // las noches a `reporte_diario`; preguntárselo otra vez al casino en cada pantallazo tardaba
    // ~70s (bajaba el árbol ENTERO de las dos conexiones) para llegar al mismo número. Un mes
    // cerrado además no cambia más, así que consultarlo de nuevo no aporta nada.
    // Se va en vivo solo si se pide `?vivo=1` o si el rango de fechas no es un mes completo
    // (el acumulado está guardado por mes, no puede contestar un rango arbitrario).
    const linked = paneles.list().filter((p) => p.conexion_id && p.id_usuario);
    const nodeMap = {}; const errores = [];
    let controlDe = 'acumulado guardado'; let cobertura = null;
    if (conControl) {
      const rangoPropio = !!(opciones.from || opciones.to);
      const vivo = !!opciones.vivo || rangoPropio;
      if (!vivo) {
        const keys = linked.map((p) => ({ conexion_id: p.conexion_id, grp: 'superagent', sa_id: String(p.id_usuario) }));
        const filas = reporteDiarioStore.filasPanelesMes(keys, mes);
        for (const f of filas) {
          const m = nodeMap[f.conexion_id] = nodeMap[f.conexion_id] || {};
          const n = m[String(f.sa_id)] = m[String(f.sa_id)] || { montos: {} };
          const div = String(f.moneda || 'ARS');
          n.montos[div] = n.montos[div] || { in: '0' };
          n.montos[div].in = money.add(n.montos[div].in, String(f.in_amt || 0));
        }
        cobertura = reporteDiarioStore.diasCapturados(mes);
        // Un mes a medio capturar mostraría el control más chico de lo que es y parecería un desvío.
        if (!cobertura.dias) errores.push(`el acumulado de ${mes} está vacío: el control no dice nada (capturalo en 📒 Acumulado, o pedí ?vivo=1)`);
      } else {
        controlDe = rangoPropio ? 'casino en vivo (rango propio)' : 'casino en vivo (pedido)';
        const byConn = {};
        linked.forEach((p) => { (byConn[p.conexion_id] = byConn[p.conexion_id] || []).push(p); });
        for (const cid of Object.keys(byConn)) {
          const cli = casinoConex.client(cid); if (!cli) { errores.push(`conexión ${cid} no disponible`); continue; }
          try {
            const r = await cli.nodos({ from, to, soloActivos: true, multiMoneda: true });
            if (!r.ok) { errores.push(`conexión ${cid}: ${r.error}`); continue; }
            const m = {}; r.nodos.forEach((n) => { m[String(n.id)] = n; }); nodeMap[cid] = m;
          } catch (e) { errores.push(`conexión ${cid}: ${String((e && e.message) || e)}`); }
        }
      }
    }

    const _tc = tcUnico.tcDelMes('ARS', mes);
    const tc = _tc.valor;
    const out = []; const sinBase = new Set(); const sinTC = new Set();
    const sinPedidos = [];      // tienen movimiento en el casino pero NO se les vendió nada
    const enCero = [];          // el % base dice 0: se les factura cero y parece correcto
    // ⚠️ Ventas cuyo código NO corresponde a ningún cliente. Con los pedidos como base de cobro,
    // eso es plata vendida que no se le factura a nadie y que no aparece por ningún lado.
    // Verificado en producción: "Mclain" y "CharlyS2" con 170.000.000 cargados, sin cliente.
    // Pasa cuando se renombra el código de un cliente y los pedidos viejos quedan con el anterior.
    let totVend = '0', totFee = '0', totCasino = '0';
    let cmpVend = '0', cmpCasino = '0';   // solo los clientes que SÍ tienen pedidos

    // ⚠️ LOS VENDEDORES NO VAN EN ESTA FACTURA. No pagan un % de lo que cargan: pagan el COSTO
    // REAL de los proveedores que usen, y eso se liquida en 🧮 Cierre de Mes → 🤝 Vendedores.
    // Estando acá aparecían como "sin % base — van al 0%" (los 6 en rojo: David, IGLatam, Sarah,
    // Alexa, Carlos, Henry), se les facturaba cero, y su movimiento del casino igual se sumaba al
    // control: el total decía que la venta difería un 66% de lo que el casino registró, mezclando
    // plata que esta factura no cobra por diseño.
    const vendedores = [];
    for (const c of clientes.list().clientes) {
      const v = ventasCli[c.id] || null;
      const cps = linked.filter((p) => p.cliente_id === c.id);
      if (c.es_vendedor) {
        if (v || cps.length) vendedores.push(c.nombre || c.nombreVisible || c.codigo);
        continue;
      }

      // el % del MES que se está facturando. Los pedidos son por CLIENTE, así que el precio propio
      // de un panel no se puede aplicar acá: si un cliente tiene paneles con precios distintos, hay
      // que unificarlos o cobrarle esa diferencia aparte.
      const rb = externosSvc.baseDelMes(c, mes);
      const base = rb.valor || '0';

      // ── lo vendido, moneda por moneda ──
      let vendUsdt = '0', feeUsdt = '0'; const porDivisa = [];
      for (const [div, monto] of Object.entries((v && v.porDivisa) || {})) {
        const t = tcUnico.tcDelMes(div, mes);
        const fee = money.pct(String(monto), base);
        if (!t.valor) { sinTC.add(div); porDivisa.push({ divisa: div, vendido: String(monto), tc: null }); continue; }
        vendUsdt = money.add(vendUsdt, money.div(String(monto), t.valor));
        feeUsdt = money.add(feeUsdt, money.div(fee, t.valor));
        porDivisa.push({ divisa: div, vendido: money.round(monto, 2), fee: money.round(fee, 2), tc: t.valor, vendidoUsdt: money.round(money.div(String(monto), t.valor), 2) });
      }

      // ── el control del casino ──
      let casinoUsdt = '0'; let hayCasino = false;
      for (const p of cps) {
        const node = (nodeMap[p.conexion_id] || {})[String(p.id_usuario)];
        if (!node) continue;
        hayCasino = true;
        const montos = (node.montos && Object.keys(node.montos).length) ? node.montos : { ARS: { in: node.in } };
        for (const [div, x] of Object.entries(montos)) {
          const t = tcUnico.tcDelMes(div, mes);
          if (t.valor) casinoUsdt = money.add(casinoUsdt, money.div(x.in || '0', t.valor));
        }
      }

      if (!v && !hayCasino) continue;                       // ni vendido ni movimiento: no aparece
      if (rb.valor == null && v) sinBase.add(c.nombre || c.nombreVisible || c.codigo);
      // Base CERO no es lo mismo que base sin cargar: acá el número está puesto, dice cero, y la
      // factura sale en cero "correctamente". Si fue un olvido, nada lo iba a delatar.
      if (rb.valor != null && !money.isPos(base) && (v || money.isPos(casinoUsdt))) {
        enCero.push({ nombre: c.nombre || c.nombreVisible || c.codigo, vendido_usdt: money.round(vendUsdt, 2), casino_usdt: money.round(casinoUsdt, 2) });
      }

      // Movimiento en el casino pero CERO pedidos: no se factura en cero y listo — se avisa. Una
      // factura en cero pasa desapercibida; un aviso no.
      if (!v && hayCasino && money.isPos(casinoUsdt)) {
        sinPedidos.push({ codigo: c.codigo, nombre: c.nombre || c.nombreVisible, casino_usdt: money.round(casinoUsdt, 2) });
      }

      // lo que quedó a mitad de anular: las fichas están puestas pero la vuelta no se confirmó
      let anulandoUsdt = '0';
      for (const [div, monto] of Object.entries((v && v.anulando && v.anulando.porDivisa) || {})) {
        const t = tcUnico.tcDelMes(div, mes);
        if (t.valor) anulandoUsdt = money.add(anulandoUsdt, money.div(String(monto), t.valor));
      }

      const dif = money.isPos(casinoUsdt) ? money.round(money.mul(money.div(money.sub(vendUsdt, casinoUsdt), casinoUsdt), '100'), 1) : null;
      out.push({
        cliente_id: c.id, codigo: c.codigo, nombre: c.nombre || c.nombreVisible, moneda: 'USDT',
        base, baseFuente: rb.fuente, sinBase: rb.valor == null,
        pedidos: (v && v.count) || 0,
        vendido_usdt: money.round(vendUsdt, 2),
        fee_usdt: money.round(feeUsdt, 2),
        casino_usdt: money.round(casinoUsdt, 2),
        dif_pct: dif,
        anulando: (v && v.anulando && v.anulando.count) ? { count: v.anulando.count, usdt: money.round(anulandoUsdt, 2) } : null,
        porDivisa,
        paneles: cps.map((p) => p.nombre),
      });
      totVend = money.add(totVend, vendUsdt);
      totFee = money.add(totFee, feeUsdt);
      totCasino = money.add(totCasino, casinoUsdt);
      // El total contra el total no dice nada cuando hay clientes que cargan por fuera del
      // sistema: Titan solo son 1,96M de los 3,3M del control, y arrastra el promedio a -66%
      // sin que haya nada mal. Este otro total compara SOLO a los que sí pasan por pedidos, que
      // es donde un desvío significa de verdad que algo no cuadra.
      if (v && v.count) { cmpVend = money.add(cmpVend, vendUsdt); cmpCasino = money.add(cmpCasino, casinoUsdt); }
    }

    out.sort((a, b) => Number(b.fee_usdt) - Number(a.fee_usdt));

    // Lo vendido que quedó sin dueño: códigos del sistema en línea que no están mapeados a
    // ningún cliente de acá. Es plata vendida que no se le factura a nadie, así que se informa
    // con el monto para poder mapearla o crear el cliente.
    for (const h of huerfanas) {
      let u = '0';
      for (const d of h.porDivisa) {
        const t = tcUnico.tcDelMes(d.divisa, mes);
        if (t.valor) u = money.add(u, money.div(String(d.monto), t.valor));
      }
      h.usdt = money.round(u, 2);
    }
    huerfanas.sort((a, b) => Number(b.usdt) - Number(a.usdt));

    return {
      mes, from, to, tc, tcFuente: _tc.fuente, tcConflicto: _tc.conflicto, moneda: 'USDT',
      fuente: 'pedidos cargados', control: conControl ? controlDe : 'apagado', cobertura,
      origen, sinBase: [...sinBase], sinTC: [...sinTC], sinPedidos, enCero, vendedores, huerfanas,
      totales: {
        vendido_usdt: money.round(totVend, 2),
        fee_usdt: money.round(totFee, 2),
        casino_usdt: money.round(totCasino, 2),
        dif_pct: money.isPos(totCasino) ? money.round(money.mul(money.div(money.sub(totVend, totCasino), totCasino), '100'), 1) : null,
        // Comparable = solo los clientes que pasan por pedidos. Es el número que dice si la
        // facturación cuadra; el otro mezcla a los que cargan por fuera del sistema.
        cmp_vendido_usdt: money.round(cmpVend, 2),
        cmp_casino_usdt: money.round(cmpCasino, 2),
        cmp_dif_pct: money.isPos(cmpCasino) ? money.round(money.mul(money.div(money.sub(cmpVend, cmpCasino), cmpCasino), '100'), 1) : null,
        fuera_usdt: money.round(money.sub(totCasino, cmpCasino), 2),
      },
      clientes: out, errores,
    };
  }

  app.get('/api/os/facturacion', wrap(async (req, res) => {
    ok(res, await _facturacionDe(req.query.mes || mesTZ(), {
      from: req.query.from, to: req.query.to,
      control: req.query.control !== '0',
      vivo: req.query.vivo === '1',   // forzar la consulta al casino en vez del acumulado guardado
    }));
  }));


  // Borrar un pedido: para sacar los sembrados de prueba o los creados por error.
  // ⚠️ Los pedidos son la base de lo que se cobra, así que borrar uno CAMBIA la facturación del mes.
  // Por eso se niega si ese pedido ya generó un movimiento, y si el mes ya se emitió a la deuda.
  app.delete('/api/os/pedidos/:id', (req, res) => {
    const p = pedidosStore.get(req.params.id);
    if (!p) return err(res, 404, 'no existe ese pedido');
    const mov = db.prepare('SELECT id FROM movimientos WHERE pedido_id=?').get(String(p.id));
    if (mov) return err(res, 409, `ese pedido ya generó el movimiento ${mov.id}: anulá el movimiento primero`);
    const mes = String(p.resueltoAt || p.createdAt || '').slice(0, 7);
    const em = emision.emitido(mes, 'facturacion');
    if (em.cantidad) return err(res, 409, `${mes} ya se emitió a la deuda (${em.cantidad} movimientos): anulá la emisión, borrá el pedido y volvé a emitir`);
    const r = pedidosStore.remove(req.params.id);
    if (!r.ok) return err(res, 400, r.error);
    console.log(`[Pedido] BORRADO ${p.id} · ${p.codigo} · ${p.divisa} ${p.monto} · estado ${p.estado}`);
    ok(res, r);
  });


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
  // ───────── PASAR LO FACTURADO A LA DEUDA ─────────
  // Emitir es EXPLÍCITO y no se puede duplicar: hay un índice único en la base sobre
  // (cliente, origen, mes). Volver a emitir el mismo mes no agrega nada.
  app.get('/api/os/emision/:mes', (req, res) => ok(res, emision.emitido(req.params.mes)));
  app.post('/api/os/emision/facturacion', wrap(async (req, res) => {
    const mes = String((req.body && req.body.mes) || mesTZ()).slice(0, 7);
    // el mismo cálculo que muestra la pantalla, para que no puedan diferir
    const fac = await _facturacionDe(mes, { control: false });
    const lineas = (fac.clientes || []).filter((c) => !c.sinBase).map((c) => ({
      cliente_id: c.cliente_id, monto_usdt: c.fee_usdt, base_pct: c.base,
      notas: `Fichas ${mes} · ${c.base}% sobre ${c.vendido_usdt} USDT vendidos`,
    }));
    const r = emision.emitir({ mes, origen: 'facturacion', lineas });
    if (!r.ok) return err(res, 400, r.error);
    ok(res, { ...r, sinBase: fac.sinBase, sinPedidos: fac.sinPedidos });
  }));
  // Lo mismo para Proveedores externos. Va como 'proveedor_extra', que en la cuenta corriente es
  // una columna aparte de las fichas: son dos conceptos y conviene verlos separados.
  app.post('/api/os/emision/externos', wrap(async (req, res) => {
    const mes = String((req.body && req.body.mes) || mesTZ()).slice(0, 7);
    const lineas = []; const fallaron = []; const sinBase = [];
    for (const c of clientes.list().clientes) {
      if (c.es_vendedor) continue;                 // el vendedor paga al costo, no lleva diferencial
      let r;
      try { r = await externosSvc.reporte({ clienteNombre: c.nombre, mes }); }
      catch (e) { fallaron.push({ cliente: c.nombre, error: String((e && e.message) || e) }); continue; }
      if (!r.ok) { (r.faltaBase ? sinBase : fallaron).push({ cliente: c.nombre, error: r.error }); continue; }
      // Un reporte INCOMPLETO no se emite: cobraría de menos y parecería correcto.
      if (r.incompleto) { fallaron.push({ cliente: c.nombre, error: `la foto del mes está incompleta (faltan ${r.sinTiempo} consultas)` }); continue; }
      if (!money.isPos(r.totalUsdt)) continue;
      lineas.push({ cliente_id: c.id, monto_usdt: r.totalUsdt, base_pct: r.base, notas: `Proveedores externos ${mes} · base ${r.base}%` });
    }
    const out = emision.emitir({ mes, origen: 'externos', lineas });
    if (!out.ok) return err(res, 400, out.error);
    ok(res, { ...out, sinBase, fallaron });
  }));

  /**
   * Lo que paga cada VENDEDOR por los proveedores que usó, a la deuda.
   *
   * Faltaba: la emisión de externos saltea a los vendedores (arriba, `if (c.es_vendedor) continue`)
   * porque no llevan diferencial, y no había ninguna otra que los tomara. Resultado: su costo se
   * calculaba, se mostraba en pantalla, y nunca entraba a la cuenta — los 8 tenían deuda 0.
   *
   * El vendedor paga el COSTO REAL del proveedor (modo 'vendedor' de externos.service, base 0),
   * así que sale del mismo reporte que ve la pantalla: no puede diferir de lo que se muestra.
   * `dry:true` devuelve el detalle SIN escribir, para mirarlo antes de emitir.
   */
  app.post('/api/os/emision/vendedores', wrap(async (req, res) => {
    const mes = String((req.body && req.body.mes) || mesTZ()).slice(0, 7);
    const dry = !!(req.body && req.body.dry);
    const lineas = []; const fallaron = []; const sinCosto = [];
    for (const c of clientes.list().clientes) {
      if (!c.es_vendedor) continue;
      let r;
      try { r = await externosSvc.reporte({ clienteNombre: c.nombre, mes }); }
      catch (e) { fallaron.push({ vendedor: c.nombre, error: String((e && e.message) || e) }); continue; }
      if (!r.ok) { fallaron.push({ vendedor: c.nombre, error: r.error }); continue; }
      // Un reporte incompleto cobraría de menos y parecería correcto: no se emite.
      if (r.incompleto) { fallaron.push({ vendedor: c.nombre, error: `la foto del mes está incompleta (faltan ${r.sinTiempo} consultas)` }); continue; }
      if (!money.isPos(r.totalUsdt)) { sinCosto.push(c.nombre); continue; }
      lineas.push({ cliente_id: c.id, monto_usdt: r.totalUsdt, base_pct: '0', notas: `Proveedores al costo ${mes} (vendedor)` });
    }
    if (dry) {
      const ya = emision.emitido(mes, 'vendedores');
      return ok(res, {
        ok: true, dry: true, mes, lineas: lineas.map((l) => ({ ...l, vendedor: (clientes.get(l.cliente_id) || {}).nombre })),
        total: money.round(money.sum(lineas.map((l) => l.monto_usdt)), 2), yaEmitido: ya, sinCosto, fallaron,
      });
    }
    const out = emision.emitir({ mes, origen: 'vendedores', lineas });
    if (!out.ok) return err(res, 400, out.error);
    ok(res, { ...out, sinCosto, fallaron });
  }));

  app.delete('/api/os/emision/:origen/:mes', (req, res) => {
    const r = emision.anular({ mes: req.params.mes, origen: req.params.origen });
    r.ok ? ok(res, r) : err(res, 400, r.error);
  });

  /** La URL pública de este servicio, para armar los links que se le mandan al cliente. */
  function _urlPublica(req) {
    const cfg = String(configStore.getCfg('urlPublica') || '').trim().replace(/\/+$/, '');
    if (cfg) return cfg;
    const host = process.env.RAILWAY_PUBLIC_DOMAIN || (req && req.get && req.get('host')) || 'localhost';
    return /^https?:\/\//.test(host) ? host.replace(/\/+$/, '') : 'https://' + host;
  }

  // ───────── 📄 LA FACTURA DEL MES, para mandársela al cliente ─────────
  // Junta las DOS facturas (consumo y proveedores externos) en un documento, más la cuenta
  // corriente. No recalcula: pide los mismos números que muestran las pantallas, para que lo
  // que se manda no pueda diferir de lo que dice el panel.
  app.get('/api/os/factura/:clienteId', wrap(async (req, res) => {
    const mes = String(req.query.mes || mesTZ()).slice(0, 7);
    // la línea de consumo sale de la MISMA función que la pantalla de Factura de consumo
    const fac = await _facturacionDe(mes, { control: false });
    if (fac.ok === false) return err(res, 502, fac.error);
    const linea = (fac.clientes || []).find((c) => c.cliente_id === req.params.clienteId) || null;
    const f = await facturaSvc.armar({
      clienteId: req.params.clienteId, mes, consumo: linea,
      conExternos: req.query.externos !== '0',
    });
    if (!f.ok) return err(res, 404, f.error);
    ok(res, { ...f, texto: facturaSvc.aTexto(f), textoConDetalle: facturaSvc.aTexto(f, { detalle: true }) });
  }));



  // El LINK con el que el cliente ve el desglose completo. Por Telegram le va el resumen y esto.
  app.post('/api/os/factura/:clienteId/link', wrap(async (req, res) => {
    const mes = String((req.body && req.body.mes) || mesTZ()).slice(0, 7);
    const fac = await _facturacionDe(mes, { control: false });
    if (fac.ok === false) return err(res, 502, fac.error);
    const linea = (fac.clientes || []).find((c) => c.cliente_id === req.params.clienteId) || null;
    const f = await facturaSvc.armar({ clienteId: req.params.clienteId, mes, consumo: linea });
    if (!f.ok) return err(res, 404, f.error);
    const l = facturaSvc.crearLink(f);
    ok(res, { ...l, url: _urlPublica(req) + '/factura/' + l.token, mes });
  }));
  app.get('/api/os/factura/:clienteId/links', (req, res) =>
    ok(res, { links: facturaSvc.linksDe(req.params.clienteId, req.query.mes).map((x) => ({ ...x, url: _urlPublica(req) + '/factura/' + x.token })) }));
  app.delete('/api/os/factura-link/:token', (req, res) => { facturaSvc.revocar(req.params.token); ok(res); });
  // Mandar la factura al grupo de Telegram DEL CLIENTE.
  //
  // ⚠️ Es una acción que sale para afuera: le llega al cliente. Por eso se dispara sólo desde el
  // botón, nunca sola, y nunca como parte de calcular. Si el cliente no tiene grupo cargado se
  // avisa en vez de fallar en silencio.
  app.post('/api/os/factura/:clienteId/enviar', wrap(async (req, res) => {
    const mes = String((req.body && req.body.mes) || mesTZ()).slice(0, 7);
    const conDetalle = !!(req.body && req.body.detalle);
    const cli = clientes.get(req.params.clienteId);
    if (!cli) return err(res, 404, 'cliente no encontrado');
    const chat = cli.telegram && cli.telegram.chatId;
    if (!chat) return err(res, 400, `${cli.nombre || cli.codigo} no tiene grupo de Telegram cargado (se pone en su ficha)`);
    const tok = configStore.getTelegramToken();
    if (!tok) return err(res, 400, 'falta el token del bot de Telegram (⚙ Config)');

    const fac = await _facturacionDe(mes, { control: false });
    if (fac.ok === false) return err(res, 502, fac.error);
    const linea = (fac.clientes || []).find((c) => c.cliente_id === cli.id) || null;
    const f = await facturaSvc.armar({ clienteId: cli.id, mes, consumo: linea, conExternos: req.body.externos !== false });
    if (!f.ok) return err(res, 400, f.error);

    // Por Telegram va el RESUMEN, y el desglose completo por link: 153 cargas en tres mensajes
    // seguidos no hay quien las lea, y en la página se pueden mirar por panel con calma.
    let texto = facturaSvc.aTexto(f, { detalle: conDetalle });
    if (req.body.link !== false) {
      const l = facturaSvc.crearLink(f);
      texto += `\n\n📄 <a href="${_urlPublica(req)}/factura/${l.token}">Ver el detalle completo</a>`;
    }
    const partes = facturaSvc.partir(texto);
    const enviados = [];
    for (const p of partes) {
      const r = await telegram.sendMessage(tok, chat, p);
      enviados.push(r);
      if (!r.ok) break;                       // si uno falla, no se sigue mandando a ciegas
    }
    const fallo = enviados.find((x) => !x.ok);
    if (fallo) return err(res, 502, `se mandaron ${enviados.length - 1} de ${partes.length} partes: ${fallo.error}`);
    console.log(`[Factura] enviada a ${cli.nombre} (${mes}) · ${partes.length} mensaje(s)`);
    ok(res, { enviado: true, partes: partes.length, total_usdt: f.totalMes_usdt, saldo: f.cuenta.saldo });
  }));
  // Todas las facturas de un mes de una sola pasada: los pedidos se traen UNA vez, no una por
  // cliente. Sirve para el envío de principio de mes.
  app.get('/api/os/facturas', wrap(async (req, res) => {
    const mes = String(req.query.mes || mesTZ()).slice(0, 7);
    const conExternos = req.query.externos === '1';   // apagado por defecto: consulta el casino
    const fac = await _facturacionDe(mes, { control: false });
    if (fac.ok === false) return err(res, 502, fac.error);
    const out = [];
    for (const linea of (fac.clientes || [])) {
      const f = await facturaSvc.armar({ clienteId: linea.cliente_id, mes, consumo: linea, conExternos });
      if (f.ok) out.push({ ...f, texto: facturaSvc.aTexto(f) });
    }
    out.sort((a, b) => Number(b.totalMes_usdt) - Number(a.totalMes_usdt));
    ok(res, { mes, conExternos, facturas: out });
  }));

  // ───────── 🤝 VENDEDORES ─────────
  // Un vendedor no paga un % sobre lo que carga: paga AL COSTO por los proveedores que use, en
  // sus paneles y en los de sus clientes. Es una cuenta interna, no una factura.
  app.get('/api/os/vendedores', (_req, res) => ok(res, { vendedores: vendedoresSvc.lista() }));
  app.get('/api/os/vendedores/:id', wrap(async (req, res) => {
    const mes = String(req.query.mes || mesTZ()).slice(0, 7);
    // la facturación se calcula UNA vez y se reparte: el vendedor y sus clientes salen de ahí
    const fac = await _facturacionDe(mes, { control: false });
    if (fac.ok === false) return err(res, 502, fac.error);
    const r = await vendedoresSvc.cuenta({ vendedorId: req.params.id, mes, facturacion: fac, conProveedores: req.query.proveedores !== '0' });
    r.ok ? ok(res, r) : err(res, 404, r.error);
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
    const _tc = tcUnico.tcDelMes('ARS', mes);   // misma regla que Facturación y Externos
    const tc = _tc.valor || '1';
    const ventas = pedidosStore.ventasCargadasMes(mes); // { codigo: { monto, ... } }
    let totVentas = '0', totFee = '0', totSinAsignar = '0';
    const porParticipante = {}, porCliente = [];
    const problemas = [];
    for (const c of clientes.list().clientes) {
      const vc = ventas[c.codigo];
      const carga = vc ? String(vc.monto) : '0';
      if (!money.isPos(carga)) continue;
      totVentas = money.add(totVentas, carga);

      // UN SOLO PASO: los participantes del cliente se reparten su % base directo (§12).
      const d = repartoSvc.distribuir(carga, c, mes, tc, fecha);
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
    ok(res, {
      mes, tc, ventas_total: money.round(totVentas, 2),
      total: money.round(totFee, 2),
      repartido: money.round(money.sub(totFee, totSinAsignar), 2),
      sin_asignar: money.round(totSinAsignar, 2),
      participantes, clientes: porCliente, problemas,
      _nota: 'En USDT, de las VENTAS DE FICHAS reales (pedidos cargados) del mes. Un solo paso: cada participante cobra SUS PUNTOS del % base del cliente (§12). "sin_asignar" = puntos del base que todavía no tienen dueño.',
    });
  });

  // Sembrar el reparto de los clientes desde la vieja Tabla Split (Empresa) — ver reparto.service.
  app.post('/api/os/reparto/sembrar', wrap((req, res) => {
    const mes = req.body && req.body.mes ? String(req.body.mes).slice(0, 7) : mesTZ();
    const aplicar = !!(req.body && req.body.aplicar);
    ok(res, repartoSvc.sembrarDesdeSplit(clientes.list().clientes, mes, { aplicar }));
  }));

  // El reparto de UN cliente, contrastado contra su % base (lo consume el editor).
  app.get('/api/os/reparto/:clienteId', (req, res) => {
    const c = clientes.get(req.params.clienteId);
    if (!c) return err(res, 404, 'cliente no encontrado');
    const mes = req.query.mes ? String(req.query.mes).slice(0, 7) : mesTZ();
    ok(res, { cliente: { id: c.id, codigo: c.codigo, nombre: c.nombre || c.nombreVisible }, mes, reparto: repartoSvc.repartoCliente(c, mes) });
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
