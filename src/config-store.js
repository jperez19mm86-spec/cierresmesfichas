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

function getTelegramToken() { return String(getCfg('telegramBotToken') || '').trim(); }
function setTelegramToken(token) {
  const v = String(token || '').trim();
  setCfg('telegramBotToken', v);
  return { telegramBotToken: v };
}

module.exports = { getTelegramToken, setTelegramToken, getCfg, setCfg, FILE };
