/**
 * factura-csv.js — la misma factura, en planilla, para que el cliente la baje y la audite.
 *
 * Sale como CSV y no como PDF a propósito: el PDF ya lo puede sacar imprimiendo la página desde el
 * navegador, pero para revisar 200 cargas hace falta poder ordenar y sumar, y eso solo se hace en
 * una planilla.
 *
 * Detalles que parecen manías pero son los que hacen que abra bien en el Excel de acá:
 *   · separador ";" y "sep=;" en la primera línea — con "," Excel en español mete todo en una columna,
 *   · números con coma decimal, por lo mismo,
 *   · BOM al principio, si no los acentos salen rotos.
 */
const money = require('./lib/money');

// Coma decimal y sin separador de miles: así Excel lo toma como NÚMERO y se puede sumar.
// Con puntos de miles lo tomaría como texto y no sumaría nada.
const num = (x) => (x == null || x === '' ? '' : String(money.round(String(x), 2)).replace('.', ','));

function celda(v) {
  const s = String(v == null ? '' : v);
  return /[";\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
const fila = (arr) => arr.map(celda).join(';');

function planilla(f) {
  const L = [];
  L.push('sep=;');
  L.push(fila([f.cliente.nombre, f.mesNombre]));
  L.push(fila(['Emitida', f.emitidaEl]));
  L.push('');

  if (f.consumo) {
    L.push(fila(['CARGAS DEL MES']));
    L.push(fila(['Moneda', 'Cargado', 'Tipo de cambio', 'USDT']));
    (f.consumo.porDivisa || []).forEach((d) => L.push(fila([d.divisa, num(d.vendido), num(d.tc), num(d.vendidoUsdt)])));
    L.push(fila(['', '', `Comisión ${f.consumo.base}%`, num(f.consumo.total_usdt)]));
    L.push('');
  }

  if ((f.detalle || []).length) {
    L.push(fila(['DETALLE DE LAS CARGAS']));
    L.push(fila(['#', 'Panel', 'Moneda', 'Fecha', 'Hora', 'Monto', 'Estado']));
    f.detalle.forEach((d) => L.push(fila([
      d.n || '', d.panel, d.divisa, d.fecha, d.hora, num(d.monto), d.anulando ? 'en anulación' : '',
    ])));
    L.push('');
  }

  const ext = f.externos;
  if (ext && (ext.porPanel || ext.items || []).length) {
    L.push(fila(['PROVEEDORES EXTERNOS']));
    L.push(fila(['Panel', 'Moneda', 'Proveedor', 'Ganancia', 'Excedente %', 'A cobrar', 'Tipo de cambio', 'USDT']));
    if (ext.porPanel && ext.porPanel.length) {
      ext.porPanel.forEach((p) => p.items.forEach((i) => L.push(fila([
        p.panel, p.divisa, i.proveedor, num(i.profit), num(i.excedente), num(i.monto), num(p.tc), num(i.usdt),
      ]))));
    } else {
      // foto vieja: no tenía panel
      (ext.items || []).forEach((i) => L.push(fila([
        '', i.divisa || '', i.proveedor, num(i.profit), num(i.excedente), num(i.monto), num(i.tc), num(i.usdt),
      ])));
    }
    L.push(fila(['', '', '', '', '', '', 'Total proveedores', num(ext.total_usdt)]));
    L.push('');
  }

  L.push(fila(['TU CUENTA']));
  L.push(fila(['Cargas pendientes', num(f.cuenta.consumo_pendiente)]));
  L.push(fila(['Proveedores pendientes', num(f.cuenta.externos_pendiente)]));
  L.push(fila(['Pagos registrados', num(f.cuenta.pagos)]));
  L.push(fila(['Saldo', num(f.cuenta.saldo)]));

  if ((f.pagosDelMes || []).length) {
    L.push('');
    L.push(fila(['PAGOS DEL MES']));
    L.push(fila(['Fecha', 'Por dónde', 'USDT']));
    f.pagosDelMes.forEach((p) => L.push(fila([p.fecha, p.medio || '', num(p.usdt)])));
  }

  // \r\n: Excel para Windows es el que la va a abrir. BOM para que los acentos no salgan rotos.
  return '﻿' + L.join('\r\n') + '\r\n';
}

/** Nombre del archivo que baja: "Marcelo - Julio 2026.csv", sin nada que rompa en Windows. */
function nombreArchivo(f) {
  const limpio = (s) => String(s || '').replace(/[\\/:*?"<>|]/g, '').trim();
  return `${limpio(f.cliente.nombre)} - ${limpio(f.mesNombre)}.csv`;
}

module.exports = { planilla, nombreArchivo };
