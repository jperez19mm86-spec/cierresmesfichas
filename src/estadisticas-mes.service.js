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
 *   antes:  525 consultas, EN CADA REPORTE
 *   ahora:  ~130 consultas, UNA VEZ POR MES
 *
 * DOS TIPOS DE CONSULTA:
 *   · MASIVA (una por conexión × divisa): trae de golpe todos los nodos del nivel que el casino
 *     tenga elegido en ESE momento.
 *   · SUELTA (una por panel): para los Distribuidores y Agentes, pidiendo su nodo puntual.
 *
 * ⚠️ EL NIVEL DE LA MASIVA NO SE ELIGE DESDE ACÁ. Es un ajuste guardado en el servidor del casino
 * por cuenta, y solo se cambia a mano en su pantalla (Estadísticas → Agrupar por). Mandar el mismo
 * formulario por HTTP NO lo guarda: probado desde la propia página del casino, el submit nativo sí
 * y un fetch con idéntico cuerpo no.
 *
 * Y los dos niveles son EXCLUYENTES. Verificado sobre junio en Europa:
 *     superagent → 951 filas, 39 nodos: 31 superagentes nuestros, 0 distribuidores
 *     diller     → 2076 filas, 128 nodos: 0 superagentes, 23 distribuidores nuestros
 * Por eso, antes de guardar, se mira en qué modo está y se frena si no coincide: si no, quedarían
 * archivados los números de unos nodos bajo el nombre de otros, sin que nada avise.
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

/**
 * ⚠️ EL REPORTE MASIVO SOLO DEVUELVE SUPERAGENTES.
 * Se probó pidiéndolo con las tres agrupaciones y el casino devolvió EXACTAMENTE lo mismo en las
 * tres (44/44/44 filas, 207/207/207…): el parámetro de agrupación lo ignora. Así que la consulta
 * masiva cubre los superagentes y nada más.
 *
 * Los paneles que son Distribuidor o Agente (70 de 211) igual tienen datos propios — verificado:
 * Alan-E-Costa, un distribuidor, devuelve 24 filas cuando se lo consulta por separado. A esos hay
 * que preguntarles uno por uno, pero es UNA vez por mes y tienen una sola divisa cada uno, así que
 * son ~70 consultas más, no 525.
 */
function gruposDe() { return ['superagent']; }

/** Los paneles que NO son superagente: hay que consultarlos de a uno. */
function panelesSueltos(conexionId) {
  return paneles.list().filter((p) => p.conexion_id === conexionId && p.id_usuario && grupoDe(p) !== 'superagent');
}

/** Qué hay que sacar para un mes: la lista completa de consultas. */
function plan(mes, { conexionId = null } = {}) {
  const cxs = casinoConex.list().filter((c) => !conexionId || c.id === conexionId);
  const out = [];
  for (const cx of cxs) {
    // 1) una consulta masiva por divisa → todos los superagentes de esa conexión
    for (const divisa of divisasDe(cx.id)) {
      out.push({ conexion_id: cx.id, conexion: cx.nombre, mes, divisa, grupo: 'superagent' });
    }
    // 2) los distribuidores y agentes, de a uno y solo en SU divisa
    for (const p of panelesSueltos(cx.id)) {
      const divs = (p.divisas || []).length ? p.divisas : ['ARS'];
      for (const d of divs) {
        out.push({ conexion_id: cx.id, conexion: cx.nombre, mes, divisa: String(d).toUpperCase(), grupo: 'nodo', nodo: String(p.id_usuario), panel: p.nombre });
      }
    }
  }
  return out;
}

// ── guardado ────────────────────────────────────────────────────────────────

function _guardar(t, filasIn) {
  let filas = filasIn;
  const del = t.grupo === 'nodo'
    ? db.prepare('DELETE FROM estad_mes WHERE conexion_id=? AND mes=? AND divisa=? AND grupo=? AND nodo_id=?')
    : db.prepare('DELETE FROM estad_mes WHERE conexion_id=? AND mes=? AND divisa=? AND grupo=?');
  const ins = db.prepare(`INSERT INTO estad_mes
    (id, conexion_id, mes, divisa, grupo, nodo_id, nodo_login, provider, label, vendor, bet, win, profit, capturado_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const at = nowISO();
  // Una transacción: o queda la foto entera de esa combinación, o no queda nada. Una foto a medias
  // es peor que ninguna, porque parece completa.
  // El subárbol devuelve una fila por terminal: se suman por proveedor antes de guardar, si no
  // el mismo proveedor entraría varias veces con la misma clave y se perderían todas menos una.
  if (t.grupo === 'nodo') {
    const acc = {};
    for (const f of filas) {
      const k = `${f.provider}|${f.label}|${f.vendor}`;
      const a = acc[k] || (acc[k] = { saId: String(t.nodo), saLogin: f.saLogin || '', provider: f.provider, label: f.label, vendor: f.vendor, bet: 0, win: 0, profit: 0 });
      a.bet += Number(f.bet) || 0; a.win += Number(f.win) || 0; a.profit += Number(f.profit) || 0;
    }
    filas = Object.values(acc);
  }
  const tx = db.transaction(() => {
    if (t.grupo === 'nodo') del.run(t.conexion_id, t.mes, t.divisa, t.grupo, String(t.nodo));
    else del.run(t.conexion_id, t.mes, t.divisa, t.grupo);
    let n = 0;
    for (const f of filas) {
      // En la consulta suelta las filas vienen del subárbol del nodo y su saId es el de adentro,
      // así que se guardan a nombre del panel que se consultó.
      const nodo = t.grupo === 'nodo' ? String(t.nodo) : K(f.saId);
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
    .run(claveDe(t), t.conexion_id, t.mes, t.divisa, t.grupo,
      estado, filas, nodos, error, segundos, nowISO());
}

/** La clave de una consulta. Las sueltas llevan el nodo: son una foto por panel, no por conexión. */
function claveDe(t) {
  return [t.conexion_id, t.mes, t.divisa, t.grupo, t.grupo === 'nodo' ? t.nodo : ''].join('|');
}
function captura(conexionId, mes, divisa, grupo, nodo = '') {
  return db.prepare('SELECT * FROM estad_captura WHERE id=?')
    .get([conexionId, mes, divisa, grupo, grupo === 'nodo' ? String(nodo) : ''].join('|')) || null;
}

// ── sacar la foto ───────────────────────────────────────────────────────────

/**
 * Le pregunta al casino y guarda. Serializado POR CONEXIÓN (el motor de reportes tiene estado por
 * sesión y el casino tira abajo la sesión anterior al volver a entrar) y en paralelo entre conexiones.
 * @param onPaso  se llama con cada paso terminado, para poder mostrar el avance
 */
/**
 * ⚠️ EN QUÉ MODO ESTÁ LA CUENTA DEL CASINO AHORA MISMO.
 *
 * El casino agrupa el reporte según un ajuste GUARDADO EN SU SERVIDOR por cuenta, y no se puede
 * cambiar desde acá: solo cambiándolo a mano en su pantalla (el <select> hace un submit nativo del
 * formulario, y mandar el mismo cuerpo por HTTP no lo guarda — probado).
 *
 * Y los dos modos son EXCLUYENTES. Verificado sobre junio en Europa:
 *   · superagent → 951 filas, 39 nodos: 31 superagentes nuestros,  0 distribuidores
 *   · diller     → 2076 filas, 128 nodos: 0 superagentes,          23 distribuidores nuestros
 *
 * Por eso hay que mirarlo ANTES de guardar. Si no, se sacaría la foto en modo dealer y quedaría
 * archivada como si fuera de superagentes: números de otra gente bajo el nombre equivocado, sin que
 * nada avise.
 */
async function modoActual(cliCx) {
  try {
    const r = await cliCx.camposDeReportes();
    if (!r.ok) return { ok: false, error: r.error };
    const s = (r.selects || []).find((x) => x.name === 'reports_user_group_by');
    const sel = s && (s.opciones || []).find((o) => o.seleccionada);
    if (!sel) return { ok: false, error: 'no se pudo leer cómo está agrupando el casino' };
    // 'diller' es como el casino escribe "dealer" (sic)
    return { ok: true, valor: sel.value, grupo: sel.value === 'superagent' ? 'superagent' : (sel.value === 'diller' ? 'nodo' : sel.value) };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

async function capturar({ mes, conexionId = null, refrescar = false, onPaso = null } = {}) {
  const m = String(mes || '').slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(m)) return { ok: false, error: 'mes inválido (se espera YYYY-MM)' };
  const { from, to } = rango(m);
  const pasos = plan(m, { conexionId });
  if (!pasos.length) return { ok: false, error: 'no hay conexiones con paneles para sacar la foto' };

  const porCx = new Map();
  pasos.forEach((p) => { if (!porCx.has(p.conexion_id)) porCx.set(p.conexion_id, []); porCx.get(p.conexion_id).push(p); });

  // Las agrupaciones 'distributor' y 'agent' fueron un intento que no sirvió (el casino devolvía
  // lo mismo que 'superagent'): si quedaron filas de esa época, se limpian.
  db.prepare("DELETE FROM estad_mes WHERE mes=? AND grupo NOT IN ('superagent','nodo')").run(m);
  db.prepare("DELETE FROM estad_captura WHERE mes=? AND grupo NOT IN ('superagent','nodo')").run(m);

  const hechos = [];
  await Promise.all([...porCx.entries()].map(async ([cxId, lista]) => {
    const cli = casinoConex.client(cxId);         // UNA sesión para toda la conexión
    // 🔒 CANDADO: si el casino está agrupando de otra forma, lo que devuelva NO es lo que dice ser.
    const modo = cli ? await modoActual(cli) : { ok: false, error: 'la conexión no responde' };
    if (!cli) {
      lista.forEach((t) => { _marcar(t, { estado: 'error', error: 'la conexión no responde' }); hechos.push({ ...t, estado: 'error', error: 'la conexión no responde' }); });
      return;
    }
    for (const t of lista) {
      // La consulta masiva depende del modo; las sueltas (por nodo) no, porque piden un nodo puntual.
      if (t.grupo === 'superagent' && modo.ok && modo.valor !== 'superagent') {
        const err = `el casino está agrupando por "${modo.valor}", no por superagente: esta foto saldría con los números de otros nodos. Cambialo en la pantalla del casino (Estadísticas → Agrupar por → Superagent) y volvé a sacarla.`;
        _marcar(t, { estado: 'error', error: err });
        hechos.push({ ...t, estado: 'error', error: err });
        if (onPaso) onPaso(hechos[hechos.length - 1]);
        continue;
      }
      const ya = captura(cxId, m, t.divisa, t.grupo, t.nodo);
      if (!refrescar && ya && ya.estado === 'ok') { hechos.push({ ...t, estado: 'ya estaba', filas: ya.filas, nodos: ya.nodos }); if (onPaso) onPaso(hechos[hechos.length - 1]); continue; }
      const t0 = Date.now();
      let r;
      try {
        r = t.grupo === 'nodo'
          ? await cli.reporteProveedoresNodo({ nodoId: t.nodo, from, to, currency: t.divisa })
          : await cli.reporteProveedores({ from, to, currency: t.divisa, userGroupBy: 'superagent' });
      }
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

  const modos = {};
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
  // Los distribuidores y agentes no salen en la consulta masiva: tienen su propia foto, por nodo.
  const g = grupo === 'superagent' ? 'superagent' : 'nodo';
  const c = captura(conexionId, String(mes).slice(0, 7), String(divisa).toUpperCase(), g, nodoId);
  if (!c || c.estado !== 'ok') return null;
  const rows = db.prepare(`SELECT nodo_id, nodo_login, provider, label, vendor, bet, win, profit
    FROM estad_mes WHERE conexion_id=? AND mes=? AND divisa=? AND grupo=? AND nodo_id=?`)
    .all(conexionId, String(mes).slice(0, 7), String(divisa).toUpperCase(), g, String(nodoId));
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
    const c = captura(p.conexion_id, m, p.divisa, p.grupo, p.nodo);
    return {
      conexion: nom[p.conexion_id] || p.conexion_id, conexion_id: p.conexion_id,
      divisa: p.divisa, grupo: p.grupo, nodo: p.nodo || null, panel: p.panel || null,
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
