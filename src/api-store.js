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
const { db, ensureColumns } = require('./db');

db.exec(`
  /* Un cliente de API = una cuenta del árbol de TBS. El id ES el del nodo, no uno inventado:
     es lo único que no cambia y lo único con lo que se le puede pedir el profit al panel. */
  CREATE TABLE IF NOT EXISTS api_cliente (
    id TEXT PRIMARY KEY,          -- id del nodo en TBS (ej '3204143')
    login TEXT,                   -- como se llama en TBS ('Ars1api')
    alias TEXT,                   -- como lo llama la planilla ('Ars1Api', 'Colombians'), JSON array
    agente TEXT,                  -- de qué cuenta raíz cuelga (Henry999, henry-IG…)
    activo INTEGER DEFAULT 1,
    /* Cajas de ESTE cliente que se facturan por separado (ids de nodo, JSON array).
       TBS devuelve el profit de un nodo con TODO su subárbol adentro, así que si una caja va
       aparte hay que restarla — si no, se le cobra dos veces: una en su propia cuenta y otra
       dentro del total de su padre. */
    excluye TEXT,
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
    corto TEXT,                   -- 'Slot Zona' — el nombre con el que se trabaja
    costo TEXT,                   -- lo que cobra el proveedor por ese sello (del panel)
    tipo TEXT,                    -- 'prepago' | 'postpago' (define en qué cuenta entra)
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
    /* De dónde salió este precio, y por lo tanto cuánto se le puede creer:
         'verificado' → de un mes YA FACTURADO (la planilla de movimientos). Se cobró así.
         'planilla'   → de la tabla de precios, que el dueño avisó que está desactualizada.
       No es un detalle de auditoría: facturar con uno o con el otro es la diferencia entre
       cobrar lo pactado y cobrar lo que alguien anotó alguna vez. La pantalla los separa. */
    origen TEXT DEFAULT 'planilla',
    PRIMARY KEY (cliente_id, sello)
  );
`);

// La tabla puede venir de una versión anterior sin `costo`. La migración vive ACÁ y no en db.js
// porque allá corre antes de que esta tabla exista y, en una base nueva, el ALTER explota.
try { db.exec('ALTER TABLE api_sello ADD COLUMN costo TEXT'); } catch (e) { /* ya la tiene */ }
try { db.exec('ALTER TABLE api_sello ADD COLUMN tipo TEXT'); } catch (e) { /* ya la tiene */ }
try { db.exec('ALTER TABLE api_cliente ADD COLUMN excluye TEXT'); } catch (e) { /* ya la tiene */ }
try { db.exec("ALTER TABLE api_pct ADD COLUMN origen TEXT DEFAULT 'planilla'"); } catch (e) { /* ya la tiene */ }
// Una celda puede estar "mal" a propósito. TBS45Ar23 vende Buffalo Thunder por debajo del costo y
// el dueño decidió apagarle el proveedor al cliente en vez de subirle el precio. Sin un lugar donde
// anotar eso, la revisión lo denuncia todos los meses — y un aviso que grita por algo ya resuelto
// deja de mirarse. Con nota, sigue estando a la vista, pero como decisión y no como alarma.
try { db.exec('ALTER TABLE api_pct ADD COLUMN nota TEXT'); } catch (e) { /* ya la tiene */ }
// Una CAJA no es otro cliente: es el mismo, al que se le entregan cuentas separadas. MULT2-CAL-ARS-PROD
// es de Nacho. Con padre_id la cuenta sale en tres vistas — la caja sola, el resto solo, y el total —
// en vez de aparecer como dos clientes que nadie sabe que son uno. Un solo nivel, no un árbol.
try { db.exec('ALTER TABLE api_cliente ADD COLUMN padre_id TEXT'); } catch (e) { /* ya la tiene */ }
// El grupo de Telegram de esta cuenta, para mandarle su cuenta del mes. Es PROPIO del cliente de
// API y no se hereda de nadie: acá no hay vendedores, y el "agente" (Henry999, henry-IG) es una
// cuenta técnica del árbol de TBS, no el comercial que atiende a ese cliente.
try { db.exec('ALTER TABLE api_cliente ADD COLUMN telegram_chat_id TEXT'); } catch (e) { /* ya la tiene */ }
// QUE ENTRA EN EL RESUMEN DEL MES, y por mes. No es una propiedad del cliente: en junio la caja de
// Nacho quedó afuera por un acuerdo puntual y en julio entra. Guardar la decisión por mes es lo que
// hace que un resumen viejo se pueda volver a sacar igual, en vez de cambiar cuando cambia el trato.
// Sólo se guardan las EXCLUSIONES: lo que no está en la tabla, entra.
db.exec(`CREATE TABLE IF NOT EXISTS api_resumen_fuera (
  mes TEXT NOT NULL, clave TEXT NOT NULL, motivo TEXT, at TEXT, PRIMARY KEY (mes, clave))`);

const nowISO = () => new Date().toISOString();
const J = (v, def) => { try { const x = JSON.parse(v); return x == null ? def : x; } catch (e) { return def; } };
const K = (s) => String(s || '').trim().toLowerCase();

// ── CLIENTES ──────────────────────────────────────────────────────────────────────────────
function listClientes() {
  return db.prepare('SELECT * FROM api_cliente ORDER BY login COLLATE NOCASE').all()
    .map((r) => ({ ...r, alias: J(r.alias, []), excluye: J(r.excluye, []), activo: r.activo !== 0,
      de_quien: r.de_quien || '', padre_id: r.padre_id || null, telegram_chat_id: r.telegram_chat_id || null }));
}
function getCliente(id) {
  const r = db.prepare('SELECT * FROM api_cliente WHERE id=?').get(String(id));
  return r ? { ...r, alias: J(r.alias, []), excluye: J(r.excluye, []), activo: r.activo !== 0,
    de_quien: r.de_quien || '' } : null;
}
/* ── DE QUIÉN ES LA CUENTA ──────────────────────────────────────────────────────────────────────
 * La identidad de una cuenta es su LOGIN en TBS: "Raul-API", "TBSDavidLatam". Eso no cambia y es
 * con lo único con lo que se le puede pedir el profit al panel.
 *
 * Aparte de eso hace falta saber DE QUIÉN es —"Raul-API es de Raul"— y eso no define nada: sirve
 * para que la cuenta que se le manda diga "Cuenta Raul" en vez de "Cuenta Raul-API", y para
 * reconocerla de un vistazo en las pantallas. Es una nota, no una clave.
 *
 * Vivía metido adentro de `alias`, que era otra cosa: la lista de nombres con los que la planilla
 * escribía a esa cuenta mientras se migraba del sistema viejo. Dos ideas distintas en un campo, y
 * la que quedó viva era la que menos se parecía al nombre del campo.
 *
 * Se separa: `de_quien` es la nota, y lo que queda en `alias` son restos que ya no hace nada.
 */
ensureColumns('api_cliente', { de_quien: 'TEXT' });

/* La mudanza corre una sola vez y no cambia lo que se ve: el primer alias ERA el nombre que se
 * mostraba, así que pasa a `de_quien` tal cual y se saca de la lista para que no quede duplicado.
 * Es idempotente —sólo toca las que todavía tienen `de_quien` vacío y algo en `alias`— así que
 * repetirla en cada arranque no hace nada. */
(function mudarNombreDeQuien() {
  const pend = db.prepare(`SELECT id, alias FROM api_cliente
      WHERE (de_quien IS NULL OR de_quien='') AND alias IS NOT NULL AND alias<>'' AND alias<>'[]'`).all();
  if (!pend.length) return;
  const upd = db.prepare('UPDATE api_cliente SET de_quien=?, alias=? WHERE id=?');
  const tx = db.transaction(() => {
    for (const r of pend) {
      let a = []; try { a = JSON.parse(r.alias) || []; } catch (e) { a = []; }
      if (!a.length) continue;
      upd.run(String(a[0]), JSON.stringify(a.slice(1)), r.id);
    }
  });
  tx();
  console.log(`[API] "de quién es" mudado desde el primer alias en ${pend.length} cuenta(s)`);
}());

/* ── LOS "OTROS NOMBRES" SON RESTOS DE LA MIGRACIÓN ─────────────────────────────────────────────
 * `alias` nació para cruzar la planilla: TBS llama a las cuentas "TBSGerson", "API-MOISES2025",
 * "TBS45Ar23" y la planilla escribía "GERSON", "Moises", "Colombians". Había una `buscarCliente`
 * que encontraba una cuenta por su login O por cualquiera de esos nombres.
 *
 * Esa función NO LA LLAMABA NADIE: aparecía dos veces en todo el repo —su propia definición y la
 * línea de exports— y en ningún otro lado. Se sacó. Las cuentas nuevas nacen acá, no vienen de la
 * planilla, así que no hay ningún nombre que cruzar.
 *
 * Lo único que quedó vivo del campo es el PRIMER valor, que es el nombre con el que la cuenta
 * aparece en el cierre del mes (api-resumen.service.js: `comoLoLlama`). Eso no es deuda de la
 * migración: es un nombre para mostrar, y ahora se edita como tal. El resto de los valores son
 * restos que no hacen nada, y se pueden sacar.
 */

/**
 * De quién es la cuenta. Una nota, no una clave: la identidad sigue siendo el login de TBS.
 * Vacío = se la nombra por su login, que es lo que corresponde a una cuenta recién creada.
 */
function setDeQuien(id, texto) {
  const c = getCliente(id);
  if (!c) return { ok: false, error: 'no existe esa cuenta' };
  const n = String(texto == null ? '' : texto).trim();
  // Idéntico al login no se guarda: nombrarla igual que su login es lo mismo que no poner nada.
  db.prepare('UPDATE api_cliente SET de_quien=? WHERE id=?').run(n === c.login ? '' : n, String(id));
  return { ok: true, cliente: getCliente(id) };
}

/** Saca los nombres que quedaron de la planilla. No tocan nada: la búsqueda por ellos ya no existe. */
function limpiarNombresViejos(id) {
  const c = getCliente(id);
  if (!c) return { ok: false, error: 'no existe esa cuenta' };
  const sacados = c.alias || [];
  db.prepare("UPDATE api_cliente SET alias='[]' WHERE id=?").run(String(id));
  return { ok: true, sacados, cliente: getCliente(id) };
}
function saveCliente(d) {
  const id = String(d.id || '').trim();
  if (!id) return { ok: false, error: 'falta el id del nodo de TBS' };
  const alias = Array.isArray(d.alias) ? d.alias : String(d.alias || '').split(/[,\n]+/);
  const exc = Array.isArray(d.excluye) ? d.excluye : String(d.excluye || '').split(/[,\n]+/);
  // padre_id: ausente no toca nada, presente en null/'' desengancha la caja.
  const tienePadre = Object.prototype.hasOwnProperty.call(d, 'padre_id');
  const padre = tienePadre ? (d.padre_id == null || d.padre_id === '' ? null : String(d.padre_id).trim()) : null;
  // Igual que padre_id: la clave ausente no toca nada, presente en null o '' borra el grupo.
  const tieneTg = Object.prototype.hasOwnProperty.call(d, 'telegram_chat_id');
  const tg = tieneTg ? (d.telegram_chat_id == null || d.telegram_chat_id === '' ? null : String(d.telegram_chat_id).trim()) : null;
  db.prepare(`INSERT INTO api_cliente (id,login,alias,agente,activo,excluye,notas,createdAt,padre_id,telegram_chat_id)
    VALUES (?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET login=excluded.login, alias=excluded.alias, agente=excluded.agente,
      activo=excluded.activo, excluye=excluded.excluye, notas=excluded.notas${tienePadre ? ', padre_id=excluded.padre_id' : ''}${tieneTg ? ', telegram_chat_id=excluded.telegram_chat_id' : ''}`)
    .run(id, String(d.login || '').trim(),
      JSON.stringify([...new Set(alias.map((x) => String(x).trim()).filter(Boolean))]),
      String(d.agente || '').trim(), d.activo === false ? 0 : 1,
      JSON.stringify([...new Set(exc.map((x) => String(x).trim()).filter(Boolean))]),
      String(d.notas || ''), nowISO(), padre, tg);
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
  // El COALESCE existe para que un PUT parcial no borre lo que no vino. Pero eso hacía IMPOSIBLE
  // desmapear un sello: mandar grupo_id null lo dejaba igual. Y desmapear hace falta — el grupo 63
  // de "Pragmatic OP" no existía en TBS y facturaba el GGR de todos los proveedores juntos.
  // Ahora se distingue: la clave AUSENTE no toca nada; presente en null o "" borra.
  const borra = Object.prototype.hasOwnProperty.call(d, 'grupo_id') && (d.grupo_id == null || d.grupo_id === '');
  db.prepare(`INSERT INTO api_sello (nombre,grupo_id,corto,costo,tipo,ord) VALUES (?,?,?,?,?,?)
    ON CONFLICT(nombre) DO UPDATE SET grupo_id=${borra ? 'NULL' : 'COALESCE(excluded.grupo_id, api_sello.grupo_id)'},
      corto=COALESCE(excluded.corto, api_sello.corto), costo=COALESCE(excluded.costo, api_sello.costo),
      tipo=COALESCE(excluded.tipo, api_sello.tipo)`)
    .run(n, d.grupo_id == null || d.grupo_id === '' ? null : String(d.grupo_id).trim(),
      String(d.corto || '').trim() || null, d.costo == null || d.costo === '' ? null : String(d.costo).trim(),
      String(d.tipo || '').trim() || null, ord);
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
      pts_ib: r.pts_ib, pts_henry: r.pts_henry, origen: r.origen || 'planilla', nota: r.nota || null,
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
  // La nota se mantiene si no viene en el cuerpo: un cambio de precio no borra la explicación.
  const nota = Object.prototype.hasOwnProperty.call(d, 'nota')
    ? (d.nota == null || d.nota === '' ? null : String(d.nota).trim())
    : ((db.prepare('SELECT nota FROM api_pct WHERE cliente_id=? AND sello=?').get(cid, s) || {}).nota || null);
  db.prepare(`INSERT INTO api_pct (cliente_id,sello,pct_cliente,pct_proveedor,pts_ib,pts_henry,origen,nota)
    VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(cliente_id,sello) DO UPDATE SET pct_cliente=excluded.pct_cliente,
      pct_proveedor=excluded.pct_proveedor, pts_ib=excluded.pts_ib, pts_henry=excluded.pts_henry,
      origen=excluded.origen, nota=excluded.nota`)
    .run(cid, s, pc, pp, ib, hen, d.origen === 'verificado' ? 'verificado' : 'planilla', nota);
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
    const ya = getPct(p.cliente_id, p.sello);
    // Un precio de la planilla NUNCA pisa uno verificado: el verificado ya se cobró así.
    if (ya && (!pisar || (ya.origen === 'verificado' && p.origen !== 'verificado'))) { out.salteados++; return; }
    const r = setPct(p.cliente_id, p.sello, p);
    if (r.ok) out.precios++; else out.errores.push(`${p.cliente_id} · ${p.sello}: ${r.error}`);
  });
  return { ok: true, ...out };
}

/** Las claves que NO entran en el resumen de ese mes. Una clave es un cliente o una caja. */
function fueraDelResumen(mes) {
  return db.prepare('SELECT clave, motivo FROM api_resumen_fuera WHERE mes=?').all(String(mes).slice(0, 7));
}
function setEnResumen(mes, clave, entra, motivo = '') {
  const m = String(mes).slice(0, 7); const k = String(clave);
  if (entra) db.prepare('DELETE FROM api_resumen_fuera WHERE mes=? AND clave=?').run(m, k);
  else {
    db.prepare(`INSERT INTO api_resumen_fuera (mes,clave,motivo,at) VALUES (?,?,?,?)
      ON CONFLICT(mes,clave) DO UPDATE SET motivo=excluded.motivo, at=excluded.at`)
      .run(m, k, String(motivo || ''), nowISO());
  }
  return { ok: true };
}

module.exports = {
  fueraDelResumen, setEnResumen,
  sembrar,
  listClientes, getCliente, saveCliente, removeCliente, setDeQuien, limpiarNombresViejos,
  listSellos, saveSello, removeSello,
  matriz, getPct, setPct, removePct,
};
