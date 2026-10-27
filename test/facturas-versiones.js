/**
 * facturas-versiones.js — LO QUE YA SALIÓ NO SE PISA (fase 4, 27-oct-2026).
 *
 * Regenerar una factura que ya se le mandó al cliente pisaba lo que recibió y la dejaba como «ya
 * salió». Ahora, si cambian los números, la que salió se guarda como versión y la nueva queda sin
 * mandar. Con los mismos números no cambia nada.
 */
process.env.DB_PATH = require('path').join(__dirname, '..', 'data', 'test-facturas-versiones.sqlite');
['', '-wal', '-shm'].forEach((x) => { try { require('fs').unlinkSync(process.env.DB_PATH + x); } catch (e) {} });
const fg = require('../src/facturas-guardadas');
const facturaSvc = require('../src/factura.service');

let ok = 0, fail = 0;
const check = (t, c, x) => { if (c) { ok++; console.log('✅ ' + t); } else { fail++; console.log('❌ ' + t + (x !== undefined ? '  → ' + x : '')); } };
console.log('\n🧾 las versiones de una factura\n');

const factura = (cons, ext) => ({ ok: true, cliente: { id: 'c1', codigo: 'C1', nombre: 'Cliente Uno' }, mes: '2026-09', mesNombre: 'septiembre de 2026',
  consumo: { pedidos: 3, vendido_usdt: '1000', porDivisa: [{ divisa: 'USDT', vendido: '1000' }], base: '6', total_usdt: cons, comisionPorDivisa: [{ divisa: 'USDT', monto: cons, usdt: cons }] },
  externos: { total_usdt: ext, items: [], porPanel: [] }, porPanel: [], totalMes_usdt: String(Number(cons) + Number(ext)) });

const r1 = fg.guardar(factura('60', '10'));
check('la primera vez se guarda, sin versiones', r1.ok && !r1.archivada && fg.versiones('c1', '2026-09').length === 0);
const r2 = fg.guardar(factura('65', '10'));
check('si todavía no salió, regenerarla no guarda versión (era un borrador)', !r2.archivada && fg.get('c1', '2026-09').total_usdt === '75' && !fg.versiones('c1', '2026-09').length);
fg.marcarSalida('c1', '2026-09', 'telegram');
const r3 = fg.guardar(factura('65', '10'));
check('ya salió y se regenera con los MISMOS números: nada cambia, sigue como enviada', !r3.archivada && !!fg.get('c1', '2026-09').salio_at && !fg.versiones('c1', '2026-09').length);
const r4 = fg.guardar(factura('80', '12'));
const v = fg.versiones('c1', '2026-09'); const ahora = fg.get('c1', '2026-09');
check('ya salió y cambian los números: la que salió queda como versión 1, con lo que recibió el cliente', r4.archivada && v.length === 1 && v[0].version === 1 && v[0].total_usdt === '75' && v[0].salio_como === 'telegram' && !!v[0].salio_at, JSON.stringify(v[0]));
check('y la nueva queda SIN mandar (el cliente tiene la vieja)', ahora.total_usdt === '92' && !ahora.salio_at && !ahora.salio_como, JSON.stringify(ahora));
check('la versión guarda la factura entera, no sólo el total', v[0].datos && v[0].datos.consumo.total_usdt === '65');
fg.marcarSalida('c1', '2026-09', 'link'); fg.guardar(factura('90', '12'));
const v2 = fg.versiones('c1', '2026-09');
check('una segunda vez: versión 2, en orden', v2.length === 2 && v2[1].version === 2 && v2[1].total_usdt === '92' && v2[1].salio_como === 'link');
check('la fecha en que se generó por primera vez no se pisa', fg.get('c1', '2026-09').generada_at === r1.factura.generada_at);
let texto = ''; try { texto = facturaSvc.aTexto(v2[0].datos); } catch (e) { texto = 'ERROR ' + e.message; }
check('de una versión se puede armar el texto tal como salió', /TOTAL DEL MES: 75/.test(texto), texto.slice(0, 200));
console.log(`\n${ok} chequeos OK, ${fail} fallaron\n`); process.exit(fail ? 1 : 0);
