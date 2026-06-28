/**
 * movimientos-store.js — el LIBRO MAYOR (sección 7, tabla MOVIMIENTOS).
 * Toda plata que entra/sale o se cobra es un movimiento. La cuenta corriente y los reportes
 * se derivan de acá (no hay tabla de "saldo" — es una vista sobre movimientos; ver deuda.service).
 *
 * tipo: carga | pago | proveedor_extra | ajuste | correccion | bonificacion
 * Cada movimiento guarda el tc_momento y el base_pct_aplicado (snapshot) → reproducible.
 */
const crypto = require('crypto');
const { db } = require('./db');
const { nowISO } = require('./lib/fechas');

const TIPOS = ['carga', 'pago', 'proveedor_extra', 'ajuste', 'correccion', 'bonificacion'];
const newId = () => 'mov_' + crypto.randomBytes(6).toString('hex');
const S = (x) => (x === null || x === undefined ? null : String(x));

function create(d) {
  if (!TIPOS.includes(d.tipo)) throw new Error(`tipo de movimiento inválido: ${d.tipo}`);
  const id = newId();
  const ord = db.prepare('SELECT COUNT(*) c FROM movimientos').get().c;
  db.prepare(`INSERT INTO movimientos
    (id,cliente_id,panel_id,proveedor_id,pedido_id,tipo,monto_ars,monto_usdt,tc_momento,base_pct_aplicado,divisa,fecha,usuario_id,notas,createdAt,ord)
    VALUES (@id,@cli,@pan,@prov,@ped,@tipo,@mars,@musdt,@tc,@base,@div,@fecha,@uid,@notas,@ca,@ord)`).run({
    id, cli: d.cliente_id || null, pan: d.panel_id || null, prov: d.proveedor_id || null, ped: d.pedido_id || null,
    tipo: d.tipo, mars: S(d.monto_ars), musdt: S(d.monto_usdt), tc: S(d.tc_momento), base: S(d.base_pct_aplicado),
    div: d.divisa || 'ARS', fecha: d.fecha || nowISO(), uid: d.usuario_id || null, notas: d.notas || '', ca: nowISO(), ord,
  });
  return get(id);
}

function get(id) { return db.prepare('SELECT * FROM movimientos WHERE id=?').get(id) || null; }

function list(filters = {}) {
  const w = [], p = [];
  if (filters.cliente_id) { w.push('cliente_id=?'); p.push(filters.cliente_id); }
  if (filters.panel_id) { w.push('panel_id=?'); p.push(filters.panel_id); }
  if (filters.tipo) { w.push('tipo=?'); p.push(filters.tipo); }
  if (filters.mes) { w.push('substr(fecha,1,7)=?'); p.push(filters.mes); }
  const sql = 'SELECT * FROM movimientos' + (w.length ? ' WHERE ' + w.join(' AND ') : '') + ' ORDER BY fecha DESC';
  return db.prepare(sql).all(...p);
}

function remove(id) { return db.prepare('DELETE FROM movimientos WHERE id=?').run(id).changes > 0; }

module.exports = { TIPOS, create, get, list, remove };
