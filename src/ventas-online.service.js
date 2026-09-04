/**
 * ventas-online.service.js — EL PUENTE con el sistema en línea, que es donde viven los pedidos.
 *
 * El motor que factura (% base, tipos de cambio, emisión a la deuda) está acá, en el OS. Pero los
 * PEDIDOS —que son la base de lo que se le cobra a cada cliente— se toman en el sistema operativo
 * (app.latamgames.online). Sin este puente, la factura de consumo del OS sale en cero aunque en el
 * online haya cientos de pedidos cargados.
 *
 * Y los dos padrones NO comparten códigos: en el online un pedido viene con "M526" o "A813", y acá
 * el cliente se llama "Marcelo" o "Gabriel@". El mapeo no se adivina por el nombre — se dedujo
 * cruzando cada pedido con el NODO DEL CASINO al que se cargó, que es el mismo dato en los dos
 * lados. 28 de 38 códigos salieron con el 100% de sus pedidos apuntando a un solo cliente.
 *
 * Reglas que decidió el dueño:
 *   · para la factura de CONSUMO manda el CÓDIGO: todo lo de "M526" va a Marcelo, aunque parte se
 *     haya cargado en paneles de JJ. Marcelo y JJ (igual que Titan y Juan) son la misma línea
 *     comercial con porcentajes distintos de proveedores.
 *   · para la factura de EXTERNOS manda el PANEL, porque ahí cada cliente tiene su propio %.
 */
const { db } = require('./db');
const crypto = require('./crypto-util');

const nowISO = () => new Date().toISOString();
const K = (s) => String(s || '').trim();

// ── configuración de la conexión ────────────────────────────────────────────
// Se guarda igual que las conexiones al casino: la contraseña cifrada en reposo, nunca en el
// código ni en una variable de entorno que haya que sincronizar entre dos servicios.
function getConfig(conClave = false) {
  const r = db.prepare("SELECT value FROM config WHERE key='ventasOnline'").get();
  if (!r) return null;
  let c;
  try { c = JSON.parse(r.value); } catch (e) { return null; }
  if (!conClave) return { url: c.url, usuario: c.usuario, tieneClave: !!c.password };
  return { ...c, password: c.password ? crypto.decrypt(c.password) : '' };
}

function setConfig({ url, usuario, password }) {
  const actual = getConfig(true) || {};
  const c = {
    /* Mandar la URL vacía APAGA el puente. Antes no se podía: `K(url) || actual.url` conservaba la
       vieja, así que una vez configurado no había forma de sacarlo desde la pantalla.
       Importa porque el puente apunta a `app.latamgames.online`, que después de la migración es
       ESTE MISMO servicio: el OS se logueaba contra sí mismo y por eso devolvía 401. Si alguien
       "lo arregla" poniéndole las credenciales del propio OS, funciona — y ahí la facturación
       vuelve a rutear por `ventas_mapeo`, salteando la marca por panel y la verificación de los
       paneles de tránsito. Apagarlo es la forma de que eso no pueda pasar.
       `undefined` (no vino el campo) conserva; `''` borra. */
    url: url === undefined ? (actual.url || '') : K(url),
    usuario: K(usuario) || actual.usuario || '',
    // si no mandan contraseña nueva, se conserva la que había (no se borra por editar la URL)
    password: password ? crypto.encrypt(String(password)) : (actual.password ? crypto.encrypt(actual.password) : ''),
  };
  db.prepare("INSERT INTO config (key, value) VALUES ('ventasOnline', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .run(JSON.stringify(c));
  return getConfig();
}

// ── el mapeo código → cliente ───────────────────────────────────────────────
function mapa() {
  const out = {};
  db.prepare('SELECT codigo, cliente_id, origen FROM ventas_mapeo').all()
    .forEach((r) => { out[String(r.codigo).toLowerCase()] = { cliente_id: r.cliente_id, origen: r.origen }; });
  return out;
}

function setMapeo(codigo, cliente_id, origen = 'a mano') {
  const c = K(codigo); if (!c) return false;
  if (!cliente_id) { db.prepare('DELETE FROM ventas_mapeo WHERE codigo=?').run(c); return true; }
  db.prepare(`INSERT INTO ventas_mapeo (codigo, cliente_id, origen, actualizado_at) VALUES (?,?,?,?)
              ON CONFLICT(codigo) DO UPDATE SET cliente_id=excluded.cliente_id, origen=excluded.origen, actualizado_at=excluded.actualizado_at`)
    .run(c, String(cliente_id), K(origen), nowISO());
  return true;
}

function listMapeo() {
  return db.prepare('SELECT codigo, cliente_id, origen, actualizado_at FROM ventas_mapeo ORDER BY codigo').all();
}

// ── traer los pedidos ───────────────────────────────────────────────────────
let _sesion = { cookie: '', at: 0 };

async function _login() {
  const c = getConfig(true);
  if (!c || !c.url || !c.usuario || !c.password) return { ok: false, error: 'falta configurar la conexión con el sistema en línea' };
  const r = await fetch(c.url.replace(/\/+$/, '') + '/api/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ user: c.usuario, password: c.password }),
  }).catch((e) => ({ status: 0, _err: String((e && e.message) || e) }));
  if (!r || r.status !== 200) return { ok: false, error: `no se pudo entrar al sistema en línea (${r && r.status ? r.status : r._err})` };
  const ck = (r.headers.getSetCookie ? r.headers.getSetCookie() : []).map((x) => x.split(';')[0]).join('; ');
  _sesion = { cookie: ck, at: Date.now() };
  return { ok: true, cookie: ck };
}

/** Los pedidos del sistema en línea. La sesión se reusa 20 minutos. */
async function _pedidos() {
  const c = getConfig(true);
  if (!c || !c.url) return { ok: false, error: 'falta configurar la conexión con el sistema en línea' };
  if (!_sesion.cookie || Date.now() - _sesion.at > 20 * 60 * 1000) {
    const l = await _login(); if (!l.ok) return l;
  }
  const url = c.url.replace(/\/+$/, '') + '/api/pedidos';
  let r = await fetch(url, { headers: { cookie: _sesion.cookie } }).then((x) => x.json()).catch((e) => ({ ok: false, error: String((e && e.message) || e) }));
  if (!r.ok) {                                    // la sesión pudo haber caducado: un reintento
    const l = await _login(); if (!l.ok) return l;
    r = await fetch(url, { headers: { cookie: _sesion.cookie } }).then((x) => x.json()).catch((e) => ({ ok: false, error: String((e && e.message) || e) }));
  }
  return r.ok ? { ok: true, pedidos: r.pedidos || [] } : { ok: false, error: r.error || 'el sistema en línea no devolvió los pedidos' };
}

/**
 * Lo vendido en un mes, ya traducido a clientes del OS.
 * Misma forma que `pedidosStore.ventasDelMes`, para que Facturación no tenga que enterarse de
 * dónde vino: { [codigo]: { count, porDivisa, anulando } } + el mapeo aplicado.
 */
async function ventasDelMes(mes) {
  const m = String(mes || '').slice(0, 7);
  const r = await _pedidos();
  if (!r.ok) return r;
  const mp = mapa();
  const porCliente = {}; const sinMapeo = {};
  for (const p of r.pedidos) {
    if (p.estado !== 'cargado' && p.estado !== 'anulando') continue;
    const f = String(p.resueltoAt || p.createdAt || '').slice(0, 7);
    if (f !== m) continue;
    const cod = String(p.codigo || '—');
    const dest = mp[cod.toLowerCase()];
    const dv = String(p.divisa || 'ARS').toUpperCase();
    const monto = Number(p.monto) || 0;
    if (!dest) {
      const s = sinMapeo[cod] = sinMapeo[cod] || { codigo: cod, count: 0, porDivisa: {} };
      s.count++; s.porDivisa[dv] = (s.porDivisa[dv] || 0) + monto;
      continue;
    }
    const o = porCliente[dest.cliente_id] = porCliente[dest.cliente_id] || { count: 0, porDivisa: {}, porUserId: {}, anulando: { count: 0, porDivisa: {} }, codigos: new Set() };
    o.codigos.add(cod);
    if (p.estado === 'anulando') {
      o.anulando.count++; o.anulando.porDivisa[dv] = (o.anulando.porDivisa[dv] || 0) + monto;
      continue;
    }
    o.count++; o.porDivisa[dv] = (o.porDivisa[dv] || 0) + monto;
  }
  Object.values(porCliente).forEach((o) => { o.codigos = [...o.codigos]; });
  return { ok: true, mes: m, porCliente, sinMapeo: Object.values(sinMapeo) };
}

/**
 * ¿Los pedidos entraron con el código de otro cliente?
 *
 * El pedido dice a nombre de QUIÉN se pidió (su código); el panel dice DÓNDE cayeron las fichas.
 * Cuando un panel se muda de un cliente a otro, los pedidos siguen llegando con el código viejo
 * y la factura se la come el que no era. Pasó de verdad: 8 de los 15 pedidos de julio de Juan se
 * cargaron en paneles de Titan — 483.886 USDT, el 90% de lo que se le facturaba a Juan.
 *
 * Acá se cruzan las dos cosas. No corrige nada: dice dónde no coinciden.
 * Los paneles que no se reconocen se informan aparte — así apareció que el sistema en línea
 * escribe "463.life" y el OS lo tiene como "463.live", y por esa letra no cruzaba nada.
 */
async function cruceConPaneles(mes) {
  const m = String(mes || '').slice(0, 7);
  const r = await _pedidos();
  if (!r.ok) return r;
  const clientes = require('./clientes-store').list().clientes;
  const nombreDe = {}; clientes.forEach((c) => { nombreDe[c.id] = c.nombre || c.nombreVisible || c.codigo; });
  // Se indexa por el nombre Y por los alias: el sistema en línea escribe "463.life" donde el OS
  // tiene "463.live", y por esa letra el pedido no cruzaba con nada.
  const dueno = {};
  require('./paneles-store').list().forEach((p) => {
    if (!p.cliente_id) return;
    [p.nombre, ...(p.alias || [])].forEach((n) => {
      const k = String(n || '').trim().toLowerCase();
      if (k) dueno[k] = p.cliente_id;
    });
  });
  const mp = mapa();
  const cruces = {}; const panelesRaros = {};
  for (const p of r.pedidos) {
    if (p.estado !== 'cargado' && p.estado !== 'anulando') continue;
    if (String(p.resueltoAt || p.createdAt || '').slice(0, 7) !== m) continue;
    const dest = mp[String(p.codigo || '').toLowerCase()];
    if (!dest) continue;                                   // sin mapear: ya lo avisa la factura
    const nom = String(p.cajaUsuario || p.userId || '').trim();
    const owner = dueno[nom.toLowerCase()];
    const dv = String(p.divisa || 'ARS').toUpperCase();
    const monto = Number(p.monto) || 0;
    if (!owner) {
      const s = panelesRaros[nom] = panelesRaros[nom] || { panel: nom, count: 0, porDivisa: {}, deCodigo: new Set() };
      s.count++; s.porDivisa[dv] = (s.porDivisa[dv] || 0) + monto; s.deCodigo.add(p.codigo);
      continue;
    }
    if (owner === dest.cliente_id) continue;               // coincide: nada que decir
    const k = `${dest.cliente_id}|${owner}`;
    const c = cruces[k] = cruces[k] || {
      seFacturaA: nombreDe[dest.cliente_id] || dest.cliente_id, seFacturaA_id: dest.cliente_id,
      panelEsDe: nombreDe[owner] || owner, panelEsDe_id: owner,
      count: 0, porDivisa: {}, paneles: new Set(), codigos: new Set(),
    };
    c.count++; c.porDivisa[dv] = (c.porDivisa[dv] || 0) + monto;
    c.paneles.add(nom); c.codigos.add(p.codigo);
  }
  return {
    ok: true, mes: m,
    cruces: Object.values(cruces).map((c) => ({ ...c, paneles: [...c.paneles], codigos: [...c.codigos] }))
      .sort((a, b) => b.count - a.count),
    panelesSinReconocer: Object.values(panelesRaros).map((s) => ({ ...s, deCodigo: [...s.deCodigo] }))
      .sort((a, b) => b.count - a.count),
  };
}

/**
 * El DETALLE carga por carga de un cliente en un mes: fecha, panel, moneda y monto.
 *
 * Es lo que hace que la factura se pueda auditar. Sin esto el cliente ve un total y tiene que
 * creernos; con esto puede cruzar cada línea contra lo que él pidió.
 */
async function detalleDelMes(mes, clienteId) {
  const m = String(mes || '').slice(0, 7);
  const r = await _pedidos();
  if (!r.ok) return r;
  const mp = mapa();
  const out = [];
  for (const p of r.pedidos) {
    if (p.estado !== 'cargado' && p.estado !== 'anulando') continue;
    const f = String(p.resueltoAt || p.createdAt || '');
    if (f.slice(0, 7) !== m) continue;
    const dest = mp[String(p.codigo || '').toLowerCase()];
    if (!dest || dest.cliente_id !== clienteId) continue;
    out.push({
      fecha: f.slice(0, 10),
      hora: f.slice(11, 16),
      panel: p.cajaUsuario || p.userId || '—',
      divisa: String(p.divisa || 'ARS').toUpperCase(),
      monto: Number(p.monto) || 0,
      codigo: p.codigo,
      anulando: p.estado === 'anulando',
    });
  }
  out.sort((a, b) => String(a.fecha + a.hora).localeCompare(String(b.fecha + b.hora)));
  return { ok: true, detalle: out };
}

module.exports = { getConfig, setConfig, mapa, setMapeo, listMapeo, ventasDelMes, detalleDelMes, cruceConPaneles, _pedidos };
