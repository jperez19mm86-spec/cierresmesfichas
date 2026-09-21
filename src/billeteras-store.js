/**
 * billeteras-store.js — DÓNDE ENTRA LA PLATA, y a quién se le avisa.
 *
 * Había UNA dirección USDT en la configuración (`usdtAddress`) y UN grupo para todos los pagos en
 * dólares (`tgChatUsdt`). Con dos billeteras eso no alcanza: no se sabía a cuál había entrado un
 * pago, y todos los comprobantes caían en el mismo grupo.
 *
 * Cada billetera tiene SUS direcciones —una por red; BEP20 y TRC20 son la misma billetera— y SU
 * grupo. El cliente apunta a una (`clientes.billetera_id`); el que no apunta a ninguna usa la
 * principal, que es exactamente lo que había antes.
 */
const crypto = require('crypto');
const { db } = require('./db');
const config = require('./config-store');

const newId = () => 'bw_' + crypto.randomBytes(5).toString('hex');
const T = (v) => String(v == null ? '' : v).trim();

function fila(r) {
  if (!r) return null;
  let direcciones = [];
  try { if (r.direcciones) direcciones = JSON.parse(r.direcciones); } catch (e) { direcciones = []; }
  if (!Array.isArray(direcciones)) direcciones = [];
  return { id: r.id, nombre: r.nombre || '', direcciones, tg_chat: r.tg_chat || '', nota: r.nota || '',
    activa: r.activa !== 0, ord: r.ord, createdAt: r.createdAt };
}

/** Las direcciones, limpias: sin vacías, sin repetir red, con la red en mayúscula. */
function limpiarDirecciones(lista) {
  const out = []; const vistas = new Set();
  (Array.isArray(lista) ? lista : []).forEach((d) => {
    const red = T(d && d.red).toUpperCase();
    const direccion = T(d && d.direccion);
    if (!direccion) return;                       // una red sin dirección no sirve para cobrar
    const clave = red + '|' + direccion;
    if (vistas.has(clave)) return;
    vistas.add(clave);
    out.push({ red, direccion });
  });
  return out;
}

function list({ soloActivas = false } = {}) {
  const filas = db.prepare('SELECT * FROM billeteras ORDER BY ord ASC, createdAt ASC').all().map(fila);
  return soloActivas ? filas.filter((b) => b.activa) : filas;
}

function get(id) { return fila(db.prepare('SELECT * FROM billeteras WHERE id=?').get(String(id || ''))); }

function crear({ nombre, direcciones, tg_chat, nota, activa = true } = {}) {
  const id = newId();
  const ord = db.prepare('SELECT COALESCE(MAX(ord), -1) + 1 AS n FROM billeteras').get().n;
  db.prepare(`INSERT INTO billeteras (id, nombre, direcciones, tg_chat, nota, activa, ord, createdAt)
    VALUES (?,?,?,?,?,?,?,?)`)
    .run(id, T(nombre) || 'Sin nombre', JSON.stringify(limpiarDirecciones(direcciones)), T(tg_chat),
      T(nota), activa === false ? 0 : 1, ord, new Date().toISOString());
  return get(id);
}

function actualizar(id, patch = {}) {
  const b = get(id); if (!b) return null;
  const n = {
    nombre: patch.nombre !== undefined ? (T(patch.nombre) || b.nombre) : b.nombre,
    direcciones: patch.direcciones !== undefined ? limpiarDirecciones(patch.direcciones) : b.direcciones,
    tg_chat: patch.tg_chat !== undefined ? T(patch.tg_chat) : b.tg_chat,
    nota: patch.nota !== undefined ? T(patch.nota) : b.nota,
    activa: patch.activa !== undefined ? (patch.activa !== false ? 1 : 0) : (b.activa ? 1 : 0),
  };
  db.prepare('UPDATE billeteras SET nombre=?, direcciones=?, tg_chat=?, nota=?, activa=? WHERE id=?')
    .run(n.nombre, JSON.stringify(n.direcciones), n.tg_chat, n.nota, n.activa, id);
  return get(id);
}

/**
 * 🔒 NO SE BORRA UNA BILLETERA QUE ALGUIEN USA.
 * Borrarla dejaría a sus clientes cobrando en una dirección que ya no existe y a sus comprobantes
 * apuntando a la nada. Se apaga (`activa: false`): deja de ofrecerse y lo viejo sigue legible.
 */
function borrar(id) {
  const usada = db.prepare('SELECT COUNT(*) n FROM clientes WHERE billetera_id=?').get(String(id)).n
    + db.prepare('SELECT COUNT(*) n FROM comprobantes WHERE billetera_id=?').get(String(id)).n;
  if (usada) return { ok: false, error: `esa billetera está en uso (${usada}): apagala en vez de borrarla` };
  const r = db.prepare('DELETE FROM billeteras WHERE id=?').run(String(id));
  return r.changes ? { ok: true } : { ok: false, error: 'no existe esa billetera' };
}

/**
 * La billetera de un cliente. Sin `billetera_id` —o con uno que ya no existe— va la PRINCIPAL, que
 * es la primera activa: así un cliente que nunca se tocó sigue viendo lo mismo de siempre.
 */
function deCliente(cli) {
  const propia = cli && cli.billetera_id ? get(cli.billetera_id) : null;
  if (propia && propia.activa) return propia;
  return principal();
}

function principal() { return list({ soloActivas: true })[0] || null; }

/**
 * La primera vez que corre, la billetera que ya estaba en Configuración se convierte en un registro
 * y NADA cambia para quien la usa: misma dirección, misma red, mismo grupo. Sin esto habría que
 * cargarla a mano y, hasta que alguien lo hiciera, los clientes no verían dónde pagar.
 */
function sembrar() {
  if (db.prepare('SELECT COUNT(*) n FROM billeteras').get().n) return null;
  const direccion = T(config.getCfg('usdtAddress'));
  const red = T(config.getCfg('usdtRed'));
  const tg = T(config.getCfg('tgChatUsdt'));
  if (!direccion && !tg) return null;             // sin nada que migrar, se crea cuando haga falta
  return crear({ nombre: 'Wallet principal', direcciones: direccion ? [{ red, direccion }] : [], tg_chat: tg });
}

module.exports = { list, get, crear, actualizar, borrar, deCliente, principal, sembrar, limpiarDirecciones };
