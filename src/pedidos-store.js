/**
 * pedidos-store.js — almacenamiento local (JSON) de los PEDIDOS de carga.
 *
 * Flujo: el cliente arma un pedido (vista cliente) → queda 'pendiente' → el admin lo Carga o Rechaza.
 *   - Cargar  → se ejecuta la carga real en el casino (area=balance) → estado 'cargado'.
 *   - Rechazar → estado 'rechazado'.
 * Los resueltos quedan en el "historial" (filtrable por cliente / estado).
 *
 * Pedido = {
 *   id, codigo, clienteNombre, cajaId, cajaUsuario, sistema, userId, divisa, monto,
 *   estado: 'pendiente'|'cargado'|'rechazado'|'anulado', createdAt, resueltoAt, newBalance, error
 *   ('anulado' = una carga que se revirtió: se retiró el monto del casino, ej. carga a usuario equivocado)
 * }
 * Se guarda en data/pedidos.json (gitignored).
 */
const crypto = require('crypto');
const { db } = require('./db');

const FILE = 'sqlite:pedidos'; // compat (ya no es un archivo)

function load() {
  const pedidos = db.prepare('SELECT data FROM pedidos ORDER BY ord ASC').all().map((r) => {
    try { return JSON.parse(r.data); } catch (e) { return null; }
  }).filter(Boolean);
  return { pedidos };
}

const _saveTx = db.transaction((data) => {
  db.prepare('DELETE FROM pedidos').run();
  const ins = db.prepare('INSERT INTO pedidos (id,data,ord) VALUES (@id,@data,@ord)');
  (data.pedidos || []).forEach((p, i) => ins.run({ id: p.id, data: JSON.stringify(p), ord: i }));
});
function save(data) { _saveTx(data); }

function create(p) {
  const data = load();
  const pedido = {
    id: 'p_' + crypto.randomBytes(5).toString('hex'),
    codigo: String(p.codigo || '').trim(),
    clienteNombre: String(p.clienteNombre || '').trim(),
    cajaId: String(p.cajaId || '').trim(),
    cajaUsuario: String(p.cajaUsuario || '').trim(),
    sistema: String(p.sistema || '').trim(),
    userId: String(p.userId || '').trim(),
    divisa: String(p.divisa || 'ARS').trim(),
    monto: Number(p.monto) || 0,
    estado: 'pendiente',
    createdAt: new Date().toISOString(),
    resueltoAt: null,
    newBalance: null,
    error: null,
  };
  data.pedidos.unshift(pedido);
  save(data);
  return pedido;
}

function get(id) { return load().pedidos.find((p) => p.id === id) || null; }

/** Cambia estado de un pedido (cargado/rechazado) + extra (newBalance/error). */
function setEstado(id, estado, extra = {}) {
  const data = load();
  const p = data.pedidos.find((x) => x.id === id);
  if (!p) return null;
  p.estado = estado;
  p.resueltoAt = new Date().toISOString();
  if (extra.newBalance !== undefined) p.newBalance = extra.newBalance;
  if (extra.error !== undefined) p.error = extra.error;
  if (extra.cascada !== undefined) p.cascada = extra.cascada;
  if (extra.trabadoEn !== undefined) p.trabadoEn = extra.trabadoEn;
  save(data);
  return p;
}

/**
 * Guarda el avance de la cascada SIN tocar el estado: el pedido sigue 'pendiente' para poder
 * RETOMARLO. Es lo que permite que volver a apretar "Cargar" no repita los pasos ya hechos.
 */
function setCascada(id, cascada, trabadoEn) {
  const data = load();
  const p = data.pedidos.find((x) => x.id === id);
  if (!p) return null;
  p.cascada = cascada;
  p.trabadoEn = trabadoEn || null;
  save(data);
  return p;
}

/** LOCK atómico para anular: si el pedido está 'cargado' lo pasa a 'anulando' y lo devuelve; si no, null.
 *  Es SINCRÓNICO (better-sqlite3) → corre entero sin interleave → previene doble-retiro concurrente.
 *  NO toca resueltoAt/newBalance (así el rollback preserva los datos de la carga original). */
function tomarParaAnular(id) {
  const data = load();
  const p = data.pedidos.find((x) => x.id === id);
  if (!p || p.estado !== 'cargado') return null;
  p.estado = 'anulando';
  save(data);
  return { ...p };
}
/** Rollback del lock: 'anulando' → 'cargado' (si el retiro en el casino no se hizo). Preserva los datos. */
function revertirAnulando(id) {
  const data = load();
  const p = data.pedidos.find((x) => x.id === id);
  if (!p || p.estado !== 'anulando') return null;
  p.estado = 'cargado';
  save(data);
  return p;
}

/** Lista con filtros opcionales: { estado, codigo }. */
function list(filters = {}) {
  let arr = load().pedidos;
  if (filters.estado) arr = arr.filter((p) => p.estado === filters.estado);
  if (filters.codigo) arr = arr.filter((p) => String(p.codigo).toLowerCase() === String(filters.codigo).toLowerCase());
  return arr;
}

function counts() {
  const arr = load().pedidos;
  return {
    pendientes: arr.filter((p) => p.estado === 'pendiente').length,
    cargados: arr.filter((p) => p.estado === 'cargado').length,
    rechazados: arr.filter((p) => p.estado === 'rechazado').length,
    anulados: arr.filter((p) => p.estado === 'anulado').length,
    anulando: arr.filter((p) => p.estado === 'anulando').length,
    total: arr.length,
  };
}

/** VENTAS DE FICHAS de un mes = pedidos CARGADOS (compra prepaga) agrupados por código de cliente.
 *  Esta es la BASE real de facturación (el % se cobra sobre lo vendido, no sobre el `in` de jugadores).
 *  Devuelve { [codigo]: { monto, count, porUserId:{userId:monto}, porDivisa:{divisa:monto} } }.
 *  La fecha del mes se toma de resueltoAt (cuándo se cargó) y si falta, createdAt. */
function ventasCargadasMes(mes) {
  const arr = load().pedidos.filter((p) => p.estado === 'cargado');
  const out = {};
  for (const p of arr) {
    const f = String(p.resueltoAt || p.createdAt || '').slice(0, 7);
    if (mes && f !== mes) continue;
    const cod = String(p.codigo || '—');
    const o = out[cod] = out[cod] || { monto: 0, count: 0, porUserId: {}, porDivisa: {} };
    const m = Number(p.monto) || 0;
    o.monto += m; o.count += 1;
    const uid = String(p.userId || '');
    o.porUserId[uid] = (o.porUserId[uid] || 0) + m;
    const dv = p.divisa || 'ARS';
    o.porDivisa[dv] = (o.porDivisa[dv] || 0) + m;
  }
  return out;
}

/**
 * ⭐ LO QUE SE LE COBRA A CADA CLIENTE EN UN MES.
 *
 * Decisión del dueño: manda lo VENDIDO por el sistema de pedidos, no el `in` que reporta el casino.
 * Son dos números distintos por diseño (hay cargas hechas por fuera, bonos, movimientos internos),
 * y el que factura es este.
 *
 * Diferencias con `ventasCargadasMes`, que se queda solo para el reparto viejo:
 *   · `monto` NO se usa para facturar: mezcla pesos con guaraníes y no significa nada. Lo que sirve
 *     es `porDivisa`, y cada moneda se pasa a USDT con SU tipo de cambio.
 *   · Los pedidos en 'anulando' se informan APARTE: las fichas ya están en el casino pero todavía no
 *     se confirmó que volvieran. Ni contarlos en silencio ni descartarlos en silencio.
 *
 * El mes sale de `resueltoAt` (cuándo se cargó de verdad) y si falta, de `createdAt`.
 */
function ventasDelMes(mes) {
  const out = {};
  const suma = (cod) => (out[cod] = out[cod] || {
    count: 0, porDivisa: {}, porUserId: {},
    anulando: { count: 0, porDivisa: {} },
  });
  for (const p of load().pedidos) {
    if (p.estado !== 'cargado' && p.estado !== 'anulando') continue;
    const f = String(p.resueltoAt || p.createdAt || '').slice(0, 7);
    if (mes && f !== mes) continue;
    const o = suma(String(p.codigo || '—'));
    const m = Number(p.monto) || 0;
    const dv = String(p.divisa || 'ARS').toUpperCase();
    if (p.estado === 'anulando') {
      o.anulando.count += 1;
      o.anulando.porDivisa[dv] = (o.anulando.porDivisa[dv] || 0) + m;
      continue;
    }
    o.count += 1;
    o.porDivisa[dv] = (o.porDivisa[dv] || 0) + m;
    const uid = String(p.userId || '');
    if (uid) o.porUserId[uid] = (o.porUserId[uid] || 0) + m;
  }
  return out;
}

/**
 * Borra un pedido. Para sacar los que se sembraron de prueba o los que se crearon por error.
 *
 * Es acotado a propósito: los pedidos son la base de lo que se le cobra a cada cliente, así que
 * borrar uno CAMBIA la facturación del mes. Devuelve el pedido borrado para poder dejar rastro.
 */
function remove(id) {
  const data = load();
  const i = data.pedidos.findIndex((p) => p.id === String(id));
  if (i < 0) return { ok: false, error: 'no existe ese pedido' };
  const [p] = data.pedidos.splice(i, 1);
  save(data);
  return { ok: true, pedido: p };
}

module.exports = { create, get, setEstado, setCascada, tomarParaAnular, revertirAnulando, list, counts, ventasCargadasMes, ventasDelMes, remove, seed: save, FILE };
