/**
 * factura-html.js — la página que abre el CLIENTE con el link.
 *
 * Es lo único de este sistema que ve alguien de afuera, así que:
 *   · se explica sola (nadie le va a enseñar a usarla),
 *   · no expone nada que no sea suyo — se arma con la foto guardada de SU factura y nada más,
 *   · no tiene ni un botón que haga algo: se mira y se imprime.
 *
 * El HTML va en un solo archivo, sin nada externo: tiene que abrir en cualquier teléfono aunque
 * esté con mala señal.
 */
const money = require('./lib/money');

const esc = (x) => String(x == null ? '' : x)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const $ = (x) => money.fmt(x, 2);

function pagina({ factura: f0, actualizado_at, token }) {
  /* Los links ya mandados guardan la foto vieja, sin el USDT de cada panel: se deriva del TC de la
     propia factura para que un link viejo no salga con la columna en «sin TC». */
  const f = require('./factura.service').conUsdtPorPanel(f0);
  /* Una moneda sin tipo de cambio NO entra en el total, y el renglón lo decía con un guioncito.
     Para el cliente eso se lee como "cero" o como un detalle de formato; en realidad es plata
     suya que este total NO incluye, y tiene que poder verlo sin preguntar. */
  const faltanDiv = (f.consumo && f.consumo.porDivisa || []).filter((d) => !d.tc);
  const filaDiv = (f.consumo && f.consumo.porDivisa || [])
    .map((d) => d.tc
      ? `<tr><td>${esc(d.divisa)}</td><td class="r">${$(d.vendido)}</td><td class="r m">TC ${$(d.tc)}</td><td class="r">${d.vendidoUsdt != null ? $(d.vendidoUsdt) + ' USDT' : '—'}</td></tr>`
      : `<tr><td>${esc(d.divisa)}</td><td class="r">${$(d.vendido)}</td>
         <td class="r m" colspan="2" style="color:#b3261e">no incluido en este total</td></tr>`)
    .join('');

  // La comisión de cada moneda. Sólo cuando hay más de una: con una sola repetiría el renglón de
  // arriba. Los USDT de la derecha suman el total — es la cuenta que el cliente puede rehacer.
  const cpd = (f.consumo && f.consumo.comisionPorDivisa) || [];
  const comDiv = cpd.length > 1
    ? '<table class="sub"><thead><tr><th>Comisión por moneda</th><th class="r">Monto</th><th class="r">En USDT</th></tr></thead><tbody>'
      + cpd.map((c) => `<tr><td>${esc(c.divisa)}</td><td class="r">${$(c.monto)}</td><td class="r">${c.usdt != null ? $(c.usdt) + ' USDT' : '—'}</td></tr>`).join('')
      + `<tr class="tot"><td></td><td class="r m">total</td><td class="r"><b>${$(f.consumo.total_usdt)} USDT</b></td></tr>`
      + '</tbody></table>'
    : '';

  /* CADA PANEL TAMBIÉN EN USDT: «cash365.vip · ARS · 162.511.765» al lado de «Ahora463.com ·
     UYU · 26.302» son dos números que no se comparan ni se suman, así que no se ve cuánto pesa
     cada panel. Un panel que movió en dos monedas lleva su total sumado en una línea aparte. */
  const veces = {}; (f.porPanel || []).forEach((p) => { veces[p.panel] = (veces[p.panel] || 0) + 1; });
  const gruposP = {}; (f.porPanel || []).forEach((p) => { (gruposP[p.panel] = gruposP[p.panel] || []).push(p); });
  const totP = (ps, c) => ps.reduce((a, p) => money.add(a, String(p[c] || 0)), '0');
  const hayPaga = (f.porPanel || []).some((p) => p.paga != null);
  const porPanel = Object.keys(gruposP)
    .sort((a, b) => Number(totP(gruposP[b], 'usdt')) - Number(totP(gruposP[a], 'usdt')))
    .map((nom) => gruposP[nom]
      .map((p) => `<tr><td>${esc(p.panel)}</td><td>${esc(p.divisa)}</td><td class="r">${p.cargas}</td>`
        + `<td class="r">${$(p.monto)}</td><td class="r m">${p.tc ? $(p.tc) : '—'}</td>`
        + `<td class="r m">${p.usdt != null ? $(p.usdt) : 'sin TC'}</td>`
        + (hayPaga ? `<td class="r">${p.paga != null ? `<b>${$(p.paga)}</b>` : '<span class="m">—</span>'}</td>` : '')
        + '</tr>').join('')
      + (veces[nom] > 1
        ? `<tr><td colspan="5" class="r m">Total ${esc(nom)}</td><td class="r m">${$(totP(gruposP[nom], 'usdt'))}</td>`
          + (hayPaga ? `<td class="r"><b>${$(totP(gruposP[nom], 'paga'))}</b></td>` : '') + '</tr>'
        : ''))
    .join('');
  const porPanelTotal = totP(f.porPanel || [], 'usdt');
  const porPanelPaga = totP(f.porPanel || [], 'paga');
  const porPanelSinTC = (f.porPanel || []).filter((p) => p.usdt == null);

  // El detalle ya viene ordenado por panel y numerado dentro de cada uno: se respeta ese orden,
  // que es como el cliente audita.
  let detalle = ''; let panelActual = null;
  (f.detalle || []).forEach((d) => {
    const k = `${d.panel}|${d.divisa}`;
    if (k !== panelActual) {
      panelActual = k;
      const p = (f.porPanel || []).find((x) => `${x.panel}|${x.divisa}` === k);
      if (detalle) detalle += '</tbody></table>';
      detalle += `<h3>${esc(d.panel)} <span class="m">(${esc(d.divisa)})${p ? ` · ${p.cargas} carga(s) · ${$(p.monto)}` : ''}</span></h3>`
        + '<table><thead><tr><th>#</th><th>Fecha</th><th>Hora</th><th class="r">Monto</th></tr></thead><tbody>';
    }
    detalle += `<tr${d.anulando ? ' class="anul"' : ''}><td class="m">${d.n || ''}</td><td>${esc(d.fecha)}</td><td class="m">${esc(d.hora)}</td>`
      + `<td class="r">${$(String(d.monto))}${d.anulando ? ' <span class="m">(en anulación)</span>' : ''}</td></tr>`;
  });
  if (detalle) detalle += '</tbody></table>';

  const ext = f.externos;
  // El desglose va POR PANEL, igual que las cargas: el cliente audita panel por panel. Cada bloque
  // lleva su moneda y su tipo de cambio, porque el TC es uno por moneda y sin él el USDT no se
  // puede verificar contra nada.
  let extTablas = '';
  const filaProv = (i) => `<tr><td>${esc(i.proveedor)}</td><td class="m">${esc(i.divisa || '—')}</td>`
    + `<td class="r">${i.profit ? $(i.profit) : '—'}</td>`
    + `<td class="r"><b>${esc(i.excedente)}%</b></td>`
    + `<td class="r">${i.monto ? $(i.monto) : '—'}</td><td class="r">${$(i.usdt)}</td></tr>`;
  const cabezaProv = '<thead><tr><th>Proveedor</th><th>Divisa</th><th class="r">Ganancia</th><th class="r">Excedente</th><th class="r">A cobrar</th><th class="r">USDT</th></tr></thead>';

  if (ext && ext.porPanel && ext.porPanel.length) {
    /* UN bloque por PANEL, no uno por panel+moneda. El motor los corta por las dos cosas, así que
       un panel que movió en dos monedas salía dos veces —`Ahora463.com` en ARS y otra vez en UYU—
       separados por media pantalla, como si fueran dos cuentas. Se juntan y la moneda pasa a ser
       una COLUMNA: los USDT de las dos filas sí se suman, que es lo que hay que ver. */
    const juntos = {};
    ext.porPanel.forEach((p) => {
      const g = juntos[p.panel] || (juntos[p.panel] = { panel: p.panel, items: [], usdt: '0', tcs: [] });
      (p.items || []).forEach((i) => g.items.push({ ...i, divisa: i.divisa || p.divisa }));
      g.usdt = money.add(g.usdt, String(p.usdt || 0));
      if (p.tc) g.tcs.push(`${esc(p.divisa)} ${$(p.tc)}`);
    });
    extTablas = Object.values(juntos)
      .sort((a, b) => Number(b.usdt) - Number(a.usdt))
      .map((g) => {
        const items = g.items.slice().sort((a, b) => Number(b.usdt) - Number(a.usdt));
        return `<h3>${esc(g.panel)} <span class="m">· ${items.length} proveedor(es)`
          + `${g.tcs.length ? ` · tipo de cambio ${g.tcs.join(' · ')}` : ' · sin tipo de cambio cargado'}</span></h3>
       <div class="scroll"><table>${cabezaProv}
        <tbody>${items.map(filaProv).join('')}</tbody>
        <tfoot><tr><td colspan="5" class="r m">Subtotal ${esc(g.panel)}</td><td class="r"><b>${$(g.usdt)}</b></td></tr></tfoot>
       </table></div>`;
      }).join('');
  } else if (ext && ext.items && ext.items.length) {
    // Los links que ya se mandaron guardan la foto vieja, sin panel ni ganancia. Se muestra lo que
    // haya para que ese link siga abriendo, en vez de quedar en blanco.
    const porDiv = {};
    ext.items.forEach((it) => {
      const i = {
        ...it,
        divisa: it.divisa || '—',
        excedente: it.excedente != null ? it.excedente
          : (money.esNumero(it.pct) && money.esNumero(it.base) ? money.sub(it.pct, it.base) : '—'),
      };
      (porDiv[i.divisa] = porDiv[i.divisa] || []).push(i);
    });
    extTablas = Object.keys(porDiv).map((div) => {
      const its = porDiv[div];
      const tc = its.find((i) => i.tc) || {};
      const sub = its.reduce((a, i) => money.add(a, i.usdt), '0');
      return `<h3>${esc(div)} <span class="m">${tc.tc ? `· tipo de cambio ${$(tc.tc)}` : ''}</span></h3>
       <div class="scroll"><table>${cabezaProv}
        <tbody>${its.map(filaProv).join('')}</tbody>
        <tfoot><tr><td colspan="5" class="r m">Subtotal ${esc(div)}</td><td class="r"><b>${$(sub)}</b></td></tr></tfoot>
       </table></div>`;
    }).join('');
  }

  // Resumen arriba del desglose: cuánto puso cada panel. Con varios paneles, es lo primero que se
  // quiere ver; el detalle de proveedores viene abajo.
  const extResumen = '';   // los bloques ya son uno por panel: el resumen repetía la misma lista

  const extHtml = extTablas
    ? `<div class="card"><h2>Proveedores externos</h2>
        <p class="m">Se cobran aparte de las cargas. Son los proveedores que cuestan más que tu porcentaje: se te cobra solo la <b>diferencia</b>,
        aplicada sobre la ganancia que dio ese proveedor en cada panel.
        Si un proveedor cuesta igual o menos que tu base, o si dio pérdida, no aparece acá.</p>
        ${extResumen}${extTablas}
        <p class="tot">Total proveedores: <b>${$(ext.total_usdt)} USDT</b></p>
        <p class="m" style="margin-top:8px">Los importes se redondean a dos decimales. Si dividís una fila por el tipo de cambio,
        el resultado puede diferir en algún centavo; los totales son los que valen.</p></div>`
    : '';

  return `<!DOCTYPE html>
<html lang="es"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(f.cliente.nombre)} — ${esc(f.mesNombre)}</title>
<style>
 :root{--t:#1c1720;--m:#7b7280;--b:#e6dbe4;--g:#b0479a;--bg:#fdfafc}
 *{box-sizing:border-box}
 body{margin:0;background:var(--bg);color:var(--t);font-family:-apple-system,"Segoe UI",Roboto,Arial,sans-serif;font-size:15px;line-height:1.5}
 .wrap{max-width:760px;margin:0 auto;padding:20px 16px 60px}
 h1{font-size:22px;margin:0}
 h2{font-size:16px;margin:0 0 8px}
 h3{font-size:14px;margin:16px 0 6px;color:var(--g)}
 .m{color:var(--m);font-size:12.5px}
 .card{background:#fff;border:1px solid var(--b);border-radius:12px;padding:16px;margin:12px 0}
 table{width:100%;border-collapse:collapse;margin:6px 0}
 th{text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:var(--m);font-weight:600;padding:6px 4px;border-bottom:1px solid var(--b)}
 td{padding:6px 4px;border-bottom:1px solid #f2ebf1;font-size:13.5px}
 tfoot td{border-bottom:none;padding-top:8px}
 /* si una tabla no entra en un teléfono, se desplaza ELLA sola — la página nunca se mueve de costado */
 .scroll{overflow-x:auto;-webkit-overflow-scrolling:touch}
 .scroll table{min-width:460px}
 .r{text-align:right}
 .anul td{opacity:.55}
 .tot{margin:10px 0 0;font-size:15px}
 .big{background:linear-gradient(180deg,#fff,#fdf6fc);border-color:var(--g)}
 .big .n{font-size:30px;font-weight:800;color:var(--g);letter-spacing:-.02em}
 /* El mismo total en la moneda del cliente: más chico porque es el mismo cobro, no otro. */
 .big .n2{font-size:19px;font-weight:700;color:#6b6470;margin-top:2px}
 table.sub{margin-top:6px;font-size:13px}
 table.sub tr.tot td{border-top:1px solid #e7dfe9}
 .saldo{font-size:22px;font-weight:800}
 .pie{color:var(--m);font-size:12px;text-align:center;margin-top:26px;line-height:1.7}
 .acc{display:flex;gap:8px;flex-wrap:wrap;margin:14px 0 0}
 .acc a,.acc button{display:inline-block;font:inherit;font-size:13.5px;font-weight:600;cursor:pointer;
   padding:9px 14px;border-radius:9px;border:1px solid var(--b);background:#fff;color:var(--t);text-decoration:none}
 .acc a{background:var(--g);border-color:var(--g);color:#fff}
 /* al imprimir se van los botones: en un PDF no sirven de nada */
 @media print{body{background:#fff}.card{break-inside:avoid;border-color:#ccc}.acc{display:none}
   h3{break-after:avoid}table{break-inside:auto}tr{break-inside:avoid}}
</style></head><body><div class="wrap">

 <h1>${esc(f.cliente.nombre)}</h1>
 <div class="m">${esc(f.mesNombre)} · emitida el ${esc(f.emitidaEl)}${f.tc ? ` · tipo de cambio ${$(f.tc)}` : ''}</div>

 ${token ? `<div class="acc">
   <a href="/factura/${esc(token)}/planilla.csv" download>⬇ Descargar planilla</a>
   <button type="button" onclick="window.print()">🖨 Guardar como PDF</button>
  </div>` : ''}

 ${(() => {
   /* EL RESUMEN, ARRIBA DE TODO. Lo primero que quiere saber el cliente es cuánto debe y de qué:
      tanto de cargas, tanto de proveedores, tanto en total. Estaba desparramado —la comisión
      adentro del bloque de cargas, los externos veinte tablas más abajo y el total al final—. */
   const car = Number((f.consumo && f.consumo.total_usdt) || 0);
   const exx = Number((f.externos && f.externos.total_usdt) || 0);
   if (!car && !exx) return '';
   const it = (t, v, g) => `<div style="flex:1 1 150px"><div class="m" style="text-transform:uppercase;letter-spacing:.04em">${t}</div>`
     + `<div style="font-size:${g ? '28px' : '21px'};font-weight:800${g ? ';color:var(--g)' : ''}">${$(v)}</div>`
     + '<div class="m">USDT</div></div>';
   return `<div class="card"><div style="display:flex;gap:18px;flex-wrap:wrap;align-items:flex-end">`
     + (car ? it('Cargas del mes', car) : '')
     + (exx ? it('Proveedores externos', exx) : '')
     + it('Total del mes', f.totalMes_usdt, true)
     + '</div>'
     + (f.totalMes_local ? `<div class="m" style="margin-top:6px">${f.totalMes_local.aproximado ? '≈ ' : ''}${$(f.totalMes_local.monto)} ${esc(f.totalMes_local.divisa)}</div>` : '')
     + '</div>';
 })()}

 ${f.consumo ? `<div class="card"><h2>Cargas del mes</h2>
   <p class="m">${f.consumo.pedidos} carga(s) en el mes. Cada moneda se pasa a USDT con el tipo de cambio del período.</p>
   <table><tbody>${filaDiv}</tbody></table>
   ${faltanDiv.length ? `<p class="m" style="color:#b3261e;border-left:3px solid #b3261e;padding-left:9px">
     <b>Este total no incluye ${faltanDiv.map((d) => $(d.vendido) + ' ' + esc(d.divisa)).join(' ni ')}.</b>
     Falta fijar el tipo de cambio de ${faltanDiv.length > 1 ? 'esas monedas' : 'esa moneda'} para el período;
     se factura aparte cuando esté.</p>` : ''}
   <p class="tot">Comisión <b>${esc(f.consumo.base)}%</b> sobre ${$(f.consumo.vendido_usdt)} USDT → <b>${$(f.consumo.total_usdt)} USDT</b>${f.consumo.local ? ` <span class="m">(${$(f.consumo.local.comision)} ${esc(f.consumo.local.divisa)})</span>` : ''}</p>
   ${comDiv}
   </div>` : ''}

 ${porPanel ? `<div class="card"><h2>Por panel</h2>
   ${hayPaga ? `<p class="m">«Paga» es tu ${esc((f.consumo || {}).base)}% sobre lo cargado, con el tipo de cambio de cada moneda: suma la comisión del mes.</p>` : ''}
   <div class="scroll"><table><thead><tr><th>Panel</th><th>Moneda</th><th class="r">Cargas</th><th class="r">Monto</th><th class="r">TC</th><th class="r">En USDT</th>${hayPaga ? '<th class="r">Paga</th>' : ''}</tr></thead>
     <tbody>${porPanel}</tbody>
     <tfoot><tr><td colspan="5" class="r"><b>Total</b></td><td class="r m">${$(porPanelTotal)}</td>${hayPaga ? `<td class="r"><b>${$(porPanelPaga)}</b></td>` : ''}</tr></tfoot></table></div>
   ${porPanelSinTC.length ? (() => {
       // Las MONEDAS, no las filas: con ocho paneles en pesos decía «ARS, ARS, ARS, …».
       const ms = [...new Set(porPanelSinTC.map((p) => p.divisa))];
       return `<p class="m" style="color:#b3261e">${ms.map(esc).join(', ')} sin tipo de cambio del mes: ${ms.length === 1 ? 'esa moneda no está' : 'esas monedas no están'} en el total en USDT.</p>`;
     })() : ''}
   </div>` : ''}

 ${extHtml}

 <div class="card big"><h2>Total del mes</h2><div class="n">${$(f.totalMes_usdt)} USDT</div>${f.totalMes_local ? `<div class="n2">${f.totalMes_local.aproximado ? '≈ ' : ''}${$(f.totalMes_local.monto)} ${esc(f.totalMes_local.divisa)}</div>` : ''}</div>

 <!-- El bloque «Tu cuenta» (saldo y pagos del mes) salió de la factura el 7-sep-2026 a pedido de
      la dueña: el sistema de pagos todavía no se usa al 100% y ese saldo no siempre refleja lo
      real. Mandarle al cliente un saldo que puede estar mal es peor que no mandarle ninguno; el
      TOTAL DEL MES sí es exacto y es lo que queda. El saldo sigue existiendo adentro del panel. -->

 ${detalle ? `<div class="card"><h2>Detalle de las cargas</h2>
   <p class="m">Todas las cargas del mes, agrupadas por panel y en orden de fecha.</p>
   ${detalle}</div>` : ''}

 <div class="pie">
  Documento generado el ${esc(f.emitidaEl)}${actualizado_at && actualizado_at.slice(0, 10) !== f.emitidaEl ? ` · actualizado el ${esc(actualizado_at.slice(0, 10))}` : ''}.<br>
  Si algún número no te cierra, escribinos con el panel y la fecha de la carga.
 </div>

</div></body></html>`;
}

function paginaError(mensaje) {
  return `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Factura</title>
<style>body{margin:0;background:#fdfafc;color:#1c1720;font-family:-apple-system,"Segoe UI",Roboto,Arial,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;text-align:center;padding:20px}
div{max-width:420px}p{color:#7b7280;font-size:14px;line-height:1.6}</style></head>
<body><div><h2>${esc(mensaje)}</h2><p>Pedile a tu contacto que te mande el link de nuevo.</p></div></body></html>`;
}

module.exports = { pagina, paginaError };
