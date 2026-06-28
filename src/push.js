/**
 * push.js — Web Push (notificaciones) para el panel admin de Latam Games.
 *
 * Cuando un cliente hace un pedido en /pedir, el admin (que instaló la PWA y activó
 * las notificaciones) recibe una push: "Usuario X pidió $MONTO en MONEDA".
 *
 * - VAPID keys: se generan UNA vez y se guardan en la tabla config (persisten en la DB).
 *   Se pueden fijar por env (VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY) para que no cambien entre
 *   entornos; si no están, se autogeneran y guardan.
 * - Suscripciones: tabla push_subs (una por dispositivo/navegador del admin).
 * - sendToAll: envía a todas; las suscripciones vencidas (404/410) se borran solas.
 */
const webpush = require('web-push');
const { db } = require('./db');
const { getCfg, setCfg } = require('./config-store');

const SUBJECT = process.env.VAPID_SUBJECT || 'mailto:admin@latamgames.online';

let _ready = false;

/** Devuelve {publicKey, privateKey}, generándolas y persistiéndolas la primera vez. */
function getVapidKeys() {
  let pub = (process.env.VAPID_PUBLIC_KEY || getCfg('vapidPublicKey') || '').trim();
  let priv = (process.env.VAPID_PRIVATE_KEY || getCfg('vapidPrivateKey') || '').trim();
  if (!pub || !priv) {
    const k = webpush.generateVAPIDKeys();
    pub = k.publicKey;
    priv = k.privateKey;
    setCfg('vapidPublicKey', pub);
    setCfg('vapidPrivateKey', priv);
    console.log('[Push] VAPID keys generadas y guardadas en la base.');
  }
  return { publicKey: pub, privateKey: priv };
}

function ensureReady() {
  if (_ready) return;
  const { publicKey, privateKey } = getVapidKeys();
  webpush.setVapidDetails(SUBJECT, publicKey, privateKey);
  _ready = true;
}

function getPublicKey() {
  ensureReady();
  return getVapidKeys().publicKey;
}

/** Guarda (o actualiza) una suscripción del navegador del admin. */
function addSubscription(sub) {
  if (!sub || !sub.endpoint) return false;
  db.prepare('INSERT INTO push_subs (endpoint, sub, createdAt) VALUES (?,?,?) ON CONFLICT(endpoint) DO UPDATE SET sub=excluded.sub')
    .run(sub.endpoint, JSON.stringify(sub), new Date().toISOString());
  return true;
}

function removeSubscription(endpoint) {
  db.prepare('DELETE FROM push_subs WHERE endpoint=?').run(endpoint);
}

function listSubscriptions() {
  return db.prepare('SELECT endpoint, sub FROM push_subs').all().map((r) => {
    try { return JSON.parse(r.sub); } catch (e) { return null; }
  }).filter(Boolean);
}

function count() {
  return db.prepare('SELECT COUNT(*) AS c FROM push_subs').get().c;
}

/**
 * Envía un payload a TODAS las suscripciones. Borra las que ya no sirven (404/410 = gone).
 * @param {{title:string, body:string, url?:string, tag?:string}} payload
 */
async function sendToAll(payload) {
  ensureReady();
  const subs = listSubscriptions();
  if (!subs.length) return { sent: 0, removed: 0 };
  const data = JSON.stringify(payload);
  let sent = 0, removed = 0;
  await Promise.all(subs.map(async (sub) => {
    try {
      await webpush.sendNotification(sub, data, { TTL: 600 });
      sent++;
    } catch (e) {
      const code = e && e.statusCode;
      if (code === 404 || code === 410) { removeSubscription(sub.endpoint); removed++; }
      else console.warn('[Push] envío falló:', code || (e && e.message));
    }
  }));
  return { sent, removed };
}

/** Notificación de un pedido nuevo: "Usuario X pidió $MONTO en MONEDA". */
function notifyNewPedido(pedido) {
  const monto = Number(pedido.monto || 0).toLocaleString('es-AR');
  const body = `${pedido.cajaUsuario} pidió $${monto} en ${pedido.divisa}` +
    (pedido.clienteNombre ? ` — ${pedido.clienteNombre} (${pedido.codigo})` : '');
  return sendToAll({
    title: '🎰 Nuevo pedido de fichas',
    body,
    url: '/',
    tag: 'pedido-' + (pedido.id || Date.now()),
  }).catch((e) => console.warn('[Push] notifyNewPedido error:', e && e.message));
}

module.exports = { getPublicKey, addSubscription, removeSubscription, listSubscriptions, count, sendToAll, notifyNewPedido };
