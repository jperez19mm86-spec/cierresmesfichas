/**
 * Venta de Fichas — servidor local (Express).
 *
 * Pantalla 1: gestor de SISTEMAS (páginas de agente).
 *   - Cada sistema = URL de admin + usuario + contraseña + nombre editable.
 *   - Login por usuario/contraseña → sesión (PHPSESSID). NO se usa api_token.
 *   - "+ Agregar sistema", editar, eliminar, elegir sistema activo, probar conexión.
 *
 * Próximas pantallas (a futuro): buscar administradores en el sistema activo + vender fichas.
 *
 * Corre 100% local:  npm install  &&  npm start  →  http://localhost:4600
 */
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const store = require('./systems-store');
const casino = require('./casino-client');
const cascada = require('./carga-cascada.service');
const clientes = require('./clientes-store');
// Los PANELES los usa /api/pedir para ofrecerle al cliente entre cuáles puede mover fichas. Iba sin
// importar y la ruta reventaba con 500 — la ruta por la que TODOS los clientes piden fichas.
const paneles = require('./paneles-store');
const pedidos = require('./pedidos-store');
const config = require('./config-store');
const telegram = require('./telegram');
const tgDestino = require('./telegram-destino');
const sheets = require('./sheets');
const push = require('./push');
const auth = require('./auth');

const PORT = parseInt(process.env.PORT || '4600', 10);

/** Mensaje legible cuando "Probar conexión" falla. */
function failDetail(r) {
  if (!r) return 'sin respuesta';
  const lg = r.login || {};
  if (lg.message || lg.error) return lg.message || lg.error; // error de red / DNS / timeout
  return 'usuario o contraseña incorrectos (no se pudo autenticar)';
}

/**
 * Parsea texto pegado de la planilla (TAB-separado) a filas de cliente/caja.
 * Columnas (en orden): codigo, nombre_visible, usuario, sistema, user_id, divisas, grupo_id, montos_rapidos.
 * - Detecta y saltea una fila de encabezado.
 * - "Fill-down": si codigo/nombre_visible vienen vacíos, hereda el de la fila anterior (la planilla
 *   a veces escribe el código una sola vez por grupo).
 */
function parseImportText(text) {
  const lines = String(text || '').split(/\r?\n/).filter((l) => l.trim() !== '');
  const rows = [];
  let lastCodigo = '';
  let lastNombre = '';
  let start = 0;
  if (lines.length) {
    const low = lines[0].toLowerCase();
    const cells0 = lines[0].split('\t');
    const looksHeader = /nombre_visible|user_id|montos_rapidos|divisas/.test(low) && !/^\d/.test((cells0[4] || '').trim());
    if (looksHeader) start = 1;
  }
  for (let i = start; i < lines.length; i++) {
    const cells = lines[i].split('\t');
    if (cells.length < 2) continue; // no parece una fila tabular
    let codigo = (cells[0] || '').trim();
    let nombreVisible = (cells[1] || '').trim();
    if (!codigo) codigo = lastCodigo; else lastCodigo = codigo;
    if (!nombreVisible) nombreVisible = lastNombre; else lastNombre = nombreVisible;
    rows.push({
      codigo,
      nombreVisible,
      usuario: (cells[2] || '').trim(),
      sistema: (cells[3] || '').trim(),
      userId: (cells[4] || '').trim(),
      divisas: (cells[5] || '').trim(),
      grupoId: (cells[6] || '').trim(),
      montosRapidos: (cells[7] || '').trim(),
    });
  }
  return rows;
}

const app = express();
app.use(cors({ origin: true }));

// ── EL COMPROBANTE VIENE EN EL CUERPO, Y UNA FOTO NO ENTRA EN 1 MB ───────────────────────────
//
// El resto de la API manda números y textos: 1 MB es de sobra y conviene que sea chico. Pero el
// comprobante viaja como data URI dentro del JSON, y base64 infla un tercio: una foto de celular
// de 3 MB llega como 4 MB de texto. Con el tope global, la pantalla decía "el máximo son 6 MB",
// el store aceptaba 6 MB, y Express cortaba en 1 — el cliente veía "Unexpected token", que no le
// dice absolutamente nada, y el pago simplemente no llegaba.
//
// El límite grande vale SÓLO para esta ruta. Se monta antes del parser general: express.json()
// no vuelve a parsear un cuerpo ya leído, así que el de abajo lo deja pasar.
app.use('/api/comprobante', express.json({ limit: '9mb' }));   // 6 MB de archivo + base64 + JSON
app.use(express.json({ limit: '1mb' }));

// Y si aun así se pasa, que lo diga en castellano. Sin esto Express contesta un HTML de error que
// el navegador intenta leer como JSON, y el cliente recibe "Unexpected token <".
app.use((e, req, res, next) => {
  if (e && (e.type === 'entity.too.large' || e.status === 413)) {
    return res.status(413).json({ ok: false,
      error: 'El archivo es demasiado grande. El máximo son 6 MB: sacá la foto con menos calidad '
        + 'o mandá una captura de pantalla en vez de la foto.' });
  }
  return next(e);
});

// ─────────────── LOGIN del panel (usuario + contraseña → cookie) ───────────────
app.post('/api/login', auth.loginHandler);
app.post('/api/logout', auth.logoutHandler);
app.get('/login', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'login.html')));

// GATE: todo lo que sigue requiere sesión, EXCEPTO las rutas públicas
// (vista cliente /pedir + /api/pedir, /login, /api/login, logo). Ver src/auth.js.
app.use(auth.required);

// ─────────────── LATAM Games OS — núcleo comercial/financiero (/api/os/*) ───────────────
// Cómo se resuelve con qué credenciales se carga en un sistema vive acá (una sola vez, ver
// `sistemaParaCargar`). Las rutas del OS lo necesitan para mover fichas, y se lo pasamos por el app
// en vez de importarlo allá: os.routes no tiene por qué saber cómo arranca esta app.
app.set('sistemaParaCargar', sistemaParaCargar);
// El aviso del comprobante lo dispara la aprobación, que vive en os.routes. Se pasa por el app en
// vez de importarlo allá: os.routes no tiene por qué saber cómo arranca esta app.
app.set('avisarComprobante', avisarComprobante);
require('./os.routes').mount(app);

// ─────────────── SISTEMAS (CRUD) ───────────────

// Listar todos + cuál está activo (NUNCA devuelve contraseñas).
app.get('/api/systems', (_req, res) => {
  const data = store.list();
  res.json({ ok: true, activeId: data.activeId, systems: data.systems.map(store.publicView) });
});

// Agregar un sistema.
app.post('/api/systems', (req, res) => {
  const { name, url, user, password } = req.body || {};
  if (!url || !user) return res.status(400).json({ ok: false, error: 'URL y usuario son obligatorios' });
  const sys = store.create({ name, url, user, password });
  console.log(`[VentaFichas] sistema agregado: ${sys.name} (${sys.url})`);
  res.json({ ok: true, system: store.publicView(sys) });
});

// Editar (nombre / url / usuario / contraseña). Contraseña vacía = mantener la actual.
app.put('/api/systems/:id', (req, res) => {
  const s = store.update(req.params.id, req.body || {});
  if (!s) return res.status(404).json({ ok: false, error: 'sistema no encontrado' });
  res.json({ ok: true, system: store.publicView(s) });
});

// Eliminar.
app.delete('/api/systems/:id', (req, res) => {
  const ok = store.remove(req.params.id);
  if (!ok) return res.status(404).json({ ok: false, error: 'sistema no encontrado' });
  res.json({ ok: true });
});

// Elegir el sistema activo (sobre el que se opera).
app.post('/api/systems/:id/activate', (req, res) => {
  const ok = store.setActive(req.params.id);
  if (!ok) return res.status(404).json({ ok: false, error: 'sistema no encontrado' });
  res.json({ ok: true, activeId: req.params.id });
});

// ─────────────── PROBAR CONEXIÓN (login usuario/contraseña → sesión) ───────────────

// Probar un sistema ya guardado (usa su contraseña almacenada).
app.post('/api/systems/:id/test', async (req, res) => {
  const s = store.get(req.params.id);
  if (!s) return res.status(404).json({ ok: false, error: 'sistema no encontrado' });
  if (!s.password) return res.status(400).json({ ok: false, error: 'el sistema no tiene contraseña guardada' });
  try {
    const r = await casino.testConnection(s.url, s.user, s.password);
    store.update(s.id, { lastLoginAt: new Date().toISOString(), lastLoginOk: !!r.ok });
    res.json({
      ok: !!r.ok,
      verified: !!r.verified,
      stage: r.stage,
      status: r.login && r.login.status,
      detail: r.ok ? null : failDetail(r),
    });
  } catch (e) {
    console.error('[VentaFichas] test error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Probar credenciales SIN guardarlas (botón "Probar" del formulario de alta).
app.post('/api/test-credentials', async (req, res) => {
  const { url, user, password } = req.body || {};
  if (!url || !user || !password) return res.status(400).json({ ok: false, error: 'URL, usuario y contraseña requeridos' });
  try {
    const r = await casino.testConnection(url, user, password);
    res.json({
      ok: !!r.ok,
      verified: !!r.verified,
      stage: r.stage,
      status: r.login && r.login.status,
      detail: r.ok ? null : failDetail(r),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ─────────────── CLIENTES + CAJAS ───────────────

/**
 * ── LO QUE VE EL OPERADOR ─────────────────────────────────────────────────────────────────────
 *
 * `/api/clientes` devuelve el cliente ENTERO: margen_externos_pct, ajuste_usdt_pct, tc_proveedor,
 * permite_deuda, la config de Telegram… o sea el negocio. Esconderlo en la pantalla no serviría:
 * el JSON viaja igual y se lee en la consola del navegador.
 *
 * Por eso esta ruta ARMA el objeto campo por campo desde una lista explícita, igual que la cuenta
 * que se le manda a un cliente de TBS. Lo que no está en la lista no existe acá, y si mañana se le
 * agrega un campo al cliente no aparece solo.
 *
 * Sin deuda ni saldos: el dueño decidió que el operador vea el pedido y nada más.
 */
// `vendedor_id` y `es_vendedor` NO son datos comerciales: dicen quién cuelga de quién, no cuánto
// se le cobra. Sin ellos la pantalla no puede armar el árbol y le mostraba al operador los 44
// clientes sueltos, mientras el dueño veía 6 vendedores con su gente adentro. Dos pantallas que
// deberían decir lo mismo mostrando cosas distintas es peor que mostrar de más.
const DESPACHO_CLIENTE = ['id', 'codigo', 'nombreVisible', 'nombre', 'estado', 'divisa_fichas',
  'vendedor_id', 'es_vendedor'];
/**
 * Pedir que se abra una caja. La crea quien despacha; la aprueba el dueño en el OS.
 * No crea nada: una caja es un destino al que se le cargan fichas y define a quién se le factura.
 */
app.post('/api/despacho/solicitud-caja', (req, res) => {
  const r = solicitudesCaja.crear(req.body || {}, auth.rolDe(req) === 'operador' ? 'operador' : 'admin');
  if (!r.ok) return res.status(400).json({ ok: false, error: r.error });
  // Al teléfono, como los pedidos y los comprobantes: sin esto hay que acordarse de ir a mirar.
  const c = clientes.get(r.solicitud.cliente_id) || {};
  push.notifyNuevaSolicitud({ ...r.solicitud, cliente: c.nombre || c.nombreVisible || '' });
  res.json({ ok: true, solicitud: r.solicitud });
});

/** Las solicitudes, para ver en qué quedaron. */
app.get('/api/despacho/solicitudes-caja', (_req, res) => {
  const porId = {}; clientes.list().clientes.forEach((c) => { porId[c.id] = c; });
  res.json({ ok: true, solicitudes: solicitudesCaja.list().map((s) => ({
    id: s.id, cliente: (porId[s.cliente_id] || {}).nombre || '(borrado)', sistema: s.sistema,
    nodo: s.nodo, login: s.login, nota: s.nota, estado: s.estado, motivo: s.motivo,
    creada_at: s.creada_at, resuelta_at: s.resuelta_at })) });
});

app.get('/api/despacho/clientes', (_req, res) => {
  const cs = clientes.list().clientes.map((c) => {
    const o = {};
    DESPACHO_CLIENTE.forEach((k) => { if (c[k] !== undefined) o[k] = c[k]; });
    // las cajas, sólo con lo que hace falta para saber a dónde va la ficha
    o.cajas = (c.cajas || []).map((k) => ({ id: k.id, usuario: k.usuario, sistema: k.sistema,
      userId: k.userId, divisas: k.divisas }));
    return o;
  });
  res.json({ ok: true, clientes: cs });
});

/** Los paneles, sin la URL ni el usuario con el que el OS entra al casino. */
app.get('/api/despacho/sistemas', (_req, res) => {
  const data = store.list();
  res.json({ ok: true, activeId: data.activeId,
    systems: data.systems.map((x) => ({ id: x.id, name: x.name })) });
});

/** Quién soy: la pantalla necesita saber el rol para no ofrecer lo que el server va a rechazar. */
app.get('/api/quien', (req, res) => res.json({ ok: true, rol: auth.rolDe(req) || null }));

app.get('/api/clientes', (_req, res) => {
  res.json({ ok: true, clientes: clientes.list().clientes });
});

const casinoConexStore = require('./casino-conexiones-store');
const solicitudesCaja = require('./solicitudes-caja');
const movPanel = require('./movimientos-panel');
const movPanelSvc = require('./movimientos-panel.service');
const deudaCargaSvc = require('./deuda-carga.service');
const accesoCli = require('./cliente-acceso');
const deudaSvc = require('./deuda.service');
const movsStore = require('./movimientos-store');

/**
 * ── CON QUÉ CREDENCIALES SE CARGA EN UN SISTEMA ───────────────────────────────────────────────
 *
 * Esto estaba copiado en TRES rutas —cargar, la cascada y anular— y al agregar las conexiones del
 * OS arreglé una sola: el pedido se veía, pero la vista previa contestaba "Sistema Casino no
 * configurado" y el botón no servía. Una regla escrita tres veces se corrige una vez y falla en
 * las otras dos.
 *
 * Orden: primero una conexión del OS marcada para cargar en ESE sistema; si no hay, el almacén
 * viejo (Operativo → Sistemas). Son cuentas distintas de las de lectura a propósito —Alexa_support
 * no puede bajar fichas— y por eso hay un henry_support aparte.
 */
function sistemaParaCargar(nombreSistema) {
  const cx = casinoConexStore.paraCargar(nombreSistema);
  if (cx) {
    const conClave = casinoConexStore.get(cx.id, true) || {};
    return { name: cx.nombre, url: cx.url, user: cx.usuario, password: conClave.password, origen: 'OS' };
  }
  const s = store.list().systems.find((x) => String(x.name).toLowerCase() === String(nombreSistema).toLowerCase());
  return s ? { ...s, origen: 'Sistemas' } : null;
}
const clientesCascada = require('./clientes-cascada');
const comprobantes = require('./comprobantes-store');

app.post('/api/clientes', (req, res) => {
  const { codigo, nombreVisible } = req.body || {};
  if (!codigo) return res.status(400).json({ ok: false, error: 'código requerido' });
  try {
    const c = clientesCascada.crear({ codigo, nombreVisible }); // + su columna en la matriz
    res.json({ ok: true, cliente: c });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.put('/api/clientes/:id', (req, res) => {
  try {
    const antes = clientes.get(req.params.id);
    const c = clientes.updateCliente(req.params.id, req.body || {});
    if (!c) return res.status(404).json({ ok: false, error: 'cliente no encontrado' });
    // renombrar SIN esto le hacía perder todos sus % de proveedores, en silencio
    clientesCascada.arrastrarRenombre(antes, c);
    res.json({ ok: true, cliente: c });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.delete('/api/clientes/:id', (req, res) => {
  // baja COMPLETA (paneles, movimientos, participaciones, config y su columna de la matriz):
  // antes esta ruta borraba solo la fila y dejaba la columna huérfana con todos sus % colgando
  const ok = clientesCascada.borrar(req.params.id);
  if (!ok) return res.status(404).json({ ok: false, error: 'cliente no encontrado' });
  res.json({ ok: true });
});

// Cajas (dentro de un cliente)
app.post('/api/clientes/:id/cajas', (req, res) => {
  const k = clientes.addCaja(req.params.id, req.body || {});
  if (!k) return res.status(404).json({ ok: false, error: 'cliente no encontrado' });
  res.json({ ok: true, caja: k });
});

app.put('/api/clientes/:id/cajas/:cajaId', (req, res) => {
  const k = clientes.updateCaja(req.params.id, req.params.cajaId, req.body || {});
  if (!k) return res.status(404).json({ ok: false, error: 'cliente o caja no encontrada' });
  res.json({ ok: true, caja: k });
});

app.delete('/api/clientes/:id/cajas/:cajaId', (req, res) => {
  const ok = clientes.removeCaja(req.params.id, req.params.cajaId);
  if (!ok) return res.status(404).json({ ok: false, error: 'cliente o caja no encontrada' });
  res.json({ ok: true });
});

// Importar lista pegada de la planilla (TAB-separada). dryRun=true → previsualizar sin guardar.
app.post('/api/clientes/import', (req, res) => {
  const { text, dryRun } = req.body || {};
  if (!text || !String(text).trim()) return res.status(400).json({ ok: false, error: 'pegá la lista (texto) primero' });
  const rows = parseImportText(text);
  if (!rows.length) return res.status(400).json({ ok: false, error: 'no se reconocieron filas (¿pegaste desde la planilla con columnas separadas por TAB?)' });
  const summary = clientes.importRows(rows, !!dryRun);
  res.json({ ok: true, dryRun: !!dryRun, summary, sample: rows.slice(0, 3) });
});

// ─────────────── CONFIG GLOBAL + TELEGRAM por cliente ───────────────

app.get('/api/config', (_req, res) => {
  const tok = config.getTelegramToken();
  res.json({ ok: true, telegramConfigured: !!tok, telegramTokenHint: tok ? ('…' + tok.slice(-6)) : '',
    apiGrupoMatriz: config.getApiGrupoMatriz() });
});

app.put('/api/config', (req, res) => {
  const { telegramBotToken, apiGrupoMatriz } = req.body || {};
  if (telegramBotToken !== undefined) config.setTelegramToken(telegramBotToken);
  // El grupo matriz de las cuentas de API: uno solo para todas. Va acá y no en cada cliente porque
  // si viviera copiado en las 16 cuentas, cambiarlo obligaría a acordarse de tocar las 16.
  if (apiGrupoMatriz !== undefined) config.setApiGrupoMatriz(apiGrupoMatriz);
  const tok = config.getTelegramToken();
  res.json({ ok: true, telegramConfigured: !!tok, telegramTokenHint: tok ? ('…' + tok.slice(-6)) : '',
    apiGrupoMatriz: config.getApiGrupoMatriz() });
});

// Configurar el grupo de Telegram de un cliente (aviso automático al cargar).
app.put('/api/clientes/:id/telegram', (req, res) => {
  const c = clientes.setTelegram(req.params.id, req.body || {});
  if (!c) return res.status(404).json({ ok: false, error: 'cliente no encontrado' });
  res.json({ ok: true, telegram: c.telegram });
});

// Mensaje de PRUEBA al grupo del cliente (para verificar bot + chatId).
app.post('/api/clientes/:id/telegram/test', async (req, res) => {
  const c = clientes.get(req.params.id);
  if (!c) return res.status(404).json({ ok: false, error: 'cliente no encontrado' });
  // La prueba tiene que ir al MISMO lugar que va a ir la factura, herencia incluida: si no,
  // probás, te llega, y después la factura se va a otro lado (o a ninguno).
  const dest = tgDestino.destinoDe(c, (id) => clientes.get(id));
  const r = await telegram.sendMessage(
    config.getTelegramToken(),
    dest.chatId,
    `🔔 Prueba de avisos — <b>${c.nombreVisible} (${c.codigo})</b>\nSi ves esto, el grupo quedó bien configurado.\n\n<i>Latam Games</i>`
  );
  res.json(r.ok ? { ok: true } : { ok: false, error: r.error });
});

// ─────────────── PUSH (notificaciones al admin) ───────────────
// El panel (logueado) pide la VAPID public key, se suscribe, y prueba.
app.get('/api/push/vapid-key', (_req, res) => {
  try { res.json({ ok: true, publicKey: push.getPublicKey() }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.post('/api/push/subscribe', (req, res) => {
  const sub = (req.body && req.body.subscription) || req.body;
  if (!sub || !sub.endpoint) return res.status(400).json({ ok: false, error: 'falta la suscripción' });
  push.addSubscription(sub);
  res.json({ ok: true, count: push.count() });
});
app.post('/api/push/unsubscribe', (req, res) => {
  const ep = (req.body && (req.body.endpoint || (req.body.subscription && req.body.subscription.endpoint)));
  if (ep) push.removeSubscription(ep);
  res.json({ ok: true, count: push.count() });
});
app.post('/api/push/test', async (req, res) => {
  const r = await push.sendToAll({ title: '🔔 Prueba — Latam Games', body: 'Las notificaciones están activas ✅', url: '/' });
  res.json({ ok: true, ...r });
});

// Diagnóstico: dónde está la base (para verificar que el VOLUME persistente esté activo).
app.get('/api/_dbinfo', (_req, res) => {
  const { DB_PATH } = require('./db');
  const fs = require('fs');
  let exists = false, sizeBytes = 0;
  try { const st = fs.statSync(DB_PATH); exists = true; sizeBytes = st.size; } catch (e) { /* no existe aún */ }
  res.json({
    ok: true,
    dbPath: DB_PATH,
    onVolume: !!process.env.RAILWAY_VOLUME_MOUNT_PATH,
    volumeMount: process.env.RAILWAY_VOLUME_MOUNT_PATH || null,
    exists, sizeBytes,
  });
});

// ─────────────── BACKUP / RESTORE (resguardo de datos) ───────────────
// Doble seguridad además del VOLUME: el admin puede bajarse TODA la base en un JSON y volver
// a cargarla cuando quiera. Las contraseñas de los sistemas salen EN CLARO (descifradas) para
// que el backup sea portable entre entornos; al restaurar se vuelven a cifrar con la CRED_KEY
// de ESTE entorno. El archivo es sensible (tiene contraseñas) → guardalo en un lugar seguro.
app.get('/api/_backup', (_req, res) => {
  try {
    const dump = {
      version: 1,
      app: 'venta-fichas',
      exportedAt: new Date().toISOString(),
      systems: store.list(),         // { activeId, systems:[... password EN CLARO ...] }
      clientes: clientes.list(),     // { clientes:[...] }
      pedidos: { pedidos: pedidos.list() },
    };
    res.json({ ok: true, dump });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Restaura un dump de /api/_backup. Acepta el dump directo o { dump:{...} }.
// SEGURIDAD: si la base NO está vacía, exige { force:true } para no pisar datos por accidente.
app.post('/api/_restore', (req, res) => {
  try {
    const body = req.body || {};
    const dump = body.dump || body;
    const cur = {
      systems: store.list().systems.length,
      clientes: clientes.list().clientes.length,
      pedidos: pedidos.list().length,
    };
    const noVacia = (cur.systems + cur.clientes + cur.pedidos) > 0;
    if (noVacia && !body.force) {
      return res.status(409).json({ ok: false, error: 'La base NO está vacía; mandá force:true para sobrescribir.', current: cur });
    }
    const applied = {};
    if (dump.systems && Array.isArray(dump.systems.systems)) { store.seed(dump.systems); applied.systems = dump.systems.systems.length; }
    if (dump.clientes && Array.isArray(dump.clientes.clientes)) { clientes.seed(dump.clientes); applied.clientes = dump.clientes.clientes.length; }
    if (dump.pedidos && Array.isArray(dump.pedidos.pedidos)) { pedidos.seed(dump.pedidos); applied.pedidos = dump.pedidos.pedidos.length; }
    console.log('[RESTORE] aplicado:', JSON.stringify(applied), '(antes:', JSON.stringify(cur) + ')');
    res.json({ ok: true, applied, before: cur });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ─────────────── PEDIDOS — vista cliente (por código) ───────────────

// El cliente entra su código → ve sus cajas + montos rápidos para armar el pedido.
app.get('/api/pedir/:codigo', (req, res) => {
  const cli = clientes.getByCodigo(req.params.codigo);
  if (!cli) return res.status(404).json({ ok: false, error: 'Código no encontrado' });
  // Los datos para pagar y, sobre todo, los AVISOS: fuera del rango o en la red equivocada la
  // plata se pierde y no se recupera, así que el cliente los tiene que ver antes de transferir.
  const cfg = (k) => String(config.getCfg(k) || '');
  res.json({
    ok: true,
    cliente: { codigo: cli.codigo, nombreVisible: cli.nombreVisible },
    // Con qué caminos cuenta ESTE cliente. Avisar un pago no lo tiene cualquiera: entra a la
    // cola de comprobantes y hay que revisarlo uno por uno.
    puedeAvisarPago: cli.avisa_pagos !== false,
    pago: {
      ars: { titular: cfg('cvuTitular'), cvu: cfg('cvuVigente'), min: cfg('arsMin'), max: cfg('arsMax'), aviso: cfg('arsAviso'), nota: cfg('cvuNota') },
      usdt: { direccion: cfg('usdtAddress'), red: cfg('usdtRed'), aviso: cfg('usdtAviso'), nota: cfg('usdtNota') },
    },
    // NO exponer "sistema" al cliente (Casino/Europa = control interno). Sí las divisas (el cliente elige).
    cajas: (cli.cajas || []).map((k) => ({ id: k.id, usuario: k.usuario, divisas: (k.divisas && k.divisas.length) ? k.divisas : ['ARS'], montosRapidos: k.montosRapidos || [] })),
    // ── MOVER FICHAS ENTRE PANELES PROPIOS ──────────────────────────────────────────────────
    // Se manda la lista de PANELES y no la de cajas: el movimiento es entre paneles, que es lo
    // que tiene el id del casino. Y va sólo si el cliente tiene el permiso: sin él, la pantalla
    // no dibuja la opción (y aunque la dibujara, la ruta la rechaza).
    //
    // `grupo` es una etiqueta OPACA ("g1", "g2") y no el nombre del sistema. Le alcanza a la
    // pantalla para no ofrecer un destino de otra plataforma —que fallaría— sin decirle al cliente
    // qué plataformas hay ni cuál es cuál, que es control interno.
    puedeMoverBalance: !!cli.mover_balance,
    paneles: cli.mover_balance ? (() => {
      const gr = {}; let n = 0;
      return paneles.list({ cliente_id: cli.id }).filter((p) => p.id_usuario).map((p) => {
        const k = String(p.sistema || '').toLowerCase();
        if (!gr[k]) { n += 1; gr[k] = 'g' + n; }
        return { id: p.id, nombre: p.nombre, grupo: gr[k],
          divisas: (p.divisas && p.divisas.length) ? p.divisas : ['ARS'] };
      });
    })() : [],
  });
});

// El cliente hace el pedido: { codigo, cajaId, monto } → queda 'pendiente'.
app.post('/api/pedir', (req, res) => {
  const { codigo, cajaId, monto, divisa } = req.body || {};
  const cli = clientes.getByCodigo(codigo);
  if (!cli) return res.status(404).json({ ok: false, error: 'Código no encontrado' });
  const caja = (cli.cajas || []).find((k) => k.id === cajaId);
  if (!caja) return res.status(400).json({ ok: false, error: 'Caja no encontrada' });
  const cajaDivisas = (caja.divisas && caja.divisas.length) ? caja.divisas : ['ARS'];
  const div = cajaDivisas.includes(divisa) ? divisa : cajaDivisas[0]; // validar contra las divisas de la caja
  const m = Number(monto);
  if (!(m > 0)) return res.status(400).json({ ok: false, error: 'Monto inválido' });
  const pedido = pedidos.create({
    codigo: cli.codigo, clienteNombre: cli.nombreVisible,
    cajaId: caja.id, cajaUsuario: caja.usuario, sistema: caja.sistema, userId: caja.userId,
    divisa: div, monto: m,
  });
  console.log(`[Pedido] nuevo: ${cli.codigo}/${cli.nombreVisible} → ${caja.usuario} (${caja.sistema}) ${div} $${m}`);
  // PUSH al admin: "Usuario X pidió $monto en MONEDA" (fire-and-forget, no bloquea la respuesta al cliente).
  push.notifyNewPedido(pedido);
  res.json({ ok: true, pedido: { id: pedido.id, cajaUsuario: pedido.cajaUsuario, divisa: pedido.divisa, monto: pedido.monto, estado: pedido.estado } });
});

// El cliente AVISA UN PAGO: declara cuánto transfirió y adjunta la captura.
// Queda pendiente. No toca la deuda: eso se hace al aprobarlo desde el panel.
app.post('/api/comprobante', async (req, res) => {
  const b = req.body || {};
  const cli = clientes.getByCodigo(b.codigo);
  if (!cli) return res.status(404).json({ ok: false, error: 'Código no encontrado' });
  // ⚠️ Se comprueba ACÁ, no solo en la pantalla. Ocultar el botón no impide nada: cualquiera que
  // sepa un código puede postear a esta ruta a mano, y es pública (no pide login, ver auth.js).
  if (cli.avisa_pagos === false) {
    console.log(`[Comprobante] RECHAZADO: ${cli.codigo} no tiene habilitado avisar pagos`);
    return res.status(403).json({ ok: false, error: 'Tu cuenta no tiene habilitado avisar pagos por acá. Escribinos y lo cargamos nosotros.' });
  }
  const r = comprobantes.crear({
    codigo: cli.codigo, clienteNombre: cli.nombreVisible,
    via: b.via, monto: b.monto, divisa: b.divisa, referencia: b.referencia, notas: b.notas,
    archivo: b.archivo || null,
  });
  if (!r.ok) return res.status(400).json({ ok: false, error: r.error });
  const c = r.comprobante;
  console.log(`[Comprobante] ${cli.codigo}/${cli.nombreVisible} avisó un pago ${c.via.toUpperCase()} ${c.monto}`);

  // Aviso al teléfono, igual que con un pedido nuevo. El de Telegram va a un grupo; éste llega a
  // quien tiene el panel instalado, que es quien lo va a aprobar. Sin esto había que estar mirando.
  push.notifyNuevoComprobante({ ...c, clienteNombre: cli.nombreVisible || cli.nombre, codigo: cli.codigo });

  // ⚠️ ACÁ NO SE AVISA AL GRUPO. Antes sí, y el mensaje decía "queda pendiente hasta que se
  // apruebe": el grupo se enteraba de algo que todavía no pasó y después nadie confirmaba si había
  // pasado. El aviso va cuando el pago SE ACREDITA, que es el hecho que importa (ver el resolver
  // en os.routes). Para que la dueña se entere de que hay uno esperando está el push, que le llega
  // al teléfono aunque no esté mirando.
  res.json({ ok: true, comprobante: { id: c.id, estado: c.estado, monto: c.monto, divisa: c.divisa } });
});

/**
 * Manda al grupo el aviso de un comprobante, y DEJA ANOTADO si salió.
 *
 * Está aparte porque se usa dos veces: al recibirlo y al reintentar desde el panel. Antes vivía
 * dentro de la ruta y el resultado se perdía en un console.warn — un comprobante no llegaba al
 * grupo y no había forma de saber si el problema era el id, el bot o el permiso. Ahora queda en la
 * fila y se ve en la pantalla.
 */
async function avisarComprobante(c, cli, monto, moneda) {
  const chat = String(config.getCfg(c.via === 'usdt' ? 'tgChatUsdt' : 'tgChatArs') || '').trim();
  const tok = config.getTelegramToken();
  let aviso = null;
  if (!tok || !chat) {
    aviso = { ok: false, error: !tok ? 'el bot de Telegram no está configurado' : `no hay grupo cargado para ${c.via === 'usdt' ? 'USDT' : 'pesos'}` };
  } else {
    const nombre = (cli && (cli.nombreVisible || cli.nombre)) || c.cliente_nombre || c.codigo;
    const texto = telegram.pagoText({ cliente: nombre,
      monto: monto != null ? monto : c.monto,
      moneda: moneda || (cli && cli.moneda_cuenta === 'ARS' ? 'ARS' : 'USDT') });
    // Con el comprobante adentro: el que mira el grupo no tiene que entrar al OS para verlo.
    const conArchivo = comprobantes.get(c.id, true);
    if (conArchivo && conArchivo.archivo_datos) {
      try {
        aviso = await telegram.sendArchivo(tok, chat, {
          archivo: Buffer.from(conArchivo.archivo_datos, 'base64'),
          nombre: conArchivo.archivo_nombre, mime: conArchivo.archivo_tipo, caption: texto,
        });
      } catch (e) { aviso = { ok: false, error: String((e && e.message) || e) }; }
    } else {
      try { aviso = await telegram.sendMessage(tok, chat, texto + '\n<i>sin comprobante adjunto</i>'); }
      catch (e) { aviso = { ok: false, error: String((e && e.message) || e) }; }
    }
  }
  try { comprobantes.marcarAviso(c.id, aviso); }
  catch (e) { console.warn('[Comprobante] no se pudo anotar el aviso:', e.message); }
  if (!aviso.ok) console.warn(`[Comprobante] ${c.id}: el aviso al grupo NO salió — ${aviso.error}`);
  return aviso;
}

/** El texto largo de antes, que ya no se usa pero deja ver qué se dejó de mandar. */
function _textoViejoComprobante(c, cli) {
    const txt = [
      `🧾 <b>Pago avisado</b> — ${c.via === 'usdt' ? 'USDT' : 'ARS'}`,
      // `cli` puede no estar si el cliente se borró entre que avisó y que se reintenta el aviso:
      // el comprobante igual tiene el código, que es lo que identifica al que pagó.
      `Cliente: <b>${(cli && (cli.nombreVisible || cli.codigo)) || c.codigo}</b> (${c.codigo})`,
      `Monto declarado: <b>${c.monto} ${c.divisa}</b>`,
      c.referencia ? `Referencia: <code>${c.referencia}</code>` : null,
      c.notas ? `Nota: ${c.notas}` : null,
      c.archivo_bytes ? `📎 Adjuntó comprobante` : '⚠️ SIN comprobante adjunto',
      '',
      'Queda <b>pendiente</b> hasta que se apruebe en el panel.',
    ].filter(Boolean).join('\n');
  return txt;
}

/** Cuántos USDT se acreditaron de verdad: sale del movimiento que creó la aprobación. */
function montoAcreditado(c) {
  if (!c.movimiento_id) return null;
  try { const m = require('./movimientos-store').get(c.movimiento_id); return m ? (m.monto_usdt || m.monto_ars) : null; }
  catch (e) { return null; }
}

/** Reintentar el aviso de un comprobante que no llegó al grupo. */
app.post('/api/os/comprobantes/:id/reavisar', async (req, res) => {
  const c = comprobantes.get(req.params.id);
  if (!c) return res.status(404).json({ ok: false, error: 'no encontré ese comprobante' });
  // Sólo tiene sentido reavisar algo aprobado: es el aviso de "pago realizado".
  if (c.estado !== 'aprobado') return res.status(400).json({ ok: false, error: `ese comprobante está "${c.estado}": el aviso sale cuando se aprueba` });
  const cli = clientes.getByCodigo(c.codigo);
  const aviso = await avisarComprobante(c, cli, montoAcreditado(c),
    cli && cli.moneda_cuenta === 'ARS' ? 'ARS' : 'USDT');
  return aviso.ok ? res.json({ ok: true, aviso }) : res.status(502).json({ ok: false, error: aviso.error });
});
/**
 * El cliente PIDE MOVER fichas de un panel suyo a otro. No mueve nada: queda pendiente hasta que
 * se apruebe en el OS, igual que un pedido de fichas o una solicitud de caja.
 *
 * El permiso `mover_balance` se comprueba ACÁ y no sólo escondiendo el botón: esta ruta es pública
 * (no pide login, ver auth.js) y cualquiera que sepa un código puede postearle a mano.
 */
app.post('/api/movimiento-panel', (req, res) => {
  const b = req.body || {};
  const cli = clientes.getByCodigo(b.codigo);
  if (!cli) return res.status(404).json({ ok: false, error: 'Código no encontrado' });
  if (!cli.mover_balance) {
    console.log(`[Mover] RECHAZADO: ${cli.codigo} no tiene habilitado mover balance`);
    return res.status(403).json({ ok: false, error: 'Tu cuenta no tiene habilitado mover fichas entre paneles. Escribinos y lo hacemos nosotros.' });
  }
  const r = movPanel.crear({
    cliente_id: cli.id, origen_panel_id: b.origen, destino_panel_id: b.destino,
    divisa: b.divisa, monto: b.monto, nota: b.nota,
  }, 'cliente');
  if (!r.ok) return res.status(400).json({ ok: false, error: r.error });

  // Se revisa lo mismo que se va a revisar al ejecutar, para poder decirle AHORA que no va a andar
  // en vez de dejarlo esperando una aprobación que va a fallar.
  // El texto PÚBLICO, no el interno: el interno nombra las plataformas (Casino/Europa) y eso no
  // viaja al cliente. El detallado queda en el log y en la pantalla de la dueña.
  const mal = movPanelSvc.revisar(r.movimiento);
  const m = r.movimiento;
  console.log(`[Mover] ${cli.codigo} pidió mover ${m.monto} ${m.divisa}${mal ? ' — con un problema: ' + mal.interno : ''}`);
  push.notifyNuevoMovimiento({ ...m, cliente: cli.nombreVisible || cli.nombre || cli.codigo });
  res.json({ ok: true, movimiento: { id: m.id, estado: m.estado, monto: m.monto, divisa: m.divisa }, aviso: mal ? mal.publico : null });
});

/** En qué quedaron los movimientos que pidió este cliente. */
app.get('/api/movimiento-panel/:codigo', (req, res) => {
  const cli = clientes.getByCodigo(req.params.codigo);
  if (!cli) return res.status(404).json({ ok: false, error: 'Código no encontrado' });
  const porId = {}; paneles.list({ cliente_id: cli.id }).forEach((p) => { porId[p.id] = p.nombre; });
  res.json({ ok: true, movimientos: movPanel.list({ cliente_id: cli.id }).slice(0, 20).map((m) => ({
    id: m.id, origen: porId[m.origen_panel_id] || '(panel borrado)', destino: porId[m.destino_panel_id] || '(panel borrado)',
    divisa: m.divisa, monto: m.monto, estado: m.estado, creado_at: m.creado_at, hecho_at: m.hecho_at,
    motivo: m.motivo })) });
});

/**
 * ── EL CLIENTE ENTRA A SU CUENTA ─────────────────────────────────────────────────────────────
 *
 * Usuario y contraseña, no el código: acá hay plata —lo que consumió, lo que debe, lo que pagó— y
 * el código es corto y adivinable. La factura ya se mandaba por un link con token largo justamente
 * por eso; esto mantiene ese estándar en vez de bajarlo.
 *
 * No dice nunca si falló el usuario o la clave: decirlo confirma qué usuarios existen.
 */
app.post('/api/cuenta/login', (req, res) => {
  const b = req.body || {};
  const cli = accesoCli.autenticar(b.usuario, b.clave);
  if (!cli) return res.status(401).json({ ok: false, error: 'Usuario o contraseña incorrectos' });
  // Un token firmado con el mismo secreto que el panel, pero de OTRA familia: un token de cliente
  // nunca puede servir para entrar al OS.
  const token = auth.firmarCliente ? auth.firmarCliente(cli.id) : null;
  console.log(`[Cuenta] entró ${cli.codigo}`);
  res.json({ ok: true, cliente: { codigo: cli.codigo, nombre: cli.nombre }, token });
});

/**
 * Su cuenta: lo que consumió este mes, lo que debe y lo que pagó.
 *
 * Sale de lo que YA se calcula para la factura y para la cuenta corriente, así que no puede
 * discrepar con lo que ve la dueña — que es la única forma de que un cliente y ella miren el
 * mismo número.
 */
app.get('/api/cuenta/mio', (req, res) => {
  const cid = auth.clienteDeToken ? auth.clienteDeToken(req) : null;
  if (!cid) return res.status(401).json({ ok: false, error: 'Entrá de nuevo' });
  const cli = clientes.get(cid);
  if (!cli) return res.status(404).json({ ok: false, error: 'cuenta no encontrada' });
  const mes = new Date().toISOString().slice(0, 7);
  const cuenta = deudaSvc.cuentaCorriente(cli.id);
  const movimientos = movsStore.list({ cliente_id: cli.id })
    .slice(0, 40)
    .map((m) => ({ fecha: String(m.fecha || '').slice(0, 10), tipo: m.tipo,
      monto_ars: m.monto_ars, monto_usdt: m.monto_usdt, tc: m.tc_momento,
      divisa: m.divisa, notas: m.notas }));
  const cargas = pedidos.list({ codigo: cli.codigo, estado: 'cargado' })
    .filter((p) => String(p.resueltoAt || p.createdAt || '').slice(0, 7) === mes)
    .map((p) => ({ fecha: String(p.resueltoAt || p.createdAt || '').slice(0, 10),
      usuario: p.cajaUsuario, monto: p.monto, divisa: p.divisa }));
  res.json({ ok: true,
    cliente: { codigo: cli.codigo, nombre: cli.nombre || cli.nombreVisible },
    mes,
    base_pct: cli.precio_base_pct != null ? String(cli.precio_base_pct) : null,
    cuenta, cargas, movimientos });
});

// ─────────────── PEDIDOS — panel admin ───────────────

app.get('/api/pedidos', (req, res) => {
  res.json({ ok: true, counts: pedidos.counts(), pedidos: pedidos.list({ estado: req.query.estado, codigo: req.query.codigo }) });
});

// Aceptar y CARGAR: loguea al sistema de la caja (usuario/contraseña → sesión) y ejecuta la carga real.
// Por dónde van a pasar las fichas (para mostrarlo ANTES de cargar).
app.get('/api/pedidos/:id/cascada', (req, res) => {
  const p = pedidos.get(req.params.id);
  if (!p) return res.status(404).json({ ok: false, error: 'pedido no encontrado' });
  const plan = cascada.pasosDe({ sistema: p.sistema, userId: p.userId, monto: p.monto, divisa: p.divisa, cajaUsuario: p.cajaUsuario });
  res.json({
    ok: true, monto: p.monto, divisa: p.divisa,
    resuelto: plan.resuelto,                    // false = el panel no tiene la jerarquía sincronizada
    pasos: p.cascada && p.cascada.length === plan.pasos.length ? p.cascada : plan.pasos,
    trabadoEn: p.trabadoEn || null,
    bloqueo: plan.bloqueo,        // un padre sin la divisa del pedido → no se puede cargar
    aviso: plan.resuelto ? null : 'Este panel no tiene la jerarquía resuelta: se va a cargar directo, sin pasar por los padres. Sincronizá el árbol en el OS.',
  });
});

// Devolver hacia arriba las fichas que quedaron trabadas a mitad de una cascada.
// Es explícito a propósito: no se dispara solo.
app.post('/api/pedidos/:id/devolver-trabadas', async (req, res) => {
  const p = pedidos.get(req.params.id);
  if (!p) return res.status(404).json({ ok: false, error: 'pedido no encontrado' });
  if (!p.trabadoEn) return res.status(400).json({ ok: false, error: 'este pedido no tiene fichas trabadas' });
  if (p.estado !== 'pendiente') return res.status(400).json({ ok: false, error: `el pedido está "${p.estado}"` });
  // ── DE DÓNDE SALEN LAS CREDENCIALES PARA CARGAR ─────────────────────────────────────────────
  // Primero se busca una conexión del OS marcada para cargar en ESTE sistema (carga_de). Son
  // cuentas distintas de las de lectura a propósito: Alexa_support no puede bajar fichas, y por eso
  // hay un henry_support aparte. Tenerlas en un solo lugar evita que el día que cambie una clave se
  // actualice en un lado y el otro empiece a fallar sin que nadie lo note.
  // Si no hay ninguna marcada, se cae al almacén viejo (Operativo → Sistemas), que sigue andando.
  const cxCarga = casinoConexStore.paraCargar(p.sistema);
  const sys = cxCarga
    ? { name: cxCarga.nombre, url: cxCarga.url, user: cxCarga.usuario, password: casinoConexStore.get(cxCarga.id, true).password }
    : sistemaParaCargar(p.sistema);
  if (!sys || !sys.password) {
    return res.status(400).json({ ok: false,
      error: `No hay con qué cargar en "${p.sistema}". Marcá una conexión del OS con "carga fichas de ${p.sistema}", `
        + 'o cargá ese sistema en Operativo → Sistemas.' });
  }
  const t = await casino.testConnection(sys.url, sys.user, sys.password);
  if (!t.ok || !t.sessionCookie) return res.status(502).json({ ok: false, error: `No se pudo autenticar a "${p.sistema}"` });
  const r = await cascada.devolver({ url: sys.url, sessionCookie: t.sessionCookie, monto: p.monto, divisa: p.divisa, paso: p.trabadoEn });
  if (!r.ok) return res.status(502).json({ ok: false, error: r.error });
  // se devolvieron: la cascada vuelve a cero para poder empezar de nuevo limpio
  console.log(`[Cascada] DEVUELTAS ${p.divisa} ${p.monto} desde ${p.trabadoEn.login} (pedido ${p.id})`);
  pedidos.setCascada(p.id, [], null);
  res.json({ ok: true, newBalance: r.newBalance, devueltoDe: p.trabadoEn.login });
});

app.post('/api/pedidos/:id/cargar', async (req, res) => {
  const p = pedidos.get(req.params.id);
  if (!p) return res.status(404).json({ ok: false, error: 'pedido no encontrado' });
  if (p.estado !== 'pendiente') return res.status(400).json({ ok: false, error: `el pedido ya está "${p.estado}"` });

  const sys = sistemaParaCargar(p.sistema);
  if (!sys) return res.status(400).json({ ok: false, error: `No hay con qué cargar en "${p.sistema}". Marcá una conexión en 🏛 Comercial → Casino con "carga fichas de ${p.sistema}".` });
  if (!sys.password) return res.status(400).json({ ok: false, error: `Sistema "${p.sistema}" sin contraseña guardada` });
  if (!p.userId) return res.status(400).json({ ok: false, error: 'La caja no tiene user_id (ID del casino) — completalo en 👥 Clientes' });

  // 🔒 SE TOMA EL PEDIDO ANTES DE TOCAR EL CASINO. El camino completo tarda decenas de segundos
  // (login + un loadChips por eslabón) y hasta ahora el pedido seguía en 'pendiente' todo ese rato:
  // apretar dos veces cargaba las fichas DOS VECES y se facturaba una sola.
  const tomado = pedidos.tomarParaCargar(p.id);
  if (!tomado) return res.status(409).json({ ok: false, error: 'ese pedido ya se está cargando en este momento' });
  const soltar = () => { try { pedidos.soltarCarga(p.id); } catch (e) { console.warn('[Pedido] no se pudo soltar el lock:', e.message); } };

  try {
    // Pre-verificar la sesión (login + area=info): evita intentar cargar con sesión no autenticada.
    const t = await casino.testConnection(sys.url, sys.user, sys.password);
    if (!t.ok || !t.sessionCookie) {
      soltar();
      return res.status(502).json({ ok: false, error: `No se pudo autenticar al sistema "${p.sistema}" — revisá su usuario/contraseña en 🔌 Sistemas (probá "Probar conexión").` });
    }
    // CASCADA: cargar un Distribuidor/Agente le saca las fichas a su padre, así que se funde cada
    // eslabón de arriba hacia abajo justo antes de usarlo. Los padres terminan como estaban y solo
    // el destino queda con el monto. Si ya hubo un intento a medias, se RETOMA (no repite pasos).
    const plan = cascada.pasosDe({ sistema: p.sistema, userId: p.userId, monto: p.monto, divisa: p.divisa, cajaUsuario: p.cajaUsuario });
    // Si un padre no tiene la divisa del pedido, se avisa ANTES de mover nada.
    if (plan.bloqueo) { soltar(); return res.status(400).json({ ok: false, error: plan.bloqueo, bloqueo: true, sinLaDivisa: plan.sinLaDivisa }); }
    const pasos = (p.cascada && p.cascada.length === plan.pasos.length) ? p.cascada : plan.pasos;
    const r = await cascada.ejecutar({
      url: sys.url, sessionCookie: t.sessionCookie, monto: p.monto, divisa: p.divisa, pasos,
      serie: `${p.sistema}|${plan.superagenteId}`,   // una cascada a la vez por superagente
      log: (m) => console.log(m),
    });
    if (!r.ok) {
      // Fail-closed: el pedido queda 'pendiente' con lo ya movido anotado. Volver a apretar
      // "Cargar" retoma desde el paso que falló; nada se carga dos veces.
      // vuelve a 'pendiente' CON lo ya movido anotado: apretar Cargar de nuevo retoma desde el
      // paso que falló, no repite los que salieron bien.
      pedidos.setCascada(p.id, r.pasos, r.trabadoEn);
      soltar();
      return res.status(502).json({
        ok: false, error: r.error || 'la carga falló',
        cascada: r.pasos, trabadoEn: r.trabadoEn,
        detalle: r.trabadoEn
          ? `Quedaron ${p.divisa} ${p.monto} en "${r.trabadoEn.login}" (${r.trabadoEn.nivel}). Volvé a apretar Cargar para retomar, o devolvelas para arriba.`
          : 'No se movió nada.',
      });
    }
    if (r.ok) {
      const upd = pedidos.setEstado(p.id, 'cargado', { newBalance: r.newBalance, error: null, cascada: r.pasos, trabadoEn: null });
      console.log(`[Pedido] CARGADO ${p.codigo}→${p.cajaUsuario} ${p.divisa} $${p.monto} (nuevo balance: ${r.newBalance})`);
      // ── LA DEUDA NACE ACÁ, NO AL CERRAR EL MES ────────────────────────────────────────────
      // El % base sobre lo cargado, en la divisa de la carga. Para las cuentas en dólares además
      // se congela el TC del momento. Es idempotente por pedido: reintentar no cobra dos veces.
      // Si falla no se tumba la carga —las fichas YA están en el casino— pero queda en el log.
      let deudaCarga = null;
      try { deudaCarga = await deudaCargaSvc.porCarga(upd); }
      catch (e) { console.warn('[Deuda] no se pudo generar la deuda de la carga:', e.message); }
      if (deudaCarga && !deudaCarga.ok) console.warn(`[Deuda] ${p.id}: ${deudaCarga.motivo}`);
      sheets.logTransaction(upd); // registro en Google Sheets (fire-and-forget, no bloquea)
      // Aviso por Telegram al grupo del cliente (si está configurado) — fire-and-forget, no bloquea.
      try {
        const cli = clientes.getByCodigo(p.codigo);
        const tok = config.getTelegramToken();
        const dest = cli ? tgDestino.destinoDe(cli, (id) => clientes.get(id)) : { chatId: null };
        // El interruptor viaja en el destino: quien hereda el grupo hereda si está encendido.
        if (cli && dest.chatId && dest.enabled && tok) {
          telegram.sendMessage(tok, dest.chatId, telegram.cargaText({
            clienteNombre: p.clienteNombre, codigo: p.codigo, cajaUsuario: p.cajaUsuario, divisa: p.divisa, monto: p.monto,
          })).then((tr) => { pedidos.marcarAviso(p.id, tr); if (!tr.ok) console.warn('[Telegram] aviso falló:', tr.error); })
            .catch((e) => { pedidos.marcarAviso(p.id, { ok: false, error: e.message }); console.warn('[Telegram] aviso error:', e.message); });
        } else {
          // Sin grupo o sin bot NO es "no había que avisar": es un aviso que no salió, y hay que
          // poder verlo. Antes esto no dejaba rastro de ninguna clase.
          pedidos.marcarAviso(p.id, { ok: false,
            error: !tok ? 'el bot de Telegram no está configurado'
              : (!dest.chatId ? 'el cliente no tiene grupo (ni lo hereda de su vendedor)' : 'los avisos están apagados para ese grupo') });
        }
      } catch (e) { console.warn('[Telegram] aviso error:', e.message); }
      return res.json({ ok: true, pedido: upd, newBalance: r.newBalance });
    }
    // Falla la carga: dejar 'pendiente' para reintentar, devolver el error del casino.
    soltar();
    return res.status(502).json({ ok: false, error: r.error || 'la carga falló', detail: r.snippet });
  } catch (e) {
    soltar();
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/pedidos/:id/rechazar', (req, res) => {
  const p = pedidos.get(req.params.id);
  if (!p) return res.status(404).json({ ok: false, error: 'pedido no encontrado' });
  if (p.estado !== 'pendiente') return res.status(400).json({ ok: false, error: `el pedido ya está "${p.estado}"` });
  const upd = pedidos.setEstado(p.id, 'rechazado', { error: (req.body && req.body.motivo) || null });
  sheets.logTransaction(upd); // registro en Google Sheets (fire-and-forget, no bloquea)
  res.json({ ok: true, pedido: upd });
});

// Ventana durante la cual se puede anular una carga (desde que se cargó). Pasada, el botón
// desaparece del panel y el endpoint rechaza: anular sirve para deshacer un error reciente.
// Debe coincidir con la del operativo (fichas-live), que es la fuente de verdad de este flujo.
const ANULAR_WINDOW_MS = 5 * 60 * 1000; // 5 minutos

// ANULAR una carga ya hecha (ej. petición a un usuario EQUIVOCADO): RETIRA (operation=out) exactamente
// el mismo monto que se cargó y deja el pedido en 'anulado'. Solo aplica a un pedido 'cargado'.
// Es plata: si el casino no confirma el retiro (ej. el usuario ya usó las fichas → saldo insuficiente),
// NO cambia el estado y devuelve el error.
app.post('/api/pedidos/:id/anular', async (req, res) => {
  const p0 = pedidos.get(req.params.id);
  if (!p0) return res.status(404).json({ ok: false, error: 'pedido no encontrado' });
  if (p0.estado !== 'cargado') return res.status(400).json({ ok: false, error: `solo se anula una carga hecha ("cargado"); este está "${p0.estado}"` });

  // VENTANA (fail-closed): anular es para corregir un error RECIÉN cometido, no perpetuo.
  // Se valida acá (no solo ocultando el botón) para que no se pueda anular una carga vieja
  // reusando la request. Sin marca de tiempo de la carga → NO se anula.
  const tCarga = p0.resueltoAt ? Date.parse(p0.resueltoAt) : NaN;
  if (!Number.isFinite(tCarga)) {
    return res.status(400).json({ ok: false, error: 'esta carga no tiene fecha registrada — no se puede anular desde el panel (retirá las fichas manualmente en el casino).' });
  }
  const pasados = Date.now() - tCarga;
  if (pasados > ANULAR_WINDOW_MS) {
    const mins = Math.floor(pasados / 60000);
    return res.status(400).json({
      ok: false,
      error: `venció la ventana para anular (${Math.round(ANULAR_WINDOW_MS / 60000)} min desde la carga; pasaron ${mins} min). Si igual hay que devolver las fichas, retiralas manualmente en el casino.`,
    });
  }

  // Validaciones que NO mutan (antes de tomar el lock).
  const sys = sistemaParaCargar(p0.sistema);
  if (!sys) return res.status(400).json({ ok: false, error: `No hay con qué cargar en "${p0.sistema}". Marcá una conexión en 🏛 Comercial → Casino con "carga fichas de ${p0.sistema}".` });
  if (!sys.password) return res.status(400).json({ ok: false, error: `Sistema "${p0.sistema}" sin contraseña guardada` });
  if (!p0.userId) return res.status(400).json({ ok: false, error: 'La caja no tiene user_id del casino' });

  // LOCK ATÓMICO (cargado → anulando): previene doble-retiro por doble-click / requests concurrentes.
  const p = pedidos.tomarParaAnular(req.params.id);
  if (!p) return res.status(409).json({ ok: false, error: 'ese pedido ya se está anulando (o cambió de estado)' });

  try {
    const t = await casino.testConnection(sys.url, sys.user, sys.password);
    if (!t.ok || !t.sessionCookie) {
      pedidos.revertirAnulando(p.id); // no se retiró nada → volver a 'cargado' para reintentar
      return res.status(502).json({ ok: false, error: `No se pudo autenticar al sistema "${p.sistema}" — revisá sus credenciales en 🔌 Sistemas.` });
    }
    const r = await casino.loadChips(sys.url, t.sessionCookie, p.userId, p.monto, p.divisa, 'out'); // RETIRA el mismo monto
    if (r.ok) {
      const upd = pedidos.setEstado(p.id, 'anulado', { newBalance: r.newBalance, error: null });
      console.log(`[Pedido] ANULADO ${p.codigo}→${p.cajaUsuario} ${p.divisa} $${p.monto} (nuevo balance: ${r.newBalance})`);
      sheets.logTransaction(upd); // registro en Google Sheets (fire-and-forget)
      // ── CORREGIR EL AVISO QUE YA SALIÓ ────────────────────────────────────────────────────
      // Al grupo le llegó "✅ Carga acreditada" cuando se cargó. Si ahora se retiran las fichas y
      // no se dice nada, el cliente se queda con un mensaje en el teléfono que dejó de ser cierto.
      // Mismo grupo y mismo interruptor que la carga: es la corrección del mismo mensaje.
      // Va DESPUÉS de que el casino confirmó el retiro — avisar una anulación que no se aplicó
      // sería peor que no avisar. Fire-and-forget: Telegram no puede tumbar una anulación hecha.
      try {
        const cliA = clientes.getByCodigo(p.codigo);
        const tokA = config.getTelegramToken();
        const destA = cliA ? tgDestino.destinoDe(cliA, (id) => clientes.get(id)) : { chatId: null };
        if (cliA && destA.chatId && destA.enabled && tokA) {
          telegram.sendMessage(tokA, destA.chatId, telegram.anulacionText({
            cajaUsuario: p.cajaUsuario, divisa: p.divisa, monto: p.monto,
          })).then((tr) => { pedidos.marcarAviso(p.id, tr); if (!tr.ok) console.warn('[Telegram] aviso de anulación falló:', tr.error); })
            .catch((e) => { pedidos.marcarAviso(p.id, { ok: false, error: e.message }); console.warn('[Telegram] aviso de anulación error:', e.message); });
        } else {
          pedidos.marcarAviso(p.id, { ok: false,
            error: !tokA ? 'el bot de Telegram no está configurado'
              : (!destA.chatId ? 'el cliente no tiene grupo (ni lo hereda de su vendedor)' : 'los avisos están apagados para ese grupo') });
        }
      } catch (e) { console.warn('[Telegram] aviso de anulación error:', e.message); }
      return res.json({ ok: true, pedido: upd, newBalance: r.newBalance });
    }
    pedidos.revertirAnulando(p.id); // el casino NO confirmó el retiro (ej. saldo insuficiente) → rollback
    return res.status(502).json({ ok: false, error: r.error || 'el casino no confirmó el retiro', detail: r.snippet });
  } catch (e) {
    pedidos.revertirAnulando(p.id); // error de red/excepción → rollback (no se confirmó el retiro)
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// Historial: resueltos (cargado/rechazado/anulado), filtrable por código.
app.get('/api/historial', (req, res) => {
  const all = pedidos.list({ codigo: req.query.codigo });
  const hist = all.filter((p) => p.estado !== 'pendiente');
  // serverNow + anularWindowMs: el panel calcula con la hora del SERVIDOR (no la de la PC del
  // operador, que puede estar desfasada) cuánto queda de la ventana para anular.
  res.json({ ok: true, pedidos: hist, anularWindowMs: ANULAR_WINDOW_MS, serverNow: new Date().toISOString() });
});

// ─────────────── Frontend estático ───────────────
// Vista CLIENTE (público): http://localhost:PORT/pedir
app.get('/pedir', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'pedir.html')));

// La FACTURA que ve el cliente con su link. Pública a propósito: el cliente no tiene usuario, y la
// llave es el token. Muestra una FOTO congelada — si después entran cargas nuevas o cambia un %,
// el link tiene que seguir diciendo lo que se le mandó.
// La cuenta del mes de un cliente de API, por link. Pública a propósito: el cliente la abre sin
// tener usuario. Lo que se guarda en el link es el documento YA PROYECTADO (vista 'cliente'), así
// que acá no hay forma de que se escape lo que le pagamos al proveedor.
app.get('/cuenta/:token', (req, res) => {
  const doc = require('./api-cuenta-doc');
  const html = require('./api-cuenta-html');
  const r = doc.porToken(req.params.token);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, private');   // es de una sola persona: que no la cachee un proxy
  if (!r) return res.status(404).send(html.paginaError('No encontramos esa cuenta'));
  if (r.revocado) return res.status(410).send(html.paginaError('Este link ya no está disponible'));
  const cuando = String(r.actualizado_at || r.creado_at || '').slice(0, 16).replace('T', ' ');
  res.send(html.pagina(r.doc, { nota: cuando ? 'Emitida el ' + cuando : null }));
});

app.get('/factura/:token', (req, res) => {
  const facturaSvc = require('./factura.service');
  const html = require('./factura-html');
  const r = facturaSvc.porToken(req.params.token);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  // que no quede cacheada en un proxy: es información de una sola persona
  res.setHeader('Cache-Control', 'no-store, private');
  if (!r) return res.status(404).send(html.paginaError('No encontramos esa factura'));
  if (r.revocado) return res.status(410).send(html.paginaError('Este link ya no está disponible'));
  res.send(html.pagina({ ...r, token: req.params.token }));
});

// La misma factura en planilla, para bajarla y auditarla. Mismo token, misma foto: si el link
// muestra 2.510,75, el archivo dice 2.510,75. No hay dos números distintos dando vueltas.
app.get('/factura/:token/planilla.csv', (req, res) => {
  const facturaSvc = require('./factura.service');
  const csv = require('./factura-csv');
  const r = facturaSvc.porToken(req.params.token);
  if (!r) return res.status(404).type('text/plain; charset=utf-8').send('No encontramos esa factura');
  if (r.revocado) return res.status(410).type('text/plain; charset=utf-8').send('Este link ya no está disponible');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, private');
  // El nombre va en filename* además de filename: con acentos, el filename a secas se rompe.
  const n = csv.nombreArchivo(r.factura);
  res.setHeader('Content-Disposition',
    `attachment; filename="${n.replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(n)}`);
  res.send(csv.planilla(r.factura));
});
app.use(express.static(path.join(__dirname, '..', 'public')));
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

// ─────────────── Migración automática: JSON legacy → SQLite (una sola vez) ───────────────
// Si la DB está vacía y existen los viejos data/*.json, los importa al arrancar.
function migrateLegacyJson() {
  const fs = require('fs');
  const dir = path.join(__dirname, '..', 'data');
  const read = (f) => {
    try { const p = path.join(dir, f); if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8')); }
    catch (e) { console.warn(`[migración] no se pudo leer ${f}: ${e.message}`); }
    return null;
  };
  try {
    if (store.list().systems.length === 0) {
      const j = read('systems.json');
      if (j && Array.isArray(j.systems) && j.systems.length) { store.seed(j); console.log(`[migración] ${j.systems.length} sistemas importados desde systems.json`); }
    }
    if (clientes.list().clientes.length === 0) {
      const j = read('clientes.json');
      if (j && Array.isArray(j.clientes) && j.clientes.length) { clientes.seed(j); console.log(`[migración] ${j.clientes.length} clientes importados desde clientes.json`); }
    }
    if (pedidos.list().length === 0) {
      const j = read('pedidos.json');
      if (j && Array.isArray(j.pedidos) && j.pedidos.length) { pedidos.seed(j); console.log(`[migración] ${j.pedidos.length} pedidos importados desde pedidos.json`); }
    }
    const cfg = read('config.json');
    if (cfg && cfg.telegramBotToken && !config.getTelegramToken()) { config.setTelegramToken(cfg.telegramBotToken); console.log('[migración] token de Telegram importado'); }
  } catch (e) {
    console.error('[migración] error:', e.message);
  }
}
migrateLegacyJson();

// Cifrar en la base las contraseñas de sistemas que estén en texto plano (legacy).
try {
  const n = store.migrateEncrypt();
  if (n) console.log(`[seguridad] ${n} contraseña(s) de sistemas cifradas en la base`);
} catch (e) {
  console.error('[seguridad] migrateEncrypt error:', e.message);
}

if (auth.USING_DEFAULT_PASSWORD) {
  console.warn('⚠️  [VentaFichas] PANEL_PASSWORD no está configurada — usando "admin" por defecto. ¡Configurá PANEL_PASSWORD (y SESSION_SECRET) en producción!');
}

app.listen(PORT, () => {
  console.log(`[VentaFichas] Panel corriendo en http://localhost:${PORT}`);
  console.log(`[VentaFichas] Login del panel: usuario "${auth.PANEL_USER}" (clave por env PANEL_PASSWORD)`);
});
