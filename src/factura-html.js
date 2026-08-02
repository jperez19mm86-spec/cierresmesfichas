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

function pagina({ factura: f, actualizado_at }) {
  const filaDiv = (f.consumo && f.consumo.porDivisa || [])
    .map((d) => `<tr><td>${esc(d.divisa)}</td><td class="r">${$(d.vendido)}</td><td class="r m">${d.tc ? 'TC ' + $(d.tc) : '—'}</td><td class="r">${d.vendidoUsdt != null ? $(d.vendidoUsdt) + ' USDT' : '—'}</td></tr>`)
    .join('');

  const porPanel = (f.porPanel || [])
    .map((p) => `<tr><td>${esc(p.panel)}</td><td>${esc(p.divisa)}</td><td class="r">${p.cargas}</td><td class="r">${$(p.monto)}</td></tr>`)
    .join('');

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
  // Se agrupa POR MONEDA: el tipo de cambio es uno por moneda, así que va en el encabezado del
  // bloque y no repetido en cada fila. Y así la ganancia queda al lado de la moneda en la que se
  // generó, que es la única forma de que el cliente pueda verificarla contra su panel.
  let extTablas = '';
  if (ext && ext.items && ext.items.length) {
    const porDiv = {};
    ext.items.forEach((it) => {
      // Los links que ya se mandaron guardan la foto vieja, sin ganancia ni moneda. Se completa lo
      // que se puede deducir para que ese link siga abriendo bien en vez de mostrar celdas vacías.
      const i = {
        ...it,
        divisa: it.divisa || '—',
        excedente: it.excedente != null ? it.excedente
          : (money.esNumero(it.pct) && money.esNumero(it.base) ? money.sub(it.pct, it.base) : '—'),
      };
      (porDiv[i.divisa] = porDiv[i.divisa] || []).push(i);
    });
    extTablas = Object.keys(porDiv)
      .map((div) => {
        const its = porDiv[div];
        const tc = its.find((i) => i.tc) || {};
        const sub = its.reduce((a, i) => money.add(a, i.usdt), '0');
        return `<h3>${esc(div)} <span class="m">${tc.tc ? `· tipo de cambio ${$(tc.tc)}` : '· sin tipo de cambio cargado'}</span></h3>
         <div class="scroll"><table>
          <thead><tr><th>Proveedor</th><th class="r">Ganancia</th><th class="r">Excedente</th><th class="r">A cobrar</th><th class="r">USDT</th></tr></thead>
          <tbody>${its.map((i) => `<tr><td>${esc(i.proveedor)}</td><td class="r">${i.profit ? $(i.profit) : '—'}</td>`
            + `<td class="r"><b>${esc(i.excedente)}%</b><span class="m"> (${esc(i.pct)}−${esc(i.base)})</span></td>`
            + `<td class="r">${i.monto ? $(i.monto) : '—'}</td><td class="r">${$(i.usdt)}</td></tr>`).join('')}</tbody>
          <tfoot><tr><td colspan="4" class="r m">Subtotal ${esc(div)}</td><td class="r"><b>${$(sub)}</b></td></tr></tfoot>
         </table></div>`;
      })
      .join('');
  }
  const extHtml = extTablas
    ? `<div class="card"><h2>Proveedores externos</h2>
        <p class="m">Se cobran aparte de las cargas. Son los proveedores que cuestan más que tu porcentaje: se te cobra solo la <b>diferencia</b> —
        si el proveedor cuesta 14% y tu base es 6%, se cobra 8%— aplicada sobre la ganancia que dio ese proveedor.
        Si un proveedor cuesta igual o menos que tu base, o si dio pérdida, no aparece acá.</p>
        ${extTablas}
        <p class="tot">Total proveedores: <b>${$(ext.total_usdt)} USDT</b></p></div>`
    : '';

  const pagos = (f.pagosDelMes || []).length
    ? `<table><thead><tr><th>Fecha</th><th>Por dónde</th><th class="r">USDT</th></tr></thead><tbody>
       ${f.pagosDelMes.map((p) => `<tr><td>${esc(p.fecha)}</td><td>${esc(p.medio || '—')}</td><td class="r">${$(p.usdt)}</td></tr>`).join('')}
       </tbody></table>`
    : '<p class="m">Sin pagos registrados en el mes.</p>';

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
 .saldo{font-size:22px;font-weight:800}
 .pie{color:var(--m);font-size:12px;text-align:center;margin-top:26px;line-height:1.7}
 @media print{body{background:#fff}.card{break-inside:avoid;border-color:#ccc}}
</style></head><body><div class="wrap">

 <h1>${esc(f.cliente.nombre)}</h1>
 <div class="m">${esc(f.mesNombre)} · emitida el ${esc(f.emitidaEl)}${f.tc ? ` · tipo de cambio ${$(f.tc)}` : ''}</div>

 ${f.consumo ? `<div class="card"><h2>Cargas del mes</h2>
   <p class="m">${f.consumo.pedidos} carga(s) en el mes. Cada moneda se pasa a USDT con el tipo de cambio del período.</p>
   <table><tbody>${filaDiv}</tbody></table>
   <p class="tot">Comisión <b>${esc(f.consumo.base)}%</b> sobre ${$(f.consumo.vendido_usdt)} USDT → <b>${$(f.consumo.total_usdt)} USDT</b></p>
   </div>` : ''}

 ${porPanel ? `<div class="card"><h2>Por panel</h2>
   <table><thead><tr><th>Panel</th><th>Moneda</th><th class="r">Cargas</th><th class="r">Monto</th></tr></thead><tbody>${porPanel}</tbody></table>
   </div>` : ''}

 ${extHtml}

 <div class="card big"><h2>Total del mes</h2><div class="n">${$(f.totalMes_usdt)} USDT</div></div>

 <div class="card"><h2>Tu cuenta</h2>
  <table><tbody>
   <tr><td>Cargas pendientes</td><td class="r">${$(f.cuenta.consumo_pendiente)}</td></tr>
   <tr><td>Proveedores pendientes</td><td class="r">${$(f.cuenta.externos_pendiente)}</td></tr>
   <tr><td>Pagos registrados</td><td class="r">− ${$(f.cuenta.pagos)}</td></tr>
  </tbody></table>
  <p class="tot">Saldo: <span class="saldo">${$(f.cuenta.saldo)} USDT</span></p>
  <h3>Pagos del mes</h3>${pagos}
 </div>

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
