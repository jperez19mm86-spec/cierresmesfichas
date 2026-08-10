/**
 * documentos.js — EL ARCHIVO DE LO QUE SE ENVIÓ.
 *
 * Guarda una copia congelada de un documento en el momento exacto en que se emitió, para poder
 * volver a abrirlo meses después y ver lo mismo que vio el que lo recibió.
 *
 * ── POR QUÉ NO ALCANZA CON VOLVER A CALCULARLO ───────────────────────────────────────────────
 * Entre agosto y diciembre pueden pasar tres cosas, todas legítimas: se carga el % de costo de un
 * proveedor que faltaba, se corrige un tipo de cambio, se descongela y recongela un mes. Cualquiera
 * de las tres cambia el número. El reporte recalculado seguiría estando bien — pero ya no sería EL
 * DOCUMENTO QUE SE ENVIÓ, y no habría manera de saber cuál de los dos vio el proveedor.
 *
 * Por eso se guardan los BYTES del HTML y no una receta para volver a armarlo: si el generador
 * cambia —y va a cambiar— este archivo no se entera. El JSON va al lado, para poder auditar de
 * dónde salió cada número y para el CSV, que es una proyección del mismo dato y no otro documento.
 *
 * ── SÓLO AGREGA ──────────────────────────────────────────────────────────────────────────────
 * No hay editar ni borrar, a propósito. Emitir de nuevo el mismo mes crea la VERSIÓN 2 y deja la 1
 * intacta: pisar la copia de lo que ya se mandó es justo lo que este archivo existe para impedir.
 * Si se emitió con un error, se emite otra y quedan las dos — el error también es parte de lo que
 * pasó, y saber que hubo dos versiones es más útil que un archivo prolijo que miente.
 *
 * ⚠️ El hash es sha256 del HTML tal como quedó guardado. Sirve para probar que el archivo no se
 * tocó desde adentro de la base; no es una firma y no prueba quién lo emitió.
 */
const crypto = require('crypto');
const { db } = require('./db');

const nowISO = () => new Date().toISOString();
const sha = (s) => crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');

/** Las columnas que se listan: todo menos los archivos, que son cientos de KB cada uno. */
const CAMPOS = 'id, tipo, mes, version, emitido_at, emitido_por, total_usdt, hash, nota, congelado, datos_hash';

/**
 * Congela un documento. `render(emision)` recibe {id, version, emitido_at, emitido_por} y devuelve
 * el HTML — así el sello de emisión queda DENTRO del documento y no en una etiqueta al costado que
 * se puede perder al imprimir.
 */
function emitir({ tipo, mes, datos, render, csv = null, por, nota, congelado = null }) {
  const t = String(tipo || '').trim();
  const m = String(mes || '').slice(0, 7);
  if (!t) return { ok: false, error: 'falta el tipo de documento' };
  if (!/^\d{4}-\d{2}$/.test(m)) return { ok: false, error: 'mes inválido (se espera YYYY-MM)' };
  if (typeof render !== 'function') return { ok: false, error: 'falta cómo armar el documento' };

  // ── NO SE CREAN VERSIONES GEMELAS ────────────────────────────────────────────────────────────
  // Dos clics seguidos, o emitir tres días seguidos sin que haya entrado nada nuevo, no son tres
  // documentos: son el mismo. Se compara el JSON —el contenido— y no el HTML, porque el HTML lleva
  // adentro el sello con el id y la fecha, así que dos renders nunca son iguales byte a byte.
  const json = JSON.stringify(datos == null ? {} : datos);
  const datos_hash = sha(json);
  const ultimo = db.prepare(`SELECT id, datos_hash FROM documento_emitido
    WHERE tipo=? AND mes=? ORDER BY version DESC LIMIT 1`).get(t, m);
  if (ultimo && ultimo.datos_hash === datos_hash) {
    return { ok: true, documento: get(ultimo.id), yaEstaba: true };
  }

  const prev = db.prepare('SELECT MAX(version) v FROM documento_emitido WHERE tipo=? AND mes=?').get(t, m);
  const version = Number(prev && prev.v ? prev.v : 0) + 1;
  const id = 'd_' + crypto.randomBytes(6).toString('hex');
  const emitido_at = nowISO();
  const emision = { id, tipo: t, mes: m, version, emitido_at, emitido_por: por || 'admin' };

  let html;
  try { html = String(render(emision)); }
  catch (e) { return { ok: false, error: `no se pudo armar el documento — ${String((e && e.message) || e)}` }; }
  if (!html.trim()) return { ok: false, error: 'el documento salió vacío: no se emite' };

  const total = datos && datos.cuadre ? String(datos.cuadre.proveedores)
    : (datos && datos.totales ? String(datos.totales.usdt) : null);

  // El CSV se guarda y no se regenera al bajarlo: csv() puede ganar una columna el año que viene, y
  // ahí la planilla de un mes viejo se corre sola y la conciliación contra el proveedor deja de dar.
  db.prepare(`INSERT INTO documento_emitido
    (id, tipo, mes, version, emitido_at, emitido_por, total_usdt, hash, html, datos, nota, congelado, datos_hash, csv)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, t, m, version, emitido_at, emision.emitido_por, total, sha(html), html, json,
      String(nota || '').trim() || null, congelado == null ? null : (congelado ? 1 : 0),
      datos_hash, csv == null ? null : String(csv));

  return { ok: true, documento: get(id) };
}

/** La ficha de un documento, sin el contenido. */
function get(id) {
  return db.prepare(`SELECT ${CAMPOS} FROM documento_emitido WHERE id=?`).get(String(id || '')) || null;
}

/**
 * El documento entero: html, datos y la verificación del hash.
 *
 * `intacto` se recalcula en cada lectura en vez de confiar en la columna. Es barato (un sha256 de
 * unos cientos de KB) y es lo único que convierte al hash en una comprobación de verdad: guardado
 * y nunca vuelto a mirar, sería un adorno.
 */
function contenido(id) {
  const r = db.prepare('SELECT * FROM documento_emitido WHERE id=?').get(String(id || ''));
  if (!r) return null;
  let datos = null;
  try { datos = JSON.parse(r.datos); } catch (e) { datos = null; }
  return { ...r, datos, intacto: sha(r.html) === r.hash };
}

/** Los documentos emitidos, del más nuevo al más viejo. */
function list({ tipo = null, mes = null, limite = 200 } = {}) {
  const cond = []; const args = [];
  if (tipo) { cond.push('tipo=?'); args.push(String(tipo)); }
  if (mes) { cond.push('mes=?'); args.push(String(mes).slice(0, 7)); }
  const w = cond.length ? ` WHERE ${cond.join(' AND ')}` : '';
  return db.prepare(`SELECT ${CAMPOS} FROM documento_emitido${w}
    ORDER BY emitido_at DESC, version DESC LIMIT ?`).all(...args, Number(limite) || 200);
}

/** Cuántas versiones tiene ya un mes. La pantalla lo usa para avisar antes de emitir de nuevo. */
function versiones(tipo, mes) {
  return db.prepare('SELECT COUNT(*) c FROM documento_emitido WHERE tipo=? AND mes=?')
    .get(String(tipo || ''), String(mes || '').slice(0, 7)).c;
}

module.exports = { emitir, get, contenido, list, versiones };
