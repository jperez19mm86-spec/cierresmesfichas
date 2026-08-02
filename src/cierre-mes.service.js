/**
 * cierre-mes.service.js — CONGELAR la matriz de un mes.
 *
 * POR QUÉ: los precios cambian, tanto el costo de los proveedores como el % de cada cliente.
 * La matriz es UNA SOLA foto, así que tocar un precio hoy cambiaba lo que calculaba para
 * CUALQUIER mes pasado — un mes ya facturado dejaba de poder reproducirse ni auditarse.
 * (Pasó de verdad: al subir 89 celdas, junio dejó de dar los 7.032 USDT que coincidían con el PDF.)
 *
 * CÓMO: al cerrar un mes se guarda una foto de la matriz completa (costos + celdas). A partir de
 * ahí, el reporte de ESE mes usa la foto y no la matriz viva. Los meses sin foto usan la actual.
 */
const { db } = require('./db');
const cierre = require('./cierre-store');

/** La foto de un mes, o null. */
function get(mes) {
  const r = db.prepare('SELECT mes, datos, createdAt, notas FROM cierre_mes_snapshot WHERE mes=?').get(String(mes));
  if (!r) return null;
  try { return { mes: r.mes, createdAt: r.createdAt, notas: r.notas, ...JSON.parse(r.datos) }; }
  catch (e) { return null; }
}

function listar() {
  return db.prepare('SELECT mes, createdAt, notas, length(datos) bytes FROM cierre_mes_snapshot ORDER BY mes DESC').all();
}

/**
 * Congela el mes con la matriz que está viva AHORA (o con una que se pase, para reconstruir un
 * mes con precios viejos a partir de un respaldo).
 */
function congelar(mes, { notas = '', matriz = null, pisar = false } = {}) {
  const m = String(mes || '').trim();
  if (!m) return { ok: false, error: 'falta el mes' };
  if (!pisar && get(m)) return { ok: false, error: `${m} ya está congelado — usá pisar:true si querés reemplazarlo`, yaExiste: true };
  const datos = matriz || cierre.getMatriz();
  // Los VÍNCULOS casino→matriz también se congelan: si después se agregan proveedores, un nombre
  // del casino podría resolverse distinto y el mes ya cerrado cambiaría de número.
  const links = db.prepare('SELECT casino, matriz FROM cierre_link').all();
  const payload = JSON.stringify({ proveedores: datos.proveedores || [], celdas: datos.celdas || {}, clientes: datos.clientes || [], links });
  db.prepare(`INSERT INTO cierre_mes_snapshot (mes,datos,createdAt,notas) VALUES (?,?,?,?)
              ON CONFLICT(mes) DO UPDATE SET datos=excluded.datos, createdAt=excluded.createdAt, notas=excluded.notas`)
    .run(m, payload, new Date().toISOString(), String(notas || ''));
  const g = get(m);
  return { ok: true, mes: m, proveedores: (g.proveedores || []).length, celdas: Object.keys(g.celdas || {}).length };
}

function descongelar(mes) {
  const n = db.prepare('DELETE FROM cierre_mes_snapshot WHERE mes=?').run(String(mes)).changes;
  return { ok: n > 0, borrado: n > 0 };
}

/**
 * Los precios que rigen para un mes: la foto si está congelado, la matriz viva si no.
 * @returns { congelado, costo:{proveedor:costo}, celdas:{proveedor:{cliente:pct}} }
 */
function preciosDe(mes) {
  const snap = get(mes);
  const datos = snap || cierre.getMatriz();
  const costo = {};
  (datos.proveedores || []).forEach((p) => { costo[p.nombre] = p.base_pct; });
  return { congelado: !!snap, congeladoEn: snap ? snap.createdAt : null, costo, celdas: datos.celdas || {}, links: snap ? (snap.links || null) : null };
}

module.exports = { get, listar, congelar, descongelar, preciosDe };
