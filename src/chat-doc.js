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
const CSS = `
  :root{
    --uva:#3b1152; --uva2:#5a1d7d; --uva3:#7b2ea6;
    --lila:#eadff5; --lila2:#f7f1fb;
    --tinta:#241033; --tinta2:#6b5a78; --linea:#e4d7ee;
    --verde:#2e7d5b; --rojo:#c0392b;
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--lila2);color:var(--tinta);
    font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
    -webkit-font-smoothing:antialiased}
  .cab{background:var(--uva);color:#fff;padding:22px 20px 30px}
  .cab .adentro{max-width:820px;margin:0 auto;display:flex;align-items:center;gap:13px}
  .cab svg{width:38px;height:38px;flex:0 0 auto}
  .cab .marca{font-size:11px;opacity:.72;letter-spacing:.13em;text-transform:uppercase}
  .cab h1{font-size:20px;margin:1px 0 0;font-weight:800;letter-spacing:-.01em}
  .cab .sub{font-size:13.5px;opacity:.75;margin-top:1px}
  .hoja{max-width:820px;margin:0 auto;padding:0 20px 44px}
  .tot{margin-top:-16px;background:#fff;border:1px solid var(--linea);border-radius:16px;
    padding:18px 20px;box-shadow:0 8px 24px -18px rgba(59,17,82,.55);
    display:flex;justify-content:space-between;align-items:baseline;gap:14px;flex-wrap:wrap}
  .tot span{font-size:12.5px;letter-spacing:.09em;text-transform:uppercase;color:var(--tinta2)}
  .tot b{font-size:30px;font-weight:800;letter-spacing:-.02em}
  .tot b.debe{color:var(--rojo)} .tot b.ok{color:var(--verde)}
  .bajo{font-size:13px;color:var(--tinta2);margin:7px 2px 0}
  h2{font-size:12px;letter-spacing:.1em;text-transform:uppercase;color:var(--tinta2);
    margin:26px 0 8px;font-weight:700}
  .caja{background:#fff;border:1px solid var(--linea);border-radius:14px;padding:6px 16px}
  table{width:100%;border-collapse:collapse}
  th{text-align:left;font-size:11px;text-transform:uppercase;color:var(--tinta2);
    border-bottom:1px solid var(--lila);padding:9px 6px;font-weight:700;letter-spacing:.03em}
  td{padding:10px 6px;border-bottom:1px solid var(--lila);vertical-align:top}
  tr:last-child td{border-bottom:none}
  .r{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}
  .tc{color:var(--tinta2);font-size:12px}
  .mon{margin-bottom:5px} .mon:last-child{margin-bottom:0}
  /* El link de la caja, debajo de su nombre: sin protocolo, que no aporta y ocupa. */
  .tot-fila td{border-top:2px solid var(--linea);padding-top:11px}
  .lnk{margin-top:3px;font-size:12.5px;word-break:break-all}
  .lnk a{color:var(--tinta2);text-decoration:none;border-bottom:1px solid currentColor}
  .lnk a:hover{color:var(--acento)}
  /* Volver: una barra fina arriba de todo, fuera de la hoja. */
  .volver{padding:12px 20px 0}
  .volver a,.volver button{display:inline-flex;align-items:center;gap:7px;background:none;border:none;
    color:#fff;opacity:.82;font:inherit;font-size:14.5px;cursor:pointer;text-decoration:none;padding:0}
  .volver a:hover,.volver button:hover{opacity:1}
  tfoot td{font-weight:700;border-top:2px solid var(--lila);border-bottom:none}
  .sub-tot{margin-top:14px;background:#fff;border:1px solid var(--linea);border-radius:13px;
    padding:13px 16px;display:flex;justify-content:space-between;align-items:baseline;gap:14px;flex-wrap:wrap}
  .sub-tot span{font-size:13.5px;color:var(--tinta2)}
  .sub-tot b{font-size:18px}
  .avi{margin-top:14px;padding:11px 14px;border-left:3px solid var(--uva3);background:#fff;
    border-radius:0 11px 11px 0;font-size:13.5px;color:var(--tinta2)}
  .paga{background:#fff;border:1px solid var(--linea);border-radius:14px;padding:15px 16px;font-size:14.5px}
  .paga .rot{font-size:11px;letter-spacing:.09em;text-transform:uppercase;color:var(--uva2);
    font-weight:700;margin-bottom:6px}
  .paga .red{font-size:13px;color:var(--tinta2);margin-bottom:8px}
  .paga + .paga{margin-top:10px}
  .paga .dir{word-break:break-all;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;
    font-size:14px;background:var(--lila2);border:1px solid var(--linea);border-radius:10px;padding:12px 13px}
  .paga .notap{margin-top:9px;font-size:13px;color:var(--tinta2)}
  .copiar{margin-top:11px;padding:12px 16px;font:inherit;font-size:14px;font-weight:700;border:0;
    border-radius:11px;background:var(--uva2);color:#fff;cursor:pointer;width:100%}
  .copiar.ok{background:var(--verde)}
  form{background:#fff;border:1px solid var(--linea);border-radius:14px;padding:16px}
  .campos{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(210px,100%),1fr));gap:13px;margin-bottom:13px}
  label{display:block;font-size:12.5px;color:var(--tinta2)}
  label .opt{color:#b7a9c2}
  input,select{width:100%;margin-top:5px;padding:11px 12px;font:inherit;border:1px solid var(--linea);
    border-radius:11px;background:#fff;color:inherit}
  input:focus-visible,select:focus-visible{outline:2px solid var(--uva3);outline-offset:1px}
  /* La aclaración de que el mes todavía no está: ocupa las dos columnas de la grilla. */
  .aclara{grid-column:1/-1;margin:0;font-size:13px;color:#6f6280;line-height:1.5}
  /* Una caja que no se pudo calcular: va listada igual, pero sin números inventados. */
  .sc{color:#9b8aa8;font-style:italic;font-size:13.5px}
  /* Elegir de qué cajas es el pago: uno con cuatro no paga cuatro veces. */
  .cajas-mant{grid-column:1/-1}
  .cajas-mant .rotc{font-size:13px;color:#6f6280;margin-bottom:4px}
  .cajita{display:flex;align-items:center;gap:9px;font-size:15px;cursor:pointer;margin-top:6px}
  .cajita input{width:auto;margin:0;flex:0 0 auto}
  button[type=submit]{padding:13px 20px;font:inherit;font-weight:800;border:0;border-radius:11px;
    background:var(--uva2);color:#fff;cursor:pointer;width:100%}
  button:disabled{opacity:.5;cursor:default}
  #msg{margin:11px 0 0;font-size:14px}
  #msg.bien{color:var(--verde)} #msg.mal{color:var(--rojo)}
  .pie{margin-top:30px;font-size:11.5px;color:var(--tinta2);border-top:1px solid var(--lila);padding-top:12px}
  @media print{
    body{background:#fff}
    .cab{background:#fff;color:var(--tinta);padding:0 0 12px;border-bottom:2px solid var(--linea)}
    .cab svg path,.cab svg circle{stroke:var(--uva);fill:none}
    .cab svg circle,.cab svg path[fill]{fill:var(--uva)}
    .hoja{padding:0} .tot{margin-top:14px;box-shadow:none}
    form,button,.copiar{display:none}
    .tot,.paga{-webkit-print-color-adjust:exact;print-color-adjust:exact}
  }
`;

/* El perrito, el mismo del portal. Dibujado y no un emoji: un emoji cambia de cara según el
   aparato, y esto es la marca. */
const PERRO = `<svg viewBox="0 0 100 100" fill="none" aria-hidden="true">
  <path d="M22 30c-6 2-9 12-8 24 1 10 4 15 9 16" stroke="#fff" stroke-width="6" stroke-linecap="round"/>
  <path d="M78 30c6 2 9 12 8 24-1 10-4 15-9 16" stroke="#fff" stroke-width="6" stroke-linecap="round"/>
  <path d="M50 20c-15 0-27 10-27 26 0 17 12 32 27 32s27-15 27-32c0-16-12-26-27-26z"
    stroke="#fff" stroke-width="6" stroke-linejoin="round"/>
  <circle cx="39" cy="45" r="4.5" fill="#fff"/><circle cx="61" cy="45" r="4.5" fill="#fff"/>
  <path d="M50 56c-4 0-7 2-7 5s3 5 7 5 7-2 7-5-3-5-7-5z" fill="#fff"/></svg>`;

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
    /* Se pide adentro y no arriba: el período lo calcula el store —es el mismo que escribe el
       renglón— y traerlo acá arriba ataría este archivo, que sólo dibuja, al que tiene la lógica. */
    const per = require('./chat-externo.store').periodoDesde(m.fecha);
    filas.push([`Mantenimiento${m.panel ? ' · ' + esc(m.panel) : ''}`
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

const cabecera = (titulo, sub, ctx) => `<div class="cab"><div class="adentro">${volver(ctx)}</div>
  <div class="adentro">${PERRO}
  <div><div class="marca">Ganamos × Latam</div><h1>${esc(titulo)}</h1>
  <div class="sub">${esc(sub)}</div></div></div></div>`;

const marco = (titulo, cuerpo) => `<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#3b1152">
<title>${esc(titulo)}</title><style>${CSS}</style></head><body>${cuerpo}</body></html>`;

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
function unaWallet(w, rotulo, id) {
  return `<div class="paga">
    ${rotulo ? `<div class="rot">${esc(rotulo)}</div>` : ''}
    <div class="red">Red <b>${esc(w.red)}</b>${w.alias && w.alias !== w.red ? ` · ${esc(w.alias)}` : ''}</div>
    <div class="dir" id="${id}">${esc(w.direccion)}</div>
    <button type="button" class="copiar" onclick="copiar(this,'${id}')">Copiar la dirección</button>
  </div>`;
}

/* Cada cosa puede tener MÁS DE UNA wallet: el mantenimiento se cobra por TRC20 y por BEP20 y la red
   la elige el cliente. Se dibujan todas.

   ⚠️ Los ids salen de un contador y no de una constante. `copiar()` busca por getElementById, y dos
   bloques con el mismo id hacen que el segundo botón copie la PRIMERA dirección: el cliente manda
   por la red equivocada y esa plata no vuelve. */
function bloqueDe(lista, rotulo, ctr) {
  return lista.map((w, i) => unaWallet(w, i === 0 ? rotulo : '', 'dir' + (ctr.n += 1))).join('');
}

/* Cuando hay varias para lo mismo hay que decir por qué: si no, se lee como dos cuentas distintas y
   la pregunta "¿a cuál de las dos?" vuelve por privado todos los meses. */
const variasRedes = (lista) => (lista.length > 1
  ? '<p class="bajo">Mandá por la red que uses. Las dos llegan al mismo lugar.</p>' : '');

/* Y cuando el % y el mantenimiento van a cuentas DISTINTAS hay que decirlo con todas las letras.
   Rotular los dos bloques no alcanza: se leen como "dos formas de pagar lo mismo" y el cliente
   manda todo junto a la primera dirección que ve. Esa plata entra, pero entra en la cuenta
   equivocada, y el mes queda medio pago de un lado y de más del otro. */
const SON_DOS = '<p class="bajo"><b>Son dos cuentas distintas.</b> El % sobre las ganancias '
  + 'se deposita en una, y el mantenimiento en la otra. Fijate cuál antes de mandar.</p>';

function bloquePago(p) {
  // Un array vacío es truthy: acá se mira el largo, o sale un "Cómo pagar" sin ninguna dirección.
  const ggr = (p && p.ggr) || []; const mens = (p && p.mens) || [];
  if (!ggr.length && !mens.length) return '';
  const nota = p.nota ? `<div class="avi">${esc(p.nota)}</div>` : '';
  const ctr = { n: 0 };
  if (p.misma || !mens.length) {
    const l = ggr.length ? ggr : mens;
    return `<h2>Cómo pagar</h2>${bloqueDe(l, '', ctr)}${variasRedes(l)}${nota}`;
  }
  if (!ggr.length) return `<h2>Cómo pagar</h2>${bloqueDe(mens, 'Mantenimiento', ctr)}${variasRedes(mens)}${nota}`;
  return `<h2>Cómo pagar</h2>${SON_DOS}`
    + `${bloqueDe(ggr, 'El % sobre las ganancias', ctr)}${variasRedes(ggr)}`
    + `${bloqueDe(mens, 'El mantenimiento', ctr)}${variasRedes(mens)}${nota}`;
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
function htmlCliente(doc, ctx = {}) {
  const emision = ctx.emision || null;
  const varios = (doc.paneles || []).length > 1;
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
      ? (debe > 0 ? 'Tenés que pagar' : (debe < 0 ? 'Tenés a favor' : 'Estás al día'))
      : 'Total a pagar'}</span>
    <b class="${debe > 0 ? 'debe' : 'ok'}">${n(Math.abs(debe), 2)} USDT</b>
  </div>
  ${saldo ? `<p class="bajo">Se te cobró ${n(saldo.cobrado, 2)} · pagaste ${n(saldo.pagado, 2)}.
    ${saldo.otrosMeses ? 'Incluye meses anteriores.' : ''}</p>` : ''}

  <h2>Tu ganancia de ${esc(mesLargo(doc.mes))}</h2>
  <div class="caja"><table><thead><tr><th>Moneda</th><th class="r">Ganancia</th><th class="r">Tipo de cambio</th><th class="r">En USDT</th></tr></thead>
    <tbody>${filasMoneda(doc.monedas)}</tbody></table></div>
  ${doc.sinTC ? '<div class="avi">Alguna moneda todavía no tiene tipo de cambio del mes: esa parte no está incluida en el total.</div>' : ''}

  ${varios ? `<h2>Por caja</h2>
  <div class="caja"><table><thead><tr><th>Caja</th><th class="r">Ganancia</th>
    <th class="r">En USDT</th><th class="r">%</th><th class="r">A pagar</th></tr></thead>
    <tbody>${doc.paneles.map((p) => `<tr><td>${esc(p.panel)}${
      p.link ? `<div class="lnk"><a href="${esc(p.link)}" target="_blank" rel="noopener">${esc(p.link.replace(/^https?:\/\//, ''))}</a></div>` : ''}</td>
      <td class="r">${celdaMonedas(p.monedas)}</td>
      <td class="r">${n(p.ganancia, 2)}</td><td class="r">${esc(pctTxt(p.pct))}</td>
      <td class="r">${n(p.cobra, 2)}</td></tr>`).join('')}</tbody></table></div>` : ''}

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
function copiar(b,id){
  var t=document.getElementById(id).textContent.trim();
  function ok(){ b.textContent='Copiada'; b.className='copiar ok';
    setTimeout(function(){ b.textContent='Copiar la dirección'; b.className='copiar'; },1800); }
  if(navigator.clipboard&&window.isSecureContext){ navigator.clipboard.writeText(t).then(ok,plan_b); }
  else plan_b();
  function plan_b(){
    var a=document.createElement('textarea'); a.value=t; a.style.position='fixed'; a.style.opacity='0';
    document.body.appendChild(a); a.select();
    try{ document.execCommand('copy'); ok(); }catch(e){ b.textContent='Copiala a mano'; }
    document.body.removeChild(a);
  }
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
        cliente: g.cliente, panel: p.panel,
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
  const salteadas = (pc.salteados || []).map((x) => ({ cliente: x.cliente || '—', panel: x.panel }));
  return {
    mes: String(ctx.mes || pc.mes || '').slice(0, 7),
    pct: pc.costo_pct,
    monedas,
    lineas: lineas.map((l) => ({
      cliente: l.cliente, panel: l.panel, ganancia: l.ganancia, paga: l.paga, monedas: l.monedas,
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
  <div class="caja"><table><thead><tr><th>Cuenta</th><th>Caja</th><th class="r">Ganancia</th>
    <th class="r">En USDT</th><th class="r">${esc(pctTxt(doc.pct))}</th></tr></thead>
    <tbody>${doc.lineas.map((l) => `<tr><td>${esc(l.cliente)}</td><td>${esc(l.panel)}</td>
      <td class="r">${celdaMonedas(l.monedas)}</td>
      <td class="r">${n(l.ganancia, 2)}</td><td class="r">${n(l.paga, 2)}</td></tr>`).join('')}
      ${(doc.salteadas || []).map((x) => `<tr><td>${esc(x.cliente)}</td><td>${esc(x.panel)}</td>
        <td class="r sc" colspan="3">no se pudo calcular este mes</td></tr>`).join('')}</tbody>
    <tfoot><tr><td colspan="4" class="r">Por la ganancia</td><td class="r">${n(doc.porGanancia != null ? doc.porGanancia : doc.total, 2)}</td></tr></tfoot></table></div>

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

function crearLink(doc, clienteId) {
  const cid = 'chat:' + String(clienteId);
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
      doc: JSON.parse(r.datos), cliente_id: String(r.cliente_id).slice(5), mes: r.mes,
      creado_at: r.creado_at, actualizado_at: r.actualizado_at, accesos: r.accesos + 1,
    };
  }
  catch (e) { return null; }
}

function linksDe(clienteId) {
  return db.prepare(`SELECT token, mes, creado_at, actualizado_at, accesos, ultimo_acceso, revocado
    FROM factura_link WHERE cliente_id=? ORDER BY mes DESC`).all('chat:' + String(clienteId));
}

/** La página cuando el link no sirve. Sin detalles: del otro lado puede haber cualquiera. */
function paginaError(msg) {
  return marco('Ganamos × Latam', cabecera('Ganamos × Latam', msg)
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
function textoTelegram(mes, movs, url) {
  const L = [`<b>Chat Externo</b> · ${esc(mesLargo(mes))}`, ''];
  const cobros = (movs || []).filter((m) => m.tipo !== 'pago');
  const mant = cobros.filter((m) => m.tipo === 'mensualidad');
  const pct = cobros.filter((m) => m.tipo !== 'mensualidad');
  if (mant.length) {
    L.push(`<b>Mantenimiento</b> · ${n(mant.reduce((a, m) => a + Number(m.monto || 0), 0), 2)} USDT`);
    for (const m of mant.slice(0, TOPE_CAJAS)) {
      const per = require('./chat-externo.store').periodoDesde(m.fecha);
      L.push(`· ${esc(m.panel || 'caja')}${per ? ` — ${esc(per.texto)}` : ''}`);
    }
    /* Si se recortan, se DICE cuántas quedaron afuera. Un listado que termina sin avisar se lee
       como el listado completo, y el que suma a mano no llega al total. */
    if (mant.length > TOPE_CAJAS) L.push(`· y ${mant.length - TOPE_CAJAS} caja(s) más`);
    L.push('');
  }
  L.push(pct.length
    ? `<b>% sobre la ganancia</b> · ${n(pct.reduce((a, m) => a + Number(m.monto || 0), 0), 2)} USDT`
    : '<b>% sobre la ganancia</b> · todavía no se cobró (se cobra a mes cerrado)');
  L.push('');
  L.push('Todo el detalle y adónde pagar:');
  L.push(url);
  return L.join('\n');
}

module.exports = {
  paraCliente, htmlCliente, paraProveedor, htmlProveedor, mesLargo, textoTelegram,
  crearLink, porToken, linksDe, paginaError,
};
