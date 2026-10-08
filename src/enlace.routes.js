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
const comprobantes = require('./comprobantes-store');
const billeteras = require('./billeteras-store');
const paneles = require('./paneles-store');
const casinoConex = require('./casino-conexiones-store');
const arbolSvc = require('./arbol.service');
const prepago = require('./prepago.service');

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
  const { cliente, caja } = encontrarCliente(query);
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
    /* QUÉ PUEDE HACER ESTE AGENTE. Es por CAJA —la cuenta del casino con la que entró—, no por
       cliente: dentro del mismo cliente uno puede hacer todo y otro sólo pedir. «Puede avisar pagos»
       del cliente sigue siendo la llave general de los pagos. Van aparte de «configurado». Mi Caja
       dibuja sólo lo permitido, y las rutas de abajo lo comprueban igual. */
    ...(() => {
      const p = clientes.permisosDe(cliente, caja);
      return { puedePedir: p.pedir, puedeAvisarPago: p.pagos, puedeVerCuenta: p.cuenta, permisosConfigurados: p.configurados };
    })(),
    motivosFaltantes,
    codigo: cliente.codigo,
    nombreVisible: cliente.nombreVisible,
    /* EL DISTRIBUIDOR pide para sí o para sus agentes. Se le pasan las cuentas del cliente en su
       mismo casino: Mi Caja las cruza con los agentes que el casino dice que son suyos, y sólo a
       esos les deja pedir. Nunca paga ni ve la cuenta (esos permisos no se le dan). */
    ...(caja && caja.rol === 'distribuidor' ? {
      esDistribuidor: true,
      agentesDelCliente: (cliente.cajas || [])
        .filter((k) => k.rol !== 'distribuidor' && norm(k.sistema) === norm(caja.sistema) && k.userId)
        .map((k) => ({ userId: String(k.userId), usuario: k.usuario, etiqueta: k.etiqueta || '' })),
    } : {}),
  };
}

/* Los datos para pagar (a dónde transferir), los mismos que ve el portal del cliente en `/api/pedir`.
   El CVU (ARS) es global. La billetera USDT es la DEL CLIENTE (`billetera_id`): puede recibir por
   varias redes (BEP20 y TRC20 son la misma billetera). `direccion`/`red` siguen viajando con la
   primera para no romper lo que ya las leía; `redes` trae la lista completa. Sin billetera propia
   —o si todavía no hay ninguna cargada— cae a la global de siempre. */
function datosDePago(cli) {
  const cfg = (k) => String(config.getCfg(k) || '');
  const w = billeteras.deCliente(cli);
  const redes = (w && w.direcciones.length) ? w.direcciones
    : (cfg('usdtAddress') ? [{ red: cfg('usdtRed'), direccion: cfg('usdtAddress') }] : []);
  return {
    ars: { titular: cfg('cvuTitular'), cvu: cfg('cvuVigente'), aviso: cfg('arsAviso'), nota: cfg('cvuNota') },
    usdt: {
      direccion: redes[0] ? redes[0].direccion : '', red: redes[0] ? redes[0].red : '',
      redes, billetera: (w && w.nombre) || '', aviso: cfg('usdtAviso'), nota: (w && w.nota) || cfg('usdtNota'),
    },
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
  const situacion = motivo === 'soporte' ? 'pidió soporte'
    : motivo === 'agente_nuevo' ? 'es distribuidor, creó un agente y su cuenta no está cargada en ningún cliente del OS'
    : 'quiso pedir fichas sin estar configurado';
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

/** Aviso de ALTA: un distribuidor creó un agente y quedó sumado a su cliente. Va al mismo grupo de
 *  soporte (decisión del dueño, 30-sep-2026): el agente ya existe en el casino, así que no se pide
 *  aprobación —se avisa—, pero un panel nuevo cambia lo que se le factura al cliente y alguien tiene
 *  que enterarse. Nunca se cuelga ni hace fallar el alta. */
async function avisarAgenteNuevo({ distribuidor, login, id, sistema, divisa, cliente, conPanel, pide = true }) {
  const grupo = String(config.getCfg('grupoSinConfigurar') || GRUPO_SOPORTE_DEFAULT).trim();
  const tok = config.getTelegramToken();
  if (!tok || !grupo) return { enviado: false, motivo: 'telegram_no_configurado' };
  const texto =
    `🆕 <b>Agente nuevo</b>\n`
    + `<code>${escapeHtml(distribuidor)}</code> creó <b>${escapeHtml(login)}</b> (id ${escapeHtml(id)} · ${escapeHtml(sistema || '—')}, ${escapeHtml(divisa)})\n`
    + `→ sumado a <b>${escapeHtml(cliente)}</b> ${pide ? 'con «sólo pedir fichas»' : 'sin poder pedir (se las pide el distribuidor)'}\n`
    + `${conPanel ? 'Panel creado: entra en la facturación.' : 'Sin panel: el distribuidor ya factura por él.'}\n\n`
    + `<i>Para que pueda pagar o ver su cuenta: ficha del cliente → Qué puede hacer cada agente.</i>`;
  try {
    const r = await telegram.sendMessage(tok, grupo, texto);
    return { enviado: !!(r && r.ok), motivo: r && r.ok ? null : 'error_envio' };
  } catch (e) {
    console.log('[Enlace] aviso de agente nuevo falló:', e && e.message);
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

  r.get('/v1/estado-cliente', async (req, res) => {
    // `datosPago` viaja acá para que «Registrar un pago» tenga a dónde transferir sin otra llamada.
    // La billetera USDT depende del cliente, así que lo resolvemos para pasárselo a datosDePago.
    const { cliente, caja } = encontrarCliente(req.query || {});
    /* PREPAGO: el saldo a favor, lo reservado por pedidos pendientes y cuánto le alcanza en fichas
       de SU caja. Y en qué divisas puede pagar (vacío = las dos). */
    let pre = { prepago: false };
    if (cliente && cliente.prepago) {
      try {
        pre = await prepago.estado(cliente);
        if (caja) {
          const divCaja = (caja.divisas || ['ARS'])[0];
          const cacheTc = {};
          pre.alcanza = await prepago.alcanzaPara(cliente, pre, { sistema: caja.sistema, userId: caja.userId, divisa: divCaja }, cacheTc);
          pre.enCaja = await prepago.enMonedaDeCaja(cliente, pre, divCaja, cacheTc);
        }
      } catch (e) { pre = { prepago: true, error: 'no se pudo calcular' }; }
    }
    res.json({ ok: true, ...estadoDe(req.query || {}), datosPago: datosDePago(cliente),
      divisasPago: (cliente && cliente.divisas_pago) || ['ARS', 'USDT'], prepago: pre });
  });

  /* ── ALTA DE UN AGENTE HECHA POR UN DISTRIBUIDOR EN MI CAJA ─────────────────────────────────
     Mi Caja la llama DESPUÉS de crear el agente en el casino y encontrarlo (el id es el del motor).
     El distribuidor se reconoce por su cuenta cargada en el cliente (caja con rol 'distribuidor').
     El agente nuevo entra como cuenta de ese cliente con «sólo pedir fichas» (decisión del dueño,
     29-sep-2026), con el casino y la moneda del distribuidor —un distribuidor y lo suyo manejan UNA
     sola—, y el Telegram es el del cliente, así que no hay que tocar nada más.
     Si el distribuidor ya factura como panel, su consumo incluye el de sus agentes: el agente va
     sólo como cuenta (para pedir), sin panel, para no cobrarlo dos veces.
     Si la cuenta del distribuidor no está en ningún cliente, no se inventa nada: se avisa a soporte. */
  r.post('/v1/agente-nuevo', async (req, res) => {
    const b = req.body || {};
    const login = String(b.login || '').trim();
    const id = String(b.id || '').trim();
    if (!login || !/^\d+$/.test(id)) return res.status(400).json({ ok: false, error: 'faltan el login y el id del agente' });
    const { cliente, caja } = encontrarCliente(b);
    if (!cliente || !caja) {
      const av = await avisarSoporte({ ...b, detalle: `Agente nuevo: ${login} (id ${id})` },
        { existe: false, motivosFaltantes: ['distribuidor_sin_cliente'] }, 'agente_nuevo');
      return res.json({ ok: true, registrado: false, motivo: 'distribuidor_sin_cliente', avisado: av.enviado });
    }
    const sistema = caja.sistema || '';
    const ya = (cliente.cajas || []).find((k) => String(k.userId) === id && (k.sistema || '') === sistema);
    if (ya) return res.json({ ok: true, registrado: true, yaEstaba: true, cliente: cliente.codigo });
    const divisas = (caja.divisas && caja.divisas.length) ? [String(caja.divisas[0]).toUpperCase()] : ['ARS'];
    const distFactura = paneles.list({ cliente_id: cliente.id })
      .some((p) => String(p.id_usuario) === String(caja.userId) && (p.sistema || '') === sistema);
    let panel = null;
    if (!distFactura) {
      const cx = casinoConex.list463().find((c) => String(c.nombre || '').toLowerCase() === sistema.toLowerCase() && !c.carga_de);
      panel = paneles.create({ cliente_id: cliente.id, nombre: login, sistema, tipo: 'exclusivo', nivel_usuario: 'Agente',
        id_usuario: id, conexion_id: cx ? cx.id : null, divisas });
      try { arbolSvc.resolverEnSegundoPlano(panel); } catch (e) { /* queda sin resolver; la pantalla lo muestra */ }
    }
    /* Entra con «sólo pedir»… salvo que el distribuidor tenga apagado «sus agentes piden fichas»:
       entonces entra sin nada, y las fichas se las pide el distribuidor (8-oct-2026, LUCHO15). */
    const agentePide = caja.agentesPiden !== false;
    clientes.addCaja(cliente.id, { usuario: login, sistema, userId: id, divisas,
      permisos: { pedir: agentePide, pagos: false, cuenta: false } });
    console.log(`[Enlace] agente ${login} (${id}) creado por el distribuidor ${caja.usuario} → cliente ${cliente.codigo}${panel ? ' (con panel)' : ' (sólo cuenta)'}`);
    const av = await avisarAgenteNuevo({ distribuidor: caja.usuario || b.usuario || '', login, id, sistema,
      divisa: divisas[0], cliente: cliente.nombre || cliente.codigo, conPanel: !!panel, pide: agentePide });
    res.json({ ok: true, registrado: true, cliente: cliente.codigo, conPanel: !!panel, avisado: av.enviado });
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
    // Este agente puede no tener permiso de pedir aunque el cliente esté configurado.
    if (!est.puedePedir) return res.json({ ok: true, creado: false, motivo: 'no_habilitado' });
    const monto = Number(b.monto);
    if (!(monto > 0)) return res.status(400).json({ ok: false, error: 'monto inválido' });
    const cajaDivisas = (caja.divisas && caja.divisas.length) ? caja.divisas : ['ARS'];
    const divisa = cajaDivisas.includes(b.divisa) ? b.divisa : cajaDivisas[0];
    // PREPAGO: sólo si le alcanza el saldo a favor (con su margen). A los demás no les cambia nada.
    const pp = await prepago.puedePedir(cliente, [{ sistema: caja.sistema, userId: caja.userId, monto, divisa }]);
    if (!pp.ok) {
      const enCaja = await prepago.enMonedaDeCaja(cliente, pp.estado, divisa).catch(() => null);
      return res.json({ ok: true, creado: false, motivo: pp.motivo, prepago: { ...(pp.estado || {}), enCaja }, costo: pp.costo, alcanza: pp.alcanza });
    }
    const pedido = pedidos.create({
      codigo: cliente.codigo, clienteNombre: cliente.nombreVisible,
      cajaId: caja.id, cajaUsuario: caja.usuario, sistema: caja.sistema, userId: caja.userId,
      divisa, monto,
    });
    push.notifyNewPedido(pedido); // fire-and-forget, no bloquea la respuesta
    res.json({ ok: true, creado: true, pedido: { id: pedido.id, cajaUsuario: pedido.cajaUsuario, divisa: pedido.divisa, monto: pedido.monto, estado: pedido.estado } });
  });

  /* ── UN DISTRIBUIDOR PIDE FICHAS PARA SUS AGENTES ──────────────────────────────────────────
     Un pedido por agente, cargado DIRECTO a la cuenta del agente (con su cascada de siempre), y con
     `pedidoPor` para que en el panel se vea quién lo pidió. Lo habilita el «pedir» de la cuenta del
     distribuidor (apagado de entrada, se prende en la ficha del cliente); el permiso propio del
     agente no cuenta: el que pide es el distribuidor. Mi Caja ya comprobó en el casino que cada
     agente es suyo; acá se comprueba que esté en el MISMO cliente y casino. Los que no, se
     devuelven uno por uno con su motivo y no frenan a los demás. */
  r.post('/v1/pedido-agentes', async (req, res) => {
    const b = req.body || {};
    const { cliente, caja } = encontrarCliente(b);
    if (!cliente || !caja) return res.json({ ok: true, creados: [], motivo: 'no_existe' });
    if (caja.rol !== 'distribuidor') return res.json({ ok: true, creados: [], motivo: 'no_es_distribuidor' });
    const est = estadoDe(b);
    if (!est.configurado) {
      const av = await avisarSoporte(b, est);
      return res.json({ ok: true, creados: [], motivo: 'sin_configurar', motivosFaltantes: est.motivosFaltantes, avisado: av.enviado });
    }
    if (!est.puedePedir) return res.json({ ok: true, creados: [], motivo: 'no_habilitado' });
    const lista = Array.isArray(b.pedidos) ? b.pedidos.slice(0, 50) : [];
    if (!lista.length) return res.status(400).json({ ok: false, error: 'no hay pedidos' });
    /* PREPAGO: todo el lote junto tiene que entrar en lo disponible. Si no entra, no se crea ninguno
       —pedir la mitad de un lote al azar confundiría más que decir cuánto le alcanza—. */
    if (cliente.prepago) {
      const items = lista.map((x) => {
        const ag = (cliente.cajas || []).find((k) => String(k.userId) === String((x && x.userId) || '').trim()
          && k.rol !== 'distribuidor' && norm(k.sistema) === norm(caja.sistema));
        const divs = ag && ag.divisas && ag.divisas.length ? ag.divisas : ['ARS'];
        return ag && Number(x.monto) > 0 ? { sistema: ag.sistema, userId: ag.userId, monto: Number(x.monto),
          divisa: divs.includes(b.divisa) ? b.divisa : divs[0] } : null;
      }).filter(Boolean);
      const pp = await prepago.puedePedir(cliente, items);
      if (!pp.ok) return res.json({ ok: true, creados: [], motivo: pp.motivo, prepago: pp.estado, costo: pp.costo });
    }
    const creados = []; const rechazados = [];
    for (const x of lista) {
      const uid = String((x && x.userId) || '').trim();
      const monto = Number(x && x.monto);
      const ag = (cliente.cajas || []).find((k) => String(k.userId) === uid && k.rol !== 'distribuidor'
        && norm(k.sistema) === norm(caja.sistema));
      if (!ag) { rechazados.push({ userId: uid, motivo: 'agente_no_en_cliente' }); continue; }
      if (!(monto > 0)) { rechazados.push({ userId: uid, usuario: ag.usuario, motivo: 'monto_invalido' }); continue; }
      const divs = (ag.divisas && ag.divisas.length) ? ag.divisas : ['ARS'];
      const divisa = divs.includes(b.divisa) ? b.divisa : divs[0];
      const pedido = pedidos.create({
        codigo: cliente.codigo, clienteNombre: cliente.nombreVisible,
        cajaId: ag.id, cajaUsuario: ag.usuario, cajaEtiqueta: ag.etiqueta || '', sistema: ag.sistema, userId: ag.userId,
        divisa, monto, pedidoPor: caja.usuario,
      });
      push.notifyNewPedido(pedido);
      creados.push({ id: pedido.id, cajaUsuario: pedido.cajaUsuario, divisa: pedido.divisa, monto: pedido.monto, estado: pedido.estado });
    }
    console.log(`[Enlace] ${caja.usuario} pidió para ${creados.length} agente(s) · rechazados ${rechazados.length}`);
    res.json({ ok: true, creados, rechazados });
  });

  // Registrar un pago: el cliente declara cuánto pagó y adjunta la captura. Entra a la MISMA cola de
  // comprobantes que usa el portal del cliente (`/api/comprobante`): queda PENDIENTE, no toca la
  // deuda —eso pasa al aprobarlo desde el panel—, y le llega un push a quien aprueba. La identidad
  // sale de la caja (no del body). El comprobante es OBLIGATORIO (decisión del dueño, 14-sep-2026).
  r.post('/v1/avisar-pago', async (req, res) => {
    const b = req.body || {};
    const { cliente, caja } = encontrarCliente(b);
    if (!cliente) return res.json({ ok: true, creado: false, motivo: 'no_existe' });
    // Por agente (la caja con la que entró), con la llave general del cliente encima.
    if (!clientes.permisosDe(cliente, caja).pagos) return res.json({ ok: true, creado: false, motivo: 'no_habilitado' });
    if (!b.archivo || !b.archivo.base64) return res.status(400).json({ ok: false, error: 'falta el comprobante' });
    // En qué puede pagar este cliente (elegido en su ficha). Vacío = las dos.
    const viaPago = String(b.via || '').toLowerCase() === 'usdt' ? 'USDT' : 'ARS';
    if (cliente.divisas_pago && !cliente.divisas_pago.includes(viaPago)) {
      return res.json({ ok: true, creado: false, motivo: 'divisa_no_habilitada', divisasPago: cliente.divisas_pago });
    }
    /* QUIÉN LO MANDÓ Y A DÓNDE ENTRÓ. Con varios agentes por cliente, «¿quién subió esto?» se
       contestaba preguntando. Va al frente de las notas, que el panel ya muestra al revisar. Y la
       billetera, igual que el portal: sin ella, con dos billeteras no se sabe dónde entró la plata. */
    const agente = caja ? (caja.etiqueta || caja.usuario) : '';
    const notas = [agente ? `Agente: ${agente}` : '', String(b.notas || '').trim()].filter(Boolean).join(' · ');
    const cr = comprobantes.crear({
      codigo: cliente.codigo, clienteNombre: cliente.nombreVisible,
      via: b.via, monto: b.monto, divisa: b.divisa, referencia: b.referencia, notas,
      archivo: b.archivo,
      billetera_id: String(b.via || '').toLowerCase() === 'usdt' ? (billeteras.deCliente(cliente) || {}).id || null : null,
    });
    if (!cr.ok) return res.status(400).json({ ok: false, error: cr.error });
    const c = cr.comprobante;
    // Push al teléfono de quien aprueba (fire-and-forget, no bloquea). El aviso al grupo va cuando
    // el pago SE ACREDITA, no ahora (igual criterio que `/api/comprobante`).
    push.notifyNuevoComprobante({ ...c, clienteNombre: cliente.nombreVisible || cliente.nombre, codigo: cliente.codigo,
      paraDespacho: require('./despacho-pagos').elegible(c).ok });
    res.json({ ok: true, creado: true, comprobante: { id: c.id, estado: c.estado, monto: c.monto, divisa: c.divisa, archivo_bytes: c.archivo_bytes || 0 } });
  });

  // «Mi cuenta»: la deuda y los movimientos del cliente, SIN contraseña. La sesión del casino (que
  // llega resuelta por el proxy de Mi Caja) ya prueba quién es; acá manda el token de servicio. Es
  // la misma cuenta corriente que ve /api/cuenta/mio, pero autenticada por el puente en vez de por
  // el token de cliente. Sólo lee: no toca la deuda ni nada.
  r.get('/v1/mi-cuenta', (req, res) => {
    const { cliente, caja } = encontrarCliente(req.query || {});
    if (!cliente) return res.json({ ok: true, existe: false });
    // Ver la cuenta es un permiso del agente: la deuda del cliente no la ve cualquiera de sus cajas.
    if (!clientes.permisosDe(cliente, caja).cuenta) return res.json({ ok: true, existe: true, habilitado: false });
    const cc = deudaSvc.cuentaCorriente(cliente.id);
    // La divisa en la que opera la caja del casino (lo que el cliente ve «en su plata»). Puede
    // diferir de la moneda de la cuenta (con la que se salda la deuda, casi siempre USDT).
    const monedaCaja = (caja && caja.divisas && caja.divisas[0]) ? String(caja.divisas[0]).toUpperCase() : null;
    // Si la caja opera en otra moneda que la de la cuenta Y esa moneda tiene cara guardada
    // (ARS/USDT), se muestra también el saldo en esa divisa. Es una REFERENCIA (suma caras a su TC
    // del día), no la deuda que se cobra: esa sigue siendo `cc` en `cc.moneda`.
    const caraCaja = (monedaCaja && monedaCaja !== cc.moneda)
      ? deudaSvc.totalesEnMoneda(cliente.id, monedaCaja) : null;
    const movimientos = movsStore.list({ cliente_id: cliente.id }).slice(0, 25).map((m) => ({
      fecha: String(m.fecha || '').slice(0, 10),
      tipo: m.tipo,
      // La cifra en la moneda de la cuenta (compatibilidad) + las dos caras guardadas, para que el
      // panel muestre la divisa de la caja y USDT sin convertir nada nuevo.
      monto: cc.moneda === 'ARS' ? (m.monto_ars || '0') : (m.monto_usdt || '0'),
      monto_ars: m.monto_ars != null ? m.monto_ars : null,
      monto_usdt: m.monto_usdt != null ? m.monto_usdt : null,
      divisa: m.divisa || null,
      notas: m.notas || null,
    }));
    res.json({
      ok: true, existe: true,
      codigo: cliente.codigo, nombreVisible: cliente.nombreVisible,
      moneda: cc.moneda,               // moneda de la CUENTA (autoridad de la deuda)
      deuda: cc.total,                 // lo que debe hoy
      fichas: cc.fichas_pendientes,    // lo consumido en fichas
      pagos: cc.pagos,                 // lo pagado
      provisional: !!cc.provisional,   // saldo con TC del mes todavía abierto
      // La MISMA cuenta leída en la divisa de la caja (o null si coincide con la de la cuenta, o si
      // esa divisa no tiene cara guardada). Referencia para el cliente, no un segundo saldo.
      monedaCaja,
      caja: caraCaja ? {
        moneda: caraCaja.moneda,
        deuda: caraCaja.total,
        fichas: caraCaja.fichas_pendientes,
        pagos: caraCaja.pagos,
      } : null,
      movimientos,
    });
  });

  app.use('/api/enlace', r);
}

module.exports = { mount, encontrarCliente, estadoDe };
