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
/* ── LAS COPIAS ──────────────────────────────────────────────────────────────────────────────
   Un cliente puede necesitar que sus avisos lleguen ADEMÁS a otro grupo — el de operaciones, el de
   un socio— sin cambiar el suyo. Titan avisa a -4842085177 y también tiene que llegar a
   -5425623864.

   ⚠️ NO SE HEREDAN, a diferencia del destino. El destino se hereda porque es «dónde vive este
   cliente»; una copia es una decisión sobre ESE cliente. Heredarla pondría a los 14 clientes de un
   vendedor a escribir en un grupo que se cargó para uno solo.

   Y nunca se manda dos veces al mismo lugar: si una copia es igual al destino, se descarta. */
function copiasDe(cliente) {
  const c = (cliente && cliente.telegram && cliente.telegram.copias) || [];
  const propio = (((cliente || {}).telegram || {}).chatId || '').trim();
  return [...new Set((Array.isArray(c) ? c : [])
    .map((x) => String(x || '').trim())
    .filter((x) => x && x !== propio))];
}

function destinoDe(cliente, getCliente) {
  if (!cliente) return { chatId: null, heredado: false, de: null, enabled: false, copias: [] };
  const copias = copiasDe(cliente);
  const propio = ((cliente.telegram || {}).chatId || '').trim();
  if (propio) return { chatId: propio, heredado: false, de: null, enabled: !!(cliente.telegram || {}).enabled, copias };

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
    if (!vid || vistos.has(String(vid))) return { chatId: null, heredado: false, de: null, enabled: false, copias };
    vistos.add(String(vid));
    const v = typeof getCliente === 'function' ? getCliente(vid) : null;
    if (!v) return { chatId: null, heredado: false, de: null, enabled: false, copias };
    const suyo = ((v.telegram || {}).chatId || '').trim();
    // El interruptor viaja CON el destino: ver avisaCargas.
    if (suyo) return { chatId: suyo, heredado: true, de: v.nombre || v.codigo || String(vid),
      enabled: !!(v.telegram || {}).enabled, copias };
    actual = v;
  }
}

/**
 * EL VENDEDOR PRINCIPAL de un cliente: el de más arriba de la cadena.
 *
 * Los avisos de cobranza van a un grupo donde lo que se reconcilia es de QUIÉN vino la plata, no
 * quién la puso. Hay clientes que cuelgan de Juli y Juli de Alexa; ahí el nombre útil es Alexa —
 * lo decidió la dueña — porque el grupo de pesos maneja tres nombres y no cuarenta.
 *
 * Sube TODA la cadena, igual que `destinoDe`, con la misma protección contra ciclos: si alguien
 * queda como vendedor de su propio vendedor, esto se colgaría, y colgar el aviso de un pago ya
 * acreditado es peor que no encontrar el nombre.
 *
 * Si el cliente no tiene vendedor —es directo, o es él mismo un vendedor— devuelve null. Quien
 * llama decide qué poner en su lugar: un aviso sin ningún nombre no le sirve a nadie.
 */
function vendedorPrincipal(cliente, getCliente) {
  if (!cliente) return null;
  const vistos = new Set([String(cliente.id)]);
  let actual = cliente; let ultimo = null;
  while (actual && actual.vendedor_id && !vistos.has(String(actual.vendedor_id))) {
    vistos.add(String(actual.vendedor_id));
    const v = typeof getCliente === 'function' ? getCliente(actual.vendedor_id) : null;
    if (!v) break;
    ultimo = v; actual = v;
  }
  return ultimo ? (ultimo.nombre || ultimo.nombreVisible || ultimo.codigo || null) : null;
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

/**
 * Mandar UN aviso al destino del cliente y a todas sus copias.
 *
 * Existe para que no haya que acordarse de las copias en cada uno de los ocho lugares que avisan
 * algo — carga, anulación, movimiento de fichas, abono… Ese olvido es silencioso: el aviso llega
 * al grupo de siempre y la copia no, y nadie se entera hasta que alguien la reclama.
 *
 * Si falla el destino principal se informa; una copia que falla NO hace fallar el aviso: lo
 * importante ya salió, y devolver error haría pensar que no se avisó.
 */
async function enviarConCopias(telegram, tok, dest, texto) {
  if (!tok || !dest || !dest.chatId) return { ok: false, skipped: true };
  const r = await telegram.sendMessage(tok, dest.chatId, texto);
  const copias = [];
  for (const c of (dest.copias || [])) {
    try {
      const x = await telegram.sendMessage(tok, c, texto);
      copias.push({ chat: c, ok: !!(x && x.ok), error: x && x.error });
      if (!(x && x.ok)) console.log(`[copia] no salió a ${c}: ${(x && x.error) || 'sin motivo'}`);
    } catch (e) { copias.push({ chat: c, ok: false, error: String((e && e.message) || e) }); }
  }
  return { ...r, copias };
}

module.exports = { destinoDe, vendedorPrincipal, avisaCargas, copiasDe, enviarConCopias };
