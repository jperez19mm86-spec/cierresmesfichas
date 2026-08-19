/**
 * tbs-diario.service.js — CAPTURAR UN DÍA DE TBS, y hacerlo solo todos los días.
 *
 * La lógica de capturar vivía adentro de la ruta. Con el cron pidiendo lo mismo habría quedado
 * duplicada, y dos copias de "cómo se arma un día" es cómo una de las dos se queda vieja: se
 * arregla un detalle en la que se ve y la otra sigue guardando mal, en silencio, de madrugada.
 *
 * ── LA ZONA HORARIA ES LA DEL PANEL, NO LA NUESTRA ───────────────────────────────────────────
 * TBS corta sus días en Africa/Blantyre (GMT+2). Preguntarle por "ayer" según la hora argentina
 * pediría un día que allá todavía no terminó —o uno que terminó hace rato— y el día quedaría
 * partido. Todo lo que decide QUÉ día se pide se calcula en la zona del panel.
 *
 * Se dispara a las 6 de la mañana de esa zona: el día anterior ya cerró y nadie está mirando.
 */
const casinoConex = require('./casino-conexiones-store');
const apiStore = require('./api-store');
const tbsDiario = require('./tbs-diario-store');

/** La zona del PANEL. No es la nuestra ni la del casino 463: es donde TBS corta sus días. */
const TZ_PANEL = process.env.TBS_TZ || 'Africa/Blantyre';   // GMT+2

function partesPanel(d = new Date()) {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ_PANEL, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', hour12: false,
  });
  const p = {};
  f.formatToParts(d).forEach((x) => { if (x.type !== 'literal') p[x.type] = x.value; });
  if (p.hour === '24') p.hour = '00';
  return p;
}
const hoyPanel = () => { const p = partesPanel(); return `${p.year}-${p.month}-${p.day}`; };
const horaPanel = () => Number(partesPanel().hour);
const ayerPanel = () => {
  const h = hoyPanel();
  const d = new Date(`${h}T12:00:00Z`);      // mediodía: ningún cambio de horario lo corre de día
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
};

/** La conexión con motor TBS y su cliente, o el motivo por el que no se puede. */
function cliente(conexionId) {
  const cx = casinoConex.list().find((c) => c.motor === 'tbs' && (!conexionId || c.id === conexionId));
  if (!cx) return { error: 'no hay ninguna conexión con motor TBS configurada' };
  const cli = casinoConex.client(cx.id);
  if (!cli) return { error: `la conexión "${cx.nombre}" no tiene credenciales cargadas` };
  return { cli, nombre: cx.nombre, id: cx.id };
}

/**
 * Captura UN día y lo guarda.
 *
 * UNA sola llamada al panel: la respuesta trae el árbol entero y de ahí sale cada cliente. Pedir
 * el total y los agentes por separado era preguntar dos veces exactamente lo mismo.
 *
 * Si el día ya está y no se pide `refrescar`, no se vuelve a pedir: el panel es lento y caro.
 */
async function capturarDia({ fecha, conexionId = null, grupos = [], refrescar = false } = {}) {
  const f = String(fecha || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f)) return { ok: false, error: 'falta la fecha (YYYY-MM-DD)' };
  const t = cliente(conexionId);
  if (t.error) return { ok: false, error: t.error };
  if (!refrescar && tbsDiario.diasCapturados(f.slice(0, 7)).includes(f)) {
    return { ok: true, fecha: f, saltado: true, motivo: 'ese día ya estaba capturado (refrescar:true para rehacerlo)' };
  }
  const t0 = Date.now();
  const agentes = apiStore.listClientes().filter((c) => c.activo !== 0).map((c) => String(c.id));
  const r = await t.cli.diaCompleto({ desde: `${f} 00:00:00`, hasta: `${f} 23:59:59`, agentes, grupos });
  if (!r.ok) return { ok: false, error: r.error };

  // Sólo los CLIENTES. El total del árbol incluye cuentas que no son nuestras y encima invita a
  // sumarlo con los agentes, que es contar todo dos veces.
  const filas = [];
  Object.values(r.porAgente || {}).forEach((a) => {
    Object.entries(a.porDivisa || {}).forEach(([mon, v]) => filas.push({
      agente_id: a.id, login: a.login, moneda: mon, bet: v.bet, win: v.win, profit: v.profit, salas: v.salas,
    }));
  });
  const ms = Date.now() - t0;
  const n = tbsDiario.guardarDia(f, filas, ms);
  return { ok: true, fecha: f, guardadas: n, ms,
    agentes: Object.keys(r.porAgente || {}).length, faltantes: r.faltantes || [] };
}

/**
 * Cron diario: a las 6 de la mañana del panel captura AYER y tapa los huecos del mes.
 *
 * Se sana solo: si el servidor estuvo caído o un día falló, al otro día se completa. Sin esto, un
 * hueco queda para siempre y nadie se entera hasta que alguien mira el mes y ve una columna vacía.
 *
 * `_ultimo` evita repetirlo: el intervalo corre cada 5 minutos y adentro de la hora 6 entraría doce
 * veces, doce recorridas del mes contra un panel ajeno.
 */
let _ultimo = null;
function startCron() {
  const H = Number(process.env.TBS_CRON_HOUR || '6');
  setInterval(async () => {
    try {
      const hoy = hoyPanel();
      if (horaPanel() !== H || _ultimo === hoy) return;
      if (cliente(null).error) return;              // sin conexión TBS no hay nada que hacer
      _ultimo = hoy;
      const ayer = ayerPanel();

      const r1 = await capturarDia({ fecha: ayer, refrescar: true });   // ayer, siempre de nuevo
      console.log(`[TBSdia] ${ayer}: ${r1.ok ? r1.guardadas + ' filas en ' + r1.ms + 'ms' : 'ERROR ' + r1.error}`);

      // Los huecos del mes en curso, y los primeros días también los del anterior.
      const meses = [hoy.slice(0, 7)];
      if (Number(hoy.slice(8, 10)) <= 3 && ayer.slice(0, 7) !== hoy.slice(0, 7)) meses.push(ayer.slice(0, 7));
      for (const mes of meses) {
        const ult = new Date(Date.UTC(Number(mes.slice(0, 4)), Number(mes.slice(5, 7)), 0)).getUTCDate();
        const listos = new Set(tbsDiario.diasCapturados(mes));
        let sanados = 0;
        for (let d = 1; d <= ult; d++) {
          const f = `${mes}-${String(d).padStart(2, '0')}`;
          if (f >= hoy || listos.has(f)) continue;   // hoy está a medias; lo guardado no se repite
          const r = await capturarDia({ fecha: f });
          if (r.ok && !r.saltado) sanados += 1;
        }
        if (sanados) console.log(`[TBSdia] ${mes}: +${sanados} día(s) sanados`);
      }
    } catch (e) { console.warn('[TBSdia] cron error:', e.message); }
  }, 5 * 60 * 1000);
  console.log(`[TBSdia] cron diario a las ${H}:00 ${TZ_PANEL} (la zona del panel, no la nuestra)`);
}

module.exports = { capturarDia, startCron, TZ_PANEL, hoyPanel, ayerPanel, horaPanel };
