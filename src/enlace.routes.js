/**
 * enlace.routes.js — EL PUENTE Mi Caja → OS, independiente a propósito.
 *
 * Mi Caja (el panel del casino) y el OS son DOS servicios separados: distinto Railway, distinta
 * base, distinto ciclo de deploy. Este módulo es el único punto de contacto, y está pensado para
 * que actualizar uno NUNCA rompa al otro:
 *   · Vive en su propio archivo y en su propia ruta (`/api/enlace/v1/...`), VERSIONADA. Nada de
 *     acá toca las rutas del panel ni las de la vista cliente.
 *   · No comparte código ni base con Mi Caja: el único lazo es este contrato HTTP chico.
 *   · Se autentica con un token de servicio (env `ENLACE_TOKEN`), no con sesiones de usuario.
 *   · Del lado de Mi Caja, toda llamada va con timeout y try/catch: si el OS está caído o
 *     actualizándose, Mi Caja no se cuelga — cae al camino de soporte. Acá no hay que hacer nada
 *     para eso, pero se contesta rápido y sin efectos raros para que ese fallback sea limpio.
 *
 * Qué contesta:
 *   GET  /api/enlace/v1/estado-cliente?usuario=&userId=&sistema=
 *        → si el usuario del casino ya es un cliente del OS y si está CONFIGURADO. La regla de
 *          «configurado» (decidida por el dueño, 13-sep-2026): existe como cliente + tiene % vigente
 *          (para generar deuda) + tiene grupo de Telegram. Nada más, por ahora.
 *   POST /api/enlace/v1/aviso-soporte  { usuario, userId, sistema, motivo, detalle }
 *        → manda un aviso al grupo de soporte: «hay una cuenta sin configurar / que necesita
 *          soporte». El OS es el dueño del bot y del grupo; Mi Caja no sabe nada de eso.
 */
const express = require('express');
const crypto = require('crypto');
const clientes = require('./clientes-store');
const participaciones = require('./participaciones-store');
const pedidos = require('./pedidos-store');
const push = require('./push');
const tgDestino = require('./telegram-destino');
const telegram = require('./telegram');
const config = require('./config-store');
const deudaSvc = require('./deuda.service');
const movsStore = require('./movimientos-store');

// Grupo al que van los avisos de «cuenta sin configurar / necesita soporte». Lo fijó el dueño el
// 13-sep-2026. Se puede pisar sin deploy con el config `grupoSinConfigurar`, por si el grupo cambia.
const GRUPO_SOPORTE_DEFAULT = '-4660535312';

const norm = (s) => String(s == null ? '' : s).trim().toLowerCase();
const escapeHtml = (s) => String(s == null ? '' : s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

/**
 * Del usuario del casino al cliente del OS. Los dos padrones NO comparten códigos, pero SÍ el nodo
 * del casino: `userId` (+ `sistema`) es el enlace fuerte, el mismo dato de los dos lados y que no
 * depende del nombre. El `usuario` es el respaldo. Igual criterio que usa el puente de ventas.
 */
function encontrarCliente({ usuario, userId, sistema } = {}) {
  const u = norm(usuario);
  const uid = String(userId == null ? '' : userId).trim();
  const sis = norm(sistema);
  const cs = clientes.list().clientes || [];
  if (uid) {
    for (const c of cs) {
      for (const k of (c.cajas || [])) {
        if (String(k.userId == null ? '' : k.userId).trim() === uid && (!sis || norm(k.sistema) === sis)) {
          return { cliente: c, caja: k, por: 'nodo' };
        }
      }
    }
  }
  if (u) {
    for (const c of cs) {
      for (const k of (c.cajas || [])) {
        if (norm(k.usuario) === u) return { cliente: c, caja: k, por: 'usuario' };
      }
    }
  }
  return { cliente: null, caja: null, por: null };
}

/** Estado de configuración de un cliente, con el detalle de lo que le falta. */
function estadoDe(query) {
  const { cliente } = encontrarCliente(query);
  if (!cliente) return { existe: false, configurado: false, motivosFaltantes: ['no_existe'] };
  // % vigente: es lo que arma el alta (participaciones con vigencia) y lo que genera la deuda.
  const tienePorcentaje = participaciones.listVigente(cliente.id).length > 0;
  // Grupo de Telegram: el destino RESUELTO (propio o heredado), que es a donde llegarían los avisos.
  const dest = tgDestino.destinoDe(cliente, (id) => clientes.get(id));
  const tieneTelegram = !!(dest && dest.chatId);
  const motivosFaltantes = [];
  if (!tienePorcentaje) motivosFaltantes.push('sin_porcentaje');
  if (!tieneTelegram) motivosFaltantes.push('sin_telegram');
  return {
    existe: true,
    configurado: tienePorcentaje && tieneTelegram,
    tienePorcentaje,
    tieneTelegram,
    motivosFaltantes,
    codigo: cliente.codigo,
    nombreVisible: cliente.nombreVisible,
  };
}

/** El aviso a soporte: al grupo del OS, describiendo qué falta. Devuelve si se envió, sin colgarse
 *  nunca (sin bot/grupo, o si Telegram falla, contesta enviado:false y el circuito sigue). */
async function avisarSoporte(body, est, motivo) {
  const grupo = String(config.getCfg('grupoSinConfigurar') || GRUPO_SOPORTE_DEFAULT).trim();
  const tok = config.getTelegramToken();
  if (!tok || !grupo) {
    console.log('[Enlace] aviso-soporte sin enviar: telegram no configurado (tok/grupo)');
    return { enviado: false, motivo: 'telegram_no_configurado' };
  }
  const quien = escapeHtml(body.usuario || est.codigo || 'desconocido');
  const falta = est.existe
    ? (est.motivosFaltantes.length ? est.motivosFaltantes.join(', ') : 'nada (revisar)')
    : 'no existe como cliente';
  const detalle = body.detalle ? `\n${escapeHtml(String(body.detalle).slice(0, 500))}` : '';
  const situacion = motivo === 'soporte' ? 'pidió soporte' : 'quiso pedir fichas sin estar configurado';
  const texto =
    `🛠️ <b>Cuenta sin configurar</b>\n`
    + `Usuario del casino: <code>${quien}</code>\n`
    + `Situación: ${escapeHtml(situacion)}\n`
    + `Falta: ${escapeHtml(falta)}${detalle}\n\n`
    + `<i>Latam Games · enlace Mi Caja</i>`;
  try {
    const r = await telegram.sendMessage(tok, grupo, texto);
    return { enviado: !!(r && r.ok), motivo: r && r.ok ? null : 'error_envio' };
  } catch (e) {
    console.log('[Enlace] aviso-soporte falló:', e && e.message);
    return { enviado: false, motivo: 'error_envio' };
  }
}

/** Autorización por token de servicio. Sin token en el server → puente APAGADO (503), no abierto. */
function autorizar(req, res, next) {
  const esperado = String(process.env.ENLACE_TOKEN || '').trim();
  if (!esperado) return res.status(503).json({ ok: false, error: 'enlace deshabilitado' });
  const crudo = String(
    (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || req.headers['x-enlace-token'] || ''
  ).trim();
  const a = Buffer.from(crudo);
  const b = Buffer.from(esperado);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ ok: false, error: 'no autorizado' });
  }
  return next();
}

function mount(app) {
  const r = express.Router();
  r.use(autorizar);

  r.get('/v1/estado-cliente', (req, res) => {
    res.json({ ok: true, ...estadoDe(req.query || {}) });
  });

  r.post('/v1/aviso-soporte', async (req, res) => {
    const b = req.body || {};
    const av = await avisarSoporte(b, estadoDe(b), b.motivo);
    res.json({ ok: true, enviado: av.enviado, motivo: av.motivo });
  });

  // Opción A: el pedido de fichas se toma en la COLA del OS (como la vista /pedir), pero sólo si el
  // cliente está configurado. Si no lo está, no se crea nada: se avisa a soporte y se contesta que
  // no se creó, con el detalle de lo que falta. Un solo llamado hace lo correcto en cada caso.
  r.post('/v1/pedido', async (req, res) => {
    const b = req.body || {};
    const { cliente, caja } = encontrarCliente(b);
    if (!cliente || !caja) {
      const av = await avisarSoporte(b, { existe: false, motivosFaltantes: ['no_existe'] });
      return res.json({ ok: true, creado: false, motivo: 'no_existe', avisado: av.enviado });
    }
    const est = estadoDe(b);
    if (!est.configurado) {
      const av = await avisarSoporte(b, est);
      return res.json({ ok: true, creado: false, motivo: 'sin_configurar', motivosFaltantes: est.motivosFaltantes, avisado: av.enviado });
    }
    const monto = Number(b.monto);
    if (!(monto > 0)) return res.status(400).json({ ok: false, error: 'monto inválido' });
    const cajaDivisas = (caja.divisas && caja.divisas.length) ? caja.divisas : ['ARS'];
    const divisa = cajaDivisas.includes(b.divisa) ? b.divisa : cajaDivisas[0];
    const pedido = pedidos.create({
      codigo: cliente.codigo, clienteNombre: cliente.nombreVisible,
      cajaId: caja.id, cajaUsuario: caja.usuario, sistema: caja.sistema, userId: caja.userId,
      divisa, monto,
    });
    push.notifyNewPedido(pedido); // fire-and-forget, no bloquea la respuesta
    res.json({ ok: true, creado: true, pedido: { id: pedido.id, cajaUsuario: pedido.cajaUsuario, divisa: pedido.divisa, monto: pedido.monto, estado: pedido.estado } });
  });

  // «Mi cuenta»: la deuda y los movimientos del cliente, SIN contraseña. La sesión del casino (que
  // llega resuelta por el proxy de Mi Caja) ya prueba quién es; acá manda el token de servicio. Es
  // la misma cuenta corriente que ve /api/cuenta/mio, pero autenticada por el puente en vez de por
  // el token de cliente. Sólo lee: no toca la deuda ni nada.
  r.get('/v1/mi-cuenta', (req, res) => {
    const { cliente } = encontrarCliente(req.query || {});
    if (!cliente) return res.json({ ok: true, existe: false });
    const cc = deudaSvc.cuentaCorriente(cliente.id);
    const col = cc.moneda === 'ARS' ? 'monto_ars' : 'monto_usdt';
    const movimientos = movsStore.list({ cliente_id: cliente.id }).slice(0, 25).map((m) => ({
      fecha: String(m.fecha || '').slice(0, 10),
      tipo: m.tipo,
      monto: m[col],
      divisa: m.divisa || null,
      notas: m.notas || null,
    }));
    res.json({
      ok: true, existe: true,
      codigo: cliente.codigo, nombreVisible: cliente.nombreVisible,
      moneda: cc.moneda,
      deuda: cc.total,                 // lo que debe hoy
      fichas: cc.fichas_pendientes,    // lo consumido en fichas
      pagos: cc.pagos,                 // lo pagado
      provisional: !!cc.provisional,   // saldo con TC del mes todavía abierto
      movimientos,
    });
  });

  app.use('/api/enlace', r);
}

module.exports = { mount, encontrarCliente, estadoDe };
