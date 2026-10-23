/**
 * api-tbs.routes.js — API y TBS: cuentas de API, ofertas, sellos, el diario de TBS y la pantalla /tbs.
 * Sale de os.routes.js (fase 2): las rutas se movieron tal cual y en el mismo orden.
 */
const clientes = require('../clientes-store');
const apiStore = require('../api-store');
const tbsDiario = require('../tbs-diario-store');
const tbsDiarioSvc = require('../tbs-diario.service');
const tbsComparativa = require('../tbs-comparativa');
const apiCuenta = require('../api-cuenta.service');
const apiCuentaDoc = require('../api-cuenta-doc');
const apiCuentaHtml = require('../api-cuenta-html');
const apiResumen = require('../api-resumen.service');
const tgDestino = require('../telegram-destino');
const casinoConex = require('../casino-conexiones-store');
const facturaSvc = require('../factura.service');
const configStore = require('../config-store');
const telegram = require('../telegram');
const ofertas = require('../api-ofertas-store');
const ofertaHtml = require('../api-oferta-html');
const chat = require('../chat-externo.store');
const { db } = require('../db');
const { mesTZ } = require('../lib/fechas'); // fechaTZ/mesTZ=ART (billing) · fechaUTC/mesUTC=UTC (casino)
const { ok, err, wrap, html, _urlPublica } = require('./comun');

/* La conexión con motor TBS y su cliente. Estaba repetido en cada ruta que le habla, y la tercera
   copia es donde uno se olvida de comprobar que tenga credenciales. */
function _tbsCliente(conexionId) {
  const cx = casinoConex.list().find((c) => c.motor === 'tbs' && (!conexionId || c.id === conexionId));
  if (!cx) return { error: 'no hay ninguna conexión con motor TBS configurada' };
  const cli = casinoConex.client(cx.id);
  if (!cli) return { error: `la conexión "${cx.nombre}" no tiene credenciales cargadas` };
  return { cli, nombre: cx.nombre, id: cx.id };
}

function mount(app) {
  /* TBS es su propio espacio de trabajo, no una pestaña del comercial: otros clientes, otros
     proveedores y otro cierre de mes. Desde el 6-sep-2026 también es su propio ARCHIVO.
     Antes servía el mismo os.html y se armaba distinto según la URL: 10.000 líneas para tres
     espacios, donde tocar una pantalla del panel podía romper TBS y nadie se enteraba hasta el
     cierre. Lo que de verdad se comparte quedó compartido en serio —`/estilos.css` y
     `/pantalla-tc.js`, que es LA MISMA pantalla de Tipos de cambio— y el resto se separó. */
  app.get('/tbs', (_req, res) => html(res, 'tbs.html'));
  /**
   * Qué meses de TBS ya están guardados. Es el equivalente de "Meses con foto" del comercial: hasta
   * ahora la precarga de TBS existía pero no se veía, así que para saber si un mes estaba sacado
   * había que apretar y esperar.
   */
  app.get('/api/os/api/guardado', wrap((_req, res) => {
    const filas = db.prepare(`SELECT mes, COUNT(*) n, MAX(capturedAt) ultimo
      FROM ganancias_cache WHERE nodo LIKE 'api:%' OR nodo LIKE '_tbs%' OR nodo='_pago_general'
      GROUP BY mes ORDER BY mes DESC`).all();
    ok(res, { meses: filas });
  }));
  // TBS: los 53 grupos de proveedores con su id, para poder mapearlos contra la matriz.
  app.get('/api/os/tbs/grupos', wrap(async (_req, res) => {
    const cx = casinoConex.list().find((c) => c.motor === 'tbs' && c.activa);
    if (!cx) return err(res, 400, 'no hay ninguna conexión con motor TBS configurada');
    const cli = casinoConex.client(cx.id);
    if (!cli) return err(res, 400, `la conexión "${cx.nombre}" no tiene credenciales cargadas`);
    const r = await cli.grupos();
    r.ok ? ok(res, { conexion: cx.nombre, ...r }) : err(res, 502, r.error, { diag: r.diag || [] });
  }));
  // ───────── 🔌 API (TBS) — el otro negocio ─────────
  // Padrón APARTE del de fichas: otros clientes, otros %, y el % es POR SELLO.
  app.get('/api/os/api/clientes', (_req, res) => ok(res, { clientes: apiStore.listClientes() }));
  app.post('/api/os/api/clientes', wrap((req, res) => {
    const r = apiStore.saveCliente(req.body || {});
    r.ok ? ok(res, r) : err(res, 400, r.error);
  }));
  app.delete('/api/os/api/clientes/:id', wrap((req, res) => ok(res, apiStore.removeCliente(req.params.id))));
  /* El nombre del cierre va por su propia ruta y no por `saveCliente`: aquélla reescribe login,
     agente y notas con lo que venga en el cuerpo, así que mandarle sólo el nombre los borraría. */
  app.put('/api/os/api/clientes/:id/nombre', wrap((req, res) => {
    const r = apiStore.setDeQuien(req.params.id, (req.body || {}).nombre);
    r.ok ? ok(res, r) : err(res, 400, r.error);
  }));
  app.delete('/api/os/api/clientes/:id/nombres-viejos', wrap((req, res) => {
    const r = apiStore.limpiarNombresViejos(req.params.id);
    r.ok ? ok(res, r) : err(res, 400, r.error);
  }));
  app.get('/api/os/api/sellos', (_req, res) => ok(res, { sellos: apiStore.listSellos() }));
  app.get('/api/os/api/paquetes', (_req, res) => ok(res, { paquetes: ofertas.listPaquetes() }));
  app.post('/api/os/api/paquetes', wrap((req, res) => {
    const r = ofertas.savePaquete(req.body || {});
    r.ok ? ok(res, r) : err(res, 400, r.error);
  }));
  app.delete('/api/os/api/paquetes/:id', wrap((req, res) => ok(res, ofertas.removePaquete(req.params.id))));
  /* Armar una oferta con un solo número: la base. Devuelve las líneas listas para editar y
     guardar — no escribe nada. Ver el porqué de la tarifa en api-ofertas-store.js. */
  /* ── CUÁNTO MOVIÓ CADA SELLO ────────────────────────────────────────────────────────────────
     El armador de ofertas discute el precio de 37 externos, y resulta que en julio 19 de ellos no
     movieron una sola ficha: los externos enteros fueron el 0,21% del GGR. Sin este número al lado
     del precio, se negocia a ciegas el 0,2% del negocio con el mismo cuidado que el 99,8%.
     Sale de las cuentas ya calculadas del mes, así que no le pide nada nuevo a TBS. */
  app.get('/api/os/api/volumen', wrap((req, res) => {
    const mes = String(req.query.mes || mesTZ()).slice(0, 7);
    const r = apiCuenta.cuentas({ mes });
    if (!r.ok) return err(res, 400, r.error);
    const ggr = {};
    for (const c of r.cuentas || []) {
      for (const l of c.lineas || []) {
        ggr[l.sello] = (ggr[l.sello] || 0) + (Number(l.ggr_usd) || 0);
      }
    }
    const total = Object.values(ggr).reduce((a, b) => a + b, 0);
    ok(res, { mes, total, ggr, cuentas: (r.cuentas || []).length });
  }));
  app.get('/api/os/api/oferta-desde-base', (req, res) => {
    const r = ofertas.armarDesdeBase(req.query.base, {
      puntos: req.query.puntos, minExt: req.query.min_ext, maxExt: req.query.max_ext,
    });
    if (r.error) return res.status(400).json({ ok: false, error: r.error });
    ok(res, r);
  });
  /* Recomponer los paquetes por lo que cuesta cada proveedor. Sin `aplicar` sólo dice qué
     movería: esto cambia lo que el cliente ve agrupado en el documento, así que se mira antes. */
  app.post('/api/os/api/paquetes/recomponer', wrap((req, res) => {
    const b = req.body || {};
    const r = ofertas.recomponerPorCosto({
      aplicar: b.aplicar === true,
      excluir: Array.isArray(b.excluir) ? b.excluir : [],
    });
    if (r.error) return err(res, 400, r.error);
    ok(res, r);
  }));
  /* ── EN QUÉ SECCIÓN SE MUESTRA CADA PROVEEDOR ───────────────────────────────────────────────
     Sólo afecta al documento: el sello, su costo y lo que se factura no se tocan. Sirve para las
     bolsas mezcladas de TBS, donde un sello trae una mesa en vivo y dos catálogos de slots. */
  app.get('/api/os/api/prov-seccion', (_req, res) => ok(res, { secciones: ofertas.listSecciones() }));
  app.put('/api/os/api/prov-seccion', wrap((req, res) => {
    const b = req.body || {};
    const r = ofertas.setSeccion(b.prov, b.paquete_id);
    r.ok ? ok(res, { ...r, secciones: ofertas.listSecciones() }) : err(res, 400, r.error);
  }));
  app.get('/api/os/api/ofertas', (_req, res) => ok(res, { ofertas: ofertas.listOfertas() }));
  app.get('/api/os/api/ofertas/:id', (req, res) => {
    const o = ofertas.getOferta(req.params.id);
    if (!o) return err(res, 404, 'no existe esa oferta');
    ok(res, { oferta: o, mostrar: ofertas.paraMostrar(o) });
  });
  app.post('/api/os/api/ofertas', wrap((req, res) => {
    const r = ofertas.saveOferta(req.body || {});
    r.ok ? ok(res, r) : err(res, 400, r.error);
  }));
  app.delete('/api/os/api/ofertas/:id', wrap((req, res) => ok(res, ofertas.removeOferta(req.params.id))));
  /* El precio de UN sello, a mano. Vacío lo devuelve al precio de su paquete. */
  app.put('/api/os/api/ofertas/:id/precio', wrap((req, res) => {
    const o = ofertas.getOferta(req.params.id);
    if (!o) return err(res, 404, 'no existe esa oferta');
    const b = req.body || {};
    const r = ofertas.precioDeSello(o, b.sello, b.pct);
    r.ok ? ok(res, { ...r, mostrar: ofertas.paraMostrar(r.oferta) }) : err(res, 400, r.error);
  }));
  /* Qué proveedores NO van en esta oferta. Ruta propia y no `saveOferta` entero: destildar una
     casilla no tiene por qué reescribir las líneas de precio, y si la pantalla mandara una lista
     vieja de líneas junto con la casilla, pisaría precios sin que nadie lo pidiera. */
  app.put('/api/os/api/ofertas/:id/excluidos', wrap((req, res) => {
    const o = ofertas.getOferta(req.params.id);
    if (!o) return err(res, 404, 'no existe esa oferta');
    const b = req.body || {};
    const r = ofertas.saveOferta({ ...o, excluidos: Array.isArray(b.excluidos) ? b.excluidos : [] });
    r.ok ? ok(res, { ...r, mostrar: ofertas.paraMostrar(r.oferta) }) : err(res, 400, r.error);
  }));
  // Qué cambiaría en la matriz. NO escribe: se mira antes de tocar precios que ya se facturan.
  app.get('/api/os/api/ofertas/:id/diff', (req, res) => {
    const o = ofertas.getOferta(req.params.id);
    if (!o) return err(res, 404, 'no existe esa oferta');
    const cid = req.query.cliente_id || o.cliente_id;
    if (!cid) return err(res, 400, 'falta a qué cuenta compararla');
    ok(res, ofertas.diff(o, cid));
  });
  /* El documento. Sale de `paraMostrar`, que devuelve SÓLO nombre de paquete, proveedores y el %
     del cliente: ni el costo, ni el margen, ni los puntos de los socios, ni el nombre del sello.
     La forma más segura de no filtrar un dato interno es no tenerlo a mano. */
  /* Mandar la oferta por Telegram, al mismo grupo al que va la factura de ese cliente.
     Va como TEXTO, no como archivo: se lee en el teléfono sin descargar nada, que es donde el
     cliente la va a mirar. Y con el mismo cinturón que el documento — si aparece un dato interno
     no se manda, porque de un mensaje enviado no se vuelve. */
  app.post('/api/os/api/ofertas/:id/telegram', wrap(async (req, res) => {
    const o = ofertas.getOferta(req.params.id);
    if (!o) return err(res, 404, 'no existe esa oferta');
    const cid = String((req.body || {}).cliente_id || o.cliente_id || '').trim();
    if (!cid) return err(res, 400, 'Elegí a qué cuenta va antes de mandarla');

    const cli = clientes.get(cid) || apiStore.getCliente(cid);
    if (!cli) return err(res, 404, 'no encontré ese cliente');
    const dest = tgDestino.destinoDe(cli, (id) => clientes.get(id));
    if (!dest.chatId) return err(res, 400, 'Ese cliente no tiene grupo de Telegram configurado');

    const m = ofertas.paraMostrar(o);
    const { escTexto: esc } = require('../lib/html');
    const pct = (x) => String(x).replace(/\.0+$/, '').replace('.', ',') + '%';
    const lineas = ['<b>Oferta comercial</b>'];
    if (m.titulo) lineas.push(esc(m.titulo));
    lineas.push('', '<i>Porcentaje sobre el GGR de cada proveedor.</i>',
      '<i>Es una oferta base: los porcentajes se conversan y se acuerdan, y bajan a medida que '
      + 'crece el volumen.</i>', '');
    /* La misma aclaración que la hoja, y por el mismo motivo: sin ella, un proveedor con dos
       precios se lee como un error de armado. Sólo sale si hay alguno repetido. */
    if ((m.repetidos || []).length) {
      lineas.push('<i>Algunos proveedores figuran más de una vez: llegan por integraciones '
        + 'distintas, o en más de una versión —una más completa y más cara—. Se contratan por '
        + 'separado.</i>', '');
    }
    /* La misma forma que el documento: un precio de título y sus proveedores debajo. Si el
       mensaje y la hoja se leyeran distinto, el cliente creería que son dos ofertas. */
    for (const g of m.grupos || []) {
      const niveles = g.niveles || [];
      const uno = niveles.length === 1;
      lineas.push(`<b>${esc(g.nombre)}</b>`
        + (uno ? ` — ${esc(pct(niveles[0].pct))}` : ` — de ${esc(pct(g.desde))} a ${esc(pct(g.hasta))}`));
      if (uno) {
        lineas.push(esc(niveles[0].proveedores.join(' · ')));
      } else {
        for (const n of niveles) {
          lineas.push('', `<b>${esc(pct(n.pct))}</b>`, esc(n.proveedores.join(' · ')));
        }
      }
      lineas.push('');
    }
    if (m.notas) lineas.push(`<i>${esc(m.notas)}</i>`, '');
    lineas.push('<i>Latam Games</i>');
    const texto = lineas.join('\n');

    if (/costo|margen|pts_ib|pts_henry|pct_proveedor|grupo_id/i.test(texto)) {
      return err(res, 500, 'el mensaje traía datos internos: NO se mandó. Avisá que esto pasó.');
    }
    const r = await telegram.sendMessage(configStore.getTelegramToken(), dest.chatId, texto);
    if (!r.ok) return err(res, 502, r.error || 'Telegram no lo aceptó');
    ok(res, { enviado: true, heredado: dest.heredado, de: dest.de });
  }));
  app.get('/api/os/api/ofertas/:id/doc', (req, res) => {
    const o = ofertas.getOferta(req.params.id);
    if (!o) return err(res, 404, 'no existe esa oferta');
    const m = ofertas.paraMostrar(o);
    const html = ofertaHtml.pagina(m);
    // Cinturón y tiradores: esto se le muestra a un cliente y no hay vuelta atrás.
    if (/costo|margen|pts_ib|pts_henry|pct_proveedor|grupo_id/i.test(html)) {
      return err(res, 500, 'el documento traía datos internos: NO se generó. Avisá que esto pasó.');
    }
    res.type('text/html; charset=utf-8').send(html);
  });
  app.post('/api/os/api/ofertas/:id/aplicar', wrap((req, res) => {
    const o = ofertas.getOferta(req.params.id);
    if (!o) return err(res, 404, 'no existe esa oferta');
    const r = ofertas.aplicar(o, (req.body || {}).cliente_id);
    r.ok ? ok(res, r) : err(res, 400, r.error);
  }));
  app.post('/api/os/api/sellos', wrap((req, res) => {
    const r = apiStore.saveSello(req.body || {});
    r.ok ? ok(res, r) : err(res, 400, r.error);
  }));
  app.delete('/api/os/api/sellos/:nombre', wrap((req, res) => ok(res, apiStore.removeSello(req.params.nombre))));
  // Sembrar el padrón y la matriz de una. Idempotente: no pisa lo cargado salvo que se pida.
  app.post('/api/os/api/sembrar', wrap((req, res) => ok(res, apiStore.sembrar(req.body || {}))));
  app.get('/api/os/api/matriz', (_req, res) => ok(res, apiStore.matriz()));
  app.post('/api/os/api/pct', wrap((req, res) => {
    const b = req.body || {};
    const r = apiStore.setPct(b.cliente_id, b.sello, b);
    r.ok ? ok(res, r) : err(res, 400, r.error, { confirmar: !!r.confirmar, empresa: r.empresa, suma: r.suma });
  }));
  // Dar de baja un proveedor para un cliente. Hace falta de verdad: si un sello se le desactiva
  // en TBS, dejarle el precio cargado lo mantiene en la lista de revisión para siempre. Sin precio
  // el GGR que llegue cae en "sinPrecio", que se ve — no se factura por las dudas ni desaparece.
  app.delete('/api/os/api/pct/:cliente/:sello', wrap((req, res) =>
    ok(res, apiStore.removePct(req.params.cliente, req.params.sello))));
  // Lo que se le paga al proveedor contra lo que el sello cuesta. No necesita TBS.
  app.get('/api/os/api/revision', (_req, res) => ok(res, apiCuenta.revisarCostos()));
  // El cierre del mes de API: una fila por cuenta, y el dueño elige cuáles entran en el total.
  app.get('/api/os/api/resumen', wrap((req, res) => {
    const r = apiResumen.resumen({ mes: String(req.query.mes || mesTZ()).slice(0, 7) });
    r.ok ? ok(res, r) : err(res, 400, r.error);
  }));
  app.post('/api/os/api/resumen/sel', wrap((req, res) => {
    const b = req.body || {};
    if (!b.mes || !b.clave) return err(res, 400, 'falta el mes o la clave');
    ok(res, apiStore.setEnResumen(b.mes, b.clave, b.entra !== false, b.motivo));
  }));
  // Cobros por mes: todas las cuentas desde junio, con el monto y si pagó.
  app.get('/api/os/api/cobros', wrap((req, res) => {
    const r = apiResumen.cobros({ desde: req.query.desde || '2026-06', hasta: req.query.hasta || mesTZ() });
    r.ok ? ok(res, r) : err(res, 400, r.error);
  }));
  // El resumen de deuda de una cuenta: los meses pendientes y el total. Vista para el cliente.
  app.get('/api/os/api/cobros/:clave/pagina', wrap((req, res) => {
    const d = apiResumen.deuda({ clave: req.params.clave, desde: req.query.desde || '2026-06', hasta: mesTZ() });
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store, private');
    res.send(apiCuentaHtml.paginaDeuda(d, d.ok ? apiResumen.deudaTexto(d) : ''));
  }));
  // Marcar / desmarcar que pagó. Se guarda con el monto que tenía la cuenta en ese momento.
  app.post('/api/os/api/cobros', wrap((req, res) => {
    const b = req.body || {};
    const r = apiStore.setCobro(b.mes, b.clave, b.pagado !== false, b.monto);
    r.ok ? ok(res, r) : err(res, 400, r.error);
  }));
  // Mandarle a un cliente de API su cuenta del mes por Telegram.
  // SALE PARA AFUERA: se pide confirmación en la pantalla y se manda la vista 'cliente', que por
  // construcción no lleva lo que le pagamos al proveedor ni cómo se reparte adentro.
  app.post('/api/os/api/cuenta/:clienteId/enviar', wrap(async (req, res) => {
    const b = req.body || {};
    const mes = String(b.mes || mesTZ()).slice(0, 7);
    const cl = apiStore.listClientes().find((x) => String(x.id) === String(req.params.clienteId));
    if (!cl) return err(res, 404, 'cuenta de API no encontrada');
    const tok = configStore.getTelegramToken();
    if (!tok) return err(res, 400, 'falta el token del bot de Telegram (⚙ Config)');

    // DOS DESTINOS, Y NO SON LO MISMO.
    // La MATRIZ recibe todas las cuentas siempre: es la copia interna de lo que se emitió.
    // El grupo del CLIENTE es una decisión por vez — el dueño manda algunas y otras no — así que
    // hay que pedirlo explícitamente. Que el destino de afuera necesite un pedido expreso y el de
    // adentro no, es a propósito: un clic de más no puede terminar en el chat de un cliente.
    const matriz = configStore.getApiGrupoMatriz();
    const alCliente = b.al_cliente === true;
    const chatCli = (cl.telegram_chat_id || '').trim();
    const destinos = [];
    if (matriz) destinos.push({ chat: matriz, quien: 'matriz' });
    if (alCliente) {
      if (!chatCli) return err(res, 400, `${cl.login} no tiene grupo propio cargado (se pone en 👥 Cuentas de API). Sin marcar "también al cliente" igual se manda a la matriz.`);
      if (chatCli !== matriz) destinos.push({ chat: chatCli, quien: cl.login });
    }
    if (!destinos.length) {
      return err(res, 400, 'no hay a dónde mandar: falta el grupo matriz (⚙ Config → Telegram) '
        + 'y no se pidió mandarlo al cliente');
    }

    const r = apiCuenta.cuentas({ mes });
    if (!r.ok) return err(res, 400, r.error);
    const cuenta = (r.cuentas || []).find((x) => String(x.cliente_id) === String(cl.id));
    if (!cuenta) return err(res, 400, `${cl.login} no tiene consumo en ${mes}: no hay nada que mandar`);
    const doc = apiCuentaDoc.documento({ cuenta, mes, vista: 'cliente',
      alcance: ['propio', 'caja', 'total'].includes(b.alcance) ? b.alcance : 'total', caja_id: b.caja_id || null });
    if (!doc.ok) return err(res, 400, doc.error);

    // Cinturón y tiradores: la lista blanca ya lo garantiza, pero esto sale para afuera y no hay
    // vuelta atrás. Si alguna vez alguien agrega un campo al motor, acá se frena antes de mandarlo.
    // El link se crea SIEMPRE y guarda el documento proyectado: el mensaje lleva el resumen y el
    // detalle vive en la página, que es la que el dueño venía mandando.
    const l = apiCuentaDoc.crearLink(doc, cl.id);
    const txt = apiCuentaDoc.aTexto(doc, { titulo: apiResumen.comoLoLlama(cl),
      link: `${_urlPublica(req)}/cuenta/${l.token}` });
    if (/proveedor|usdt_empresa|pts_ib|pts_henry|costo_sello/i.test(JSON.stringify(doc))) {
      return err(res, 500, 'la cuenta del cliente traía datos internos: NO se mandó nada. Avisá que esto pasó.');
    }
    const partes = facturaSvc.partir(txt);
    // Se manda a un destino por vez y se informa CADA UNO. Si falla el segundo, el primero ya salió
    // y hay que decirlo: dar un error a secas dejaría creyendo que no se mandó nada.
    const hechos = [];
    for (const d of destinos) {
      let error = null;
      for (const p of partes) { const x = await telegram.sendMessage(tok, d.chat, p); if (!x.ok) { error = x.error; break; } }
      hechos.push({ quien: d.quien, chat: d.chat, ok: !error, error });
      console.log(`[API] cuenta de ${cl.login} (${mes}) → ${d.quien}: ${error ? 'FALLÓ ' + error : partes.length + ' mensaje(s)'}`);
    }
    const fallaron = hechos.filter((x) => !x.ok);
    if (fallaron.length === hechos.length) {
      return err(res, 502, `no se pudo mandar a ninguno: ${fallaron.map((x) => x.quien + ' — ' + x.error).join(' · ')}`, { destinos: hechos });
    }
    ok(res, { enviado: true, partes: partes.length, total_usdt: doc.usdt_cliente, destinos: hechos,
      aviso: fallaron.length ? `se mandó a ${hechos.length - fallaron.length} de ${hechos.length}: falló ${fallaron.map((x) => x.quien).join(', ')}` : null });
  }));
  // La MISMA página que va a ver el cliente, pero detrás del login. Un solo renderizador y dos
  // puertas: si el dueño revisa una cosa y el cliente ve otra, nadie se entera hasta el reclamo.
  app.get('/api/os/api/cuenta/:clienteId/pagina', wrap((req, res) => {
    const mes = String(req.query.mes || mesTZ()).slice(0, 7);
    const r = apiCuenta.cuentas({ mes });
    if (!r.ok) return err(res, 400, r.error);
    const c = (r.cuentas || []).find((x) => String(x.cliente_id) === String(req.params.clienteId));
    const d = apiCuentaDoc.documento({ cuenta: c, mes, vista: 'cliente',
      alcance: ['propio', 'caja', 'total'].includes(req.query.alcance) ? req.query.alcance : 'total',
      caja_id: req.query.caja_id || null });
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store, private');
    res.send(d.ok ? apiCuentaHtml.pagina(d, { nota: 'Vista previa' }) : apiCuentaHtml.paginaError(d.error));
  }));
  // El documento de UNA cuenta. La vista 'cliente' se arma acá, en el servidor, con lista blanca:
  // lo que le pagamos al proveedor no puede viajar al navegador y esconderse con CSS.
  app.get('/api/os/api/cuenta/:clienteId', wrap((req, res) => {
    const mes = String(req.query.mes || mesTZ()).slice(0, 7);
    const r = apiCuenta.cuentas({ mes });
    if (!r.ok) return err(res, 400, r.error);
    const c = (r.cuentas || []).find((x) => String(x.cliente_id) === String(req.params.clienteId));
    const d = apiCuentaDoc.documento({ cuenta: c, mes,
      vista: req.query.vista === 'cliente' ? 'cliente' : 'interno',
      alcance: ['propio', 'caja', 'total'].includes(req.query.alcance) ? req.query.alcance : 'total',
      caja_id: req.query.caja_id || null });
    d.ok ? ok(res, d) : err(res, 404, d.error);
  }));
  // Las DOS cuentas del mes de API: la del cliente y la del proveedor, del mismo GGR.
  app.post('/api/os/api/precargar', wrap(async (req, res) => {
    const b = req.body || {};
    const r = await apiCuenta.precargar({ mes: b.mes || mesTZ(), confirmar: !!b.confirmar, desde: Number(b.desde) || 0,
      limite: Number(b.limite) || 8, refrescar: !!b.refrescar });
    r.ok ? ok(res, r) : err(res, 502, r.error);
  }));
  app.get('/api/os/api/cuentas', wrap((req, res) => {
    const r = apiCuenta.cuentas({ mes: req.query.mes || mesTZ(), cliente_id: req.query.cliente_id || null });
    r.ok ? ok(res, r) : err(res, 400, r.error);
  }));
  // TBS: el árbol de cuentas aplanado. Sin el id de cada cuenta no se le puede pedir el profit.
  app.get('/api/os/tbs/arbol', wrap(async (req, res) => {
    const cx = casinoConex.list().find((c) => c.motor === 'tbs' && c.activa);
    if (!cx) return err(res, 400, 'no hay ninguna conexión con motor TBS configurada');
    const cli = casinoConex.client(cx.id);
    if (!cli) return err(res, 400, `la conexión "${cx.nombre}" no tiene credenciales cargadas`);
    const mes = String(req.query.mes || mesTZ()).slice(0, 7);
    const ult = new Date(Date.UTC(Number(mes.slice(0, 4)), Number(mes.slice(5, 7)), 0)).getUTCDate();
    const r = await cli.arbol({
      desde: req.query.desde || `${mes}-01 00:00:00`,
      hasta: req.query.hasta || `${mes}-${String(ult).padStart(2, '0')} 23:59:59`,
      grupos: req.query.grupos ? String(req.query.grupos).split(',') : [],
    });
    r.ok ? ok(res, { conexion: cx.nombre, mes, ...r }) : err(res, 502, r.error);
  }));
  /**
   * TBS: el profit de unos agentes puntuales, por grupo de proveedores y por moneda.
   * Es la base para calcular cuánto se le paga a cada proveedor (punto 8).
   *
   * ⏱ Tarda ~54s por llamada. `grupos` es un array y se piden TODOS en la misma pasada —
   * pedirlos de a uno serían 53 llamadas, casi una hora.
   */
  app.post('/api/os/tbs/profit', wrap(async (req, res) => {
    const b = req.body || {};
    const cx = casinoConex.list().find((c) => c.motor === 'tbs' && (!b.conexion_id || c.id === b.conexion_id));
    if (!cx) return err(res, 400, 'no hay ninguna conexión con motor TBS configurada');
    const cli = casinoConex.client(cx.id);
    if (!cli) return err(res, 400, `la conexión "${cx.nombre}" no tiene credenciales cargadas`);
    const mes = String(b.mes || mesTZ()).slice(0, 7);
    const ult = new Date(Date.UTC(Number(mes.slice(0, 4)), Number(mes.slice(5, 7)), 0)).getUTCDate();
    const desde = b.desde || `${mes}-01 00:00:00`;
    const hasta = b.hasta || `${mes}-${String(ult).padStart(2, '0')} 23:59:59`;
    const agentes = Array.isArray(b.agentes) ? b.agentes.map(String) : [];
    if (!agentes.length) return err(res, 400, 'hay que decir de qué agentes (agentes: ["3206986", …])');
    const r = await cli.profitDeAgentes({ desde, hasta, agentes, grupos: b.grupos || [] });
    if (!r.ok) return err(res, 502, r.error);
    ok(res, { conexion: cx.nombre, mes, desde, hasta, ...r });
  }));
  /**
   * ── EL TOTAL DE TBS POR DIVISA ────────────────────────────────────────────────────────────
   * Lo que había era por AGENTE, para facturar. Esto contesta la otra pregunta: cuánto movió TBS
   * en cada moneda. Una sola llamada (⏱ ~54s), todos los grupos juntos.
   */
  app.post('/api/os/tbs/total-divisa', wrap(async (req, res) => {
    const b = req.body || {};
    const t = _tbsCliente(b.conexion_id);
    if (t.error) return err(res, 400, t.error);
    const mes = String(b.mes || mesTZ()).slice(0, 7);
    const ult = new Date(Date.UTC(Number(mes.slice(0, 4)), Number(mes.slice(5, 7)), 0)).getUTCDate();
    const desde = b.desde || `${mes}-01 00:00:00`;
    const hasta = b.hasta || `${mes}-${String(ult).padStart(2, '0')} 23:59:59`;
    const r = await t.cli.totalPorDivisa({ desde, hasta, grupos: b.grupos || [] });
    if (!r.ok) return err(res, 502, r.error);
    ok(res, { conexion: t.nombre, mes, desde, hasta, porDivisa: r.porDivisa });
  }));
  /**
   * ── EL REPORTE DIARIO DE TBS ──────────────────────────────────────────────────────────────
   * Casino y Europa tienen su acumulado diario y de ahí sale el Pulso. TBS no lo tenía porque cada
   * consulta tarda ~54s: armar el mes en vivo son 31 llamadas, media hora, cada vez que se abre.
   * Se captura UNA VEZ por día y queda guardado (ver src/tbs-diario-store.js, y por qué NO va en
   * la misma tabla que el motor 463).
   *
   * El plan dice qué días faltan, así que la pantalla puede ir de a uno y mostrar el avance en vez
   * de apretar un botón y esperar media hora sin señales — el mismo patrón que la Foto del mes.
   */
  app.get('/api/os/tbs/diario/plan', (req, res) => {
    const mes = String(req.query.mes || mesTZ()).slice(0, 7);
    const ult = new Date(Date.UTC(Number(mes.slice(0, 4)), Number(mes.slice(5, 7)), 0)).getUTCDate();
    const hoy = mesTZ() === mes ? Number(new Date().toISOString().slice(8, 10)) : ult;
    // No se piden días que todavía no pasaron: la respuesta vendría vacía y habría que rehacerlos.
    const todos = [];
    for (let d = 1; d <= Math.min(ult, hoy); d++) todos.push(`${mes}-${String(d).padStart(2, '0')}`);
    const listos = tbsDiario.diasCapturados(mes);
    const faltan = todos.filter((d) => !listos.includes(d));
    // La estimación sale de lo MEDIDO, no de una constante. La primera versión usaba 54s —el
    // tiempo de una consulta de un MES entero— y daba 28 minutos para algo que tarda dos: con ese
    // número la decisión razonable era no hacerlo nunca.
    const ms = tbsDiario.msPromedio();
    ok(res, { mes, dias: todos.length, capturados: listos.length, faltan,
      ms_por_dia: ms,
      segundos_estimados: ms ? Math.ceil((faltan.length * ms) / 1000) : null,
      medido_en: listos.length });
  });
  app.post('/api/os/tbs/diario/capturar', wrap(async (req, res) => {
    // La lógica vive en el servicio: el cron nocturno pide exactamente lo mismo, y dos copias de
    // "cómo se arma un día" es cómo una se queda vieja — se arregla la que se ve y la otra sigue
    // guardando mal, en silencio, de madrugada.
    const b = req.body || {};
    const r = await tbsDiarioSvc.capturarDia({
      fecha: b.fecha, conexionId: b.conexion_id || null,
      grupos: b.grupos || [], refrescar: !!b.refrescar,
    });
    r.ok ? ok(res, r) : err(res, r.error && /falta la fecha|conexión/.test(r.error) ? 400 : 502, r.error);
  }));
  app.get('/api/os/tbs/diario', (req, res) => ok(res, tbsDiario.delMes(req.query.mes || mesTZ())));
  app.post('/api/os/tbs/diario/borrar-dia', wrap((req, res) => {
    const fecha = String((req.body || {}).fecha || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) return err(res, 400, 'falta la fecha (YYYY-MM-DD)');
    ok(res, { fecha, borradas: tbsDiario.borrarDia(fecha) });
  }));
  /* ── LA COMPARATIVA QUE SE MANDA POR TELEGRAM ────────────────────────────────────────────────
     Es el mensaje que la dueña venía escribiendo a mano cuando le preguntan por un cliente. El
     texto lo arma el SERVIDOR con los datos de la base: si la pantalla mandara el texto ya hecho,
     cualquier cosa que llegue a la ruta de enviar se publicaría tal cual. */
  app.get('/api/os/tbs/comparativa', (req, res) => {
    const ids = String(req.query.ids || '').split(',').map((x) => x.trim()).filter(Boolean);
    const d = tbsComparativa.armar({ mes: req.query.mes || mesTZ(), ids });
    if (!d.ok) return err(res, 400, d.error);
    ok(res, { ...d, texto: tbsComparativa.texto(d), plano: tbsComparativa.textoPlano(d) });
  });
  /* Va SÓLO al grupo interno (⚙ Config → Telegram). Es una decisión, no una limitación: la dueña
     lo usa para contestarle a su gente, y un clic de más no puede terminar en el chat de un
     cliente con los números de otro. El día que haga falta mandárselo a un cliente, se agrega
     pidiéndolo explícitamente, como ya hace la cuenta del mes. */
  app.post('/api/os/tbs/comparativa/enviar', wrap(async (req, res) => {
    const b = req.body || {};
    const tok = configStore.getTelegramToken();
    if (!tok) return err(res, 400, 'falta el token del bot de Telegram (⚙ Config)');
    const chat = configStore.getApiGrupoMatriz();
    if (!chat) return err(res, 400, 'falta el grupo de Telegram (⚙ Config → Telegram → grupo de la matriz)');
    const ids = Array.isArray(b.ids) ? b.ids : String(b.ids || '').split(',').map((x) => x.trim()).filter(Boolean);
    const d = tbsComparativa.armar({ mes: b.mes || mesTZ(), ids });
    if (!d.ok) return err(res, 400, d.error);
    if (!d.filas.length) return err(res, 400, 'no hay ninguna cuenta con movimiento para mandar');
    const txt = tbsComparativa.texto(d);
    const partes = facturaSvc.partir(txt);
    for (const p of partes) {
      const x = await telegram.sendMessage(tok, chat, p);
      if (!x.ok) return err(res, 502, `no se pudo mandar: ${x.error}`);
    }
    console.log(`[TBS] comparativa ${d.mesAnt}→${d.mes} (${d.filas.length} cuentas) al grupo ${chat}`);
    ok(res, { enviado: true, partes: partes.length, cuentas: d.filas.length, chat });
  }));
}

module.exports = { mount };
