/**
 * casino-api.js — cliente GENÉRICO del engine 463.life ("API for systems") por API TOKEN.
 *
 * Auth: api_token en el BODY del POST (sessionless, sin login). Patrón verificado contra
 * admin.463.life + igual al casino.service.js del chat del VPS.
 *   POST {url}/index.php?act=admin&area={area}&response=js   body: {...params, api_token}
 *
 * NO hardcodea ningún token: recibe {url, token} (de una conexión configurable). Soporta
 * múltiples masters (la app real usará una cuenta DEV con varios).
 *
 * Jerarquía: SuperAgente → Distribuidor → Agente → Caja. Cada nodo trae su total ROLLED-UP
 * en su propia fila (in=carga, out=retiro, profit=ganancia, rtp, balance). NO sumar hijos.
 */
const axios = require('axios');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const CURRENCIES = ['ARS', 'BRL', 'CLP', 'DOP', 'EUR', 'MXN', 'PEN', 'USD', 'UYU', 'VEF'];

function normUrl(u) {
  let s = String(u || '').trim().replace(/\/+$/, '');
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  return s;
}

/** Extrae "PHPSESSID=xxx" de un header set-cookie (array). */
function extractPhpsessid(setCookie) {
  const f = (setCookie || []).find((c) => /^PHPSESSID=/i.test(c));
  return f ? f.split(';')[0] : null;
}

/**
 * Nivel jerárquico de un nodo, leído de `additional.group` del raw de area=users.
 * El casino lo trae como "[Superagente]" | "[Distributor]" | "[Agente]" | ausente (terminal/caja).
 */
function nivelDeGroup(additional) {
  let g = '';
  try { const a = typeof additional === 'string' ? JSON.parse(additional) : (additional || {}); g = String(a.group || ''); } catch (e) { /* noop */ }
  g = g.replace(/^\[+|\]+$/g, '').trim(); // "[Superagente]" -> "Superagente"
  if (/super/i.test(g)) return 'SuperAgente';
  if (/distrib/i.test(g)) return 'Distribuidor';
  if (/agent/i.test(g)) return 'Agente';
  // Cualquier OTRO nivel que la cuenta exponga (ej. master/GOD desde la cuenta de Alexa, por
  // encima de TitanGOD) se devuelve tal cual para que el asignador lo ofrezca como filtro.
  return g; // '' = terminal / caja / jugador (sin group)
}

/**
 * makeClient — auth DUAL:
 *   - api_token: { url, token }  → token en el body (sessionless).
 *   - usuario/contraseña: { url, user, password } → login 2-pasos (GET sesión anónima → POST
 *     credenciales) → cookie PHPSESSID, reusada en los headers. Re-login automático si expira.
 * Si hay token, gana el token; si no, usa user/pass.
 */
function makeClient({ url, token, user, password } = {}) {
  const base = normUrl(url);
  const useSession = !token && !!(user && password);
  let sessionCookie = '';

  /** Login 2-pasos (igual que casino-client.js del repo). Devuelve {ok, cookie?|error}. */
  async function login() {
    const loginUrl = `${base}/index.php?act=admin&area=login`;
    const common = { timeout: 20000, validateStatus: () => true, maxRedirects: 0, headers: { 'User-Agent': UA } };
    let getR;
    try { getR = await axios.get(loginUrl, common); } catch (e) { return { ok: false, error: 'GET login: ' + e.message }; }
    let cookie = extractPhpsessid(getR.headers['set-cookie']);
    const body = new URLSearchParams({ login: user, password, sended: 'true' });
    let postR;
    try {
      postR = await axios.post(loginUrl, body.toString(), {
        ...common, headers: { ...common.headers, 'Content-Type': 'application/x-www-form-urlencoded', ...(cookie ? { Cookie: cookie } : {}) },
      });
    } catch (e) { return { ok: false, error: 'POST login: ' + e.message }; }
    const newCookie = extractPhpsessid(postR.headers['set-cookie']);
    if (newCookie) cookie = newCookie;
    const loc = postR.headers.location || '';
    const redirect = postR.status >= 300 && postR.status < 400;
    if (!(cookie && redirect && !/login/i.test(loc))) return { ok: false, error: 'usuario o contraseña incorrectos' };
    sessionCookie = cookie;
    return { ok: true, cookie };
  }
  async function ensureSession() { return sessionCookie ? { ok: true } : login(); }

  async function apiCall(area, body = {}, query = {}, _retry = true) {
    if (!base) return { ok: false, error: 'URL del casino no configurada' };
    if (!token && !useSession) return { ok: false, error: 'sin credenciales (ni api_token ni usuario/contraseña)' };
    if (useSession) { const s = await ensureSession(); if (!s.ok) return { ok: false, error: s.error }; }
    const qs = new URLSearchParams({ act: 'admin', area, response: 'js', ...query }).toString();
    const params = new URLSearchParams(useSession ? { ...body } : { ...body, api_token: token });
    const headers = { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA, ...(useSession && sessionCookie ? { Cookie: sessionCookie } : {}) };
    try {
      const r = await axios.post(`${base}/index.php?${qs}`, params.toString(), { headers, timeout: Number(process.env.CASINO_TIMEOUT_MS) || 120000, validateStatus: () => true, maxRedirects: 0 });
      const data = r.data;
      if (data && typeof data === 'object') {
        if (data.noMain || data.redirect === 'login') {
          if (useSession && _retry) { sessionCookie = ''; const s = await login(); if (s.ok) return apiCall(area, body, query, false); }
          return { ok: false, status: r.status, error: useSession ? 'sesión expirada / login inválido' : 'api_token inválido o expirado', data };
        }
        if (data.error) return { ok: false, status: r.status, error: String(data.error), data };
      }
      return { ok: r.status >= 200 && r.status < 300, status: r.status, data };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  function curBody() { const o = {}; CURRENCIES.forEach((c) => { o[`currencies[${c}]`] = '1'; }); return o; }

  /** Normaliza una fila de usuario del casino a un objeto limpio (valores en la moneda `cur`). */
  function mapNode(u, cur = 'ARS') {
    const g = (x) => (x && typeof x === 'object') ? (x[cur] !== undefined ? x[cur] : '') : (x == null ? '' : x);
    const n = (x) => String(g(x)).replace(/,/g, ''); // numérico LIMPIO (sin separadores de miles → math directo)
    return {
      id: String(u.id), login: u.login || '', name: u.name || '',
      balance: n(u.balances), in: n(u.in), out: n(u.out), profit: n(u.profit),
      rtp: g(u.rtp), wager: n(u.wager), jackpot: n(u.jackpot), bonus: n(u.bonus),
      online: u.online === '1', terminals: u.terminals || '', game: u.game || '',
      currencies: u.currencies || [],
      nivel: nivelDeGroup(u.additional), // 'SuperAgente' | 'Distribuidor' | 'Agente' | '' (terminal)
    };
  }

  /**
   * Lista nodos: sin `id` = todos (root, flat, cada uno con su total); con `id` = subárbol de ese nodo.
   * Requiere show_users=1 (clave) + el array de monedas. Período por from/to.
   */
  async function nodos({ from = '', to = '', id = null, cur = 'ARS' } = {}) {
    // OJO: NADA de interval=month → ese param hace que el casino IGNORE from/to y devuelva
    // siempre el mes actual. Sin interval, from/to scopea el período correctamente (verificado).
    const body = {
      from, to, show_users: '1', provider: 'all',
      deleted_users: 'undelete', inactive_users: 'all', ...curBody(),
    };
    const r = await apiCall('users', body, id ? { id: String(id) } : {});
    if (!r.ok) return r;
    const arr = (r.data && r.data.users) || [];
    return {
      ok: true,
      nodos: arr.filter((u) => u.id && String(u.login).toLowerCase() !== 'total').map((u) => mapNode(u, cur)),
    };
  }

  /** Solo los SUPERAGENTES (plataformas que ve el GOD) — para el asignador con checkboxes. */
  async function superagentes({ from = '', to = '', cur = 'ARS' } = {}) {
    const r = await nodos({ from, to, cur });
    if (!r.ok) return r;
    return { ok: true, superagentes: r.nodos.filter((nodo) => nodo.nivel === 'SuperAgente') };
  }

  /** Total propio de UN nodo (su fila dentro del listado flat). */
  async function totalNodo({ nodeId, from = '', to = '', cur = 'ARS' }) {
    const r = await nodos({ from, to, cur });
    if (!r.ok) return r;
    const n = r.nodos.find((x) => x.id === String(nodeId));
    return n ? { ok: true, nodo: n } : { ok: false, error: `nodo ${nodeId} no encontrado` };
  }

  /** Buscar un usuario por login (global) → id + sala. */
  async function buscar({ login, page = 1 }) {
    const r = await apiCall('search', { search_login: login, page: String(page) });
    if (!r.ok) return r;
    const users = (r.data && r.data.users) || [];
    return { ok: true, users: users.map((u) => ({ id: String(u.id), login: u.login, salaId: String(u.create || '') })) };
  }

  /** Game history de un usuario (bet/win/provider → profit por proveedor). */
  async function gameHistory({ userId, from = '', to = '' }) {
    const r = await apiCall('history', { from, to }, { id: String(userId) });
    if (!r.ok) return r;
    return { ok: true, history: (r.data && r.data.history) || [] };
  }

  /** Profit agregado POR PROVEEDOR de un usuario (sumando su game history). */
  async function profitPorProveedor({ userId, from = '', to = '' }) {
    const r = await gameHistory({ userId, from, to });
    if (!r.ok) return r;
    const acc = {};
    for (const h of r.history) {
      const p = h.provider || h.label || 'desconocido';
      const bet = Number(String(h.bet || 0).replace(/,/g, '')) || 0;
      const win = Number(String(h.win || 0).replace(/,/g, '')) || 0;
      acc[p] = acc[p] || { proveedor: p, bet: 0, win: 0, profit: 0 };
      acc[p].bet += bet; acc[p].win += win; acc[p].profit += (bet - win);
    }
    return { ok: true, proveedores: Object.values(acc) };
  }

  /** Catálogo de proveedores/sistemas de juego de la cuenta (de gamesSystem). */
  async function catalogoProveedores() {
    const r = await apiCall('users', {}, {});
    if (!r.ok) return r;
    const gs = (r.data && r.data.gamesSystem) || {};
    // keys con ':' = agregador:proveedor (el proveedor fino); sin ':' = el agregador.
    const items = Object.entries(gs).map(([code, label]) => ({ code, label: String(label), sub: code.includes(':'), agregador: code.split(':')[0] }));
    return { ok: true, proveedores: items };
  }

  const numC = (x) => { const n = Number(String(x == null ? '' : x).replace(/,/g, '')); return isNaN(n) ? 0 : n; };

  /**
   * Helper del flujo Reportes/Estadísticas (2 pasos descubierto):
   *   1) POST area=reports (página) con los params → HTML con la URL de la tabla de datos (con un id de contexto).
   *   2) GET  area=reportstable&id=<ese>&response=js → JSON con las filas.
   * `append(b)` agrega los params propios de cada reporte. Devuelve {ok, raw[]} o {ok:false, error}.
   * IMPORTANTE: si el motor de reportes del casino está caído/ocupado devuelve una PÁGINA HTML de error
   * (no JSON) — lo detectamos y devolvemos ok:false en vez de tragárnoslo como tabla vacía (falla silenciosa).
   */
  async function _runReport(append, _retry = true) {
    if (useSession) { const s = await ensureSession(); if (!s.ok) return { ok: false, error: s.error }; }
    if (!token && !useSession) return { ok: false, error: 'sin credenciales' };
    const b = new URLSearchParams();
    append(b);
    if (!useSession) b.append('api_token', token);
    const refer = `${base}/index.php?act=admin&area=reports`;
    const headers = { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA, 'X-Requested-With': 'XMLHttpRequest', Referer: refer, ...(useSession && sessionCookie ? { Cookie: sessionCookie } : {}) };
    let page;
    try { page = await axios.post(`${base}/index.php?act=admin&area=reports`, b.toString(), { headers, timeout: 60000, validateStatus: () => true, maxRedirects: 0 }); }
    catch (e) { return { ok: false, error: 'reports page: ' + e.message }; }
    const html = String(page.data || '');
    const m = html.match(/area=reportstable[^"']*/);
    if (!m) {
      // La página de reports volvió sin la tabla → suele ser la sesión caída (login redirect). Re-login y 1 reintento.
      if (useSession && _retry) { sessionCookie = ''; const s = await login(); if (s.ok) return _runReport(append, false); }
      return { ok: false, error: 'no se encontró la tabla de datos (¿sesión inválida?)' };
    }
    let path = '/index.php?act=admin&' + m[0].replace(/&amp;/g, '&');
    if (!useSession) path += '&api_token=' + encodeURIComponent(token);
    let data;
    try { data = await axios.get(`${base}${path}`, { headers: { 'User-Agent': UA, Accept: 'application/json, text/javascript, */*; q=0.01', 'X-Requested-With': 'XMLHttpRequest', Referer: refer, ...(useSession && sessionCookie ? { Cookie: sessionCookie } : {}) }, timeout: 60000, validateStatus: () => true }); }
    catch (e) { return { ok: false, error: 'reportstable: ' + e.message }; }
    const d = data.data;
    // Sano → array (a veces objeto keyed por índice). Error del motor → STRING (HTML "Unknown error occurred").
    if (typeof d === 'string') return { ok: false, error: 'el motor de reportes del casino devolvió un error (probá de nuevo en un rato)' };
    const raw = Array.isArray(d) ? d
      : (d && typeof d === 'object' ? (Array.isArray(d.rows) ? d.rows : (Array.isArray(d.data) ? d.data : Object.values(d).filter((v) => v && typeof v === 'object'))) : null);
    if (!Array.isArray(raw)) return { ok: false, error: 'respuesta inesperada del reporte del casino' };
    return { ok: true, raw };
  }

  /**
   * REPORTE DIARIO (in/out/profit/rtp por nodo). groupBy: 'superagent' | 'distributor' | 'agent'.
   */
  async function reporte({ groupBy = 'superagent', from = '', to = '', currency = 'ARS', activeTemplate = '' } = {}) {
    const r = await _runReport((b) => {
      b.append('statistic_type', 'on_money'); b.append('conversion_type', 'current_currency');
      b.append('reports_user_group_by', groupBy); b.append('reports_base_group_by', '');
      // Campos EXACTOS de la captura del browser (sin 'information', que rompía el motor).
      ['id', 'login', 'in', 'out', 'profit', 'rtp'].forEach((f) => b.append('reports_group_fields[]', f));
      b.append('currency', currency); b.append('from', from); b.append('to', to); b.append('save_template_name', '');
      if (activeTemplate) b.append('active_template', String(activeTemplate));
    });
    if (!r.ok) return r;
    const filas = r.raw.filter((x) => x && x.id).map((x) => ({
      id: String(x.id), login: x.login || '',
      in: numC(x.in), out: numC(x.out), profit: numC(x.profit), rtp: numC(x.rtp),
      count_in: numC(x.count_in), count_out: numC(x.count_out),
    }));
    return { ok: true, groupBy, from, to, filas };
  }

  /**
   * REPORTE DE PROVEEDORES: profit por (superagente × proveedor/sistema × juego). Usa statistic_type=on_bets
   * + reports_group_by=provider_label. Filas crudas del casino: {id,login,provider,label,vendor,profit}
   *   - id/login = superagente, provider = sistema/agregador (ej "Games System"), label = marca (ej "AMATIC"),
   *     vendor = código corto (ej "SL2"), profit = ganancia de ese proveedor.
   * `activeTemplate` opcional = id de un template guardado en el casino, por si la cuenta lo requiere.
   */
  async function reporteProveedores({ from = '', to = '', currency = 'ARS', userGroupBy = 'superagent', activeTemplate = '' } = {}) {
    const general = !userGroupBy; // userGroupBy='' = GENERAL (toda la plataforma, sin abrir por cuenta)
    const fields = general
      ? ['provider', 'label', 'vendor', 'bet', 'win', 'profit', 'rtp']      // vista general (captura del user)
      : ['id', 'login', 'provider', 'label', 'vendor', 'profit'];            // vista por superagente
    const r = await _runReport((b) => {
      b.append('statistic_type', 'on_bets'); b.append('conversion_type', 'current_currency');
      b.append('reports_user_group_by', userGroupBy || ''); b.append('reports_base_group_by', 'bets');
      b.append('reports_group_by', 'provider_label');
      fields.forEach((f) => b.append('reports_group_fields[]', f));
      b.append('currency', currency); b.append('from', from); b.append('to', to); b.append('save_template_name', '');
      if (activeTemplate) b.append('active_template', String(activeTemplate));
    });
    if (!r.ok) return r;
    const filas = r.raw.map((x) => ({
      saId: String(x.id == null ? '' : x.id), saLogin: x.login || '',
      provider: x.provider || '', label: x.label || '', vendor: x.vendor || '',
      bet: numC(x.bet), win: numC(x.win), profit: numC(x.profit), rtp: numC(x.rtp),
    })).filter((x) => x.provider || x.label || x.bet || x.win || x.profit);
    return { ok: true, from, to, currency, general, filas };
  }

  /**
   * Reporte de proveedores en VARIAS monedas (la misma plataforma): corre uno por moneda, SECUENCIAL
   * para no saturar el motor de reportes. `currencies` = subset de CURRENCIES (default todas).
   * Devuelve { ok, monedas: { ARS:{ok,filas}|{ok:false,error}, ... } }.
   */
  async function reporteProveedoresMonedas({ from = '', to = '', currencies = null, userGroupBy = '', activeTemplate = '' } = {}) {
    const list = (currencies && currencies.length) ? currencies.filter((c) => CURRENCIES.includes(c)) : CURRENCIES.slice();
    const monedas = {};
    for (const cur of list) {
      const r = await reporteProveedores({ from, to, currency: cur, userGroupBy, activeTemplate });
      monedas[cur] = r.ok ? { ok: true, filas: r.filas } : { ok: false, error: r.error };
    }
    return { ok: true, from, to, monedas };
  }

  /** Test de conexión: trae login + balances de la cuenta. */
  async function test() {
    const r = await apiCall('info', {});
    if (!r.ok) return r;
    const main = (r.data && r.data.main) || {};
    return { ok: true, login: (r.data.editUser && r.data.editUser.login) || main.login || '', balances: main.balances || {} };
  }

  return { apiCall, nodos, superagentes, totalNodo, buscar, gameHistory, profitPorProveedor, catalogoProveedores, reporte, reporteProveedores, reporteProveedoresMonedas, test };
}

module.exports = { makeClient, normUrl, CURRENCIES };
