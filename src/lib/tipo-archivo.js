/**
 * tipo-archivo.js — QUÉ ES UN ARCHIVO DE VERDAD, por sus bytes.
 *
 * El tipo que declara quien sube un archivo es un dato de él, no un hecho: el 21-sep-2026 alguien
 * subió un `.html` como comprobante con `Content-Type: text/html` y el panel lo abrió como página
 * de su propio dominio. Desde ahí un script hace pedidos con la sesión de quien lo mira.
 *
 * Acá se mira el principio del archivo, que no se puede falsear sin cambiar el archivo.
 */
const VISIBLES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/heic', 'application/pdf']);

/** El tipo real, o '' si no se reconoce. */
function tipoPorBytes(b) {
  if (!b || b.length < 12) return '';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) return 'image/png';
  if (b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return 'image/jpeg';
  if (b.slice(0, 4).toString('ascii') === 'GIF8') return 'image/gif';
  if (b.slice(0, 4).toString('ascii') === 'RIFF' && b.slice(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  if (b.slice(0, 4).toString('ascii') === '%PDF') return 'application/pdf';
  // HEIC/HEIF de los iPhone: la marca está en el segundo bloque, no al principio.
  if (b.slice(4, 8).toString('ascii') === 'ftyp' && /heic|heif|mif1|msf1/i.test(b.slice(8, 16).toString('ascii'))) return 'image/heic';
  return '';
}

/** Si se puede MOSTRAR en pantalla sin riesgo. Lo demás se descarga, nunca se abre. */
function sePuedeMostrar(tipo) { return VISIBLES.has(String(tipo || '')); }

module.exports = { tipoPorBytes, sePuedeMostrar, VISIBLES };
