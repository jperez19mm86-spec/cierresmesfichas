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

/** Lo guardado de un cliente y un mes, o null. `logins` = por login y moneda (lo que pidió el dueño
 * el 17-oct: «por panel, por login y por divisa»); las facturas viejas sin ese detalle traen sólo `items`. */
function de(clienteId, mes) {
  const f = facturasGuardadas.get(clienteId, mes);
  const e = f && f.datos && f.datos.externos;
  if (!e || !(e.items || []).length) return null;
  const c = f.datos.cliente || {};
  const cero = (v) => Math.abs(Number(v) || 0) < 0.005;
  const grupos = (e.porPanel || []).filter((g) => !cero(g.usdt)); // lo que da 0,00 USDT no se cobra: no se muestra
  // login → sus monedas, el login que más deja primero
  const porLogin = new Map();
  grupos.forEach((g) => { if (!porLogin.has(g.panel)) porLogin.set(g.panel, { login: g.panel, usdt: 0, monedas: [] }); const l = porLogin.get(g.panel); l.monedas.push(g); l.usdt += Number(g.usdt) || 0; });
  const logins = [...porLogin.values()].sort((x, y) => y.usdt - x.usdt);
  logins.forEach((l) => l.monedas.sort((x, y) => Number(y.usdt) - Number(x.usdt)));
  // por moneda: lo que suma cada una en su moneda y en USDT
  const porMoneda = new Map();
  grupos.forEach((g) => { const m = porMoneda.get(g.divisa) || { divisa: g.divisa, monto: 0, usdt: 0, tc: g.tc }; m.monto += Number(g.monto) || 0; m.usdt += Number(g.usdt) || 0; porMoneda.set(g.divisa, m); });
  return { cliente: c.nombre || clienteId, codigo: c.codigo || '', mes, base: e.base, total: e.total_usdt, items: e.items, guardada: f.actualizada_at || f.generada_at,
    logins: logins.length ? logins : null, monedas: [...porMoneda.values()].sort((x, y) => y.usdt - x.usdt) };
}

const sinCambio = (d) => d === 'USD' || d === 'USDT';
const cambioDe = (d, tc, dec) => (sinCambio(d) ? '1' : num(tc, dec));
const CABECERA = ['Login', 'Moneda', 'Proveedor', 'Ganancia', '% del proveedor', 'Tu % base', 'Diferencia %', 'Monto en la moneda', 'Cambio', 'USDT'];
const CABECERA_VIEJA = ['Proveedor', 'Moneda', 'Ganancia', '% del proveedor', 'Tu % base', 'Diferencia %', 'Monto en la moneda', 'Cambio', 'USDT', 'Cajas'];

/** Los renglones del Excel de un cliente (sin la columna Cliente). */
function filasDe(d) {
  const out = [];
  if (!d.logins) { // factura vieja: sólo por proveedor
    d.items.forEach((i) => out.push([i.proveedor, i.divisa, num(i.profit, 2), num(i.pct, 2), num(i.base, 2), num(i.excedente, 2), num(i.monto, 2),
      cambioDe(i.divisa, i.tc, 4), num(i.usdt, 2), (i.paneles || []).join(', ')]));
    out.push(['TOTAL', '', '', '', '', '', '', '', num(d.total, 2), '']);
    return out;
  }
  d.logins.forEach((l) => l.monedas.forEach((g) => {
    (g.items || []).forEach((i) => out.push([l.login, g.divisa, i.proveedor, num(i.profit, 2), num(i.pct, 2), num(i.base, 2), num(i.excedente, 2), num(i.monto, 2),
      cambioDe(g.divisa, g.tc, 4), num(i.usdt, 2)]));
    out.push([l.login, g.divisa, 'Subtotal', '', '', '', '', num(g.monto, 2), cambioDe(g.divisa, g.tc, 4), num(g.usdt, 2)]);
  }));
  out.push(['TOTAL', '', '', '', '', '', '', '', '', num(d.total, 2)]);
  out.push([]);
  d.monedas.forEach((m) => out.push(['Por moneda', m.divisa, '', '', '', '', '', num(m.monto, 2), cambioDe(m.divisa, m.tc, 4), num(m.usdt, 2)]));
  return out;
}

/** CSV de un cliente (o de todo el mes si `clienteId` es null). Con BOM, para que Excel lea los acentos. */
function csv(mes, clienteId) {
  const lista = clienteId ? [de(clienteId, mes)].filter(Boolean) : delMes(mes).map((x) => de(x.cliente_id, mes)).filter(Boolean);
  if (!lista.length) return null;
  const todos = !clienteId;
  const cab = lista.every((d) => !d.logins) ? CABECERA_VIEJA : CABECERA;
  const lineas = [(todos ? ['Cliente', ...cab] : cab).map(celda).join(';')];
  lista.forEach((d) => filasDe(d).forEach((f) => { if (f.length) lineas.push((todos ? [d.cliente, ...f] : f).map(celda).join(';')); }));
  return '﻿' + lineas.join('\r\n') + '\r\n';
}

/** La página para imprimir o guardar como PDF. Es lo que ve el cliente: sin nada interno. */
function html(mes, clienteId) {
  const d = de(clienteId, mes);
  if (!d) return null;
  const fila = (i, div, tc) => `<tr><td>${esc(i.proveedor)}</td><td class="n">${num(i.profit, 2)}</td><td class="n">${num(i.pct, 2)}%</td>
    <td class="n">${num(i.base, 2)}%</td><td class="n">${num(i.excedente, 2)}%</td><td class="n">${num(i.monto, 2)}</td><td class="n"><b>${num(i.usdt, 2)}</b></td></tr>`;
  const cab = `<thead><tr><th>Proveedor</th><th class="n">Ganancia</th><th class="n">% del proveedor</th><th class="n">Tu % base</th>
<th class="n">Diferencia</th><th class="n">Monto</th><th class="n">USDT</th></tr></thead>`;
  let cuerpo;
  if (d.logins) {
    const resumen = `<h2>Por moneda</h2><table class="res"><thead><tr><th>Moneda</th><th class="n">Monto</th><th class="n">Cambio</th><th class="n">USDT</th></tr></thead><tbody>
${d.monedas.map((m) => `<tr><td>${esc(m.divisa)}</td><td class="n">${num(m.monto, 2)}</td><td class="n">${cambioDe(m.divisa, m.tc, 2)}</td><td class="n"><b>${num(m.usdt, 2)}</b></td></tr>`).join('')}
</tbody><tfoot><tr><td colspan="3">Total</td><td class="n">${num(d.total, 2)} USDT</td></tr></tfoot></table>`;
    const porLogin = d.logins.map((l) => `<section><h2>Login ${esc(l.login)} <span class="sub2">${num(l.usdt, 2)} USDT</span></h2>
${l.monedas.map((g) => `<h3>${esc(g.divisa)}${sinCambio(g.divisa) ? '' : ` · cambio ${cambioDe(g.divisa, g.tc, 2)}`}</h3>
<table>${cab}<tbody>${(g.items || []).map((i) => fila(i)).join('')}</tbody>
<tfoot><tr><td colspan="5">Subtotal ${esc(l.login)} en ${esc(g.divisa)}</td><td class="n">${num(g.monto, 2)}</td><td class="n">${num(g.usdt, 2)}</td></tr></tfoot></table>`).join('')}
</section>`).join('');
    cuerpo = resumen + porLogin;
  } else {
    cuerpo = `<table><thead><tr><th>Proveedor</th><th>Moneda</th><th class="n">Ganancia</th><th class="n">% del proveedor</th><th class="n">Tu % base</th>
<th class="n">Diferencia</th><th class="n">Monto</th><th class="n">Cambio</th><th class="n">USDT</th></tr></thead><tbody>
${d.items.map((i) => `<tr><td>${esc(i.proveedor)}</td><td>${esc(i.divisa)}</td><td class="n">${num(i.profit, 2)}</td><td class="n">${num(i.pct, 2)}%</td><td class="n">${num(i.base, 2)}%</td>
<td class="n">${num(i.excedente, 2)}%</td><td class="n">${num(i.monto, 2)}</td><td class="n">${cambioDe(i.divisa, i.tc, 2)}</td><td class="n"><b>${num(i.usdt, 2)}</b></td></tr>`).join('')}
</tbody><tfoot><tr><td colspan="8">Total</td><td class="n">${num(d.total, 2)} USDT</td></tr></tfoot></table>`;
  }
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Proveedores externos ${esc(nomMes(mes))} · ${esc(d.cliente)}</title>
<style>
  body{font:13px/1.45 -apple-system,"Segoe UI",Roboto,Arial,sans-serif;color:#241f27;margin:24px;background:#fff}
  h1{font-size:19px;margin:0 0 2px} .sub{color:#6b6470;margin-bottom:16px}
  h2{font-size:15px;margin:22px 0 4px;padding-top:10px;border-top:2px solid #241f27} h2 .sub2{float:right;font-weight:800}
  h3{font-size:12px;margin:10px 0 2px;color:#6b6470;text-transform:uppercase;letter-spacing:.04em}
  section{break-inside:avoid-page} table{width:100%;border-collapse:collapse;margin-bottom:6px} table.res{max-width:520px}
  th,td{padding:5px 8px;border-bottom:1px solid #e7dfe9;text-align:left;vertical-align:top}
  th{font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:#6b6470} td.n,th.n{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}
  tfoot td{font-weight:800;border-top:1px solid #241f27;border-bottom:none}
  .nota{color:#6b6470;font-size:12px;margin-top:18px} .boton{margin:0 0 16px} .boton button{font:inherit;padding:8px 14px;border-radius:8px;border:1px solid #c456ad;background:#c456ad;color:#fff;cursor:pointer}
  @media print{.boton{display:none} body{margin:0}}
</style></head><body>
<div class="boton"><button onclick="window.print()">🖨 Imprimir o guardar como PDF</button></div>
<h1>Proveedores externos · ${esc(nomMes(mes))}</h1>
<div class="sub">${esc(d.cliente)}${d.codigo ? ' · ' + esc(d.codigo) : ''} · tu % base ${esc(num(d.base, 2))}% · total ${num(d.total, 2)} USDT</div>
${cuerpo}
<div class="nota">Se cobra la diferencia entre el % de cada proveedor y tu % base, sobre la ganancia del mes de cada login, pasada a USDT con el cambio del mes de cada moneda.</div>
</body></html>`;
}

module.exports = { delMes, de, csv, html };
