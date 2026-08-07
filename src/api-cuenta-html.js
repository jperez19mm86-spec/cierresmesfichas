/**
 * api-cuenta-html.js — LA CUENTA DEL CLIENTE COMO PÁGINA.
 *
 * Es lo que se le manda por Telegram: un link a esta página, no un texto. Telegram no puede mostrar
 * una tabla con subtotales por divisa, y ese formato es el que el dueño venía usando.
 *
 * ── UN SOLO RENDERIZADOR, DOS PUERTAS ──────────────────────────────────────────────────────────
 *
 * Esta función la usan las dos: la vista de adentro (con sesión) y el link público del cliente. Si
 * cada una armara su propio HTML, el día que se cambie una el cliente vería algo distinto de lo que
 * vio el dueño al revisar — y nadie se enteraría hasta que alguien reclame.
 *
 * Recibe SIEMPRE un documento ya proyectado por api-cuenta-doc (vista 'cliente'). No toca la cuenta
 * cruda: acá no hay forma de imprimir lo que se le paga al proveedor porque ese dato no llega.
 */
const money = require('./lib/money');

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const n = (x, d = 2) => Number(x || 0).toLocaleString('es-AR', { minimumFractionDigits: d, maximumFractionDigits: d });

const CSS = `
  body{font:14px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;padding:26px;color:#2b2230;
       max-width:900px;margin:auto;background:#fff}
  h1{font-size:20px;margin:0 0 2px} h2{font-size:14px;margin:22px 0 4px;color:#8c7e89;font-weight:700}
  table{width:100%;border-collapse:collapse;margin-bottom:6px}
  th{text-align:left;font-size:11px;text-transform:uppercase;color:#8c7e89;border-bottom:1px solid #ead6e6;padding:6px 8px}
  td{padding:6px 8px;border-bottom:1px solid #f3e9f1}
  .r{text-align:right}
  tfoot td{font-weight:700;border-top:2px solid #ead6e6;border-bottom:none}
  .tot{margin-top:22px;padding:13px 15px;background:#f6e9f4;border-radius:8px;font-size:18px;font-weight:800}
  .proy{display:flex;justify-content:space-between;align-items:baseline;margin:26px 0 2px;
        padding:8px 12px;border-radius:7px;font-size:15px}
  .proy.p0{background:#e8e6f6}.proy.p1{background:#f6e2e4}
  .proy span{font-weight:800}
  .sub2{text-align:right;padding:6px 12px 2px;font-size:14px;color:#8c7e89}
  .pie{margin-top:26px;font-size:11px;color:#8c7e89;border-top:1px solid #f3e9f1;padding-top:10px}
  button{padding:9px 15px;font:inherit;border:1px solid #ead6e6;background:#fff;border-radius:7px;cursor:pointer}
  /* En papel, las franjas de color de cada proyecto tienen que salir: son lo que distingue
     una fila de un proyecto de la del otro cuando los dos tienen los mismos sellos. */
  @media print{button{display:none}
    .proy,.tot{-webkit-print-color-adjust:exact;print-color-adjust:exact}}
`;

/** @param {object} doc  documento de api-cuenta-doc, vista 'cliente' */
function pagina(doc, { nota = null } = {}) {
  if (!doc || !doc.ok) return paginaError('No encontramos esa cuenta');
  const varias = (doc.secciones || []).length > 1;
  const cuerpo = (doc.secciones || []).map((sec, i) => `
    ${varias ? `<div class="proy p${i % 2}"><b>${esc(sec.titulo)}</b><span>${n(sec.usdt_cliente)} USDT</span></div>` : ''}
    ${(sec.porDivisa || []).map((g) => `
      <h2>${esc(g.divisa)} · tipo de cambio ${esc(g.tc_cliente)}</h2>
      <table><thead><tr><th>Proveedor</th><th class="r">GGR ${esc(g.divisa)}</th>
        <th class="r">GGR US$</th><th class="r">%</th><th class="r">USDT</th></tr></thead><tbody>
      ${(g.lineas || []).map((l) => `<tr><td>${esc(l.sello)}</td><td class="r">${n(l.ggr, 0)}</td>
        <td class="r">${n(l.ggr_usd)}</td><td class="r">${esc(l.pct_cliente)}%</td>
        <td class="r">${n(l.usdt_cliente)}</td></tr>`).join('')}
      </tbody><tfoot><tr><td>Subtotal ${esc(g.divisa)}</td><td class="r">${n(g.ggr, 0)}</td>
        <td class="r">${n(g.ggr_usd)}</td><td></td><td class="r">${n(g.usdt_cliente)}</td></tr></tfoot></table>`).join('')}
    ${varias ? `<div class="sub2">Total ${esc(sec.titulo)}: <b>${n(sec.usdt_cliente)} USDT</b></div>` : ''}`).join('');

  return `<!doctype html><html lang="es"><head><meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <meta name="robots" content="noindex,nofollow">
    <title>${esc(doc.cuenta)} — ${esc(doc.mes)}</title><style>${CSS}</style></head><body>
    <h1>${esc(doc.cuenta)}${doc.caja ? ' — ' + esc(doc.caja) : ''}</h1>
    <div style="color:#8c7e89;margin-bottom:14px">Consumo de ${esc(doc.mes)}</div>
    ${cuerpo}
    <div class="tot">Total a pagar: ${n(doc.usdt_cliente)} USDT</div>
    <button onclick="window.print()">Guardar como PDF</button>
    <div class="pie">${nota ? esc(nota) + ' · ' : ''}Latam Games</div>
    </body></html>`;
}

function paginaError(msg) {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <meta name="robots" content="noindex,nofollow">
    <title>Cuenta</title><style>${CSS}</style></head><body>
    <h1>${esc(msg)}</h1>
    <div style="color:#8c7e89">Si creés que es un error, escribinos.</div>
    <div class="pie">Latam Games</div></body></html>`;
}

module.exports = { pagina, paginaError };
