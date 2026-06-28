/**
 * sheets.js — registro de transacciones (cargas/rechazos) en una Google Sheet.
 *
 * Cómo funciona: cada vez que un pedido se RESUELVE (cargado/rechazado), mandamos un POST
 * (fire-and-forget) a un Apps Script Web App (SHEET_WEBHOOK_URL). El script escribe una fila
 * en la pestaña del mes correspondiente (la crea si no existe, con encabezados + filtro por columna).
 *
 * Si SHEET_WEBHOOK_URL no está configurada, no hace nada (no rompe ni bloquea el flujo de carga).
 */
const axios = require('axios');

const WEBHOOK_URL = process.env.SHEET_WEBHOOK_URL || '';
const SHEET_SECRET = process.env.SHEET_SECRET || ''; // opcional: si lo ponés acá y en el Apps Script, valida el origen
const TZ = process.env.SHEET_TZ || 'America/Argentina/Buenos_Aires';

/**
 * Envía una transacción (pedido resuelto) a la Google Sheet. Fire-and-forget:
 * no bloquea la respuesta al admin y nunca lanza — si falla, solo loguea un warning.
 * @param {object} pedido - el pedido ya resuelto (estado 'cargado' o 'rechazado')
 */
function logTransaction(pedido) {
  if (!WEBHOOK_URL || !pedido) return;
  try {
    const payload = {
      secret: SHEET_SECRET,
      tz: TZ,
      id: pedido.id || '',
      fecha: pedido.resueltoAt || pedido.createdAt || new Date().toISOString(), // cuándo se resolvió
      pedidoAt: pedido.createdAt || '',                                          // cuándo lo pidió el cliente
      estado: pedido.estado || '',
      cliente: pedido.clienteNombre || pedido.codigo || '',                      // nombre; si falta → código
      codigo: pedido.codigo || '',
      cajaUsuario: pedido.cajaUsuario || '',
      usuarioId: pedido.userId || '',                                            // ID de la cuenta en el casino
      sistema: pedido.sistema || '',
      monto: Number(pedido.monto) || 0,
      divisa: pedido.divisa || '',
      saldo: (pedido.newBalance === null || pedido.newBalance === undefined) ? '' : pedido.newBalance,
      motivo: pedido.error || '',
    };
    axios.post(WEBHOOK_URL, payload, { timeout: 12000, headers: { 'Content-Type': 'application/json' } })
      .then((r) => {
        if (!(r.data && r.data.ok)) console.warn('[Sheets] respuesta inesperada:', JSON.stringify(r.data || {}).slice(0, 200));
      })
      .catch((e) => console.warn('[Sheets] log falló:', e.message));
  } catch (e) {
    console.warn('[Sheets] logTransaction error:', e.message);
  }
}

module.exports = { logTransaction, enabled: !!WEBHOOK_URL };
