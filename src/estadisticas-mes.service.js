/**
 * estadisticas-mes.service.js — LA FOTO DEL MES: se le pregunta al casino UNA VEZ y queda guardada.
 *
 * EL PROBLEMA: cada reporte de proveedores externos le preguntaba al casino en vivo, panel por panel
 * y divisa por divisa. Para toda la flota son 525 consultas, y el casino tarda entre 2 y 16 segundos
 * en cada una. Sacar el reporte de un cliente con 9 paneles multidivisa no llegaba a terminar nunca.
 *
 * LA IDEA (del dueño): un mes cerrado YA NO CAMBIA. Entonces se le pregunta una sola vez, a principio
 * del mes siguiente, y se guarda. Después armar el reporte de Titán, de Juan, de Alexa o de quien sea
 * es leer la base — instantáneo, y sin depender de que el casino esté arriba.
 *
 * LO QUE LO HACE POSIBLE: el reporte agrupado por superagente devuelve TODOS los nodos en UNA sola
 * consulta. Verificado contra producción: una consulta de 2,9 s trajo 951 filas cubriendo 39 nodos, y
 * comparado nodo por nodo con la consulta individual dio EXACTAMENTE lo mismo — 11 proveedores,
 * 11 coincidencias, total 480.187,11 contra 480.187,11, diferencia 0,00.
 *
 *   antes:  525 consultas, en CADA reporte
 *   ahora:  1 consulta por (conexión × divisa × agrupación), UNA VEZ POR MES
 *
 * TRES AGRUPACIONES, no una: los paneles no son todos superagentes (hay 141 superagentes, 67
 * distribuidores y 3 agentes). Un distribuidor no aparece como fila propia en la agrupación por
 * superagente — sus números están sumados dentro de su superagente. Por eso se saca una foto por
 * cada nivel y cada panel lee la que le corresponde.
 *
 * ⚠️ NUNCA se suman dos agrupaciones entre sí: son la misma plata contada de dos formas.
 */
const { db } = require('./db');
const nowISO = () => new Date().toISOString();
const paneles = require('./paneles-store');
const casinoConex = require('./casino-conexiones-store');

const K = (s) => String(s || '').trim();
const GRUPOS = ['superagent', 'distributor', 'agent'];

/** El nivel del panel dice de qué foto tiene que leer. */
const GRUPO_DE_NIVEL = { SuperAgente: 'superagent', Distribuidor: 'distributor', Agente: 'agent' };
function grupoDe(panel) {
  return GRUPO_DE_NIVEL[panel && panel.nivel_usuario] || 'superagent';
}

/** Primer y último día del mes, con hora: el motor del casino descarta la fecha pelada. */
function rango(mes) {
  const [y, m] = String(mes).split('-').map(Number);
  const ult = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${mes}-01 00:00:00`, to: `${mes}-${String(ult).padStart(2, '0')} 23:59:59` };
}

/**
 * Las divisas que hay que sacar de una conexión: las de sus paneles.
 * No se piden las 36 del catálogo porque la mayoría no tiene un peso de movimiento y cada una es
 * una consulta más.
 */
function divisasDe(conexionId) {
  const s = new Set(['ARS']);
  paneles.list().filter((p) => p.conexion_id === conexionId)
    .forEach((p) => (p.divisas || []).forEach((d) => { if (d) s.add(String(d).toUpperCase()); }));
  return [...s].sort();
}

/** Las agrupaciones que hacen falta para una conexión: solo los niveles que tiene de verdad. */
function gruposDe(conexionId) {
  const s = new Set();
  paneles.list().filter((p) => p.conexion_id === conexionId).forEach((p) => s.add(grupoDe(p)));
  return GRUPOS.filter((g) => s.has(g));
}

/** Qué hay que sacar para un mes: la lista completa de consultas. */
function plan(mes, { conexionId = null } = {}) {
  const cxs = casinoConex.list().filter((c) => !conexionId || c.id === conexionId);
  const out = [];
  for (const cx of cxs) {
    for (const divisa of divisasDe(cx.id)) {
      for (const grupo of gruposDe(cx.id)) out.push({ conexion_id: cx.id, conexion: cx.nombre, mes, divisa, grupo });
    }
  }
  return out;
}

// ── guardado ────────────────────────────────────────────────────────────────

function _guardar(t, filas) {
  const del = db.prepare('DELETE FROM estad_mes WHERE conexion_id=? AND mes=? AND divisa=? AND grupo=?');
  const ins = db.prepare(`INSERT INTO estad_mes
    (id, conexion_id, mes, divisa, grupo, nodo_id, nodo_login, provider, label, vendor, bet, win, profit, capturado_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const at = nowISO();
  // Una transacción: o queda la foto entera de esa combinación, o no queda nada. Una foto a medias
  // es peor que ninguna, porque parece completa.
  const tx = db.transaction(() => {
    del.run(t.conexion_id, t.mes, t.divisa, t.grupo);
    let n = 0;
    for (const f of filas) {
      const nodo = K(f.saId);
      if (!nodo) continue;                       // fila sin nodo: no se le puede atribuir a nadie
      const id = [t.conexion_id, t.mes, t.divisa, t.grupo, nodo, f.provider, f.label, f.vendor].join('|');
      ins.run(id, t.conexion_id, t.mes, t.divisa, t.grupo, nodo, K(f.saLogin),
        K(f.provider), K(f.label), K(f.vendor),
        String(f.bet == null ? '' : f.bet), String(f.win == null ? '' : f.win), String(f.profit == null ? '' : f.profit), at);
      n++;
    }
    return n;
  });
  return tx();
}

function _marcar(t, { estado, filas = 0, nodos = 0, error = null, segundos = 0 }) {
  db.prepare(`INSERT INTO estad_captura (id, conexion_id, mes, divisa, grupo, estado, filas, nodos, error, segundos, capturado_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?)
              ON CONFLICT(id) DO UPDATE SET estado=excluded.estado, filas=excluded.filas, nodos=excluded.nodos,
                error=excluded.error, segundos=excluded.segundos, capturado_at=excluded.capturado_at`)
    .run([t.conexion_id, t.mes, t.divisa, t.grupo].join('|'), t.conexion_id, t.mes, t.divisa, t.grupo,
      estado, filas, nodos, error, segundos, nowISO());
}

function captura(conexionId, mes, divisa, grupo) {
  return db.prepare('SELECT * FROM estad_captura WHERE id=?')
    .get([conexionId, mes, divisa, grupo].join('|')) || null;
}

// ── sacar la foto ───────────────────────────────────────────────────────────

/**
 * Le pregunta al casino y guarda. Serializado POR CONEXIÓN (el motor de reportes tiene estado por
 * sesión y el casino tira abajo la sesión anterior al volver a entrar) y en paralelo entre conexiones.
 * @param onPaso  se llama con cada paso terminado, para poder mostrar el avance
 */
async function capturar({ mes, conexionId = null, refrescar = false, onPaso = null } = {}) {
  const m = String(mes || '').slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(m)) return { ok: false, error: 'mes inválido (se espera YYYY-MM)' };
  const { from, to } = rango(m);
  const pasos = plan(m, { conexionId });
  if (!pasos.length) return { ok: false, error: 'no hay conexiones con paneles para sacar la foto' };

  const porCx = new Map();
  pasos.forEach((p) => { if (!porCx.has(p.conexion_id)) porCx.set(p.conexion_id, []); porCx.get(p.conexion_id).push(p); });

  const hechos = [];
  await Promise.all([...porCx.entries()].map(async ([cxId, lista]) => {
    const cli = casinoConex.client(cxId);         // UNA sesión para toda la conexión
    if (!cli) {
      lista.forEach((t) => { _marcar(t, { estado: 'error', error: 'la conexión no responde' }); hechos.push({ ...t, estado: 'error', error: 'la conexión no responde' }); });
      return;
    }
    for (const t of lista) {
      const ya = captura(cxId, m, t.divisa, t.grupo);
      if (!refrescar && ya && ya.estado === 'ok') { hechos.push({ ...t, estado: 'ya estaba', filas: ya.filas, nodos: ya.nodos }); if (onPaso) onPaso(hechos[hechos.length - 1]); continue; }
      const t0 = Date.now();
      let r;
      try { r = await cli.reporteProveedores({ from, to, currency: t.divisa, userGroupBy: t.grupo }); }
      catch (e) { r = { ok: false, error: String((e && e.message) || e) }; }
      const seg = Number(((Date.now() - t0) / 1000).toFixed(1));
      if (!r.ok) {
        _marcar(t, { estado: 'error', error: r.error, segundos: seg });
        hechos.push({ ...t, estado: 'error', error: r.error, segundos: seg });
      } else {
        const filas = r.filas || [];
        const n = _guardar(t, filas);
        const nodos = new Set(filas.map((f) => K(f.saId)).filter(Boolean)).size;
        _marcar(t, { estado: 'ok', filas: n, nodos, segundos: seg });
        hechos.push({ ...t, estado: 'ok', filas: n, nodos, segundos: seg });
      }
      if (onPaso) onPaso(hechos[hechos.length - 1]);
    }
  }));

  const ok = hechos.filter((h) => h.estado === 'ok' || h.estado === 'ya estaba').length;
  return {
    ok: true, mes: m, consultas: pasos.length, logradas: ok, fallidas: hechos.length - ok,
    filas: hechos.reduce((s, h) => s + (h.filas || 0), 0),
    detalle: hechos,
  };
}

// ── leer la foto ────────────────────────────────────────────────────────────

/**
 * Las filas de un nodo, con la MISMA forma que devuelve el casino, para que quien las use no tenga
 * que enterarse de si salieron de la foto o de una consulta en vivo.
 * Devuelve null si esa combinación todavía no se sacó: eso significa "no sé", que es distinto de
 * "no tuvo movimiento". Nunca hay que tomar el null como cero.
 */
function filasDe({ conexionId, nodoId, mes, divisa, grupo = 'superagent' }) {
  const c = captura(conexionId, String(mes).slice(0, 7), String(divisa).toUpperCase(), grupo);
  if (!c || c.estado !== 'ok') return null;
  const rows = db.prepare(`SELECT nodo_id, nodo_login, provider, label, vendor, bet, win, profit
    FROM estad_mes WHERE conexion_id=? AND mes=? AND divisa=? AND grupo=? AND nodo_id=?`)
    .all(conexionId, String(mes).slice(0, 7), String(divisa).toUpperCase(), grupo, String(nodoId));
  return rows.map((r) => ({
    saId: r.nodo_id, saLogin: r.nodo_login,
    provider: r.provider, label: r.label, vendor: r.vendor,
    bet: Number(r.bet) || 0, win: Number(r.win) || 0, profit: Number(r.profit) || 0,
  }));
}

/** Cómo está la foto de un mes: qué se sacó, qué falta y qué falló. */
function estado(mes) {
  const m = String(mes || '').slice(0, 7);
  const pasos = plan(m);
  const nom = {}; casinoConex.list().forEach((c) => { nom[c.id] = c.nombre; });
  const filas = pasos.map((p) => {
    const c = captura(p.conexion_id, m, p.divisa, p.grupo);
    return {
      conexion: nom[p.conexion_id] || p.conexion_id, conexion_id: p.conexion_id,
      divisa: p.divisa, grupo: p.grupo,
      estado: c ? c.estado : 'falta', filas: c ? c.filas : 0, nodos: c ? c.nodos : 0,
      error: c ? c.error : null, segundos: c ? c.segundos : null, capturado_at: c ? c.capturado_at : null,
    };
  });
  const listas = filas.filter((f) => f.estado === 'ok').length;
  const conError = filas.filter((f) => f.estado === 'error');
  return {
    mes: m, total: filas.length, listas, faltan: filas.filter((f) => f.estado === 'falta').length,
    conError: conError.length, completa: listas === filas.length && filas.length > 0,
    filasGuardadas: db.prepare('SELECT COUNT(*) c FROM estad_mes WHERE mes=?').get(m).c,
    detalle: filas,
  };
}

/** Meses que tienen algo sacado. */
function meses() {
  return db.prepare('SELECT mes, COUNT(*) filas, MAX(capturado_at) ultimo FROM estad_mes GROUP BY mes ORDER BY mes DESC').all();
}

function borrarMes(mes) {
  const m = String(mes || '').slice(0, 7);
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM estad_mes WHERE mes=?').run(m);
    db.prepare('DELETE FROM estad_captura WHERE mes=?').run(m);
  });
  tx();
  return true;
}

module.exports = { capturar, filasDe, estado, meses, plan, divisasDe, gruposDe, grupoDe, captura, borrarMes, rango, GRUPOS };
