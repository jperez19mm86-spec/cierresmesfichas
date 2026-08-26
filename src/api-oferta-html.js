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
 * ── UN NÚMERO POR GRUPO CUANDO SE PUEDE ──────────────────────────────────────────────────────
 * Si todos los sellos de un paquete van al mismo %, se muestra UNO arriba y la lista de
 * proveedores debajo, como la hoja que ya se usaba. Repetir "8%" veintisiete veces no informa: hace
 * que el lector busque la diferencia que no existe. Cuando sí hay diferencias —Live suele
 * tenerlas— se muestra renglón por renglón.
 */
const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const pct = (x) => String(x).replace(/\.0+$/, '') + '%';

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
  .gnota{font-size:12.5px;color:var(--ink2)}
  .provs{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px}
  .prov{background:var(--suave);border:1px solid var(--linea);border-radius:20px;
    padding:3px 11px;font-size:13px}
  table{width:100%;border-collapse:collapse;margin-top:8px}
  td{padding:7px 0;border-bottom:1px solid var(--linea);vertical-align:top;font-size:14px}
  tr:last-child td{border-bottom:none}
  td.p{text-align:right;white-space:nowrap;font-weight:700;color:var(--acento);
    font-variant-numeric:tabular-nums;width:74px}
  .cond{margin-top:34px;border-top:2px solid var(--ink);padding-top:14px}
  .cond h2{font-size:13px;letter-spacing:.12em;text-transform:uppercase;margin:0 0 8px}
  .cond p{margin:0 0 6px;font-size:13.5px;color:var(--ink2)}
  .pie{margin-top:34px;font-size:12px;color:var(--ink2)}
  @media print{ .hoja{padding:0} @page{margin:16mm} }
`;

/**
 * @param mostrar  lo que devuelve api-ofertas-store.paraMostrar — y NADA más
 */
function pagina(mostrar) {
  const grupos = (mostrar.grupos || []).map((g) => {
    const cab = `<div class="gcab"><span class="gnom">${esc(g.nombre)}</span>`
      + (g.unico ? `<span class="gpct">${esc(pct(g.unico))}</span>` : '<span class="gnota">según el proveedor</span>')
      + '</div>';
    if (g.unico) {
      // Un solo precio: la lista de proveedores alcanza, y se lee de un vistazo.
      // `unicos` junta la misma marca escrita distinto en dos sellos: "Igt" e "IGT" es una sola.
      const provs = require('./api-ofertas-store').unicos(g.items.flatMap((i) => i.proveedores));
      return `<div class="grupo">${cab}<div class="provs">${
        provs.map((p) => `<span class="prov">${esc(p)}</span>`).join('')}</div></div>`;
    }
    // Precios distintos: renglón por renglón, con los proveedores de cada uno.
    return `<div class="grupo">${cab}<table><tbody>${g.items
      .slice().sort((a, b) => a.corto.localeCompare(b.corto, 'es'))
      // También acá pasan por `unicos`: la fila de un sello puede repetir una marca.
      .map((i) => `<tr><td>${esc(require('./api-ofertas-store').unicos(i.proveedores).join(', '))}</td><td class="p">${esc(pct(i.pct))}</td></tr>`)
      .join('')}</tbody></table></div>`;
  }).join('');

  const cuantos = (mostrar.proveedores || []).length;
  return `<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Oferta comercial${mostrar.titulo ? ' · ' + esc(mostrar.titulo) : ''}</title>
<style>${CSS}</style></head><body><div class="hoja">
  <h1>Oferta comercial</h1>
  ${mostrar.titulo ? `<p class="para">${esc(mostrar.titulo)}</p>` : ''}
  <p style="color:var(--ink2);margin:0 0 6px">Porcentaje sobre el GGR de cada proveedor.
    ${cuantos} proveedores incluidos.</p>
  ${grupos}
  <div class="cond"><h2>Condiciones</h2>
    <p>El porcentaje se aplica sobre el GGR del período.</p>
    <p>La liquidación se realiza mensualmente.</p>
    ${mostrar.notas ? `<p>${esc(mostrar.notas)}</p>` : ''}
  </div>
  <p class="pie">La disponibilidad de cada proveedor puede variar según la moneda.</p>
</div></body></html>`;
}

module.exports = { pagina };
