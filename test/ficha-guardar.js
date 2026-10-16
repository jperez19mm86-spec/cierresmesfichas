/**
 * ficha-guardar.js — GUARDAR LA FICHA NO PUEDE BORRAR LO QUE NO SE TOCÓ.
 *
 * La ficha se dibuja con la lista GET /api/os/clientes y el botón Guardar (saveCli) manda TODAS sus
 * claves. Si una clave no viaja en la lista, la ficha la dibuja vacía y al guardar la pisa: así se
 * perdían el prepago, el abono por carga y las divisas de pago (auditoría 17-oct-2026).
 * Chequeo estático: cada clave de saveCli tiene que estar en la lista.
 */
const fs = require('fs'); const path = require('path');
const html = fs.readFileSync(path.join(__dirname, '../public/os.html'), 'utf8');
const rutas = fs.readFileSync(path.join(__dirname, '../src/os.routes.js'), 'utf8');
let ok = 0, fail = 0;
const check = (t, c, x) => { if (c) { ok++; console.log('✅ ' + t); } else { fail++; console.log('❌ ' + t + (x ? '  → ' + x : '')); } };
console.log('\n🗂 guardar la ficha no borra nada\n');
const save = html.slice(html.indexOf('async function saveCli('), html.indexOf('async function saveCli(') + 4000);
const cuerpo = save.slice(save.indexOf('JSON.stringify({'), save.indexOf('})});'));
const claves = [...cuerpo.matchAll(/(?:^|[\s,{(])([a-z_]+)\s*:/g)].map((m) => m[1]).filter((k) => !['method', 'body'].includes(k));
const ini = rutas.indexOf("app.get('/api/os/clientes', ");
const lista = rutas.slice(ini, rutas.indexOf('ok(res, { clientes: list })', ini));
check('saveCli manda claves', claves.length > 20, claves.length);
const faltan = claves.filter((k) => !new RegExp('\\b' + k + '\\s*:').test(lista));
check('cada clave que guarda la ficha viene en la lista de clientes', !faltan.length, faltan.join(', '));
console.log(`\n${ok} chequeos OK, ${fail} fallaron\n`); process.exit(fail ? 1 : 0);
