/**
 * casino-conexiones-store.js — conexiones al casino. Auth DUAL: api_token O usuario/contraseña,
 * ambos CIFRADOS (crypto-util). Multi-conexión (la cuenta DEV real verá varios masters).
 * Los secretos nunca se devuelven al frontend en claro (solo `client()` los descifra).
 */
const crypto = require('crypto');
const { db } = require('./db');
const { encrypt, decrypt } = require('./crypto-util');

const newId = () => 'cx_' + crypto.randomBytes(5).toString('hex');

/** Vista pública (sin secretos). secret=true solo para uso interno (crear el cliente). */
function view(r, secret = false) {
  if (!r) return null;
  const o = {
    id: r.id, nombre: r.nombre, url: r.url, usuario: r.usuario || '', activa: !!r.activa, createdAt: r.createdAt,
    hasToken: !!r.token, hasPassword: !!r.password,
    motor: r.motor || '463',        // con qué cliente se le habla: '463' (Casino/Europa) o 'tbs'
    modo: r.token ? 'token' : ((r.usuario && r.password) ? 'userpass' : 'incompleto'),
  };
  if (secret) { o.token = decrypt(r.token); o.password = decrypt(r.password); }
  return o;
}

function list() { return db.prepare('SELECT * FROM casino_conexiones ORDER BY ord ASC').all().map((r) => view(r)); }
function get(id, secret = false) { return view(db.prepare('SELECT * FROM casino_conexiones WHERE id=?').get(id), secret); }

const MOTORES = new Set(['463', 'tbs']);

function create({ nombre, url, token, usuario, password, motor }) {
  const id = newId();
  const ord = db.prepare('SELECT COUNT(*) c FROM casino_conexiones').get().c;
  const m = MOTORES.has(String(motor)) ? String(motor) : '463';
  db.prepare('INSERT INTO casino_conexiones (id,nombre,url,token,usuario,password,activa,createdAt,ord,motor) VALUES (?,?,?,?,?,?,1,?,?,?)')
    .run(id, String(nombre || '').trim() || 'Casino', String(url || '').trim(),
      encrypt(token || ''), String(usuario || '').trim(), encrypt(password || ''), new Date().toISOString(), ord, m);
  return get(id);
}

function update(id, patch) {
  const r = db.prepare('SELECT * FROM casino_conexiones WHERE id=?').get(id);
  if (!r) return null;
  const nombre = patch.nombre !== undefined ? String(patch.nombre).trim() : r.nombre;
  const url = patch.url !== undefined ? String(patch.url).trim() : r.url;
  const usuario = patch.usuario !== undefined ? String(patch.usuario).trim() : r.usuario;
  // token/password vacíos = mantener los actuales
  const token = (patch.token !== undefined && patch.token !== '') ? encrypt(patch.token) : r.token;
  const password = (patch.password !== undefined && patch.password !== '') ? encrypt(patch.password) : r.password;
  const activa = patch.activa !== undefined ? (patch.activa ? 1 : 0) : r.activa;
  const motor = MOTORES.has(String(patch.motor)) ? String(patch.motor) : (r.motor || '463');
  db.prepare('UPDATE casino_conexiones SET nombre=?, url=?, token=?, usuario=?, password=?, activa=?, motor=? WHERE id=?')
    .run(nombre, url, token, usuario, password, activa, motor, id);
  return get(id);
}

function remove(id) { return db.prepare('DELETE FROM casino_conexiones WHERE id=?').run(id).changes > 0; }

/**
 * El cliente que corresponde a esta conexión. Usa token si hay, si no usuario/contraseña.
 *
 * 🔑 `motor` decide con QUÉ módulo se le habla. Antes se asumía que todas las conexiones eran
 * del engine 463.life: por eso TBS, que es otro producto, devolvía "usuario o contraseña
 * incorrectos" — el cliente le posteaba a una ruta que en ese panel no existe.
 */
function client(id) {
  const c = get(id, true);
  if (!c) return null;
  const mod = require(c.motor === 'tbs' ? './tbs-api' : './casino-api');
  if (c.token) return mod.makeClient({ url: c.url, token: c.token });
  if (c.usuario && c.password) return mod.makeClient({ url: c.url, user: c.usuario, password: c.password });
  return null;
}

/** Solo las del engine 463 (Casino/Europa). Las pantallas que piden nodos/reportes usan estas. */
function list463() { return list().filter((c) => (c.motor || '463') === '463'); }

module.exports = { list, list463, get, create, update, remove, client, MOTORES };
