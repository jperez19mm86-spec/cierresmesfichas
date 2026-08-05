/**
 * api-store.js — EL NEGOCIO DE API (TBS), que NO es el de fichas.
 *
 * Son dos negocios distintos que comparten muy poco, y mezclarlos sería el error:
 *
 *                    fichas (Casino/Europa)          API (TBS)
 *   cliente          padrón de clientes del OS       padrón APARTE (decisión del dueño)
 *   se cobra por     lo que CARGA                    el GGR que produce
 *   el %             uno solo por cliente            uno por SELLO (grupo de proveedores)
 *   el costo         % del proveedor en la matriz    % del proveedor por sello
 *   el reparto       participantes que suman la base IB + Henry, que suman el % que queda
 *
 * ── LA CUENTA, verificada contra la planilla del dueño (API 2026, 6 meses, al centavo) ─────
 *     GGR × %cliente              = monto en la divisa
 *     monto ÷ TC del mes          = US$
 *     US$ × (%proveedor ÷ %cliente) = lo que se le paga al proveedor
 *     US$ − proveedor             = GGR EMPRESA
 *     %cliente − %proveedor       = % Empresa      ← y IB + Henry suman exactamente esto
 *
 * ⚠️ El nombre NO es la clave. La planilla escribe "Nacho-API", "GERSON", "Moises"; TBS los
 * llama "NachoAPI", "TBSGerson", "API-MOISES2025". La clave es el ID del nodo en el árbol de
 * TBS; el nombre de la planilla queda como alias para poder buscarlos como uno los llama.
 */
const { db } = require('./db');

db.exec(`
  /* Un cliente de API = una cuenta del árbol de TBS. El id ES el del nodo, no uno inventado:
     es lo único que no cambia y lo único con lo que se le puede pedir el profit al panel. */
  CREATE TABLE IF NOT EXISTS api_cliente (
    id TEXT PRIMARY KEY,          -- id del nodo en TBS (ej '3204143')
    login TEXT,                   -- como se llama en TBS ('Ars1api')
    alias TEXT,                   -- como lo llama la planilla ('Ars1Api', 'Colombians'), JSON array
    agente TEXT,                  -- de qué cuenta raíz cuelga (Henry999, henry-IG…)
    activo INTEGER DEFAULT 1,
    notas TEXT,
    createdAt TEXT
  );

  /* Un SELLO es un grupo de proveedores de TBS, con el nombre largo que usa la planilla.
     grupo_id es el id del grupo en el panel: sin él no se puede pedir el GGR.

     Los 52 se identificaron alineando el desplegable del panel con la lista de precios del
     dueño: las dos vienen en el mismo orden. La alineación no se dio por buena porque cuadre
     la cantidad — se contrastó contra los 12 grupos que ya estaban verificados uno por uno
     con los números reales del panel (Slot zona por CRC/BOB/MXN exactos, Sport Betting por
     499.083, SA Gaming por USD 1.678,80...). Los 12 caen donde tienen que caer. */
  CREATE TABLE IF NOT EXISTS api_sello (
    nombre TEXT PRIMARY KEY,      -- 'EGT Digital, Pragmatic Play, NetEnt, ELK Studios (Slot zona)'
    grupo_id TEXT,                -- id del grupo en TBS (78 = goldenneo = Slot zona)
    corto TEXT,                   -- 'Slot zona', para las pantallas
    costo TEXT,                   -- lo que cobra el proveedor por ese sello (del panel)
    ord INTEGER
  );

  /* El precio de cada cliente para cada sello. Los cuatro números que definen la cuenta.
     Se guardan por separado y NO se derivan entre sí: en la planilla del dueño son cuatro
     columnas independientes y hubo meses donde el reparto no era proporcional al %. */
  CREATE TABLE IF NOT EXISTS api_pct (
    cliente_id TEXT,
    sello TEXT,
    pct_cliente TEXT,             -- lo que paga el cliente sobre el GGR
    pct_proveedor TEXT,           -- lo que de eso se lleva el proveedor
    pts_ib TEXT,                  -- puntos de Central/IB (IMPERIUM es el mismo, otro nombre)
    pts_henry TEXT,               -- puntos de Henry
    PRIMARY KEY (cliente_id, sello)
  );
`);

// La tabla puede venir de una versión anterior sin `costo`. La migración vive ACÁ y no en db.js
// porque allá corre antes de que esta tabla exista y, en una base nueva, el ALTER explota.
try { db.exec('ALTER TABLE api_sello ADD COLUMN costo TEXT'); } catch (e) { /* ya la tiene */ }

const nowISO = () => new Date().toISOString();
const J = (v, def) => { try { const x = JSON.parse(v); return x == null ? def : x; } catch (e) { return def; } };
const K = (s) => String(s || '').trim().toLowerCase();

// ── CLIENTES ──────────────────────────────────────────────────────────────────────────────
function listClientes() {
  return db.prepare('SELECT * FROM api_cliente ORDER BY login COLLATE NOCASE').all()
    .map((r) => ({ ...r, alias: J(r.alias, []), activo: r.activo !== 0 }));
}
function getCliente(id) {
  const r = db.prepare('SELECT * FROM api_cliente WHERE id=?').get(String(id));
  return r ? { ...r, alias: J(r.alias, []), activo: r.activo !== 0 } : null;
}
/** Lo busca por id, por login o por cualquiera de sus alias: la planilla lo escribe distinto. */
function buscarCliente(txt) {
  const k = K(txt);
  if (!k) return null;
  return listClientes().find((c) => String(c.id) === String(txt).trim()
    || K(c.login) === k || (c.alias || []).some((a) => K(a) === k)) || null;
}
function saveCliente(d) {
  const id = String(d.id || '').trim();
  if (!id) return { ok: false, error: 'falta el id del nodo de TBS' };
  const alias = Array.isArray(d.alias) ? d.alias : String(d.alias || '').split(/[,\n]+/);
  db.prepare(`INSERT INTO api_cliente (id,login,alias,agente,activo,notas,createdAt)
    VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET login=excluded.login, alias=excluded.alias, agente=excluded.agente,
      activo=excluded.activo, notas=excluded.notas`)
    .run(id, String(d.login || '').trim(),
      JSON.stringify([...new Set(alias.map((x) => String(x).trim()).filter(Boolean))]),
      String(d.agente || '').trim(), d.activo === false ? 0 : 1, String(d.notas || ''), nowISO());
  return { ok: true, cliente: getCliente(id) };
}
function removeCliente(id) {
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM api_pct WHERE cliente_id=?').run(String(id));
    db.prepare('DELETE FROM api_cliente WHERE id=?').run(String(id));
  }); tx();
  return { ok: true };
}

// ── SELLOS ────────────────────────────────────────────────────────────────────────────────
function listSellos() { return db.prepare('SELECT * FROM api_sello ORDER BY ord ASC, nombre ASC').all(); }
function saveSello(d) {
  const n = String(d.nombre || '').trim();
  if (!n) return { ok: false, error: 'falta el nombre del sello' };
  const ord = d.ord != null ? Number(d.ord) : (db.prepare('SELECT COALESCE(MAX(ord),-1)+1 n FROM api_sello').get().n);
  db.prepare(`INSERT INTO api_sello (nombre,grupo_id,corto,costo,ord) VALUES (?,?,?,?,?)
    ON CONFLICT(nombre) DO UPDATE SET grupo_id=COALESCE(excluded.grupo_id, api_sello.grupo_id),
      corto=COALESCE(excluded.corto, api_sello.corto), costo=COALESCE(excluded.costo, api_sello.costo)`)
    .run(n, d.grupo_id == null || d.grupo_id === '' ? null : String(d.grupo_id).trim(),
      String(d.corto || '').trim() || null, d.costo == null || d.costo === '' ? null : String(d.costo).trim(), ord);
  return { ok: true };
}
function removeSello(nombre) {
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM api_pct WHERE sello=?').run(String(nombre));
    db.prepare('DELETE FROM api_sello WHERE nombre=?').run(String(nombre));
  }); tx();
  return { ok: true };
}

// ── LA MATRIZ DE PRECIOS ──────────────────────────────────────────────────────────────────
function matriz() {
  const clientes = listClientes();
  const sellos = listSellos();
  const celdas = {};
  db.prepare('SELECT * FROM api_pct').all().forEach((r) => {
    (celdas[r.cliente_id] = celdas[r.cliente_id] || {})[r.sello] = {
      pct_cliente: r.pct_cliente, pct_proveedor: r.pct_proveedor,
      pts_ib: r.pts_ib, pts_henry: r.pts_henry,
    };
  });
  return { clientes, sellos, celdas };
}
function getPct(cliente_id, sello) {
  return db.prepare('SELECT * FROM api_pct WHERE cliente_id=? AND sello=?').get(String(cliente_id), String(sello)) || null;
}
/**
 * Guarda el precio de un cliente para un sello.
 * Se valida que IB + Henry cierren contra lo que queda: si no cierran, la plata repartida no es
 * la que se ganó — ni de más ni de menos — y eso no se nota mirando el total.
 */
function setPct(cliente_id, sello, d = {}) {
  const cid = String(cliente_id || '').trim(); const s = String(sello || '').trim();
  if (!cid || !s) return { ok: false, error: 'falta el cliente o el sello' };
  const num = (v) => (v == null || v === '' ? null : String(v).trim());
  const pc = num(d.pct_cliente); const pp = num(d.pct_proveedor);
  const ib = num(d.pts_ib); const hen = num(d.pts_henry);
  if (pc != null && !Number.isFinite(Number(pc))) return { ok: false, error: `"${pc}" no es un número` };

  if (pc != null && ib != null && hen != null) {
    const empresa = Number(pc) - Number(pp || 0);
    const suma = Number(ib) + Number(hen);
    if (Math.abs(suma - empresa) > 0.001) {
      return { ok: false, confirmar: true, empresa, suma,
        error: `IB ${ib} + Henry ${hen} = ${suma}, pero al cliente le queda ${empresa} `
          + `(${pc}% menos ${pp || 0}% del proveedor). Tienen que dar lo mismo.` };
    }
  }
  db.prepare(`INSERT INTO api_pct (cliente_id,sello,pct_cliente,pct_proveedor,pts_ib,pts_henry)
    VALUES (?,?,?,?,?,?)
    ON CONFLICT(cliente_id,sello) DO UPDATE SET pct_cliente=excluded.pct_cliente,
      pct_proveedor=excluded.pct_proveedor, pts_ib=excluded.pts_ib, pts_henry=excluded.pts_henry`)
    .run(cid, s, pc, pp, ib, hen);
  return { ok: true };
}
function removePct(cliente_id, sello) {
  db.prepare('DELETE FROM api_pct WHERE cliente_id=? AND sello=?').run(String(cliente_id), String(sello));
  return { ok: true };
}

/**
 * Siembra el padrón y la matriz desde la planilla del dueño.
 *
 * Son 14 clientes y 83 precios cliente×sello que ya existen y no cambiaron en 6 meses: pedirle
 * que los tipee sería regalarle 300 casillas para equivocarse. Es IDEMPOTENTE — no pisa lo que
 * ya esté cargado salvo que se pida `pisar`, así que correrla de nuevo no rompe nada.
 */
function sembrar({ clientes = [], sellos = [], precios = [], pisar = false } = {}) {
  const yaC = new Set(listClientes().map((c) => String(c.id)));
  const yaS = new Set(listSellos().map((x) => x.nombre));
  const out = { clientes: 0, sellos: 0, precios: 0, salteados: 0, errores: [] };
  clientes.forEach((c) => { if (pisar || !yaC.has(String(c.id))) { saveCliente(c); out.clientes++; } });
  sellos.forEach((x, i) => { if (pisar || !yaS.has(x.nombre)) { saveSello({ ...x, ord: i }); out.sellos++; } });
  precios.forEach((p) => {
    if (!pisar && getPct(p.cliente_id, p.sello)) { out.salteados++; return; }
    const r = setPct(p.cliente_id, p.sello, p);
    if (r.ok) out.precios++; else out.errores.push(`${p.cliente_id} · ${p.sello}: ${r.error}`);
  });
  return { ok: true, ...out };
}

module.exports = {
  sembrar,
  listClientes, getCliente, buscarCliente, saveCliente, removeCliente,
  listSellos, saveSello, removeSello,
  matriz, getPct, setPct, removePct,
};
