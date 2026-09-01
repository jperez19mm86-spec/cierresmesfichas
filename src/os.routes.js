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
const apiStore = require('./api-store');
const tbsDiario = require('./tbs-diario-store');
const tbsDiarioSvc = require('./tbs-diario.service');
const tbsComparativa = require('./tbs-comparativa');
const { parseMonto } = require('./lib/monto');
const apiCuenta = require('./api-cuenta.service');
const apiCuentaDoc = require('./api-cuenta-doc');
const apiCuentaHtml = require('./api-cuenta-html');
const pagoProvHtml = require('./pago-proveedores-html');
const documentos = require('./documentos');
const { rolDe } = require('./auth');
const apiResumen = require('./api-resumen.service');
const tgDestino = require('./telegram-destino');
const { mesCierre: mesCierreLbl } = require('./lib/fechas');
const notify = require('./notify.service');
const casinoConex = require('./casino-conexiones-store');
const acumSvc = require('./acumulado.service');
const reporteDiarioStore = require('./reporte-diario-store');
const pulsoSvc = require('./pulso.service');
const pedidosStore = require('./pedidos-store');
const solicitudes = require('./solicitudes-caja');
const deudaCargaSvc = require('./deuda-carga.service');
const acceso = require('./cliente-acceso');
const movPanel = require('./movimientos-panel');
const movPanelSvc = require('./movimientos-panel.service');
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
const backup = require('./backup.service');
const ofertas = require('./api-ofertas-store');
const ofertaHtml = require('./api-oferta-html');
const chat = require('./chat-externo.store');
const chatDoc = require('./chat-doc');
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
// Cuándo levantó ESTE proceso. Cambia en cada despliegue, sirva o no la variable de git.
const ARRANQUE = new Date().toISOString();

/* La conexión con motor TBS y su cliente. Estaba repetido en cada ruta que le habla, y la tercera
   copia es donde uno se olvida de comprobar que tenga credenciales. */
function _tbsCliente(conexionId) {
  const cx = casinoConex.list().find((c) => c.motor === 'tbs' && (!conexionId || c.id === conexionId));
  if (!cx) return { error: 'no hay ninguna conexión con motor TBS configurada' };
  const cli = casinoConex.client(cx.id);
  if (!cli) return { error: `la conexión "${cx.nombre}" no tiene credenciales cargadas` };
  return { cli, nombre: cx.nombre, id: cx.id };
}

function basePctEfectivo(cliente, panel, mes = mesTZ()) {
  return externosSvc.baseDelMes(cliente, mes, panel).valor;
}

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

  // Panel del OS (HTML estático, detrás del gate de auth)
  const path = require('path');
  /* ── EL NAVEGADOR NO PUEDE QUEDARSE CON UNA COPIA VIEJA ──────────────────────────────────────
     `express.static` no manda ningún Cache-Control, y sin él el navegador aplica su propia regla:
     reutiliza la respuesta un rato SIN preguntar si cambió. Para un archivo que se reescribe en
     cada despliegue eso significa que un cambio ya desplegado no aparece — y desde la pantalla se
     ve idéntico a que no se hubiera subido. Pasó de verdad: la pestaña nueva estaba en el servidor
     y en la pantalla no.

     `no-cache` NO quiere decir "no guardes": quiere decir "guardala, pero preguntá siempre si
     cambió". Con el ETag que ya manda express, la pregunta se contesta con un 304 sin cuerpo, así
     que no cuesta ancho de banda — sólo un viaje corto. Es lo correcto para un HTML que cambia. */
  const html = (res, archivo) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(path.join(__dirname, '..', 'public', archivo));
  };
  app.get('/os', (_req, res) => html(res, 'os.html'));
  // TBS es su propio espacio de trabajo, no una pestaña del comercial: otros clientes, otros
  // proveedores y otro cierre de mes. Sirve el MISMO archivo — duplicarlo para no compartir los
  // helpers habría sido peor — y la página se arma distinto según por dónde se entró.
  app.get('/tbs', (_req, res) => html(res, 'os.html'));
  /* El chat tiene su propio espacio, con la misma pantalla y otra barra. Ojo con el nombre: `/chat`
     es el portal PÚBLICO del cliente y no lleva login; éste es el de adentro y sí. */
  app.get('/chat-externo', (_req, res) => html(res, 'os.html'));

  // ───────── CLIENTES (comercial) ─────────
  app.get('/api/os/clientes', (_req, res) => {
    const list = clientes.list().clientes.map((c) => ({
      id: c.id, codigo: c.codigo, nombre: c.nombre || c.nombreVisible, estado: c.estado,
      telegram: c.telegram, paga_proveedores: c.paga_proveedores, permite_deuda: c.permite_deuda, avisa_pagos: c.avisa_pagos !== false,
      mezcla_pago_usdt: c.mezcla_pago_usdt, ajuste_usdt_pct: c.ajuste_usdt_pct,
      // v3.0 ficha
      divisa_fichas: c.divisa_fichas, moneda_cobro: c.moneda_cobro, momento_pago: c.momento_pago,
      disparador: c.disparador, tc_aplicar: c.tc_aplicar, tc_proveedor: c.tc_proveedor,
      // v3.0 §7-10 (planilla). Si no viajan acá, el modal los renderiza vacíos y al Guardar los pisa con null.
      mover_balance: c.mover_balance, moneda_cuenta: c.moneda_cuenta, margen_externos_pct: c.margen_externos_pct,
      es_vendedor: c.es_vendedor, vendedor_id: c.vendedor_id, externos_modo: c.externos_modo, saldo_inicial: c.saldo_inicial,
      saldo_inicial_divisa: c.saldo_inicial_divisa, saldo_inicial_mov_id: c.saldo_inicial_mov_id,
      precio_base_pct: historial.getVigente('cliente', c.id, 'precio_base_pct'),
      paneles: paneles.list({ cliente_id: c.id }).length,
      deuda: deudaSvc.cuentaCorriente(c.id),
    }));
    ok(res, { clientes: list });
  });

  // ───────── CATÁLOGO DE DIVISAS (v3.0) ─────────
  // ── QUÉ VERSIÓN ESTÁ CORRIENDO ────────────────────────────────────────────────────────────
  // Sin esto, saber si un cambio ya subió era buscar algún texto nuevo en la pantalla — y varias
  // veces esa sonda dio verde con el código VIEJO todavía arriba, porque el texto que buscaba ya
  // existía. Un cambio que no toca ninguna pantalla no tenía forma de comprobarse.
  //
  // ⚠️ Y OJO CON LA SONDA: pedirle a /api/os/loquesea sin ruta devuelve 401 del middleware de
  // sesión, no un 404. O sea que "responde algo con forma de API" NO prueba que la ruta exista.
  // Lo que prueba es el CONTENIDO: si vuelve `arranque`, la ruta está.
  app.get('/api/os/version', (_req, res) => ok(res, {
    commit: process.env.RAILWAY_GIT_COMMIT_SHA || process.env.GIT_COMMIT || null,
    mensaje: process.env.RAILWAY_GIT_COMMIT_MESSAGE || null,
    despliegue: process.env.RAILWAY_DEPLOYMENT_ID || null,
    arranque: ARRANQUE,
  }));
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
  /**
   * ¿A qué grupo llegan los avisos de pago, y el bot llega ahí? Sólo LEE (getChat): no manda un
   * mensaje de prueba a un grupo real. Existe porque un comprobante no llegó y no había forma de
   * saber si el problema era el id, el bot o el permiso.
   */
  app.get('/api/os/config/pagos/probar', wrap(async (_req, res) => {
    const tok = configStore.getTelegramToken();
    const out = [];
    for (const k of ['tgChatArs', 'tgChatUsdt']) {
      const chat = String(configStore.getCfg(k) || '').trim();
      if (!chat) { out.push({ clave: k, chat: null, ok: false, error: 'no hay grupo configurado' }); continue; }
      out.push({ clave: k, chat, ...(await telegram.verChat(tok, chat)) });
    }
    ok(res, { bot: !!tok, destinos: out });
  }));

  /**
   * Todos los grupos configurados, comprobados de una. Sólo LEE.
   *
   * Un grupo que dejó de existir no avisa: los envíos fallan de a uno, en silencio, y lo que se
   * nota meses después es que a un cliente "no le llegan las facturas". Esto los encuentra a todos
   * juntos, y sin escribirle a ninguno.
   */
  app.get('/api/os/telegram/probar-grupos', wrap(async (_req, res) => {
    const tok = configStore.getTelegramToken();
    if (!tok) return ok(res, { bot: false, grupos: [] });
    // Un mismo grupo puede estar en varios clientes (los vendedores lo prestan): se prueba UNA vez
    // y se dice quiénes dependen de él, que es lo que importa para saber a quién le afecta.
    const porChat = new Map();
    clientes.list().clientes.forEach((c) => {
      const id = String(((c.telegram || {}).chatId) || '').trim();
      if (!id) return;
      const g = porChat.get(id) || { chat: id, clientes: [], encendidos: 0 };
      g.clientes.push(c.nombre || c.codigo);
      if ((c.telegram || {}).enabled) g.encendidos += 1;
      porChat.set(id, g);
    });
    ['tgChatArs', 'tgChatUsdt'].forEach((k) => {
      const id = String(configStore.getCfg(k) || '').trim();
      if (!id) return;
      const g = porChat.get(id) || { chat: id, clientes: [], encendidos: 0 };
      g.clientes.push(`(avisos de pago: ${k})`);
      porChat.set(id, g);
    });
    const grupos = [];
    for (const g of porChat.values()) grupos.push({ ...g, ...(await telegram.verChat(tok, g.chat)) });
    grupos.sort((a, b) => (a.ok === b.ok ? 0 : (a.ok ? 1 : -1)));
    ok(res, { bot: true, grupos, rotos: grupos.filter((g) => !g.ok).length });
  }));

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
  // Prender o apagar "avisar pagos" a varios de una. Es lo primero que se necesita: apagarlo para
  // todos y prenderlo solo a los pocos que corresponde.
  app.post('/api/os/clientes/avisa-pagos', wrap((req, res) => {
    const b = req.body || {};
    const valor = !!b.valor;
    const ids = Array.isArray(b.ids) && b.ids.length ? b.ids : clientes.list().clientes.map((c) => c.id);
    let n = 0;
    ids.forEach((id) => { if (clientes.updateComercial(id, { avisa_pagos: valor })) n++; });
    ok(res, { cambiados: n, valor });
  }));

  /**
   * 🔒 NO SE CAMBIA LA MONEDA DE LA CUENTA SI YA HAY MOVIMIENTOS EN LA OTRA.
   *
   * Cambiarla no convierte nada: sólo cambia qué columna se suma. Un cliente con pagos cargados en
   * dólares que pasa a pesos vería su saldo en cero —los movimientos siguen ahí, en la columna que
   * ya no se mira— y eso parece un error de plata, no de configuración. Se corta antes.
   *
   * La salida no es "no se puede nunca": es cargar el ajuste que cierra la cuenta en la moneda
   * vieja, y recién ahí cambiarla. Con la cuenta en cero no hay nada que se pueda perder.
   */
  function puedeCambiarMoneda(cliente_id, nueva) {
    const actual = (clientes.get(cliente_id) || {}).moneda_cuenta === 'ARS' ? 'ARS' : 'USDT';
    const quiere = String(nueva).toUpperCase() === 'ARS' ? 'ARS' : 'USDT';
    if (actual === quiere) return null;
    const col = actual === 'ARS' ? 'monto_ars' : 'monto_usdt';
    const cuantos = movs.list({ cliente_id }).filter((m) => m[col] != null && m[col] !== '' && Number(m[col]) !== 0).length;
    if (!cuantos) return null;
    return `no se puede pasar la cuenta a ${quiere}: este cliente ya tiene ${cuantos} movimiento(s) `
      + `cargados en ${actual}. Cambiar la moneda no los convierte —sólo deja de sumarlos— y el saldo `
      + `quedaría en cero como si se hubiera perdido plata. Cerrá la cuenta en ${actual} con un ajuste y después cambiala.`;
  }

  /**
   * ── LA CUENTA PROPIA DE UN CLIENTE ───────────────────────────────────────────────────────────
   * Prenderla devuelve la clave EN CLARO UNA SOLA VEZ. No hay forma de volver a verla: lo que se
   * guarda es el hash. Si el cliente la pierde, se genera otra — eso es lo que hace que perderla
   * sea un trámite y no una filtración.
   */
  app.get('/api/os/clientes/:id/acceso', (req, res) => {
    const e = acceso.estado(req.params.id);
    return e ? ok(res, { acceso: e }) : err(res, 404, 'no encontré ese cliente');
  });
  app.post('/api/os/clientes/:id/acceso', wrap((req, res) => {
    const b = req.body || {};
    if (b.habilitado === false) return ok(res, { ...acceso.deshabilitar(req.params.id), acceso: acceso.estado(req.params.id) });
    const r = acceso.habilitar(req.params.id, { usuario: b.usuario, clave: b.clave });
    if (!r.ok) return err(res, 400, r.error);
    // La clave viaja UNA vez en esta respuesta. La pantalla la muestra y avisa que no vuelve.
    ok(res, { ...r, acceso: acceso.estado(req.params.id) });
  }));

  /* ── LOS ACCESOS DE TODOS, EN UNA PANTALLA ──────────────────────────────────────────────────
     Darle acceso a 45 clientes de a uno —abrir la ficha, buscar el botón, copiar la clave, cerrar—
     son 45 idas y vueltas, y en el medio se pierde la cuenta de quién ya tiene y quién no. Acá
     salen todos juntos con lo que puede hacer cada uno, y las acciones valen para los que marques. */
  /* Subir un logo propio. Tope chico a propósito: es un logo, no una foto — y viaja en cada
     pantalla que lo muestre. */
  app.get('/api/os/logo', (_req, res) => ok(res, { propio: !!configStore.getCfg('logoPng') }));
  app.put('/api/os/logo', wrap((req, res) => {
    const b = req.body || {};
    if (b.quitar === true) { configStore.setCfg('logoPng', ''); return ok(res, { propio: false }); }
    const d = String(b.dataUri || '');
    const m = /^data:(image\/(png|jpeg|jpg|webp|svg\+xml));base64,(.+)$/.exec(d);
    if (!m) return err(res, 400, 'Tiene que ser una imagen PNG, JPG, WEBP o SVG.');
    const bytes = Math.floor((m[3].length * 3) / 4);
    if (bytes > 400 * 1024) return err(res, 400, `Ese archivo pesa ${Math.round(bytes / 1024)} KB. El logo tiene que pesar menos de 400 KB: se carga en cada pantalla.`);
    configStore.setCfg('logoPng', d);
    ok(res, { propio: true, bytes });
  }));

  app.get('/api/os/accesos', (_req, res) => {
    const conChat = new Set(chat.list().filter((p) => p.activo && p.cliente_id).map((p) => p.cliente_id));
    const filas = clientes.list().clientes.map((c) => {
      const e = acceso.estado(c.id) || {};
      return {
        id: c.id, codigo: c.codigo, nombre: c.nombre || c.nombreVisible || c.codigo,
        estado: c.estado || 'activo',
        entra: e.habilitado ? (e.usuario || c.codigo) : null,
        acceso: !!e.habilitado, desde: e.desde || null,
        // Lo que puede hacer hoy. `avisa_pagos` viene en true cuando nunca se tocó.
        avisa_pagos: c.avisa_pagos !== false,
        mover_balance: !!c.mover_balance,
        chat: conChat.has(c.id),
      };
    });
    ok(res, { clientes: filas });
  });

  /* Dar acceso a varios de una. La clave viaja UNA vez en esta respuesta: se guarda cifrada y no se
     puede volver a mostrar, así que la pantalla la muestra y avisa que no vuelve. */
  app.post('/api/os/accesos/generar', wrap((req, res) => {
    const ids = Array.isArray((req.body || {}).ids) ? req.body.ids : [];
    if (!ids.length) return err(res, 400, 'no marcaste ningún cliente');
    const hechos = []; const fallaron = [];
    for (const id of ids) {
      // Sin usuario: `habilitar` conserva el que ya tenía. Mandarle el código acá le cambiaría el
      // nombre con el que entra a todo el que tuviera uno propio.
      const r = acceso.habilitar(id, {});
      const c = clientes.get(id) || {};
      if (r.ok) hechos.push({ id, cliente: c.nombre || c.codigo, usuario: r.usuario, clave: r.clave });
      else fallaron.push({ id, cliente: c.nombre || c.codigo || id, error: r.error });
    }
    ok(res, { generadas: hechos.length, claves: hechos, fallaron });
  }));

  app.post('/api/os/accesos/quitar', wrap((req, res) => {
    const ids = Array.isArray((req.body || {}).ids) ? req.body.ids : [];
    ids.forEach((id) => acceso.deshabilitar(id));
    ok(res, { quitados: ids.length });
  }));

  /* Qué puede hacer cada uno, para varios a la vez. Sólo estos dos campos: son permisos, y el resto
     de la ficha del cliente son números que no se tocan en masa. */
  app.post('/api/os/accesos/permiso', wrap((req, res) => {
    const b = req.body || {};
    const ids = Array.isArray(b.ids) ? b.ids : [];
    if (!['avisa_pagos', 'mover_balance'].includes(b.campo)) return err(res, 400, 'ese permiso no se toca desde acá');
    const valor = b.valor === true;
    for (const id of ids) {
      const c = clientes.get(id);
      // updateCliente sólo toca código y nombre: los permisos viven en updateComercial. Pasarlos
      // por la otra función los descartaba en silencio y la pantalla mostraba un cambio que no fue.
      if (c) clientes.updateComercial(id, { [b.campo]: valor });
    }
    ok(res, { cambiados: ids.length, campo: b.campo, valor });
  }));

  app.put('/api/os/accesos/:id/usuario', wrap((req, res) => {
    const u = String((req.body || {}).usuario || '').trim();
    if (!u) return err(res, 400, 'falta el usuario');
    /* Cambiar el usuario le cambia la puerta: la clave que tenía sigue valiendo, pero el nombre con
       el que entra es otro. Se avisa en la pantalla porque hay que volver a decírselo. */
    const r = acceso.habilitar(req.params.id, { usuario: u, clave: (req.body || {}).clave });
    r.ok ? ok(res, r) : err(res, 400, r.error);
  }));

  app.put('/api/os/clientes/:id/comercial', wrap((req, res) => {
    const antes = clientes.get(req.params.id);
    if ((req.body || {}).moneda_cuenta !== undefined) {
      const mal = puedeCambiarMoneda(req.params.id, req.body.moneda_cuenta);
      if (mal) return err(res, 400, mal);
    }
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
    // ── DE QUÉ ESTÁ HECHA ESA DEUDA ────────────────────────────────────────────────────────
    // El saldo solo no sirve para hablar con el cliente: cuando pregunta "¿por qué debo esto?" hay
    // que poder abrir el renglón. Son los MISMOS movimientos que ve él en su pantalla, con lo que
    // acá hace falta y allá no: la nota, el tipo de cambio y las dos monedas.
    // Vienen valuados del store, así que un pago que espera el TC del mes ya figura con su valor.
    const cuentaMovs = movs.list({ cliente_id: c.id }).slice(0, 100).map((m) => ({
      id: m.id, fecha: String(m.fecha || '').slice(0, 10), tipo: m.tipo,
      monto_ars: m.monto_ars, monto_usdt: m.monto_usdt,
      tc: m.tc_momento || m.tc_usado || null, tc_pendiente: m.tc_modo === 'mes' && !!m.provisional,
      divisa: m.divisa, notas: m.notas || '', medio: m.medio || null,
    }));
    ok(res, {
      cliente: { id: c.id, codigo: c.codigo, nombre: c.nombre || c.nombreVisible, estado: c.estado, paneles: cPaneles.length },
      base_actual: baseActual, deuda, historial_pct: histPct, auditoria_pct: auditPct, meses: filas, plataformas,
      movimientos: cuentaMovs,
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
  // `clienteDestino` deja mandar la caja a OTRO cliente que el dueño del panel. Pasa de verdad:
  // un panel figura a nombre del vendedor pero las fichas las pide el cliente final, o al revés.
  // Por defecto va al dueño del panel, que es lo que corresponde casi siempre.
  const _espejarCaja = (p, clienteDestino) => {
    if (!p || !p.id_usuario) return false;
    const destino = clienteDestino || p.cliente_id;
    if (!destino) return false;
    const c = clientes.get(destino); if (!c) return false;
    if ((c.cajas || []).some((k) => String(k.userId) === String(p.id_usuario) && (k.sistema || '') === (p.sistema || ''))) return false;
    clientes.addCaja(destino, { usuario: p.usuario || p.nombre, sistema: p.sistema, userId: p.id_usuario, divisas: p.divisas, montosRapidos: [], grupoId: '' });
    return true;
  };
  /* ── UN PANEL NUEVO SE RESUELVE SOLO ─────────────────────────────────────────────────────────
     El nivel con el que nace un panel es una ELECCIÓN: en el alta manual sale del desplegable, y al
     aprobar una caja está escrito fijo como 'SuperAgente'. La cascada de carga le cree, y un panel
     marcado SuperAgente carga DIRECTO, sin pasar por sus padres. Si en realidad es un Agente, la
     carga falla — el padre real no tiene saldo — y desde la pantalla no hay forma de darse cuenta:
     el nivel se ve escrito como cualquier otro dato.
     Pasó con GanamosM01: caja creada el 21 de agosto, marcada SuperAgente, siendo Agente. Era el
     único de los 204 paneles sin resolver.

     Va en segundo plano y no bloquea la respuesta: baja el árbol entero de esa conexión (el casino
     no devuelve el padre de un nodo) y tarda cerca de un minuto. Si falla, el panel queda "sin
     resolver" y la pantalla lo muestra así, con su botón para reintentar. */
  function _resolverJerarquia(panel) {
    if (!panel || !panel.id || !panel.id_usuario) return;
    arbolSvc.sincronizar({ soloPanel: panel.id })
      .then((r) => {
        const c = (r && r.nivelCorregido || [])[0];
        console.log(`[Árbol] ${panel.nombre}: ` + (!r || !r.ok ? 'no se pudo resolver — ' + ((r && r.error) || '')
          : (c ? `era ${c.de} y es ${c.a}` : 'el nivel ya era el correcto')));
      })
      .catch((e) => console.warn('[Árbol] no se pudo resolver', panel.nombre, e.message));
  }

  app.post('/api/os/paneles', wrap((req, res) => {
    const panel = paneles.create(req.body || {});
    _espejarCaja(panel);
    _resolverJerarquia(panel);
    ok(res, { panel });
  }));
  app.put('/api/os/paneles/:id', wrap((req, res) => {
    const p = paneles.update(req.params.id, req.body || {}); if (!p) return err(res, 404, 'no encontrado'); _espejarCaja(p); ok(res, { panel: p });
  }));
  // Qué monedas MUEVE cada panel de verdad, contra las que tiene guardadas.
  app.get('/api/os/paneles/divisas', (req, res) => {
    const filas = paneles.divisasUsadas(Number(req.query.meses) || 6);
    ok(res, {
      paneles: filas,
      conSobrante: filas.filter((f) => f.sobran.length).length,
      conFaltante: filas.filter((f) => f.faltan.length).length,
      sinDatos: filas.filter((f) => f.sinDatos).length,
    });
  });
  /**
   * ── EL CRUCE DE VERDAD: LO QUE EL CASINO TIENE HABILITADO ─────────────────────────────────────
   *
   * /paneles/divisas compara lo guardado contra lo que el panel MOVIÓ. Eso sólo detecta las que
   * sobran, y de las que faltan no sabe nada. Este cruce trae la tercera lista —la que el casino
   * tiene HABILITADA— leyendo la pantalla de divisas de cada nodo. Con las tres se puede decir:
   *
   *   habilitada + movida + guardada  → está bien
   *   habilitada + movida + NO guardada → FALTA, y es la peor: mueve plata y el OS no la lista
   *   habilitada + no movida + guardada → sobra, se puede sacar
   *   NO habilitada + guardada          → sobra seguro, el casino ni siquiera la acepta
   *
   * Va TROCEADO (desde/limite) porque es un pedido HTTP por panel y son 200: de una sola vez se
   * come los 5 minutos que aguanta el proxy de Railway y se corta a la mitad sin decir dónde quedó.
   *
   * SÓLO LEE. La pantalla que consulta también guarda —tiene un form por divisa con los proveedores
   * y su botón Guardar—, así que divisasDeNodo hace GET y nada más. Ver el comentario allá.
   */
  app.post('/api/os/paneles/divisas/casino', wrap(async (req, res) => {
    const b = req.body || {};
    const desde = Number(b.desde) || 0;
    const limite = Number(b.limite) || 25;
    let lista = paneles.list().filter((p) => p.conexion_id && p.id_usuario);
    if (b.conexion_id) lista = lista.filter((p) => p.conexion_id === b.conexion_id);
    if (b.panel_id) lista = lista.filter((p) => p.id === b.panel_id);
    lista.sort((a, z) => String(a.nombre || '').localeCompare(String(z.nombre || ''), 'es', { sensitivity: 'base' }));
    const total = lista.length;
    const tanda = lista.slice(desde, desde + limite);
    const usadasPorPanel = {};
    paneles.divisasUsadas(Number(b.meses) || 6).forEach((x) => { usadasPorPanel[x.panel_id] = x.usadas || []; });

    const porConexion = {};
    const filas = [];
    for (const p of tanda) {
      // client() elige el módulo según el motor. Una conexión de TBS devuelve el cliente de TBS,
      // que no tiene esta pantalla — de ahí el chequeo de la función y no sólo del cliente.
      if (porConexion[p.conexion_id] === undefined) porConexion[p.conexion_id] = casinoConex.client(p.conexion_id);
      const cli = porConexion[p.conexion_id];
      if (!cli) { filas.push({ panel_id: p.id, nombre: p.nombre, error: 'sin conexión configurada' }); continue; }
      if (typeof cli.divisasDeNodo !== 'function') {
        filas.push({ panel_id: p.id, nombre: p.nombre, error: 'esa conexión no es del motor Imperia' }); continue;
      }
      const r = await cli.divisasDeNodo(p.id_usuario);
      if (!r.ok) { filas.push({ panel_id: p.id, nombre: p.nombre, error: r.error, pista: r.pista || null }); continue; }
      const guardadas = (p.divisas || []).map((x) => String(x).toUpperCase());
      const usadas = usadasPorPanel[p.id] || [];

      // ── REGLA DEL DUEÑO: SÓLO UN SUPERAGENTE PUEDE TENER VARIAS DIVISAS ────────────────────
      // Un distribuidor tiene una y nada más. Al leer los 201 paneles la regla se cumplió sola
      // —los 65 distribuidores trajeron exactamente 1—, así que acá no corrige nada: vigila.
      // Si algún día un distribuidor vuelve con dos, el que está mal es alguno de los dos lados,
      // y escribirlo callado taparía justo eso. Se avisa y no se toca.
      const esSuper = /superagente/i.test(String(p.nivel_usuario || ''));
      const rompeRegla = !esSuper && r.divisas.length > 1;

      let aplicado = null;
      if (b.aplicar && !rompeRegla && r.divisas.length
          && r.divisas.join(',') !== guardadas.slice().sort().join(',')) {
        paneles.update(p.id, { divisas: r.divisas });
        aplicado = { antes: guardadas, ahora: r.divisas };
      }
      filas.push({
        aplicado, rompeRegla, nivel: p.nivel_usuario || '',
        panel_id: p.id, nombre: p.nombre, nodo: p.id_usuario,
        habilitadas: r.divisas, guardadas, usadas,
        // faltan primero: es lo único de acá que puede estar costando plata
        faltan: r.divisas.filter((d) => !guardadas.includes(d)),
        faltanYMueven: r.divisas.filter((d) => !guardadas.includes(d) && usadas.includes(d)),
        sobran: guardadas.filter((d) => !r.divisas.includes(d)),
        sinUsar: guardadas.filter((d) => r.divisas.includes(d) && usadas.length && !usadas.includes(d)),
      });
    }
    ok(res, { total, desde, devueltos: tanda.length, hay_mas: desde + tanda.length < total, paneles: filas });
  }));

  /**
   * ── LOS SUPERAGENTES, PARA ELEGIR DE CUÁLES SE SACAN LOS DISTRIBUIDORES ───────────────────────
   *
   * De los distribuidores el dueño necesita muy pocos, pero la Foto los sacaba todos. Acá se lista
   * cada superagente con los distribuidores que le cuelgan, para marcar de a grupos en vez de
   * panel por panel.
   *
   * El vínculo sale de `sa_id`/`padre_id`, que los resuelve arbol.service contra el árbol del
   * casino. 2 de los 68 no cuelgan de ningún superagente cargado en el OS: van aparte y NO se
   * esconden — si quedaran fuera de la lista no habría forma de marcarlos, y "no lo veo" se
   * volvería "no lo saco" sin que nadie lo haya decidido.
   */
  app.get('/api/os/paneles/foto-distribuidores', (_req, res) => {
    const todos = paneles.list();
    const porNodo = new Map();
    todos.forEach((p) => { if (p.id_usuario) porNodo.set(String(p.id_usuario), p); });
    const esSuper = (p) => /superagente/i.test(String(p.nivel_usuario || ''));
    const hijosDe = new Map();
    const sueltos = [];
    todos.filter((p) => !esSuper(p) && p.id_usuario).forEach((p) => {
      const sa = porNodo.get(String(p.sa_id || '')) || porNodo.get(String(p.padre_id || ''));
      if (sa && sa.id !== p.id) {
        if (!hijosDe.has(sa.id)) hijosDe.set(sa.id, []);
        hijosDe.get(sa.id).push({ id: p.id, nombre: p.nombre, nivel: p.nivel_usuario, en_foto: p.en_foto !== false });
      } else sueltos.push({ id: p.id, nombre: p.nombre, nivel: p.nivel_usuario, en_foto: p.en_foto !== false,
        conexion_id: p.conexion_id });
    });
    const conexiones = casinoConex.list463().map((cx) => ({
      id: cx.id, nombre: cx.nombre,
      superagentes: todos.filter((p) => esSuper(p) && p.conexion_id === cx.id && p.id_usuario)
        .map((p) => ({ id: p.id, nombre: p.nombre, nodo: p.id_usuario, en_foto: p.en_foto !== false,
          hijos: (hijosDe.get(p.id) || []).sort((a, b) => a.nombre.localeCompare(b.nombre, 'es', { sensitivity: 'base' })) }))
        .sort((a, b) => a.nombre.localeCompare(b.nombre, 'es', { sensitivity: 'base' })),
      sueltos: sueltos.filter((x) => x.conexion_id === cx.id),
    }));
    ok(res, { conexiones });
  });

  /** Marca o desmarca de una todos los distribuidores que cuelgan de un superagente. */
  app.post('/api/os/paneles/foto-distribuidores', wrap((req, res) => {
    const b = req.body || {};
    const ids = Array.isArray(b.panel_ids) ? b.panel_ids : (b.panel_id ? [b.panel_id] : []);
    const val = !!b.en_foto;
    const hechos = ids.filter((id) => paneles.get(id)).map((id) => {
      paneles.update(id, { en_foto: val });
      return paneles.get(id).nombre;
    });
    ok(res, { cambiados: hechos.length, paneles: hechos, en_foto: val });
  }));

  /**
   * ── LOS PANELES QUE NADIE PUEDE PEDIR ────────────────────────────────────────────────────────
   *
   * Un panel del OS y una caja del operativo son la MISMA cuenta del casino guardada dos veces: las
   * dos tienen usuario, sistema y id de nodo. La diferencia es para qué se usan — el panel factura,
   * la caja recibe fichas — y por eso están separadas.
   *
   * El problema es que se desincronizan sin avisar: hoy hay 68 paneles sin caja, o sea 68 cuentas
   * a las que ningún cliente puede pedirle fichas aunque el OS las tenga cargadas y facturadas.
   * Los vendedores son los peores: Carlos tiene 11 paneles y 2 cajas.
   *
   * Desde hace un tiempo crear o editar un panel ESPEJA la caja solo (_espejarCaja). Los 68 que
   * faltan son de antes de eso, o entraron por la importación, que no pasa por ahí. Esto es el
   * repaso hacia atrás.
   *
   * Listar sólo INFORMA. Crear la caja es decidir que a esa cuenta se le pueden mandar fichas, y eso
   * no lo adivina un endpoint: se pide panel por panel.
   */
  app.get('/api/os/cajas-faltantes', (_req, res) => {
    const todosPan = paneles.list().filter((p) => p.id_usuario);
    const out = [];
    clientes.list().clientes.forEach((c) => {
      const mios = todosPan.filter((p) => p.cliente_id === c.id);
      if (!mios.length) return;
      // MISMA identidad que usa _espejarCaja: nodo + sistema. Comparar sólo por nodo daría por
      // cubierto un panel de Europa porque existe una caja con ese mismo id en Casino.
      const clave = (sis, uid) => `${sis || ''}|${uid}`;
      const conCaja = new Set((c.cajas || []).map((k) => clave(k.sistema, String(k.userId))));
      const faltan = mios.filter((p) => !conCaja.has(clave(p.sistema, String(p.id_usuario))));
      const nodos = new Set(mios.map((p) => clave(p.sistema, String(p.id_usuario))));
      const huerfanas = (c.cajas || []).filter((k) => !nodos.has(clave(k.sistema, String(k.userId))));
      if (faltan.length || huerfanas.length) {
        out.push({ cliente_id: c.id, cliente: c.nombre, es_vendedor: !!c.es_vendedor,
          faltan: faltan.map((p) => ({ panel_id: p.id, nombre: p.nombre, sistema: p.sistema,
            userId: String(p.id_usuario), divisas: p.divisas || [] })),
          huerfanas: huerfanas.map((k) => ({ id: k.id, usuario: k.usuario, sistema: k.sistema, userId: k.userId })) });
      }
    });
    out.sort((a, b) => b.faltan.length - a.faltan.length);
    ok(res, { clientes: out,
      totalFaltan: out.reduce((a, x) => a + x.faltan.length, 0),
      totalHuerfanas: out.reduce((a, x) => a + x.huerfanas.length, 0) });
  });

  /** Crea las cajas que falten. Se pide panel por panel: crear todas de una es una decisión grande. */
  app.post('/api/os/cajas-faltantes', wrap((req, res) => {
    // Se acepta [{panel_id, cliente_id}] o la forma corta [id]: el destino por defecto es el dueño.
    const crudo = (req.body && (req.body.crear || req.body.panel_ids)) || [];
    const items = (Array.isArray(crudo) ? crudo : []).map((x) => (typeof x === 'string'
      ? { panel_id: x, cliente_id: null } : { panel_id: x.panel_id, cliente_id: x.cliente_id || null }));
    if (!items.length) return err(res, 400, 'no viene ningún panel');
    const hechas = []; const saltadas = [];
    items.forEach(({ panel_id: pid, cliente_id: destinoId }) => {
      const p = paneles.get(pid);
      if (!p || !p.id_usuario) { saltadas.push({ panel_id: pid, motivo: 'no existe o no está linkeado' }); return; }
      const c = clientes.get(destinoId || p.cliente_id);
      if (!c) { saltadas.push({ panel_id: pid, motivo: 'el cliente destino no existe' }); return; }
      // Se reusa _espejarCaja, la misma que corre al crear o editar un panel: es idempotente por
      // (nodo, sistema). Escribir la caja acá a mano abriría la puerta a que las dos formas de
      // crearla queden distintas — y una caja mal armada manda fichas al lugar equivocado.
      if (!_espejarCaja(p, c.id)) { saltadas.push({ panel_id: pid, motivo: 'ya tiene caja' }); return; }
      hechas.push({ cliente: c.nombre, caja: p.nombre, sistema: p.sistema, userId: String(p.id_usuario),
        aOtroCliente: c.id !== p.cliente_id });
    });
    ok(res, { creadas: hechas.length, hechas, saltadas });
  }));

  /**
   * ── TRAER LOS PEDIDOS DEL SISTEMA EN LÍNEA ───────────────────────────────────────────────────
   *
   * Para mudar app.latamgames.online acá sin perder nada. Se le pasa el array de pedidos que
   * devuelve /api/_backup del otro lado y los mete acá.
   *
   * ⚠️ NO USAR /api/_restore PARA ESTO. Ese endpoint pisa clientes y sistemas enteros: se llevaría
   * puesto todo el trabajo del OS y de TBS. Acá sólo entran pedidos.
   *
   * ⚠️ Y NO MANDES EL BACKUP COMPLETO A NINGÚN LADO: incluye las contraseñas del casino EN CLARO.
   * De todo ese dump acá sólo hace falta `pedidos`.
   *
   * ── CÓMO SE ENGANCHA CADA PEDIDO ─────────────────────────────────────────────────────────────
   *
   * Los dos padrones NO comparten códigos: allá un pedido viene con "M526" y acá el cliente se
   * llama "Marcelo". Por eso se busca en este orden:
   *   1. el NODO del casino (sistema + userId) — el mismo dato en los dos lados, y el más confiable
   *   2. el mapeo ventas_mapeo, que se armó justamente cruzando por el nodo
   *   3. el código, sólo si coincide exacto
   * Lo que no engancha por ninguna se informa y NO se importa. Un pedido colgado del cliente
   * equivocado le carga fichas a otro.
   */
  app.post('/api/os/importar-pedidos', wrap((req, res) => {
    const entrada = (req.body && (req.body.pedidos || (req.body.dump && req.body.dump.pedidos))) || [];
    const lista = Array.isArray(entrada) ? entrada : (entrada.pedidos || []);
    if (!Array.isArray(lista) || !lista.length) return err(res, 400, 'no vino ningún pedido');
    const soloProbar = req.body.probar !== false && req.body.aplicar !== true;

    const todos = clientes.list().clientes;
    const porNodo = new Map();
    todos.forEach((c) => (c.cajas || []).forEach((k) => {
      porNodo.set(`${(k.sistema || '').toLowerCase()}|${k.userId}`, { cliente: c, caja: k });
    }));
    const porCodigo = new Map(todos.map((c) => [String(c.codigo || '').toUpperCase(), c]));
    const mapeo = new Map(db.prepare('SELECT codigo, cliente_id FROM ventas_mapeo').all()
      .map((r) => [String(r.codigo).toUpperCase(), r.cliente_id]));
    const yaEstan = new Set(pedidosStore.list().map((x) => x.id));

    const enganchados = []; const sinCliente = []; const repetidos = [];
    lista.forEach((p) => {
      if (p.id && yaEstan.has(p.id)) { repetidos.push(p.id); return; }
      const clave = `${String(p.sistema || '').toLowerCase()}|${String(p.userId || '')}`;
      let via = null; let cliente = null; let caja = null;
      const porN = porNodo.get(clave);
      if (porN) { cliente = porN.cliente; caja = porN.caja; via = 'nodo del casino'; }
      if (!cliente && p.codigo && mapeo.has(String(p.codigo).toUpperCase())) {
        cliente = todos.find((c) => c.id === mapeo.get(String(p.codigo).toUpperCase())) || null;
        if (cliente) via = 'mapeo del sistema en línea';
      }
      if (!cliente && p.codigo && porCodigo.has(String(p.codigo).toUpperCase())) {
        cliente = porCodigo.get(String(p.codigo).toUpperCase()); via = 'código igual';
      }
      if (!cliente) {
        sinCliente.push({ id: p.id, codigo: p.codigo, cliente: p.clienteNombre,
          sistema: p.sistema, userId: p.userId, monto: p.monto, estado: p.estado });
        return;
      }
      enganchados.push({ p, cliente, caja, via });
    });

    if (soloProbar) {
      const porEstado = {};
      enganchados.forEach((x) => { porEstado[x.p.estado || '?'] = (porEstado[x.p.estado || '?'] || 0) + 1; });
      const porVia = {};
      enganchados.forEach((x) => { porVia[x.via] = (porVia[x.via] || 0) + 1; });
      return ok(res, { probar: true, entraron: enganchados.length, porEstado, porVia,
        yaEstaban: repetidos.length, sinCliente,
        ejemplos: enganchados.slice(0, 5).map((x) => ({ codigo: x.p.codigo, va_a: x.cliente.nombre,
          caja: x.caja ? x.caja.usuario : '(sin caja: se guarda igual con el nodo)', via: x.via })) });
    }

    // Se conserva el id, el estado y las fechas del original: si se les pusiera uno nuevo, un mes
    // ya cerrado del otro lado volvería a figurar como recién hecho.
    let creados = 0;
    enganchados.forEach(({ p, cliente, caja }) => {
      pedidosStore.importar({ ...p, codigo: cliente.codigo, clienteNombre: cliente.nombreVisible || cliente.nombre,
        cajaId: caja ? caja.id : (p.cajaId || ''), cajaUsuario: caja ? caja.usuario : p.cajaUsuario });
      creados += 1;
    });
    ok(res, { importados: creados, yaEstaban: repetidos.length, sinCliente });
  }));

  /**
   * ── SOLICITUDES PARA ABRIR UNA CAJA ──────────────────────────────────────────────────────────
   * Las crea quien despacha; las aprueba el dueño. Ver src/solicitudes-caja.js para el porqué.
   */
  app.get('/api/os/solicitudes-caja', (req, res) => {
    const filas = solicitudes.list(req.query.estado ? { estado: req.query.estado } : {});
    const porId = {}; clientes.list().clientes.forEach((c) => { porId[c.id] = c; });
    ok(res, { solicitudes: filas.map((s) => ({ ...s, cliente: (porId[s.cliente_id] || {}).nombre || '(borrado)' })),
      pendientes: solicitudes.pendientes() });
  });

  /**
   * Aprobar: se verifica el nodo CONTRA EL CASINO antes de crear nada.
   *
   * Eso hace dos cosas de una: confirma que la cuenta existe —un id mal tipeado se descubre acá y
   * no el día que una carga falla— y trae las divisas que tiene habilitadas, que es mejor que
   * pedírselas a quien llena el formulario.
   *
   * Se crea el PANEL. La caja sale sola por _espejarCaja: crear sólo la caja dejaría una cuenta que
   * recibe fichas y no se le factura a nadie.
   */
  app.post('/api/os/solicitudes-caja/:id/aprobar', wrap(async (req, res) => {
    const s = solicitudes.get(req.params.id);
    if (!s) return err(res, 404, 'no encontré esa solicitud');
    if (s.estado !== 'pendiente') return err(res, 400, `esa solicitud ya está "${s.estado}"`);
    const cli = clientes.get(s.cliente_id);
    if (!cli) return err(res, 400, 'el cliente de la solicitud ya no existe');

    // ¿ese nodo ya está en el OS? Dos paneles al mismo nodo se facturarían dos veces.
    const repe = paneles.list().find((p) => String(p.id_usuario) === String(s.nodo)
      && String(p.sistema || '').toLowerCase() === String(s.sistema).toLowerCase());
    if (repe) {
      solicitudes.resolver(s.id, { estado: 'rechazada', motivo: `el nodo ya es el panel "${repe.nombre}"` });
      return err(res, 400, `Ese nodo ya está cargado como el panel "${repe.nombre}".`);
    }

    // la conexión de LECTURA de ese sistema: es la que sabe qué divisas tiene el nodo
    const cx = casinoConex.list463().find((c) => String(c.nombre).toLowerCase() === String(s.sistema).toLowerCase());
    let divisas = [];
    let aviso = null;
    if (cx) {
      const cli463 = casinoConex.client(cx.id);
      const r = cli463 && cli463.divisasDeNodo ? await cli463.divisasDeNodo(s.nodo) : { ok: false, error: 'la conexión no responde' };
      if (r.ok) divisas = r.divisas;
      else if (!req.body || !req.body.igual) {
        // No se crea a ciegas: si el casino no confirma el nodo, puede no existir. Se puede forzar
        // con `igual: true`, pero que sea una decisión y no un descuido.
        return err(res, 400, `El casino no confirmó el nodo ${s.nodo}: ${r.error}. `
          + 'Revisá el id, o aprobá igual si sabés que está bien.', { requiereForzar: true });
      } else aviso = `no se pudieron leer las divisas (${r.error}); se creó con ARS`;
    } else aviso = `no hay una conexión llamada "${s.sistema}" para verificar; se creó con ARS`;

    /* 'SuperAgente' es sólo el valor con el que NACE: el de verdad lo resuelve el casino un
       segundo después (_resolverJerarquia). Antes se quedaba con éste para siempre, y la carga en
       cascada le creía. */
    const panel = paneles.create({ cliente_id: cli.id, nombre: s.login, sistema: s.sistema,
      nivel_usuario: 'SuperAgente', id_usuario: String(s.nodo),
      divisas: divisas.length ? divisas : ['ARS'], conexion_id: cx ? cx.id : null });
    _espejarCaja(panel);
    _resolverJerarquia(panel);
    solicitudes.resolver(s.id, { estado: 'aprobada', panel_id: panel.id,
      motivo: `panel y caja creados para ${cli.nombre}` });
    ok(res, { panel, divisas, aviso });
  }));

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

  app.post('/api/os/solicitudes-caja/:id/rechazar', wrap((req, res) => {
    const s = solicitudes.get(req.params.id);
    if (!s) return err(res, 404, 'no encontré esa solicitud');
    if (s.estado !== 'pendiente') return err(res, 400, `esa solicitud ya está "${s.estado}"`);
    ok(res, { solicitud: solicitudes.resolver(s.id, { estado: 'rechazada',
      motivo: String((req.body || {}).motivo || '').trim() || 'sin motivo' }) });
  }));

  // Dejar en un panel SOLO las monedas que usa. Es una decisión, así que se pide explícita.
  app.post('/api/os/paneles/divisas/ajustar', wrap((req, res) => {
    const b = req.body || {};
    const filas = paneles.divisasUsadas(Number(b.meses) || 6)
      .filter((f) => (b.panel_id ? f.panel_id === b.panel_id : f.sobran.length) && f.usadas.length);
    const hechos = filas.map((f) => {
      paneles.update(f.panel_id, { divisas: f.usadas });
      return { panel: f.nombre, antes: f.guardadas, ahora: f.usadas };
    });
    ok(res, { ajustados: hechos.length, hechos });
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
  app.get('/api/os/comprobantes', (req, res) => {
    // ── LO DECLARADO Y LO ACREDITADO SON DOS NÚMEROS ─────────────────────────────────────────
    // El cliente escribe un monto y el comprobante puede decir otro: declara 300.000 y transfirió
    // 205.000. Se acredita lo del comprobante, y eso quedaba guardado en el movimiento — o sea,
    // registrado pero invisible: la tarjeta mostraba lo DECLARADO y un id de movimiento, así que
    // para saber qué se cobró de verdad había que ir a buscarlo. Ahora viaja con cada comprobante.
    const lista = comprobantes.list({ estado: req.query.estado, codigo: req.query.codigo })
      .map((c) => {
        if (!c.movimiento_id) return c;
        const m = movs.get(c.movimiento_id);            // ya viene valuado
        if (!m) return c;
        // En la moneda en que PAGÓ, que es la del comprobante: comparar 205.000 contra 300.000 es
        // inmediato; contra "129,84 USDT" hay que hacer una cuenta para ver si coincide.
        const enUsdt = c.via === 'usdt';
        const propio = enUsdt ? m.monto_usdt : m.monto_ars;
        const otro = enUsdt ? m.monto_ars : m.monto_usdt;
        return { ...c,
          acreditado: propio != null && propio !== '' ? String(propio) : null,
          acreditado_moneda: enUsdt ? 'USDT' : 'ARS',
          acreditado_otro: otro != null && otro !== '' ? String(otro) : null,
          acreditado_otro_moneda: enUsdt ? 'ARS' : 'USDT',
          acreditado_tc: m.tc_momento || m.tc_usado || null,
        };
      });
    ok(res, {
      cuentas: comprobantes.cuentas(),
      // La lista de clientes con comprobantes va SIEMPRE completa, filtre o no: es la que llena el
      // desplegable, y si se armara con lo que quedó filtrado no habría forma de volver a otro.
      porCliente: comprobantes.porCliente(),
      comprobantes: lista,
    });
  });
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
    // getByCodigo resuelve también los códigos VIEJOS (codigosAlias): si un cliente se renombró,
    // su comprobante viejo tiene que seguir encontrándolo.
    const cli = clientes.getByCodigo(c.codigo);
    if (!cli) return err(res, 404, `el código ${c.codigo} ya no corresponde a ningún cliente`);

    // ── UN PAGO SE GUARDA CON LAS DOS CARAS Y EL TIPO DE CAMBIO ───────────────────────────────
    //
    // Es como la dueña lo lleva en su planilla, y tiene razón: cada renglón tiene el monto en
    // pesos, el TC al que se recibió, y los dólares. Los tres. Guardar uno solo obliga a
    // reconstruir los otros dos después, y no se puede — el TC de un pago NO es el del día:
    //     "si alguien sube comprobante en ARS yo debo poner a qué cambio manual recibí ese dinero
    //      en USDT porque no es exacto al tipo de cambio del momento"
    // Ese TC es un dato del acuerdo con quien cambió la plata, no una cotización. Si no se guarda
    // en el momento, se pierde.
    //
    // `moneda` es la de la CUENTA: la que resta la deuda. La otra cara queda igual de guardada, y
    // por eso la misma fila sirve para mirar el saldo en pesos o en dólares sin recalcular nada.
    const moneda = cli.moneda_cuenta === 'ARS' ? 'ARS' : 'USDT';

    // ── EL TC PUEDE QUEDAR PENDIENTE DEL CIERRE ──────────────────────────────────────────────
    // Hay clientes que pagan en pesos todo el mes y el cambio recién se acuerda al cerrarlo. Con
    // `tc_modo: 'mes'` se acredita lo que SÍ se sabe —los pesos que entraron— y la otra cara se
    // deriva del TC del mes cada vez que se lee (ver src/valuacion.js): el día que se carga el TC
    // del cierre, estos pagos pasan a valer lo correcto solos.
    //
    // Sin esto había que elegir entre inventar un TC —y guardar un número que no es el real— o no
    // aprobar el pago, dejando al cliente como deudor de algo que ya pagó.
    const porElMes = b.tc_modo === 'mes';
    // Con TC del mes se carga la moneda en que PAGÓ, no la de la cuenta: es el único monto que se
    // conoce de verdad. Si la cuenta ya se lleva en esa moneda, no hay nada pendiente que derivar.
    const monedaCargada = porElMes ? (c.via === 'usdt' ? 'USDT' : 'ARS') : moneda;
    // La pantalla manda en qué moneda cree que está el monto y acá se compara. Si alguna vez las
    // dos puntas dejan de coincidir, esto lo frena; sin esta comprobación, un número en pesos
    // entraría como dólares —1.476.000 en vez de 1.000— y nadie se enteraría hasta el cierre.
    if (b.moneda && String(b.moneda).toUpperCase() !== monedaCargada) {
      return err(res, 400, `la pantalla dice ${b.moneda} y el pago está en ${monedaCargada} — recargá la página`);
    }
    // Entiende coma y punto igual que la pantalla: quien aprueba escribe "94,22" y eso tiene que
    // valer. Y si escribe "94.22" se lee como 94,22, no como 9422 — el error de los 100×.
    const montoNum = parseMonto(b.monto != null ? b.monto : b.monto_usdt);
    const monto = montoNum == null ? null : String(montoNum);
    if (!money.isPos(monto)) return err(res, 400, `poné cuántos ${monedaCargada} se acreditan`);
    // El TC lo pone quien aprueba. Sin él sólo se guarda la cara que se declaró: es preferible un
    // dato faltante y visible a un número inventado con la cotización del día.
    const tcNum = !porElMes && b.tc != null && String(b.tc).trim() !== '' ? parseMonto(b.tc) : null;
    const tc = tcNum == null ? null : String(tcNum);
    if (tc != null && !money.isPos(tc)) return err(res, 400, 'el tipo de cambio tiene que ser mayor a cero');
    let enArs = null; let enUsdt = null;
    if (monedaCargada === 'ARS') { enArs = monto; if (tc) enUsdt = money.round(money.div(monto, tc), 2); }
    else { enUsdt = monto; if (tc) enArs = money.round(money.mul(monto, tc), 2); }
    const mov = movs.create({ cliente_id: cli.id, tipo: 'pago',
      monto_usdt: enUsdt, monto_ars: enArs, tc_momento: tc,
      // Sólo si de verdad queda algo pendiente: si pagó en la misma moneda en que se lleva su
      // cuenta, el importe que suma ya está y no depende de ningún tipo de cambio.
      tc_modo: (porElMes && monedaCargada !== moneda) ? 'mes' : null,
      divisa: moneda, fecha: b.fecha, medio: c.via === 'usdt' ? 'usdt' : 'cvu',
      notas: `comprobante ${c.id}${b.motivo ? ' · ' + b.motivo : ''}` });
    const montoUsdt = enUsdt;
    const r = comprobantes.resolver(req.params.id, { estado: 'aprobado', por: 'panel', motivo: b.motivo, movimiento_id: mov.id });
    if (!r.ok) return err(res, 400, r.error);
    // ── EL AVISO AL GRUPO VA ACÁ, NO AL RECIBIRLO ────────────────────────────────────────────
    // Antes salía cuando el cliente subía el comprobante y decía "queda pendiente": el grupo se
    // enteraba de algo que todavía no había pasado, y después nadie confirmaba si pasó. Ahora sale
    // cuando el pago está ACREDITADO, con la foto adentro y con el monto que se acreditó de verdad
    // —no el que declaró el cliente, que pueden ser dos números distintos.
    // Fire-and-forget: que Telegram no conteste no puede tumbar un pago ya registrado.
    const avisar = req.app.get('avisarComprobante');
    if (typeof avisar === 'function') {
      Promise.resolve(avisar(comprobantes.get(req.params.id), cli, monto, monedaCargada))
        .catch((e) => console.warn('[Comprobante] aviso error:', e.message));
    }
    ok(res, { ...r, movimiento: mov, deuda: deudaSvc.cuentaCorriente(cli.id) });
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
   * La factura de proveedores como hoja, para imprimir o mandar.
   *
   * ⚠️ Va DETRÁS DEL LOGIN, sin token público como la cuenta de un cliente: dice cuánto se le paga
   * a cada proveedor y a qué costo, o sea el margen del negocio.
   */
  app.get('/api/os/pago-proveedores/hoja', wrap(async (req, res) => {
    const r = await pagoProv.reporte({ mes: req.query.mes || mesTZ(), refrescar: req.query.refrescar === '1' });
    res.type('html').send(pagoProvHtml.hoja(r));
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
    /* ⚠️ EL CUARTO ARGUMENTO ES `forzar`, Y ESTABA EN `true` FIJO.
       `setTC` tiene un control que compara contra lo que esa misma moneda venía valiendo y frena
       un salto de más del 50% — está justo para el caso de escribir "1.473" pensando en 1473, que
       es un número válido (uno coma cuatro siete tres) y por eso el control de formato lo deja
       pasar. Ese TC es el divisor de TODO lo que se le paga a los proveedores externos en pesos:
       con 1,473 en vez de 1473, el resultado sale mil veces más grande.
       Con `true` fijo, la única pantalla donde se carga ese número lo salteaba siempre. Ahora
       `forzar` llega de la pantalla, que primero muestra la pregunta. */
    const forzar = !!(req.body || {}).forzar;
    const r = cierreStore.setTC(cierreStore.FILA_PROVEEDOR, mesCierreLbl(req.params.mes), tc_proveedor_ext, forzar);
    // `confirmar` y `anterior` viajan al cliente: sin eso la pantalla no puede preguntar nada.
    if (!r.ok) return err(res, 400, r.error, { confirmar: !!r.confirmar, anterior: r.anterior || null });
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

  /* ── LA COPIA DE SEGURIDAD DE TODA LA BASE ──────────────────────────────────────────────────
     Van bajo /api/os/* a propósito: esa rama es sólo del dueño (auth.js:81 es lista blanca, y el
     operador no la tiene). El archivo trae las contraseñas del casino adentro — ver el comentario
     de backup.service.js. */
  app.get('/api/os/backup/inventario', (_req, res) => ok(res, backup.inventario()));

  app.get('/api/os/backup/archivo', async (_req, res) => {
    let snap;
    try { snap = await backup.snapshot(); }
    // Se responde el error EN TEXTO y no como JSON: esto se abre navegando, no con fetch, así que
    // un JSON de error se bajaría como archivo y parecería una copia.
    catch (e) { return res.status(500).type('text/plain; charset=utf-8')
      .send('No se pudo generar la copia: ' + e.message); }
    res.setHeader('Content-Type', 'application/vnd.sqlite3');
    res.setHeader('Content-Disposition', `attachment; filename="${snap.nombre}"`);
    res.setHeader('Content-Length', snap.bytes);
    res.send(snap.buffer);
    // Después de mandarla: si la descarga se cortó antes, no cuenta como copia hecha.
    res.on('finish', () => { try { backup.registrar(snap); } catch (e) { console.warn('[Backup]', e.message); } });
  });

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
    // ── LA ETIQUETA DICE HASTA CUÁNDO ──────────────────────────────────────────────────────
    // "saldo anterior (deuda previa al sistema)" le habla al que armó el sistema, no al cliente:
    // él no sabe ni le importa cuándo empezamos a usar esto. Lo que necesita saber es de qué
    // período es esa deuda, y con eso ya no pregunta. Sale del mes del propio movimiento, así que
    // se escribe solo y no hay un texto fijo que se quede viejo el mes que viene.
    const hoy = (req.body && req.body.fecha) ? String(req.body.fecha) : new Date().toISOString();
    const [aa, mm] = hoy.slice(0, 7).split('-');
    const etiqueta = `deuda antes de ${mm}/${aa.slice(2)}`;
    const movimiento = movs.create({
      cliente_id: cli.id, tipo: 'ajuste', monto_ars: div === 'ARS' ? monto : null, monto_usdt: montoUsdt,
      tc_momento: tcUsado, divisa: div, notas: etiqueta,
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
      confirmar: !!b.confirmar,
      mes: b.mes || mesTZ(), conexion_id: b.conexion_id,
      desde: Number(b.desde) || 0, limite: Number(b.limite) || 12, refrescar: !!b.refrescar,
    });
    r.ok ? ok(res, r) : err(res, 502, r.error,
      { reintentable: !!r.reintentable, requiereConfirmar: !!r.requiereConfirmar });
  }));

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
  function _sinDatosInternos(html) {
    return !/margen|costo|pct_costo|te cuesta|paga:/i.test(html);
  }

  app.get('/api/os/chat/doc/cliente/:clienteId', (req, res) => {
    const mes = String(req.query.mes || '').slice(0, 7) || mesTZ();
    const doc = _hojaCliente(mes, req.params.clienteId, req.query.divisa);
    if (!doc) return err(res, 404, 'ese cliente no tiene nada en el chat externo ese mes');
    // La vista previa muestra lo MISMO que va a ver el cliente, salvo el formulario: mirar una
    // versión distinta de la que se manda no sirve para revisarla.
    const todo = chat.cuentas(null).clientes.find((x) => x.cliente_id === req.params.clienteId) || null;
    const esteMes = chat.cuentas(mes).clientes.find((x) => x.cliente_id === req.params.clienteId) || null;
    const html = chatDoc.htmlCliente(doc, {
      pago: chat.comoPagar(req.params.clienteId), saldo: todo,
      cobradoMes: esteMes ? esteMes.cobrado : null,
      // Los movimientos del mes, para poder decir DE QUÉ está hecho ese total: el % y el
      // mantenimiento son dos cobros distintos y meterlos en un solo número los confunde.
      movsMes: esteMes ? esteMes.movs : [] });
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
  app.delete('/api/os/chat/movs/:id', wrap((req, res) => ok(res, chat.borrarMov(req.params.id))));

  /* ── LOS AVISOS DE PAGO DEL CLIENTE ─────────────────────────────────────────────────────────
     Suben la captura desde su hoja. No mueven el saldo hasta que se aprueban acá. */
  app.get('/api/os/chat/avisos', (_req, res) => ok(res, { avisos: chat.avisosPendientes() }));
  app.get('/api/os/chat/avisos/:id/archivo', (req, res) => {
    const a = chat.archivoDeAviso(req.params.id);
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
    const r = chat.resolverAviso(req.params.id, (req.body || {}).aprobar === true);
    r.ok ? ok(res, r) : err(res, 400, r.error);
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
  app.get('/api/os/api/oferta-desde-base', (req, res) => {
    const r = ofertas.armarDesdeBase(req.query.base);
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
    const esc = (s) => String(s == null ? '' : s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
    const pct = (x) => String(x).replace(/\.0+$/, '') + '%';
    const lineas = ['<b>Oferta comercial</b>'];
    if (m.titulo) lineas.push(esc(m.titulo));
    lineas.push('', '<i>Porcentaje sobre el GGR de cada proveedor.</i>', '');
    for (const g of m.grupos || []) {
      lineas.push(`<b>${esc(g.nombre)}</b>` + (g.unico ? ` — ${esc(pct(g.unico))}` : ''));
      if (g.unico) {
        lineas.push(esc(ofertas.unicos(g.items.flatMap((i) => i.proveedores)).join(' · ')));
      } else {
        for (const i of g.items.slice().sort((a, b) => a.corto.localeCompare(b.corto, 'es'))) {
          lineas.push(`  ${esc(ofertas.unicos(i.proveedores).join(', '))} — ${esc(pct(i.pct))}`);
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
    let avisoPuente = null;
    const puente = ventasOnline.getConfig();
    // ── SI EL PUENTE FALLA, SE USAN LOS PEDIDOS DE ACÁ ──────────────────────────────────────────
    //
    // El puente traía los pedidos del sistema viejo. Desde la migración los 848 pedidos viven en
    // esta base, y el sistema viejo ya no autentica: devolvía 401 y esta función cortaba con un
    // error, o sea que la facturación mensual ENTERA estaba caída y no se podía emitir nada.
    //
    // No es un fallback silencioso —eso sí podría duplicar— porque las dos fuentes son
    // excluyentes: o los pedidos están allá o están acá. Se usa lo de acá y se dice que el puente
    // falló, para que quede claro de dónde salió el número y para que alguien lo apague.
    if (puente && puente.url) {
      const vo = await ventasOnline.ventasDelMes(mes);
      if (!vo.ok) {
        avisoPuente = `el puente al sistema en línea no contestó (${vo.error}). Se usaron los pedidos `
          + 'de este sistema, que desde la migración son los buenos. Conviene apagar el puente en Config.';
        console.warn('[Facturación] ' + avisoPuente);
      } else {
      ventasCli = vo.porCliente;
      huerfanas = (vo.sinMapeo || []).map((x) => ({ codigo: x.codigo, pedidos: x.count, porDivisa: Object.entries(x.porDivisa).map(([d, m]) => ({ divisa: d, monto: money.round(String(m), 2) })) }));
      origen = 'pedidos del sistema en línea';
      }
    }
    if (!Object.keys(ventasCli).length) {
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
      let vendUsdt = '0', feeUsdt = '0'; const porDivisa = []; const sinTCCliente = [];
      for (const [div, monto] of Object.entries((v && v.porDivisa) || {})) {
        const t = tcUnico.tcDelMes(div, mes);
        const fee = money.pct(String(monto), base);
        /* La lista global `sinTC` dice QUÉ monedas faltan; la del cliente dice A QUIÉN le faltan.
           Sin esa segunda, la emisión no puede saltear al cliente afectado y le emite el total
           recortado — y como emitir es idempotente por cliente+mes, la parte que falta ya no se
           puede agregar salvo anulando el mes entero. */
        if (!t.valor) { sinTC.add(div); sinTCCliente.push(div);
          porDivisa.push({ divisa: div, vendido: String(monto), tc: null }); continue; }
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
        sinTC: sinTCCliente,          // las monedas de ESTE cliente que no se pudieron pasar a USDT
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
      origen, avisoPuente, sinBase: [...sinBase], sinTC: [...sinTC], sinPedidos, enCero, vendedores, huerfanas,
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
  /**
   * Generar hacia atrás la deuda de las cargas de un mes.
   *
   * Se usa una vez, el día que esto se enciende: las cargas ya hechas están en la factura pero no
   * en la cuenta corriente, así que el saldo del cliente arranca incompleto. Cada carga se convierte
   * con el TC de SU día — usar el de hoy le cambiaría el precio a operaciones que ya pasaron.
   *
   * Por defecto SIMULA. Escribir de verdad hay que pedirlo con `aplicar: true`: son movimientos de
   * plata en la cuenta de cada cliente y conviene mirar los números antes.
   */
  app.post('/api/os/deuda/generar-mes', wrap(async (req, res) => {
    const b = req.body || {};
    const mes = String(b.mes || mesTZ()).slice(0, 7);
    const delMes = pedidosStore.list({ estado: 'cargado' })
      .filter((p) => String(p.resueltoAt || p.createdAt || '').slice(0, 7) === mes);
    const r = await deudaCargaSvc.generarMes(mes, delMes, { simular: b.aplicar !== true });
    ok(res, { ...r, simulado: b.aplicar !== true, pedidosDelMes: delMes.length });
  }));

  /**
   * Borrar la deuda generada por cargas de un mes, para poder rehacerla.
   *
   * Se pide con `confirmar: true` porque borra movimientos de la cuenta de los clientes. Sólo toca
   * los que nacieron de una carga: no roza pagos, ajustes ni saldos anteriores.
   */
  app.post('/api/os/deuda/borrar-mes', wrap((req, res) => {
    const b = req.body || {};
    if (b.confirmar !== true) return err(res, 400, 'esto borra movimientos de la cuenta: mandá confirmar:true');
    ok(res, deudaCargaSvc.borrarMes(String(b.mes || mesTZ()).slice(0, 7)));
  }));

  app.post('/api/os/emision/facturacion', wrap(async (req, res) => {
    const mes = String((req.body && req.body.mes) || mesTZ()).slice(0, 7);
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
      if (ya && ya.cargas) {
        conciliado.push({ cliente_id: c.cliente_id, codigo: c.codigo, cargas: ya.cargas,
          enCuenta_usdt: ya.usdt, calculoMes_usdt: c.fee_usdt,
          diferencia: money.round(money.sub(c.fee_usdt, ya.usdt), 2) });
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
    ok(res, { ...r, sinBase: fac.sinBase, sinPedidos: fac.sinPedidos,
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

  /** La URL pública de este servicio, para armar los links que se le mandan al cliente. */
  function _urlPublica(req) {
    const cfg = configStore.getUrlPublica();
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
    // Puede ir al grupo del vendedor si el cliente no tiene el suyo — ver telegram-destino.js.
    const dest = tgDestino.destinoDe(cli, (id) => clientes.get(id));
    const chat = dest.chatId;
    if (!chat) return err(res, 400, `${cli.nombre || cli.codigo} no tiene grupo de Telegram, ni él ni su vendedor (se pone en su ficha, o en la del vendedor para que lo hereden todos)`);
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
