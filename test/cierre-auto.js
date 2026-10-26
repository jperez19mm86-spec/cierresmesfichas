/**
 * cierre-auto.js — LO QUE EL CIERRE HACE SOLO DESPUÉS DE LA FOTO (26-oct-2026).
 *
 * Apenas la foto del mes está completa corren, en segundo plano, el contraste contra los paneles y
 * el cálculo del pago a proveedores. Acá se prueba con el casino de mentira: que corran una sola vez
 * aunque la foto avise varias, que lo que pasó quede anotado, y que si uno falla no tire nada.
 */
process.env.DB_PATH = require('path').join(__dirname, '..', 'data', 'test-cierre-auto.sqlite');
['', '-wal', '-shm'].forEach((x) => { try { require('fs').unlinkSync(process.env.DB_PATH + x); } catch (e) {} });

let ok = 0, fail = 0;
const check = (t, c, x) => { if (c) { ok++; console.log('✅ ' + t); } else { fail++; console.log('❌ ' + t + (x !== undefined ? '  → ' + x : '')); } };
console.log('\n⚙ el cierre después de la foto\n');

const llamadas = [];
let contrasteFalla = false;
require.cache[require.resolve('../src/cruce-panel.service')] = { exports: {
  cruzarMes: async (mes) => { llamadas.push('contraste ' + mes); await new Promise((r) => setTimeout(r, 30)); if (contrasteFalla) throw new Error('el casino no contestó'); return { ok: true, clientesConDiferencias: 2 }; },
  guardar: () => llamadas.push('guardar'),
} };
require.cache[require.resolve('../src/pago-proveedores.service')] = { exports: {
  precargar: async ({ conexion_id, desde }) => { llamadas.push('pago ' + conexion_id + ' ' + desde); return desde ? { ok: true, hechos: 2, total: 2, faltan: 0 } : { ok: true, hechos: 1, total: 2, faltan: 1 }; },
} };
const casinoConex = require('../src/casino-conexiones-store');
const paneles = require('../src/paneles-store');
casinoConex.list = () => [{ id: 'cx1', nombre: 'Casino', activa: true }, { id: 'cx2', nombre: 'Sin paneles', activa: true }];
paneles.list = () => [{ id: 'p1', conexion_id: 'cx1' }];
const auto = require('../src/cierre-auto.service');

(async () => {
  check('si la foto no está completa no hace nada', auto.siLaFotoEstaCompleta('2026-09', false) === false && !llamadas.length);
  check('completa: arranca en segundo plano', auto.siLaFotoEstaCompleta('2026-09', true) === true);
  auto.siLaFotoEstaCompleta('2026-09', true);   // otra tanda de la foto avisa de nuevo
  await new Promise((r) => setTimeout(r, 120));
  check('corre el contraste una sola vez aunque la foto avise dos', llamadas.filter((x) => x.startsWith('contraste')).length === 1, llamadas.join(','));
  check('y lo guarda', llamadas.includes('guardar'));
  check('el pago se calcula por tandas, sólo en las conexiones con paneles', llamadas.filter((x) => x.startsWith('pago')).join('|') === 'pago cx1 0|pago cx1 1', llamadas.join(','));
  const e = auto.estado('2026-09');
  check('queda anotado lo que pasó', e && !e.corriendo && e.contraste.ok && e.contraste.conDiferencias === 2 && e.pago.ok, JSON.stringify(e));
  contrasteFalla = true; llamadas.length = 0;
  await auto.trasLaFoto('2026-10');
  const e2 = auto.estado('2026-10');
  check('si el contraste falla, no tira nada: lo anota y el pago se calcula igual', e2 && e2.contraste.ok === false && /no contestó/.test(e2.contraste.error) && e2.pago.ok, JSON.stringify(e2));
  check('un mes inválido no hace nada', (await auto.trasLaFoto('cualquiera')) === undefined && !auto.estado('cualquiera'));
  console.log(`\n${ok} chequeos OK, ${fail} fallaron\n`); process.exit(fail ? 1 : 0);
})();
