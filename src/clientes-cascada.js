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

/** Baja completa: paneles, % de proveedores, participaciones, config, movimientos y su columna. */
function borrar(id) {
  const antes = clientes.get(id);
  if (!antes) return false;
  paneles.list({ cliente_id: id }).forEach((p) => paneles.remove(p.id));
  db.prepare('DELETE FROM cliente_proveedores WHERE cliente_id=?').run(id);
  db.prepare('DELETE FROM participaciones WHERE cliente_id=?').run(id);
  db.prepare("DELETE FROM config_valores WHERE entidad_tipo='cliente' AND entidad_id=?").run(id);
  db.prepare('DELETE FROM movimientos WHERE cliente_id=?').run(id);
  cierreStore.removeCliente(nombreDe(antes));
  return clientes.removeCliente(id);
}

module.exports = { crear, arrastrarRenombre, borrar, nombreDe };
