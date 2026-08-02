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
  function mapNode(u, cur = 'ARS', multiMoneda = false) {
    const g = (x) => (x && typeof x === 'object') ? (x[cur] !== undefined ? x[cur] : '') : (x == null ? '' : x);
    const n = (x) => String(g(x)).replace(/,/g, ''); // numérico LIMPIO (sin separadores de miles → math directo)
    const node = {
      id: String(u.id), login: u.login || '', name: u.name || '',
      balance: n(u.balances), in: n(u.in), out: n(u.out), profit: n(u.profit),
      rtp: g(u.rtp), wager: n(u.wager), jackpot: n(u.jackpot), bonus: n(u.bonus),
      online: u.online === '1', terminals: u.terminals || '', game: u.game || '',
      currencies: u.currencies || [],
      nivel: nivelDeGroup(u.additional), // 'SuperAgente' | 'Distribuidor' | 'Agente' | '' (terminal)
    };
    if (multiMoneda) {
      // montos por CADA moneda con actividad (la misma respuesta trae todas; solo guardamos las != 0).
      const nc = (x, c) => String((x && typeof x === 'object') ? (x[c] !== undefined ? x[c] : '') : (x == null ? '' : x)).replace(/,/g, '');
      const m = {};
      CURRENCIES.forEach((c) => {
        const iin = nc(u.in, c), oout = nc(u.out, c), prof = nc(u.profit, c);
        if (Number(iin) !== 0 || Number(oout) !== 0 || Number(prof) !== 0) m[c] = { in: iin, out: oout, profit: prof };
      });
      node.montos = m;
    }
    return node;
  }

  /**
   * Lista nodos: sin `id` = todos (root, flat, cada uno con su total); con `id` = subárbol de ese nodo.
   * Requiere show_users=1 (clave) + el array de monedas. Período por from/to.
   */
  async function nodos({ from = '', to = '', id = null, cur = 'ARS', soloActivos = false, multiMoneda = false, currencies = null, extra = {} } = {}) {
    // currencies = subset a pedir (ej ['ARS']); null = todas. (Prueba: ¿pedir menos monedas acelera la query?)
    const curB = (currencies && currencies.length) ? Object.fromEntries(currencies.map((c) => [`currencies[${c}]`, '1'])) : curBody();
    // OJO: NADA de interval=month → ese param hace que el casino IGNORE from/to y devuelva
    // siempre el mes actual. Sin interval, from/to scopea el período correctamente (verificado).
    // soloActivos → inactive_users=active: el casino filtra SERVER-SIDE y devuelve SOLO los nodos
    // activos (verificado: MISMO total IN que 'all', 98% menos nodos → sin ruido y mucho más rápido).
    // `extra` pisa cualquier default (para casos especiales / pruebas de params).
    const body = {
      from, to, show_users: '1', provider: 'all',
      deleted_users: 'undelete', inactive_users: soloActivos ? 'active' : 'all', ...curB, ...extra,
    };
    const r = await apiCall('users', body, id ? { id: String(id) } : {});
    if (!r.ok) return r;
    const arr = (r.data && r.data.users) || [];
    return {
      ok: true,
      nodos: arr.filter((u) => u.id && String(u.login).toLowerCase() !== 'total').map((u) => mapNode(u, cur, multiMoneda)),
    };
  }

  /** Solo los SUPERAGENTES (plataformas que ve el GOD) — para el asignador con checkboxes. */
  async function superagentes({ from = '', to = '', cur = 'ARS', soloActivos = true } = {}) {
    const r = await nodos({ from, to, cur, soloActivos });
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

  const numC = (x) => {
    // Algunos motores (ej. casino.dark-ig.com) mandan la plata como objeto {value, convertedValue, currency}
    // en vez de número directo (ej. admbet888). Sacamos .value (el monto en la moneda pedida).
    if (x && typeof x === 'object' && !Array.isArray(x)) x = x.value != null ? x.value : x.convertedValue;
    const n = Number(String(x == null ? '' : x).replace(/,/g, ''));
    return isNaN(n) ? 0 : n;
  };

  /**
   * Helper del flujo Reportes/Estadísticas (2 pasos descubierto):
   *   1) POST area=reports (página) con los params → HTML con la URL de la tabla de datos (con un id de contexto).
   *   2) GET  area=reportstable&id=<ese>&response=js → JSON con las filas.
   * `append(b)` agrega los params propios de cada reporte. Devuelve {ok, raw[]} o {ok:false, error}.
   * IMPORTANTE: si el motor de reportes del casino está caído/ocupado devuelve una PÁGINA HTML de error
   * (no JSON) — lo detectamos y devolvemos ok:false en vez de tragárnoslo como tabla vacía (falla silenciosa).
   */
  async function _runReport(append, opts = {}, _retry = true) {
    const { filtros = [] } = opts;
    if (useSession) { const s = await ensureSession(); if (!s.ok) return { ok: false, error: s.error }; }
    if (!token && !useSession) return { ok: false, error: 'sin credenciales' };
    const refer = `${base}/index.php?act=admin&area=reports`;
    // Cookies ACUMULADAS del flujo — el motor puede rotar/agregar cookies entre el POST y el reportstable
    // (el browser las actualiza solo; nosotros usábamos una cookie FIJA del login → sesión desincronizada).
    const jar = {};
    if (useSession && sessionCookie) sessionCookie.split(';').forEach((p) => { const i = p.indexOf('='); if (i > 0) jar[p.slice(0, i).trim()] = p.slice(i + 1).trim(); });
    const cookieHdr = () => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
    const absorb = (resp) => { const sc = resp && resp.headers && resp.headers['set-cookie']; if (Array.isArray(sc)) sc.forEach((c) => { const kv = c.split(';')[0]; const i = kv.indexOf('='); if (i > 0) jar[kv.slice(0, i).trim()] = kv.slice(i + 1).trim(); }); };
    const hGet = () => ({ 'User-Agent': UA, ...(useSession ? { Cookie: cookieHdr() } : {}) });
    const hForm = () => ({ ...hGet(), 'Content-Type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'XMLHttpRequest', Referer: refer });
    // Paso 0: NAVEGAR (GET) como el browser — inicializa el estado del motor + captura cookies + DESCUBRE el
    // active_template seleccionado (el "Borrador" del usuario, que define el group_by por-superagente de ESE casino).
    let gHtml = '';
    try { const g = await axios.get(refer + (useSession ? '' : `&api_token=${encodeURIComponent(token)}`), { headers: hGet(), timeout: 60000, validateStatus: () => true }); absorb(g); gHtml = String(g.data || ''); } catch (e) { /* seguir */ }
    const tplM = gHtml.match(/name=["']?active_template["']?[^>]*value=["'](\d+)/i)
      || gHtml.match(/<option[^>]*value=["'](\d+)["'][^>]*\bselected/i)
      || gHtml.match(/active_template["']?\s*[:=]\s*["']?(\d+)/);
    const autoTpl = tplM ? tplM[1] : '';
    // Paso PREVIO: filtros (save_filter) — profit> para no ahogar al motor.
    for (const f of filtros) {
      const fb = new URLSearchParams();
      fb.append('column_name', String(f.column_name)); fb.append('condition', String(f.condition));
      fb.append('value', f.value == null ? '' : String(f.value)); fb.append('save_filter', '');
      if (!useSession) fb.append('api_token', token);
      try { const rf = await axios.post(`${base}/index.php?act=admin&area=reports`, fb.toString(), { headers: hForm(), timeout: 60000, validateStatus: () => true, maxRedirects: 0 }); absorb(rf); }
      catch (e) { /* si el filtro falla, seguimos igual con el reporte */ }
    }
    const b = new URLSearchParams();
    append(b);
    // 🔑 EL MOTOR EXIGE FECHA **CON HORA** (`YYYY-MM-DD HH:MM:SS`). Con la fecha pelada la descarta
    // en silencio y usa HOY — verificado: pidiendo julio armaba `from=2026-08-01 00:00:00&
    // to=2026-08-01 23:59:59`. Por eso todos los rangos devolvían lo mismo (siempre el día de hoy).
    const conHora = (v, fin) => {
      const s = String(v == null ? '' : v).trim();
      if (!s || /\d{2}:\d{2}:\d{2}/.test(s)) return s;
      return `${s} ${fin ? '23:59:59' : '00:00:00'}`;
    };
    if (b.has('from')) b.set('from', conHora(b.get('from'), false));
    if (b.has('to')) b.set('to', conHora(b.get('to'), true));
    if (!b.has('active_template') && autoTpl) b.append('active_template', autoTpl); // template seleccionado del usuario (auto)
    if (!useSession) b.append('api_token', token);
    let page;
    try { page = await axios.post(`${base}/index.php?act=admin&area=reports`, b.toString(), { headers: hForm(), timeout: 60000, validateStatus: () => true, maxRedirects: 0 }); absorb(page); }
    catch (e) { return { ok: false, error: 'reports page: ' + e.message }; }
    const html = String(page.data || '');
    // BUG HISTÓRICO ("Unknown error" por semanas): la página embebe VARIAS URLs de reportstable. La 1ra es la
    // del botón "exportar Excel" (response=xlsx) → devuelve página Error. La BUENA (la tabla AJAX) tiene
    // response=js + safe_content=1 + from + to. Usamos ESA tal cual (no la reconstruimos). El motor SÍ anda.
    const allRs = html.match(/area=reportstable[^"'\s\\]*/g) || [];
    const rsUrl = allRs.find((u) => /response=js/.test(u)) || allRs[0];
    if (!rsUrl) {
      // La página de reports volvió sin la tabla → suele ser la sesión caída (login redirect). Re-login y 1 reintento.
      if (useSession && _retry) { sessionCookie = ''; const s = await login(); if (s.ok) return _runReport(append, opts, false); }
      return { ok: false, error: 'no se encontró la tabla de datos (¿sesión inválida?)', debug: { pageSnippet: html.slice(0, 300).replace(/\s+/g, ' ') } };
    }
    let path = '/index.php?act=admin&' + rsUrl.replace(/&amp;/g, '&');
    // El `id=` que embebe el motor es el del usuario LOGUEADO (el GOD), y el reporte sale de su árbol.
    // Reemplazándolo por el id de otro nodo se obtiene el reporte DE ESE NODO — es la única forma de
    // abrir un DISTRIBUIDOR, porque agrupar por 'distributor' no desglosa (devuelve el total).
    if (opts.nodoId) {
      path = /[?&]id=/.test(path)
        ? path.replace(/([?&]id=)[^&]*/, `$1${encodeURIComponent(opts.nodoId)}`)
        : path + '&id=' + encodeURIComponent(opts.nodoId);
    }
    // ⚠️ Lo mismo con las FECHAS: el motor embebe en esa URL las del estado de la página, NO las que
    // mandamos en el POST. Sin pisarlas, el reporte devuelve SIEMPRE el mismo período — verificado:
    // un día, un mes y dos años daban las mismas 53 filas y el mismo profit.
    const pisar = (p, k, v) => ((v === '' || v == null) ? p
      : (new RegExp(`[?&]${k}=`).test(p)
        ? p.replace(new RegExp(`([?&]${k}=)[^&]*`), `$1${encodeURIComponent(v)}`)
        : `${p}&${k}=${encodeURIComponent(v)}`));
    // La URL de la tabla también lleva las fechas, y también con hora.
    path = pisar(path, 'from', conHora(opts.from, false));
    path = pisar(path, 'to', conHora(opts.to, true));
    // CLAVE (bug de semanas): la tabla AJAX AGREGA paginación al GET (sort/order/offset/limit). SIN esos params
    // el reportstable devuelve página de Error — NO era el id (7164043 era correcto). limit alto = traer TODO.
    //
    // ⚠️ Y HAY QUE PISARLO, no sólo agregarlo si falta: la página embebe el límite que tenga puesto
    // el usuario en la pantalla del casino. Si ahí quedó "1000" y el reporte tiene 2000 filas, nos
    // volvían 1000 y el resto desaparecía SIN AVISAR — media plata de menos y el número parecía bueno.
    const LIMITE = 100000;
    if (!/[?&]offset=/.test(path)) path += '&offset=0';
    if (!/[?&]sort=/.test(path)) path += '&sort=provider&order=desc';
    path = pisar(path, 'limit', String(LIMITE));
    path = pisar(path, 'offset', '0');
    if (!useSession) path += '&api_token=' + encodeURIComponent(token);
    let data, d;
    for (let t = 0; t < 5; t++) { // el reporte puede generarse ASYNC → si vuelve string (no listo), esperamos y reintentamos
      try { data = await axios.get(`${base}${path}`, { headers: { ...hGet(), Accept: 'application/json, text/javascript, */*; q=0.01', 'X-Requested-With': 'XMLHttpRequest', Referer: refer }, timeout: 60000, validateStatus: () => true }); absorb(data); }
      catch (e) { return { ok: false, error: 'reportstable: ' + e.message }; }
      d = data.data;
      if (typeof d !== 'string') break;
      if (t < 4) await new Promise((r) => setTimeout(r, 2500));
    }
    // Sano → array (a veces objeto keyed por índice). Error del motor → STRING (HTML "Unknown error occurred").
    if (typeof d === 'string') return { ok: false, error: 'el motor de reportes del casino devolvió un error (probá de nuevo en un rato)', debug: { rsSnippet: d.slice(0, 160).replace(/\s+/g, ' ') } };
    const raw = Array.isArray(d) ? d
      : (d && typeof d === 'object' ? (Array.isArray(d.rows) ? d.rows : (Array.isArray(d.data) ? d.data : Object.values(d).filter((v) => v && typeof v === 'object'))) : null);
    if (!Array.isArray(raw)) return { ok: false, error: 'respuesta inesperada del reporte del casino' };
    // ⚠️ TRUNCADO. El motor devuelve `total` = cuántas filas hay EN TOTAL, aparte de las que mandó.
    // Si mandó menos, el resto no está y el número sale corto. Antes esto no se miraba: con el
    // límite de la pantalla en 1000 y 1949 filas de verdad, faltaba casi la mitad de la plata y el
    // total parecía correcto.
    const totalDicho = (d && typeof d === 'object' && !Array.isArray(d) && d.total != null) ? Number(d.total) : null;
    if (Number.isFinite(totalDicho) && totalDicho > raw.length) {
      return { ok: false, error: `el casino dice que hay ${totalDicho} filas y mandó ${raw.length}: el reporte viene cortado, faltan datos.` };
    }
    if (raw.length >= LIMITE) {
      return { ok: false, error: `el reporte trajo ${raw.length} filas y ese es el tope: faltan datos. Achicá el período o pedilo por partes.` };
    }
    // Para diagnosticar el filtro de fechas: con qué params queda realmente la URL de la tabla.
    const debug = opts.debug ? {
      path: path.replace(/api_token=[^&]*/, 'api_token=***'),
      original: rsUrl,                        // la que armó el MOTOR, antes de que pisemos id/from/to
      todas: allRs.slice(0, 3),
      urls: allRs.length,
    } : undefined;
    return { ok: true, raw, debug };
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
  /**
   * REPORTE DE PROVEEDORES DE UN NODO PUNTUAL (por ejemplo un DISTRIBUIDOR).
   *
   * Por qué existe: agrupar por 'distributor' NO desglosa — el casino devuelve el total sin abrir por
   * cuenta (el campo id vuelve vacío). La forma de abrir un distribuidor es pedir el reporte "parado"
   * en ese nodo: es el mismo pedido, cambiando el `id` de la URL de la tabla por el del nodo.
   * Config del reporte (la que usa el panel): reports_base_group_by=users + reports_group_by=terminal.
   *
   * Devuelve las mismas filas que reporteProveedores: {saId, saLogin, provider, label, vendor, bet, win, profit}.
   */
  async function reporteProveedoresNodo({ nodoId, from = '', to = '', currency = 'ARS', activeTemplate = '', debug = false, filtros = [{ column_name: 'profit', condition: '>', value: '' }] } = {}) {
    if (!nodoId) return { ok: false, error: 'falta nodoId' };
    const r = await _runReport((b) => {
      b.append('statistic_type', 'on_bets'); b.append('conversion_type', 'current_currency');
      b.append('reports_base_group_by', 'users'); b.append('reports_group_by', 'terminal');
      ['id', 'login', 'provider', 'label', 'vendor', 'profit'].forEach((f) => b.append('reports_group_fields[]', f));
      b.append('currency', currency); b.append('from', from); b.append('to', to); b.append('save_template_name', '');
      if (activeTemplate) b.append('active_template', String(activeTemplate));
    }, { filtros, nodoId, from, to, debug });
    if (!r.ok) return r;
    const filas = r.raw.map((x) => ({
      saId: String(x.id == null ? '' : x.id), saLogin: x.login || '',
      superagent: x.superagent == null ? null : String(x.superagent),
      provider: x.provider || '', label: x.label || '', vendor: x.vendor || '',
      bet: numC(x.bet), win: numC(x.win), profit: numC(x.profit),
    })).filter((x) => x.provider || x.label || x.bet || x.win || x.profit);
    return { ok: true, nodoId: String(nodoId), from, to, currency, filas, debug: r.debug };
  }

  async function reporteProveedores({ from = '', to = '', currency = 'ARS', userGroupBy = 'superagent', activeTemplate = '', filtros = [{ column_name: 'profit', condition: '>', value: '' }] } = {}) {
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
    }, { filtros, from, to });
    if (!r.ok) return r;
    let filas = r.raw.map((x) => ({
      saId: String(x.id == null ? '' : x.id), saLogin: x.login || '',
      provider: x.provider || '', label: x.label || '', vendor: x.vendor || '',
      bet: numC(x.bet), win: numC(x.win), profit: numC(x.profit), rtp: numC(x.rtp),
    })).filter((x) => x.provider || x.label || x.bet || x.win || x.profit);
    if (general) {
      // Vista GENERAL = 1 fila POR PROVEEDOR. Algunos motores/templates traen filas por (superagente × proveedor)
      // → agregamos nosotros por proveedor (robusto, independiente del estado del template del casino). RTP = win/bet.
      const acc = {};
      for (const f of filas) {
        const k = `${f.provider}|${f.label}|${f.vendor}`;
        const a = acc[k] || (acc[k] = { saId: '', saLogin: '', provider: f.provider, label: f.label, vendor: f.vendor, bet: 0, win: 0, profit: 0 });
        a.bet += f.bet; a.win += f.win; a.profit += f.profit;
      }
      filas = Object.values(acc).map((a) => ({ ...a, rtp: a.bet ? Number((a.win / a.bet * 100).toFixed(2)) : 0 }));
    }
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
      monedas[cur] = r.ok ? { ok: true, filas: r.filas } : { ok: false, error: r.error, debug: r.debug };
    }
    return { ok: true, from, to, monedas };
  }

  /**
   * SONDA: corre el reporte con los parámetros crudos que se le pasen.
   *
   * Existe para poder averiguar qué combinación hace que el casino abra el reporte POR DISTRIBUIDOR.
   * Ya se descartaron dos candidatos con evidencia: `reports_user_group_by` se ignora (ocho valores
   * distintos devuelven exactamente las mismas 979 filas y 39 nodos) y la plantilla tampoco cambia
   * nada (Draft y Default dan idéntico). El que queda es `reports_group_by` / `reports_base_group_by`.
   *
   * No se usa en ningún cálculo: es solo para investigar.
   */
  async function sondaReporte({ from = '', to = '', nodoId = null, campos = null, params = {}, filtros = [{ column_name: 'profit', condition: '>', value: '' }] } = {}) {
    const r = await _runReport((b) => {
      b.append('statistic_type', 'on_bets');
      b.append('conversion_type', 'current_currency');
      Object.entries(params).forEach(([k, v]) => { if (v !== undefined && v !== null) b.append(k, String(v)); });
      (campos || ['id', 'login', 'provider', 'label', 'vendor', 'profit']).forEach((f) => b.append('reports_group_fields[]', f));
      b.append('from', from); b.append('to', to); b.append('save_template_name', '');
    }, { filtros, nodoId, from, to });
    if (!r.ok) return r;
    const filas = r.raw.map((x) => ({
      id: String(x.id == null ? '' : x.id), login: x.login || '',
      provider: x.provider || '', label: x.label || '', vendor: x.vendor || '',
      profit: x.profit == null ? '' : x.profit,
    }));
    return { ok: true, filas, columnas: r.raw[0] ? Object.keys(r.raw[0]) : [] };
  }

  /**
   * Las PLANTILLAS de reporte guardadas en el casino.
   *
   * El motor no tiene un parámetro para decir "agrupame por distribuidor": la agrupación sale de la
   * plantilla que el usuario tenga guardada y seleccionada en la pantalla de reportes. Probado: pedir
   * el reporte con ocho valores distintos de `reports_user_group_by` devuelve EXACTAMENTE lo mismo
   * (979 filas, 39 nodos, los mismos ids) — el parámetro se ignora.
   *
   * Por eso hace falta saber qué plantillas hay y cuál es la que abre por distribuidor: esa se pasa
   * como `active_template` y el reporte sale con esa forma.
   */
  async function plantillas() {
    if (useSession) { const s = await ensureSession(); if (!s.ok) return { ok: false, error: s.error }; }
    const refer = `${base}/index.php?act=admin&area=reports`;
    const jar = {};
    if (useSession && sessionCookie) sessionCookie.split(';').forEach((p) => { const i = p.indexOf('='); if (i > 0) jar[p.slice(0, i).trim()] = p.slice(i + 1).trim(); });
    const cookieHdr = () => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
    let html = '';
    try {
      const g = await axios.get(refer + (useSession ? '' : `&api_token=${encodeURIComponent(token)}`),
        { headers: { 'User-Agent': UA, ...(useSession ? { Cookie: cookieHdr() } : {}) }, timeout: 60000, validateStatus: () => true });
      html = String(g.data || '');
    } catch (e) { return { ok: false, error: 'no se pudo abrir la pantalla de reportes: ' + e.message }; }
    if (!html) return { ok: false, error: 'la pantalla de reportes vino vacía (¿sesión caída?)' };

    // el <select> de plantillas: cada opción es una forma de reporte guardada
    const opciones = [];
    const re = /<option[^>]*value=["'](\d+)["']([^>]*)>([\s\S]*?)<\/option>/gi;
    let m;
    while ((m = re.exec(html)) !== null) {
      const nombre = m[3].replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
      if (!nombre) continue;
      opciones.push({ id: m[1], nombre, seleccionada: /\bselected\b/i.test(m[2]) });
    }
    // deduplicar por id, quedándose con el primero
    const vistos = new Set();
    const lista = opciones.filter((o) => (vistos.has(o.id) ? false : (vistos.add(o.id), true)));
    const act = html.match(/name=["']?active_template["']?[^>]*value=["'](\d+)/i);
    return { ok: true, activa: act ? act[1] : (lista.find((o) => o.seleccionada) || {}).id || null, plantillas: lista };
  }

  /** Test de conexión: trae login + balances de la cuenta. */
  async function test() {
    const r = await apiCall('info', {});
    if (!r.ok) return r;
    const main = (r.data && r.data.main) || {};
    return { ok: true, login: (r.data.editUser && r.data.editUser.login) || main.login || '', balances: main.balances || {} };
  }

  return { apiCall, nodos, superagentes, totalNodo, buscar, gameHistory, profitPorProveedor, catalogoProveedores, reporte, reporteProveedores, reporteProveedoresNodo, reporteProveedoresMonedas, plantillas, sondaReporte, test };
}

module.exports = { makeClient, normUrl, CURRENCIES };
