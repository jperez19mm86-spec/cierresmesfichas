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
const { db } = require('./db');
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

/**
 * Series diarias por (panel, moneda) de un mes, desde lo guardado.
 *
 * @param hastaDia  si viene, se corta ahí (día del mes, 1-31). Es lo que permite comparar el mes
 *                  en curso contra EL MISMO TRAMO del anterior. Ver el porqué en `pulso`.
 */
function seriesDe(mes, hastaDia = null) {
  const validas = new Set(db.prepare('SELECT id FROM casino_conexiones').all().map((r) => r.id));
  const corte = Number(hastaDia) > 0 ? String(Math.min(31, Number(hastaDia))).padStart(2, '0') : null;
  const rows = db.prepare(
    "SELECT conexion_id, sa_id, login, moneda, fecha, in_amt, out_amt, profit FROM reporte_diario"
    + " WHERE grp='superagent' AND substr(fecha,1,7)=?"
    + (corte ? ' AND substr(fecha,9,2)<=?' : '')
    + ' ORDER BY fecha ASC',
  ).all(...(corte ? [mes, corte] : [mes])).filter((r) => validas.has(r.conexion_id));

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
    const ps = db.prepare('SELECT p.conexion_id, p.id_usuario, p.nombre, p.sistema, c.codigo, c.nombre AS cliente FROM paneles p LEFT JOIN clientes c ON c.id = p.cliente_id').all();
    ps.forEach((p) => { if (p.conexion_id && p.id_usuario) m.set(`${p.conexion_id}:${p.id_usuario}`, { codigo: p.codigo || null, cliente: p.cliente || null, panel: p.nombre, sistema: p.sistema || null }); });
  } catch (e) { /* si el esquema cambia, el pulso sale igual sin el nombre del cliente */ }
  return m;
}

/**
 * De qué SISTEMA es cada conexión. Un mismo panel puede existir en Europa y en Casino a la vez
 * (UPruebaLatam está en los dos): no es un duplicado, son dos paneles distintos con el mismo
 * nombre. Sin esta columna parecen el mismo y se lee como un error de datos.
 */
function sistemas() {
  const m = new Map();
  try {
    db.prepare('SELECT id, nombre FROM casino_conexiones').all().forEach((c) => {
      m.set(c.id, { conexion: c.nombre, sistema: /europa/i.test(c.nombre || '') ? 'Europa' : 'Casino' });
    });
  } catch (e) { /* sin conexiones el pulso igual sale, sin la columna sistema */ }
  return m;
}

function pulso({ mes, minDias = 5 } = {}) {
  const m = String(mes || new Date().toISOString().slice(0, 7)).slice(0, 7);
  const prev = mesAnterior(m);
  const { series, dias } = seriesDe(m);

  // ── SE COMPARA CONTRA EL MISMO TRAMO DEL MES ANTERIOR, NO CONTRA EL MES ENTERO ───────────────
  //
  // Esto estaba mal y no daba un error: daba un número. El mes en curso lleva 9 días y el anterior
  // tuvo 31, así que la resta medía el CALENDARIO y no el negocio — todo daba alrededor de −71%,
  // que es exactamente 1 − 9/31. Peor todavía: mentía al revés. Beting-SA aparecía cayendo 61%
  // cuando por día venía creciendo 33%, y 95 de los 100 paneles del top salían en rojo estando
  // la mayoría en alza.
  //
  // Se corta el mes anterior en el mismo día del mes. No se prorratea (multiplicar por 31/9 supone
  // que todos los días rinden igual, y los fines de semana no rinden como los martes): se comparan
  // los mismos días del calendario contra los mismos días del calendario.
  const ultimoDiaMes = dias.length ? Number(String(dias[dias.length - 1]).slice(8, 10)) : null;
  const { series: sPrev, dias: diasPrev } = seriesDe(prev, ultimoDiaMes);
  const prevPor = new Map(sPrev.map((s) => [s.key, s]));
  const quien = duenos();
  const sis = sistemas();
  const nombre = (s) => {
    const d = quien.get(s.nodo);
    const c = sis.get(s.conexion_id) || {};
    return {
      login: s.login, moneda: s.moneda,
      cliente: d ? (d.codigo || d.cliente) : null,
      // El sistema sale del panel si está registrado; si no, del nombre de la conexión.
      sistema: (d && d.sistema) || c.sistema || null,
      conexion: c.conexion || null,
    };
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

  // ── QUIÉN ESTÁ VENDIENDO MENOS ──────────────────────────────────────────────────────────────
  //
  // Lo que el dueño mira primero. Antes esto sólo existía como una alerta suelta POR PANEL, y por
  // panel no se ve: un cliente con seis paneles puede tener tres subiendo y tres bajando, y la
  // pregunta "¿este cliente me está vendiendo menos?" no la contesta ninguno de los seis.
  //
  // Se agrega POR CLIENTE y en USDT —única forma de sumar pesos con mexicanos— y se compara contra
  // EL MISMO TRAMO del mes anterior. Se ordena por cuántos dólares se perdieron, no por porcentaje:
  // un cliente que cae 80% sobre 200 USDT importa menos que uno que cae 15% sobre 40.000.
  const ventaPorCliente = new Map();
  activos.forEach((s) => {
    const n2 = nombre(s);
    const quienEs = n2.cliente || `(sin cliente) ${s.login}`;
    const a = prevPor.get(s.key);
    const inU = aUsdt(s.in, s.moneda); const prU = aUsdt(s.profit, s.moneda);
    // Sin TC no se puede sumar con las otras monedas: se cuenta aparte en vez de mentir con un cero.
    if (inU == null) {
      const c0 = ventaPorCliente.get(quienEs) || { cliente: quienEs, in: 0, prev: 0, profit: 0, paneles: 0, sinTC: 0, monedas: new Set() };
      c0.sinTC += 1; c0.monedas.add(s.moneda); ventaPorCliente.set(quienEs, c0);
      return;
    }
    const c = ventaPorCliente.get(quienEs) || { cliente: quienEs, in: 0, prev: 0, profit: 0, paneles: 0, sinTC: 0, monedas: new Set() };
    c.in += inU; c.profit += prU || 0; c.paneles += 1; c.monedas.add(s.moneda);
    if (a) c.prev += aUsdt(a.in, s.moneda) || 0;
    ventaPorCliente.set(quienEs, c);
  });
  const clientesVenta = [...ventaPorCliente.values()].map((c) => ({
    cliente: c.cliente, paneles: c.paneles, sinTC: c.sinTC, monedas: [...c.monedas].sort(),
    in: Math.round(c.in), inPrev: Math.round(c.prev), profit: Math.round(c.profit),
    varIn: c.prev > 0 ? (c.in - c.prev) / c.prev : null,
    caidaUsdt: Math.round(c.prev - c.in),          // positivo = perdió; negativo = creció
  })).sort((a, b) => b.caidaUsdt - a.caidaUsdt);

  // ── PANELES QUE SE APAGARON ─────────────────────────────────────────────────────────────────
  //
  // Nadie avisa cuando un panel deja de operar. Las alertas miran a los que BAJAN, y un panel que
  // pasó a cero no baja: desaparece de la lista y el mes siguiente parece que nunca existió. En el
  // mismo tramo de julio había 26 así.
  //
  // Se compara contra el MISMO tramo, igual que todo lo demás: uno que movía el 20 de julio y
  // todavía no movió el 9 de agosto no está apagado, es que no le llegó el turno del mes.
  const activosPrev = sPrev.filter((x) => x.in > 0 || x.out > 0);
  const hoyActivos = new Set(activos.map((x) => x.key));
  const apagados = activosPrev.filter((x) => !hoyActivos.has(x.key)).map((x) => {
    const n2 = nombre(x);
    return { ...n2, moneda: x.moneda, movia: Math.round(x.in), moviaUsdt: Math.round(aUsdt(x.in, x.moneda) || 0),
      dias: x.activos, ultimo: Object.keys(x.dias).filter((f) => x.dias[f].in > 0 || x.dias[f].out > 0).sort().pop() || null };
  }).sort((a, b) => b.moviaUsdt - a.moviaUsdt);

  // ── PANELES QUE MUEVEN Y NO SON DE NADIE ────────────────────────────────────────────────────
  //
  // Están en el reporte del casino y no tienen panel en el OS, así que su ganancia no se le factura
  // a nadie. No es un problema de datos: es plata sin dueño. Se lista aparte de "los que bajan"
  // porque la acción es otra — no hay a quién preguntarle, hay que asignarlo.
  const sinDueno = activos.filter((x) => !nombre(x).cliente).map((x) => {
    const n2 = nombre(x);
    return { login: x.login, moneda: x.moneda, sistema: n2.sistema, conexion: n2.conexion,
      nodo: x.sa_id, conexion_id: x.conexion_id,
      in: Math.round(x.in), inUsdt: Math.round(aUsdt(x.in, x.moneda) || 0),
      profitUsdt: Math.round(aUsdt(x.profit, x.moneda) || 0), dias: x.activos };
  }).sort((a, b) => b.inUsdt - a.inUsdt);

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

  // ── POR CLIENTE ────────────────────────────────────────────────────────
  // Un panel roto es un problema; tres paneles del MISMO cliente con el mismo síntoma es otra cosa.
  // Eso no se ve en una lista de alertas sueltas — hay que sumarlas por dueño.
  const porCliente = {};
  alertas.filter((a) => a.nivel !== 'info').forEach((a) => {
    const k = a.cliente || '(sin cliente)';
    const c = porCliente[k] = porCliente[k] || { cliente: k, alertas: 0, graves: 0, usdt: 0, paneles: new Set(), tipos: {} };
    c.alertas++; if (a.nivel === 'grave') c.graves++;
    c.usdt += a.montoUsdt || 0;
    c.paneles.add(a.login);
    c.tipos[a.tipo] = (c.tipos[a.tipo] || 0) + 1;
  });
  const clientes = Object.values(porCliente)
    .map((c) => ({ ...c, paneles: [...c.paneles] }))
    .sort((a, b) => b.usdt - a.usdt);

  // ── POR SISTEMA (Europa / Casino) ─────────────────────────────────────
  const porSistema = {};
  activos.forEach((s) => {
    const n = nombre(s);
    const k = n.sistema || '(sin sistema)';
    const g = porSistema[k] = porSistema[k] || { sistema: k, paneles: 0, inUsdt: 0, profitUsdt: 0, sinTC: 0 };
    g.paneles++;
    const i = aUsdt(s.in, s.moneda), p = aUsdt(s.profit, s.moneda);
    if (i == null) g.sinTC++; else { g.inUsdt += i; g.profitUsdt += p; }
  });
  const sistemasTot = Object.values(porSistema)
    .map((g) => ({ ...g, rtp: g.inUsdt ? (g.inUsdt - g.profitUsdt) / g.inUsdt : null }))
    .sort((a, b) => b.inUsdt - a.inUsdt);

  // ── CUÁNTO SE LLEVAN LOS JUGADORES, PANEL POR PANEL ───────────────────
  // Este mes contra el anterior. Es la señal de margen hecha gráfico: si la barra creció, ese panel
  // está dejando menos aunque mueva lo mismo.
  const rtp = activos
    .filter((s) => s.in > 0 && s.activos >= 5)
    .map((s) => {
      const a = prevPor.get(s.key);
      return {
        ...nombre(s), inUsdt: aUsdt(s.in, s.moneda),
        rtp: s.out / s.in,
        rtpPrev: a && a.in > 0 ? a.out / a.in : null,
        profitUsdt: aUsdt(s.profit, s.moneda),
      };
    })
    .filter((x) => x.inUsdt != null)
    .sort((a, b) => b.inUsdt - a.inUsdt)
    .slice(0, 14);

  const graves = alertas.filter((a) => a.nivel === 'grave').length;
  return {
    clientes, sistemas: sistemasTot, rtp,
    ok: true, mes: m, mesPrev: prev,
    // Contra qué se comparó, para que la pantalla lo pueda decir en vez de dejarlo implícito.
    // Quién vende menos y quién más, ya sumado por cliente y en dólares.
    clientesVenta,
    apagados,       // operaban en el mismo tramo del mes pasado y este mes no movieron nada
    sinDueno,       // mueven plata y no tienen panel en el OS: no se le factura a nadie
    comparacion: {
      hastaDia: ultimoDiaMes,
      diasMes: dias.length,
      diasPrev: diasPrev.length,
      // Si el mes anterior tiene menos días capturados en el mismo tramo, la comparación se
      // inclina sola y hay que decirlo: no es que el negocio subió, es que faltan días.
      desparejo: !!(ultimoDiaMes && diasPrev.length && diasPrev.length < dias.length),
    },
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

/**
 * Los últimos N meses en USDT, para ver si la cosa sube o baja de verdad.
 *
 * Va por SQL agrupado y no armando series día por día: es un total por mes y moneda, así que no
 * hace falta recorrer nada. Cada moneda se convierte con SU tipo de cambio DE ESE MES — usar el de
 * hoy para todos haría que una devaluación se lea como una caída de ventas.
 */
function tendencia({ hasta, meses = 6 } = {}) {
  const fin = String(hasta || new Date().toISOString().slice(0, 7)).slice(0, 7);
  const lista = [];
  let [y, m] = fin.split('-').map(Number);
  for (let i = 0; i < meses; i++) { lista.unshift(`${y}-${String(m).padStart(2, '0')}`); m--; if (m < 1) { m = 12; y--; } }

  const validas = new Set(db.prepare('SELECT id FROM casino_conexiones').all().map((r) => r.id));
  const ph = lista.map(() => '?').join(',');
  const rows = db.prepare(
    "SELECT substr(fecha,1,7) AS mes, moneda, conexion_id, SUM(in_amt) AS inn, SUM(out_amt) AS outt, SUM(profit) AS pr,"
    + " COUNT(DISTINCT sa_id) AS paneles, COUNT(DISTINCT fecha) AS dias"
    + ` FROM reporte_diario WHERE grp='superagent' AND substr(fecha,1,7) IN (${ph}) GROUP BY 1,2,3`,
  ).all(...lista).filter((r) => validas.has(r.conexion_id));

  const porMes = {};
  const faltan = new Set();
  rows.forEach((r) => {
    const g = porMes[r.mes] = porMes[r.mes] || { mes: r.mes, inUsdt: 0, profitUsdt: 0, paneles: 0, dias: 0, sinTC: [] };
    const t = tcUnico.tcDelMes(r.moneda || 'ARS', r.mes);
    const v = t && t.valor && Number(t.valor) > 0 ? Number(t.valor) : null;
    if (!v) { if (!g.sinTC.includes(r.moneda)) g.sinTC.push(r.moneda); faltan.add(`${r.moneda} (${r.mes})`); return; }
    g.inUsdt += Number(r.inn || 0) / v;
    g.profitUsdt += Number(r.pr || 0) / v;
    g.paneles += Number(r.paneles || 0);
    g.dias = Math.max(g.dias, Number(r.dias || 0));
  });

  return {
    ok: true,
    meses: lista.map((mm) => {
      const g = porMes[mm] || { mes: mm, inUsdt: 0, profitUsdt: 0, paneles: 0, dias: 0, sinTC: [] };
      return {
        ...g,
        inUsdt: Math.round(g.inUsdt), profitUsdt: Math.round(g.profitUsdt),
        rtp: g.inUsdt ? (g.inUsdt - g.profitUsdt) / g.inUsdt : null,
        vacio: !g.dias,
      };
    }),
    sinTC: [...faltan],
  };
}

module.exports = { pulso, tendencia };
