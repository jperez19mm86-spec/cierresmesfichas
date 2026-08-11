/**
 * cliente-acceso.js — LA CUENTA PROPIA DE UN CLIENTE.
 *
 * Hasta acá el único identificador de un cliente era su CÓDIGO, y con eso pedía fichas, avisaba
 * pagos y movía balance. Alcanza para eso: son acciones que después alguien aprueba.
 *
 * Ver su cuenta es otra cosa. Ahí hay plata: lo que consumió, lo que debe, lo que pagó. El sistema
 * ya trataba ese dato con más cuidado que el resto —la factura se manda por un link con un token
 * largo y al azar, no con el código— y bajar ese estándar para meterlo detrás de un código corto y
 * adivinable sería deshacer una decisión que ya se había tomado bien.
 *
 * Por eso: usuario y contraseña, y sólo para los clientes que lo necesiten. La mayoría sólo pide
 * fichas y para esos agregar una contraseña es fricción sin nada a cambio.
 *
 * ── LA CONTRASEÑA NO SE GUARDA ─────────────────────────────────────────────────────────────
 * Se guarda `scrypt(clave, sal)`. Ni la dueña puede verla: si un cliente la pierde, se le genera
 * otra, no se le muestra la que tenía. Guardar una contraseña recuperable es guardar una
 * contraseña que alguien puede leer.
 *
 * scrypt y no un hash a secas: está hecho para ser LENTO a propósito, así que probar millones de
 * claves cuesta tiempo real. Viene en Node, no hace falta ninguna dependencia.
 */
const crypto = require('crypto');
const { db } = require('./db');

const N = 16384, r = 8, p = 1, LARGO = 32;   // parámetros de scrypt: los recomendados para login

/** `sal:hash`, los dos en hex. La sal va con el hash porque es única por clave, no es un secreto. */
function hashear(clave) {
  const sal = crypto.randomBytes(16);
  const h = crypto.scryptSync(String(clave), sal, LARGO, { N, r, p });
  return `${sal.toString('hex')}:${h.toString('hex')}`;
}

/**
 * Compara en tiempo constante. Con una comparación normal, el tiempo que tarda en fallar delata
 * cuántos caracteres acertó: se prueban de a uno y se arma la clave sin adivinarla entera.
 */
function verificar(clave, guardado) {
  if (!guardado || !String(guardado).includes(':')) return false;
  const [salHex, hashHex] = String(guardado).split(':');
  try {
    const h = crypto.scryptSync(String(clave), Buffer.from(salHex, 'hex'), LARGO, { N, r, p });
    const esperado = Buffer.from(hashHex, 'hex');
    return h.length === esperado.length && crypto.timingSafeEqual(h, esperado);
  } catch (e) { return false; }
}

/**
 * Una clave que se pueda dictar por teléfono sin equivocarse.
 *
 * Sin 0/O ni 1/l/I: son el motivo por el que una clave "no anda" y en realidad está bien escrita.
 * Diez caracteres de este alfabeto son ~51 bits: de sobra para algo que además está detrás de un
 * usuario, y corto como para pasarlo por un mensaje.
 */
function generarClave(largo = 10) {
  const abc = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const b = crypto.randomBytes(largo);
  return [...b].map((x) => abc[x % abc.length]).join('');
}

/** Prende la cuenta y devuelve la clave EN CLARO una sola vez: no se puede volver a mostrar. */
function habilitar(cliente_id, { usuario, clave } = {}) {
  const c = db.prepare('SELECT id, codigo FROM clientes WHERE id=?').get(String(cliente_id || ''));
  if (!c) return { ok: false, error: 'no encontré ese cliente' };
  const user = String(usuario || c.codigo || '').trim().toLowerCase();
  if (!user) return { ok: false, error: 'falta el usuario' };
  // Dos clientes con el mismo usuario haría que uno entre a la cuenta del otro.
  const repe = db.prepare('SELECT id FROM clientes WHERE lower(acceso_usuario)=? AND id<>?').get(user, c.id);
  if (repe) return { ok: false, error: `el usuario "${user}" ya lo tiene otro cliente` };
  const enClaro = String(clave || '').trim() || generarClave();
  if (enClaro.length < 8) return { ok: false, error: 'la clave tiene que tener al menos 8 caracteres' };
  db.prepare(`UPDATE clientes SET acceso_habilitado=1, acceso_usuario=?, acceso_clave=?, acceso_at=? WHERE id=?`)
    .run(user, hashear(enClaro), new Date().toISOString(), c.id);
  return { ok: true, usuario: user, clave: enClaro, generada: !clave };
}

function deshabilitar(cliente_id) {
  db.prepare('UPDATE clientes SET acceso_habilitado=0 WHERE id=?').run(String(cliente_id || ''));
  return { ok: true };
}

/** El cliente que corresponde a ese usuario y clave, o null. Nunca dice cuál de los dos falló. */
function autenticar(usuario, clave) {
  const u = String(usuario || '').trim().toLowerCase();
  if (!u) return null;
  const c = db.prepare(`SELECT id, codigo, nombre, nombreVisible, acceso_clave, acceso_habilitado
    FROM clientes WHERE lower(acceso_usuario)=?`).get(u);
  if (!c || !c.acceso_habilitado) return null;
  if (!verificar(clave, c.acceso_clave)) return null;
  return { id: c.id, codigo: c.codigo, nombre: c.nombre || c.nombreVisible || c.codigo };
}

/** El estado del acceso, para la pantalla. NUNCA devuelve el hash. */
function estado(cliente_id) {
  const c = db.prepare('SELECT acceso_habilitado, acceso_usuario, acceso_at FROM clientes WHERE id=?')
    .get(String(cliente_id || ''));
  if (!c) return null;
  return { habilitado: !!c.acceso_habilitado, usuario: c.acceso_usuario || null,
    desde: c.acceso_at || null, tieneClave: !!c.acceso_usuario };
}

module.exports = { habilitar, deshabilitar, autenticar, estado, generarClave, hashear, verificar };
