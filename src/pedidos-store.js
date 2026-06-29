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
 *   estado: 'pendiente'|'cargado'|'rechazado', createdAt, resueltoAt, newBalance, error
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

module.exports = { create, get, setEstado, list, counts, ventasCargadasMes, seed: save, FILE };
