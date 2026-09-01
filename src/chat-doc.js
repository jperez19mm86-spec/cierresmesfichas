/**
 * chat-doc.js — LAS DOS HOJAS DEL CHAT EXTERNO.
 *
 * El mismo mes se cuenta dos veces, para dos personas distintas, y cada una tiene que ver un número
 * diferente sin enterarse del otro:
 *
 *   · LA DEL CLIENTE     «ésta fue tu ganancia, esto tenés que pagar»  → con SU %
 *   · LA DEL PROVEEDOR   «ésta fue la ganancia de ellos, esto te van a pagar» → con el costo
 *
 * ── POR QUÉ HAY UNA PROYECCIÓN ANTES DEL HTML ────────────────────────────────────────────────
 * `paraCliente` arma un objeto que NO CONTIENE lo que el cliente no puede ver: ni el costo del
 * proveedor, ni el margen, ni lo que pagan los demás. Después `htmlCliente` dibuja ese objeto y
 * nada más. Podría haberse hecho todo junto y filtrado al imprimir, pero entonces el dato interno
 * estaría a mano y bastaría una línea distraída para que saliera. La forma más segura de no
 * filtrar un número es no tenerlo.
 *
 * Del otro lado pasa lo mismo al revés: el proveedor ve la ganancia de cada panel y su 2%, y no ve
 * qué le cobrás vos a cada cliente. `paraProveedor` tampoco arrastra ese dato.
 *
 * ── LA MONEDA Y EL TIPO DE CAMBIO VAN SIEMPRE ────────────────────────────────────────────────
 * Cobrar el 2% de una ganancia en pesos y el 2% de una en dólares son dos cuentas que no se
 * parecen. Si la hoja dice sólo "USDT 398,56", el que la recibe no tiene con qué comprobarla. Con
 * la ganancia en su moneda y el tipo de cambio usado al lado, la puede rehacer con una calculadora
 * — que es exactamente lo que hace alguien que desconfía de una factura.
 */
const money = require('./lib/money');

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const n = (x, d = 2) => Number(x || 0).toLocaleString('es-AR', { minimumFractionDigits: d, maximumFractionDigits: d });
const pctTxt = (x) => String(x).replace(/\.0+$/, '') + '%';

const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio',
  'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const mesLargo = (m) => {
  const [y, mm] = String(m || '').split('-');
  return MESES[Number(mm) - 1] ? `${MESES[Number(mm) - 1]} de ${y}` : String(m || '');
};

/* LA CARA DEL CHAT ES LA DEL PORTAL: morada, con el perrito. Es otro producto que las fichas —otra
   cuenta, otra wallet, otro grupo— y el papel que recibe el cliente tiene que decirlo desde la
   primera línea. Los mismos colores que ganamos.html a propósito: si la hoja saliera con la paleta
   del otro negocio, parecería de otra empresa. */
/* La cara sale de /piel.css, que comparten las tres pantallas del chat. Absoluto y no relativo:
   esta hoja vive en /chat/<token>, así que uno relativo pediría /chat/piel.css y llegaría el login.
   Antes el estilo viajaba adentro del HTML, y las guardas que revisan que no se escape un dato
   interno lo escaneaban también: una palabra en un comentario del CSS devolvía un 500. */
const CSS_LINK = '<link rel="stylesheet" href="/piel.css?v=3bdc6286">';

/* El perrito, el mismo del portal. Dibujado y no un emoji: un emoji cambia de cara según el
   aparato, y esto es la marca. */
/* El globo de chat. Antes era un perrito dibujado a mano; el producto pasó a llamarse CHAT
   INTERNO y un perro ya no dice de qué se trata. */
const MARCA_IC = `<svg viewBox="0 0 100 100" aria-hidden="true">
  <path d="M23 17h54c7.2 0 13 5.8 13 13v31c0 7.2-5.8 13-13 13H49.5L30 92V74h-7c-7.2 0-13-5.8-13-13V30c0-7.2 5.8-13 13-13z" fill="#fff" opacity=".92"/>
  <circle cx="34" cy="45" r="6" fill="#6b2a92"/><circle cx="50" cy="45" r="6" fill="#8e3fb0"/>
  <circle cx="66" cy="45" r="6" fill="#b25fd0"/>
</svg>`;

/* ── CÓMO SE VUELVE, SEGÚN QUIÉN ESTÉ MIRANDO ────────────────────────────────────────────────
   La hoja se abre en una pestaña nueva, así que la flecha del navegador queda apagada: no hay a
   dónde volver. Y son dos lectores distintos:
     · el CLIENTE llega con su token desde el portal → un link de vuelta al portal.
     · la dueña la abre desde el panel para mirarla antes de mandarla → cerrar la pestaña, que es
       lo único que tiene sentido cuando la pestaña la abrió un script.
   `window.close()` sólo funciona en pestañas abiertas por script, que es justo este caso. */
const volver = (ctx) => (ctx && ctx.token)
  ? '<div class="volver"><a href="/chat">← Volver</a></div>'
  : '<div class="volver"><button type="button" onclick="window.close()">← Cerrar</button></div>';

/* ── DE QUÉ ESTÁ HECHO LO QUE SE LE COBRÓ ESTE MES ───────────────────────────────────────────
   Acá hay DOS cobros distintos: el % sobre la ganancia, que se cobra el 1ro con el mes cerrado, y
   el mantenimiento de cada caja, que se cobra por adelantado el día que arranca.

   El renglón que había decía «De este mes · 4% de la ganancia» encima del total del mes — y hoy
   ese total, en los tres clientes, es PURO MANTENIMIENTO: el % de agosto todavía no se cobró. O
   sea que la hoja le decía al cliente que 300 USDT eran el 4% de su ganancia cuando eran dos
   mensualidades de 150. No era un dato repetido: era un dato equivocado.

   Ahora se abre en sus partes. Y cuando el % todavía no se cobró se dice, porque arriba está la
   tabla «Por caja» con una columna «A pagar» que es una PROYECCIÓN, y sin esta línea el cliente
   suma esos números al total y no le cierra. */
function desgloseMes(ctx, doc) {
  const movs = (ctx.movsMes || []).filter((m) => m.tipo !== 'pago');
  const total = ctx.cobradoMes != null ? ctx.cobradoMes : doc.total;
  if (!ctx.saldo) return '';
  const mant = movs.filter((m) => m.tipo === 'mensualidad');
  const pct = movs.filter((m) => m.tipo === 'cobro');
  const filas = [];
  if (pct.length) {
    filas.push([`${doc.pctUnico ? esc(pctTxt(doc.pct)) + ' de la ganancia' : 'Por la ganancia'}`,
      n(pct.reduce((a, m) => a + Number(m.monto || 0), 0), 2)]);
  }
  /* CON LAS FECHAS QUE CUBRE. Un renglón que dice «Mantenimiento · AgenteFortuna — 150» no dice
     por qué tramo se está cobrando, y a la segunda caja el cliente pregunta si no le cobraron dos
     veces lo mismo. El período sale de la fecha del movimiento, no del texto de la nota: la nota
     es un rótulo y podría cambiar, la fecha es el dato. */
  for (const m of mant) {
    /* Se pide adentro y no arriba: el período y el nombre los resuelve el store —es el mismo que
       escribe el renglón— y traerlos acá ataría este archivo, que sólo dibuja, al que tiene la
       lógica. La caja va por su LINK, igual que en el resto: el nombre interno se lo pusimos
       nosotros y el cliente nunca lo usó. */
    const st = require('./chat-externo.store');
    const per = st.periodoDesde(m.fecha);
    const caja = st.comoLaLlamaElCliente(m.panel);
    filas.push([`Mantenimiento${caja ? ' · ' + esc(caja) : ''}`
      + (per ? ` <span class="tenue">${esc(per.texto)}</span>` : ''), n(m.monto, 2)]);
  }
  /* Sin movimientos no hay de qué hacer un desglose, pero el total del mes tiene que salir igual:
     es la mitad de la respuesta —lo de este mes contra lo que debe en total— y sin él la hoja
     muestra un saldo sin decir qué parte es de acá. */
  if (!filas.length) {
    return `<div class="sub-tot"><span>De este mes</span><b>${n(total, 2)} USDT</b></div>`;
  }
  return `<h2>Qué se te cobró de ${esc(mesLargo(doc.mes))}</h2>
  <div class="caja"><table><tbody>
    ${filas.map(([q, c]) => `<tr><td>${q}</td><td class="r">${c}</td></tr>`).join('')}
    <tr class="tot-fila"><td><b>Total del mes</b></td><td class="r"><b>${n(total, 2)} USDT</b></td></tr>
  </tbody></table></div>
  ${!pct.length ? `<p class="bajo">El ${doc.pctUnico ? esc(pctTxt(doc.pct)) : 'porcentaje'} sobre la
    ganancia de ${esc(mesLargo(doc.mes))} todavía no se cobró: se cobra a mes cerrado. Los números
    de arriba son un adelanto de cuánto va a ser.</p>` : ''}`;
}

/* UNA sola fila: ícono, nombre, y el «volver» empujado al final. Antes eran dos `.adentro`
   apilados y en un teléfono el botón quedaba de un lado y el título del otro. */
const cabecera = (titulo, sub, ctx) => `<div class="cab"><div class="adentro">${MARCA_IC}
  <div><div class="marca">Chat Interno</div><h1>${esc(titulo)}</h1>
  <div class="sub">${esc(sub)}</div></div>${volver(ctx)}</div></div>`;

const marco = (titulo, cuerpo) => `<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#3b1152">
<title>${esc(titulo)}</title>${CSS_LINK}</head><body>${cuerpo}</body></html>`;

/* La ganancia de una caja EN SU MONEDA, con el tipo de cambio abajo. El número convertido solo no
   se puede comprobar: el que la recibe ve pesos en su panel, no USDT. */
function celdaMonedas(monedas) {
  const d = (monedas || []).filter((x) => Number(x.profit) > 0);
  if (!d.length) return '<span class="tc">—</span>';
  return d.map((x) => `<div class="mon"><b>${n(x.profit, 0)}</b> <span class="tc">${esc(x.moneda)}</span>`
    + (x.usdt == null ? '<div class="tc">sin tipo de cambio</div>'
      : (x.moneda === 'USD' || x.moneda === 'USDT' ? ''
        : `<div class="tc">÷ ${n(x.tc, 2)}</div>`))
    + '</div>').join('');
}

/** Los renglones de ganancia por moneda, iguales en las dos hojas. */
function filasMoneda(monedas) {
  return (monedas || []).map((m) => {
    const conv = m.usdt == null
      ? '<span class="tc">sin tipo de cambio</span>'
      : (m.moneda === 'USD' || m.moneda === 'USDT'
        ? '<span class="tc">—</span>'
        : `<span class="tc">÷ ${n(m.tc, 2)}</span>`);
    return `<tr>
      <td>${esc(m.moneda)}</td>
      <td class="r">${n(m.profit, 0)}</td>
      <td class="r">${conv}</td>
      <td class="r">${m.usdt == null ? '—' : n(m.usdt, 2)}</td>
    </tr>`;
  }).join('');
}

/**
 * LA HOJA DEL CLIENTE — proyección.
 * @param g   un elemento de chat.porCliente(mes).clientes
 * @param ctx { mes, nota }
 * @returns   SÓLO lo que el cliente puede ver
 */
function paraCliente(g, ctx = {}) {
  return {
    mes: String(ctx.mes || '').slice(0, 7),
    cliente: g.cliente,
    pct: g.paneles && g.paneles.length ? g.paneles[0].pct_cliente : '0',
    // Un cliente puede tener paneles con % distinto; entonces se muestra el % en cada renglón.
    pctUnico: !!(g.paneles || []).every((p) => p.pct_cliente === (g.paneles[0] || {}).pct_cliente),
    monedas: (g.monedas || []).map((m) => ({ moneda: m.moneda, profit: m.profit, tc: m.tc, usdt: m.usdt })),
    /* Cada caja con SUS monedas: el cliente compara el renglón contra su propio panel, y para eso
       necesita el número en la moneda en que lo ve ahí, no sólo el convertido. */
    paneles: (g.paneles || []).map((p) => ({
      panel: p.panel, pct: p.pct_cliente, ganancia: p.profit_usdt, cobra: p.cobra,
      // El link de jugadores: un cliente con varias cajas reconoce cuál es por el link, no por
      // el nombre interno del panel.
      link: p.link_jugadores || '',
      /* QUÉ TRAMO DEL MES SE LE CONTÓ. El primer mes cada caja arrancó una fecha distinta, así que
         su % no cubre el mes entero: sin las dos puntas, «6.880,50 × 4%» es un número que el
         cliente no puede comprobar contra su panel. */
      tramo: p.tramo || null,
      monedas: (p.detalle || []).filter((d) => Number(d.profit) > 0)
        .map((d) => ({ moneda: d.moneda, profit: String(d.profit), tc: d.tc || null, usdt: d.usdt })),
    })),
    total: g.cobra,
    sinTC: !!g.sinTC,
    nota: ctx.nota || '',
  };
}

/* CÓMO PAGAR. Puede haber una wallet para el servicio del mes y otra para el mantenimiento —y no
   la misma para todos los clientes—, así que se dibuja lo que le toca a ÉSTE. Si las dos son la
   misma va un bloque solo: repetir la misma dirección dos veces invita a mirar cuál es cuál. */
function unaWallet(w, rotulo, id, concepto) {
  /* ⚠️ EL BOTÓN PREGUNTA ANTES DE COPIAR, y la pregunta dice DE QUÉ es la wallet y QUÉ RED es.
     Las dos direcciones que se pueden confundir son las dos BEP20 —una del % y otra del
     mantenimiento—, así que la etiqueta de la red sola no distingue nada: lo que distingue es el
     concepto. Un toque más, y a cambio es imposible copiar la equivocada sin haberlo leído. */
  return `<div class="paga">
    ${rotulo ? `<div class="rot">${esc(rotulo)}</div>` : ''}
    <div class="red">Red <b>${esc(w.red)}</b>${w.alias && w.alias !== w.red ? ` · ${esc(w.alias)}` : ''}</div>
    <div class="dir" id="${id}">${esc(w.direccion)}</div>
    <button type="button" class="copiar" data-id="${id}" data-c="${esc(concepto || '')}"
      data-red="${esc(w.red)}" data-paso="0" onclick="copiar(this)">Copiar la dirección</button>
    <div class="tras"></div>
  </div>`;
}

/* Cada cosa puede tener MÁS DE UNA wallet: el mantenimiento se cobra por TRC20 y por BEP20 y la red
   la elige el cliente. Se dibujan todas.

   ⚠️ Los ids salen de un contador y no de una constante. `copiar()` busca por getElementById, y dos
   bloques con el mismo id hacen que el segundo botón copie la PRIMERA dirección: el cliente manda
   por la red equivocada y esa plata no vuelve. */
function bloqueDe(lista, rotulo, ctr, concepto) {
  let h = '<div class="concepto">';
  if (rotulo) h += `<div class="rot">${esc(rotulo)}</div>`;
  /* La aclaración de las dos redes va ADENTRO del recuadro, que es donde significa algo: afuera se
     lee como si hablara de las dos cuentas, que sí son distintas. */
  if (lista.length > 1) {
    h += '<p class="mismared">Se cobra una sola vez. Elegí la red que uses: '
      + 'las dos llegan al mismo lugar.</p>';
  }
  for (const w of lista) h += unaWallet(w, '', 'dir' + (ctr.n += 1), concepto);
  return h + '</div>';
}

/* Cuando hay varias para lo mismo hay que decir por qué: si no, se lee como dos cuentas distintas y
   la pregunta "¿a cuál de las dos?" vuelve por privado todos los meses. */
/* La aclaración vive DENTRO del recuadro del concepto (ver bloqueDe). Se deja devolviendo vacío
   para no tocar las cuatro llamadas. */
const variasRedes = () => '';

/* Y cuando el % y el mantenimiento van a cuentas DISTINTAS hay que decirlo con todas las letras.
   Rotular los dos bloques no alcanza: se leen como "dos formas de pagar lo mismo" y el cliente
   manda todo junto a la primera dirección que ve. Esa plata entra, pero entra en la cuenta
   equivocada, y el mes queda medio pago de un lado y de más del otro. */
const SON_DOS = '<div class="ojo"><span class="sig">\u26A0\uFE0F</span><div>'
  + '<b>Son dos cuentas distintas.</b> El % sobre las ganancias se deposita en una, y el '
  + 'mantenimiento en la otra. Fijate cuál antes de mandar.</div></div>';

function bloquePago(p) {
  // Un array vacío es truthy: acá se mira el largo, o sale un "Cómo pagar" sin ninguna dirección.
  const ggr = (p && p.ggr) || []; const mens = (p && p.mens) || [];
  if (!ggr.length && !mens.length) return '';
  const nota = p.nota ? `<div class="avi">${esc(p.nota)}</div>` : '';
  const ctr = { n: 0 };
  if (p.misma || !mens.length) {
    const l = ggr.length ? ggr : mens;
    return `<h2>Cómo pagar</h2>${bloqueDe(l, '', ctr, 'pago')}${variasRedes(l)}${nota}`;
  }
  if (!ggr.length) return `<h2>Cómo pagar</h2>${bloqueDe(mens, 'El mantenimiento', ctr, 'mantenimiento')}${variasRedes(mens)}${nota}`;
  return `<h2>Cómo pagar</h2>${SON_DOS}`
    + `${bloqueDe(ggr, 'El % sobre las ganancias', ctr, '% sobre las ganancias')}${variasRedes(ggr)}`
    + `${bloqueDe(mens, 'El mantenimiento', ctr, 'mantenimiento')}${variasRedes(mens)}${nota}`;
}

/**
 * LA HOJA DEL CLIENTE — HTML. Recibe lo que devuelve `paraCliente` y nada más de adentro.
 *
 * @param ctx {saldo, comoPaga, token, avisos, emision}
 *   `cobradoMes` es lo que se le COBRÓ de ese mes. Va en vez del total recalculado: el detalle de
 *   arriba es una foto y el saldo es lo vivo, y si entre una cosa y la otra cambió un tipo de
 *   cambio la misma página mostraba dos números distintos para el mismo mes — el de arriba, que es
 *   el que tiene que pagar, y el de abajo, más grande. Manda lo cobrado.
 *   `saldo` es lo que debe HOY en la cuenta del chat — todos los meses, no sólo éste: alguien puede
 *   arrastrar tres y mirando un mes solo no se entera. El detalle del mes queda congelado abajo,
 *   porque es lo que se le mandó; el saldo es lo vivo, porque es lo que tiene que pagar.
 *   Con `token` la hoja además deja avisar un pago: sin eso el cliente lee cuánto debe y no tiene
 *   dónde decir que pagó.
 */
/* «Del 17 al 31 de agosto · 15 días». Los días van porque el tramo no siempre es corrido: si una
   caja no reportó un día, ese día no se contó, y «del 17 al 31» sin el número da a entender que
   fueron 15 seguidos cuando pudieron ser 13.
   Sin tramo se dice que no, en vez de dejar la celda vacía: una celda vacía se lee como un error de
   la página y la pregunta llega igual. */
const DIA_MES = (iso) => {
  const [, m, d] = String(iso || '').split('-');
  return `${Number(d)} ${['', 'ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'][Number(m)] || ''}`;
};
function tramoTxt(t) {
  if (!t || !t.desde) return '<span class="tenue">sin datos</span>';
  const uno = t.desde === t.hasta;
  return `${esc(uno ? DIA_MES(t.desde) : `${DIA_MES(t.desde)} – ${DIA_MES(t.hasta)}`)}`
    + `<div class="tenue">${t.dias} día${t.dias === 1 ? '' : 's'} cobrado${t.dias === 1 ? '' : 's'}${
      t.diasAfuera ? ` · ${t.diasAfuera} antes de contratar` : ''}</div>`;
}

function htmlCliente(doc, ctx = {}) {
  const emision = ctx.emision || null;
  const saldo = ctx.saldo || null;
  const avisos = ctx.avisos || [];
  const pend = avisos.filter((a) => a.estado === 'pendiente');
  /* Las opciones del "¿de qué es este pago?" vienen ARMADAS del servidor (opcionesDeConcepto en
     chat-externo.store): el portal dibuja el mismo formulario y dos textos escritos por separado
     terminan diciendo dos cosas distintas. */
  const conc = ctx.conceptos || null;

  const debe = saldo ? Number(saldo.debe) : Number(doc.total);
  const cuerpo = cabecera(doc.cliente, mesLargo(doc.mes), ctx) + `<div class="hoja">
  <div class="tot">
    <span>${saldo
      ? (debe > 0 ? 'Pendiente de pago' : (debe < 0 ? 'Tenés a favor' : 'Estás al día'))
      : 'Total a pagar'}</span>
    <b class="${debe > 0 ? 'debe' : 'ok'}">${n(Math.abs(debe), 2)} USDT</b>
  </div>
  ${saldo ? `<p class="bajo">Se te cobró ${n(saldo.cobrado, 2)} · pagaste ${n(saldo.pagado, 2)}.
    ${saldo.otrosMeses ? 'Incluye meses anteriores.' : ''}</p>` : ''}

  <h2>Tu ganancia de ${esc(mesLargo(doc.mes))}</h2>
  <div class="caja"><table><thead><tr><th>Moneda</th><th class="r">Ganancia</th><th class="r">Tipo de cambio</th><th class="r">En USDT</th></tr></thead>
    <tbody>${filasMoneda(doc.monedas)}</tbody></table></div>
  ${doc.sinTC ? '<div class="avi">Alguna moneda todavía no tiene tipo de cambio del mes: esa parte no está incluida en el total.</div>' : ''}

  ${(doc.paneles || []).length ? `<h2>Por caja</h2>
  ${doc.paneles.map((p) => `<div class="dcaja">
    <div class="dtit"><b>${esc(p.link ? p.link.replace(/^https?:\/\//, '') : p.panel)}</b>
      <span>${n(p.cobra, 2)} USDT</span></div>
    <table><tbody>
      <tr><td>Período</td><td class="r">${tramoTxt(p.tramo)}</td></tr>
      <tr><td>Ganó</td><td class="r">${celdaMonedas(p.monedas)}</td></tr>
      <tr><td>En USDT</td><td class="r">${n(p.ganancia, 2)}</td></tr>
      <tr><td>Tu ${esc(pctTxt(p.pct))}</td><td class="r"><b>${n(p.cobra, 2)} USDT</b></td></tr>
    </tbody></table></div>`).join('')}` : ''}

  ${desgloseMes(ctx, doc)}

  ${bloquePago(ctx.pago)}

  ${ctx.token ? `
  ${pend.length ? `<div class="avi"><b>Ya nos avisaste ${pend.length === 1 ? 'un pago' : pend.length + ' pagos'}</b>
    de ${pend.map((a) => n(a.monto, 2) + ' ' + esc(a.moneda)).join(', ')}.
    ${pend.length === 1 ? 'Lo estamos' : 'Los estamos'} revisando: el saldo se actualiza cuando ${pend.length === 1 ? 'se confirme' : 'se confirmen'}.</div>` : ''}
  <h2>¿Ya pagaste?</h2>
  <form id="f" onsubmit="return avisar(event)">
    <div class="campos">
      ${conc ? `<label>${esc(conc.titulo)}
        <select name="concepto" onchange="sugerir()">${conc.opciones.map((o) => `<option value="${esc(o.valor)}"${o.sugerida ? ' selected' : ''}>${esc(o.rotulo)}</option>`).join('')}</select></label>` : ''}
      ${conc && (conc.cajasMant || []).length > 1 ? `<div id="cajasMant" class="cajas-mant"${
        (conc.opciones.find((o) => o.sugerida) || {}).valor === 'mantenimiento' ? '' : ' style="display:none"'}>
        <div class="rotc">${esc(conc.tituloCajas)}</div>
        ${conc.cajasMant.map((c) => `<label class="cajita"><input type="checkbox" name="caja"
          value="${esc(c.panel)}" data-debe="${esc(c.debe)}" onchange="sugerir()"> ${esc(c.texto)}</label>`).join('')}
        <p class="opt" style="margin:6px 0 0">Si no marcás ninguna, lo aplicamos a las más viejas.</p></div>` : ''}
      <label>Cuánto pagaste
        <input name="monto" inputmode="decimal" placeholder="${saldo ? n(Math.max(0, Number(saldo.debe)), 2) : ''}" required></label>
      <label>Referencia <span class="opt">(opcional)</span>
        <input name="referencia" placeholder="hash, alias, últimos dígitos"></label>
      <label>Comprobante <span class="opt">(opcional)</span>
        <input type="file" name="archivo" accept="image/*"></label>
    </div>
    ${conc && conc.aclaracion ? `<p class="aclara" id="aclaraMes"${
      (conc.opciones.find((o) => o.sugerida) || {}).valor === 'ganancia' ? '' : ' style="display:none"'
    }>${esc(conc.aclaracion)}</p>` : ''}
    <button type="submit" id="b">Avisar el pago</button>
    <p id="msg"></p>
  </form>` : ''}

  ${(avisos || []).filter((a) => a.estado !== 'pendiente').length ? `<h2>Pagos anteriores</h2>
  <table><tbody>${avisos.filter((a) => a.estado !== 'pendiente').map((a) => `<tr>
    <td>${esc(String(a.creado_at).slice(0, 10))}</td>
    <td class="r">${n(a.monto, 2)} ${esc(a.moneda)}</td>
    <td class="r tc">${a.estado === 'aprobado' ? 'confirmado' : 'no lo pudimos confirmar'}</td>
  </tr>`).join('')}</tbody></table>` : ''}

  <p class="pie">El porcentaje se aplica sobre la ganancia del período.
    La ganancia se toma del reporte diario de cada caja.
    ${emision ? `Emitido el ${esc(String(emision.emitido_at).slice(0, 10))} · versión ${esc(emision.version)}` : ''}</p>
  </div>`;

  /* `navigator.clipboard` sólo existe en https (o en localhost). El cliente puede abrir esto desde
     cualquier lado, así que hay un plan B con un textarea: sin eso el botón no hace nada y no se
     entiende por qué. */
  const hayWallet = !!(ctx.pago && (((ctx.pago.ggr || []).length + (ctx.pago.mens || []).length) > 0));
  const jsCopiar = hayWallet ? `<script>
function copiar(b){
  var tras=b.parentNode.querySelector('.tras');
  var t=document.getElementById(b.dataset.id).textContent.trim();
  if(b.dataset.paso==='0'){
    b.dataset.paso='1'; b.className='copiar dudar';
    b.innerHTML='Esta wallet es para el <u>'+b.dataset.c+'</u><br>y la red es <u>'+b.dataset.red
      +'</u>. \u00bfSeguro?<small>Toc\u00e1 de nuevo para copiarla</small>';
    tras.className='tras no';
    tras.textContent='Si mand\u00e1s a la cuenta o a la red equivocada, esa plata no vuelve.';
    clearTimeout(b._t);
    b._t=setTimeout(function(){ b.dataset.paso='0'; b.className='copiar';
      b.textContent='Copiar la direcci\u00f3n'; tras.textContent=''; },7000);
    return;
  }
  clearTimeout(b._t);
  function fin(ok){
    b.dataset.paso='0'; b.className='copiar'+(ok?' ok':'');
    b.textContent=ok?'Copiada':'Copiala a mano';
    tras.className='tras';
    tras.innerHTML=ok?'\u2713 Es la del <b>'+b.dataset.c+'</b> \u00b7 red '+b.dataset.red:'';
    setTimeout(function(){ b.className='copiar'; b.textContent='Copiar la direcci\u00f3n'; },2800);
  }
  function plan_b(){
    var a=document.createElement('textarea'); a.value=t; a.style.position='fixed'; a.style.opacity='0';
    document.body.appendChild(a); a.select();
    try{ document.execCommand('copy'); fin(true); }catch(e){ fin(false); }
    document.body.removeChild(a);
  }
  if(navigator.clipboard&&window.isSecureContext){ navigator.clipboard.writeText(t).then(function(){fin(true);},plan_b); }
  else plan_b();
}
</script>` : '';

  const js = ctx.token ? `<script>
/* Las cajas sólo tienen sentido con el mantenimiento, y lo que marca cambia el monto que sugiere:
   es el número que va a transferir. Gemela de sugerirMonto() en el portal. */
function sugerir(){
  var f=document.getElementById('f'); if(!f||!f.concepto) return;
  var esMant=f.concepto.value==='mantenimiento';
  var caja=document.getElementById('cajasMant');
  if(caja) caja.style.display=esMant?'':'none';
  var acl=document.getElementById('aclaraMes');
  if(acl) acl.style.display=esMant?'none':'';
  var marcadas=[].slice.call(document.querySelectorAll('input[name=caja]:checked'));
  if(esMant&&marcadas.length){
    var t=0; marcadas.forEach(function(x){ t+=Number(x.dataset.debe||0); });
    f.monto.placeholder=t.toLocaleString('es-AR',{minimumFractionDigits:2,maximumFractionDigits:2});
  }
}
async function avisar(e){
  e.preventDefault();
  var f=document.getElementById('f'), b=document.getElementById('b'), m=document.getElementById('msg');
  var arch=f.archivo.files[0]||null;
  b.disabled=true; m.textContent='Enviando…'; m.className='';
  var datos={monto:f.monto.value, referencia:f.referencia.value};
  if(f.concepto) datos.concepto=f.concepto.value;
  if(datos.concepto==='mantenimiento'){
    datos.cajas=[].slice.call(document.querySelectorAll('input[name=caja]:checked')).map(function(x){return x.value;});
  }
  if(arch){
    if(arch.size>6*1024*1024){ m.textContent='La imagen es muy grande (máximo 6 MB).'; m.className='mal'; b.disabled=false; return false; }
    datos.archivo=await new Promise(function(r){ var fr=new FileReader();
      fr.onload=function(){ r({nombre:arch.name, tipo:arch.type, base64:String(fr.result)}); };
      fr.readAsDataURL(arch); });
  }
  try{
    var res=await fetch(location.pathname+'/pague',{method:'POST',
      headers:{'Content-Type':'application/json'}, body:JSON.stringify(datos)});
    var j=await res.json();
    if(j.ok){ m.textContent='Listo, nos llegó. Lo revisamos y actualizamos tu saldo.'; m.className='bien'; f.reset(); }
    else { m.textContent=j.error||'No se pudo enviar.'; m.className='mal'; b.disabled=false; }
  }catch(err){ m.textContent='No se pudo enviar. Probá de nuevo.'; m.className='mal'; b.disabled=false; }
  return false;
}
</script>` : '';

  return marco(`Chat Externo · ${doc.cliente} · ${mesLargo(doc.mes)}`, cuerpo + jsCopiar + js);
}

/**
 * LA HOJA DEL PROVEEDOR — proyección.
 * Ve la ganancia de cada panel y lo que le corresponde por su %. NO ve qué le cobra ella a cada
 * cliente: ése es el precio de otro contrato y no es asunto suyo.
 * @param pc  lo que devuelve chat.porCliente(mes)
 */
function paraProveedor(pc, ctx = {}) {
  const lineas = [];
  for (const g of pc.clientes || []) {
    for (const p of g.paneles || []) {
      lineas.push({
        /* SIN EL NOMBRE DEL CLIENTE. Él cobra por caja y cobra lo mismo por todas: de quién es
           cada una no cambia un número de su liquidación. Pero saber que estas tres son del mismo
           le dice el tamaño de cada cuenta y quién pesa más, que es la cartera de ella. */
        panel: p.panel,
        ganancia: p.profit_usdt, paga: p.paga,
        monedas: (p.detalle || []).filter((d) => Number(d.profit) > 0)
          .map((d) => ({ moneda: d.moneda, profit: String(d.profit), tc: d.tc || null, usdt: d.usdt })),
      });
    }
  }
  lineas.sort((a, b) => money.cmp(b.paga, a.paga));
  const monedas = [];
  for (const l of lineas) {
    for (const m of l.monedas) {
      const y = monedas.find((z) => z.moneda === m.moneda);
      if (y) {
        y.profit = money.add(y.profit, m.profit);
        y.usdt = y.usdt == null || m.usdt == null ? null : money.add(y.usdt, m.usdt);
      } else monedas.push({ ...m });
    }
  }
  /* ⚠️ EL MANTENIMIENTO VA ACÁ, Y ANTES NO IBA. Esta hoja sumaba sólo el % y decía «total a pagar»
     — le mandaba 169,40 cuando le debía 1.219,40. El mantenimiento se le paga 100% a él, así que
     no incluirlo no era una omisión de detalle: era otro número. Y ahora que él tiene su propia
     pantalla, las dos tienen que decir lo mismo o la primera discusión es sobre cuál miente. */
  const porGanancia = money.round(money.sum(lineas.map((l) => l.paga)), 2);
  const mant = ctx.mantenimiento || { debe: '0', cajas: 0 };
  /* ⚠️ LAS CAJAS QUE NO SE PUDIERON CALCULAR VAN IGUAL, y no es un detalle: se le cobra el
     mantenimiento por TODAS, así que si la tabla lista seis y el mantenimiento dice siete, el que
     lo lee cuenta y encuentra un número que no cierra. Dejarla afuera parece un error nuestro.

     Y NO van en cero: una caja que no se pudo calcular no es una caja que no ganó nada, y decirle
     lo segundo cuando pasó lo primero es afirmar algo que no sabemos. Va con la marca.
     El MOTIVO no viaja: «no figura con el usuario 7364108, el mes sí está bajado» es
     infraestructura de ella. Él necesita saber que falta, no por qué. */
  const salteadas = (pc.salteados || []).map((x) => ({ panel: x.panel }));
  return {
    mes: String(ctx.mes || pc.mes || '').slice(0, 7),
    pct: pc.costo_pct,
    monedas,
    lineas: lineas.map((l) => ({
      panel: l.panel, ganancia: l.ganancia, paga: l.paga, monedas: l.monedas,
    })),
    porGanancia,
    salteadas,
    mantenimiento: mant.debe || '0',
    cajasMant: mant.cajas || 0,
    total: money.round(money.add(porGanancia, mant.debe || '0'), 2),
    nota: ctx.nota || '',
  };
}

/** LA HOJA DEL PROVEEDOR — HTML. */
function htmlProveedor(doc, emision = null) {
  const cuerpo = cabecera('Liquidación', `${mesLargo(doc.mes)} · ${pctTxt(doc.pct)} sobre la ganancia`)
  + `<div class="hoja">
  <div class="tot"><span>Total a pagar</span><b>${n(doc.total, 2)} USDT</b></div>

  <h2>Ganancia del período</h2>
  <div class="caja"><table><thead><tr><th>Moneda</th><th class="r">Ganancia</th><th class="r">Tipo de cambio</th><th class="r">En USDT</th></tr></thead>
    <tbody>${filasMoneda(doc.monedas)}</tbody></table></div>

  <h2>Por caja</h2>
  <div class="caja"><table><thead><tr><th>Caja</th><th class="r">Ganancia</th>
    <th class="r">En USDT</th><th class="r">${esc(pctTxt(doc.pct))}</th></tr></thead>
    <tbody>${doc.lineas.map((l) => `<tr><td>${esc(l.panel)}</td>
      <td class="r">${celdaMonedas(l.monedas)}</td>
      <td class="r">${n(l.ganancia, 2)}</td><td class="r">${n(l.paga, 2)}</td></tr>`).join('')}
      ${(doc.salteadas || []).map((x) => `<tr><td>${esc(x.panel)}</td>
        <td class="r sc" colspan="3">no se pudo calcular este mes</td></tr>`).join('')}</tbody>
    <tfoot><tr><td colspan="3" class="r">Por la ganancia</td><td class="r">${n(doc.porGanancia != null ? doc.porGanancia : doc.total, 2)}</td></tr></tfoot></table></div>

  ${Number(doc.mantenimiento || 0) > 0 ? `<h2>Mantenimiento</h2>
  <div class="caja"><table><tbody><tr>
    <td>${esc(String(doc.cajasMant))} caja${doc.cajasMant === 1 ? '' : 's'} del período</td>
    <td class="r">${n(doc.mantenimiento, 2)} USDT</td></tr></tbody></table></div>` : ''}

  ${doc.nota ? `<div class="avi">${esc(doc.nota)}</div>` : ''}

  <p class="pie">La ganancia se toma del reporte diario de cada caja del período.
    ${emision ? `Emitido el ${esc(String(emision.emitido_at).slice(0, 10))} · versión ${esc(emision.version)}` : ''}</p>
  </div>`;
  return marco(`Chat Externo · liquidación · ${mesLargo(doc.mes)}`, cuerpo);
}

/* ── EL LINK QUE SE LE MANDA AL CLIENTE ──────────────────────────────────────────────────────
 * Se guarda la HOJA YA PROYECTADA, no la manera de volver a armarla. Dos razones:
 *   · lo que el cliente abre es lo mismo que viste vos al mandarlo, aunque después cambie un TC;
 *   · en el link no hay forma de que se escape un dato interno, porque el dato interno no está
 *     guardado ahí. Lo que se guarda es lo que devuelve `paraCliente`.
 *
 * Reusa la tabla `factura_link` con el id prefijado 'chat:', igual que la cuenta de API usa 'api:'.
 * Es la misma idea de siempre: un token largo, sin contraseña, que muestra un solo mes de un solo
 * cliente. No hay 45 contraseñas que administrar y el cliente no ve nada más del sistema.
 */
const crypto = require('crypto');
const { db } = require('./db');

/* ⚠️ LA CLAVE LLEVA LA DIVISA, o el segundo documento del mes PISA al primero.
   Un cliente con cajas en dos monedas recibe dos hojas del mismo mes. Con la clave vieja
   —(cliente, mes)— la segunda encontraba la fila viva y le sobreescribía el JSON: el link de
   guaraníes que ya le mandaste, al abrirlo, mostraba el de pesos. Sin error y sin aviso, que es el
   peor modo de fallar de toda la cadena.
   El prefijo queda de largo variable, así que el cliente se recupera cortando por ':' y no por
   posición: `slice(5)` se rompía en cuanto el prefijo creciera. */
const _claveLink = (clienteId, divisa) => `chat:${String(clienteId)}${divisa ? ':' + String(divisa).toUpperCase() : ''}`;

function crearLink(doc, clienteId) {
  const cid = _claveLink(clienteId, doc.divisa);
  const mes = String(doc.mes);
  const at = new Date().toISOString();
  const ya = db.prepare('SELECT token FROM factura_link WHERE cliente_id=? AND mes=? AND revocado=0').get(cid, mes);
  if (ya) {
    // Se refresca la foto y se conserva el token: si ya se lo mandaste, el link que tiene anda.
    db.prepare('UPDATE factura_link SET datos=?, actualizado_at=? WHERE token=?').run(JSON.stringify(doc), at, ya.token);
    return { token: ya.token, actualizado: true };
  }
  const token = crypto.randomBytes(24).toString('base64url');
  db.prepare('INSERT INTO factura_link (token, cliente_id, mes, datos, creado_at, actualizado_at) VALUES (?,?,?,?,?,?)')
    .run(token, cid, mes, JSON.stringify(doc), at, at);
  return { token, actualizado: false };
}

function porToken(token) {
  const r = db.prepare('SELECT * FROM factura_link WHERE token=?').get(String(token || ''));
  // El prefijo es lo que impide que un token de factura abra la hoja del chat y al revés.
  if (!r || !String(r.cliente_id || '').startsWith('chat:')) return null;
  if (r.revocado) return { revocado: true };
  db.prepare('UPDATE factura_link SET accesos=accesos+1, ultimo_acceso=? WHERE token=?').run(new Date().toISOString(), r.token);
  try {
    return {
      doc: JSON.parse(r.datos), cliente_id: String(r.cliente_id).split(':')[1] || '', mes: r.mes,
      divisa: String(r.cliente_id).split(':')[2] || '',
      creado_at: r.creado_at, actualizado_at: r.actualizado_at, accesos: r.accesos + 1,
    };
  }
  catch (e) { return null; }
}

function linksDe(clienteId) {
  /* Con LIKE porque la clave ahora puede llevar la divisa detrás: `chat:<id>` y `chat:<id>:PYG`
     son links del mismo cliente, y buscando exacto se perdían los partidos. El `:` del final del
     patrón evita que `chat:c_1` traiga los de `chat:c_10`. */
  const base = 'chat:' + String(clienteId);
  return db.prepare(`SELECT token, mes, cliente_id, creado_at, actualizado_at, accesos, ultimo_acceso, revocado
    FROM factura_link WHERE cliente_id=? OR cliente_id LIKE ? ORDER BY mes DESC`)
    .all(base, base + ':%')
    .map((r) => ({ ...r, divisa: String(r.cliente_id).split(':')[2] || '' }));
}

/** La página cuando el link no sirve. Sin detalles: del otro lado puede haber cualquiera. */
function paginaError(msg) {
  return marco('Chat Interno', cabecera('Chat Interno', msg)
    + '<div class="hoja"><p class="bajo">Si creés que es un error, escribinos.</p></div>');
}

/* ── EL MENSAJE DE TELEGRAM ──────────────────────────────────────────────────────────────────
 * Hasta acá era un link pelado: «Ganancia del mes y lo que corresponde abonar: <url>». Funciona,
 * pero obliga a abrir la hoja para saber si eso es el mantenimiento, el %, o las dos cosas — y el
 * mantenimiento se cobra por PERÍODO, no por mes calendario, así que sin las fechas el renglón no
 * se explica solo.
 *
 * El resumen va en el mensaje y el detalle sigue en la hoja. Los montos ya estaban del otro lado
 * del link, en el mismo grupo: esto no muestra nada nuevo, lo muestra antes.
 *
 * ⚠️ Sale de los MOVIMIENTOS, no del documento. El documento tiene la proyección del % —lo que va
 * a ser cuando cierre el mes— y anunciar eso como si estuviera cobrado es la confusión que ya nos
 * costó una hoja mal leída. Acá sólo se nombra lo que quedó registrado.
 */
const TOPE_CAJAS = 8;

/* CÓMO SE NOMBRA UNA CAJA CUANDO SE LE HABLA AL CLIENTE.
   Adentro se llama «AgenteFortuna» o «GAF-parA». El cliente no usa esos nombres: los pusimos
   nosotros. Lo que él reconoce es el link donde juega su gente —ganamoscpy.com—, y con cuatro cajas
   es lo ÚNICO que le dice cuál es cuál. La hoja HTML ya lo hace así desde hace rato; el mensaje era
   el último lugar donde seguía saliendo el nombre interno.

   Se muestra sin el https:// porque así es como el cliente lo escribe y lo lee.
   Si la caja no tiene link cargado se cae al nombre: los links NO se deducen nunca —no hay relación
   entre la caja y el dominio que le toca— así que acá tampoco se inventa uno. */
const soloDominio = (u) => String(u || '').trim()
  .replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/+$/, '');

function nombreParaElCliente(mov, cajas) {
  const nom = String(mov.panel || '').trim();
  const c = (cajas || []).find((p) => String(p.panel || '').trim() === nom);
  return soloDominio(c && c.link_jugadores) || nom || 'caja';
}

function textoTelegram(mes, movs, url, cajas, pago, divisa) {
  /* Con dos cuentas, el mensaje tiene que decir de cuál es desde el título: si no, los dos se leen
     igual y el cliente cree que el segundo es el primero repetido. */
  const dv = String(divisa || '').toUpperCase();
  const L = [`<b>Chat Externo</b> · ${esc(mesLargo(mes))}${dv ? ` · tus cajas en ${esc(dv)}` : ''}`, ''];
  /* El renglón que hace que esto se lea como un mensaje y no como una planilla. El mes no se
     repite: está en el título, dos renglones más arriba. */
  L.push('Tu cuenta ya está lista.');
  L.push('');
  const cobros = (movs || []).filter((m) => m.tipo !== 'pago');
  const mant = cobros.filter((m) => m.tipo === 'mensualidad');
  const pct = cobros.filter((m) => m.tipo !== 'mensualidad');
  if (mant.length) {
    L.push(`<b>Mantenimiento</b> · ${n(mant.reduce((a, m) => a + Number(m.monto || 0), 0), 2)} USDT`);
    for (const m of mant.slice(0, TOPE_CAJAS)) {
      const per = require('./chat-externo.store').periodoDesde(m.fecha);
      L.push(`· ${esc(nombreParaElCliente(m, cajas))}${per ? ` — ${esc(per.texto)}` : ''}`);
    }
    /* Si se recortan, se DICE cuántas quedaron afuera. Un listado que termina sin avisar se lee
       como el listado completo, y el que suma a mano no llega al total. */
    if (mant.length > TOPE_CAJAS) L.push(`· y ${mant.length - TOPE_CAJAS} caja(s) más`);
    L.push('');
  }
  L.push(pct.length
    ? `<b>% sobre la ganancia</b> · ${n(pct.reduce((a, m) => a + Number(m.monto || 0), 0), 2)} USDT`
    : '<b>% sobre la ganancia</b> · todavía no se cobró (se cobra a mes cerrado)');
  /* ⚠️ EL AVISO DE LAS DOS WALLETS VA EN EL MENSAJE, no sólo en la hoja. El que lee el Telegram y
     recién al día siguiente abre el link ya se olvidó; y con un solo número en la cabeza manda
     todo junto a la primera dirección que ve. Esa plata entra en la cuenta equivocada y el mes
     queda medio pago de un lado y de más del otro.
     Sale SÓLO cuando las dos cosas van a wallets distintas Y las dos están en este mensaje:
     avisar de una división que no existe, o de una que este mes no aplica, confunde igual. */
  const dosWallets = !!(pago && !pago.misma && (pago.ggr || []).length && (pago.mens || []).length);
  if (dosWallets && mant.length && pct.length) {
    L.push('');
    L.push('⚠️ El mantenimiento y el % van a <b>wallets distintas</b>. Fijate cuál es cuál antes de mandar.');
  }
  L.push('');
  L.push('Todo el detalle y adónde pagar:');
  L.push(url);
  /* Va al PORTAL, no a un link con token. El portal se abre escribiendo el usuario que ya usa
     —el de su caja, o su código— y muestra el saldo al día, sus cajas con sus links, y adónde
     pagar. Un link con token es una llave suelta en un grupo de Telegram y muestra un mes
     congelado; el portal es una puerta con su nombre y siempre está al día. */
  L.push('Ingresá con tu usuario de siempre.');
  return L.join('\n');
}

module.exports = {
  paraCliente, htmlCliente, paraProveedor, htmlProveedor, mesLargo, textoTelegram, soloDominio,
  crearLink, porToken, linksDe, paginaError,
};
