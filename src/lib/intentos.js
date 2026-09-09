/**
 * intentos.js — EL TOPE DE INTENTOS DE LOGIN, uno solo para todas las puertas.
 *
 * Vivía suelto adentro de `index.js`, así que la puerta de Mi Caja —que se agregó después y está
 * en otro archivo— quedó sin ninguno. Cada intento suyo se manda derecho al casino: sin tope,
 * probar contraseñas contra cuentas reales A TRAVÉS de nuestro panel es gratis, y como el casino
 * bloquea por intentos fallidos, alcanza para dejar afuera a un cajero de verdad.
 *
 * Se cuenta por IP Y por usuario. Sólo por IP, todos los que comparten un internet se tapan entre
 * ellos; sólo por usuario, se prueba contra los cuarenta y cinco desde el mismo lado. Lo que hay
 * que frenar es probar muchas claves contra UNA cuenta, y eso lo corta el tope por usuario.
 */
const _intentos = new Map();
const VENTANA = 15 * 60 * 1000;

/* Dos topes distintos a propósito: 10 por USUARIO y 40 por IP. Diez por IP parece más seguro y es
   peor — un cliente que se equivoca tres veces, su encargado otras tres y el vendedor dos, todos
   detrás del mismo internet, se quedan afuera sin haber hecho nada raro. */
function demasiados(clave) {
  const ahora = Date.now();
  const tope = String(clave).startsWith('ip:') ? 40 : 10;
  const prev = (_intentos.get(clave) || []).filter((t) => ahora - t < VENTANA);
  if (_intentos.size > 5000) _intentos.clear();          // no crece para siempre
  _intentos.set(clave, prev);
  return prev.length >= tope;
}

function anotar(clave) {
  const arr = (_intentos.get(clave) || []).filter((t) => Date.now() - t < VENTANA);
  arr.push(Date.now());
  _intentos.set(clave, arr);
}

function limpiar(clave) { _intentos.delete(clave); }

/** La IP de quien pide, mirando el proxy. Detrás de Railway la real es la primera de la lista. */
function ipDe(req) {
  return String(req.ip || req.headers['x-forwarded-for'] || 'x').split(',')[0].trim();
}

module.exports = { demasiados, anotar, limpiar, ipDe, VENTANA };
