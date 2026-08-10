/**
 * telegram.js — envío de mensajes por el bot de Telegram (sendMessage de la Bot API).
 * Un solo bot global; el destino es el chatId del grupo de cada cliente.
 */
const axios = require('axios');

/**
 * @returns {Promise<{ok:boolean, messageId?:number, error?:string}>}
 */
async function sendMessage(botToken, chatId, text) {
  if (!botToken) return { ok: false, error: 'Bot de Telegram no configurado (falta el token)' };
  if (!chatId) return { ok: false, error: 'El cliente no tiene grupo (chatId) configurado' };
  try {
    const r = await axios.post(
      `https://api.telegram.org/bot${botToken}/sendMessage`,
      { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true },
      { timeout: 12000, validateStatus: () => true }
    );
    if (r.data && r.data.ok) return { ok: true, messageId: r.data.result.message_id };
    return { ok: false, error: (r.data && r.data.description) || ('HTTP ' + r.status) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/** Texto del aviso de carga exitosa. */
function cargaText({ clienteNombre, codigo, cajaUsuario, divisa, monto }) {
  const m = Number(monto).toLocaleString('es-AR');
  return `✅ <b>Carga acreditada</b>\n\n` +
    `🎰 Usuario: <b>${escapeHtml(cajaUsuario || '')}</b>\n` +
    `💰 Monto: <b>${escapeHtml(divisa || '')} $ ${m}</b>`;
}

/**
 * El aviso de que se movieron fichas de un usuario del cliente a otro.
 *
 * Mismo criterio que `cargaText`: NO lleva el nombre ni el código del cliente. Estos grupos son
 * compartidos —el de un vendedor sirve a varios clientes— y lo que identifica el movimiento son
 * los usuarios, que el cliente conoce porque son los suyos. Poner el nombre agregaría a la
 * conversación de un grupo quién es quién, que no es asunto del grupo.
 *
 * Tampoco dice Casino ni Europa: a qué plataforma pertenece cada usuario es control interno, y ya
 * se cuida de no mandárselo al cliente en la pantalla de pedidos.
 */
function movimientoText({ origen, destino, divisa, monto }) {
  const m = Number(monto).toLocaleString('es-AR');
  return '🔀 <b>Fichas movidas</b>\n\n'
    + `↖️ De: <b>${escapeHtml(origen || '')}</b>\n`
    + `↘️ A: <b>${escapeHtml(destino || '')}</b>\n`
    + `💰 Monto: <b>${escapeHtml(divisa || '')} $ ${m}</b>`;
}

function escapeHtml(s) { return String(s == null ? '' : s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }

module.exports = { sendMessage, cargaText, movimientoText };
