/**
 * pago-proveedores-html.js — LA FACTURA DE PROVEEDORES COMO DOCUMENTO.
 *
 * La MISMA plata partida de cuatro formas: por proveedor, por etiqueta, por sistema y por divisa.
 * Es lo que el dueño venía recibiendo en una planilla, pero armado desde el cálculo del OS.
 *
 * ⚠️ ESTE DOCUMENTO ES INTERNO. Dice cuánto se le paga a cada proveedor y a qué costo — o sea, el
 * margen del negocio. No lleva token público como la cuenta de un cliente: se sirve detrás del
 * login y nada más. Si algún día hace falta mandárselo a alguien de afuera, hay que decidir ANTES
 * qué columnas se le muestran, igual que se hizo con la cuenta de TBS.
 *
 * ── POR QUÉ CADA VISTA ES UNA PÁGINA ─────────────────────────────────────────────────────────
 * Antes las cuatro tablas venían corridas una atrás de otra y en papel quedaban partidas por la
 * mitad: el título de una sección al pie de una hoja y sus números en la siguiente. Cada vista
 * arranca ahora en página nueva y empieza por su RESUMEN — quien lee la hoja quiere primero el
 * número grande y después el detalle, no al revés. En pantalla se ve igual, sólo que separado.
 *
 * El cuadre va arriba de todo y no al final: las cuatro vistas tienen que dar el mismo total, y si
 * no dan, eso hay que verlo antes de leer un solo número, no después de firmar el pago.
 */
const { MESES_ES } = require('./lib/fechas');

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const n = (x, d = 2) => Number(x || 0).toLocaleString('es-AR', { minimumFractionDigits: d, maximumFractionDigits: d });
const alfa = (a, b) => String(a).localeCompare(String(b), 'es', { sensitivity: 'base' });

const CSS = `
  body{font:13px/1.55 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;padding:26px;color:#2b2230;
       max-width:1000px;margin:auto;background:#fff}
  h1{font-size:22px;margin:0 0 2px}

  /* ── EL TÍTULO DE SECCIÓN ES LA MARCA DE QUE EMPEZÓ OTRA HOJA ───────────────────────────────
     Antes era un renglón gris en mayúsculas chiquitas y se perdía entre las tablas. Ahora pesa:
     hoja nueva, número de orden, y una regla debajo que lo separa de los datos. */
  .pg{page-break-before:always;margin-top:34px}
  .pg:first-of-type{page-break-before:auto}
  .pg-h{border-bottom:2px solid #2b2230;padding-bottom:7px;margin-bottom:2px;
        display:flex;align-items:baseline;gap:10px}
  .pg-h b{font-size:19px;letter-spacing:-.01em}
  .pg-h .num{font-size:11px;font-weight:800;color:#fff;background:#8a4d80;
             border-radius:4px;padding:2px 7px;letter-spacing:.06em}
  .pg-h .cnt{margin-left:auto;font-size:11px;color:#8c7e89;white-space:nowrap}
  .pg-sub{font-size:11.5px;color:#8c7e89;margin:7px 0 13px}

  /* ── EL RESUMEN DE CADA SECCIÓN, ANTES DE LOS DATOS ─────────────────────────────────────────
     Cuatro o cinco cajas con lo que hay que saber sin leer la tabla. */
  .sum{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 14px}
  .sum div{flex:1 1 130px;background:#faf4f9;border:1px solid #f0e2ee;border-radius:7px;padding:8px 11px}
  .sum .k{font-size:9.5px;text-transform:uppercase;letter-spacing:.05em;color:#8c7e89;white-space:nowrap}
  .sum .v{font-size:16px;font-weight:800;margin-top:1px;white-space:nowrap}
  .sum .v small{font-size:11px;font-weight:600;color:#8c7e89}

  table{width:100%;border-collapse:collapse;margin-bottom:4px}
  th{text-align:left;font-size:10px;text-transform:uppercase;color:#8c7e89;
     border-bottom:1px solid #ead6e6;padding:6px 8px;white-space:nowrap}
  td{padding:5px 8px;border-bottom:1px solid #f3e9f1;vertical-align:top}
  tr:last-child td{border-bottom:none}
  .r{text-align:right;white-space:nowrap}
  .mut{color:#8c7e89;font-size:11px}
  .z{color:#c9bcc6}
  tfoot td{font-weight:800;border-top:2px solid #ead6e6}
  .tot{margin:16px 0 4px;padding:15px 17px;background:#f6e9f4;border-radius:9px}
  .tot .k{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:#7a5d74}
  .tot .v{font-size:29px;font-weight:800;letter-spacing:-.02em;line-height:1.1}
  .porsis{display:flex;flex-wrap:wrap;gap:8px;margin:10px 0 0}
  .porsis div{flex:1 1 150px;background:#fff;border:1px solid #ead6e6;border-radius:7px;padding:9px 12px}
  .porsis .k{font-size:10px;text-transform:uppercase;letter-spacing:.05em;color:#8c7e89}
  .porsis .v{font-size:18px;font-weight:800;margin-top:1px}
  .cua{padding:9px 12px;border-radius:7px;margin:14px 0;font-size:12px}
  .cua.ok{background:#eaf5ec;border-left:3px solid #2ea043}
  .cua.mal{background:#fdeceb;border-left:3px solid #d9534f}
  .cua.avi{background:#fdf4e6;border-left:3px solid #c88a2e}
  .nota{font-size:11px;color:#8c7e89;margin:6px 0 0}
  .pie{margin-top:26px;font-size:11px;color:#8c7e89;border-top:1px solid #f3e9f1;padding-top:10px}
  button{padding:9px 15px;font:inherit;border:1px solid #ead6e6;background:#fff;border-radius:7px;cursor:pointer}

  @media print{
    button{display:none} body{padding:0;max-width:none}
    /* Los fondos del cuadre, del total y de los resúmenes tienen que salir impresos: son lo que
       distingue "esto cuadra" de "esto no cuadra" en una hoja donde no hay nada más que mire. */
    .cua,.tot,.sum div,.pg-h .num{-webkit-print-color-adjust:exact;print-color-adjust:exact}
    /* El encabezado de la tabla se repite en cada hoja: una tabla de 95 filas ocupa tres páginas y
       en la segunda ya nadie se acuerda de qué columna era cuál. */
    thead{display:table-header-group} tfoot{display:table-footer-group}
    tr{page-break-inside:avoid}
    .pg-h,.sum{page-break-after:avoid} .pg-sub{page-break-after:avoid}
    @page{margin:14mm 12mm}
  }
`;

/** Una caja del resumen. */
const box = (k, v, sub) => `<div><div class="k">${esc(k)}</div><div class="v">${v}${sub ? ` <small>${esc(sub)}</small>` : ''}</div></div>`;

/** El encabezado de una sección: número de hoja, título, y a la derecha el conteo. */
const cab = (num, titulo, cnt, sub) => `<div class="pg"><div class="pg-h">`
  + `<span class="num">HOJA ${num}</span><b>${esc(titulo)}</b>`
  + (cnt ? `<span class="cnt">${esc(cnt)}</span>` : '') + '</div>'
  + (sub ? `<div class="pg-sub">${sub}</div>` : '');

/** @param {object} rep  lo que devuelve pago-proveedores.reporte() */
function hoja(rep) {
  if (!rep || !rep.ok) return `<!doctype html><meta charset="utf-8"><title>Pago a proveedores</title>
    <style>${CSS}</style><h1>No se pudo armar la hoja</h1>
    <div class="mut">${esc((rep && rep.error) || 'sin datos')}</div>`;

  const [y, mm] = String(rep.mes || '').split('-');
  const mesNom = MESES_ES[Number(mm) - 1] ? `${MESES_ES[Number(mm) - 1]} ${y}` : String(rep.mes);
  const c = rep.cuadre || {};
  const conex = Object.entries(rep.porConexion || {}).sort((a, b) => Number(b[1].usdt) - Number(a[1].usdt));

  // ── ALFABÉTICO, NO POR MONTO ─────────────────────────────────────────────────────────────────
  // El reporte viene ordenado de mayor a menor, que sirve para mirar dónde está la plata. Pero esta
  // hoja se concilia contra la del proveedor, y para eso hay que poder ir a buscar un renglón:
  // alfabético se encuentra, por monto hay que barrer la columna entera.
  const porClave = (a, b) => alfa(a.clave, b.clave);
  const etiq = [...(rep.porEtiqueta || [])].sort(porClave);
  const divs = [...(rep.porDivisa || [])].sort(porClave);
  const sis = [...(rep.porSistema || [])].sort((a, b) => Number(b.usdt) - Number(a.usdt));
  const provs = [...(rep.proveedores || [])].sort((a, b) => alfa(a.proveedor, b.proveedor));
  const otros = rep.otros || [];
  const oTot = rep.otrosTotal || { gananciaUsdt: '0', cuantos: 0 };
  const sc = rep.sinCostoDetalle || [];
  const scR = rep.sinCostoResumen || { cuantos: 0, revisar: 0, familias: [] };
  const hayHoja6 = !!(otros.length || sc.length);

  // Los nombres de sistema en el orden en que se muestran, para las columnas de la tabla cruzada.
  const sistemas = sis.map((s) => s.clave);
  const mayor = (arr) => (arr.length ? [...arr].sort((a, b) => Number(b.usdt) - Number(a.usdt))[0] : null);

  const cuadre = c.cuadra
    ? `<div class="cua ok"><b>Cuadra.</b> Las cuatro vistas de este documento —por proveedor, por
       etiqueta, por sistema y por divisa— dan ${n(c.proveedores)} USDT.
       ${c.etiquetasDeducidas ? `<span class="mut">· ${c.etiquetasDeducidas} línea(s) con la etiqueta deducida del nombre.</span>` : ''}</div>`
    : `<div class="cua mal"><b>NO cuadra.</b> Por proveedor ${n(c.proveedores)} · por etiqueta ${n(c.etiquetas)}
       · por sistema ${n(c.sistemas)} · por divisa ${n(c.divisas)}. Es un error de cálculo: no pagar con esta hoja.</div>`;

  // ── HOJA 1 · RESUMEN ─────────────────────────────────────────────────────────────────────────
  // Lo primero es el número que se va a pagar y de dónde sale. Después, en una línea por vista, qué
  // va a encontrar en las hojas siguientes: así se sabe si hace falta darlas vuelta o no.
  const portada = `<h1>Pago a proveedores</h1>
    <div class="mut">${esc(mesNom)}${rep.congelado ? ' · precios congelados de ese mes' : ' · precios de hoy (mes sin congelar)'}</div>
    <div class="tot"><div class="k">Total a pagar</div><div class="v">${n(c.proveedores)} USDT</div>
      <div class="porsis">${conex.map(([k, v]) => `<div><div class="k">${esc(k)}</div>`
        + `<div class="v">${n(v.usdt)}</div>`
        + `<div class="mut">${v.filas} línea(s)</div></div>`).join('')}</div></div>
    ${cuadre}
    <div class="pg-sub" style="margin-top:18px"><b style="color:#2b2230;font-size:13px">Qué hay en este documento</b></div>
    <table>
      <thead><tr><th>Hoja</th><th>Corta la plata por</th><th class="r">Renglones</th><th class="r">Total USDT</th></tr></thead>
      <tbody>
        <tr><td><b>2</b></td><td>Proveedor <span class="mut">— para conciliar contra la hoja de cada uno</span></td>
          <td class="r mut">${provs.length}</td><td class="r"><b>${n(c.proveedores)}</b></td></tr>
        <tr><td><b>3</b></td><td>Etiqueta <span class="mut">— los grupos con los que pagás (SL2, OP, SZ…)</span></td>
          <td class="r mut">${etiq.length}</td><td class="r"><b>${n(c.etiquetas)}</b></td></tr>
        <tr><td><b>4</b></td><td>Sistema <span class="mut">— cuánto pesa cada proveedor en cada panel</span></td>
          <td class="r mut">${sis.length}</td><td class="r"><b>${n(c.sistemas)}</b></td></tr>
        <tr><td><b>5</b></td><td>Divisa <span class="mut">— y con qué tipo de cambio se pasó a dólares</span></td>
          <td class="r mut">${divs.length}</td><td class="r"><b>${n(c.divisas)}</b></td></tr>
        ${hayHoja6 ? `<tr><td><b>6</b></td><td>Otros <span class="mut">— con ganancia, pero sin el dato para poder pagarlo</span></td>
          <td class="r mut">${otros.length + sc.length}</td><td class="r mut">no entra al total</td></tr>` : ''}
      </tbody>
    </table>
    ${otros.length ? `<div class="cua avi"><b>${otros.length} concepto(s) sin equivalencia en la matriz</b>
      — el casino o TBS informan ganancia por ellos (${n(oTot.gananciaUsdt)} USDT) pero no se sabe a qué
      proveedor corresponden, así que no se puede saber cuánto se paga. Están en la hoja 6, con el motivo
      de cada uno.</div>` : ''}
    ${scR.revisar ? `<div class="cua avi"><b>${scR.revisar} fila(s) de la matriz sin % de costo, para revisar</b>
      — el resto de las que faltan son de las familias que cuestan 0, pero éstas no. Están al pie de la
      hoja 6, marcadas.</div>` : ''}
    ${(rep.avisos || []).length ? `<div class="pg-sub" style="margin-top:16px"><b style="color:#2b2230;font-size:13px">Avisos</b></div>`
      + `<table><tbody>${rep.avisos.map((a) => `<tr><td class="mut">${esc(a)}</td></tr>`).join('')}</tbody></table>` : ''}`;

  // ── HOJA 2 · POR PROVEEDOR ───────────────────────────────────────────────────────────────────
  const mayorProv = mayor(provs.map((p) => ({ clave: p.proveedor, usdt: p.usdt })));
  const tProv = cab(2, 'Por proveedor', `${provs.length} proveedores`,
    'Cada proveedor con su etiqueta y el % de costo que se le aplica. Es la vista que se concilia '
    + 'renglón por renglón contra la liquidación que manda cada uno.')
    + `<div class="sum">
        ${box('Total a pagar', `${n(c.proveedores)} USDT`)}
        ${box('Proveedores', String(provs.length))}
        ${box('El más grande', mayorProv ? esc(mayorProv.clave) : '—', mayorProv ? `${n(mayorProv.usdt)} USDT` : '')}
        ${box('Promedio', `${n(provs.length ? Number(c.proveedores) / provs.length : 0)} USDT`)}
      </div>
      <table>
      <thead><tr><th>Proveedor</th><th>Etiqueta</th><th>Sistemas</th><th class="r">Costo</th><th class="r">USDT</th></tr></thead>
      <tbody>${provs.map((p) => {
    const es = [...new Set((p.lineas || []).map((l) => l.etiqueta).filter(Boolean))];
    const cx = [...new Set((p.lineas || []).map((l) => l.conexion))].sort(alfa);
    return `<tr><td>${esc(p.proveedor)}</td><td class="mut">${esc(es.join(', '))}</td>
      <td class="mut">${esc(cx.join(', '))}</td>
      <td class="r mut">${esc(p.costo)}%</td><td class="r"><b>${n(p.usdt)}</b></td></tr>`;
  }).join('')}</tbody>
      <tfoot><tr><td>Total</td><td></td><td></td><td></td><td class="r">${n(c.proveedores)}</td></tr></tfoot></table></div>`;

  // ── HOJA 3 · POR ETIQUETA ────────────────────────────────────────────────────────────────────
  const mayorEt = mayor(etiq);
  const tEtiq = cab(3, 'Por etiqueta', `${etiq.length} etiquetas`,
    'Los grupos con los que se paga de verdad. Una etiqueta puede juntar varios proveedores: al pie '
    + 'de esta hoja está el detalle de qué incluye cada una.')
    + `<div class="sum">
        ${box('Total a pagar', `${n(c.etiquetas)} USDT`)}
        ${box('Etiquetas', String(etiq.length))}
        ${box('La más grande', mayorEt ? esc(mayorEt.clave) : '—', mayorEt ? `${n(mayorEt.usdt)} USDT` : '')}
        ${box('Las 3 primeras', `${n([...etiq].sort((a, b) => Number(b.usdt) - Number(a.usdt)).slice(0, 3)
          .reduce((t, e) => t + Number(e.usdt), 0))} USDT`,
    `de ${n(c.etiquetas)}`)}
      </div>
      <table>
      <thead><tr><th>Etiqueta</th><th class="r">Proveedores</th><th>Divisas</th><th class="r">USDT</th></tr></thead>
      <tbody>${etiq.map((e) => `<tr><td><b>${esc(e.clave)}</b></td>
      <td class="r mut">${(e.proveedores || []).length}</td>
      <td class="mut">${esc((e.divisas || []).join(', '))}</td>
      <td class="r"><b>${n(e.usdt)}</b></td></tr>`).join('')}</tbody>
      <tfoot><tr><td>Total</td><td></td><td></td><td class="r">${n(c.etiquetas)}</td></tr></tfoot></table>
      <div class="pg-sub" style="margin-top:20px"><b style="color:#2b2230;font-size:13px">Qué incluye cada etiqueta</b></div>
      <table>
      <thead><tr><th style="width:120px">Etiqueta</th><th>Proveedores</th></tr></thead>
      <tbody>${etiq.map((e) => `<tr><td><b>${esc(e.clave)}</b></td>
      <td class="mut">${esc([...(e.proveedores || [])].sort(alfa).join(' · '))}</td></tr>`).join('')}</tbody></table></div>`;

  // ── HOJA 4 · POR SISTEMA ─────────────────────────────────────────────────────────────────────
  //
  // Tabla cruzada y no una página por sistema: la pregunta que se hace acá es "¿cuánto de este
  // proveedor va por cada panel?", y con una página por sistema hay que ir y volver entre hojas
  // para responderla. Cruzada se lee de un renglón. Son 95 filas y 3 columnas: entra.
  const usdtDe = (p, s) => (p.lineas || []).filter((l) => l.conexion === s)
    .reduce((t, l) => t + Number(l.usdt), 0);
  const tSis = cab(4, 'Por sistema', `${sis.length} sistemas · ${provs.length} proveedores`,
    'La misma plata abierta por panel. La primera columna de números es el total del proveedor; las '
    + 'que siguen dicen por dónde se generó.')
    + `<div class="sum">
        ${box('Total a pagar', `${n(c.sistemas)} USDT`)}
        ${sis.map((s) => box(s.clave, `${n(s.usdt)} USDT`,
    `${Math.round((Number(s.usdt) / (Number(c.sistemas) || 1)) * 100)}% · ${(s.proveedores || []).length} prov.`)).join('')}
      </div>
      <table>
      <thead><tr><th>Proveedor</th><th>Etiqueta</th><th class="r">Total</th>
        ${sistemas.map((s) => `<th class="r">${esc(s)}</th>`).join('')}</tr></thead>
      <tbody>${provs.map((p) => {
    const es = [...new Set((p.lineas || []).map((l) => l.etiqueta).filter(Boolean))];
    return `<tr><td>${esc(p.proveedor)}</td><td class="mut">${esc(es.join(', '))}</td>
      <td class="r"><b>${n(p.usdt)}</b></td>
      ${sistemas.map((s) => { const v = usdtDe(p, s); return `<td class="r${v ? '' : ' z'}">${v ? n(v) : '—'}</td>`; }).join('')}</tr>`;
  }).join('')}</tbody>
      <tfoot><tr><td>Total</td><td></td><td class="r">${n(c.sistemas)}</td>
        ${sis.map((s) => `<td class="r">${n(s.usdt)}</td>`).join('')}</tr></tfoot></table></div>`;

  // ── HOJA 5 · POR DIVISA ──────────────────────────────────────────────────────────────────────
  const mayorDiv = mayor(divs);
  const tDiv = cab(5, 'Por divisa', `${divs.length} divisas`,
    'Cuánto se movió en cada moneda y con qué tipo de cambio se pasó a dólares. La diferencia contra '
    + 'la liquidación de un proveedor casi siempre está acá.')
    + `<div class="sum">
        ${box('Total a pagar', `${n(c.divisas)} USDT`)}
        ${box('Divisas', String(divs.length))}
        ${box('La más grande', mayorDiv ? esc(mayorDiv.clave) : '—', mayorDiv ? `${n(mayorDiv.usdt)} USDT` : '')}
        ${box('Con más de un TC', String(divs.filter((d) => !d.tc).length), 'SL2 y BVS van aparte')}
      </div>
      <table>
      <thead><tr><th>Divisa</th><th class="r">Movido en la moneda</th><th class="r">Tipo de cambio</th>
        <th class="r">USDT</th></tr></thead>
      <tbody>${divs.map((d) => `<tr><td><b>${esc(d.clave)}</b></td>
      <td class="r mut">${n(d.montoLocal)}</td>
      <td class="r mut">${d.tc ? esc(d.tc) : esc((d.tcs || []).join(' / '))}</td>
      <td class="r"><b>${n(d.usdt)}</b></td></tr>`).join('')}</tbody>
      <tfoot><tr><td>Total</td><td></td><td></td><td class="r">${n(c.divisas)}</td></tr></tfoot></table>
      ${divs.some((d) => !d.tc)
    ? '<div class="nota">Donde hay dos tipos de cambio: SL2 y BVS se pasan a dólares con el promedio '
        + 'del mes y el resto con el del proveedor. No es un error, son dos acuerdos distintos — el '
        + 'detalle de cuál se usó para qué está en el pie del documento.</div>' : ''}</div>`;

  // ── HOJA 6 · OTROS ───────────────────────────────────────────────────────────────────────────
  //
  // Dos bloques, y la separación importa. Arriba lo que NO SE SABE QUIÉN ES: son pocos y cada uno
  // es una pregunta concreta que se puede responder. Abajo las filas de la matriz sin % cargado,
  // que es otra cosa — ahí el proveedor se sabe, falta el número, y casi todas son familias que
  // cuestan 0. Juntarlas tapaba a las primeras: PRAGMATIC SL sola tiene 2,25 millones de ganancia.
  //
  // La columna de dólares dice GANANCIA y no "a pagar" a propósito: son dos números que se parecen
  // y no lo son. Lo que se paga es la ganancia por el % de costo, y el % es justo lo que falta.
  const tOtros = !hayHoja6 ? '' : cab(6, 'Otros', `${otros.length + sc.length} conceptos`,
    'Todo lo que tiene ganancia y <b>no entra al total a pagar</b>. No entra porque falta el dato con '
    + 'el que se calcula —a qué proveedor corresponde, o con qué % de costo— y ponerle un porcentaje '
    + 'inventado sería inventar plata.')
    + (!otros.length ? '' : `<div class="sum">
        ${box('Sin equivalencia', String(otros.length), 'no se sabe quién es')}
        ${box('Ganancia', `${n(oTot.gananciaUsdt)} USDT`, 'no es lo que se paga')}
        ${box('El más grande', esc(otros[0] ? otros[0].nombre : '—'), otros[0] ? `${n(otros[0].gananciaUsdt)} USDT` : '')}
        ${box('Se resuelve', 'diciendo qué fila es', 'y con qué % de costo')}
      </div>
      <table>
      <thead><tr><th>Concepto</th><th>Origen</th><th>Ganancia por divisa</th>
        <th>Por qué no se paga</th><th class="r">Ganancia USDT</th></tr></thead>
      <tbody>${otros.map((o) => `<tr>
        <td><b>${esc(o.nombre)}</b>${o.ref ? ` <span class="mut">${esc(o.ref)}</span>` : ''}</td>
        <td class="mut">${esc(o.origen)}</td>
        <td class="mut">${Object.entries(o.porDivisa || {}).sort((a, b) => alfa(a[0], b[0]))
    .map(([d, v]) => `${esc(d)} ${n(v)}`).join(' · ')}</td>
        <td class="mut">${esc(o.motivo)}${(o.faltanTC || []).length ? ` <i>(sin TC para ${esc(o.faltanTC.join(', '))})</i>` : ''}</td>
        <td class="r">${n(o.gananciaUsdt)}</td></tr>`).join('')}</tbody>
      <tfoot><tr><td>Ganancia total</td><td></td><td></td><td></td><td class="r">${n(oTot.gananciaUsdt)}</td></tr></tfoot></table>
      <div class="nota">Para que uno de estos pase a pagarse hace falta una sola cosa: decir a qué
      fila de la matriz corresponde y con qué % de costo. A partir de ahí entra solo.</div>`)
    + (!sc.length ? '' : `<div class="pg-sub" style="margin-top:22px">
        <b style="color:#2b2230;font-size:13px">Filas de la matriz sin % de costo cargado</b></div>
      <div class="pg-sub" style="margin-top:-6px">Acá el proveedor se sabe: lo que falta es el
        porcentaje. Las familias <b>${esc(scR.familias.filter((f) => f.cuestaCero).map((f) => f.familia).join(' y ') || '—')}</b>
        cuestan 0, así que si es eso no se debe nada y no hay nada que hacer.
        ${scR.revisar ? `<b>Las ${scR.revisar} marcadas para revisar no son de esas familias</b> y sí pueden
        ser plata que no se está pagando.` : 'Ninguna queda fuera de esas familias.'}</div>
      <div class="sum">
        ${box('Filas sin costo', String(scR.cuantos))}
        ${scR.familias.slice(0, 3).map((f) => box(`Familia ${f.familia}`, String(f.cuantos),
    f.cuestaCero ? 'cuesta 0' : 'revisar')).join('')}
        ${box('A revisar', String(scR.revisar), 'fuera de las familias que cuestan 0')}
      </div>
      <table>
      <thead><tr><th></th><th>Proveedor</th><th>Panel</th><th>Ganancia por divisa</th>
        <th class="r">Ganancia USDT</th></tr></thead>
      <tbody>${sc.map((o) => `<tr>
        <td>${o.revisar ? '<b style="color:#c0392b">revisar</b>' : ''}</td>
        <td>${o.revisar ? `<b>${esc(o.nombre)}</b>` : esc(o.nombre)}</td>
        <td class="mut">${esc(o.origen)}</td>
        <td class="mut">${Object.entries(o.porDivisa || {}).sort((a, b) => alfa(a[0], b[0]))
    .map(([d, v]) => `${esc(d)} ${n(v)}`).join(' · ')}</td>
        <td class="r${o.revisar ? '' : ' mut'}">${n(o.gananciaUsdt)}</td></tr>`).join('')}</tbody></table>`)
    + '</div>';

  // ── EL PIE: LOS TIPOS DE CAMBIO USADOS ───────────────────────────────────────────────────────
  //
  // Va al pie del documento y no en cada hoja porque es una tabla, no un renglón — repetirla abajo
  // de cada página se comería media hoja. Estando escrita, la discusión típica con un proveedor
  // ("a mí me da otra cosa") pasa de ser una investigación a comparar una línea.
  const tcs = rep.tiposDeCambio || [];
  const pieTC = !tcs.length ? '' : `<div class="pg"><div class="pg-h">
      <span class="num">PIE</span><b>Tipos de cambio usados</b>
      <span class="cnt">${tcs.length} divisas</span></div>
    <div class="pg-sub">Con estos valores se pasó cada monto a dólares. Una divisa con dos filas no
      es un error: <b>SL2 y BVS</b> se convierten con el <b>promedio del mes</b> y el resto con el
      <b>tipo de cambio del proveedor</b> — son dos acuerdos distintos.</div>
    <table>
      <thead><tr><th>Divisa</th><th class="r">TC</th><th class="r">Monto en la moneda</th>
        <th class="r">USDT</th><th>Se aplicó a</th></tr></thead>
      <tbody>${tcs.map((d) => d.tcs.map((t, i) => `<tr>
        <td>${i === 0 ? `<b>${esc(d.divisa)}</b>` : ''}</td>
        <td class="r"><b>${esc(t.tc)}</b></td>
        <td class="r mut">${n(t.montoLocal)}</td>
        <td class="r">${n(t.usdt)}</td>
        <td class="mut">${d.tcs.length === 1 ? `los ${t.cuantos} proveedores de esta divisa`
    : `${t.cuantos}: ${esc(t.proveedores.slice(0, 6).join(', '))}${t.proveedores.length > 6 ? ` y ${t.proveedores.length - 6} más` : ''}`}</td>
      </tr>`).join('')).join('')}</tbody></table></div>`;

  return `<!doctype html><html lang="es"><head><meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <meta name="robots" content="noindex,nofollow">
    <title>Pago a proveedores — ${esc(mesNom)}</title><style>${CSS}</style></head><body>
    ${portada}${tProv}${tEtiq}${tSis}${tDiv}${tOtros}${pieTC}
    <button onclick="window.print()">Guardar como PDF</button>
    <div class="pie">Latam Games · documento interno · ${esc(mesNom)}</div>
    </body></html>`;
}

module.exports = { hoja };
