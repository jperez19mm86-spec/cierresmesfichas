/**
 * pases.routes.js — 🔀 Pases (ver pases.service.js).
 *
 * Dos puertas PÚBLICAS, las que usa pase.js desde los sitios del casino:
 *   POST /api/pase/emitir   { token }   → { ir } | { motivo }   (desde el sitio viejo)
 *   POST /api/pase/canjear  { codigo }  → { token }             (desde el sitio nuevo)
 * Las dos con tope por dirección. El sitio se toma del encabezado Origin que pone el navegador,
 * no de lo que diga el cuerpo.
 *
 * La pantalla va por /api/os/pases*: sólo la dueña (gate de la matriz).
 */
const pases = require('./pases.service');
const { porIp } = require('./lib/tope');

function mount(app) {
  const mal = (res, e, st = 400) => res.status(st).json({ ok: false, error: e.message || String(e) });
  const origen = (req) => req.headers.origin || req.headers.referer || '';

  app.post('/api/pase/emitir', porIp('pase-emitir', 30, 1), async (req, res) => {
    try { res.json({ ok: true, ...(await pases.emitir({ origin: origen(req), token: (req.body || {}).token })) }); }
    catch (e) { console.error('[pase]', e.message); res.json({ ok: true, motivo: 'error' }); }
  });
  // ¿Mostrar «Nos actualizamos · Probá ahora» adentro del casino? Tope alto: va en cada carga.
  app.post('/api/pase/consultar', porIp('pase-consultar', 120, 1), async (req, res) => {
    try { res.json({ ok: true, ...(await pases.consultar({ origin: origen(req), token: (req.body || {}).token })) }); }
    catch (e) { res.json({ ok: true, mostrar: false }); }
  });
  app.post('/api/pase/canjear', porIp('pase-canjear', 30, 1), (req, res) => {
    const r = pases.canjear({ origin: origen(req), codigo: (req.body || {}).codigo });
    if (!r) return res.status(404).json({ ok: false, error: 'el link ya se usó o venció' });
    res.json({ ok: true, token: r.token });
  });

  app.get('/api/os/pases', (req, res) => res.json({ ok: true, pases: pases.list(), sitios: pases.sitios() }));
  app.get('/api/os/pases/:id/eventos', (req, res) => res.json({ ok: true, eventos: pases.eventos(req.params.id) }));
  app.post('/api/os/pases', async (req, res) => { try { res.json({ ok: true, pase: await pases.crear(req.body || {}) }); } catch (e) { mal(res, e); } });
  app.put('/api/os/pases/:id', async (req, res) => { try { res.json({ ok: true, pase: await pases.editar(req.params.id, req.body || {}) }); } catch (e) { mal(res, e); } });
  app.post('/api/os/pases/:id/regalos/pendientes', async (req, res) => { try { res.json({ ok: true, ...(await pases.darPendientes(req.params.id)) }); } catch (e) { mal(res, e); } });
  app.delete('/api/os/pases/:id', (req, res) => res.json({ ok: pases.borrar(req.params.id) }));
}

module.exports = { mount };
