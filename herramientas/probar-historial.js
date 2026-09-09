/**
 * probar-historial.js — MAQUETA del Historial de Fichas, fuera de producción.
 *
 * El CSS sale de public/index.html —el de verdad, no una copia— y las filas son las que dibujó el
 * panel corriendo. Se mira acá antes de subir nada.
 *
 * Muestra el antes y el después para poder compararlos de un vistazo. El «antes» se consigue
 * poniéndole encima las reglas viejas y devolviendo las dos columnas que se sacaron; no es otra
 * tabla escrita a mano, que se parecería a la de producción justo hasta que dejara de parecerse.
 *
 *   node herramientas/probar-historial.js [salida.html]
 */
const fs = require('fs');
const path = require('path');

const RAIZ = path.join(__dirname, '..');
const salida = process.argv[2] || path.join(RAIZ, 'maqueta-historial.html');

const panel = fs.readFileSync(path.join(RAIZ, 'public', 'index.html'), 'utf8');
const estilos = (panel.match(/<style>([\s\S]*?)<\/style>/) || [])[1];
if (!estilos) throw new Error('no encontré el <style> del panel');

const ahora = Buffer.from(
  fs.readFileSync(path.join(__dirname, 'maquetas', 'historial.b64'), 'utf8').trim(), 'base64',
).toString('utf8');

/* El «antes»: se rearma sobre la MISMA tabla, devolviéndole lo que se sacó. Así lo que se compara
   es exactamente el cambio y no dos maquetas distintas. */
const CODIGOS = { Titan: 'TITAN86', Marcelo: 'MARCELO44' };
const BALANCES = ['fichas retiradas · bal: 0', 'bal: 1000000', 'bal: 115271095.57', 'bal: 314562957.14'];
/* ⚠️ Sólo el CUERPO. La primera versión reemplazaba `</tr>` en toda la tabla y el primero que
   encontraba era el del encabezado: la columna entera quedaba corrida una fila. */
const cuerpo = ahora.slice(ahora.indexOf('<tbody>'));
const cabeza = ahora.slice(0, ahora.indexOf('<tbody>'));
let i = -1;
const antes = cabeza.replace('<th>Quién</th>', '<th>Quién</th><th>Detalle</th>')
  + cuerpo
    .replace(/<td data-label="Cliente"><b>([^<]+)<\/b><\/td>/g,
      (m, n) => `<td data-label="Cliente"><b>${n}</b> <span class="meta">${CODIGOS[n] || ''}</span></td>`)
    .replace(/<strong>ARS<\/strong> /g, '<strong>ARS</strong> $ ')
    .replace(/<\/tr>/g, () => {
      i += 1;
      // El botón de anular vivía en Detalle, que es de lo que se trata la comparación.
      const btn = i === 0 ? '' : ' <button class="danger small">↩ Anular (55:12)</button>';
      return `<td data-label="Detalle" class="meta">${BALANCES[i]}${btn}</td></tr>`;
    })
    // en el «antes» el botón no estaba al lado del estado
    .replace(/(<td data-label="Estado"[^>]*>[^<]*) <button class="danger small"[\s\S]*?<\/button>/g, '$1');

const PANES = [
  { t: 'Antes', p: 'El código del cliente en cada fila, «ARS $», y una columna Detalle con el balance del casino.', h: antes },
  { t: 'Ahora', p: 'Sólo el nombre. «ARS» y el monto. Sin Detalle: lo único que hacía falta de ahí —el botón de anular— queda al lado del estado.', h: ahora },
];

fs.writeFileSync(salida, `<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Maqueta · Historial</title>
<style>
${estilos}
  .maq { max-width: 1150px; margin: 0 auto; padding: 22px; }
  .maq h1 { font-size: 20px; margin: 0 0 4px; }
  .maq .op { margin: 26px 0; }
  .maq .op > h2 { font-size: 15px; margin: 0 0 4px; color: var(--gold); }
  .maq .op > p { margin: 0 0 10px; color: var(--muted); font-size: 12.5px; }
</style></head><body>
<div class="maq">
  <h1>📜 Historial</h1>
  <p class="meta">Maqueta con el CSS y las filas del panel de verdad. Nada de esto está en producción.</p>
  ${PANES.map((o) => `<div class="op"><h2>${o.t}</h2><p>${o.p}</p><div class="card">${o.h}</div></div>`).join('')}
</div>
</body></html>`);
console.log('maqueta →', salida);
