/**
 * pago-proveedores-html.js — LA FACTURA DE PROVEEDORES COMO HOJA.
 *
 * Tres tablas de la MISMA plata: por proveedor, por etiqueta y por divisa. Es lo que el dueño
 * venía recibiendo en una planilla, pero armado desde el cálculo del OS.
 *
 * ⚠️ ESTE DOCUMENTO ES INTERNO. Dice cuánto se le paga a cada proveedor y a qué costo — o sea, el
 * margen del negocio. No lleva token público como la cuenta de un cliente: se sirve detrás del
 * login y nada más. Si algún día hace falta mandárselo a alguien de afuera, hay que decidir ANTES
 * qué columnas se le muestran, igual que se hizo con la cuenta de TBS.
 *
 * El cuadre va arriba y no al final: las tres vistas tienen que dar el mismo total, y si no dan,
 * eso hay que verlo antes de leer un solo número, no después de firmar el pago.
 */
const { MESES_ES } = require('./lib/fechas');

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const n = (x, d = 2) => Number(x || 0).toLocaleString('es-AR', { minimumFractionDigits: d, maximumFractionDigits: d });

const CSS = `
  body{font:13px/1.55 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;padding:26px;color:#2b2230;
       max-width:1000px;margin:auto;background:#fff}
  h1{font-size:21px;margin:0 0 2px}
  h2{font-size:13px;margin:26px 0 6px;color:#8c7e89;text-transform:uppercase;letter-spacing:.04em}
  table{width:100%;border-collapse:collapse;margin-bottom:4px}
  th{text-align:left;font-size:10px;text-transform:uppercase;color:#8c7e89;
     border-bottom:1px solid #ead6e6;padding:6px 8px;white-space:nowrap}
  td{padding:5px 8px;border-bottom:1px solid #f3e9f1}
  tr:last-child td{border-bottom:none}
  .r{text-align:right;white-space:nowrap}
  .mut{color:#8c7e89;font-size:11px}
  tfoot td{font-weight:800;border-top:2px solid #ead6e6}
  .tot{margin:18px 0 4px;padding:13px 15px;background:#f6e9f4;border-radius:8px;font-size:19px;font-weight:800}
  .cua{padding:9px 12px;border-radius:7px;margin-bottom:14px;font-size:12px}
  .cua.ok{background:#eaf5ec;border-left:3px solid #2ea043}
  .cua.mal{background:#fdeceb;border-left:3px solid #d9534f}
  .pie{margin-top:26px;font-size:11px;color:#8c7e89;border-top:1px solid #f3e9f1;padding-top:10px}
  button{padding:9px 15px;font:inherit;border:1px solid #ead6e6;background:#fff;border-radius:7px;cursor:pointer}
  /* En papel los fondos del cuadre y del total tienen que salir: son lo que distingue
     "esto cuadra" de "esto no cuadra" en una hoja impresa, donde no hay nada más que mire. */
  @media print{button{display:none} body{padding:0}
    .cua,.tot{-webkit-print-color-adjust:exact;print-color-adjust:exact}
    h2{page-break-after:avoid} table{page-break-inside:auto} tr{page-break-inside:avoid}}
`;

/** @param {object} rep  lo que devuelve pago-proveedores.reporte() */
function hoja(rep) {
  if (!rep || !rep.ok) return `<!doctype html><meta charset="utf-8"><title>Pago a proveedores</title>
    <style>${CSS}</style><h1>No se pudo armar la hoja</h1>
    <div class="mut">${esc((rep && rep.error) || 'sin datos')}</div>`;

  const [y, mm] = String(rep.mes || '').split('-');
  const mesNom = MESES_ES[Number(mm) - 1] ? `${MESES_ES[Number(mm) - 1]} ${y}` : String(rep.mes);
  const conex = Object.entries(rep.porConexion || {});
  const c = rep.cuadre || {};

  const cuadre = c.cuadra
    ? `<div class="cua ok"><b>Cuadra.</b> Las tres vistas dan ${n(c.proveedores)} USDT.
       ${c.etiquetasDeducidas ? `<span class="mut">· ${c.etiquetasDeducidas} línea(s) con la etiqueta deducida del nombre.</span>` : ''}</div>`
    : `<div class="cua mal"><b>NO cuadra.</b> Por proveedor ${n(c.proveedores)} · por etiqueta ${n(c.etiquetas)}
       · por divisa ${n(c.divisas)}. Es un error de cálculo: no pagar con esta hoja.</div>`;

  const tProv = `<h2>Por proveedor</h2><table>
    <thead><tr><th>Proveedor</th><th class="r">Costo</th><th class="r">Líneas</th><th class="r">USDT</th></tr></thead>
    <tbody>${(rep.proveedores || []).map((p) => `<tr><td>${esc(p.proveedor)}</td>
      <td class="r mut">${esc(p.costo)}%</td><td class="r mut">${(p.lineas || []).length}</td>
      <td class="r"><b>${n(p.usdt)}</b></td></tr>`).join('')}</tbody>
    <tfoot><tr><td>Total</td><td></td><td></td><td class="r">${n(c.proveedores)}</td></tr></tfoot></table>`;

  const tEtiq = `<h2>Por etiqueta</h2><table>
    <thead><tr><th>Etiqueta</th><th class="r">USDT</th><th>Proveedores</th><th>Divisas</th></tr></thead>
    <tbody>${(rep.porEtiqueta || []).map((e) => `<tr><td><b>${esc(e.clave)}</b></td>
      <td class="r"><b>${n(e.usdt)}</b></td>
      <td class="mut">${esc((e.proveedores || []).join(', '))}</td>
      <td class="mut">${esc((e.divisas || []).join(', '))}</td></tr>`).join('')}</tbody>
    <tfoot><tr><td>Total</td><td class="r">${n(c.etiquetas)}</td><td></td><td></td></tr></tfoot></table>`;

  const tDiv = `<h2>Por divisa</h2><table>
    <thead><tr><th>Divisa</th><th class="r">Movido en la moneda</th><th class="r">Tipo de cambio</th>
      <th class="r">USDT</th></tr></thead>
    <tbody>${(rep.porDivisa || []).map((d) => `<tr><td><b>${esc(d.clave)}</b></td>
      <td class="r mut">${n(d.montoLocal)}</td>
      <td class="r mut">${d.tc ? esc(d.tc) : esc((d.tcs || []).join(' / '))}</td>
      <td class="r"><b>${n(d.usdt)}</b></td></tr>`).join('')}</tbody>
    <tfoot><tr><td>Total</td><td></td><td></td><td class="r">${n(c.divisas)}</td></tr></tfoot></table>
    ${(rep.porDivisa || []).some((d) => !d.tc)
      ? '<div class="mut">Donde hay dos tipos de cambio: SL2 y BVS se pasan a dólares con el promedio '
        + 'del mes y el resto con el del proveedor. No es un error, son dos acuerdos distintos.</div>' : ''}`;

  return `<!doctype html><html lang="es"><head><meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <meta name="robots" content="noindex,nofollow">
    <title>Pago a proveedores — ${esc(mesNom)}</title><style>${CSS}</style></head><body>
    <h1>Pago a proveedores</h1>
    <div class="mut">${esc(mesNom)}${rep.congelado ? ' · precios congelados de ese mes' : ' · precios de hoy (mes sin congelar)'}</div>
    <div class="tot">Total a pagar: ${n(c.proveedores)} USDT</div>
    <div class="mut" style="margin-bottom:14px">${conex.map(([k, v]) => `${esc(k)} ${n(v.usdt)}`).join(' · ')}</div>
    ${cuadre}${tEtiq}${tDiv}${tProv}
    <button onclick="window.print()">Guardar como PDF</button>
    <div class="pie">Latam Games · documento interno</div>
    </body></html>`;
}

module.exports = { hoja };
