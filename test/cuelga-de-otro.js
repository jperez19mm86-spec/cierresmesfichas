/**
 * cuelga-de-otro.js — UN CLIENTE QUE CUELGA DE OTRO.
 *
 * Fran/Ariel: Ariel trabaja al 14, su consumo lo paga Fran (a quien se le cobra 12) y los 2 puntos
 * son la ganancia de Fran. Marcelo/JJ: lo mismo, pero JJ conserva sus propios precios de
 * proveedores porque de verdad difieren.
 *
 * Lo que se prueba acá es lo que ANTES funcionaba de casualidad: que la carga se le facture a
 * quien paga se apoyaba en que alguien tipeara el código correcto al cargar el pedido.
 */
const assert = require('assert');
process.env.DB_PATH = require('path').join(__dirname, '..', 'data', 'test-cuelga.sqlite');
['', '-wal', '-shm'].forEach((x) => { try { require('fs').unlinkSync(process.env.DB_PATH + x); } catch (e) {} });

const { db } = require('../src/db');
const clientes = require('../src/clientes-store');
const paneles = require('../src/paneles-store');
const pedidos = require('../src/pedidos-store');
const externos = require('../src/externos.service');
const cierre = require('../src/cierre-store');

let ok = 0, fail = 0;
const check = (t, c, extra) => { if (c) { ok++; console.log('✅ ' + t + (extra ? '  → ' + extra : '')); }
  else { fail++; console.log('❌ ' + t + (extra ? '  → ' + extra : '')); } };

// ── el padrón de la prueba ──────────────────────────────────────────────────────────────────
const fran = clientes.createCliente({ codigo: 'FRANT', nombre: 'FranT' });
const ariel = clientes.createCliente({ codigo: 'ARIELT', nombre: 'ArielT' });
const suelto = clientes.createCliente({ codigo: 'SUELT', nombre: 'SueltoT' });
const pa = paneles.create({ nombre: 'PanelDeAriel', cliente_id: ariel.id, id_usuario: '900001' });
assert(pa && pa.id, 'no se pudo crear el panel');

const MES = '2026-08';
/* El pedido se guarda como JSON en una sola columna, así que se arma con el propio store: meterlo
   con SQL a mano probaría una forma que el sistema no usa. Sólo el estado y la fecha se fijan
   después, que es lo que lo pone en el mes. */
const meter = (codigo, userId, monto, dia) => {
  const p = pedidos.create({ codigo, userId: String(userId), divisa: 'ARS', monto: String(monto),
    cajaUsuario: 'PanelDeAriel', clienteNombre: codigo });
  const fecha = MES + '-' + dia + 'T12:00:00.000Z';
  const fila = db.prepare('SELECT data FROM pedidos WHERE id=?').get(p.id);
  const d = JSON.parse(fila.data);
  d.estado = 'cargado'; d.resueltoAt = fecha; d.createdAt = fecha;
  db.prepare('UPDATE pedidos SET data=? WHERE id=?').run(JSON.stringify(d), p.id);
  return p;
};

// ── 1 · sin factura_a, la carga se le cobra a quien dice el código ──────────────────────────
meter('ARIELT', '900001', 1000, '05');
let r = pedidos.ventasDelMesPorCliente(MES);
check('sin factura_a: la carga con el código de Ariel se le cobra a Ariel',
  !!r.porCliente[ariel.id] && !r.porCliente[fran.id],
  'ese es el agujero: alcanzaba con tipear otro código');

// ── 2 · con factura_a, va a quien paga de verdad ────────────────────────────────────────────
clientes.updateComercial(ariel.id, { factura_a: fran.id });
r = pedidos.ventasDelMesPorCliente(MES);
check('con factura_a: la misma carga se le cobra a Fran',
  !!r.porCliente[fran.id] && !r.porCliente[ariel.id]);
check('el desvío queda anotado, no es silencioso',
  r.ruteadas.some((x) => x.porFacturaA && x.aCliente === 'FranT'),
  JSON.stringify(r.ruteadas.map((x) => x.deCodigo + '→' + x.aCliente)));
check('el monto llega entero, no se parte ni se duplica',
  Math.round(r.porCliente[fran.id].porDivisa.ARS) === 1000,
  String(r.porCliente[fran.id] && r.porCliente[fran.id].porDivisa.ARS));

// ── 3 · sigue UN salto: una cadena no se persigue ───────────────────────────────────────────
clientes.updateComercial(fran.id, { factura_a: suelto.id });
r = pedidos.ventasDelMesPorCliente(MES);
check('la cadena no se persigue: Ariel→Fran para en Fran, no sigue a Suelto',
  !!r.porCliente[fran.id] && !r.porCliente[suelto.id],
  'un salto y basta: una cadena sin tope se cuelga con un ciclo mal cargado');
clientes.updateComercial(fran.id, { factura_a: '' });

// ── 4 · apuntar a sí mismo no rompe el ruteo ────────────────────────────────────────────────
db.prepare('UPDATE clientes SET factura_a=? WHERE id=?').run(ariel.id, ariel.id);
r = pedidos.ventasDelMesPorCliente(MES);
check('apuntarse a sí mismo no hace desaparecer la carga',
  !!r.porCliente[ariel.id] && Math.round(r.porCliente[ariel.id].porDivisa.ARS) === 1000);
clientes.updateComercial(ariel.id, { factura_a: fran.id });

// ── 5 · los precios de externos se LEEN del otro ────────────────────────────────────────────
cierre.addProveedor('PROV UNO', '5');
cierre.addProveedor('PROV DOS', '5');
cierre.setCelda('PROV UNO', 'FranT', '15');
cierre.setCelda('PROV DOS', 'FranT', '12');

let p = externos.pctsDelCliente('ArielT', MES);
check('sin externos_precios_de: Ariel no tiene una sola celda',
  Object.keys(p.celdas).length === 0 && p.columnaPrestada === false);

clientes.updateComercial(ariel.id, { externos_precios_de: fran.id });
p = externos.pctsDelCliente('ArielT', MES);
check('con externos_precios_de: usa las celdas de Fran',
  Object.keys(p.celdas).length === 2 && p.columna === 'FranT' && p.columnaPrestada === true,
  JSON.stringify(p.celdas));

// Se LEEN, no se copian: tocar el precio de Fran mueve el de Ariel en el acto.
cierre.setCelda('PROV UNO', 'FranT', '17');
p = externos.pctsDelCliente('ArielT', MES);
check('se leen y no se copian: cambiar el precio de Fran cambia el de Ariel',
  String(p.celdas[Object.keys(p.celdas).find((k) => /uno/i.test(k))]) === '17');

// ── 6 · el que tiene los suyos los conserva (Marcelo/JJ) ────────────────────────────────────
cierre.setCelda('PROV UNO', 'ArielT', '9');
p = externos.pctsDelCliente('ArielT', MES);
check('el puntero manda sobre la columna propia si está puesto',
  String(p.celdas[Object.keys(p.celdas).find((k) => /uno/i.test(k))]) === '17',
  'apuntar a otro es una decisión explícita: si querés los tuyos, sacá el puntero');
clientes.updateComercial(ariel.id, { externos_precios_de: '' });
p = externos.pctsDelCliente('ArielT', MES);
check('sin el puntero vuelve a los suyos',
  String(p.celdas[Object.keys(p.celdas).find((k) => /uno/i.test(k))]) === '9' && p.columnaPrestada === false);

// ── 7 · el puntero sobrevive a renombrar al que paga ────────────────────────────────────────
// Se renombra por el mismo camino que la app: `updateComercial` cambia el nombre y la cascada le
// arrastra la columna de la matriz. Sin la cascada el cliente pierde sus % igual que siempre —
// eso no es lo que se prueba acá; lo que se prueba es que el PUNTERO no quede colgado.
clientes.updateComercial(ariel.id, { externos_precios_de: fran.id });
const antesDelRenombre = clientes.get(fran.id);
const despues = clientes.updateComercial(fran.id, { nombre: 'FranRenombrado' });
require('../src/clientes-cascada').arrastrarRenombre(antesDelRenombre, despues);
p = externos.pctsDelCliente('ArielT', MES);
check('renombrar al que presta los precios no deja el puntero colgado',
  p.columna === 'FranRenombrado' && Object.keys(p.celdas).length === 2,
  'por eso se guarda el id y no el nombre');

console.log('\n=== ' + ok + '/' + (ok + fail) + ' checks OK ===');
process.exit(fail ? 1 : 0);
