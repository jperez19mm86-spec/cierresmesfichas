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
    modo: r.token ? 'token' : ((r.usuario && r.password) ? 'userpass' : 'incompleto'),
  };
  if (secret) { o.token = decrypt(r.token); o.password = decrypt(r.password); }
  return o;
}

function list() { return db.prepare('SELECT * FROM casino_conexiones ORDER BY ord ASC').all().map((r) => view(r)); }
function get(id, secret = false) { return view(db.prepare('SELECT * FROM casino_conexiones WHERE id=?').get(id), secret); }

function create({ nombre, url, token, usuario, password }) {
  const id = newId();
  const ord = db.prepare('SELECT COUNT(*) c FROM casino_conexiones').get().c;
  db.prepare('INSERT INTO casino_conexiones (id,nombre,url,token,usuario,password,activa,createdAt,ord) VALUES (?,?,?,?,?,?,1,?,?)')
    .run(id, String(nombre || '').trim() || 'Casino', String(url || '').trim(),
      encrypt(token || ''), String(usuario || '').trim(), encrypt(password || ''), new Date().toISOString(), ord);
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
  db.prepare('UPDATE casino_conexiones SET nombre=?, url=?, token=?, usuario=?, password=?, activa=? WHERE id=?')
    .run(nombre, url, token, usuario, password, activa, id);
  return get(id);
}

function remove(id) { return db.prepare('DELETE FROM casino_conexiones WHERE id=?').run(id).changes > 0; }

/** Cliente casino-api listo: usa token si hay, si no usuario/contraseña. */
function client(id) {
  const c = get(id, true);
  if (!c) return null;
  if (c.token) return require('./casino-api').makeClient({ url: c.url, token: c.token });
  if (c.usuario && c.password) return require('./casino-api').makeClient({ url: c.url, user: c.usuario, password: c.password });
  return null;
}

module.exports = { list, get, create, update, remove, client };
