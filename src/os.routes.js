/**
 * os.routes.js — endpoints del núcleo comercial/financiero (LATAM Games OS v3).
 * Se montan DESPUÉS del gate de auth de la MATRIZ (todo /api/os/* requiere sesión de admin).
 * mount(app) también siembra split_base y arranca el scheduler de TC.
 * Desde la fase 2 las rutas viven partidas por tema en src/rutas/ (lo compartido, en
 * src/rutas/comun.js). Acá quedan el arranque, y el orden en que se montan los sectores.
 */
const clientes = require('./clientes-store');
const personas = require('./personas-store');
const paneles = require('./paneles-store');
const splitBase = require('./split-base-store');
const tcStore = require('./tc-store');
const movs = require('./movimientos-store');
const historial = require('./historial');
const repartoSvc = require('./reparto.service');
const pagoProv = require('./pago-proveedores.service');
const tcSvc = require('./tc.service');
const tcDivisas = require('./tc-divisas.service');
const tcColumna = require('./tc-columna.service');
const apiStore = require('./api-store');
const tbsDiario = require('./tbs-diario-store');
const tbsDiarioSvc = require('./tbs-diario.service');
const tbsComparativa = require('./tbs-comparativa');
const apiCuenta = require('./api-cuenta.service');
const apiCuentaDoc = require('./api-cuenta-doc');
const apiCuentaHtml = require('./api-cuenta-html');
const pagoProvHtml = require('./pago-proveedores-html');
const documentos = require('./documentos');
const { rolDe } = require('./auth');
const apiResumen = require('./api-resumen.service');
const tgDestino = require('./telegram-destino');
const { mesCierre: mesCierreLbl } = require('./lib/fechas');
const casinoConex = require('./casino-conexiones-store');
const acumSvc = require('./acumulado.service');
const reporteDiarioStore = require('./reporte-diario-store');
const pulsoSvc = require('./pulso.service');
const pedidosStore = require('./pedidos-store');
const deudaCargaSvc = require('./deuda-carga.service');
const movPanel = require('./movimientos-panel');
const movPanelSvc = require('./movimientos-panel.service');
const cierreStore = require('./cierre-store');
const arbolSvc = require('./arbol.service');
const externosSvc = require('./externos.service');
const tcUnico = require('./tc-unico.service');
const revision = require('./revision.service');
const estadMes = require('./estadisticas-mes.service');
const emision = require('./emision.service');
const ventasOnline = require('./ventas-online.service');
const facturaSvc = require('./factura.service');
const crucePanel = require('./cruce-panel.service');
const facturasGuardadas = require('./facturas-guardadas');
const enviosStore = require('./envios-store');
const cierreMesSvc = require('./cierre-mes.service');
const ganCache = require('./ganancias-cache');
const configStore = require('./config-store');
const telegram = require('./telegram');
const ofertas = require('./api-ofertas-store');
const ofertaHtml = require('./api-oferta-html');
const chat = require('./chat-externo.store');
const chatDoc = require('./chat-doc');
const { db } = require('./db');
const money = require('./lib/money');
const { fechaTZ, mesTZ, fechaUTC, mesUTC } = require('./lib/fechas'); // fechaTZ/mesTZ=ART (billing) · fechaUTC/mesUTC=UTC (casino)
const { ok, err, wrap, html, _facturacionDe, _urlPublica } = require('./rutas/comun');

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

/* La conexión con motor TBS y su cliente. Estaba repetido en cada ruta que le habla, y la tercera
   copia es donde uno se olvida de comprobar que tenga credenciales. */
function _tbsCliente(conexionId) {
  const cx = casinoConex.list().find((c) => c.motor === 'tbs' && (!conexionId || c.id === conexionId));
  if (!cx) return { error: 'no hay ninguna conexión con motor TBS configurada' };
  const cli = casinoConex.client(cx.id);
  if (!cli) return { error: `la conexión "${cx.nombre}" no tiene credenciales cargadas` };
  return { cli, nombre: cx.nombre, id: cx.id };
}

/* Las rutas, partidas por tema en src/rutas/ (fase 2). El orden importa: Express atiende con la
   primera que coincide, y cada archivo conserva el orden que tenían sus rutas acá. */
const SECTORES = [
  require('./rutas/ajustes.routes'),
  require('./rutas/cambios.routes'),
  require('./rutas/reparto.routes'),
  require('./rutas/proveedores.routes'),
  require('./rutas/clientes.routes'),
  require('./rutas/cuenta.routes'),
];

function mount(app) {
  splitBase.seedIfEmpty();
  // Los paquetes de la oferta comercial, una sola vez. Si ya hay alguno no se toca nada.
  try { ofertas.sembrarPaquetes(); } catch (e) { console.warn('[Ofertas] no se pudieron sembrar:', e.message); }
  historial.repararTramosDadosVuelta();   // tramos que quedaron al revés por el bug de setVigencia
  tcSvc.startScheduler();
  tcDivisas.startScheduler();
  tcColumna.startScheduler();
  acumSvc.startCron();
  // TBS tiene su propio cron y su propia hora: corta los días en la zona del panel (GMT+2), no en
  // la nuestra. Pedirle "ayer" según la hora argentina traería un día que allá no terminó.
  tbsDiarioSvc.startCron();
  /* El recordatorio del chat externo: una vez por día le dice a ELLA qué cuentas quedaron cobradas
     y sin mandar. No le manda nada a ningún cliente — eso lo sigue apretando ella. */
  require('./chat-avisos.service').startCron();
  /* EL MANTENIMIENTO SE DEVENGA SOLO. Se paga por TENER el servicio, así que apenas arranca el
     período ya es plata que el cliente debe: esperar a que alguien apretara un botón hacía que
     entrara a su portal y viera "estás al día" debiendo un mes. Cada media hora se pone al día y
     además se llama al abrir la pantalla y el portal, por si el proceso estuvo caído: es
     idempotente, la llave (cliente, caja, fecha) impide repetir. */
  const _devengar = () => {
    try {
      const r = chat.devengarMensualidades();
      if (r.creadas) console.log(`[Chat] ${r.creadas} mantenimiento(s) devengado(s)`);
    } catch (e) { console.warn('[Chat] devengar:', e.message); }
  };
  setTimeout(_devengar, 20 * 1000);
  setInterval(_devengar, 30 * 60 * 1000);

  /* TBS es su propio espacio de trabajo, no una pestaña del comercial: otros clientes, otros
     proveedores y otro cierre de mes. Desde el 6-sep-2026 también es su propio ARCHIVO.
     Antes servía el mismo os.html y se armaba distinto según la URL: 10.000 líneas para tres
     espacios, donde tocar una pantalla del panel podía romper TBS y nadie se enteraba hasta el
     cierre. Lo que de verdad se comparte quedó compartido en serio —`/estilos.css` y
     `/pantalla-tc.js`, que es LA MISMA pantalla de Tipos de cambio— y el resto se separó. */
  app.get('/tbs', (_req, res) => html(res, 'tbs.html'));
  /* El chat tiene su propio espacio, con la misma pantalla y otra barra. Ojo con el nombre: `/chat`
     es el portal PÚBLICO del cliente y no lleva login; éste es el de adentro y sí. */
  app.get('/chat-externo', (_req, res) => html(res, 'os.html'));
  // Chequeo de coherencia: columnas de la matriz sin cliente, y clientes sin columna.
  app.get('/api/os/cierre/coherencia', (_req, res) => ok(res, cierreStore.inconsistencias()));
  // 🩺 TODO lo que puede hacer que un mes salga con un número equivocado, en una sola respuesta.
  app.get('/api/os/revision', (req, res) => ok(res, revision.revisar(req.query.mes)));
  // El cruce entre Proveedores (el nombre resuelve) y Matriz (a quién se le cobra): lo que
  // ninguna de las dos contesta sola es si algo dio ganancia y no se le cobra a nadie.
  app.get('/api/os/cierre/cruce', (req, res) => ok(res, revision.cruceProveedores(req.query.mes)));
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
  /**
   * Aprobar y ejecutar. La MISMA ruta reintenta uno que quedó a medias: el estado del que se lo
   * toma decide si hay que hacer las dos mitades o sólo la que falta. Un botón menos y, sobre todo,
   * un camino menos donde equivocarse y repetir un retiro.
   */
  /* ── LO QUE VE EL PROVEEDOR ──────────────────────────────────────────────────────────────
     Estas dos rutas son las ÚNICAS que su usuario puede tocar (ver PROVEEDOR_PUEDE en auth.js) y
     son las dos de sólo lectura. Él mira; lo que se cobra y se paga lo registra ella.

     ⚠️ El cinturón de abajo es el mismo que ya cuida las hojas del cliente: si por lo que sea se
     colara un campo del negocio de ella, la ruta devuelve 500 en vez de mandarlo. Que un guard se
     dispare es una molestia; que el margen viaje, no tiene vuelta atrás. */
  const _sinMargen = (o) => {
    const t = JSON.stringify(o);
    return !/"cobra"|"pct_cliente"|"pct"\s*:\s*"?\d+"?\s*,\s*"cobra"|margen|sinPrecio|precio sin confirmar/i.test(t);
  };
  /* El acceso del proveedor, desde SU pantalla. Antes vivía en una variable del servidor: cambiar
     una contraseña obligaba a salir del sistema, y lo que es incómodo no se hace nunca. */
  app.get('/api/os/chat/proveedor-acceso', (_req, res) => ok(res, chat.proveedorAcceso()));
  app.put('/api/os/chat/proveedor-acceso', wrap((req, res) => {
    const r = chat.setProveedorAcceso(req.body || {});   // usuario, clave, generar y grupo
    r.ok ? ok(res, r) : err(res, 400, r.error);
  }));
  app.get('/api/os/proveedor/meses', (_req, res) => ok(res, { meses: chat.mesesDelProveedor() }));
  app.get('/api/os/proveedor/mes', (req, res) => {
    const mes = String(req.query.mes || '').slice(0, 7) || mesTZ();
    if (!/^\d{4}-\d{2}$/.test(mes)) return err(res, 400, 'mes inválido');
    const d = chat.paraElProveedor(mes);
    if (!_sinMargen(d)) {
      console.error('[Proveedor] se frenó una respuesta que llevaba datos internos');
      return err(res, 500, 'no pudimos armar la liquidación. Escribinos.');
    }
    ok(res, d);
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
  // ───────── CIERRE DE MES (matriz % proveedor×cliente, réplica editable de la planilla) ─────────
  app.get('/api/os/cierre/matriz', (_req, res) => ok(res, cierreStore.getMatriz()));
  app.get('/api/os/cierre/tc', (_req, res) => ok(res, cierreStore.getTC()));
  /* Los tres campos del cierre que se tipean a mano. Un porcentaje mal escrito ("12,5") vale CERO
     al calcular y no rompe nada: ese proveedor pasa a costar cero y nadie se entera. Ahora se
     rechaza al escribirlo y la pantalla lo pinta en rojo — ver _validarPct en cierre-store.js. */
  app.post('/api/os/cierre/celda', wrap((req, res) => {
    const { proveedor, cliente, pct } = req.body || {};
    const r = cierreStore.setCelda(proveedor, cliente, pct);
    r.ok ? ok(res, { guardado: true }) : err(res, 400, r.error);
  }));
  // Mantenimiento de precios en lote (SL2/SZ a 0, tope, copiar la lista de un cliente a otro…).
  // Una sola transacción; devuelve cuántas celdas se escribieron.
  app.post('/api/os/cierre/celdas-lote', wrap((req, res) => {
    const cambios = (req.body || {}).cambios;
    if (!Array.isArray(cambios)) return err(res, 400, 'falta el arreglo "cambios"');
    if (cambios.length > 20000) return err(res, 400, 'demasiados cambios en una sola llamada');
    const r = cierreStore.setCeldas(cambios);
    // Si una sola celda del lote está mal, no entra ninguna: quedarse a medias en un cambio de
    // precios masivo es peor que no haberlo hecho.
    r.ok ? ok(res, { escritas: r.escritas }) : err(res, 400, r.error);
  }));
  app.post('/api/os/cierre/base', wrap((req, res) => {
    const r = cierreStore.setBase((req.body || {}).proveedor, (req.body || {}).base_pct);
    r.ok ? ok(res, { guardado: true }) : err(res, 400, r.error);
  }));
  app.post('/api/os/cierre/descuento', wrap((req, res) => {
    const r = cierreStore.setDescuento((req.body || {}).cliente, (req.body || {}).descuento);
    r.ok ? ok(res, { guardado: true }) : err(res, 400, r.error);
  }));
  app.post('/api/os/cierre/proveedor', wrap((req, res) => ok(res, { nombre: cierreStore.addProveedor((req.body || {}).nombre, (req.body || {}).base_pct) })));
  app.delete('/api/os/cierre/proveedor/:nombre', (req, res) => ok(res, { borrado: cierreStore.removeProveedor(req.params.nombre) }));
  app.post('/api/os/cierre/cliente', wrap((req, res) => ok(res, { nombre: cierreStore.addCliente((req.body || {}).nombre, (req.body || {}).descuento) })));
  app.delete('/api/os/cierre/cliente/:nombre', (req, res) => ok(res, { borrado: cierreStore.removeCliente(req.params.nombre) }));
  app.post('/api/os/cierre/tc', wrap((req, res) => {
    const b = req.body || {};
    // `true` al final: esto lo escribió una PERSONA en la pantalla, así que vale como el real.
    // Lo que escribe el sistema solo (tc-columna, al cerrar el mes) no lleva esa marca.
    const r = cierreStore.setTC(b.moneda, b.mes, b.tasa, !!b.forzar, true);
    // El TC se tipea a mano y es el divisor de todo lo que se cobra: si viene mal escrito hay que
    // decirlo en el momento, no dejar que salga una factura en cero o mil veces más grande.
    if (r.ok) return ok(res, { guardado: true, borrado: !!r.borrado });
    // 409 = 'estás seguro?': la pantalla lo re-manda con forzar:true si el dueño confirma
    res.status(r.confirmar ? 409 : 400).json({ ok: false, error: r.error, confirmar: !!r.confirmar, anterior: r.anterior });
  }));
  /* «Este número es el real», sin tener que volver a tipearlo. Es la salida para cuando el
     promedio que puso el sistema está bien: sin esto, la única forma de sacarse el aviso de
     encima sería reescribir el mismo número. */
  app.post('/api/os/cierre/tc/confirmar', wrap((req, res) => {
    const b = req.body || {};
    const r = cierreStore.confirmarTC(b.moneda, b.mes);
    r.ok ? ok(res, r) : err(res, 400, r.error);
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
  // ───────── 📸 LA FOTO DEL MES ─────────
  // Un mes cerrado ya no cambia: se le pregunta al casino UNA vez y después todos los reportes
  // salen de la base. Antes cada reporte eran 525 consultas en vivo; ahora son 180, una vez al mes.
  app.get('/api/os/estadisticas/estado', (req, res) => ok(res, estadMes.estado(req.query.mes || mesTZ())));
  app.get('/api/os/estadisticas/meses', (_req, res) => ok(res, { meses: estadMes.meses() }));
  app.post('/api/os/estadisticas/capturar', wrap(async (req, res) => {
    const b = req.body || {};
    const r = await estadMes.capturar({
      mes: b.mes, conexionId: b.conexion_id || null,
      nivel: b.nivel || null, divisa: b.divisa || null,
      alcance: b.alcance === 'todas' ? 'todas' : 'movidas', control: !!b.control,
      desde: Number(b.desde) || 0, limite: Number(b.limite) || 0,
      refrescar: !!b.refrescar, nivelDeclarado: b.nivel_declarado || null,
    });
    r.ok ? ok(res, r) : err(res, 400, r.error);
  }));
  // El plan del mes: cuántas consultas son y cuáles. Lo usa la pantalla para ir pidiéndolas de a
  // pedazos y mostrar el avance, en vez de apretar un botón y esperar minutos sin saber nada.
  app.get('/api/os/estadisticas/plan', (req, res) => {
    // 'movidas' por defecto: sólo las monedas que el panel movió de verdad. 'todas' es la pasada
    // de descubrimiento — la única que puede encontrar una moneda que arrancó este mes.
    const alcance = req.query.alcance === 'todas' ? 'todas' : 'movidas';
    const mes = String(req.query.mes || mesTZ()).slice(0, 7);
    const p = estadMes.plan(mes, {
      conexionId: req.query.conexion_id || null, nivel: req.query.nivel || null,
      divisa: req.query.divisa || null, alcance, control: req.query.control === '1',
    });
    const completo = alcance === 'movidas'
      ? estadMes.plan(mes, { conexionId: req.query.conexion_id || null, nivel: req.query.nivel || null,
        divisa: req.query.divisa || null, alcance: 'todas' }).length
      : p.length;
    ok(res, { plan: p, alcance, consultas: p.length, siFueranTodas: completo,
      fuera: p.fuera || [], fueraTotal: p.fueraTotal || 0 });
  });
  /**
   * ── ¿DA LO MISMO LA LLAMADA GLOBAL QUE LA DE A UN NODO? ───────────────────────────────────────
   *
   * La Foto pide UNA consulta por panel y divisa (reporteProveedoresNodo). La pantalla de reportes
   * del casino, en cambio, manda `reports_user_group_by` y devuelve TODOS los nodos de ese nivel
   * en una sola respuesta — que es lo que hace reporteProveedores, escrita hace rato y sin usar.
   *
   * Los dos agrupan distinto (uno por terminal dentro del nodo, el otro por superagente/diller),
   * asi que ANTES de reescribir la extraccion hay que probar que dan el mismo profit por panel y
   * proveedor. Esto compara la llamada global contra lo que YA está guardado en la foto.
   *
   * No escribe nada: solo lee el casino y la base, y devuelve las diferencias.
   */
  app.post('/api/os/estadisticas/comparar-global', wrap(async (req, res) => {
    const b = req.body || {};
    const mes = String(b.mes || '').slice(0, 7);
    const nivel = b.nivel === 'superagente' ? 'superagente' : 'distribuidor';
    const grupoCasino = nivel === 'superagente' ? 'superagent' : 'diller';
    const cxId = String(b.conexion_id || '');
    const divisa = String(b.divisa || 'ARS').toUpperCase();
    if (!/^\d{4}-\d{2}$/.test(mes) || !cxId) return err(res, 400, 'faltan mes o conexion_id');
    const cli = casinoConex.client(cxId);
    if (!cli) return err(res, 502, 'la conexión no responde');
    const { from, to } = estadMes.rango(mes);

    const t0 = Date.now();
    const r = await cli.reporteProveedores({ from, to, currency: divisa, userGroupBy: grupoCasino });
    const segundos = Number(((Date.now() - t0) / 1000).toFixed(1));
    if (!r.ok) return err(res, 502, r.error);

    // lo global, partido por nodo
    const global = new Map();
    (r.filas || []).forEach((f) => {
      if (!global.has(f.saId)) global.set(f.saId, new Map());
      const k = [f.provider, f.label, f.vendor].join('|');
      const m = global.get(f.saId);
      m.set(k, (m.get(k) || 0) + (Number(f.profit) || 0));
    });

    // lo guardado, panel por panel, de la foto ya sacada
    const comparados = [];
    paneles.list().filter((p) => p.conexion_id === cxId && p.id_usuario).forEach((p) => {
      const guardadas = estadMes.filasDe({ conexionId: cxId, nodoId: p.id_usuario, mes, divisa, nivel });
      const g = global.get(String(p.id_usuario));
      if (!guardadas && !g) return;                       // ni foto ni global: no hay qué comparar
      const suma = (arr) => (arr || []).reduce((a, x) => a + (Number(x.profit) || 0), 0);
      const totalFoto = suma(guardadas);
      const totalGlobal = g ? [...g.values()].reduce((a, x) => a + x, 0) : null;
      const fila = { panel: p.nombre, nodo: String(p.id_usuario),
        nivelDelPanel: p.nivel_usuario || '',
        // ¿se está comparando en el nivel en el que ESE panel factura, o en el otro? Un panel
        // medido en el nivel que no le corresponde no tiene por qué dar lo mismo, y mezclarlos
        // haría parecer que los dos reportes no coinciden cuando el problema es la comparación.
        esSuNivel: estadMes.nivelDe(p) === nivel,
        enLaFoto: !!guardadas, enElGlobal: !!g,
        filasFoto: (guardadas || []).length, filasGlobal: g ? g.size : 0,
        totalFoto: guardadas ? Number(totalFoto.toFixed(2)) : null,
        totalGlobal: g ? Number(totalGlobal.toFixed(2)) : null };
      if (guardadas && g) {
        fila.dif = Number((totalGlobal - totalFoto).toFixed(2));
        // dónde difiere, proveedor por proveedor
        const porProv = [];
        const claves = new Set([...(guardadas || []).map((x) => [x.provider, x.label, x.vendor].join('|')), ...g.keys()]);
        claves.forEach((k) => {
          const a = (guardadas || []).filter((x) => [x.provider, x.label, x.vendor].join('|') === k)
            .reduce((z, x) => z + (Number(x.profit) || 0), 0);
          const z = g.get(k) || 0;
          if (Math.abs(z - a) > 0.01) porProv.push({ sello: k, foto: Number(a.toFixed(2)), global: Number(z.toFixed(2)) });
        });
        fila.proveedoresQueDifieren = porProv.slice(0, 8);
      }
      comparados.push(fila);
    });

    const ambos = comparados.filter((x) => x.enLaFoto && x.enElGlobal);
    const propios = ambos.filter((x) => x.esSuNivel);
    const otros = ambos.filter((x) => !x.esSuNivel);
    ok(res, { mes, divisa, nivel, segundos,
      enSuNivel: { comparables: propios.length, iguales: propios.filter((x) => Math.abs(x.dif) < 0.01).length,
        distintos: propios.filter((x) => Math.abs(x.dif) >= 0.01) },
      enElOtroNivel: { comparables: otros.length, iguales: otros.filter((x) => Math.abs(x.dif) < 0.01).length,
        distintos: otros.filter((x) => Math.abs(x.dif) >= 0.01).length },
      filasQueTrajoLaGlobal: (r.filas || []).length,
      nodosQueTrajoLaGlobal: global.size,
      comparables: ambos.length,
      iguales: ambos.filter((x) => Math.abs(x.dif) < 0.01).length,
      distintos: ambos.filter((x) => Math.abs(x.dif) >= 0.01),
      soloEnLaFoto: comparados.filter((x) => x.enLaFoto && !x.enElGlobal).map((x) => x.panel),
      soloEnElGlobal: comparados.filter((x) => !x.enLaFoto && x.enElGlobal).length,
    });
  }));
  /**
   * ── LA PRUEBA QUE NO DEPENDE DE LO GUARDADO ───────────────────────────────────────────────────
   *
   * Comparar contra la foto ya sacada no alcanzó: lo único guardado de julio son superagentes
   * medidos a nivel distribuidor (la pasada de control), o sea ninguna combinación en el nivel que
   * le corresponde al panel. Comparar eso no dice si los dos reportes coinciden — dice que un panel
   * medido en el nivel que no es da distinto, que es lo esperado.
   *
   * Acá se llaman LAS DOS EN VIVO para el mismo panel, mes, divisa y nivel:
   *   reporteProveedoresNodo → una consulta scopeada a ese nodo (lo que hace la Foto hoy)
   *   reporteProveedores     → una sola consulta global, partida por nodo (lo que hace la pantalla)
   *
   * ⚠️ EL NIVEL. reporteProveedoresNodo NO manda `reports_user_group_by`: usa el que el casino tiene
   * guardado en la sesión. Así que la global se pide con ESE mismo nivel, leído con modoActual, o se
   * estarían comparando dos cosas distintas y la diferencia no querría decir nada.
   */
  app.post('/api/os/estadisticas/comparar-vivo', wrap(async (req, res) => {
    const b = req.body || {};
    const mes = String(b.mes || '').slice(0, 7);
    const cxId = String(b.conexion_id || '');
    const divisa = String(b.divisa || 'ARS').toUpperCase();
    const cuantos = Math.min(Number(b.limite) || 5, 15);
    if (!/^\d{4}-\d{2}$/.test(mes) || !cxId) return err(res, 400, 'faltan mes o conexion_id');
    const cli = casinoConex.client(cxId);
    if (!cli) return err(res, 502, 'la conexión no responde');
    const { from, to } = estadMes.rango(mes);

    const modo = await estadMes.modoActual(cli);
    if (!modo.ok) return err(res, 502, 'no se pudo leer cómo agrupa el casino: ' + modo.error);

    const g = await cli.reporteProveedores({ from, to, currency: divisa, userGroupBy: modo.valor });
    if (!g.ok) return err(res, 502, 'la global falló: ' + g.error);
    const porNodo = new Map();
    (g.filas || []).forEach((f) => {
      if (!porNodo.has(f.saId)) porNodo.set(f.saId, new Map());
      const k = [f.provider, f.label, f.vendor].join('|');
      porNodo.get(f.saId).set(k, (porNodo.get(f.saId).get(k) || 0) + (Number(f.profit) || 0));
    });

    // se comparan paneles del OS que la global haya traído, y que estén en el nivel que el casino
    // tiene puesto — si no, se compara un panel contra un nivel que no le corresponde.
    const candidatos = paneles.list()
      .filter((p) => p.conexion_id === cxId && p.id_usuario && porNodo.has(String(p.id_usuario))
        && estadMes.nivelDe(p) === modo.nivel)
      .slice(0, cuantos);

    const filas = [];
    for (const p of candidatos) {
      const r = await cli.reporteProveedoresNodo({ nodoId: p.id_usuario, from, to, currency: divisa });
      if (!r.ok) { filas.push({ panel: p.nombre, error: r.error }); continue; }
      const nodo = new Map();
      (r.filas || []).forEach((f) => {
        const k = [f.provider, f.label, f.vendor].join('|');
        nodo.set(k, (nodo.get(k) || 0) + (Number(f.profit) || 0));
      });
      const glob = porNodo.get(String(p.id_usuario));
      const sum = (m) => [...m.values()].reduce((a, x) => a + x, 0);
      const claves = new Set([...nodo.keys(), ...glob.keys()]);
      const difs = [];
      claves.forEach((k) => {
        const a = nodo.get(k) || 0, z = glob.get(k) || 0;
        if (Math.abs(z - a) > 0.01) difs.push({ sello: k, porNodo: Number(a.toFixed(2)), global: Number(z.toFixed(2)) });
      });
      filas.push({ panel: p.nombre, nodo: String(p.id_usuario), nivel: p.nivel_usuario,
        totalPorNodo: Number(sum(nodo).toFixed(2)), totalGlobal: Number(sum(glob).toFixed(2)),
        dif: Number((sum(glob) - sum(nodo)).toFixed(2)),
        sellosPorNodo: nodo.size, sellosGlobal: glob.size,
        difieren: difs.length, ejemplos: difs.slice(0, 6) });
    }
    ok(res, { mes, divisa, nivelDelCasino: modo.nivel, valorCrudo: modo.valor,
      nodosEnLaGlobal: porNodo.size, comparados: filas.length,
      iguales: filas.filter((x) => x.dif !== undefined && Math.abs(x.dif) < 0.01).length, filas });
  }));
  /** La extracción nueva: una llamada por divisa. Con guardar:false no escribe nada. */
  app.post('/api/os/estadisticas/capturar-global', wrap(async (req, res) => {
    const b = req.body || {};
    const mes = String(b.mes || '').slice(0, 7);
    // Sin `divisas` explícitas se sacan las del plan: todas las habilitadas de esa conexión. Ya no
    // hay que elegir — cada divisa es UNA consulta, no decenas.
    let divisas = Array.isArray(b.divisas) ? b.divisas : null;
    if (!divisas) {
      divisas = [...new Set(estadMes.planGlobal(mes, { conexionId: b.conexion_id })
        .filter((x) => !b.conexion_id || x.conexion_id === b.conexion_id).map((x) => x.divisa))];
    }
    // Troceado por divisa: son 1 a 3 segundos cada una y el proxy corta a los 5 minutos.
    const desde = Number(b.desde) || 0;
    const limite = Number(b.limite) || 12;
    const tanda = divisas.slice(desde, desde + limite);
    const r = await estadMes.capturarGlobal({
      mes, conexionId: b.conexion_id,
      // sin nivel declarado, se usa el que tenga el casino; con nivel, se rechaza si no coincide
      nivel: ['distribuidor', 'superagente', 'general'].includes(b.nivel) ? b.nivel : null,
      divisas: tanda, plantilla: b.plantilla || '', guardar: b.guardar !== false,
      // rehacer sólo si se pide explícito: sin esto, una corrida de más pisa un mes cerrado
      rehacer: !!b.rehacer,
    });
    if (!r.ok) return err(res, 502, r.error);
    ok(res, { ...r, totalDivisas: divisas.length, desde, devueltos: tanda.length,
      hay_mas: desde + tanda.length < divisas.length });
  }));
  /**
   * En qué nivel está agrupando cada casino AHORA. Es lo que decide qué vuelta sale al apretar
   * "sacar": el nivel no se elige desde el OS, se lee. Sin esto hay que apretar para enterarse.
   */
  app.get('/api/os/estadisticas/modos', wrap(async (_req, res) => {
    const out = [];
    // listDeReportes: preguntarle el nivel a las conexiones de carga era una consulta al casino por
    // cada una para pintar un cartel al lado de una tarjeta que ya no se muestra.
    for (const cx of casinoConex.listDeReportes()) {
      const cli = casinoConex.client(cx.id);
      if (!cli) { out.push({ id: cx.id, nombre: cx.nombre, error: 'la conexión no responde' }); continue; }
      const m = await estadMes.modoActual(cli);
      out.push({ id: cx.id, nombre: cx.nombre,
        nivel: m.ok ? m.nivel : null, valor: m.ok ? m.valor : null,
        porDefecto: m.ok ? !!m.porDefecto : null, error: m.ok ? null : m.error });
    }
    ok(res, { conexiones: out });
  }));
  /**
   * Qué meses de TBS ya están guardados. Es el equivalente de "Meses con foto" del comercial: hasta
   * ahora la precarga de TBS existía pero no se veía, así que para saber si un mes estaba sacado
   * había que apretar y esperar.
   */
  app.get('/api/os/api/guardado', wrap((_req, res) => {
    const filas = db.prepare(`SELECT mes, COUNT(*) n, MAX(capturedAt) ultimo
      FROM ganancias_cache WHERE nodo LIKE 'api:%' OR nodo LIKE '_tbs%' OR nodo='_pago_general'
      GROUP BY mes ORDER BY mes DESC`).all();
    ok(res, { meses: filas });
  }));
  /**
   * Rehacer el caché del pago a proveedores desde la Foto, a mano.
   *
   * La reparación automática sólo se dispara cuando al caché le FALTAN divisas. Si el caché quedó
   * mal por otra razón —como el día que se rearmó sumando la plataforma más cada panel— hace falta
   * poder forzarlo. No consulta al casino: sale entero de lo que la Foto ya tiene guardado.
   */
  app.post('/api/os/estadisticas/rehacer-pago-general', wrap((req, res) => {
    const mes = String((req.body || {}).mes || mesTZ()).slice(0, 7);
    const uno = (req.body || {}).conexion_id;
    const salida = casinoConex.listDeReportes()
      .filter((c) => !uno || c.id === uno)
      .map((c) => ({ conexion: c.nombre, ...estadMes.rehacerPagoGeneralDesdeFoto(c.id, mes) }));
    ok(res, { mes, conexiones: salida });
  }));
  app.delete('/api/os/estadisticas/:mes', (req, res) => { estadMes.borrarMes(req.params.mes); ok(res); });
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
    /* ⚠️ ESCRITO CON COMA SE GUARDA Y VALE CERO. La librería de plata no entiende "6,5": devuelve
       0 sin quejarse, y este % es el número por el que se multiplica todo. Con 0 pasan DOS cosas a
       la vez: la factura de consumo sale en cero, y al proveedor externo se le cobra el 100% de la
       celda en vez del excedente. Los tipos de cambio y la matriz ya se validaban así; éste era el
       único número tipeado a mano que había quedado afuera (auditoría del 3-oct-2026). */
    if (!money.esNumero(base_pct)) {
      return err(res, 400, `"${base_pct}" no es un número. Escribilo con punto: 6.5`);
    }
    ok(res, { confirmada: externosSvc.confirmarBase(req.params.cliente, mes, base_pct) });
  }));
  /**
   * Resumen de TODOS los clientes del mes: el % de cada uno, el del mes anterior, y si ya se
   * confirmó. Es lo que come el repaso.
   *
   * 🔴 ACÁ LEÍA LA COLUMNA EQUIVOCADA. Sacaba el % de `c.precio_base_pct`, que es un campo de la
   * ficha — y el % NO vive ahí: es versionado (config_valores, vía historial.js), y esa columna
   * está vacía para casi todos. Resultado: la pantalla cuyo trabajo es decir "quién falta
   * confirmar" informaba 43 de 47 clientes SIN % base cuando en realidad faltaba UNO solo.
   * El número bueno lo resuelve `baseDelMes`, que es la única función que responde esta pregunta
   * en todo el sistema (mira el precio propio del panel, el confirmado del mes, y el vigente al
   * cierre, en ese orden).
   */
  app.get('/api/os/externos', wrap(async (req, res) => {
    const mes = req.query.mes || new Date().toISOString().slice(0, 7);
    const soloVendedor = req.query.vendedor || null;
    // El mes anterior, para poder decir "sigue igual que en julio" en vez de sólo mostrar un número.
    const [ay, am] = String(mes).split('-').map(Number);
    const prevD = new Date(Date.UTC(ay, am - 2, 1));
    const prev = prevD.getUTCFullYear() + '-' + String(prevD.getUTCMonth() + 1).padStart(2, '0');
    const lista = clientes.list().clientes
      .filter((c) => !soloVendedor || String(c.vendedor_id) === String(soloVendedor))
      .map((c) => {
        const g = externosSvc.baseGuardada(c.nombre, mes);
        const r = externosSvc.baseDelMes(c, mes);
        const rp = externosSvc.baseDelMes(c, prev);
        return {
          cliente: c.nombre, id: c.id, codigo: c.codigo,
          esVendedor: !!c.es_vendedor, vendedor_id: c.vendedor_id || null,
          base: r.valor != null ? String(r.valor) : null, fuente: r.fuente,
          basePrev: rp.valor != null ? String(rp.valor) : null,
          confirmada: !!g, confirmadoAt: g ? g.confirmadoAt : null,
          margenExtra: c.margen_externos_pct ?? null,
        };
      });
    ok(res, { mes, prev, clientes: lista });
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
  // ── EL ARCHIVO DE LO QUE SE ENVIÓ ────────────────────────────────────────────────────────────
  //
  // /hoja recalcula y sirve para mirar; esto CONGELA. La diferencia importa: entre que se manda un
  // documento y que se lo vuelve a abrir pueden cargarse costos, corregirse un TC o descongelarse
  // el mes — todo legítimo, y todo cambia el número. El dueño necesita poder abrir lo que envió,
  // no una versión mejorada de lo que envió.
  app.post('/api/os/documentos/pago-proveedores', wrap(async (req, res) => {
    const b = req.body || {};
    const mes = String(b.mes || mesTZ()).slice(0, 7);
    // Sin `refrescar`: emitir tiene que ser barato y repetible. Si falta traer el mes, se trae antes
    // desde la pantalla — que una emisión dispare 525 consultas al casino es la forma más fácil de
    // que se emita a medias y quede guardado así para siempre.
    const rep = await pagoProv.reporte({ mes });
    if (!rep.ok) return err(res, 400, rep.error);
    // 🔒 Un documento que no cuadra no se emite. Es lo mismo que dice la hoja en rojo ("no pagar con
    // esta hoja"), pero acá se puede impedir de verdad en vez de sólo avisarlo.
    if (rep.cuadre && !rep.cuadre.cuadra) {
      return err(res, 400, 'las cuatro vistas no dan el mismo total: es un error de cálculo y no se '
        + 'puede emitir un documento así. Mirá la vista previa para ver dónde está la diferencia.');
    }
    // ⚠️ UN MES SIN CONGELAR USA LOS PRECIOS DE HOY. El documento en sí no cambia nunca (son bytes),
    // pero el mismo mes recalculado el mes que viene puede dar otro número, y hay que saber que
    // salió de ahí. Se pide confirmación una vez, igual que /precargar con requiereConfirmar.
    if (!rep.congelado && !b.confirmar) {
      return err(res, 400, `${mes} no está congelado: el cálculo usa los precios de HOY, así que el `
        + 'mes que viene el mismo mes puede dar otro número. El documento que emitas no va a cambiar, '
        + 'pero conviene congelar el mes primero. Confirmá si querés emitirlo igual.',
      { requiereConfirmar: true });
    }
    const r = documentos.emitir({
      tipo: 'pago-proveedores', mes, datos: rep, nota: b.nota,
      por: rolDe(req) || 'admin',
      congelado: !!rep.congelado,
      csv: pagoProv.csv(rep),
      render: (emision) => pagoProvHtml.hoja(rep, emision),
    });
    r.ok ? ok(res, r) : err(res, 400, r.error);
  }));
  app.get('/api/os/documentos', wrap(async (req, res) => ok(res, {
    documentos: documentos.list({ tipo: req.query.tipo || null, mes: req.query.mes || null }),
  })));
  // Los BYTES guardados, tal cual. No se re-renderiza ni se le agrega nada: cualquier agregado, por
  // chico que sea, ya no es el documento que se envió.
  app.get('/api/os/documentos/:id', wrap(async (req, res) => {
    const d = documentos.contenido(req.params.id);
    if (!d) return err(res, 404, 'no encontré ese documento');
    res.type('html').send(d.html);
  }));
  // El CSV congelado. Si el documento es viejo y no lo tiene guardado, se regenera del JSON — que
  // es lo que había antes y sigue siendo correcto para esos.
  app.get('/api/os/documentos/:id/planilla.csv', wrap(async (req, res) => {
    const d = documentos.contenido(req.params.id);
    if (!d) return err(res, 404, 'no encontré ese documento');
    const texto = d.csv || (d.datos ? pagoProv.csv(d.datos) : null);
    if (texto == null) return err(res, 404, 'ese documento no tiene planilla');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition',
      `attachment; filename="pago-proveedores-${d.mes}-v${d.version}.csv"`);
    res.send('\ufeff' + texto);
  }));
  // ── BAJAR EL ARCHIVO ─────────────────────────────────────────────────────────────────────────
  // Todo esto vive en el volumen de Railway, y /api/_backup no dumpea las tablas del OS: si se
  // pierde el volumen, se pierde el documento. Que se pueda bajar el .html a mano es la copia de
  // seguridad que no depende de nada de acá.
  app.get('/api/os/documentos/:id/archivo.html', wrap(async (req, res) => {
    const d = documentos.contenido(req.params.id);
    if (!d) return err(res, 404, 'no encontré ese documento');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Disposition',
      `attachment; filename="pago-proveedores-${d.mes}-v${d.version}.html"`);
    res.send(d.html);
  }));
  // La comprobación del hash, para poder afirmar que el archivo no se tocó.
  app.get('/api/os/documentos/:id/verificar', wrap(async (req, res) => {
    const d = documentos.contenido(req.params.id);
    if (!d) return err(res, 404, 'no encontré ese documento');
    ok(res, { id: d.id, tipo: d.tipo, mes: d.mes, version: d.version, emitido_at: d.emitido_at,
      hash: d.hash, intacto: d.intacto, bytes: Buffer.byteLength(d.html, 'utf8') });
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
  // ───────── 🔌 API (TBS) — el otro negocio ─────────
  // Padrón APARTE del de fichas: otros clientes, otros %, y el % es POR SELLO.
  app.get('/api/os/api/clientes', (_req, res) => ok(res, { clientes: apiStore.listClientes() }));
  app.post('/api/os/api/clientes', wrap((req, res) => {
    const r = apiStore.saveCliente(req.body || {});
    r.ok ? ok(res, r) : err(res, 400, r.error);
  }));
  app.delete('/api/os/api/clientes/:id', wrap((req, res) => ok(res, apiStore.removeCliente(req.params.id))));
  /* El nombre del cierre va por su propia ruta y no por `saveCliente`: aquélla reescribe login,
     agente y notas con lo que venga en el cuerpo, así que mandarle sólo el nombre los borraría. */
  app.put('/api/os/api/clientes/:id/nombre', wrap((req, res) => {
    const r = apiStore.setDeQuien(req.params.id, (req.body || {}).nombre);
    r.ok ? ok(res, r) : err(res, 400, r.error);
  }));
  app.delete('/api/os/api/clientes/:id/nombres-viejos', wrap((req, res) => {
    const r = apiStore.limpiarNombresViejos(req.params.id);
    r.ok ? ok(res, r) : err(res, 400, r.error);
  }));
  app.get('/api/os/api/sellos', (_req, res) => ok(res, { sellos: apiStore.listSellos() }));
  /* ── OFERTAS COMERCIALES ─────────────────────────────────────────────────────────────────────
     La oferta ES el precio: se arma una vez, se manda como documento y al aceptarla escribe la
     matriz. Antes se cotizaba en una hoja aparte y después había que volver a tipear los mismos
     números para poder facturar — dos lugares con el mismo dato es cómo terminan distintos. */
  /* ── CHAT EXTERNO ────────────────────────────────────────────────────────────────────────────
     Un servicio de terceros que algunos paneles contratan. Los dos lados tienen precios distintos:
     al cliente se le cobra lo negociado, al proveedor se le paga un % fijo, y la diferencia es el
     margen. Sale de la ganancia que el acumulado ya captura todas las noches. */
  app.get('/api/os/chat/config', (_req, res) => ok(res, { config: chat.config() }));
  app.put('/api/os/chat/config', wrap((req, res) => {
    const r = chat.setConfig(req.body || {});
    r.ok ? ok(res, r) : err(res, 400, r.error);
  }));
  app.get('/api/os/chat/paneles', (_req, res) => (chat.devengarMensualidades(), ok(res, {
    paneles: chat.list(), config: chat.config(), destinos: chat.destinos(),
    wallets: chat.wallets(), apagadas: chat.walletsApagadasEnUso(),
  })));
  app.post('/api/os/chat/wallets', wrap((req, res) => {
    const r = chat.guardarWallet(req.body || {});
    r.ok ? ok(res, r) : err(res, 400, r.error);
  }));
  app.delete('/api/os/chat/wallets/:id', wrap((req, res) => {
    const r = chat.borrarWallet(req.params.id);
    r.ok ? ok(res, r) : err(res, 400, r.error);
  }));
  app.post('/api/os/chat/paneles', wrap((req, res) => {
    const r = chat.set(req.body || {});
    r.ok ? ok(res, r) : err(res, 400, r.error);
  }));
  app.delete('/api/os/chat/paneles/:id', wrap((req, res) => ok(res, chat.quitar(req.params.id))));
  app.get('/api/os/chat/cierre', (req, res) => ok(res, chat.cierre(String(req.query.mes || '').slice(0, 7) || mesTZ())));
  app.get('/api/os/chat/mensualidades', (req, res) => ok(res, chat.mensualidadesDe(req.query.fecha || fechaTZ())));
  /* ── EL MES AGRUPADO POR CLIENTE ────────────────────────────────────────────────────────────
     La cuenta se la mandás al CLIENTE, no al panel: uno con tres paneles paga una sola cuenta. */
  app.get('/api/os/chat/por-cliente', (req, res) => {
    chat.devengarMensualidades();      // al mirar la pantalla, lo vencido ya está adentro
    const mes = String(req.query.mes || '').slice(0, 7) || mesTZ();
    const pc = chat.porCliente(mes);
    ok(res, {
      ...pc, pagado: chat.pagado(mes), pagos: chat.pagos(mes),
      // Lo que le debés al proveedor, abierto en sus dos partes: el % y el mantenimiento van a
      // wallets distintas y se pagan en fechas distintas.
      deudaProv: chat.deudaProveedor(mes),
      envios: chat.envios(mes), cuentas: chat.cuentas(mes), arrastre: chat.cuentas(null),
      /* Lo que está cobrado y sin mandar. Va también a la pantalla y no sólo al recordatorio de
         Telegram: si el bot falla o falta el grupo, éste es el único lugar donde se ve. */
      listas: chat.listasParaMandar(),
      // El mantenimiento caja por caja, para poder ver cuáles quedaron al día y cuáles no.
      mantCajas: Object.fromEntries((pc.clientes || []).map((g) => [g.cliente_id, chat.mantenimientoPorCaja(g.cliente_id)])),
      avisos: chat.avisosPendientes(), solicitudes: chat.solicitudesPendientes(),
      // Y los últimos resueltos: sin esto, apenas aprobabas uno desaparecía y no había desde dónde
      // reenviarle el comprobante al proveedor.
      avisosResueltos: chat.avisosResueltos(12),
    });
  });
  // A dónde se le manda la cuenta de ESTE servicio (grupo propio, ver la tabla chat_cliente).
  app.get('/api/os/chat/destino/:clienteId', (req, res) => ok(res, { destino: chat.destino(req.params.clienteId) }));
  app.put('/api/os/chat/destino/:clienteId', wrap((req, res) => {
    const r = chat.setDestino({ ...(req.body || {}), cliente_id: req.params.clienteId });
    r.ok ? ok(res, r) : err(res, 400, r.error);
  }));
  /* ── LAS DOS HOJAS ──────────────────────────────────────────────────────────────────────────
     La del cliente sale de `paraCliente`, que NO arrastra el costo ni el margen; la del proveedor
     sale de `paraProveedor`, que no arrastra lo que le cobrás a cada cliente. El chequeo de abajo
     es cinturón y tiradores: esto se le muestra a alguien de afuera y no hay vuelta atrás. */
  /* Con `divisa`, la hoja de UNA de sus cuentas. Un cliente con cajas en dos monedas recibe dos:
     a veces son dos negocios con socios distintos.

     ⚠️ EL TOTAL SE VUELVE A SUMAR CAJA POR CAJA, no se recalcula como el % de la ganancia junta.
     `cobra` se redondea en cada caja, así que las de Ariel en PYG dan 292,10 sumando y 292,09
     haciendo el 4% de 7.302,35 — un centavo, y la hoja deja de cerrar contra su propio detalle.
     Y `sinTC` se recalcula sobre lo filtrado: el aviso de «falta un tipo de cambio» es de todo el
     cliente, y arrastrarlo entero pondría el cartel en la hoja de la cuenta que no lo tiene. */
  function _hojaCliente(mes, clienteId, divisa) {
    const pc = chat.porCliente(mes);
    const g = (pc.clientes || []).find((x) => String(x.cliente_id) === String(clienteId));
    if (!g) return null;
    const dv = String(divisa || '').toUpperCase();
    if (!dv) return chatDoc.paraCliente(g, { mes: pc.mes });
    const paneles = (g.paneles || []).filter((p) => chat.divisaDelPanel(p) === dv);
    if (!paneles.length) return null;
    const gd = {
      ...g,
      paneles,
      monedas: (g.monedas || []).filter((m) => String(m.moneda || '').toUpperCase() === dv),
      cobra: paneles.reduce((a, p) => require('./lib/money').add(a, p.cobra || '0'), '0'),
      sinTC: paneles.some((p) => (p.detalle || []).some((x) => Number(x.profit) > 0 && x.usdt == null)),
    };
    return { ...chatDoc.paraCliente(gd, { mes: pc.mes }), divisa: dv };
  }
  /* ── LA HOJA DE UNA CUENTA TIENE QUE CERRAR CONSIGO MISMA ────────────────────────────────────
     Filtrar la tabla de arriba no alcanza: el saldo, el total del mes y el desglose de "qué se te
     cobró" venían del cliente ENTERO. La hoja de guaraníes decía «debés 906,34» arriba y 742,10
     abajo, y el que la lee no tiene forma de saber cuál de los dos es el suyo.
     Sin divisa devuelven lo de siempre: el cliente de una sola moneda no pasa por acá. */
  function _saldoDe(todo, dv) {
    if (!todo) return null;
    if (!dv) return todo;
    const d = (todo.porDivisa || []).find((x) => x.divisa === dv);
    return d ? { ...d, movs: (todo.movs || []).filter((m) => String(m.divisa || '').toUpperCase() === dv) } : null;
  }
  function _cobradoDe(esteMes, dv) {
    if (!esteMes) return null;
    if (!dv) return esteMes.cobrado;
    const d = (esteMes.porDivisa || []).find((x) => x.divisa === dv);
    return d ? d.cobrado : '0';
  }
  const _movsDe = (esteMes, dv) => (esteMes ? esteMes.movs : [])
    .filter((m) => !dv || String(m.divisa || '').toUpperCase() === dv);
  function _sinDatosInternos(html) {
    return !/margen|costo|pct_costo|te cuesta|paga:/i.test(html);
  }
  app.get('/api/os/chat/doc/cliente/:clienteId', (req, res) => {
    const mes = String(req.query.mes || '').slice(0, 7) || mesTZ();
    const doc = _hojaCliente(mes, req.params.clienteId, req.query.divisa);
    if (!doc) return err(res, 404, 'ese cliente no tiene nada en el chat externo ese mes');
    // La vista previa muestra lo MISMO que va a ver el cliente, salvo el formulario: mirar una
    // versión distinta de la que se manda no sirve para revisarla.
    const dvP = String(req.query.divisa || '').toUpperCase();
    const todo = chat.cuentas(null).clientes.find((x) => x.cliente_id === req.params.clienteId) || null;
    const esteMes = chat.cuentas(mes).clientes.find((x) => x.cliente_id === req.params.clienteId) || null;
    const html = chatDoc.htmlCliente(doc, {
      pago: chat.comoPagar(req.params.clienteId),
      // El saldo de ESA cuenta, no el del cliente entero: la hoja de guaraníes tiene que cerrar
      // con lo que dice arriba, y el total del cliente incluye la otra.
      saldo: _saldoDe(todo, dvP),
      cobradoMes: _cobradoDe(esteMes, dvP),
      // Los movimientos del mes, para poder decir DE QUÉ está hecho ese total: el % y el
      // mantenimiento son dos cobros distintos y meterlos en un solo número los confunde.
      movsMes: _movsDe(esteMes, dvP) });
    if (!_sinDatosInternos(html)) return err(res, 500, 'la hoja traía datos internos: NO se generó. Avisá que esto pasó.');
    res.type('text/html; charset=utf-8').send(html);
  });
  app.get('/api/os/chat/doc/proveedor', (req, res) => {
    const mes = String(req.query.mes || '').slice(0, 7) || mesTZ();
    const doc = chatDoc.paraProveedor(chat.porCliente(mes), { mes, mantenimiento: chat.deudaProveedor(mes).mantenimiento });
    res.type('text/html; charset=utf-8').send(chatDoc.htmlProveedor(doc));
  });
  /* ── MANDARLE LA CUENTA AL CLIENTE ──────────────────────────────────────────────────────────
     Sale para AFUERA: se manda de verdad. El link guarda la hoja YA PROYECTADA, así que lo que el
     cliente abre es lo mismo que viste vos, aunque después cambie un tipo de cambio. */
  app.post('/api/os/chat/enviar/:clienteId', wrap(async (req, res) => {
    const mes = String((req.body || {}).mes || '').slice(0, 7) || mesTZ();
    /* Una cuenta a la vez. Un cliente con cajas en dos monedas recibe dos mensajes, cada uno con
       lo suyo: son dos negocios, y a veces con socios distintos. */
    const dv = String((req.body || {}).divisa || '').toUpperCase();
    const doc = _hojaCliente(mes, req.params.clienteId, dv);
    if (!doc) return err(res, 404, 'ese cliente no tiene nada en el chat externo ese mes');
    const d = chat.destino(req.params.clienteId);
    if (!d.grupos.length) return err(res, 400, 'ese cliente todavía no tiene grupo de Telegram para este servicio');
    /* El link con token se sigue generando —ella lo copia con el botón «Link» cuando lo necesita, y
       es la foto congelada del mes—, pero al grupo NO va: lo que se manda es el portal. Un token en
       un grupo de Telegram es una llave suelta, y muestra un mes viejo si se abre en diciembre. */
    const l = chatDoc.crearLink(doc, req.params.clienteId);
    const url = _urlPublica(req) + '/chat/' + l.token;
    const portal = _urlPublica(req) + '/chat';
    /* Con el resumen adelante: qué es el mantenimiento, por qué período, y si el % ya se cobró.
       Sale de los movimientos del mes, que es lo REGISTRADO — no de la proyección del documento.
       Las cajas van para poder nombrarlas por su link, que es como las reconoce el cliente. */
    const esteMesTg = chat.cuentas(mes).clientes.find((x) => x.cliente_id === req.params.clienteId);
    // Los movimientos de ESA cuenta: el mensaje tiene que decir lo mismo que la hoja que acompaña.
    const movsTg = ((esteMesTg && esteMesTg.movs) || [])
      .filter((m) => !dv || String(m.divisa || '').toUpperCase() === dv);
    const cajasTg = chat.list().filter((p) => p.cliente_id === req.params.clienteId
      && (!dv || String(p.divisa || '').toUpperCase() === dv));
    const texto = chatDoc.textoTelegram(mes, movsTg, portal, cajasTg,
      chat.comoPagar(req.params.clienteId), dv);
    /* A TODOS los grupos: a veces el encargado tiene que enterarse y no está en el mismo grupo que
       el cliente. Se manda de a uno y se guarda el resultado de cada uno — si falla el segundo, no
       puede quedar como que salió todo bien. */
    const tok = chat.botToken();
    const idas = [];
    for (const g of d.grupos) {
      // eslint-disable-next-line no-await-in-loop
      const r1 = await telegram.sendMessage(tok, g, texto);
      idas.push({ grupo: g, ok: !!r1.ok, error: r1.error || null });
    }
    const fallaron = idas.filter((x) => !x.ok);
    const r = fallaron.length
      ? { ok: false, error: fallaron.map((x) => `${x.grupo}: ${x.error}`).join(' · ') }
      : { ok: true };
    // Queda anotado que se mandó: sin esto, "¿se la mandaste?" no tiene respuesta.
    chat.marcarEnviado(req.params.clienteId, mes, r, dv);
    r.ok ? ok(res, { url, portal, token: l.token, divisa: dv, enviado: idas.length, idas })
      : err(res, 502, `salió a ${idas.length - fallaron.length} de ${idas.length}: ${r.error}`,
        { url, token: l.token, idas });
  }));
  // El link sin mandarlo: para copiarlo y pegarlo donde ella quiera.
  app.post('/api/os/chat/link/:clienteId', wrap((req, res) => {
    const mes = String((req.body || {}).mes || '').slice(0, 7) || mesTZ();
    const doc = _hojaCliente(mes, req.params.clienteId);
    if (!doc) return err(res, 404, 'ese cliente no tiene nada en el chat externo ese mes');
    const l = chatDoc.crearLink(doc, req.params.clienteId);
    ok(res, { url: _urlPublica(req) + '/chat/' + l.token, token: l.token, actualizado: l.actualizado });
  }));
  /* ── LA CUENTA DEL CHAT, QUE ES OTRA CUENTA ─────────────────────────────────────────────────
     No pasa por `movimientos` ni por el cierre del mes: esta plata no es toda de ella —la mitad se
     le paga al proveedor—, se cobra en otra wallet y se habla en otro grupo. Ver el comentario de
     la tabla `chat_mov`. Cobrar congela el número; apretar dos veces no cobra dos veces. */
  app.post('/api/os/chat/cobrar', wrap((req, res) => {
    const mes = String((req.body || {}).mes || '').slice(0, 7) || mesTZ();
    const r = chat.cobrar(mes, { confirmar: (req.body || {}).confirmar === true });
    if (r.ok) r.salteados = chat.porCliente(mes).salteados || [];
    r.ok ? ok(res, r) : err(res, 400, r.error, { requiereConfirmar: !!r.requiereConfirmar, sinTC: r.sinTC || [] });
  }));
  app.post('/api/os/chat/descobrar', wrap((req, res) => {
    const b = req.body || {};
    const mes = String(b.mes || '').slice(0, 7) || mesTZ();
    ok(res, chat.descobrar(mes, b.cliente_id || null));
  }));
  app.get('/api/os/chat/cuentas', (req, res) => {
    // Sin `mes` devuelve el arrastre: alguien puede deber tres meses y eso no se ve mirando uno.
    ok(res, { mes: chat.cuentas(req.query.mes || null), todo: chat.cuentas(null) });
  });
  app.post('/api/os/chat/cobros', wrap((req, res) => {
    const r = chat.pagarCliente(req.body || {});
    r.ok ? ok(res, r) : err(res, 400, r.error);
  }));
  /* SALDAR UNA DIFERENCIA. El cliente que paga en pesos usa SU tipo de cambio: si debe 160 y paga
     155, esos 5 no se le reclaman. Pero no se borran — quedan como una fila con el motivo escrito,
     y la cuenta cierra en cero sin perder el porqué. */
  app.post('/api/os/chat/ajustes', wrap((req, res) => {
    const r = chat.ajustar(req.body || {});
    r.ok ? ok(res, r) : err(res, 400, r.error);
  }));
  /* Cuánto falta para saldar lo que dijo pagar, y si entra en la tolerancia. Lo usa la pantalla
     para preguntar antes de aprobar cuando la diferencia es grande. */
  app.get('/api/os/chat/diferencia', (req, res) => {
    const q = req.query || {};
    ok(res, {
      diferencia: chat.diferenciaDe(q.cliente_id, q.concepto, q.divisa, q.monto, q.cajas),
      tolerancia: chat.TOLERANCIA_PCT,
    });
  });
  app.delete('/api/os/chat/movs/:id', wrap((req, res) => ok(res, chat.borrarMov(req.params.id))));
  /* ── LOS AVISOS DE PAGO DEL CLIENTE ─────────────────────────────────────────────────────────
     Suben la captura desde su hoja. No mueven el saldo hasta que se aprueban acá. */
  app.get('/api/os/chat/avisos', (_req, res) => ok(res, {
    avisos: chat.avisosPendientes(),
    // Y los últimos resueltos: apenas aprobabas uno desaparecía y no había desde dónde reenviarlo.
    resueltos: chat.avisosResueltos(12),
  }));
  /* REENVIARLE AL PROVEEDOR el comprobante de un mantenimiento YA APROBADO. No mueve ni un peso:
     sólo vuelve a mandar el mensaje. Es lo que hay que usar cuando el aviso no salió —o cuando se
     aprobó antes de que este mensaje existiera— en vez de anular el pago, que sí mueve el saldo. */
  app.post('/api/os/chat/avisos/:id/avisar-proveedor', wrap(async (req, res) => {
    const av = chat.avisoPorId(req.params.id);
    if (!av) return err(res, 404, 'no existe ese aviso');
    if (av.concepto !== 'mantenimiento') {
      return err(res, 400, 'ese aviso no es del mantenimiento: el % se lo pagás vos y se avisa al registrarlo');
    }
    const nombres = String(av.cajas || '').split(',').map((x) => x.trim()).filter(Boolean);
    const cajas = nombres.map((n) => {
      const mv = (chat.cuentas(null).clientes.find((x) => x.cliente_id === av.cliente_id) || { movs: [] })
        .movs.filter((m) => m.tipo === 'mensualidad' && m.panel === n).slice(-1)[0];
      const per = mv ? chat.periodoDesde(mv.fecha) : null;
      return { caja: chat.comoLaLlamaElCliente(n) || n, periodo: per ? per.texto : '' };
    });
    const archivos = chat.archivosDeAviso(av.id)
      .map((x) => chat.archivoDeAviso(av.id, x.ord)).filter(Boolean);
    const r = await require('./chat-avisos.service').avisarMantenimientoCobrado(av, cajas, archivos);
    r.ok ? ok(res, { ...r, cajas: cajas.length, archivos: archivos.length }) : err(res, 502, r.error);
  }));
  // Cuáles trae — hasta tres. La pantalla los ofrece todos en vez de suponer que hay uno.
  app.get('/api/os/chat/avisos/:id/archivos', (req, res) =>
    ok(res, { archivos: chat.archivosDeAviso(req.params.id) }));
  app.get('/api/os/chat/avisos/:id/archivo', (req, res) => {
    const a = chat.archivoDeAviso(req.params.id, req.query.n || 0);
    if (!a || !a.archivo_b64) return err(res, 404, 'ese aviso no trae comprobante');
    /* Se sirve con el tipo que se guardó —ya filtrado a imágenes— y además con estas dos, que son
       las que impiden que un archivo subido desde afuera se ejecute como página adentro de tu
       sesión: nosniff para que el navegador no adivine el tipo, y Content-Disposition para que lo
       trate como archivo y no como documento. */
    res.setHeader('Content-Type', a.archivo_tipo || 'application/octet-stream');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', 'inline; filename="comprobante"');
    res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; sandbox");
    res.setHeader('Cache-Control', 'no-store, private');
    res.send(Buffer.from(a.archivo_b64, 'base64'));
  });
  app.post('/api/os/chat/solicitudes/:id', wrap((req, res) => {
    const r = chat.resolverSolicitud(req.params.id, (req.body || {}).listo === true);
    r.ok ? ok(res, r) : err(res, 400, r.error);
  }));
  app.post('/api/os/chat/avisos/:id/resolver', wrap((req, res) => {
    const aprobar = (req.body || {}).aprobar === true;
    /* El aviso se lee ANTES de resolverlo: al aprobarlo cambia de estado, y después ya no se sabe
       de qué cajas era ni qué monto tenía sin volver a armarlo. */
    const av = chat.avisoPorId(req.params.id);
    const r = chat.resolverAviso(req.params.id, aprobar);
    if (!r.ok) return err(res, 400, r.error);
    /* ⚠️ SI ERA DEL MANTENIMIENTO, SE LE REENVÍA AL PROVEEDOR CON EL COMPROBANTE. Esa plata le
       entró a él directo —las wallets del mantenimiento son suyas— y sin esto le llega una
       transferencia sin saber de qué caja ni de qué período es.
       Sale DESPUÉS de contestar: que Telegram falle no puede hacer que la pantalla diga que el
       aviso no se aprobó, cuando el saldo ya se movió. */
    if (aprobar && av && av.concepto === 'mantenimiento') {
      const nombres = String(av.cajas || '').split(',').map((x) => x.trim()).filter(Boolean);
      const cajas = nombres.map((n) => {
        const p = chat.list().find((x) => x.cliente_id === av.cliente_id && x.panel === n) || {};
        const mv = (chat.cuentas(null).clientes.find((x) => x.cliente_id === av.cliente_id) || { movs: [] })
          .movs.filter((m) => m.tipo === 'mensualidad' && m.panel === n).slice(-1)[0];
        const per = mv ? chat.periodoDesde(mv.fecha) : null;
        return { caja: chat.comoLaLlamaElCliente(n) || n, periodo: per ? per.texto : '' };
      });
      const archivos = chat.archivosDeAviso(av.id)
        .map((x) => chat.archivoDeAviso(av.id, x.ord)).filter(Boolean);
      res.on('finish', () => {
        require('./chat-avisos.service').avisarMantenimientoCobrado(av, cajas, archivos)
          .then((x) => { if (!x.ok) console.warn('[Chat] no se le avisó el mantenimiento al proveedor:', x.error); })
          .catch((e) => console.warn('[Chat] error avisando el mantenimiento:', e.message));
      });
    }
    ok(res, r);
  }));
  // La mensualidad se cobra el día de cada panel, así que tiene su propio botón y su propia fecha.
  app.post('/api/os/chat/mensualidad', wrap((req, res) => {
    const r = chat.cobrarMensualidad(req.body || {});
    r.ok ? ok(res, r) : err(res, 400, r.error);
  }));
  /* AVISARLE LA MENSUALIDAD AL CLIENTE. Sale para AFUERA. Va de a una porque cada caja tiene su
     día: mandar "vencen tus cuatro" el día de la primera sería cobrarle cuatro antes de tiempo. */
  app.post('/api/os/chat/mensualidad/avisar', wrap(async (req, res) => {
    const b = req.body || {};
    const cid = String(b.cliente_id || '');
    const d = chat.destino(cid);
    if (!d.grupos.length) return err(res, 400, 'ese cliente todavía no tiene grupo de Telegram para este servicio');
    const c = chat.config();
    const fecha = String(b.fecha || '').slice(0, 10) || fechaTZ();
    const per = chat.periodoDesde(fecha);
    /* La caja se nombra por su LINK, igual que en la cuenta del mes. Si un mensaje dice
       «ganamoscpy.com» y el otro «AgenteFortuna», el cliente cree que son dos cajas distintas —y
       ese nombre interno se lo pusimos nosotros, él nunca lo usó. Sin link cargado, el nombre. */
    const cajaAv = chat.list().find((p) => p.cliente_id === cid && p.panel === String(b.panel || ''));
    const comoSeLlama = chatDoc.soloDominio(cajaAv && cajaAv.link_jugadores) || b.panel || 'tu caja';
    const texto = `<b>Chat Externo</b> · mantenimiento de <b>${comoSeLlama}</b>\n`
      + (per ? `Período <b>${per.texto}</b>\n` : '')
      + `A pagar: <b>${c.mensualidad} ${c.mensualidad_moneda}</b>.\n`
      + `Podés ver tu cuenta y cómo pagar acá:\n${_urlPublica(req)}/chat`;
    const tok = chat.botToken();
    const idas = [];
    for (const g of d.grupos) {
      // eslint-disable-next-line no-await-in-loop
      const r1 = await telegram.sendMessage(tok, g, texto);
      idas.push({ grupo: g, ok: !!r1.ok, error: r1.error || null });
    }
    const fallaron = idas.filter((x) => !x.ok);
    const r = fallaron.length
      ? { ok: false, error: fallaron.map((x) => `${x.grupo}: ${x.error}`).join(' · ') }
      : { ok: true };
    chat.marcarAvisoMens(cid, b.panel, fecha, r);
    r.ok ? ok(res, { avisado: idas.length, idas })
      : err(res, 502, `salió a ${idas.length - fallaron.length} de ${idas.length}: ${r.error}`, { idas });
  }));
  /* ── LO QUE LE PAGASTE AL PROVEEDOR ─────────────────────────────────────────────────────────
     Antes un mes pagado y uno impago se veían idénticos. */
  app.post('/api/os/chat/pagos', wrap((req, res) => {
    const r = chat.pagar(req.body || {});
    if (!r.ok) return err(res, 400, r.error);
    /* Y se le avisa al proveedor, DESPUÉS de contestar. El pago ya quedó registrado: que Telegram
       tarde o falle no puede hacer que la pantalla diga que no se guardó. Si no sale, se ve en el
       aviso de abajo y se puede volver a mandar. */
    res.on('finish', () => {
      require('./chat-avisos.service').avisarPagoAlProveedor(r.pago)
        .then((x) => { if (!x.ok) console.warn('[Chat] no se le avisó al proveedor:', x.error); })
        .catch((e) => console.warn('[Chat] error avisando al proveedor:', e.message));
    });
    ok(res, r);
  }));
  /* Reenviar el aviso de un pago que no salió. No registra nada: sólo vuelve a mandar. */
  app.post('/api/os/chat/pagos/:id/avisar', wrap(async (req, res) => {
    const pago = (chat.pagos(null) || []).find((x) => String(x.id) === String(req.params.id));
    if (!pago) return err(res, 404, 'no existe ese pago');
    const x = await require('./chat-avisos.service').avisarPagoAlProveedor(pago);
    x.ok ? ok(res, x) : err(res, 502, x.error);
  }));
  app.delete('/api/os/chat/pagos/:id', wrap((req, res) => ok(res, chat.borrarPago(req.params.id))));
  app.get('/api/os/api/paquetes', (_req, res) => ok(res, { paquetes: ofertas.listPaquetes() }));
  app.post('/api/os/api/paquetes', wrap((req, res) => {
    const r = ofertas.savePaquete(req.body || {});
    r.ok ? ok(res, r) : err(res, 400, r.error);
  }));
  app.delete('/api/os/api/paquetes/:id', wrap((req, res) => ok(res, ofertas.removePaquete(req.params.id))));
  /* Armar una oferta con un solo número: la base. Devuelve las líneas listas para editar y
     guardar — no escribe nada. Ver el porqué de la tarifa en api-ofertas-store.js. */
  /* ── CUÁNTO MOVIÓ CADA SELLO ────────────────────────────────────────────────────────────────
     El armador de ofertas discute el precio de 37 externos, y resulta que en julio 19 de ellos no
     movieron una sola ficha: los externos enteros fueron el 0,21% del GGR. Sin este número al lado
     del precio, se negocia a ciegas el 0,2% del negocio con el mismo cuidado que el 99,8%.
     Sale de las cuentas ya calculadas del mes, así que no le pide nada nuevo a TBS. */
  app.get('/api/os/api/volumen', wrap((req, res) => {
    const mes = String(req.query.mes || mesTZ()).slice(0, 7);
    const r = apiCuenta.cuentas({ mes });
    if (!r.ok) return err(res, 400, r.error);
    const ggr = {};
    for (const c of r.cuentas || []) {
      for (const l of c.lineas || []) {
        ggr[l.sello] = (ggr[l.sello] || 0) + (Number(l.ggr_usd) || 0);
      }
    }
    const total = Object.values(ggr).reduce((a, b) => a + b, 0);
    ok(res, { mes, total, ggr, cuentas: (r.cuentas || []).length });
  }));
  app.get('/api/os/api/oferta-desde-base', (req, res) => {
    const r = ofertas.armarDesdeBase(req.query.base, {
      puntos: req.query.puntos, minExt: req.query.min_ext, maxExt: req.query.max_ext,
    });
    if (r.error) return res.status(400).json({ ok: false, error: r.error });
    ok(res, r);
  });
  /* Recomponer los paquetes por lo que cuesta cada proveedor. Sin `aplicar` sólo dice qué
     movería: esto cambia lo que el cliente ve agrupado en el documento, así que se mira antes. */
  app.post('/api/os/api/paquetes/recomponer', wrap((req, res) => {
    const b = req.body || {};
    const r = ofertas.recomponerPorCosto({
      aplicar: b.aplicar === true,
      excluir: Array.isArray(b.excluir) ? b.excluir : [],
    });
    if (r.error) return err(res, 400, r.error);
    ok(res, r);
  }));
  /* ── EN QUÉ SECCIÓN SE MUESTRA CADA PROVEEDOR ───────────────────────────────────────────────
     Sólo afecta al documento: el sello, su costo y lo que se factura no se tocan. Sirve para las
     bolsas mezcladas de TBS, donde un sello trae una mesa en vivo y dos catálogos de slots. */
  app.get('/api/os/api/prov-seccion', (_req, res) => ok(res, { secciones: ofertas.listSecciones() }));
  app.put('/api/os/api/prov-seccion', wrap((req, res) => {
    const b = req.body || {};
    const r = ofertas.setSeccion(b.prov, b.paquete_id);
    r.ok ? ok(res, { ...r, secciones: ofertas.listSecciones() }) : err(res, 400, r.error);
  }));
  app.get('/api/os/api/ofertas', (_req, res) => ok(res, { ofertas: ofertas.listOfertas() }));
  app.get('/api/os/api/ofertas/:id', (req, res) => {
    const o = ofertas.getOferta(req.params.id);
    if (!o) return err(res, 404, 'no existe esa oferta');
    ok(res, { oferta: o, mostrar: ofertas.paraMostrar(o) });
  });
  app.post('/api/os/api/ofertas', wrap((req, res) => {
    const r = ofertas.saveOferta(req.body || {});
    r.ok ? ok(res, r) : err(res, 400, r.error);
  }));
  app.delete('/api/os/api/ofertas/:id', wrap((req, res) => ok(res, ofertas.removeOferta(req.params.id))));
  /* El precio de UN sello, a mano. Vacío lo devuelve al precio de su paquete. */
  app.put('/api/os/api/ofertas/:id/precio', wrap((req, res) => {
    const o = ofertas.getOferta(req.params.id);
    if (!o) return err(res, 404, 'no existe esa oferta');
    const b = req.body || {};
    const r = ofertas.precioDeSello(o, b.sello, b.pct);
    r.ok ? ok(res, { ...r, mostrar: ofertas.paraMostrar(r.oferta) }) : err(res, 400, r.error);
  }));
  /* Qué proveedores NO van en esta oferta. Ruta propia y no `saveOferta` entero: destildar una
     casilla no tiene por qué reescribir las líneas de precio, y si la pantalla mandara una lista
     vieja de líneas junto con la casilla, pisaría precios sin que nadie lo pidiera. */
  app.put('/api/os/api/ofertas/:id/excluidos', wrap((req, res) => {
    const o = ofertas.getOferta(req.params.id);
    if (!o) return err(res, 404, 'no existe esa oferta');
    const b = req.body || {};
    const r = ofertas.saveOferta({ ...o, excluidos: Array.isArray(b.excluidos) ? b.excluidos : [] });
    r.ok ? ok(res, { ...r, mostrar: ofertas.paraMostrar(r.oferta) }) : err(res, 400, r.error);
  }));
  // Qué cambiaría en la matriz. NO escribe: se mira antes de tocar precios que ya se facturan.
  app.get('/api/os/api/ofertas/:id/diff', (req, res) => {
    const o = ofertas.getOferta(req.params.id);
    if (!o) return err(res, 404, 'no existe esa oferta');
    const cid = req.query.cliente_id || o.cliente_id;
    if (!cid) return err(res, 400, 'falta a qué cuenta compararla');
    ok(res, ofertas.diff(o, cid));
  });
  /* El documento. Sale de `paraMostrar`, que devuelve SÓLO nombre de paquete, proveedores y el %
     del cliente: ni el costo, ni el margen, ni los puntos de los socios, ni el nombre del sello.
     La forma más segura de no filtrar un dato interno es no tenerlo a mano. */
  /* Mandar la oferta por Telegram, al mismo grupo al que va la factura de ese cliente.
     Va como TEXTO, no como archivo: se lee en el teléfono sin descargar nada, que es donde el
     cliente la va a mirar. Y con el mismo cinturón que el documento — si aparece un dato interno
     no se manda, porque de un mensaje enviado no se vuelve. */
  app.post('/api/os/api/ofertas/:id/telegram', wrap(async (req, res) => {
    const o = ofertas.getOferta(req.params.id);
    if (!o) return err(res, 404, 'no existe esa oferta');
    const cid = String((req.body || {}).cliente_id || o.cliente_id || '').trim();
    if (!cid) return err(res, 400, 'Elegí a qué cuenta va antes de mandarla');

    const cli = clientes.get(cid) || apiStore.getCliente(cid);
    if (!cli) return err(res, 404, 'no encontré ese cliente');
    const dest = tgDestino.destinoDe(cli, (id) => clientes.get(id));
    if (!dest.chatId) return err(res, 400, 'Ese cliente no tiene grupo de Telegram configurado');

    const m = ofertas.paraMostrar(o);
    const { escTexto: esc } = require('./lib/html');
    const pct = (x) => String(x).replace(/\.0+$/, '').replace('.', ',') + '%';
    const lineas = ['<b>Oferta comercial</b>'];
    if (m.titulo) lineas.push(esc(m.titulo));
    lineas.push('', '<i>Porcentaje sobre el GGR de cada proveedor.</i>',
      '<i>Es una oferta base: los porcentajes se conversan y se acuerdan, y bajan a medida que '
      + 'crece el volumen.</i>', '');
    /* La misma aclaración que la hoja, y por el mismo motivo: sin ella, un proveedor con dos
       precios se lee como un error de armado. Sólo sale si hay alguno repetido. */
    if ((m.repetidos || []).length) {
      lineas.push('<i>Algunos proveedores figuran más de una vez: llegan por integraciones '
        + 'distintas, o en más de una versión —una más completa y más cara—. Se contratan por '
        + 'separado.</i>', '');
    }
    /* La misma forma que el documento: un precio de título y sus proveedores debajo. Si el
       mensaje y la hoja se leyeran distinto, el cliente creería que son dos ofertas. */
    for (const g of m.grupos || []) {
      const niveles = g.niveles || [];
      const uno = niveles.length === 1;
      lineas.push(`<b>${esc(g.nombre)}</b>`
        + (uno ? ` — ${esc(pct(niveles[0].pct))}` : ` — de ${esc(pct(g.desde))} a ${esc(pct(g.hasta))}`));
      if (uno) {
        lineas.push(esc(niveles[0].proveedores.join(' · ')));
      } else {
        for (const n of niveles) {
          lineas.push('', `<b>${esc(pct(n.pct))}</b>`, esc(n.proveedores.join(' · ')));
        }
      }
      lineas.push('');
    }
    if (m.notas) lineas.push(`<i>${esc(m.notas)}</i>`, '');
    lineas.push('<i>Latam Games</i>');
    const texto = lineas.join('\n');

    if (/costo|margen|pts_ib|pts_henry|pct_proveedor|grupo_id/i.test(texto)) {
      return err(res, 500, 'el mensaje traía datos internos: NO se mandó. Avisá que esto pasó.');
    }
    const r = await telegram.sendMessage(configStore.getTelegramToken(), dest.chatId, texto);
    if (!r.ok) return err(res, 502, r.error || 'Telegram no lo aceptó');
    ok(res, { enviado: true, heredado: dest.heredado, de: dest.de });
  }));
  app.get('/api/os/api/ofertas/:id/doc', (req, res) => {
    const o = ofertas.getOferta(req.params.id);
    if (!o) return err(res, 404, 'no existe esa oferta');
    const m = ofertas.paraMostrar(o);
    const html = ofertaHtml.pagina(m);
    // Cinturón y tiradores: esto se le muestra a un cliente y no hay vuelta atrás.
    if (/costo|margen|pts_ib|pts_henry|pct_proveedor|grupo_id/i.test(html)) {
      return err(res, 500, 'el documento traía datos internos: NO se generó. Avisá que esto pasó.');
    }
    res.type('text/html; charset=utf-8').send(html);
  });
  app.post('/api/os/api/ofertas/:id/aplicar', wrap((req, res) => {
    const o = ofertas.getOferta(req.params.id);
    if (!o) return err(res, 404, 'no existe esa oferta');
    const r = ofertas.aplicar(o, (req.body || {}).cliente_id);
    r.ok ? ok(res, r) : err(res, 400, r.error);
  }));
  app.post('/api/os/api/sellos', wrap((req, res) => {
    const r = apiStore.saveSello(req.body || {});
    r.ok ? ok(res, r) : err(res, 400, r.error);
  }));
  app.delete('/api/os/api/sellos/:nombre', wrap((req, res) => ok(res, apiStore.removeSello(req.params.nombre))));
  // Sembrar el padrón y la matriz de una. Idempotente: no pisa lo cargado salvo que se pida.
  app.post('/api/os/api/sembrar', wrap((req, res) => ok(res, apiStore.sembrar(req.body || {}))));
  app.get('/api/os/api/matriz', (_req, res) => ok(res, apiStore.matriz()));
  app.post('/api/os/api/pct', wrap((req, res) => {
    const b = req.body || {};
    const r = apiStore.setPct(b.cliente_id, b.sello, b);
    r.ok ? ok(res, r) : err(res, 400, r.error, { confirmar: !!r.confirmar, empresa: r.empresa, suma: r.suma });
  }));
  // Dar de baja un proveedor para un cliente. Hace falta de verdad: si un sello se le desactiva
  // en TBS, dejarle el precio cargado lo mantiene en la lista de revisión para siempre. Sin precio
  // el GGR que llegue cae en "sinPrecio", que se ve — no se factura por las dudas ni desaparece.
  app.delete('/api/os/api/pct/:cliente/:sello', wrap((req, res) =>
    ok(res, apiStore.removePct(req.params.cliente, req.params.sello))));
  // Lo que se le paga al proveedor contra lo que el sello cuesta. No necesita TBS.
  app.get('/api/os/api/revision', (_req, res) => ok(res, apiCuenta.revisarCostos()));
  // El cierre del mes de API: una fila por cuenta, y el dueño elige cuáles entran en el total.
  app.get('/api/os/api/resumen', wrap((req, res) => {
    const r = apiResumen.resumen({ mes: String(req.query.mes || mesTZ()).slice(0, 7) });
    r.ok ? ok(res, r) : err(res, 400, r.error);
  }));
  app.post('/api/os/api/resumen/sel', wrap((req, res) => {
    const b = req.body || {};
    if (!b.mes || !b.clave) return err(res, 400, 'falta el mes o la clave');
    ok(res, apiStore.setEnResumen(b.mes, b.clave, b.entra !== false, b.motivo));
  }));
  // Cobros por mes: todas las cuentas desde junio, con el monto y si pagó.
  app.get('/api/os/api/cobros', wrap((req, res) => {
    const r = apiResumen.cobros({ desde: req.query.desde || '2026-06', hasta: req.query.hasta || mesTZ() });
    r.ok ? ok(res, r) : err(res, 400, r.error);
  }));
  // El resumen de deuda de una cuenta: los meses pendientes y el total. Vista para el cliente.
  app.get('/api/os/api/cobros/:clave/pagina', wrap((req, res) => {
    const d = apiResumen.deuda({ clave: req.params.clave, desde: req.query.desde || '2026-06', hasta: mesTZ() });
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store, private');
    res.send(apiCuentaHtml.paginaDeuda(d, d.ok ? apiResumen.deudaTexto(d) : ''));
  }));
  // Marcar / desmarcar que pagó. Se guarda con el monto que tenía la cuenta en ese momento.
  app.post('/api/os/api/cobros', wrap((req, res) => {
    const b = req.body || {};
    const r = apiStore.setCobro(b.mes, b.clave, b.pagado !== false, b.monto);
    r.ok ? ok(res, r) : err(res, 400, r.error);
  }));
  // Mandarle a un cliente de API su cuenta del mes por Telegram.
  // SALE PARA AFUERA: se pide confirmación en la pantalla y se manda la vista 'cliente', que por
  // construcción no lleva lo que le pagamos al proveedor ni cómo se reparte adentro.
  app.post('/api/os/api/cuenta/:clienteId/enviar', wrap(async (req, res) => {
    const b = req.body || {};
    const mes = String(b.mes || mesTZ()).slice(0, 7);
    const cl = apiStore.listClientes().find((x) => String(x.id) === String(req.params.clienteId));
    if (!cl) return err(res, 404, 'cuenta de API no encontrada');
    const tok = configStore.getTelegramToken();
    if (!tok) return err(res, 400, 'falta el token del bot de Telegram (⚙ Config)');

    // DOS DESTINOS, Y NO SON LO MISMO.
    // La MATRIZ recibe todas las cuentas siempre: es la copia interna de lo que se emitió.
    // El grupo del CLIENTE es una decisión por vez — el dueño manda algunas y otras no — así que
    // hay que pedirlo explícitamente. Que el destino de afuera necesite un pedido expreso y el de
    // adentro no, es a propósito: un clic de más no puede terminar en el chat de un cliente.
    const matriz = configStore.getApiGrupoMatriz();
    const alCliente = b.al_cliente === true;
    const chatCli = (cl.telegram_chat_id || '').trim();
    const destinos = [];
    if (matriz) destinos.push({ chat: matriz, quien: 'matriz' });
    if (alCliente) {
      if (!chatCli) return err(res, 400, `${cl.login} no tiene grupo propio cargado (se pone en 👥 Cuentas de API). Sin marcar "también al cliente" igual se manda a la matriz.`);
      if (chatCli !== matriz) destinos.push({ chat: chatCli, quien: cl.login });
    }
    if (!destinos.length) {
      return err(res, 400, 'no hay a dónde mandar: falta el grupo matriz (⚙ Config → Telegram) '
        + 'y no se pidió mandarlo al cliente');
    }

    const r = apiCuenta.cuentas({ mes });
    if (!r.ok) return err(res, 400, r.error);
    const cuenta = (r.cuentas || []).find((x) => String(x.cliente_id) === String(cl.id));
    if (!cuenta) return err(res, 400, `${cl.login} no tiene consumo en ${mes}: no hay nada que mandar`);
    const doc = apiCuentaDoc.documento({ cuenta, mes, vista: 'cliente',
      alcance: ['propio', 'caja', 'total'].includes(b.alcance) ? b.alcance : 'total', caja_id: b.caja_id || null });
    if (!doc.ok) return err(res, 400, doc.error);

    // Cinturón y tiradores: la lista blanca ya lo garantiza, pero esto sale para afuera y no hay
    // vuelta atrás. Si alguna vez alguien agrega un campo al motor, acá se frena antes de mandarlo.
    // El link se crea SIEMPRE y guarda el documento proyectado: el mensaje lleva el resumen y el
    // detalle vive en la página, que es la que el dueño venía mandando.
    const l = apiCuentaDoc.crearLink(doc, cl.id);
    const txt = apiCuentaDoc.aTexto(doc, { titulo: apiResumen.comoLoLlama(cl),
      link: `${_urlPublica(req)}/cuenta/${l.token}` });
    if (/proveedor|usdt_empresa|pts_ib|pts_henry|costo_sello/i.test(JSON.stringify(doc))) {
      return err(res, 500, 'la cuenta del cliente traía datos internos: NO se mandó nada. Avisá que esto pasó.');
    }
    const partes = facturaSvc.partir(txt);
    // Se manda a un destino por vez y se informa CADA UNO. Si falla el segundo, el primero ya salió
    // y hay que decirlo: dar un error a secas dejaría creyendo que no se mandó nada.
    const hechos = [];
    for (const d of destinos) {
      let error = null;
      for (const p of partes) { const x = await telegram.sendMessage(tok, d.chat, p); if (!x.ok) { error = x.error; break; } }
      hechos.push({ quien: d.quien, chat: d.chat, ok: !error, error });
      console.log(`[API] cuenta de ${cl.login} (${mes}) → ${d.quien}: ${error ? 'FALLÓ ' + error : partes.length + ' mensaje(s)'}`);
    }
    const fallaron = hechos.filter((x) => !x.ok);
    if (fallaron.length === hechos.length) {
      return err(res, 502, `no se pudo mandar a ninguno: ${fallaron.map((x) => x.quien + ' — ' + x.error).join(' · ')}`, { destinos: hechos });
    }
    ok(res, { enviado: true, partes: partes.length, total_usdt: doc.usdt_cliente, destinos: hechos,
      aviso: fallaron.length ? `se mandó a ${hechos.length - fallaron.length} de ${hechos.length}: falló ${fallaron.map((x) => x.quien).join(', ')}` : null });
  }));
  // La MISMA página que va a ver el cliente, pero detrás del login. Un solo renderizador y dos
  // puertas: si el dueño revisa una cosa y el cliente ve otra, nadie se entera hasta el reclamo.
  app.get('/api/os/api/cuenta/:clienteId/pagina', wrap((req, res) => {
    const mes = String(req.query.mes || mesTZ()).slice(0, 7);
    const r = apiCuenta.cuentas({ mes });
    if (!r.ok) return err(res, 400, r.error);
    const c = (r.cuentas || []).find((x) => String(x.cliente_id) === String(req.params.clienteId));
    const d = apiCuentaDoc.documento({ cuenta: c, mes, vista: 'cliente',
      alcance: ['propio', 'caja', 'total'].includes(req.query.alcance) ? req.query.alcance : 'total',
      caja_id: req.query.caja_id || null });
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store, private');
    res.send(d.ok ? apiCuentaHtml.pagina(d, { nota: 'Vista previa' }) : apiCuentaHtml.paginaError(d.error));
  }));
  // El documento de UNA cuenta. La vista 'cliente' se arma acá, en el servidor, con lista blanca:
  // lo que le pagamos al proveedor no puede viajar al navegador y esconderse con CSS.
  app.get('/api/os/api/cuenta/:clienteId', wrap((req, res) => {
    const mes = String(req.query.mes || mesTZ()).slice(0, 7);
    const r = apiCuenta.cuentas({ mes });
    if (!r.ok) return err(res, 400, r.error);
    const c = (r.cuentas || []).find((x) => String(x.cliente_id) === String(req.params.clienteId));
    const d = apiCuentaDoc.documento({ cuenta: c, mes,
      vista: req.query.vista === 'cliente' ? 'cliente' : 'interno',
      alcance: ['propio', 'caja', 'total'].includes(req.query.alcance) ? req.query.alcance : 'total',
      caja_id: req.query.caja_id || null });
    d.ok ? ok(res, d) : err(res, 404, d.error);
  }));
  // Las DOS cuentas del mes de API: la del cliente y la del proveedor, del mismo GGR.
  app.post('/api/os/api/precargar', wrap(async (req, res) => {
    const b = req.body || {};
    const r = await apiCuenta.precargar({ mes: b.mes || mesTZ(), confirmar: !!b.confirmar, desde: Number(b.desde) || 0,
      limite: Number(b.limite) || 8, refrescar: !!b.refrescar });
    r.ok ? ok(res, r) : err(res, 502, r.error);
  }));
  app.get('/api/os/api/cuentas', wrap((req, res) => {
    const r = apiCuenta.cuentas({ mes: req.query.mes || mesTZ(), cliente_id: req.query.cliente_id || null });
    r.ok ? ok(res, r) : err(res, 400, r.error);
  }));
  // TBS: el árbol de cuentas aplanado. Sin el id de cada cuenta no se le puede pedir el profit.
  app.get('/api/os/tbs/arbol', wrap(async (req, res) => {
    const cx = casinoConex.list().find((c) => c.motor === 'tbs' && c.activa);
    if (!cx) return err(res, 400, 'no hay ninguna conexión con motor TBS configurada');
    const cli = casinoConex.client(cx.id);
    if (!cli) return err(res, 400, `la conexión "${cx.nombre}" no tiene credenciales cargadas`);
    const mes = String(req.query.mes || mesTZ()).slice(0, 7);
    const ult = new Date(Date.UTC(Number(mes.slice(0, 4)), Number(mes.slice(5, 7)), 0)).getUTCDate();
    const r = await cli.arbol({
      desde: req.query.desde || `${mes}-01 00:00:00`,
      hasta: req.query.hasta || `${mes}-${String(ult).padStart(2, '0')} 23:59:59`,
      grupos: req.query.grupos ? String(req.query.grupos).split(',') : [],
    });
    r.ok ? ok(res, { conexion: cx.nombre, mes, ...r }) : err(res, 502, r.error);
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
  /**
   * ── EL TOTAL DE TBS POR DIVISA ────────────────────────────────────────────────────────────
   * Lo que había era por AGENTE, para facturar. Esto contesta la otra pregunta: cuánto movió TBS
   * en cada moneda. Una sola llamada (⏱ ~54s), todos los grupos juntos.
   */
  app.post('/api/os/tbs/total-divisa', wrap(async (req, res) => {
    const b = req.body || {};
    const t = _tbsCliente(b.conexion_id);
    if (t.error) return err(res, 400, t.error);
    const mes = String(b.mes || mesTZ()).slice(0, 7);
    const ult = new Date(Date.UTC(Number(mes.slice(0, 4)), Number(mes.slice(5, 7)), 0)).getUTCDate();
    const desde = b.desde || `${mes}-01 00:00:00`;
    const hasta = b.hasta || `${mes}-${String(ult).padStart(2, '0')} 23:59:59`;
    const r = await t.cli.totalPorDivisa({ desde, hasta, grupos: b.grupos || [] });
    if (!r.ok) return err(res, 502, r.error);
    ok(res, { conexion: t.nombre, mes, desde, hasta, porDivisa: r.porDivisa });
  }));
  /**
   * ── EL REPORTE DIARIO DE TBS ──────────────────────────────────────────────────────────────
   * Casino y Europa tienen su acumulado diario y de ahí sale el Pulso. TBS no lo tenía porque cada
   * consulta tarda ~54s: armar el mes en vivo son 31 llamadas, media hora, cada vez que se abre.
   * Se captura UNA VEZ por día y queda guardado (ver src/tbs-diario-store.js, y por qué NO va en
   * la misma tabla que el motor 463).
   *
   * El plan dice qué días faltan, así que la pantalla puede ir de a uno y mostrar el avance en vez
   * de apretar un botón y esperar media hora sin señales — el mismo patrón que la Foto del mes.
   */
  app.get('/api/os/tbs/diario/plan', (req, res) => {
    const mes = String(req.query.mes || mesTZ()).slice(0, 7);
    const ult = new Date(Date.UTC(Number(mes.slice(0, 4)), Number(mes.slice(5, 7)), 0)).getUTCDate();
    const hoy = mesTZ() === mes ? Number(new Date().toISOString().slice(8, 10)) : ult;
    // No se piden días que todavía no pasaron: la respuesta vendría vacía y habría que rehacerlos.
    const todos = [];
    for (let d = 1; d <= Math.min(ult, hoy); d++) todos.push(`${mes}-${String(d).padStart(2, '0')}`);
    const listos = tbsDiario.diasCapturados(mes);
    const faltan = todos.filter((d) => !listos.includes(d));
    // La estimación sale de lo MEDIDO, no de una constante. La primera versión usaba 54s —el
    // tiempo de una consulta de un MES entero— y daba 28 minutos para algo que tarda dos: con ese
    // número la decisión razonable era no hacerlo nunca.
    const ms = tbsDiario.msPromedio();
    ok(res, { mes, dias: todos.length, capturados: listos.length, faltan,
      ms_por_dia: ms,
      segundos_estimados: ms ? Math.ceil((faltan.length * ms) / 1000) : null,
      medido_en: listos.length });
  });
  app.post('/api/os/tbs/diario/capturar', wrap(async (req, res) => {
    // La lógica vive en el servicio: el cron nocturno pide exactamente lo mismo, y dos copias de
    // "cómo se arma un día" es cómo una se queda vieja — se arregla la que se ve y la otra sigue
    // guardando mal, en silencio, de madrugada.
    const b = req.body || {};
    const r = await tbsDiarioSvc.capturarDia({
      fecha: b.fecha, conexionId: b.conexion_id || null,
      grupos: b.grupos || [], refrescar: !!b.refrescar,
    });
    r.ok ? ok(res, r) : err(res, r.error && /falta la fecha|conexión/.test(r.error) ? 400 : 502, r.error);
  }));
  app.get('/api/os/tbs/diario', (req, res) => ok(res, tbsDiario.delMes(req.query.mes || mesTZ())));
  app.post('/api/os/tbs/diario/borrar-dia', wrap((req, res) => {
    const fecha = String((req.body || {}).fecha || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) return err(res, 400, 'falta la fecha (YYYY-MM-DD)');
    ok(res, { fecha, borradas: tbsDiario.borrarDia(fecha) });
  }));
  /* ── LA COMPARATIVA QUE SE MANDA POR TELEGRAM ────────────────────────────────────────────────
     Es el mensaje que la dueña venía escribiendo a mano cuando le preguntan por un cliente. El
     texto lo arma el SERVIDOR con los datos de la base: si la pantalla mandara el texto ya hecho,
     cualquier cosa que llegue a la ruta de enviar se publicaría tal cual. */
  app.get('/api/os/tbs/comparativa', (req, res) => {
    const ids = String(req.query.ids || '').split(',').map((x) => x.trim()).filter(Boolean);
    const d = tbsComparativa.armar({ mes: req.query.mes || mesTZ(), ids });
    if (!d.ok) return err(res, 400, d.error);
    ok(res, { ...d, texto: tbsComparativa.texto(d), plano: tbsComparativa.textoPlano(d) });
  });
  /* Va SÓLO al grupo interno (⚙ Config → Telegram). Es una decisión, no una limitación: la dueña
     lo usa para contestarle a su gente, y un clic de más no puede terminar en el chat de un
     cliente con los números de otro. El día que haga falta mandárselo a un cliente, se agrega
     pidiéndolo explícitamente, como ya hace la cuenta del mes. */
  app.post('/api/os/tbs/comparativa/enviar', wrap(async (req, res) => {
    const b = req.body || {};
    const tok = configStore.getTelegramToken();
    if (!tok) return err(res, 400, 'falta el token del bot de Telegram (⚙ Config)');
    const chat = configStore.getApiGrupoMatriz();
    if (!chat) return err(res, 400, 'falta el grupo de Telegram (⚙ Config → Telegram → grupo de la matriz)');
    const ids = Array.isArray(b.ids) ? b.ids : String(b.ids || '').split(',').map((x) => x.trim()).filter(Boolean);
    const d = tbsComparativa.armar({ mes: b.mes || mesTZ(), ids });
    if (!d.ok) return err(res, 400, d.error);
    if (!d.filas.length) return err(res, 400, 'no hay ninguna cuenta con movimiento para mandar');
    const txt = tbsComparativa.texto(d);
    const partes = facturaSvc.partir(txt);
    for (const p of partes) {
      const x = await telegram.sendMessage(tok, chat, p);
      if (!x.ok) return err(res, 502, `no se pudo mandar: ${x.error}`);
    }
    console.log(`[TBS] comparativa ${d.mesAnt}→${d.mes} (${d.filas.length} cuentas) al grupo ${chat}`);
    ok(res, { enviado: true, partes: partes.length, cuentas: d.filas.length, chat });
  }));
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
  app.get('/api/os/facturacion', wrap(async (req, res) => {
    ok(res, await _facturacionDe(req.query.mes || mesTZ(), {
      from: req.query.from, to: req.query.to,
      control: req.query.control !== '0',
      vivo: req.query.vivo === '1',   // forzar la consulta al casino en vez del acumulado guardado
    }));
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
  /* ── MARCAR UNA DIFERENCIA COMO YA MIRADA ────────────────────────────────────────────────────
     Muchas diferencias tienen una explicación que sólo conoce quien las hizo: una prueba, una
     reposición, una carga a mano. Sin poder anotarlo, el mismo aviso sale todos los meses y termina
     salteándose sin leer. No borra ni corrige nada: deja dicho que alguien lo miró, quién y cuándo,
     y sale del recuento de plata. Se puede deshacer. */
  app.post('/api/os/validacion/:mes/resolver', wrap((req, res) => {
    const b = req.body || {};
    const r = crucePanel.resolver({
      mes: req.params.mes, nodo: b.nodo, panel: b.panel, cliente_id: b.cliente_id || null,
      divisa: b.divisa, monto: b.monto, fecha: b.fecha || null,
      decision: b.decision, motivo: b.motivo,
      quien: (req.usuario && req.usuario.usuario) || 'admin',
    });
    if (!r.ok) return err(res, 400, r.error);
    ok(res, r);
  }));
  app.delete('/api/os/validacion/resolver/:clave', (req, res) =>
    ok(res, crucePanel.desresolver(decodeURIComponent(req.params.clave))));
  /* ⭐ ¿ESTÁ LISTO PARA CERRAR ESTE MES?
     No alcanza con que la Factura de consumo dé un número: cerrar un mes son varias cosas y una se
     olvida. Agosto tenía la foto completa (210/210) y la factura de externos sin emitir, y nada
     lo decía — el saldo de cada cliente quedaba sin sus externos y parecía correcto.
     Se mira todo lo barato: qué hay emitido, si la foto está, si están los tipos de cambio y los %
     que la factura de externos necesita. No consulta el casino. */
  app.get('/api/os/cierre/listo/:mes', wrap(async (req, res) => {
    const mes = String(req.params.mes || '').slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(mes)) return err(res, 400, 'mes inválido');
    const falta = []; const listo = [];

    const emC = emision.emitido(mes, 'facturacion');
    const emE = emision.emitido(mes, 'externos');
    (emC.cantidad ? listo : falta).push(emC.cantidad
      ? { que: 'La factura de consumo está emitida', detalle: `${emC.cantidad} cliente(s)` }
      : { que: 'Falta emitir la factura de CONSUMO', detalle: 'es el botón de esta pantalla', donde: 'acá' });

    // ── lo que la factura de externos necesita ──
    let foto = null;
    try { foto = estadMes.estado(mes); } catch (e) { /* si no se puede leer, se dice abajo */ }
    if (!emE.cantidad) {
      const porQue = [];
      if (!foto) porQue.push('no se pudo leer el estado de la foto del mes');
      else if (!foto.completa) porQue.push(`la foto del mes está incompleta (${foto.listas} de ${foto.total} consultas)`);

      /* El TC de proveedores NO es el del mercado: sale de la factura que manda el proveedor y se
         carga a mano. Sin él, lo de esa moneda se liquida mal. Se miran sólo las monedas que el mes
         movió de verdad. */
      // Por la misma función que hace la cuenta: ver el comentario en /cierre/pasos.
      try {
        const usadas = new Set();
        pedidosStore.detalleDelMes(mes).forEach((d) => usadas.add(d.divisa));
        const sinTC = [...usadas].filter((d) => tcUnico.tcDelMes(d, mes).valor == null);
        if (sinTC.length) porQue.push(`falta el tipo de cambio del proveedor de ${sinTC.join(', ')}`);
      } catch (e) { /* sin esto igual se avisa lo demás */ }

      // El % de externos se confirma MES A MES: el que no lo tenga se saltea en silencio al emitir.
      const sinBase = [];
      for (const c of clientes.list().clientes) {
        if (c.es_vendedor) continue;
        if (!paneles.list().some((p) => p.cliente_id === c.id)) continue;
        const b = externosSvc.baseDelMes(c, mes);
        if (b.valor == null) sinBase.push(c.nombre || c.codigo);
      }
      if (sinBase.length) porQue.push(`${sinBase.length} cliente(s) sin % confirmado para el mes: ${sinBase.slice(0, 6).join(', ')}${sinBase.length > 6 ? '…' : ''}`);

      falta.push({
        que: 'Falta emitir la factura de PROVEEDORES EXTERNOS',
        detalle: porQue.length ? porQue.join(' · ') : 'ya está todo lo que necesita: se puede emitir',
        listaParaEmitir: !porQue.length,
        donde: '🧮 Cierre de Mes → 🧾 Factura de externos',
      });
    } else {
      listo.push({ que: 'La factura de externos está emitida', detalle: `${emE.cantidad} cliente(s)` });
    }

    if (foto) (foto.completa ? listo : falta).push(foto.completa
      ? { que: 'La foto del mes está completa', detalle: `${foto.total} consultas` }
      : { que: 'La foto del mes está incompleta', detalle: `${foto.listas} de ${foto.total}`, donde: '📸 Foto del mes' });

    ok(res, { mes, listo, falta, puedeCerrar: !falta.length });
  }));
  /**
   * ── CERRAR EL MES: LOS PASOS, EN ORDEN ──────────────────────────────────────────────────────
   *
   * Cerrar un mes son ocho cosas en un orden que importa, repartidas en cinco pantallas. Saltearse
   * una no da error: hace que la siguiente cobre de menos y el total igual cuadre. Eso ya pasó —la
   * factura de externos de agosto 2026 se emitió antes de sacar la vuelta de Agentes y le faltaban
   * 121,61 USDT de Fran, con los 18 renglones dando bien.
   *
   * Acá se contesta, en una sola respuesta, en qué paso está el mes y qué falta para el siguiente.
   *
   * ⚠️ Y se avisa cuando una emisión quedó VIEJA: si la foto se volvió a sacar DESPUÉS de emitir,
   * esos números ya no son los de hoy. Volver a apretar Emitir no los arregla —no actualiza lo ya
   * emitido, a propósito— hay que anular y emitir de nuevo.
   */
  app.get('/api/os/cierre/pasos/:mes', wrap(async (req, res) => {
    const mes = String(req.params.mes || '').slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(mes)) return err(res, 400, 'mes inválido');
    const pasos = [];
    const paso = (o) => { pasos.push({ n: pasos.length + 1, estado: 'falta', porQue: [], ...o }); };

    // 1 · la foto
    let foto = null;
    try { foto = estadMes.estado(mes); } catch (e) { /* se dice abajo */ }
    let fotoAt = null;
    try { fotoAt = (estadMes.meses().find((x) => x.mes === mes) || {}).ultimo || null; } catch (e) {}
    paso({ id: 'foto', titulo: 'Sacar la foto del mes', ir: 'foto',
      estado: foto && foto.completa ? 'listo' : 'falta',
      detalle: !foto ? 'no se pudo leer el estado de la foto'
        : foto.completa ? foto.total + ' consultas, las cuatro vueltas'
        : foto.listas + ' de ' + foto.total + ' consultas · falta cambiar «Agrupar por» en el casino y sacar la vuelta que falte' });

    // 2 · el TC del proveedor de cada moneda que el mes movió
    /* ⚠️ SE LE PREGUNTA A LA MISMA FUNCIÓN QUE HACE LA CUENTA, no a la tabla en crudo.
       Miraba `cierre_tc` directo y salteaba sólo USDT: reclamaba el TC del proveedor de USD, que
       NUNCA hace falta —`tcDelMes` contesta 1 y lo dice, "el dólar es la unidad"— y tampoco veía
       que VES se resuelve con el de VEF. Un aviso que pide algo que no existe hace que se deje de
       confiar en los avisos, que es peor que no tenerlos. */
    const sinTC = [];
    let faltaProv = false; let hayARS = false;
    /* Afuera del `try` a propósito: el paso de abajo —«¿es el real?»— también necesita saber qué
       monedas movió el mes, y declarada adentro no la ve. Declarada adentro, ese paso no fallaba:
       no hacía NADA, en silencio, que es peor. */
    const usadas = new Set();
    try {
      pedidosStore.detalleDelMes(mes).forEach((d) => usadas.add(d.divisa));
      [...usadas].forEach((d) => { if (tcUnico.tcDelMes(d, mes).valor == null) sinTC.push(d); });
      /* ── Y EL TC DEL PROVEEDOR, QUE ES OTRO NÚMERO ────────────────────────────────────────
         `ARS_OF` no es una moneda: es el ARS que factura el PROVEEDOR, sale de su factura y se
         carga a mano.

         ⚠️ NO afecta lo que se le cobra al CLIENTE. Regla del dueño (4-ago-2026), escrita en
         externos.service: al cliente se le cobra SIEMPRE con el promedio del mes, y la diferencia
         entre las dos tasas es margen, no un costo a trasladar. Lo que sí depende de este TC es
         la cuenta de los VENDEDORES y el PAGO A PROVEEDORES — las dos son lo que se paga de
         verdad. Si falta, esas dos caen al promedio sin frenar nada: sólo queda un texto en
         `fuente` que no mira nadie.
         Agosto 2026: con el promedio (1584,53) los vendedores daban una cosa y con el del
         proveedor (1508,77) otra. Este paso se llama "el TC del proveedor": mira el del proveedor. */
      hayARS = usadas.has('ARS');
      if (hayARS) {
        faltaProv = !tcUnico.tcProveedorDelMes(mes);
      }
    } catch (e) { /* si no se puede leer, no se frena el resto */ }
    /* ── ⚠️ EL TC QUE PUSO EL SISTEMA Y NADIE MIRÓ ────────────────────────────────────────
       Al terminar el mes, `tc-columna` arma la columna sola con el promedio automático y la
       escribe en la MISMA celda donde iría el real. `tc-unico.manual()` no los distingue: el
       promedio queda contando como el definitivo, los pagos dejan de figurar provisorios, y se
       acreditan con una estimación que nadie decidió.
       Septiembre 2026: el sistema puso 1596,3923 y el real era 1679,88 — 5,2% arriba, 241,74
       USDT repartidos en 7 clientes. Por eso esto no es un detalle del paso: es su propio aviso. */
    const sinMirar = [];
    try {
      const colMes = mesCierreLbl(mes);
      for (const mon of usadas) {
        /* Sólo las que TIENEN celda. Las que faltan ya las cuenta `sinTC`, y el dólar no tiene
           celda porque es la unidad: sin esta distinción el aviso nombraba a USD y USDT, que no
           llevan tipo de cambio que decidir. Se pregunta por moneda y no leyendo la tabla entera,
           que es lo que este bloque tiene prohibido hacer. */
        /* El dólar SÍ tiene celda, con un 1 adentro, y no es un tipo de cambio que alguien haya
           decidido: es la unidad. Se pregunta por la fuente y no por la celda porque eso es lo
           que de verdad lo distingue. */
        if (tcUnico.tcDelMes(mon, mes).fuente === 'el dólar es la unidad') continue;
        const celda = cierreStore.tcCelda(mon, colMes);
        if (!celda) continue;
        if (!celda.confirmado) sinMirar.push(mon);
      }
    } catch (e) { /* si no se puede leer, no se frena el resto */ }

    const porQueTC = [];
    if (sinTC.length) porQueTC.push('falta el de ' + sinTC.join(', ') + ' — sin él esa moneda entra valiendo cero');
    if (faltaProv) porQueTC.push('falta el TC del PROVEEDOR de ARS (la fila ARS_OF): sin él la cuenta de los '
      + 'VENDEDORES y el pago a proveedores se valúan con el promedio del mes. Al cliente no lo afecta: '
      + 'a él se le cobra siempre con el promedio');
    paso({ id: 'tc', titulo: 'Cargar el tipo de cambio del proveedor', ir: 'tc',
      estado: porQueTC.length ? 'falta' : 'listo',
      detalle: porQueTC.length ? porQueTC.join(' · ')
        : 'todas las monedas que movió el mes lo tienen' + (hayARS ? ', y el del proveedor está cargado' : '') });

    /* Paso aparte y no un renglón del anterior: aquél pregunta si el número ESTÁ, éste si es el
       REAL. Con el automático puesto, el de arriba da «listo» — y es justo cuando hay que mirar. */
    paso({ id: 'tc-real', titulo: 'Confirmar que el tipo de cambio es el real', ir: 'tc',
      estado: sinMirar.length ? 'aviso' : 'listo',
      detalle: sinMirar.length
        ? 'el de ' + sinMirar.join(', ') + ' lo puso el sistema solo (el promedio del mes), no vos. '
          + 'Con él ya se acreditaron los pagos en esa moneda: si el real es otro, los saldos cambian. '
          + 'Escribí el tuyo o tocá «es el real» en 💱 Tipos de cambio.'
        : 'confirmados: el número que se usó es el que recibiste de verdad' });

    // 3 · los % del mes. No confirmarlos NO frena: se usa el vigente. No tener ninguno SÍ frena.
    const sinValor = []; const sinConfirmar = [];
    for (const c of clientes.list().clientes) {
      if (c.es_vendedor) continue;
      if (!paneles.list().some((p) => p.cliente_id === c.id)) continue;
      if (externosSvc.baseDelMes(c, mes).valor == null) sinValor.push(c.nombre || c.codigo);
      else if (!externosSvc.baseGuardada(c.nombre, mes)) sinConfirmar.push(c.nombre || c.codigo);
    }
    paso({ id: 'pct', titulo: 'Repasar los % del mes', ir: 'cierre:externos',
      estado: sinValor.length ? 'falta' : (sinConfirmar.length ? 'aviso' : 'listo'),
      detalle: sinValor.length
        ? sinValor.length + ' sin % cargado: ' + sinValor.slice(0, 6).join(', ') + ' — sin eso no se puede calcular'
        : sinConfirmar.length ? sinConfirmar.length + ' sin confirmar: toman el % vigente igual'
        : 'todos confirmados para este mes' });

    // 4 · congelar. Sin congelar, tocar un precio hoy cambia lo que ya cobraste de este mes.
    let congelado = false;
    try { congelado = (cierreMesSvc.listar() || []).some((x) => x.mes === mes); } catch (e) {}
    paso({ id: 'congelar', titulo: 'Congelar el mes', ir: 'cierre:externos',
      estado: congelado ? 'listo' : 'aviso',
      detalle: congelado ? 'los precios de este mes quedaron fijos'
        : 'sin congelar, tocar un precio hoy cambia lo que ya cobraste de este mes' });

    /* ── CONTRASTAR CONTRA LOS PANELES, ANTES DE EMITIR ──────────────────────────────────────
       El contraste compara lo que se le va a cobrar a cada cliente contra lo que REGISTRARON sus
       paneles en el casino. Es lo único que atrapa una carga cobrada al cliente equivocado o una
       que se cobra dos veces, y después de emitir ya no sirve de mucho: la deuda está puesta.

       Hasta el 5-oct-2026 sólo se podía correr de a UN cliente, metido adentro de la vista previa
       de su factura. El mes entero nunca se contrastaba, y en la cuenta de cada cliente quedaba
       escrito «sin contrastar» para siempre. El servidor sabía hacerlo desde siempre
       (`/api/os/validacion/<mes>?correr=1`) y no lo llamaba ninguna pantalla.

       Va ANTES de las emisiones a propósito: es el paso que tiene sentido hacer antes, no después. */
    let contraste = null;
    try { contraste = crucePanel.leer(mes); } catch (e) { /* si no se puede leer, se pide correrlo */ }
    /* Lo que importa no es si se emitió antes o después del contraste —después está bien— sino si
       el contraste quedó VIEJO: corrido antes de la última foto, mira datos que ya cambiaron. Es
       el mismo criterio que usa `vieja()` para las emisiones, unas líneas más abajo. */
    const contrasteViejo = !!(contraste && contraste.validadoAt && fotoAt
      && String(contraste.validadoAt) < String(fotoAt));
    const dif = contraste ? Number(contraste.clientesConDiferencias || 0) : 0;
    paso({ id: 'contraste', titulo: 'Contrastar contra los paneles', ir: 'facturacion',
      accion: 'cruzarElMes',
      estado: !contraste ? 'falta' : ((dif || contrasteViejo) ? 'aviso' : 'listo'),
      detalle: !contraste
        ? 'nunca se corrió para este mes: lo que se emita no pasa por ningún control'
        : (dif ? dif + ' cliente(s) con diferencias contra lo que registraron sus paneles — miralos antes de emitir'
               : 'todo lo del mes coincide con lo que registraron los paneles')
          + (contrasteViejo ? ' · ⚠ se corrió ANTES de la última foto: volvé a correrlo' : '') });

    /* 5-8 · las emisiones y las facturas. El orden lo puso la dueña: lo de los VENDEDORES va al
       final, después de mandarle las facturas a los clientes — no bloquea nada y llegaba a frenar
       lo urgente, que es el consumo. Cada emisión avisa si quedó vieja. */
    const vieja = (o) => !!(o && o.hasta && fotoAt && String(o.hasta) < String(fotoAt));
    const em = emision.emitido(mes).porOrigen || {};
    [['externos', 'Emitir proveedores externos', 'cierre:externos'],
     ['facturacion', 'Emitir el consumo (fichas)', 'facturacion']].forEach(([id, titulo, ir]) => {
      const o = em[id];
      paso({ id, titulo, ir,
        estado: !o ? 'falta' : (vieja(o) ? 'aviso' : 'listo'),
        detalle: !o ? 'todavía no se pasó a la deuda de nadie'
          : o.cantidad + ' cliente(s) · ' + o.total + ' USDT'
            + (vieja(o) ? ' — ⚠ se emitió ANTES de la última foto: anulá y emití de nuevo' : ''),
        emitidoAt: o ? o.hasta : null });
    });

    // 7 · las facturas que salieron
    let guardadas = [];
    try { guardadas = facturasGuardadas.delMes(mes) || []; } catch (e) {}
    const salieron = guardadas.filter((g) => g.salio_at).length;
    paso({ id: 'facturas', titulo: 'Mandar las facturas a los clientes', ir: 'facturacion',
      estado: salieron ? 'listo' : (guardadas.length ? 'aviso' : 'falta'),
      detalle: !guardadas.length ? 'ninguna generada todavía'
        : salieron + ' de ' + guardadas.length + ' salieron (impresa, copiada, link o Telegram)' });

    // 8 · los vendedores, al final: es la única cuenta que no le llega al cliente.
    {
      const o = em.vendedores;
      paso({ id: 'vendedores', titulo: 'Emitir lo de los vendedores', ir: 'cierre:vendedores',
        estado: !o ? 'falta' : (vieja(o) ? 'aviso' : 'listo'),
        detalle: !o ? 'todavía no se pasó a la deuda de nadie — no frena nada, puede ir al final'
          : o.cantidad + ' cliente(s) · ' + o.total + ' USDT'
            + (vieja(o) ? ' — ⚠ se emitió ANTES de la última foto: anulá y emití de nuevo' : ''),
        emitidoAt: o ? o.hasta : null });
    }

    /* 9-10 · LOS DOS ENVÍOS AL GRUPO INTERNO. Cerrar el mes no termina cuando la deuda está
       emitida: las dos cuentas van a «Cuentas Imperium», y eso es a mano y se olvida. Un paso que
       no está escrito no existe — por eso están acá, con su fecha, y no en la cabeza de nadie.
       Van DESPUÉS de su emisión: mandar una cuenta que todavía no se emitió es mandar un número
       que puede cambiar. */
    {
      const enviado = enviosStore.delMes(mes);
      const hayChat = !!String(configStore.getCfg('tgChatInterno') || '').trim();
      [['externos', 'Mandar la cuenta de EXTERNOS a Cuentas Imperium', 'cierre:externos'],
       ['vendedores', 'Mandar la cuenta de VENDEDORES a Cuentas Imperium', 'cierre:vendedores']]
        .forEach(([que, titulo, ir]) => {
          const e = enviado[que]; const o = em[que];
          // Si salió ANTES de la última emisión, lo que está en el grupo ya no es lo que se cobró.
          const desactualizado = !!(e && o && o.hasta && String(e.at) < String(o.hasta));
          paso({ id: 'enviar_' + que, titulo, ir,
            estado: e ? (desactualizado ? 'aviso' : 'listo') : (o ? 'falta' : 'aviso'),
            detalle: e
              ? (desactualizado
                ? 'salió el ' + String(e.at).slice(0, 10) + ', pero DESPUÉS se volvió a emitir: mandala de nuevo'
                : e.cantidad + ' cuenta(s) · ' + e.total_usdt + ' USDT · salió el ' + String(e.at).slice(0, 10))
              : !o ? 'primero hay que emitirlo'
              : hayChat ? 'todavía no salió al grupo'
              : 'falta cargar el grupo interno en ⚙ Ajustes → Medios de pago',
            enviadoAt: e ? e.at : null });
        });
    }

    const falta = pasos.filter((p) => p.estado === 'falta');
    ok(res, { mes, pasos, falta: falta.length, avisos: pasos.filter((p) => p.estado === 'aviso').length,
      siguiente: (falta[0] || null), puedeCerrar: !falta.length });
  }));
  // La validación guardada de un mes. Sale de la base, no consulta el casino: es lo que se validó
  // cuando se emitió, no lo que daría hoy. Con ?correr=1 se rehace.
  app.get('/api/os/validacion/:mes', wrap(async (req, res) => {
    if (req.query.correr === '1') {
      const v = await crucePanel.cruzarMes(req.params.mes);
      if (!v.ok) return err(res, 502, v.error);
      crucePanel.guardar(v);
    }
    ok(res, { validacion: crucePanel.leer(req.params.mes) });
  }));
  /* ── TODAS LAS CUENTAS DEL MES, JUNTAS ───────────────────────────────────────────────────────
     La pantalla de externos muestra un cliente por vez: para ver los 28 hay que entrar 28 veces y
     esperar el minuto que tarda cada consulta al casino. Y para mandarlas al grupo interno hacen
     falta todas juntas.

     Sale de lo EMITIDO, no de recalcular: lo emitido es lo que entró a la deuda del cliente, y es
     instantáneo. Recalcular acá daría un número que puede no ser el que se cobró —cambió un %, un
     precio, el TC— y mandar al grupo algo distinto de lo facturado es peor que no mandarlo. */
  /* ── QUÉ CAMBIARÍA SI RE-EMITO ───────────────────────────────────────────────────────────────
     Anular y volver a emitir mueve plata en las cuentas de todos, y hasta ahora la única forma de
     saber qué iba a pasar era hacerlo. Pasó dos veces en un día: primero con los internos (12.970
     USDT), después con la excepción de Titan (12.861 en el otro sentido).

     Esto lo contesta ANTES y sin escribir nada: lo emitido contra lo que daría hoy, cliente por
     cliente, y marca a quiénes ya les mandaste la factura — que son los que no se pueden mover sin
     avisarles. Lee la foto y el caché, así que para un mes ya calculado es instantáneo. */
  app.get('/api/os/emision/externos/:mes/simular', wrap(async (req, res) => {
    const mes = String(req.params.mes || '').slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(mes)) return err(res, 400, 'mes inválido');

    const emitido = {};
    emision.lineas(mes, 'externos').forEach((l) => { emitido[l.cliente_id] = l.monto_usdt; });

    const filas = []; const fallaron = [];
    for (const c of clientes.list().clientes) {
      if (c.es_vendedor) continue;
      let r = null;
      try { r = await externosSvc.reporte({ clienteNombre: c.nombre, mes }); }
      catch (e) { fallaron.push({ cliente: c.nombre, error: String((e && e.message) || e) }); continue; }
      if (!r || !r.ok) { fallaron.push({ cliente: c.nombre, error: (r && r.error) || 'no salió' }); continue; }
      // A quién se le cobra de verdad: el que cuelga de otro no lleva línea propia.
      const paga = (c.factura_a && c.factura_a !== c.id && clientes.get(c.factura_a)) ? c.factura_a : c.id;
      const g = filas.find((f) => f.cliente_id === paga);
      if (g) { g.ahora = money.add(g.ahora, r.totalUsdt); if (paga !== c.id) g.incluye.push(c.nombre); continue; }
      const dueño = clientes.get(paga) || c;
      filas.push({ cliente_id: paga, cliente: dueño.nombre, codigo: dueño.codigo || '',
        ahora: r.totalUsdt, incluye: paga !== c.id ? [c.nombre] : [],
        base: r.base, incompleto: !!r.incompleto,
        internosSeCobran: !!dueño.internos_se_cobran });
    }

    // La factura que YA salió es la que no se puede mover sin avisarle al cliente.
    filas.forEach((f) => {
      f.emitido = emitido[f.cliente_id] || '0';
      f.dif = money.round(money.sub(f.ahora, f.emitido), 2);
      f.ahora = money.round(f.ahora, 2);
      const g = facturasGuardadas.get(f.cliente_id, mes);
      f.facturaSalio = g && g.salio_at ? g.salio_como : null;
      delete f.cliente_id;
    });
    // Los que tienen línea emitida y hoy no darían nada: también se mueven, a cero.
    Object.entries(emitido).forEach(([cid, monto]) => {
      if (filas.some((f) => f.cliente === (clientes.get(cid) || {}).nombre)) return;
      const c = clientes.get(cid) || {};
      const g = facturasGuardadas.get(cid, mes);
      filas.push({ cliente: c.nombre || cid, codigo: c.codigo || '', emitido: monto, ahora: '0',
        dif: money.round(money.sub('0', monto), 2), incluye: [], base: null, incompleto: false,
        facturaSalio: g && g.salio_at ? g.salio_como : null });
    });

    filas.sort((a, b) => Math.abs(Number(b.dif)) - Math.abs(Number(a.dif)));
    const cambian = filas.filter((f) => Math.abs(Number(f.dif)) > 0.004);
    ok(res, { mes, filas, cambian: cambian.length, fallaron,
      total_emitido: money.round(money.sum(filas.map((f) => f.emitido)), 2),
      total_ahora: money.round(money.sum(filas.map((f) => f.ahora)), 2),
      salieron: cambian.filter((f) => f.facturaSalio).length });
  }));
  app.get('/api/os/emision/detalle/:mes', wrap((req, res) => {
    const mes = String(req.params.mes || '').slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(mes)) return err(res, 400, 'mes inválido');
    const nom = {}; clientes.list().clientes.forEach((c) => { nom[c.id] = c; });
    const armar = (origen) => {
      const filas = emision.lineas(mes, origen).map((l) => {
        const c = nom[l.cliente_id] || {};
        return { ...l, cliente: c.nombre || l.cliente_id, codigo: c.codigo || '', es_vendedor: !!c.es_vendedor };
      });
      return { origen, filas, cantidad: filas.length,
        total_usdt: money.round(money.sum(filas.map((f) => f.monto_usdt)), 2),
        emitidoAt: filas.reduce((a, f) => (!a || String(f.emitidoAt) > a ? f.emitidoAt : a), null) };
    };
    ok(res, { mes, externos: armar('externos'), vendedores: armar('vendedores'),
      enviado: enviosStore.delMes(mes), chat: String(configStore.getCfg('tgChatInterno') || '').trim() || null });
  }));
  /* ── Y SE MANDAN AL GRUPO INTERNO ────────────────────────────────────────────────────────────
     «Cuentas Imperium» es interno: ahí SÍ van los nombres, al revés del resumen de pesos, que va
     al grupo donde concilian contra el banco. Son dos grupos y dos criterios distintos; no se
     mezclan.
     Se pregunta siempre antes desde la pantalla, y queda anotado qué salió y cuándo — así el paso
     del cierre puede decir si ya se mandó en vez de que haya que acordarse. */
  app.post('/api/os/emision/:origen/:mes/enviar', wrap(async (req, res) => {
    const origen = String(req.params.origen || '');
    const mes = String(req.params.mes || '').slice(0, 7);
    if (!enviosStore.QUE.includes(origen)) return err(res, 400, `no sé mandar "${origen}"`);
    if (!/^\d{4}-\d{2}$/.test(mes)) return err(res, 400, 'mes inválido');
    const chat = String(configStore.getCfg('tgChatInterno') || '').trim();
    const tok = configStore.getTelegramToken();
    if (!tok) return err(res, 400, 'el bot de Telegram no está configurado');
    if (!chat) return err(res, 400, 'no hay grupo interno cargado en Config → Medios de pago (Cuentas Imperium)');

    const nom = {}; clientes.list().clientes.forEach((c) => { nom[c.id] = c; });
    const filas = emision.lineas(mes, origen);
    if (!filas.length) return err(res, 400, `no hay nada emitido de ${origen} en ${mes}: emitilo antes de mandarlo`);
    const total = money.round(money.sum(filas.map((f) => f.monto_usdt)), 2);
    const fmt = (x) => Number(x || 0).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const titulo = origen === 'externos' ? '🧾 <b>Proveedores externos' : '🤝 <b>Proveedores de vendedores';
    const texto = [`${titulo} — ${mesCierreLbl(mes).replace('_', ' ')}</b>`, '']
      .concat(filas.map((f) => {
        const c = nom[f.cliente_id] || {};
        return `  ${telegram.escapeHtml(c.nombre || f.cliente_id)}   ${fmt(f.monto_usdt)}`;
      }))
      .concat(['', `<b>Total: ${fmt(total)} USDT</b>`, `<i>${filas.length} cuenta(s)</i>`])
      .join('\n');
    const cuerpo = (req.body && req.body.texto != null && String(req.body.texto).trim())
      ? String(req.body.texto) : texto;
    if (req.body && req.body.soloTexto) {
      return ok(res, { previsualizacion: true, texto: cuerpo, chat, destino: 'Cuentas Imperium',
        cuentas: filas.length, total });
    }
    const r = await telegram.sendMessage(tok, chat, cuerpo);
    if (!r.ok) return err(res, 502, r.error || 'Telegram no aceptó el mensaje');
    const marca = enviosStore.marcar({ mes, que: origen, chat, cantidad: filas.length, total_usdt: total,
      quien: (req.usuario && req.usuario.usuario) || 'admin' });
    ok(res, { enviado: filas.length, total, chat, ...marca });
  }));
  app.get('/api/os/emision/:mes', (req, res) => ok(res, emision.emitido(req.params.mes)));
  app.post('/api/os/emision/facturacion', wrap(async (req, res) => {
    const mes = String((req.body && req.body.mes) || mesTZ()).slice(0, 7);

    /* ── EL PANEL ES LA VALIDACIÓN: NO SE EMITE SIN HABERLA MIRADO ────────────────────────────
       Emitir convierte el número en deuda. Si una carga que se factura no existe en el panel se
       está cobrando de más; si el panel entregó fichas que nadie pidió, no se está cobrando. Las
       dos cosas cuadran igual en todas las pantallas, que es la forma cara de estar mal.
       Así que antes de emitir se contrasta contra los paneles. No BLOQUEA —el casino puede estar
       lento o no devolver una moneda, y el mes tiene que poder cerrarse— pero no se puede emitir
       sin haber visto el resultado: la primera llamada devuelve las diferencias y pide confirmar.
       La validación queda guardada, con quién confirmó, para poder mirarla meses después. */
    if (!(req.body && req.body.confirmado)) {
      // Lo que el ruteo dejó SIN COBRAR A NADIE: cargas en un panel de tránsito que no aparecen
      // cobradas más abajo. La marca del panel no las puede hacer desaparecer sin que alguien las vea.
      const previa = await _facturacionDe(mes, { control: false });
      // Las que ya se miraron no vuelven a frenar la emisión. Usan el id del pedido como nodo:
      // vienen de los pedidos, no de una fila del casino.
      const vistas = crucePanel.resoluciones(mes);
      const revisar = ((previa && previa.paraRevisar) || []).map((x) => ({
        ...x, clave: crucePanel.claveDe(mes, x.id, { divisa: x.divisa, monto: x.monto, fecha: x.iso || null }),
      })).filter((x) => !vistas[x.clave]);
      /* ── EL CRUCE SE SACA UNA VEZ, COMO LA FOTO ─────────────────────────────────────────────
         Acá se le preguntaba el historial a los 73 paneles CADA VEZ: 78 segundos, y si el proxy
         cortaba antes, la pantalla quedaba colgada sin decir nada. Y era al pedo — las cargas y
         los pedidos de un mes que pasó ya no se mueven, igual que la foto.
         Se lee el guardado; sólo se sale a preguntar si no hay ninguno o si se pide de nuevo con
         `recontrastar: true`. Lo que puede cambiar en el medio son las cargas que se marcaron como
         vistas, y eso se filtra acá arriba, sobre lo guardado. */
      // `leer` devuelve la fila con el cruce adentro de `datos`; `cruzarMes` devuelve el cruce
      // pelado. Se desenvuelve para que las dos ramas hablen la misma forma — si no, `v.ok` es
      // undefined sobre lo guardado y se sale a preguntar igual, que es justo lo que se evita.
      let v = (crucePanel.leer(mes) || {}).datos || null;
      if (!v || !v.ok || (req.body && req.body.recontrastar)) {
        v = await crucePanel.cruzarMes(mes);
        if (v.ok) crucePanel.guardar(v);
      }
      if (revisar.length || (v && v.ok && crucePanel.hayQueMirar(v))) {
        return res.status(409).json({ ok: false, requiereConfirmacion: true,
          error: revisar.length
            ? `hay ${revisar.length} carga(s) que no se le cobran a nadie, y el contraste contra los paneles puede tener más: mirá el detalle antes de emitir`
            : 'el contraste contra los paneles encontró diferencias: mirá el detalle antes de emitir',
          paraRevisar: revisar,
          // Cuándo se sacó el contraste que se está mostrando: si es de hace una semana, quien lo
          // mira tiene que poder saberlo y pedirlo de nuevo, no descubrirlo cuando un número no da.
          contrasteDe: (v && v.validadoAt) || null,
          validacion: v && v.ok ? v : null });
      }
    }

    // el mismo cálculo que muestra la pantalla, para que no puedan diferir
    const fac = await _facturacionDe(mes, { control: false });
    // ── LO QUE YA ESTÁ CARGA POR CARGA NO SE VUELVE A COBRAR ──────────────────────────────────
    //
    // Desde que cada carga genera su deuda en el momento, el cierre del mes ya no CREA la deuda de
    // fichas: la mayor parte ya está en la cuenta. Emitirla de nuevo cobraría el mismo consumo dos
    // veces, y cuadraría en todas las pantallas — que es la forma cara de estar mal.
    //
    // El cierre pasa a CONCILIAR: para cada cliente compara lo que suman sus cargas contra lo que
    // da el cálculo del mes. Si ya está cubierto, no emite nada y lo dice. La diferencia, cuando
    // la hay, es la del tipo de cambio: cada carga se congeló con el suyo y el cálculo mensual usa
    // el del mes. No se "corrige" hacia el mensual — la suma de los snapshots es la verdad, porque
    // es a ese cambio que se cobró cada operación.
    const yaEnCuenta = deudaCargaSvc.delMes(mes);
    const conciliado = [];
    const recortados = [];   // clientes a los que les falta el TC de alguna moneda
    const lineas = (fac.clientes || []).filter((c) => !c.sinBase).map((c) => {
      const ya = yaEnCuenta[c.cliente_id];
      if (ya && (ya.cargas || ya.anuladas)) {
        /* Se compara en la moneda en que se lleva la cuenta. Ru98 lleva la cuenta en pesos: sus
           cargas no tienen cara en dólares y la tabla decía «en su cuenta 0», una diferencia que
           no existía. En pesos se compara contra lo que el cálculo del mes cobra en pesos. */
        const enPesos = (clientes.get(c.cliente_id) || {}).moneda_cuenta === 'ARS';
        const calcArs = money.sum((c.porDivisa || []).filter((d) => d.divisa === 'ARS').map((d) => d.fee || '0'));
        const enCuenta = enPesos ? ya.ars : ya.usdt;
        const calculo = enPesos ? calcArs : c.fee_usdt;
        conciliado.push({ cliente_id: c.cliente_id, codigo: c.codigo, cargas: ya.cargas, anuladas: ya.anuladas || 0,
          moneda: enPesos ? 'ARS' : 'USDT',
          enCuenta: money.round(enCuenta, 2), calculoMes: money.round(calculo, 2),
          // los nombres de antes, para lo que todavía los lea
          enCuenta_usdt: ya.usdt, calculoMes_usdt: c.fee_usdt,
          diferencia: money.round(money.sub(calculo, enCuenta), 2) });
        return null;                       // su deuda ya está: no se emite
      }
      /* ── NO SE EMITE UN TOTAL RECORTADO ──────────────────────────────────────────────────
         Si a este cliente le falta el tipo de cambio de alguna de sus monedas, lo vendido en esa
         moneda quedó AFUERA de `fee_usdt`. Emitir así le cobra de menos con una factura que se ve
         impecable — y como emitir es idempotente por cliente+origen+mes, la parte que falta ya no
         se puede agregar después: habría que anular el mes entero y rehacerlo, y nadie se va a
         acordar porque nada avisó.
         No cobrar todavía se arregla cargando el TC y volviendo a emitir (los ya emitidos se
         saltean solos). Cobrar de menos, no. */
      if ((c.sinTC || []).length) {
        recortados.push({ cliente: c.nombre || c.codigo, divisas: c.sinTC.join(', '),
          error: `falta el tipo de cambio de ${c.sinTC.join(', ')} en ${mes}: lo vendido en `
            + `${c.sinTC.length > 1 ? 'esas monedas' : 'esa moneda'} quedaría sin cobrar` });
        return null;
      }
      return { cliente_id: c.cliente_id, monto_usdt: c.fee_usdt, base_pct: c.base,
        notas: `Fichas ${mes} · ${c.base}% sobre ${c.vendido_usdt} USDT vendidos` };
    }).filter(Boolean);
    const r = emision.emitir({ mes, origen: 'facturacion', lineas });
    if (!r.ok) return err(res, 400, r.error);
    /* Y se congela la factura de cada cliente. Emitir es el momento en que el número se vuelve
       deuda: si no se guarda acá, dentro de tres meses no hay forma de volver a lo que se cobró.
       El detalle se trae UNA vez para todos, no una vez por cliente. */
    let guardadas = 0;
    try {
      for (const c of (fac.clientes || [])) {
        if (c.sinBase) continue;
        /* CON los externos. Iba en `false` y por eso la factura guardada mostraba el total con
           los externos adentro y ni una línea de dónde salían: el cliente veía un número más
           grande que la suma de sus cargas y no podía auditarlo. Ahora que el reporte sale de la
           foto del mes tarda ~1s por cliente, así que la factura se guarda completa. */
        const f = await facturaSvc.armar({ clienteId: c.cliente_id, mes, consumo: c, conExternos: true });
        if (!f.ok) continue;
        facturasGuardadas.guardar(f, { quien: (req.usuario && req.usuario.usuario) || 'admin' });
        guardadas += 1;
      }
    } catch (e) { console.warn('[Factura] no se pudieron guardar todas:', e.message); }
    // Queda el rastro de que se emitió con las diferencias a la vista, y de quién lo decidió.
    if (req.body && req.body.confirmado) {
      const guardada = crucePanel.leer(mes);
      if (guardada && guardada.datos) crucePanel.guardar(guardada.datos, { confirmadoPor: (req.usuario && req.usuario.usuario) || 'admin' });
    }
    ok(res, { ...r, guardadas, validacion: crucePanel.leer(mes), sinBase: fac.sinBase, sinPedidos: fac.sinPedidos,
      // Quiénes quedaron sin emitir por falta de tipo de cambio: es lo que hay que destrabar.
      fallaron: recortados,
      // Quiénes ya tenían su deuda cargada carga por carga, y cuánto se aparta del cálculo mensual.
      conciliado, yaCargaPorCarga: conciliado.length });
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
      /* Un reporte INCOMPLETO no se emite: cobraría de menos y parecería correcto.
         El motivo se dice entero: antes el mensaje nombraba sólo el reloj ("faltan N consultas"),
         y con las otras cuatro formas de quedar corto ni siquiera se llegaba hasta acá. Un cliente
         salteado sin decir por qué es un cliente que nadie va a poder destrabar. */
      if (r.incompleto) {
        fallaron.push({ cliente: c.nombre, error: 'el reporte salió incompleto: ' + r.porQueIncompleto.join(' · '),
          faltantes: r.faltantes, avisos: r.avisos });
        continue;
      }
      if (!money.isPos(r.totalUsdt)) continue;
      lineas.push({ cliente_id: c.id, monto_usdt: r.totalUsdt, base_pct: r.base, notas: `Proveedores externos ${mes} · base ${r.base}%` });
    }

    /* ── EL QUE CUELGA DE OTRO NO PAGA SU PROPIA CUENTA ───────────────────────────────────────
       JJ se le factura a Marcelo, Ariel a Fran: su deuda va a la cuenta del que de verdad paga.
       Eso ya pasaba con el CONSUMO —lo rutea `factura_a` en pedidos-store— pero los externos se
       emitían igual a nombre del chico, así que la cuenta quedaba partida en dos: el consumo en
       uno y los proveedores en el otro.
       Se suman en UNA línea, porque la deuda tiene un solo renglón por cliente y mes (el índice
       único de emisión). Y la nota dice de quiénes está hecha, que si no el número aparece más
       grande que su propio reporte y no hay forma de explicarlo. */
    const porPagador = new Map(); const ruteadas = [];
    for (const l of lineas) {
      const c = clientes.get(l.cliente_id) || {};
      const paga = (c.factura_a && c.factura_a !== c.id && clientes.get(c.factura_a)) ? c.factura_a : c.id;
      if (paga !== c.id) ruteadas.push({ de: c.nombre, a: (clientes.get(paga) || {}).nombre, monto: l.monto_usdt });
      const ya = porPagador.get(paga);
      if (!ya) { porPagador.set(paga, { ...l, cliente_id: paga, de: paga === c.id ? [] : [c.nombre] }); continue; }
      ya.monto_usdt = money.add(ya.monto_usdt, l.monto_usdt);
      if (paga !== c.id) ya.de.push(c.nombre);
    }
    const lineasFinales = [...porPagador.values()].map((l) => ({
      ...l,
      notas: l.de && l.de.length
        ? `Proveedores externos ${mes} · base ${l.base_pct}% · incluye ${l.de.join(', ')}`
        : l.notas,
    }));
    const out = emision.emitir({ mes, origen: 'externos', lineas: lineasFinales });
    if (!out.ok) return err(res, 400, out.error);
    ok(res, { ...out, sinBase, fallaron, ruteadas });
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
      if (r.incompleto) {
        fallaron.push({ vendedor: c.nombre, error: 'el reporte salió incompleto: ' + r.porQueIncompleto.join(' · '),
          faltantes: r.faltantes, avisos: r.avisos });
        continue;
      }
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
  // ───────── 📄 LA FACTURA DEL MES, para mandársela al cliente ─────────
  // Junta las DOS facturas (consumo y proveedores externos) en un documento, más la cuenta
  // corriente. No recalcula: pide los mismos números que muestran las pantallas, para que lo
  // que se manda no pueda diferir de lo que dice el panel.
  /** Arma la factura de un cliente para un mes, con la misma línea de consumo que muestra la pantalla. */
  async function _armarFactura(clienteId, mes, { conExternos = true, conCruce = false } = {}) {
    const fac = await _facturacionDe(mes, { control: false });
    if (fac.ok === false) return { ok: false, error: fac.error, esDelPuente: true };
    const linea = (fac.clientes || []).find((c) => c.cliente_id === clienteId) || null;
    return facturaSvc.armar({ clienteId, mes, consumo: linea, conExternos, conCruce });
  }
  /* Registrar que la factura salió del sistema. Se llama al imprimir y al copiar, que son las dos
     formas en que se venía usando y las dos que no dejaban ningún rastro. */
  app.post('/api/os/factura/:clienteId/registrar', wrap(async (req, res) => {
    const mes = String((req.body && req.body.mes) || mesTZ()).slice(0, 7);
    const como = ['impresa', 'copiada'].includes(req.body && req.body.como) ? req.body.como : 'copiada';
    // Si ya estaba guardada se registra la salida sobre ESA, sin recalcular: lo que se imprimió
    // es lo que se estaba mirando, no lo que daría el cálculo de este segundo.
    const ya = facturasGuardadas.get(req.params.clienteId, mes);
    if (ya && ya.datos) return ok(res, { ok: true, factura: facturasGuardadas.marcarSalida(req.params.clienteId, mes, como) });
    const f = await _armarFactura(req.params.clienteId, mes, { conExternos: true });
    if (!f.ok) return err(res, 400, f.error);
    const r = facturasGuardadas.guardar(f, { como, quien: (req.usuario && req.usuario.usuario) || 'admin' });
    ok(res, r);
  }));
  /**
   * ── VOLVER A GENERAR LAS FACTURAS YA GUARDADAS DE UN MES ────────────────────────────────────
   *
   * La factura guardada es la que se le mandó al cliente, y por eso pedirla de nuevo NO recalcula:
   * dentro de tres meses tiene que dar lo mismo. Pero cuando se arregla algo que cambia el número
   * —pasó con el saldo, que arrastraba el mes siguiente— las guardadas quedan con el número viejo
   * y no hay forma de actualizarlas sin volver a emitir el mes entero, que toca la deuda.
   *
   * Esto rehace SÓLO las facturas, sin tocar ningún movimiento. `guardar` conserva `generada_at` y
   * la primera salida: lo que cambia es el contenido, y sube `veces`.
   *
   * Por defecto SIMULA y dice cuáles cambiarían de número. Escribir hay que pedirlo con
   * `aplicar: true`: son los papeles que ve el cliente.
   */
  app.post('/api/os/facturas-guardadas/:mes/regenerar', wrap(async (req, res) => {
    const mes = String(req.params.mes || '').slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(mes)) return err(res, 400, 'mes inválido');
    const aplicar = !!(req.body && req.body.aplicar);
    const guardadas = facturasGuardadas.delMes(mes) || [];
    const cambian = []; const iguales = []; const fallaron = [];
    for (const g of guardadas) {
      let f;
      try { f = await _armarFactura(g.cliente_id, mes, { conExternos: true }); }
      catch (e) { fallaron.push({ cliente_id: g.cliente_id, error: String((e && e.message) || e) }); continue; }
      if (!f || !f.ok) { fallaron.push({ cliente_id: g.cliente_id, error: (f && f.error) || 'no se pudo armar' }); continue; }
      const fila = { cliente_id: g.cliente_id, cliente: (f.cliente || {}).nombre || g.cliente_id,
        antes_total: g.total_usdt, ahora_total: f.totalMes_usdt,
        // el saldo es el que cambió con el arreglo, y es el que el cliente lee al final
        antes_saldo: ((g.datos || {}).cuenta || {}).saldo ?? null,
        ahora_saldo: f.saldoAlCierre ?? null,
        yaSalio: g.salio_at ? g.salio_como : null };
      const distinto = String(fila.antes_total) !== String(fila.ahora_total)
        || String(fila.antes_saldo) !== String(fila.ahora_saldo);
      (distinto ? cambian : iguales).push(fila);
      if (aplicar) facturasGuardadas.guardar(f, { quien: (req.usuario && req.usuario.usuario) || 'admin' });
    }
    ok(res, { mes, simulado: !aplicar, total: guardadas.length,
      cambian: cambian.length, iguales: iguales.length, fallaron,
      detalle: cambian, yaEnviadas: cambian.filter((x) => x.yaSalio) });
  }));
  /* ── LAS CUENTAS DE EXTERNOS, TAL CUAL SE COBRARON (17-oct-2026) ──────────────────────────
     Para descargar sólo la parte de proveedores externos de un mes pasado y mandársela al cliente.
     Sale de la factura guardada, no de recalcular (ver externos-guardados.js). */
  const extGuardados = require('./externos-guardados');
  const mesOk = (m) => /^\d{4}-\d{2}$/.test(String(m || ''));
  app.get('/api/os/externos-guardados', (req, res) => {
    const mes = String(req.query.mes || '').slice(0, 7);
    if (!mesOk(mes)) return err(res, 400, 'mes inválido');
    ok(res, { mes, clientes: extGuardados.delMes(mes) });
  });
  app.get('/api/os/externos-guardados/:mes/todos.csv', (req, res) => {
    if (!mesOk(req.params.mes)) return err(res, 400, 'mes inválido');
    const c = extGuardados.csv(req.params.mes, null);
    if (!c) return err(res, 404, 'no hay cuentas de externos guardadas de ese mes');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="externos-${req.params.mes}-todos.csv"`);
    res.send(c);
  });
  app.get('/api/os/externos-guardados/:mes/:clienteId.csv', (req, res) => {
    if (!mesOk(req.params.mes)) return err(res, 400, 'mes inválido');
    const c = extGuardados.csv(req.params.mes, req.params.clienteId);
    if (!c) return err(res, 404, 'ese cliente no tiene cuenta de externos guardada de ese mes');
    const d = extGuardados.de(req.params.clienteId, req.params.mes);
    const nombre = String((d && (d.codigo || d.cliente)) || req.params.clienteId).replace(/[^\w.-]+/g, '_');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="externos-${req.params.mes}-${nombre}.csv"`);
    res.send(c);
  });
  app.get('/api/os/externos-guardados/:mes/:clienteId.html', (req, res) => {
    if (!mesOk(req.params.mes)) return err(res, 400, 'mes inválido');
    const h = extGuardados.html(req.params.mes, req.params.clienteId);
    if (!h) return err(res, 404, 'ese cliente no tiene cuenta de externos guardada de ese mes');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(h);
  });
  // El historial de facturas de un cliente: qué se le generó, cuándo, y si salió.
  app.get('/api/os/facturas-guardadas/:clienteId', (req, res) =>
    ok(res, { facturas: facturasGuardadas.delCliente(req.params.clienteId) }));
  // La factura guardada de un mes, tal cual se generó.
  app.get('/api/os/facturas-guardadas/:clienteId/:mes', (req, res) => {
    const f = facturasGuardadas.get(req.params.clienteId, req.params.mes);
    if (!f) return err(res, 404, 'no hay ninguna factura guardada de ese mes');
    ok(res, { factura: f });
  });
  app.get('/api/os/factura/:clienteId', wrap(async (req, res) => {
    const mes = String(req.query.mes || mesTZ()).slice(0, 7);
    /* Si ya se generó una factura de ese mes, se muestra ESA y no un recálculo: es lo que se le
       mandó al cliente, y pedirla de nuevo dos meses después daría otro número. Con ?vivo=1 se
       fuerza el recálculo, para comparar la guardada contra lo que daría hoy. */
    if (req.query.vivo !== '1') {
      const g = facturasGuardadas.get(req.params.clienteId, mes);
      if (g && g.datos) {
        /* Las guardadas de antes del 8-sep-2026 no tienen el USDT de cada panel y salían todas
           «sin TC». Se deriva al vuelo del TC de la propia factura; lo guardado no se toca, que es
           lo que el cliente ya recibió. */
        const datos = facturaSvc.conUsdtPorPanel(g.datos);
        return ok(res, { ...datos, guardada: {
          generada_at: g.generada_at, generada_por: g.generada_por, veces: g.veces,
          actualizada_at: g.actualizada_at, salio_at: g.salio_at, salio_como: g.salio_como,
        }, texto: facturaSvc.aTexto(datos), textoConDetalle: facturaSvc.aTexto(datos, { detalle: true }) });
      }
    }
    // la línea de consumo sale de la MISMA función que la pantalla de Factura de consumo
    const fac = await _facturacionDe(mes, { control: false });
    if (fac.ok === false) return err(res, 502, fac.error);
    const linea = (fac.clientes || []).find((c) => c.cliente_id === req.params.clienteId) || null;
    const f = await facturaSvc.armar({
      clienteId: req.params.clienteId, mes, consumo: linea,
      conExternos: req.query.externos !== '0',
      // El cruce contra el panel va APAGADO por defecto: consulta el casino una vez por panel y
      // por moneda, y la factura se abre muchas veces al día. Se pide con ?cruce=1.
      conCruce: req.query.cruce === '1',
    });
    if (!f.ok) return err(res, 404, f.error);
    ok(res, { ...f, texto: facturaSvc.aTexto(f), textoConDetalle: facturaSvc.aTexto(f, { detalle: true }) });
  }));
  // El LINK con el que el cliente ve el desglose completo. Por Telegram le va el resumen y esto.
  app.post('/api/os/factura/:clienteId/link', wrap(async (req, res) => {
    // Igual que enviar: el link se le pasa al cliente, así que tampoco puede adivinar el mes.
    const mes = String((req.body && req.body.mes) || '').slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(mes)) return err(res, 400, 'falta decir de qué mes es la factura — no se arma a ciegas');
    /* Si ya hay una factura guardada de ese mes, el link tiene que mostrar ESA: si recalculara, el
       cliente abriría el link y vería un número distinto del que se le mandó. */
    const g = facturasGuardadas.get(req.params.clienteId, mes);
    let f = g && g.datos ? g.datos : null;
    if (!f) {
      f = await _armarFactura(req.params.clienteId, mes);
      if (!f.ok) return err(res, f.esDelPuente ? 502 : 404, f.error);
      facturasGuardadas.guardar(f, { como: 'link', quien: (req.usuario && req.usuario.usuario) || 'admin' });
    } else {
      facturasGuardadas.marcarSalida(req.params.clienteId, mes, 'link');
    }
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
    /* 🔴 SIN MES NO SE MANDA. Caía al mes actual, y eso mandó la factura de septiembre a un cliente
       mientras se estaba mirando la de agosto. Un documento que sale para afuera no puede adivinar
       de qué mes es: si no viene, se frena y se dice. Un error acá no se puede deshacer. */
    const mes = String((req.body && req.body.mes) || '').slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(mes)) return err(res, 400, 'falta decir de qué mes es la factura — no se manda a ciegas');
    const conDetalle = !!(req.body && req.body.detalle);
    const cli = clientes.get(req.params.clienteId);
    if (!cli) return err(res, 404, 'cliente no encontrado');
    // Puede ir al grupo del vendedor si el cliente no tiene el suyo — ver telegram-destino.js.
    const dest = tgDestino.destinoDe(cli, (id) => clientes.get(id));
    const chat = dest.chatId;
    if (!chat) return err(res, 400, `${cli.nombre || cli.codigo} no tiene grupo de Telegram, ni él ni su vendedor (se pone en su ficha, o en la del vendedor para que lo hereden todos)`);
    const tok = configStore.getTelegramToken();
    if (!tok) return err(res, 400, 'falta el token del bot de Telegram (⚙ Config)');

    /* Se manda la guardada si existe: lo que le llega al cliente tiene que ser lo mismo que ya se
       generó, no lo que daría el cálculo de este momento. */
    const g = facturasGuardadas.get(cli.id, mes);
    let f = g && g.datos ? g.datos : null;
    if (!f) {
      f = await _armarFactura(cli.id, mes, { conExternos: req.body.externos !== false });
      if (!f.ok) return err(res, f.esDelPuente ? 502 : 400, f.error);
    }

    // Por Telegram va el RESUMEN, y el desglose completo por link: 153 cargas en tres mensajes
    // seguidos no hay quien las lea, y en la página se pueden mirar por panel con calma.
    let texto = facturaSvc.aTexto(f, { detalle: conDetalle });
    if (req.body.link !== false) {
      const l = facturaSvc.crearLink(f);
      texto += `\n\n📄 <a href="${_urlPublica(req)}/factura/${l.token}">Ver el detalle completo</a>`;
    }
    /* ── VERLO Y PODER TOCARLO ANTES DE QUE SALGA ──────────────────────────────────────────────
       Con `soloTexto` se arma TODO —incluido el link, que se crea igual— y se devuelve sin mandar
       nada. La pantalla lo muestra tal cual va a salir y deja editarlo; después vuelve con `texto`
       y se manda eso. Antes lo único que se podía hacer era aceptar a ciegas, y estos mensajes se
       volvieron largos: aceptar sin leer es cómo sale algo mal a un grupo de un cliente. */
    if (req.body.texto != null && String(req.body.texto).trim()) texto = String(req.body.texto);
    if (req.body.soloTexto) {
      return ok(res, { previsualizacion: true, texto, chat,
        destino: dest.heredado ? `el grupo de ${dest.de}` : (cli.nombre || cli.codigo),
        partes: facturaSvc.partir(texto).length });
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
    // Recién con el envío hecho queda registrado: si Telegram falla no se marca como enviada.
    if (g && g.datos) facturasGuardadas.marcarSalida(cli.id, mes, 'telegram');
    else facturasGuardadas.guardar(f, { como: 'telegram', quien: (req.usuario && req.usuario.usuario) || 'admin' });
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

  for (const s of SECTORES) s.mount(app);

  console.log('[OS] rutas comerciales/financieras montadas (/api/os/*)');
}

module.exports = { mount };
