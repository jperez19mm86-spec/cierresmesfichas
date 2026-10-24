/**
 * nuestro-chat.routes.js — NUESTRO chat: lo que se le cobra a cada cliente (pantalla /nuestro-chat).
 * Solo el admin (el operador y el proveedor no tienen estas rutas en su lista, ver auth.js).
 * La lógica vive en nuestro-chat.store.js; acá solo se reciben y se devuelven datos.
 */
const nc = require('../nuestro-chat.store');
const auth = require('../auth');
const { mesTZ } = require('../lib/fechas');
const { ok, err, wrap, html } = require('./comun');

const r = (res, x) => (x && x.ok === false ? err(res, 400, x.error || 'no se pudo') : ok(res, x || {}));
const quien = (req) => { try { return auth.quienEs(req).usuario || 'admin'; } catch (e) { return 'admin'; } };
const mesDe = (req) => (/^\d{4}-\d{2}$/.test(String(req.query.mes || req.body && req.body.mes || '')) ? String(req.query.mes || req.body.mes) : mesTZ());

function mount(app) {
  app.get('/nuestro-chat', (_req, res) => html(res, 'nuestro-chat.html'));
  const P = '/api/os/nuestro-chat';
  app.get(P + '/tablero', (_req, res) => ok(res, nc.tablero()));
  app.get(P + '/cobros', (req, res) => ok(res, nc.cobrosDe(mesDe(req))));
  app.post(P + '/cobros/armar', wrap((req, res) => r(res, nc.armarMes(mesDe(req), { cliente: req.body.cliente || null, sinDatosEsCero: !!req.body.sinDatosEsCero }))));
  app.post(P + '/cobros/mandar', wrap(async (req, res) => r(res, await nc.mandarMes(mesDe(req)))));
  app.post(P + '/cobros/frenar', wrap((req, res) => r(res, nc.frenar(mesDe(req), true))));
  app.post(P + '/cobros/soltar', wrap((req, res) => r(res, nc.frenar(mesDe(req), false))));
  app.post(P + '/cobros/recordar', wrap(async (req, res) => r(res, await nc.recordar(String(req.body.cliente || ''), mesDe(req)))));
  app.post(P + '/cobros/prorroga', wrap((req, res) => r(res, nc.prorroga(String(req.body.cliente || ''), req.body.hasta || null))));
  app.get(P + '/cobros/abiertos', (_req, res) => ok(res, { abiertos: nc.cobrosAbiertos() }));
  app.get(P + '/pagos', (_req, res) => ok(res, nc.pagos()));
  app.post(P + '/pagos', wrap((req, res) => r(res, nc.registrarPago({ ...req.body, cobro: req.body.doc || req.body.cobro, por: quien(req) }))));
  app.post(P + '/pagos/:id/borrar', wrap((req, res) => r(res, nc.borrarPago(req.params.id))));
  app.post(P + '/avisos/:id/aprobar', wrap((req, res) => r(res, nc.resolverAviso(req.params.id, { aprobar: true, monto: req.body.monto, por: quien(req) }))));
  app.post(P + '/avisos/:id/rechazar', wrap((req, res) => r(res, nc.resolverAviso(req.params.id, { aprobar: false, por: quien(req) }))));
  app.get(P + '/cuenta', (req, res) => ok(res, nc.cuenta(mesDe(req))));
  app.post(P + '/cuenta/gasto', wrap((req, res) => r(res, nc.anotarGasto(req.body || {}))));
  app.post(P + '/cuenta/gasto/:id/borrar', wrap((req, res) => r(res, nc.borrarGasto(req.params.id, quien(req)))));
  app.post(P + '/cuenta/pago-prog', wrap((req, res) => r(res, nc.anotarPagoProg(req.body || {}))));
  app.get(P + '/clientes', (_req, res) => ok(res, nc.clientes()));
  app.post(P + '/clientes', wrap((req, res) => r(res, nc.sumarCliente(String(req.body.cliente || '')))));
  app.post(P + '/clientes/:id', wrap((req, res) => r(res, nc.setCliente(req.params.id, req.body || {}))));
  app.post(P + '/clientes/:id/nuevo-link', wrap((req, res) => r(res, nc.nuevoToken(req.params.id))));
  app.post(P + '/cajas', wrap((req, res) => r(res, nc.guardarCaja(req.body || {}))));
  app.post(P + '/cajas/:id/empezo', wrap((req, res) => r(res, nc.marcarInicio(req.params.id, String(req.body.fecha || '')))));
  app.post(P + '/cajas/:id/baja', wrap((req, res) => r(res, nc.darDeBaja(req.params.id))));
  app.get(P + '/config', (_req, res) => ok(res, { config: nc.config() }));
  app.post(P + '/config', wrap((req, res) => r(res, nc.setConfig(req.body || {}))));

  /* ── LO PÚBLICO: el link de pago del cliente ───────────────────────────────────────────────
     Sin login: lo que prueba quién es, es el token (144 bits) de su link. No hay «entrar con el
     nombre de la caja»: con un nombre se vería la cuenta de cualquiera. Solo lee, y lo único que
     puede crear es un aviso de pago que queda pendiente hasta que lo apruebe el admin. */
  app.get(/^\/mi-chat\/[A-Za-z0-9_-]{16,64}\/?$/, (_req, res) => html(res, 'mi-chat.html'));
  app.get('/mi-chat/cuenta', (req, res) => { const x = nc.cuentaCliente(String(req.query.t || '')); x.ok ? ok(res, x) : err(res, 404, x.error); });
  app.post('/mi-chat/hash', wrap((req, res) => r(res, nc.avisarHash(String(req.body.token || ''), String(req.body.doc || ''), String(req.body.hash || '')))));
  /* Para el panel del chat (etapa 4): cuánto debe y si va el cartel. Mismo token, solo lectura. */
  app.get('/mi-chat/estado', (req, res) => { const x = nc.estadoParaElChat(String(req.query.t || req.get('x-token') || '')); x.ok ? ok(res, x) : err(res, 404, x.error); });

  if (process.env.NODE_ENV !== 'test') nc.startCron();
}
module.exports = { mount };
