/**
 * db.js — base SQLite (better-sqlite3, síncrono) de LATAM Games OS.
 *
 * Mantiene las tablas de la MATRIZ (systems, clientes, pedidos, config, push_subs, meta)
 * y agrega el núcleo comercial/financiero (personas, paneles, participaciones, split_base,
 * proveedores, panel_proveedores, tc_snapshots, tc_mes, movimientos, config_valores,
 * historial_config, usuarios).
 *
 * CONVENCIÓN DE DINERO: los montos/porcentajes se guardan como TEXT (string decimal) y se
 * operan con decimal.js (ver lib/money.js). NUNCA REAL/float.
 *
 * Persistencia: DB_PATH (env) || RAILWAY_VOLUME_MOUNT_PATH/store.sqlite || data/store.sqlite.
 */
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DB_PATH
  || (process.env.RAILWAY_VOLUME_MOUNT_PATH ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'store.sqlite') : null)
  || path.join(__dirname, '..', 'data', 'store.sqlite');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
console.log('[DB] base en:', DB_PATH, process.env.RAILWAY_VOLUME_MOUNT_PATH ? '(VOLUME persistente ✓)' : '(local/efímero)');

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');

db.exec(`
  /* ───── MATRIZ (existente) ───── */
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
  CREATE TABLE IF NOT EXISTS systems (
    id TEXT PRIMARY KEY, name TEXT, url TEXT, user TEXT, password TEXT,
    createdAt TEXT, lastLoginAt TEXT, lastLoginOk INTEGER, ord INTEGER
  );
  CREATE TABLE IF NOT EXISTS clientes (
    id TEXT PRIMARY KEY, codigo TEXT, nombreVisible TEXT, createdAt TEXT,
    telegram TEXT, cajas TEXT, ord INTEGER
  );
  CREATE TABLE IF NOT EXISTS pedidos (id TEXT PRIMARY KEY, data TEXT, ord INTEGER);
  CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT);
  /* ───── PUENTE con el sistema en línea ─────
     Los pedidos viven allá y el motor que factura vive acá, pero los dos padrones NO comparten
     códigos: allá un pedido viene con "M526", acá el cliente se llama "Marcelo". Este mapeo se
     dedujo cruzando cada pedido con el NODO DEL CASINO al que se cargó — el mismo dato en los
     dos lados — y no adivinando por el nombre. */
  CREATE TABLE IF NOT EXISTS ventas_mapeo (
    codigo TEXT PRIMARY KEY,      -- el código del sistema en línea
    cliente_id TEXT,              -- el cliente de ACÁ
    origen TEXT,                  -- 'por el nodo del casino' | 'a mano'
    actualizado_at TEXT
  );

  /* ───── LINK PÚBLICO DE UNA FACTURA ─────
     El cliente abre el desglose completo sin tener que entrar a ningún lado, y por Telegram le
     llega solo el resumen. Guarda una FOTO de la factura: si después entran más cargas o cambia
     un %, el link tiene que seguir mostrando lo que se le mandó, no un número nuevo. */
  CREATE TABLE IF NOT EXISTS factura_link (
    token TEXT PRIMARY KEY,       -- al azar y largo: es la única llave, no puede ser adivinable
    cliente_id TEXT, mes TEXT,
    datos TEXT,                   -- la factura congelada (JSON)
    creado_at TEXT, actualizado_at TEXT,
    accesos INTEGER DEFAULT 0, ultimo_acceso TEXT,
    revocado INTEGER DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS ix_factura_link_cli ON factura_link (cliente_id, mes);

  CREATE TABLE IF NOT EXISTS push_subs (endpoint TEXT PRIMARY KEY, sub TEXT, createdAt TEXT);

  /* ───── COMERCIAL ───── */
  CREATE TABLE IF NOT EXISTS personas (
    id TEXT PRIMARY KEY, nombre TEXT, activo INTEGER DEFAULT 1, createdAt TEXT, ord INTEGER
  );
  CREATE TABLE IF NOT EXISTS paneles (
    id TEXT PRIMARY KEY,
    cliente_id TEXT,
    nombre TEXT,
    sistema TEXT,                 -- Casino | Europa
    tipo TEXT,                    -- franquicia | exclusivo
    nivel_usuario TEXT,           -- SuperAgente | Distribuidor | Agente
    id_usuario TEXT,              -- ID real en el panel del proveedor
    usa_config_cliente INTEGER DEFAULT 1,
    divisas TEXT,                 -- JSON array
    usuario TEXT,                 -- login operativo (puente con la carga)
    montosRapidos TEXT,           -- JSON
    notas TEXT,
    createdAt TEXT, ord INTEGER
  );
  CREATE TABLE IF NOT EXISTS participaciones (
    id TEXT PRIMARY KEY,
    cliente_id TEXT,
    panel_id TEXT,                -- null = nivel cliente; set = override panel
    persona_id TEXT,
    porcentaje TEXT,             -- decimal string
    vigente_desde TEXT,
    vigente_hasta TEXT,          -- null = vigente
    createdAt TEXT
  );
  CREATE TABLE IF NOT EXISTS split_base (
    pct_base TEXT PRIMARY KEY,    -- "15","14",...,"8","<8"
    pct_empresa TEXT,
    pct_latam TEXT,
    notas TEXT
  );

  /* ───── PROVEEDORES ───── */
  CREATE TABLE IF NOT EXISTS proveedores (
    id TEXT PRIMARY KEY,
    nombre TEXT,
    categoria TEXT,               -- incluido | extra | interno
    tc_aplica TEXT,              -- na | tc_cliente
    activo INTEGER DEFAULT 1,
    createdAt TEXT, ord INTEGER
  );
  CREATE TABLE IF NOT EXISTS panel_proveedores (
    id TEXT PRIMARY KEY,
    panel_id TEXT,
    proveedor_id TEXT,
    tarifa_pct TEXT,            -- decimal string
    habilitado INTEGER DEFAULT 1,
    vigente_desde TEXT,
    vigente_hasta TEXT,
    createdAt TEXT
  );
  /* % de proveedor POR CLIENTE: rige para TODOS los paneles/superagentes de ese cliente.
     Si no hay fila para (cliente, proveedor) → se usa el % global de proveedores.tarifa_pct. */
  CREATE TABLE IF NOT EXISTS cliente_proveedores (
    id TEXT PRIMARY KEY,
    cliente_id TEXT,
    proveedor_id TEXT,
    tarifa_pct TEXT,            -- decimal string (% que se cobra a ESTE cliente por este proveedor)
    habilitado INTEGER DEFAULT 1,
    createdAt TEXT
  );

  /* ───── TIPOS DE CAMBIO ───── */
  CREATE TABLE IF NOT EXISTS tc_snapshots (
    id TEXT PRIMARY KEY,
    fecha TEXT,                   -- YYYY-MM-DD
    hora TEXT,                    -- HH:mm
    tc_ars_usdt TEXT,           -- decimal string
    fuente TEXT,
    createdAt TEXT
  );
  -- Snapshot diario del resto de las divisas (ARS va aparte, en tc_snapshots, porque sale de
  -- Binance/criptoya). Una fila por (fecha, divisa): al cerrar el mes se promedia.
  CREATE TABLE IF NOT EXISTS tc_divisa_snapshots (
    fecha TEXT,                   -- YYYY-MM-DD
    divisa TEXT,                  -- código (PYG, BRL, …)
    tasa TEXT,                    -- decimal string: cuántas unidades por 1 USDT
    fuente TEXT,
    createdAt TEXT,
    PRIMARY KEY (fecha, divisa)
  );
  CREATE INDEX IF NOT EXISTS idx_tcdiv_mes ON tc_divisa_snapshots(substr(fecha,1,7), divisa);
  CREATE TABLE IF NOT EXISTS tc_mes (
    mes TEXT PRIMARY KEY,         -- YYYY-MM
    tc_cliente TEXT,            -- promedio snapshots (auto)
    tc_proveedor_ext TEXT,     -- manual (factura)
    diferencia_tc TEXT,        -- auto
    cerrado INTEGER DEFAULT 0,
    updatedAt TEXT
  );

  /* ───── MOVIMIENTOS & FINANZAS ───── */
  CREATE TABLE IF NOT EXISTS movimientos (
    id TEXT PRIMARY KEY,
    cliente_id TEXT,
    panel_id TEXT,
    proveedor_id TEXT,
    pedido_id TEXT,
    tipo TEXT,                    -- carga | pago | proveedor_extra | ajuste | correccion | bonificacion
    monto_ars TEXT,
    monto_usdt TEXT,
    tc_momento TEXT,
    base_pct_aplicado TEXT,
    divisa TEXT,
    fecha TEXT,                   -- datetime ISO
    usuario_id TEXT,
    notas TEXT,
    createdAt TEXT, ord INTEGER
  );

  /* ───── HISTORIAL / VIGENCIAS ───── */
  CREATE TABLE IF NOT EXISTS config_valores (
    id TEXT PRIMARY KEY,
    entidad_tipo TEXT,           -- cliente | panel
    entidad_id TEXT,
    campo TEXT,                   -- precio_base_pct, mezcla_pago_usdt, ajuste_usdt_pct, ...
    valor TEXT,
    vigente_desde TEXT,
    vigente_hasta TEXT,          -- null = vigente
    createdAt TEXT
  );
  CREATE TABLE IF NOT EXISTS historial_config (
    id TEXT PRIMARY KEY,
    entidad_tipo TEXT,           -- cliente | panel | participacion | proveedor | split_base | panel_proveedor
    entidad_id TEXT,
    campo TEXT,
    valor_anterior TEXT,
    valor_nuevo TEXT,
    tipo_cambio TEXT,           -- correccion | vigencia
    vigente_desde TEXT,
    fecha_registro TEXT,
    usuario_id TEXT,
    notas TEXT
  );
  CREATE TABLE IF NOT EXISTS usuarios (
    id TEXT PRIMARY KEY, nombre TEXT, rol TEXT, activo INTEGER DEFAULT 1, createdAt TEXT
  );

  /* ───── REPORTE DIARIO ACUMULADO (se llena día a día: 1 fila por conexión/fecha/nivel/superagente) ───── */
  CREATE TABLE IF NOT EXISTS reporte_diario (
    id TEXT PRIMARY KEY,
    conexion_id TEXT, fecha TEXT, grp TEXT,
    sa_id TEXT, login TEXT,
    in_amt TEXT, out_amt TEXT, profit TEXT,
    moneda TEXT DEFAULT 'ARS',
    captured_at TEXT
  );


  /* ───── LA FOTO DEL MES: estadísticas por proveedor sacadas UNA VEZ y guardadas ─────
     Un mes cerrado ya no cambia. Se le pregunta al casino una sola vez (una consulta por
     conexión × divisa × agrupación, que trae TODOS los nodos de golpe) y después los reportes
     se arman leyendo de acá: instantáneo y sin depender de que el casino esté arriba. */
  CREATE TABLE IF NOT EXISTS estad_mes (
    id TEXT PRIMARY KEY,          -- conexion|mes|divisa|grupo|nodo|provider|label|vendor
    conexion_id TEXT, mes TEXT, divisa TEXT,
    grupo TEXT,                   -- 'superagent' | 'distributor' | 'agent' (el nivel del nodo)
    nodo_id TEXT, nodo_login TEXT,
    provider TEXT, label TEXT, vendor TEXT,
    bet TEXT, win TEXT, profit TEXT,
    capturado_at TEXT
  );
  CREATE INDEX IF NOT EXISTS ix_estad_mes_nodo ON estad_mes (conexion_id, mes, divisa, grupo, nodo_id);
  CREATE INDEX IF NOT EXISTS ix_estad_mes_mes ON estad_mes (mes);

  /* Qué se sacó y qué no. Sin esto, un mes con la foto a medias parece completo. */
  CREATE TABLE IF NOT EXISTS estad_captura (
    id TEXT PRIMARY KEY,          -- conexion|mes|divisa|grupo
    conexion_id TEXT, mes TEXT, divisa TEXT, grupo TEXT,
    estado TEXT,                  -- 'ok' | 'error'
    filas INTEGER, nodos INTEGER, error TEXT, segundos REAL,
    capturado_at TEXT
  );


  /* ───── COMPROBANTES DE PAGO que suben los clientes ─────
     El adjunto va EN LA BASE (que ya vive en el volumen): así el comprobante y su registro no se
     pueden separar. Queda 'pendiente' hasta que alguien lo mira: acreditar un pago porque el
     cliente subió una imagen sería confiar en la imagen. */
  CREATE TABLE IF NOT EXISTS comprobantes (
    id TEXT PRIMARY KEY,
    codigo TEXT, cliente_nombre TEXT,
    via TEXT,                     -- 'ars' | 'usdt'
    monto TEXT, divisa TEXT,
    referencia TEXT,              -- nro de operación / hash de la transacción
    notas TEXT,
    estado TEXT,                  -- 'pendiente' | 'aprobado' | 'rechazado'
    archivo_nombre TEXT, archivo_tipo TEXT, archivo_bytes INTEGER, archivo_datos TEXT,
    creado_at TEXT, resuelto_at TEXT, resuelto_por TEXT, motivo TEXT,
    movimiento_id TEXT            -- el movimiento de pago que se generó al aprobarlo
  );
  CREATE INDEX IF NOT EXISTS ix_comprobantes_estado ON comprobantes (estado, creado_at);
  CREATE INDEX IF NOT EXISTS ix_comprobantes_codigo ON comprobantes (codigo);

  /* ───── CONEXIONES AL CASINO (api_token, genérico/multi-master) ───── */
  CREATE TABLE IF NOT EXISTS casino_conexiones (
    id TEXT PRIMARY KEY,
    nombre TEXT,              -- ej "463.life (dev)"
    url TEXT,                 -- https://admin.463.life
    token TEXT,               -- api_token CIFRADO (crypto-util)
    activa INTEGER DEFAULT 1,
    createdAt TEXT, ord INTEGER
  );

  /* ───── CIERRE DE MES (réplica EDITABLE de la planilla de Alexa) ─────
     Matriz proveedor × cliente de %, + base por proveedor, + descuento por cliente, + TC mensual.
     Keyeada por NOMBRE (igual que la planilla) para duplicarla fiel; se cruza con catálogo/paneles al calcular. */
  CREATE TABLE IF NOT EXISTS cierre_proveedor (
    nombre TEXT PRIMARY KEY,   -- "MARCA VENDOR" (ej "EGT DIGITAL SZ")
    base_pct TEXT,             -- columna "%" base de la planilla (costo/rate mínimo)
    ord INTEGER
  );
  CREATE TABLE IF NOT EXISTS cierre_cliente (
    nombre TEXT PRIMARY KEY,   -- ej "Titan"
    descuento TEXT,            -- 1_Cliente (% que se resta al %proveedor)
    ord INTEGER
  );
  CREATE TABLE IF NOT EXISTS cierre_pct (
    proveedor TEXT, cliente TEXT, pct TEXT,   -- celda de la matriz
    PRIMARY KEY (proveedor, cliente)
  );
  CREATE TABLE IF NOT EXISTS cierre_tc (
    moneda TEXT, mes TEXT, tasa TEXT,         -- Exchange Rate (moneda × mes → USDT)
    PRIMARY KEY (moneda, mes)
  );
  /* §9 — el % base de un cliente CAMBIA de un mes a otro (un mes 6%, otro 7%) pero su costo de
     proveedores casi nunca. Se confirma por mes y NO se toca el histórico hacia atrás. */
  CREATE TABLE IF NOT EXISTS externos_base_mes (
    cliente TEXT, mes TEXT, base_pct TEXT, confirmadoAt TEXT,
    PRIMARY KEY (cliente, mes)
  );
  /* Foto de la matriz de UN mes. Los precios cambian (costo del proveedor y % del cliente), y sin
     esto tocar un precio hoy cambiaba lo que calculaba para cualquier mes ya facturado. */
  /* Ganancias por proveedor que devolvio el casino. Sin esto cada corrida del reporte de §9 le
     vuelve a preguntar lo mismo (50-120s) y con el casino lento se pasa del timeout. */
  CREATE TABLE IF NOT EXISTS ganancias_cache (
    conexion_id TEXT, nodo TEXT, mes TEXT, divisa TEXT, datos TEXT, capturedAt TEXT,
    PRIMARY KEY (conexion_id, nodo, mes, divisa)
  );
  CREATE TABLE IF NOT EXISTS cierre_mes_snapshot (
    mes TEXT PRIMARY KEY, datos TEXT, createdAt TEXT, notas TEXT
  );
  /* LA VALIDACION CONTRA LOS PANELES DE UN MES, guardada.
     El panel del casino es la validacion de lo que se factura: si una carga que se cobra no existe
     en el panel se esta cobrando de mas, y si el panel entrego fichas que nadie pidio no se esta
     cobrando. Eso se mira ANTES de emitir, que es cuando el numero se vuelve deuda.
     Se guarda porque preguntarselo al casino de nuevo cinco meses despues no devuelve lo mismo
     —los paneles se renombran, se dan de baja, cambian de conexion— y porque hay que poder ver
     que se valido y que se dejo pasar cuando se emitio, no lo que daria hoy.
     La columna confirmado_por deja el rastro de quien decidio emitir igual con las diferencias
     a la vista. */
  /* UNA DIFERENCIA QUE YA SE MIRÓ.
     El contraste encuentra cosas que no cuadran, pero muchas tienen una explicación que sólo
     conoce quien las hizo: una prueba, una reposición, una carga a mano. Sin poder anotarlo, el
     mismo aviso vuelve a salir todos los meses y termina salteándose sin leer — que es la forma
     en que se pierde la señal que el aviso existe para dar.
     La CLAVE identifica el movimiento, no la fila del reporte: mes + nodo + divisa + monto + fecha, sin
     el tipo, para que la resolución sobreviva si mañana el cruce lo clasifica mejor.
     No borra ni corrige nada: sólo deja dicho que alguien lo miró, quién y cuándo. */
  CREATE TABLE IF NOT EXISTS diferencia_resuelta (
    clave TEXT PRIMARY KEY,
    mes TEXT, nodo TEXT, panel TEXT, cliente_id TEXT,
    divisa TEXT, monto TEXT, fecha TEXT,
    decision TEXT,              -- prueba | revisada
    motivo TEXT,
    quien TEXT, cuando TEXT
  );
  CREATE INDEX IF NOT EXISTS ix_dif_resuelta_mes ON diferencia_resuelta (mes);

  /* LA FACTURA DE UN MES, GUARDADA.
     Hasta acá una factura sólo quedaba congelada si alguien apretaba el boton del link o la mandaba
     por Telegram. Imprimirla a PDF -que es como se venia usando- no dejaba rastro: en todo el
     sistema habia DOS facturas guardadas. Sin eso no se puede volver a lo que se le mando a un
     cliente, y el numero de hoy no es el de entonces.
     Se guarda cuando la factura SALE del sistema: al emitir el mes, al imprimirla, al copiarla, al
     crear el link o al mandarla. Abrirla para mirar no guarda nada.
     No lleva token: el link publico sigue viviendo en la tabla factura_link. Acunar una URL publica cada
     vez que alguien imprime seria crear una credencial de paso, sin querer. */
  CREATE TABLE IF NOT EXISTS factura_guardada (
    cliente_id TEXT, mes TEXT,
    datos TEXT,                     -- la factura entera, congelada (JSON)
    consumo_usdt TEXT, externos_usdt TEXT, total_usdt TEXT,
    generada_at TEXT, generada_por TEXT, veces INTEGER DEFAULT 1,
    actualizada_at TEXT,
    salio_at TEXT, salio_como TEXT,  -- impresa | copiada | link | telegram
    PRIMARY KEY (cliente_id, mes)
  );
  CREATE INDEX IF NOT EXISTS ix_factura_guardada_mes ON factura_guardada (mes);

  CREATE TABLE IF NOT EXISTS validacion_mes (
    mes TEXT PRIMARY KEY,
    datos TEXT,                    -- el resultado completo (JSON)
    cobra_de_mas TEXT, no_se_cobra TEXT, sin_validar TEXT,
    clientes_con_diferencias INTEGER,
    validado_at TEXT,
    confirmado_at TEXT, confirmado_por TEXT
  );
  /* ───── LO QUE YA SE MANDÓ AL GRUPO INTERNO ─────
     Cerrar el mes termina en dos envíos a «Cuentas Imperium»: la cuenta de externos de los
     clientes y la de los vendedores. Sin dejar rastro, el paso del cierre no puede decir si ya
     salió, y lo que no se puede ver se manda dos veces o no se manda ninguna. Una fila por
     (mes, qué): mandar de nuevo pisa la fila y deja la última fecha. */
  CREATE TABLE IF NOT EXISTS envio_interno (
    mes TEXT, que TEXT,             -- 'externos' | 'vendedores'
    chat TEXT, cantidad INTEGER, total_usdt TEXT,
    at TEXT, quien TEXT, veces INTEGER DEFAULT 1,
    PRIMARY KEY (mes, que)
  );
  CREATE TABLE IF NOT EXISTS cierre_link (
    casino TEXT PRIMARY KEY,   -- proveedor que sale del casino "MARCA VENDOR" (ej "RUBYPLAY XG")
    matriz TEXT,               -- proveedor de la matriz de % (ej "RUBYPLAY OP")
    origen TEXT                -- exacto | marca | manual (cómo se vinculó)
  );
  /* ───── CATÁLOGO DE DIVISAS (v3.0) — editable, NO enum en código ───── */
  CREATE TABLE IF NOT EXISTS divisas (
    codigo TEXT PRIMARY KEY,    -- ARS, MXN, UYU, PYG, USD…
    nombre TEXT,                -- "Peso argentino"
    activa INTEGER DEFAULT 1,
    ord INTEGER
  );

  /* índices útiles */
  CREATE INDEX IF NOT EXISTS idx_paneles_cliente ON paneles(cliente_id);
  CREATE INDEX IF NOT EXISTS idx_part_cliente ON participaciones(cliente_id);
  CREATE INDEX IF NOT EXISTS idx_mov_cliente ON movimientos(cliente_id);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_clipro ON cliente_proveedores(cliente_id, proveedor_id);
  CREATE INDEX IF NOT EXISTS idx_mov_fecha ON movimientos(fecha);
  CREATE INDEX IF NOT EXISTS idx_cv_entidad ON config_valores(entidad_tipo, entidad_id, campo);
  CREATE INDEX IF NOT EXISTS idx_snap_fecha ON tc_snapshots(fecha);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_repdia ON reporte_diario(conexion_id, fecha, grp, sa_id, moneda);
  CREATE INDEX IF NOT EXISTS idx_repdia_mes ON reporte_diario(conexion_id, grp, fecha);
`);

/** Agrega columnas que falten a una tabla existente (migración no destructiva). */
function ensureColumns(table, cols) {
  const have = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((r) => r.name));
  for (const [name, decl] of Object.entries(cols)) {
    if (!have.has(name)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${decl}`);
      console.log(`[DB] columna agregada: ${table}.${name}`);
    }
  }
}

// Extender CLIENTES de la MATRIZ con los campos comerciales del OS v3 (todos opcionales).
ensureColumns('clientes', {
  nombre: 'TEXT',
  estado: "TEXT DEFAULT 'activo'",        // activo | inactivo | suspendido
  paga_proveedores: 'INTEGER DEFAULT 0',
  permite_deuda: 'INTEGER DEFAULT 0',
  mezcla_pago_usdt: 'TEXT',               // decimal string % (proporción USDT por defecto)
  ajuste_usdt_pct: 'TEXT',                // decimal string %
  fecha_alta: 'TEXT',
  // ── v3.0 ficha de cliente ──
  divisa_fichas: 'TEXT',                  // código de divisa (del catálogo `divisas`)
  moneda_cobro: 'TEXT',                   // usdt | cvu (=ARS) | variable | no_aplica (no se le cobra)
  momento_pago: 'TEXT',                   // anticipado | acumulado | invoice
  disparador: 'TEXT',                     // carga_deuda | pago_carga | variable (el cliente elige por operación)
  tc_aplicar: 'TEXT',                     // tiempo_real | promedio | proveedor | trader (TC que pasa el trader, por mes)
  tc_proveedor: 'TEXT',                   // TC manual del proveedor (si tc_aplicar=proveedor)
  // ── v3.0 §7-10 (planilla "BASE DE DATOS CLIENTES") ──
  mover_balance: 'INTEGER DEFAULT 0',     // permiso: mover fichas entre paneles PROPIOS, misma divisa
  // Margen genérico de proveedores externos: "a este cliente cobrale +N sobre el COSTO del
  // proveedor". Se usa cuando ese proveedor NO tiene un precio propio en la matriz (típico de
  // un cliente nuevo: "cobrale +3 los externos"). Si la matriz tiene precio, manda la matriz.
  margen_externos_pct: 'TEXT',
  // ── v3.0 §11: vendedores ──
  // es_vendedor: revende a sus propios sub-clientes (Alexa, Sarah, Carlos, Henry, Julian, David).
  //   Su % base es 0 y sólo se le factura el diferencial de proveedores externos.
  // vendedor_id: a qué vendedor pertenece ESTE cliente (null = cliente directo).
  //   Los clientes chicos se registran por separado y se agrupan por acá: agrupar siempre se
  //   puede, desagregar no. Al vendedor se le muestra el total de SUS clientes a precio real.
  es_vendedor: 'INTEGER DEFAULT 0', externos_modo: 'TEXT',
  vendedor_id: 'TEXT',
  /* ── UN CLIENTE QUE CUELGA DE OTRO (Fran/Ariel, Marcelo/JJ) ──────────────────────────────
     factura_a: a QUIÉN se le cobra de verdad el consumo de este cliente. Su deuda va a la
       cuenta de ese otro y con el % de ese otro; el cliente conserva SU precio, que es lo que
       le paga a quien lo banca. La diferencia entre los dos es la ganancia del intermediario.
       Hasta ahora esto no estaba escrito en ningún lado: funcionaba porque el pedido se cargaba
       tipeando el código del que paga. Una costumbre, no una regla — bastaba que alguien tipeara
       el código del chico para que se le facturara a él, sin que saltara nada.
     externos_precios_de: de qué cliente salen sus precios de proveedores externos. Fran y Ariel
       usan los mismos (Ariel no tiene una sola celda propia); Marcelo y JJ no —difieren en 16
       proveedores— y por eso JJ conserva los suyos. Se LEEN del otro, no se copian: una copia
       queda vieja el primer mes que se toque un precio. */
  factura_a: 'TEXT', externos_precios_de: 'TEXT',
  /* ── LA EXCEPCIÓN A LOS INTERNOS ──────────────────────────────────────────────────────────
     Regla general (4-sep-2026): SL, SL2 y XG no se cobran, van al % base del cliente. Pero hay
     acuerdos viejos donde SÍ se cobran —Juan y Titan— y a esos no se les puede cambiar el precio
     de un día para el otro. Con esto en 1, ese cliente los cobra como a cualquier otro proveedor:
     lo que diga su celda de la matriz. Es por cliente y a propósito: una regla global con una
     lista de excepciones adentro del código se olvida el día que entra el cuarto. */
  internos_se_cobran: 'INTEGER DEFAULT 0',
  saldo_inicial: 'TEXT',                  // decimal string: deuda previa al sistema ("saldo anterior")
  saldo_inicial_divisa: 'TEXT',           // divisa en la que se expresa ese saldo
  saldo_inicial_mov_id: 'TEXT',           // id del movimiento 'ajuste' que lo materializa (re-aplicable/reversible)
});

// Cada PANEL puede linkearse a un nodo del casino (qué conexión + qué id de usuario del casino).
// Quién puede AVISAR UN PAGO desde la pantalla del cliente. Arranca en 1 para no cambiarle el
// comportamiento a nadie al desplegar; se apaga por cliente (o a todos de una) desde el OS.
ensureColumns('clientes', { avisa_pagos: 'INTEGER DEFAULT 1' });

ensureColumns('paneles', { conexion_id: 'TEXT' });
// El sistema de pedidos escribe el nombre del panel a su manera —"463.life" donde el OS tiene
// "463.live"— y por una letra el pedido no cruza con ningún panel: se le termina facturando al
// dueño del código en vez de a quien recibió las fichas. `alias` deja registrar esas otras formas
// sin tener que renombrar nada en el casino, que es donde el nombre no lo elegimos nosotros.
ensureColumns('paneles', { alias: 'TEXT' });   // JSON array de nombres alternativos

/* A QUIÉN SE LE COBRA lo que entra a este panel. Tres valores, y ninguno se adivina:
   · 'codigo'  (por defecto) — al cliente del código del pedido. Es lo que venía haciendo el
                sistema y lo correcto cuando el panel es de la misma persona con otra cuenta:
                Marcelo carga en los paneles de JJ y JJ *es* Marcelo; Fran en los de Ariel, igual.
   · 'dueno'   — al cliente dueño del panel, sin importar con qué código se pidió. Caso Rafael-SA:
                entró con el código de Alexa y se le cobra a Rafael.
   · 'ninguno' — no genera deuda. Son los paneles de tránsito de un vendedor, por donde bajan las
                fichas hacia sus clientes: RMIglatamAlexa e IgLatamAlexa. Cobrar ahí sería cobrar
                dos veces la misma entrega.
   Decisión de la dueña, 3-sep-2026. El default deja el comportamiento anterior intacto: sólo
   cambia lo que se marque a mano. */
ensureColumns('paneles', { consumo_a: 'TEXT' });

// ¿Este panel entra en la Foto del mes? La Foto existe para no tener que preguntarle al casino en
// vivo cuando se saca el reporte de externos. Sacar un panel de la Foto NO rompe nada: su reporte
// sigue saliendo, sólo que preguntando en vivo — más lento y puede fallar, que es exactamente lo
// que dice el cartel de la pantalla. Por eso se puede elegir panel por panel.
// NULL = sí (los 201 que ya existían siguen entrando, nadie se queda afuera por una migración).
ensureColumns('paneles', { en_foto: 'INTEGER' });

// ── QUÉ CONEXIÓN SE USA PARA CARGAR FICHAS ────────────────────────────────────────────────────
// `carga_de` guarda el nombre del SISTEMA al que sirve esa conexión para cargar ("Casino", "Europa"):
// el mismo texto que tiene la caja del cliente. Vacío = esa conexión sólo lee (reportes, la Foto).
//
// Hace falta porque son cuentas DISTINTAS del casino a propósito: Alexa_support es de sólo lectura
// —no puede ni agregar una divisa— y para bajar fichas hace falta un usuario con ese permiso. Antes
// las de carga vivían en otra tabla y había que cargar las credenciales dos veces.
//
// Se guarda el sistema y NO se deduce del nombre: "Casino_Fichas" empieza con "Casino" pero
// "Casino Dark" también, y una conexión mal elegida carga fichas en el panel equivocado.
ensureColumns('casino_conexiones', { carga_de: 'TEXT' });

/* ───── SOLICITUDES PARA ABRIR UNA CAJA ─────
   El que despacha se entera antes que nadie de que un cliente necesita una caja nueva, pero no
   puede crearla: eso mueve plata (una caja es un destino al que se le cargan fichas) y define a
   quién se le factura. Así que la pide, y el dueño aprueba.

   Se guarda el NODO del casino, que es la identidad real de la cuenta. El nombre lo escribe cada
   sistema distinto — "463.life" vs "463.live" — y por un nombre mal tipeado la ficha va a otro lado. */
db.exec(`CREATE TABLE IF NOT EXISTS solicitud_caja (
  id TEXT PRIMARY KEY,
  cliente_id TEXT,              -- a quién se le abre; puede ser el vendedor mismo
  sistema TEXT,                 -- Casino | Europa
  nodo TEXT,                    -- el id del casino: la identidad de verdad
  login TEXT,                   -- cómo se llama en el panel
  nota TEXT,
  estado TEXT DEFAULT 'pendiente',   -- pendiente | aprobada | rechazada
  pedida_por TEXT,              -- 'operador' | 'admin'
  creada_at TEXT,
  resuelta_at TEXT,
  motivo TEXT,                  -- por qué se rechazó, o qué se creó al aprobar
  panel_id TEXT                 -- el panel que quedó, si se aprobó
)`);

// Jerarquía REAL del panel en el casino (SuperAgente → Distribuidor → Agente). Hace falta para
// cargar: las fichas se bajan nivel por nivel, así que hay que saber por qué padres pasar.
// Lo resuelve arbol.service.js contra el árbol del casino; no se carga a mano.
ensureColumns('paneles', {
  padre_id: 'TEXT', padre_login: 'TEXT', padre_nivel: 'TEXT',
  sa_id: 'TEXT', sa_login: 'TEXT',
  escala: 'TEXT',        // JSON [{id,login,nivel}] desde el SuperAgente hasta el padre directo
  arbol_at: 'TEXT',      // cuándo se resolvió (para saber si está vieja)
});

// PARTICIPANTES del reparto (§12 del addendum v3). La tabla se llamaba "personas" cuando el
// reparto era en dos pasos y la Empresa vivía aparte, en split_base. Ahora la Empresa es una
// fila más del catálogo, y el flag la distingue: es la casa, no un socio, y no se borra.
ensureColumns('personas', { es_empresa: 'INTEGER DEFAULT 0' });

// Conexiones: auth dual (token O usuario/contraseña, ambos cifrados).
// `motor` dice con qué CLIENTE hablarle. Hasta el 4-ago se asumía que todas eran del engine
// 463.life (Casino y Europa); TBS es otro producto y con el cliente de siempre devolvía
// "usuario o contraseña incorrectos" sin haber probado nunca las credenciales.
//   '463' (default) → src/casino-api.js   ·   'tbs' → src/tbs-api.js
ensureColumns('casino_conexiones', { usuario: 'TEXT', password: 'TEXT', motor: "TEXT DEFAULT '463'" });

// Proveedores: % que se cobra al cliente + código del gamesSystem (para importar del casino).
ensureColumns('proveedores', { tarifa_pct: 'TEXT', codigo: 'TEXT' });

// Reporte diario MULTI-MONEDA: columna moneda + índice único que la incluye (misma cuenta/día en varias monedas).
ensureColumns('reporte_diario', { moneda: "TEXT DEFAULT 'ARS'" });
// El MODO con el que el casino estaba agrupando cuando se sacó la foto. Cambia los números:
// verificado sobre el mismo nodo y mes, superagente dio 480.187,11 y dealer 480.378,36 — la vista
// de superagente venía incompleta. Sin guardarlo, un mes con las dos mitades sacadas en modos
// distintos parecería consistente.
ensureColumns('estad_captura', { modo: 'TEXT' });
// De dónde salió un movimiento. Si lo generó una emisión mensual lleva `origen`
// ('facturacion' | 'externos') y `origen_ref` (el mes). Cargado a mano quedan en NULL.
// `tc_modo='mes'` = el pago se valúa con el tipo de cambio del mes, que puede no estar cargado
// todavía. La cara que falta NO se guarda: se deriva al leer (ver src/valuacion.js), así el día
// que se carga el TC del cierre todos los pagos que esperaban pasan a valer lo correcto solos.
/* `mes_cierre`: a QUÉ MES entra este movimiento, que no es lo mismo que cuándo pasó. Un cliente
   puede pagar el 2 de septiembre algo que corresponde al cierre de agosto. Antes había una sola
   fecha y el mes se deducía de ella: para mandar ese pago a agosto había que MENTIR la fecha, y se
   perdía el dato de cuándo entró de verdad. Son dos cosas distintas — la fecha es un hecho, el mes
   de cierre es una decisión— y ahora se guardan por separado. Vacío = el mes de la fecha. */
ensureColumns('movimientos', { origen: 'TEXT', origen_ref: 'TEXT', medio: 'TEXT', tc_modo: 'TEXT', mes_cierre: 'TEXT' });
// 🔒 EL CANDADO CONTRA EL DOBLE COBRO, en la BASE y no en el código: un cliente no puede
// tener dos movimientos del mismo origen para el mismo mes. Es PARCIAL (solo donde origen no
// es nulo) para no tocar nada de lo cargado a mano, que puede repetirse legítimamente.
db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ux_mov_emision
         ON movimientos (cliente_id, origen, origen_ref) WHERE origen IS NOT NULL;`);
db.exec('DROP INDEX IF EXISTS idx_repdia');
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_repdia ON reporte_diario(conexion_id, fecha, grp, sa_id, moneda)');

/* ───── DOCUMENTOS EMITIDOS ─────
   Una copia CONGELADA de un documento en el momento en que se emitió.

   El problema que resuelve, con las palabras del dueño: "quiero siempre poder acceder a EXACTAMENTE
   lo mismo que envié". Un reporte que se vuelve a calcular no sirve para eso — el mes puede
   descongelarse, un costo puede cargarse, un TC puede corregirse, y el documento que abre en
   diciembre ya no es el que mandó en agosto. Y él no tiene forma de saber cuál de los dos vio el
   proveedor.

   Por eso se guardan LOS BYTES del HTML, no una receta para volver a armarlo. El HTML es lo que se
   imprimió y lo que se mandó; si el generador cambia tres veces en el año, este archivo no se
   entera. El JSON va al lado para poder auditar de dónde salió cada número y regenerar el CSV, que
   es una proyección del mismo dato y no otro documento.

   Es de sólo agregar: no hay UPDATE ni DELETE. Emitir de nuevo el mismo mes crea otra VERSIÓN y
   deja la anterior intacta — pisar la copia de lo que ya se envió es exactamente lo que este
   archivo existe para impedir. */
db.exec(`CREATE TABLE IF NOT EXISTS documento_emitido (
  id TEXT PRIMARY KEY,
  tipo TEXT NOT NULL,            -- 'pago-proveedores' (hoy el único)
  mes TEXT NOT NULL,             -- YYYY-MM
  version INTEGER NOT NULL,      -- 1, 2, 3… por (tipo, mes). Nunca se reusa.
  emitido_at TEXT NOT NULL,
  emitido_por TEXT,
  total_usdt TEXT,               -- TEXT: la convención de plata de toda la base
  hash TEXT NOT NULL,            -- sha256 del html guardado, para probar que no se tocó
  html TEXT NOT NULL,            -- los bytes exactos que se imprimieron y se mandaron
  datos TEXT NOT NULL,           -- el reporte en JSON: auditoría y CSV
  nota TEXT
);`);
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS ux_doc_ver ON documento_emitido(tipo, mes, version)');
db.exec('CREATE INDEX IF NOT EXISTS ix_doc_mes ON documento_emitido(tipo, mes)');
/* El candado del "sólo agregar", en la BASE y no en un `if`.
   El módulo no tiene UPDATE ni DELETE, pero el módulo se puede cambiar dentro de seis meses por
   alguien apurado; la tabla no. No es a prueba de quien tenga acceso al volumen —puede dropear el
   trigger— pero sí de la forma en que esto se rompe de verdad: una línea de código nueva. */
db.exec(`CREATE TRIGGER IF NOT EXISTS tr_doc_no_update BEFORE UPDATE ON documento_emitido
  BEGIN SELECT RAISE(ABORT, 'un documento emitido no se modifica: emití una versión nueva'); END;`);
db.exec(`CREATE TRIGGER IF NOT EXISTS tr_doc_no_delete BEFORE DELETE ON documento_emitido
  BEGIN SELECT RAISE(ABORT, 'un documento emitido no se borra'); END;`);

/* ───── MOVER FICHAS DE UN PANEL A OTRO DEL MISMO CLIENTE ─────
   El cliente lo pide, la dueña lo aprueba, y recién ahí se ejecuta. Mover fichas cambia dónde está
   el saldo y, si un panel es de un vendedor y el otro no, cambia a quién se le factura.

   Se guardan las DOS MITADES por separado (detalle_retiro y detalle_carga) porque son dos
   operaciones distintas contra el casino y pueden terminar distinto. El estado 'retirado' es el
   "quedó a medias": salió el retiro y falta la carga, con las fichas en la cuenta con la que
   cargamos — que es nuestra, así que no se perdieron. Ver src/movimientos-panel.js. */
db.exec(`CREATE TABLE IF NOT EXISTS movimiento_panel (
  id TEXT PRIMARY KEY,
  cliente_id TEXT,
  origen_panel_id TEXT,
  destino_panel_id TEXT,
  divisa TEXT,
  monto TEXT,                    -- TEXT: la convención de plata de toda la base
  nota TEXT,
  estado TEXT DEFAULT 'pendiente',  -- pendiente | ejecutando | retirado | hecho | rechazado
  desde_estado TEXT,             -- de qué estado se tomó el lock, para poder devolverlo ahí
  pedido_por TEXT, aprobado_por TEXT,
  creado_at TEXT, tomado_at TEXT, retirado_at TEXT, hecho_at TEXT, resuelto_at TEXT,
  detalle_retiro TEXT, detalle_carga TEXT,   -- lo que contestó el casino en cada mitad
  motivo TEXT, error TEXT
);`);
db.exec('CREATE INDEX IF NOT EXISTS ix_movpanel_estado ON movimiento_panel(estado, creado_at)');
db.exec('CREATE INDEX IF NOT EXISTS ix_movpanel_cli ON movimiento_panel(cliente_id)');

/* Lo que se agregó después de la primera versión de la tabla.
   · congelado    — si el mes tenía la foto de precios puesta al emitir. Un mes SIN congelar usa los
                    precios de hoy, así que el mismo mes puede dar otro número el mes que viene. El
                    documento no cambia (son bytes), pero hay que poder ver que salió de ahí.
   · datos_hash   — sha256 del JSON. Sirve para no crear versiones gemelas: dos clics seguidos, o
                    emitir tres días seguidos sin que haya entrado nada nuevo, no son dos documentos.
   · csv          — la planilla congelada. Se guarda y no se regenera porque csv() puede ganar una
                    columna mañana, y ahí la conciliación de un mes viejo se corre sola. */
ensureColumns('documento_emitido', { congelado: 'INTEGER', datos_hash: 'TEXT', csv: 'TEXT' });

/* Los pasos de la cadena de un movimiento, guardados DESPUÉS DE CADA UNO.
   Sin esto, reintentar un movimiento a medias vuelve a recorrer los eslabones que ya salieron —
   y en una cadena que retira y carga, repetir no es cargar de más: es descuadrar dos cuentas. */
ensureColumns('movimiento_panel', { pasos: 'TEXT' });

/* Si el aviso del comprobante llegó al grupo, y si no, por qué.
   Antes esto era un console.warn que se perdía entre despliegues: un comprobante no llegaba al
   grupo y no había forma de saber si el problema era el id, el bot o el permiso. Guardarlo es lo
   que permite verlo en la pantalla y reintentarlo en vez de descubrirlo por un reclamo. */
// Un pago genera DOS avisos a dos grupos distintos: el de cobranzas (con la foto, para controlar)
// y el del cliente (para que sepa que llegó). Se siguen por separado porque fallan por separado:
// que el bot esté en un grupo no dice nada de si está en el otro.
ensureColumns('comprobantes', { aviso_ok: 'INTEGER', aviso_error: 'TEXT', aviso_at: 'TEXT',
  aviso_cli_ok: 'INTEGER', aviso_cli_error: 'TEXT', aviso_cli_at: 'TEXT' });

/* En qué MONEDA se lleva la cuenta corriente de un cliente: 'USDT' (lo normal) o 'ARS'.
   Vacío = USDT, que es como estaban los 45 clientes el día que esto se agregó.

   NO se reusó `moneda_cobro`, que ya existía: ese vino de la planilla y tiene valores 'cvu',
   'usdt', 'variable', 'no_aplica' y doce vacíos — describe CÓMO paga el cliente (por CVU, en
   cripto), no en qué moneda se le lleva la cuenta. Son dos preguntas distintas y meterlas en el
   mismo campo hace que la respuesta a una rompa la otra. */
ensureColumns('clientes', { moneda_cuenta: 'TEXT' });

/* La CUENTA PROPIA de un cliente: usuario y contraseña para ver su saldo y su factura.
   No la tienen todos, y está bien que no: la mayoría sólo pide fichas y ahí el código alcanza.
   `acceso_clave` guarda `sal:scrypt(clave)` — nunca la clave. Ver src/cliente-acceso.js. */
ensureColumns('clientes', {
  acceso_habilitado: 'INTEGER',
  acceso_usuario: 'TEXT',
  acceso_clave: 'TEXT',
  acceso_at: 'TEXT',
  // Desde cuándo vale un token de ese cliente: cambiarle la clave o sacarle el acceso corta las
  // sesiones que ya tenía abiertas, en vez de dejarlas vivas hasta que venzan solas.
  acceso_corte: 'INTEGER',
});
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS ux_cliente_acceso ON clientes(lower(acceso_usuario)) WHERE acceso_usuario IS NOT NULL');

module.exports = { db, DB_PATH, ensureColumns };
