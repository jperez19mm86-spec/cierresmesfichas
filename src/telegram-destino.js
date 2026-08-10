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
  if (!cliente) return { chatId: null, heredado: false, de: null, enabled: false };
  const propio = ((cliente.telegram || {}).chatId || '').trim();
  if (propio) return { chatId: propio, heredado: false, de: null, enabled: !!(cliente.telegram || {}).enabled };

  // SUBE TODA LA CADENA, no un solo escalón. Hay vendedores que cuelgan de otro vendedor —
  // GanamosSarah y Julian son de Alexa — así que un cliente de Julian tiene que poder terminar en
  // el grupo de Alexa. Con un solo salto la pantalla mostraría la jerarquía y el mensaje se
  // perdería a mitad de camino.
  // `vistos` corta los ciclos: si alguien queda como vendedor de su propio vendedor, esto se
  // colgaría, y colgar el envío de una factura es peor que no encontrar el grupo.
  const vistos = new Set([String(cliente.id)]);
  let actual = cliente;
  while (true) {
    const vid = actual.vendedor_id;
    if (!vid || vistos.has(String(vid))) return { chatId: null, heredado: false, de: null, enabled: false };
    vistos.add(String(vid));
    const v = typeof getCliente === 'function' ? getCliente(vid) : null;
    if (!v) return { chatId: null, heredado: false, de: null, enabled: false };
    const suyo = ((v.telegram || {}).chatId || '').trim();
    // El interruptor viaja CON el destino: ver avisaCargas.
    if (suyo) return { chatId: suyo, heredado: true, de: v.nombre || v.codigo || String(vid),
      enabled: !!(v.telegram || {}).enabled };
    actual = v;
  }
}

/**
 * ¿Se le puede avisar CADA CARGA? Hace falta destino y que esté encendido.
 *
 * ── EL INTERRUPTOR SE HEREDA CON EL DESTINO (cambiado el 10-ago-2026, lo decidió el dueño) ────
 *
 * Antes NO se heredaba, y la razón era buena: prender el de un vendedor pondría a sus clientes a
 * escribir de golpe en un grupo real. Pero el efecto en la práctica fue peor — 11 clientes tenían
 * grupo asignado y no avisaban nunca, y desde afuera parecía que el grupo no estaba cargado.
 *
 * Se le mostró al dueño la lista exacta de quiénes empezarían a avisar y decidió que se herede.
 * La regla queda: si el grupo lo presta el vendedor, el interruptor también es el suyo. Un cliente
 * con chatId propio manda con SU interruptor y puede apagarlo sin afectar a nadie más.
 */
function avisaCargas(cliente, getCliente) {
  const d = destinoDe(cliente, getCliente);
  return !!(d.chatId && d.enabled);
}

module.exports = { destinoDe, avisaCargas };
