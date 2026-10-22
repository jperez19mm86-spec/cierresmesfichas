/**
 * clientes-store.js — CLIENTES (relación comercial) + sus CAJAS operativas (MATRIZ).
 *
 * MATRIZ: codigo (L210), nombreVisible (Lu), cajas[], telegram (aviso de carga).
 * OS v3 (sección 2.1): + estado, paga_proveedores, permite_deuda, mezcla_pago_usdt, ajuste_usdt_pct, fecha_alta.
 *   ⚠️ precio_base_pct NO vive acá: es versionado (config_valores, vía historial.js).
 *
 * Caja = { id, usuario, sistema, userId, divisas[], montosRapidos[], grupoId, notas } (flujo /pedir intacto).
 */
const crypto = require('crypto');
const { db } = require('./db');

const FILE = 'sqlite:clientes';
const num = (v) => (v === null || v === undefined ? null : Number(v));

/* En qué divisas puede pagar un cliente. Devuelve ['ARS'], ['USDT'] o ['ARS','USDT']; null = las
   dos (sin elegir, que es como estaban todos). Acepta array o texto «ARS,USDT». */
function normDivisasPago(v) {
  if (v == null || v === '') return null;
  const xs = (Array.isArray(v) ? v : String(v).split(',')).map((x) => String(x).trim().toUpperCase())
    .filter((x) => x === 'ARS' || x === 'USDT');
  const u = ['ARS', 'USDT'].filter((x) => xs.includes(x));
  return u.length && u.length < 2 ? u : (u.length === 2 ? u : null);
}

/* ── LAS COLUMNAS, ESCRITAS UNA SOLA VEZ ─────────────────────────────────────────────────────
   Cada fila es [columna de la tabla, cómo se lee al objeto, cómo se guarda desde el objeto], en el
   orden en que el objeto tiene sus claves. load() y el guardado salen de esta misma lista: antes
   eran dos listas a mano y una columna que faltaba en una se perdía para TODOS los clientes en el
   próximo guardado (pasó con externos_modo y con el acceso). `ord` no va acá: es el orden de la
   lista y lo maneja el guardado. test/clientes-de-a-uno.js compara esta lista con la tabla real. */
const nn = (v) => (v != null && v !== '' ? String(v) : null);
const sino = (v) => (v ? 1 : 0);
const tcCar = (v) => (v === 'promedio' || v === 'momento' ? v : null);
const COLUMNAS = [
  ['id', (r) => r.id, (c) => c.id],
  ['codigo', (r) => r.codigo, (c) => c.codigo],
  ['nombreVisible', (r) => r.nombreVisible, (c) => c.nombreVisible || ''],
  ['createdAt', (r) => r.createdAt, (c) => c.createdAt || null],
  ['telegram', (r) => {
    let t = { chatId: '', enabled: false };
    try { if (r.telegram) t = JSON.parse(r.telegram); } catch (e) {}
    if (!t) t = { chatId: '', enabled: false };
    if (!Array.isArray(t.copias)) t.copias = [];
    return t;
  }, (c) => JSON.stringify(c.telegram || { chatId: '', enabled: false })],
  ['cajas', (r) => { let k = []; try { if (r.cajas) k = JSON.parse(r.cajas); } catch (e) {} return k; },
    (c) => JSON.stringify(c.cajas || [])],
  // comercial (OS v3)
  ['nombre', (r) => r.nombre || r.nombreVisible || '', (c) => c.nombre || c.nombreVisible || ''],
  ['estado', (r) => r.estado || 'activo', (c) => c.estado || 'activo'],
  ['paga_proveedores', (r) => !!r.paga_proveedores, (c) => sino(c.paga_proveedores)],
  ['permite_deuda', (r) => !!r.permite_deuda, (c) => sino(c.permite_deuda)],
  ['mezcla_pago_usdt', (r) => r.mezcla_pago_usdt || null, (c) => nn(c.mezcla_pago_usdt)],
  ['ajuste_usdt_pct', (r) => r.ajuste_usdt_pct || null, (c) => nn(c.ajuste_usdt_pct)],
  ['fecha_alta', (r) => r.fecha_alta || r.createdAt || null, (c) => c.fecha_alta || c.createdAt || null],
  // v3.0 ficha de cliente
  ['divisa_fichas', (r) => r.divisa_fichas || null, (c) => nn(c.divisa_fichas)],
  ['moneda_cobro', (r) => r.moneda_cobro || null, (c) => nn(c.moneda_cobro)],
  ['momento_pago', (r) => r.momento_pago || null, (c) => nn(c.momento_pago)],
  ['disparador', (r) => r.disparador || null, (c) => nn(c.disparador)],
  ['tc_aplicar', (r) => r.tc_aplicar || null, (c) => nn(c.tc_aplicar)],
  ['tc_proveedor', (r) => r.tc_proveedor || null, (c) => nn(c.tc_proveedor)],
  // v3.0 §7-10 (planilla)
  ['mover_balance', (r) => !!r.mover_balance, (c) => sino(c.mover_balance)],
  /* El acceso viaja acá aunque nadie lo lea de este objeto: lo escribe src/cliente-acceso.js con
     su propio UPDATE. `acceso_clave` es el hash, nunca la clave, y no se muestra en ningún lado. */
  ['acceso_habilitado', (r) => (r.acceso_habilitado ? 1 : 0), (c) => sino(c.acceso_habilitado)],
  ['acceso_usuario', (r) => r.acceso_usuario || null, (c) => nn(c.acceso_usuario)],
  ['acceso_clave', (r) => r.acceso_clave || null, (c) => nn(c.acceso_clave)],
  ['acceso_at', (r) => r.acceso_at || null, (c) => nn(c.acceso_at)],
  ['acceso_corte', (r) => (r.acceso_corte != null ? Number(r.acceso_corte) : null),
    (c) => (c.acceso_corte != null ? Number(c.acceso_corte) : null)],
  // Vacío = USDT: es como estaban todos antes de que esto existiera.
  ['moneda_cuenta', (r) => (r.moneda_cuenta === 'ARS' ? 'ARS' : 'USDT'), (c) => (c.moneda_cuenta === 'ARS' ? 'ARS' : 'USDT')],
  // A qué billetera paga. Vacío = la principal, que es lo que había con una sola dirección.
  ['billetera_id', (r) => r.billetera_id || null, (c) => nn(c.billetera_id)],
  ['margen_externos_pct', (r) => r.margen_externos_pct || null, (c) => nn(c.margen_externos_pct)],
  ['es_vendedor', (r) => !!r.es_vendedor, (c) => sino(c.es_vendedor)],
  ['externos_modo', (r) => r.externos_modo || null, (c) => nn(c.externos_modo)],
  ['vendedor_id', (r) => r.vendedor_id || null, (c) => nn(c.vendedor_id)],
  ['factura_a', (r) => r.factura_a || null, (c) => nn(c.factura_a)],
  ['internos_se_cobran', (r) => !!r.internos_se_cobran, (c) => sino(c.internos_se_cobran)],
  ['externos_precios_de', (r) => r.externos_precios_de || null, (c) => nn(c.externos_precios_de)],
  ['avisa_pagos', (r) => (r.avisa_pagos == null ? true : !!r.avisa_pagos), (c) => (c.avisa_pagos === false ? 0 : 1)],
  ['prepago', (r) => !!r.prepago, (c) => sino(c.prepago)],
  ['prepago_margen_pct', (r) => r.prepago_margen_pct || null, (c) => nn(c.prepago_margen_pct)],
  ['divisas_pago', (r) => normDivisasPago(r.divisas_pago), (c) => (normDivisasPago(c.divisas_pago) || []).join(',') || null],
  ['abona_a', (r) => r.abona_a || null, (c) => nn(c.abona_a)],
  ['abona_pts', (r) => r.abona_pts || null, (c) => nn(c.abona_pts)],
  ['tc_cargas', (r) => tcCar(r.tc_cargas), (c) => tcCar(c.tc_cargas)],
  ['tope_deuda', (r) => r.tope_deuda || null, (c) => nn(c.tope_deuda)],
  ['saldo_inicial', (r) => r.saldo_inicial || null, (c) => nn(c.saldo_inicial)],
  ['saldo_inicial_divisa', (r) => r.saldo_inicial_divisa || null, (c) => nn(c.saldo_inicial_divisa)],
  ['saldo_inicial_mov_id', (r) => r.saldo_inicial_mov_id || null, (c) => nn(c.saldo_inicial_mov_id)],
];
const NOMBRES = COLUMNAS.map(([col]) => col);

function deFila(r) {
  const c = {};
  for (const [col, leer] of COLUMNAS) c[col] = leer(r);
  return c;
}
function aFila(c) {
  const f = {};
  for (const [col, , guardar] of COLUMNAS) f[col] = guardar(c);
  return f;
}

function load() {
  return { clientes: db.prepare('SELECT * FROM clientes ORDER BY ord ASC').all().map(deFila) };
}

/* ── EL CLIENTE SE GUARDA DE A UNO ──────────────────────────────────────────────────────────
   Antes cada guardado borraba la tabla entera y volvía a insertar a todos. Ahora se escribe sólo
   la fila del cliente que cambió; los demás no se tocan, y una columna que esta lista no conozca
   queda como estaba en vez de pasar a NULL. Un cliente nuevo va al final de la lista. */
const _upsert = db.prepare(`INSERT INTO clientes (${NOMBRES.join(',')},ord)
  VALUES (${NOMBRES.map((n) => '@' + n).join(',')},@ord)
  ON CONFLICT(id) DO UPDATE SET ${NOMBRES.filter((n) => n !== 'id').map((n) => `${n}=excluded.${n}`).join(',')}`);
const _proxOrd = db.prepare('SELECT COALESCE(MAX(ord), -1) + 1 AS n FROM clientes');
function saveCliente(c) { _upsert.run({ ...aFila(c), ord: _proxOrd.get().n }); }

/* La lista ENTERA (restaurar una copia, importar la planilla): queda exactamente esa lista. Se
   escriben sólo las filas que cambiaron, se borran las que no vienen, y el orden es el de la lista. */
const _saveTx = db.transaction((data) => {
  const lista = data.clientes || [];
  const antes = new Map(db.prepare('SELECT * FROM clientes').all().map((r) => [r.id, r]));
  const vienen = new Set(lista.map((c) => c.id));
  const del = db.prepare('DELETE FROM clientes WHERE id=?');
  for (const id of antes.keys()) if (!vienen.has(id)) del.run(id);
  const setOrd = db.prepare('UPDATE clientes SET ord=? WHERE id=?');
  lista.forEach((c, i) => {
    const f = aFila(c); const r = antes.get(c.id);
    if (!r) { _upsert.run({ ...f, ord: i }); return; }
    if (NOMBRES.some((n) => f[n] !== r[n])) _upsert.run({ ...f, ord: i });
    if (r.ord !== i) setOrd.run(i, c.id);
  });
});
function save(data) { _saveTx(data); }

// ── helpers de parseo ──
function parseMontos(v) {
  if (Array.isArray(v)) return v.map((n) => Number(n)).filter((n) => !isNaN(n) && n > 0);
  return String(v || '').split(/[,;\s]+/).map((s) => Number(String(s).replace(/[^\d.]/g, ''))).filter((n) => !isNaN(n) && n > 0);
}
function parseDivisas(v) {
  if (Array.isArray(v)) return v.map((s) => String(s).trim().toUpperCase()).filter(Boolean);
  return String(v || '').split(/[,;\s]+/).map((s) => s.trim().toUpperCase()).filter(Boolean);
}
function newId(prefix) { return prefix + '_' + crypto.randomBytes(5).toString('hex'); }

// ─────────── Clientes ───────────
function list() { return load(); }
function get(id) { return load().clientes.find((c) => c.id === id) || null; }
function getByCodigo(codigo) {
  const cod = String(codigo || '').trim();
  return load().clientes.find((c) => String(c.codigo).toLowerCase() === cod.toLowerCase()) || null;
}

function createCliente({ codigo, nombreVisible, nombre }) {
  const data = load();
  const cod = String(codigo || '').trim();
  if (!cod) throw new Error('codigo requerido');
  if (data.clientes.some((c) => String(c.codigo).toLowerCase() === cod.toLowerCase())) {
    throw new Error(`Ya existe un cliente con código "${cod}"`);
  }
  const nom = String(nombre || nombreVisible || '').trim();
  const cliente = {
    id: newId('c'), codigo: cod, nombreVisible: String(nombreVisible || nom).trim(),
    createdAt: new Date().toISOString(), telegram: { chatId: '', enabled: false }, cajas: [],
    nombre: nom, estado: 'activo', paga_proveedores: false, permite_deuda: false,
    mezcla_pago_usdt: null, ajuste_usdt_pct: null, fecha_alta: new Date().toISOString().slice(0, 10),
    mover_balance: false, margen_externos_pct: null, es_vendedor: false, vendedor_id: null,
    factura_a: null, externos_precios_de: null, avisa_pagos: true, saldo_inicial: null, saldo_inicial_divisa: null, saldo_inicial_mov_id: null,
  };
  saveCliente(cliente); return cliente;
}

function updateCliente(id, patch) {
  const data = load();
  const c = data.clientes.find((x) => x.id === id);
  if (!c) return null;
  if (patch.codigo !== undefined) {
    const cod = String(patch.codigo).trim();
    if (cod && data.clientes.some((x) => x.id !== id && String(x.codigo).toLowerCase() === cod.toLowerCase())) {
      throw new Error(`Ya existe otro cliente con código "${cod}"`);
    }
    if (cod) c.codigo = cod;
  }
  if (patch.nombreVisible !== undefined) c.nombreVisible = String(patch.nombreVisible).trim();
  if (patch.nombre !== undefined) c.nombre = String(patch.nombre).trim();
  saveCliente(c); return c;
}

/** Campos comerciales del OS v3 (NO precio_base, que va por historial). */
function updateComercial(id, patch) {
  const data = load();
  const c = data.clientes.find((x) => x.id === id);
  if (!c) return null;
  if (patch.nombre !== undefined) c.nombre = String(patch.nombre).trim();
  if (patch.estado !== undefined) c.estado = String(patch.estado).trim() || 'activo';
  if (patch.paga_proveedores !== undefined) c.paga_proveedores = !!patch.paga_proveedores;
  if (patch.permite_deuda !== undefined) c.permite_deuda = !!patch.permite_deuda;
  if (patch.mezcla_pago_usdt !== undefined) c.mezcla_pago_usdt = patch.mezcla_pago_usdt === '' ? null : String(patch.mezcla_pago_usdt);
  if (patch.ajuste_usdt_pct !== undefined) c.ajuste_usdt_pct = patch.ajuste_usdt_pct === '' ? null : String(patch.ajuste_usdt_pct);
  // ── v3.0 ficha de cliente ──
  ['divisa_fichas', 'moneda_cobro', 'momento_pago', 'disparador', 'tc_aplicar', 'tc_proveedor',
    'saldo_inicial', 'saldo_inicial_divisa', 'saldo_inicial_mov_id', 'margen_externos_pct', 'vendedor_id', 'externos_modo',
    'factura_a', 'externos_precios_de'].forEach((k) => {
    if (patch[k] !== undefined) c[k] = patch[k] === '' ? null : String(patch[k]).trim();
  });
  // Sí/no: con String(), un `false` quedaba «"false"» y se guardaba como 1 (se cobraban SL/SL2/XG).
  if (patch.internos_se_cobran !== undefined) c.internos_se_cobran = [true, 1, '1', 'true', 'si', 'sí'].includes(typeof patch.internos_se_cobran === 'string' ? patch.internos_se_cobran.trim().toLowerCase() : patch.internos_se_cobran);
  // A qué billetera paga. Vacío = la principal.
  if (patch.billetera_id !== undefined) c.billetera_id = patch.billetera_id === '' ? null : String(patch.billetera_id).trim();
  if (patch.mover_balance !== undefined) c.mover_balance = !!patch.mover_balance;
  if (patch.moneda_cuenta !== undefined) c.moneda_cuenta = (String(patch.moneda_cuenta).toUpperCase() === 'ARS' ? 'ARS' : 'USDT');
  if (patch.es_vendedor !== undefined) c.es_vendedor = !!patch.es_vendedor;
  if (patch.avisa_pagos !== undefined) c.avisa_pagos = !!patch.avisa_pagos;
  if (patch.prepago !== undefined) c.prepago = !!patch.prepago;
  if (patch.prepago_margen_pct !== undefined) {
    const m = String(patch.prepago_margen_pct).replace(',', '.').trim();
    c.prepago_margen_pct = m === '' || !(Number(m) >= 0) ? null : String(Math.min(Number(m), 100));
  }
  if (patch.divisas_pago !== undefined) c.divisas_pago = normDivisasPago(patch.divisas_pago);
  if (patch.abona_a !== undefined) c.abona_a = patch.abona_a === '' || patch.abona_a == null ? null : String(patch.abona_a).trim();
  if (patch.abona_pts !== undefined) {
    const v = String(patch.abona_pts == null ? '' : patch.abona_pts).replace(',', '.').trim();
    c.abona_pts = v === '' || !(Number(v) > 0) ? null : String(Number(v));
  }
  if (patch.tc_cargas !== undefined) c.tc_cargas = patch.tc_cargas === 'promedio' || patch.tc_cargas === 'momento' ? patch.tc_cargas : null;
  if (patch.tope_deuda !== undefined) {
    const n = require('./lib/monto').parseMonto(patch.tope_deuda);   // «1.500.000» y «1500,5» como los tipea una persona
    c.tope_deuda = n && n > 0 ? String(n) : null;
  }
  saveCliente(c); return c;
}

/**
 * CON QUÉ CAMBIO SE PASAN SUS CARGAS A DÓLARES (regla del dueño, 18-oct-2026).
 *  · 'promedio' — se le manda la cuenta a fin de mes: cada carga vale con el promedio del mes de
 *    su moneda, y mientras el mes está abierto es provisoria.
 *  · 'momento'  — va pagando durante el mes: cada carga vale con el cambio del momento en que se hizo.
 * Sin elegir: prepago o «anticipado» (planilla) → momento; el resto → promedio.
 * Una cuenta en pesos no pasa sus cargas en pesos a nada: se le debita en pesos.
 */
function tcCargasDe(c) {
  if (!c) return 'promedio';
  if (c.tc_cargas === 'promedio' || c.tc_cargas === 'momento') return c.tc_cargas;
  return c.prepago || String(c.momento_pago || '').toLowerCase() === 'anticipado' ? 'momento' : 'promedio';
}

function removeCliente(id) {
  return db.prepare('DELETE FROM clientes WHERE id=?').run(id).changes > 0;
}

function setTelegram(id, patch) {
  const data = load();
  const c = data.clientes.find((x) => x.id === id);
  if (!c) return null;
  if (!c.telegram) c.telegram = { chatId: '', enabled: false };
  if (patch.chatId !== undefined) c.telegram.chatId = String(patch.chatId).trim();
  if (patch.enabled !== undefined) c.telegram.enabled = !!patch.enabled;
  /* COPIAS: otros grupos que reciben lo MISMO que el suyo. Viven adentro de `telegram`, que ya es
     un JSON, así que no hace falta tocar el esquema. Se acepta una lista o un texto separado por
     comas —que es como se pega—, y se limpia acá y no en la pantalla: la ruta es la puerta, y un
     chatId con un espacio adelante no lo encuentra nadie después. */
  if (patch.copias !== undefined) {
    const crudo = Array.isArray(patch.copias) ? patch.copias : String(patch.copias || '').split(/[,\s]+/);
    c.telegram.copias = [...new Set(crudo.map((x) => String(x || '').trim()).filter(Boolean))];
  }
  saveCliente(c); return c;
}

// ─────────── Cajas (operativo /pedir) ───────────
function addCaja(clienteId, caja) {
  const data = load();
  const c = data.clientes.find((x) => x.id === clienteId);
  if (!c) return null;
  const k = {
    id: newId('k'), usuario: String(caja.usuario || '').trim(), sistema: String(caja.sistema || '').trim(),
    userId: String(caja.userId || '').trim(), divisas: parseDivisas(caja.divisas), montosRapidos: parseMontos(caja.montosRapidos),
    grupoId: String(caja.grupoId || '').trim(), notas: String(caja.notas || '').trim(),
    /* EL NOMBRE CON EL QUE EL CLIENTE RECONOCE ESTA CAJA («Royal»), aparte del usuario de la cuenta
       («RoyalAlexa-SA»). Es sólo para mostrar: `usuario` sigue siendo el login, que es lo que usan la
       cascada, los avisos y el cruce — y lo que el espejo del panel vuelve a escribir cada vez. Por
       eso el nombre vive en su propio campo, donde nadie lo pisa. Vacío = se muestra el usuario. */
    etiqueta: String(caja.etiqueta || '').trim(),
    /* QUÉ PUEDE HACER ESTE AGENTE EN MI CAJA. `null` = nadie lo configuró → sólo pedir fichas
       (ver PERMISOS_POR_DEFECTO). Ver permisosDe(). */
    permisos: caja.permisos ? normPermisos(caja.permisos) : null,
    /* 'distribuidor' = la cuenta con la que un DISTRIBUIDOR entra a Mi Caja. Es sólo identidad: el
       puente la usa para saber a qué cliente sumar los agentes que crea. No es un panel (su consumo
       ya incluye el de sus agentes: facturarlo junto a ellos sería cobrar dos veces). '' = agente. */
    rol: caja.rol === 'distribuidor' ? 'distribuidor' : '',
  };
  c.cajas.push(k); saveCliente(c); return k;
}

/* ── PERMISOS POR AGENTE ─────────────────────────────────────────────────────────────────────
   Cada caja es la cuenta de UN agente en el casino, y Mi Caja lo reconoce por esa cuenta. Dentro
   de un mismo cliente, un agente puede hacer todo y otro sólo pedir fichas.
   · pedir  → Pedir fichas
   · pagos  → Registrar un pago (subir comprobante)
   · cuenta → Ver su cuenta y el monto pendiente
   Una caja sin `permisos` es una cuenta que nadie configuró: sólo pide fichas (lo decidió el
   dueño el 29-sep-2026). Las que ya existían se congelaron con lo que tenían ese día. */
const PERMISOS_POR_DEFECTO = Object.freeze({ pedir: true, pagos: false, cuenta: false });
function normPermisos(p) {
  const o = p || {};
  return { pedir: o.pedir === true || o.pedir === 'true' || o.pedir === 1 || o.pedir === '1',
    pagos: o.pagos === true || o.pagos === 'true' || o.pagos === 1 || o.pagos === '1',
    cuenta: o.cuenta === true || o.cuenta === 'true' || o.cuenta === 1 || o.cuenta === '1' };
}
/* Lo que el agente puede hacer DE VERDAD. «Puede avisar pagos» del cliente sigue siendo la llave
   general: apagado ahí, ningún agente de ese cliente registra pagos, tenga lo que tenga. */
function permisosDe(cliente, caja) {
  const p = (caja && caja.permisos) ? normPermisos(caja.permisos) : { ...PERMISOS_POR_DEFECTO };
  return { pedir: p.pedir, pagos: p.pagos && !(cliente && cliente.avisa_pagos === false), cuenta: p.cuenta,
    configurados: !!(caja && caja.permisos) };
}
/* El día que esto se sube, los agentes que ya operaban no pierden nada: a cada caja SIN permisos se
   le escribe lo que podía hacer hasta ese momento (todo; los pagos siguen dependiendo de la llave
   del cliente). Sólo toca las que no tienen: correrlo dos veces no cambia nada. */
const congelarPermisosActuales = db.transaction(() => {
  const data = load(); let n = 0;
  for (const c of data.clientes) {
    let toca = false;
    for (const k of (c.cajas || [])) {
      if (k.permisos) continue;
      k.permisos = { pedir: true, pagos: true, cuenta: true }; n += 1; toca = true;
    }
    if (toca) saveCliente(c);
  }
  return n;
});
function updateCaja(clienteId, cajaId, patch) {
  const data = load();
  const c = data.clientes.find((x) => x.id === clienteId);
  if (!c) return null;
  const k = c.cajas.find((x) => x.id === cajaId);
  if (!k) return null;
  if (patch.usuario !== undefined) k.usuario = String(patch.usuario).trim();
  if (patch.sistema !== undefined) k.sistema = String(patch.sistema).trim();
  if (patch.userId !== undefined) k.userId = String(patch.userId).trim();
  if (patch.divisas !== undefined) k.divisas = parseDivisas(patch.divisas);
  if (patch.montosRapidos !== undefined) k.montosRapidos = parseMontos(patch.montosRapidos);
  if (patch.grupoId !== undefined) k.grupoId = String(patch.grupoId).trim();
  if (patch.notas !== undefined) k.notas = String(patch.notas).trim();
  if (patch.etiqueta !== undefined) k.etiqueta = String(patch.etiqueta).trim();
  if (patch.permisos !== undefined) k.permisos = patch.permisos === null ? null : normPermisos(patch.permisos);
  if (patch.rol !== undefined) k.rol = patch.rol === 'distribuidor' ? 'distribuidor' : '';
  /* Sólo para un distribuidor: si los agentes que crea entran pudiendo pedir fichas ellos mismos
     (sin el campo, sí — como siempre). Con «no», pide el distribuidor por ellos. */
  if (patch.agentesPiden !== undefined) k.agentesPiden = !!patch.agentesPiden;
  saveCliente(c); return k;
}
/* EL NOMBRE ES DE LA CUENTA DEL CASINO, NO DE UNA PANTALLA.
   Se guarda en la caja, pero en TODAS las cajas de esa cuenta (sistema + id del casino): Marcelo y
   JJ comparten Celuapuestas-SA y LuWinCasino-SA a propósito, y el cliente tiene que ver el mismo
   nombre desde cualquiera de las dos. Fichas y el OS escriben por acá, así nunca quedan distintos. */
const setEtiquetaCuenta = db.transaction((sistema, userId, etiqueta) => {
  if (!userId) return 0;
  const data = load();
  const v = String(etiqueta == null ? '' : etiqueta).trim();
  let n = 0;
  data.clientes.forEach((c) => {
    let toca = false;
    (c.cajas || []).forEach((k) => {
      if (String(k.userId) === String(userId) && (k.sistema || '') === (sistema || '')) { k.etiqueta = v; n++; toca = true; }
    });
    if (toca) saveCliente(c);
  });
  return n;
});
/* Pasa una caja de un cliente a otro tal cual: mismo id, permisos, nombre para el cliente y montos.
   Es lo que pasa al mover un panel; crear una caja nueva le hacía perder todo eso al agente. */
const moverCaja = db.transaction((deId, aId, cajaId) => {
  const de = get(deId); const a = get(aId);
  if (!de || !a) return null;
  const k = (de.cajas || []).find((x) => x.id === cajaId);
  if (!k) return null;
  de.cajas = de.cajas.filter((x) => x.id !== cajaId);
  a.cajas = (a.cajas || []).concat([k]);
  saveCliente(de); saveCliente(a);
  return k;
});

function removeCaja(clienteId, cajaId) {
  const data = load();
  const c = data.clientes.find((x) => x.id === clienteId);
  if (!c) return false;
  const before = c.cajas.length;
  c.cajas = c.cajas.filter((k) => k.id !== cajaId);
  saveCliente(c); return c.cajas.length < before;
}

function importRows(rows, dryRun = false) {
  const data = load();
  const summary = { clientesCreados: 0, clientesActualizados: 0, cajasAgregadas: 0, cajasActualizadas: 0, filas: rows.length, errores: [] };
  const touched = new Set();
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i] || {};
    const cod = String(r.codigo || '').trim();
    const userId = String(r.userId || '').trim();
    if (!cod) { summary.errores.push(`Fila ${i + 1}: sin código de cliente`); continue; }
    let cliente = data.clientes.find((c) => String(c.codigo).toLowerCase() === cod.toLowerCase());
    if (!cliente) {
      cliente = { id: newId('c'), codigo: cod, nombreVisible: String(r.nombreVisible || '').trim(), nombre: String(r.nombreVisible || '').trim(), createdAt: new Date().toISOString(), estado: 'activo', cajas: [], telegram: { chatId: '', enabled: false } };
      data.clientes.push(cliente); summary.clientesCreados++;
    } else {
      if (r.nombreVisible && cliente.nombreVisible !== String(r.nombreVisible).trim()) cliente.nombreVisible = String(r.nombreVisible).trim();
      if (!touched.has(cliente.id)) summary.clientesActualizados++;
    }
    touched.add(cliente.id);
    if (!r.usuario && !userId) continue;
    const sistema = String(r.sistema || '').trim();
    let caja = cliente.cajas.find((k) => userId && String(k.userId) === userId && String(k.sistema).toLowerCase() === sistema.toLowerCase());
    const payload = { usuario: String(r.usuario || '').trim(), sistema, userId, divisas: parseDivisas(r.divisas), montosRapidos: parseMontos(r.montosRapidos), grupoId: String(r.grupoId || '').trim() };
    if (caja) { Object.assign(caja, payload); summary.cajasActualizadas++; }
    else { cliente.cajas.push({ id: newId('k'), notas: '', ...payload }); summary.cajasAgregadas++; }
  }
  if (!dryRun) db.transaction(() => data.clientes.filter((c) => touched.has(c.id)).forEach(saveCliente))();
  summary.totalClientes = data.clientes.length;
  return summary;
}

module.exports = {
  list, get, getByCodigo, createCliente, updateCliente, updateComercial, removeCliente, setTelegram,
  addCaja, updateCaja, setEtiquetaCuenta, removeCaja, moverCaja, importRows, parseMontos, parseDivisas, seed: save, FILE, COLUMNAS,
  permisosDe, congelarPermisosActuales, PERMISOS_POR_DEFECTO, normDivisasPago, tcCargasDe,
};
