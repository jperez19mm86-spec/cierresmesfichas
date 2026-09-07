/**
 * vendedor-linea-doc.js — LA LÍNEA DE UN VENDEDOR, COMO LINK.
 *
 * Telegram no puede mostrar una tabla con el movimiento de cada divisa, su tipo de cambio y el
 * subtotal por proveedor. La cuenta de TBS ya se manda así —un mensaje corto con un link a la
 * página— y la dueña pidió lo mismo para la línea de cada vendedor: «necesito que llegue como link
 * como te mandé el de TBS».
 *
 * Se guarda el documento YA ARMADO, no una referencia al mes: si mañana cambia un panel o un TC,
 * el link sigue mostrando lo que se mandó. Un link que cambia solo es peor que uno viejo — nadie
 * puede discutir un número que ya no existe.
 *
 * Reusa la tabla `factura_link` con el prefijo `vend:`, igual que las cuentas de API usan `api:`.
 * El prefijo es lo que evita que un token de acá abra la cuenta de un cliente: `porToken` no
 * devuelve nada si no empieza como corresponde.
 */
const crypto = require('crypto');
const { db } = require('./db');

const PREFIJO = 'vend:';

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const n = (x, d = 2) => Number(x || 0).toLocaleString('es-AR',
  { minimumFractionDigits: d, maximumFractionDigits: d });

/** Guarda (o refresca) el link de un vendedor para un mes. El token NO cambia: si ya se mandó, anda. */
function crearLink(doc) {
  const cid = PREFIJO + String(doc.vendedor);
  const mes = String(doc.mes);
  const at = new Date().toISOString();
  const ya = db.prepare('SELECT token FROM factura_link WHERE cliente_id=? AND mes=? AND revocado=0').get(cid, mes);
  if (ya) {
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
  if (!r || !String(r.cliente_id || '').startsWith(PREFIJO)) return null;
  if (r.revocado) return { revocado: true };
  db.prepare('UPDATE factura_link SET accesos=accesos+1, ultimo_acceso=? WHERE token=?')
    .run(new Date().toISOString(), r.token);
  try { return { doc: JSON.parse(r.datos), creado_at: r.creado_at, actualizado_at: r.actualizado_at }; }
  catch (e) { return null; }
}

const CSS = `
  body{font:14px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;padding:26px;color:#2b2230;
       max-width:900px;margin:auto;background:#fff}
  h1{font-size:20px;margin:0 0 2px}
  h2{font-size:15px;margin:30px 0 2px}
  .sub{color:#8c7e89;font-size:13px;margin:0 0 18px}
  table{width:100%;border-collapse:collapse}
  th{text-align:left;font-size:11px;text-transform:uppercase;color:#8c7e89;border-bottom:1px solid #ead6e6;padding:6px 8px}
  td{padding:6px 8px;border-bottom:1px solid #f3e9f1}
  .r{text-align:right}
  /* La fila del proveedor manda; las de divisa cuelgan de ella y van más chicas y corridas. */
  tr.prov td{font-weight:700;border-bottom:none;padding-top:12px}
  tr.div td{color:#6b6270;font-size:13px;border-bottom:1px solid #f3e9f1}
  tr.div td:first-child{padding-left:22px}
  .tot{margin-top:22px;padding:13px 15px;background:#f6e9f4;border-radius:8px;font-size:18px;font-weight:800;
       display:flex;justify-content:space-between}
  .pie{margin-top:26px;font-size:11px;color:#8c7e89;border-top:1px solid #f3e9f1;padding-top:10px}
`;

/** @param {object} doc  { vendedor, mes, mesNombre, proveedores[], clientes[], totalUsdt } */
function pagina(doc, { nota = null } = {}) {
  if (!doc || !doc.ok) return paginaError('No encontramos esa línea');
  const filas = (doc.proveedores || []).map((p) => {
    const cab = `<tr class="prov"><td>${esc(p.proveedor)}</td>`
      + `<td class="r">${p.costo == null ? '—' : esc(p.costo) + '%'}</td>`
      + `<td></td><td></td><td class="r">${n(p.usdt)}</td></tr>`;
    const divs = (p.porDivisa || []).map((d) => `<tr class="div"><td>${esc(d.divisa)}</td>`
      + `<td></td><td class="r">${n(d.movimiento, 0)}</td>`
      + `<td class="r">${esc(d.tasa || '—')}</td><td class="r">${n(d.usdt)}</td></tr>`).join('');
    return cab + divs;
  }).join('');
  return `<!doctype html><html lang="es"><head><meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>${esc(doc.vendedor)} · ${esc(doc.mesNombre || doc.mes)}</title><style>${CSS}</style></head><body>
    <h1>${esc(doc.vendedor)} — ${esc(doc.mesNombre || doc.mes)}</h1>
    <p class="sub">Lo que movió toda su línea · ${(doc.clientes || []).length} cuentas · ${(doc.proveedores || []).length} proveedores</p>
    <table><thead><tr><th>Proveedor / divisa</th><th class="r">Costo</th><th class="r">Movimiento</th>
      <th class="r">TC</th><th class="r">USD</th></tr></thead>
      <tbody>${filas || '<tr><td colspan="5">Sin movimiento este mes.</td></tr>'}</tbody></table>
    <div class="tot"><span>Total</span><span>${n(doc.totalUsdt)} USD</span></div>
    ${bloqueClientes(doc)}
    ${nota ? `<div class="pie">${esc(nota)}</div>` : ''}
    </body></html>`;
}

/* EL MISMO TOTAL, CORTADO POR CLIENTE. La factura lista los paneles en SU moneda —162.511.765 ARS
   al lado de 26.302 UYU— y así no se pueden ni comparar ni sumar. Acá cada panel ya viene en USDT
   con el TC de su divisa, así que un cliente con paneles en tres monedas es un solo número. */
function bloqueClientes(doc) {
  const cs = doc.porCliente || [];
  if (!cs.length) return '';
  const filas = cs.map((c) => {
    const cab = `<tr class="prov"><td>${esc(c.cliente)}</td><td></td>`
      + `<td class="r">${n(c.usdt)}</td></tr>`;
    const pans = (c.paneles || []).map((p) => `<tr class="div"><td>${esc(p.panel)}</td>`
      + `<td class="r">${esc(p.divisa)}</td><td class="r">${n(p.usdt)}</td></tr>`).join('');
    return cab + pans;
  }).join('');
  return `<h2>Por cliente</h2>
    <p class="sub">Sus paneles sumados en USDT, con el tipo de cambio de cada divisa.</p>
    <table><thead><tr><th>Cliente / panel</th><th class="r">Divisa</th><th class="r">USDT</th></tr></thead>
      <tbody>${filas}</tbody></table>`;
}

function paginaError(msg) {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>Latam Games</title><style>${CSS}</style></head><body>
    <h1>${esc(msg)}</h1><p class="sub">Pedile el link de nuevo a quien te lo mandó.</p></body></html>`;
}

module.exports = { crearLink, porToken, pagina, paginaError };
