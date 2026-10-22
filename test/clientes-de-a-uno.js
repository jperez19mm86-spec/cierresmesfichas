/**
 * clientes-de-a-uno.js — GUARDAR UN CLIENTE NO TOCA A LOS DEMÁS.
 *
 * Hasta el 22-oct-2026 cada guardado borraba la tabla de clientes y volvía a insertar a todos.
 * Una columna que faltaba en una de las dos listas a mano (la de leer y la de guardar) se perdía
 * para TODOS en el próximo guardado de cualquiera: pasó con externos_modo y con el acceso.
 * Ahora hay una sola lista de columnas y se escribe sólo la fila del cliente que cambió.
 */
process.env.DB_PATH = require('path').join(__dirname, '..', 'data', 'test-de-a-uno.sqlite');
['', '-wal', '-shm'].forEach((x) => { try { require('fs').unlinkSync(process.env.DB_PATH + x); } catch (e) {} });

const { db } = require('../src/db');
const clientes = require('../src/clientes-store');
const acceso = require('../src/cliente-acceso');

let ok = 0, fail = 0;
const check = (t, c, extra) => { if (c) { ok++; console.log('✅ ' + t + (extra && extra.length < 80 ? '  → ' + extra : '')); }
  else { fail++; console.log('❌ ' + t + (extra ? '  → ' + extra : '')); } };
console.log('\n🧍 el cliente se guarda de a uno\n');

// ── 1. La lista de columnas del store es exactamente la tabla ─────────────────────────────────
// Agregar una columna en db.js sin sumarla a COLUMNAS (o al revés) tiene que romper acá.
{
  const tabla = db.prepare('PRAGMA table_info(clientes)').all().map((x) => x.name).filter((n) => n !== 'ord');
  const store = (clientes.COLUMNAS || []).map(([col]) => col);
  const faltan = tabla.filter((n) => !store.includes(n));
  const sobran = store.filter((n) => !tabla.includes(n));
  check('la lista de columnas del store es la de la tabla', store.length > 40 && !faltan.length && !sobran.length,
    faltan.length ? 'el store no conoce: ' + faltan.join(', ') : sobran.length ? 'la tabla no tiene: ' + sobran.join(', ') : store.length + ' columnas');
}

// ── 2. El padrón de la prueba ─────────────────────────────────────────────────────────────────
const A = clientes.createCliente({ codigo: 'AAA', nombre: 'Cliente A' });
const B = clientes.createCliente({ codigo: 'BBB', nombre: 'Cliente B' });
clientes.updateComercial(B.id, { prepago: true, prepago_margen_pct: '3', tc_cargas: 'momento', tope_deuda: '1500',
  moneda_cuenta: 'ARS', abona_a: A.id, abona_pts: '2', externos_modo: 'por_login', divisas_pago: 'ARS', momento_pago: 'anticipado' });
clientes.setTelegram(B.id, { chatId: '-100', enabled: true, copias: '-200, -300' });
clientes.addCaja(B.id, { usuario: 'CajaB', sistema: 'casino', userId: '777', divisas: 'ARS,USD' });
acceso.habilitar ? acceso.habilitar(B.id, { usuario: 'clienteb' }) : null;
// Una columna que el store no conoce (como fue externos_modo el día que se agregó).
db.exec('ALTER TABLE clientes ADD COLUMN columna_nueva TEXT');
db.prepare("UPDATE clientes SET columna_nueva='no me borres' WHERE id=?").run(B.id);

const filaB = () => db.prepare('SELECT rowid AS _rowid, * FROM clientes WHERE id=?').get(B.id);
const antes = JSON.stringify(filaB());

// ── 3. Todo lo que se le puede hacer a A no le cambia un byte a B ─────────────────────────────
const pasos = [
  ['cambiar el nombre', () => clientes.updateCliente(A.id, { nombre: 'Cliente A2', nombreVisible: 'A2' })],
  ['cambiar la ficha', () => clientes.updateComercial(A.id, { estado: 'activo', tope_deuda: '900', prepago: true })],
  ['cambiar el Telegram', () => clientes.setTelegram(A.id, { chatId: '-999', enabled: true })],
  ['agregar una caja', () => clientes.addCaja(A.id, { usuario: 'CajaA', sistema: 'casino', userId: '888' })],
  ['editar la caja', () => { const k = clientes.get(A.id).cajas[0]; clientes.updateCaja(A.id, k.id, { notas: 'x', permisos: { pedir: true } }); }],
  ['ponerle nombre a la cuenta', () => clientes.setEtiquetaCuenta('casino', '888', 'Royal')],
  ['sacar la caja', () => { const k = clientes.get(A.id).cajas[0]; clientes.removeCaja(A.id, k.id); }],
  ['dar de alta otro y borrarlo', () => { const C = clientes.createCliente({ codigo: 'CCC' }); clientes.removeCliente(C.id); }],
  ['importar filas', () => clientes.importRows([{ codigo: 'AAA', usuario: 'CajaA2', sistema: 'casino', userId: '889' }])],
];
for (const [qué, fn] of pasos) {
  fn();
  const ahora = JSON.stringify(filaB());
  check(`${qué} a A no cambia nada de B`, ahora === antes, ahora === antes ? '' : ahora);
}
// Congelar permisos sí tiene que tocar a B (su caja no tenía): se vuelve a medir desde acá.
clientes.congelarPermisosActuales();
check('congelar permisos sí le escribe a B lo suyo', (clientes.get(B.id).cajas[0].permisos || {}).pagos === true);
const antes2 = JSON.stringify(filaB());
clientes.updateComercial(A.id, { tope_deuda: '1000' });
check('después de eso, guardar A sigue sin tocar a B', JSON.stringify(filaB()) === antes2);
check('la columna que el store no conoce sigue ahí', filaB().columna_nueva === 'no me borres');

// ── 4. Lo que el objeto dice, después de guardar, es lo mismo que se guardó ───────────────────
{
  const b = clientes.get(B.id);
  check('B conserva lo suyo', b.prepago === true && b.prepago_margen_pct === '3' && b.tc_cargas === 'momento'
    && b.tope_deuda === '1500' && b.moneda_cuenta === 'ARS' && b.abona_pts === '2' && b.externos_modo === 'por_login'
    && JSON.stringify(b.divisas_pago) === '["ARS"]' && JSON.stringify(b.telegram.copias) === '["-200","-300"]'
    && clientes.tcCargasDe(b) === 'momento', JSON.stringify(b).slice(0, 300));
  check('el orden sigue siendo el de alta', clientes.list().clientes.map((c) => c.codigo).join(',') === 'AAA,BBB');
}

// ── 5. La lista entera (restaurar una copia) ──────────────────────────────────────────────────
{
  const todo = clientes.list();
  const r0 = JSON.stringify(db.prepare('SELECT rowid AS _rowid, * FROM clientes ORDER BY id').all());
  clientes.seed(todo);
  check('volver a guardar la misma lista no reescribe ninguna fila',
    JSON.stringify(db.prepare('SELECT rowid AS _rowid, * FROM clientes ORDER BY id').all()) === r0);
  clientes.seed({ clientes: [todo.clientes[1], todo.clientes[0]] });
  check('guardar la lista en otro orden cambia el orden', clientes.list().clientes.map((c) => c.codigo).join(',') === 'BBB,AAA');
  clientes.seed({ clientes: [todo.clientes[1]] });
  check('guardar una lista sin un cliente lo saca', clientes.list().clientes.map((c) => c.codigo).join(',') === 'BBB');
  check('y a los que quedan no los toca', filaB().columna_nueva === 'no me borres');
}

console.log(`\n${ok} chequeos OK, ${fail} fallaron\n`); process.exit(fail ? 1 : 0);
