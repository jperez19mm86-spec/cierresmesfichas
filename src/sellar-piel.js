#!/usr/bin/env node
/**
 * sellar-piel.js — LE PONE A /piel.css UNA VERSIÓN QUE SALE DE SU PROPIO CONTENIDO.
 *
 * El servidor sirve lo estático con `Cache-Control: max-age=3600`, así que después de cambiar la
 * piel el navegador del cliente sigue mostrando la de hace una hora — y eso no se nota desde acá:
 * se nota cuando el cliente abre la pantalla y la ve a medio pintar. Con `?v=<hash>` en el link,
 * cambiar la piel cambia la URL y el navegador la pide de nuevo sola.
 *
 * El sello sale del CONTENIDO y no de un número puesto a mano, justamente para que no se pueda
 * olvidar: el suite recalcula el hash y falla si algún archivo quedó con el sello viejo.
 *
 * Se corre a mano después de tocar public/piel.css:   node src/sellar-piel.js
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const raiz = path.join(__dirname, '..');
const ARCHIVOS = ['public/ganamos.html', 'public/proveedor.html', 'src/chat-doc.js'];

function sello() {
  const piel = fs.readFileSync(path.join(raiz, 'public', 'piel.css'));
  return crypto.createHash('sha1').update(piel).digest('hex').slice(0, 8);
}

function sellar() {
  const v = sello();
  let tocados = 0;
  for (const rel of ARCHIVOS) {
    const p = path.join(raiz, rel);
    const antes = fs.readFileSync(p, 'utf8');
    /* Sólo el href de verdad, no cualquier mención: si sella también los comentarios, cada
       cambio de la piel ensucia el diff con renglones de texto que no hacen nada. */
    const despues = antes.replace(/href="\/piel\.css(\?v=[0-9a-f]+)?"/g, `href="/piel.css?v=${v}"`);
    if (antes !== despues) { fs.writeFileSync(p, despues); tocados += 1; }
  }
  return { v, tocados };
}

/** Los sellos que tiene cada archivo hoy. Lo usa el suite para ver si alguno quedó viejo. */
function sellosPuestos() {
  const out = {};
  for (const rel of ARCHIVOS) {
    const t = fs.readFileSync(path.join(raiz, rel), 'utf8');
    out[rel] = [...t.matchAll(/href="\/piel\.css\?v=([0-9a-f]+)"/g)].map((m) => m[1]);
  }
  return out;
}

module.exports = { sello, sellar, sellosPuestos, ARCHIVOS };
if (require.main === module) {
  const r = sellar();
  console.log(`piel sellada v=${r.v} · ${r.tocados} archivo(s) actualizado(s)`);
}
