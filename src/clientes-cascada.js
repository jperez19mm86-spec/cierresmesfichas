/**
 * clientes-cascada.js — DAR DE ALTA, RENOMBRAR Y BORRAR UN CLIENTE, EN UN SOLO LUGAR.
 *
 * Un cliente no vive solo en la tabla `clientes`: tiene paneles, movimientos, participaciones,
 * configuración, y una COLUMNA EN LA MATRIZ del cierre que se referencia POR NOMBRE.
 *
 * Había dos caminos para editarlo y borrarlo — el operativo (`/api/clientes/...`) y el comercial
 * (`/api/os/clientes/...`) — y solo el segundo arrastraba la matriz. Por el primero:
 *   · borrar dejaba la columna huérfana con todos sus % colgando de un nombre que ya no existe
 *     (pasó con "Hen" y con "Moises"),
 *   · renombrar le hacía PERDER todos sus % de proveedores, en silencio.
 *
 * Ahora los dos caminos llaman acá.
 */
const clientes = require('./clientes-store');
const paneles = require('./paneles-store');
const cierreStore = require('./cierre-store');
const { db } = require('./db');

const nombreDe = (c) => (c && (c.nombre || c.nombreVisible)) || '';

/** Alta: crea el cliente y su columna en la matriz. */
function crear({ codigo, nombre, nombreVisible }) {
  const c = clientes.createCliente({ codigo, nombreVisible: nombreVisible || nombre || codigo, nombre });
  cierreStore.addCliente(nombreDe(c) || codigo);
  return c;
}

/** Si el nombre cambió, mueve con él su columna de la matriz y su % base por mes. */
function arrastrarRenombre(antes, despues) {
  const viejo = nombreDe(antes); const nuevo = nombreDe(despues);
  if (viejo && nuevo && viejo !== nuevo) { cierreStore.renombrarCliente(viejo, nuevo); return true; }
  return false;
}

/* ── QUÉ FRENA EL BORRADO ────────────────────────────────────────────────────────────────────
   Borrar se lleva los movimientos sin respaldo. Con plata o gente colgando no es «uno cargado por
   error»: es un cliente que dejó de trabajar, y eso se da de baja (fase 4.3), no se borra. Antes un
   vendedor borrado dejaba a sus clientes con un vendedor que no existe. */
function queLoFrena(id) {
  const n = (sql) => { try { return db.prepare(sql).get(id).n; } catch (e) { return 0; } };
  const por = [];
  const movs = n('SELECT COUNT(*) n FROM movimientos WHERE cliente_id=?');
  if (movs) por.push(`${movs} movimiento(s) en su cuenta`);
  const facts = n('SELECT COUNT(*) n FROM factura_guardada WHERE cliente_id=?');
  if (facts) por.push(`${facts} factura(s) guardada(s)`);
  const otros = clientes.list().clientes.filter((c) => c.id !== id
    && [c.vendedor_id, c.factura_a, c.abona_a, c.externos_precios_de].includes(id));
  if (otros.length) por.push(`${otros.length} cliente(s) que dependen de él (${otros.slice(0, 4).map(nombreDe).join(', ')})`);
  return por;
}

/** Baja completa: paneles, % de proveedores, participaciones, config, movimientos y su columna.
    Devuelve false si no existe, o { frenado: [motivos] } si tiene historia. */
function borrar(id) {
  const antes = clientes.get(id);
  if (!antes) return false;
  const frenos = queLoFrena(id);
  if (frenos.length) return { frenado: frenos };
  paneles.list({ cliente_id: id }).forEach((p) => paneles.remove(p.id));
  db.prepare('DELETE FROM cliente_proveedores WHERE cliente_id=?').run(id);
  db.prepare('DELETE FROM participaciones WHERE cliente_id=?').run(id);
  db.prepare("DELETE FROM config_valores WHERE entidad_tipo='cliente' AND entidad_id=?").run(id);
  db.prepare('DELETE FROM movimientos WHERE cliente_id=?').run(id);
  /* Y lo del CHAT EXTERNO, que es otra cuenta pero también es suya. Sin esto quedaba una deuda
     huérfana sumando en el total del chat, sin cliente al lado y sin forma de sacarla desde
     ninguna pantalla. Cada tabla se borra si existe: el chat puede no estar en una base vieja. */
  for (const t of ['chat_mov', 'chat_comprobante', 'chat_solicitud', 'chat_envio',
    'chat_aviso_mens', 'chat_cliente']) {
    try { db.prepare(`DELETE FROM ${t} WHERE cliente_id=?`).run(id); } catch (e) { /* no está */ }
  }
  cierreStore.removeCliente(nombreDe(antes));
  return clientes.removeCliente(id);
}

module.exports = { crear, arrastrarRenombre, borrar, queLoFrena, nombreDe };
