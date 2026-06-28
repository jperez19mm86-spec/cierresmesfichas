/**
 * notify.service.js — mensajes Telegram v2 (sección 4): carga (con USDT en tiempo real + deuda) y pago.
 * Reusa el sender de la MATRIZ (telegram.sendMessage) + el bot global (config-store).
 */
const telegram = require('./telegram');
const config = require('./config-store');
const money = require('./lib/money');

const LINE = '━━━━━━━━━━━━━━━━━━';
const esc = (s) => String(s == null ? '' : s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

/** Mensaje de carga acreditada con desglose USDT + deuda acumulada (sección 4.1). */
function msgCarga({ panel, carga, basePct, montoDivisa, divisa, tc, equivUsdt, deuda }) {
  const d = deuda || { fichas_pendientes: '0', proveedores_pendientes: '0', total: '0' };
  return [
    `🎰 <b>Panel:</b> ${esc(panel)}`,
    LINE,
    '✅ <b>Carga acreditada</b>',
    '',
    `💰 Fichas cargadas:  <b>${money.fmt(carga, 0)}</b>`,
    `📊 Base:  <b>${esc(basePct)}%</b>`,
    `   Monto en divisa:  ${money.fmt(montoDivisa, 0)} ${esc(divisa || 'ARS')}`,
    '',
    `💱 ExRate (Binance):  ${money.fmt(tc, 0)} ARS/USDT`,
    `   Equivalente:  <b>${money.fmt(equivUsdt, 0)} USDT</b>`,
    LINE,
    '📋 <b>Deuda acumulada</b>',
    `   Fichas pendientes:  ${money.fmt(d.fichas_pendientes, 0)} USDT`,
    `   Proveedores ext.:  ${money.fmt(d.proveedores_pendientes, 0)} USDT`,
    `   <b>TOTAL:  ${money.fmt(d.total, 0)} USDT</b>`,
    LINE,
  ].join('\n');
}

/** Mensaje de pago registrado con saldo actualizado (sección 4.2). */
function msgPago({ nombre, pago, deudaAnterior, saldo }) {
  const head = [
    `💳 <b>Pago registrado — ${esc(nombre)}</b>`, LINE,
    `   Pago recibido:  <b>${money.fmt(pago, 0)} USDT</b>`,
    `   Deuda anterior:  ${money.fmt(deudaAnterior, 0)} USDT`, '',
  ];
  const tail = money.cmp(saldo, '0') <= 0
    ? ['✅ <b>Cuenta al día. Sin saldo pendiente.</b>', LINE]
    : [`✅ <b>Saldo pendiente:  ${money.fmt(saldo, 0)} USDT</b>`, LINE];
  return head.concat(tail).join('\n');
}

async function _send(cliente, text) {
  const tok = config.getTelegramToken();
  if (!(cliente && cliente.telegram && cliente.telegram.enabled && cliente.telegram.chatId && tok)) {
    return { ok: false, skipped: true };
  }
  return telegram.sendMessage(tok, cliente.telegram.chatId, text);
}

const avisarCarga = (cliente, data) => _send(cliente, msgCarga(data));
const avisarPago = (cliente, data) => _send(cliente, msgPago(data));

module.exports = { msgCarga, msgPago, avisarCarga, avisarPago };
