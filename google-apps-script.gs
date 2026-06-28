/**
 * Apps Script para "Venta de Fichas" — registra cada carga/rechazo en pestañas por mes.
 * v2 (02-06-2026): + columnas "ID Casino" y "Pedido"; encabezados auto-reparables.
 *
 * INSTALACIÓN / ACTUALIZACIÓN:
 *  1. Sheet → Extensiones → Apps Script.
 *  2. Borrá todo y pegá ESTE archivo. Guardá (💾).
 *  3. Implementar → Administrar implementaciones → ✏ Editar → Versión: "Nueva versión" → Implementar.
 *     (Si es la primera vez: Implementar → Nueva implementación → Tipo "Aplicación web" →
 *      Ejecutar como: Yo | Acceso: Cualquier persona → Implementar. La URL /exec NO cambia entre versiones.)
 *  4. Tras actualizar columnas: borrá la pestaña del mes actual (clic derecho → Eliminar). Se recrea
 *     sola con las columnas nuevas en la próxima transacción.
 */

// (Opcional) Secreto compartido. Si lo completás, poné el MISMO valor en SHEET_SECRET de venta-fichas (Railway).
var SHEET_SECRET = '';

var HEADERS = ['Fecha', 'Hora', 'Estado', 'Cliente', 'Código', 'Caja/Usuario', 'ID Casino', 'Sistema', 'Monto', 'Divisa', 'Saldo result.', 'Pedido', 'Motivo', 'ID'];

function doPost(e) {
  var lock = LockService.getScriptLock();
  try { lock.waitLock(20000); } catch (x) { /* mejor escribir que perder el dato */ }
  try {
    var data = JSON.parse(e.postData.contents);
    if (SHEET_SECRET && String(data.secret || '') !== SHEET_SECRET) {
      return _json({ ok: false, error: 'unauthorized' });
    }
    var tz = data.tz || 'America/Argentina/Buenos_Aires';
    var when = data.fecha ? new Date(data.fecha) : new Date();

    var tabName = Utilities.formatDate(when, tz, 'yyyy-MM'); // pestaña por mes: 2026-06
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName(tabName) || ss.insertSheet(tabName, 0); // nueva queda primera
    _ensureHeaders(sheet); // garantiza encabezados + filtro AUNQUE la pestaña exista vacía

    var estado = data.estado === 'cargado' ? '✅ Cargado'
               : (data.estado === 'rechazado' ? '❌ Rechazado' : (data.estado || ''));
    var pedido = data.pedidoAt ? Utilities.formatDate(new Date(data.pedidoAt), tz, 'dd/MM HH:mm') : '';

    sheet.appendRow([
      Utilities.formatDate(when, tz, 'dd/MM/yyyy'), // Fecha (resuelto)
      Utilities.formatDate(when, tz, 'HH:mm:ss'),   // Hora (resuelto)
      estado,                                        // Estado
      data.cliente || '',                            // Cliente (nombre, o código si falta)
      data.codigo || '',                             // Código
      data.cajaUsuario || '',                        // Caja/Usuario
      data.usuarioId || '',                          // ID Casino (cuenta en el casino)
      data.sistema || '',                            // Sistema
      Number(data.monto) || 0,                       // Monto
      data.divisa || '',                             // Divisa
      (data.saldo === '' || data.saldo == null) ? '' : Number(data.saldo), // Saldo result.
      pedido,                                        // Pedido (cuándo lo pidió)
      data.motivo || '',                             // Motivo (si rechazado)
      data.id || ''                                  // ID (del pedido)
    ]);
    return _json({ ok: true, tab: tabName });
  } catch (err) {
    return _json({ ok: false, error: String(err) });
  } finally {
    try { lock.releaseLock(); } catch (e2) {}
  }
}

/** Asegura que la fila 1 tenga los encabezados + filtro. Si no (pestaña nueva o vaciada), los repone. */
function _ensureHeaders(sheet) {
  if (String(sheet.getRange(1, 1).getValue()) === HEADERS[0]) return; // ya tiene cabecera
  if (sheet.getLastRow() > 0) sheet.insertRowBefore(1);               // hay datos sin cabecera → fila arriba
  var head = sheet.getRange(1, 1, 1, HEADERS.length);
  head.setValues([HEADERS]).setFontWeight('bold').setBackground('#1f2937').setFontColor('#ffffff');
  sheet.setFrozenRows(1);
  if (!sheet.getFilter()) { try { head.createFilter(); } catch (e) {} }
  sheet.setColumnWidth(1, 90); sheet.setColumnWidth(4, 150); sheet.setColumnWidth(6, 150);
}

function doGet() { return _json({ ok: true, service: 'venta-fichas-sheets' }); }

function _json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
