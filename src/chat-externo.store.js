/**
 * chat-externo.store.js — EL SERVICIO DE CHAT EXTERNO.
 *
 * ── QUÉ ES ───────────────────────────────────────────────────────────────────────────────────
 * Un servicio de terceros que algunos paneles contratan. Se paga a mes vencido sobre la ganancia
 * del panel, más una mensualidad fija por panel.
 *
 * Los DOS lados tienen precios distintos y ésa es toda la razón de que exista este archivo:
 *   · lo que le cobrás al cliente  → se negocia con él (2%, 2,5%, 4%…)
 *   · lo que te cobra el proveedor → 2% fijo, igual para todos
 * La diferencia es tuya. La factura del cliente dice SU número —si le cobrás 4%, dice 4%— y el
 * proveedor recibe otro papel donde figura el 2% y nada más.
 *
 * ── POR QUÉ NO ES UN SISTEMA APARTE ──────────────────────────────────────────────────────────
 * Son clientes de Imperia que ya están cargados, con paneles que ya están cargados, y la ganancia
 * de cada panel YA se captura todas las noches en `reporte_diario` (in/out/profit por nodo, por
 * día, por moneda). Armarlo aparte habría significado duplicar la lista de paneles y volver a
 * traer las mismas ganancias: dos copias del mismo dato, y el día que difieran nadie sabría cuál
 * está bien. Y la deuda del cliente quedaría partida en dos cuentas que no se pueden sumar.
 *
 * Lo que sí está separado es lo propio: esta tabla, esta pantalla, estos documentos. No toca una
 * línea de fichas, del cierre ni de TBS.
 *
 * ── EL % SE GUARDA COMO EL TOTAL QUE PAGA EL CLIENTE ─────────────────────────────────────────
 * No como "el adicional". Es el número que va en su factura y es el que se piensa al negociar
 * ("a éste le cobro 4"). El margen se calcula restando el costo, que es uno solo y vive en la
 * configuración: guardar el adicional obligaría a sumar de cabeza para saber qué se le está
 * cobrando, justo cuando se está decidiendo cuánto cobrarle.
 */
const { db } = require('./db');
const money = require('./lib/money');
const cfg = require('./config-store');
const paneles = require('./paneles-store');
const clientes = require('./clientes-store');
const tcUnico = require('./tc-unico.service');
const { parseMonto } = require('./lib/monto');

db.exec(`
  CREATE TABLE IF NOT EXISTS chat_panel (
    panel_id TEXT PRIMARY KEY,    -- paneles.id: el servicio se contrata POR PANEL, no por cliente
    pct_cliente TEXT,             -- lo que paga el cliente EN TOTAL (incluye el costo)
    dia_cobro INTEGER,            -- qué día del mes se le cobra la mensualidad
    activo INTEGER DEFAULT 1,
    desde TEXT,                   -- desde cuándo tiene el servicio
    notas TEXT,
    createdAt TEXT
  );

  /* EL DESTINO, POR CLIENTE Y PROPIO DE ESTE PRODUCTO.
     El cliente ya tiene un grupo de Telegram en "clientes.telegram", pero ése es el de las fichas:
     ahí van las cargas y los avisos de siempre. El chat es otro servicio y va a otro grupo, con
     otra gente adentro. Por eso el destino vive acá y no allá: mezclar los dos habría hecho que
     cambiar uno cambiara el otro sin que nadie lo pidiera.
     "enviar_a" es texto libre a propósito — es la nota de a quién se la mandás en la práctica
     ("a Raúl por privado", "al grupo grande"), que no siempre coincide con el grupo. */
  CREATE TABLE IF NOT EXISTS chat_cliente (
    cliente_id TEXT PRIMARY KEY,
    tg_grupo TEXT,                -- el chatId del grupo de ESTE servicio
    enviar_a TEXT,                -- nota: a dónde se la mandás vos
    notas TEXT,
    createdAt TEXT
  );

  /* LO QUE YA LE PAGASTE AL PROVEEDOR.
     Del lado del cliente esto no hace falta: su deuda y sus pagos ya viven en "movimientos", que
     es el libro mayor de todo el sistema. Del lado del proveedor no había NADA —el sistema
     calculaba cuánto le correspondía cobrar cada mes y no registraba en ningún lado si se le pagó—
     así que un mes pagado y uno impago se veían exactamente igual. */
  CREATE TABLE IF NOT EXISTS chat_pago_proveedor (
    id TEXT PRIMARY KEY,
    mes TEXT,                     -- YYYY-MM al que corresponde el pago
    monto TEXT,
    moneda TEXT,
    fecha TEXT,                   -- cuándo se pagó (YYYY-MM-DD)
    nota TEXT,
    createdAt TEXT
  );
  CREATE INDEX IF NOT EXISTS ix_chat_pago_mes ON chat_pago_proveedor(mes);

  /* LA CUENTA DEL CHAT, QUE ES OTRA CUENTA.
     No entra en "movimientos" —el libro mayor de las fichas— y es a propósito. Esta plata no es
     toda de ella: la mitad se le paga al proveedor del servicio. Se cobra en otra wallet, se habla
     en otro grupo y no quiere que su cierre del mes muestre un ingreso que en realidad es de otro.
     Mezclarlas habría hecho que el saldo del cliente sumara dos negocios distintos y que "quién me
     debe" contestara con un número que no se puede pagar de una sola vez.

     Un solo libro con dos tipos: lo que le cobraste ("cobro", uno por cliente y por mes) y lo que
     te pagó ("pago", los que hagan falta). El saldo es la resta. */
  CREATE TABLE IF NOT EXISTS chat_mov (
    id TEXT PRIMARY KEY,
    cliente_id TEXT,
    mes TEXT,                     -- YYYY-MM al que corresponde
    tipo TEXT,                    -- cobro | pago
    monto TEXT,
    moneda TEXT,
    fecha TEXT,
    nota TEXT,
    createdAt TEXT
  );
  /* Cobrar dos veces el mismo mes no puede pasar por apretar dos veces: lo impide la base, no una
     comparación en el código. Los pagos no llevan índice porque puede haber varios. */
  CREATE UNIQUE INDEX IF NOT EXISTS ux_chat_cobro
    ON chat_mov (cliente_id, mes) WHERE tipo='cobro';
  CREATE INDEX IF NOT EXISTS ix_chat_mov_mes ON chat_mov(mes);
  CREATE INDEX IF NOT EXISTS ix_chat_mov_cli ON chat_mov(cliente_id);

  /* LOS AVISOS DE PAGO DEL CLIENTE.
     El cliente abre su hoja y dice "ya pagué", con la captura. Queda PENDIENTE hasta que alguien lo
     mira: acreditar un pago porque subió una imagen sería confiar en la imagen. Se aprueba a mano y
     recién ahí se registra el pago en la cuenta del chat.
     El archivo se guarda EN LA BASE y no en disco, igual que los de fichas: así el comprobante y su
     registro no se pueden separar. */
  CREATE TABLE IF NOT EXISTS chat_comprobante (
    id TEXT PRIMARY KEY,
    cliente_id TEXT,
    mes TEXT,
    monto TEXT,
    moneda TEXT,
    referencia TEXT,
    archivo_nombre TEXT,
    archivo_tipo TEXT,
    archivo_bytes INTEGER,
    archivo_b64 TEXT,
    estado TEXT DEFAULT 'pendiente',   -- pendiente | aprobado | rechazado
    creado_at TEXT,
    resuelto_at TEXT,
    mov_id TEXT                        -- el pago que generó al aprobarse
  );
  CREATE INDEX IF NOT EXISTS ix_chat_cmp_estado ON chat_comprobante(estado);

  /* LOS AVISOS DE MENSUALIDAD.
     La cuenta del mes se manda una vez y ya; las mensualidades caen cada una en su día y hay que
     avisarlas de a una. Sin registro, "¿le avisaste a Ariel de la A3?" no tiene respuesta y la
     respuesta fácil —volver a mandarlo— molesta al cliente dos veces. */
  CREATE TABLE IF NOT EXISTS chat_aviso_mens (
    id TEXT PRIMARY KEY,
    cliente_id TEXT,
    panel TEXT,
    fecha TEXT,                   -- el día que le tocaba
    ok INTEGER,
    error TEXT,
    at TEXT
  );
  CREATE INDEX IF NOT EXISTS ix_chat_avmens ON chat_aviso_mens(fecha);

  /* LAS WALLETS. Son varias y no una: hay una TRC20 y una BEP20 para el mantenimiento, y otra
     distinta para lo del mes. Y no todos los clientes pagan a la misma — a uno se le manda una y a
     otro otra— así que cada cliente puede tener la suya y, si no la tiene, se usa la de siempre.
     La RED va en su propia columna: mandar USDT por la red equivocada es perder la plata. */
  CREATE TABLE IF NOT EXISTS chat_wallet (
    id TEXT PRIMARY KEY,
    alias TEXT,                   -- cómo la llamás vos ("la de Binance")
    red TEXT,                     -- TRC20, BEP20…
    direccion TEXT,
    activa INTEGER DEFAULT 1,
    ord INTEGER,
    createdAt TEXT
  );

  /* PEDIDOS DE UN CHAT NUEVO.
     El cliente ya tiene el servicio en una caja y quiere otro. Lo pide desde su propio portal en
     vez de escribir por privado y que se pierda entre mensajes. No da de alta nada: llega como
     pedido y se resuelve a mano, porque abrir un chat cuesta plata todos los meses. */
  CREATE TABLE IF NOT EXISTS chat_solicitud (
    id TEXT PRIMARY KEY,
    cliente_id TEXT,
    caja TEXT,
    nota TEXT,
    estado TEXT DEFAULT 'pendiente',   -- pendiente | listo | rechazada
    creado_at TEXT,
    resuelto_at TEXT
  );

  /* QUÉ SE MANDÓ, CUÁNDO Y SI LLEGÓ.
     Hoy el sistema manda la factura del mes por Telegram y no deja rastro: si el envío falla, en
     pantalla no se ve nada y la pregunta "¿se la mandaste?" no tiene respuesta. Acá sí queda. */
  CREATE TABLE IF NOT EXISTS chat_envio (
    cliente_id TEXT,
    mes TEXT,
    ok INTEGER,
    error TEXT,
    at TEXT,
    PRIMARY KEY (cliente_id, mes)
  );
`);

/* LOS DOS LINKS DE CADA CAJA.
   Cada caja nueva viene con un link para los jugadores y otro para el panel del administrador. Son
   de la caja y NO se pueden deducir: hay muchos dominios en juego y no hay ninguna relación entre
   el nombre de la cuenta y el dominio que le toca, así que se escriben a mano. El usuario del panel
   se guarda porque es lo que el cliente necesita tener a mano; LA CONTRASEÑA NO — ver `setLinks`.
   Se agregan aparte porque ALTER TABLE tira error si la columna ya está. */
for (const col of ['link_jugadores TEXT', 'link_panel TEXT', 'usuario_admin TEXT']) {
  try { db.exec(`ALTER TABLE chat_panel ADD COLUMN ${col}`); } catch (e) { /* ya estaba */ }
}
// A qué wallet paga ESTE cliente cada cosa. Vacío = la de siempre.
for (const col of ['wallet_ggr TEXT', 'wallet_mens TEXT']) {
  try { db.exec(`ALTER TABLE chat_cliente ADD COLUMN ${col}`); } catch (e) { /* ya estaba */ }
}
/* De qué caja es una mensualidad. Antes se deducía buscando el nombre adentro de la nota, y
   "Ariel-A1" está adentro de "Ariel-A10": una caja quedaba marcada como cobrada por el nombre de
   otra. El dato se guarda, no se adivina. */
try { db.exec('ALTER TABLE chat_mov ADD COLUMN panel TEXT'); } catch (e) { /* ya estaba */ }
try { db.exec('ALTER TABLE chat_comprobante ADD COLUMN archivo_tipo_seguro TEXT'); } catch (e) { /* ya estaba */ }
try { db.exec('CREATE INDEX IF NOT EXISTS ix_chat_cmp_cli ON chat_comprobante(cliente_id)'); } catch (e) { /* ya estaba */ }

const nowISO = () => new Date().toISOString();
/* ⚠️ LAS FECHAS DEL CHAT SON EN HORA ARGENTINA, NO UTC. `nowISO().slice(0,10)` da el día UTC, que
   entre las 21 y las 24 de acá YA ES MAÑANA: la mensualidad se guardaba con la fecha de mañana y
   la pantalla la buscaba con la de hoy, así que "ya cobrada" no se marcaba y se podía cobrar dos
   veces. El acumulado del casino sí corta en UTC —ése es otro reloj y no se toca—; esto es del
   negocio, y el negocio vive acá. */
const { fechaTZ } = require('./lib/fechas');
const hoy = () => fechaTZ();

/* ⚠️ EL CHAT SE CONTRATA POR CAJA, Y LA CAJA SUELE SER UN AGENTE, NO EL SUPERAGENTE.
   Un cliente puede tener varios chats, cada uno colgado de un agente distinto: Fran tiene dos,
   Ariel cuatro. Cada uno se cobra sobre lo que ganó SU agente, así que la ganancia hay que leerla
   en el nivel del panel y no siempre en el de arriba. El acumulado guarda una fila por nivel
   (`grp`), y leer todo como 'superagent' daba cero para cualquier caja que no fuera la de más
   arriba — una factura de menos, sin ningún aviso. */
const GRP_DE_NIVEL = { SuperAgente: 'superagent', Distribuidor: 'distributor', Agente: 'agent' };

/* EL PERÍODO QUE CUBRE UNA MENSUALIDAD.
   "Mensualidad 30 USDT" en la cuenta de alguien no dice por qué mes se le está cobrando, y a la
   tercera el cliente pregunta. Cobrada el 15 de agosto, cubre del 15 de agosto al 14 de septiembre:
   se escribe entero, así el renglón se explica solo dentro de seis meses.
   Los días de cobro están limitados a 1–28 justamente para que el mismo día exista en todos los
   meses; igual se calcula con fechas de verdad por si alguien cobra una suelta un 31. */
const MES_CORTO = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
function periodoDesde(fechaISO) {
  const [y, m, d] = String(fechaISO || '').slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) return null;
  const ini = new Date(Date.UTC(y, m - 1, d));
  /* Mismo día del mes que viene, menos un día. Si ese día no existe en el mes de destino —cobrada
     un 31 de enero, y febrero tiene 28— se toma el último día de ese mes: si no, JavaScript se
     pasa solo al mes siguiente y el período salía un mes y pico. */
  const largoDestino = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const fin = new Date(Date.UTC(y, m, Math.min(d, largoDestino)) - 24 * 60 * 60 * 1000);
  const txt = (x) => `${x.getUTCDate()} ${MES_CORTO[x.getUTCMonth()]}`;
  return { desde: ini.toISOString().slice(0, 10), hasta: fin.toISOString().slice(0, 10), texto: `${txt(ini)} – ${txt(fin)}` };
}

/* El costo y la mensualidad son UNO SOLO para todo el servicio: el proveedor cobra lo mismo por
   todos los paneles. Viven en la configuración global y no repetidos en cada fila — el día que
   cambien, se cambian en un lugar. */
const COSTO = 'chatCostoPct';        // lo que te cobra el proveedor, en %
const MENSUAL = 'chatMensualidad';   // la mensualidad por panel
const MENSUAL_MON = 'chatMensualidadMoneda';
/* EL BOT DE ESTE SERVICIO ES OTRO. El sistema ya tiene un bot para las fichas, pero éste manda a
   otros grupos y con otra cara: si compartieran el token, el mismo bot tendría que estar adentro de
   los dos mundos y un cambio de token cortaría las dos cosas a la vez. Si está vacío se usa el bot
   general, para que funcione desde el primer día sin configurar nada. */
const BOT = 'chatBotToken';
/* CÓMO SE PAGA ESTE SERVICIO. Es otra wallet que la de las fichas, así que va acá y se imprime en
   la hoja del cliente y en su portal: sin eso, la hoja dice cuánto pagar y no dice adónde.
   La RED va en su propio campo y no pegada a la dirección: mandar USDT por la red equivocada es
   perder la plata, y el que copia y pega una línea entera se lleva la red adentro de la dirección. */
const PAGO_NOTA = 'chatPagoNota';
/* Cuál se usa por defecto para cada cosa. Se guarda el id de la wallet, no la dirección: el día que
   cambie la dirección se cambia en un lugar y sigue valiendo para todos. */
const W_GGR = 'chatWalletGgr';      // para el % sobre la ganancia del mes
const W_MENS = 'chatWalletMens';    // para el mantenimiento

/** El token, para usarlo. NO sale nunca en una respuesta HTTP: ver `config()`. */
function botToken() {
  return String(cfg.getCfg(BOT) || '').trim() || cfg.getTelegramToken();
}

function config() {
  // ⚠️ El token NO se devuelve: sólo si hay uno y sus últimos 6 dígitos, para poder reconocerlo.
  // Es la misma regla que el bot general — un token que se puede leer de la pantalla es un token
  // que se puede copiar de una foto de la pantalla.
  const propio = String(cfg.getCfg(BOT) || '').trim();
  return {
    costo_pct: cfg.getCfg(COSTO) || '2',
    mensualidad: cfg.getCfg(MENSUAL) || '',
    mensualidad_moneda: cfg.getCfg(MENSUAL_MON) || 'USDT',
    pago_nota: cfg.getCfg(PAGO_NOTA) || '',
    wallet_ggr: cfg.getCfg(W_GGR) || '',
    wallet_mens: cfg.getCfg(W_MENS) || '',
    bot_propio: !!propio,
    bot_hint: propio ? '…' + propio.slice(-6) : '',
    bot_general: !propio && !!cfg.getTelegramToken(),
  };
}
function setConfig(d) {
  if (d.costo_pct !== undefined) {
    const v = String(d.costo_pct).trim();
    if (!money.esNumero(v)) return { ok: false, error: `"${v}" no es un número. Usá punto para los decimales` };
    if (money.isNeg(v) || money.cmp(v, '100') > 0) return { ok: false, error: 'el costo tiene que estar entre 0 y 100' };
    cfg.setCfg(COSTO, v);
  }
  if (d.mensualidad !== undefined) {
    const v = String(d.mensualidad).trim();
    if (v && !money.esNumero(v)) return { ok: false, error: `"${v}" no es un número` };
    cfg.setCfg(MENSUAL, v);
  }
  if (d.mensualidad_moneda !== undefined) {
    /* La cuenta del chat se lleva en USDT y se suma sin mirar la moneda de cada renglón. Aceptar
       "ARS" acá habría sumado pesos como si fueran dólares y el saldo del cliente saldría cientos
       de veces más grande, rotulado en USDT. Si algún día se cobra en otra moneda, primero hay que
       convertir; hasta entonces, no se acepta. */
    const m = String(d.mensualidad_moneda).trim().toUpperCase() || 'USDT';
    if (!['USDT', 'USD'].includes(m)) {
      return { ok: false, error: 'La mensualidad se cobra en USDT (la cuenta del chat se lleva en USDT).' };
    }
    cfg.setCfg(MENSUAL_MON, m);
  }
  if (d.pago_nota !== undefined) cfg.setCfg(PAGO_NOTA, String(d.pago_nota).slice(0, 400));
  for (const [k, clave] of [['wallet_ggr', W_GGR], ['wallet_mens', W_MENS]]) {
    if (d[k] === undefined) continue;
    const v = String(d[k] || '').trim();
    if (v && !db.prepare('SELECT id FROM chat_wallet WHERE id=?').get(v)) {
      return { ok: false, error: 'esa wallet no existe' };
    }
    cfg.setCfg(clave, v);
  }
  if (d.bot_token !== undefined) {
    const v = String(d.bot_token).trim();
    /* Un token de bot es 123456789:AA... — se valida la forma para no guardar una url pegada de
       más o el nombre del bot, que da un error de Telegram sin explicación cuando ya es tarde. */
    if (v && !/^\d{6,}:[\w-]{30,}$/.test(v)) {
      return { ok: false, error: 'Eso no parece el token de un bot. Tiene esta forma: 123456789:AAF... (te lo da @BotFather)' };
    }
    cfg.setCfg(BOT, v);
  }
  return { ok: true, config: config() };
}

/** Los paneles que tienen el servicio, con su cliente y su precio. */
function list() {
  const filas = db.prepare('SELECT * FROM chat_panel').all();
  const pan = new Map(paneles.list().map((p) => [p.id, p]));
  const cli = new Map(clientes.list().clientes.map((c) => [c.id, c]));
  return filas.map((f) => {
    const p = pan.get(f.panel_id) || {};
    const c = cli.get(p.cliente_id) || {};
    return {
      ...f, activo: f.activo !== 0,
      panel: p.nombre || '(panel borrado)', sistema: p.sistema || '', id_usuario: p.id_usuario || '',
      nivel: p.nivel_usuario || '', grp: GRP_DE_NIVEL[p.nivel_usuario] || 'superagent',
      link_jugadores: f.link_jugadores || '', link_panel: f.link_panel || '',
      usuario_admin: f.usuario_admin || '',
      conexion_id: p.conexion_id || null,
      cliente_id: p.cliente_id || null, cliente: c.nombre || c.codigo || '—',
    };
  }).sort((a, b) => String(a.cliente).localeCompare(String(b.cliente), 'es')
    || String(a.panel).localeCompare(String(b.panel), 'es'));
}

function set(d) {
  const id = String(d.panel_id || '').trim();
  if (!id) return { ok: false, error: 'falta el panel' };
  if (!paneles.get(id)) return { ok: false, error: 'ese panel no existe' };
  const prev = db.prepare('SELECT * FROM chat_panel WHERE panel_id=?').get(id);
  /* Lo que no viene en el pedido NO se pisa: se guarda lo que ya estaba. Guardar el % desde la
     pantalla de precios no puede borrar el día de cobro de la mensualidad —son dos cosas que se
     tocan por separado y en momentos distintos—. Mandar el campo VACÍO sí lo borra: eso es una
     decisión, no un olvido. Por eso se mira si el campo vino, no si tiene valor. */
  const vino = (k) => Object.prototype.hasOwnProperty.call(d, k);
  const pct = vino('pct_cliente')
    ? String(d.pct_cliente == null ? '' : d.pct_cliente).trim()
    : String((prev && prev.pct_cliente) || '');
  if (pct) {
    if (!money.esNumero(pct)) return { ok: false, error: `"${pct}" no es un número. Usá punto para los decimales: 2.5` };
    if (money.isNeg(pct) || money.cmp(pct, '100') > 0) return { ok: false, error: 'el % tiene que estar entre 0 y 100' };
    // Cobrarle MENOS de lo que cuesta se puede querer (una promoción), pero no por accidente.
    // No se frena: se avisa al calcular el mes, donde el margen sale en rojo.
  }
  /* ⚠️ LOS LINKS NO SE DEDUCEN NUNCA. Ni del nombre de la caja, ni del dominio de otra parecida:
     hay muchos dominios en juego y no hay relación entre la cuenta y el que le toca. Un link mal
     armado genera un acceso que no funciona, y eso se descubre después de habérselo mandado a toda
     la gente del cliente. Por eso se validan pero no se completan solos.
     ⚠️ ACÁ NO SE GUARDA NINGUNA CONTRASEÑA. El portal del cliente se abre escribiendo el nombre de
     una caja, sin clave: guardar ahí la contraseña del panel sería publicarla a quien adivine un
     nombre. El usuario sí, que no abre nada por sí solo. */
  const links = {};
  for (const k of ['link_jugadores', 'link_panel']) {
    if (!vino(k)) continue;
    const v = String(d[k] == null ? '' : d[k]).trim();
    if (!v) { links[k] = null; continue; }
    const con = /^https?:\/\//i.test(v) ? v : 'https://' + v;
    if (!/^https?:\/\/[a-z0-9.-]+(:\d+)?(\/[^\s]*)?$/i.test(con)) {
      return { ok: false, error: `"${v}" no parece un link. Pegá la dirección completa, como te la dieron.` };
    }
    links[k] = con;
  }
  if (vino('usuario_admin')) links.usuario_admin = String(d.usuario_admin || '').trim().slice(0, 80) || null;
  if (/contrase|password|clave/i.test(JSON.stringify(d.usuario_admin || ''))) {
    return { ok: false, error: 'Acá no va la contraseña: el portal del cliente se abre sin clave y quedaría a la vista.' };
  }

  const desdeNueva = vino('desde') ? String(d.desde || '').slice(0, 10) : null;
  /* EL DÍA DE COBRO SALE DE LA FECHA DE INICIO. Si contrató el 20, se le cobra el 20 de cada mes y
     el período va del 20 al 19 — no del 1 al 30. Poner la fecha y además el día era pedir dos veces
     el mismo dato, y el día que no coincidieran nadie sabría cuál manda.
     Se recorta a 28 para que el día exista en todos los meses, febrero incluido: quien contrató un
     31 se le cobra el 28. */
  let dia = vino('dia_cobro')
    ? (d.dia_cobro == null || d.dia_cobro === '' ? null : Number(d.dia_cobro))
    : ((prev && prev.dia_cobro) || null);
  if (desdeNueva && !vino('dia_cobro')) {
    const n = Number(desdeNueva.slice(8, 10));
    if (n >= 1 && n <= 31) dia = Math.min(n, 28);
  }
  if (dia != null && (!Number.isInteger(dia) || dia < 1 || dia > 28)) {
    return { ok: false, error: 'el día de cobro tiene que estar entre 1 y 28 (para que exista en todos los meses)' };
  }
  const q = (k) => (Object.prototype.hasOwnProperty.call(links, k) ? links[k] : ((prev && prev[k]) || null));
  db.prepare(`INSERT INTO chat_panel
      (panel_id,pct_cliente,dia_cobro,activo,desde,notas,createdAt,link_jugadores,link_panel,usuario_admin)
      VALUES (?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(panel_id) DO UPDATE SET pct_cliente=excluded.pct_cliente, dia_cobro=excluded.dia_cobro,
      activo=excluded.activo, desde=excluded.desde, notas=excluded.notas,
      link_jugadores=excluded.link_jugadores, link_panel=excluded.link_panel,
      usuario_admin=excluded.usuario_admin`)
    .run(id, pct || null, dia,
      vino('activo') ? (d.activo === false ? 0 : 1) : (prev ? prev.activo : 1),
      String(d.desde || (prev && prev.desde) || '').slice(0, 10) || null,
      vino('notas') ? String(d.notas || '') : String((prev && prev.notas) || ''),
      (prev && prev.createdAt) || nowISO(),
      q('link_jugadores'), q('link_panel'), q('usuario_admin'));
  return { ok: true, panel: list().find((x) => x.panel_id === id) };
}
function quitar(panelId) {
  return { ok: true, borrados: db.prepare('DELETE FROM chat_panel WHERE panel_id=?').run(String(panelId)).changes };
}

/**
 * LA GANANCIA DE UN MES, POR PANEL Y POR MONEDA.
 *
 * Sale de `reporte_diario`, que el cron llena todas las noches: no se le vuelve a preguntar al
 * casino. El cruce es conexión + nodo, que es como el acumulado identifica cada panel.
 */
function gananciaDelMes(mes) {
  const filas = db.prepare(`SELECT conexion_id, grp, sa_id, moneda, SUM(CAST(profit AS REAL)) profit
    FROM reporte_diario WHERE substr(fecha,1,7)=? GROUP BY conexion_id, grp, sa_id, moneda`)
    .all(String(mes || '').slice(0, 7));
  const m = new Map();
  // La clave lleva el NIVEL: el mismo id de nodo existe como superagente y como agente, con
  // números distintos, y mezclarlos sumaría la caja dos veces.
  for (const f of filas) m.set(`${f.conexion_id}|${f.grp}|${f.sa_id}|${f.moneda || 'ARS'}`, f.profit);
  return m;
}


/**
 * EL CIERRE DEL MES DEL SERVICIO.
 *
 * Por cada panel con el servicio: lo que se le cobra al cliente y lo que se le paga al proveedor,
 * sobre la MISMA ganancia. La diferencia es el margen.
 *
 * Una ganancia negativa —el panel perdió— no genera cobro: cobrarle un % de una pérdida sería
 * cobrarle por perder, y pagarle al proveedor un % de una pérdida no tiene sentido tampoco.
 */
function cierre(mes) {
  const m = String(mes || '').slice(0, 7);
  const g = gananciaDelMes(m);
  const c = config();
  const filas = [];
  let cobraT = '0', pagaT = '0', margenT = '0';
  const sinTC = new Set();

  /* Los que NO se pueden calcular se juntan en una lista en vez de desaparecer. Un panel
     desconectado del casino, o sin nodo, no tiene ganancia que leer — pero el cliente igual tiene
     el servicio contratado. Descartarlo en silencio dejaba una factura de menos que nadie iba a
     buscar, porque en pantalla no faltaba nada. */
  const salteados = [];
  for (const p of list()) {
    if (!p.activo) { salteados.push({ panel: p.panel, cliente: p.cliente, motivo: 'está pausado' }); continue; }
    if (!p.conexion_id || !p.id_usuario) {
      salteados.push({ panel: p.panel, cliente: p.cliente, motivo: 'el panel no está enlazado al casino' });
      continue;
    }
    // Un panel puede reportar en varias monedas; cada una se convierte con su propio tipo de cambio.
    const monedas = [];
    for (const [k, v] of g) {
      const [cx, grp, nodo, mon] = k.split('|');
      if (cx === p.conexion_id && grp === p.grp && String(nodo) === String(p.id_usuario)) {
        monedas.push({ moneda: mon, profit: v });
      }
    }
    /* Una caja sin NINGUNA fila en su nivel no es una caja sin ganancias: es una caja que el
       acumulado no está bajando. Cobrar cero por eso sería regalar el mes en silencio. */
    if (!monedas.length) {
      salteados.push({ panel: p.panel, cliente: p.cliente,
        motivo: `todavía no hay datos de ${p.nivel || 'esa caja'} en ${m}` });
      continue;
    }
    let profitUsdt = '0'; const detalle = [];
    for (const x of monedas) {
      if (x.profit <= 0) { detalle.push({ ...x, usdt: '0', motivo: 'sin ganancia' }); continue; }
      const t = tcUnico.tcDelMes(x.moneda, m);
      if (!t || !t.valor || !money.isPos(String(t.valor))) {
        sinTC.add(x.moneda);
        detalle.push({ ...x, usdt: null, motivo: 'falta el tipo de cambio' });
        continue;
      }
      const u = money.round(money.div(String(x.profit), String(t.valor)), 2);
      profitUsdt = money.add(profitUsdt, u);
      /* Se guarda el TC USADO y DE DÓNDE SALIÓ. No es lo mismo cobrar el 2% de una ganancia en
         pesos que en dólares: sin el tipo de cambio a la vista, la cuenta del cliente es un número
         sin manera de comprobarlo, ni para él ni para vos. */
      detalle.push({ ...x, tc: String(t.valor), fuente: t.fuente || '', conflicto: t.conflicto || null, usdt: u });
    }
    /* SIN PRECIO SE COBRA EL MÍNIMO, que es lo que a vos te cuesta: cobrar cero sería regalarle el
       servicio y pagarlo de tu bolsillo, y eso no puede pasar por un olvido. Queda marcado como
       precio provisorio —en la pantalla y en la lista de la emisión— para poder confirmarlo
       después. La marca no viaja a la hoja del cliente: él ve un precio, no una duda. */
    const pctCli = p.pct_cliente || c.costo_pct;
    const cobra = money.round(money.pct(profitUsdt, pctCli), 2);
    const paga = money.round(money.pct(profitUsdt, c.costo_pct), 2);
    const margen = money.sub(cobra, paga);
    filas.push({
      panel_id: p.panel_id, panel: p.panel, cliente: p.cliente, cliente_id: p.cliente_id,
      sistema: p.sistema, pct_cliente: pctCli, pct_costo: c.costo_pct,
      profit_usdt: profitUsdt, cobra, paga, margen,
      /* Cobrarle menos de lo que cuesta se puede querer (una promoción) pero no por accidente.
         Un panel SIN precio también da margen negativo, pero ése ya tiene su propio aviso: contarlo
         acá lo haría aparecer en las dos listas y las dos dirían lo mismo. Este aviso es para el
         caso que sólo se ve mirando: le pusiste un precio, y el precio no alcanza. */
      pierde: money.isNeg(margen) && !!p.pct_cliente,
      sinPrecio: !p.pct_cliente,          // no se le cargó precio: se está cobrando el mínimo
      pctMinimo: !p.pct_cliente,
      detalle,
    });
    cobraT = money.add(cobraT, cobra); pagaT = money.add(pagaT, paga); margenT = money.add(margenT, margen);
  }
  filas.sort((a, b) => money.cmp(b.cobra, a.cobra));
  return {
    mes: m, costo_pct: c.costo_pct, mensualidad: c.mensualidad, mensualidad_moneda: c.mensualidad_moneda,
    filas, totales: { cobra: cobraT, paga: pagaT, margen: margenT },
    sinTC: [...sinTC],
    sinPrecio: filas.filter((f) => f.sinPrecio).map((f) => f.panel),
    pierden: filas.filter((f) => f.pierde).map((f) => f.panel),
    salteados,
  };
}

/**
 * LAS MENSUALIDADES QUE TOCAN EN UNA FECHA.
 *
 * La mensualidad NO va con el cierre: cada panel tiene su propio día de cobro, porque no se cobran
 * todos a principio de mes sino cuando corresponde a cada uno. Se cobra haya o no ganancias — es
 * por tener el servicio, no por usarlo. Un cliente con tres paneles paga tres.
 */
function mensualidadesDe(fecha) {
  const f = String(fecha || '').slice(0, 10);
  const dia = Number(f.slice(8, 10));
  const c = config();
  if (!dia) return { fecha: f, monto: c.mensualidad, moneda: c.mensualidad_moneda, paneles: [] };
  /* Se marca la que YA se cobró ese día: si no, al volver a entrar la pantalla dice lo mismo y no
     hay forma de saber si se cobró o si falta. */
  const yaHoy = new Set(db.prepare("SELECT cliente_id||'|'||IFNULL(panel,'') k FROM chat_mov WHERE tipo='mensualidad' AND fecha=?")
    .all(f).map((x) => x.k));
  const cobradaHoy = (p) => yaHoy.has(`${p.cliente_id}|${p.panel}`);
  return {
    fecha: f, monto: c.mensualidad, moneda: c.mensualidad_moneda,
    /* Una caja no paga mantenimiento antes de tenerlo: si arrancó el 20 de agosto, el 20 de julio
       no le tocaba nada, y aparecer ahí era invitar a cobrarle un mes que no usó. */
    paneles: list().filter((p) => p.activo && Number(p.dia_cobro) === dia
      && (!p.desde || String(p.desde).slice(0, 10) <= f))
      .map((p) => ({
        ...p,
        cobrada: cobradaHoy(p),
        periodo: periodoDesde(f),
        aviso: avisosMensDe(f)[`${p.cliente_id}|${p.panel}`] || null,
      })),
  };
}

/* La wallet vieja, cuando era UNA sola en la configuración. Si ya había una cargada y todavía no
   hay ninguna en la tabla, se pasa sola y queda elegida para las dos cosas: si no, el día del
   despliegue la dirección desaparecía de la pantalla y habría que acordarse de volver a escribirla.
   Corre una vez y no vuelve a tocar nada. */
(function migrarWalletVieja() {
  try {
    const dir = String(cfg.getCfg('chatWallet') || '').trim();
    if (!dir) return;
    if (db.prepare('SELECT COUNT(*) n FROM chat_wallet').get().n > 0) return;
    const red = String(cfg.getCfg('chatRed') || '').trim().toUpperCase() || 'TRC20';
    const id = 'chw_migrada';
    db.prepare(`INSERT INTO chat_wallet (id,alias,red,direccion,activa,ord,createdAt)
      VALUES (?,?,?,?,1,0,?)`).run(id, red, red, dir, nowISO());
    cfg.setCfg(W_GGR, id);
    cfg.setCfg(W_MENS, id);
    console.log('[Chat] la wallet que estaba cargada pasó a la lista de wallets');
  } catch (e) { console.warn('[Chat] no se pudo pasar la wallet vieja:', e.message); }
}());

/* ── LAS WALLETS ─────────────────────────────────────────────────────────────────────────────
   Varias, no una: una TRC20 y una BEP20 para el mantenimiento, otra para lo del mes. Cada cliente
   puede tener la suya y, si no la tiene, se usa la de siempre. */
function wallets() {
  return db.prepare('SELECT * FROM chat_wallet ORDER BY ord, createdAt')
    .all().map((w) => ({ ...w, activa: w.activa !== 0 }));
}

function guardarWallet(d) {
  const dir = String(d.direccion == null ? '' : d.direccion).trim().slice(0, 200);
  if (!dir) return { ok: false, error: 'falta la dirección' };
  /* Una dirección no lleva espacios ni comas: si los tiene, casi seguro le pegaron la red adentro,
     y mandar por la red equivocada es perder la plata. */
  if (/[\s,]/.test(dir)) {
    return { ok: false, error: 'La dirección no puede llevar espacios. La red va en su propio campo.' };
  }
  const red = String(d.red || '').trim().toUpperCase().slice(0, 24);
  if (!red) return { ok: false, error: 'falta la red (TRC20, BEP20…)' };
  const id = String(d.id || '').trim() || 'chw_' + require('crypto').randomBytes(5).toString('hex');
  const prev = db.prepare('SELECT * FROM chat_wallet WHERE id=?').get(id);
  const ord = prev ? prev.ord : (db.prepare('SELECT COALESCE(MAX(ord),-1)+1 n FROM chat_wallet').get().n);
  db.prepare(`INSERT INTO chat_wallet (id,alias,red,direccion,activa,ord,createdAt)
      VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET alias=excluded.alias, red=excluded.red,
      direccion=excluded.direccion, activa=excluded.activa`)
    .run(id, String(d.alias || '').trim().slice(0, 60) || red, red, dir,
      d.activa === false ? 0 : 1, ord, (prev && prev.createdAt) || nowISO());
  /* La PRIMERA queda elegida para las dos cosas. Sin esto, con una sola wallet todo funcionaba por
     el atajo de "si hay una sola, es ésa" — y el día que agregabas la segunda, de golpe no había
     ninguna elegida y a todos los clientes les desaparecía la dirección sin ningún aviso. */
  if (!cfg.getCfg(W_GGR) && !cfg.getCfg(W_MENS) && wallets().filter((w) => w.activa).length === 1) {
    cfg.setCfg(W_GGR, id); cfg.setCfg(W_MENS, id);
  }
  return { ok: true, wallet: wallets().find((w) => w.id === id) };
}

function borrarWallet(id) {
  const w = String(id || '');
  /* No se borra la que está en uso: el cliente que la tenía elegida se quedaría sin adónde pagar y
     nadie se enteraría hasta que preguntara. Se apaga, que deja de ofrecerse y no rompe nada. */
  const usada = [cfg.getCfg(W_GGR), cfg.getCfg(W_MENS)].includes(w)
    || db.prepare('SELECT COUNT(*) n FROM chat_cliente WHERE wallet_ggr=? OR wallet_mens=?').get(w, w).n > 0;
  if (usada) return { ok: false, error: 'esa wallet está elegida en algún lado. Apagala en vez de borrarla, o cambiá primero quién la usa.' };
  return { ok: true, borrados: db.prepare('DELETE FROM chat_wallet WHERE id=?').run(w).changes };
}

/**
 * QUÉ WALLET LE TOCA A ESTE CLIENTE PARA ESTA COSA.
 * La suya si tiene una elegida; si no, la de siempre; si no elegiste ninguna y hay UNA sola activa,
 * esa — el caso de una sola wallet es el común y pedir que además la elija sería pedir dos veces lo
 * mismo.
 *
 * ⚠️ Si la elegida está APAGADA no se reemplaza por otra: devuelve nada. Poner la que quedó
 * prendida sería cambiarle al cliente la dirección donde paga sin que nadie lo haya decidido, y
 * ésa es la clase de cambio silencioso que termina en plata mandada a otro lado. Sin wallet, la
 * hoja no muestra "cómo pagar" y la pantalla avisa.
 */
function walletDe(clienteId, uso) {
  const todas = wallets();
  const act = todas.filter((w) => w.activa);
  const viva = (id) => (id ? (act.find((w) => w.id === id) || null) : undefined);
  const d = clienteId ? destino(clienteId) : null;
  const propia = d && (uso === 'mens' ? d.wallet_mens : d.wallet_ggr);
  const elegidaCli = viva(propia);
  if (elegidaCli !== undefined) return elegidaCli;           // eligió una: vale, prendida o nada
  const elegidaDef = viva(cfg.getCfg(uso === 'mens' ? W_MENS : W_GGR));
  if (elegidaDef !== undefined) return elegidaDef;
  return act.length === 1 ? act[0] : null;
}

/** Las elegidas que quedaron apagadas. La pantalla lo avisa: si no, no hay adónde pagar y no se ve. */
function walletsApagadasEnUso() {
  const todas = wallets();
  const off = new Set(todas.filter((w) => !w.activa).map((w) => w.id));
  const nombre = (id) => (todas.find((w) => w.id === id) || {}).alias || id;
  const out = [];
  for (const [k, quien] of [[cfg.getCfg(W_GGR), 'el servicio del mes'], [cfg.getCfg(W_MENS), 'el mantenimiento']]) {
    if (k && off.has(k)) out.push({ wallet: nombre(k), donde: quien });
  }
  for (const f of db.prepare('SELECT * FROM chat_cliente').all()) {
    for (const [k, quien] of [[f.wallet_ggr, 'el mes'], [f.wallet_mens, 'el mantenimiento']]) {
      if (k && off.has(k)) out.push({ wallet: nombre(k), donde: `${quien} de un cliente` });
    }
  }
  return out;
}

/** Lo que va en la hoja y en el portal: la del mes, la del mantenimiento y la aclaración. */
function comoPagar(clienteId) {
  const ggr = walletDe(clienteId, 'ggr');
  const mens = walletDe(clienteId, 'mens');
  const misma = ggr && mens && ggr.id === mens.id;
  return {
    nota: config().pago_nota,
    misma: !!misma,
    ggr: ggr ? { alias: ggr.alias, red: ggr.red, direccion: ggr.direccion } : null,
    mens: mens ? { alias: mens.alias, red: mens.red, direccion: mens.direccion } : null,
  };
}

/* ── EL DESTINO DE CADA CLIENTE ──────────────────────────────────────────────────────────────
   Dónde se le manda la cuenta de ESTE servicio. Ver el comentario de la tabla: es a propósito que
   no sea el mismo grupo que el de las fichas. */
/* Puede haber MÁS DE UN GRUPO: a veces el encargado tiene que enterarse y no está en el mismo
   grupo que el cliente. Se guardan en el mismo campo separados por coma o por renglón, y se manda a
   todos. Una tabla aparte para esto habría sido una tabla de una sola columna. */
const partirGrupos = (s) => String(s || '').split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean);

function destino(clienteId) {
  const f = db.prepare('SELECT * FROM chat_cliente WHERE cliente_id=?').get(String(clienteId || ''))
    || { cliente_id: String(clienteId || ''), tg_grupo: '', enviar_a: '', notas: '', createdAt: null };
  return { ...f, grupos: partirGrupos(f.tg_grupo) };
}

function setDestino(d) {
  const id = String(d.cliente_id || '').trim();
  if (!id) return { ok: false, error: 'falta el cliente' };
  const prev = db.prepare('SELECT * FROM chat_cliente WHERE cliente_id=?').get(id);
  // Igual que en set(): lo que no viene no se pisa, lo que viene vacío sí borra.
  const vino = (k) => Object.prototype.hasOwnProperty.call(d, k);
  const val = (k) => (vino(k) ? String(d[k] == null ? '' : d[k]).trim() : String((prev && prev[k]) || ''));
  const grupo = partirGrupos(val('tg_grupo')).join(', ');
  // La wallet propia de este cliente, si le pusiste una distinta de la de siempre.
  const wsel = {};
  for (const k of ['wallet_ggr', 'wallet_mens']) {
    if (!vino(k)) continue;
    const v = String(d[k] || '').trim();
    if (v && !db.prepare('SELECT id FROM chat_wallet WHERE id=?').get(v)) {
      return { ok: false, error: 'esa wallet no existe' };
    }
    wsel[k] = v || null;
  }
  /* Un chatId de Telegram es un número (los grupos son negativos) o un @nombre. Se avisa en vez de
     prohibir: puede pegarse un link y quererse arreglar después, pero mandar a un destino que no
     existe falla en silencio del lado de Telegram y la cuenta no llega. */
  const malos = partirGrupos(grupo).filter((g) => !/^-?\d+$/.test(g) && !/^@[\w]{3,}$/.test(g));
  const qw = (k) => (Object.prototype.hasOwnProperty.call(wsel, k) ? wsel[k] : ((prev && prev[k]) || null));
  db.prepare(`INSERT INTO chat_cliente (cliente_id,tg_grupo,enviar_a,notas,createdAt,wallet_ggr,wallet_mens)
      VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(cliente_id) DO UPDATE SET tg_grupo=excluded.tg_grupo,
      enviar_a=excluded.enviar_a, notas=excluded.notas,
      wallet_ggr=excluded.wallet_ggr, wallet_mens=excluded.wallet_mens`)
    .run(id, grupo || null, val('enviar_a') || null, val('notas') || null,
      (prev && prev.createdAt) || nowISO(), qw('wallet_ggr'), qw('wallet_mens'));
  return {
    ok: true,
    destino: destino(id),
    aviso: malos.length
      ? `${malos.join(', ')} no parece${malos.length > 1 ? 'n' : ''} un grupo de Telegram: suelen ser un número (los grupos empiezan con −) o un @nombre.`
      : null,
  };
}

/** Todos los destinos cargados, por cliente. Sirve para poder cargarle el grupo a un cliente que
    todavía no facturó nada: si la lista saliera del cierre, un cliente nuevo no aparecería hasta
    tener ganancias y no habría dónde escribirle el grupo. */
function destinos() {
  const out = {};
  for (const f of db.prepare('SELECT * FROM chat_cliente').all()) {
    out[f.cliente_id] = { ...f, grupos: partirGrupos(f.tg_grupo) };
  }
  return out;
}

/* ── EL MES, AGRUPADO POR CLIENTE ────────────────────────────────────────────────────────────
   `cierre` devuelve una fila por PANEL, que es como se calcula. Pero la cuenta se la mandás al
   CLIENTE, y uno con tres paneles paga una sola cuenta con tres renglones, no tres cuentas. Acá se
   junta: los totales del cliente, sus paneles, y las monedas en que ganó con el TC de cada una.

   La ganancia por moneda se suma entre los paneles del mismo cliente: si dos paneles ganaron en
   pesos, en la cuenta va un solo renglón de pesos. Es lo que el cliente puede comprobar contra su
   propio panel. */
function porCliente(mes) {
  const ci = cierre(mes);
  const grupos = new Map();
  for (const f of ci.filas) {
    const k = f.cliente_id || ('sin-cliente:' + f.panel_id);
    if (!grupos.has(k)) {
      const d = f.cliente_id ? destino(f.cliente_id) : {};
      grupos.set(k, {
        cliente_id: f.cliente_id, cliente: f.cliente,
        tg_grupo: d.tg_grupo || '', grupos: d.grupos || [], enviar_a: d.enviar_a || '',
        paneles: [], monedas: [],
        cobra: '0', paga: '0', margen: '0',
        sinPrecio: false, sinTC: false,
      });
    }
    const g = grupos.get(k);
    g.paneles.push(f);
    g.cobra = money.add(g.cobra, f.cobra);
    g.paga = money.add(g.paga, f.paga);
    g.margen = money.add(g.margen, f.margen);
    if (f.sinPrecio) g.sinPrecio = true;
    for (const x of f.detalle || []) {
      if (!(Number(x.profit) > 0)) continue;
      if (x.usdt == null) g.sinTC = true;
      const y = g.monedas.find((z) => z.moneda === x.moneda);
      if (y) {
        y.profit = money.add(String(y.profit), String(x.profit));
        y.usdt = y.usdt == null || x.usdt == null ? null : money.add(y.usdt, x.usdt);
      } else {
        g.monedas.push({ moneda: x.moneda, profit: String(x.profit), tc: x.tc || null, fuente: x.fuente || '', usdt: x.usdt });
      }
    }
  }
  const cs = [...grupos.values()].sort((a, b) => money.cmp(b.cobra, a.cobra));
  return {
    mes: ci.mes, costo_pct: ci.costo_pct,
    mensualidad: ci.mensualidad, mensualidad_moneda: ci.mensualidad_moneda,
    clientes: cs, totales: ci.totales, sinTC: ci.sinTC, salteados: ci.salteados,
  };
}

/* ── LA CUENTA DEL CHAT ──────────────────────────────────────────────────────────────────────
   Aparte de la cuenta de las fichas, a propósito: ver el comentario de la tabla `chat_mov`.
   Cobrar un mes CONGELA el número. Después de eso el cliente puede pagar y el saldo se mueve, pero
   lo cobrado no cambia aunque cambie un tipo de cambio — es lo que le mandaste. */
function cobrar(mes, opciones = {}) {
  const m = String(mes || '').slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(m)) return { ok: false, error: 'mes inválido (se espera YYYY-MM)' };
  const pc = porCliente(m);
  /* ⚠️ NO SE CONGELA UN MES AL QUE LE FALTA UN TIPO DE CAMBIO. Lo ganado en esa moneda vale cero
     hasta que el TC esté, así que el total se congelaría CORTO — y como no se puede cobrar dos
     veces encima, cargar el TC al día siguiente ya no lo arregla: hay que deshacer y volver a
     cobrar, y nadie sale a buscar un número que en pantalla no falta. Se puede forzar, pero
     diciéndolo. */
  if ((pc.sinTC || []).length && !opciones.confirmar) {
    return {
      ok: false,
      error: `Falta el tipo de cambio de ${pc.sinTC.join(', ')} en ${m}. Lo ganado en esa moneda quedaría en cero y el cobro se congela así. Cargá el TC, o confirmá si querés cobrar igual.`,
      requiereConfirmar: true,
      sinTC: pc.sinTC,
    };
  }
  const creados = []; const yaEstaban = []; const enCero = []; const sinCliente = [];
  const ins = db.prepare(`INSERT INTO chat_mov (id,cliente_id,mes,tipo,monto,moneda,fecha,nota,createdAt)
    VALUES (?,?,?,'cobro',?,'USDT',?,?,?)`);
  const tx = db.transaction(() => {
    for (const g of pc.clientes || []) {
      /* Una caja sin cliente asignado no se le puede cobrar a nadie — pero al proveedor SÍ se le
         paga por ella. Saltearla en silencio era regalar ese mes. Se nombra. */
      if (!g.cliente_id) { sinCliente.push(g.cliente || '(sin cliente)'); continue; }
      if (!money.isPos(g.cobra)) { enCero.push(g.cliente); continue; }
      const ya = db.prepare("SELECT id FROM chat_mov WHERE cliente_id=? AND mes=? AND tipo='cobro'").get(g.cliente_id, m);
      if (ya) { yaEstaban.push(g.cliente); continue; }
      const id = 'chm_' + require('crypto').randomBytes(6).toString('hex');
      // La fecha cae DENTRO del mes cobrado, no el día que apretaste el botón.
      ins.run(id, g.cliente_id, m, g.cobra, `${m}-28`,
        g.sinPrecio ? 'precio sin confirmar (se cobró el mínimo)' : '', nowISO());
      creados.push({ cliente: g.cliente, cliente_id: g.cliente_id, monto: g.cobra });
    }
  });
  try { tx(); } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  return {
    ok: true, mes: m,
    creados: creados.length, yaEstaban: yaEstaban.length, enCero: enCero.length,
    total: money.round(money.sum(creados.map((c) => c.monto)), 2),
    detalle: creados,
    sinPrecio: (pc.clientes || []).filter((g) => g.sinPrecio).map((g) => g.cliente),
    sinCliente,
    sinTC: pc.sinTC || [],
  };
}

/**
 * DESHACE EL COBRO DE UN CLIENTE (o de todo el mes si no se dice cuál).
 *
 * Para qué sirve: cobrar CONGELA el número, y a veces el número estaba mal cuando se apretó —
 * faltaba cargar un precio, faltaba el tipo de cambio del mes, o faltaban días del acumulado. El
 * índice único no deja volver a cobrar encima, así que sin esto el mes quedaba mal para siempre.
 * Se deshace, se arregla lo que faltaba, y se cobra de nuevo.
 *
 * NO borra los pagos: ésos pasaron de verdad y no los deshace nadie.
 */
function descobrar(mes, clienteId = null) {
  const m = String(mes || '').slice(0, 7);
  const cid = clienteId ? String(clienteId) : null;
  const r = cid
    ? db.prepare("DELETE FROM chat_mov WHERE mes=? AND tipo='cobro' AND cliente_id=?").run(m, cid)
    : db.prepare("DELETE FROM chat_mov WHERE mes=? AND tipo='cobro'").run(m);
  return { ok: true, mes: m, cliente_id: cid, borrados: r.changes };
}

/**
 * COBRA UNA MENSUALIDAD. Va a la misma cuenta del chat pero como tipo aparte: su fecha no es la del
 * cierre —cada panel tiene su día— y un cliente con tres paneles paga tres, así que no puede
 * compartir la llave única del cobro del mes.
 */
function cobrarMensualidad(d) {
  const id = String(d.cliente_id || '').trim();
  if (!id) return { ok: false, error: 'falta el cliente' };
  /* No se cobra antes de que empiece. Si contrató el 20 de agosto, el 5 de agosto no le toca nada:
     sin este control, cobrar "la mensualidad de hoy" de una caja recién dada de alta le cobraba un
     mes que todavía no usó. */
  if (d.panel) {
    const fila = list().find((p) => p.cliente_id === id && p.panel === String(d.panel));
    const desde = fila && fila.desde;
    const f0 = String(d.fecha || '').slice(0, 10) || hoy();
    if (desde && f0 < desde) {
      return { ok: false, error: `esa caja empieza el ${desde}: todavía no le toca la mensualidad` };
    }
  }
  const c = config();
  const monto = String(d.monto || c.mensualidad || '').trim();
  if (!money.esNumero(monto) || !money.isPos(monto)) {
    return { ok: false, error: 'la mensualidad no está cargada o no es un número. Cargala arriba.' };
  }
  const fecha = String(d.fecha || '').slice(0, 10) || hoy();
  /* La misma caja, el mismo día, dos veces no. Antes no había ningún control: dos clics —o un clic
     y una repintada que no marcó "cobrada"— dejaban dos filas de 30 USDT y el cliente veía 60. */
  if (d.panel) {
    const ya = db.prepare(`SELECT id FROM chat_mov
      WHERE tipo='mensualidad' AND cliente_id=? AND panel=? AND fecha=?`).get(id, String(d.panel), fecha);
    if (ya) return { ok: false, error: 'esa mensualidad ya se cobró hoy' };
  }
  const per = periodoDesde(fecha);
  const nota = String(d.nota || '').trim()
    || `Mantenimiento${d.panel ? ' ' + d.panel : ''}${per ? ' · ' + per.texto : ''}`;
  const mid = 'chm_' + require('crypto').randomBytes(6).toString('hex');
  db.prepare(`INSERT INTO chat_mov (id,cliente_id,mes,tipo,monto,moneda,fecha,nota,createdAt,panel)
    VALUES (?,?,?,'mensualidad',?,?,?,?,?,?)`).run(mid, id, fecha.slice(0, 7),
    money.round(monto, 2), c.mensualidad_moneda || 'USDT', fecha, nota, nowISO(),
    String(d.panel || '') || null);
  return { ok: true, mov: db.prepare('SELECT * FROM chat_mov WHERE id=?').get(mid) };
}

/** Registra lo que te pagó un cliente por el chat. Otra wallet, otra cuenta. */
function pagarCliente(d) {
  const id = String(d.cliente_id || '').trim();
  if (!id) return { ok: false, error: 'falta el cliente' };
  const m = String(d.mes || '').slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(m)) return { ok: false, error: 'mes inválido (se espera YYYY-MM)' };
  const monto = String(d.monto == null ? '' : d.monto).trim();
  if (!money.esNumero(monto) || !money.isPos(monto)) {
    return { ok: false, error: 'el monto tiene que ser un número mayor que cero. Usá punto para los decimales: 246.93' };
  }
  const mid = 'chm_' + require('crypto').randomBytes(6).toString('hex');
  db.prepare(`INSERT INTO chat_mov (id,cliente_id,mes,tipo,monto,moneda,fecha,nota,createdAt)
    VALUES (?,?,?,'pago',?,?,?,?,?)`).run(mid, id, m, money.round(monto, 2),
    String(d.moneda || 'USDT').toUpperCase().slice(0, 8),
    String(d.fecha || '').slice(0, 10) || hoy(), String(d.nota || ''), nowISO());
  return { ok: true, mov: db.prepare('SELECT * FROM chat_mov WHERE id=?').get(mid) };
}

function borrarMov(id) {
  const r = db.prepare('DELETE FROM chat_mov WHERE id=?').run(String(id || ''));
  return { ok: true, borrados: r.changes };
}

/**
 * LA CUENTA DE CADA CLIENTE EN EL CHAT.
 * Con `mes` muestra ese mes; sin `mes`, todo lo que arrastra. El saldo de arrastre importa: alguien
 * puede deber tres meses y eso no se ve mirando uno solo.
 */
function cuentas(mes) {
  const m = String(mes || '').slice(0, 7);
  const filas = m
    ? db.prepare('SELECT * FROM chat_mov WHERE mes=? ORDER BY fecha, createdAt').all(m)
    : db.prepare('SELECT * FROM chat_mov ORDER BY mes, fecha, createdAt').all();
  const cli = new Map(clientes.list().clientes.map((c) => [c.id, c]));
  const por = new Map();
  for (const f of filas) {
    if (!por.has(f.cliente_id)) {
      const c = cli.get(f.cliente_id) || {};
      por.set(f.cliente_id, {
        cliente_id: f.cliente_id, cliente: c.nombre || c.codigo || '(cliente borrado)',
        cobrado: '0', pagado: '0', debe: '0', movs: [],
      });
    }
    const g = por.get(f.cliente_id);
    g.movs.push(f);
    // La mensualidad suma del mismo lado que el cobro: las dos son plata que te deben.
    if (f.tipo === 'pago') g.pagado = money.add(g.pagado, f.monto || '0');
    else g.cobrado = money.add(g.cobrado, f.monto || '0');
  }
  const out = [...por.values()];
  out.forEach((g) => { g.debe = money.round(money.sub(g.cobrado, g.pagado), 2); });
  out.sort((a, b) => money.cmp(b.debe, a.debe));
  return {
    mes: m || null, clientes: out,
    totales: {
      cobrado: money.round(money.sum(out.map((g) => g.cobrado)), 2),
      pagado: money.round(money.sum(out.map((g) => g.pagado)), 2),
      debe: money.round(money.sum(out.map((g) => g.debe)), 2),
    },
  };
}

/* ── QUIÉN ES EL QUE ENTRA AL PORTAL ─────────────────────────────────────────────────────────
   Escribe el usuario que ya conoce —el de su caja, "Fran44"— y no una cuenta nueva: una contraseña
   más para recordar es la forma más segura de que no entre nunca.

   Se busca entre los paneles QUE TIENEN EL CHAT, por nombre o por alias, y también por el código
   del cliente. Un usuario que no tiene el servicio no encuentra nada: el portal es del chat.

   ⚠️ Entrar con el usuario solo, sin contraseña, es la misma puerta que ya usa la pantalla de
   pedidos con el código del cliente. Quien adivine un nombre de caja ve lo que ese cliente debe por
   el chat — no puede tocar nada, ni ver otra cosa del sistema, ni ver a otro cliente. Es una
   decisión tomada a sabiendas, no un olvido. */
function quienEntra(usuario) {
  const k = String(usuario || '').trim().toLowerCase();
  if (!k) return null;
  const conChat = list().filter((p) => p.activo);
  /* ⚠️ SI EL NOMBRE ESTÁ REPETIDO EN DOS CLIENTES, NO ENTRA NINGUNO. Antes se tomaba el primero de
     la lista, así que uno podía terminar viendo la cuenta y los accesos del otro. Ante la duda, la
     puerta se queda cerrada: es un caso raro y se resuelve renombrando una caja. */
  const mismos = conChat.filter((p) => String(p.panel || '').trim().toLowerCase() === k);
  const clientesDistintos = new Set(mismos.map((p) => p.cliente_id));
  if (clientesDistintos.size > 1) return null;
  const pan = mismos[0];
  if (pan && pan.cliente_id) return { cliente_id: pan.cliente_id, cliente: pan.cliente, por: 'caja' };
  // Por alias del panel: el mismo panel se escribe de dos formas y las dos tienen que entrar.
  const conAlias = conChat.find((p) => {
    const full = paneles.get(p.panel_id);
    return full && (full.alias || []).some((a) => String(a).trim().toLowerCase() === k);
  });
  if (conAlias && conAlias.cliente_id) return { cliente_id: conAlias.cliente_id, cliente: conAlias.cliente, por: 'caja' };
  const c = clientes.list().clientes.find((x) => String(x.codigo || '').trim().toLowerCase() === k
    || String(x.nombre || '').trim().toLowerCase() === k);
  if (c && conChat.some((p) => p.cliente_id === c.id)) {
    return { cliente_id: c.id, cliente: c.nombre || c.codigo, por: 'cliente' };
  }
  return null;
}

/** Lo que ve un cliente en su portal: su saldo, sus cajas con el chat y sus avisos. */
function portalDe(clienteId) {
  const id = String(clienteId || '');
  const todo = cuentas(null).clientes.find((x) => x.cliente_id === id) || null;
  /* Los links de cada caja van al portal: es lo que el cliente busca cuando entra —dónde juegan
     los suyos y por dónde administra— y hoy los tiene sueltos en un chat de hace tres meses.
     La contraseña NO viaja: acá se entra sin clave. */
  const cajas = list().filter((p) => p.cliente_id === id && p.activo)
    .map((p) => ({
      caja: p.panel, desde: p.desde || null, dia_cobro: p.dia_cobro || null,
      link_jugadores: p.link_jugadores || '', link_panel: p.link_panel || '',
      usuario_admin: p.usuario_admin || '',
    }));
  const c = clientes.list().clientes.find((x) => x.id === id) || {};
  return {
    cliente: c.nombre || c.codigo || '',
    saldo: todo ? { cobrado: todo.cobrado, pagado: todo.pagado, debe: todo.debe } : { cobrado: '0', pagado: '0', debe: '0' },
    // Los movimientos del chat, para que pueda comprobar el saldo en vez de creerlo.
    /* La nota de un cobro es INTERNA ("precio sin confirmar (se cobró el mínimo)"): decirle al
       cliente que su precio está sin decidir es abrirle una negociación que nadie pidió. La de la
       mensualidad sí es para él —lleva la caja y el período— y va tal cual. */
    movs: (todo ? todo.movs : []).slice(-30).map((m) => ({
      fecha: m.fecha, tipo: m.tipo, monto: m.monto, moneda: m.moneda,
      nota: m.tipo === 'mensualidad' ? m.nota : '',
    })),
    cajas,
    avisos: avisosDe(id).map((a) => ({ fecha: String(a.creado_at).slice(0, 10), monto: a.monto, moneda: a.moneda, estado: a.estado })),
    solicitudes: db.prepare(`SELECT caja, nota, estado, creado_at FROM chat_solicitud
      WHERE cliente_id=? ORDER BY creado_at DESC LIMIT 10`).all(id),
    pago: comoPagar(id),
  };
}

/** Pide un chat nuevo. No da de alta nada: llega como pedido y se resuelve a mano. */
function pedirChat(d) {
  const id = String(d.cliente_id || '').trim();
  if (!id) return { ok: false, error: 'falta el cliente' };
  const caja = String(d.caja || '').trim().slice(0, 80);
  if (!caja) return { ok: false, error: 'decinos para qué caja lo querés' };
  const sid = 'chs_' + require('crypto').randomBytes(6).toString('hex');
  db.prepare(`INSERT INTO chat_solicitud (id,cliente_id,caja,nota,estado,creado_at)
    VALUES (?,?,?,?,'pendiente',?)`).run(sid, id, caja, String(d.nota || '').slice(0, 400), nowISO());
  return { ok: true, solicitud: { id: sid, caja } };
}

function solicitudesPendientes() {
  const filas = db.prepare("SELECT * FROM chat_solicitud WHERE estado='pendiente' ORDER BY creado_at").all();
  const cli = new Map(clientes.list().clientes.map((c) => [c.id, c]));
  return filas.map((f) => {
    const c = cli.get(f.cliente_id) || {};
    return { ...f, cliente: c.nombre || c.codigo || '(cliente borrado)' };
  });
}

function resolverSolicitud(id, listo) {
  const r = db.prepare('UPDATE chat_solicitud SET estado=?, resuelto_at=? WHERE id=?')
    .run(listo ? 'listo' : 'rechazada', nowISO(), String(id || ''));
  return { ok: r.changes > 0, error: r.changes ? null : 'no existe esa solicitud' };
}

/* ── LOS AVISOS DE PAGO DEL CLIENTE ──────────────────────────────────────────────────────────
   Sube la captura desde su hoja y queda esperando. No mueve el saldo hasta que se aprueba. */
const MAX_ADJUNTO = 6 * 1024 * 1024;   // una captura pesa mucho menos; más que esto es otra cosa

function avisarPago(d) {
  const cid = String(d.cliente_id || '').trim();
  if (!cid) return { ok: false, error: 'falta el cliente' };
  /* El monto se lee con el mismo criterio que el resto del sistema: mira la POSICIÓN del último
     separador en vez de suponer. "94.22" es noventa y cuatro con veintidós, no nueve mil. Ese error
     pasó de verdad con los pagos de fichas y costó un aviso de 9.422 por una transferencia de 94. */
  const num = parseMonto(d.monto);
  if (num == null || !(num > 0)) return { ok: false, error: 'el monto no es válido' };
  /* Se guarda YA REDONDEADO y en notación normal. Un número enorme salía como "1e+21", que después
     el control de los pagos rechaza: el aviso quedaba clavado en pendiente, imposible de aprobar,
     con un monto que este mismo store había aceptado. Lo que entra tiene que poder salir. */
  if (!(num < 1e12)) return { ok: false, error: 'ese monto no parece real' };
  const monto = money.round(num.toFixed(2), 2);
  if (!money.esNumero(monto) || !money.isPos(monto)) return { ok: false, error: 'el monto no es válido' };
  /* Tope de avisos sin resolver. Sin esto, el portal —que se abre escribiendo el nombre de una
     caja— deja a cualquiera meter capturas de 6 MB en la base hasta llenarla. */
  if (avisosSinResolver(cid) >= 10) {
    return { ok: false, error: 'Ya tenés varios avisos esperando. Escribinos y los revisamos.' };
  }
  const a = d.archivo || null;
  let bytes = 0; let b64 = null; let nombre = null; let tipo = null;
  if (a && a.base64) {
    b64 = String(a.base64).replace(/^data:[^;]+;base64,/, '');
    bytes = Math.floor((b64.length * 3) / 4);
    if (bytes > MAX_ADJUNTO) return { ok: false, error: 'la imagen es muy grande (máximo 6 MB)' };
    nombre = String(a.nombre || 'comprobante').slice(0, 120);
    /* ⚠️ EL TIPO NO LO ELIGE EL CLIENTE. Lo manda él en el JSON, y si pone "text/html" el archivo
       vuelve a salir con ese tipo cuando vos lo abrís desde el panel: sería HTML de otro corriendo
       adentro de tu sesión. Sólo se aceptan tipos de imagen conocidos, y cualquier otra cosa se
       guarda como binario. */
    const t = String(a.tipo || '').toLowerCase().slice(0, 60);
    tipo = /^image\/(jpeg|jpg|png|gif|webp|heic|heif)$/.test(t) ? t : 'application/octet-stream';
  }
  const id = 'chc_' + require('crypto').randomBytes(6).toString('hex');
  db.prepare(`INSERT INTO chat_comprobante
    (id,cliente_id,mes,monto,moneda,referencia,archivo_nombre,archivo_tipo,archivo_bytes,archivo_b64,estado,creado_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,'pendiente',?)`)
    .run(id, cid, String(d.mes || '').slice(0, 7) || hoy().slice(0, 7), monto,
      String(d.moneda || 'USDT').toUpperCase().slice(0, 8), String(d.referencia || '').slice(0, 200),
      nombre, tipo, bytes, b64, nowISO());
  return { ok: true, aviso: { id, monto, archivo_bytes: bytes } };
}

/** Los avisos de un cliente (para que vea en su hoja que el suyo llegó y no lo mande otra vez). */
function avisosDe(clienteId) {
  // Sin `archivo_b64`: son cientos de KB cada uno y acá sólo se listan.
  return db.prepare(`SELECT id, mes, monto, moneda, referencia, archivo_bytes, estado, creado_at, resuelto_at
    FROM chat_comprobante WHERE cliente_id=? ORDER BY creado_at DESC LIMIT 20`).all(String(clienteId || ''));
}

/* Cuántos avisos sin resolver tiene: más de un puñado sin mirar es alguien apretando el botón, no
   alguien pagando. El portal es público y no pide contraseña. */
function avisosSinResolver(clienteId) {
  return db.prepare("SELECT COUNT(*) n FROM chat_comprobante WHERE cliente_id=? AND estado='pendiente'")
    .get(String(clienteId || '')).n;
}

/** Los que están esperando que alguien los mire. Sin el archivo: pesa cientos de KB cada uno. */
function avisosPendientes() {
  const filas = db.prepare(`SELECT id, cliente_id, mes, monto, moneda, referencia, archivo_bytes, estado, creado_at
    FROM chat_comprobante WHERE estado='pendiente' ORDER BY creado_at`).all();
  const cli = new Map(clientes.list().clientes.map((c) => [c.id, c]));
  return filas.map((f) => {
    const c = cli.get(f.cliente_id) || {};
    return { ...f, cliente: c.nombre || c.codigo || '(cliente borrado)' };
  });
}

/** El archivo de un aviso, para poder mirarlo antes de aprobarlo. */
function archivoDeAviso(id) {
  return db.prepare('SELECT archivo_nombre, archivo_tipo, archivo_b64 FROM chat_comprobante WHERE id=?')
    .get(String(id || ''));
}

/**
 * Aprueba un aviso: recién ACÁ se mueve el saldo. Rechazarlo no mueve nada y queda registrado —
 * borrarlo dejaría al cliente diciendo "yo avisé" sin nada que mirar.
 */
function resolverAviso(id, aprobar) {
  const f = db.prepare('SELECT * FROM chat_comprobante WHERE id=?').get(String(id || ''));
  if (!f) return { ok: false, error: 'no existe ese aviso' };
  if (f.estado !== 'pendiente') return { ok: false, error: `ese aviso ya está ${f.estado}` };
  if (!aprobar) {
    db.prepare("UPDATE chat_comprobante SET estado='rechazado', resuelto_at=? WHERE id=?").run(nowISO(), f.id);
    return { ok: true, estado: 'rechazado' };
  }
  const pg = pagarCliente({
    cliente_id: f.cliente_id, mes: f.mes, monto: f.monto, moneda: f.moneda,
    fecha: String(f.creado_at || '').slice(0, 10), nota: 'aviso del cliente' + (f.referencia ? ' · ' + f.referencia : ''),
  });
  if (!pg.ok) return pg;
  db.prepare("UPDATE chat_comprobante SET estado='aprobado', resuelto_at=?, mov_id=? WHERE id=?")
    .run(nowISO(), pg.mov.id, f.id);
  return { ok: true, estado: 'aprobado', mov: pg.mov };
}

/* ── LO QUE YA LE PAGASTE AL PROVEEDOR ───────────────────────────────────────────────────────
   Un mes pagado y uno impago se veían igual: el sistema calculaba lo que correspondía y no
   guardaba en ningún lado si el pago se hizo. */
/** Deja anotado el resultado del envío. Se pisa: lo que importa es el último intento. */
function marcarEnviado(clienteId, mes, r) {
  db.prepare(`INSERT INTO chat_envio (cliente_id,mes,ok,error,at) VALUES (?,?,?,?,?)
    ON CONFLICT(cliente_id,mes) DO UPDATE SET ok=excluded.ok, error=excluded.error, at=excluded.at`)
    .run(String(clienteId), String(mes).slice(0, 7), r && r.ok ? 1 : 0,
      r && r.ok ? null : String((r && r.error) || 'error desconocido'), nowISO());
  return { ok: true };
}

/** Deja anotado el aviso de una mensualidad, de a una: cada caja tiene su día. */
function marcarAvisoMens(clienteId, panel, fecha, r) {
  db.prepare(`INSERT INTO chat_aviso_mens (id,cliente_id,panel,fecha,ok,error,at)
    VALUES (?,?,?,?,?,?,?)`).run('chav_' + require('crypto').randomBytes(6).toString('hex'),
    String(clienteId), String(panel || ''), String(fecha || '').slice(0, 10),
    r && r.ok ? 1 : 0, r && r.ok ? null : String((r && r.error) || 'error desconocido'), nowISO());
  return { ok: true };
}

/** Qué mensualidades ya se avisaron ese día, por caja. */
function avisosMensDe(fecha) {
  const f = String(fecha || '').slice(0, 10);
  const out = {};
  // La llave lleva el cliente: dos clientes pueden tener una caja con el mismo nombre y el aviso de
  // uno marcaba como avisada la del otro.
  for (const r of db.prepare('SELECT * FROM chat_aviso_mens WHERE fecha=? ORDER BY at').all(f)) {
    out[`${r.cliente_id}|${r.panel}`] = { ok: !!r.ok, error: r.error, at: r.at };
  }
  return out;
}

/** Lo enviado de un mes, por cliente. */
function envios(mes) {
  const m = String(mes || '').slice(0, 7);
  const out = {};
  for (const f of db.prepare('SELECT * FROM chat_envio WHERE mes=?').all(m)) {
    out[f.cliente_id] = { ok: !!f.ok, error: f.error, at: f.at };
  }
  return out;
}

function pagos(mes) {
  const m = String(mes || '').slice(0, 7);
  const filas = m
    ? db.prepare('SELECT * FROM chat_pago_proveedor WHERE mes=? ORDER BY fecha, createdAt').all(m)
    : db.prepare('SELECT * FROM chat_pago_proveedor ORDER BY mes DESC, fecha').all();
  return filas;
}

function pagado(mes) {
  return money.round(money.sum(pagos(mes).map((p) => p.monto || '0')), 2);
}

function pagar(d) {
  const m = String(d.mes || '').slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(m)) return { ok: false, error: 'mes inválido (se espera YYYY-MM)' };
  const monto = String(d.monto == null ? '' : d.monto).trim();
  if (!money.esNumero(monto) || !money.isPos(monto)) {
    return { ok: false, error: 'el monto tiene que ser un número mayor que cero. Usá punto para los decimales: 1419.49' };
  }
  const fecha = String(d.fecha || '').slice(0, 10) || hoy();
  const id = 'chp_' + require('crypto').randomBytes(6).toString('hex');
  db.prepare(`INSERT INTO chat_pago_proveedor (id,mes,monto,moneda,fecha,nota,createdAt)
    VALUES (?,?,?,?,?,?,?)`).run(id, m, money.round(monto, 2),
    String(d.moneda || 'USDT').toUpperCase().slice(0, 8), fecha, String(d.nota || ''), nowISO());
  return { ok: true, pago: db.prepare('SELECT * FROM chat_pago_proveedor WHERE id=?').get(id) };
}

function borrarPago(id) {
  const r = db.prepare('DELETE FROM chat_pago_proveedor WHERE id=?').run(String(id || ''));
  return { ok: true, borrados: r.changes };
}

module.exports = {
  config, setConfig, list, set, quitar, gananciaDelMes, cierre, mensualidadesDe,
  destino, setDestino, porCliente, pagos, pagado, pagar, borrarPago, botToken,
  marcarEnviado, envios, partirGrupos, destinos, marcarAvisoMens, avisosMensDe,
  wallets, guardarWallet, borrarWallet, walletDe, comoPagar, walletsApagadasEnUso,
  cobrar, descobrar, pagarCliente, borrarMov, cuentas, cobrarMensualidad, periodoDesde,
  avisarPago, avisosDe, avisosPendientes, archivoDeAviso, resolverAviso, avisosSinResolver,
  quienEntra, portalDe, pedirChat, solicitudesPendientes, resolverSolicitud,
};
