/**
 * cambios.routes.js — Los cambios del mes (peso y divisas).
 * Sale de os.routes.js (fase 2): las rutas se movieron tal cual y en el mismo orden.
 */
const tcStore = require('../tc-store');
const tcSvc = require('../tc.service');
const tcDivisas = require('../tc-divisas.service');
const tcColumna = require('../tc-columna.service');
const { mesCierre: mesCierreLbl } = require('../lib/fechas');
const cierreStore = require('../cierre-store');
const tcUnico = require('../tc-unico.service');
const divisasStore = require('../divisas-store');
const { mesTZ } = require('../lib/fechas'); // fechaTZ/mesTZ=ART (billing) · fechaUTC/mesUTC=UTC (casino)
const { ok, err, wrap } = require('./comun');

function mount(app) {
  app.get('/api/os/divisas', (req, res) => ok(res, { divisas: req.query.activas === '1' ? divisasStore.listActivas() : divisasStore.list() }));
  app.post('/api/os/divisas', wrap((req, res) => { const b = req.body || {}; ok(res, { divisa: divisasStore.upsert({ codigo: b.codigo, nombre: b.nombre, activa: b.activa }) }); }));
  app.put('/api/os/divisas/:codigo/activa', wrap((req, res) => ok(res, { ok: divisasStore.setActiva(req.params.codigo, !!(req.body && req.body.activa)) })));
  app.delete('/api/os/divisas/:codigo', (req, res) => divisasStore.remove(req.params.codigo) ? ok(res) : err(res, 404, 'no encontrada'));
  // ───────── TIPOS DE CAMBIO ─────────
  app.get('/api/os/tc/ahora', wrap(async (_req, res) => ok(res, await tcSvc.tcAhora())));
  app.post('/api/os/tc/snapshot', wrap(async (_req, res) => {
    const r = await tcSvc.snapshotNow(); r.ok ? ok(res, { snapshot: r.snapshot }) : err(res, 502, r.error);
  }));
  app.get('/api/os/tc/snapshots', (req, res) => ok(res, { snapshots: tcStore.listSnapshots(req.query.mes) }));
  app.get('/api/os/tc/meses', (_req, res) => ok(res, { meses: tcStore.listMeses() }));
  // EL tipo de cambio de un mes, resuelto con la regla única + dónde las fuentes no coinciden.
  app.get('/api/os/tc/del-mes', (req, res) => {
    const mes = req.query.mes || mesTZ();
    if (req.query.divisa) return ok(res, tcUnico.tcDelMes(req.query.divisa, mes));
    ok(res, { mes, ars: tcUnico.tcDelMes('ARS', mes), monedas: tcUnico.resumenMes(mes), discrepancias: tcUnico.discrepancias(mes) });
  });
  // ── TC del resto de las divisas (ARS sale de Binance, arriba) ──
  // Snapshot diario automático; acá se puede forzar y consultar el promedio del mes.
  app.post('/api/os/tc/divisas/snapshot', wrap(async (req, res) => {
    const r = await tcDivisas.snapshotHoy(req.body && req.body.fecha);
    r.ok ? ok(res, { fecha: r.fecha, divisas: r.divisas }) : err(res, 502, r.error);
  }));
  app.get('/api/os/tc/divisas/promedios', (req, res) => {
    const mes = req.query.mes || new Date().toISOString().slice(0, 7);
    const lista = tcDivisas.promediosMes(mes);
    // ARS no sale de esta fuente: se toma el promedio de los snapshots de Binance
    const ars = tcStore.promedioMes(mes);
    if (ars) lista.unshift({ divisa: 'ARS', dias: tcStore.listSnapshots(mes).length, promedio: ars, fuente: 'binance/criptoya' });
    ok(res, { mes, promedios: lista });
  });
  // Qué monedas se siguen (salen de las filas de la grilla) + limpiar lo que sobró.
  app.get('/api/os/tc/divisas/seguidas', (_req, res) => ok(res, { monedas: [...tcDivisas.seguidas()].sort(), piso: tcDivisas.BASE_SEGUIDAS }));
  app.post('/api/os/tc/divisas/purgar', wrap((_req, res) => ok(res, { borradas: tcDivisas.purgarNoSeguidas(), monedas: [...tcDivisas.seguidas()].sort() })));
  app.get('/api/os/tc/divisas/dias', (req, res) => {
    const mes = req.query.mes || new Date().toISOString().slice(0, 7);
    ok(res, { mes, dias: tcDivisas.listDias(mes, req.query.divisa) });
  });
  // La columna del mes en la grilla, armada con los promedios que se juntaron.
  app.post('/api/os/tc/columna', wrap((req, res) => {
    const b = req.body || {};
    const r = tcColumna.armarColumna(b.mes || mesTZ(), { pisar: !!b.pisar });
    r.ok ? ok(res, r) : err(res, 400, r.error);
  }));
  // El TC del proveedor entra SIEMPRE por acá: `setTC` lo escribe en la grilla (fila ARS_OF) y en
  // tc_mes de una sola vez. Guardarlo directo en tc_mes es lo que había dejado los dos lados
  // distintos — julio con 1473,5 en uno y vacío en el otro.
  app.put('/api/os/tc/mes/:mes', wrap((req, res) => {
    const { tc_proveedor_ext } = req.body || {};
    if (tc_proveedor_ext === undefined) return err(res, 400, 'falta tc_proveedor_ext');
    /* ⚠️ EL CUARTO ARGUMENTO ES `forzar`, Y ESTABA EN `true` FIJO.
       `setTC` tiene un control que compara contra lo que esa misma moneda venía valiendo y frena
       un salto de más del 50% — está justo para el caso de escribir "1.473" pensando en 1473, que
       es un número válido (uno coma cuatro siete tres) y por eso el control de formato lo deja
       pasar. Ese TC es el divisor de TODO lo que se le paga a los proveedores externos en pesos:
       con 1,473 en vez de 1473, el resultado sale mil veces más grande.
       Con `true` fijo, la única pantalla donde se carga ese número lo salteaba siempre. Ahora
       `forzar` llega de la pantalla, que primero muestra la pregunta. */
    const forzar = !!(req.body || {}).forzar;
    const r = cierreStore.setTC(cierreStore.FILA_PROVEEDOR, mesCierreLbl(req.params.mes), tc_proveedor_ext, forzar, true);
    // `confirmar` y `anterior` viajan al cliente: sin eso la pantalla no puede preguntar nada.
    if (!r.ok) return err(res, 400, r.error, { confirmar: !!r.confirmar, anterior: r.anterior || null });
    ok(res, { mes: tcStore.getMes(req.params.mes) });
  }));
}

module.exports = { mount };
