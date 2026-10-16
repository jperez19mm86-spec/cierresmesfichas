/**
 * externos-guardados.js — LA CUENTA DE PROVEEDORES EXTERNOS DE UN CLIENTE, TAL CUAL SE COBRÓ.
 *
 * Pedido del dueño (17-oct-2026): «un lugar desde donde descargar solo sus cuentas de externos»,
 * para mandárselas a un cliente de meses pasados. Sale de la FACTURA GUARDADA del mes —la copia
 * congelada al emitir—, no de recalcular: la pantalla 🏷 Proveedores externos recalcula con los
 * precios y cambios de hoy, y un mes viejo puede dar distinto de lo que se le cobró.
 *
 * Dos formatos: CSV para Excel (separador «;» y coma decimal, que es como lo abre un Excel en
 * castellano) y una página para imprimir o guardar como PDF desde el navegador.
 */
const facturasGuardadas = require('./facturas-guardadas');
const clientes = require('./clientes-store');

const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const nomMes = (m) => { const [a, b] = String(m).split('-'); const n = MESES[Number(b) - 1]; return n ? n[0].toUpperCase() + n.slice(1) + ' ' + a : m; };
const num = (v, dec) => (v == null || v === '' ? '' : Number(v).toLocaleString('es-AR', { minimumFractionDigits: dec, maximumFractionDigits: dec }));
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// Una celda de CSV: si trae «;», comillas o saltos, va entre comillas.
const celda = (v) => { const s = String(v == null ? '' : v); return /[;"\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };

/** Los clientes con externos en la factura guardada de un mes. */
function delMes(mes) {
  return facturasGuardadas.delMes(mes).map((g) => {
    const f = facturasGuardadas.get(g.cliente_id, mes);
    const e = f && f.datos && f.datos.externos;
    if (!e || !(e.items || []).length) return null;
    const c = clientes.get(g.cliente_id) || {};
    return { cliente_id: g.cliente_id, cliente: c.nombre || (f.datos.cliente || {}).nombre || g.cliente_id, codigo: c.codigo || (f.datos.cliente || {}).codigo || '',
      externos_usdt: e.total_usdt, renglones: e.items.length, generada_at: f.generada_at, actualizada_at: f.actualizada_at || null, veces: f.veces };
  }).filter(Boolean).sort((a, b) => Number(b.externos_usdt) - Number(a.externos_usdt));
}

/** Lo guardado de un cliente y un mes, o null. */
function de(clienteId, mes) {
  const f = facturasGuardadas.get(clienteId, mes);
  const e = f && f.datos && f.datos.externos;
  if (!e || !(e.items || []).length) return null;
  const c = f.datos.cliente || {};
  return { cliente: c.nombre || clienteId, codigo: c.codigo || '', mes, base: e.base, total: e.total_usdt, items: e.items, guardada: f.actualizada_at || f.generada_at };
}

const CABECERA = ['Proveedor', 'Moneda', 'Ganancia', '% del proveedor', 'Tu % base', 'Diferencia %', 'Monto en la moneda', 'Cambio', 'USDT', 'Cajas'];
const filaDe = (i) => [i.proveedor, i.divisa, num(i.profit, 2), num(i.pct, 2), num(i.base, 2), num(i.excedente, 2), num(i.monto, 2),
  i.divisa === 'USD' || i.divisa === 'USDT' ? '1' : num(i.tc, 4), num(i.usdt, 2), (i.paneles || []).join(', ')];

/** CSV de un cliente (o de todo el mes si `clienteId` es null). Con BOM, para que Excel lea los acentos. */
function csv(mes, clienteId) {
  const lista = clienteId ? [de(clienteId, mes)].filter(Boolean) : delMes(mes).map((x) => de(x.cliente_id, mes)).filter(Boolean);
  if (!lista.length) return null;
  const lineas = [];
  const todos = !clienteId;
  lineas.push((todos ? ['Cliente', ...CABECERA] : CABECERA).map(celda).join(';'));
  lista.forEach((d) => {
    d.items.forEach((i) => lineas.push((todos ? [d.cliente, ...filaDe(i)] : filaDe(i)).map(celda).join(';')));
    const tot = todos ? [d.cliente, 'TOTAL', '', '', '', '', '', '', '', num(d.total, 2), ''] : ['TOTAL', '', '', '', '', '', '', '', num(d.total, 2), ''];
    lineas.push(tot.map(celda).join(';'));
  });
  return '﻿' + lineas.join('\r\n') + '\r\n';
}

/** La página para imprimir o guardar como PDF. Es lo que ve el cliente: sin nada interno. */
function html(mes, clienteId) {
  const d = de(clienteId, mes);
  if (!d) return null;
  const filas = d.items.map((i) => `<tr><td>${esc(i.proveedor)}</td><td>${esc(i.divisa)}</td><td class="n">${num(i.profit, 2)}</td>
    <td class="n">${num(i.pct, 2)}%</td><td class="n">${num(i.base, 2)}%</td><td class="n">${num(i.excedente, 2)}%</td>
    <td class="n">${num(i.monto, 2)}</td><td class="n">${i.divisa === 'USD' || i.divisa === 'USDT' ? '1' : num(i.tc, 2)}</td><td class="n"><b>${num(i.usdt, 2)}</b></td></tr>`).join('');
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Proveedores externos ${esc(nomMes(mes))} · ${esc(d.cliente)}</title>
<style>
  body{font:13px/1.45 -apple-system,"Segoe UI",Roboto,Arial,sans-serif;color:#241f27;margin:24px;background:#fff}
  h1{font-size:19px;margin:0 0 2px} .sub{color:#6b6470;margin-bottom:16px}
  table{width:100%;border-collapse:collapse} th,td{padding:6px 8px;border-bottom:1px solid #e7dfe9;text-align:left;vertical-align:top}
  th{font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:#6b6470} td.n,th.n{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}
  tfoot td{font-weight:800;border-top:2px solid #241f27;border-bottom:none}
  .nota{color:#6b6470;font-size:12px;margin-top:14px} .boton{margin:0 0 16px} .boton button{font:inherit;padding:8px 14px;border-radius:8px;border:1px solid #c456ad;background:#c456ad;color:#fff;cursor:pointer}
  @media print{.boton{display:none} body{margin:0}}
</style></head><body>
<div class="boton"><button onclick="window.print()">🖨 Imprimir o guardar como PDF</button></div>
<h1>Proveedores externos · ${esc(nomMes(mes))}</h1>
<div class="sub">${esc(d.cliente)}${d.codigo ? ' · ' + esc(d.codigo) : ''} · tu % base ${esc(num(d.base, 2))}%</div>
<table><thead><tr><th>Proveedor</th><th>Moneda</th><th class="n">Ganancia</th><th class="n">% del proveedor</th><th class="n">Tu % base</th>
<th class="n">Diferencia</th><th class="n">Monto</th><th class="n">Cambio</th><th class="n">USDT</th></tr></thead>
<tbody>${filas}</tbody><tfoot><tr><td colspan="8">Total</td><td class="n">${num(d.total, 2)} USDT</td></tr></tfoot></table>
<div class="nota">Se cobra la diferencia entre el % de cada proveedor y tu % base, sobre la ganancia del mes, pasada a USDT con el cambio del mes de cada moneda.</div>
</body></html>`;
}

module.exports = { delMes, de, csv, html };
