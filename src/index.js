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
const clientes = require('./clientes-store');
const pedidos = require('./pedidos-store');
const config = require('./config-store');
const telegram = require('./telegram');
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
app.use(express.json({ limit: '1mb' }));

// ─────────────── LOGIN del panel (usuario + contraseña → cookie) ───────────────
app.post('/api/login', auth.loginHandler);
app.post('/api/logout', auth.logoutHandler);
app.get('/login', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'login.html')));

// GATE: todo lo que sigue requiere sesión, EXCEPTO las rutas públicas
// (vista cliente /pedir + /api/pedir, /login, /api/login, logo). Ver src/auth.js.
app.use(auth.required);

// ─────────────── LATAM Games OS — núcleo comercial/financiero (/api/os/*) ───────────────
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

app.get('/api/clientes', (_req, res) => {
  res.json({ ok: true, clientes: clientes.list().clientes });
});

app.post('/api/clientes', (req, res) => {
  const { codigo, nombreVisible } = req.body || {};
  if (!codigo) return res.status(400).json({ ok: false, error: 'código requerido' });
  try {
    const c = clientes.createCliente({ codigo, nombreVisible });
    res.json({ ok: true, cliente: c });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.put('/api/clientes/:id', (req, res) => {
  try {
    const c = clientes.updateCliente(req.params.id, req.body || {});
    if (!c) return res.status(404).json({ ok: false, error: 'cliente no encontrado' });
    res.json({ ok: true, cliente: c });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.delete('/api/clientes/:id', (req, res) => {
  const ok = clientes.removeCliente(req.params.id);
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
  res.json({ ok: true, telegramConfigured: !!tok, telegramTokenHint: tok ? ('…' + tok.slice(-6)) : '' });
});

app.put('/api/config', (req, res) => {
  const { telegramBotToken } = req.body || {};
  if (telegramBotToken !== undefined) config.setTelegramToken(telegramBotToken);
  const tok = config.getTelegramToken();
  res.json({ ok: true, telegramConfigured: !!tok, telegramTokenHint: tok ? ('…' + tok.slice(-6)) : '' });
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
  const r = await telegram.sendMessage(
    config.getTelegramToken(),
    c.telegram && c.telegram.chatId,
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
  res.json({
    ok: true,
    cliente: { codigo: cli.codigo, nombreVisible: cli.nombreVisible },
    // NO exponer "sistema" al cliente (Casino/Europa = control interno). Sí las divisas (el cliente elige).
    cajas: (cli.cajas || []).map((k) => ({ id: k.id, usuario: k.usuario, divisas: (k.divisas && k.divisas.length) ? k.divisas : ['ARS'], montosRapidos: k.montosRapidos || [] })),
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

// ─────────────── PEDIDOS — panel admin ───────────────

app.get('/api/pedidos', (req, res) => {
  res.json({ ok: true, counts: pedidos.counts(), pedidos: pedidos.list({ estado: req.query.estado, codigo: req.query.codigo }) });
});

// Aceptar y CARGAR: loguea al sistema de la caja (usuario/contraseña → sesión) y ejecuta la carga real.
app.post('/api/pedidos/:id/cargar', async (req, res) => {
  const p = pedidos.get(req.params.id);
  if (!p) return res.status(404).json({ ok: false, error: 'pedido no encontrado' });
  if (p.estado !== 'pendiente') return res.status(400).json({ ok: false, error: `el pedido ya está "${p.estado}"` });

  const sys = store.list().systems.find((s) => String(s.name).toLowerCase() === String(p.sistema).toLowerCase());
  if (!sys) return res.status(400).json({ ok: false, error: `Sistema "${p.sistema}" no configurado (cargalo en 🔌 Sistemas)` });
  if (!sys.password) return res.status(400).json({ ok: false, error: `Sistema "${p.sistema}" sin contraseña guardada` });
  if (!p.userId) return res.status(400).json({ ok: false, error: 'La caja no tiene user_id (ID del casino) — completalo en 👥 Clientes' });

  try {
    // Pre-verificar la sesión (login + area=info): evita intentar cargar con sesión no autenticada.
    const t = await casino.testConnection(sys.url, sys.user, sys.password);
    if (!t.ok || !t.sessionCookie) {
      return res.status(502).json({ ok: false, error: `No se pudo autenticar al sistema "${p.sistema}" — revisá su usuario/contraseña en 🔌 Sistemas (probá "Probar conexión").` });
    }
    const r = await casino.loadChips(sys.url, t.sessionCookie, p.userId, p.monto, p.divisa, 'in');
    if (r.ok) {
      const upd = pedidos.setEstado(p.id, 'cargado', { newBalance: r.newBalance, error: null });
      console.log(`[Pedido] CARGADO ${p.codigo}→${p.cajaUsuario} ${p.divisa} $${p.monto} (nuevo balance: ${r.newBalance})`);
      sheets.logTransaction(upd); // registro en Google Sheets (fire-and-forget, no bloquea)
      // Aviso por Telegram al grupo del cliente (si está configurado) — fire-and-forget, no bloquea.
      try {
        const cli = clientes.getByCodigo(p.codigo);
        const tok = config.getTelegramToken();
        if (cli && cli.telegram && cli.telegram.enabled && cli.telegram.chatId && tok) {
          telegram.sendMessage(tok, cli.telegram.chatId, telegram.cargaText({
            clienteNombre: p.clienteNombre, codigo: p.codigo, cajaUsuario: p.cajaUsuario, divisa: p.divisa, monto: p.monto,
          })).then((tr) => { if (!tr.ok) console.warn('[Telegram] aviso falló:', tr.error); })
            .catch((e) => console.warn('[Telegram] aviso error:', e.message));
        }
      } catch (e) { console.warn('[Telegram] aviso error:', e.message); }
      return res.json({ ok: true, pedido: upd, newBalance: r.newBalance });
    }
    // Falla la carga: dejar 'pendiente' para reintentar, devolver el error del casino.
    return res.status(502).json({ ok: false, error: r.error || 'la carga falló', detail: r.snippet });
  } catch (e) {
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

// Historial: resueltos (cargado/rechazado), filtrable por código.
app.get('/api/historial', (req, res) => {
  const all = pedidos.list({ codigo: req.query.codigo });
  const hist = all.filter((p) => p.estado !== 'pendiente');
  res.json({ ok: true, pedidos: hist });
});

// ─────────────── Frontend estático ───────────────
// Vista CLIENTE (público): http://localhost:PORT/pedir
app.get('/pedir', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'pedir.html')));
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
