/**
 * tc-divisas.service.js — tipo de cambio diario del RESTO de las divisas (ARS va aparte).
 *
 * Por qué existe: el cierre de proveedores externos convierte a USDT con el TC PROMEDIO DEL MES
 * de la divisa de cada panel, y los paneles usan ~36 monedas. Hasta ahora ese TC se cargaba a mano
 * mes a mes en una grilla. Guardando un snapshot por día, el promedio del mes sale solo.
 *
 * Fuente: open.er-api.com (gratis, sin clave, cubre 36 de las 38 divisas en uso).
 * exchange-rates.org NO se puede usar: está detrás de Cloudflare y bloquea la lectura automática.
 *
 * Reglas del negocio (decididas por el dueño):
 *   - ARS  → NO se toma de acá. Sale de Binance/criptoya (tc-store), que es el mercado real.
 *   - VEF  → se cobra igual que VES; la fuente no tiene VEF, así que se le copia el valor de VES.
 *            (En el panel del casino figuran como divisas distintas, pero valen lo mismo.)
 *   - BOB  → se usa el valor de la fuente, que es el PARALELO (el oficial ~6.9 no es el real).
 *   - ADA  → se ignora (es cripto, no se factura).
 */
const { db } = require('./db');
const money = require('./lib/money');
const { fechaTZ, nowISO } = require('./lib/fechas');

const FUENTE_URL = 'https://open.er-api.com/v6/latest/USD';
// USD/USDT valen 1 · ADA no se factura · ARS ver abajo 👇
const IGNORAR = new Set(['ADA', 'USD', 'USDT', 'ARS']);

/* 🔴 POR QUÉ ARS ESTÁ EN LA LISTA (arreglado 3-ago-2026)
   La regla de arriba siempre dijo "ARS NO se toma de acá, sale de Binance/criptoya", pero ARS
   NO estaba en IGNORAR: se guardaba igual, con la cotización OFICIAL. Y como en tc-unico el
   promedio automático le gana al histórico de Binance, el peso terminaba resolviéndose con la
   oficial cada vez que un mes no tenía TC cargado a mano.
   Medido en producción el 3-ago: agosto daba 1488,45 (oficial) en vez de 1579,68 (Binance),
   6,1% abajo. Como el USDT sale de DIVIDIR por ese número, todo lo facturado en pesos ese mes
   se habría cobrado 6,1% de más. Junio y julio no se vieron afectados porque tienen el TC
   cargado a mano, que manda sobre todo lo demás. */
const ALIAS = { VEF: 'VES' };                       // VEF toma el valor de VES

/**
 * ── SOLO LAS MONEDAS QUE SE USAN ───────────────────────────────────────────────────────────
 * La fuente publica ~160 cotizaciones. Guardarlas todas llenaba la base y, peor, la pantalla:
 * entre AED, AFN, ALL y AOA no se encontraba el peso. Se siguen únicamente las monedas en las
 * que de verdad se factura.
 *
 * La lista NO está clavada: sale de las FILAS de la grilla de TC (`cierre_tc`), que es donde el
 * dueño decide en qué monedas trabaja. Si mañana agrega una fila, al otro día ya se le junta la
 * cotización sola. La base de abajo es el piso —las que aparecen en el reporte de proveedores
 * externos— para que la lista nunca quede vacía si la grilla se vacía.
 */
const BASE_SEGUIDAS = ['BOB', 'BRL', 'CLP', 'COP', 'CRC', 'DOP', 'GTQ', 'HNL', 'MXN', 'PEN', 'PYG', 'UYU', 'VEF', 'VES', 'ZAR'];

/** Las monedas que se siguen: las de la grilla + el piso. Sin ARS (va por Binance) ni USD/USDT. */
function seguidas() {
  const set = new Set(BASE_SEGUIDAS);
  try {
    require('./cierre-store').getTC().monedas.forEach((m) => {
      const d = String(m || '').toUpperCase().trim();
      if (/^[A-Z]{3}$/.test(d)) set.add(d);        // ARS_OF y demás etiquetas no son monedas
    });
  } catch (e) { /* si la grilla no se puede leer, queda el piso */ }
  IGNORAR.forEach((d) => set.delete(d));
  return set;
}

/** Baja las cotizaciones del día. Devuelve { ok, tasas: {DIVISA: '1234.56'}, error? } */
async function fetchTasas() {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), 20000);
  try {
    const r = await fetch(FUENTE_URL, { signal: ctrl.signal });
    if (!r.ok) return { ok: false, error: `HTTP ${r.status}` };
    const j = await r.json();
    if (!j || !j.rates) return { ok: false, error: 'respuesta sin cotizaciones' };
    const tasas = {};
    const quiero = seguidas();
    for (const [div, val] of Object.entries(j.rates)) {
      if (IGNORAR.has(div) || !quiero.has(div)) continue;
      const n = Number(val);
      if (!Number.isFinite(n) || n <= 0) continue;
      tasas[div] = money.round(String(n), 6);
    }
    // VEF no existe en la fuente: se le copia VES (mismo valor, el dueño cobra igual)
    for (const [destino, origen] of Object.entries(ALIAS)) {
      if (tasas[destino] == null && tasas[origen] != null) tasas[destino] = tasas[origen];
    }
    return { ok: true, tasas };
  } catch (e) {
    return { ok: false, error: e.name === 'AbortError' ? 'timeout' : e.message };
  } finally { clearTimeout(to); }
}

const _guardar = db.transaction((fecha, tasas, fuente) => {
  const ins = db.prepare(`INSERT INTO tc_divisa_snapshots (fecha,divisa,tasa,fuente,createdAt)
    VALUES (?,?,?,?,?) ON CONFLICT(fecha,divisa) DO UPDATE SET tasa=excluded.tasa, fuente=excluded.fuente`);
  let n = 0;
  for (const [div, tasa] of Object.entries(tasas)) { ins.run(fecha, div, tasa, fuente, nowISO()); n++; }
  return n;
});

/** Toma el snapshot del día y lo guarda (idempotente: si ya corrió hoy, lo pisa). */
async function snapshotHoy(fecha) {
  const f = fecha || fechaTZ();
  const r = await fetchTasas();
  if (!r.ok) return r;
  const n = _guardar(f, r.tasas, 'open.er-api.com');
  return { ok: true, fecha: f, divisas: n };
}

/** Promedio del mes de una divisa. null si no hay ningún día guardado. */
function promedioMes(divisa, mes) {
  const d = String(divisa || '').toUpperCase();
  if (d === 'USDT' || d === 'USD') return '1';
  const rows = db.prepare("SELECT tasa FROM tc_divisa_snapshots WHERE divisa=? AND substr(fecha,1,7)=?").all(d, mes);
  if (!rows.length) return null;
  return money.round(money.div(money.sum(rows.map((x) => x.tasa)), String(rows.length)), 6);
}

/** Promedios de TODAS las divisas de un mes + cuántos días tiene cada una. */
function promediosMes(mes) {
  const rows = db.prepare(`SELECT divisa, COUNT(*) dias, GROUP_CONCAT(tasa) tasas
    FROM tc_divisa_snapshots WHERE substr(fecha,1,7)=? GROUP BY divisa ORDER BY divisa`).all(mes);
  return rows.map((r) => {
    const vals = String(r.tasas || '').split(',').filter(Boolean);
    return { divisa: r.divisa, dias: r.dias, promedio: vals.length ? money.round(money.div(money.sum(vals), String(vals.length)), 6) : null };
  });
}

function listDias(mes, divisa) {
  if (divisa) return db.prepare("SELECT * FROM tc_divisa_snapshots WHERE substr(fecha,1,7)=? AND divisa=? ORDER BY fecha DESC").all(mes, String(divisa).toUpperCase());
  return db.prepare("SELECT * FROM tc_divisa_snapshots WHERE substr(fecha,1,7)=? ORDER BY fecha DESC, divisa ASC").all(mes);
}

/** ¿Ya se guardó el día? Se pregunta a la BASE: en memoria, cada redeploy volvía a pedir la API. */
function hayDia(fecha) {
  return !!db.prepare('SELECT 1 FROM tc_divisa_snapshots WHERE fecha=? LIMIT 1').get(fecha);
}

/**
 * Borra las filas de ARS que quedaron guardadas acá con la cotización OFICIAL antes del arreglo
 * del 3-ago. No alcanza con dejar de escribirlas: mientras existan, `promedioMes('ARS')` las
 * promedia y el peso se sigue resolviendo con la oficial. Corre sola al arrancar y es idempotente.
 */
function purgarArsViejo() {
  const n = db.prepare("DELETE FROM tc_divisa_snapshots WHERE divisa='ARS'").run().changes;
  if (n) console.log(`[TC divisas] purgadas ${n} filas de ARS con cotización oficial (el peso va por Binance)`);
  return n;
}

/**
 * Borra lo guardado de monedas que no se siguen. Dejar de escribirlas no alcanza: mientras las
 * filas viejas existan, siguen apareciendo en los promedios y en la pantalla.
 */
function purgarNoSeguidas() {
  const quiero = [...seguidas()];
  if (!quiero.length) return 0;
  const huecos = quiero.map(() => '?').join(',');
  const n = db.prepare(`DELETE FROM tc_divisa_snapshots WHERE divisa NOT IN (${huecos})`).run(...quiero).changes;
  if (n) console.log(`[TC divisas] purgadas ${n} filas de monedas que no se usan (quedan ${quiero.length})`);
  return n;
}

/**
 * Cron: UNA por día, y está bien que sea una.
 *
 * A diferencia del peso —que se mueve todo el día contra el dólar cripto y por eso lleva dos
 * snapshots— esta fuente publica UNA cotización de referencia por jornada: pedirla dos veces
 * devuelve el mismo número. Además la tabla es única por (fecha, divisa), así que una segunda
 * pasada pisaría la primera en vez de sumar al promedio.
 *
 * Corre en la última franja de las configuradas para ARS, cuando la cotización del día ya está.
 */
function startScheduler() {
  purgarArsViejo();     // el peso no vive acá; si quedaron filas viejas, se van
  purgarNoSeguidas();   // ~160 monedas de la fuente, se guardan solo las que se facturan
  const horas = String(process.env.TC_SNAPSHOT_HOURS || '9,18')
    .split(',').map((h) => Number(String(h).trim())).filter((h) => Number.isInteger(h) && h >= 0 && h <= 23);
  const HOUR = (horas.length ? horas : [9, 18]).slice(-1)[0];
  setInterval(async () => {
    try {
      const dia = fechaTZ();
      const hora = Number(new Date().toLocaleString('en-GB', { timeZone: 'America/Argentina/Buenos_Aires', hour: '2-digit', hour12: false }));
      if (hora !== HOUR || hayDia(dia)) return;
      const r = await snapshotHoy(dia);
      console.log('[TC divisas] snapshot diario →', r.ok ? `${r.divisas} divisas` : `FALLÓ ${r.error}`);
    } catch (e) { console.warn('[TC divisas] scheduler error:', e.message); }
  }, 5 * 60 * 1000);
  console.log(`[TC divisas] scheduler activo (snapshot diario ${HOUR}:00 ART)`);
}

module.exports = { fetchTasas, snapshotHoy, promedioMes, promediosMes, listDias, startScheduler, purgarArsViejo, purgarNoSeguidas, seguidas, ALIAS, IGNORAR, BASE_SEGUIDAS };
