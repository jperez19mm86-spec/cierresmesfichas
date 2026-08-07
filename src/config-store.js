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
function setTelegramToken(token) {
  const v = String(token || '').trim();
  setCfg('telegramBotToken', v);
  return { telegramBotToken: v };
}

module.exports = { getTelegramToken, setTelegramToken, getApiGrupoMatriz, setApiGrupoMatriz, getCfg, setCfg, FILE };
