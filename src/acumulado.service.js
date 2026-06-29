/**
 * acumulado.service.js — captura el reporte diario y lo guarda (reporte_diario), para la solapa que
 * se llena día a día. captureDia (un día), captureMes (backfill), startCron (auto-captura diaria).
 */
const casinoConex = require('./casino-conexiones-store');
const store = require('./reporte-diario-store');
const { fechaTZ, horaNum, TZ } = require('./lib/fechas');

// El nivel del nodo según el "group" del acumulado.
const NIVEL_DE_GROUP = { superagent: 'SuperAgente', distributor: 'Distribuidor', agent: 'Agente' };

/** Arma las filas del acumulado (IN/OUT/Profit por nodo del nivel) desde la lista plana de nodos().
 * Pivot: usamos nodos() (area=users, VIVO) en vez de reporte()→reportstable (motor roto del casino). */
function _filasDesdeNodos(nodos, group) {
  const nivel = NIVEL_DE_GROUP[group] || 'SuperAgente';
  return nodos.filter((n) => n.nivel === nivel).map((n) => ({
    id: n.id, login: n.login, in: n.in, out: n.out, profit: n.profit, rtp: n.rtp, count_in: 0, count_out: 0,
  }));
}

/** Captura UN día de una conexión y lo guarda. */
async function captureDia(conexion_id, dia, group = 'superagent') {
  const cli = casinoConex.client(conexion_id);
  if (!cli) return { ok: false, error: 'conexión no encontrada' };
  const r = await cli.nodos({ from: `${dia} 00:00:00`, to: `${dia} 23:59:59` });
  if (!r.ok) return r;
  const filas = _filasDesdeNodos(r.nodos, group);
  store.upsertDia(conexion_id, dia, group, filas);
  return { ok: true, dia, filas: filas.length };
}

/** Backfill: captura todos los días (hasta hoy) de un mes (batches de 3 + reintento). */
async function captureMes(conexion_id, mes, group = 'superagent') {
  const cli = casinoConex.client(conexion_id);
  if (!cli) return { ok: false, error: 'conexión no encontrada' };
  const [y, m] = mes.split('-').map(Number);
  const last = new Date(y, m, 0).getDate();
  const hoy = fechaTZ();
  const dias = [];
  for (let d = 1; d <= last; d++) { const ds = `${mes}-${String(d).padStart(2, '0')}`; if (ds <= hoy) dias.push(ds); }
  await cli.test(); // login 1 vez
  // nodos() puede traer DECENAS DE MILES de nodos por día (cuentas GOD grandes) → de a 2 en paralelo, no 3.
  const run = (d) => cli.nodos({ from: `${d} 00:00:00`, to: `${d} 23:59:59` }).then((r) => ({ d, r })).catch((e) => ({ d, r: { ok: false, error: e.message } }));
  const guardar = (d, r) => store.upsertDia(conexion_id, d, group, _filasDesdeNodos(r.nodos, group));
  let okc = 0; let err = [];
  for (let i = 0; i < dias.length; i += 2) {
    const rs = await Promise.all(dias.slice(i, i + 2).map(run));
    rs.forEach(({ d, r }) => { if (r.ok) { guardar(d, r); okc++; } else err.push(d); });
  }
  for (const d of err.slice()) { const { r } = await run(d); if (r.ok) { guardar(d, r); okc++; err = err.filter((x) => x !== d); } }
  return { ok: true, capturados: okc, errores: err };
}

/** Cron: a la hora H captura el DÍA ANTERIOR (completo) de todas las conexiones activas. */
let _last = null;
function startCron() {
  const H = Number(process.env.ACUM_CRON_HOUR || '1');
  setInterval(async () => {
    try {
      const day = fechaTZ();
      if (horaNum() === H && _last !== day) {
        _last = day;
        const ayer = fechaTZ(new Date(Date.now() - 86400000));
        for (const cx of casinoConex.list()) {
          if (!cx.activa) continue;
          try { const r = await captureDia(cx.id, ayer, 'superagent'); console.log(`[Acum] ${cx.nombre} ${ayer} → ${r.ok ? r.filas + ' filas' : 'ERR ' + r.error}`); }
          catch (e) { console.warn('[Acum]', cx.nombre, e.message); }
        }
      }
    } catch (e) { console.warn('[Acum] cron error:', e.message); }
  }, 5 * 60 * 1000);
  console.log(`[Acum] cron diario activo (captura el día anterior a las ${H}:00 ${TZ})`);
}

module.exports = { captureDia, captureMes, startCron };
