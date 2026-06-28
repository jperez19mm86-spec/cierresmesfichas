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

  /* ───── TIPOS DE CAMBIO ───── */
  CREATE TABLE IF NOT EXISTS tc_snapshots (
    id TEXT PRIMARY KEY,
    fecha TEXT,                   -- YYYY-MM-DD
    hora TEXT,                    -- HH:mm
    tc_ars_usdt TEXT,           -- decimal string
    fuente TEXT,
    createdAt TEXT
  );
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
    captured_at TEXT
  );

  /* ───── CONEXIONES AL CASINO (api_token, genérico/multi-master) ───── */
  CREATE TABLE IF NOT EXISTS casino_conexiones (
    id TEXT PRIMARY KEY,
    nombre TEXT,              -- ej "463.life (dev)"
    url TEXT,                 -- https://admin.463.life
    token TEXT,               -- api_token CIFRADO (crypto-util)
    activa INTEGER DEFAULT 1,
    createdAt TEXT, ord INTEGER
  );

  /* índices útiles */
  CREATE INDEX IF NOT EXISTS idx_paneles_cliente ON paneles(cliente_id);
  CREATE INDEX IF NOT EXISTS idx_part_cliente ON participaciones(cliente_id);
  CREATE INDEX IF NOT EXISTS idx_mov_cliente ON movimientos(cliente_id);
  CREATE INDEX IF NOT EXISTS idx_mov_fecha ON movimientos(fecha);
  CREATE INDEX IF NOT EXISTS idx_cv_entidad ON config_valores(entidad_tipo, entidad_id, campo);
  CREATE INDEX IF NOT EXISTS idx_snap_fecha ON tc_snapshots(fecha);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_repdia ON reporte_diario(conexion_id, fecha, grp, sa_id);
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
  mezcla_pago_usdt: 'TEXT',               // decimal string %
  ajuste_usdt_pct: 'TEXT',                // decimal string %
  fecha_alta: 'TEXT',
});

// Cada PANEL puede linkearse a un nodo del casino (qué conexión + qué id de usuario del casino).
ensureColumns('paneles', { conexion_id: 'TEXT' });

// Conexiones: auth dual (token O usuario/contraseña, ambos cifrados).
ensureColumns('casino_conexiones', { usuario: 'TEXT', password: 'TEXT' });

// Proveedores: % que se cobra al cliente + código del gamesSystem (para importar del casino).
ensureColumns('proveedores', { tarifa_pct: 'TEXT', codigo: 'TEXT' });

module.exports = { db, DB_PATH, ensureColumns };
