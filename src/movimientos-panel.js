/**
 * movimientos-panel.js — MOVER FICHAS DE UN PANEL A OTRO DEL MISMO CLIENTE.
 *
 * El cliente pide, la dueña aprueba, y recién ahí se ejecuta. Es el mismo molde que las solicitudes
 * de caja, y por el mismo motivo: mover fichas cambia dónde está el saldo y, si un panel es de un
 * vendedor y el otro no, cambia a quién se le factura. Que pase por una aprobación es la diferencia
 * entre poder reconstruir qué pasó y tener que adivinar.
 *
 * ── POR QUÉ PRIMERO SE RETIRA Y DESPUÉS SE CARGA ─────────────────────────────────────────────
 * Son dos operaciones contra el casino y no hay transacción que las abrace. Hay que elegir cuál va
 * primero, y la respuesta la da un detalle del conector: NO SE PUEDE CONSULTAR EL SALDO. `loadChips`
 * es la única operación de balance que existe y devuelve el saldo DESPUÉS de operar, así que no hay
 * forma de saber de antemano si el panel origen tiene con qué.
 *
 * Entonces se retira primero:
 *   · si el origen no tiene saldo, el casino rechaza el retiro y NO PASÓ NADA. Es la falla más
 *     probable de todas y así es la más barata.
 *   · si el retiro sale y la carga falla, las fichas no se perdieron: el retiro las sube a la CUENTA
 *     CON LA QUE CARGAMOS, que es nuestra. Quedan a la vista y se reintenta sólo la segunda mitad.
 *
 * Al revés sería mucho peor: cargar primero en el destino y no poder retirar del origen deja fichas
 * DE MÁS en la calle, que es plata regalada y no se recupera.
 *
 * ── EL ESTADO "retirado" ES EL QUE IMPORTA ───────────────────────────────────────────────────
 * Es el "quedó a medias": salió el retiro, falta la carga. No es un error a esconder — es plata
 * nuestra esperando que se la mande a destino. Reintentar desde ahí ejecuta SÓLO la segunda mitad;
 * el retiro nunca se repite, porque repetirlo sacaría el monto dos veces del origen.
 *
 *   pendiente ──aprobar──> ejecutando ──retiro ok──> retirado ──carga ok──> hecho
 *       │                      │                        │
 *       │                      └──retiro falla──────────┘ (vuelve a pendiente, no se movió nada)
 *       └──rechazar──> rechazado                          └──carga falla──> sigue en retirado
 *
 * El lock `ejecutando` está en la BASE y no en la pantalla: el camino completo son decenas de
 * segundos y apretar dos veces movía las fichas dos veces. Es la misma lección que dejó escrita
 * `pedidos-store.tomarParaCargar`.
 */
const crypto = require('crypto');
const { db } = require('./db');
const money = require('./lib/money');

const nowISO = () => new Date().toISOString();
const K = (s) => String(s || '').trim();

/** Lo que hace falta para que un pedido de movimiento sea atendible. Devuelve el motivo si falta. */
function queFalta(d) {
  if (!K(d.cliente_id)) return 'falta decir de qué cliente es';
  if (!K(d.origen_panel_id)) return 'falta el panel de origen';
  if (!K(d.destino_panel_id)) return 'falta el panel de destino';
  if (K(d.origen_panel_id) === K(d.destino_panel_id)) return 'el origen y el destino son el mismo panel';
  if (!K(d.divisa)) return 'falta la divisa';
  if (!money.isPos(String(d.monto || '0'))) return 'el monto tiene que ser mayor a cero';
  return null;
}

function crear(d, pedidoPor) {
  const falta = queFalta(d);
  if (falta) return { ok: false, error: falta };

  // Un mismo cliente no puede dejar dos pedidos iguales esperando: son dos clics, no dos
  // movimientos. Se corta acá y no al aprobar, que es cuando ya nadie mira el detalle.
  const ya = db.prepare(`SELECT id FROM movimiento_panel
    WHERE cliente_id=? AND origen_panel_id=? AND destino_panel_id=? AND divisa=? AND monto=?
      AND estado IN ('pendiente','ejecutando','retirado')`)
    .get(K(d.cliente_id), K(d.origen_panel_id), K(d.destino_panel_id), K(d.divisa).toUpperCase(), String(d.monto));
  if (ya) return { ok: false, error: 'ya hay un pedido igual esperando; no hace falta pedirlo de nuevo' };

  const id = 'mv_' + crypto.randomBytes(5).toString('hex');
  db.prepare(`INSERT INTO movimiento_panel
    (id, cliente_id, origen_panel_id, destino_panel_id, divisa, monto, nota, estado, pedido_por, creado_at)
    VALUES (?,?,?,?,?,?,?, 'pendiente', ?, ?)`)
    .run(id, K(d.cliente_id), K(d.origen_panel_id), K(d.destino_panel_id),
      K(d.divisa).toUpperCase(), String(d.monto), K(d.nota) || null, pedidoPor || 'cliente', nowISO());
  return { ok: true, movimiento: get(id) };
}

function get(id) {
  return db.prepare('SELECT * FROM movimiento_panel WHERE id=?').get(String(id || '')) || null;
}

function list(filtros = {}) {
  const cond = []; const args = [];
  if (filtros.estado) { cond.push('estado=?'); args.push(String(filtros.estado)); }
  if (filtros.cliente_id) { cond.push('cliente_id=?'); args.push(String(filtros.cliente_id)); }
  const w = cond.length ? ` WHERE ${cond.join(' AND ')}` : '';
  return db.prepare(`SELECT * FROM movimiento_panel${w} ORDER BY creado_at DESC LIMIT 300`).all(...args);
}

/**
 * 🔒 EL CANDADO. Toma el pedido para ejecutarlo, en la base y en un solo UPDATE condicional.
 *
 * El WHERE con el estado esperado es lo que lo hace atómico: dos requests simultáneas entran las
 * dos, pero sólo una encuentra la fila en ese estado y la otra cambia cero filas. Sin esto, apretar
 * "Aprobar" dos veces mueve las fichas dos veces — pasó con los pedidos y quedó documentado ahí.
 *
 * @param desde  'pendiente' para el movimiento entero, 'retirado' para reintentar sólo la carga.
 */
function tomar(id, desde) {
  const r = db.prepare(`UPDATE movimiento_panel SET estado='ejecutando', tomado_at=?, desde_estado=?
    WHERE id=? AND estado=?`).run(nowISO(), desde, String(id || ''), desde);
  return r.changes === 1 ? get(id) : null;
}

/** Suelta el lock devolviendo la fila al estado del que se la tomó. Nunca inventa un estado. */
function soltar(id, error) {
  const m = get(id);
  if (!m || m.estado !== 'ejecutando') return null;
  db.prepare('UPDATE movimiento_panel SET estado=?, tomado_at=NULL, error=? WHERE id=?')
    .run(m.desde_estado || 'pendiente', error ? String(error).slice(0, 500) : null, String(id));
  return get(id);
}

/**
 * El retiro salió. Sigue EJECUTANDO —falta la carga— pero desde acá el punto de retorno cambia:
 * si la segunda mitad falla, esto no vuelve a 'pendiente' nunca más. Volver a pendiente haría que
 * el próximo intento repita el retiro, y eso sacaría el monto DOS VECES del origen.
 */
function marcarRetiroOk(id, detalle) {
  db.prepare(`UPDATE movimiento_panel SET retirado_at=?, detalle_retiro=?, desde_estado='retirado',
    error=NULL WHERE id=?`).run(nowISO(), JSON.stringify(detalle || {}), String(id));
  return get(id);
}

/**
 * Destrabar un movimiento que quedó en 'ejecutando' porque el server se reinició en el medio.
 *
 * Sin esto queda tomado para siempre y no hay botón que lo mueva. A dónde vuelve NO se elige: lo
 * dice `retirado_at`. Si el retiro alcanzó a salir, vuelve a 'retirado' —falta sólo la carga— y si
 * no, a 'pendiente'. Adivinar acá sería o repetir un retiro o dar por perdidas fichas que están.
 *
 * Pide que hayan pasado unos minutos: un movimiento en curso de verdad no se puede destrabar por
 * error mientras el casino todavía está contestando.
 */
function destrabar(id, minimoMinutos = 5) {
  const m = get(id);
  if (!m || m.estado !== 'ejecutando') return { ok: false, error: 'ese movimiento no está trabado' };
  const desde = m.tomado_at ? Date.parse(m.tomado_at) : NaN;
  if (Number.isFinite(desde) && Date.now() - desde < minimoMinutos * 60000) {
    return { ok: false, error: `se tomó hace menos de ${minimoMinutos} minutos: puede estar ejecutándose ahora mismo` };
  }
  const vuelve = m.retirado_at ? 'retirado' : 'pendiente';
  db.prepare('UPDATE movimiento_panel SET estado=?, tomado_at=NULL, error=? WHERE id=?')
    .run(vuelve, 'se destrabó a mano: el proceso se cortó en el medio', String(id));
  return { ok: true, movimiento: get(id), vuelveA: vuelve };
}

function marcarHecho(id, detalle, porQuien) {
  db.prepare(`UPDATE movimiento_panel SET estado='hecho', tomado_at=NULL, hecho_at=?,
    detalle_carga=?, aprobado_por=?, error=NULL WHERE id=?`)
    .run(nowISO(), JSON.stringify(detalle || {}), porQuien || 'admin', String(id));
  return get(id);
}

function rechazar(id, motivo, porQuien) {
  const m = get(id);
  if (!m) return null;
  // Sólo se rechaza lo que todavía no movió nada. Un movimiento en 'retirado' ya sacó las fichas
  // del origen: rechazarlo dejaría la plata nuestra y el pedido cerrado como si no hubiera pasado.
  if (m.estado !== 'pendiente') return { ok: false, error: `no se puede rechazar: está "${m.estado}"` };
  db.prepare(`UPDATE movimiento_panel SET estado='rechazado', motivo=?, resuelto_at=?, aprobado_por=? WHERE id=?`)
    .run(String(motivo || '').slice(0, 300) || null, nowISO(), porQuien || 'admin', String(id));
  return { ok: true, movimiento: get(id) };
}

/** Cuántos esperan algo del dueño: los pendientes y —sobre todo— los que quedaron a medias. */
function counts() {
  const f = db.prepare(`SELECT estado, COUNT(*) n FROM movimiento_panel GROUP BY estado`).all();
  const o = { pendiente: 0, ejecutando: 0, retirado: 0, hecho: 0, rechazado: 0 };
  f.forEach((x) => { o[x.estado] = x.n; });
  // Un 'ejecutando' viejo es un proceso que se cortó, así que también pide atención: si no se
  // contara, un movimiento con las fichas ya retiradas podría quedar meses sin que nadie lo vea.
  const trabados = db.prepare(`SELECT COUNT(*) n FROM movimiento_panel
    WHERE estado='ejecutando' AND (tomado_at IS NULL OR tomado_at < ?)`)
    .get(new Date(Date.now() - 5 * 60000).toISOString()).n;
  o.trabados = trabados;
  o.requierenAtencion = o.pendiente + o.retirado + trabados;
  return o;
}

module.exports = { crear, get, list, tomar, soltar, marcarRetiroOk, destrabar, marcarHecho, rechazar, counts, queFalta };
