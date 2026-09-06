/* ── EL ESPACIO TBS ──────────────────────────────────────────────────────────────────────────
   Todas las pantallas de /tbs: ofertas, precios por cliente, clientes, cuentas del mes, cierre
   y reporte diario. Vivía adentro de os.html, que servía tres espacios distintos y los
   distinguía con un `if` por la URL — así, tocar una pantalla del panel podía romper TBS y al
   revés. Ya había pasado.

   Lo que necesita de afuera son ayudantes genéricos (`api`, `esc`, `money`, `toast`, `val`,
   `seccion`, `ayuda`, `MX_STYLE`, `CIE_STYLE`) y `VIEWS`. Nada de las pantallas del panel. */
/* ───────── 🔌 API (TBS) ──────────────────────────────────────────────────────────────────
   El otro negocio. No comparte NADA con el de fichas: otros clientes, otros porcentajes, y el
   % es por SELLO (grupo de proveedores), no uno solo por cliente.

   Los precios vienen de dos lugares y no valen lo mismo, así que se ven distinto:
     VERIFICADO → salió de un mes ya facturado. Se cobró así.
     sin verificar → salió de la tabla de precios, que está desactualizada.
   Facturar con uno o con el otro es la diferencia entre cobrar lo pactado y cobrar lo que
   alguien anotó alguna vez. */
let _apiSub='matriz', _apiMes=new Date().toISOString().slice(0,7);
VIEWS.api = () => { document.getElementById('main').innerHTML = apiHeader(); (API[_apiSub]||API.matriz)(); };
// En el espacio TBS cada subpantalla es una pestaña propia: la barra de arriba ya cumple el rol
// que cumplían los botones de adentro, y tenerlos dos veces era ruido.
['ofertas','matriz','clientes','cuentas','resumen'].forEach(k=>{
  VIEWS['tbs'+k] = () => { _apiSub=k; document.getElementById('main').innerHTML = '<div id="api-body"></div>'; API[k](); };
});

/* ── 📅 EL REPORTE DIARIO DE TBS ──────────────────────────────────────────────────────────────
   Casino y Europa tienen su acumulado día por día; TBS no lo tenía porque hay que preguntárselo al
   panel una vez por día y guardarlo. Cada día es UNA llamada (el árbol entero, todas las monedas,
   todos los grupos) y el primero tardó 3 segundos.

   La captura va de a un día y muestra el avance: aunque hoy sea rápido, un mes son 31 pedidos y
   una pantalla que se queda muda mientras tanto parece colgada. */
let _tdMes = new Date().toISOString().slice(0,7);
let _tdMoneda = 'ARS';
let _tdCapturando = false;

let _tdAbiertos = new Set();      // qué clientes quedaron desplegados

/* ── POR QUÉ NO ALCANZA CON EL PROFIT ─────────────────────────────────────────────────────────
   Un cliente puede bajar el profit por dos motivos completamente distintos:
     · trae MENOS JUGADO — se le fue el negocio. Es un problema y hay que llamarlo.
     · los jugadores GANARON MÁS — mala racha. No es un problema: se da vuelta solo.
   Mirando sólo el profit los dos casos se ven iguales, y llevan a decisiones opuestas.

   Por eso se muestran los tres: lo JUGADO (in), el PROFIT, y cuánto QUEDA de cada 100 jugados.
   "Queda" es el que saca la suerte del medio. Se llamaba MARGEN y nadie tiene por qué saber qué
   es eso: dicho como "de cada 100 que juegan, te quedan 11,8" se entiende sin explicación.

   ── CONTRA QUÉ SE COMPARA ────────────────────────────────────────────────────────────────────
   Contra EL MISMO TRAMO DEL MES PASADO: si hoy es 19, agosto del 01 al 19 contra julio del 01 al 19.

   Antes se partía el mes al medio —del 01 al 09 contra el 10 al 19— porque era lo único posible
   con un solo mes guardado. Tenía dos problemas: la primera mitad de un mes no es una referencia
   estable (tres días de racha la deforman), y sobre todo era una comparación que nadie hace de
   cabeza. La pregunta real es "¿cómo veníamos el mes pasado a esta altura?", y con dos meses
   guardados ya se puede contestar.

   Se comparan SÓLO los días capturados en LOS DOS meses. Si a uno le falta un día, ese día no
   entra en ninguno de los dos lados: 19 días contra 18 mostraría una caída que no existe. */

/** El mes anterior. A mano y no con Date(): un string 'YYYY-MM' pasado por Date se corre de mes
    según la zona horaria del navegador, y el reporte quedaría comparando contra el mes equivocado. */
function tdMesAnterior(m) {
  const a = Number(String(m).slice(0, 4)), n = Number(String(m).slice(5, 7));
  return n > 1 ? a + '-' + String(n - 1).padStart(2, '0') : (a - 1) + '-12';
}
const TD_MESES = ['', 'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto',
  'septiembre', 'octubre', 'noviembre', 'diciembre'];

/* Un porcentaje deja de leerse cuando pasa de unos cientos: "+1.900%" hay que traducirlo, "×20"
   no. Se cambia de unidad a partir de 6 veces, que es donde el porcentaje ya no ayuda. */
/* «MULT2-CAL-ARS-PROD» adentro de una etiqueta la parte en dos renglones y no aporta: el sufijo
   dice la moneda y el ambiente, que ya están en la fila. Se deja la primera parte, que es como lo
   nombra la dueña ("sin Mult2"). Si el nombre ya es corto, no se toca. */
function tdCorto(login) {
  const s = String(login || '');
  if (s.length <= 12 || !s.includes('-')) return s;
  return s.split('-')[0];
}

function tdDelta(pct, ratio) {
  if (pct == null) return null;
  if (ratio != null && ratio >= 6) return '×' + money(ratio, ratio < 10 ? 1 : 0);
  // Redondear −0,4% daba "-0%", que se lee como una caída y no es ninguna: es no haberse movido.
  if (Math.abs(pct) < 0.5) return '0%';
  return (pct > 0 ? '+' : '') + money(pct, 0) + '%';
}

/* LA COMPARACIÓN, SUELTA Y PURA: entran dos tramos {bet,win,profit} —el de este mes y el mismo
   tramo del mes pasado— y sale todo lo que hay que decir de ellos.

   Está afuera de la vista a propósito. Adentro era una función anónima dentro de un closure, y lo
   único que se podía verificar de ella era que el texto estuviera escrito en el archivo. Acá se le
   pueden pasar números y mirar qué contesta, que es lo único que prueba que la cuenta está bien. */
function tdComparar(h, a) {
  if (!a) return { hay: false };
  const q = (b, p) => (b ? (p / b) * 100 : null);
  // El mes pasado no jugaba: cualquier porcentaje sobre una base de casi cero es cierto y no
  // significa nada. Hubo una cuenta con +1.716.225%.
  const nuevo = a.bet <= 0 || a.bet < (a.bet + h.bet) * 0.01;
  // El profit se compara sólo si el mes pasado dio ganancia: "cayó 300%" desde una pérdida no se
  // entiende, y el número que importa en ese caso es el profit mismo, que ya está en la columna.
  const conP = !nuevo && a.profit > 0;
  // De ganar a perder no es "-150%": es haber dado vuelta el signo, y así se dice.
  const aPerdida = conP && h.profit < 0;
  return {
    hay: true, nuevo, aPerdida,
    vol:   nuevo ? null : ((h.bet - a.bet) / a.bet) * 100,
    rVol:  nuevo ? null : h.bet / a.bet,
    volP:  conP ? ((h.profit - a.profit) / a.profit) * 100 : null,
    rVolP: conP ? h.profit / a.profit : null,
    qAnt: q(a.bet, a.profit), qNue: q(h.bet, h.profit),
    // Los profits crudos: el veredicto necesita saber si SUBIÓ o BAJÓ incluso cuando no se puede
    // dar un porcentaje (el mes pasado en cero, o de ganancia a pérdida).
    pAnt: a.profit, pNue: h.profit,
  };
}

/* ── EL CARTEL DICE LAS DOS COSAS QUE PASARON ────────────────────────────────────────────────
   Un mes se explica con dos movimientos y nada más:

     · el JUGADO — cuánta plata entró a apostarse. Es el negocio: si cae, se está yendo el cliente
       y no vuelve solo.
     · el RTP — qué parte se llevaron los jugadores. A un mes es suerte, y se da vuelta solo.

   Y el PROFIT es el resultado de los dos: jugado × (1 − RTP). Por eso el cartel nombra los dos
   movimientos —«menos jugado, más profit»— en vez de una sola palabra: «estable» para NachoAPI
   escondía la noticia, que era que jugaron 11% menos y aun así quedó 11% más.

   El TONO (de qué tarjeta cuenta arriba) lo sigue decidiendo el JUGADO, no el profit: un mes con
   más profit sobre un jugado que se derrumba no es una buena noticia, es un buen mes adentro de
   un cliente que se va. */
function tdVeredicto(cmp, nomAnt) {
  if (!cmp || !cmp.hay) return { txt: '', tono: '', det: '' };
  if (cmp.nuevo) return { txt: 'nuevo', tono: 'bien', det: 'no jugaba en ' + nomAnt };
  const volPct = cmp.vol;
  if (volPct == null) return { txt: '', tono: '', det: '' };
  const dpp = (cmp.qNue != null && cmp.qAnt != null) ? (cmp.qNue - cmp.qAnt) : null;

  // Se movió de verdad, o es ruido. 10% en cualquiera de los dos.
  const MOV = 10;
  const dirJ = volPct >= MOV ? 1 : (volPct <= -MOV ? -1 : 0);
  /* La dirección del profit sale de los números crudos y no del porcentaje: hay meses sin
     porcentaje posible —el anterior en cero, o de ganancia a pérdida— y ahí igual se sabe
     perfectamente para qué lado se movió. */
  const dirP = (cmp.pAnt == null || cmp.pNue == null) ? 0 : (() => {
    const base = Math.abs(cmp.pAnt) || Math.abs(cmp.pNue);
    if (!base) return 0;
    const d = ((cmp.pNue - cmp.pAnt) / base) * 100;
    return d >= MOV ? 1 : (d <= -MOV ? -1 : 0);
  })();

  const PAL = { '-1': 'menos', 0: 'mismo', 1: 'más' };
  const txt = dirJ === 0 && dirP === 0 ? 'igual que en ' + nomAnt
    : PAL[dirJ] + ' jugado, ' + PAL[dirP] + ' profit';

  // El detalle: qué significa esa combinación, en una línea.
  let det = '';
  if (dirJ < 0 && dirP > 0) det = 'jugaron menos y aun así te quedó más: lo puso el RTP, no el cliente';
  else if (dirJ < 0 && dirP < 0) det = 'se le está yendo el negocio';
  else if (dirJ < 0) det = 'trae menos jugado y el profit se mantuvo';
  else if (dirJ > 0 && dirP > 0) det = 'está creciendo';
  else if (dirJ > 0 && dirP < 0) det = 'trae más jugado, pero ganaron los jugadores';
  else if (dirJ > 0) det = 'trae más jugado y el profit se mantuvo';
  else if (dirP < 0) det = 'juega lo mismo: ganaron los jugadores, es racha';
  else if (dirP > 0) det = 'juega lo mismo y te quedó más: bajó el RTP';

  /* El tono, igual que antes: manda el jugado, y sólo si el jugado está quieto se mira el RTP.
     Son las tres tarjetas de arriba y por eso no se tocan sus umbrales. */
  let tono = '';
  if (volPct <= -15) tono = 'mal';
  else if (dpp != null && dpp <= -3) tono = 'ojo';
  else if (volPct >= 15) tono = 'bien';
  else if (dpp != null && dpp >= 3) tono = 'bien';
  return { txt, tono, det };
}

/* Una línea que se lee de un vistazo: el jugado de cada día. No lleva ejes ni números —para eso
   está la tabla— sino la FORMA: si viene cayendo dentro del mes, se ve cayendo.

   EL COLOR LO PONE EL VEREDICTO DE LA FILA, no la forma de la línea. Se pintaba comparando las dos
   mitades del mes, y con la comparación contra el mes pasado eso pasó a contradecirse en la misma
   fila: TBSDavidLatam trae +230% contra julio —dice "creciendo" en verde— y adentro de agosto viene
   bajando desde un pico enorme del día 6, así que la línea salía ROJA al lado de la palabra verde.
   Los dos datos son ciertos y no se pisan: la forma es de adentro del mes, el veredicto es contra
   julio. Pero dos colores peleados en un renglón no informan, confunden. Manda el veredicto, que es
   la conclusión; la forma sigue estando en el dibujo. */
function tdSpark(vals, tono, ancho=90, alto=22) {
  const max = Math.max(...vals, 1);
  if (!vals.length) return '';
  const paso = vals.length>1 ? ancho/(vals.length-1) : ancho;
  const pts = vals.map((v,i)=>`${(i*paso).toFixed(1)},${(alto - (v/max)*(alto-2)).toFixed(1)}`).join(' ');
  const col = { mal:'var(--red)', ojo:'var(--gold)', bien:'var(--green)' }[tono] || 'var(--muted)';
  return `<svg width="${ancho}" height="${alto}" style="vertical-align:middle">
    <polyline points="${pts}" fill="none" stroke="${col}" stroke-width="1.5" stroke-linejoin="round"/></svg>`;
}

/* EL DÍA A DÍA, HACIA ABAJO.
   Los días eran columnas: había que barrer con la vista de izquierda a derecha, y a partir del día
   12 la tabla se salía de la pantalla. Puestos uno debajo del otro se leen como se lee cualquier
   lista —de arriba hacia abajo— y las tres cantidades quedan enfrentadas en la misma fila.

   La barra al lado del jugado es lo que hace el trabajo: la tendencia se ve sin leer un número.
   Abajo van los dos totales, uno debajo del otro, para el mismo tramo de los dos meses. */
function tdDetalle(c, dias, ref) {
  const bets = dias.map(f => (c.dias[f]||{}).bet || 0);
  const max = Math.max(...bets, 1);
  let tb=0, tw=0, tp=0;
  const filas = dias.map(f => {
    const d = c.dias[f];
    if (!d) return `<tr><td class="muted" style="font-size:12px">${String(f).slice(8,10)}</td>
      <td colspan="5" class="muted" style="font-size:11px">sin datos</td></tr>`;
    tb+=d.bet; tw+=d.win; tp+=d.profit;
    const q = d.bet ? (d.profit/d.bet)*100 : null;
    const w = Math.round((d.bet/max)*100);
    return `<tr>
      <td class="muted" style="font-size:12px;width:30px">${String(f).slice(8,10)}</td>
      <td style="width:84px;padding-right:10px"><div style="height:7px;border-radius:4px;
        background:var(--gold);opacity:.7;width:${w}%"></div></td>
      <td class="right" style="font-size:12px">${money(d.bet,0)}</td>
      <td class="right muted" style="font-size:12px">${money(d.win,0)}</td>
      <td class="right" style="font-size:12px"><b style="${d.profit<0?'color:var(--red)':''}">${money(d.profit,0)}</b></td>
      <td class="right muted" style="font-size:11px">${q==null?'':money(q,1)+'%'}</td></tr>`;
  }).join('');
  const tot = (lab, b, w2, p, fuerte) => `<tr style="${fuerte?'border-top:2px solid var(--border)':''}">
      <td colspan="2" style="font-size:11px;${fuerte?'':'color:var(--muted)'}"><b>${esc(lab)}</b></td>
      <td class="right" style="font-size:12px;${fuerte?'':'color:var(--muted)'}"><b>${money(b,0)}</b></td>
      <td class="right" style="font-size:12px;color:var(--muted)"><b>${money(w2,0)}</b></td>
      <td class="right" style="font-size:12px;${fuerte?'':'color:var(--muted)'}"><b style="${p<0?'color:var(--red)':''}">${money(p,0)}</b></td>
      <!-- RTP = lo que se llevan los jugadores = premios / jugado. Es 100 menos lo que te queda. -->
      <td class="right" style="font-size:11px;${fuerte?'':'color:var(--muted)'}"><b>${b?money(100-(p/b)*100,1)+'%':''}</b></td></tr>`;
  return `<div style="max-width:640px">
    <div class="muted" style="font-size:11px;margin:0 0 4px">Día a día · ${esc(c.moneda)}</div>
    <table style="width:100%"><thead><tr>
      <th style="font-size:10px">Día</th><th></th>
      <th class="right" style="font-size:10px">Jugado (in)</th>
      <th class="right" style="font-size:10px">Premios (out)</th>
      <th class="right" style="font-size:10px">Profit</th>
      <th class="right" style="font-size:10px" title="Lo que se llevan los jugadores de cada 100 jugados. Cuanto más alto, menos te queda a vos.">RTP</th>
    </tr></thead><tbody>${filas}
      ${tot('Este mes', tb, tw, tp, true)}
      ${ref ? tot(ref.lab, ref.bet, ref.win, ref.profit, false) : ''}
    </tbody></table></div>`;
}

VIEWS.tbsdiario = async () => {
  const main = document.getElementById('main');
  main.innerHTML = '<div class="card"><div class="muted">Cargando…</div></div>';
  const mesAnt = tdMesAnterior(_tdMes);
  const nomAnt = TD_MESES[Number(mesAnt.slice(5,7))] || mesAnt;
  const nomEste = TD_MESES[Number(_tdMes.slice(5,7))] || _tdMes;
  const [plan, dat, ant, tcd] = await Promise.all([
    api('/api/os/tbs/diario/plan?mes='+_tdMes),
    api('/api/os/tbs/diario?mes='+_tdMes),
    api('/api/os/tbs/diario?mes='+mesAnt),
    api('/api/os/tc/del-mes?mes='+_tdMes),
  ]);
  const TC = {}; (tcd.monedas||[]).forEach(m=>{ if(Number(m.valor)) TC[m.divisa]=Number(m.valor); });
  const dias = dat.dias||[];
  const falt = (plan.faltan||[]).length;
  const seg = plan.segundos_estimados;
  const dd = f => String(f).slice(8,10);

  // Los días que están capturados en LOS DOS meses. 19 días contra 18 daría una caída inventada.
  const sAnt = new Set((ant.dias||[]).map(dd));
  const comunes = dias.map(dd).filter(x => sAnt.has(x));
  const hayComp = comunes.length > 0;
  const parcial = hayComp && comunes.length < dias.length;
  const tramo = hayComp ? comunes[0]+' al '+comunes[comunes.length-1] : '';

  const sumar = (c, mes) => { let b=0,w=0,p=0;
    for (const n of comunes) { const d = c.dias[mes+'-'+n]; if (d) { b+=d.bet; w+=d.win; p+=d.profit; } }
    return { bet:b, win:w, profit:p }; };
  const idxAnt = new Map();
  if (hayComp) (ant.clientes||[]).forEach(c => idxAnt.set(c.agente_id+'|'+c.moneda, sumar(c, ant.mes)));

  /* ── EL TOTAL DE LOS DOS MESES, EN EL MISMO TRAMO ────────────────────────────────────────────
     Cada cliente ya traía su comparación, pero no había en ningún lado la respuesta a la pregunta
     de arriba de todo: «¿este mes viene mejor o peor que el pasado, y por cuánto?».

     Se pasa a USDT porque los clientes están en nueve monedas y en pesos no se suman. Y los DOS
     meses se convierten con el MISMO tipo de cambio —el de este mes— a propósito: con el de cada
     mes, una devaluación sola aparecería como que el negocio se cayó. Acá se quiere medir el
     negocio, no el dólar.

     ⚠️ Una moneda sin tipo de cambio NO se suma como cero: se la nombra abajo. Sumarla en cero es
     la forma de que falte plata sin que nadie lo note — ya pasó con el guaraní. */
  const sinTC = new Set();
  const aUsdt = (v, mon) => {
    if (mon === 'USD' || mon === 'USDT') return v;
    const t = TC[mon];
    if (!t) { sinTC.add(mon); return null; }
    return v / t;
  };
  /* ⚠️ NO SE SUMAN LOS QUE ESTÁN ADENTRO DE OTRO. En TBS un padre trae su subárbol adentro, y de
     los agentes que se capturan hay uno que cuelga de otro: MULT2-CAL-ARS-PROD cuelga de NachoAPI,
     así que el número de NachoAPI YA lo incluye. Sumando los 22 el total daba 6.302.228 USDT
     cuando lo real son 5.360.000 — casi un millón de más, y en pantalla no se nota. El servidor
     los marca con `dentroDe` para que ninguna pantalla tenga que acordarse sola. */
  const anidados = (dat.clientes||[]).filter(c => c.dentroDe);
  const totalDe = (lista, mes) => {
    let bet = 0, profit = 0;
    for (const c of lista) {
      if (c.dentroDe) continue;
      const x = sumar(c, mes);
      const b = aUsdt(x.bet, c.moneda), pr = aUsdt(x.profit, c.moneda);
      if (b == null || pr == null) continue;
      bet += b; profit += pr;
    }
    return { bet, profit };
  };
  const TOT  = hayComp ? totalDe(dat.clientes||[], dat.mes) : null;
  const TOTA = hayComp ? totalDe(ant.clientes||[], ant.mes) : null;
  const varPct = (nue, viejo) => (viejo ? (nue / viejo - 1) * 100 : null);
  const flechaT = (v) => v == null ? '<span class="muted">—</span>'
    : `<span style="color:${v >= 0 ? 'var(--verde2)' : 'var(--rosa)'};font-weight:700">${
        v >= 0 ? '▲' : '▼'} ${money(Math.abs(v), 0)}%</span>`;

  // Una fila por CLIENTE con su moneda principal; las otras se despliegan. Se esconde lo que no
  // movió nada: una fila de ceros no es información.
  const vivos = (dat.clientes||[]).filter(c => c.bet !== 0 || c.win !== 0 || c.profit !== 0);
  const escondidas = (dat.clientes||[]).length - vivos.length;
  /* ── EL QUE ESTÁ ADENTRO DE OTRO NO VA COMO FILA SUELTA ──────────────────────────────────────
     Desde que el padre se abre en Total / Sin / Sólo, tener al hijo TAMBIÉN arriba es mostrar lo
     mismo dos veces. Y era peor que redundante: MULT2 caía en «traen menos jugado» y sumaba al
     contador de esa tarjeta, así que un problema que ya estaba adentro de NachoAPI se contaba como
     un cliente aparte. Los contadores de arriba y la lista tienen que ser cosas que se puedan
     sumar; lo de adentro se mira abriendo su padre. */
  const anidadasVivas = vivos.filter(c => c.dentroDe);
  const sueltos = vivos.filter(c => !c.dentroDe);
  const porCliente = new Map();
  sueltos.forEach(c => {
    const g = porCliente.get(c.login) || { login: c.login, filas: [] };
    g.filas.push(c); porCliente.set(c.login, g);
  });

  const queda = (b, p) => b ? (p/b)*100 : null;
  const analizar = (c) => {
    const a = hayComp ? idxAnt.get(c.agente_id+'|'+c.moneda) : null;
    const cmp = tdComparar(a ? sumar(c, dat.mes) : null, a);
    return { ...cmp, queda: queda(c.bet, c.profit), ant: a,
      v: tdVeredicto(cmp, nomAnt) };
  };

  /* ── PARTIR AL PADRE EN «SIN EL HIJO» Y «SÓLO EL HIJO» ───────────────────────────────────────
     El número de NachoAPI incluye a MULT2-CAL-ARS-PROD, y los dos están en la tabla: se ve el
     total dos veces y no se ve nunca cuánto es cada parte. Como el hijo está ENTERO adentro del
     padre, restarlo es exacto — y sólo en su misma moneda, que es donde el hijo suma.
     Se muestran las tres: sin él, sólo él, y el total (que es lo que muestra el panel de TBS). */
  const hijosDe = new Map();
  (dat.clientes||[]).forEach(h => {
    if (!h.dentroDe) return;
    const k = h.dentroDe + '|' + h.moneda;
    hijosDe.set(k, [...(hijosDe.get(k) || []), h]);
  });
  const restar = (padre, hijos) => {
    const dias2 = {};
    Object.keys(padre.dias || {}).forEach(f => {
      const d = padre.dias[f];
      const m = hijos.reduce((a,h)=>{ const x=(h.dias||{})[f]; return x ? {bet:a.bet+x.bet, win:a.win+x.win, profit:a.profit+x.profit} : a; },
        {bet:0,win:0,profit:0});
      dias2[f] = { bet: d.bet-m.bet, win: d.win-m.win, profit: d.profit-m.profit };
    });
    return { ...padre, login: padre.login, dias: dias2, dentroDe: null,
      bet: padre.bet - hijos.reduce((a,h)=>a+h.bet,0),
      win: padre.win - hijos.reduce((a,h)=>a+h.win,0),
      profit: padre.profit - hijos.reduce((a,h)=>a+h.profit,0) };
  };

  /* Una fila armada por nosotros no está en `idxAnt`, así que su mes anterior también hay que
     restarlo: el padre de julio menos el hijo de julio, o la comparación saldría contra el total. */
  const analizarArmada = (nue, ant) => {
    const cmp = tdComparar(ant ? { bet:nue.bet, win:nue.win, profit:nue.profit } : null, ant);
    return { ...cmp, queda: queda(nue.bet, nue.profit), ant,
      v: tdVeredicto(cmp, nomAnt) };
  };

  const grupos = [...porCliente.values()].map(g => {
    g.filas.sort((a,b)=>Math.abs(b.bet)-Math.abs(a.bet));   // manda la moneda de más JUGADO
    g.principal = g.filas[0];
    g.otras = g.filas.slice(1);
    g.a = analizar(g.principal);
    g.hijos = hijosDe.get(g.principal.login + '|' + g.principal.moneda) || [];
    return g;
  });
  // Primero lo que hay que mirar: los que traen menos jugado, después los de racha, después el resto.
  const peso = { mal:0, ojo:1, '':2, bien:3 };
  grupos.sort((x,y)=> (peso[x.a.v.tono]-peso[y.a.v.tono]) || ((x.a.vol??0)-(y.a.vol??0)));
  const cuenta = t => grupos.filter(g=>g.a.v.tono===t).length;

  /* JUGADO y PROFIT van pegados, y cada uno lleva su comparación DEBAJO en chico. Antes había
     cuatro columnas entre los dos números —vs, margen, margen 1ª→2ª— y para leer un cliente había
     que cruzar toda la pantalla. Lo que se compara con algo va junto a ese algo, no en otra
     columna. */
  /* El % solo no alcanza: «−68%» no dice si se perdieron mil o un millón, y son dos conversaciones
     distintas. Va también la DIFERENCIA en la moneda del cliente, que es la pregunta de "cuánto
     más, cuánto menos". El «vs. julio» se fue al encabezado: era la misma palabra repetida
     veintidós veces, una por fila. */
  /* TRES RENGLONES, EN EL ORDEN EN QUE SE LEE: este mes, el mes pasado, y la diferencia.
     Estaba el número, después el % con la diferencia, y recién abajo el mes pasado — así los dos
     números que hay que comparar quedaban separados por un renglón y no se podían mirar juntos.
     Ahora van pegados y alineados a la derecha, que es lo que deja ver de un vistazo cuál es más
     grande sin leer una sola cifra. */
  const celda = (val, pct, ratio, neg, antes) => {
    const col = pct==null ? 'var(--muted)' : (pct<0?'var(--rosa)':(pct>0?'var(--verde2)':'var(--muted)'));
    const dif = (antes==null||val==null) ? null : val-antes;
    return `<div style="font-weight:700;${neg?'color:var(--rosa)':''}">${money(val,0)}</div>
      ${antes==null?'':`<div class="muted" style="font-size:12.5px">${money(antes,0)}
        <span style="font-size:11px">${esc(nomAnt)}</span></div>`}
      ${(dif==null&&pct==null)?'':`<div style="font-size:12.5px;color:${col};font-weight:600">${
        dif==null?'':(dif>=0?'+':'−')+money(Math.abs(dif),0)}${
        pct==null?'':` <span style="font-size:11px;font-weight:400">${esc(tdDelta(pct,ratio))}</span>`}</div>`}`;
  };

  const filaCliente = (c, a, sub) => {   // `a` trae el veredicto en a.v: de ahí sale el color
    const vals = dias.map(f=>(c.dias[f]||{}).bet||0);
    return `<td class="muted">${esc(c.moneda)}</td>
      <td>${sub?'':tdSpark(vals, a.v && a.v.tono)}</td>
      <td class="right" style="padding-right:20px">${celda(c.bet, a.vol, a.rVol, false, a.ant?a.ant.bet:null)}
        ${a.nuevo?`<div class="muted" style="font-size:11px">no jugaba en ${esc(nomAnt)}</div>`:''}</td>
      <td class="right" style="padding-right:20px">${a.aPerdida
        ? `<div style="font-weight:700;color:var(--rosa)">${money(c.profit,0)}</div>
           <div class="muted" style="font-size:12.5px">${money(a.ant.profit,0)}
             <span style="font-size:11px">${esc(nomAnt)}</span></div>
           <div style="font-size:12.5px;color:var(--rosa);font-weight:600">−${money(Math.abs(c.profit-a.ant.profit),0)}
             <span style="font-size:11px;font-weight:400">pasó a pérdida</span></div>`
        : celda(c.profit, a.volP, a.rVolP, c.profit<0, a.ant?a.ant.profit:null)}</td>
      <td class="right"><div style="font-weight:700">${a.queda==null?'—':money(100-a.queda,1)+'%'}</div>
        ${(a.hay && !a.nuevo && a.qAnt!=null)?(()=>{
          /* Los mismos tres renglones que las otras dos columnas: ahora, antes, y la diferencia.
             ⚠️ PERO EL RTP VA AL REVÉS. En jugado y profit, subir es bueno. Acá subir es que los
             jugadores se llevaron MÁS, o sea peor. El verde y el rosa están dados vuelta a
             propósito: sin eso quedaría un ▲ verde justo donde el mes fue peor. */
          const rtpNue = 100 - a.queda, rtpAnt = 100 - a.qAnt;
          const d = rtpNue - rtpAnt;
          const col = Math.abs(d) < 0.05 ? 'var(--muted)' : (d > 0 ? 'var(--rosa)' : 'var(--verde2)');
          const sig = Math.abs(d) < 0.05 ? '=' : (d > 0 ? '▲' : '▼');
          return `<div class="muted" style="font-size:12.5px">${money(rtpAnt,1)}%
              <span style="font-size:11px">${esc(nomAnt)}</span></div>
            <div style="font-size:12.5px;color:${col};font-weight:600">${sig} ${money(Math.abs(d),1)}
              <span style="font-size:11px;font-weight:400">pts</span></div>`;
        })():''}</td>`;
  };

  main.innerHTML = `
    <div class="card">
      <h2>📅 Reporte diario <span class="muted">(TBS)</span>
        <input type="month" value="${esc(_tdMes)}" onchange="_tdMes=this.value;VIEWS.tbsdiario()"
          style="width:auto;display:inline-block;margin-left:8px"></h2>
      <div class="row" style="margin-top:8px;gap:8px;align-items:center;flex-wrap:wrap">
        <div class="muted"><b>${plan.capturados||0}</b> de <b>${plan.dias||0}</b> días</div>
        ${falt ? `<button class="small" id="td-btn" onclick="tdCapturar()">⬇ ${falt===1?'Traer el día que falta':'Traer los '+falt+' que faltan'}${
          seg!=null ? ' (~'+(seg<60?seg+' seg':Math.ceil(seg/60)+' min')+')' : ''}</button>`
        : '<span class="badge ok">completo</span> <span class="muted" style="font-size:11px">se actualiza solo a las 6 AM (hora del panel)</span>'}
        <span id="td-prog" class="muted"></span>
      </div>
    </div>

    ${!grupos.length ? '<div class="card"><div class="empty">Todavía no hay días guardados de este mes.</div></div>' : `
    ${hayComp ? `<div class="card">
      <div class="tapa"><div>
        <h2>${esc(nomEste.charAt(0).toUpperCase()+nomEste.slice(1))} contra ${esc(nomAnt)}</h2>
        <div class="sub">Del <b>${esc(tramo)}</b> de los dos meses, todo pasado a USDT</div>
      </div></div>
      <!-- ── SÓLO EL PORCENTAJE ──────────────────────────────────────────────────────────────
           Los montos en USDT salían de pasar nueve monedas a dólares con un tipo de cambio que
           todavía se mueve: son un estimado, y puesto en grande al lado de cifras exactas se lee
           como si fuera plata cerrada. El PORCENTAJE, en cambio, aguanta: si los dos meses se
           convierten con el mismo cambio, la proporción no depende de cuál sea.
           Y el RTP no va: está en la tabla de abajo, cliente por cliente, que es donde sirve. -->
      <div class="tc-tiles" style="margin-top:12px;grid-template-columns:repeat(auto-fill,minmax(150px,1fr))">
        ${(()=>{
          const ficha = (rot, pct) => {
            const col = pct==null ? 'var(--muted)' : (pct>=0?'var(--verde2)':'var(--rosa)');
            const sig = pct==null ? '' : (pct>=0?'▲':'▼');
            return `<div class="tc-t"><div class="d">${rot}</div>
              <div class="v" style="color:${col}">${pct==null?'—':sig+' '+money(Math.abs(pct),0)+'%'}</div>
              <div class="f">contra ${esc(nomAnt)}</div></div>`;
          };
          return ficha('IN', varPct(TOT.bet, TOTA.bet)) + ficha('PROFIT', varPct(TOT.profit, TOTA.profit));
        })()}
      </div>
      <div class="muted" style="margin-top:10px;font-size:12px">* son un estimado: los dos meses
        se pasan a USDT con el mismo tipo de cambio, y puede cambiar.
        ${sinTC.size?`<b style="color:var(--rosa)">Falta el de ${[...sinTC].join(', ')}: esos clientes no están adentro.</b>`:''}
      </div>
    </div>

    <!-- align-items:stretch — la clase .row alinea abajo, así que las tres tarjetas quedaban a
         distinta altura según cuánto texto tuviera cada una y se veían escalonadas.
         (Sin comillas invertidas acá: esto vive adentro de una plantilla y las corta.) -->
    <div class="row" style="gap:10px;flex-wrap:wrap;margin-bottom:12px;align-items:stretch">
      <div class="card" style="flex:1;min-width:200px;margin:0;border-left:3px solid var(--red)">
        <label>Traen menos jugado</label>
        <div style="font-size:26px;font-weight:800;color:${cuenta('mal')?'var(--red)':'inherit'}">${cuenta('mal')}</div>
        <div class="muted" style="font-size:12px">Se les está yendo el negocio. Es lo que hay que atender.</div></div>
      <div class="card" style="flex:1;min-width:200px;margin:0;border-left:3px solid var(--gold)">
        <label>Mala racha</label>
        <div style="font-size:26px;font-weight:800">${cuenta('ojo')}</div>
        <div class="muted" style="font-size:12px">Juegan lo mismo, ganaron los jugadores. Se da vuelta solo.</div></div>
      <div class="card" style="flex:1;min-width:200px;margin:0;border-left:3px solid var(--green)">
        <label>Creciendo</label>
        <div style="font-size:26px;font-weight:800">${cuenta('bien')}</div>
        <div class="muted" style="font-size:12px">Traen más jugado que en ${esc(nomAnt)}, o les bajó el RTP.</div></div>
    </div>` : ''}

    <!-- ── MANDAR LA COMPARATIVA ────────────────────────────────────────────────────────────────
         El mensaje que se escribía a mano en WhatsApp cuando le preguntan por un cliente. Se
         elige a quién, se MIRA lo que va a salir, y recién ahí se manda o se copia. -->
    <details class="plegable" style="margin-bottom:12px"${_secAb.has('tbs.comp')?' open':''}
        ontoggle="secEstado('tbs.comp',this.open); if(this.open) tdCompPintar()">
      <summary class="fila"><span class="chev" aria-hidden="true"></span>
        <span class="nom">📨 Mandar una comparativa</span>
        <span class="cifra"><span class="u">elegís a quién y sale por Telegram</span></span></summary>
      <div class="cuerpo">
        ${ayuda('tbs-comp',
          'Arma el mensaje que mandás cuando te preguntan por un cliente: jugado, premios y profit de los dos meses, con la diferencia.',
          'Sale por el <b>grupo interno</b> —el que está en ⚙ Config → Telegram—, nunca al grupo de un cliente. El tramo son los días capturados en <b>los dos</b> meses: 27 contra 26 daría una caída que no existe.')}
        <div class="acciones" style="margin:0 0 10px">
          <button class="outline small" onclick="tdCompTodos(true)">Marcar todos</button>
          <button class="outline small" onclick="tdCompTodos(false)">Ninguno</button>
        </div>
        <div style="display:flex;flex-wrap:wrap;gap:10px 16px">
          ${grupos.map(g=>`<label style="display:inline-flex;align-items:center;gap:5px;font-size:13px;cursor:pointer">
            <input type="checkbox" class="td-comp" value="${esc(g.principal.agente_id)}"
              onchange="tdCompPintar()" style="width:auto;margin:0"> ${esc(g.login)}</label>`).join('')}
        </div>
        <div id="td-comp-out" style="margin-top:12px"></div>
      </div>
    </details>

    <div class="card">
      <h2>Cada cliente <span class="muted">(${grupos.length})</span></h2>
      <div class="muted" style="margin-bottom:10px;max-width:900px">
        <b>Jugado</b> es todo lo que apostaron. <b>Profit</b> es lo que quedó (jugado − premios).
        <b>RTP</b> es lo que se llevan los jugadores de cada 100 jugados.
        <b style="color:var(--rosa)">Ojo: en esta columna, más alto es peor</b> — cuanto más se
        llevan, menos te queda. Por eso acá el ▲ va en rosa y el ▼ en verde, al revés que en las
        otras dos.
        <div style="margin-top:4px">Sirve para separar dos cosas que en el profit se ven iguales:
        si <b>cae el jugado</b> se está yendo el negocio; si el jugado se mantiene pero <b>sube el RTP</b>,
        ganaron los jugadores y se da vuelta solo.</div>
        ${hayComp
          ? `<div style="margin-top:6px">Todo se compara contra <b>el mismo tramo de ${esc(nomAnt)}</b>:
              del <b>${esc(tramo)}</b> de los dos meses.${parcial?` De los ${dias.length} días de este mes,
              ${comunes.length} tienen su día correspondiente en ${esc(nomAnt)}; los demás no entran en la
              comparación de ninguno de los dos lados.`:''}</div>`
          : `<div style="margin-top:6px">No hay días guardados de <b>${esc(nomAnt)}</b>, así que este mes
              no se puede comparar contra nada. Los números están; las tendencias aparecen en cuanto haya
              un mes anterior.</div>`}
        <div style="margin-top:4px">Tocá el nombre para ver el día a día.</div></div>
      <div style="overflow-x:auto">
      <table style="min-width:100%"><thead><tr>
        <th>Cliente</th><th>Div</th><th>Jugado por día</th>
        <th class="right">Jugado (in)<div style="font-weight:400;text-transform:none;letter-spacing:0">y cuánto vs. ${esc(nomAnt)}</div></th>
        <th class="right">Profit<div style="font-weight:400;text-transform:none;letter-spacing:0">y cuánto vs. ${esc(nomAnt)}</div></th>
        <th class="right" title="Lo que se llevan los jugadores de cada 100 jugados. OJO: acá más alto es PEOR — cuanto más se llevan, menos te queda.">RTP<div style="font-weight:400;text-transform:none;letter-spacing:0">se llevan los jugadores</div></th>
        <th>Qué pasó</th>
      </tr></thead><tbody>
      ${grupos.map(g=>{
        const ab = _tdAbiertos.has(g.login);
        const tono = {mal:'var(--red)',ojo:'var(--gold)',bien:'var(--green)',''  :''}[g.a.v.tono];
        const abrible = g.otras.length || g.hijos.length;   // se abre también si hay que partirlo
        return `<tr${g.a.v.tono==='mal'?' style="background:rgba(217,83,79,.06)"':''}>
          <td style="${abrible?'cursor:pointer':''}" ${abrible?`onclick="tdToggle('${esc(g.login).replace(/'/g,"")}')"`:''}>
            ${abrible?`<span style="color:var(--gold);font-size:10px">${ab?'▾':'▸'}</span> `:''}<b>${esc(g.login)}</b>
            ${g.otras.length?`<span class="muted" style="font-size:11px">+${g.otras.length}</span>`:''}
            ${g.hijos.length?(()=>{
              // Si adentro hay uno que viene mal, la tarjeta cerrada tiene que decirlo: si no, el
              // problema se esconde justo por haberlo metido adentro del padre.
              const malos = g.hijos.filter(h=>{ const a2=analizar(h); return a2.v && a2.v.tono==='mal'; });
              return `<div class="señal ${malos.length?'rosa':'durazno'}" style="margin-top:4px;font-size:10.5px"
                title="Este número es el TOTAL: incluye ${g.hijos.map(h=>esc(h.login)).join(' + ')}. Abrilo para verlo partido.">incluye ${
                g.hijos.map(h=>esc(tdCorto(h.login))).join(' + ')}${malos.length?' ⚠':''}</div>`
              + (malos.length?`<div class="muted" style="font-size:10.5px;margin-top:2px">${
                  malos.map(h=>esc(tdCorto(h.login))).join(', ')} trae menos jugado — abrilo</div>`:'');
            })():''}
            <!-- En TBS un padre trae su subárbol adentro. Sin decirlo acá, la tabla invita a sumar
                 esta fila con la de su padre — que es justo lo que inflaba el total en un millón. -->
            ${g.principal.dentroDe?`<div class="señal durazno" style="margin-top:4px;font-size:10.5px"
              title="Su número ya está contado adentro de ${esc(g.principal.dentroDe)}: no se suman los dos">ya contado en ${esc(g.principal.dentroDe)}</div>`:''}</td>
          ${filaCliente(g.principal, g.a, false)}
          <td style="font-size:12px${tono?';color:'+tono:''}"><b>${esc(g.a.v.txt)}</b>
            ${g.a.v.det?`<div class="muted" style="font-size:11px">${esc(g.a.v.det)}</div>`:''}</td>
        </tr>`
        + (ab ? (g.hijos.length ? (()=>{
            // Las tres vistas de lo mismo, en el orden en que se piensan: primero el total —que es
            // el número que muestra el panel de TBS— y después de qué está hecho.
            const sinH = restar(g.principal, g.hijos);
            const antP = g.a.ant;
            const antH = g.hijos.map(h=>idxAnt.get(h.agente_id+'|'+h.moneda)).filter(Boolean);
            const antSin = (antP && antH.length===g.hijos.length)
              ? { bet: antP.bet-antH.reduce((a,x)=>a+x.bet,0), win: antP.win-antH.reduce((a,x)=>a+x.win,0),
                  profit: antP.profit-antH.reduce((a,x)=>a+x.profit,0) } : null;
            const linea = (etq, fila, ana) => `<tr class="sub">
              <td style="padding-left:18px;font-size:12.5px;font-weight:700">${etq}</td>
              ${filaCliente(fila, ana, true)}
              <td class="muted" style="font-size:11px">${esc((ana.v&&ana.v.txt)||'')}</td></tr>`;
            const corto = g.hijos.map(h=>esc(tdCorto(h.login))).join(' ni ');
            return linea('Total', g.principal, g.a)
              + linea('Sin ' + corto, sinH, analizarArmada(sinH, antSin))
              + g.hijos.map(h=>linea('Sólo ' + esc(tdCorto(h.login)), h, analizar(h))).join('');
          })() : '')
          + g.otras.map(o=>{const a2=analizar(o);return `<tr class="sub">
            <td></td>${filaCliente(o, a2, true)}
            <td class="muted" style="font-size:11px">${esc(a2.v.txt)}</td></tr>`;}).join('')
              + `<tr class="sub"><td colspan="7" style="padding:8px 0 14px">
                  ${tdDetalle(g.principal, dias, (g.a.hay && g.a.ant)
                    ? { lab: nomAnt+' ('+tramo+')', bet:g.a.ant.bet, win:g.a.ant.win, profit:g.a.ant.profit }
                    : null)}</td></tr>` : '');
      }).join('')}
      </tbody></table>
      </div>
      <div class="muted" style="margin-top:8px;font-size:12px">
        Las cuentas que en ${esc(nomAnt)} casi no jugaban dicen «nuevo» en vez de un porcentaje, y a partir
        de 6 veces se pasa a «×6», «×20» — un porcentaje de cuatro cifras hay que traducirlo.
        ${escondidas?`Se ocultaron <b>${escondidas}</b> cuenta(s) que no movieron nada.`:''}
        ${anidadasVivas.length?` ${anidadasVivas.map(c=>'<b>'+esc(c.login)+'</b>').join(', ')}
          no ${anidadasVivas.length===1?'aparece':'aparecen'} como fila aparte:
          ${anidadasVivas.length===1?'está':'están'} adentro de
          ${[...new Set(anidadasVivas.map(c=>c.dentroDe))].map(esc).join(', ')}, que se abre para verlo partido.`:''}</div>
    </div>`}
  `;
};
function tdToggle(login){ if(_tdAbiertos.has(login)) _tdAbiertos.delete(login); else _tdAbiertos.add(login); VIEWS.tbsdiario(); }

/* Trae los días que faltan, DE A UNO y en orden.
   En serie y no en paralelo a propósito: son consultas caras contra el panel de un tercero, y
   dispararle 31 de golpe es la forma de que corte la conexión o devuelva basura. Si uno falla, se
   frena ahí y se dice cuál — los que ya entraron quedan guardados y al reintentar no se repiten. */
async function tdCapturar(){
  if(_tdCapturando) return;
  _tdCapturando = true;
  const btn = document.getElementById('td-btn'); const prog = document.getElementById('td-prog');
  if(btn) btn.disabled = true;
  try {
    const plan = await api('/api/os/tbs/diario/plan?mes='+_tdMes);
    const dias = plan.faltan||[];
    for(let i=0;i<dias.length;i++){
      if(prog) prog.innerHTML = '⏳ '+(i+1)+' de '+dias.length+' — '+esc(dias[i]);
      const r = await api('/api/os/tbs/diario/capturar',{method:'POST',body:JSON.stringify({fecha:dias[i]})});
      if(!r.ok){
        if(prog) prog.innerHTML = '<span style="color:var(--red)">Se frenó en '+esc(dias[i])+': '+esc(r.error||'')+'</span>';
        toast('Se frenó en '+dias[i]);
        return;
      }
    }
    if(prog) prog.textContent = '';
    toast(dias.length ? 'Listo: '+dias.length+' día(s)' : 'No faltaba ninguno');
  } finally {
    _tdCapturando = false;
    if(btn) btn.disabled = false;
    VIEWS.tbsdiario();
  }
}
function apiSub(k){ _apiSub=k; document.getElementById('main').innerHTML=apiHeader(); (API[k]||API.matriz)(); }
function apiHeader(){
  const subs=[['ofertas','💼 Ofertas'],['matriz','🎯 Precios por cliente'],['clientes','👥 Clientes'],['cuentas','🧾 Cuentas del mes'],['resumen','📊 Cierre del mes']];
  return `<div class="card" style="padding:10px 12px;margin-bottom:12px"><div style="display:flex;gap:6px;flex-wrap:wrap">`+
    subs.map(([k,l])=>`<button class="${k===_apiSub?'':'outline'} small" onclick="apiSub('${k}')">${l}</button>`).join('')+
    `</div></div><div id="api-body"></div>`;
}
const API={};

/* ── LAS OFERTAS COMERCIALES ────────────────────────────────────────────────────────────────────
   Cuando alguien pregunta "¿cuánto me cobrás por los proveedores?", la respuesta se armaba en una
   hoja aparte y después había que volver a tipear esos mismos precios en la matriz para poder
   facturar. Dos lugares con el mismo número es la forma más barata de que terminen distintos: se
   cotiza 8% y se factura 12%, y nadie se entera hasta que el cliente reclama.

   Acá la oferta ES el precio: se arma con PAQUETES —no con los 51 sellos uno por uno— se mira el
   documento, y al aplicarla escribe la matriz. Antes de escribir muestra qué cambia, porque un
   cliente que ya venía facturando puede tener precios negociados que la oferta no menciona. */
let _ofSel=null, _ofPaquetes=[], _ofClientes=[];

API.ofertas = async () => {
  const b=document.getElementById('api-body');
  b.innerHTML='<div class="card"><div class="muted">Cargando…</div></div>';
  const [lo,lp,lc]=await Promise.all([api('/api/os/api/ofertas'),api('/api/os/api/paquetes'),api('/api/os/api/clientes')]);
  _ofPaquetes=lp.paquetes||[]; _ofClientes=(lc.clientes||[]).filter(c=>c.activo);
  const ofs=lo.ofertas||[];
  const nom=(c)=>String(c.de_quien||'').trim()||c.login;
  b.innerHTML=`
    <div class="card">
      <h2>💼 Ofertas comerciales</h2>
      <div class="muted" style="margin-bottom:10px">
        La oferta <b>es</b> el precio: se arma con paquetes, se manda el documento, y al aplicarla
        escribe los precios en la matriz. Así lo que cotizaste y lo que facturás salen del mismo dato.</div>
      <div class="row" style="align-items:flex-end;gap:10px">
        <div style="flex:0 0 240px"><label>Nueva oferta — a quién va</label>
          <input id="of-nueva" placeholder="ej: Almir"></div>
        <div style="flex:0"><button onclick="ofCrear()">+ Armar oferta</button></div>
      </div>
      ${ofs.length?`<div style="overflow-x:auto;margin-top:14px"><table style="min-width:100%"><thead><tr>
        <th>Para</th><th>Estado</th><th>Cuenta</th><th class="right">Paquetes</th><th>Hecha</th><th></th>
      </tr></thead><tbody>${ofs.map(o=>{
        const cli=_ofClientes.find(c=>c.id===o.cliente_id);
        return `<tr${_ofSel===o.id?' style="background:var(--bg3)"':''}>
          <td style="cursor:pointer" onclick="ofAbrir('${o.id}')"><b>${esc(o.titulo)}</b></td>
          <td>${o.estado==='aplicada'?'<span class="badge ok">aplicada</span>':'<span class="badge warn">borrador</span>'}</td>
          <td class="muted">${cli?esc(nom(cli))+' <span style="font-size:10px">('+esc(cli.login)+')</span>':'—'}</td>
          <td class="right">${(o.lineas||[]).filter(l=>l.paquete_id).length}</td>
          <td class="muted" style="font-size:11px">${esc(String(o.createdAt||'').slice(0,10))}</td>
          <td class="right"><button class="outline small" onclick="ofAbrir('${o.id}')">abrir</button>
            <button class="outline small" onclick="ofBorrar('${o.id}','${esc(o.titulo).replace(/'/g,'')}')">✕</button></td>
        </tr>`;}).join('')}</tbody></table></div>`
      :'<div class="empty" style="margin-top:12px">Todavía no hay ninguna oferta. Escribí a quién va y armala.</div>'}
    </div>
    <div id="of-editor"></div>`;
  if(_ofSel) ofAbrir(_ofSel);
};

async function ofCrear(){
  const t=val('of-nueva'); if(!t) return toast('Poné a quién va la oferta');
  const r=await api('/api/os/api/ofertas',{method:'POST',body:JSON.stringify({titulo:t,lineas:[]})});
  if(!r||!r.ok) return;
  _ofSel=r.oferta.id; API.ofertas();
}
async function ofBorrar(id,titulo){
  if(!confirm('¿Borrar la oferta de '+titulo+'?\n\nNo toca los precios que ya se hayan aplicado.')) return;
  await api('/api/os/api/ofertas/'+id,{method:'DELETE'});
  if(_ofSel===id) _ofSel=null;
  API.ofertas();
}

async function ofAbrir(id){
  _ofSel=id;
  const cont=document.getElementById('of-editor'); if(!cont) return;
  const r=await api('/api/os/api/ofertas/'+id);
  if(!r||!r.ok) return;
  const o=r.oferta, m=r.mostrar;
  const pctDe=(pid)=>{const l=(o.lineas||[]).find(x=>x.paquete_id===pid); return l?(l.pct||''):'';};
  const nom=(c)=>String(c.de_quien||'').trim()||c.login;
  cont.innerHTML=`
    <div class="card">
      <h2>Oferta para ${esc(o.titulo)}</h2>
      <div class="muted" style="margin-bottom:12px">Poné el % de cada paquete. El que dejes vacío
        no entra en la oferta.</div>

      <!-- Armar todo con un número. La tarifa salió de comparar las 13 ofertas de 2025: lo único
           que se negocia es la base; Premium y Live van a lista. Ver api-ofertas-store.js. -->
      <div class="card" style="margin:0 0 12px;background:var(--bg3);display:flex;gap:10px;
           align-items:center;flex-wrap:wrap">
        <div>
          <label style="margin:0">Armar con una base</label>
          <div class="muted" style="font-size:11px">Básico = la base · Básico + = base+2 · Premium y Live = 15</div>
        </div>
        <input id="ofBase" value="10" style="width:70px;font-size:16px;text-align:center"
          onkeydown="if(event.key==='Enter') ofDesdeBase('${o.id}')">
        <button class="btn" onclick="ofDesdeBase('${o.id}')">Armar</button>
        <div id="ofBaseAviso" class="muted" style="font-size:11.5px;flex-basis:100%"></div>
      </div>
      <div class="row" style="margin:0 0 8px;justify-content:flex-end">
        <button class="btn ghost" style="font-size:12px;padding:5px 11px"
          onclick="paqRecomponer()">⚖ Revisar quién va en cada paquete</button>
      </div>
      <div style="display:flex;gap:10px;flex-wrap:wrap">
        ${_ofPaquetes.map(p=>`<div class="card" style="flex:1;min-width:190px;margin:0;background:var(--bg3)">
          <label>${esc(p.nombre)}</label>
          <div class="row" style="align-items:center;gap:6px">
            <input id="ofp-${p.id}" value="${esc(pctDe(p.id))}" placeholder="—"
              onchange="ofGuardar('${o.id}')" style="width:74px;font-size:16px;text-align:center"><span class="muted">%</span>
          </div>
          <div class="muted" style="font-size:11px;margin-top:4px">${p.sellos.length} sellos</div>
        </div>`).join('')}
      </div>
      <div class="row" style="margin-top:12px"><div style="flex:1">
        <label>Nota para el documento (opcional)</label>
        <input id="of-notas" value="${esc(o.notas||'')}" onchange="ofGuardar('${o.id}')"
          placeholder="ej: precios sujetos a revisión trimestral" style="width:100%"></div></div>

      <div class="row" style="margin-top:14px;gap:8px;align-items:flex-end;flex-wrap:wrap">
        <div style="flex:0;display:flex;gap:8px;flex-wrap:wrap">
          <a class="btn" href="/api/os/api/ofertas/${o.id}/doc" target="_blank">📄 Ver el documento</a>
          <button class="btn" onclick="ofTelegram('${o.id}')">📨 Mandar por Telegram</button>
        </div>
        <div style="flex:1;min-width:200px"><label>Aplicar a la cuenta</label>
          <select id="of-cli" onchange="ofVerCambios('${o.id}')" style="width:100%">
            <option value="">— elegí una cuenta —</option>
            ${_ofClientes.map(c=>`<option value="${esc(c.id)}"${c.id===o.cliente_id?' selected':''}>${esc(nom(c))} (${esc(c.login)})</option>`).join('')}
          </select></div>
      </div>
      <div id="of-cambios" style="margin-top:12px"></div>
    </div>
    <div class="card">
      <h2>Así lo va a ver</h2>
      <div class="muted" style="margin-bottom:8px">${m.proveedores.length} proveedores incluidos.</div>
      ${m.grupos.length?m.grupos.map(g=>`<div style="border-top:1px solid var(--border);padding:8px 0">
        <b>${esc(g.nombre)}</b> ${g.unico?`<span style="color:var(--gold);font-weight:700">${esc(g.unico)}%</span>`:'<span class="muted">varios precios</span>'}
        <div class="muted" style="font-size:12px;margin-top:3px">${esc(g.items.flatMap(i=>i.proveedores).slice(0,14).join(' · '))}${g.items.flatMap(i=>i.proveedores).length>14?' …':''}</div>
      </div>`).join(''):'<div class="empty">Poné el % de al menos un paquete.</div>'}
    </div>`;
  if(o.cliente_id) ofVerCambios(o.id);
}

/* Trae la oferta armada desde la base y la escribe en los campos. No guarda: el dueño la mira,
   la retoca si quiere, y guarda él. Los avisos dicen qué levantó el piso y por qué — eso no es
   un detalle: es plata que se estaba vendiendo por debajo del costo. */
async function ofDesdeBase(id){
  const base = (document.getElementById('ofBase')||{}).value;
  const av = document.getElementById('ofBaseAviso');
  if (av) av.textContent = 'Armando…';
  const r = await api('/api/os/api/oferta-desde-base?base=' + encodeURIComponent(base));
  if (!r || r.ok === false) { if (av) av.textContent = (r && r.error) || 'No se pudo armar'; return; }

  /* Se guarda la oferta ENTERA de una —paquetes y proveedores sueltos— y después se redibuja.
     Pasar por `ofGuardar` no serviría: esa función arma las líneas desde los campos de la
     pantalla, y los proveedores sueltos no tienen campo propio. */
  const actual = (await api('/api/os/api/ofertas/' + id)).oferta;
  const g = await api('/api/os/api/ofertas', { method: 'POST', body: JSON.stringify({
    id, titulo: actual.titulo,
    notas: (document.getElementById('of-notas') || {}).value || '',
    lineas: r.lineas }) });
  if (!g || !g.ok) { if (av) av.textContent = 'Se armó, pero no se pudo guardar'; return; }

  if (av) {
    const n = (r.avisos || []).length;
    av.innerHTML = n
      ? '<b>Ojo:</b> ' + r.avisos.map(a => esc(a.corto) + ' — ' + esc(a.porque) + ', queda en ' + a.queda).join(' · ')
        + '<br><span class="muted">Son los que se vendían por debajo del costo. El piso los levantó solo.</span>'
      : 'Listo. ' + (r.lineas || []).filter(l => l.sello).length + ' proveedor(es) con precio propio.';
  }
  ofAbrir(id);
}

/* Manda la oferta al MISMO grupo al que le llega la factura a ese cliente, herencia incluida.
   Va como texto para que se lea en el teléfono sin descargar nada. Se avisa a dónde fue: si el
   grupo es heredado del vendedor, el dueño tiene que saberlo antes de mandarla, no después. */
async function ofTelegram(id){
  const cid=(document.getElementById('of-cli')||{}).value||'';
  if(!cid){ alert('Elegí a qué cuenta va antes de mandarla.'); return; }
  if(!confirm('Se le manda la oferta por Telegram. ¿Va?')) return;
  const r=await api('/api/os/api/ofertas/'+id+'/telegram',{method:'POST',
    body:JSON.stringify({cliente_id:cid})});
  if(!r||!r.ok){ alert((r&&r.error)||'No se pudo mandar'); return; }
  alert(r.heredado ? 'Mandada — al grupo de '+(r.de||'su vendedor')+', que es el que tiene configurado.'
                   : 'Mandada.');
}

/* Revisa si algún proveedor está en la bolsa equivocada para lo que cuesta. Muestra qué movería
   y recién mueve si el dueño dice que sí: esto cambia cómo se ve agrupado el documento del
   cliente, no sólo un número. */
async function paqRecomponer(){
  const prev=await api('/api/os/api/paquetes/recomponer',{method:'POST',body:JSON.stringify({})});
  if(!prev||!prev.ok){ alert((prev&&prev.error)||'No se pudo revisar'); return; }
  const m=prev.movimientos||[];
  if(!m.length){ alert('Está todo en su lugar: ningún proveedor desentona con lo que cuesta.'); return; }
  const texto=m.map(x=>'· '+x.corto+' (cuesta '+x.costo+'%)  '+x.de+' → '+x.a+'\n     '+x.porque).join('\n');
  if(!confirm('Se moverían '+m.length+' proveedor(es):\n\n'+texto
    +'\n\nEsto cambia cómo se agrupa el documento del cliente. Las ofertas ya aplicadas no se tocan.\n¿Los muevo?')) return;
  const r=await api('/api/os/api/paquetes/recomponer',{method:'POST',body:JSON.stringify({aplicar:true})});
  if(!r||!r.ok){ alert((r&&r.error)||'No se pudo aplicar'); return; }
  alert('Listo. Básico + quedó con '+r.bplus+' y Premium con '+r.premium+'.');
  location.reload();
}

async function ofGuardar(id){
  const actual=(await api('/api/os/api/ofertas/'+id)).oferta;
  /* 🔴 Las líneas por PROVEEDOR se conservan. Los campos de la pantalla son sólo los paquetes: si
     se rearmaran las líneas desde cero, cada vez que alguien tocara un % se perderían los precios
     sueltos —los caros y los que levantó el piso— sin que nadie lo viera. */
  const sueltas=(actual.lineas||[]).filter(l=>l.sello&&l.pct!=null);
  const lineas=_ofPaquetes.map(p=>({paquete_id:p.id, pct:(document.getElementById('ofp-'+p.id)||{}).value||''}))
    .filter(l=>String(l.pct).trim()!=='').concat(sueltas);
  const r=await api('/api/os/api/ofertas',{method:'POST',
    body:JSON.stringify({id, titulo:actual.titulo,
      notas:(document.getElementById('of-notas')||{}).value||'', lineas})});
  if(r&&r.ok) ofAbrir(id);
}

/* Qué cambiaría en la matriz. Se mira ANTES de escribir: un cliente que ya venía facturando puede
   tener precios negociados que la oferta no menciona, y pisarlos sin verlos es cobrarle distinto
   sin haberlo decidido. */
async function ofVerCambios(id){
  const cid=(document.getElementById('of-cli')||{}).value||'';
  const box=document.getElementById('of-cambios'); if(!box) return;
  if(!cid){ box.innerHTML=''; return; }
  const d=await api('/api/os/api/ofertas/'+id+'/diff?cliente_id='+encodeURIComponent(cid));
  if(!d||!d.ok) return;
  const fila=(t,arr,col)=>arr.length?`<div style="margin-top:4px"><b style="color:${col}">${arr.length}</b> ${t}
    <div class="muted" style="font-size:11.5px">${arr.slice(0,10).map(x=>esc(x.sello.slice(0,40))+(x.de?` (${esc(x.de)}% → ${esc(x.a)}%)`:'')).join(' · ')}${arr.length>10?' …':''}</div></div>`:'';
  box.innerHTML=`<div class="card" style="margin:0;background:var(--bg3)">
    ${fila('precios nuevos',d.nuevos,'var(--green)')}
    ${fila('que CAMBIAN de precio',d.cambian,'var(--red)')}
    ${d.iguales.length?`<div class="muted" style="margin-top:4px">${d.iguales.length} ya estaban igual</div>`:''}
    ${d.fuera.length?`<div class="muted" style="margin-top:4px">${d.fuera.length} precio(s) que tiene y la oferta no menciona: <b>no se tocan</b></div>`:''}
    <button style="margin-top:10px" onclick="ofAplicar('${id}')">✓ Escribir estos precios en la matriz</button>
  </div>`;
}
async function ofAplicar(id){
  const cid=(document.getElementById('of-cli')||{}).value||'';
  if(!cid) return toast('Elegí a qué cuenta');
  if(!confirm('¿Escribir los precios de esta oferta en la matriz?\n\nLo que el cliente tenga aparte y la oferta no mencione NO se toca.')) return;
  const r=await api('/api/os/api/ofertas/'+id+'/aplicar',{method:'POST',body:JSON.stringify({cliente_id:cid})});
  if(!r||!r.ok) return;
  toast(r.escritos+' precio(s) escritos en la matriz');
  API.ofertas();
}

/* ── DE QUIÉN ES LA CUENTA ──────────────────────────────────────────────────────────────────────
   La identidad de una cuenta es su LOGIN en TBS: "Raul-API", "TBSDavidLatam". Eso no cambia y es
   con lo único con lo que se le puede pedir el profit al panel, así que la pantalla lo muestra
   siempre y no se puede editar desde acá.

   Aparte hace falta saber DE QUIÉN es —"Raul-API es de Raul"—, que no define nada: sirve para que
   la cuenta que se le manda diga "Cuenta Raul" en vez de "Cuenta Raul-API", y para reconocerla de
   un vistazo. Es una nota.

   Antes esto vivía metido adentro de "otros nombres", que era otra cosa: la lista con la que la
   planilla escribía a esa cuenta mientras se migraba del sistema viejo. Dos ideas en un campo, y
   la que quedó viva era la que menos se parecía al nombre del campo. */
function apiNombre(c){
  const dq=String(c.de_quien||'').trim();
  const viejos=c.alias||[];
  const n=viejos.length;
  return `<label>De quién es</label>
    <input id="nom-${c.id}" value="${esc(dq)}" placeholder="ej: Raul"
      onchange="apiNombreGuardar('${c.id}')" style="width:210px;font-size:12.5px">
    <div class="muted" style="font-size:11px">${dq
      ? `La cuenta del mes va a decir <b>«Cuenta ${esc(dq)}»</b>. En TBS se sigue llamando <b>${esc(c.login)}</b>.`
      : `Opcional. Sin esto, la cuenta del mes dice <b>«Cuenta ${esc(c.login)}»</b>, que es como la llama TBS.`}</div>
    ${n?`<div class="muted" style="font-size:11px;margin-top:5px;padding-left:8px;border-left:2px solid var(--border)">
      ${n===1?'Queda <b>1</b> nombre':'Quedan <b>'+n+'</b> nombres'} de cuando se traía la gente de la planilla.
      Ya no se ${n===1?'usa':'usan'} para nada.
      <div style="margin-top:4px;display:flex;gap:6px;flex-wrap:wrap;align-items:center">
        ${/* Cada uno con su botón: al mudar los datos, en varias cuentas el nombre de la PERSONA
             quedó acá abajo y arriba quedó el login reescrito — "Raul-API" arriba y "Raul" acá.
             Elegirlo tiene que ser un clic, no volver a tipearlo. */''}
        ${viejos.map(v=>`<button class="outline small" style="font-size:10.5px;padding:2px 7px"
          title="Usar «${esc(v)}» como de quién es la cuenta" onclick="apiUsarNombre('${c.id}','${esc(v).replace(/'/g,'')}')">${esc(v)}</button>`).join('')}
        <button class="outline small" style="font-size:10.5px;padding:2px 7px"
          onclick="apiNombresViejos('${c.id}')">✕ sacar ${n===1?'el resto':'los restos'}</button>
      </div></div>`:''}`;
}
async function apiNombreGuardar(id){
  const el=document.getElementById('nom-'+id); if(!el) return;
  const r=await api('/api/os/api/clientes/'+id+'/nombre',{method:'PUT',body:JSON.stringify({nombre:el.value})});
  if(!r||!r.ok) return;
  const v=el.value.trim();
  toast(v?('La cuenta del mes va a decir «Cuenta '+v+'»'):'Vuelve a nombrarse como la llama TBS');
  API.clientes();
}
/* Promover un resto a "de quién es". Es lo que arregla el caso más común de la mudanza: el nombre
   de la persona había quedado segundo y arriba quedó el login reescrito. */
async function apiUsarNombre(id, v){
  const r=await api('/api/os/api/clientes/'+id+'/nombre',{method:'PUT',body:JSON.stringify({nombre:v})});
  if(!r||!r.ok) return;
  toast('La cuenta del mes va a decir «Cuenta '+v+'»');
  API.clientes();
}
async function apiNombresViejos(id){
  if(!confirm('¿Sacar los nombres viejos de la planilla?\n\nNo se usan para nada: la búsqueda por esos nombres ya no existe. De quién es la cuenta no se toca.')) return;
  const r=await api('/api/os/api/clientes/'+id+'/nombres-viejos',{method:'DELETE'});
  if(!r||!r.ok) return;
  toast((r.sacados||[]).length+' nombre(s) viejo(s) sacado(s)');
  API.clientes();
}

API.clientes = async () => {
  const cs=(await api('/api/os/api/clientes')).clientes||[];
  const m=await api('/api/os/api/matriz');
  document.getElementById('api-body').innerHTML=`
    <div class="card"><h2>Clientes <span class="muted">(${cs.length})</span></h2>
      <div class="muted">Cada cliente es un nodo del árbol de TBS. La clave es su <b>id</b>, no el nombre.
        Tocá la flecha para ver y editar el grupo de Telegram y los otros nombres con los que aparece.</div>
      <table style="margin-top:10px"><thead><tr><th></th><th>Cliente</th><th>id</th>
        <th class="right">Sellos con precio</th><th>Telegram</th><th>Estado</th></tr></thead><tbody>
      ${cs.map(c=>{
        const n=Object.keys((m.celdas||{})[c.id]||{}).length;
        const ver=Object.values((m.celdas||{})[c.id]||{}).filter(x=>x.origen==='verificado').length;
        const ab=(window._apiAbierto||new Set()).has(c.id);
        /* El detalle plegado: dos campos que se tocan una vez y después estorban. Los "otros
           nombres" NO se pueden borrar aunque no se vean — el primero es el nombre que sale en el
           cierre de mes, y la planilla encuentra al cliente por ellos cuando lo escribe distinto. */
        const det = ab ? `<tr class="sub"><td></td><td colspan="5"><div class="subwrap" style="padding:8px 10px">
          <div class="row" style="gap:14px;flex-wrap:wrap">
            <div style="flex:0 0 230px"><label>Grupo de Telegram</label>
              <input id="tgapi-${c.id}" value="${esc(c.telegram_chat_id||'')}" placeholder="-1001234567890"
                onchange="apiTgGuardar('${c.id}')" style="width:200px;font-variant-numeric:tabular-nums;font-size:12px">
              <div class="muted" style="font-size:11px">Donde se le manda la cuenta del mes. La matriz la recibe siempre.</div></div>
            <div style="flex:1;min-width:260px">${apiNombre(c)}</div>
            ${c.notas?`<div style="flex:1 0 100%" class="muted" style="font-size:11px">${esc(c.notas)}</div>`:''}
          </div></div></td></tr>` : '';
        return `<tr${c.activo?'':' style="opacity:.5"'}>
          <td style="width:20px;cursor:pointer" onclick="apiCliToggle('${c.id}')"><span style="color:var(--gold)">${ab?'▾':'▸'}</span></td>
          <td style="cursor:pointer" onclick="apiCliToggle('${c.id}')"><b>${esc(c.login)}</b></td>
          <td class="muted">${esc(c.id)}<div style="font-size:10px">cuelga de ${esc(c.agente||'—')}</div></td>
          <td class="right">${n?`<b>${n}</b> <span class="muted" style="font-size:11px">(${ver} verificados)</span>`:'<span class="badge err">sin precios</span>'}</td>
          <td>${c.telegram_chat_id?'<span class="badge ok">grupo</span>':'<span class="badge err">sin grupo</span>'}</td>
          <td>${c.activo?'<span class="badge ok">activa</span>':'<span class="muted">inactiva</span>'}</td></tr>`+det;
      }).join('')}
      </tbody></table></div>`;
};

window._apiAbierto = window._apiAbierto || new Set();
/* Ojo con el nombre: ya existe un apiToggle() para la pantalla de Cuentas del mes. Dos funciones
   con el mismo nombre no fallan — gana la última — así que las flechas de acá habrían llamado a la
   de allá y roto las dos pantallas sin un solo error en la consola. */
function apiCliToggle(id){
  const S=window._apiAbierto; S.has(id)?S.delete(id):S.add(id);
  API.clientes && API.clientes();
}
/* ── LA MATRIZ DE PRECIOS DE TBS ────────────────────────────────────────────────────────────────
   51 sellos × 15 cuentas = 765 celdas, y 558 están vacías: tres de cada cuatro. Una grilla que es
   mayormente hueco se lee como un muro, y lo que importa —los 10 sellos INTERNOS (post pago), que
   son los que casi no cuestan y por eso son casi todo margen— quedaba dicho en una palabra gris de
   10px al lado del nombre.

   ── LOS COLORES SE PISABAN ───────────────────────────────────────────────────────────────────
   Había tres: verde de "verificado", ámbar de "sin verificar", y otro verde de "casi sin costo".
   Medido: de los 9 sellos "casi sin costo", los 9 son postpago. O sea que ese tercer color estaba
   marcando, por accidente, casi lo mismo que el tipo — dos señales distintas del mismo color para
   la misma cosa. Se fue: los internos ahora son un BLOQUE, no un tinte.

   Y los tintes que quedan son opacos. Eran rgba con alfa .16 sobre un fondo lila: el color de
   abajo se mezclaba y todo salía lavado y sucio.

   ── LAS COLUMNAS ─────────────────────────────────────────────────────────────────────────────
   Cada una se estiraba según su contenido, así que ninguna medía lo mismo y el ojo no podía
   comparar en vertical. Ahora `table-layout:fixed` y un ancho igual para todas. */
let _apiSoloConPrecio = true;   // arranca escondiendo lo que no tiene ningún precio
function apiVerVacios(v){ _apiSoloConPrecio = !v; API.matriz(); }

API.matriz = async () => {
  const m=await api('/api/os/api/matriz');
  const todasCs=(m.clientes||[]).filter(c=>c.activo);
  const cel=m.celdas||{};
  const todosSellos=(m.sellos||[]).filter(x=>x.grupo_id)
    .sort((a,b)=>String(a.corto||a.nombre).localeCompare(String(b.corto||b.nombre),'es',{sensitivity:'base'}));

  const tienePrecio=(cId,sNombre)=>{ const d=(cel[cId]||{})[sNombre]; return !!(d && d.pct_cliente!=null); };
  const selloConAlgo=(x)=>todasCs.some(c=>tienePrecio(c.id,x.nombre));
  const cuentaConAlgo=(c)=>todosSellos.some(x=>tienePrecio(c.id,x.nombre));

  /* Esconder lo vacío no es cosmética: 12 sellos no tienen precio en NINGUNA cuenta y 3 cuentas no
     tienen precio en ningún sello. Son 180 celdas de nada que separan las que sí importan. Se
     puede volver a mostrar. */
  const sellosOcultos=todosSellos.filter(x=>!selloConAlgo(x));
  const cuentasOcultas=todasCs.filter(c=>!cuentaConAlgo(c));
  const sellos=_apiSoloConPrecio ? todosSellos.filter(selloConAlgo) : todosSellos;
  const cs=_apiSoloConPrecio ? todasCs.filter(cuentaConAlgo) : todasCs;

  let ver=0,pla=0,vac=0;
  todosSellos.forEach(x=>todasCs.forEach(c=>{ const d=(cel[c.id]||{})[x.nombre];
    if(!d||d.pct_cliente==null) vac++; else (d.origen==='verificado'?ver++:pla++); }));

  const celda=(c,x)=>{
    /* CADA CELDA ES EDITABLE. Se guarda al salir del campo; vaciarla BORRA el precio (ese cliente
       deja de pagar ese sello). */
    const d=(cel[c.id]||{})[x.nombre];
    const val=(d && d.pct_cliente!=null) ? d.pct_cliente : '';
    const cls = val==='' ? 'mx-vacia' : (d.origen==='verificado' ? 'mx-ver' : 'mx-pla');
    const tit = val===''
      ? `${c.login} · ${esc(x.corto)}\nsin precio: no se le cobra. Escribí un % para cobrárselo.`
      : `${c.login} · ${esc(x.corto)}\ncliente ${d.pct_cliente}% · proveedor ${d.pct_proveedor||0}% · el sello cuesta ${x.costo==null?'—':x.costo}%\n`
        + (d.origen==='verificado'?'VERIFICADO: salió de un mes ya facturado':'sin verificar: salió de la tabla de precios')
        + (d.nota?`\nnota: ${esc(d.nota)}`:'') + '\n\nVaciar el campo borra el precio.';
    return `<td class="${cls}"><input value="${esc(val)}" title="${tit}"
      data-cli="${esc(c.id)}" data-sello="${esc(x.nombre)}" onchange="apiPct(this)"></td>`;
  };

  /* El costo del sello es EDITABLE acá. Cambiarlo NO cambia lo que se le cobra a nadie: sólo lo
     que se descuenta como costo. */
  const fila=(x)=>`<tr class="${x.tipo==='postpago'?'mx-int':''}">
      <td class="cie-p">
        <div class="mx-sello">${esc(x.corto)}</div>
        <div class="mx-costo">cuesta<input value="${esc(x.costo==null?'':x.costo)}" data-sello="${esc(x.nombre)}"
            onchange="apiCosto(this)"
            title="Lo que cuesta este proveedor. Cambiarlo NO cambia lo que se le cobra a nadie: sólo lo que se descuenta como costo."><span>%</span></div>
      </td>${cs.map(c=>celda(c,x)).join('')}</tr>`;

  const internos=sellos.filter(x=>x.tipo==='postpago');
  const externos=sellos.filter(x=>x.tipo!=='postpago');
  /* El contador dice cuántas filas se están viendo, y cuántas hay en total si el filtro escondió
     alguna. Antes la banda decía 9 y la leyenda 10 —el mismo dato con dos números— porque una
     contaba lo visible y la otra el total. */
  /* El rótulo va en un div sticky ADENTRO de la celda, no la celda entera: una celda con colspan
     es tan ancha como la tabla, así que fijarla a la izquierda no fija su TEXTO — el texto se iba
     con el scroll y la banda quedaba cortada a la mitad de una palabra. */
  const banda=(txt,det,n,total)=>`<tr class="mx-banda"><td colspan="${cs.length+1}"><div>
      <b>${esc(txt)}</b> <span class="mx-n">${n}${n<total?' de '+total:''}</span>
      <span class="muted">${esc(det)}</span></div></td></tr>`;

  const totInt=todosSellos.filter(x=>x.tipo==='postpago').length;
  const cuerpo =
      (internos.length ? banda('Internos', '— post pago: cuestan casi nada, así que lo que se cobra es casi todo margen', internos.length, totInt) + internos.map(fila).join('') : '')
    + (externos.length ? banda('Proveedores', '— pre pago: se les paga su costo', externos.length, todosSellos.length-totInt) + externos.map(fila).join('') : '');

  const ocultos=sellosOcultos.length+cuentasOcultas.length;
  document.getElementById('api-body').innerHTML = CIE_STYLE + MX_STYLE + `
    <div class="card"><h2>Precios por cliente <span class="muted">(% que paga sobre el GGR)</span></h2>
      <div class="muted">Filas = <b>sellos</b> (grupos de proveedores de TBS) · columnas = <b>cuentas de API</b>.
        Cada celda es lo que ese cliente paga por ese sello. Se escribe encima para cambiarla.</div>

      <div class="mx-leyenda">
        <span><i class="mx-c mx-ver"></i><b>${ver}</b> verificados <span class="muted">— de un mes ya facturado</span></span>
        <span><i class="mx-c mx-pla"></i><b>${pla}</b> sin verificar <span class="muted">— de la tabla de precios, revisalos antes de facturar</span></span>
        <span class="muted"><i class="mx-c mx-vacia"></i><b>${vac}</b> sin precio <span class="muted">— no se le cobra</span></span>
        <span class="mx-sep"><i class="mx-c mx-int-c"></i><b>internos</b> <span class="muted">— post pago, van agrupados arriba de todo</span></span>
      </div>

      ${ocultos ? `<div class="mx-filtro">
        <label><input type="checkbox" ${_apiSoloConPrecio?'':'checked'} onchange="apiVerVacios(this.checked)">
          mostrar lo que no tiene ningún precio</label>
        <span class="muted">${_apiSoloConPrecio
          ? `— ahora escondidos: ${sellosOcultos.length} sello(s)${cuentasOcultas.length?` y ${cuentasOcultas.length} cuenta(s) (${cuentasOcultas.map(c=>esc(c.login)).join(', ')})`:''}`
          : '— se están mostrando todos'}</span></div>` : ''}

      <div class="mx-scroll">
        <table class="ciet mx-tabla"><thead><tr><th class="cie-h0">Sello</th>${
          cs.map(c=>`<th title="${esc(c.login)} · id ${esc(c.id)}"><span>${esc(c.login)}</span></th>`).join('')
        }</tr></thead><tbody>${cuerpo}</tbody></table>
      </div>
    </div>`;
};

let _apiCta=null, _apiAbierta=new Set();
API.cuentas = async () => {
  document.getElementById('api-body').innerHTML=`
    <div class="card"><h2>🧾 Cuentas del mes</h2>
      <div class="muted">Por cada cuenta salen <b>dos</b> del mismo GGR de TBS: lo que se le <b>cobra al cliente</b>
        y lo que se le <b>paga al proveedor</b>. La diferencia es la ganancia, que es lo que se reparte.</div>
      <div class="row" style="align-items:flex-end;margin-top:10px">
        <div style="flex:0 0 190px"><label>Mes</label><input type="month" id="api-mes" value="${esc(_apiMes)}"></div>
        <div style="flex:0"><button onclick="apiCalcular()">Calcular</button></div>
        <div style="flex:0"><button class="outline small" onclick="apiCalcular(true)">↻ Volver a consultar TBS</button></div>
      </div>
      <div id="api-cta" style="margin-top:14px"><div class="muted">Elegí el mes y apretá Calcular.</div></div>
    </div>
    <div class="card"><h2>💾 Lo que ya está guardado</h2>
      <div class="muted">Consultarle a TBS es pesado —unos 2 segundos por sello, y son cerca de 40—, así que
        cada mes se pregunta UNA vez y queda. Es lo mismo que la Foto del mes del comercial, para el otro motor.
        Un mes que ya está acá contesta al instante, aunque TBS esté caído.</div>
      <div id="api-guardado" class="muted" style="margin-top:8px">Cargando…</div>
    </div>
    <div class="card"><h2>📥 Lo que le pagamos a los proveedores de TBS</h2>
      <div class="muted">Las cuentas de arriba dicen <b>qué le cobrás a cada cliente</b>. Esto es la otra mitad:
        el total que TBS le factura a la casa por cada familia de proveedores, que es lo que necesita el reporte de
        pago a proveedores. Es una consulta pesada, por eso se guarda: si el mes ya está sacado contesta al instante.</div>
      <div class="row" style="margin-top:8px">
        <div style="flex:0"><button class="outline" onclick="apiPagoProv()">📥 Sacar el mes</button></div>
        <div class="muted" id="api-pp" style="flex:1;align-self:center"></div>
      </div>
    </div>`;
  if(_apiCta) apiPintarCuentas();
  apiGuardado();
};
/* Qué meses de TBS ya están guardados. La precarga existía desde siempre pero no se veía: para
   saber si un mes estaba sacado había que apretar y esperar los 40 sellos. */
async function apiGuardado(){
  const el=document.getElementById('api-guardado'); if(!el) return;
  const r=await api('/api/os/api/guardado');
  if(!r||!r.ok){ el.textContent=''; return; }
  const ms=r.meses||[];
  if(!ms.length){ el.innerHTML='<span class="badge err">Ningún mes guardado todavía</span> '
    +'Apretá Calcular arriba: la primera vez de cada mes tarda, después es instantáneo.'; return; }
  el.innerHTML='<table style="margin-top:4px"><thead><tr><th>Mes</th><th class="right">Consultas guardadas</th>'
    +'<th>Última vez</th></tr></thead><tbody>'
    +ms.map(x=>'<tr><td><b>'+esc(x.mes)+'</b></td><td class="right">'+money(x.n,0)+'</td>'
      +'<td class="muted">'+esc(String(x.ultimo||'').slice(0,16).replace('T',' '))+'</td></tr>').join('')
    +'</tbody></table>';
}
/* TBS tarda ~2s por sello y son ~40: no entra en una sola consulta. Se trae por tandas y se
   guarda, igual que el pago a proveedores; un mes cerrado no se vuelve a preguntar. */
async function apiCalcular(refrescar){
  _apiMes=val('api-mes')||_apiMes;
  // Volver a consultar REEMPLAZA lo guardado. Si el mes ya está cerrado, eso sólo puede empeorarlo:
  // son ~40 sellos a 2s cada uno y si alguno falla en el medio, lo bueno ya se perdió.
  if(refrescar && !confirm('¿Volver a consultarle a TBS el mes '+_apiMes+'?\n\n'
    +'Reemplaza lo que ya está guardado. Son ~40 consultas de 2s, y si alguna falla no se recupera sola.')) return;
  const out=document.getElementById('api-cta');
  let desde=0;
  for(let v=0; v<20; v++){
    out.innerHTML='<div class="empty">⏳ trayendo el GGR de TBS… '+desde+' sellos listos'+(v?'':' (la primera vez de cada mes tarda)')+'</div>';
    const p=await api('/api/os/api/precargar',{method:'POST',body:JSON.stringify({mes:_apiMes,desde,limite:8,refrescar,confirmar:!!refrescar})});
    if(!p.ok){ out.innerHTML='<div class="badge err">'+esc(p.error||'error')+'</div>'; return; }
    if(!p.faltan) break;
    desde=p.hechos;
  }
  out.innerHTML='<div class="empty">⏳ armando las cuentas…</div>';
  const r=await api('/api/os/api/cuentas?mes='+encodeURIComponent(_apiMes));
  if(!r.ok){ out.innerHTML='<div class="badge err">'+esc(r.error||'error')+'</div>'; return; }
  _apiCta=r; _apiAbierta.clear(); apiPintarCuentas();
}
/* El detalle de un bloque, cortado por DIVISA. Cada moneda tiene su TC y su subtotal; el GGR local
   sólo se suma dentro de su divisa, y al lado va el equivalente en dólares, que es lo único
   comparable entre monedas y lo que sirve para auditar contra el panel. */
function apiBloque(b, conInterno){
  return (b.porDivisa||[]).map(d=>`
    <div class="apidiv">
      <div class="apidiv-h">
        <b>${esc(d.divisa)}</b>
        <span class="muted">TC ${esc(d.tc_cliente)}${d.tc_proveedor&&d.tc_proveedor!==d.tc_cliente?' · proveedor '+(d.tc_proveedor_varios?'varios':esc(d.tc_proveedor)):''}</span>
        <span style="flex:1"></span>
        <span class="muted">GGR ${money(d.ggr,0)} ${esc(d.divisa)} = <b>US$ ${money(d.ggr_usd,2)}</b></span>
      </div>
      <table><thead><tr>
        <th>Sello</th><th class="right">GGR ${esc(d.divisa)}</th><th class="right">GGR US$</th>
        <th class="right">%</th><th class="right">Le cobro</th>
        ${conInterno?'<th class="right">Le pago</th><th class="right">Empresa</th>':''}
      </tr></thead><tbody>
      ${d.lineas.map(l=>`<tr${l.origen&&l.origen!=='verificado'?' class="sinver"':''}>
        <td>${esc(l.sello)}${l.origen&&l.origen!=='verificado'?' <span class="cie-est cie-est-sc" title="El % salió de la tabla de precios y no está verificado">sin verificar</span>':''}</td>
        <td class="right muted">${money(l.ggr,0)}</td>
        <td class="right muted">${money(l.ggr_usd,2)}</td>
        <td class="right">${esc(l.pct_cliente)}%${conInterno?`<span class="muted" style="font-size:10px"> / ${esc(l.pct_proveedor||0)}%</span>`:''}</td>
        <td class="right"><b>${money(l.usdt_cliente,2)}</b></td>
        ${conInterno?`<td class="right muted">${money(l.usdt_proveedor,2)}</td>
          <td class="right" style="color:var(--gold)">${money(l.usdt_empresa,2)}</td>`:''}
      </tr>`).join('')}
      </tbody><tfoot><tr>
        <td><b>Subtotal ${esc(d.divisa)}</b></td>
        <td class="right"><b>${money(d.ggr,0)}</b></td>
        <td class="right"><b>${money(d.ggr_usd,2)}</b></td><td></td>
        <td class="right"><b>${money(d.usdt_cliente,2)}</b></td>
        ${conInterno?`<td class="right">${money(d.usdt_proveedor,2)}</td>
          <td class="right" style="color:var(--gold)"><b>${money(d.usdt_empresa,2)}</b></td>`:''}
      </tr></tfoot></table>
    </div>`).join('');
}
function apiPintarCuentas(){
  const r=_apiCta, out=document.getElementById('api-cta'); if(!out) return;
  const T=r.totales||{};
  const fila=(c,esCaja)=>{
    const b=c.total||c, id=String(c.cliente_id), ab=_apiAbierta.has(id);
    const nl=(b.lineas||[]).length;
    // Un cliente con caja se muestra en tres partes, que es como el dueño entrega las cuentas.
    const partes=(c.cajas&&c.cajas.length)?`
      <tr class="sub"><td colspan="5"><div class="subwrap">
        <div class="apitres">
          <div><span class="muted">Sin la caja</span><b>${money(c.propio.usdt_cliente,2)}</b></div>
          ${c.cajas.map(k=>`<div><span class="muted">${esc(k.login)}</span><b>${money(k.usdt_cliente,2)}</b></div>`).join('')}
          <div class="tot"><span class="muted">Total</span><b>${money(c.total.usdt_cliente,2)}</b></div>
        </div></div></td></tr>`:'';
    const det=ab?`<tr class="sub"><td colspan="5"><div class="subwrap">
      <div class="row" style="margin:0 0 8px">
        <button class="small outline" onclick="event.stopPropagation();apiDoc('${id}','cliente','${c.cajas&&c.cajas.length?'total':'propio'}')">📄 Cuenta del cliente</button>
        ${(c.cajas||[]).map(k=>`<button class="small outline" onclick="event.stopPropagation();apiDoc('${id}','cliente','caja','${k.cliente_id}')">📄 Sólo ${esc(k.login)}</button>`).join('')}
        <button class="small" onclick="event.stopPropagation();apiEnviar('${id}','${esc(String(c.login)).replace(/'/g,"\\'")}','${c.cajas&&c.cajas.length?'total':'propio'}',false)">📤 Enviar a la matriz</button>
        <button class="small outline" onclick="event.stopPropagation();apiEnviar('${id}','${esc(String(c.login)).replace(/'/g,"\\'")}','${c.cajas&&c.cajas.length?'total':'propio'}',true)">📤 …y al cliente</button>
        <span style="flex:1"></span>
        <span class="muted" id="apienv-${id}" style="align-self:center"></span>
      </div>
      ${apiBloque(c.propio||c,true)}
      ${(c.cajas||[]).map(k=>`<div class="apicaja"><div class="apicaja-h">📦 ${esc(k.login)} <span class="muted">— caja de ${esc(c.login)}, se factura aparte</span></div>${apiBloque(k,true)}</div>`).join('')}
      </div></td></tr>`:'';
    return `<tr style="cursor:pointer" onclick="apiToggle('${id}')">
      <td><span style="color:var(--gold);font-size:10px">${ab?'▾':'▸'}</span> <b>${esc(c.login)}</b>
        ${c.cajas&&c.cajas.length?`<span class="badge warn" style="margin-left:5px">+${c.cajas.length} caja${c.cajas.length===1?'':'s'}</span>`:''}
        ${b.sinVerificar?`<span class="cie-est cie-est-sc">${b.sinVerificar} sin verificar</span>`:''}</td>
      <td class="muted">${nl} línea${nl===1?'':'s'} · ${(b.porDivisa||[]).length} divisa${(b.porDivisa||[]).length===1?'':'s'}</td>
      <td class="right"><b>${money(b.usdt_cliente,2)}</b></td>
      <td class="right muted">${money(b.usdt_proveedor,2)}</td>
      <td class="right" style="color:var(--gold)"><b>${money(b.usdt_empresa,2)}</b></td></tr>`+partes+det;
  };
  const filas=(r.cuentas||[]).map(c=>fila(c)).join('');
  out.innerHTML=`
    <div class="row" style="align-items:stretch">
      <div class="card" style="flex:1;background:var(--bg3);margin:0"><label>Le cobro a los clientes</label>
        <div style="font-size:22px;font-weight:800">${money(T.cliente,2)}</div><div class="muted" style="font-size:11px">USDT</div></div>
      <div class="card" style="flex:1;background:var(--bg3);margin:0"><label>Le pago a los proveedores</label>
        <div style="font-size:22px;font-weight:800;opacity:.8">${money(T.proveedor,2)}</div><div class="muted" style="font-size:11px">USDT</div></div>
      <div class="card" style="flex:1;background:var(--bg3);margin:0"><label>Queda para la empresa <span class="muted">(Henry incluido)</span></label>
        <div style="font-size:22px;font-weight:800;color:var(--gold)">${money(T.empresa,2)}</div><div class="muted" style="font-size:11px">USDT</div></div>
    </div>
    ${(r.movieronSinCobrar||[]).length?`<div class="nota err">
      <span class="tit">⚠️ ${r.movieronSinCobrar.length} cuenta(s) movieron y NO se les factura nada</span>
      Tienen ganancia en el reporte diario de este mes y no aparecen abajo. Si cerrás así, esa plata no se le cobra a nadie.
      <div style="margin-top:6px"><table><thead><tr><th>Cuenta</th><th>Ganancia del mes</th><th>Por qué no se cobra</th><th></th></tr></thead><tbody>
      ${r.movieronSinCobrar.map(x=>`<tr><td><b>${esc(x.cuenta)}</b></td>
        <td>${Object.entries(x.monedas||{}).map(([d,v])=>esc(d)+' '+money(v,0)).join(' · ')}</td>
        <td>${x.enLaFoto===false ? '<b style="color:var(--red)">TBS ya no la devuelve</b> <span class="muted">(no está en el árbol)</span>'
             : (x.precios ? esc(x.precios)+' <span class="muted">(el movimiento cae en sellos sin precio)</span>'
             : '<b style="color:var(--red)">ninguno</b>')}</td>
        <td class="right">${x.enLaFoto===false ? '<span class="muted">reclamarle el acceso al proveedor</span>'
          : (x.id?`<button class="small" onclick="apiCompletar('${esc(x.id)}')">✏️ Cargarle los precios</button>`:'')}</td></tr>`).join('')}
      </tbody></table></div></div>`:''}
    ${(r.avisos||[]).length?`<div class="nota warn"><span class="tit">Para mirar</span>${r.avisos.map(esc).join('<br>')}</div>`:''}
    ${(r.aceptados||[]).length?`<div class="nota"><span class="tit">Decisiones tomadas</span>${r.aceptados.map(esc).join('<br>')}</div>`:''}
    ${(r.sinTC||[]).length?`<div class="nota err"><span class="tit">Sin tipo de cambio</span>${r.sinTC.map(esc).join(', ')}</div>`:''}
    <table style="margin-top:12px"><thead><tr><th>Cuenta</th><th></th><th class="right">Le cobro</th><th class="right">Le pago</th><th class="right">Empresa</th></tr></thead><tbody>
    ${filas||'<tr><td colspan="5" class="empty">Sin GGR este mes.</td></tr>'}</tbody></table>
    ${(r.sinPrecio||[]).length?`<div class="nota err">
      <span class="tit">${r.sinPrecio.length} sello(s) con GGR y SIN precio cargado</span>
      Produjeron ganancia y no se le está cobrando a nadie.
      <div style="max-height:280px;overflow:auto;margin-top:6px">
      <table><thead><tr><th>Cuenta</th><th>Sello</th><th>GGR</th><th></th></tr></thead><tbody>
      ${r.sinPrecio.map(x=>`<tr><td>${esc(x.cuenta)}</td><td><b>${esc(x.sello)}</b></td>
        <td class="muted">${Object.entries(x.porDivisa).map(([d,v])=>esc(d)+' '+money(v,0)).join(' · ')}</td>
        <td class="right">${x.cliente_id?`<button class="small outline" onclick="apiCompletar('${esc(x.cliente_id)}','${esc(String(x.sello_nombre||x.sello)).replace(/'/g,"\\'")}')">✏️ Ponerle precio</button>`:''}</td></tr>`).join('')}
      </tbody></table></div></div>`:''}`;
}
/* Guarda lo que UN cliente paga por UN sello.
   Vaciar el campo BORRA el precio: ese cliente deja de pagar ese sello, y su GGR pasa a figurar en
   "sellos con GGR y sin precio" — visible, no facturado. Es distinto de poner 0, que es cobrarle
   cero a propósito.
   El % del proveedor no se toca acá: sale del costo del sello y la revisión avisa si no coinciden.
   Corregirlo solo sería decidir por el dueño cuál de los dos lados está bien. */
/* La misma celda se edita desde la matriz y desde la pantalla de una sola cuenta: al cancelar o
   fallar hay que repintar la que está a la vista, no siempre la matriz. */
function _apiRepintar(){ return _apiSub==='completar' ? API.completar() : API.matriz(); }
async function apiPct(inp){
  const cli=inp.dataset.cli, sello=inp.dataset.sello;
  const v=String(inp.value||'').trim().replace(',','.');
  if(v!=='' && !(Number(v)>=0)){ toast('⚠ "'+inp.value+'" no es un porcentaje'); return _apiRepintar(); }
  let r;
  if(v===''){
    if(!confirm('¿Borrar el precio de este sello para ese cliente?\n\nDeja de pagarlo: su GGR va a aparecer como "sin precio".')) return _apiRepintar();
    r=await api('/api/os/api/pct/'+encodeURIComponent(cli)+'/'+encodeURIComponent(sello),{method:'DELETE'});
  } else {
    const m=await api('/api/os/api/matriz');
    const s=(m.sellos||[]).find(x=>x.nombre===sello)||{};
    const d=((m.celdas||{})[cli]||{})[sello]||{};
    r=await api('/api/os/api/pct',{method:'POST',body:JSON.stringify({cliente_id:cli, sello,
      pct_cliente:v,
      // si la celda es nueva, el proveedor arranca en lo que cuesta el sello
      pct_proveedor: d.pct_proveedor!=null ? d.pct_proveedor : (s.costo!=null?String(s.costo):'0'),
      pts_ib:null, pts_henry:null, origen: d.origen||'planilla'})});
  }
  if(!r.ok) return _apiRepintar();
  inp.classList.add('cie-ok'); setTimeout(()=>inp.classList.remove('cie-ok'),350);
  const rv=await api('/api/os/api/revision');
  if((rv.avisos||[]).length) toast('⚠ '+rv.avisos[0].slice(0,150));
}
/* Guarda el costo de un sello. Sólo toca el costo: los % de cada cliente quedan como están, así
   que después la revisión avisa cuáles dejaron de coincidir en vez de moverlos sola. */
async function apiCosto(inp){
  const v=String(inp.value||'').trim().replace(',','.');
  if(v!=='' && !(Number(v)>=0)) { toast('⚠ "'+inp.value+'" no es un costo válido'); return; }
  const r=await api('/api/os/api/sellos',{method:'POST',
    body:JSON.stringify({nombre:inp.dataset.sello, costo:v===''?'0':v})});
  if(!r.ok) return;
  inp.classList.add('cie-ok'); setTimeout(()=>inp.classList.remove('cie-ok'),350);
  const rv=await api('/api/os/api/revision');
  if((rv.avisos||[]).length) toast('⚠ '+rv.avisos[0].slice(0,150));
}
/* ── COMPLETARLE LOS PRECIOS A UNA CUENTA ────────────────────────────────────────────────────────
   El aviso de "movieron y no se les factura nada" decía el problema y ahí terminaba: para
   arreglarlo había que ir a Precios por cliente, destildar el filtro que esconde las cuentas
   vacías, buscar la columna entre 15 y bajar 51 filas. Tres pantallas para escribir un número.

   Acá se abre esa cuenta SOLA: sus sellos vacíos primero, el costo de cada uno al lado, y un
   campo para llenar todos los vacíos de una. Si no tiene ningún precio, además ofrece aplicarle
   una oferta, que es como se carga un cliente nuevo de verdad — sello por sello son 51 números.

   Se escribe en la MISMA tabla que la matriz (`apiPct`), no en una copia: dos lugares que guardan
   el mismo precio terminan distintos, y eso ya pasó con las ofertas. */
let _apiComp=null;   // { id, sello }  — el sello es el que se resalta al entrar, si vino de un aviso
function apiCompletar(id, sello){ _apiComp={ id:String(id), sello:sello||null }; apiSub('completar'); }

API.completar = async () => {
  const b=document.getElementById('api-body');
  if(!_apiComp) return apiSub('cuentas');
  b.innerHTML='<div class="card"><div class="muted">Cargando…</div></div>';
  const [m,lo]=await Promise.all([api('/api/os/api/matriz'),api('/api/os/api/ofertas')]);
  const cli=(m.clientes||[]).find(c=>String(c.id)===_apiComp.id);
  if(!cli){ b.innerHTML='<div class="card"><div class="badge err">no encuentro esa cuenta</div></div>'; return; }
  const mis=(m.celdas||{})[cli.id]||{};
  // Sólo los sellos mapeados a un grupo de TBS: a los otros no se les puede preguntar el GGR, así
  // que ponerles precio no cobra nada. Se avisan aparte en "sin grupo".
  const sellos=(m.sellos||[]).filter(x=>x.grupo_id);
  const tiene=(x)=>{ const d=mis[x.nombre]; return !!(d && d.pct_cliente!=null); };
  const vacios=sellos.filter(x=>!tiene(x));
  const puestos=sellos.filter(tiene);

  // Lo que movió este mes, si se llegó acá desde el aviso. Es el motivo de estar en esta pantalla.
  const mov=((_apiCta&&_apiCta.movieronSinCobrar)||[]).find(x=>String(x.id)===_apiComp.id);

  const fila=(x)=>{
    const d=mis[x.nombre]||{};
    const val=(d.pct_cliente!=null)?d.pct_cliente:'';
    const foco=_apiComp.sello&&x.nombre===_apiComp.sello;
    return `<tr class="${val===''?'mx-vacia':''}"${foco?' style="outline:2px solid var(--gold)"':''}>
      <td><b>${esc(x.corto||x.nombre)}</b>${x.tipo==='postpago'?' <span class="muted" style="font-size:10px">interno</span>':''}
        ${foco?' <span class="badge warn" style="margin-left:4px">este movió</span>':''}</td>
      <td class="right muted">${x.costo==null?'—':esc(x.costo)+'%'}</td>
      <td style="width:120px"><input value="${esc(val)}" placeholder="sin precio"
        data-cli="${esc(cli.id)}" data-sello="${esc(x.nombre)}" onchange="apiPct(this)"
        title="${esc(x.corto||x.nombre)}\nVacío = no se le cobra. Escribí un % para cobrárselo."></td>
      <td class="muted">${val===''?'<span style="color:var(--red)">no se le cobra</span>'
        :(d.origen==='verificado'?'verificado':'sin verificar')}</td></tr>`;
  };

  const ofs=(lo.ofertas||[]);
  b.innerHTML = CIE_STYLE + MX_STYLE + `
    <div class="card">
      <div class="row" style="margin:0 0 10px"><button class="small outline" onclick="apiSub('cuentas')">← Volver a las cuentas del mes</button></div>
      <h2>Precios de ${esc(cli.login)} <span class="muted">(% que paga sobre el GGR)</span></h2>
      ${mov?`<div class="nota err" style="margin-top:8px"><span class="tit">Por esto estás acá</span>
        Este mes ganó ${Object.entries(mov.monedas||{}).map(([d,v])=>esc(d)+' '+money(v,0)).join(' · ')}
        y no se le facturó nada.</div>`:''}
      <div class="muted" style="margin-top:8px">Cada fila es un <b>sello</b> (un grupo de proveedores de TBS).
        Vacío = <b>no se le cobra</b> y su ganancia queda sin facturar. Se guarda al salir del campo.</div>

      ${vacios.length?`<div class="mx-filtro" style="margin-top:10px">
        <b>${vacios.length} sello(s) sin precio.</b>
        <label style="margin-left:8px">Cobrarle el costo <b>+</b>
          <input id="comp-mas" style="width:56px" value="2"> puntos</label>
        <button class="small" onclick="apiCompletarTodos('mas')">Aplicar a los ${vacios.length}</button>
        <span class="muted">— cada sello queda en <b>lo que cuesta + eso</b>. ${esc(vacios.length?`Ej.: ${vacios[0].corto||vacios[0].nombre} cuesta ${vacios[0].costo==null?'—':vacios[0].costo+'%'}`:'')}</span>
        <div style="margin-top:6px;padding-top:6px;border-top:1px solid var(--bd)">
          <label>…o el mismo % para todos: <input id="comp-todos" style="width:56px" placeholder="ej. 12"></label>
          <button class="small outline" onclick="apiCompletarTodos('plano')">Aplicar plano</button>
          <span class="muted">— sólo si de verdad cobran todos igual: un sello de 1,5% y uno de 15% al mismo % es regalar uno y perder con el otro</span>
        </div>
      </div>`:'<div class="nota" style="margin-top:10px">Todos los sellos de esta cuenta tienen precio.</div>'}

      ${(!puestos.length && ofs.length)?`<div class="mx-filtro" style="margin-top:8px">
        <b>Esta cuenta no tiene ningún precio.</b>
        <label style="margin-left:8px">Aplicarle una oferta:
          <select id="comp-of" style="width:auto">${ofs.map(o=>`<option value="${esc(o.id)}">${esc(o.titulo||o.nombre||o.id)}</option>`).join('')}</select></label>
        <button class="small" onclick="apiCompletarOferta()">Aplicar la oferta</button>
        <span class="muted">— es como se carga un cliente nuevo: escribe todos los sellos de una</span>
      </div>`:''}

      <table style="margin-top:12px"><thead><tr>
        <th>Sello</th><th class="right">Cuesta</th><th>Le cobro</th><th></th>
      </tr></thead><tbody>
        ${vacios.length?`<tr class="mx-banda"><td colspan="4"><div><b>Sin precio</b> <span class="mx-n">${vacios.length}</span>
          <span class="muted">— su ganancia no se le cobra a nadie</span></div></td></tr>`:''}
        ${vacios.map(fila).join('')}
        ${puestos.length?`<tr class="mx-banda"><td colspan="4"><div><b>Con precio</b> <span class="mx-n">${puestos.length}</span></div></td></tr>`:''}
        ${puestos.map(fila).join('')}
      </tbody></table>
    </div>`;
};
/* Llenar los vacíos de una. Se hace de a uno contra la misma ruta que la matriz —no hay ruta en
   lote— y se corta al primer error en vez de seguir: la mitad cargada con el resto en el aire es
   peor que no haber empezado, y el que falla se ve. */
async function apiCompletarTodos(modo){
  const v=String(val(modo==='mas'?'comp-mas':'comp-todos')||'').trim().replace(',','.');
  if(v===''||!(Number(v)>=0)) return toast(modo==='mas'?'⚠ Escribí cuántos puntos sumarle':'⚠ Escribí un % válido');
  const m=await api('/api/os/api/matriz');
  const mis=(m.celdas||{})[_apiComp.id]||{};
  const vacios=(m.sellos||[]).filter(x=>x.grupo_id).filter(x=>{ const d=mis[x.nombre]; return !(d&&d.pct_cliente!=null); });
  if(!vacios.length) return toast('No quedaba ninguno vacío');
  // El % de cada sello se calcula ANTES de preguntar, para poder mostrar el rango que se va a
  // escribir. "51 sellos entre 1,5% y 17%" se puede revisar; "51 sellos" no dice nada.
  const pct=(x)=> modo==='mas' ? String(Math.round(((Number(x.costo)||0)+Number(v))*100)/100) : v;
  const ns=vacios.map(x=>Number(pct(x)));
  if(!confirm((modo==='mas'
      ? '¿Ponerle a los '+vacios.length+' sellos sin precio lo que cuesta cada uno + '+v+' puntos?\n\n'
        +'Van a quedar entre '+Math.min(...ns)+'% y '+Math.max(...ns)+'%.'
      : '¿Ponerle '+v+'% a los '+vacios.length+' sellos sin precio de esta cuenta?\n\n'
        +'Ojo: es el mismo % para sellos que cuestan entre '
        +Math.min(...vacios.map(x=>Number(x.costo)||0))+'% y '+Math.max(...vacios.map(x=>Number(x.costo)||0))+'%.')
    +'\n\nDespués podés corregir uno por uno los que hagan falta.')) return;
  let n=0;
  for(const x of vacios){
    const r=await api('/api/os/api/pct',{method:'POST',body:JSON.stringify({cliente_id:_apiComp.id, sello:x.nombre,
      pct_cliente:pct(x), pct_proveedor:(x.costo!=null?String(x.costo):'0'), pts_ib:null, pts_henry:null, origen:'planilla'})});
    if(!r.ok){ toast('⚠ Se cortó en '+(x.corto||x.nombre)+': '+esc(r.error||'error')+' — quedaron '+n+' cargados'); break; }
    n++;
  }
  toast('✔ '+n+' sello(s) cargados'+(modo==='mas'?' (costo + '+v+')':' en '+v+'%'));
  API.completar();
}
async function apiCompletarOferta(){
  const id=val('comp-of'); if(!id) return;
  if(!confirm('¿Aplicarle esta oferta a la cuenta?\n\nEscribe los precios de todos los sellos que la oferta incluye.')) return;
  const r=await api('/api/os/api/ofertas/'+encodeURIComponent(id)+'/aplicar',
    {method:'POST',body:JSON.stringify({cliente_id:_apiComp.id})});
  if(!r.ok) return toast('⚠ '+esc(r.error||'no se pudo'));
  toast('✔ Oferta aplicada');
  API.completar();
}
function apiToggle(id){ _apiAbierta.has(id)?_apiAbierta.delete(id):_apiAbierta.add(id); apiPintarCuentas(); }
/* La vista general de TBS: lo que el proveedor le factura a la casa. Vive acá y no en la Foto del
   mes del comercial — es otro motor y otro negocio. Va de a pedazos porque tarda ~54s por llamada. */
async function apiPagoProv(){
  const mes=document.getElementById('api-mes').value;
  const cxs=(await api('/api/os/casino/conexiones')).conexiones||[];
  const tbs=cxs.find(c=>c.motor==='tbs'&&c.activa!==false);
  const out=document.getElementById('api-pp');
  if(!tbs) return out.innerHTML='<span class="badge err">no hay conexión TBS activa</span>';
  let desde=0, vueltas=0;
  while(vueltas++<40){
    out.innerHTML='<span class="muted">Consultando TBS… '+(desde?desde+' familias listas':'arrancando')+' (tarda ~54s por llamada)</span>';
    const r=await api('/api/os/pago-proveedores/precargar',{method:'POST',
      body:JSON.stringify({mes, conexion_id:tbs.id, desde, limite:2})});
    if(!r.ok){ out.innerHTML='<span class="badge err">'+esc(r.error||'no se pudo')+'</span>'; return; }
    desde=r.hechos!=null?r.hechos:desde+2;
    if(!r.faltan){ out.innerHTML='<span class="badge ok">listo</span> '+desde+' de '+(r.total||desde)
      +(r.avisos&&r.avisos.length?' · <span style="color:var(--red)">'+r.avisos.map(esc).join(' · ')+'</span>':''); return; }
  }
  out.innerHTML='<span class="badge warn">se cortó por las vueltas</span> probá de nuevo, sigue desde donde quedó';
}

// ───────── CIERRE DEL MES: el total, con lo que entra y lo que no ─────────
let _apiRes=null;
API.resumen = async () => {
  const mes=_apiMes;
  document.getElementById('api-body').innerHTML=`
    <div class="card">
      <h2>📊 Cierre del mes de API</h2>
      <div class="muted" style="margin-bottom:8px">El total del mes no es la suma de todos: hay cuentas que no se
        cobran. Destildá las que quedan afuera y el total se recalcula. <b>La decisión se guarda por mes</b>, así que
        un cierre viejo se vuelve a sacar igual aunque después cambie el trato con el cliente.</div>
      <div class="row" style="align-items:flex-end">
        <div style="flex:0 0 190px"><label>Mes</label><input type="month" id="ares-mes" value="${mes}"></div>
        <div style="flex:0"><button onclick="apiResCargar()">Calcular</button></div>
        <div style="flex:0"><button class="outline" onclick="apiResImprimir()">📄 Reporte</button></div>
      </div>
      <div id="ares-body" style="margin-top:12px" class="muted">Elegí el mes y calculá.</div>
    </div>`;
  apiResCargar();
};
async function apiResCargar(){
  _apiMes=document.getElementById('ares-mes').value||_apiMes;
  document.getElementById('ares-body').innerHTML='<div class="muted">Calculando…</div>';
  _apiRes=await api('/api/os/api/resumen?mes='+encodeURIComponent(_apiMes));
  apiResPintar();
}
async function apiResSel(clave,entra){
  const f=(_apiRes.filas||[]).find(x=>x.clave===clave); if(f) f.entra=entra;
  apiResPintar();                                        // responde ya, sin esperar al servidor
  // api() le pasa opts tal cual a fetch: el body va SERIALIZADO. Mandarlo como objeto llegaba
  // "[object Object]", el servidor lo rechazaba y el tilde volvía solo a su lugar.
  const q=await api('/api/os/api/resumen/sel',{method:'POST',
    body:JSON.stringify({mes:_apiRes.mes,clave,entra})});
  if(!q.ok){ if(f) f.entra=!entra; return apiResPintar(); }   // no se guardó: no mentir en pantalla
  _apiRes=await api('/api/os/api/resumen?mes='+encodeURIComponent(_apiRes.mes));
  apiResPintar();
}
function apiResPintar(){
  const r=_apiRes, out=document.getElementById('ares-body'); if(!out) return;
  if(!r||!r.ok) return out.innerHTML=`<div class="nota err">${esc((r&&r.error)||'no se pudo calcular')}</div>`;
  const T=r.totales, TT=r.totalesConTodo;
  const hayFuera=(r.fuera||[]).length;
  out.innerHTML=`
    <div class="row" style="align-items:stretch">
      <div class="card" style="flex:1;background:var(--bg3);margin:0"><label>Total</label>
        <div style="font-size:22px;font-weight:800">${money(T.cliente,2)}</div><div class="muted" style="font-size:11px">USDT</div></div>
      <div class="card" style="flex:1;background:var(--bg3);margin:0"><label>Proveedor</label>
        <div style="font-size:22px;font-weight:800;opacity:.8">${money(T.proveedor,2)}</div><div class="muted" style="font-size:11px">USDT</div></div>
      <div class="card" style="flex:1;background:var(--bg3);margin:0"><label>Empresa</label>
        <div style="font-size:22px;font-weight:800;color:var(--gold)">${money(T.empresa,2)}</div><div class="muted" style="font-size:11px">USDT</div></div>
    </div>
    ${hayFuera?`<div class="nota warn"><span class="tit">${r.fuera.length} cuenta(s) fuera del total</span>
      Suman <b>${money(String(Number(TT.cliente)-Number(T.cliente)),2)} USDT</b> que no se están cobrando.
      Con todo adentro el mes daría ${money(TT.cliente,2)} / ${money(TT.proveedor,2)} / ${money(TT.empresa,2)}.</div>`:''}
    <table style="margin-top:12px"><thead><tr>
      <th style="width:34px"></th><th>Cuenta</th><th class="right">Total</th><th class="right">Proveedor</th><th class="right">Empresa</th>
    </tr></thead><tbody>
    ${(r.filas||[]).map(f=>`<tr${f.entra?'':' style="opacity:.45"'}>
      <td><input type="checkbox" style="width:auto" ${f.entra?'checked':''} onchange="apiResSel('${f.clave}',this.checked)"></td>
      <td>${f.es_caja?'<span class="muted" style="font-size:11px">└ caja de '+esc(f.de)+'</span><br>':''}<b>${esc(f.titulo)}</b>
        ${f.titulo!==f.login?`<span class="muted" style="font-size:11px"> · ${esc(f.login)}</span>`:''}</td>
      <td class="right"><b>${money(f.total,2)}</b></td>
      <td class="right muted">${money(f.proveedor,2)}</td>
      <td class="right" style="color:var(--gold)">${money(f.empresa,2)}</td></tr>`).join('')
      ||'<tr><td colspan="5" class="empty">Sin cuentas este mes.</td></tr>'}
    </tbody><tfoot><tr>
      <td></td><td><b>Total del mes</b></td>
      <td class="right"><b>${money(T.cliente,2)}</b></td>
      <td class="right"><b>${money(T.proveedor,2)}</b></td>
      <td class="right" style="color:var(--gold)"><b>${money(T.empresa,2)}</b></td>
    </tr></tfoot></table>`;
}
function apiResImprimir(){
  const r=_apiRes; if(!r||!r.ok) return alert('calculá el mes primero');
  const T=r.totales, dentro=(r.filas||[]).filter(x=>x.entra), fuera=(r.filas||[]).filter(x=>!x.entra);
  const w=window.open('','_blank');
  w.document.write(`<html><head><meta charset="utf-8"><title>API ${esc(r.mes)}</title>
  <style>body{font:14px system-ui;padding:26px;color:#2b2230;max-width:760px;margin:auto}
  h1{font-size:20px;margin:0 0 18px}
  table{width:100%;border-collapse:collapse;margin-bottom:8px}
  th{text-align:left;font-size:11px;text-transform:uppercase;color:#8c7e89;border-bottom:1px solid #ead6e6;padding:6px 8px}
  td{padding:6px 8px;border-bottom:1px solid #f3e9f1}.r{text-align:right}
  tfoot td{font-weight:800;border-top:2px solid #ead6e6;border-bottom:none;font-size:15px}
  .cab{display:flex;gap:10px;margin-bottom:20px}
  .cab div{flex:1;padding:11px 13px;background:#f6e9f4;border-radius:8px}
  .cab span{display:block;font-size:11px;color:#8c7e89;text-transform:uppercase}
  .cab b{font-size:19px}
  .fuera{margin-top:24px;font-size:12px;color:#8c7e89}
  @media print{button{display:none}.cab div{-webkit-print-color-adjust:exact;print-color-adjust:exact}}</style></head><body>
  <h1>API · ${esc(r.mes)}</h1>
  <div class="cab">
    <div><span>Total</span><b>${money(T.cliente,2)}</b></div>
    <div><span>Proveedor</span><b>${money(T.proveedor,2)}</b></div>
    <div><span>Empresa</span><b>${money(T.empresa,2)}</b></div>
  </div>
  <table><thead><tr><th>Cuenta</th><th class="r">Total</th><th class="r">Proveedor</th><th class="r">Empresa</th></tr></thead><tbody>
  ${dentro.map(f=>`<tr><td>${esc(f.titulo)}${f.es_caja?' <span style="color:#8c7e89;font-size:11px">(caja de '+esc(f.de)+')</span>':''}</td>
    <td class="r">${money(f.total,2)}</td><td class="r">${money(f.proveedor,2)}</td><td class="r">${money(f.empresa,2)}</td></tr>`).join('')}
  </tbody><tfoot><tr><td>Total</td><td class="r">${money(T.cliente,2)}</td>
    <td class="r">${money(T.proveedor,2)}</td><td class="r">${money(T.empresa,2)}</td></tr></tfoot></table>
  ${fuera.length?`<div class="fuera"><b>No entran en este total:</b> ${fuera.map(f=>esc(f.titulo)+' ('+money(f.total,2)+')'+(f.motivo?' — '+esc(f.motivo):'')).join(' · ')}</div>`:''}
  <button style="margin-top:20px;padding:9px 15px" onclick="window.print()">Guardar como PDF</button>
  </body></html>`);
  w.document.close();
}
/* Guarda el grupo de Telegram de una cuenta de API al salir del campo. */
async function apiTgGuardar(id){
  const inp=document.getElementById('tgapi-'+id);
  const cs=(await api('/api/os/api/clientes')).clientes||[];
  const c=cs.find(x=>String(x.id)===String(id)); if(!c) return;
  const r=await api('/api/os/api/clientes',{method:'POST',
    body:JSON.stringify({...c, telegram_chat_id: inp.value.trim()})});
  if(r.ok){ inp.classList.add('cie-ok'); setTimeout(()=>inp.classList.remove('cie-ok'),350); }
}
/* SALE PARA AFUERA: le manda al cliente su cuenta del mes por Telegram. Se pregunta siempre y se
   dice a qué grupo va, porque un mensaje mandado no se puede volver atrás. */
/* SALE PARA AFUERA. Dos botones y no uno con un tilde: el que incluye al cliente tiene que ser un
   acto aparte. Con un tilde que queda puesto de la vez anterior, el segundo envío se va al chat del
   cliente sin que nadie lo haya decidido esta vez. */
async function apiEnviar(id, nombre, alcance, alCliente){
  const mes=document.getElementById('api-mes').value;
  const cfg=await api('/api/config');
  const matriz=(cfg.apiGrupoMatriz||'').trim();
  const cs=(await api('/api/os/api/clientes')).clientes||[];
  const c=cs.find(x=>String(x.id)===String(id));
  const chat=((c&&c.telegram_chat_id)||'').trim();
  if(!matriz && !alCliente) return alert('Falta el grupo matriz.\n\nSe carga en ⚙ Config → 📣 Telegram.');
  if(alCliente && !chat) return alert(nombre+' no tiene grupo propio cargado.\n\nSe pone en 👥 Clientes, abriendo la flecha del cliente.\nSin eso igual podés mandarla a la matriz.');
  const van=[matriz?'la matriz ('+matriz+')':null, (alCliente&&chat&&chat!==matriz)?nombre+' ('+chat+')':null].filter(Boolean);
  if(!confirm('¿Mandar la cuenta de '+nombre+' de '+mes+'?\n\nVa a: '+van.join('\ny a: ')
    +'\n\nSon mensajes de verdad: no se pueden deshacer.')) return;
  const marca=(t)=>{const e=document.getElementById('apienv-'+id); if(e) e.innerHTML=t;};
  marca('<span class="muted">Mandando…</span>');
  const r=await api('/api/os/api/cuenta/'+encodeURIComponent(id)+'/enviar',
    {method:'POST',body:JSON.stringify({mes, alcance, al_cliente:!!alCliente})});
  if(!r.ok) return marca('<span class="badge err">no se envió</span> '+esc(r.error||''));
  // Se dice a QUIÉN llegó y a quién no: si uno de los dos falla, saber cuál es lo único que importa.
  marca((r.destinos||[]).map(d=>(d.ok?'<span class="badge ok">'+esc(d.quien)+'</span>':'<span class="badge err">'+esc(d.quien)+': '+esc(d.error||'')+'</span>')).join(' ')
    +' <span class="muted">· '+r.partes+' mensaje(s) · '+money(r.total_usdt,2)+' USDT</span>');
}
/* La cuenta del cliente la arma el SERVIDOR: lo que le pagamos al proveedor no viaja al navegador.
   Por eso esto pide el documento en vez de esconder columnas de lo que ya está en pantalla. */
/* Abre la MISMA página que va a recibir el cliente. Antes esto armaba su propio HTML en el
   navegador: dos renderizadores del mismo documento que se iban a separar con el primer cambio. */
function apiDoc(id,vista,alcance,caja){
  const mes=document.getElementById('api-mes').value;
  const q=`?mes=${encodeURIComponent(mes)}&alcance=${alcance}${caja?'&caja_id='+encodeURIComponent(caja):''}`;
  window.open('/api/os/api/cuenta/'+encodeURIComponent(id)+'/pagina'+q,'_blank');
}


// ───────── REPORTES (diario por superagente/distribuidor — data REAL del casino) ─────────

/* ── LA COMPARATIVA: MIRARLA ANTES DE MANDARLA ───────────────────────────────────────────────
   El texto lo arma el servidor y la pantalla lo muestra tal cual: lo que se ve acá es EXACTAMENTE
   lo que va a salir. Mostrar una cosa y mandar otra es la forma de perder la confianza en el
   botón, y a partir de ahí nadie lo usa. */
function tdCompIds(){ return [...document.querySelectorAll('.td-comp:checked')].map(c=>c.value); }
function tdCompTodos(v){ document.querySelectorAll('.td-comp').forEach(c=>{c.checked=v;}); tdCompPintar(); }
async function tdCompPintar(){
  const out=document.getElementById('td-comp-out'); if(!out) return;
  const ids=tdCompIds();
  if(!ids.length){ out.innerHTML='<div class="empty">Marcá al menos una cuenta.</div>'; return; }
  out.innerHTML='<div class="muted">Armando el mensaje…</div>';
  const r=await api('/api/os/tbs/comparativa?mes='+encodeURIComponent(_tdMes)+'&ids='+encodeURIComponent(ids.join(',')));
  if(!r.ok){ out.innerHTML='<div class="nota err">'+esc(r.error||'no se pudo')+'</div>'; return; }
  window._tdCompPlano = r.plano;
  out.innerHTML =
    '<div style="background:var(--bg3);border-radius:10px;padding:12px 14px;white-space:pre-wrap;'
    + 'font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px;line-height:1.55;'
    + 'max-height:46vh;overflow:auto">'+esc(r.plano)+'</div>'
    + '<div class="acciones"><button class="outline small" onclick="tdCompCopiar()">📋 Copiar</button>'
    + '<button class="grave small" onclick="tdCompEnviar()">📨 Mandar al grupo</button>'
    + '<span class="muted" style="font-size:12px;align-self:center">Va al grupo interno, no al del cliente.</span></div>';
}
async function tdCompCopiar(){
  try { await navigator.clipboard.writeText(window._tdCompPlano||''); toast('Copiado'); }
  catch(e){ toast('No se pudo copiar: seleccionalo y copialo a mano'); }
}
async function tdCompEnviar(){
  const ids=tdCompIds(); if(!ids.length) return toast('Marcá al menos una cuenta');
  // SALE PARA AFUERA: se pregunta siempre, y se dice a dónde.
  if(!confirm('¿Mandar esta comparativa al grupo de Telegram?\n\nVa al grupo interno (⚙ Config), no al de ningún cliente.')) return;
  const r=await api('/api/os/tbs/comparativa/enviar',{method:'POST',
    body:JSON.stringify({mes:_tdMes, ids})});
  toast(r&&r.ok ? ('Mandada · '+r.cuentas+' cuenta(s)') : ('No salió: '+((r&&r.error)||'')));
}
