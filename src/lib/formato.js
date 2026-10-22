/**
 * formato.js — cómo se escriben la plata y los meses en lo que ve una persona.
 *
 * Cada documento arma el mes a su manera («julio de 2026», «Julio 2026», «julio 2026») y eso queda
 * en cada uno; lo que vive acá es la lista de los nombres, que antes estaba copiada nueve veces.
 */
const MESES = Object.freeze(['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio',
  'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre']);
/** Los mismos con mayúscula: 'Julio'. Es como los escribe la grilla del cierre. */
const MESES_MAY = Object.freeze(MESES.map((m) => m[0].toUpperCase() + m.slice(1)));

/** 1234.5 → «1.234,50». Vacío o null cuenta como 0. */
const plata = (x, d = 2) => Number(x || 0).toLocaleString('es-AR', { minimumFractionDigits: d, maximumFractionDigits: d });

module.exports = { MESES, MESES_MAY, plata };
