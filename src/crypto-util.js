/**
 * crypto-util.js — cifrado de secretos en reposo (AES-256-GCM).
 *
 * Se usa para que las contraseñas de los SISTEMAS (casino) NO queden en texto plano
 * en la base de datos. La clave maestra sale de una variable de entorno:
 *     CRED_KEY  (recomendado, dedicada)  →  si no, cae a SESSION_SECRET  →  si no, default de dev.
 *
 * ⚠️ IMPORTANTE: si cambiás CRED_KEY (o SESSION_SECRET si usás ese de fallback) DESPUÉS de
 * haber guardado contraseñas, esas contraseñas ya NO se van a poder desencriptar y habrá
 * que volver a cargarlas en el panel. Mantené CRED_KEY estable.
 */
const crypto = require('crypto');

const SECRET = process.env.CRED_KEY || process.env.SESSION_SECRET || 'dev-insecure-secret-cambiar-en-prod';
const KEY = crypto.createHash('sha256').update(String(SECRET)).digest(); // 32 bytes
const PREFIX = 'enc:v1:';

/** Cifra un texto. Si ya está cifrado o está vacío, lo devuelve tal cual. */
function encrypt(plain) {
  if (plain === null || plain === undefined || plain === '') return '';
  const s = String(plain);
  if (s.startsWith(PREFIX)) return s; // ya cifrado
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const ct = Buffer.concat([cipher.update(s, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + Buffer.concat([iv, tag, ct]).toString('base64');
}

/** Descifra un valor. Si NO tiene el prefijo (texto plano legacy) lo devuelve tal cual. */
function decrypt(value) {
  if (value === null || value === undefined || value === '') return '';
  const s = String(value);
  if (!s.startsWith(PREFIX)) return s; // legacy en texto plano → devolver como está
  try {
    const raw = Buffer.from(s.slice(PREFIX.length), 'base64');
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(12, 28);
    const ct = raw.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  } catch (e) {
    console.error('[crypto] no se pudo desencriptar (¿cambió CRED_KEY/SESSION_SECRET?):', e.message);
    return '';
  }
}

/** ¿El valor ya está cifrado? */
function isEncrypted(value) {
  return typeof value === 'string' && value.startsWith(PREFIX);
}

module.exports = { encrypt, decrypt, isEncrypted };
