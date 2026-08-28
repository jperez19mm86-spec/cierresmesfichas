/**
 * tbs-comparativa.js — EL MENSAJE QUE LA DUEÑA VENÍA ESCRIBIENDO A MANO.
 *
 * Cada tanto le preguntan por uno o dos clientes y ella contesta con un mensaje así:
 *
 *     Julio
 *     1-17
 *     Colombians: 21,941,069,957.60  20,927,685,711.05  1,013,384,246.55
 *     Nacho: 42,114,467,093.10  37,969,867,151.11  4,144,599,941.99
 *
 * Son tres números por cliente —jugado, premios y profit— para el MISMO tramo de los dos meses.
 * Acá se arma solo, con dos diferencias respecto de lo que escribía a mano:
 *
 *   · Lleva la DIFERENCIA. El que lo lee la va a calcular igual, y calcularla a mano sobre
 *     números de doce dígitos es donde se equivoca cualquiera.
 *   · El tramo NO se elige: son los días que están capturados en LOS DOS meses. 17 contra 16
 *     daría una caída inventada, y es un error que no se ve mirando el mensaje.
 *
 * El texto se arma ACÁ y no en la pantalla a propósito: lo que sale para afuera lo tiene que
 * componer el servidor con los datos de la base. Si la pantalla mandara el texto ya hecho,
 * cualquier cosa que llegue a esa ruta se publicaría tal cual.
 */
const tbsDiario = require('./tbs-diario-store');
const apiStore = require('./api-store');

const MESES = ['', 'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio',
  'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

const dd = (f) => String(f).slice(8, 10);
const nombreMes = (m) => MESES[Number(String(m).slice(5, 7))] || String(m);
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/** Los mismos separadores que usa el resto del panel: 1.234.567,89 */
function num(n) {
  return Number(n || 0).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** 'YYYY-MM' → el anterior, a mano: pasar 'YYYY-MM' por Date se corre de mes según la zona. */
function mesAnterior(mes) {
  const [y, m] = String(mes).split('-').map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}

/**
 * Suma un cliente sobre los días indicados (los 'DD' comunes a los dos meses).
 * @returns {{bet:number,win:number,profit:number}}
 */
function sumar(cliente, mes, diasDD) {
  let bet = 0, win = 0, profit = 0;
  for (const d of diasDD) {
    const x = cliente.dias[`${mes}-${d}`];
    if (x) { bet += x.bet; win += x.win; profit += x.profit; }
  }
  return { bet, win, profit };
}

/**
 * Arma los datos de la comparativa.
 *
 * @param mes       'YYYY-MM' — el mes de este lado
 * @param ids       ids de agente de TBS; si viene vacío, TODOS los que movieron algo
 * @returns { ok, mes, mesAnt, desde, hasta, dias, filas[], sinDatos[] }
 */
function armar({ mes, ids = [] } = {}) {
  const m = String(mes || '').slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(m)) return { ok: false, error: 'falta el mes (YYYY-MM)' };
  const mAnt = mesAnterior(m);
  const nue = tbsDiario.delMes(m);
  const ant = tbsDiario.delMes(mAnt);
  if (!nue.dias.length) return { ok: false, error: `no hay días guardados de ${m}` };
  if (!ant.dias.length) return { ok: false, error: `no hay días guardados de ${mAnt}: no hay contra qué comparar` };

  // El tramo: los días capturados en LOS DOS meses. Sin esto, 17 días contra 16 dan una caída
  // que no existe y el mensaje sale con un número que nadie puede desmentir del otro lado.
  const setAnt = new Set(ant.dias.map(dd));
  const comunes = nue.dias.map(dd).filter((x) => setAnt.has(x)).sort();
  if (!comunes.length) return { ok: false, error: `${m} y ${mAnt} no tienen ningún día en común` };

  const quiero = new Set(ids.map(String).filter(Boolean));
  const nombres = {};
  apiStore.listClientes().forEach((c) => { nombres[String(c.id)] = String(c.de_quien || '').trim() || c.login; });

  const porClave = new Map();
  ant.clientes.forEach((c) => porClave.set(`${c.agente_id}|${c.moneda}`, c));

  /* ── UNA FILA POR CLIENTE, NO UNA POR MONEDA ─────────────────────────────────────────────────
     Un bloque por cada moneda daba un mensaje de sesenta líneas: NachoAPI solo tiene ARS, PYG,
     USD y COP, y tres de esas cuatro son monedas donde movió unos pocos dólares. Va la moneda
     PRINCIPAL y nada más —la de más jugado, que es de la que le están preguntando—. Las otras
     quedan afuera del mensaje: son de las que nadie pregunta y sólo alargan la respuesta. */
  const porCliente = new Map();
  for (const c of nue.clientes) {
    if (quiero.size && !quiero.has(String(c.agente_id))) continue;
    const a = porClave.get(`${c.agente_id}|${c.moneda}`);
    const nu = sumar(c, m, comunes);
    const an = a ? sumar(a, mAnt, comunes) : null;
    if (!nu.bet && !nu.profit && !(an && an.bet)) continue;    // no movió nada en ninguno de los dos
    const k = String(c.agente_id);
    const g = porCliente.get(k) || { agente_id: k, nombre: nombres[k] || c.login, login: c.login,
      dentroDe: c.dentroDe || null, monedas: [] };
    g.monedas.push({ moneda: c.moneda, nue: nu, ant: an });
    porCliente.set(k, g);
  }

  const filas = [];
  const sinDatos = [];
  for (const g of porCliente.values()) {
    g.monedas.sort((x, y) => y.nue.bet - x.nue.bet);
    const p = g.monedas[0];
    if (!p.ant) { sinDatos.push({ nombre: g.nombre, moneda: p.moneda }); continue; }
    filas.push({ agente_id: g.agente_id, nombre: g.nombre, login: g.login,
      // ⚠️ Un hijo que cuelga de otro agente capturado ya está contado adentro del padre. Va la
      // marca para que el mensaje lo diga: si no, quien lo lee suma las dos líneas.
      dentroDe: g.dentroDe,
      moneda: p.moneda, nue: p.nue, ant: p.ant,
      // Las demás, sólo las que movieron algo de verdad.
      otras: g.monedas.slice(1).filter((x) => x.nue.bet || (x.ant && x.ant.bet)).map((x) => x.moneda),
    });
  }
  filas.sort((x, y) => y.nue.bet - x.nue.bet);
  return { ok: true, mes: m, mesAnt: mAnt, dias: comunes.length,
    desde: comunes[0], hasta: comunes[comunes.length - 1], filas, sinDatos };
}

/**
 * El texto, en HTML de Telegram (`<b>` y `<code>` son los únicos que hace falta).
 *
 * Los números van en <code> para que Telegram los muestre en ancho fijo: doce dígitos sin alinear
 * no se comparan de un vistazo, que es todo el punto de mandar los dos meses juntos.
 */
function texto(d) {
  if (!d || !d.ok) return '';
  const L = [];
  /* El porcentaje sólo cuando significa algo. Sobre una base negativa o en cero da un número que
     además apunta para el lado contrario: el profit de una cuenta que pasó de −92.985 a 0 subió,
     y la cuenta daba «−100%». Ahí va la diferencia en plata, que nunca miente. */
  const pctTxt = (nue, ant) => {
    if (ant > 0) {
      const p = (nue / ant - 1) * 100;
      return `(${p >= 0 ? '+' : '−'}${Math.abs(p).toFixed(0)}%)`;
    }
    const x = nue - ant;
    return `(${x >= 0 ? '+' : '−'}${num(Math.abs(x))})`;
  };

  L.push(`📊 <b>${cap(nombreMes(d.mes))} contra ${nombreMes(d.mesAnt)}</b> · del <b>${d.desde} al ${d.hasta}</b>`);

  for (const f of d.filas) {
    L.push('');
    L.push(`<b>${f.nombre}</b> · ${f.moneda}${f.dentroDe ? ` <i>(ya contado adentro de ${f.dentroDe})</i>` : ''}`);
    L.push('');
    // Un renglón por número: los dos meses y el porcentaje. La diferencia en plata no va —los dos
    // números están, y el renglón de más por cada uno hacía el mensaje el doble de largo.
    const linea = (rot, nue, ant) => L.push(`<b>${rot}</b>  <code>${num(ant)} → ${num(nue)}</code>  ${pctTxt(nue, ant)}`);
    linea('IN', f.nue.bet, f.ant.bet);
    linea('OUT', f.nue.win, f.ant.win);
    linea('PROFIT', f.nue.profit, f.ant.profit);
    // Las otras monedas se nombran, no se detallan: que se sepa que existen sin tapar la respuesta.
    if (f.otras.length) { L.push(''); L.push(`<i>también hay movimiento en ${f.otras.join(', ')}</i>`); }
  }

  L.push('');
  L.push(`<i>${nombreMes(d.mesAnt)} → ${nombreMes(d.mes)}, los mismos ${d.dias} días de los dos meses.</i>`);
  if (d.sinDatos.length) {
    L.push(`<i>Sin datos de ${nombreMes(d.mesAnt)}: ${d.sinDatos.map((x) => x.nombre).join(', ')}</i>`);
  }
  return L.join('\n');
}

/** El mismo texto pero sin etiquetas, para copiar y pegar en WhatsApp. */
function textoPlano(d) {
  return texto(d).replace(/<[^>]+>/g, '');
}

module.exports = { armar, texto, textoPlano, mesAnterior, num };
