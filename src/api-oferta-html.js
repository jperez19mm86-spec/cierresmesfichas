/**
 * api-oferta-html.js — EL DOCUMENTO DE LA OFERTA, EL QUE VE EL CLIENTE.
 *
 * Contesta una sola pregunta: "¿cuánto me cobrás por los proveedores?". Por eso muestra los
 * NOMBRES DE LOS PROVEEDORES —Pragmatic, Evolution, Novomatic— y no los sellos internos: "SL" no
 * le dice nada a nadie de afuera.
 *
 * ── LO QUE NO PUEDE APARECER ─────────────────────────────────────────────────────────────────
 * Ni el costo del proveedor, ni el margen, ni los puntos de los socios, ni el nombre del sello, ni
 * a qué grupo de TBS corresponde. Este archivo recibe sólo lo que `paraMostrar` devuelve —nombre
 * del paquete, proveedores y el % del cliente— y no tiene acceso a nada más. Es a propósito: la
 * forma más segura de no filtrar un dato interno es no tenerlo a mano.
 *
 * ── UN PRECIO, UNA LISTA DE PROVEEDORES ──────────────────────────────────────────────────────
 * Todo el documento tiene la misma forma: un precio de título y debajo los proveedores que entran
 * a ese precio, uno por chip. Si el paquete entero va a un solo % hay un bloque; si adentro hay
 * varios, hay un bloque por cada uno —todos los de 15, todos los de 17,5— y no renglón por sello.
 *
 * El corte por sello era el corte de TBS, no el del cliente: una fila decía "Galaxsys, OneTouch,
 * 3 Oaks" porque esos tres se compran juntos, y el que la lee cuenta UN proveedor donde hay tres.
 * La bolsa interna no se le muestra a nadie de afuera; lo que se le muestra es cuántos proveedores
 * le estás dando y a qué precio.
 *
 * ── Y EL BARATO PRIMERO ──────────────────────────────────────────────────────────────────────
 * El orden lo pone `paraMostrar`: de menor a mayor precio de entrada. El Básico es lo que más se
 * vende —es barato y es la puerta— y va arriba, con el bloque destacado. Abajo del todo, lo caro.
 */
const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
/* 17.5 → "17,5%". El documento está en castellano y el decimal va con coma; el punto lo pone el
   motor, que escribe en inglés. */
const pct = (x) => String(x).replace(/\.0+$/, '').replace('.', ',') + '%';
const cuenta = (n) => `${n} ${n === 1 ? 'proveedor' : 'proveedores'}`;

const CSS = `
  :root{ --ink:#1e1a22; --ink2:#5b5262; --linea:#e6dfe8; --bg:#fff; --acento:#8a2f74; --suave:#faf6f9 }
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--ink);
    font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
  .hoja{max-width:820px;margin:0 auto;padding:44px 34px 70px}
  h1{font-size:27px;letter-spacing:-.01em;margin:0 0 4px}
  .para{font-size:17px;color:var(--acento);font-weight:600;margin:0 0 26px}
  .grupo{border-top:2px solid var(--ink);margin-top:26px;padding-top:12px;break-inside:avoid}
  .gcab{display:flex;align-items:baseline;justify-content:space-between;gap:14px;flex-wrap:wrap}
  .gnom{font-size:16px;font-weight:700;letter-spacing:.03em;text-transform:uppercase}
  .gpct{font-size:24px;font-weight:700;color:var(--acento);font-variant-numeric:tabular-nums}
  .gnota{font-size:12.5px;color:var(--ink2);font-variant-numeric:tabular-nums}
  .gsub{margin:3px 0 0;font-size:12.5px;color:var(--ink2)}
  /* La aclaración de los repetidos. Va arriba, antes del primer precio: si se lee después ya
     hiciste la pregunta que la nota contesta. */
  .aclara{margin:14px 0 0;padding:11px 14px;background:var(--suave);border:1px solid var(--linea);
    border-radius:9px;font-size:13px;color:var(--ink2)}
  .aclara b{color:var(--ink);font-weight:600}
  .provs{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px}
  .prov{background:var(--suave);border:1px solid var(--linea);border-radius:20px;
    padding:3px 11px;font-size:13px}
  /* ── UN BLOQUE POR PRECIO ──────────────────────────────────────────────────────────────────
     El % es el título y los proveedores van debajo. La línea de la izquierda ata visualmente el
     precio con su lista: sin ella, en Live —que tiene seis— no se ve dónde termina uno y empieza
     el que sigue. */
  .nivel{margin-top:14px;padding-left:13px;border-left:3px solid var(--linea);break-inside:avoid}
  .ncab{display:flex;align-items:baseline;gap:9px;flex-wrap:wrap}
  .npct{font-size:18px;font-weight:700;color:var(--acento);font-variant-numeric:tabular-nums}
  .ncuenta{font-size:12px;color:var(--ink2)}
  .nivel .provs{margin-top:7px}
  /* ── EL BÁSICO SE TIENE QUE VER ────────────────────────────────────────────────────────────
     Es el más barato, el que más entra y el primero de la hoja; con el mismo formato que los
     demás quedaba como el preámbulo de lo importante. Fondo propio y el número más grande de la
     página: se ve antes de leer nada. */
  .grupo.destacado{background:var(--suave);border:2px solid var(--ink);border-radius:12px;
    padding:16px 18px 18px;margin-top:22px}
  .grupo.destacado .gpct{font-size:34px}
  .grupo.destacado .prov{background:#fff}
  /* "Oferta base" va arriba y no sólo en Condiciones: si el cliente lee 8% y 15% creyendo que es
     el precio final, después cualquier conversación arranca desde ahí. La marca antes de los
     números; el detalle, abajo. */
  .base{margin:2px 0 0;font-size:13.5px;color:var(--ink2)}
  .base b{color:var(--acento);font-weight:600}
  .cond{margin-top:34px;border-top:2px solid var(--ink);padding-top:14px}
  .cond h2{font-size:13px;letter-spacing:.12em;text-transform:uppercase;margin:0 0 8px}
  .cond p{margin:0 0 6px;font-size:13.5px;color:var(--ink2)}
  /* Punteadas y no en párrafo corrido: son condiciones sueltas, cada una se acepta o se discute
     por separado, y en un bloque de texto la segunda se lee como aclaración de la primera. */
  .cond ul{margin:0;padding-left:19px}
  .cond li{margin:0 0 6px;font-size:13.5px;color:var(--ink2)}
  .pie{margin-top:22px;font-size:11.5px;color:var(--ink2);display:flex;gap:7px;align-items:flex-start}
  /* La disponibilidad no es una condición: es un aviso. Va chico y detrás de la (i), como todo lo
     que hay que decir pero no cambia lo que se firma. */
  .i{flex:0 0 auto;width:14px;height:14px;border-radius:50%;border:1px solid var(--ink2);
    font-size:10px;line-height:12px;text-align:center;font-style:italic;font-weight:700;
    margin-top:1px}
  /* La barra es para quien manda el documento, no para quien lo recibe: desaparece al imprimir
     y al guardar en PDF. */
  .barra{position:sticky;top:0;z-index:9;display:flex;gap:8px;justify-content:flex-end;
    padding:10px 14px;background:#fff;border-bottom:1px solid #e8e4ef}
  .barra button{font:inherit;font-size:13px;padding:7px 14px;border:1px solid #d6cfe4;
    border-radius:7px;background:#fff;cursor:pointer;color:#3b3350}
  .barra button:hover{background:#f6f3fb}
  .barra button:focus-visible{outline:2px solid #7c5cd6;outline-offset:2px}
  /* ── IMPRESO ES OTRO MEDIO ────────────────────────────────────────────────────────────────
     En pantalla se desplaza; en papel se paga por pliego. Con el interlineado de pantalla y los
     grupos sin poder partirse, 83 proveedores salían en CUATRO hojas — y una quedaba casi vacía,
     porque el grupo de Premium son 21 filas y si no entraba saltaba entero.
     Acá se aprieta el aire y se deja que los grupos se corten, pero NUNCA justo debajo de su
     título: un encabezado solo al pie de una hoja es peor que una hoja de más. */
  @media print{
    .hoja{padding:0}
    .barra{display:none}
    @page{margin:13mm}
    body{font-size:12px;line-height:1.4}
    h1{font-size:19px;margin-bottom:2px}
    .para{font-size:13.5px;margin-bottom:12px}
    .grupo{margin-top:13px;padding-top:7px;break-inside:auto}
    .gcab{break-after:avoid}
    .gnom{font-size:13px}
    .gpct{font-size:17px}
    .gnota,.gsub{font-size:11px}
    .aclara{font-size:10.5px;padding:7px 9px;margin-top:8px;break-inside:avoid}
    .base{font-size:11px}
    .provs{gap:4px;margin-top:6px}
    .prov{font-size:10.5px;padding:1.5px 8px;border-radius:12px}
    .grupo.destacado{padding:10px 12px 12px;margin-top:10px;border-radius:8px}
    .grupo.destacado .gpct{font-size:23px}
    .nivel{margin-top:8px;padding-left:9px}
    .ncab{break-after:avoid}
    .npct{font-size:13px}
    .ncuenta{font-size:10.5px}
    .nivel .provs{margin-top:4px}
    .cond{margin-top:16px;padding-top:9px}
    .cond p,.cond li{font-size:11px;margin-bottom:3px}
    .pie{margin-top:11px;font-size:10px}
  }
`;

/**
 * @param mostrar  lo que devuelve api-ofertas-store.paraMostrar — y NADA más
 */
const chips = (provs) => `<div class="provs">${
  provs.map((p) => `<span class="prov">${esc(p)}</span>`).join('')}</div>`;

function pagina(mostrar) {
  const grupos = (mostrar.grupos || []).map((g, idx) => {
    const niveles = g.niveles || [];
    const uno = niveles.length === 1;
    /* El primero es el más barato —`paraMostrar` los ordena así— y es el que más se vende. */
    const destacado = idx === 0 ? ' destacado' : '';

    const cab = `<div class="gcab"><span class="gnom">${esc(g.nombre)}</span>`
      + (uno
        ? `<span class="gpct">${esc(pct(niveles[0].pct))}</span>`
        : `<span class="gnota">de ${esc(pct(g.desde))} a ${esc(pct(g.hasta))}</span>`)
      + '</div>'
      /* Cuántos son. Es el dato que el cliente compara contra la oferta de al lado, y hasta ahora
         había que contar los chips a ojo. */
      + `<p class="gsub">${esc(cuenta((g.proveedores || []).length))}</p>`;

    // Un solo precio para todo el paquete: no hace falta repetirlo, alcanza la lista.
    if (uno) return `<div class="grupo${destacado}">${cab}${chips(niveles[0].proveedores)}</div>`;

    // Varios precios: un bloque por cada uno, de menor a mayor.
    return `<div class="grupo${destacado}">${cab}${niveles.map((n) => `<div class="nivel">
      <div class="ncab"><span class="npct">${esc(pct(n.pct))}</span>
        <span class="ncuenta">${esc(cuenta(n.proveedores.length))}</span></div>
      ${chips(n.proveedores)}</div>`).join('')}</div>`;
  }).join('');

  const cuantos = (mostrar.proveedores || []).length;

  /* Sólo si de verdad hay alguno repetido. Ver `_repetidos` en api-ofertas-store.js. */
  const rep = mostrar.repetidos || [];
  const aclaracion = rep.length ? `<p class="aclara"><b>Algunos proveedores figuran más de una
    vez.</b> Es porque llegan por integraciones distintas, o en más de una versión —una más
    completa y más cara que la otra—. Podés quedarte con la más barata, con la más completa o con
    las dos: se contratan por separado. ${rep.length === 1
      ? `Es el caso de ${esc(rep[0])}.`
      : `Es el caso de ${esc(rep.slice(0, -1).join(', '))} y ${esc(rep[rep.length - 1])}.`}</p>` : '';
  return `<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Oferta comercial${mostrar.titulo ? ' · ' + esc(mostrar.titulo) : ''}</title>
<style>${CSS}</style></head><body>
<div class="barra">
  <button onclick="descargar()">Descargar</button>
  <button onclick="window.print()">Imprimir o guardar en PDF</button>
</div>
<script>
/* Guarda esta misma página como archivo. Se arma con lo que ya está en pantalla, así que lo que se
   descarga es exactamente lo que se vio — sin volver a pedirle nada al servidor. */
function descargar(){
  var doc = '<!doctype html>' + document.documentElement.outerHTML;
  doc = doc.replace(/<div class="barra">[\\s\\S]*?<\\/div>/, '')
           .replace(/<script>[\\s\\S]*?<\\/script>/, '');
  var a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([doc], { type: 'text/html;charset=utf-8' }));
  a.download = (document.title || 'oferta').replace(/[^\\wáéíóúñ ·-]/gi, '') + '.html';
  document.body.appendChild(a); a.click();
  setTimeout(function(){ URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
</script>
<div class="hoja">
  <h1>Oferta comercial</h1>
  ${mostrar.titulo ? `<p class="para">${esc(mostrar.titulo)}</p>` : ''}
  <p style="color:var(--ink2);margin:0 0 6px">Porcentaje sobre el GGR de cada proveedor.
    ${cuantos} proveedores incluidos.</p>
  <p class="base"><b>Es una oferta base.</b> Los porcentajes se conversan y se acuerdan, y bajan a
    medida que crece el volumen.</p>
  ${aclaracion}
  ${grupos}
  <div class="cond"><h2>Condiciones</h2>
    <ul>
      <li>Los valores presentados son una oferta base: se conversan y se acuerdan antes de
        comenzar.</li>
      <li>Los porcentajes bajan a medida que crece el volumen de juego.</li>
      <li>El porcentaje se aplica sobre el GGR del período.</li>
      <li>La liquidación se realiza mensualmente.</li>
      ${mostrar.notas ? `<li>${esc(mostrar.notas)}</li>` : ''}
    </ul>
  </div>
  <p class="pie"><span class="i">i</span><span>La disponibilidad de cada proveedor puede variar
    según la divisa.</span></p>
</div></body></html>`;
}

module.exports = { pagina };
