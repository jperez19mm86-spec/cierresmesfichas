/**
 * ajustes.routes.js — Ajustes del sistema: configuración, logo, copias de la base, Telegram, historial, versión y la pantalla /os.
 * Sale de os.routes.js (fase 2): las rutas se movieron tal cual y en el mismo orden.
 */
const clientes = require('../clientes-store');
const historial = require('../historial');
const pedidosStore = require('../pedidos-store');
const configStore = require('../config-store');
const telegram = require('../telegram');
const backup = require('../backup.service');
const chat = require('../chat-externo.store');
const { ok, err, wrap, html } = require('./comun');

/**
 * Base % efectivo de un cliente/panel PARA UN MES.
 * Es un atajo a `externosSvc.baseDelMes`, que es la única función que resuelve este número en todo
 * el sistema. Antes cada pantalla lo hacía a su manera y el mismo cliente-mes daba tres resultados.
 * Siempre hay que pasarle el mes que se está facturando; si no, factura con el % de hoy.
 */
// Cuándo levantó ESTE proceso. Cambia en cada despliegue, sirva o no la variable de git.
const ARRANQUE = new Date().toISOString();

function mount(app) {
  app.get('/os', (_req, res) => html(res, 'os.html'));
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
  // ───────── MEDIOS DE PAGO GLOBALES (v3.0): CVU + dirección USDT + notas ─────────
  // Los datos con los que el cliente paga, y los avisos de seguridad que tiene que leer ANTES de
  // transferir. Los avisos no son decorativos: fuera del rango o en la red equivocada, la plata
  // se pierde y no se recupera.
  const PAGOS_KEYS = [
    'cvuVigente', 'cvuTitular', 'cvuNota', 'arsMin', 'arsMax', 'arsAviso',
    'usdtAddress', 'usdtRed', 'usdtNota', 'usdtAviso',
    'tgChatArs', 'tgChatUsdt',   // a qué grupo de Telegram avisa cada camino
    // El grupo INTERNO («Cuentas Imperium»): ahí van las cuentas de externos y de vendedores al
    // cerrar el mes. No es de clientes — por eso esos mensajes sí llevan nombres.
    'tgChatInterno',
  ];
  /**
   * ¿A qué grupo llegan los avisos de pago, y el bot llega ahí? Sólo LEE (getChat): no manda un
   * mensaje de prueba a un grupo real. Existe porque un comprobante no llegó y no había forma de
   * saber si el problema era el id, el bot o el permiso.
   */
  app.get('/api/os/config/pagos/probar', wrap(async (_req, res) => {
    const tok = configStore.getTelegramToken();
    const out = [];
    for (const k of ['tgChatArs', 'tgChatUsdt', 'tgChatInterno']) {
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
    ['tgChatArs', 'tgChatUsdt', 'tgChatInterno'].forEach((k) => {
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
  /* ── DIVISAS QUE NO SE CONSULTAN ──────────────────────────────────────────────────────────
   * La lista de monedas que la Foto del mes no pregunta nunca, aunque el casino las tenga
   * habilitadas. No borra nada: los paneles conservan su lista tal como vino del casino, y esto
   * sólo filtra al momento de armar el plan. Sacar una de acá la devuelve al mes siguiente. */
  app.get('/api/os/config/divisas-ignoradas', (_req, res) => ok(res, { divisas: configStore.getDivisasIgnoradas() }));
  app.put('/api/os/config/divisas-ignoradas', wrap((req, res) => {
    const b = req.body || {};
    const r = configStore.setDivisasIgnoradas(b.divisas === undefined ? '' : b.divisas);
    ok(res, { divisas: r.divisasIgnoradas });
  }));
  app.get('/api/os/config/pagos', (_req, res) => { const o = {}; PAGOS_KEYS.forEach((k) => { o[k] = configStore.getCfg(k) || ''; }); ok(res, { pagos: o }); });
  app.put('/api/os/config/pagos', wrap((req, res) => { const b = req.body || {}; PAGOS_KEYS.forEach((k) => { if (b[k] !== undefined) configStore.setCfg(k, String(b[k])); }); const o = {}; PAGOS_KEYS.forEach((k) => { o[k] = configStore.getCfg(k) || ''; }); ok(res, { pagos: o }); }));
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
  // ───────── HISTORIAL / AUDITORÍA ─────────
  app.get('/api/os/historial', (req, res) => ok(res, {
    historial: historial.listHistorial({ entidad_tipo: req.query.entidad_tipo, entidad_id: req.query.entidad_id, campo: req.query.campo }),
  }));
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
}

module.exports = { mount };
