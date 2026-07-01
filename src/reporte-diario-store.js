/**
 * reporte-diario-store.js — persistencia del reporte diario acumulado (solapa que se llena día a día).
 * 1 fila por (conexión, fecha, nivel grp, superagente). getMatriz arma la grilla días×superagente desde la DB.
 */
const crypto = require('crypto');
const { db } = require('./db');
const { nowISO } = require('./lib/fechas');

const newId = () => 'rd_' + crypto.randomBytes(6).toString('hex');

// reemplaza las filas de un día PARA UNA MONEDA (idempotente: re-capturar actualiza esa moneda)
const upsertTx = db.transaction((conexion_id, fecha, grp, moneda, filas) => {
  db.prepare('DELETE FROM reporte_diario WHERE conexion_id=? AND fecha=? AND grp=? AND moneda=?').run(conexion_id, fecha, grp, moneda);
  const ins = db.prepare('INSERT INTO reporte_diario (id,conexion_id,fecha,grp,sa_id,login,in_amt,out_amt,profit,moneda,captured_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)');
  (filas || []).forEach((f) => ins.run(newId(), conexion_id, fecha, grp, String(f.id), f.login || '', String(f.in || 0), String(f.out || 0), String(f.profit || 0), moneda, nowISO()));
});
function upsertDia(conexion_id, fecha, grp, moneda, filas) { upsertTx(conexion_id, fecha, grp, moneda, filas); }

/** Arma la matriz {dias, superagentes, matriz, totales} desde un set de filas. */
function build(rows, grp, mes) {
  const saMap = {}, matriz = {}, totales = {}, dias = new Set();
  for (const r of rows) {
    saMap[r.sa_id] = r.login; dias.add(r.fecha);
    (matriz[r.fecha] = matriz[r.fecha] || {})[r.sa_id] = { in: Number(r.in_amt) || 0, out: Number(r.out_amt) || 0, profit: Number(r.profit) || 0 };
  }
  const superagentes = Object.keys(saMap).map((id) => ({ id, login: saMap[id] }));
  superagentes.forEach((s) => { totales[s.id] = { in: 0, out: 0, profit: 0 }; });
  for (const r of rows) { const t = totales[r.sa_id]; t.in += Number(r.in_amt) || 0; t.out += Number(r.out_amt) || 0; t.profit += Number(r.profit) || 0; }
  Object.keys(totales).forEach((id) => { const t = totales[id]; t.rtp = t.in ? (t.out / t.in * 100) : 0; });
  return { mes, group: grp, dias: [...dias].sort(), superagentes, matriz, totales };
}

/** Monedas con data guardada en el mes (para el dropdown "monedas disponibles"). */
function monedasDisponibles(conexion_id, grp, mes) {
  const q = conexion_id
    ? db.prepare("SELECT DISTINCT moneda FROM reporte_diario WHERE conexion_id=? AND grp=? AND substr(fecha,1,7)=? ORDER BY moneda").all(conexion_id, grp, mes)
    : db.prepare("SELECT DISTINCT moneda FROM reporte_diario WHERE grp=? AND substr(fecha,1,7)=? ORDER BY moneda").all(grp, mes);
  const m = q.map((r) => r.moneda || 'ARS');
  return m.length ? m : ['ARS'];
}

/** Matriz acumulada de UNA conexión (días × superagente) + totales + RTP, desde lo GUARDADO, en `moneda`. */
function getMatriz(conexion_id, grp, mes, moneda = 'ARS') {
  const rows = db.prepare('SELECT * FROM reporte_diario WHERE conexion_id=? AND grp=? AND substr(fecha,1,7)=? AND moneda=? ORDER BY fecha ASC, login ASC').all(conexion_id, grp, mes, moneda);
  return { ...build(rows, grp, mes), moneda, monedas: monedasDisponibles(conexion_id, grp, mes) };
}

/** Matriz acumulada de TODAS las conexiones (todos los GOD juntos) para el mes, en `moneda`. */
function getMatrizTodos(grp, mes, moneda = 'ARS') {
  const rows = db.prepare('SELECT * FROM reporte_diario WHERE grp=? AND substr(fecha,1,7)=? AND moneda=? ORDER BY fecha ASC, login ASC').all(grp, mes, moneda);
  return { ...build(rows, grp, mes), moneda, monedas: monedasDisponibles(null, grp, mes) };
}

function fechasCapturadas(conexion_id, grp) {
  return db.prepare('SELECT DISTINCT fecha FROM reporte_diario WHERE conexion_id=? AND grp=? ORDER BY fecha').all(conexion_id, grp).map((r) => r.fecha);
}

/** Filas guardadas de un mes para un set de paneles {conexion_id, grp, sa_id}. Para el Perfil del cliente
 *  (lee del acumulado en vez de consultar el casino en vivo → instantáneo). Devuelve [{sa_id,in_amt,out_amt,profit}]. */
function filasPanelesMes(keys, mes, moneda = 'ARS') {
  if (!keys || !keys.length) return [];
  const byCG = {};
  keys.forEach((k) => { const kk = k.conexion_id + '|' + (k.grp || 'superagent'); (byCG[kk] = byCG[kk] || []).push(String(k.sa_id)); });
  const out = [];
  for (const kk of Object.keys(byCG)) {
    const [cid, grp] = kk.split('|');
    const ids = [...new Set(byCG[kk])];
    const ph = ids.map(() => '?').join(',');
    const rows = db.prepare(`SELECT sa_id, in_amt, out_amt, profit FROM reporte_diario WHERE conexion_id=? AND grp=? AND substr(fecha,1,7)=? AND moneda=? AND sa_id IN (${ph})`).all(cid, grp, mes, moneda, ...ids);
    out.push(...rows);
  }
  return out;
}

module.exports = { upsertDia, getMatriz, getMatrizTodos, monedasDisponibles, fechasCapturadas, filasPanelesMes };
