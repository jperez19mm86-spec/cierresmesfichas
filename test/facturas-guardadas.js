/**
 * test/facturas-guardadas.js — LAS FACTURAS QUEDAN GUARDADAS.
 *
 * Lo que se protege: hasta el 4-sep-2026 una factura sólo se congelaba si alguien apretaba el
 * botón del link o la mandaba por Telegram. Imprimirla a PDF —que es como se venía usando— no
 * dejaba rastro, y en todo el sistema había DOS facturas guardadas. Sin eso no hay forma de volver
 * a lo que se le cobró a un cliente hace tres meses: pedirla de nuevo la recalcula.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const tmp = path.join(os.tmpdir(), `os-fact-guard-${Date.now()}.sqlite`);
process.env.DB_PATH = tmp;

const g = require('../src/facturas-guardadas');

let fallos = 0;
const ok = (c, m) => { console.log(`${c ? '  ✔' : '  ✘'} ${m}`); if (!c) fallos++; };
const fac = (mes, total) => ({ ok: true, cliente: { id: 'c1', nombre: 'Marcelo' }, mes,
  totalMes_usdt: total, consumo: { total_usdt: total }, externos: null, detalle: [{ x: 1 }] });

console.log('\n🧾 facturas guardadas\n');

// ── se guarda con su contenido ──
g.guardar(fac('2026-08', '17959.47'), { como: 'impresa', quien: 'alexa' });
let f = g.get('c1', '2026-08');
ok(!!f, 'se guarda al imprimir');
ok(f.total_usdt === '17959.47', `con su total (${f.total_usdt})`);
ok(!!f.datos && f.datos.detalle.length === 1, 'y con la factura entera adentro, no sólo el número');
ok(f.salio_como === 'impresa' && !!f.salio_at, 'queda dicho por dónde salió');
ok(f.generada_por === 'alexa', 'y quién la generó');

// ── regenerarla actualiza el contenido pero NO la primera fecha ni la primera salida ──
const primera = f.generada_at;
g.guardar(fac('2026-08', '18000.00'), { como: 'telegram' });
f = g.get('c1', '2026-08');
ok(f.veces === 2, `cuenta las veces que se generó (${f.veces})`);
ok(f.total_usdt === '18000.00', 'actualiza el contenido');
ok(f.generada_at === primera, 'la fecha de la PRIMERA vez no se pisa');
ok(f.salio_como === 'impresa', 'ni la primera salida: importa cuándo se le mandó, no la última vez que se miró');

// ── el historial ──
g.guardar(fac('2026-07', '19570.30'), { como: 'link' });
g.guardar(fac('2026-06', '15930.00'));
const h = g.delCliente('c1');
ok(h.length === 3, `el historial trae los tres meses (${h.length})`);
ok(h[0].mes === '2026-08' && h[2].mes === '2026-06', 'del más nuevo al más viejo');
ok(!h[0].datos, 'el listado NO arrastra el JSON entero de cada factura');
ok(!!g.delCliente('c1', { conDatos: true })[0].datos, 'pero se puede pedir con contenido');

// ── una generada y no enviada se distingue ──
const jun = h.find((x) => x.mes === '2026-06');
ok(jun && !jun.salio_at, 'una generada que nunca salió queda marcada como tal');
g.marcarSalida('c1', '2026-06', 'telegram');
ok(g.get('c1', '2026-06').salio_como === 'telegram', 'y se puede marcar después');

// ── el mes ──
ok(g.delMes('2026-08').length === 1, 'se pueden listar las de un mes, para ver a quién falta');

try { fs.unlinkSync(tmp); fs.unlinkSync(`${tmp}-wal`); fs.unlinkSync(`${tmp}-shm`); } catch (e) { /* da igual */ }
console.log(fallos ? `\n❌ ${fallos} fallo(s)\n` : '\n✅ todo bien\n');
process.exit(fallos ? 1 : 0);
