/**
 * operaciones.routes.js — la pantalla 🛠 Operaciones (ver operaciones.service.js).
 *
 * Todo cuelga de /api/os/*, así que lo cubre el gate de la matriz: sólo la dueña. La operadora y el
 * proveedor no tienen ninguna de estas rutas en su lista blanca (auth.js) y reciben 403.
 */
const ops = require('./operaciones.service');
const casinoConex = require('./casino-conexiones-store');
const { quienEs } = require('./auth');

function mount(app) {
  const mal = (res, e, st = 400) => res.status(st).json({ ok: false, error: e.message || String(e) });

  app.get('/api/os/operaciones', (req, res) => {
    const conexiones = casinoConex.list463().filter((c) => c.activa !== false)
      .map((c) => ({ id: c.id, nombre: c.nombre, carga_de: c.carga_de || '' }));
    res.json({ ok: true, catalogo: ops.catalogo(), conexiones, historial: ops.list() });
  });

  app.get('/api/os/operaciones/:id', (req, res) => {
    const op = ops.get(req.params.id);
    if (!op) return mal(res, new Error('esa operación no existe'), 404);
    res.json({ ok: true, op });
  });

  app.post('/api/os/operaciones/revisar', async (req, res) => {
    try {
      const { tipo, params } = req.body || {};
      const op = await ops.revisar({ tipo, params, por: (quienEs(req) || {}).usuario });
      res.json({ ok: true, op });
    } catch (e) { mal(res, e); }
  });

  const accion = (fn) => (req, res) => {
    try { res.json({ ok: true, op: fn(req.params.id) }); } catch (e) { mal(res, e); }
  };
  app.post('/api/os/operaciones/:id/piloto', accion((id) => ops.correr(id, { cuantos: 1 })));
  app.post('/api/os/operaciones/:id/seguir', accion((id) => ops.correr(id)));
  app.post('/api/os/operaciones/:id/reintentar', accion((id) => ops.correr(id, { reintentar: true })));
  app.post('/api/os/operaciones/:id/cancelar', (req, res) => {
    res.json({ ok: ops.cancelar(req.params.id), op: ops.get(req.params.id, false) });
  });
}

module.exports = { mount };
