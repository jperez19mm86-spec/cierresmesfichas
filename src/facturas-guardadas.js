/**
 * facturas-guardadas.js — LAS FACTURAS QUE SE LE MANDARON A CADA CLIENTE, guardadas.
 *
 * El agujero que cierra: la factura se armaba en pantalla y se iba. Sólo quedaba congelada si
 * alguien apretaba el botón del link o la mandaba por Telegram; imprimirla a PDF —que es como se
 * venía usando— no dejaba rastro. En todo el sistema había **dos** facturas guardadas.
 *
 * Sin esto no hay forma de volver a lo que se le cobró a un cliente en mayo: pedirla de nuevo la
 * recalcula, y el número de hoy no es el de entonces — entraron cargas, cambió un %, cambió el TC.
 *
 * Se guarda cuando la factura SALE del sistema: al emitir el mes, al imprimirla, al copiarla, al
 * crear el link o al enviarla. Abrirla para mirar no guarda nada, porque mirar no es cobrar.
 *
 * ⚠️ La primera vez manda: `generada_at` no se pisa nunca. Si la factura se vuelve a generar se
 * actualiza el contenido y sube `veces`, pero la fecha en que se emitió por primera vez es la que
 * importa para saber qué se le mandó y cuándo.
 */
const { db } = require('./db');

const nowISO = () => new Date().toISOString();
const M = (x) => String(x || '').slice(0, 7);
const J = (x) => { try { return x ? JSON.parse(x) : null; } catch (e) { return null; } };

function _fila(r) {
  if (!r) return null;
  return {
    cliente_id: r.cliente_id,
    mes: r.mes,
    datos: J(r.datos),
    consumo_usdt: r.consumo_usdt || '0',
    externos_usdt: r.externos_usdt || '0',
    total_usdt: r.total_usdt || '0',
    generada_at: r.generada_at,
    generada_por: r.generada_por,
    veces: r.veces || 1,
    actualizada_at: r.actualizada_at,
    salio_at: r.salio_at || null,
    salio_como: r.salio_como || null,
  };
}

/** La factura guardada de (cliente, mes), o null si nunca se generó. */
function get(clienteId, mes) {
  return _fila(db.prepare('SELECT * FROM factura_guardada WHERE cliente_id=? AND mes=?')
    .get(String(clienteId), M(mes)));
}

/** Todas las de un cliente, de la más nueva a la más vieja. Es su historial de facturas. */
function delCliente(clienteId, { conDatos = false } = {}) {
  const cols = conDatos ? '*' : 'cliente_id, mes, consumo_usdt, externos_usdt, total_usdt, generada_at, generada_por, veces, actualizada_at, salio_at, salio_como';
  return db.prepare(`SELECT ${cols} FROM factura_guardada WHERE cliente_id=? ORDER BY mes DESC`)
    .all(String(clienteId)).map(_fila);
}

/** Todas las de un mes. Para ver a quién ya se le mandó y a quién no. */
function delMes(mes) {
  return db.prepare(`SELECT cliente_id, mes, total_usdt, generada_at, veces, salio_at, salio_como
                     FROM factura_guardada WHERE mes=? ORDER BY CAST(total_usdt AS REAL) DESC`)
    .all(M(mes)).map(_fila);
}

/**
 * Guarda (o actualiza) la factura de un mes.
 *
 * @param como  por dónde salió, si salió: impresa | copiada | link | telegram. Si no viene, se
 *              guarda el contenido sin marcar que se haya enviado — es el caso de la emisión.
 */
function guardar(factura, { como = null, quien = 'admin' } = {}) {
  if (!factura || !factura.ok || !factura.cliente) return { ok: false, error: 'factura inválida' };
  const cid = String(factura.cliente.id);
  const mes = M(factura.mes);
  const at = nowISO();
  const ya = db.prepare('SELECT generada_at, veces FROM factura_guardada WHERE cliente_id=? AND mes=?').get(cid, mes);
  const cons = (factura.consumo && factura.consumo.total_usdt) || '0';
  const ext = (factura.externos && factura.externos.total_usdt) || '0';

  db.prepare(`INSERT INTO factura_guardada
      (cliente_id, mes, datos, consumo_usdt, externos_usdt, total_usdt,
       generada_at, generada_por, veces, actualizada_at, salio_at, salio_como)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(cliente_id, mes) DO UPDATE SET
        datos=excluded.datos, consumo_usdt=excluded.consumo_usdt, externos_usdt=excluded.externos_usdt,
        total_usdt=excluded.total_usdt, veces=factura_guardada.veces+1, actualizada_at=excluded.actualizada_at,
        -- la primera vez que salió no se pisa: importa cuándo se le mandó, no la última vez que se miró
        salio_at=COALESCE(factura_guardada.salio_at, excluded.salio_at),
        salio_como=COALESCE(factura_guardada.salio_como, excluded.salio_como)`)
    .run(cid, mes, JSON.stringify(factura), String(cons), String(ext), String(factura.totalMes_usdt || '0'),
      (ya && ya.generada_at) || at, quien, 1, at, como ? at : null, como);
  return { ok: true, factura: get(cid, mes) };
}

/** Deja registrado que la factura salió, y por dónde. Se usa cuando ya estaba guardada. */
function marcarSalida(clienteId, mes, como) {
  db.prepare(`UPDATE factura_guardada SET salio_at=COALESCE(salio_at, ?), salio_como=COALESCE(salio_como, ?)
              WHERE cliente_id=? AND mes=?`)
    .run(nowISO(), String(como), String(clienteId), M(mes));
  return get(clienteId, mes);
}

module.exports = { get, delCliente, delMes, guardar, marcarSalida };
