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
    if (r.data && r.data.ok) return { ok: true, messageId: r.data.result.message_id, metodo: 'texto' };
    return { ok: false, error: (r.data && r.data.description) || ('HTTP ' + r.status), metodo: 'texto' };
  } catch (e) {
    return { ok: false, error: e.message, metodo: 'texto' };
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

/**
 * Manda un ARCHIVO al grupo, con un texto al pie.
 *
 * El comprobante de un pago es una imagen: mandar "adjuntó comprobante" y que haya que entrar al
 * OS para verla convierte un aviso en una tarea. Con la foto adentro, el que mira el grupo ya sabe
 * si el pago está bien.
 *
 * Se elige el método por el tipo de archivo, y no da lo mismo: `sendPhoto` RECOMPRIME la imagen —
 * bien para una captura, y encima Telegram rechaza un PDF por ahí. Los PDF van como documento, que
 * los deja intactos.
 *
 * @param archivo  Buffer con los bytes
 */
async function sendArchivo(botToken, chatId, { archivo, nombre, mime, caption }) {
  if (!botToken) return { ok: false, error: 'Bot de Telegram no configurado (falta el token)' };
  if (!chatId) return { ok: false, error: 'no hay grupo (chatId) configurado' };
  if (!archivo || !archivo.length) return { ok: false, error: 'el comprobante no tiene archivo' };
  const esFoto = /^image\//i.test(String(mime || ''));
  const metodo = esFoto ? 'sendPhoto' : 'sendDocument';
  try {
    const fd = new FormData();
    fd.append('chat_id', String(chatId));
    if (caption) { fd.append('caption', caption); fd.append('parse_mode', 'HTML'); }
    fd.append(esFoto ? 'photo' : 'document',
      new Blob([archivo], { type: mime || 'application/octet-stream' }),
      nombre || (esFoto ? 'comprobante.jpg' : 'comprobante'));
    const r = await axios.post(`https://api.telegram.org/bot${botToken}/${metodo}`, fd,
      { timeout: 30000, validateStatus: () => true });   // 30s: sube bytes, no un texto
    if (r.data && r.data.ok) return { ok: true, messageId: r.data.result.message_id, metodo };
    return { ok: false, error: (r.data && r.data.description) || ('HTTP ' + r.status), metodo };
  } catch (e) { return { ok: false, error: e.message, metodo }; }
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
 * El aviso de que un pago quedó acreditado, para el grupo de COBRANZAS. Corto a propósito: lo pidió
 * así la dueña y tiene razón — al grupo le sirve saber de quién vino y cuánto, y el resto es ruido.
 *
 * ── QUIÉN SE NOMBRA, Y POR QUÉ NO ES LO MISMO EN LOS DOS GRUPOS ─────────────────────────────
 * En PESOS va sólo el VENDEDOR. Ese grupo reconcilia por vendedor —tres nombres, no cuarenta— y
 * el nombre del cliente ahí no aporta nada y lo expone de más.
 * En USDT van los dos, vendedor arriba y cliente abajo: ahí sí hace falta saber de quién es cada
 * transferencia.
 *
 * El vendedor es el de MÁS ARRIBA de la cadena: los clientes que cuelgan de Juli entran como Alexa.
 * Si no hay vendedor, se nombra al cliente — un aviso sin ningún nombre no le sirve a nadie.
 *
 * Va el monto ACREDITADO, no el declarado. Son dos números distintos: el cliente dice que mandó
 * 1000 y el que aprueba confirma lo que entró de verdad. Poner el declarado sería avisarle al grupo
 * un pago que capaz no es el que se registró.
 */
function pagoText({ vendedor, cliente, monto, moneda = 'USDT' }) {
  const m = Number(monto).toLocaleString('es-AR', { maximumFractionDigits: 2 });
  const quien = [vendedor || cliente || '', vendedor && cliente ? cliente : null]
    .filter(Boolean).map((x) => escapeHtml(x)).join('\n');
  return `✅ <b>Pago realizado</b>\n${quien}\n<b>${m} ${escapeHtml(moneda)}</b>`;
}

/**
 * EL MISMO PAGO, PERO PARA EL CLIENTE. Va a SU grupo, el de las cargas, no al de cobranzas.
 *
 * Son dos mensajes distintos porque son dos lectores distintos. El de cobranzas dice "Lucia pagó
 * 200.000" y lleva la foto del comprobante: sirve para controlar. Al cliente decirle su propio
 * nombre no le aporta nada, y mandarle de vuelta el comprobante que él acaba de mandar, menos.
 * Lo que él quiere saber es una sola cosa: que llegó.
 *
 * Sin monto no se manda: "tu abono está registrado" sin decir cuánto obliga a preguntar, que es
 * exactamente lo que este mensaje viene a evitar.
 */
function abonoText({ monto, moneda = 'USDT', declarado = null }) {
  const n = (x) => Number(x).toLocaleString('es-AR', { maximumFractionDigits: 2 });
  // La tercera línea SÓLO cuando lo acreditado no coincide con lo que él avisó. Sin ella, el
  // cliente que declaró 300.000 recibe un mensaje que dice 205.000 y tiene que darse cuenta solo —
  // y si no se da cuenta, la pregunta llega igual, más tarde y peor. Con ella queda por escrito
  // que la diferencia se vio. Cuando los montos coinciden no aparece: sería ruido en todos los
  // pagos para explicar el caso raro.
  return `✅ <b>Tu abono está registrado</b>\n<b>${n(monto)} ${escapeHtml(moneda)}</b>`
    + (declarado != null ? `\n<i>(habías avisado ${n(declarado)} ${escapeHtml(moneda)})</i>` : '');
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

module.exports = {
  abonoText, sendMessage, sendArchivo, verChat, cargaText, movimientoText, anulacionText, pagoText, cuenta,
  // Se manda con parse_mode HTML: un nombre de cliente con un & o un < rompe el mensaje entero
  // y Telegram lo rechaza. Quien arme texto acá afuera lo necesita.
  escapeHtml };
