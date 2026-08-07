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

// ¿Este panel entra en la Foto del mes? La Foto existe para no tener que preguntarle al casino en
// vivo cuando se saca el reporte de externos. Sacar un panel de la Foto NO rompe nada: su reporte
// sigue saliendo, sólo que preguntando en vivo — más lento y puede fallar, que es exactamente lo
// que dice el cartel de la pantalla. Por eso se puede elegir panel por panel.
// NULL = sí (los 201 que ya existían siguen entrando, nadie se queda afuera por una migración).
ensureColumns('paneles', { en_foto: 'INTEGER' });

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
ensureColumns('movimientos', { origen: 'TEXT', origen_ref: 'TEXT', medio: 'TEXT' });
// 🔒 EL CANDADO CONTRA EL DOBLE COBRO, en la BASE y no en el código: un cliente no puede
// tener dos movimientos del mismo origen para el mismo mes. Es PARCIAL (solo donde origen no
// es nulo) para no tocar nada de lo cargado a mano, que puede repetirse legítimamente.
db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ux_mov_emision
         ON movimientos (cliente_id, origen, origen_ref) WHERE origen IS NOT NULL;`);
db.exec('DROP INDEX IF EXISTS idx_repdia');
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_repdia ON reporte_diario(conexion_id, fecha, grp, sa_id, moneda)');

module.exports = { db, DB_PATH, ensureColumns };
