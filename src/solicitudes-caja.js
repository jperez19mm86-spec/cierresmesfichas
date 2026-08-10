/**
 * solicitudes-caja.js — PEDIR QUE SE ABRA UNA CAJA.
 *
 * Quien despacha se entera antes que nadie de que un cliente necesita una caja nueva, pero no puede
 * crearla: una caja es un destino al que se le cargan fichas, y de quién sea define a quién se le
 * factura. Así que la pide y el dueño aprueba.
 *
 * ── TRES DECISIONES QUE VALE LA PENA EXPLICAR ─────────────────────────────────────────────────
 *
 * 1. NO SE PREGUNTAN LAS DIVISAS. Se leen del casino al aprobar. Escribirlas a mano es la fuente de
 *    error que ya vimos hoy: 154 paneles tenían monedas que nadie usó nunca y 27 movían una que no
 *    estaba en la lista. El casino sabe cuáles tiene habilitadas esa cuenta; preguntarlas es
 *    invitar a que alguien escriba mal.
 *
 * 2. NO SE PREGUNTA EL VENDEDOR COMO DATO. Un cliente ya cuelga de su vendedor (`vendedor_id`);
 *    pedir las dos cosas invita a que se contradigan. En la pantalla el vendedor es un FILTRO para
 *    encontrar al cliente, y si la caja es del vendedor mismo, se lo elige como cliente.
 *
 * 3. AL APROBAR SE CREA EL PANEL, NO LA CAJA. Panel y caja son la misma cuenta guardada dos veces:
 *    el panel factura, la caja recibe fichas. Crear sólo la caja dejaría una cuenta que recibe
 *    fichas y no se le cobra a nadie — el peor de los dos desbalances. Creando el panel, la caja
 *    sale sola por el espejo que ya existe.
 */
const crypto = require('crypto');
const { db } = require('./db');

const nowISO = () => new Date().toISOString();
const K = (s) => String(s || '').trim();

/** Lo que hace falta para que una solicitud sea atendible. Devuelve el motivo si algo falta. */
function queFalta(d) {
  if (!K(d.cliente_id)) return 'falta decir para qué cliente es';
  if (!/^(Casino|Europa)$/i.test(K(d.sistema))) return 'el panel tiene que ser Casino o Europa';
  if (!/^\d+$/.test(K(d.nodo))) return 'el id del casino son sólo números';
  if (!K(d.login)) return 'falta el login con el que figura en el panel';
  return null;
}

function crear(d, pedidaPor) {
  const falta = queFalta(d);
  if (falta) return { ok: false, error: falta };
  // El NODO es la identidad: dos cajas al mismo nodo serían dos destinos idénticos y la ficha se
  // podría cargar dos veces. Se avisa acá y no al aprobar, que es cuando ya nadie lo mira.
  const sis = K(d.sistema).replace(/^./, (c) => c.toUpperCase()).toLowerCase() === 'casino' ? 'Casino' : 'Europa';
  const ya = db.prepare(`SELECT id, estado FROM solicitud_caja
    WHERE nodo=? AND sistema=? AND estado='pendiente'`).get(K(d.nodo), sis);
  if (ya) return { ok: false, error: `ya hay una solicitud pendiente para el nodo ${K(d.nodo)} de ${sis}` };

  const id = 's_' + crypto.randomBytes(5).toString('hex');
  db.prepare(`INSERT INTO solicitud_caja (id, cliente_id, sistema, nodo, login, nota, estado, pedida_por, creada_at)
    VALUES (?,?,?,?,?,?, 'pendiente', ?, ?)`)
    .run(id, K(d.cliente_id), sis, K(d.nodo), K(d.login), K(d.nota), pedidaPor || 'admin', nowISO());
  return { ok: true, solicitud: get(id) };
}

function get(id) {
  return db.prepare('SELECT * FROM solicitud_caja WHERE id=?').get(String(id || '')) || null;
}

function list(filtros = {}) {
  let sql = 'SELECT * FROM solicitud_caja';
  const args = [];
  if (filtros.estado) { sql += ' WHERE estado=?'; args.push(filtros.estado); }
  sql += ' ORDER BY creada_at DESC';
  return db.prepare(sql).all(...args);
}

function resolver(id, { estado, motivo, panel_id }) {
  const s = get(id);
  if (!s) return null;
  db.prepare('UPDATE solicitud_caja SET estado=?, motivo=?, panel_id=?, resuelta_at=? WHERE id=?')
    .run(estado, motivo || null, panel_id || null, nowISO(), id);
  return get(id);
}

function pendientes() { return db.prepare("SELECT COUNT(*) c FROM solicitud_caja WHERE estado='pendiente'").get().c; }

module.exports = { crear, get, list, resolver, pendientes, queFalta };
