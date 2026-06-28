/**
 * money.js — aritmética EXACTA de dinero y porcentajes (decimal.js).
 *
 * Regla del proyecto: NUNCA usar floats para plata. Todos los montos se guardan como
 * STRING decimal (ej "20000000.00", "1355.123456") y se operan con decimal.js.
 * Las agregaciones de reportes se hacen en JS (los volúmenes son chicos), no con SUM() de SQLite.
 *
 * Convención de decimales: ARS 2, USDT 6 (para no perder precisión en conversiones).
 */
const Decimal = require('decimal.js');
Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

/** Decimal seguro desde cualquier entrada (null/''/undefined → 0). */
function D(x) {
  if (x === null || x === undefined || x === '') return new Decimal(0);
  try { return new Decimal(String(x).trim()); } catch (e) { return new Decimal(0); }
}

const add = (a, b) => D(a).plus(D(b)).toString();
const sub = (a, b) => D(a).minus(D(b)).toString();
const mul = (a, b) => D(a).times(D(b)).toString();
const div = (a, b) => { const d = D(b); return d.isZero() ? '0' : D(a).div(d).toString(); };

/** amount * percent%  (ej: pct(20000000, 10) = 2000000) */
const pct = (amount, percent) => D(amount).times(D(percent)).div(100).toString();

/** Redondea a `dec` decimales (HALF_UP) y devuelve string. */
const round = (x, dec = 2) => D(x).toDecimalPlaces(dec).toString();

const isPos = (x) => D(x).greaterThan(0);
const isNeg = (x) => D(x).lessThan(0);
const isZero = (x) => D(x).isZero();
const cmp = (a, b) => D(a).comparedTo(D(b));
const max = (a, b) => (cmp(a, b) >= 0 ? D(a).toString() : D(b).toString());

/** Suma una lista de strings decimales. */
const sum = (arr) => (arr || []).reduce((acc, x) => acc.plus(D(x)), new Decimal(0)).toString();

/** Formato es-AR para mostrar (no para guardar). */
function fmt(x, dec = 2) {
  const n = D(x).toDecimalPlaces(dec);
  return n.toNumber().toLocaleString('es-AR', { minimumFractionDigits: dec, maximumFractionDigits: dec });
}

module.exports = { D, add, sub, mul, div, pct, round, isPos, isNeg, isZero, cmp, max, sum, fmt, Decimal };
