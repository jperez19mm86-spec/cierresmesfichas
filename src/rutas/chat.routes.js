/**
 * chat.routes.js — El Chat externo: su cuenta con cada cliente, su proveedor y la pantalla /chat-externo.
 * Sale de os.routes.js (fase 2): las rutas se movieron tal cual y en el mismo orden.
 */
const paneles = require('../paneles-store');
const telegram = require('../telegram');
const chat = require('../chat-externo.store');
const chatDoc = require('../chat-doc');
const { fechaTZ, mesTZ } = require('../lib/fechas'); // fechaTZ/mesTZ=ART (billing) · fechaUTC/mesUTC=UTC (casino)
const { ok, err, wrap, html, _urlPublica } = require('./comun');

function mount(app) {
  /* El chat tiene su propio espacio, con la misma pantalla y otra barra. Ojo con el nombre: `/chat`
     es el portal PÚBLICO del cliente y no lleva login; éste es el de adentro y sí. */
  app.get('/chat-externo', (_req, res) => html(res, 'os.html'));
  /**
   * Aprobar y ejecutar. La MISMA ruta reintenta uno que quedó a medias: el estado del que se lo
   * toma decide si hay que hacer las dos mitades o sólo la que falta. Un botón menos y, sobre todo,
   * un camino menos donde equivocarse y repetir un retiro.
   */
  /* ── LO QUE VE EL PROVEEDOR ──────────────────────────────────────────────────────────────
     Estas dos rutas son las ÚNICAS que su usuario puede tocar (ver PROVEEDOR_PUEDE en auth.js) y
     son las dos de sólo lectura. Él mira; lo que se cobra y se paga lo registra ella.

     ⚠️ El cinturón de abajo es el mismo que ya cuida las hojas del cliente: si por lo que sea se
     colara un campo del negocio de ella, la ruta devuelve 500 en vez de mandarlo. Que un guard se
     dispare es una molestia; que el margen viaje, no tiene vuelta atrás. */
  const _sinMargen = (o) => {
    const t = JSON.stringify(o);
    return !/"cobra"|"pct_cliente"|"pct"\s*:\s*"?\d+"?\s*,\s*"cobra"|margen|sinPrecio|precio sin confirmar/i.test(t);
  };
  /* El acceso del proveedor, desde SU pantalla. Antes vivía en una variable del servidor: cambiar
     una contraseña obligaba a salir del sistema, y lo que es incómodo no se hace nunca. */
  app.get('/api/os/chat/proveedor-acceso', (_req, res) => ok(res, chat.proveedorAcceso()));
  app.put('/api/os/chat/proveedor-acceso', wrap((req, res) => {
    const r = chat.setProveedorAcceso(req.body || {});   // usuario, clave, generar y grupo
    r.ok ? ok(res, r) : err(res, 400, r.error);
  }));
  app.get('/api/os/proveedor/meses', (_req, res) => ok(res, { meses: chat.mesesDelProveedor() }));
  app.get('/api/os/proveedor/mes', (req, res) => {
    const mes = String(req.query.mes || '').slice(0, 7) || mesTZ();
    if (!/^\d{4}-\d{2}$/.test(mes)) return err(res, 400, 'mes inválido');
    const d = chat.paraElProveedor(mes);
    if (!_sinMargen(d)) {
      console.error('[Proveedor] se frenó una respuesta que llevaba datos internos');
      return err(res, 500, 'no pudimos armar la liquidación. Escribinos.');
    }
    ok(res, d);
  });
  /* ── OFERTAS COMERCIALES ─────────────────────────────────────────────────────────────────────
     La oferta ES el precio: se arma una vez, se manda como documento y al aceptarla escribe la
     matriz. Antes se cotizaba en una hoja aparte y después había que volver a tipear los mismos
     números para poder facturar — dos lugares con el mismo dato es cómo terminan distintos. */
  /* ── CHAT EXTERNO ────────────────────────────────────────────────────────────────────────────
     Un servicio de terceros que algunos paneles contratan. Los dos lados tienen precios distintos:
     al cliente se le cobra lo negociado, al proveedor se le paga un % fijo, y la diferencia es el
     margen. Sale de la ganancia que el acumulado ya captura todas las noches. */
  app.get('/api/os/chat/config', (_req, res) => ok(res, { config: chat.config() }));
  app.put('/api/os/chat/config', wrap((req, res) => {
    const r = chat.setConfig(req.body || {});
    r.ok ? ok(res, r) : err(res, 400, r.error);
  }));
  app.get('/api/os/chat/paneles', (_req, res) => (chat.devengarMensualidades(), ok(res, {
    paneles: chat.list(), config: chat.config(), destinos: chat.destinos(),
    wallets: chat.wallets(), apagadas: chat.walletsApagadasEnUso(),
  })));
  app.post('/api/os/chat/wallets', wrap((req, res) => {
    const r = chat.guardarWallet(req.body || {});
    r.ok ? ok(res, r) : err(res, 400, r.error);
  }));
  app.delete('/api/os/chat/wallets/:id', wrap((req, res) => {
    const r = chat.borrarWallet(req.params.id);
    r.ok ? ok(res, r) : err(res, 400, r.error);
  }));
  app.post('/api/os/chat/paneles', wrap((req, res) => {
    const r = chat.set(req.body || {});
    r.ok ? ok(res, r) : err(res, 400, r.error);
  }));
  app.delete('/api/os/chat/paneles/:id', wrap((req, res) => ok(res, chat.quitar(req.params.id))));
  app.get('/api/os/chat/cierre', (req, res) => ok(res, chat.cierre(String(req.query.mes || '').slice(0, 7) || mesTZ())));
  app.get('/api/os/chat/mensualidades', (req, res) => ok(res, chat.mensualidadesDe(req.query.fecha || fechaTZ())));
  /* ── EL MES AGRUPADO POR CLIENTE ────────────────────────────────────────────────────────────
     La cuenta se la mandás al CLIENTE, no al panel: uno con tres paneles paga una sola cuenta. */
  app.get('/api/os/chat/por-cliente', (req, res) => {
    chat.devengarMensualidades();      // al mirar la pantalla, lo vencido ya está adentro
    const mes = String(req.query.mes || '').slice(0, 7) || mesTZ();
    const pc = chat.porCliente(mes);
    ok(res, {
      ...pc, pagado: chat.pagado(mes), pagos: chat.pagos(mes),
      // Lo que le debés al proveedor, abierto en sus dos partes: el % y el mantenimiento van a
      // wallets distintas y se pagan en fechas distintas.
      deudaProv: chat.deudaProveedor(mes),
      envios: chat.envios(mes), cuentas: chat.cuentas(mes), arrastre: chat.cuentas(null),
      /* Lo que está cobrado y sin mandar. Va también a la pantalla y no sólo al recordatorio de
         Telegram: si el bot falla o falta el grupo, éste es el único lugar donde se ve. */
      listas: chat.listasParaMandar(),
      // El mantenimiento caja por caja, para poder ver cuáles quedaron al día y cuáles no.
      mantCajas: Object.fromEntries((pc.clientes || []).map((g) => [g.cliente_id, chat.mantenimientoPorCaja(g.cliente_id)])),
      avisos: chat.avisosPendientes(), solicitudes: chat.solicitudesPendientes(),
      // Y los últimos resueltos: sin esto, apenas aprobabas uno desaparecía y no había desde dónde
      // reenviarle el comprobante al proveedor.
      avisosResueltos: chat.avisosResueltos(12),
    });
  });
  // A dónde se le manda la cuenta de ESTE servicio (grupo propio, ver la tabla chat_cliente).
  app.get('/api/os/chat/destino/:clienteId', (req, res) => ok(res, { destino: chat.destino(req.params.clienteId) }));
  app.put('/api/os/chat/destino/:clienteId', wrap((req, res) => {
    const r = chat.setDestino({ ...(req.body || {}), cliente_id: req.params.clienteId });
    r.ok ? ok(res, r) : err(res, 400, r.error);
  }));
  /* ── LAS DOS HOJAS ──────────────────────────────────────────────────────────────────────────
     La del cliente sale de `paraCliente`, que NO arrastra el costo ni el margen; la del proveedor
     sale de `paraProveedor`, que no arrastra lo que le cobrás a cada cliente. El chequeo de abajo
     es cinturón y tiradores: esto se le muestra a alguien de afuera y no hay vuelta atrás. */
  /* Con `divisa`, la hoja de UNA de sus cuentas. Un cliente con cajas en dos monedas recibe dos:
     a veces son dos negocios con socios distintos.

     ⚠️ EL TOTAL SE VUELVE A SUMAR CAJA POR CAJA, no se recalcula como el % de la ganancia junta.
     `cobra` se redondea en cada caja, así que las de Ariel en PYG dan 292,10 sumando y 292,09
     haciendo el 4% de 7.302,35 — un centavo, y la hoja deja de cerrar contra su propio detalle.
     Y `sinTC` se recalcula sobre lo filtrado: el aviso de «falta un tipo de cambio» es de todo el
     cliente, y arrastrarlo entero pondría el cartel en la hoja de la cuenta que no lo tiene. */
  function _hojaCliente(mes, clienteId, divisa) {
    const pc = chat.porCliente(mes);
    const g = (pc.clientes || []).find((x) => String(x.cliente_id) === String(clienteId));
    if (!g) return null;
    const dv = String(divisa || '').toUpperCase();
    if (!dv) return chatDoc.paraCliente(g, { mes: pc.mes });
    const paneles = (g.paneles || []).filter((p) => chat.divisaDelPanel(p) === dv);
    if (!paneles.length) return null;
    const gd = {
      ...g,
      paneles,
      monedas: (g.monedas || []).filter((m) => String(m.moneda || '').toUpperCase() === dv),
      cobra: paneles.reduce((a, p) => require('../lib/money').add(a, p.cobra || '0'), '0'),
      sinTC: paneles.some((p) => (p.detalle || []).some((x) => Number(x.profit) > 0 && x.usdt == null)),
    };
    return { ...chatDoc.paraCliente(gd, { mes: pc.mes }), divisa: dv };
  }
  /* ── LA HOJA DE UNA CUENTA TIENE QUE CERRAR CONSIGO MISMA ────────────────────────────────────
     Filtrar la tabla de arriba no alcanza: el saldo, el total del mes y el desglose de "qué se te
     cobró" venían del cliente ENTERO. La hoja de guaraníes decía «debés 906,34» arriba y 742,10
     abajo, y el que la lee no tiene forma de saber cuál de los dos es el suyo.
     Sin divisa devuelven lo de siempre: el cliente de una sola moneda no pasa por acá. */
  function _saldoDe(todo, dv) {
    if (!todo) return null;
    if (!dv) return todo;
    const d = (todo.porDivisa || []).find((x) => x.divisa === dv);
    return d ? { ...d, movs: (todo.movs || []).filter((m) => String(m.divisa || '').toUpperCase() === dv) } : null;
  }
  function _cobradoDe(esteMes, dv) {
    if (!esteMes) return null;
    if (!dv) return esteMes.cobrado;
    const d = (esteMes.porDivisa || []).find((x) => x.divisa === dv);
    return d ? d.cobrado : '0';
  }
  const _movsDe = (esteMes, dv) => (esteMes ? esteMes.movs : [])
    .filter((m) => !dv || String(m.divisa || '').toUpperCase() === dv);
  function _sinDatosInternos(html) {
    return !/margen|costo|pct_costo|te cuesta|paga:/i.test(html);
  }
  app.get('/api/os/chat/doc/cliente/:clienteId', (req, res) => {
    const mes = String(req.query.mes || '').slice(0, 7) || mesTZ();
    const doc = _hojaCliente(mes, req.params.clienteId, req.query.divisa);
    if (!doc) return err(res, 404, 'ese cliente no tiene nada en el chat externo ese mes');
    // La vista previa muestra lo MISMO que va a ver el cliente, salvo el formulario: mirar una
    // versión distinta de la que se manda no sirve para revisarla.
    const dvP = String(req.query.divisa || '').toUpperCase();
    const todo = chat.cuentas(null).clientes.find((x) => x.cliente_id === req.params.clienteId) || null;
    const esteMes = chat.cuentas(mes).clientes.find((x) => x.cliente_id === req.params.clienteId) || null;
    const html = chatDoc.htmlCliente(doc, {
      pago: chat.comoPagar(req.params.clienteId),
      // El saldo de ESA cuenta, no el del cliente entero: la hoja de guaraníes tiene que cerrar
      // con lo que dice arriba, y el total del cliente incluye la otra.
      saldo: _saldoDe(todo, dvP),
      cobradoMes: _cobradoDe(esteMes, dvP),
      // Los movimientos del mes, para poder decir DE QUÉ está hecho ese total: el % y el
      // mantenimiento son dos cobros distintos y meterlos en un solo número los confunde.
      movsMes: _movsDe(esteMes, dvP) });
    if (!_sinDatosInternos(html)) return err(res, 500, 'la hoja traía datos internos: NO se generó. Avisá que esto pasó.');
    res.type('text/html; charset=utf-8').send(html);
  });
  app.get('/api/os/chat/doc/proveedor', (req, res) => {
    const mes = String(req.query.mes || '').slice(0, 7) || mesTZ();
    const doc = chatDoc.paraProveedor(chat.porCliente(mes), { mes, mantenimiento: chat.deudaProveedor(mes).mantenimiento });
    res.type('text/html; charset=utf-8').send(chatDoc.htmlProveedor(doc));
  });
  /* ── MANDARLE LA CUENTA AL CLIENTE ──────────────────────────────────────────────────────────
     Sale para AFUERA: se manda de verdad. El link guarda la hoja YA PROYECTADA, así que lo que el
     cliente abre es lo mismo que viste vos, aunque después cambie un tipo de cambio. */
  app.post('/api/os/chat/enviar/:clienteId', wrap(async (req, res) => {
    const mes = String((req.body || {}).mes || '').slice(0, 7) || mesTZ();
    /* Una cuenta a la vez. Un cliente con cajas en dos monedas recibe dos mensajes, cada uno con
       lo suyo: son dos negocios, y a veces con socios distintos. */
    const dv = String((req.body || {}).divisa || '').toUpperCase();
    const doc = _hojaCliente(mes, req.params.clienteId, dv);
    if (!doc) return err(res, 404, 'ese cliente no tiene nada en el chat externo ese mes');
    const d = chat.destino(req.params.clienteId);
    if (!d.grupos.length) return err(res, 400, 'ese cliente todavía no tiene grupo de Telegram para este servicio');
    /* El link con token se sigue generando —ella lo copia con el botón «Link» cuando lo necesita, y
       es la foto congelada del mes—, pero al grupo NO va: lo que se manda es el portal. Un token en
       un grupo de Telegram es una llave suelta, y muestra un mes viejo si se abre en diciembre. */
    const l = chatDoc.crearLink(doc, req.params.clienteId);
    const url = _urlPublica(req) + '/chat/' + l.token;
    const portal = _urlPublica(req) + '/chat';
    /* Con el resumen adelante: qué es el mantenimiento, por qué período, y si el % ya se cobró.
       Sale de los movimientos del mes, que es lo REGISTRADO — no de la proyección del documento.
       Las cajas van para poder nombrarlas por su link, que es como las reconoce el cliente. */
    const esteMesTg = chat.cuentas(mes).clientes.find((x) => x.cliente_id === req.params.clienteId);
    // Los movimientos de ESA cuenta: el mensaje tiene que decir lo mismo que la hoja que acompaña.
    const movsTg = ((esteMesTg && esteMesTg.movs) || [])
      .filter((m) => !dv || String(m.divisa || '').toUpperCase() === dv);
    const cajasTg = chat.list().filter((p) => p.cliente_id === req.params.clienteId
      && (!dv || String(p.divisa || '').toUpperCase() === dv));
    const texto = chatDoc.textoTelegram(mes, movsTg, portal, cajasTg,
      chat.comoPagar(req.params.clienteId), dv);
    /* A TODOS los grupos: a veces el encargado tiene que enterarse y no está en el mismo grupo que
       el cliente. Se manda de a uno y se guarda el resultado de cada uno — si falla el segundo, no
       puede quedar como que salió todo bien. */
    const tok = chat.botToken();
    const idas = [];
    for (const g of d.grupos) {
      // eslint-disable-next-line no-await-in-loop
      const r1 = await telegram.sendMessage(tok, g, texto);
      idas.push({ grupo: g, ok: !!r1.ok, error: r1.error || null });
    }
    const fallaron = idas.filter((x) => !x.ok);
    const r = fallaron.length
      ? { ok: false, error: fallaron.map((x) => `${x.grupo}: ${x.error}`).join(' · ') }
      : { ok: true };
    // Queda anotado que se mandó: sin esto, "¿se la mandaste?" no tiene respuesta.
    chat.marcarEnviado(req.params.clienteId, mes, r, dv);
    r.ok ? ok(res, { url, portal, token: l.token, divisa: dv, enviado: idas.length, idas })
      : err(res, 502, `salió a ${idas.length - fallaron.length} de ${idas.length}: ${r.error}`,
        { url, token: l.token, idas });
  }));
  // El link sin mandarlo: para copiarlo y pegarlo donde ella quiera.
  app.post('/api/os/chat/link/:clienteId', wrap((req, res) => {
    const mes = String((req.body || {}).mes || '').slice(0, 7) || mesTZ();
    const doc = _hojaCliente(mes, req.params.clienteId);
    if (!doc) return err(res, 404, 'ese cliente no tiene nada en el chat externo ese mes');
    const l = chatDoc.crearLink(doc, req.params.clienteId);
    ok(res, { url: _urlPublica(req) + '/chat/' + l.token, token: l.token, actualizado: l.actualizado });
  }));
  /* ── LA CUENTA DEL CHAT, QUE ES OTRA CUENTA ─────────────────────────────────────────────────
     No pasa por `movimientos` ni por el cierre del mes: esta plata no es toda de ella —la mitad se
     le paga al proveedor—, se cobra en otra wallet y se habla en otro grupo. Ver el comentario de
     la tabla `chat_mov`. Cobrar congela el número; apretar dos veces no cobra dos veces. */
  app.post('/api/os/chat/cobrar', wrap((req, res) => {
    const mes = String((req.body || {}).mes || '').slice(0, 7) || mesTZ();
    const r = chat.cobrar(mes, { confirmar: (req.body || {}).confirmar === true });
    if (r.ok) r.salteados = chat.porCliente(mes).salteados || [];
    r.ok ? ok(res, r) : err(res, 400, r.error, { requiereConfirmar: !!r.requiereConfirmar, sinTC: r.sinTC || [] });
  }));
  app.post('/api/os/chat/descobrar', wrap((req, res) => {
    const b = req.body || {};
    const mes = String(b.mes || '').slice(0, 7) || mesTZ();
    ok(res, chat.descobrar(mes, b.cliente_id || null));
  }));
  app.get('/api/os/chat/cuentas', (req, res) => {
    // Sin `mes` devuelve el arrastre: alguien puede deber tres meses y eso no se ve mirando uno.
    ok(res, { mes: chat.cuentas(req.query.mes || null), todo: chat.cuentas(null) });
  });
  app.post('/api/os/chat/cobros', wrap((req, res) => {
    const r = chat.pagarCliente(req.body || {});
    r.ok ? ok(res, r) : err(res, 400, r.error);
  }));
  /* SALDAR UNA DIFERENCIA. El cliente que paga en pesos usa SU tipo de cambio: si debe 160 y paga
     155, esos 5 no se le reclaman. Pero no se borran — quedan como una fila con el motivo escrito,
     y la cuenta cierra en cero sin perder el porqué. */
  app.post('/api/os/chat/ajustes', wrap((req, res) => {
    const r = chat.ajustar(req.body || {});
    r.ok ? ok(res, r) : err(res, 400, r.error);
  }));
  /* Cuánto falta para saldar lo que dijo pagar, y si entra en la tolerancia. Lo usa la pantalla
     para preguntar antes de aprobar cuando la diferencia es grande. */
  app.get('/api/os/chat/diferencia', (req, res) => {
    const q = req.query || {};
    ok(res, {
      diferencia: chat.diferenciaDe(q.cliente_id, q.concepto, q.divisa, q.monto, q.cajas),
      tolerancia: chat.TOLERANCIA_PCT,
    });
  });
  app.delete('/api/os/chat/movs/:id', wrap((req, res) => ok(res, chat.borrarMov(req.params.id))));
  /* ── LOS AVISOS DE PAGO DEL CLIENTE ─────────────────────────────────────────────────────────
     Suben la captura desde su hoja. No mueven el saldo hasta que se aprueban acá. */
  app.get('/api/os/chat/avisos', (_req, res) => ok(res, {
    avisos: chat.avisosPendientes(),
    // Y los últimos resueltos: apenas aprobabas uno desaparecía y no había desde dónde reenviarlo.
    resueltos: chat.avisosResueltos(12),
  }));
  /* REENVIARLE AL PROVEEDOR el comprobante de un mantenimiento YA APROBADO. No mueve ni un peso:
     sólo vuelve a mandar el mensaje. Es lo que hay que usar cuando el aviso no salió —o cuando se
     aprobó antes de que este mensaje existiera— en vez de anular el pago, que sí mueve el saldo. */
  app.post('/api/os/chat/avisos/:id/avisar-proveedor', wrap(async (req, res) => {
    const av = chat.avisoPorId(req.params.id);
    if (!av) return err(res, 404, 'no existe ese aviso');
    if (av.concepto !== 'mantenimiento') {
      return err(res, 400, 'ese aviso no es del mantenimiento: el % se lo pagás vos y se avisa al registrarlo');
    }
    const nombres = String(av.cajas || '').split(',').map((x) => x.trim()).filter(Boolean);
    const cajas = nombres.map((n) => {
      const mv = (chat.cuentas(null).clientes.find((x) => x.cliente_id === av.cliente_id) || { movs: [] })
        .movs.filter((m) => m.tipo === 'mensualidad' && m.panel === n).slice(-1)[0];
      const per = mv ? chat.periodoDesde(mv.fecha) : null;
      return { caja: chat.comoLaLlamaElCliente(n) || n, periodo: per ? per.texto : '' };
    });
    const archivos = chat.archivosDeAviso(av.id)
      .map((x) => chat.archivoDeAviso(av.id, x.ord)).filter(Boolean);
    const r = await require('../chat-avisos.service').avisarMantenimientoCobrado(av, cajas, archivos);
    r.ok ? ok(res, { ...r, cajas: cajas.length, archivos: archivos.length }) : err(res, 502, r.error);
  }));
  // Cuáles trae — hasta tres. La pantalla los ofrece todos en vez de suponer que hay uno.
  app.get('/api/os/chat/avisos/:id/archivos', (req, res) =>
    ok(res, { archivos: chat.archivosDeAviso(req.params.id) }));
  app.get('/api/os/chat/avisos/:id/archivo', (req, res) => {
    const a = chat.archivoDeAviso(req.params.id, req.query.n || 0);
    if (!a || !a.archivo_b64) return err(res, 404, 'ese aviso no trae comprobante');
    /* Se sirve con el tipo que se guardó —ya filtrado a imágenes— y además con estas dos, que son
       las que impiden que un archivo subido desde afuera se ejecute como página adentro de tu
       sesión: nosniff para que el navegador no adivine el tipo, y Content-Disposition para que lo
       trate como archivo y no como documento. */
    res.setHeader('Content-Type', a.archivo_tipo || 'application/octet-stream');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', 'inline; filename="comprobante"');
    res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; sandbox");
    res.setHeader('Cache-Control', 'no-store, private');
    res.send(Buffer.from(a.archivo_b64, 'base64'));
  });
  app.post('/api/os/chat/solicitudes/:id', wrap((req, res) => {
    const r = chat.resolverSolicitud(req.params.id, (req.body || {}).listo === true);
    r.ok ? ok(res, r) : err(res, 400, r.error);
  }));
  app.post('/api/os/chat/avisos/:id/resolver', wrap((req, res) => {
    const aprobar = (req.body || {}).aprobar === true;
    /* El aviso se lee ANTES de resolverlo: al aprobarlo cambia de estado, y después ya no se sabe
       de qué cajas era ni qué monto tenía sin volver a armarlo. */
    const av = chat.avisoPorId(req.params.id);
    const r = chat.resolverAviso(req.params.id, aprobar);
    if (!r.ok) return err(res, 400, r.error);
    /* ⚠️ SI ERA DEL MANTENIMIENTO, SE LE REENVÍA AL PROVEEDOR CON EL COMPROBANTE. Esa plata le
       entró a él directo —las wallets del mantenimiento son suyas— y sin esto le llega una
       transferencia sin saber de qué caja ni de qué período es.
       Sale DESPUÉS de contestar: que Telegram falle no puede hacer que la pantalla diga que el
       aviso no se aprobó, cuando el saldo ya se movió. */
    if (aprobar && av && av.concepto === 'mantenimiento') {
      const nombres = String(av.cajas || '').split(',').map((x) => x.trim()).filter(Boolean);
      const cajas = nombres.map((n) => {
        const p = chat.list().find((x) => x.cliente_id === av.cliente_id && x.panel === n) || {};
        const mv = (chat.cuentas(null).clientes.find((x) => x.cliente_id === av.cliente_id) || { movs: [] })
          .movs.filter((m) => m.tipo === 'mensualidad' && m.panel === n).slice(-1)[0];
        const per = mv ? chat.periodoDesde(mv.fecha) : null;
        return { caja: chat.comoLaLlamaElCliente(n) || n, periodo: per ? per.texto : '' };
      });
      const archivos = chat.archivosDeAviso(av.id)
        .map((x) => chat.archivoDeAviso(av.id, x.ord)).filter(Boolean);
      res.on('finish', () => {
        require('../chat-avisos.service').avisarMantenimientoCobrado(av, cajas, archivos)
          .then((x) => { if (!x.ok) console.warn('[Chat] no se le avisó el mantenimiento al proveedor:', x.error); })
          .catch((e) => console.warn('[Chat] error avisando el mantenimiento:', e.message));
      });
    }
    ok(res, r);
  }));
  // La mensualidad se cobra el día de cada panel, así que tiene su propio botón y su propia fecha.
  app.post('/api/os/chat/mensualidad', wrap((req, res) => {
    const r = chat.cobrarMensualidad(req.body || {});
    r.ok ? ok(res, r) : err(res, 400, r.error);
  }));
  /* AVISARLE LA MENSUALIDAD AL CLIENTE. Sale para AFUERA. Va de a una porque cada caja tiene su
     día: mandar "vencen tus cuatro" el día de la primera sería cobrarle cuatro antes de tiempo. */
  app.post('/api/os/chat/mensualidad/avisar', wrap(async (req, res) => {
    const b = req.body || {};
    const cid = String(b.cliente_id || '');
    const d = chat.destino(cid);
    if (!d.grupos.length) return err(res, 400, 'ese cliente todavía no tiene grupo de Telegram para este servicio');
    const c = chat.config();
    const fecha = String(b.fecha || '').slice(0, 10) || fechaTZ();
    const per = chat.periodoDesde(fecha);
    /* La caja se nombra por su LINK, igual que en la cuenta del mes. Si un mensaje dice
       «ganamoscpy.com» y el otro «AgenteFortuna», el cliente cree que son dos cajas distintas —y
       ese nombre interno se lo pusimos nosotros, él nunca lo usó. Sin link cargado, el nombre. */
    const cajaAv = chat.list().find((p) => p.cliente_id === cid && p.panel === String(b.panel || ''));
    const comoSeLlama = chatDoc.soloDominio(cajaAv && cajaAv.link_jugadores) || b.panel || 'tu caja';
    const texto = `<b>Chat Externo</b> · mantenimiento de <b>${comoSeLlama}</b>\n`
      + (per ? `Período <b>${per.texto}</b>\n` : '')
      + `A pagar: <b>${c.mensualidad} ${c.mensualidad_moneda}</b>.\n`
      + `Podés ver tu cuenta y cómo pagar acá:\n${_urlPublica(req)}/chat`;
    const tok = chat.botToken();
    const idas = [];
    for (const g of d.grupos) {
      // eslint-disable-next-line no-await-in-loop
      const r1 = await telegram.sendMessage(tok, g, texto);
      idas.push({ grupo: g, ok: !!r1.ok, error: r1.error || null });
    }
    const fallaron = idas.filter((x) => !x.ok);
    const r = fallaron.length
      ? { ok: false, error: fallaron.map((x) => `${x.grupo}: ${x.error}`).join(' · ') }
      : { ok: true };
    chat.marcarAvisoMens(cid, b.panel, fecha, r);
    r.ok ? ok(res, { avisado: idas.length, idas })
      : err(res, 502, `salió a ${idas.length - fallaron.length} de ${idas.length}: ${r.error}`, { idas });
  }));
  /* ── LO QUE LE PAGASTE AL PROVEEDOR ─────────────────────────────────────────────────────────
     Antes un mes pagado y uno impago se veían idénticos. */
  app.post('/api/os/chat/pagos', wrap((req, res) => {
    const r = chat.pagar(req.body || {});
    if (!r.ok) return err(res, 400, r.error);
    /* Y se le avisa al proveedor, DESPUÉS de contestar. El pago ya quedó registrado: que Telegram
       tarde o falle no puede hacer que la pantalla diga que no se guardó. Si no sale, se ve en el
       aviso de abajo y se puede volver a mandar. */
    res.on('finish', () => {
      require('../chat-avisos.service').avisarPagoAlProveedor(r.pago)
        .then((x) => { if (!x.ok) console.warn('[Chat] no se le avisó al proveedor:', x.error); })
        .catch((e) => console.warn('[Chat] error avisando al proveedor:', e.message));
    });
    ok(res, r);
  }));
  /* Reenviar el aviso de un pago que no salió. No registra nada: sólo vuelve a mandar. */
  app.post('/api/os/chat/pagos/:id/avisar', wrap(async (req, res) => {
    const pago = (chat.pagos(null) || []).find((x) => String(x.id) === String(req.params.id));
    if (!pago) return err(res, 404, 'no existe ese pago');
    const x = await require('../chat-avisos.service').avisarPagoAlProveedor(pago);
    x.ok ? ok(res, x) : err(res, 502, x.error);
  }));
  app.delete('/api/os/chat/pagos/:id', wrap((req, res) => ok(res, chat.borrarPago(req.params.id))));
}

module.exports = { mount };
