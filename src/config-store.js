/**
 * config-store.js — configuración global de la app (data/config.json, gitignored).
 * Por ahora guarda el token del bot de Telegram (uno solo para toda la plataforma;
 * cada cliente configura su propio GRUPO/chatId aparte).
 */
const { db } = require('./db');

const FILE = 'sqlite:config'; // compat (ya no es un archivo)

function getCfg(key) {
  const r = db.prepare('SELECT value FROM config WHERE key=?').get(key);
  return r ? r.value : null;
}
function setCfg(key, value) {
  db.prepare('INSERT INTO config (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    .run(key, value);
}

/**
 * EL GRUPO MATRIZ de las cuentas de API.
 *
 * Toda cuenta que se manda va SIEMPRE a este grupo — es el registro interno del dueño, su copia de
 * lo que se emitió. Mandarla además al grupo del cliente es una decisión aparte y por vez.
 *
 * Va en la configuración global y no en cada cliente a propósito: es uno solo, y si viviera copiado
 * en las 16 cuentas, el día que cambie el grupo habría que acordarse de tocar las 16.
 */
function getApiGrupoMatriz() { return String(getCfg('apiGrupoMatriz') || '').trim(); }
function setApiGrupoMatriz(v) {
  const x = String(v == null ? '' : v).trim();
  setCfg('apiGrupoMatriz', x);
  return { apiGrupoMatriz: x };
}

function getTelegramToken() { return String(getCfg('telegramBotToken') || '').trim(); }

/* EL DOMINIO DE LOS LINKS QUE VE EL CLIENTE.
   Sin esto el sistema arma el link con el dominio por el que entró quien apretó el botón, así que
   la misma factura podía salir con dos direcciones distintas según desde dónde se mandara. El
   cliente recibe un link: tiene que ser siempre el mismo y tiene que ser el de la marca. */
function getUrlPublica() { return String(getCfg('urlPublica') || '').trim().replace(/\/+$/, ''); }
function setUrlPublica(v) {
  const s = String(v || '').trim().replace(/\/+$/, '');
  if (!s) { setCfg('urlPublica', ''); return { ok: true, urlPublica: '' }; }
  const con = /^https?:\/\//i.test(s) ? s : 'https://' + s;
  // Sólo el dominio: un link con una ruta pegada de más genera direcciones que no existen.
  if (!/^https?:\/\/[a-z0-9.-]+(:\d+)?$/i.test(con)) {
    return { ok: false, error: 'Poné sólo el dominio, sin barra ni ruta. Ejemplo: app.latamgames.online' };
  }
  setCfg('urlPublica', con);
  return { ok: true, urlPublica: con };
}
function setTelegramToken(token) {
  const v = String(token || '').trim();
  setCfg('telegramBotToken', v);
  return { telegramBotToken: v };
}

module.exports = {
  getUrlPublica, setUrlPublica, getTelegramToken, setTelegramToken, getApiGrupoMatriz, setApiGrupoMatriz, getCfg, setCfg, FILE };
