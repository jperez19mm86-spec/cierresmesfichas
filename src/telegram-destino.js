/**
 * telegram-destino.js — A DÓNDE LE LLEGA EL AVISO A CADA CLIENTE.
 *
 * A muchos clientes el dueño no les avisa directo: les avisa por el grupo de su vendedor. Antes eso
 * obligaba a cargar el mismo chatId en cada uno de los 14 clientes de Henry, y si el grupo cambiaba
 * había que tocar los 14. Ahora el grupo se carga UNA vez en el vendedor y baja solo.
 *
 * ── POR QUÉ ESTO ES UNA FUNCIÓN Y NO UNA LÍNEA EN CADA LADO ────────────────────────────────────
 *
 * Había CUATRO lugares distintos leyendo `cliente.telegram.chatId` para decidir a dónde mandar: el
 * aviso de carga del panel público, el aviso de carga del OS, la factura y el botón de prueba.
 * Cuatro copias de la misma decisión. Una herencia implementada en dos de las cuatro es peor que
 * ninguna: la factura llegaría y el aviso de carga no, sin que nada lo diga.
 *
 * ── LO QUE SE HEREDA Y LO QUE NO ───────────────────────────────────────────────────────────────
 *
 * Se hereda el DESTINO (a qué grupo), no el INTERRUPTOR (si avisar). A propósito: hoy los 45
 * clientes tienen los avisos apagados. Si también se heredara el interruptor, prender el del
 * vendedor pondría a 14 clientes a escribir de golpe en un grupo real, sin que nadie lo pidiera.
 * Así, prender el aviso de un cliente sigue siendo una decisión de ese cliente — pero ya no hay
 * que averiguar ni pegar ningún id.
 *
 * La factura y el botón de prueba no dependen del interruptor: los dispara una persona a mano.
 */

/**
 * @param {object} cliente          el cliente al que se le quiere avisar
 * @param {function} getCliente     (id) => cliente — para poder subir al vendedor
 * @returns {{chatId:string|null, heredado:boolean, de:string|null}}
 */
function destinoDe(cliente, getCliente) {
  if (!cliente) return { chatId: null, heredado: false, de: null };
  const propio = ((cliente.telegram || {}).chatId || '').trim();
  if (propio) return { chatId: propio, heredado: false, de: null };

  const vid = cliente.vendedor_id;
  if (!vid || String(vid) === String(cliente.id)) return { chatId: null, heredado: false, de: null };
  const v = typeof getCliente === 'function' ? getCliente(vid) : null;
  const delVendedor = ((v && v.telegram) || {}).chatId;
  if (!v || !delVendedor || !String(delVendedor).trim()) return { chatId: null, heredado: false, de: null };
  return { chatId: String(delVendedor).trim(), heredado: true, de: v.nombre || v.codigo || String(vid) };
}

/** ¿Se le puede avisar CADA CARGA? Hace falta el destino Y el interruptor propio prendido. */
function avisaCargas(cliente, getCliente) {
  const d = destinoDe(cliente, getCliente);
  return !!(d.chatId && (cliente.telegram || {}).enabled);
}

module.exports = { destinoDe, avisaCargas };
