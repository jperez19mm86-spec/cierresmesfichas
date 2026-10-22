/**
 * html.js — escapar texto antes de meterlo en HTML. Tres reglas, cada una con su lugar:
 *
 *  · escTexto: sólo & < >. Es lo que pide Telegram en sus mensajes con formato, y alcanza para
 *    texto entre etiquetas. NO sirve adentro de un atributo.
 *  · esc:      & < > y comillas dobles. Para los documentos (factura, cuenta, oferta): sirve también
 *    adentro de un atributo entre comillas dobles.
 *  · escTodo:  además la comilla simple. Para lo que puede terminar en un atributo entre comillas
 *    simples.
 *
 * Están separadas a propósito: cambiar la regla de un lugar cambia los bytes de lo que ya se mandó
 * o se guardó (una factura guardada, un mensaje), aunque en pantalla se vea igual.
 */
const s = (x) => String(x == null ? '' : x);
const escTexto = (x) => s(x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const esc = (x) => escTexto(x).replace(/"/g, '&quot;');
const escTodo = (x) => esc(x).replace(/'/g, '&#39;');

module.exports = { escTexto, esc, escTodo };
