/**
 * caja-panel.js — LA CAJA Y EL PANEL SON LA MISMA CUENTA, Y DICEN LO MISMO.
 *
 * Hasta el 22-oct-2026 había dos copiadores con reglas distintas: renombrar una caja y después tocar
 * el panel le devolvía a la caja el nombre viejo; mover un panel a otro cliente creaba una caja
 * nueva (sin sus permisos) y dejaba la vieja; y la Revisión comparaba por nombre, así que avisaba
 * de más y no veía dos cuentas que se llaman igual. Ver src/cuenta-espejo.js.
 */
process.env.DB_PATH = require('path').join(__dirname, '..', 'data', 'test-caja-panel.sqlite');
['', '-wal', '-shm'].forEach((x) => { try { require('fs').unlinkSync(process.env.DB_PATH + x); } catch (e) {} });
// El árbol del casino no se resuelve acá: no hay casino.
require.cache[require.resolve('../src/arbol.service')] = { exports: { resolverEnSegundoPlano: () => {} } };

const clientes = require('../src/clientes-store');
const paneles = require('../src/paneles-store');
const esp = require('../src/cuenta-espejo');

let ok = 0, fail = 0;
const check = (t, c, x) => { if (c) { ok++; console.log('✅ ' + t); } else { fail++; console.log('❌ ' + t + (x !== undefined ? '  → ' + x : '')); } };
console.log('\n🔗 caja y panel: la misma cuenta\n');

const A = clientes.createCliente({ codigo: 'CA', nombre: 'Cliente A' });
const B = clientes.createCliente({ codigo: 'CB', nombre: 'Cliente B' });
const panelDe = (cid, id) => paneles.list({ cliente_id: cid }).find((p) => String(p.id_usuario) === String(id));
const cajaDe = (cid, id) => (clientes.get(cid).cajas || []).find((k) => String(k.userId) === String(id));

// ── De la caja al panel ────────────────────────────────────────────────────────────────────────
let k = clientes.addCaja(A.id, { usuario: 'Royal-SA', sistema: 'Casino', userId: '1001', divisas: 'ARS' });
check('una caja nueva crea su panel', esp.cajaAPanel(A.id, k) === 'creado');
let p = panelDe(A.id, '1001');
check('el panel nace con el login en nombre y en usuario', p && p.nombre === 'Royal-SA' && p.usuario === 'Royal-SA');
k = clientes.updateCaja(A.id, k.id, { usuario: 'RoyalNuevo-SA', divisas: 'ARS,USD' });
esp.cajaAPanel(A.id, k);
p = panelDe(A.id, '1001');
check('renombrar la caja renombra el panel, nombre Y usuario', p.nombre === 'RoyalNuevo-SA' && p.usuario === 'RoyalNuevo-SA', JSON.stringify([p.nombre, p.usuario]));
check('y le pasa las monedas', p.divisas.join(',') === 'ARS,USD');

// El caso que antes volvía atrás: después de renombrar la caja, se toca el panel.
p = paneles.update(p.id, { en_foto: false });
esp.panelACaja(p);
check('tocar el panel después no le devuelve a la caja el nombre viejo', cajaDe(A.id, '1001').usuario === 'RoyalNuevo-SA', cajaDe(A.id, '1001').usuario);

// ── Del panel a la caja, y mover ───────────────────────────────────────────────────────────────
const p2 = paneles.create({ cliente_id: A.id, nombre: 'Luna-SA', sistema: 'Casino', id_usuario: '2002', divisas: ['ARS'] });
check('un panel nuevo crea su caja', esp.panelACaja(p2) === true && !!cajaDe(A.id, '2002'));
const k2 = cajaDe(A.id, '2002');
clientes.updateCaja(A.id, k2.id, { permisos: { pedir: true, pagos: true, cuenta: true }, etiqueta: 'Luna' });
const movido = paneles.update(p2.id, { cliente_id: B.id });
check('mover el panel muda la caja', esp.panelACaja(movido, { desde: A.id }) === 'movida');
check('el cliente viejo ya no la tiene', !cajaDe(A.id, '2002'));
const k2b = cajaDe(B.id, '2002');
check('el nuevo la tiene con el mismo id, sus permisos y su nombre', k2b && k2b.id === k2.id && k2b.permisos.cuenta === true && k2b.etiqueta === 'Luna',
  JSON.stringify(k2b));

// Cuenta compartida: el destino ya tiene su caja → la del cliente viejo se queda (Marcelo y JJ).
const k3a = clientes.addCaja(A.id, { usuario: 'Celu-SA', sistema: 'Casino', userId: '3003', divisas: 'ARS' });
clientes.addCaja(B.id, { usuario: 'Celu-SA', sistema: 'Casino', userId: '3003', divisas: 'ARS' });
const p3 = paneles.create({ cliente_id: A.id, nombre: 'Celu-SA', usuario: 'Celu-SA', sistema: 'Casino', id_usuario: '3003', divisas: ['ARS'] });
esp.panelACaja(paneles.update(p3.id, { cliente_id: B.id }), { desde: A.id });
check('si el nuevo ya tiene la caja, la del viejo se queda', !!cajaDe(A.id, '3003') && cajaDe(A.id, '3003').id === k3a.id);

// ── Lo que ve la Revisión ──────────────────────────────────────────────────────────────────────
// Dos cuentas que se llaman igual, una sin panel (como la segunda Betpalace-SA de CARLOS777).
clientes.addCaja(A.id, { usuario: 'RoyalNuevo-SA', sistema: 'Casino', userId: '1009', divisas: 'ARS' });
// Una de distribuidor: no es panel a propósito.
clientes.addCaja(A.id, { usuario: 'Dist-D', sistema: 'Casino', userId: '4004', divisas: 'ARS', rol: 'distribuidor' });
// Un panel de la tabla con el usuario vacío (como los 43 del árbol): no es una diferencia.
paneles.create({ cliente_id: B.id, nombre: 'Sol-SA', sistema: 'Casino', id_usuario: '5005', divisas: ['ARS'] });
clientes.addCaja(B.id, { usuario: 'Sol-SA', sistema: 'Casino', userId: '5005', divisas: 'ARS' });
const d = esp.diferencias();
check('ve la cuenta con caja y sin panel aunque otra se llame igual', d.sinPanel.length === 1 && d.sinPanel[0].id === '1009', JSON.stringify(d.sinPanel));
check('no avisa por la del distribuidor', !d.sinPanel.some((x) => x.id === '4004'));
check('no avisa por la cuenta compartida', !d.enOtroCliente.length, JSON.stringify(d.enOtroCliente));
check('no avisa por un panel con el usuario vacío', !d.distintas.length, JSON.stringify(d.distintas));
check('nada sin caja ni sin id', !d.sinCaja.length && !d.sinId.length, JSON.stringify([d.sinCaja, d.sinId]));

console.log(`\n${ok} chequeos OK, ${fail} fallaron\n`); process.exit(fail ? 1 : 0);
