/**
 * cache-mitad-de-mes.js — LA GANANCIA TOMADA A MITAD DE MES NO ES DEFINITIVA (fase 4.5, 29-oct-2026).
 *
 * Lo que se le pidió al casino mientras el mes corría quedaba guardado y, apenas cambiaba el mes,
 * valía para siempre: los externos y el pago a proveedores salían con la mitad del mes. Ahora sólo
 * vale para siempre lo que se tomó después de que el mes terminó.
 */
process.env.DB_PATH = require('path').join(__dirname, '..', 'data', 'test-cache-mitad.sqlite');
['', '-wal', '-shm'].forEach((x) => { try { require('fs').unlinkSync(process.env.DB_PATH + x); } catch (e) {} });
const cache = require('../src/ganancias-cache');
const { db } = require('../src/db');

let ok = 0, fail = 0;
const check = (t, c, x) => { if (c) { ok++; console.log('✅ ' + t); } else { fail++; console.log('❌ ' + t + (x !== undefined ? '  → ' + x : '')); } };
console.log('\n🗓 la caché del casino a mitad de mes\n');

const ponerFecha = (nodo, mes, at) => db.prepare('UPDATE ganancias_cache SET capturedAt=? WHERE nodo=? AND mes=?').run(at, nodo, mes);
cache.set('cx', 'p1', '2026-09', 'ARS', [{ x: 1 }]); ponerFecha('p1', '2026-09', '2026-09-05T04:00:00.000Z');
cache.set('cx', 'p2', '2026-09', 'ARS', [{ x: 2 }]); ponerFecha('p2', '2026-09', '2026-10-02T02:00:00.000Z');
cache.set('cx', 'p3', '2026-09', 'ARS', [{ x: 3 }]); ponerFecha('p3', '2026-09', '2026-10-01T00:20:00.000Z');

check('tomada el 5 de septiembre: ya no vale para septiembre', cache.get('cx', 'p1', '2026-09', 'ARS') === null);
check('tomada el 2 de octubre: vale para siempre', !!cache.get('cx', 'p2', '2026-09', 'ARS'));
check('tomada a los 20 minutos de terminar el mes: todavía no (el casino tarda en asentar)', cache.get('cx', 'p3', '2026-09', 'ARS') === null);
check('esDefinitiva dice lo mismo', !cache.esDefinitiva('2026-09', '2026-09-30T23:59:00Z') && cache.esDefinitiva('2026-09', '2026-10-01T01:00:00Z'));
check('diciembre termina el 1 de enero del año siguiente', !cache.esDefinitiva('2026-12', '2026-12-31T22:00:00Z') && cache.esDefinitiva('2026-12', '2027-01-01T02:00:00Z'));
cache.set('cx', 'p1', '2026-09', 'ARS', [{ x: 9 }]);
check('al volver a pedirla, la nueva la pisa y vale', JSON.stringify((cache.get('cx', 'p1', '2026-09', 'ARS') || {}).filas) === '[{"x":9}]');
const ahora = new Date().toISOString().slice(0, 7);
cache.set('cx', 'p4', ahora, 'ARS', [{ x: 4 }]);
check('el mes en curso sigue valiendo un rato', !!cache.get('cx', 'p4', ahora, 'ARS'));

console.log(`\n${ok} chequeos OK, ${fail} fallaron`);
process.exit(fail ? 1 : 0);
