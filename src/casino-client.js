/**
 * casino-client.js — login a un sistema de casino por USUARIO + CONTRASEÑA (NO api_token).
 *
 * Flujo REAL (verificado contra admin.463.life, 2026-05-26):
 *   1) GET  {base}/index.php?act=admin&area=login   → devuelve Set-Cookie: PHPSESSID=... (sesión anónima)
 *   2) POST {base}/index.php?act=admin&area=login   con esa cookie + login+password+sended=true
 *        → 302 Location: index.php  (login OK; la MISMA sesión queda autenticada)
 *        → si las credenciales son malas, vuelve a servir la página de login.
 *   3) GET  {base}/index.php?act=admin&area=info&response=js  con la cookie → JSON real = autenticado.
 *
 * IMPORTANTE: el POST "pelado" (sin el GET previo) NO funciona — el server necesita la sesión
 * anónima del paso 1 para "promoverla" a autenticada. Por eso hacemos GET y después POST con la cookie.
 *
 * Cada sistema (Casino / Europa / etc.) se entra por una URL distinta y tiene su propia sesión.
 */
const axios = require('axios');

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

/** Normaliza una URL: agrega https:// si falta y saca la barra final. */
function normalizeBaseUrl(url) {
  let u = String(url || '').trim().replace(/\/+$/, '');
  if (!u) return '';
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  return u;
}

/** Extrae el valor "PHPSESSID=xxx" de un header set-cookie (array). */
function extractPhpSessid(setCookieHeader) {
  const arr = setCookieHeader || [];
  const found = arr.find((c) => /^PHPSESSID=/i.test(c));
  return found ? found.split(';')[0] : null;
}

/**
 * Login en dos pasos (GET sesión anónima → POST credenciales). Devuelve la cookie autenticada.
 * @returns {Promise<{ok:boolean, sessionCookie?:string, status?:number, location?:string, error?:string, message?:string, stage?:string}>}
 */
async function login(baseUrl, user, password) {
  const base = normalizeBaseUrl(baseUrl);
  if (!base) return { ok: false, error: 'URL vacía' };
  const loginUrl = base + '/index.php?act=admin&area=login';
  const common = { timeout: 15000, validateStatus: () => true, maxRedirects: 0, headers: { 'User-Agent': USER_AGENT } };

  // 1) GET para obtener PHPSESSID anónimo
  let getResp;
  try {
    getResp = await axios.get(loginUrl, common);
  } catch (e) {
    return { ok: false, stage: 'get', error: e.code || 'ERR', message: e.message };
  }
  let cookie = extractPhpSessid(getResp.headers['set-cookie']);

  // 2) POST credenciales CON esa cookie
  const params = new URLSearchParams();
  params.append('login', user);
  params.append('password', password);
  params.append('sended', 'true');
  let postResp;
  try {
    postResp = await axios.post(loginUrl, params.toString(), {
      ...common,
      headers: {
        ...common.headers,
        'Content-Type': 'application/x-www-form-urlencoded',
        ...(cookie ? { Cookie: cookie } : {}),
      },
    });
  } catch (e) {
    return { ok: false, stage: 'post', error: e.code || 'ERR', message: e.message };
  }

  // El POST puede regenerar la sesión: si trae cookie nueva, usarla.
  const newCookie = extractPhpSessid(postResp.headers['set-cookie']);
  if (newCookie) cookie = newCookie;

  const location = postResp.headers.location || '';
  const isRedirect = postResp.status >= 300 && postResp.status < 400;
  // Señal preliminar (la confirmación definitiva la da verifySession con area=info):
  // login OK = hay cookie y el POST REDIRIGE (302) a algo que NO es la página de login (ej. index.php).
  // OJO: un POST con credenciales MALAS re-renderiza el form con status 200 → NO es éxito.
  const looksOk = !!cookie && isRedirect && !/login/i.test(location);

  return { ok: looksOk, sessionCookie: cookie, status: postResp.status, location };
}

/**
 * Verifica una sesión llamando a area=info. Si devuelve JSON con datos reales del panel,
 * la sesión está autenticada. (Sin sesión, ese endpoint devuelve HTML/redirect a login.)
 */
async function verifySession(baseUrl, sessionCookie) {
  const base = normalizeBaseUrl(baseUrl);
  const url = base + '/index.php?act=admin&area=info&response=js';
  try {
    const resp = await axios.get(url, {
      headers: { Cookie: sessionCookie, 'User-Agent': USER_AGENT },
      timeout: 15000,
      validateStatus: () => true,
      maxRedirects: 0,
    });
    const isJson = typeof resp.data === 'object' && resp.data !== null;
    const ok2xx = resp.status >= 200 && resp.status < 300;
    const body = isJson ? resp.data : {};
    // Engine 463.life: una sesión NO autenticada devuelve { noMain:true, redirect:"login", login:"" }.
    // Una sesión autenticada trae config/provider/etc. y NO trae esos flags.
    const notAuthed = body.noMain === true || body.redirect === 'login';
    const authed = isJson && ok2xx && !notAuthed;
    return { ok: !!authed, status: resp.status, isJson, keys: isJson ? Object.keys(body).slice(0, 12) : [], snippet: isJson ? '' : String(resp.data || '').slice(0, 120) };
  } catch (e) {
    return { ok: false, error: e.code || 'ERR', message: e.message };
  }
}

/**
 * Login + verificación en un paso (botón "Probar conexión").
 * `ok` (fuente de verdad) = la sesión quedó autenticada (confirmado con area=info).
 */
async function testConnection(baseUrl, user, password) {
  const lg = await login(baseUrl, user, password);
  if (!lg.sessionCookie) {
    return { ok: false, stage: lg.stage || 'login', login: lg };
  }
  const vf = await verifySession(baseUrl, lg.sessionCookie);
  return { ok: !!vf.ok, verified: !!vf.ok, stage: vf.ok ? 'verified' : 'login', sessionCookie: lg.sessionCookie, login: lg, verify: vf };
}

/**
 * Carga (o retira) fichas a una caja/usuario por su ID en el casino, usando la SESIÓN.
 * Replica el endpoint real del panel: POST area=balance (mismo que usa el chat del casino).
 *   query: act=admin&area=balance&response=js&type=frame&printing=true&id=<userId>
 *   body : balance_currency, amount, send=true, all=false, operation=in|out
 * Conservador (es plata): solo devuelve ok=true si el casino responde successMessage/dataList.
 * @returns {Promise<{ok:boolean, newBalance?:any, error?:string, status?:number, snippet?:string}>}
 */
async function loadChips(baseUrl, sessionCookie, userId, amount, currency = 'ARS', operation = 'in') {
  const base = normalizeBaseUrl(baseUrl);
  if (!base) return { ok: false, error: 'URL vacía' };
  if (!sessionCookie) return { ok: false, error: 'sin sesión' };
  if (!userId) return { ok: false, error: 'sin userId de la caja' };
  if (!(Number(amount) > 0)) return { ok: false, error: 'monto inválido' };

  const qs = new URLSearchParams({ act: 'admin', area: 'balance', response: 'js', type: 'frame', printing: 'true', id: String(userId) }).toString();
  const url = base + '/index.php?' + qs;
  const body = new URLSearchParams({ balance_currency: currency, amount: String(amount), send: 'true', all: 'false', operation }).toString();

  let resp;
  try {
    resp = await axios.post(url, body, {
      headers: { Cookie: sessionCookie, 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': USER_AGENT },
      timeout: 20000, validateStatus: () => true, maxRedirects: 0,
    });
  } catch (e) {
    return { ok: false, error: e.code || 'ERR', message: e.message };
  }

  const data = resp.data;
  const isJson = typeof data === 'object' && data !== null;
  if (isJson) {
    if (data.error || data.errorMessage) return { ok: false, error: String(data.error || data.errorMessage), status: resp.status };
    if (data.noMain || data.redirect === 'login') return { ok: false, error: 'sesión inválida (re-login necesario)', status: resp.status };
    if (data.successMessage || data.dataList) {
      const nb = (data.dataList && data.dataList.currencies && data.dataList.currencies[currency]) || (data.currencies && data.currencies[currency]);
      return { ok: true, newBalance: nb, status: resp.status };
    }
  }
  // Cualquier otra cosa = NO confirmar la carga (defensivo).
  return { ok: false, error: 'respuesta inesperada del casino', status: resp.status, snippet: (isJson ? JSON.stringify(data) : String(data || '')).slice(0, 200) };
}

module.exports = { normalizeBaseUrl, login, verifySession, testConnection, loadChips, USER_AGENT };
