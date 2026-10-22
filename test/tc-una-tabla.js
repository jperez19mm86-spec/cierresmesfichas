/**
 * tc-una-tabla.js — EL TC DEL PROVEEDOR VIVE EN UN SOLO LUGAR: LA GRILLA DEL CIERRE (fila ARS_OF).
 *
 * Hasta el 22-oct-2026 se copiaba a tc_mes.tc_proveedor_ext adentro de un try que tragaba el error,
 * y borrar o renombrar en la grilla no llegaba a la copia: externos y el paso del cierre seguían
 * leyendo un número que en la grilla ya no estaba. Además había dos formas de buscar un mes en la
 * grilla, y una no reconocía «Julio_26»: podía nacer una segunda columna para el mismo mes.
 */
process.env.DB_PATH = require('path').join(__dirname, '..', 'data', 'test-tc-una-tabla.sqlite');
['', '-wal', '-shm'].forEach((x) => { try { require('fs').unlinkSync(process.env.DB_PATH + x); } catch (e) {} });
const fs = require('fs'); const path = require('path');
const { db } = require('../src/db');
const cierre = require('../src/cierre-store');
const tcStore = require('../src/tc-store');
const tcu = require('../src/tc-unico.service');
const { esColumnaDe } = require('../src/lib/fechas');

let ok = 0, fail = 0;
const check = (t, c, x) => { if (c) { ok++; console.log('✅ ' + t); } else { fail++; console.log('❌ ' + t + (x !== undefined ? '  → ' + x : '')); } };
console.log('\n💱 el TC del proveedor en una sola tabla\n');

tcStore.addSnapshot({ tc_ars_usdt: '1574.42', fecha: '2026-07-15', hora: '18:00' });
const ext = () => tcu.tcExternos('ARS', '2026-07', 'RUBYPLAY OP').valor;

cierre.setTC('ARS_OF', 'Julio_2026', '1485.44', true);
check('externos usa el de la grilla', ext() === '1485.44', ext());
check('el paso del cierre lo encuentra', (tcu.tcProveedorDelMes ? tcu.tcProveedorDelMes('2026-07') : undefined) === '1485.44');
check('el cierre mensual muestra el de la grilla', (tcStore.getMes('2026-07') || {}).tc_proveedor_ext === '1485.44',
  JSON.stringify(tcStore.getMes('2026-07')));
check('no se copia a tc_mes', !(db.prepare('SELECT tc_proveedor_ext FROM tc_mes WHERE mes=?').get('2026-07') || {}).tc_proveedor_ext);

// Lo que antes se quedaba en la copia: renombrar y borrar.
cierre.renombrarMesTC('Julio_2026', 'Julio_26');
check('renombrado a «Julio_26», sigue siendo julio', ext() === '1485.44', ext());
cierre.removeMesTC('Julio_26');
check('borrado en la grilla, externos ya no lo ve', ext() === '1574.42', ext());
check('y el cierre mensual tampoco', (tcStore.getMes('2026-07') || {}).tc_proveedor_ext == null);
check('y el paso del cierre avisa que falta', (tcu.tcProveedorDelMes ? tcu.tcProveedorDelMes('2026-07') : undefined) === null);

// Un mismo mes no puede tener dos columnas.
check('«Julio_26», «julio_2026» y « JULIO_2026 » son julio', esColumnaDe('Julio_26', '2026-07') && esColumnaDe('julio_2026', '2026-07') && esColumnaDe(' JULIO_2026 ', '2026-07'));
check('«Junio_2026» no es julio', !esColumnaDe('Junio_2026', '2026-07') && !esColumnaDe('Julio_2025', '2026-07'));
db.prepare("INSERT INTO tc_divisa_snapshots (divisa, fecha, tasa, fuente) VALUES ('UYU','2026-07-15','40.1','prueba')").run();
cierre.setTC('UYU', 'Julio_26', '39.9', true);
const r = require('../src/tc-columna.service').armarColumna('2026-07');
const meses = cierre.getTC().meses;
check('armar la columna de julio no crea «Julio_2026» si ya está «Julio_26»', r.ok && !meses.includes('Julio_2026'), JSON.stringify(meses));

// Que nadie vuelva a escribir la copia.
const SRC = path.join(__dirname, '..', 'src');
const escriben = fs.readdirSync(SRC).filter((f) => f.endsWith('.js') && f !== 'db.js')
  .filter((f) => /SET[^;`]*tc_proveedor_ext\s*=|setTcProveedor/.test(fs.readFileSync(path.join(SRC, f), 'utf8')));
check('ningún módulo escribe tc_mes.tc_proveedor_ext', !escriben.length, escriben.join(', '));

console.log(`\n${ok} chequeos OK, ${fail} fallaron\n`); process.exit(fail ? 1 : 0);
