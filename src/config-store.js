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

/* ── TU GRUPO, EL QUE ES SÓLO TUYO ───────────────────────────────────────────────────────────
 * Distinto del de la matriz. Eran DOS COSAS GUARDADAS EN LA MISMA CLAVE: «el grupo donde va la
 * copia de las cuentas de TBS» y «el grupo interno de ella», y por eso al de TBS le entraban
 * también los avisos del chat — que un cliente avisó un pago, a quién le falta cobrar, la lista
 * diaria de pendientes.
 *
 * Vacío cae al de la matriz, que es lo que hacía antes: así el día que alguien despliegue esto sin
 * cargar el grupo nuevo, los avisos siguen llegando a algún lado en vez de perderse.
 */
function getGrupoInterno() {
  return String(getCfg('grupoInterno') || '').trim() || getApiGrupoMatriz();
}
function setGrupoInterno(v) {
  const x = String(v == null ? '' : v).trim();
  setCfg('grupoInterno', x);
  return { grupoInterno: x };
}

/* ── DIVISAS QUE NO SE CONSULTAN NUNCA ───────────────────────────────────────────────────────
 * Una divisa habilitada en el casino NO es una divisa que exista de verdad. `ALL` (el lek albanés)
 * está prendida en dos superagentes porque alguien la tocó sin querer en la pantalla de divisas, y
 * el casino la acepta igual. Mientras esté prendida, la Foto del mes la pide todos los meses: una
 * consulta más por vuelta, por conexión, para traer siempre cero.
 *
 * Por eso esto NO se arregla mirando el casino ni mirando las fichas pedidas:
 *   - el casino dice que sí (está habilitada de verdad, ese es el error),
 *   - las fichas pedidas dicen que no, pero también dicen que no cuando un cliente pasó un mes sin
 *     pedir — y con esa señal ya se borraron divisas buenas una vez.
 * La única que sabe cuáles no van a moverse nunca es la dueña. Entonces se escriben acá a mano.
 *
 * Es global y no por panel: si el lek no existe para el negocio, no existe en ninguna conexión.
 * Nunca toca lo guardado en el panel: filtra al momento de preguntar. El día que una de estas
 * empiece a moverse de verdad, se saca de la lista y vuelve sola, sin re-linkear nada.
 */
const DIVISAS_IGNORADAS_DEFAULT = ['ALL'];

function getDivisasIgnoradas() {
  const guardado = getCfg('divisasIgnoradas');
  // Distinto de vacío: null es "nunca se configuró" → el default. '' es "la dueña las quiere todas".
  if (guardado === null || guardado === undefined) return DIVISAS_IGNORADAS_DEFAULT.slice();
  return String(guardado).split(',').map((x) => x.trim().toUpperCase()).filter(Boolean);
}
function setDivisasIgnoradas(v) {
  const lista = (Array.isArray(v) ? v : String(v == null ? '' : v).split(','))
    .map((x) => String(x).trim().toUpperCase())
    .filter((x) => /^[A-Z]{2,6}$/.test(x));
  const limpio = [...new Set(lista)].sort();
  setCfg('divisasIgnoradas', limpio.join(','));
  return { divisasIgnoradas: limpio };
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
  getGrupoInterno, setGrupoInterno,
  getDivisasIgnoradas, setDivisasIgnoradas,
  getUrlPublica, setUrlPublica, getTelegramToken, setTelegramToken, getApiGrupoMatriz, setApiGrupoMatriz, getCfg, setCfg, FILE };
