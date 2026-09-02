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
/* ⚠️ UNA FILA POR CUENTA, no por cliente. Un cliente con cajas en dos monedas recibe dos cuentas
   del mismo mes. Con la clave vieja —(cliente, mes)— el segundo envío PISABA al primero, y eso
   mentía en las dos direcciones: si el de guaraníes salía y el de pesos fallaba, la fila quedaba
   en error y parecía que no había salido nada; al revés, el error del primero desaparecía.
   La columna se agrega y la PK vieja se deja: SQLite no deja cambiarla sin rehacer la tabla, y un
   índice único sobre las tres columnas hace el mismo trabajo. La PK vieja se afloja poniendo la
   divisa adentro del `cliente_id` guardado — ver `_claveEnvio`. */
try { db.exec("ALTER TABLE chat_envio ADD COLUMN divisa TEXT NOT NULL DEFAULT ''"); } catch (e) { /* ya estaba */ }

/* LOS DOS LINKS DE CADA CAJA.
   Cada caja nueva viene con un link para los jugadores y otro para el panel del administrador. Son
   de la caja y NO se pueden deducir: hay muchos dominios en juego y no hay ninguna relación entre
   el nombre de la cuenta y el dominio que le toca, así que se escriben a mano. El usuario del panel
   se guarda porque es lo que el cliente necesita tener a mano; LA CONTRASEÑA NO — ver `setLinks`.
   Se agregan aparte porque ALTER TABLE tira error si la columna ya está. */
for (const col of ['link_jugadores TEXT', 'link_panel TEXT', 'usuario_admin TEXT']) {
  try { db.exec(`ALTER TABLE chat_panel ADD COLUMN ${col}`); } catch (e) { /* ya estaba */ }
}
/* ── LO QUE YA ESTABA, PUESTO EN SU CUENTA ───────────────────────────────────────────────────
   Corre una vez, al arrancar. Las mensualidades viejas saben de qué caja son (`panel`), así que
   se les puede poner la divisa de esa caja. Los cobros del % viejos NO: un cobro era el total de
   todas las monedas juntas y no hay forma de partirlo desde acá — se deshacen y se vuelven a
   emitir desde la pantalla, que es donde está el cálculo.
   Idempotente: sólo toca las filas que todavía no tienen divisa. */
function _ponerDivisaALoViejo() {
  try {
    const faltan = db.prepare("SELECT COUNT(*) n FROM chat_mov WHERE tipo='mensualidad' AND (divisa IS NULL OR divisa='') AND panel IS NOT NULL").get().n;
    if (!faltan) return;
    const cajas = new Map();
    for (const p of list()) cajas.set(`${p.cliente_id}|${p.panel}`, String(p.divisa || '').toUpperCase());
    const upd = db.prepare('UPDATE chat_mov SET divisa=? WHERE id=?');
    const filas = db.prepare("SELECT id, cliente_id, panel FROM chat_mov WHERE tipo='mensualidad' AND (divisa IS NULL OR divisa='') AND panel IS NOT NULL").all();
    let n = 0;
    db.transaction(() => {
      for (const f of filas) {
        const dv = cajas.get(`${f.cliente_id}|${f.panel}`) || '';
        if (!dv) continue;
        upd.run(dv, f.id); n += 1;
      }
    })();
    if (n) console.log(`[Chat] ${n} mensualidad(es) quedaron asignadas a su cuenta por divisa`);
  } catch (e) { console.warn('[Chat] no se pudo asignar la divisa a lo viejo:', e.message); }
}

/* ── LA DIVISA DE LA CAJA ────────────────────────────────────────────────────────────────────
   Se GUARDA, no se deduce. Hasta acá la moneda de una caja era un hecho de los datos: salía del
   reporte del casino mes a mes. Sirve para mostrar, pero no para facturar, por dos motivos:

   · El mantenimiento vence el día de alta de la caja, que puede caer ANTES de que ese mes tenga
     un solo día de datos. En ese momento no hay de dónde deducir nada, y esos 150 USDT tienen que
     entrar a una de las dos cuentas igual.
   · Una caja puede reportar en dos monedas el mismo mes —el cálculo lo contempla— y ahí el
     mantenimiento no se puede partir: repartirlo sería inventar una proporción.

   Se completa sola con lo que dicen los datos y se puede corregir a mano, que es lo honesto:
   asignarle una divisa a los 150 es una convención, no un dato. */
try { db.exec('ALTER TABLE chat_panel ADD COLUMN divisa TEXT'); } catch (e) { /* ya estaba */ }
// A qué wallet paga ESTE cliente cada cosa. Vacío = la de siempre.
for (const col of ['wallet_ggr TEXT', 'wallet_mens TEXT']) {
  try { db.exec(`ALTER TABLE chat_cliente ADD COLUMN ${col}`); } catch (e) { /* ya estaba */ }
}
/* De qué caja es una mensualidad. Antes se deducía buscando el nombre adentro de la nota, y
   "Ariel-A1" está adentro de "Ariel-A10": una caja quedaba marcada como cobrada por el nombre de
   otra. El dato se guarda, no se adivina. */
try { db.exec('ALTER TABLE chat_mov ADD COLUMN panel TEXT'); } catch (e) { /* ya estaba */ }
/* ── DE QUÉ CUENTA ES ESTE MOVIMIENTO ────────────────────────────────────────────────────────
   Un cliente puede tener cajas en dos monedas, y a veces son dos negocios distintos con socios
   distintos: los quiere separados, y a veces va a pagar cada uno en su moneda.

   ⚠️ NO ES `moneda`. `moneda` es la unidad en que está EXPRESADO el monto —siempre USDT, la
   cuenta del chat se lleva así— y `divisa` es DE QUÉ CUENTA es ese monto: la de sus cajas en PYG
   o la de las de ARS. Dos cosas distintas que se llaman parecido, por eso el nombre distinto.

   Vacío ('') = movimiento de antes de la división, o de un cliente de una sola moneda. Se guarda
   '' y no NULL a propósito: en SQLite dos NULL son distintos entre sí, así que un índice único
   con NULL no impide nada. */
try { db.exec("ALTER TABLE chat_mov ADD COLUMN divisa TEXT NOT NULL DEFAULT ''"); } catch (e) { /* ya estaba */ }
/* El índice único pasa a llevar la divisa: son DOS cobros por mes cuando el cliente tiene cajas en
   dos monedas, y uno solo cuando tiene en una. Va acá abajo y no arriba con los otros porque usa
   la columna que se acaba de agregar. Se tira el viejo primero: si quedara, seguiría prohibiendo
   el segundo cobro del mes y la división no entraría en la base. */
try { db.exec('DROP INDEX IF EXISTS ux_chat_cobro'); } catch (e) { /* no estaba */ }
try {
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ux_chat_cobro_div
    ON chat_mov (cliente_id, mes, divisa) WHERE tipo='cobro'`);
} catch (e) { console.warn('[Chat] no se pudo crear el índice del cobro por divisa:', e.message); }
/* AL PROVEEDOR SE LE PAGAN DOS COSAS, Y NO JUNTAS. El % de la ganancia y el mantenimiento de cada
   caja van a wallets distintas y en fechas distintas, así que cada pago tiene que decir de cuál de
   las dos es: si no, un saldo a medias no dice qué falta. */
try { db.exec("ALTER TABLE chat_pago_proveedor ADD COLUMN concepto TEXT"); } catch (e) { /* ya estaba */ }
/* DÓNDE Y CON QUÉ se le pagó. Hasta ahora un pago era un monto y una fecha, y "¿dónde me lo
   mandaste?" se contestaba buscando en el chat. `destino` es la wallet del proveedor tal como él la
   dio (la red va adentro: es lo que él escribió) y `hash` el comprobante de la red. Los dos
   opcionales: los pagos viejos no los tienen y no se inventan. */
for (const col of ['destino TEXT', 'red TEXT', 'hash TEXT']) {
  try { db.exec(`ALTER TABLE chat_pago_proveedor ADD COLUMN ${col}`); } catch (e) { /* ya estaba */ }
}
/* LA CONTRASEÑA DEL PANEL DE CADA CAJA, y la clave con la que el cliente puede verla.
   Hay clientes con muchas cuentas y no se acuerdan cuál va con cuál; tenerlas acá les resuelve el
   problema. Pero al portal se entra escribiendo el NOMBRE DE UNA CAJA, sin contraseña: dejarlas a
   la vista ahí sería regalarle el panel a cualquiera que adivine un nombre. Por eso los accesos
   sólo se muestran después de escribir una clave que vos le das una vez, y que vive en el cliente,
   no en la caja: es la llave del portal, no la del casino. */
for (const col of ['clave_admin TEXT']) {
  try { db.exec(`ALTER TABLE chat_panel ADD COLUMN ${col}`); } catch (e) { /* ya estaba */ }
}
try { db.exec('ALTER TABLE chat_cliente ADD COLUMN clave_portal TEXT'); } catch (e) { /* ya estaba */ }
/* Lo que hace falta saber para abrir una caja, y que sólo sabe el cliente: en qué página juega su
   gente, con qué dominio y en qué moneda. Preguntarlo en el pedido evita la ida y vuelta de tres
   mensajes que hoy pasa por privado. */
for (const col of ['pagina TEXT', 'dominio TEXT', 'divisa TEXT', 'caja_nueva INTEGER']) {
  try { db.exec(`ALTER TABLE chat_solicitud ADD COLUMN ${col}`); } catch (e) { /* ya estaba */ }
}
/* DE QUÉ ES EL PAGO. Al cliente se le cobran dos cosas —el % del mes y el mantenimiento— y hasta
   ahora avisaba "pagué 150" sin decir de cuál de las dos, así que había que adivinarlo mirando el
   monto. Mismo vocabulario que del lado del proveedor: 'ganancia' | 'mantenimiento'.
   Es OPCIONAL en toda la cadena: los avisos viejos no lo tienen y los links que ya andan no lo
   mandan — rechazarlos sería romperle el aviso a alguien que sí pagó. */
try { db.exec('ALTER TABLE chat_comprobante ADD COLUMN concepto TEXT'); } catch (e) { /* ya estaba */ }
try { db.exec('ALTER TABLE chat_mov ADD COLUMN concepto TEXT'); } catch (e) { /* ya estaba */ }
/* QUÉ CAJAS CUBRE ESTE PAGO. Uno con cuatro cajas no paga cuatro veces 150: paga una vez y elige
   cuáles está cubriendo. Sin esto, un pago de 300 sobre cuatro mantenimientos de 150 no dice cuáles
   dos quedaron al día — y ésa es justo la pregunta que hay que poder contestar. Va como lista de
   nombres separados por coma, el mismo patrón que los grupos de Telegram y las wallets.
   Vacío = "lo que haya", y se reparte en cascada. */
/* LA SALA QUE MIDE ESTE CHAT. Por defecto es el nodo del panel, pero no siempre coinciden: el
   chat se contrata para una caja y la ganancia puede estar UN NIVEL MÁS ABAJO, en el nodo donde
   cuelgan los jugadores. Medido: «GAF-parA» reportaba 11.003.651 PYG en agosto mientras
   «fortunareal1py», que cuelga de ella y tiene los 1.000 jugadores, reportaba 64.723.344 — seis
   veces más. Sin poder decirlo, el chat factura sobre el nodo equivocado y no hay forma de notarlo.
   Vacío = el nodo del panel, como siempre. */
try { db.exec('ALTER TABLE chat_panel ADD COLUMN sala_id TEXT'); } catch (e) { /* ya estaba */ }
try { db.exec('ALTER TABLE chat_panel ADD COLUMN sala_login TEXT'); } catch (e) { /* ya estaba */ }
try { db.exec('ALTER TABLE chat_comprobante ADD COLUMN cajas TEXT'); } catch (e) { /* ya estaba */ }
/* DE CUÁL DE SUS CUENTAS ES ESTE PAGO. Un cliente con cajas en dos monedas tiene dos cuentas; un
   aviso que no dice de cuál es, al aprobarse le tapa deuda a la equivocada y las dos quedan mal.
   Vacío = tiene una sola, que es el caso de casi todos. */
try { db.exec('ALTER TABLE chat_comprobante ADD COLUMN divisa TEXT'); } catch (e) { /* ya estaba */ }
/* ── POR QUÉ SE SALDÓ UNA DIFERENCIA ─────────────────────────────────────────────────────────
   El cliente que paga en pesos usa SU tipo de cambio: si debe 160 y paga 155, esos 5 no se le
   reclaman — se asumen como diferencia de cambio. Pero borrarlos sin dejar rastro hace que dentro
   de tres meses nadie pueda explicar por qué la cuenta cerró con menos de lo facturado.
   Así que la diferencia es UNA FILA MÁS, tipo 'ajuste', con el motivo escrito. La cuenta queda en
   cero y el porqué queda auditable. */
try { db.exec('ALTER TABLE chat_mov ADD COLUMN motivo TEXT'); } catch (e) { /* ya estaba */ }
try { db.exec('ALTER TABLE chat_mov ADD COLUMN cajas TEXT'); } catch (e) { /* ya estaba */ }
/* ¿EL AVISO A LA MATRIZ SALIÓ? Un comprobante que no llega al grupo no dejaba forma de saber si el
   problema era el grupo, el bot o el permiso.
   ⚠️ EL BACKFILL NO ES DECORATIVO. Sin él las filas viejas quedan en NULL, y NULL no matchea ni
   `=0` ni `=1`: un aviso que nunca se intentó desaparecería de las dos listas —la de los que
   fallaron y la de los que salieron— que son justamente la red que hace visible el problema. Por
   eso además se consulta con `IS NOT 1` y nunca con `=0`. */
for (const col of ['aviso_ok INTEGER', 'aviso_error TEXT', 'aviso_at TEXT']) {
  try { db.exec(`ALTER TABLE chat_comprobante ADD COLUMN ${col}`); } catch (e) { /* ya estaba */ }
}
try { db.exec('UPDATE chat_comprobante SET aviso_ok=0 WHERE aviso_ok IS NULL'); } catch (e) { /* no pasa nada */ }
try { db.exec('ALTER TABLE chat_comprobante ADD COLUMN archivo_tipo_seguro TEXT'); } catch (e) { /* ya estaba */ }
try { db.exec('CREATE INDEX IF NOT EXISTS ix_chat_cmp_cli ON chat_comprobante(cliente_id)'); } catch (e) { /* ya estaba */ }

const nowISO = () => new Date().toISOString();

/* UN PORCENTAJE ESCRITO CON COMA ES EL MISMO NÚMERO. "2,5" es como se escribe acá, y rechazarlo
   obligaba a volver a tipear lo mismo con un punto — la forma natural de escribir un número no
   puede ser la forma equivocada. Un % no lleva separador de miles (nadie cobra el 1.500%), así que
   la coma siempre es decimal y no hay nada que adivinar: no es el caso de los montos, donde "94.22"
   sí es ambiguo. Se guarda normalizado con punto, que es lo que entiende el resto del sistema. */
const normPct = (x) => String(x == null ? '' : x).trim().replace(',', '.');
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
    /* El campo crudo sigue viajando igual —con una sola wallet es el id pelado de siempre— y al
       lado va la lista ya partida, exactamente como destino() hace con los grupos de Telegram. */
    wallet_ggr: cfg.getCfg(W_GGR) || '',
    wallet_mens: cfg.getCfg(W_MENS) || '',
    wallets_ggr: partirWallets(cfg.getCfg(W_GGR)),
    wallets_mens: partirWallets(cfg.getCfg(W_MENS)),
    bot_propio: !!propio,
    bot_hint: propio ? '…' + propio.slice(-6) : '',
    bot_general: !propio && !!cfg.getTelegramToken(),
  };
}
function setConfig(d) {
  if (d.costo_pct !== undefined) {
    const v = normPct(d.costo_pct);
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
    /* Puede venir una sola o varias. Si UNA de la lista no existe no se guarda ninguna: media
       lista guardada es peor que ninguna, porque el que la mandó cree que quedaron las dos. */
    const ids = partirWallets(d[k]);
    for (const id of ids) {
      if (!db.prepare('SELECT id FROM chat_wallet WHERE id=?').get(id)) {
        return { ok: false, error: 'esa wallet no existe' };
      }
    }
    cfg.setCfg(clave, juntarWallets(ids));
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
/* QUÉ MONEDA REPORTA ESA CAJA, según los datos. Es la sugerencia, no el dato de facturación: el
   que factura es `chat_panel.divisa`, que se guarda. Mira los últimos meses y se queda con la
   moneda que más días trajo — si una caja cambió de moneda, el mes viejo no manda sobre el nuevo.
   Devuelve null si no hay datos: sin datos no se inventa una divisa. */
function _divisaSegunLosDatos(nodo, conexionId) {
  if (!nodo || !conexionId) return null;
  try {
    const r = db.prepare(`SELECT moneda, COUNT(*) n FROM reporte_diario
      WHERE conexion_id=? AND sa_id=? AND fecha >= date('now','-4 months')
      GROUP BY moneda ORDER BY n DESC LIMIT 1`).get(String(conexionId), String(nodo));
    return (r && r.moneda) || null;
  } catch (e) { return null; }
}

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
      usuario_admin: f.usuario_admin || '', clave_admin: f.clave_admin || '',
      conexion_id: p.conexion_id || null,
      sala_id: f.sala_id || '', sala_login: f.sala_login || '',
      /* ⚠️ SIN SALA, TODO LO QUE SE COBRA SALE DEL NODO EQUIVOCADO. Se factura sobre la sala, no
         sobre la caja: medido en agosto, «GAF-parA» daba 11.003.651 PYG y su sala 96.122.809. La
         marca viaja para que la pantalla lo grite en vez de dejarlo pasar. */
      faltaSala: !f.sala_id,
      /* El nodo que se MIDE. Una sola fuente: si estuviera resuelto en cada lugar que lo usa, el
         día que se agregue uno nuevo va a quedar mirando el nodo del panel sin que nadie lo note. */
      nodo: String(f.sala_id || p.id_usuario || ''),
      cliente_id: p.cliente_id || null, cliente: c.nombre || c.codigo || '—',
      /* DE QUÉ CUENTA ES ESTA CAJA. La guardada manda; si está vacía se usa la de los datos, y se
         avisa que es sugerida para que se pueda confirmar en vez de quedar adivinada para siempre. */
      divisa: String(f.divisa || '').toUpperCase()
        || _divisaSegunLosDatos(String(f.sala_id || p.id_usuario || ''), p.conexion_id) || '',
      divisaPuesta: !!f.divisa,
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
    ? normPct(d.pct_cliente)
    : String((prev && prev.pct_cliente) || '');
  if (pct) {
    if (!money.esNumero(pct)) return { ok: false, error: `"${d.pct_cliente}" no es un número. Podés escribirlo con coma o con punto: 2,5` };
    if (money.isNeg(pct) || money.cmp(pct, '100') > 0) return { ok: false, error: 'el % tiene que estar entre 0 y 100' };
    /* ⚠️ NUNCA POR DEBAJO DE LO QUE TE CUESTA. Un 1% cuando el proveedor te cobra 2 es pagar de tu
       bolsillo para que el cliente tenga el servicio, y eso no se decide tipeando un número en una
       tabla: no se guarda. Si alguna vez hace falta —una promoción de verdad— se baja primero el
       costo, que es el número que manda. El aviso de "cobrás menos de lo que te cuesta" sigue
       existiendo para el otro caso: que el costo SUBA después de haber puesto los precios. */
    const costo = String(config().costo_pct || '0');
    if (money.esNumero(costo) && money.cmp(pct, costo) < 0) {
      return { ok: false, error: `No podés cobrar ${pct}%: te cuesta ${costo}%. Estarías pagando vos la diferencia.` };
    }
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
  if (vino('clave_admin')) links.clave_admin = String(d.clave_admin || '').trim().slice(0, 120) || null;
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
  /* SON DOS COSAS DISTINTAS Y NO SE PISAN.
     `desde` es CUÁNDO EMPEZÓ a tener el chat; `dia_cobro` es QUÉ DÍA paga. Casi siempre coinciden
     —el mantenimiento se cobra el día que arranca, por adelantado— así que la primera vez el día se
     completa solo con el de la fecha. Pero si vos ya pusiste un día, corregir la fecha de alta no
     te lo cambia por atrás: eran dos datos mezclados en uno y no se sabía cuál mandaba. */
  if (desdeNueva && !vino('dia_cobro') && !(prev && prev.dia_cobro)) {
    const n = Number(desdeNueva.slice(8, 10));
    if (n >= 1 && n <= 31) dia = Math.min(n, 28);
  }
  if (dia != null && (!Number.isInteger(dia) || dia < 1 || dia > 28)) {
    return { ok: false, error: 'el día de cobro tiene que estar entre 1 y 28 (para que exista en todos los meses)' };
  }
  const q = (k) => (Object.prototype.hasOwnProperty.call(links, k) ? links[k] : ((prev && prev[k]) || null));
  db.prepare(`INSERT INTO chat_panel
      (panel_id,pct_cliente,dia_cobro,activo,desde,notas,createdAt,link_jugadores,link_panel,usuario_admin,clave_admin,sala_id,sala_login,divisa)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(panel_id) DO UPDATE SET pct_cliente=excluded.pct_cliente, dia_cobro=excluded.dia_cobro,
      activo=excluded.activo, desde=excluded.desde, notas=excluded.notas,
      link_jugadores=excluded.link_jugadores, link_panel=excluded.link_panel,
      usuario_admin=excluded.usuario_admin, clave_admin=excluded.clave_admin,
      sala_id=excluded.sala_id, sala_login=excluded.sala_login, divisa=excluded.divisa`)
    .run(id, pct || null, dia,
      vino('activo') ? (d.activo === false ? 0 : 1) : (prev ? prev.activo : 1),
      String(d.desde || (prev && prev.desde) || '').slice(0, 10) || null,
      vino('notas') ? String(d.notas || '') : String((prev && prev.notas) || ''),
      (prev && prev.createdAt) || nowISO(),
      q('link_jugadores'), q('link_panel'), q('usuario_admin'), q('clave_admin'),
      /* El id del casino se guarda como lo escribió ella, sin adivinar: acá se pega un número de
         la pantalla del casino y no hay forma de deducirlo del nombre. Vacío vuelve al nodo del panel. */
      (vino('sala_id') ? String(d.sala_id || '').trim().slice(0, 32) : String((prev && prev.sala_id) || '')) || null,
      (vino('sala_login') ? String(d.sala_login || '').trim().slice(0, 80) : String((prev && prev.sala_login) || '')) || null,
      /* Vacío = la que digan los datos. Confirmarla la fija: es una convención —a qué cuenta van
         los 150 del mantenimiento— y una convención se decide, no se deduce todos los meses. */
      (vino('divisa') ? String(d.divisa || '').trim().toUpperCase().slice(0, 8) : String((prev && prev.divisa) || '')) || null);
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
  /* ⚠️ DÍA POR DÍA, NO EL TOTAL DEL MES. Una caja que contrató el chat el 22 no tiene por qué
     pagar el % de lo que trabajó del 1 al 21: eso lo ganó sin el servicio. Sumando el mes entero
     —que es lo que se hacía— se le cobraban tres semanas de más en su primer mes, y el número
     salía redondo y sin ninguna señal de que estuviera mal.
     Del segundo mes en adelante no cambia nada: `desde` queda antes del 1 y entran todos los días. */
  const filas = db.prepare(`SELECT conexion_id, grp, sa_id, moneda, fecha, CAST(profit AS REAL) profit
    FROM reporte_diario WHERE substr(fecha,1,7)=?`)
    .all(String(mes || '').slice(0, 7));
  const m = new Map();
  // La clave lleva el NIVEL: el mismo id de nodo existe como superagente y como agente, con
  // números distintos, y mezclarlos sumaría la caja dos veces.
  for (const f of filas) {
    const k = `${f.conexion_id}|${f.grp}|${f.sa_id}|${f.moneda || 'ARS'}`;
    if (!m.has(k)) m.set(k, new Map());
    const dia = String(f.fecha || '').slice(0, 10);
    m.get(k).set(dia, (m.get(k).get(dia) || 0) + (Number(f.profit) || 0));
  }
  return m;
}

/**
 * Suma los días de una caja DESDE que tiene el servicio.
 *
 * `desde` vacío = todos los días del mes, que es el caso normal a partir del segundo mes.
 * Devuelve también cuántos días entraron y cuántos quedaron afuera: sin eso, un mes recortado y un
 * mes completo se ven idénticos en pantalla y nadie puede comprobar por qué el número es ése.
 */
function sumarDesde(porDia, desde) {
  let profit = 0; let dias = 0; let afuera = 0;
  /* Y QUÉ TRAMO SE CONTÓ, no sólo cuántos días. «15 días» no le dice al cliente cuáles: el primer
     mes cada caja arrancó en una fecha distinta, así que su % no cubre el mes entero y sin las dos
     puntas no hay forma de comprobar el número. Salen de los días con dato, no del calendario: un
     día sin movimiento no está en `porDia` y decir que se contó igual sería inventarlo. */
  let primero = null; let ultimo = null;
  for (const [dia, v] of porDia) {
    if (desde && dia < desde) { afuera += 1; continue; }
    profit += v; dias += 1;
    if (primero === null || dia < primero) primero = dia;
    if (ultimo === null || dia > ultimo) ultimo = dia;
  }
  return { profit, dias, afuera, desde: primero, hasta: ultimo };
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
  /* Las que no tienen sala puesta. NO se saltean —se cobran igual, midiendo la caja— pero se
     nombran: sobre la sala se factura todo, y una caja sin ella casi seguro está midiendo un nodo
     que no es el que produce. Es un aviso, no un bloqueo: bloquear el cierre por esto dejaría el
     mes sin cobrar por algo que quizás está bien. */
  const sinSala = [];
  for (const p of list()) {
    if (!p.activo) { salteados.push({ panel: p.panel, cliente: p.cliente, motivo: 'está pausado' }); continue; }
    if (p.faltaSala) sinSala.push({ panel: p.panel, cliente: p.cliente, nodo: p.nodo });
    if (!p.conexion_id || !p.nodo) {
      salteados.push({ panel: p.panel, cliente: p.cliente, motivo: 'el panel no está enlazado al casino' });
      continue;
    }
    // Un panel puede reportar en varias monedas; cada una se convierte con su propio tipo de cambio.
    const monedas = [];
    for (const [k, v] of g) {
      const [cx, grp, nodo, mon] = k.split('|');
      /* ⚠️ SE COMPARA CONTRA `p.nodo`, que es la sala si ella la puso y el panel si no.
         Y cuando hay sala propia NO se filtra por nivel: la sala suele estar un escalón más abajo
         que el panel, así que exigir el mismo grupo la haría desaparecer justo en el caso para el
         que se agregó el campo. */
      const mismoNodo = String(nodo) === String(p.nodo);
      const mismoNivel = p.sala_id ? true : (grp === p.grp);
      if (cx === p.conexion_id && mismoNivel && mismoNodo) {
        /* Sólo los días desde que tiene el servicio. `desde` es el mismo campo con el que se
           devenga el mantenimiento: si empieza a pagar el 22, el % arranca el 22. */
        const sd = sumarDesde(v, String(p.desde || '').slice(0, 10));
        monedas.push({ moneda: mon, profit: sd.profit, dias: sd.dias, diasAfuera: sd.afuera,
          desde: sd.desde, hasta: sd.hasta });
      }
    }
    /* Una caja sin NINGUNA fila en su nivel no es una caja sin ganancias: es una caja que no está
       en el acumulado. Cobrar cero por eso sería regalar el mes en silencio.
       Y hay DOS motivos posibles, que se arreglan de formas distintas:
         · el mes de ese nivel no se bajó todavía  → hay que capturarlo
         · el mes SÍ está y esa caja no figura     → el número de usuario no es el que el casino
           reporta, y capturar de nuevo no va a cambiar nada
       Decir siempre "todavía no hay datos" mandaba a apretar capturar una y otra vez sobre un
       problema que no se arregla capturando. */
    if (!monedas.length) {
      let hay = 0;
      for (const k of g.keys()) {
        const [cx, grp] = k.split('|');
        if (cx === p.conexion_id && grp === p.grp) hay += 1;
      }
      salteados.push({
        panel: p.panel, cliente: p.cliente, usuario: p.nodo, nivel: p.nivel,
        motivo: hay
          ? `no figura con el usuario ${p.nodo}${p.sala_id ? ' (la sala que le pusiste)' : ''}: el mes SÍ está bajado (${hay} cajas de ${p.nivel || 'ese nivel'}), pero ésta no aparece. Revisá el número.`
          : `todavía no se bajó el nivel ${p.nivel || '—'} de esa conexión en ${m}. Capturá el mes.`,
        capturar: !hay,
      });
      continue;
    }
    /* El tramo de la CAJA es la unión del de sus monedas: una caja puede reportar en dos y no
       necesariamente los mismos días. Es lo que se le muestra al cliente como «del X al Y». */
    const conDato = monedas.filter((x) => x.desde);
    const tramo = conDato.length ? {
      desde: conDato.map((x) => x.desde).sort()[0],
      hasta: conDato.map((x) => x.hasta).sort().slice(-1)[0],
      dias: Math.max(...conDato.map((x) => x.dias)),
      diasAfuera: Math.max(...conDato.map((x) => x.diasAfuera)),
    } : null;
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
      // El link de jugadores viaja con la fila: en la hoja, el nombre de la caja solo no le dice
      // al cliente CUÁL es —tiene varias— y el link es como la reconoce.
      link_jugadores: p.link_jugadores || '',
      sistema: p.sistema, pct_cliente: pctCli, pct_costo: c.costo_pct,
      profit_usdt: profitUsdt, cobra, paga, margen,
      // Desde cuándo tiene el servicio, y qué tramo del mes se le contó.
      contrato_desde: String(p.desde || '').slice(0, 10) || null, tramo,
      // De qué cuenta es esta caja: la guardada, o la que digan sus datos. Ver _divisaDelPanel.
      divisa: String(p.divisa || '').toUpperCase(),
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
    salteados, sinSala,
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
/* Al mantenimiento se puede pagar por más de una red: hay una TRC20 y una BEP20, y el que elige es
   el cliente, que sabe cuál usa. Los ids van en el MISMO campo separados por coma, igual que los
   grupos de Telegram de acá al lado: una tabla aparte para esto habría sido una tabla de una sola
   columna. Con un id solo el campo queda idéntico a como estaba, así que lo que ya está cargado se
   sigue leyendo y escribiendo igual y no hay nada que migrar. */
const partirWallets = (v) => [...new Set(
  (Array.isArray(v) ? v : String(v == null ? '' : v).split(/[\s,;]+/))
    .map((x) => String(x).trim()).filter(Boolean))];
/* El normalizador de escritura. Una lista vacía se guarda como '' y NUNCA como ',' ni ' ': la
   auto-elección de guardarWallet se dispara con getCfg() falsy, y una coma residual la desarma en
   silencio — el día que agregás la segunda wallet todos los clientes se quedan sin dirección. */
const juntarWallets = (v) => partirWallets(v).join(', ');

/* Lista blanca, no validación dura: lo que no está en la lista queda en null, que es "no lo dijo".
   El que avisa un pago es el cliente desde una página pública; que un valor raro tumbe el aviso
   sería perder la noticia de una transferencia que ya se hizo. */
const CONCEPTOS = ['ganancia', 'mantenimiento'];
const normConcepto = (v) => (CONCEPTOS.includes(String(v || '').trim().toLowerCase())
  ? String(v).trim().toLowerCase() : null);

/* 'YYYY-MM' → 'agosto'. A mano y no con Date: pasar 'YYYY-MM' por Date se corre de mes según la
   zona horaria, y el mes equivocado en la cara del cliente es una llamada. */
const MESES_LARGOS = ['', 'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio',
  'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const mesEnLetras = (m) => MESES_LARGOS[Number(String(m || '').slice(5, 7))] || String(m || '');

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
    cfg.setCfg(W_GGR, juntarWallets([id])); cfg.setCfg(W_MENS, juntarWallets([id]));
  }
  return { ok: true, wallet: wallets().find((w) => w.id === id) };
}

function borrarWallet(id) {
  const w = String(id || '');
  /* No se borra la que está en uso: el cliente que la tenía elegida se quedaría sin adónde pagar y
     nadie se enteraría hasta que preguntara. Se apaga, que deja de ofrecerse y no rompe nada.
     ⚠️ Se compara por PERTENENCIA a la lista, nunca por substring ni con LIKE '%id%': «chw_ab» está
     adentro de «chw_ab1» y borraría la equivocada. Es el mismo error que ya está documentado más
     arriba con los nombres de las cajas. */
  const enUso = new Set();
  for (const v of [cfg.getCfg(W_GGR), cfg.getCfg(W_MENS)]) partirWallets(v).forEach((x) => enUso.add(x));
  for (const f of db.prepare('SELECT wallet_ggr, wallet_mens FROM chat_cliente').all()) {
    partirWallets(f.wallet_ggr).forEach((x) => enUso.add(x));
    partirWallets(f.wallet_mens).forEach((x) => enUso.add(x));
  }
  const usada = enUso.has(w);
  if (usada) return { ok: false, error: 'esa wallet está elegida en algún lado. Apagala en vez de borrarla, o cambiá primero quién la usa.' };
  return { ok: true, borrados: db.prepare('DELETE FROM chat_wallet WHERE id=?').run(w).changes };
}

/**
 * QUÉ WALLETS LE TOCAN A ESTE CLIENTE PARA ESTA COSA.
 * Las suyas si tiene elegidas; si no, las de siempre; si no elegiste ninguna y hay UNA sola activa,
 * esa — el caso de una sola wallet es el común y pedir que además la elija sería pedir dos veces lo
 * mismo.
 *
 * Pueden ser VARIAS a propósito: el mantenimiento se cobra por TRC20 y por BEP20, y quien elige la
 * red es el cliente. Se le muestran todas y manda por la que use.
 *
 * ⚠️ Elegir NADA y elegir una APAGADA no son lo mismo. Nada baja al nivel siguiente; una elegida
 * que está apagada se cae de la lista y no se reemplaza por otra: poner la que quedó prendida sería
 * cambiarle al cliente la dirección donde paga sin que nadie lo haya decidido, y ésa es la clase de
 * cambio silencioso que termina en plata mandada a otro lado. Si se apagan TODAS las elegidas no
 * queda ninguna, la hoja no muestra "cómo pagar" y la pantalla avisa.
 */
function walletsDe(clienteId, uso) {
  const act = wallets().filter((w) => w.activa);
  const vivas = (v) => {
    const ids = partirWallets(v);
    if (!ids.length) return undefined;                       // no eligió nada: seguí bajando
    return ids.map((id) => act.find((w) => w.id === id)).filter(Boolean);
  };
  const d = clienteId ? destino(clienteId) : null;
  const propias = vivas(d && (uso === 'mens' ? d.wallet_mens : d.wallet_ggr));
  if (propias !== undefined) return propias;                 // eligió: vale, prendidas o ninguna
  const defs = vivas(cfg.getCfg(uso === 'mens' ? W_MENS : W_GGR));
  if (defs !== undefined) return defs;
  return act.length === 1 ? [act[0]] : [];
}

/* La de siempre, para lo que necesita una sola. Un array vacío es truthy: acá se traduce a null,
   que es lo que el resto del sistema entiende por "no hay adónde pagar". */
function walletDe(clienteId, uso) { return walletsDe(clienteId, uso)[0] || null; }

/** Las elegidas que quedaron apagadas. La pantalla lo avisa: si no, no hay adónde pagar y no se ve. */
function walletsApagadasEnUso() {
  const todas = wallets();
  const off = new Set(todas.filter((w) => !w.activa).map((w) => w.id));
  const nombre = (id) => (todas.find((w) => w.id === id) || {}).alias || id;
  const out = [];
  for (const [v, quien] of [[cfg.getCfg(W_GGR), 'el servicio del mes'], [cfg.getCfg(W_MENS), 'el mantenimiento']]) {
    for (const k of partirWallets(v)) if (off.has(k)) out.push({ wallet: nombre(k), donde: quien });
  }
  for (const f of db.prepare('SELECT * FROM chat_cliente').all()) {
    for (const [v, quien] of [[f.wallet_ggr, 'el mes'], [f.wallet_mens, 'el mantenimiento']]) {
      for (const k of partirWallets(v)) if (off.has(k)) out.push({ wallet: nombre(k), donde: `${quien} de un cliente` });
    }
  }
  return out;
}

/** Lo que va en la hoja y en el portal: la del mes, la del mantenimiento y la aclaración. */
function comoPagar(clienteId) {
  const ggr = walletsDe(clienteId, 'ggr');
  const mens = walletsDe(clienteId, 'mens');
  const firma = (l) => l.map((w) => w.id).join('|');
  /* "Misma" es que las dos cosas se paguen exactamente a las mismas: ahí va un bloque solo, porque
     repetir la misma dirección dos veces invita a mirar cuál es cuál. */
  const misma = !!ggr.length && firma(ggr) === firma(mens);
  const proy = (l) => l.map((w) => ({ alias: w.alias, red: w.red, direccion: w.direccion }));
  return { nota: config().pago_nota, misma, ggr: proy(ggr), mens: proy(mens) };
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
  return { ...f, grupos: partirGrupos(f.tg_grupo),
    wallets_ggr: partirWallets(f.wallet_ggr), wallets_mens: partirWallets(f.wallet_mens) };
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
  if (vino('clave_portal')) {
    const c = String(d.clave_portal || '').trim().slice(0, 40);
    if (c && c.length < 4) return { ok: false, error: 'la clave tiene que tener al menos 4 caracteres' };
    db.prepare(`INSERT INTO chat_cliente (cliente_id,clave_portal,createdAt) VALUES (?,?,?)
      ON CONFLICT(cliente_id) DO UPDATE SET clave_portal=excluded.clave_portal`)
      .run(id, c || null, nowISO());
  }
  const wsel = {};
  for (const k of ['wallet_ggr', 'wallet_mens']) {
    if (!vino(k)) continue;
    // Mismo criterio que en setConfig: si una de la lista no existe, no se guarda ninguna.
    const ids = partirWallets(d[k]);
    for (const id of ids) {
      if (!db.prepare('SELECT id FROM chat_wallet WHERE id=?').get(id)) {
        return { ok: false, error: 'esa wallet no existe' };
      }
    }
    // Lista vacía sigue guardando null, que es lo que el sistema lee como "la de siempre".
    wsel[k] = juntarWallets(ids) || null;
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
    out[f.cliente_id] = { ...f, grupos: partirGrupos(f.tg_grupo),
      wallets_ggr: partirWallets(f.wallet_ggr), wallets_mens: partirWallets(f.wallet_mens) };
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
    sinSala: ci.sinSala || [],
  };
}

/* ── LA CUENTA DEL CHAT ──────────────────────────────────────────────────────────────────────
   Aparte de la cuenta de las fichas, a propósito: ver el comentario de la tabla `chat_mov`.
   Cobrar un mes CONGELA el número. Después de eso el cliente puede pagar y el saldo se mueve, pero
   lo cobrado no cambia aunque cambie un tipo de cambio — es lo que le mandaste. */
/* DE QUÉ CUENTA ES ESTE PANEL. La guardada manda; si no hay, la que dicen sus datos de este mes;
   y si el mes trajo dos monedas, se toma la de más ganancia — el mantenimiento no se puede partir
   y repartirlo sería inventar una proporción. Sin nada, cadena vacía: el cliente de una sola
   moneda sigue teniendo UNA cuenta, como siempre. */
function _divisaDelPanel(p) {
  const puesta = String((p && p.divisa) || '').trim().toUpperCase();
  if (puesta) return puesta;
  const det = ((p && p.detalle) || []).filter((x) => Number(x.profit) > 0);
  if (!det.length) return '';
  const mayor = det.slice().sort((a2, b2) => Number(b2.profit || 0) - Number(a2.profit || 0))[0];
  return String((mayor && mayor.moneda) || '').toUpperCase();
}

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
  const ins = db.prepare(`INSERT INTO chat_mov (id,cliente_id,mes,tipo,monto,moneda,fecha,nota,createdAt,divisa)
    VALUES (?,?,?,'cobro',?,'USDT',?,?,?,?)`);
  /* LA FECHA ES EL ÚLTIMO DÍA DEL MES COBRADO, no el día que apretaste el botón ni un 28 inventado.
     El % se calcula con el mes cerrado, así que el 28 decía que se cobró tres días antes de que se
     pudiera calcular. El cierre de agosto es el 31 de agosto. */
  const largoM = new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0)).getUTCDate();
  const fechaCierre = `${m}-${largoM}`;
  const tx = db.transaction(() => {
    for (const g of pc.clientes || []) {
      /* Una caja sin cliente asignado no se le puede cobrar a nadie — pero al proveedor SÍ se le
         paga por ella. Saltearla en silencio era regalar ese mes. Se nombra. */
      if (!g.cliente_id) { sinCliente.push(g.cliente || '(sin cliente)'); continue; }
      if (!money.isPos(g.cobra)) { enCero.push(g.cliente); continue; }
      /* ── UN COBRO POR DIVISA, NO UNO POR CLIENTE ────────────────────────────────────────────
         Un cliente puede tener cajas en dos monedas, y a veces son dos negocios con socios
         distintos: los quiere separados, y a veces va a pagar cada uno en su moneda.

         ⚠️ EL TOTAL SE SUMA PANEL POR PANEL, no se recalcula como el % de la ganancia junta.
         `cobra` se redondea en cada panel, así que las cajas PYG de Ariel dan 292,10 sumando y
         292,09 haciendo el 4% de 7.302,35. Un centavo, y la cuenta del cliente deja de cerrar
         contra el detalle que tiene delante. */
      const porDiv = new Map();
      for (const p of g.paneles || []) {
        const dv = _divisaDelPanel(p);
        if (!porDiv.has(dv)) porDiv.set(dv, { monto: '0', sinPrecio: false });
        const x = porDiv.get(dv);
        x.monto = money.add(x.monto, p.cobra || '0');
        x.sinPrecio = x.sinPrecio || !!p.sinPrecio;
      }
      for (const [dv, x] of porDiv) {
        if (!money.isPos(x.monto)) continue;
        const ya = db.prepare(`SELECT id FROM chat_mov
          WHERE cliente_id=? AND mes=? AND tipo='cobro' AND divisa=?`).get(g.cliente_id, m, dv);
        if (ya) { yaEstaban.push(`${g.cliente}${dv ? ' (' + dv + ')' : ''}`); continue; }
        const id = 'chm_' + require('crypto').randomBytes(6).toString('hex');
        ins.run(id, g.cliente_id, m, x.monto, fechaCierre,
          x.sinPrecio ? 'precio sin confirmar (se cobró el mínimo)' : '', nowISO(), dv);
        creados.push({ cliente: g.cliente, cliente_id: g.cliente_id, monto: x.monto, divisa: dv });
      }
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
function descobrar(mes, clienteId = null, divisa = null) {
  const m = String(mes || '').slice(0, 7);
  const cid = clienteId ? String(clienteId) : null;
  /* Con divisa se deshace SÓLO esa cuenta: un cliente con cajas en dos monedas tiene dos cobros
     del mismo mes, y arreglar el de pesos no puede borrarle el de guaraníes. */
  const dv = divisa == null ? null : String(divisa).toUpperCase();
  let r;
  if (cid && dv != null) {
    r = db.prepare("DELETE FROM chat_mov WHERE mes=? AND tipo='cobro' AND cliente_id=? AND divisa=?").run(m, cid, dv);
  } else if (cid) {
    r = db.prepare("DELETE FROM chat_mov WHERE mes=? AND tipo='cobro' AND cliente_id=?").run(m, cid);
  } else {
    r = db.prepare("DELETE FROM chat_mov WHERE mes=? AND tipo='cobro'").run(m);
  }
  return { ok: true, mes: m, cliente_id: cid, divisa: dv, borrados: r.changes };
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
  /* De qué cuenta son estos 150. Sale de la caja: es lo único que los ata a una moneda, porque el
     mantenimiento en sí se cobra en USDT vaya donde vaya. Sin caja identificable queda sin cuenta,
     que es lo mismo que un cliente de una sola moneda. */
  const divMens = String((list().find((x) => x.cliente_id === id
    && x.panel === String(d.panel || '')) || {}).divisa || '').toUpperCase();
  db.prepare(`INSERT INTO chat_mov (id,cliente_id,mes,tipo,monto,moneda,fecha,nota,createdAt,panel,divisa)
    VALUES (?,?,?,'mensualidad',?,?,?,?,?,?,?)`).run(mid, id, fecha.slice(0, 7),
    money.round(monto, 2), c.mensualidad_moneda || 'USDT', fecha, nota, nowISO(),
    String(d.panel || '') || null, divMens);
  return { ok: true, mov: db.prepare('SELECT * FROM chat_mov WHERE id=?').get(mid) };
}

/**
 * DEVENGA SOLAS LAS MENSUALIDADES QUE YA EMPEZARON.
 *
 * El mantenimiento se paga POR TENER el servicio, no por usarlo: apenas arranca el período, ya es
 * plata que el cliente debe. Antes había que apretar "+ cobrar" a mano y hasta que alguien lo
 * hiciera el cliente entraba a su portal y veía "estás al día" debiendo un mes — y el día que se
 * apretaran tres juntas, le aparecían tres de golpe sin entender de dónde salieron.
 *
 * Recorre, para cada caja activa con fecha de inicio, todos los períodos que ya empezaron y crea
 * los que falten. Es idempotente: la llave (cliente, caja, fecha) impide repetir, así que se puede
 * llamar todas las veces que haga falta —al abrir la pantalla, al abrir el portal, o de noche— y
 * siempre deja lo mismo. No cobra hacia atrás de la fecha de inicio ni hacia adelante de hoy.
 */
function devengarMensualidades(hasta) {
  const tope = String(hasta || '').slice(0, 10) || hoy();
  const c = config();
  if (!money.esNumero(String(c.mensualidad || '')) || !money.isPos(String(c.mensualidad || ''))) {
    return { ok: true, creadas: 0, motivo: 'no hay mensualidad cargada' };
  }
  let creadas = 0;
  for (const p of list()) {
    if (!p.activo || !p.cliente_id || !p.desde) continue;
    const desde = String(p.desde).slice(0, 10);
    if (desde > tope) continue;
    /* EL PRIMERO ES EL DÍA DEL ALTA, siempre: el mantenimiento se cobra POR ADELANTADO el día que
       arranca. Después sigue por el día que tenga puesto. Cuando los dos coinciden —que es lo
       normal— esto es una sola serie; cuando no, el cliente igual paga desde el día uno en vez de
       esperar hasta el mes que viene. */
    const [y0, m0] = desde.split('-').map(Number);
    const dia = Math.min(28, Number(p.dia_cobro) || Number(desde.slice(8, 10)));
    const fechas = [desde];
    for (let k = 0; k < 400; k++) {
      const base = new Date(Date.UTC(y0, (m0 - 1) + k, 1));
      const largo = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + 1, 0)).getUTCDate();
      const f = `${base.getUTCFullYear()}-${String(base.getUTCMonth() + 1).padStart(2, '0')}-${String(Math.min(dia, largo)).padStart(2, '0')}`;
      if (f > tope) break;
      if (f <= desde) continue;              // el del mes del alta ya está en la lista
      fechas.push(f);
    }
    for (const f of fechas) {
      if (f > tope) continue;
      const r = cobrarMensualidad({ cliente_id: p.cliente_id, panel: p.panel, fecha: f });
      if (r.ok) creadas += 1;                // si ya estaba, devuelve error y no se toca nada
    }
  }
  return { ok: true, creadas };
}

/** Registra lo que te pagó un cliente por el chat. Otra wallet, otra cuenta. */
/* La única cuenta de un cliente, cuando tiene una sola. Vacío si tiene dos —ahí se elige, no se
   adivina, y el portal se lo pregunta— o si no tiene ninguna caja con divisa. */
function _cuentaUnicaDe(clienteId) {
  try {
    const ds = [...new Set(list().filter((p) => p.cliente_id === String(clienteId) && p.activo)
      .map((p) => String(p.divisa || '').toUpperCase()).filter(Boolean))];
    return ds.length === 1 ? ds[0] : '';
  } catch (e) { return ''; }
}

/* EL MES MÁS VIEJO QUE TODAVÍA DEBE ALGO de ese concepto. Es contra lo que la cascada va a imputar
   el pago, así que archivarlo ahí es decir la verdad. Sin deuda —un pago a cuenta— cae en el mes de
   hoy, que es lo único cierto. */
function _mesQueSePaga(clienteId, concepto, divisa) {
  try {
    const dv = String(divisa || '').toUpperCase();
    const conc = normConcepto(concepto);
    const tipos = conc === 'mantenimiento' ? ['mensualidad'] : (conc === 'ganancia' ? ['cobro'] : ['mensualidad', 'cobro']);
    const movs = db.prepare('SELECT * FROM chat_mov WHERE cliente_id=?').all(String(clienteId || ''))
      .filter((x) => !dv || String(x.divisa || '').toUpperCase() === dv);
    const cobrado = {}; let pagado = '0';
    for (const x of movs) {
      if (x.tipo === 'pago') {
        if (!conc || !x.concepto || x.concepto === conc) pagado = money.add(pagado, x.monto || '0');
      } else if (tipos.includes(x.tipo)) {
        cobrado[x.mes] = money.add(cobrado[x.mes] || '0', x.monto || '0');
      }
    }
    let resto = pagado;
    for (const mes of Object.keys(cobrado).sort()) {
      if (money.cmp(resto, cobrado[mes]) >= 0) { resto = money.sub(resto, cobrado[mes]); continue; }
      return mes;                                    // acá se corta: es el mes que todavía debe
    }
  } catch (e) { /* sin datos: cae al de hoy */ }
  return hoy().slice(0, 7);
}

function pagarCliente(d) {
  const id = String(d.cliente_id || '').trim();
  if (!id) return { ok: false, error: 'falta el cliente' };
  /* ⚠️ EL MES DEL PAGO ES EL MES QUE SE ESTÁ PAGANDO, no el día que se apretó. Un pago del 1 de
     septiembre por la cuenta de agosto quedaba archivado en septiembre, y la pantalla de agosto lo
     mostraba en cero: la plata estaba y la deuda global bajaba, pero el mes que ella miraba decía
     que no había pagado nada. Si vino uno explícito, manda ése. */
  const m = String(d.mes || '').slice(0, 7) || _mesQueSePaga(id, d.concepto, d.divisa);
  if (!/^\d{4}-\d{2}$/.test(m)) return { ok: false, error: 'mes inválido (se espera YYYY-MM)' };
  const monto = String(d.monto == null ? '' : d.monto).trim();
  if (!money.esNumero(monto) || !money.isPos(monto)) {
    return { ok: false, error: 'el monto tiene que ser un número mayor que cero. Usá punto para los decimales: 246.93' };
  }
  const mid = 'chm_' + require('crypto').randomBytes(6).toString('hex');
  /* CONTRA QUÉ CUENTA. Un cliente con cajas en dos monedas tiene dos cuentas, y un pago tiene que
     decir de cuál es: sin eso, la plata del negocio en guaraníes le tapa deuda al de pesos. Vacío
     = el cliente tiene una sola, que es el caso de casi todos. */
  /* ⚠️ Y SI NO DICE DE CUÁL CUENTA ES Y TIENE UNA SOLA, SE LE PONE ESA. Un pago sin cuenta contra
     una deuda que sí la tiene deja la cuenta partida al medio: el total daba bien, pero el desglose
     mostraba la deuda entera de un lado y la plata en un renglón «sin cuenta» del otro. Le pasó a
     Fran — pagó 425 y su cuenta de pesos seguía diciendo que debía 657,07. */
  const divPago = String(d.divisa || '').trim().toUpperCase().slice(0, 8) || _cuentaUnicaDe(id);
  db.prepare(`INSERT INTO chat_mov (id,cliente_id,mes,tipo,monto,moneda,fecha,nota,createdAt,divisa)
    VALUES (?,?,?,'pago',?,?,?,?,?,?)`).run(mid, id, m, money.round(monto, 2),
    String(d.moneda || 'USDT').toUpperCase().slice(0, 8),
    String(d.fecha || '').slice(0, 10) || hoy(), String(d.nota || ''), nowISO(), divPago);
  // A qué se imputa. Los que ella carga a mano no lo dicen y quedan en null: ver saldoPorConcepto.
  const conc = normConcepto(d.concepto);
  if (conc) db.prepare('UPDATE chat_mov SET concepto=? WHERE id=?').run(conc, mid);
  // Qué cajas cubre. Sólo tiene sentido con el mantenimiento; en el % del mes no hay cajas que elegir.
  const cjs = conc === 'mantenimiento' ? juntarWallets(d.cajas) : '';
  if (cjs) db.prepare('UPDATE chat_mov SET cajas=? WHERE id=?').run(cjs, mid);
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
        cobrado: '0', pagado: '0', ajustado: '0', debe: '0', movs: [], porDivisa: [],
      });
    }
    const g = por.get(f.cliente_id);
    g.movs.push(f);
    /* Tres lados, no dos:
       · `cobrado`  — lo que se le facturó (el % y las mensualidades)
       · `pagado`   — la plata que efectivamente entró
       · `ajustado` — lo que se dio por saldado sin que entrara plata (la diferencia de cambio).
       Meter el ajuste adentro de `pagado` diría que recibiste 160 cuando recibiste 155. Baja la
       deuda igual, pero se cuenta aparte. */
    if (f.tipo === 'pago') g.pagado = money.add(g.pagado, f.monto || '0');
    else if (f.tipo === 'ajuste') g.ajustado = money.add(g.ajustado || '0', f.monto || '0');
    else g.cobrado = money.add(g.cobrado, f.monto || '0');
    /* ── Y LA MISMA CUENTA, PARTIDA POR DIVISA ────────────────────────────────────────────────
       Se AGREGA adentro en vez de cambiarle la forma a `cuentas`. El total del cliente sigue
       siendo el total —lo lee la pantalla de ella, el portal, la hoja y media docena de checks— y
       el que quiera las dos cuentas las tiene acá al lado. Un cliente de una sola moneda trae un
       solo renglón, así que no hay dos caminos que mantener. */
    const dv = String(f.divisa || '').toUpperCase();
    let d = g.porDivisa.find((x) => x.divisa === dv);
    if (!d) { d = { divisa: dv, cobrado: '0', pagado: '0', ajustado: '0', debe: '0' }; g.porDivisa.push(d); }
    if (f.tipo === 'pago') d.pagado = money.add(d.pagado, f.monto || '0');
    else if (f.tipo === 'ajuste') d.ajustado = money.add(d.ajustado || '0', f.monto || '0');
    else d.cobrado = money.add(d.cobrado, f.monto || '0');
  }
  const out = [...por.values()];
  out.forEach((g) => {
    g.ajustado = money.round(g.ajustado || '0', 2);
    g.debe = money.round(money.sub(money.sub(g.cobrado, g.pagado), g.ajustado), 2);
    g.porDivisa.forEach((d) => {
      d.cobrado = money.round(d.cobrado, 2); d.pagado = money.round(d.pagado, 2);
      d.ajustado = money.round(d.ajustado || '0', 2);
      d.debe = money.round(money.sub(money.sub(d.cobrado, d.pagado), d.ajustado), 2);
    });
    g.porDivisa.sort((a, b) => money.cmp(b.debe, a.debe));
    /* La señal de que este cliente TIENE dos cuentas. Una sola divisa —o ninguna, que es lo de
       antes de la división— no es «dos cuentas»: es la de siempre, y la pantalla no tiene que
       dibujar una separación que no existe. */
    g.variasDivisas = g.porDivisa.filter((d) => d.divisa).length > 1;
  });
  out.sort((a, b) => money.cmp(b.debe, a.debe));
  return {
    mes: m || null, clientes: out,
    totales: {
      cobrado: money.round(money.sum(out.map((g) => g.cobrado)), 2),
      pagado: money.round(money.sum(out.map((g) => g.pagado)), 2),
      ajustado: money.round(money.sum(out.map((g) => g.ajustado || '0')), 2),
      debe: money.round(money.sum(out.map((g) => g.debe)), 2),
    },
  };
}

/**
 * EL SALDO DE UN CLIENTE, PARTIDO EN LAS DOS COSAS QUE SE LE COBRAN.
 *
 * Para qué: cuando avisa un pago hay que preguntarle DE QUÉ es, y para que la pregunta se pueda
 * contestar tiene que ver cuánto debe de cada una al lado. Hasta ahora veía un total solo y el que
 * tenía que adivinar de dónde salía era el que recibía la transferencia.
 *
 * Arrastra TODOS los meses, como `cuentas(null)`: alguien puede deber tres y mirando uno solo no se
 * entera. El `mes` que se pasa es sólo para las dos señales de abajo.
 *
 * ⚠️ LOS PAGOS VIEJOS NO DICEN DE QUÉ ERAN — la columna es nueva y los que ella carga a mano
 * tampoco la llenan. Si quedaran afuera, mantenimiento + servicio no daría el total y el cliente
 * vería tres números que no cierran, que es peor que no partirlo. Se reparten EN CASCADA: primero
 * tapan lo que falta del mantenimiento, y lo que sobra va al servicio del mes. Así los dos números
 * siempre suman el total, y el que sobra cae del lado que puede quedar a favor.
 *
 * Y las dos señales del servicio del mes, que NO son lo mismo:
 *   · `generado` — este cliente ya tiene cobrado ese mes.
 *   · `corrida`  — el mes se cobró para alguien. Sin esto no se puede distinguir "todavía no lo
 *                  generaste" de "lo generaste y a este cliente le dio cero", y decirle lo primero
 *                  cuando es lo segundo es mentirle.
 */
function saldoPorConcepto(clienteId, mes, divisa = null) {
  const id = String(clienteId || '');
  const m = String(mes || '').slice(0, 7);
  /* Con divisa, la cuenta de ESA moneda y nada más: los dos negocios del cliente son dos, a veces
     con socios distintos, y la cascada de un pago sin concepto no puede saltar de uno al otro.
     Sin divisa, todo junto — que es lo que ve la pantalla de ella y el total del portal. */
  const dv = divisa == null ? null : String(divisa).toUpperCase();
  const movs = db.prepare('SELECT * FROM chat_mov WHERE cliente_id=?').all(id)
    .filter((x) => dv == null || String(x.divisa || '').toUpperCase() === dv);

  const suma = (f) => money.round(money.sum(movs.filter(f).map((x) => x.monto || '0')), 2);
  const cobradoM = suma((x) => x.tipo === 'mensualidad');
  const cobradoG = suma((x) => x.tipo === 'cobro');
  const pagadoM = suma((x) => x.tipo === 'pago' && x.concepto === 'mantenimiento');
  const pagadoG = suma((x) => x.tipo === 'pago' && x.concepto === 'ganancia');
  const suelto = suma((x) => x.tipo === 'pago' && !x.concepto);
  /* Lo saldado sin plata: la diferencia de cambio. Salda igual que un pago pero NO es plata que
     entró, así que viaja en su propia columna — si se sumara a `pagado`, la cuenta diría que
     recibiste 160 cuando recibiste 155. */
  const ajusM = suma((x) => x.tipo === 'ajuste' && x.concepto === 'mantenimiento');
  const ajusG = suma((x) => x.tipo === 'ajuste' && x.concepto === 'ganancia');
  const ajusSuelto = suma((x) => x.tipo === 'ajuste' && !x.concepto);

  // La cascada. Nunca deja el mantenimiento en negativo: lo que sobra pasa entero al mes.
  const faltaM = money.sub(cobradoM, pagadoM);
  const aM = money.isPos(faltaM) ? (money.cmp(suelto, faltaM) > 0 ? faltaM : suelto) : '0';
  const aG = money.sub(suelto, aM);

  const parte = (cobrado, pagado, ajustado) => ({
    cobrado, pagado: money.round(pagado, 2), ajustado: money.round(ajustado, 2),
    debe: money.round(money.sub(money.sub(cobrado, pagado), ajustado), 2),
  });
  /* Los ajustes sin concepto tapan primero el mantenimiento, igual que los pagos sin concepto. */
  const faltaMa = money.sub(money.sub(cobradoM, pagadoM), ajusM);
  const bM = money.isPos(faltaMa) ? (money.cmp(ajusSuelto, faltaMa) > 0 ? faltaMa : ajusSuelto) : '0';
  const bG = money.sub(ajusSuelto, bM);
  const mant = parte(cobradoM, money.add(pagadoM, aM), money.add(ajusM, bM));
  const gan = parte(cobradoG, money.add(pagadoG, aG), money.add(ajusG, bG));

  const generado = m ? !!(dv == null
    ? db.prepare("SELECT id FROM chat_mov WHERE cliente_id=? AND mes=? AND tipo='cobro'").get(id, m)
    : db.prepare("SELECT id FROM chat_mov WHERE cliente_id=? AND mes=? AND tipo='cobro' AND divisa=?").get(id, m, dv)) : false;
  const corrida = m ? db.prepare("SELECT COUNT(*) n FROM chat_mov WHERE mes=? AND tipo='cobro'").get(m).n > 0 : false;

  return {
    mes: m || null, divisa: dv,
    mantenimiento: mant,
    ganancia: { ...gan, generado, corrida },
    total: {
      cobrado: money.round(money.add(cobradoM, cobradoG), 2),
      pagado: money.round(money.add(mant.pagado, gan.pagado), 2),
      ajustado: money.round(money.add(mant.ajustado, gan.ajustado), 2),
      debe: money.round(money.add(mant.debe, gan.debe), 2),
    },
  };
}

/**
 * EL MANTENIMIENTO, CAJA POR CAJA.
 *
 * Un cliente con cuatro cajas no paga cuatro veces 150: paga una vez y elige cuáles cubre. Para
 * que eso se pueda contestar, cada mensualidad ya viene con su caja (`chat_mov.panel`) y ahora
 * cada pago dice a cuáles va (`chat_mov.cajas`).
 *
 * El reparto es una cascada con dos niveles, y el orden importa:
 *   1. Un pago que NOMBRA cajas tapa esas y nada más, en el orden en que las nombró.
 *   2. Lo que sobre —y los pagos que no nombran ninguna, que son todos los viejos— cae sobre las
 *      que sigan debiendo, de la más vieja a la más nueva.
 * Así la suma por caja siempre da el total del cliente, y un pago viejo no desaparece.
 */
function mantenimientoPorCaja(clienteId, divisa = null) {
  const id = String(clienteId || '');
  /* Con divisa, sólo las cajas de esa cuenta. La cascada del sobrante recorre las cajas de a una:
     sin este filtro, un pago del negocio en guaraníes taparía una caja del de pesos. */
  const dv = divisa == null ? null : String(divisa).toUpperCase();
  const movs = db.prepare('SELECT * FROM chat_mov WHERE cliente_id=? ORDER BY fecha, createdAt').all(id)
    .filter((x) => dv == null || String(x.divisa || '').toUpperCase() === dv);

  // Lo cobrado, por caja. Una caja sin nombre cae en un cajón aparte para no perderla.
  const cajas = new Map();
  for (const m of movs.filter((x) => x.tipo === 'mensualidad')) {
    const k = String(m.panel || '(sin caja)');
    const c = cajas.get(k) || { panel: k, cobrado: '0', pagado: '0', desde: m.fecha };
    c.cobrado = money.add(c.cobrado, m.monto || '0');
    cajas.set(k, c);
  }
  if (!cajas.size) return [];

  const falta = (c) => money.sub(c.cobrado, c.pagado);
  const aplicar = (c, cuanto) => {
    const f = falta(c);
    if (!money.isPos(f) || !money.isPos(cuanto)) return '0';
    const usa = money.cmp(cuanto, f) > 0 ? f : cuanto;
    c.pagado = money.add(c.pagado, usa);
    return usa;
  };

  /* El ajuste salda una caja igual que un pago: la diferencia de cambio de esa transferencia es
     de esa caja. Si no entrara acá, la caja quedaría debiendo cinco pesos para siempre. */
  const pagos = movs.filter((x) => (x.tipo === 'pago' || x.tipo === 'ajuste') && x.concepto === 'mantenimiento');
  let sobra = '0';
  for (const p of pagos) {
    let resto = String(p.monto || '0');
    for (const nom of partirWallets(p.cajas)) {          // el mismo partidor de listas
      const c = cajas.get(nom);
      if (c) resto = money.sub(resto, aplicar(c, resto));
    }
    sobra = money.add(sobra, resto);
  }
  /* Los pagos sin concepto tapan primero el mantenimiento —igual que en saldoPorConcepto— así que
     lo que ahí se imputó al mantenimiento también tiene que llegar acá, o los dos números no
     coinciden y el cliente ve dos cuentas distintas de lo mismo. */
  const sc = saldoPorConcepto(id, null);
  const yaImputado = money.round(money.sum(pagos.map((x) => x.monto || '0')), 2);
  sobra = money.add(sobra, money.sub(sc.mantenimiento.pagado, yaImputado));

  for (const c of cajas.values()) {
    if (!money.isPos(sobra)) break;
    sobra = money.sub(sobra, aplicar(c, sobra));
  }
  return [...cajas.values()].map((c) => ({
    panel: c.panel, desde: c.desde,
    cobrado: money.round(c.cobrado, 2), pagado: money.round(c.pagado, 2),
    debe: money.round(money.sub(c.cobrado, c.pagado), 2),
  }));
}

/**
 * LAS OPCIONES DEL "¿DE QUÉ ES ESTE PAGO?", YA ESCRITAS.
 *
 * El texto se arma ACÁ y no en cada pantalla a propósito: la hoja (src/chat-doc.js) y el portal
 * (public/ganamos.html) son dos renderers gemelos del mismo formulario, y cada cosa que se escribe
 * dos veces termina diciendo dos cosas distintas. Además es lo que sale para afuera, y en este
 * sistema lo que sale para afuera lo compone el servidor con los datos de la base.
 *
 * Viene preseleccionado lo que MÁS DEBE: es lo que va a estar pagando nueve de cada diez veces, y
 * un desplegable que arranca vacío es un campo más para equivocarse.
 */
/* DE QUÉ MES ES LA DEUDA DEL %. Los cobros del % son uno por mes; los pagos no van contra un mes
   sino contra el concepto, así que no se puede decir cuál quedó pago y cuál no. Lo que sí se puede
   decir con certeza es de cuántos meses viene: si hay uno solo, se nombra; si hay varios, se avisa
   que son varios en vez de elegir uno y equivocarse. */
function _deQueMes(clienteId, divisa = null) {
  const dv = divisa == null ? null : String(divisa).toUpperCase();
  const ms = (dv == null
    ? db.prepare("SELECT DISTINCT mes FROM chat_mov WHERE cliente_id=? AND tipo='cobro' ORDER BY mes").all(String(clienteId || ''))
    : db.prepare("SELECT DISTINCT mes FROM chat_mov WHERE cliente_id=? AND tipo='cobro' AND divisa=? ORDER BY mes").all(String(clienteId || ''), dv))
    .map((r) => r.mes).filter(Boolean);
  if (!ms.length) return '';
  if (ms.length === 1) return ` de ${mesEnLetras(ms[0])}`;
  return ' (de varios meses)';
}

function opcionesDeConcepto(clienteId, mes, divisa = null) {
  const sc = saldoPorConcepto(clienteId, mes, divisa);
  const plata = (x) => `${money.round(x, 2).replace('-', '')}`;
  const fmt = (v) => Number(v || 0).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const comoEsta = (p) => {
    if (money.isPos(p.debe)) return `debés ${fmt(p.debe)} USDT`;
    if (money.isNeg(p.debe)) return `tenés ${fmt(plata(p.debe))} USDT a favor`;
    return 'estás al día';
  };
  /* El servicio del mes tiene un estado más que el mantenimiento: puede no existir todavía. Y "no
     lo generaste" no es lo mismo que "lo generaste y te dio cero" — decir lo primero cuando es lo
     segundo es mentirle a alguien que va a mirar su cuenta el mes que viene. */
  const estadoGan = () => {
    if (money.isPos(sc.ganancia.debe) || money.isNeg(sc.ganancia.debe)) return comoEsta(sc.ganancia);
    if (!sc.ganancia.generado) {
      return sc.ganancia.corrida ? 'este mes no te cobramos nada' : 'todavía no está';
    }
    return 'estás al día';
  };
  const opciones = [
    { valor: 'mantenimiento', nombre: 'Mantenimiento', estado: comoEsta(sc.mantenimiento),
      debe: sc.mantenimiento.debe },
    /* «Servicio del mes» no dice qué es: es el % sobre lo que ganó, y es DE UN MES CONCRETO.
       ⚠️ PERO EL MES NO ES EL DE HOY. `sc.debe` es lo que arrastra de TODOS los meses, y `sc.mes`
       es sólo el mes que se está mirando: poniendo ése, el 2 de septiembre el rótulo decía
       «% sobre las ganancias de septiembre — debés 357,07» cuando esos 357,07 son de agosto, de un
       mes que encima todavía no está calculado. Se nombra el mes del que viene la deuda, y si
       viene de varios no se nombra ninguno: se dice que son varios. */
    { valor: 'ganancia', nombre: `% sobre las ganancias${_deQueMes(clienteId, divisa)}`,
      estado: estadoGan(), debe: sc.ganancia.debe },
  ];
  opciones.forEach((o) => { o.rotulo = `${o.nombre} — ${o.estado}`; });
  // El que más debe va marcado. Si ninguno debe nada, el mantenimiento, que es el que se repite.
  const mayor = money.cmp(sc.ganancia.debe, sc.mantenimiento.debe) > 0 ? 'ganancia' : 'mantenimiento';
  opciones.forEach((o) => { o.sugerida = o.valor === mayor; });

  /* Las cajas que todavía deben mantenimiento, para que pueda elegir cuáles cubre. Uno con cuatro
     cajas paga una vez y dice cuáles: sin esto, un pago de 300 sobre cuatro de 150 no deja saber
     cuáles dos quedaron al día. Sólo van las que deben algo. */
  const cajasMant = mantenimientoPorCaja(clienteId, divisa).filter((c) => money.isPos(c.debe))
    .map((c) => ({ panel: c.panel, debe: c.debe, texto: `${c.panel} — ${fmt(c.debe)} USDT` }));

  return {
    titulo: '¿De qué es este pago?',
    opciones,
    cajasMant,
    tituloCajas: cajasMant.length > 1 ? '¿De qué cajas?' : '',
    /* Sólo cuando el mes todavía no se generó: si no se explica, "todavía no está" se lee como un
       error de la página y la respuesta llega por privado. */
    aclaracion: (!sc.ganancia.generado && !sc.ganancia.corrida && sc.mes)
      ? `Lo de ${mesEnLetras(sc.mes)} todavía no está: se calcula con el mes cerrado y te lo pasamos `
        + 'a principio del mes que viene. Si querés dejar algo a cuenta, poné cuánto.'
      : '',
    saldo: sc,
    divisa: divisa == null ? null : String(divisa).toUpperCase(),
  };
}

/**
 * LAS CUENTAS QUE ESTÁN COBRADAS Y TODAVÍA NO SE MANDARON.
 *
 * Lo usa el recordatorio diario. Ella cobra el mes (que CONGELA el número) y después le manda la
 * cuenta a cada uno apretando un botón por cliente: entre una cosa y la otra puede pasar una
 * semana, y hasta ahora nada se lo recordaba.
 *
 * ⚠️ NO ALCANZA CON MIRAR EL COBRO DEL MES. `cobrar()` saltea al cliente cuyo total da cero, así
 * que uno que sólo paga mantenimiento NUNCA tiene una fila tipo='cobro' — y sin embargo le debe
 * plata y su cuenta se le manda igual. Filtrando por 'cobro' esos clientes quedaban callados para
 * siempre: la cuenta lista, la plata sin cobrar, y ni un aviso. Van los dos tipos.
 *
 * @param dias  hasta cuántos días para atrás se sigue insistiendo (default 15). Pasado eso se
 *              entiende que no lo mandó a propósito y se deja de molestar.
 */
function listasParaMandar(dias = 15) {
  const corte = new Date(Date.now() - Number(dias) * 864e5).toISOString();
  /* ⚠️ AGRUPADO TAMBIÉN POR DIVISA. Un cliente con cajas en dos monedas tiene dos cuentas del
     mismo mes: agrupando sólo por (cliente, mes), mandar UNA daba las dos por mandadas y el
     recordatorio dejaba de insistir por la que faltaba. */
  const filas = db.prepare(`SELECT cliente_id, mes, divisa, MAX(createdAt) AS ultimo
    FROM chat_mov WHERE tipo IN ('cobro','mensualidad') GROUP BY cliente_id, mes, divisa`).all();
  const yaFue = new Set(db.prepare('SELECT cliente_id, mes FROM chat_envio WHERE ok=1').all()
    .map((e) => `${e.cliente_id}|${e.mes}`));
  const fallo = new Map(db.prepare('SELECT cliente_id, mes, error FROM chat_envio WHERE ok=0').all()
    .map((e) => [`${e.cliente_id}|${e.mes}`, e.error]));
  const cli = new Map(clientes.list().clientes.map((c) => [c.id, c]));

  /* ⚠️ TENER MENSUALIDADES NO ES TENER EL MES COBRADO. El mantenimiento se devenga solo; el % del
     mes lo congela ella apretando «Cobrar el mes». Mandar la cuenta antes de eso le manda al
     cliente un número que no es el que se le va a cobrar: la hoja lleva el % calculado en vivo y
     su cuenta sólo tiene el mantenimiento. Son dos pasos y este de acá es el PRIMERO — decirle
     «mandá» cuando lo que falta es «cobrá» la manda a hacer lo segundo sin lo primero. */
  /* ⚠️ LA SEÑAL ES POR MES, NO POR CLIENTE. `cobrar(mes)` es una acción de todo el mes, y saltea al
     cliente cuyo total da cero — el que sólo paga mantenimiento NUNCA va a tener una fila de cobro.
     Preguntando por cliente, ése quedaba trabado para siempre en «falta cobrar», y ella no podía
     destrabarlo cobrando porque cobrar lo saltea. Corrido el mes, el que no tiene cobro es el que
     dio cero, y su cuenta está tan lista como la de los demás. */
  const mesesCobrados = new Set(db.prepare("SELECT DISTINCT mes FROM chat_mov WHERE tipo='cobro'")
    .all().map((x) => String(x.mes)));

  const mandar = []; const sinGrupo = []; const faltaCobrar = [];
  for (const f of filas) {
    if (!f.cliente_id) continue;
    if (String(f.ultimo || '') < corte) continue;              // viejo: ya no se insiste
    // La misma clave con la que se guardó el envío: sin la divisa, un envío tapa al otro.
    const k = `${_claveEnvio(f.cliente_id, f.divisa)}|${f.mes}`;
    if (yaFue.has(k)) continue;
    const c = cli.get(f.cliente_id);
    const fila = { cliente_id: f.cliente_id, mes: f.mes, divisa: f.divisa || '',
      cliente: (c && (c.nombre || c.codigo)) || '(cliente borrado)',
      fallo: fallo.get(k) || null };
    if (!mesesCobrados.has(String(f.mes))) { faltaCobrar.push(fila); continue; }  // primero se cobra
    // Sin grupo cargado no hay adónde mandarla: es otro problema y se cuenta aparte.
    (destino(f.cliente_id).grupos.length ? mandar : sinGrupo).push(fila);
  }
  const ord = (a, b) => (a.mes === b.mes ? a.cliente.localeCompare(b.cliente) : (a.mes < b.mes ? -1 : 1));
  return { mandar: mandar.sort(ord), sinGrupo: sinGrupo.sort(ord), faltaCobrar: faltaCobrar.sort(ord) };
}

/* ── EL ACCESO DEL PROVEEDOR ─────────────────────────────────────────────────────────────────
   Usuario y contraseña, puestos por ella DESDE SU PANTALLA. Vivían en una variable del servidor y
   eso significaba salir del sistema para cambiarlos: la primera vez que quiso ponerlos, la
   pregunta fue "dónde". Si cambiar una contraseña es incómodo, no se cambia nunca.

   ⚠️ LA CONTRASEÑA NO SE GUARDA. Se guarda scrypt(clave, sal), con el mismo módulo que ya usan las
   cuentas de cliente. Ni ella la puede leer: si el proveedor la pierde, se le genera otra. Guardar
   una contraseña recuperable es guardar una contraseña que alguien puede leer. */
const acceso = require('./cliente-acceso');
const PROV_GRUPO = 'chatProvGrupo';
const PROV_USER = 'chatProvUsuario';
const PROV_HASH = 'chatProvClave';
const PROV_CORTE = 'chatProvCorte';

function proveedorAcceso() {
  const u = String(cfg.getCfg(PROV_USER) || '').trim();
  return { usuario: u, tieneClave: !!cfg.getCfg(PROV_HASH), activo: !!(u && cfg.getCfg(PROV_HASH)),
    grupo: String(cfg.getCfg(PROV_GRUPO) || '').trim() };
}

/** El grupo de Telegram del proveedor. Es OTRO que el de la matriz: acá lee él, no ella. */
function proveedorGrupo() { return String(cfg.getCfg(PROV_GRUPO) || '').trim(); }

/** Deja el usuario y/o la clave. Devuelve la clave SÓLO cuando se genera, y una sola vez. */
function setProveedorAcceso({ usuario, clave, generar, grupo } = {}) {
  if (grupo !== undefined) {
    /* Un chatId de Telegram es un número (los grupos son negativos) o un @nombre. Se avisa en vez
       de prohibir, igual que con los grupos de los clientes: puede pegarse un link y quererse
       arreglar después, pero mandar a un destino que no existe falla en silencio del lado de
       Telegram y el aviso no llega. */
    const g = String(grupo || '').trim().slice(0, 40);
    if (g && !/^-?\d+$/.test(g) && !/^@\w{3,}$/.test(g)) {
      return { ok: false, error: `"${g}" no parece un grupo de Telegram. Es un número (los grupos son negativos) o un @nombre.` };
    }
    cfg.setCfg(PROV_GRUPO, g);
  }
  if (usuario !== undefined) {
    const u = String(usuario || '').trim().slice(0, 60);
    if (u && u.length < 3) return { ok: false, error: 'el usuario tiene que tener al menos 3 caracteres' };
    cfg.setCfg(PROV_USER, u);
  }
  if (usuario !== undefined || clave !== undefined || generar) { /* nada extra */ }
  let generada = null;
  if (generar) { generada = acceso.generarClave(10); }
  const c = generada || (clave === undefined ? null : String(clave));
  if (c !== null) {
    if (!c) { cfg.setCfg(PROV_HASH, ''); return { ok: true, ...proveedorAcceso() }; }  // vacío = sin acceso
    /* Diez es el largo de las que genera el sistema; menos que eso a mano es una clave que se
       adivina, y ésta abre toda la liquidación del chat. */
    if (c.length < 8) return { ok: false, error: 'la contraseña tiene que tener al menos 8 caracteres' };
    cfg.setCfg(PROV_HASH, acceso.hashear(c));
    // Cambiar la clave corta las sesiones abiertas: si no, "se la cambié" no es verdad hasta que venza.
    cfg.setCfg(PROV_CORTE, nowISO());
  }
  return { ok: true, ...proveedorAcceso(), generada };
}

/** ¿Entra? Devuelve true sólo si el usuario y la clave son los guardados. */
function proveedorEntra(usuario, clave) {
  const u = String(cfg.getCfg(PROV_USER) || '').trim();
  const h = String(cfg.getCfg(PROV_HASH) || '');
  if (!u || !h) return false;
  // El usuario también en tiempo constante: el tiempo de fallar delata si acertó el usuario.
  const a = Buffer.from(String(usuario || ''));
  const b = Buffer.from(u);
  if (a.length !== b.length || !require('crypto').timingSafeEqual(a, b)) return false;
  return acceso.verificar(clave, h);
}

/** Desde cuándo no valen las sesiones viejas del proveedor. */
function proveedorCorte() { return String(cfg.getCfg(PROV_CORTE) || ''); }

/**
 * LO QUE VE EL PROVEEDOR DE UN MES. Su liquidación y nada más.
 *
 * ⚠️ ESTA FUNCIÓN ES UNA LISTA BLANCA, NO UN FILTRO. Se arma un objeto NUEVO campo por campo en vez
 * de copiar lo que devuelve `porCliente` y borrarle cosas: así una columna nueva del negocio nace
 * afuera de acá en vez de adentro, que es la diferencia entre olvidarse de sacar algo y tener que
 * acordarse de ponerlo.
 *
 * LO QUE NO PUEDE VER, y por qué:
 *  · `cobra` / `pct_cliente` — lo que ELLA le cobra al cliente. De la diferencia contra lo que él
 *    cobra sale el margen, que es el negocio entero.
 *  · `sinPrecio`, las notas de un cobro, y cualquier cosa de la cuenta del cliente con ella.
 *  · A qué plataforma pertenece cada caja (Casino/Europa): es control interno.
 *  · EL NOMBRE DEL CLIENTE. Él cobra por caja y cobra lo mismo por todas: de quién es cada una no
 *    cambia un solo número de su liquidación. Pero saber que estas tres son del mismo y aquella
 *    otra no le dice el tamaño de cada cuenta y quién es el que más pesa — y eso es la cartera de
 *    ella. Decisión de ella, textual: «ellos solo reciben la plata y ya».
 *    ⚠️ NO ALCANZA CON SACAR LA COLUMNA DE LA PANTALLA: viajaba en el JSON, y cualquiera que abra
 *    las herramientas del navegador lo lee igual. Se saca de acá, que es de donde sale el dato.
 * LO QUE SÍ, y por qué no molesta:
 *  · el profit de cada caja y lo que él cobra por ella: los dos números son suyos, ya los conoce.
 */
function paraElProveedor(mes) {
  const m = String(mes || '').slice(0, 7);
  const pc = porCliente(m);
  const cajas = [];
  for (const g of pc.clientes || []) {
    for (const p of g.paneles || []) {
      cajas.push({
        caja: p.panel,
        profit: p.profit_usdt,      // la ganancia de la caja, en USDT
        /* QUÉ TRAMO SE CONTÓ. Él cobra sobre esa ganancia: sin las fechas no puede comprobar el
           número contra nada, igual que el cliente. Y el primer mes cada caja arrancó un día
           distinto, así que ninguna cubre el mes entero. */
        tramo: p.tramo || null,
        cobra: undefined,           // ← NUNCA. Queda escrito para que se vea que es a propósito.
        paga: p.paga,               // lo que ÉL cobra por esa caja
        monedas: (p.detalle || []).filter((d) => Number(d.profit) > 0)
          .map((d) => ({ moneda: d.moneda, profit: String(d.profit), tc: d.tc || null, usdt: d.usdt })),
      });
    }
  }
  cajas.forEach((c) => delete c.cobra);
  /* Por lo que él cobra, de mayor a menor. Ordenar por cualquier cosa que venga del cliente
     —el nombre, el id— volvería a agrupar sus cajas en la pantalla y contaría lo mismo que se
     acaba de sacar. */
  cajas.sort((a, b) => money.cmp(b.paga, a.paga));

  /* El mantenimiento, caja por caja: es la pregunta que él hace todos los meses. Sale de las
     mensualidades de ESE mes, no del arrastre — le está preguntando por su liquidación. */
  const mens = db.prepare("SELECT panel, monto FROM chat_mov WHERE mes=? AND tipo='mensualidad'").all(m);
  const mantenimiento = mens.map((x) => ({
    caja: String(x.panel || '(sin caja)'),
    monto: x.monto,
  })).sort((a, b) => a.caja.localeCompare(b.caja));

  /* El total del mes por moneda. Es contra lo que él va a comparar el panel del casino: mirar
     seis renglones y sumarlos a mano es donde aparece la discusión que no existía. */
  const monedas = [];
  for (const c of cajas) {
    for (const x of c.monedas) {
      const y = monedas.find((z) => z.moneda === x.moneda);
      if (y) {
        y.profit = money.add(y.profit, x.profit);
        y.usdt = (y.usdt == null || x.usdt == null) ? null : money.add(y.usdt, x.usdt);
      } else monedas.push({ ...x });
    }
  }
  monedas.sort((a2, b2) => Number(b2.usdt || 0) - Number(a2.usdt || 0));

  const dp = deudaProveedor(m);
  /* ⚠️ ¿EL MES ESTÁ CERRADO O TODAVÍA SE MUEVE?
     El mantenimiento se devenga y queda firme desde el día que arranca cada caja. El % NO: hasta
     que ella aprieta «Cobrar el mes», el número se recalcula en vivo —el acumulado se sana todas
     las noches y un tipo de cambio nuevo lo mueve— así que mostrarlo como definitivo es dejar que
     alguien le saque una captura a una cifra que mañana es otra.
     La señal es la fila tipo='cobro': existe = se congeló. */
  const cobros = db.prepare("SELECT MIN(createdAt) AS cuando, COUNT(*) n FROM chat_mov WHERE mes=? AND tipo='cobro'").get(m);
  const cerrado = !!(cobros && cobros.n > 0);

  return {
    mes: m,
    /* Provisorio no es un adorno: cambia lo que el número significa. */
    cerrado,
    cerradoAt: cerrado ? String(cobros.cuando || '').slice(0, 10) : null,
    pct: pc.costo_pct,                 // SU porcentaje, que él ya conoce
    monedas,
    /* Si falta un tipo de cambio, lo ganado en esa moneda vale cero y el total queda CORTO. Se lo
       decimos: que descubra solo que le liquidaron de menos es peor que avisarle. */
    sinTC: pc.sinTC || [],
    cajas,
    /* ⚠️ LAS QUE NO SE PUDIERON CALCULAR VAN IGUAL. Se le paga mantenimiento por TODAS: si la
       tabla lista seis y el mantenimiento dice siete, el que lo lee cuenta y encuentra un número
       que no cierra, y dejarla afuera parece un error nuestro.
       No van en cero —una caja que no se pudo calcular no es una que no ganó nada— y el MOTIVO no
       viaja: «no figura con el usuario 7364108» es infraestructura de ella. Él necesita saber que
       falta, no por qué. */
    salteadas: (pc.salteados || []).map((x) => ({ caja: x.panel })),
    mantenimiento,
    /* Lo que se le debe y lo que se le pagó, abierto en las dos cosas. Los pagos van con dónde y
       cuándo: es literalmente lo que ella pidió que pudiera ver. */
    deuda: dp,
    pagos: pagos(m).map((x) => ({
      fecha: x.fecha, monto: x.monto, moneda: x.moneda,
      concepto: x.concepto || 'ganancia',
      destino: x.destino || '', red: x.red || '', hash: x.hash || '',
      nota: x.nota || '',
    })),
  };
}

/** Los meses que tienen algo, del más nuevo al más viejo. Para que pueda mirar hacia atrás. */
function mesesDelProveedor() {
  const a = db.prepare("SELECT DISTINCT mes FROM chat_mov WHERE tipo IN ('cobro','mensualidad')").all();
  const b = db.prepare('SELECT DISTINCT mes FROM chat_pago_proveedor').all();
  return [...new Set([...a, ...b].map((x) => String(x.mes || '').slice(0, 7)).filter((x) => /^\d{4}-\d{2}$/.test(x)))]
    .sort().reverse();
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
  /* ── Y POR EL LINK DE LA CAJA ────────────────────────────────────────────────────────────────
     Desde que el mensaje de Telegram nombra las cajas por su link —«ganamoscpy.com — 22 ago…»,
     que es como el cliente las reconoce—, ese link es lo único que tiene delante cuando llega acá.
     Si la puerta no lo acepta, el mensaje le muestra un nombre que la puerta rechaza.
     Se compara sin el https:// ni el www ni la barra final: nadie escribe eso a mano igual dos
     veces. Entran los dos links, el de los jugadores y el del panel. */
  const dom = (u) => String(u || '').trim().toLowerCase()
    .replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/+$/, '');
  const kDom = dom(k);
  if (kDom) {
    const porLink = conChat.filter((p) => [p.link_jugadores, p.link_panel].some((u) => u && dom(u) === kDom));
    // La misma regla que arriba: si el link estuviera en dos clientes, no entra ninguno.
    if (porLink.length && new Set(porLink.map((p) => p.cliente_id)).size === 1 && porLink[0].cliente_id) {
      return { cliente_id: porLink[0].cliente_id, cliente: porLink[0].cliente, por: 'caja' };
    }
  }
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
      // El usuario sí —solo no abre nada—; la contraseña NO viaja hasta que escriba la clave.
      usuario_admin: p.usuario_admin || '',
      tiene_clave: !!p.clave_admin,
    }));
  const c = clientes.list().clientes.find((x) => x.id === id) || {};
  return {
    cliente: c.nombre || c.codigo || '',
    saldo: todo ? { cobrado: todo.cobrado, pagado: todo.pagado, debe: todo.debe } : { cobrado: '0', pagado: '0', debe: '0' },
    // Los movimientos del chat, para que pueda comprobar el saldo en vez de creerlo.
    /* La nota de un cobro es INTERNA ("precio sin confirmar (se cobró el mínimo)"): decirle al
       cliente que su precio está sin decidir es abrirle una negociación que nadie pidió. La de la
       mensualidad sí es para él —lleva la caja y el período— y va tal cual. */
    movs: (todo ? todo.movs : []).slice(-30).map((m) => {
      /* LA CAJA SE NOMBRA POR SU LINK, igual que en la cuenta del mes y en el mensaje de Telegram.
         La nota guardada dice el nombre interno —«Mantenimiento F01Zeus»—, que se lo pusimos
         nosotros y el cliente nunca usó. Se rearma acá y no se toca lo guardado: así los
         movimientos viejos también salen bien. */
      const caja = m.tipo === 'mensualidad' ? _comoLaLlamaElCliente(m.panel) : '';
      const per = m.tipo === 'mensualidad' ? periodoDesde(m.fecha) : null;
      return {
        // El MES del renglón, no sólo la fecha en que se cobró: el % de agosto se cobra el 28 de
        // agosto pero también podría cobrarse el 3 de septiembre, y ahí la fecha engaña.
        fecha: m.fecha, mes: m.mes, tipo: m.tipo, monto: m.monto, moneda: m.moneda,
        caja, periodo: per ? per.texto : '',
        // El motivo del ajuste SÍ es para él: es la explicación de por qué su cuenta cerró en cero.
        motivo: m.tipo === 'ajuste' ? (m.motivo || '') : '',
        // La nota cruda queda de respaldo: si la caja ya no está, el renglón dice algo igual.
        nota: m.tipo === 'mensualidad' ? m.nota : '',
      };
    }),
    cajas,
    avisos: avisosDe(id).map((a) => ({ fecha: String(a.creado_at).slice(0, 10), monto: a.monto,
      moneda: a.moneda, estado: a.estado, concepto: a.concepto, divisa: a.divisa || '' })),
    solicitudes: db.prepare(`SELECT caja, nota, estado, creado_at, pagina, dominio, divisa, caja_nueva FROM chat_solicitud
      WHERE cliente_id=? ORDER BY creado_at DESC LIMIT 10`).all(id),
    pago: comoPagar(id),
    /* Lo que debe, partido en las dos cosas que se le cobran: es lo que hace contestable la
       pregunta "¿de qué es este pago?". Son sus propios números, no hay nada interno acá. */
    conceptos: opcionesDeConcepto(id, hoy().slice(0, 7)),
    /* ── Y SUS CUENTAS, UNA POR DIVISA ────────────────────────────────────────────────────────
       Un cliente con cajas en dos monedas tiene dos cuentas: a veces son dos negocios con socios
       distintos. Cada una trae su saldo Y sus opciones de "¿de qué es este pago?", porque el
       mantenimiento que debe de un lado no es el que debe del otro.

       El de una sola moneda trae UNA, y la pantalla no dibuja ninguna separación: no hay dos
       caminos que mantener, hay uno que a veces tiene dos renglones. */
    cuentasPorDivisa: (todo && todo.variasDivisas ? (todo.porDivisa || []).filter((d) => d.divisa) : [])
      .map((d) => ({
        divisa: d.divisa,
        saldo: { cobrado: d.cobrado, pagado: d.pagado, debe: d.debe },
        conceptos: opcionesDeConcepto(id, hoy().slice(0, 7), d.divisa),
        // Las cajas de ESA cuenta, por su link: es como el cliente las reconoce.
        cajas: list().filter((p) => p.cliente_id === id && p.activo
          && String(p.divisa || '').toUpperCase() === d.divisa)
          .map((p) => _comoLaLlamaElCliente(p.panel)).filter(Boolean),
      })),
    // Si no tiene clave puesta, el portal ni ofrece ver los accesos: le dice que te los pida.
    pide_clave: !!(destino(id).clave_portal),
    /* EL DESGLOSE DEL ÚLTIMO MES QUE SE LE COBRÓ. Hasta acá el portal mostraba un total en USDT y
       nada más: ni en qué moneda ganó, ni con qué tipo de cambio se convirtió, ni qué tramo del mes
       se le contó. Un número sin manera de comprobarlo. La hoja con token sí lo tenía; el portal
       era la mitad pobre de los dos, y desde que el mensaje de Telegram manda acá, era la única
       que el cliente iba a abrir. */
    desglose: desgloseParaElPortal(id),
  };
}

/**
 * EL DESGLOSE QUE VE EL CLIENTE EN SU PORTAL.
 *
 * Se muestra el ÚLTIMO MES QUE TIENE MOVIMIENTOS, que es el que se le acaba de mandar. Si mirara
 * siempre el mes en curso, el 2 de septiembre el cliente entraría a ver de qué es el mensaje que
 * recibió de agosto y encontraría septiembre en cero.
 *
 * ⚠️ LISTA BLANCA, NO FILTRO. Se nombra campo por campo lo que puede salir. `porCliente` trae
 * `paga`, `margen` y `pct_costo` —lo que ella le paga al proveedor y lo que le queda—, y un
 * `{...p}` distraído los publicaría en una página que se abre sin contraseña.
 *
 * El número puede no coincidir exactamente con lo cobrado: lo cobrado quedó congelado y esto se
 * recalcula. Por eso `cerrado` viaja, y el total que manda es el de la cuenta, no éste.
 */
/* Cómo la llama el cliente: su link, sin el https://. Si no tiene link cargado, el nombre — los
   links NO se deducen nunca, así que acá tampoco se inventa uno. */
function _comoLaLlamaElCliente(panel) {
  const nom = String(panel || '').trim();
  if (!nom) return '';
  try {
    const c = list().find((p) => String(p.panel || '').trim() === nom);
    const u = String((c && c.link_jugadores) || '').trim()
      .replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/+$/, '');
    return u || nom;
  } catch (e) { return nom; }
}

function desgloseParaElPortal(clienteId) {
  try {
    const ult = db.prepare('SELECT MAX(mes) m FROM chat_mov WHERE cliente_id=?').get(String(clienteId || ''));
    const mes = (ult && ult.m) || '';
    if (!/^\d{4}-\d{2}$/.test(mes)) return null;
    const g = (porCliente(mes).clientes || []).find((x) => x.cliente_id === String(clienteId));
    if (!g) return null;
    const cobros = db.prepare("SELECT COUNT(*) n FROM chat_mov WHERE mes=? AND tipo='cobro'").get(mes);
    return {
      mes,
      cerrado: !!(cobros && cobros.n > 0),
      monedas: (g.monedas || []).map((m) => ({ moneda: m.moneda, profit: m.profit, tc: m.tc, usdt: m.usdt })),
      cajas: (g.paneles || []).map((p) => ({
        caja: p.panel,
        link: p.link_jugadores || '',
        pct: p.pct_cliente,
        tramo: p.tramo || null,
        ganancia_usdt: p.profit_usdt,
        cobra: p.cobra,
        monedas: (p.detalle || []).filter((d) => Number(d.profit) > 0)
          .map((d) => ({ moneda: d.moneda, profit: String(d.profit), tc: d.tc || null, usdt: d.usdt })),
      })),
      sinTC: !!g.sinTC,
    };
  } catch (e) {
    /* Que falle el desglose no puede dejar al cliente sin su portal: lo importante de esa pantalla
       es cuánto debe y adónde pagar, y eso no depende de esto. */
    console.warn('[Chat] no se pudo armar el desglose del portal:', e.message);
    return null;
  }
}

/**
 * LOS ACCESOS DE SUS CAJAS, DETRÁS DE UNA CLAVE.
 * Al portal se entra con el nombre de una caja y nada más, así que la contraseña del panel no puede
 * estar del otro lado de esa puerta: se pide una clave que vos le diste una vez. Sin clave cargada
 * no se muestran, ni siquiera vacíos — que es distinto de "no tiene": tiene, pero no acá.
 */
function accesosDe(clienteId, clave) {
  const id = String(clienteId || '');
  const guardada = String(destino(id).clave_portal || '');
  if (!guardada) return { ok: false, error: 'Todavía no tenés clave para ver los accesos. Pedínosla y te la damos.' };
  if (String(clave || '').trim() !== guardada) return { ok: false, error: 'Esa clave no es' };
  return {
    ok: true,
    cajas: list().filter((p) => p.cliente_id === id && p.activo && (p.usuario_admin || p.clave_admin))
      .map((p) => ({ caja: p.panel, usuario: p.usuario_admin || '', clave: p.clave_admin || '', link: p.link_panel || '' })),
  };
}

/** Pide un chat nuevo. No da de alta nada: llega como pedido y se resuelve a mano. */
function pedirChat(d) {
  const id = String(d.cliente_id || '').trim();
  if (!id) return { ok: false, error: 'falta el cliente' };
  const caja = String(d.caja || '').trim().slice(0, 80);
  if (!caja) return { ok: false, error: 'decinos para qué caja lo querés' };
  const pagina = String(d.pagina || '').trim().slice(0, 80);
  if (!pagina) return { ok: false, error: 'decinos qué página vas a usar' };
  /* Un cliente puede meter pedidos hasta cansarse: el portal se abre escribiendo el nombre de una
     caja y no pide contraseña. Con unos cuantos sin resolver ya alcanza para llamarlo por teléfono. */
  const esperando = db.prepare("SELECT COUNT(*) n FROM chat_solicitud WHERE cliente_id=? AND estado='pendiente'").get(id).n;
  if (esperando >= 10) return { ok: false, error: 'Ya tenés varios pedidos esperando. Escribinos y los vemos.' };
  const sid = 'chs_' + require('crypto').randomBytes(6).toString('hex');
  db.prepare(`INSERT INTO chat_solicitud (id,cliente_id,caja,nota,estado,creado_at,pagina,dominio,divisa,caja_nueva)
    VALUES (?,?,?,?,'pendiente',?,?,?,?,?)`).run(sid, id, caja, String(d.nota || '').slice(0, 400), nowISO(),
    pagina, String(d.dominio || '').trim().slice(0, 120) || null,
    String(d.divisa || '').trim().toUpperCase().slice(0, 8) || null,
    d.caja_nueva ? 1 : 0);
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
    (id,cliente_id,mes,monto,moneda,referencia,archivo_nombre,archivo_tipo,archivo_bytes,archivo_b64,estado,creado_at,concepto,divisa)
    VALUES (?,?,?,?,?,?,?,?,?,?,'pendiente',?,?,?)`)
    .run(id, cid, String(d.mes || '').slice(0, 7) || hoy().slice(0, 7), monto,
      String(d.moneda || 'USDT').toUpperCase().slice(0, 8), String(d.referencia || '').slice(0, 200),
      nombre, tipo, bytes, b64, nowISO(), normConcepto(d.concepto),
      String(d.divisa || '').trim().toUpperCase().slice(0, 8));
  /* Las cajas que dijo estar cubriendo. Se guardan tal como vinieron, sin comprobar que sean
     suyas: el que lo escribe es el cliente desde una página pública y un valor raro no puede
     tumbar el aviso de una transferencia que ya se hizo. Al aprobarlo se reparte sólo sobre las
     que existen — ver mantenimientoPorCaja. */
  const cjsAviso = juntarWallets(d.cajas).slice(0, 400);
  if (cjsAviso) db.prepare('UPDATE chat_comprobante SET cajas=? WHERE id=?').run(cjsAviso, id);
  return { ok: true, aviso: { id, monto, archivo_bytes: bytes } };
}

/** Los avisos de un cliente (para que vea en su hoja que el suyo llegó y no lo mande otra vez). */
function avisosDe(clienteId) {
  // Sin `archivo_b64`: son cientos de KB cada uno y acá sólo se listan.
  return db.prepare(`SELECT id, mes, monto, moneda, referencia, archivo_bytes, estado, creado_at, resuelto_at, concepto, cajas, divisa
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
  const filas = db.prepare(`SELECT id, cliente_id, mes, monto, moneda, referencia, archivo_bytes, estado, creado_at, concepto, cajas, divisa,
    aviso_ok, aviso_error, aviso_at
    FROM chat_comprobante WHERE estado='pendiente' ORDER BY creado_at`).all();
  const cli = new Map(clientes.list().clientes.map((c) => [c.id, c]));
  return filas.map((f) => {
    const c = cli.get(f.cliente_id) || {};
    return { ...f, cliente: c.nombre || c.codigo || '(cliente borrado)' };
  });
}

/**
 * UN AVISO SOLO, con el nombre del cliente ya resuelto.
 * Lo usa el aviso a la matriz: `avisarPago` devuelve nada más que {id, monto, archivo_bytes}, y con
 * eso no se puede armar el mensaje. Se relee la fila para que el texto diga lo mismo venga por
 * donde venga —el portal o la hoja con token— y para que lo componga el servidor con la base y no
 * lo que quedó colgado en una variable de la ruta.
 */
function avisoPorId(id) {
  const f = db.prepare(`SELECT id, cliente_id, mes, monto, moneda, referencia, archivo_bytes,
    estado, creado_at, concepto, cajas, divisa, aviso_ok, aviso_error, aviso_at
    FROM chat_comprobante WHERE id=?`).get(String(id || ''));
  if (!f) return null;
  const c = clientes.list().clientes.find((x) => x.id === f.cliente_id) || {};
  return { ...f, cliente: c.nombre || c.codigo || '(cliente borrado)',
    sinResolver: avisosSinResolver(f.cliente_id) };
}

/** Deja anotado si el aviso a la matriz salió. Se pisa: importa el último intento. */
function marcarAvisoPago(id, r) {
  db.prepare('UPDATE chat_comprobante SET aviso_ok=?, aviso_error=?, aviso_at=? WHERE id=?')
    .run(r && r.ok ? 1 : 0, (r && r.error) ? String(r.error).slice(0, 300) : null, nowISO(), String(id || ''));
  return { ok: true };
}

/* Los avisos que están esperando y de los que NO se pudo avisar. `IS NOT 1` y no `=0`: los que
   nunca se intentaron valen igual que los que fallaron —los dos son "ella no se enteró"— y con
   `=0` los NULL se escapaban de la lista sin que nada lo dijera. */
function avisosSinNotificar() {
  return db.prepare(`SELECT id, cliente_id, monto, moneda, aviso_error, aviso_at
    FROM chat_comprobante WHERE estado='pendiente' AND (aviso_ok IS NOT 1) ORDER BY creado_at`).all();
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
/* ── SALDAR UNA DIFERENCIA ───────────────────────────────────────────────────────────────────
 * El cliente que paga en pesos usa SU tipo de cambio: si debe 160 y paga 155, esos 5 no se le
 * reclaman. Pero no se borran: se anotan como una fila más, con el motivo escrito, y la cuenta
 * queda en cero. Así siempre se puede auditar por qué cerró con menos de lo facturado.
 */
function ajustar(d) {
  const id = String(d.cliente_id || '').trim();
  if (!id) return { ok: false, error: 'falta el cliente' };
  const monto = String(d.monto == null ? '' : d.monto).trim();
  if (!money.esNumero(monto) || !money.isPos(monto)) {
    return { ok: false, error: 'la diferencia tiene que ser un número mayor que cero' };
  }
  /* EL MOTIVO ES OBLIGATORIO. Un ajuste sin motivo es exactamente el agujero que esto viene a
     tapar: una cuenta que cierra en cero y nadie sabe por qué. */
  const motivo = String(d.motivo || '').trim().slice(0, 200);
  if (!motivo) return { ok: false, error: 'poné el motivo: un ajuste sin motivo no se puede auditar después' };
  const conc = normConcepto(d.concepto);
  const dv = String(d.divisa || '').trim().toUpperCase().slice(0, 8) || _cuentaUnicaDe(id);
  const m = String(d.mes || '').slice(0, 7) || _mesQueSePaga(id, d.concepto, dv);
  const mid = 'chm_' + require('crypto').randomBytes(6).toString('hex');
  db.prepare(`INSERT INTO chat_mov (id,cliente_id,mes,tipo,monto,moneda,fecha,nota,createdAt,divisa,motivo)
    VALUES (?,?,?,'ajuste',?,'USDT',?,?,?,?,?)`).run(mid, id, m, money.round(monto, 2),
    String(d.fecha || '').slice(0, 10) || hoy(), '', nowISO(), dv, motivo);
  if (conc) db.prepare('UPDATE chat_mov SET concepto=? WHERE id=?').run(conc, mid);
  const cjs = conc === 'mantenimiento' ? juntarWallets(d.cajas) : '';
  if (cjs) db.prepare('UPDATE chat_mov SET cajas=? WHERE id=?').run(cjs, mid);
  return { ok: true, mov: db.prepare('SELECT * FROM chat_mov WHERE id=?').get(mid) };
}

/* CUÁNTO FALTA PARA SALDAR lo que el cliente dijo estar pagando, y si esa diferencia entra en la
   tolerancia. Regla de ella: menos del 5% se salda solo; de ahí para arriba, avisa y ella confirma.
   Devuelve `null` cuando no hay nada que saldar (pagó igual o de más). */
const TOLERANCIA_PCT = Number(process.env.CHAT_TOLERANCIA_PCT || '5');
function diferenciaDe(clienteId, concepto, divisa, monto, cajas) {
  try {
    const sc = saldoPorConcepto(clienteId, null, divisa || null);
    const conc = normConcepto(concepto);
    /* Contra la deuda de LO QUE DIJO PAGAR: si marcó cajas del mantenimiento, contra esas cajas;
       si no, contra el concepto entero. Comparar contra el total del cliente diría que falta
       muchísimo cada vez que paga una sola cosa. */
    let debe;
    const nombres = partirWallets(cajas);
    if (conc === 'mantenimiento' && nombres.length) {
      const porCaja = mantenimientoPorCaja(clienteId, divisa || null);
      debe = money.round(money.sum(nombres
        .map((n) => (porCaja.find((c) => c.panel === n) || {}).debe || '0')), 2);
    } else if (conc === 'mantenimiento') debe = sc.mantenimiento.debe;
    else if (conc === 'ganancia') debe = sc.ganancia.debe;
    else debe = sc.total.debe;
    const falta = money.sub(debe, String(monto || '0'));
    if (!money.isPos(falta)) return null;                       // pagó igual o de más
    const pct = money.isPos(debe)
      ? Number(money.round(money.pctDe ? money.pctDe(falta, debe) : String((Number(falta) / Number(debe)) * 100), 2))
      : 100;
    return { debe, pagado: String(monto), falta: money.round(falta, 2), pct, tolerado: pct < TOLERANCIA_PCT };
  } catch (e) { return null; }
}

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
    // Se imputa a lo que el cliente dijo al avisar. Si dijo mal, se rechaza y lo manda de nuevo.
    concepto: f.concepto, cajas: f.cajas,
    // Y a la cuenta que dijo: con dos, imputarlo a la otra deja las dos mal.
    divisa: f.divisa || '',
  });
  if (!pg.ok) return pg;
  db.prepare("UPDATE chat_comprobante SET estado='aprobado', resuelto_at=?, mov_id=? WHERE id=?")
    .run(nowISO(), pg.mov.id, f.id);
  /* ⚠️ Y LA DIFERENCIA, SI LA HAY. Se calcula DESPUÉS de registrar el pago —con el pago adentro,
     lo que queda es exactamente lo que falta— y se salda sola sólo si está dentro de la tolerancia.
     Por encima, no se toca nada: se devuelve para que ella lo mire y confirme. */
  const dif = diferenciaDe(f.cliente_id, f.concepto, f.divisa, '0', f.cajas);
  let ajuste = null;
  if (dif && dif.tolerado) {
    const r = ajustar({
      cliente_id: f.cliente_id, monto: dif.falta, concepto: f.concepto, divisa: f.divisa,
      cajas: f.cajas, mes: pg.mov.mes, fecha: String(f.creado_at || '').slice(0, 10),
      motivo: `diferencia por tipo de cambio (${dif.pct}%)`,
    });
    if (r.ok) ajuste = r.mov;
  }
  return { ok: true, estado: 'aprobado', mov: pg.mov, ajuste, diferencia: dif };
}

/* ── LO QUE YA LE PAGASTE AL PROVEEDOR ───────────────────────────────────────────────────────
   Un mes pagado y uno impago se veían igual: el sistema calculaba lo que correspondía y no
   guardaba en ningún lado si el pago se hizo. */
/** Deja anotado el resultado del envío. Se pisa: lo que importa es el último intento. */
/* La clave guardada lleva la divisa pegada al cliente. Es lo que deja tener DOS filas del mismo
   mes sin rehacer la tabla —SQLite no permite cambiar una PRIMARY KEY— y sigue impidiendo dos de
   la misma cuenta, que es lo que la clave vieja protegía bien. */
const _claveEnvio = (clienteId, divisa) => `${String(clienteId)}${divisa ? '|' + String(divisa).toUpperCase() : ''}`;

function marcarEnviado(clienteId, mes, r, divisa = '') {
  db.prepare(`INSERT INTO chat_envio (cliente_id,mes,ok,error,at,divisa) VALUES (?,?,?,?,?,?)
    ON CONFLICT(cliente_id,mes) DO UPDATE SET ok=excluded.ok, error=excluded.error, at=excluded.at`)
    .run(_claveEnvio(clienteId, divisa), String(mes).slice(0, 7), r && r.ok ? 1 : 0,
      r && r.ok ? null : String((r && r.error) || 'error desconocido'), nowISO(),
      String(divisa || '').toUpperCase());
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
/* Cómo salió cada envío. La clave del objeto es la misma que se guardó: `<cliente>` cuando el
   cliente tiene una sola cuenta y `<cliente>|PYG` cuando tiene dos, así la pantalla puede decir
   «la de guaraníes salió, la de pesos no» en vez de una sola respuesta para las dos. */
function envios(mes) {
  const m = String(mes || '').slice(0, 7);
  const out = {};
  for (const f of db.prepare('SELECT * FROM chat_envio WHERE mes=?').all(m)) {
    out[f.cliente_id] = { ok: !!f.ok, error: f.error, at: f.at, divisa: f.divisa || '' };
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

/* ── LO QUE LE DEBÉS AL PROVEEDOR, ABIERTO EN SUS DOS PARTES ─────────────────────────────────
   Antes «le debés del mes» era SÓLO el % sobre la ganancia. El mantenimiento no entraba, y va
   entero al proveedor —a otra wallet y en otras fechas—. Con los datos de agosto eso daba
   169,44 cuando lo real eran 1.219,44: faltaban los 1.050 de las siete mensualidades enteros.

   El mantenimiento que le debés es el que YA le cobraste al cliente ese mes: lo que entró por ese
   concepto sale por el mismo. No se recalcula sobre las cajas activas, porque una caja que arrancó
   a mitad de mes no debe un mes entero — y eso ya lo resolvió el devengo al cobrarlo. */
/**
 * LO QUE LE DEBÉS AL PROVEEDOR — Y LO QUE NO.
 *
 * ⚠️ SON DOS PLATAS QUE VIAJAN POR CAMINOS DISTINTOS, y confundirlas hacía pagar dos veces:
 *
 *  · EL MANTENIMIENTO NO PASA POR VOS. Las wallets del mantenimiento son DE ÉL: el cliente le
 *    transfiere directo. Vos lo facturás y lo confirmás, pero esa plata nunca la recibís, así que
 *    NO ES UNA DEUDA TUYA. Antes se sumaba a lo que le debías —1.050 de agosto— y quedaba
 *    esperando que vos le mandaras algo que él ya había cobrado.
 *    Acá va como informativo: cuánto es, cuánto le pagaron ya los clientes, y cuánto falta que
 *    le paguen. Lo que falta lo cobra él, no vos.
 *
 *  · EL % SÍ. Ese entra a TU wallet y después le mandás la parte suya. Es la única deuda.
 *
 * Por eso `total` es sólo la ganancia: es lo que tenés que transferir.
 */
function deudaProveedor(mes) {
  const m = String(mes || '').slice(0, 7);
  const c = cierre(m);
  const porGanancia = c.totales.paga;
  const mant = db.prepare("SELECT monto FROM chat_mov WHERE mes=? AND tipo='mensualidad'").all(m);
  const mantenimiento = money.round(money.sum(mant.map((x) => x.monto || '0')), 2);
  const ps = pagos(m);
  const pagadoDe = (k) => money.round(money.sum(
    ps.filter((p) => (p.concepto || 'ganancia') === k).map((p) => p.monto || '0')), 2);
  const pagG = pagadoDe('ganancia');
  /* Lo que los CLIENTES ya le pagaron directo del mantenimiento de este mes. Sale de los pagos de
     ellos, no de los tuyos: la plata fue de su bolsillo a la wallet de él sin escala. */
  const pagCli = money.round(money.sum(
    db.prepare(`SELECT monto FROM chat_mov
      WHERE mes=? AND tipo='pago' AND concepto='mantenimiento'`).all(m).map((x) => x.monto || '0')), 2);
  /* Y si además vos le pagaste mantenimiento alguna vez —no debería, pero se pudo haber cargado—
     cuenta igual: la plata le llegó. */
  const pagM = pagadoDe('mantenimiento');
  const cubierto = money.round(money.add(pagCli, pagM), 2);
  return {
    mes: m,
    ganancia: { debe: porGanancia, pagado: pagG, falta: money.round(money.sub(porGanancia, pagG), 2) },
    /* `debe: '0'` a propósito y no el monto: NO se lo debés vos. `factura` es cuánto es el
       mantenimiento del mes, para que se vea de qué se está hablando. */
    mantenimiento: {
      debe: '0', factura: mantenimiento, cajas: mant.length,
      leLlegoDelCliente: cubierto,
      faltaQueLePaguen: money.round(money.sub(mantenimiento, cubierto), 2),
      directo: true,
      pagado: cubierto,
      falta: money.round(money.sub(mantenimiento, cubierto), 2),
    },
    total: {
      debe: porGanancia,
      pagado: pagG,
      falta: money.round(money.sub(porGanancia, pagG), 2),
    },
  };
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
  // Sin concepto se asume el %, que es lo único que existía antes de que se separaran.
  const concepto = d.concepto === 'mantenimiento' ? 'mantenimiento' : 'ganancia';
  db.prepare(`INSERT INTO chat_pago_proveedor (id,mes,monto,moneda,fecha,nota,concepto,createdAt,destino,red,hash)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(id, m, money.round(monto, 2),
    String(d.moneda || 'USDT').toUpperCase().slice(0, 8), fecha, String(d.nota || ''), concepto, nowISO(),
    String(d.destino || '').trim().slice(0, 200) || null,
    String(d.red || '').trim().toUpperCase().slice(0, 24) || null,
    String(d.hash || '').trim().slice(0, 200) || null);
  return { ok: true, pago: db.prepare('SELECT * FROM chat_pago_proveedor WHERE id=?').get(id) };
}

function borrarPago(id) {
  const r = db.prepare('DELETE FROM chat_pago_proveedor WHERE id=?').run(String(id || ''));
  return { ok: true, borrados: r.changes };
}

/* Se corre al final del módulo, cuando `list()` ya existe y las columnas nuevas ya están. */
_ponerDivisaALoViejo();

module.exports = {
  config, setConfig, list, set, quitar, gananciaDelMes, cierre, mensualidadesDe,
  destino, setDestino, porCliente, pagos, pagado, pagar, borrarPago, botToken, deudaProveedor,
  ajustar, diferenciaDe, TOLERANCIA_PCT,
  marcarEnviado, envios, partirGrupos, destinos, marcarAvisoMens, avisosMensDe,
  wallets, guardarWallet, borrarWallet, walletDe, walletsDe, partirWallets, comoPagar, walletsApagadasEnUso,
  cobrar, descobrar, pagarCliente, borrarMov, cuentas, cobrarMensualidad, periodoDesde,
  devengarMensualidades,
  avisarPago, avisosDe, avisosPendientes, archivoDeAviso, resolverAviso, avisosSinResolver,
  avisoPorId, marcarAvisoPago, avisosSinNotificar, mesEnLetras, listasParaMandar,
  claveEnvio: _claveEnvio,
  saldoPorConcepto, opcionesDeConcepto, mantenimientoPorCaja, gananciaDelMes, sumarDesde,
  comoLaLlamaElCliente: _comoLaLlamaElCliente, divisaDelPanel: _divisaDelPanel,
  proveedorGrupo,
  paraElProveedor, mesesDelProveedor,
  proveedorAcceso, setProveedorAcceso, proveedorEntra, proveedorCorte,
  quienEntra, portalDe, pedirChat, solicitudesPendientes, resolverSolicitud, accesosDe,
};
