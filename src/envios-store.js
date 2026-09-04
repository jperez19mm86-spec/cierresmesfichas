/**
 * envios-store.js — LO QUE YA SE MANDÓ AL GRUPO INTERNO, con fecha.
 *
 * Cerrar el mes termina en dos envíos a «Cuentas Imperium»: la cuenta de proveedores externos de
 * los clientes y la de los vendedores. Los dos son a mano y los dos se olvidan.
 *
 * Sin este registro el paso del cierre no puede contestar si ya salió, y un paso que no sabe su
 * propio estado no sirve: o se manda dos veces o no se manda ninguna. Guarda lo mínimo para poder
 * decirlo — cuándo, a qué grupo, cuántos renglones y cuánto sumaban — no el mensaje entero.
 *
 * Mandar de nuevo NO es un error: se pisa la fila, sube `veces` y queda la última fecha. Un mes se
 * corrige y se vuelve a mandar; lo que importa es cuándo salió lo último.
 */
const { db } = require('./db');

const nowISO = () => new Date().toISOString();
const M = (x) => String(x || '').slice(0, 7);
const QUE = ['externos', 'vendedores'];

function _fila(r) {
  if (!r) return null;
  return { mes: r.mes, que: r.que, chat: r.chat || null, cantidad: r.cantidad || 0,
    total_usdt: r.total_usdt || '0', at: r.at, quien: r.quien || null, veces: r.veces || 1 };
}

/** Qué se mandó de un mes: { externos: {...}|null, vendedores: {...}|null }. */
function delMes(mes) {
  const out = {};
  QUE.forEach((q) => { out[q] = null; });
  db.prepare('SELECT * FROM envio_interno WHERE mes=?').all(M(mes))
    .forEach((r) => { out[r.que] = _fila(r); });
  return out;
}

function get(mes, que) {
  return _fila(db.prepare('SELECT * FROM envio_interno WHERE mes=? AND que=?').get(M(mes), String(que)));
}

/** Deja anotado que salió. Devuelve la fila como quedó. */
function marcar({ mes, que, chat, cantidad, total_usdt, quien }) {
  const m = M(mes); const q = String(que);
  if (!/^\d{4}-\d{2}$/.test(m)) return { ok: false, error: 'mes inválido' };
  if (!QUE.includes(q)) return { ok: false, error: `no sé qué es "${q}"` };
  const ya = get(m, q);
  db.prepare(`INSERT INTO envio_interno (mes, que, chat, cantidad, total_usdt, at, quien, veces)
    VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(mes, que) DO UPDATE SET chat=excluded.chat, cantidad=excluded.cantidad,
      total_usdt=excluded.total_usdt, at=excluded.at, quien=excluded.quien, veces=envio_interno.veces+1`)
    .run(m, q, String(chat || ''), Number(cantidad || 0), String(total_usdt || '0'), nowISO(), String(quien || 'admin'), 1);
  return { ok: true, envio: get(m, q), yaHabiaSalido: !!ya };
}

module.exports = { delMes, get, marcar, QUE };
