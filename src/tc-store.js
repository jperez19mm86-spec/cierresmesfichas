/**
 * tc-store.js — tipos de cambio (sección 3.3 + tablas TC_SNAPSHOTS / TC_MES).
 *  - tc_snapshots: 1 fila por consulta (cron diario 18:00). fuente = criptoya/binance.
 *  - tc_mes: tc_cliente = promedio de los snapshots del mes (auto); tc_proveedor_ext = factura (manual);
 *    diferencia_tc = proveedor_ext - cliente (pérdida/ganancia empresa).
 */
const crypto = require('crypto');
const { db } = require('./db');
const money = require('./lib/money');
const { fechaTZ, horaTZ, nowISO, mesDe } = require('./lib/fechas');

const newId = (p) => p + '_' + crypto.randomBytes(5).toString('hex');

function get(id) { return db.prepare('SELECT * FROM tc_snapshots WHERE id=?').get(id) || null; }

function addSnapshot({ tc_ars_usdt, fuente, fecha, hora }) {
  const f = fecha || fechaTZ(), h = hora || horaTZ();
  const id = newId('snap');
  db.prepare('INSERT INTO tc_snapshots (id,fecha,hora,tc_ars_usdt,fuente,createdAt) VALUES (?,?,?,?,?,?)')
    .run(id, f, h, money.round(tc_ars_usdt, 4), fuente || 'criptoya', nowISO());
  recomputeMes(mesDe(f));
  return get(id);
}

function listSnapshots(mes) {
  if (mes) return db.prepare("SELECT * FROM tc_snapshots WHERE substr(fecha,1,7)=? ORDER BY fecha DESC, hora DESC").all(mes);
  return db.prepare('SELECT * FROM tc_snapshots ORDER BY fecha DESC, hora DESC LIMIT 200').all();
}

/** Último TC conocido (para el equivalente USDT en tiempo real si falla la API). */
function ultimoTC() {
  const r = db.prepare('SELECT tc_ars_usdt FROM tc_snapshots ORDER BY fecha DESC, hora DESC LIMIT 1').get();
  return r ? r.tc_ars_usdt : null;
}

function promedioMes(mes) {
  const rows = db.prepare("SELECT tc_ars_usdt FROM tc_snapshots WHERE substr(fecha,1,7)=?").all(mes);
  if (!rows.length) return null;
  return money.round(money.div(money.sum(rows.map((r) => r.tc_ars_usdt)), String(rows.length)), 4);
}

function getMes(mes) { return db.prepare('SELECT * FROM tc_mes WHERE mes=?').get(mes) || null; }
function listMeses() { return db.prepare('SELECT * FROM tc_mes ORDER BY mes DESC').all(); }

/** Recalcula tc_cliente (promedio) y la diferencia, preservando el tc_proveedor_ext manual. */
function recomputeMes(mes) {
  const prom = promedioMes(mes);
  const cur = getMes(mes) || {};
  const tcProv = cur.tc_proveedor_ext || null;
  const dif = (tcProv && prom) ? money.sub(tcProv, prom) : null;
  db.prepare(`INSERT INTO tc_mes (mes,tc_cliente,tc_proveedor_ext,diferencia_tc,cerrado,updatedAt)
    VALUES (?,?,?,?,?,?)
    ON CONFLICT(mes) DO UPDATE SET tc_cliente=excluded.tc_cliente, diferencia_tc=excluded.diferencia_tc, updatedAt=excluded.updatedAt`)
    .run(mes, prom, tcProv, dif, cur.cerrado ? 1 : 0, nowISO());
  return getMes(mes);
}

/** Ingreso manual del TC de factura del proveedor externo → cierra el mes. */
function setTcProveedor(mes, tc_proveedor_ext) {
  const prom = promedioMes(mes);
  const tp = money.round(tc_proveedor_ext, 4);
  const dif = prom ? money.sub(tp, prom) : null;
  db.prepare(`INSERT INTO tc_mes (mes,tc_cliente,tc_proveedor_ext,diferencia_tc,cerrado,updatedAt)
    VALUES (?,?,?,?,1,?)
    ON CONFLICT(mes) DO UPDATE SET tc_proveedor_ext=excluded.tc_proveedor_ext, tc_cliente=excluded.tc_cliente, diferencia_tc=excluded.diferencia_tc, cerrado=1, updatedAt=excluded.updatedAt`)
    .run(mes, prom, tp, dif, nowISO());
  return getMes(mes);
}

module.exports = { get, addSnapshot, listSnapshots, ultimoTC, promedioMes, getMes, listMeses, recomputeMes, setTcProveedor };
