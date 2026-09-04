/**
 * test/factura-cruce.js — EL DETALLE DE LA FACTURA Y EL CRUCE CONTRA EL PANEL.
 *
 * Lo que se protege es el agujero que apareció el 2-sep-2026: el puente al sistema en línea dejó
 * de autenticar, `armar` se comió el 401 en silencio y la factura salió con el total correcto y
 * **cero líneas de detalle**. El cliente recibía un número sin nada que auditar y nadie se
 * enteraba, porque el total seguía estando bien.
 *
 * Corre contra una base descartable (DB_PATH) sembrada con pedidos de forma real, y contra un
 * casino de MENTIRA que además grita si alguna vez le llega un parámetro que mueve fichas.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const tmp = path.join(os.tmpdir(), `os-factura-cruce-${Date.now()}.sqlite`);
process.env.DB_PATH = tmp;

const { db } = require('../src/db');
const pedidosStore = require('../src/pedidos-store');
const casinoConex = require('../src/casino-conexiones-store');

let fallos = 0;
const ok = (cond, msg) => { console.log(`${cond ? '  ✔' : '  ✘'} ${msg}`); if (!cond) fallos++; };

// ── el padrón ──────────────────────────────────────────────────────────────
const CLIENTE = { id: 'c_marce', codigo: 'MARCELO44', nombre: 'Marcelo', nombreVisible: 'Marcelo' };
db.prepare('INSERT INTO clientes (id,codigo,nombreVisible,createdAt,ord) VALUES (?,?,?,?,0)')
  .run(CLIENTE.id, CLIENTE.codigo, CLIENTE.nombre, new Date().toISOString());
db.prepare('UPDATE clientes SET nombre=? WHERE id=?').run(CLIENTE.nombre, CLIENTE.id);
db.prepare(`INSERT INTO paneles (id,cliente_id,nombre,sistema,id_usuario,conexion_id,divisas,createdAt,ord)
            VALUES (?,?,?,?,?,?,?,?,0)`)
  .run('p_luwin', CLIENTE.id, 'LuWinCasino-SA', 'Casino', '9235765', 'cx_test', JSON.stringify(['ARS', 'USD']), new Date().toISOString());
db.prepare(`INSERT INTO paneles (id,cliente_id,nombre,sistema,id_usuario,conexion_id,divisas,createdAt,ord)
            VALUES (?,?,?,?,?,?,?,?,1)`)
  .run('p_celu', CLIENTE.id, 'Celuapuestas-SA', 'Casino', '9099270', 'cx_test', JSON.stringify(['ARS']), new Date().toISOString());

// ── el vendedor y un cliente que cuelga de su SuperAgente ──
// Es el caso 21luciadm → IgLatamAlexa: las fichas le bajan al cliente por el árbol del vendedor.
// NO es un movimiento interno que se pueda descartar: es la entrega de una carga que SÍ se factura.
const VEND = { id: 'c_alexa', codigo: 'ALEXA777', nombre: 'Alexa' };
const LUCIA = { id: 'c_lucia', codigo: 'LUCIA72', nombre: 'Lucia' };
for (const c of [VEND, LUCIA]) {
  db.prepare('INSERT INTO clientes (id,codigo,nombreVisible,createdAt,ord) VALUES (?,?,?,?,0)')
    .run(c.id, c.codigo, c.nombre, new Date().toISOString());
  db.prepare('UPDATE clientes SET nombre=? WHERE id=?').run(c.nombre, c.id);
}
db.prepare('UPDATE clientes SET es_vendedor=1 WHERE id=?').run(VEND.id);
db.prepare(`INSERT INTO paneles (id,cliente_id,nombre,sistema,id_usuario,conexion_id,divisas,createdAt,ord)
            VALUES (?,?,?,?,?,?,?,?,2)`)
  .run('p_sa_alexa', VEND.id, 'IgLatamAlexa', 'Casino', '111', 'cx_test', JSON.stringify(['ARS']), new Date().toISOString());
db.prepare(`INSERT INTO paneles (id,cliente_id,nombre,sistema,id_usuario,conexion_id,divisas,createdAt,ord)
            VALUES (?,?,?,?,?,?,?,?,3)`)
  .run('p_lucia', LUCIA.id, '21luciadm', 'Casino', '222', 'cx_test', JSON.stringify(['ARS']), new Date().toISOString());

// ── el caso Pistacho: un panel que cuelga de OTRO panel del MISMO cliente ──
// Acá sí es redistribución: la venta ocurrió arriba y contar las dos cobraría dos veces.
const PIS = { id: 'c_pis', codigo: 'PISTACHO23', nombre: 'Pistacho' };
db.prepare('INSERT INTO clientes (id,codigo,nombreVisible,createdAt,ord) VALUES (?,?,?,?,0)')
  .run(PIS.id, PIS.codigo, PIS.nombre, new Date().toISOString());
db.prepare('UPDATE clientes SET nombre=? WHERE id=?').run(PIS.nombre, PIS.id);
db.prepare(`INSERT INTO paneles (id,cliente_id,nombre,sistema,id_usuario,conexion_id,divisas,createdAt,ord)
            VALUES (?,?,?,?,?,?,?,?,4)`)
  .run('p_gold', PIS.id, 'goldenclub.pro', 'Europa', '333', 'cx_test', JSON.stringify(['ARS']), new Date().toISOString());
db.prepare(`INSERT INTO paneles (id,cliente_id,nombre,sistema,id_usuario,conexion_id,divisas,createdAt,ord)
            VALUES (?,?,?,?,?,?,?,?,5)`)
  .run('p_elite', PIS.id, 'Eliteadmin', 'Europa', '444', 'cx_test', JSON.stringify(['ARS']), new Date().toISOString());

// ── un PASE entre dos paneles del mismo cliente ────────────────────────────
// Son dos casinos distintos: se retira en el origen y se carga en el destino, así que las DOS
// mitades salen con `from` vacío, igual que una venta. Sin mirar la tabla de pases, el destino
// figuraba como "fichas entregadas y no cobradas" — y son fichas que el cliente ya había comprado.
db.prepare(`INSERT INTO movimiento_panel (id,cliente_id,origen_panel_id,destino_panel_id,divisa,monto,estado,creado_at,hecho_at)
            VALUES (?,?,?,?,?,?,?,?,?)`)
  .run('mp_1', CLIENTE.id, 'p_celu', 'p_luwin', 'ARS', '7500000', 'hecho',
    '2026-08-12T09:59:00.000Z', '2026-08-12T10:00:00.000Z');

// ── las cargas: dos monedas a propósito, que es donde se rompía ────────────
const PEDIDOS = [
  { id: 'p1', codigo: 'MARCELO44', cajaUsuario: 'Celuapuestas-SA', userId: '9099270', sistema: 'Casino', divisa: 'ARS', monto: 1000000, estado: 'cargado', resueltoAt: '2026-08-31T16:45:33.461Z' },
  { id: 'p2', codigo: 'MARCELO44', cajaUsuario: 'Celuapuestas-SA', userId: '9099270', sistema: 'Casino', divisa: 'ARS', monto: 2000000, estado: 'cargado', resueltoAt: '2026-08-22T20:20:22.000Z' },
  { id: 'p3', codigo: 'MARCELO44', cajaUsuario: 'LuWinCasino-SA', userId: '9235765', sistema: 'Casino', divisa: 'USD', monto: 2000, estado: 'cargado', resueltoAt: '2026-08-23T16:37:13.148Z' },
  { id: 'p4', codigo: 'MARCELO44', cajaUsuario: 'LuWinCasino-SA', userId: '9235765', sistema: 'Casino', divisa: 'USD', monto: 1000, estado: 'cargado', resueltoAt: '2026-08-19T22:45:54.721Z' },
  { id: 'p5', codigo: 'OTRO99', cajaUsuario: 'Celuapuestas-SA', userId: '9099270', sistema: 'Casino', divisa: 'ARS', monto: 500000, estado: 'cargado', resueltoAt: '2026-08-15T10:00:00.000Z' },
  { id: 'p6', codigo: 'MARCELO44', cajaUsuario: 'Celuapuestas-SA', userId: '9099270', sistema: 'Casino', divisa: 'ARS', monto: 700000, estado: 'rechazado', resueltoAt: '2026-08-10T10:00:00.000Z' },
  // Lucia: la carga le baja desde el SuperAgente del vendedor
  { id: 'p7', codigo: 'LUCIA72', cajaUsuario: '21luciadm', userId: '222', sistema: 'Casino', divisa: 'ARS', monto: 3000000, estado: 'cargado', resueltoAt: '2026-08-09T03:30:53.705Z' },
  // Pistacho: la carga cae en Eliteadmin, que cuelga de su propio goldenclub.pro
  { id: 'p8', codigo: 'PISTACHO23', cajaUsuario: 'Eliteadmin', userId: '444', sistema: 'Europa', divisa: 'ARS', monto: 45000000, estado: 'cargado', resueltoAt: '2026-08-06T12:00:00.000Z' },
  // 🔴 la MISMA entrega con un pedido en cada tramo: entra al padre y baja al hijo en el segundo
  { id: 'd1', codigo: 'PISTACHO23', cajaUsuario: 'goldenclub.pro', userId: '333', sistema: 'Europa', divisa: 'ARS', monto: 3300000, estado: 'cargado', resueltoAt: '2026-08-21T10:00:00.000Z' },
  { id: 'd2', codigo: 'PISTACHO23', cajaUsuario: 'Eliteadmin', userId: '444', sistema: 'Europa', divisa: 'ARS', monto: 3300000, estado: 'cargado', resueltoAt: '2026-08-21T10:00:04.000Z' },
  // el vendedor también carga en su propio SA: sin una carga, ese panel ni se mira
  { id: 'p9', codigo: 'ALEXA777', cajaUsuario: 'IgLatamAlexa', userId: '111', sistema: 'Casino', divisa: 'ARS', monto: 1000000, estado: 'cargado', resueltoAt: '2026-08-02T10:00:00.000Z' },
  // y Pistacho carga también en goldenclub.pro, para que ese panel se mire
  { id: 'p10', codigo: 'PISTACHO23', cajaUsuario: 'goldenclub.pro', userId: '333', sistema: 'Europa', divisa: 'ARS', monto: 6000000, estado: 'cargado', resueltoAt: '2026-08-07T09:00:00.000Z' },
];
pedidosStore.seed({ pedidos: PEDIDOS });

// ── el casino de mentira ───────────────────────────────────────────────────
// Devuelve lo que el motor devolvería, y ABORTA si le llega un parámetro que carga fichas.
const PEDIDOS_AL_MOTOR = [];
const MOVS = {
  '9099270|ARS': [
    { id: '1', from: null, operation: 'in', currency: 'ARS', cash: '1000000.00', datetime: '2026-08-31 16:45:33', initiator: 'henry_support' },
    { id: '2', from: null, operation: 'in', currency: 'ARS', cash: '2000000.00', datetime: '2026-08-22 20:20:22', initiator: 'henry_support' },
    // una venta chica que nadie pidió: por debajo del umbral, es una prueba
    { id: '3', from: null, operation: 'in', currency: 'ARS', cash: '50000.00', datetime: '2026-08-03 14:23:50', initiator: 'henry_support' },
    // y una GRANDE que nadie pidió, sin pase ni retiro que la explique: eso sí es plata sin cobrar
    { id: '3b', from: null, operation: 'in', currency: 'ARS', cash: '900000.00', datetime: '2026-08-04 09:00:00', initiator: 'henry_support' },
    // una que se cargó y se devolvió: es un pedido anulado, no un agujero
    { id: '4', from: null, operation: 'in', currency: 'ARS', cash: '9000000.00', datetime: '2026-08-05 11:00:00', initiator: 'henry_support' },
    { id: '5', from: null, operation: 'out', currency: 'ARS', cash: '9000000.00', datetime: '2026-08-05 11:00:09', initiator: 'henry_support' },
    // y una que bajó del panel de arriba: movimiento interno, no se cobra
    { id: '6', from: 'GanamosBot-SA', operation: 'in', currency: 'ARS', cash: '500000.00', datetime: '2026-08-15 10:00:00', initiator: 'x' },
    // el RETIRO del pase: no es una devolución, las fichas se fueron al otro panel
    { id: '14', from: null, operation: 'out', currency: 'ARS', cash: '7500000.00', datetime: '2026-08-12 09:59:58', initiator: 'x' },
  ],
  '9235765|USD': [
    { id: '7', from: null, operation: 'in', currency: 'USD', cash: '2000.00', datetime: '2026-08-23 16:37:13', initiator: 'henry_support' },
    // ésta vuelve SIN hora, como pasa en los nodos de preámbulo largo
    { id: '8', from: null, operation: 'in', currency: 'USD', cash: '1000.00', datetime: null, initiator: 'henry_support' },
  ],
  '9235765|ARS': [
    // la CARGA del pase: entra con `from` vacío, igual que una venta
    { id: '15', from: null, operation: 'in', currency: 'ARS', cash: '7500000.00', datetime: '2026-08-12 10:00:00', initiator: 'x' },
  ],
  // el SA del vendedor: compra mayorista, sin pedido. NO es plata sin cobrar.
  '111|ARS': [
    { id: '10', from: null, operation: 'in', currency: 'ARS', cash: '80000000.00', datetime: '2026-08-01 09:00:00', initiator: 'x' },
    { id: '10b', from: null, operation: 'in', currency: 'ARS', cash: '1000000.00', datetime: '2026-08-02 10:00:00', initiator: 'x' },
  ],
  // el cliente que cuelga del vendedor: la carga entra DESDE el SA del vendedor
  '222|ARS': [
    { id: '11', from: 'IgLatamAlexa', operation: 'in', currency: 'ARS', cash: '3000000.00', datetime: '2026-08-09 03:30:53', initiator: 'x' },
  ],
  // Pistacho: la venta está arriba y baja al distribuidor. Son las MISMAS fichas.
  '333|ARS': [
    { id: '12', from: null, operation: 'in', currency: 'ARS', cash: '45000000.00', datetime: '2026-08-06 12:00:00', initiator: 'x' },
    // entra sin pedido, pero es la otra mitad del retiro de Eliteadmin
    { id: '17', from: null, operation: 'in', currency: 'ARS', cash: '12000000.00', datetime: '2026-08-20 08:00:05', initiator: 'x' },
    { id: '18b', from: null, operation: 'in', currency: 'ARS', cash: '6000000.00', datetime: '2026-08-07 09:00:00', initiator: 'x' },
    // la venta que después baja a Eliteadmin: hay un pedido por cada tramo
    { id: '18', from: null, operation: 'in', currency: 'ARS', cash: '3300000.00', datetime: '2026-08-21 10:00:00', initiator: 'x' },
  ],
  '444|ARS': [
    { id: '13', from: 'goldenclub.pro', operation: 'in', currency: 'ARS', cash: '45000000.00', datetime: '2026-08-06 12:00:00', initiator: 'x' },
    // el RETIRO de un pase hecho a mano: su otra mitad entra en goldenclub.pro
    { id: '16', from: null, operation: 'out', currency: 'ARS', cash: '12000000.00', datetime: '2026-08-20 08:00:00', initiator: 'x' },
    // y la bajada de la entrega duplicada
    { id: '19', from: 'goldenclub.pro', operation: 'in', currency: 'ARS', cash: '3300000.00', datetime: '2026-08-21 10:00:04', initiator: 'x' },
  ],
};
casinoConex.client = (id) => (id !== 'cx_test' ? null : {
  async apiCall(area, params, query) {
    PEDIDOS_AL_MOTOR.push({ area, params, query });
    for (const k of ['amount', 'send', 'sended', 'operation', 'all']) {
      if (k in params) throw new Error(`💥 el test aborta: se mandó "${k}" al motor`);
    }
    const k = `${query.id}|${params.balance_currency || 'ARS'}`;
    return { ok: true, status: 200, data: { operationsData: MOVS[k] || [] } };
  },
});

const facturaSvc = require('../src/factura.service');

(async () => {
  console.log('\n🧾 detalle de la factura + cruce contra el panel\n');

  // ── 1) el detalle sale de los pedidos de acá cuando el puente no contesta ──
  const consumo = { pedidos: 4, base: '6', vendido_usdt: '0', fee_usdt: '0', porDivisa: [], codigos: ['MARCELO44'] };
  const f = await facturaSvc.armar({ clienteId: CLIENTE.id, mes: '2026-08', consumo, conExternos: false });
  ok(f.ok, 'la factura se arma');
  ok((f.detalle || []).length === 4, `trae las 4 cargas del cliente (dio ${(f.detalle || []).length})`);
  ok(f.detalleDe === 'pedidos de este sistema', `dice de dónde salió el detalle (${f.detalleDe})`);
  ok(!f.detalle.some((d) => d.codigo === 'OTRO99'), 'no se cuela la carga de otro código');
  ok(!f.detalle.some((d) => d.id === 'p6'), 'no se cuela el pedido rechazado');
  const divisas = [...new Set(f.detalle.map((d) => d.divisa))].sort();
  ok(divisas.join(',') === 'ARS,USD', `están las DOS monedas (${divisas.join(',')})`);
  const panelesDet = (f.porPanel || []).map((p) => `${p.panel}/${p.divisa}`).sort();
  ok(panelesDet.join(' ') === 'Celuapuestas-SA/ARS LuWinCasino-SA/USD', `por panel y moneda: ${panelesDet.join(' ')}`);
  const usd = (f.porPanel || []).find((p) => p.divisa === 'USD');
  ok(usd && Number(usd.monto) === 3000, `el subtotal en USD no se mezcla con pesos (${usd && usd.monto})`);

  // ── 2) el texto que se manda incluye las líneas ──
  const texto = facturaSvc.aTexto(f, { detalle: true });
  ok(texto.includes('Detalle de las cargas'), 'el mensaje al cliente lleva el detalle');
  ok(texto.includes('LuWinCasino-SA'), 'y nombra el panel en dólares');

  // ── 3) el cruce contra el panel ──
  const c = await facturaSvc.armar({ clienteId: CLIENTE.id, mes: '2026-08', consumo, conExternos: false, conCruce: true });
  const cr = c.cruce;
  ok(cr && cr.ok, 'el cruce corre');
  ok(cr.totales.pedidas === 4 && cr.totales.cruzan === 4, `las 4 cargas cruzan con el panel (${cr.totales.cruzan}/${cr.totales.pedidas})`);

  const celu = cr.paneles.find((p) => p.panel === 'Celuapuestas-SA');
  ok(celu.pedidas === 2, `Celuapuestas: 2 pedidas (dio ${celu.pedidas})`);
  ok(celu.registradas === 5, `Celuapuestas: el panel registra 5 ventas (dio ${celu.registradas})`);
  ok(!celu.cargas.some((c) => c.comoLlego === null && c.cruza), 'ninguna carga cruza sin saber cómo llegó');
  ok(celu.diferencias.some((d) => d.tipo === 'entro_sin_pedido'),
    'y avisa de las fichas que entraron desde otro nodo sin ningún pedido detrás');
  ok(!celu.cuadra, 'Celuapuestas NO cuadra, y lo dice');
  const sinPedido = celu.diferencias.filter((d) => d.tipo === 'registrada_sin_pedido');
  ok(sinPedido.length === 1 && sinPedido[0].venta.monto === 900000, `señala la venta de 900.000 que nadie pidió (${sinPedido.length})`);
  const devuelta = celu.diferencias.filter((d) => d.tipo === 'registrada_y_devuelta');
  ok(devuelta.length === 1, 'y separa la que se cargó y se devolvió, que no es un agujero');

  const luwin = cr.paneles.find((p) => p.panel === 'LuWinCasino-SA');
  ok(luwin.cuadra, 'LuWinCasino cuadra');
  ok(luwin.cargas.filter((x) => x.cruzaPorMonto).length === 1, 'la fila que vino sin hora cruza igual, por monto');

  // ── 4) se le pidió al motor las DOS monedas del panel ──
  const monedasPedidas = PEDIDOS_AL_MOTOR.filter((p) => p.query.id === '9235765').map((p) => p.params.balance_currency).sort();
  ok(monedasPedidas.join(',') === 'ARS,USD', `al panel multi-divisa se le pide cada moneda (${monedasPedidas.join(',')})`);
  ok(PEDIDOS_AL_MOTOR.every((p) => p.params.balance_type === 'usual:to'), 'siempre "Al usuario", nunca otro tipo');

  // ── 4b) LOS TRES CAMINOS POR LOS QUE LLEGA UNA CARGA ──────────────────────────────────────
  // Es lo que estaba mal: todo lo que venía "de arriba" se descartaba como no-plata, y eso dejaba
  // ciega la validación de todos los clientes que cuelgan de un vendedor.
  const crucePanel2 = require('../src/cruce-panel.service');
  const mesR = await crucePanel2.cruzarMes('2026-08');
  ok(mesR.ok, 'la validación del mes corre');

  const luci = mesR.paneles.find((p) => p.panel === '21luciadm');
  ok(luci.cruzan === 1, `la carga de Lucia CRUZA aunque baje del vendedor (${luci.cruzan}/1)`);
  ok(luci.cargas[0].comoLlego === 'vendedor', `y dice cómo llegó: ${luci.cargas[0].comoLlego}`);
  ok(luci.cargas[0].via === 'IgLatamAlexa', `nombra por dónde bajó: ${luci.cargas[0].via}`);
  ok(luci.cuadra, 'el panel de Lucia cuadra');

  const elite = mesR.paneles.find((p) => p.panel === 'Eliteadmin');
  ok(elite.cruzan === elite.pedidas, `las cargas de Pistacho cruzan en Eliteadmin (${elite.cruzan}/${elite.pedidas})`);
  ok(elite.cargas[0].comoLlego === 'propio', `y se reconoce como su propio árbol: ${elite.cargas[0].comoLlego}`);
  const gold = mesR.paneles.find((p) => p.panel === 'goldenclub.pro');
  ok(!gold || !(gold.diferencias || []).some((d) => d.tipo === 'registrada_sin_pedido'),
    'la venta de arriba NO se reporta como "venta que nadie pidió": son las mismas fichas');

  const sa = mesR.paneles.find((p) => p.panel === 'IgLatamAlexa');
  ok(sa && sa.diferencias.some((d) => d.tipo === 'compra_del_vendedor'),
    'la compra mayorista del vendedor se separa y no cuenta como plata sin cobrar');
  ok(sa && !sa.diferencias.some((d) => d.tipo === 'registrada_sin_pedido'),
    'y no queda además como "venta que nadie pidió"');
  const alexa = mesR.porCliente.find((x) => x.nombre === 'Alexa');
  ok(!alexa || Number(alexa.noSeCobra_usdt) === 0, 'y no le suma nada al "no se cobra" del vendedor');

  // La de 50.000 está por debajo del umbral: es una prueba, no un agujero. La de 900.000 sí lo es.
  const celuP = mesR.paneles.find((p) => p.panel === 'Celuapuestas-SA');
  ok((celuP.diferencias || []).some((d) => d.tipo === 'probable_prueba' && Math.abs(d.venta.monto - 50000) < 1),
    'la de 50.000 se toma como prueba o reposición');
  ok(mesR.totales.probablesPruebas === 1, `y se cuenta aparte (${mesR.totales.probablesPruebas})`);
  // Pero se AVISA igual: que se asuma prueba no quiere decir que no haya que verlo.
  const marcePr = mesR.porCliente.find((x) => x.nombre === 'Marcelo');
  ok(marcePr && marcePr.pruebas === 1, `la prueba llega al recuento del cliente (${marcePr && marcePr.pruebas})`);
  ok(!celuP.cuadra, 'y el panel con una prueba NO figura como que cuadra');
  const marcelo = mesR.porCliente.find((x) => x.nombre === 'Marcelo');
  ok(marcelo && marcelo.ventasSinPedido === 1,
    `la de 900.000 sí queda como plata sin cobrar (${marcelo ? marcelo.ventasSinPedido : 'ninguna'})`);
  ok(mesR.totales.entregadasPorVendedor === 1 && mesR.totales.bajaronDeSuArbol === 2,
    `los caminos se cuentan aparte (vendedor ${mesR.totales.entregadasPorVendedor} · propio ${mesR.totales.bajaronDeSuArbol})`);
  // ── el pase: fichas que el cliente ya compró y movió entre sus paneles ──
  const luw = mesR.paneles.find((p) => p.panel === 'LuWinCasino-SA');
  const dPase = (luw.diferencias || []).find((d) => d.tipo === 'pase_entre_paneles');
  ok(!!dPase, 'la carga del pase se reconoce como pase, no como "venta que nadie pidió"');
  ok(dPase && /Celuapuestas-SA/.test(dPase.motivo), `y dice desde qué panel vino: ${dPase && dPase.motivo}`);
  ok(!(luw.diferencias || []).some((d) => d.tipo === 'registrada_sin_pedido'),
    'no queda además como plata sin cobrar');
  const marce2 = mesR.porCliente.find((x) => x.nombre === 'Marcelo');
  ok(marce2 && marce2.ventasSinPedido === 1,
    `y no infla el "no se cobra": sigue siendo sólo la de 900.000 (${marce2 && marce2.ventasSinPedido})`);
  const celu2 = mesR.paneles.find((p) => p.panel === 'Celuapuestas-SA');
  ok(!(celu2.diferencias || []).some((d) => d.tipo === 'registrada_y_devuelta' && Math.abs(d.venta.monto - 7500000) < 1),
    'el retiro del pase tampoco se cuenta como una devolución');
  ok(mesR.totales.pasesEntrePaneles === 1, `los pases se cuentan aparte (${mesR.totales.pasesEntrePaneles})`);

  // ── el pase hecho A MANO, sin pasar por el sistema ──
  // Es el caso de Titan: `Beting-SA` recibió 50.000.000 y `463.live` tiene el retiro. El pase por
  // el sistema es nuevo, así que los de antes sólo se reconocen por las dos mitades.
  const gold2 = mesR.paneles.find((p) => p.panel === 'goldenclub.pro');
  const elite2 = mesR.paneles.find((p) => p.panel === 'Eliteadmin');
  const dMano = [gold2, elite2].filter(Boolean).flatMap((p) => p.diferencias || []).find((d) => d.tipo === 'pase_a_mano');
  ok(!!dMano, 'una venta sin pedido con su retiro en otro panel del mismo cliente se marca como pase a mano');
  ok(!dMano || /parece un pase hecho a mano/.test(dMano.motivo), 'y se dice "parece", no se afirma de más');

  // ── 🔴 la misma entrega facturada dos veces ──
  const dDup = (elite2.diferencias || []).find((d) => d.tipo === 'cobrada_dos_veces');
  ok(!!dDup, 'detecta la entrega que tiene un pedido en el nodo de arriba y otro en el de abajo');
  ok(dDup && /una sola entrega/.test(dDup.motivo), `y explica por qué: ${dDup && dDup.motivo.slice(0, 60)}…`);
  ok(mesR.totales.cobradasDosVeces === 1, `se cuenta (${mesR.totales.cobradasDosVeces})`);
  ok(!elite2.cuadra, 'y el panel con una entrega duplicada NO cuadra');

  ok(crucePanel2.hayQueMirar(mesR), 'hayQueMirar dice que sí por la de 900.000');

  // ── 4c) VES usa el TC de VEF ──────────────────────────────────────────────────────────────
  // Son la misma moneda con dos códigos. Sin la regla, un mes con el TC cargado sólo en VEF dejaba
  // lo movido en VES fuera del total, sin error y sin aviso.
  db.prepare("INSERT INTO tc_divisa_snapshots (fecha,divisa,tasa,fuente,createdAt) VALUES ('2026-08-10','VEF','771.56','test','')").run();
  const tcSvc = require('../src/tc-unico.service');
  const vef = tcSvc.tcDelMes('VEF', '2026-08');
  const ves = tcSvc.tcDelMes('VES', '2026-08');
  ok(vef.valor === ves.valor && ves.valor === '771.56', `VES resuelve con el TC de VEF (${ves.valor})`);
  ok(/de VEF/.test(ves.fuente), `y dice de dónde salió: "${ves.fuente}"`);
  ok(tcSvc.tcDelMes('VES', '2026-05').valor === null, 'si no hay ninguno de los dos, sigue sin TC — no inventa');

  // ── 4d) A QUIÉN SE LE COBRA LO QUE ENTRA A CADA PANEL ─────────────────────────────────────
  // Tres reglas, y ninguna se adivina. El default es el código, que es lo correcto cuando el panel
  // es de la misma persona con otra cuenta (los de JJ son de Marcelo, los de Ariel son de Fran).
  const { db: bd } = require('../src/db');
  bd.prepare("UPDATE paneles SET consumo_a='dueno' WHERE id='p_lucia'").run();       // como Rafael-SA
  bd.prepare("UPDATE paneles SET consumo_a='ninguno' WHERE id='p_sa_alexa'").run();  // como RMIglatamAlexa
  const rr = pedidosStore.ventasDelMesPorCliente('2026-08');

  ok(!!rr.porCliente[CLIENTE.id], 'por defecto manda el código: las de Marcelo siguen siendo de Marcelo');
  ok(rr.porCliente[CLIENTE.id].codigos.includes('MARCELO44'), 'y conserva con qué código se pidieron');

  // 'dueno': la carga de Lucia entró con LUCIA72 y el panel es suyo, así que no cambia de mano;
  // lo que se comprueba es que el modo no rompa el caso normal.
  ok(!!rr.porCliente[LUCIA.id], 'el panel marcado «al dueño» le sigue facturando a su dueño');

  // 'ninguno': la carga del vendedor en su panel de tránsito no le genera deuda a nadie
  ok(!rr.porCliente[VEND.id], 'el panel marcado «de tránsito» no le factura a nadie');
  // 🔴 Y NO se descarta a ciegas: se verifica que la entrega esté cobrada más abajo.
  // La del vendedor de 1.000.000 no baja a nadie → tiene que quedar PARA REVISAR, no desaparecer.
  ok(rr.paraRevisar.some((x) => x.panel === 'IgLatamAlexa' && x.monto === 1000000),
    'una carga de tránsito que NO se cobra abajo queda para revisar');
  ok(rr.paraRevisar.every((x) => /no aparece cobrada a ningún cliente/.test(x.motivo)), 'con el motivo escrito');

  // Y si SÍ baja a un cliente, ahí sí se descarta — con el motivo y diciendo dónde se cobra.
  pedidosStore.seed({ pedidos: PEDIDOS.concat([
    { id: 'tr1', codigo: 'ALEXA777', cajaUsuario: 'IgLatamAlexa', userId: '111', sistema: 'Casino', divisa: 'ARS', monto: 3000000, estado: 'cargado', resueltoAt: '2026-08-09T03:30:49.000Z' },
  ]) });
  const rr2 = pedidosStore.ventasDelMesPorCliente('2026-08');
  const baja = rr2.sinCobrar.find((x) => x.monto === 3000000);
  ok(!!baja, 'la que sí baja a un cliente no genera deuda');
  ok(baja && baja.cobradaEn === '21luciadm' && baja.conCodigo === 'LUCIA72',
    `y dice dónde se cobra: ${baja && baja.cobradaEn} con ${baja && baja.conCodigo}`);
  pedidosStore.seed({ pedidos: PEDIDOS });

  bd.prepare("UPDATE paneles SET consumo_a=NULL WHERE id IN ('p_lucia','p_sa_alexa')").run();

  // ── 4c-bis) UN PASE QUE BAJA POR EL ÁRBOL ─────────────────────────────────────────────────
  // Si el panel de destino cuelga hondo, la cascada le baja las fichas desde su PADRE: la entrada
  // llega como interna (`from` = el padre) y no como venta. Buscar el pase sólo entre las ventas
  // dejaba justo esos afuera — le pasó a las dos de Lucia, 1.779,49 USDT.
  db.prepare(`INSERT INTO movimiento_panel (id,cliente_id,origen_panel_id,destino_panel_id,divisa,monto,estado,creado_at,hecho_at)
              VALUES (?,?,?,?,?,?,?,?,?)`)
    .run('mp_2', LUCIA.id, 'p_celu', 'p_lucia', 'ARS', '2500000', 'hecho',
      '2026-08-14T09:59:00.000Z', '2026-08-14T10:00:00.000Z');
  MOVS['222|ARS'].push({ id: '20', from: 'IgLatamAlexa', operation: 'in', currency: 'ARS', cash: '2500000.00', datetime: '2026-08-14 09:59:59', initiator: 'x' });
  const mesP = await crucePanel2.cruzarMes('2026-08');
  const luciP = mesP.paneles.find((p) => p.panel === '21luciadm');
  const dBaja = (luciP.diferencias || []).find((d) => d.tipo === 'pase_entre_paneles');
  ok(!!dBaja, 'un pase que baja por el árbol se reconoce como pase, no como plata sin cobrar');
  ok(dBaja && /bajó por IgLatamAlexa/.test(dBaja.motivo), `y dice por dónde bajó: ${dBaja && dBaja.motivo.slice(-40)}`);
  ok(!(luciP.diferencias || []).some((d) => d.tipo === 'entro_sin_pedido' && Math.abs(d.venta.monto - 2500000) < 1),
    'y no queda además como entrada sin pedido');
  MOVS['222|ARS'].pop();
  db.prepare("DELETE FROM movimiento_panel WHERE id='mp_2'").run();

  // ── 4c-ter) ENTRÓ Y VOLVIÓ: la anulación por el árbol ─────────────────────────────────────
  // Un pedido anulado deja las dos patas. Si el panel cuelga del árbol de un vendedor las dos son
  // INTERNAS, y no aparecían ni en las ventas ni en las devoluciones. Le pasó a Fran: 1.000.000
  // que entraron y volvieron tres minutos después figuraban como plata sin cobrar.
  MOVS['222|ARS'].push(
    { id: '21', from: 'IgLatamAlexa', operation: 'in', currency: 'ARS', cash: '4200000.00', datetime: '2026-08-18 01:22:21', initiator: 'x' },
    { id: '22', from: 'IgLatamAlexa', operation: 'out', currency: 'ARS', cash: '4200000.00', datetime: '2026-08-18 01:25:14', initiator: 'x' },
  );
  const mesA = await crucePanel2.cruzarMes('2026-08');
  const luciA = mesA.paneles.find((p) => p.panel === '21luciadm');
  const dVuelta = (luciA.diferencias || []).find((d) => d.tipo === 'entro_y_volvio');
  ok(!!dVuelta, 'una entrada interna que volvió se reconoce como anulación, no como plata sin cobrar');
  ok(dVuelta && /funcionó bien/.test(dVuelta.motivo), 'y se dice que funcionó bien');
  ok(!(luciA.diferencias || []).some((d) => d.tipo === 'entro_sin_pedido' && Math.abs(d.venta.monto - 4200000) < 1),
    'y no queda además como entrada sin pedido');
  MOVS['222|ARS'].pop(); MOVS['222|ARS'].pop();

  // ── 4d-bis) LA VENTANA PREVIA NO ENSUCIA EL MES ───────────────────────────────────────────
  // El historial se pide desde una semana antes para encontrar el retiro de un pase que cruza el
  // borde del mes. Pero si esas filas se cuentan como ventas del mes, cada venta de fin del mes
  // anterior aparece "sin cobrar": medido en producción, el total pasó de 34.091 a 164.679 USDT.
  MOVS['9099270|ARS'].push(
    { id: 'jul1', from: null, operation: 'in', currency: 'ARS', cash: '4444000.00', datetime: '2026-07-28 10:00:00', initiator: 'x' },
  );
  const mesV = await crucePanel2.cruzarMes('2026-08');
  const celuV = mesV.paneles.find((p) => p.panel === 'Celuapuestas-SA');
  ok(!(celuV.diferencias || []).some((d) => d.venta && Math.abs(d.venta.monto - 4444000) < 1),
    'una venta del mes ANTERIOR no se reporta como carga sin cobrar de este mes');
  MOVS['9099270|ARS'].pop();

  // ── 4d-ter) MARCAR UNA DIFERENCIA COMO YA MIRADA ──────────────────────────────────────────
  // Sin esto el mismo aviso sale todos los meses y se termina salteando sin leer. Marcarla no borra
  // ni corrige: la saca del recuento de plata y deja quién la miró.
  const svcR = require('../src/cruce-panel.service');
  const antes = await svcR.cruzarMes('2026-08');
  const marce3 = antes.porCliente.find((x) => x.nombre === 'Marcelo');
  ok(marce3 && marce3.ventasSinPedido === 1, 'antes de marcarla, la de 900.000 cuenta como plata sin cobrar');

  const celuR = antes.paneles.find((p) => p.panel === 'Celuapuestas-SA');
  const dR = (celuR.diferencias || []).find((d) => d.tipo === 'registrada_sin_pedido');
  ok(!!dR.clave, 'cada diferencia trae su clave para poder marcarla');
  svcR.resolver({ mes: '2026-08', nodo: celuR.nodo, panel: celuR.panel, divisa: dR.venta.divisa,
    monto: dR.venta.monto, fecha: dR.venta.fecha, decision: 'prueba', motivo: 'carga de prueba', quien: 'alexa' });

  const desp = await svcR.cruzarMes('2026-08');
  const marce4 = desp.porCliente.find((x) => x.nombre === 'Marcelo');
  ok(!marce4 || marce4.ventasSinPedido === 0, `marcada, deja de contar como plata (${marce4 ? marce4.ventasSinPedido : 0})`);
  const celuD = desp.paneles.find((p) => p.panel === 'Celuapuestas-SA');
  const dD = (celuD.diferencias || []).find((d) => d.clave === dR.clave);
  ok(dD && dD.resuelta && dD.resuelta.quien === 'alexa', 'pero SIGUE figurando, con quién la marcó');
  ok(dD && dD.resuelta.decision === 'prueba' && dD.resuelta.motivo === 'carga de prueba', 'y con su motivo');
  ok(desp.totales.yaRevisadas >= 1, 'se cuentan las ya revisadas');

  svcR.desresolver(dR.clave);
  const otra = await svcR.cruzarMes('2026-08');
  const marce5 = otra.porCliente.find((x) => x.nombre === 'Marcelo');
  ok(marce5 && marce5.ventasSinPedido === 1, 'y se puede deshacer: vuelve a contar');

  // La clave NO lleva el tipo: si mañana el cruce la clasifica mejor, la marca sigue valiendo.
  ok(!/registrada_sin_pedido/.test(dR.clave), 'la clave no depende de cómo la clasificamos hoy');

  // ── 4e) apagar el puente ──────────────────────────────────────────────────────────────────
  // Apunta a un dominio que después de la migración es ESTE servicio, así que dejarlo prendido es
  // un riesgo: si alguien acierta las credenciales, la facturación vuelve a rutear por el mapeo
  // viejo y se saltea la marca por panel.
  const vo = require('../src/ventas-online.service');
  vo.setConfig({ url: 'https://app.latamgames.online', usuario: 'Admin', password: 'x' });
  ok((vo.getConfig() || {}).url === 'https://app.latamgames.online', 'el puente se puede configurar');
  vo.setConfig({ usuario: 'Otro' });
  ok((vo.getConfig() || {}).url === 'https://app.latamgames.online', 'y si no mandás la URL, se conserva');
  vo.setConfig({ url: '' });
  ok(!(vo.getConfig() || {}).url, 'mandando la URL vacía se APAGA — antes no había forma');

  // ── 5) el candado ──
  const svc = require('../src/cruce-panel.service');
  for (const malo of ['amount', 'send', 'sended', 'operation', 'all']) {
    let abortó = false;
    try { svc._soloLectura({ from: 'x', to: 'y', [malo]: '1' }); }
    catch (e) { abortó = /carga fichas/.test(e.message); }
    ok(abortó, `el candado aborta con "${malo}"`);
  }
  let okLectura = true;
  try { svc._soloLectura({ from: 'a', to: 'b', interval: 'custom', balance_type: 'usual:to', limit: '1000', balance_currency: 'USD' }); }
  catch (e) { okLectura = false; }
  ok(okLectura, 'y deja pasar los de lectura, con balance_currency incluido');

  try { fs.unlinkSync(tmp); fs.unlinkSync(`${tmp}-wal`); fs.unlinkSync(`${tmp}-shm`); } catch (e) { /* da igual */ }
  console.log(fallos ? `\n❌ ${fallos} fallo(s)\n` : '\n✅ todo bien\n');
  process.exit(fallos ? 1 : 0);
})();
