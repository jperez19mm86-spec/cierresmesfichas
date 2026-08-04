/**
 * tbs-api.js — cliente del TERCER motor: TBS (`tbs2api.dark-a.com`).
 *
 * NO es el engine 463.life de Casino y Europa. Es otro producto, con otras rutas y otro formato.
 * Por eso agregarlo desde la pantalla de Config con el cliente de siempre daba
 * "usuario o contraseña incorrectos": `casino-api` postea a `index.php?act=admin&area=login` y
 * espera un redirect 3xx; TBS no tiene esa ruta y contesta JSON. Las credenciales nunca se
 * llegaban a probar — el mensaje era falso.
 *
 * ── Cómo se habla con TBS (capturado del panel el 4-ago-2026) ──────────────────────────────
 *
 *  1) LOGIN — devuelve el token, que es lo que autentica todo lo demás:
 *     POST {url}/index.php?act=users&area=login&response=js
 *     body: login=<usuario>&password=<clave>
 *     → { status:'ok'|'fail', error, content:{ user:{ id, token } } }
 *
 *  2) DATOS:
 *     POST {url}/!new/request.php
 *     body: token, data[cmd]=treeGet, data[filters][date][]=desde, data[filters][date][]=hasta,
 *           data[filters][providers][]=<id de grupo> (repetible), data[filters][show]=notNULL, lang
 *     → { cmd, data:{ tree, treeLevel, filters, UM } }
 *
 * Ventaja sobre el otro motor: todo JSON, sin cookies ni redirects que interpretar.
 *
 * ⚠️ TRES COSAS QUE HAY QUE SABER
 *  · Es LENTO: ~54 segundos por llamada (medido, respuesta de 101 KB). La caché no es opcional.
 *    `providers` es un ARRAY: conviene pedir varios grupos por llamada en vez de uno por uno.
 *  · `data[filters][parent]` NO filtra. Se le pasó el id de un agente y devolvió igual el árbol
 *    entero desde la raíz. Hay que traer todo y buscar el nodo por id (ver `agente()`).
 *  · El profit NO viene calculado: es `bet − win`.
 *
 * La zona horaria del panel es Africa/Blantyre (GMT+2) — ni la de Casino/Europa ni la nuestra.
 * Las fechas se mandan como las espera ÉL; quien llame decide qué significa "el mes".
 */
const axios = require('axios');

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36';

/** Deja la URL como base limpia: sin barra final, sin /index.php. */
function normUrl(u) {
  let s = String(u || '').trim();
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  return s.replace(/\/index\.php.*$/i, '').replace(/\/+$/, '');
}

function makeClient({ url, user, password, token: tokenFijo }) {
  const base = normUrl(url);
  let token = tokenFijo || '';        // si la cuenta tiene token propio, no hace falta login
  let cookies = '';                   // la PÁGINA (no la API) se autentica con la cookie de sesión

  const comun = (extra = {}) => ({
    timeout: 120000,                  // 54s es lo normal acá; 120 da margen sin colgarse para siempre
    validateStatus: () => true,
    headers: {
      'User-Agent': UA,
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'X-Requested-With': 'XMLHttpRequest',
      ...extra,
    },
  });

  /** Login. Devuelve {ok, token} — el token es lo que después autentica los pedidos. */
  async function login() {
    if (!user || !password) return { ok: false, error: 'falta usuario o contraseña' };
    const u = `${base}/index.php?act=users&area=login&response=js`;
    let r;
    try {
      r = await axios.post(u, new URLSearchParams({ login: user, password }).toString(), comun());
    } catch (e) { return { ok: false, error: 'no se pudo conectar: ' + e.message }; }
    const d = r.data;
    if (!d || typeof d !== 'object') {
      const txt = typeof d === 'string' ? d.slice(0, 120).replace(/\s+/g, ' ') : '';
      return { ok: false, error: `respuesta inesperada (HTTP ${r.status}): esta URL no parece un panel TBS${txt ? ' — ' + txt : ''}` };
    }
    // ⚠️ TBS responde status "success" cuando entra y "fail" cuando no. Comparar contra "ok"
    // rechazaba logins válidos: el panel decía que sí y el cliente lo leía como que no.
    const okStatus = d.status === 'success' || d.status === 'ok';
    const t = ((d.content || {}).user || {}).token;
    if (!okStatus || !t) {
      // Que diga QUÉ pasó. "no se pudo autenticar" a secas obliga a adivinar entre credenciales
      // mal, IP bloqueada o cuenta sin permisos — y son arreglos distintos.
      // TBS contesta "Account not found" tanto si el usuario no existe como si la clave está mal.
      const dice = d.error || (d.status && d.status !== 'ok' ? `status "${d.status}"` : '');
      const sinToken = okStatus && !t ? ' (entró pero no devolvió token)' : '';
      return { ok: false, error: `TBS rechazó el login: ${dice || 'sin explicación'}${sinToken}`, respuesta: d };
    }
    token = t;
    // La API se conforma con el token, pero el HTML del panel pide la cookie de sesión de PHP.
    // Viene en este mismo login; si no se guarda acá, después no hay forma de pedirla.
    const set = r.headers && (r.headers['set-cookie'] || r.headers['Set-Cookie']);
    if (Array.isArray(set) && set.length) cookies = set.map((c) => String(c).split(';')[0]).join('; ');
    return { ok: true, token: t, userId: ((d.content || {}).user || {}).id };
  }

  async function asegurarToken() { return token ? { ok: true } : login(); }

  /**
   * Llama a la API de datos. `reintento` deja renovar el token una vez si venció:
   * el token de sesión caduca y el error no siempre lo dice claro.
   */
  async function pedir(cmd, filtros = {}, reintento = true) {
    const s = await asegurarToken();
    if (!s.ok) return s;

    const b = new URLSearchParams();
    b.set('token', token);
    b.set('data[cmd]', cmd);
    (filtros.fechas || []).forEach((f) => b.append('data[filters][date][]', f));
    const grupos = filtros.proveedores && filtros.proveedores.length ? filtros.proveedores : [''];
    grupos.forEach((g) => b.append('data[filters][providers][]', String(g)));
    (filtros.labels || ['']).forEach((l) => b.append('data[filters][labels][]', String(l)));
    (filtros.monedas || ['']).forEach((m) => b.append('data[filters][currencys][]', String(m)));
    b.set('data[filters][show]', filtros.show || 'notNULL');
    b.set('data[filters][parent]', filtros.parent || '');   // ⚠️ el server lo ignora, ver cabecera
    b.set('lang', filtros.lang || 'en');

    let r;
    try { r = await axios.post(`${base}/!new/request.php`, b.toString(), comun()); }
    catch (e) { return { ok: false, error: 'la consulta falló: ' + e.message }; }

    const d = r.data;
    if (!d || typeof d !== 'object' || !d.data) {
      // sesión vencida: el token dejó de valer y devuelve algo vacío
      if (reintento && user && password) { token = ''; const l = await login(); if (l.ok) return pedir(cmd, filtros, false); }
      return { ok: false, error: `respuesta vacía o inesperada (HTTP ${r.status})` };
    }
    return { ok: true, data: d.data };
  }

  const num = (x) => { const n = Number(x); return Number.isFinite(n) ? n : 0; };

  /** Recorre el árbol y devuelve el nodo con ese id (a cualquier profundidad). */
  function buscarNodo(nodos, id) {
    const objetivo = String(id);
    const pila = [...(nodos || [])];
    while (pila.length) {
      const n = pila.shift();
      if (!n || typeof n !== 'object') continue;
      if (String(n.id) === objetivo) return n;
      if (Array.isArray(n.tree)) pila.push(...n.tree);
    }
    return null;
  }

  /** Suma las HOJAS de un nodo (las que tienen moneda propia) agrupando por divisa. */
  function sumarPorDivisa(nodo) {
    const acc = {};
    const pila = [nodo];
    while (pila.length) {
      const n = pila.shift();
      if (!n || typeof n !== 'object') continue;
      if (n.currency && (n.bet != null || n.win != null)) {
        const d = String(n.currency);
        acc[d] = acc[d] || { bet: 0, win: 0, profit: 0, salas: 0 };
        acc[d].bet += num(n.bet); acc[d].win += num(n.win); acc[d].salas += 1;
        acc[d].profit = acc[d].bet - acc[d].win;      // el profit NO viene: se calcula
      }
      if (Array.isArray(n.tree)) pila.push(...n.tree);
    }
    return acc;
  }

  /**
   * El profit de UNOS agentes puntuales, por grupo de proveedores y por moneda.
   * @param agentes  ids de los nodos que interesan (el dueño factura solo algunos)
   * @param grupos   ids de grupo de proveedores; se piden todos en la MISMA llamada
   * @returns { ok, porAgente: { <id>: { login, porDivisa: { ARS:{bet,win,profit,salas} } } }, faltantes }
   */
  async function profitDeAgentes({ desde, hasta, agentes = [], grupos = [] }) {
    const r = await pedir('treeGet', {
      fechas: [desde, hasta],
      proveedores: grupos,
    });
    if (!r.ok) return r;

    const raiz = r.data.tree || [];
    const porAgente = {}; const faltantes = [];
    for (const id of agentes) {
      const n = buscarNodo(raiz, id);
      if (!n) { faltantes.push(String(id)); continue; }
      porAgente[String(id)] = { id: String(id), login: n.login || '', porDivisa: sumarPorDivisa(n) };
    }
    return { ok: true, porAgente, faltantes, grupos };
  }

  /**
   * Los GRUPOS de proveedores con su id, tal como los lista el desplegable del panel.
   *
   * No salen de la API de datos sino del HTML de la página: el `<select name="provider">`.
   * Hacen falta para mapear cada grupo con su fila de la matriz, que es lo que decide el costo.
   * Los que dicen "(prepayment)" son proveedores SUELTOS, no paquetes.
   */
  async function grupos() {
    // Siempre login de nuevo: hace falta la COOKIE de sesión, y un token guardado no la trae.
    const l = await login();
    if (!l.ok) return l;

    const limpio = (s) => String(s).replace(/<[^>]*>/g, '')
      .replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/&#0?39;|&apos;/g, "'")
      .replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
    const fila = (id, nombre) => ({ id: String(id), nombre, suelto: /\(prepayment\)/i.test(nombre) });

    const diag = [];
    const paginas = [`${base}/?act=diller`, `${base}/index.php?act=diller`, `${base}/`];
    for (const u of paginas) {
      let r;
      try {
        r = await axios.get(u, {
          timeout: 60000, validateStatus: () => true,
          headers: { 'User-Agent': UA, Cookie: `${cookies}${cookies ? '; ' : ''}token=${token}` },
        });
      } catch (e) { diag.push(`${u}: ${e.message}`); continue; }
      const html = String(r.data || '');
      diag.push(`${u}: HTTP ${r.status}, ${html.length} bytes`);

      // 1) Un <select> de verdad. El name puede ser provider, providers[], provider_id…
      const selects = [...html.matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/gi)];
      if (selects.length) diag.push(`selects: ${selects.map((s) => (s[1].match(/(?:name|id)=["']([^"']+)["']/i) || [, '?'])[1]).join(', ')}`);
      for (const s of selects) {
        if (!/provider|diller|group/i.test(s[1])) continue;
        const out = [];
        // El value puede venir sin comillas (<option value=10>): pedirlas descartaba todo.
        for (const o of s[2].matchAll(/<option\b[^>]*?\bvalue=(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/option>/gi)) {
          const id = (o[1] ?? o[2] ?? o[3] ?? '').trim(); const nombre = limpio(o[4]);
          if (!id || !nombre || /^-+$/.test(nombre.replace(/\s/g, ''))) continue;
          out.push(fila(id, nombre));
        }
        if (out.length) return { ok: true, grupos: out, origen: `select de ${u}` };
        diag.push(`el select de proveedores vino vacío — así empieza: ${s[2].replace(/\s+/g, ' ').trim().slice(0, 400)}`);
      }

      // 2) Widget de JS: la lista viaja como JSON dentro de la página.
      //    Se buscan objetos con id + nombre, que es la forma que tienen acá.
      const out = [];
      const vistos = new Set();
      for (const m of html.matchAll(/\{[^{}]*?"id"\s*:\s*"?(\d+)"?[^{}]*?"(?:name|title|label|provider)"\s*:\s*"((?:[^"\\]|\\.)*)"[^{}]*?\}/gi)) {
        const id = m[1]; const nombre = limpio(m[2].replace(/\\"/g, '"').replace(/\\\//g, '/'));
        if (!nombre || vistos.has(id)) continue;
        vistos.add(id); out.push(fila(id, nombre));
      }
      if (out.length >= 10) return { ok: true, grupos: out, origen: `json embebido en ${u}` };
      if (out.length) diag.push(`json embebido: solo ${out.length} candidatos, poco para 53 grupos`);
      if (/name=["']password["']/i.test(html) && !selects.length) diag.push('volvió el login: la cookie no autenticó');
    }
    return { ok: false, error: 'no encontré la lista de grupos en el panel', diag };
  }

  /** Test de conexión: hace el login y devuelve con qué cuenta entró. */
  async function test() {
    const l = await login();
    if (!l.ok) return l;
    return { ok: true, login: user, userId: l.userId, motor: 'tbs' };
  }

  return { login, pedir, profitDeAgentes, grupos, buscarNodo, sumarPorDivisa, test, get token() { return token; } };
}

module.exports = { makeClient, normUrl };
