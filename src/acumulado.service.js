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
  const r = await cli.nodos({ from: `${dia} 00:00:00`, to: `${dia} 23:59:59`, soloActivos: true });
  if (!r.ok) return r;
  const filas = _filasDesdeNodos(r.nodos, group);
  store.upsertDia(conexion_id, dia, group, filas);
  return { ok: true, dia, filas: filas.length };
}

/** Backfill: captura SOLO los días FALTANTES del mes (saltea los ya guardados), SECUENCIAL (las cuentas
 *  GOD grandes ven decenas de miles de nodos y el casino throttlea si se pide en paralelo), por LOTES
 *  de `maxPorLlamada` para que el request HTTP no se corte. Devuelve `faltan` (re-llamar hasta 0). */
async function captureMes(conexion_id, mes, group = 'superagent', maxPorLlamada = 8, hasta = null) {
  const cli = casinoConex.client(conexion_id);
  if (!cli) return { ok: false, error: 'conexión no encontrada' };
  const [y, m] = mes.split('-').map(Number);
  const last = new Date(y, m, 0).getDate();
  const tope = hasta || fechaTZ(); // no capturar más allá de este día (el cron pasa "ayer" para no fijar HOY parcial)
  const todos = [];
  for (let d = 1; d <= last; d++) { const ds = `${mes}-${String(d).padStart(2, '0')}`; if (ds <= tope) todos.push(ds); }
  const yaG = new Set((store.getMatriz(conexion_id, group, mes).dias) || []);
  const faltantes = todos.filter((d) => !yaG.has(d));
  const lote = faltantes.slice(0, maxPorLlamada);
  if (!lote.length) return { ok: true, capturados: 0, faltan: 0, total: todos.length, ya_tenia: yaG.size };
  await cli.test(); // login 1 vez
  let okc = 0;
  for (const d of lote) { // SECUENCIAL — no throttlear el casino con cuentas grandes
    try { const r = await cli.nodos({ from: `${d} 00:00:00`, to: `${d} 23:59:59`, soloActivos: true }); if (r.ok) { store.upsertDia(conexion_id, d, group, _filasDesdeNodos(r.nodos, group)); okc++; } }
    catch (e) { /* el día queda como faltante para el próximo lote */ }
  }
  return { ok: true, capturados: okc, faltan: faltantes.length - okc, total: todos.length, ya_tenia: yaG.size };
}

/** Backfill server-side de un mes hasta completarlo (loop de lotes con tope de seguridad). */
async function backfillMesCompleto(conexion_id, mes, group, hasta = null, maxLotes = 25) {
  let total = 0;
  for (let i = 0; i < maxLotes; i++) {
    let r;
    try { r = await captureMes(conexion_id, mes, group, 8, hasta); } catch (e) { break; }
    if (!r.ok) break;
    total += r.capturados || 0;
    if ((r.faltan || 0) === 0) break;       // mes completo
    if ((r.capturados || 0) === 0) break;    // no avanzó (días erroran) → reintenta mañana
  }
  return total;
}

/** Cron nocturno: AUTO-COMPLETA el mes y se auto-sana. A la hora H, por cada conexión activa y nivel:
 *  (1) finaliza AYER (overwrite, por si quedó parcial), (2) rellena los días VIEJOS faltantes del mes
 *  (self-heal: si el server estuvo caído o un día falló, se completa solo — ya no quedan huecos),
 *  (3) los primeros días del mes, cierra el mes anterior. Server-side: NO depende de una pestaña abierta. */
let _last = null;
const CRON_GROUPS = (process.env.ACUM_CRON_GROUPS || 'superagent').split(',').map((s) => s.trim()).filter(Boolean);
function startCron() {
  const H = Number(process.env.ACUM_CRON_HOUR || '1');
  setInterval(async () => {
    try {
      const day = fechaTZ();
      if (horaNum() !== H || _last === day) return;
      _last = day;
      const ayer = fechaTZ(new Date(Date.now() - 86400000));
      const mesAct = day.slice(0, 7);
      const mesPrev = ayer.slice(0, 7);
      const diaNum = Number(day.slice(8, 10));
      for (const cx of casinoConex.list()) {
        if (!cx.activa) continue;
        for (const g of CRON_GROUPS) {
          try {
            await captureDia(cx.id, ayer, g);                            // 1) finalizar AYER (overwrite)
            const n = await backfillMesCompleto(cx.id, mesAct, g, ayer); // 2) sanar días viejos faltantes
            if (diaNum <= 3 && mesPrev !== mesAct) await backfillMesCompleto(cx.id, mesPrev, g); // 3) cierre mes anterior
            console.log(`[Acum] ${cx.nombre} ${mesAct}/${g} → ayer ok, +${n} días sanados`);
          } catch (e) { console.warn('[Acum]', cx.nombre, g, e.message); }
        }
      }
    } catch (e) { console.warn('[Acum] cron error:', e.message); }
  }, 5 * 60 * 1000);
  console.log(`[Acum] cron auto-completa el mes a las ${H}:00 ${TZ} (grupos: ${CRON_GROUPS.join(',')})`);
}

module.exports = { captureDia, captureMes, backfillMesCompleto, startCron };
