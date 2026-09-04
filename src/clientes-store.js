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

function load() {
  const clientes = db.prepare('SELECT * FROM clientes ORDER BY ord ASC').all().map((r) => {
    let telegram = { chatId: '', enabled: false };
    let cajas = [];
    try { if (r.telegram) telegram = JSON.parse(r.telegram); } catch (e) {}
    try { if (r.cajas) cajas = JSON.parse(r.cajas); } catch (e) {}
    if (!telegram) telegram = { chatId: '', enabled: false };
    return {
      id: r.id, codigo: r.codigo, nombreVisible: r.nombreVisible, createdAt: r.createdAt, telegram, cajas,
      // comercial (OS v3)
      nombre: r.nombre || r.nombreVisible || '',
      estado: r.estado || 'activo',
      paga_proveedores: !!r.paga_proveedores,
      permite_deuda: !!r.permite_deuda,
      mezcla_pago_usdt: r.mezcla_pago_usdt || null,
      ajuste_usdt_pct: r.ajuste_usdt_pct || null,
      fecha_alta: r.fecha_alta || r.createdAt || null,
      // v3.0 ficha de cliente
      divisa_fichas: r.divisa_fichas || null,
      moneda_cobro: r.moneda_cobro || null,
      momento_pago: r.momento_pago || null,
      disparador: r.disparador || null,
      tc_aplicar: r.tc_aplicar || null,
      tc_proveedor: r.tc_proveedor || null,
      // v3.0 §7-10 (planilla). OJO: si un campo falta ACÁ, save() lo reinserta como null
      // aunque esté bien en el INSTERT → se borra solo al guardar cualquier otro cliente.
      mover_balance: !!r.mover_balance,
      // ⚠️ EL ACCESO VIAJA ACÁ AUNQUE NADIE LO LEA DE ESTE OBJETO. El store guarda con DELETE +
      // INSERT: una columna que load() no trae, el próximo guardado de CUALQUIER cliente la deja
      // en NULL PARA TODOS. Estas cuatro se estaban perdiendo — o sea que editar un cliente
      // borraba la contraseña de todos los que tenían acceso a ver su cuenta, en silencio.
      // `acceso_clave` es el hash, nunca la clave; se copia tal cual y no se muestra en ningún lado.
      acceso_habilitado: r.acceso_habilitado ? 1 : 0,
      acceso_usuario: r.acceso_usuario || null,
      acceso_clave: r.acceso_clave || null,
      acceso_at: r.acceso_at || null,
      acceso_corte: r.acceso_corte != null ? Number(r.acceso_corte) : null,
      // Vacío = USDT: es como estaban todos antes de que esto existiera.
      moneda_cuenta: (r.moneda_cuenta === 'ARS' ? 'ARS' : 'USDT'),
      margen_externos_pct: r.margen_externos_pct || null,
      es_vendedor: !!r.es_vendedor,
      // ⚠️ El store guarda con DELETE + INSERT: si load() no trae una columna, el próximo
      // guardado de CUALQUIER cliente la deja en NULL para todos. Pasó con externos_modo.
      externos_modo: r.externos_modo || null,
      vendedor_id: r.vendedor_id || null,
      factura_a: r.factura_a || null,
      externos_precios_de: r.externos_precios_de || null,
      avisa_pagos: r.avisa_pagos == null ? true : !!r.avisa_pagos,
      saldo_inicial: r.saldo_inicial || null,
      saldo_inicial_divisa: r.saldo_inicial_divisa || null,
      saldo_inicial_mov_id: r.saldo_inicial_mov_id || null,
    };
  });
  return { clientes };
}

const _saveTx = db.transaction((data) => {
  db.prepare('DELETE FROM clientes').run();
  const ins = db.prepare(`INSERT INTO clientes
    (id,codigo,nombreVisible,createdAt,telegram,cajas,ord,nombre,estado,paga_proveedores,permite_deuda,mezcla_pago_usdt,ajuste_usdt_pct,fecha_alta,
     divisa_fichas,moneda_cobro,momento_pago,disparador,tc_aplicar,tc_proveedor,
     mover_balance,saldo_inicial,saldo_inicial_divisa,saldo_inicial_mov_id,margen_externos_pct,es_vendedor,vendedor_id,externos_modo,factura_a,externos_precios_de,avisa_pagos,moneda_cuenta,
     acceso_habilitado,acceso_usuario,acceso_clave,acceso_at,acceso_corte)
    VALUES (@id,@codigo,@nombreVisible,@createdAt,@telegram,@cajas,@ord,@nombre,@estado,@pp,@pd,@mez,@aj,@fa,
     @dfi,@mco,@mpa,@dis,@tca,@tcp,
     @mb,@sini,@sdiv,@smov,@mext,@esv,@vend,@exmodo,@facta,@exprec,@avisa,@mcta,
     @accOn,@accU,@accC,@accAt,@accCorte)`);
  const nn = (v) => (v != null && v !== '' ? String(v) : null);
  (data.clientes || []).forEach((c, i) => ins.run({
    id: c.id, codigo: c.codigo, nombreVisible: c.nombreVisible || '', createdAt: c.createdAt || null,
    telegram: JSON.stringify(c.telegram || { chatId: '', enabled: false }),
    cajas: JSON.stringify(c.cajas || []), ord: i,
    nombre: c.nombre || c.nombreVisible || '', estado: c.estado || 'activo',
    pp: c.paga_proveedores ? 1 : 0, pd: c.permite_deuda ? 1 : 0,
    mez: nn(c.mezcla_pago_usdt), aj: nn(c.ajuste_usdt_pct), fa: c.fecha_alta || c.createdAt || null,
    dfi: nn(c.divisa_fichas), mco: nn(c.moneda_cobro), mpa: nn(c.momento_pago), dis: nn(c.disparador), tca: nn(c.tc_aplicar), tcp: nn(c.tc_proveedor),
    mcta: c.moneda_cuenta === 'ARS' ? 'ARS' : 'USDT',
    mb: c.mover_balance ? 1 : 0, mext: nn(c.margen_externos_pct), esv: c.es_vendedor ? 1 : 0, vend: nn(c.vendedor_id), exmodo: nn(c.externos_modo), sini: nn(c.saldo_inicial), sdiv: nn(c.saldo_inicial_divisa), smov: nn(c.saldo_inicial_mov_id),
    facta: nn(c.factura_a), exprec: nn(c.externos_precios_de),
    avisa: (c.avisa_pagos === false) ? 0 : 1,
    accOn: c.acceso_habilitado ? 1 : 0, accU: nn(c.acceso_usuario), accC: nn(c.acceso_clave), accAt: nn(c.acceso_at),
    // Sin esto, guardar cualquier cliente le devolvía la sesión a todos los que se la habías
    // cortado: el guardado reescribe la tabla entera y lo que no está en la lista se pierde.
    accCorte: c.acceso_corte != null ? Number(c.acceso_corte) : null,
  }));
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
  data.clientes.push(cliente); save(data); return cliente;
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
  save(data); return c;
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
  if (patch.mover_balance !== undefined) c.mover_balance = !!patch.mover_balance;
  if (patch.moneda_cuenta !== undefined) c.moneda_cuenta = (String(patch.moneda_cuenta).toUpperCase() === 'ARS' ? 'ARS' : 'USDT');
  if (patch.es_vendedor !== undefined) c.es_vendedor = !!patch.es_vendedor;
  if (patch.avisa_pagos !== undefined) c.avisa_pagos = !!patch.avisa_pagos;
  save(data); return c;
}

function removeCliente(id) {
  const data = load();
  const before = data.clientes.length;
  data.clientes = data.clientes.filter((c) => c.id !== id);
  save(data); return data.clientes.length < before;
}

function setTelegram(id, patch) {
  const data = load();
  const c = data.clientes.find((x) => x.id === id);
  if (!c) return null;
  if (!c.telegram) c.telegram = { chatId: '', enabled: false };
  if (patch.chatId !== undefined) c.telegram.chatId = String(patch.chatId).trim();
  if (patch.enabled !== undefined) c.telegram.enabled = !!patch.enabled;
  save(data); return c;
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
  };
  c.cajas.push(k); save(data); return k;
}
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
  save(data); return k;
}
function removeCaja(clienteId, cajaId) {
  const data = load();
  const c = data.clientes.find((x) => x.id === clienteId);
  if (!c) return false;
  const before = c.cajas.length;
  c.cajas = c.cajas.filter((k) => k.id !== cajaId);
  save(data); return c.cajas.length < before;
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
  if (!dryRun) save(data);
  summary.totalClientes = data.clientes.length;
  return summary;
}

module.exports = {
  list, get, getByCodigo, createCliente, updateCliente, updateComercial, removeCliente, setTelegram,
  addCaja, updateCaja, removeCaja, importRows, parseMontos, parseDivisas, seed: save, FILE,
};
