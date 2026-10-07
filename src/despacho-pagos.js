/**
 * despacho-pagos.js — la operadora (Sophi) acepta los PAGOS EN PESOS de los clientes PREPAGO.
 *
 * Decisión del dueño (8-oct-2026): «que Sophi pueda aceptarlos; tope 500 mil, sólo prepago, que
 * pueda rechazar». Es un permiso ANGOSTO a propósito: la operadora no entra al OS comercial (ve
 * deudas, precios y márgenes) y aprobar comprobantes estaba vedado porque «da por cobrada plata que
 * quizás no entró». Acá sólo puede:
 *   · ver los comprobantes PENDIENTES, en PESOS (CVU), de clientes PREPAGO con la cuenta en PESOS;
 *   · aprobar hasta ARS 500.000 (lo que entró de verdad, confirmando que lo vio en el CVU);
 *   · rechazar con un motivo.
 * Todo se vuelve a comprobar en el servidor —una ruta a mano no saltea nada—. Los pagos en USDT
 * (tipo de cambio, billetera) y los de más de 500.000 quedan para el dueño, en el OS.
 *
 * Aprobar hace lo mismo que el OS: registra el PAGO en la cuenta corriente (en pesos, sin tipo de
 * cambio: la cuenta se lleva en pesos), marca el comprobante con QUIÉN lo aprobó y avisa al grupo de
 * cobranzas. Desde ahí el cliente ya puede pedir contra ese saldo. El dueño lo anula desde el OS.
 */
const clientes = require('./clientes-store');
const comprobantes = require('./comprobantes-store');
const movs = require('./movimientos-store');
const tipoArchivo = require('./lib/tipo-archivo');
const { parseMonto } = require('./lib/monto');

const TOPE_ARS = 500000;

/** ¿Este comprobante lo puede resolver la operadora? Devuelve el cliente, o el motivo por el que no. */
function elegible(c) {
  if (!c) return { ok: false, codigo: 404, motivo: 'no existe ese comprobante' };
  if (c.estado !== 'pendiente') return { ok: false, codigo: 409, motivo: `ya estaba ${c.estado}` };
  if (String(c.via || '').toLowerCase() !== 'ars') return { ok: false, codigo: 403, motivo: 'los pagos en USDT los aprueba Alexa' };
  const cli = clientes.getByCodigo(c.codigo);
  if (!cli) return { ok: false, codigo: 404, motivo: 'ese comprobante ya no corresponde a ningún cliente' };
  if (!cli.prepago || cli.moneda_cuenta !== 'ARS') return { ok: false, codigo: 403, motivo: 'sólo los pagos de clientes prepago en pesos; este lo aprueba Alexa' };
  return { ok: true, cli };
}

const agenteDe = (c) => { const m = String(c.notas || '').match(/Agente:\s*([^·]+)/); return m ? m[1].trim() : ''; };

function mount(app, { quienEs }) {
  // La lista: sólo lo que puede resolver, y lo justo para hacerlo (nada de deudas ni saldos).
  app.get('/api/despacho/pagos-prepago', (req, res) => {
    const pend = comprobantes.list({ estado: 'pendiente', limite: 500 }).filter((c) => elegible(c).ok);
    res.json({ ok: true, tope: TOPE_ARS, pagos: pend.map((c) => {
      const cli = clientes.getByCodigo(c.codigo) || {};
      const monto = parseMonto(c.monto);
      return { id: c.id, cliente: cli.nombreVisible || cli.nombre || c.cliente_nombre || c.codigo, codigo: cli.codigo,
        agente: agenteDe(c), monto: c.monto, referencia: c.referencia || '', creado_at: c.creado_at,
        tieneArchivo: !!c.archivo_bytes, superaTope: monto != null && monto > TOPE_ARS };
    }) });
  });

  // La foto del comprobante: sólo de uno que puede resolver.
  app.get('/api/despacho/pagos-prepago/:id/archivo', (req, res) => {
    const c = comprobantes.get(req.params.id, true);
    const e = elegible(c);
    if (!e.ok) return res.status(e.codigo).json({ ok: false, error: e.motivo });
    if (!c.archivo_datos) return res.status(404).json({ ok: false, error: 'ese comprobante no tiene archivo' });
    const buf = Buffer.from(c.archivo_datos, 'base64');
    const tipo = tipoArchivo.tipoPorBytes(buf);
    const mostrar = tipoArchivo.sePuedeMostrar(tipo);
    res.setHeader('Content-Type', mostrar ? tipo : 'application/octet-stream');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; sandbox");
    res.setHeader('Cache-Control', 'no-store, private');
    res.setHeader('Content-Disposition', `${mostrar ? 'inline' : 'attachment'}; filename="comprobante"`);
    res.send(buf);
  });

  app.post('/api/despacho/pagos-prepago/:id/aprobar', (req, res) => {
    const b = req.body || {};
    const c = comprobantes.get(req.params.id);
    const e = elegible(c);
    if (!e.ok) return res.status(e.codigo).json({ ok: false, error: e.motivo });
    const monto = parseMonto(b.monto);
    if (!(monto > 0)) return res.status(400).json({ ok: false, error: 'Escribí cuántos pesos entraron' });
    if (monto > TOPE_ARS) {
      return res.status(403).json({ ok: false, error: `Pasa el tope de ARS ${TOPE_ARS.toLocaleString('es-AR')}: ese pago lo aprueba Alexa.` });
    }
    if (b.vioEntrar !== true) return res.status(400).json({ ok: false, error: 'Confirmá que lo viste entrar en el CVU' });
    const quien = quienEs(req) || 'operador';
    /* Sin ningún await entre la comprobación y el registro: no hay forma de que dos aprobaciones del
       mismo comprobante se crucen. Y `resolver` además sólo pisa uno que siga pendiente. */
    const mov = movs.create({ cliente_id: e.cli.id, tipo: 'pago', monto_ars: String(monto), monto_usdt: null,
      tc_momento: null, divisa: 'ARS', medio: 'cvu', recibido_por: null,
      notas: `comprobante ${c.id} · aprobado por ${quien}` });
    const r = comprobantes.resolver(c.id, { estado: 'aprobado', por: quien, movimiento_id: mov.id });
    if (!r.ok) return res.status(409).json({ ok: false, error: r.error });
    console.log(`[Pagos prepago] ${quien} aprobó ${c.id} · ${e.cli.codigo} · ARS ${monto}`);
    const avisar = req.app.get('avisarComprobante');
    if (typeof avisar === 'function') {
      Promise.resolve(avisar(comprobantes.get(c.id), e.cli, String(monto), 'ARS'))
        .catch((er) => console.warn('[Pagos prepago] aviso error:', er.message));
    }
    res.json({ ok: true, monto, cliente: e.cli.nombreVisible || e.cli.nombre });
  });

  app.post('/api/despacho/pagos-prepago/:id/rechazar', (req, res) => {
    const b = req.body || {};
    const c = comprobantes.get(req.params.id);
    const e = elegible(c);
    if (!e.ok) return res.status(e.codigo).json({ ok: false, error: e.motivo });
    const motivo = String(b.motivo || '').trim();
    if (!motivo) return res.status(400).json({ ok: false, error: 'Escribí por qué lo rechazás' });
    const quien = quienEs(req) || 'operador';
    const r = comprobantes.resolver(c.id, { estado: 'rechazado', por: quien, motivo });
    if (!r.ok) return res.status(409).json({ ok: false, error: r.error });
    console.log(`[Pagos prepago] ${quien} rechazó ${c.id} · ${e.cli.codigo} · ${motivo}`);
    res.json({ ok: true });
  });
}

module.exports = { mount, elegible, TOPE_ARS };
