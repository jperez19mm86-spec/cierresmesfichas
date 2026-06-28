/**
 * systems-store.js — almacenamiento local (JSON) de los "sistemas" (páginas de agente).
 *
 * Cada sistema = una URL de admin + usuario + contraseña + un nombre editable (ej "Casino", "Europa").
 * Se guarda en data/systems.json (gitignored — contiene contraseñas en claro).
 *
 * Estructura del archivo:
 *   { "activeId": "s_xxx", "systems": [ { id, name, url, user, password, createdAt, lastLoginAt, lastLoginOk } ] }
 */
const crypto = require('crypto');
const { db } = require('./db');
const { encrypt, decrypt, isEncrypted } = require('./crypto-util');

const FILE = 'sqlite:systems'; // compat (ya no es un archivo; queda por si algo lo referencia)

function load() {
  const systems = db.prepare('SELECT * FROM systems ORDER BY ord ASC').all().map((r) => ({
    id: r.id,
    name: r.name,
    url: r.url,
    user: r.user,
    password: decrypt(r.password), // en la base está cifrada; acá la devolvemos en claro para usarla
    createdAt: r.createdAt,
    lastLoginAt: r.lastLoginAt,
    lastLoginOk: r.lastLoginOk === null ? null : !!r.lastLoginOk,
  }));
  const a = db.prepare("SELECT value FROM meta WHERE key='activeId'").get();
  return { activeId: a ? a.value : '', systems };
}

const _saveTx = db.transaction((data) => {
  db.prepare('DELETE FROM systems').run();
  const ins = db.prepare(
    'INSERT INTO systems (id,name,url,user,password,createdAt,lastLoginAt,lastLoginOk,ord) VALUES (@id,@name,@url,@user,@password,@createdAt,@lastLoginAt,@lastLoginOk,@ord)'
  );
  (data.systems || []).forEach((s, i) => ins.run({
    id: s.id,
    name: s.name || '',
    url: s.url || '',
    user: s.user || '',
    password: encrypt(s.password || ''), // se guarda CIFRADA en la base
    createdAt: s.createdAt || null,
    lastLoginAt: s.lastLoginAt || null,
    lastLoginOk: (s.lastLoginOk === null || s.lastLoginOk === undefined) ? null : (s.lastLoginOk ? 1 : 0),
    ord: i,
  }));
  db.prepare("INSERT INTO meta (key,value) VALUES ('activeId',@v) ON CONFLICT(key) DO UPDATE SET value=@v")
    .run({ v: data.activeId || '' });
});
function save(data) { _saveTx(data); }

function list() {
  return load();
}

function get(id) {
  return load().systems.find((s) => s.id === id) || null;
}

function create({ name, url, user, password }) {
  const data = load();
  const id = 's_' + crypto.randomBytes(5).toString('hex');
  const sys = {
    id,
    name: String(name || '').trim() || 'Sin nombre',
    url: String(url || '').trim(),
    user: String(user || '').trim(),
    password: String(password || ''),
    createdAt: new Date().toISOString(),
    lastLoginAt: null,
    lastLoginOk: null,
  };
  data.systems.push(sys);
  if (!data.activeId) data.activeId = id; // el primero queda activo por defecto
  save(data);
  return sys;
}

function update(id, patch) {
  const data = load();
  const s = data.systems.find((x) => x.id === id);
  if (!s) return null;
  if (patch.name !== undefined) s.name = String(patch.name).trim() || s.name;
  if (patch.url !== undefined) s.url = String(patch.url).trim();
  if (patch.user !== undefined) s.user = String(patch.user).trim();
  // La contraseña solo se actualiza si viene NO vacía (vacío = mantener la actual).
  if (patch.password !== undefined && patch.password !== '') s.password = String(patch.password);
  if (patch.lastLoginAt !== undefined) s.lastLoginAt = patch.lastLoginAt;
  if (patch.lastLoginOk !== undefined) s.lastLoginOk = patch.lastLoginOk;
  save(data);
  return s;
}

function remove(id) {
  const data = load();
  const before = data.systems.length;
  data.systems = data.systems.filter((s) => s.id !== id);
  if (data.activeId === id) data.activeId = data.systems[0] ? data.systems[0].id : '';
  save(data);
  return data.systems.length < before;
}

function setActive(id) {
  const data = load();
  if (!data.systems.find((s) => s.id === id)) return false;
  data.activeId = id;
  save(data);
  return true;
}

/** Vista "pública" (sin contraseña) para mandar al frontend. */
function publicView(s) {
  return {
    id: s.id,
    name: s.name,
    url: s.url,
    user: s.user,
    hasPassword: !!s.password,
    createdAt: s.createdAt,
    lastLoginAt: s.lastLoginAt || null,
    lastLoginOk: s.lastLoginOk === undefined ? null : s.lastLoginOk,
  };
}

/**
 * Cifra en la base las contraseñas que estén en texto plano (legacy, ej. recién migradas del JSON).
 * Idempotente: si ya están todas cifradas, no hace nada. Devuelve cuántas cifró.
 */
function migrateEncrypt() {
  const rows = db.prepare('SELECT password FROM systems').all();
  const plain = rows.filter((r) => r.password && !isEncrypted(r.password)).length;
  if (plain > 0) save(load()); // load descifra (legacy=tal cual) → save vuelve a guardar cifrado
  return plain;
}

module.exports = { list, get, create, update, remove, setActive, publicView, seed: save, migrateEncrypt, FILE };
