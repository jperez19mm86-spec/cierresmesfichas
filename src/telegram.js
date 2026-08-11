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

/**
 * ¿El bot LLEGA a ese chat? Pregunta sin mandar nada.
 *
 * `getChat` es de sólo lectura: contesta si el chat existe y si el bot está adentro. Sirve para
 * diagnosticar sin escribirle a un grupo real, que es lo que hacía falta el día que un comprobante
 * no llegó y no había forma de saber si el problema era el id, el bot o el permiso — el envío
 * fallaba en silencio y no quedaba registro de nada.
 *
 * @returns {Promise<{ok:boolean, titulo?:string, tipo?:string, error?:string}>}
 */
async function verChat(botToken, chatId) {
  if (!botToken) return { ok: false, error: 'Bot de Telegram no configurado (falta el token)' };
  if (!chatId) return { ok: false, error: 'no hay chatId configurado' };
  try {
    const r = await axios.post(`https://api.telegram.org/bot${botToken}/getChat`,
      { chat_id: chatId }, { timeout: 12000, validateStatus: () => true });
    if (r.data && r.data.ok) {
      const c = r.data.result || {};
      return { ok: true, titulo: c.title || c.username || String(chatId), tipo: c.type || '?' };
    }
    return { ok: false, error: (r.data && r.data.description) || ('HTTP ' + r.status) };
  } catch (e) { return { ok: false, error: e.message }; }
}

/** Texto del aviso de carga exitosa. */
function cargaText({ clienteNombre, codigo, cajaUsuario, divisa, monto }) {
  const m = Number(monto).toLocaleString('es-AR');
  return `✅ <b>Carga acreditada</b>\n\n` +
    `🎰 Usuario: ${cuenta(cajaUsuario)}\n` +
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
    + `↖️ De: ${cuenta(origen)}\n`
    + `↘️ A: ${cuenta(destino)}\n`
    + `💰 Monto: <b>${escapeHtml(divisa || '')} $ ${m}</b>`;
}

/**
 * El aviso de que una carga que YA se había avisado se dio de baja y las fichas se retiraron.
 *
 * Es la contracara de `cargaText` y existe porque sin él el grupo se quedaba con un "✅ Carga
 * acreditada" que dejó de ser cierto: al cliente le sacaron las fichas del casino y en su teléfono
 * seguía el mensaje diciendo que las tenía. Corregirlo es de quien mandó el primero.
 *
 * NO hay un equivalente para "rechazado": un pedido rechazado nunca se cargó, así que al grupo no
 * le llegó nada que corregir. Eso el dueño prefiere hablarlo por privado.
 */
function anulacionText({ cajaUsuario, divisa, monto }) {
  const m = Number(monto).toLocaleString('es-AR');
  return '↩️ <b>Carga anulada</b>\n\n'
    + `🎰 Usuario: ${cuenta(cajaUsuario)}\n`
    + `💰 Monto: <b>${escapeHtml(divisa || '')} $ ${m}</b>\n\n`
    + 'Las fichas se retiraron de la cuenta.';
}

function escapeHtml(s) { return String(s == null ? '' : s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }

/**
 * El nombre de una cuenta del casino, dentro de un mensaje de Telegram.
 *
 * ── POR QUÉ VA EN <code> Y NO EN <b> ─────────────────────────────────────────────────────────
 * Muchos paneles se llaman como un dominio —cash365.vip, Ahora463.com, Argenbets.net— y Telegram
 * convierte eso en un ENLACE TOCABLE solo, sin que nadie se lo pida. En el grupo de un cliente
 * queda un link a un sitio de afuera adentro de un aviso nuestro, y alcanza con un dedo mal puesto.
 *
 * `<code>` es la única marca que Telegram no auto-enlaza. De paso queda en monoespaciado, que para
 * un identificador se lee mejor que en negrita.
 *
 * Se usa en TODO lo que sale a un grupo: avisos de carga, de movimiento, y los nombres de panel
 * de la factura y de la cuenta de TBS.
 */
function cuenta(s) { return `<code>${escapeHtml(s == null ? '' : s)}</code>`; }

module.exports = { sendMessage, verChat, cargaText, movimientoText, anulacionText, cuenta };
