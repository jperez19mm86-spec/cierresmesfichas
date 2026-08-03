/**
 * pulso.service.js — el resumen diario: qué está pasando con los paneles y los clientes.
 *
 * Sale TODO del acumulado ya guardado (`reporte_diario`, que el cron llena cada noche), así que no
 * consulta el casino y contesta al instante. Si el cron no corrió, lo dice en vez de mentir.
 *
 * Dos cosas que condicionan todo el archivo:
 *
 *  1. UN PANEL PUEDE OPERAR EN VARIAS MONEDAS (18 lo hacen: 463.life está en ARS, MXN, USD y UYU).
 *     Sumar sus pesos con sus dólares no significa nada, así que la unidad de análisis es
 *     (panel, moneda) y las comparaciones son en PORCENTAJE. Para rankear "el más grande" se pasa
 *     a USDT con el TC del mes — y si a una moneda le falta el TC, se dice, no se asume.
 *
 *  2. NO TODO MOVIMIENTO GRANDE ES JUEGO. Un panel que normalmente mueve 150.000 por día puede
 *     mostrar 98 millones de entrada un día y 98 millones de salida dos días después: eso es plata
 *     que pasó de largo, no jugadores. Contarlo como crecimiento es lo que hace que un panel que en
 *     realidad CAYÓ aparezca creciendo 439%. Por eso se detecta y se marca aparte.
 */
const db = require('./db');
const money = require('./lib/money');
const tcUnico = require('./tc-unico.service');

const mesAnterior = (m) => {
  const [y, mm] = String(m).split('-').map(Number);
  return mm === 1 ? `${y - 1}-12` : `${y}-${String(mm - 1).padStart(2, '0')}`;
};
const mediana = (xs) => {
  if (!xs.length) return 0;
  const s = xs.slice().sort((a, b) => a - b);
  const i = Math.floor(s.length / 2);
  return s.length % 2 ? s[i] : (s[i - 1] + s[i]) / 2;
};

/** Series diarias por (panel, moneda) de un mes, desde lo guardado. */
function seriesDe(mes) {
  const validas = new Set(db.prepare('SELECT id FROM casino_conexiones').all().map((r) => r.id));
  const rows = db.prepare(
    "SELECT conexion_id, sa_id, login, moneda, fecha, in_amt, out_amt, profit FROM reporte_diario"
    + " WHERE grp='superagent' AND substr(fecha,1,7)=? ORDER BY fecha ASC",
  ).all(mes).filter((r) => validas.has(r.conexion_id));

  const S = new Map();
  const dias = new Set();
  for (const r of rows) {
    const moneda = r.moneda || 'ARS';
    const k = `${r.conexion_id}:${r.sa_id}|${moneda}`;
    let s = S.get(k);
    if (!s) S.set(k, s = {
      key: k, nodo: `${r.conexion_id}:${r.sa_id}`, conexion_id: r.conexion_id, sa_id: String(r.sa_id),
      login: r.login, moneda, dias: {}, in: 0, out: 0, profit: 0, activos: 0,
    });
    const inn = Number(r.in_amt || 0), out = Number(r.out_amt || 0), pr = Number(r.profit || 0);
    s.dias[r.fecha] = { in: inn, out, profit: pr };
    s.in += inn; s.out += out; s.profit += pr;
    if (inn > 0 || out > 0) s.activos++;
    dias.add(r.fecha);
  }
  return { series: [...S.values()], dias: [...dias].sort() };
}

/** De qué cliente es cada panel, para poder decir "Titan dejó de operar" y no sólo el login. */
function duenos() {
  const m = new Map();
  try {
    const ps = db.prepare('SELECT p.conexion_id, p.id_usuario, p.nombre, c.codigo, c.nombre AS cliente FROM paneles p LEFT JOIN clientes c ON c.id = p.cliente_id').all();
    ps.forEach((p) => { if (p.conexion_id && p.id_usuario) m.set(`${p.conexion_id}:${p.id_usuario}`, { codigo: p.codigo || null, cliente: p.cliente || null, panel: p.nombre }); });
  } catch (e) { /* si el esquema cambia, el pulso sale igual sin el nombre del cliente */ }
  return m;
}

function pulso({ mes, minDias = 5 } = {}) {
  const m = String(mes || new Date().toISOString().slice(0, 7)).slice(0, 7);
  const prev = mesAnterior(m);
  const { series, dias } = seriesDe(m);
  const { series: sPrev } = seriesDe(prev);
  const prevPor = new Map(sPrev.map((s) => [s.key, s]));
  const quien = duenos();
  const nombre = (s) => {
    const d = quien.get(s.nodo);
    return { login: s.login, moneda: s.moneda, cliente: d ? (d.codigo || d.cliente) : null };
  };

  // ── tipo de cambio, para poder rankear entre monedas ──
  const tc = {}; const sinTC = new Set();
  [...new Set(series.map((s) => s.moneda))].forEach((mon) => {
    const t = tcUnico.tcDelMes(mon, m);
    if (t && t.valor && Number(t.valor) > 0) tc[mon] = Number(t.valor); else sinTC.add(mon);
  });
  const aUsdt = (n, mon) => (tc[mon] ? n / tc[mon] : null);

  const activos = series.filter((s) => s.in > 0 || s.out > 0);
  const alertas = [];
  const push = (a) => alertas.push(a);

  for (const s of activos) {
    const n = nombre(s);
    const dsAct = dias.map((f) => s.dias[f]).filter((v) => v && (v.in > 0 || v.out > 0));
    const medIn = mediana(dsAct.map((v) => v.in));
    const medOut = mediana(dsAct.map((v) => v.out));
    const ant = prevPor.get(s.key);

    // ── 1) PLATA QUE ENTRA Y SALE (no es juego) ──────────────────────────
    // Un pico de entrada y uno de salida parecidos, con pocos días entre medio. Es un movimiento de
    // fichas: si se cuenta como venta, el panel parece que creció cuando no pasó nada.
    const picosIn = dias.filter((f) => s.dias[f] && medIn > 0 && s.dias[f].in > medIn * 10);
    const picosOut = dias.filter((f) => s.dias[f] && medOut > 0 && s.dias[f].out > medOut * 10);
    const yaPar = new Set();
    for (const fi of picosIn) {
      for (const fo of picosOut) {
        if (yaPar.has(fo)) continue;
        const dif = Math.abs(new Date(fi) - new Date(fo)) / 86400000;
        if (dif > 3) continue;
        const a = s.dias[fi].in, b = s.dias[fo].out;
        if (Math.abs(a - b) / Math.max(a, b) > 0.1) continue;
        yaPar.add(fo);
        push({
          tipo: 'pasa_de_largo', nivel: 'grave', ...n, fecha: fi, hasta: fo,
          titulo: 'Plata que entró y salió — no es juego',
          detalle: `Entraron ${money.fmt(String(a), 0)} el ${fi} y salieron ${money.fmt(String(b), 0)} el ${fo}.`
            + ` Este panel mueve ${money.fmt(String(Math.round(medIn)), 0)} por día: es ${Math.round(a / Math.max(medIn, 1))} veces lo normal.`
            + ' Contarlo como venta hace que el panel parezca crecer sin que haya pasado nada.',
          monto: a, montoUsdt: aUsdt(a, s.moneda), donde: 'Acumulado → ese panel, esos días',
        });
      }
    }

    // ── 2) SALIDA GRANDE SIN CONTRAPARTIDA ──────────────────────────────
    // Salió mucho más de lo normal y NO hay una entrada que lo explique: eso es plata que se fue.
    for (const fo of picosOut) {
      if (yaPar.has(fo)) continue;
      const v = s.dias[fo];
      if (v.profit >= 0) continue;
      push({
        tipo: 'salida_grande', nivel: 'grave', ...n, fecha: fo,
        titulo: 'Salida muy por encima de lo normal',
        detalle: `El ${fo} salieron ${money.fmt(String(v.out), 0)} contra ${money.fmt(String(v.in), 0)} que entraron`
          + ` (${(v.out / Math.max(v.in, 1)).toFixed(1)}× lo que entró, y ${Math.round(v.out / Math.max(medOut, 1))}× lo que sale un día normal).`
          + ` Ese día perdió ${money.fmt(String(Math.abs(v.profit)), 0)}.`,
        monto: Math.abs(v.profit), montoUsdt: aUsdt(Math.abs(v.profit), s.moneda), donde: 'Acumulado → ese panel, ese día',
      });
    }

    // ── 3) SE APAGÓ ──────────────────────────────────────────────────────
    let seco = 0;
    for (let i = dias.length - 1; i >= 0; i--) { if (s.dias[dias[i]] && s.dias[dias[i]].in > 0) break; seco++; }
    if (seco >= minDias && s.activos > 0 && seco < dias.length) {
      const grande = (aUsdt(s.in, s.moneda) || 0) > 300;
      push({
        tipo: 'apagado', nivel: grande ? 'grave' : 'aviso', ...n, dias: seco,
        titulo: 'Dejó de operar',
        detalle: `Lleva ${seco} días seguidos sin una sola entrada. En el mes movió ${money.fmt(String(s.in), 0)} en ${s.activos} días.`,
        monto: s.in, montoUsdt: aUsdt(s.in, s.moneda), donde: 'Clientes → el panel',
      });
    }

    // ── 4) EL MARGEN SE CAE AUNQUE EL VOLUMEN SE MANTENGA ────────────────
    // Es la más importante y la que no se ve mirando ventas: mismo movimiento, mucha menos ganancia.
    if (ant && ant.profit > 0 && ant.in > 0 && s.activos >= 10) {
      const varIn = (s.in - ant.in) / ant.in;
      const varPr = (s.profit - ant.profit) / ant.profit;
      if (varPr <= -0.25 && Math.abs(varIn) <= 0.15) {
        const rtpA = ant.out / ant.in, rtpB = s.out / s.in;
        push({
          tipo: 'margen_cae', nivel: 'grave', ...n,
          titulo: 'Gana mucho menos moviendo lo mismo',
          detalle: `El movimiento quedó igual (${(varIn * 100).toFixed(0)}%) pero la ganancia cayó ${Math.abs(varPr * 100).toFixed(0)}%:`
            + ` de ${money.fmt(String(ant.profit), 0)} a ${money.fmt(String(s.profit), 0)}.`
            + ` Los jugadores se llevan ${(rtpB * 100).toFixed(0)}% de lo que entra, cuando el mes pasado era ${(rtpA * 100).toFixed(0)}%.`,
          monto: ant.profit - s.profit, montoUsdt: aUsdt(ant.profit - s.profit, s.moneda), donde: 'Acumulado → ese panel',
        });
      } else if (varIn <= -0.35) {
        push({
          tipo: 'cae_fuerte', nivel: 'aviso', ...n,
          titulo: 'Está vendiendo mucho menos',
          detalle: `Movió ${Math.abs(varIn * 100).toFixed(0)}% menos que el mes pasado: de ${money.fmt(String(ant.in), 0)} a ${money.fmt(String(s.in), 0)}.`,
          monto: ant.in - s.in, montoUsdt: aUsdt(ant.in - s.in, s.moneda), donde: 'Clientes → el panel',
        });
      }
    }

    // ── 5) EL MES ENTERO EN NEGATIVO ────────────────────────────────────
    if (s.profit < 0) {
      push({
        tipo: 'mes_negativo', nivel: 'grave', ...n,
        titulo: 'El mes cierra en rojo',
        detalle: `Entraron ${money.fmt(String(s.in), 0)} y salieron ${money.fmt(String(s.out), 0)}: perdió ${money.fmt(String(Math.abs(s.profit)), 0)} en el mes.`,
        monto: Math.abs(s.profit), montoUsdt: aUsdt(Math.abs(s.profit), s.moneda), donde: 'Acumulado → ese panel',
      });
    }

    // ── 6) EMPEZÓ ESTE MES ──────────────────────────────────────────────
    if (!ant && s.activos >= 3) {
      push({
        tipo: 'nuevo', nivel: 'info', ...n,
        titulo: 'Empezó a operar este mes',
        detalle: `Movió ${money.fmt(String(s.in), 0)} en ${s.activos} días. No tenía movimiento el mes pasado.`,
        monto: s.in, montoUsdt: aUsdt(s.in, s.moneda), donde: 'Clientes → el panel',
      });
    }
  }

  // Lo más caro primero, y dentro de cada nivel por plata en juego.
  const peso = { grave: 0, aviso: 1, info: 2 };
  alertas.sort((a, b) => (peso[a.nivel] - peso[b.nivel]) || ((b.montoUsdt || 0) - (a.montoUsdt || 0)));

  // ── el mes en números ──────────────────────────────────────────────────
  const porMoneda = {};
  activos.forEach((s) => {
    const g = porMoneda[s.moneda] = porMoneda[s.moneda] || { moneda: s.moneda, paneles: 0, in: 0, out: 0, profit: 0, inPrev: 0, profitPrev: 0, tc: tc[s.moneda] || null };
    g.paneles++; g.in += s.in; g.out += s.out; g.profit += s.profit;
    const a = prevPor.get(s.key); if (a) { g.inPrev += a.in; g.profitPrev += a.profit; }
  });
  const monedas = Object.values(porMoneda).map((g) => ({
    ...g,
    rtp: g.in ? g.out / g.in : null,
    varIn: g.inPrev ? (g.in - g.inPrev) / g.inPrev : null,
    varProfit: g.profitPrev ? (g.profit - g.profitPrev) / g.profitPrev : null,
    inUsdt: aUsdt(g.in, g.moneda), profitUsdt: aUsdt(g.profit, g.moneda),
  })).sort((a, b) => (b.inUsdt || 0) - (a.inUsdt || 0));

  // Serie diaria en USDT: es la única forma honesta de juntar monedas en un gráfico.
  const serieDia = dias.map((f) => {
    let inn = 0, pr = 0, falta = false;
    activos.forEach((s) => {
      const v = s.dias[f]; if (!v) return;
      if (!tc[s.moneda]) { falta = true; return; }
      inn += v.in / tc[s.moneda]; pr += v.profit / tc[s.moneda];
    });
    return { fecha: f, in: Math.round(inn), profit: Math.round(pr), incompleto: falta };
  });

  // Top paneles por ganancia, con lo que cambió — para ver de dónde sale la plata de verdad.
  const top = activos.map((s) => {
    const a = prevPor.get(s.key);
    return {
      ...nombre(s), in: s.in, profit: s.profit,
      profitUsdt: aUsdt(s.profit, s.moneda), inUsdt: aUsdt(s.in, s.moneda),
      varProfit: a && a.profit > 0 ? (s.profit - a.profit) / a.profit : null,
      varIn: a && a.in > 0 ? (s.in - a.in) / a.in : null,
      rtp: s.in ? s.out / s.in : null, activos: s.activos,
    };
  }).sort((a, b) => (b.profitUsdt || 0) - (a.profitUsdt || 0));

  const graves = alertas.filter((a) => a.nivel === 'grave').length;
  return {
    ok: true, mes: m, mesPrev: prev,
    dias, ultimoDia: dias[dias.length - 1] || null, diasCapturados: dias.length,
    paneles: series.length, activos: activos.length,
    alertas, graves, avisos: alertas.filter((a) => a.nivel === 'aviso').length,
    monedas, serieDia, top,
    sinTC: [...sinTC],
    // Si el cron no corrió, cualquier número de acá abajo está incompleto. Mejor decirlo.
    faltaCaptura: (() => {
      const hoy = new Date().toISOString().slice(0, 10);
      const ayer = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
      if (!m.startsWith(hoy.slice(0, 7))) return null;
      return dias.includes(ayer) ? null : `El acumulado llega hasta ${dias[dias.length - 1] || '—'}; falta capturar ${ayer}.`;
    })(),
  };
}

module.exports = { pulso };
