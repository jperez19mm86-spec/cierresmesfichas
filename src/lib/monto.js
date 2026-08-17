/**
 * monto.js — ENTENDER UN IMPORTE ESCRITO POR UNA PERSONA.
 *
 * Un cliente avisó "9422 USDT" cuando había transferido 94,22: cien veces más. Se aprobó bien
 * porque quien aprueba mira el comprobante, pero el número declarado quedó mal y la diferencia
 * hubo que verla a ojo.
 *
 * Hay dos problemas distintos y los dos se arreglan acá:
 *
 *  1. LA COMA SE RECHAZABA. `Number('94,22')` es NaN, así que escribir el importe como lo escribe
 *     cualquiera en Argentina hacía fallar el aviso con "el monto no es válido". La forma natural
 *     de escribir un número no puede ser la forma equivocada.
 *
 *  2. EL PUNTO SIGNIFICA DOS COSAS. En "200.000" es separador de miles; en "94.22" es decimal.
 *     La pantalla borraba TODOS los puntos, así que "94.22" se convertía en 9422.
 *
 * ── LA REGLA ─────────────────────────────────────────────────────────────────────────────────
 * El ÚLTIMO separador manda, y decide por cuántos dígitos lo siguen:
 *   · 1 o 2 dígitos detrás  → es DECIMAL     94.22 → 94,22   ·   1.234,56 → 1234,56
 *   · 3 dígitos detrás      → es de MILES    200.000 → 200000   ·   9.422 → 9422
 *   · sin separador         → entero         9422 → 9422
 *
 * Sirve para las dos convenciones —"1.234,56" y "1,234.56" dan lo mismo— porque mira la POSICIÓN,
 * no cuál de los dos símbolos es.
 *
 * El único caso que resuelve distinto a lo que alguien podría querer es "9.422" con tres decimales
 * de verdad. Se eligió miles a propósito: en pesos es lo habitual, y en dólares nadie transfiere
 * con milésimos.
 *
 * ⚠️ ESTO NO REEMPLAZA MIRAR EL COMPROBANTE. Interpreta mejor, pero lo que se acredita lo decide
 * quien aprueba mirando el recibo — por eso el declarado y el acreditado se guardan aparte.
 */

/**
 * @returns {number|null} el importe, o null si no se puede leer como uno positivo
 */
function parseMonto(txt) {
  if (typeof txt === 'number') return Number.isFinite(txt) && txt > 0 ? txt : null;
  let s = String(txt == null ? '' : txt).trim();
  if (!s) return null;
  // Se sacan símbolos y espacios (incluido el fino que meten algunos teclados), no los separadores.
  s = s.replace(/[\s  ]/g, '').replace(/[$€₲]/g, '').replace(/USDT?|ARS|PYG|UYU/gi, '');
  if (!/^[\d.,]+$/.test(s)) return null;         // letras o signos raros: no se adivina

  const ultimo = Math.max(s.lastIndexOf('.'), s.lastIndexOf(','));
  let n;
  if (ultimo < 0) {
    n = Number(s);
  } else {
    const detras = s.length - ultimo - 1;
    if (detras === 1 || detras === 2) {
      // decimal: se limpia todo lo de la izquierda y ese separador pasa a punto
      n = Number(s.slice(0, ultimo).replace(/[.,]/g, '') + '.' + s.slice(ultimo + 1));
    } else {
      n = Number(s.replace(/[.,]/g, ''));        // miles (o algo raro): todo junto
    }
  }
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Cómo se le muestra a la persona lo que se entendió, para que lo confirme antes de mandarlo. */
function fmtMonto(n, decimales = 2) {
  return Number(n || 0).toLocaleString('es-AR',
    { minimumFractionDigits: decimales, maximumFractionDigits: decimales });
}

/**
 * ¿Lo que se entendió es distinto de lo que se escribió?
 *
 * Sirve para avisar sólo cuando hace falta: si alguien escribe "94,22" y se entendió 94,22, no hay
 * nada que confirmar. Si escribió "94.22" y podría haber querido 9422, sí.
 */
function esAmbiguo(txt) {
  const s = String(txt == null ? '' : txt).trim();
  if (!/[.,]/.test(s)) return false;
  const ultimo = Math.max(s.lastIndexOf('.'), s.lastIndexOf(','));
  const detras = s.length - ultimo - 1;
  // Un punto con 1-2 dígitos detrás es el caso del error: en la costumbre local eso son miles.
  return s[ultimo] === '.' && (detras === 1 || detras === 2);
}

module.exports = { parseMonto, fmtMonto, esAmbiguo };
