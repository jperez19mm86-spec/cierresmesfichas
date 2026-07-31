/**
 * import-sheet.service.js — importa la planilla "2026 BASE DE DATOS CLIENTES" (Google Sheets)
 * al OS: la ficha comercial de los clientes (solapa "Clientes") y sus paneles con las divisas
 * habilitadas (solapa "SA Datos").
 *
 * CÓMO SE LEE: la planilla es PÚBLICA, así que se baja como CSV sin credenciales:
 *   https://docs.google.com/spreadsheets/d/<ID>/gviz/tq?tqx=out:csv&sheet=<NOMBRE>
 *
 * REGLAS (acordadas con el dueño):
 *  - El cliente se matchea por NOMBRE (normalizado). El código sólo se usa para los que hay que
 *    CREAR: el código es lo que el cliente tipea para pedir fichas, así que NUNCA se pisa el de
 *    un cliente que ya existe.
 *  - El panel se matchea por ID de usuario del casino (es único, incluso entre Casino y Europa).
 *  - CELDA VACÍA = "sin dato", NO "borrar": ese campo no se escribe y queda lo que haya en el OS.
 *    (23 de 37 clientes tienen el TC vacío, por ejemplo; interpretarlo como borrado destruiría
 *    configuración real.)
 *  - Nada se escribe sin una previsualización previa: el apply exige el hash de lo que se revisó.
 */
const clientes = require('./clientes-store');
const paneles = require('./paneles-store');
const divisasStore = require('./divisas-store');
const casinoConex = require('./casino-conexiones-store');
const { db } = require('./db');
const crypto = require('crypto');

const SHEET_ID_DEFAULT = '1VQDqpACnxPRGFYPrEUsefhCiGspnJRqfEcG_UEyrfXE';
const HOJA_CLIENTES = 'Clientes';
const HOJA_PANELES = 'SA Datos';
const ES_DIVISA = /^[A-Z]{3,4}$/;

// ───────────────────────── correcciones de datos ─────────────────────────
// La planilla tiene errores que el dueño ya nos aclaró. Se corrigen acá, explícitos y auditables,
// en vez de "arreglar" el CSV a mano (que se perdería en la próxima importación).
const FIX_PANEL_POR_ID = {
  // ID duplicado entre dos clientes: es de Raul, no de Henry.
  4172292: { soloCliente: 'Raul' },
  // Las dos filas traen divisas equivocadas (una 21 monedas, la otra sólo CLP).
  2614466: { divisas: ['ARS', 'USD'] },
};
// Panel que en la planilla quedó con el ID de otro: Master-SA es de Europa y tiene ID propio.
const FIX_PANEL_POR_LOGIN = {
  'master-sa': { id_usuario: '3048028', sistema: 'Europa' },
  'rmmaster-sa': { sistema: 'Casino' },
};
// % base de los clientes que en la planilla estaban vacíos. Son vendedores: no pagan fee por
// carga (0), sólo el diferencial de proveedores externos.
const FIX_BASE_PCT = { nurplay: '13', oscar: '8' };
const BASE_PCT_VACIO = '0';
// Paneles sin cliente asignado: por decisión del dueño quedan fuera de esta importación.
const PANELES_EXCLUIDOS = ['GA-MDP', 'RedGanamos1', 'Ga-Na8263'].map((s) => s.toLowerCase());

// ───────────────────────── helpers ─────────────────────────
const norm = (s) => String(s == null ? '' : s).trim();
const key = (s) => norm(s).toLowerCase();
const vacio = (s) => norm(s) === '';

/** Parser CSV (RFC4180: comillas dobles, comas y saltos embebidos). */
function parseCsv(texto) {
  const filas = [];
  let fila = [], celda = '', enComillas = false;
  for (let i = 0; i < texto.length; i++) {
    const ch = texto[i];
    if (enComillas) {
      if (ch === '"') { if (texto[i + 1] === '"') { celda += '"'; i++; } else enComillas = false; }
      else celda += ch;
    } else if (ch === '"') enComillas = true;
    else if (ch === ',') { fila.push(celda); celda = ''; }
    else if (ch === '\n') { fila.push(celda); filas.push(fila); fila = []; celda = ''; }
    else if (ch !== '\r') celda += ch;
  }
  if (celda !== '' || fila.length) { fila.push(celda); filas.push(fila); }
  return filas;
}

async function bajarCsv(sheetId, hoja) {
  const url = `https://docs.google.com/spreadsheets/d/${encodeURIComponent(sheetId)}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(hoja)}`;
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), 20000);
  let resp;
  try { resp = await fetch(url, { signal: ctrl.signal }); } finally { clearTimeout(to); }
  if (!resp.ok) throw new Error(`no se pudo bajar la hoja "${hoja}" (HTTP ${resp.status}) — ¿la planilla es pública?`);
  const texto = await resp.text();
  // FAIL-CLOSED: si Google devuelve una página de error/login, viene HTML en vez de CSV.
  if (/^\s*</.test(texto)) throw new Error(`la hoja "${hoja}" no devolvió CSV (¿la planilla dejó de ser pública?)`);
  const filas = parseCsv(texto);
  if (filas.length < 2) throw new Error(`la hoja "${hoja}" vino vacía`);
  return filas;
}

// ───────────────────────── normalización de valores ─────────────────────────
const MAP_MONEDA = { ars: 'cvu', usdt: 'usdt', variable: 'variable', 'no aplica': 'no_aplica' };
const MAP_MOMENTO = { acumulado: 'acumulado', anticipado: 'anticipado', 'invoice mensual': 'invoice' };
const MAP_DISPARADOR = { 'pago - carga': 'pago_carga', 'carga - deuda': 'carga_deuda', variable: 'variable' };
const MAP_TC = { trader: 'trader', 'tiempo real': 'tiempo_real', 'promedio mensual': 'promedio' };
const mapear = (tabla, v) => (vacio(v) ? undefined : (tabla[key(v)] || undefined));
const siNo = (v) => (vacio(v) ? undefined : /^s[ií]$/i.test(norm(v)));

/**
 * Divisas de un panel. La celda se corrige ANTES de partirla: hay dos errores de tipeo conocidos
 * ("AR,S BRL" es un ARS + BRL con la S corrida, y "PEN. PYG" son dos separadas por punto).
 * VEF y VES se dejan como divisas distintas (son dos billeteras reales del panel).
 * Si la celda viene vacía se asume ARS (decisión del dueño): un panel sin divisas no se puede operar.
 */
function parseDivisas(celda) {
  const limpio = norm(celda).replace(/AR,\s*S\s+BRL/gi, 'ARS, BRL').replace(/PEN\.\s*PYG/gi, 'PEN, PYG');
  const vistas = new Set();
  const out = [];
  for (const tok of limpio.split(/[,;]+/)) {
    const d = norm(tok).toUpperCase();
    if (!ES_DIVISA.test(d) || vistas.has(d)) continue;
    vistas.add(d); out.push(d);
  }
  return out.length ? out : ['ARS'];
}

// ───────────────────────── lectura de las dos hojas ─────────────────────────
/**
 * Se indexa por POSICIÓN y no por nombre de encabezado a propósito: la hoja "Clientes" tiene DOS
 * columnas llamadas "Cliente" (y en una fila la segunda está vacía), así que armar un objeto por
 * nombre se queda con la columna equivocada.
 */
function leerClientes(filas) {
  const out = [];
  for (const f of filas.slice(1)) {
    const nombre = norm(f[0]);
    if (!nombre) continue;
    out.push({
      nombre,
      telegram: norm(f[2]),
      base_pct: norm(f[3]),
      moneda_cobro: mapear(MAP_MONEDA, f[4]),
      momento_pago: mapear(MAP_MOMENTO, f[5]),
      disparador: mapear(MAP_DISPARADOR, f[6]),
      tc_aplicar: mapear(MAP_TC, f[7]),
      ajuste_usdt_pct: vacio(f[8]) ? undefined : norm(f[8]),
      paga_proveedores: siNo(f[9]),
      mover_balance: siNo(f[11]),
    });
  }
  return out;
}

function leerPaneles(filas) {
  const out = [];
  for (const f of filas.slice(1)) {
    const login = norm(f[2]);
    const idUsuario = norm(f[4]);
    if (!login || !idUsuario) continue;
    let p = {
      cliente: norm(f[0]),
      codigo: norm(f[1]),
      nombre: login,
      sistema: norm(f[3]),
      id_usuario: idUsuario,
      nivel_usuario: norm(f[5]),
      divisas: parseDivisas(f[6]),
      divisasAsumidas: vacio(f[6]), // la planilla no traía ninguna → se asumió ARS
    };
    // correcciones puntuales que nos pasó el dueño
    const porLogin = FIX_PANEL_POR_LOGIN[key(login)];
    if (porLogin) p = { ...p, ...porLogin };
    const porId = FIX_PANEL_POR_ID[p.id_usuario];
    if (porId) {
      if (porId.divisas) p.divisas = porId.divisas.slice();
      // el ID pertenece a un cliente puntual: la fila del otro cliente se descarta
      if (porId.soloCliente && key(p.cliente) !== key(porId.soloCliente)) continue;
    }
    if (PANELES_EXCLUIDOS.includes(key(p.nombre)) || !p.cliente) continue; // sin dueño → fuera
    out.push(p);
  }
  return out;
}

// 'Distribuidor-Ganamos' no es un nivel del sistema; sin esto caería a 'Agente'.
function nivelValido(n) {
  const k = key(n);
  if (k.startsWith('superagente')) return 'SuperAgente';
  if (k.startsWith('distribuidor')) return 'Distribuidor';
  return 'Agente';
}

// ───────────────────────── armado del plan ─────────────────────────
/**
 * Compara la planilla con lo que hay en el OS y devuelve TODO lo que cambiaría, sin escribir nada.
 * El `hash` identifica esta previsualización: el apply lo exige para no aplicar sobre una planilla
 * que cambió mientras se revisaba.
 */
async function planificar({ sheetId = SHEET_ID_DEFAULT, incluirBasePct = false, incluirTelegram = false } = {}) {
  const [filasCli, filasPan] = await Promise.all([bajarCsv(sheetId, HOJA_CLIENTES), bajarCsv(sheetId, HOJA_PANELES)]);
  const hash = crypto.createHash('sha256').update(JSON.stringify([filasCli, filasPan])).digest('hex').slice(0, 16);

  const sheetClientes = leerClientes(filasCli);
  const sheetPaneles = leerPaneles(filasPan);
  if (sheetClientes.length < 30) throw new Error(`la hoja "${HOJA_CLIENTES}" trajo sólo ${sheetClientes.length} filas — parece incompleta, no se importa`);

  const actuales = clientes.list().clientes;
  const porNombre = new Map();
  const ambiguos = new Set();
  for (const c of actuales) {
    const k = key(c.nombre || c.nombreVisible || c.codigo);
    if (porNombre.has(k)) ambiguos.add(k); else porNombre.set(k, c);
  }

  const avisos = [];
  const cambiosCliente = [];
  const crearClientes = [];
  for (const s of sheetClientes) {
    if (ambiguos.has(key(s.nombre))) { avisos.push(`"${s.nombre}": hay 2 clientes con ese nombre en el OS — se saltea`); continue; }
    const actual = porNombre.get(key(s.nombre));
    const campos = {};
    const set = (k, v) => { if (v !== undefined && (!actual || actual[k] !== v)) campos[k] = v; };
    set('moneda_cobro', s.moneda_cobro);
    set('momento_pago', s.momento_pago);
    set('disparador', s.disparador);
    set('tc_aplicar', s.tc_aplicar);
    set('ajuste_usdt_pct', s.ajuste_usdt_pct);
    set('paga_proveedores', s.paga_proveedores);
    set('mover_balance', s.mover_balance);
    if (incluirTelegram && s.telegram) set('telegram_chat_id', s.telegram);
    // % base: vacío = 0 (vendedores), salvo los dos que el dueño corrigió a mano
    const base = vacio(s.base_pct) ? (FIX_BASE_PCT[key(s.nombre)] || BASE_PCT_VACIO) : s.base_pct;
    if (incluirBasePct) campos.precio_base_pct = base;
    if (!actual) crearClientes.push({ nombre: s.nombre, campos, base_pct: base });
    else if (Object.keys(campos).length) cambiosCliente.push({ id: actual.id, nombre: actual.nombre || actual.codigo, campos });
  }

  // ── paneles ──
  const actualesPan = paneles.list();
  const porIdUsuario = new Map();
  for (const p of actualesPan) if (p.id_usuario) porIdUsuario.set(String(p.id_usuario), p);

  // Auto-link a la conexión del casino: la planilla dice de qué sistema es cada panel
  // ("Casino"/"Europa") y las conexiones registradas se llaman igual. Sin esto los paneles
  // entran sueltos y quedan fuera de la facturación y del acumulado.
  const conexPorNombre = new Map();
  for (const cx of casinoConex.list()) conexPorNombre.set(key(cx.nombre), cx);
  const sinConexion = new Set();

  const crearPaneles = [];
  const actualizarPaneles = [];
  const sinCambio = [];
  const vistos = new Set();
  const divisasNuevas = new Set();
  const sinDivisas = [];
  for (const s of sheetPaneles) {
    if (vistos.has(s.id_usuario)) continue; // la planilla repite filas idénticas
    vistos.add(s.id_usuario);
    // El cliente puede existir ya, o estar en la lista de los que este mismo import va a crear
    // (en ese caso el id todavía no existe y se resuelve al aplicar, por nombre).
    const cli = porNombre.get(key(s.cliente));
    const seVaACrear = !cli && crearClientes.some((n) => key(n.nombre) === key(s.cliente));
    if (!cli && !seVaACrear) { avisos.push(`panel "${s.nombre}" (${s.id_usuario}): el cliente "${s.cliente}" no está en el OS ni en la planilla de clientes`); continue; }
    s.divisas.forEach((d) => divisasNuevas.add(d));
    if (s.divisasAsumidas) sinDivisas.push(s.nombre); // la planilla no las traía: quedan en ARS
    const nivel = nivelValido(s.nivel_usuario);
    const existente = porIdUsuario.get(s.id_usuario);
    const cx = conexPorNombre.get(key(s.sistema));
    if (!cx) sinConexion.add(s.sistema || '(sin sistema)');
    const datos = {
      cliente_id: cli ? cli.id : null, clienteNombre: s.cliente, nombre: s.nombre, sistema: s.sistema,
      nivel_usuario: nivel, id_usuario: s.id_usuario, divisas: s.divisas, usuario: s.nombre,
      conexion_id: cx ? cx.id : (existente ? existente.conexion_id : null),
    };
    if (!existente) { crearPaneles.push(datos); continue; }
    const dif = [];
    if (existente.nombre !== datos.nombre) dif.push('nombre');
    if ((existente.divisas || []).join(',') !== s.divisas.join(',')) dif.push('divisas');
    if (cli && existente.cliente_id !== cli.id) dif.push('cliente');
    if (existente.nivel_usuario !== nivel) dif.push('nivel');
    if (datos.conexion_id && existente.conexion_id !== datos.conexion_id) dif.push('conexión');
    if (dif.length) actualizarPaneles.push({ id: existente.id, datos, dif });
    else sinCambio.push(s.nombre);
  }

  const catalogo = new Set(divisasStore.list().map((d) => d.codigo));
  const altaDivisas = [...divisasNuevas].filter((d) => !catalogo.has(d)).sort();
  for (const s of sinConexion) avisos.push(`no hay una conexión de casino llamada "${s}" — esos paneles entran sin linkear`);
  const linkeados = [...crearPaneles, ...actualizarPaneles.map((u) => u.datos)].filter((d) => d.conexion_id).length;

  return {
    hash,
    sheetId,
    clientes: { enPlanilla: sheetClientes.length, crear: crearClientes, actualizar: cambiosCliente },
    paneles: { enPlanilla: sheetPaneles.length, crear: crearPaneles, actualizar: actualizarPaneles, sinCambio: sinCambio.length, sinDivisas, linkeados },
    altaDivisas,
    avisos,
    opciones: { incluirBasePct, incluirTelegram },
  };
}

/** Foto de las 3 tablas que toca el import. Es el respaldo para deshacer. */
function snapshot() {
  return {
    tomadoEl: new Date().toISOString(),
    clientes: db.prepare('SELECT * FROM clientes').all(),
    paneles: db.prepare('SELECT * FROM paneles').all(),
    divisas: db.prepare('SELECT * FROM divisas').all(),
  };
}

/** Restaura exactamente esas 3 tablas. NO toca movimientos ni el historial de precios. */
function restaurar(snap) {
  if (!snap || !Array.isArray(snap.clientes) || !Array.isArray(snap.paneles)) throw new Error('snapshot inválido');
  const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
  const reponer = (tabla, filas) => {
    const c = cols(tabla);
    db.prepare(`DELETE FROM ${tabla}`).run();
    if (!filas.length) return;
    const ins = db.prepare(`INSERT INTO ${tabla} (${c.join(',')}) VALUES (${c.map((x) => '@' + x).join(',')})`);
    for (const f of filas) { const row = {}; c.forEach((k) => { row[k] = f[k] !== undefined ? f[k] : null; }); ins.run(row); }
  };
  db.transaction(() => {
    reponer('clientes', snap.clientes);
    reponer('paneles', snap.paneles);
    if (Array.isArray(snap.divisas)) reponer('divisas', snap.divisas);
  })();
  return { clientes: snap.clientes.length, paneles: snap.paneles.length, divisas: (snap.divisas || []).length };
}

/** Código para un cliente nuevo, a partir de su nombre. Único dentro de los ya usados. */
function codigoDesdeNombre(nombre, usados) {
  const raiz = norm(nombre).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8) || 'CLI';
  let cod = raiz, n = 1;
  while (usados.has(cod.toLowerCase())) cod = raiz + (++n);
  usados.add(cod.toLowerCase());
  return cod;
}

/**
 * Aplica el plan. Todo dentro de UNA transacción: o entra completo o no entra nada.
 * Los clientes se persisten con UN solo save (cada createCliente/updateComercial reescribe la
 * tabla entera, así que 37 llamadas serían 37 reescrituras).
 */
async function aplicar({ sheetId = SHEET_ID_DEFAULT, confirmHash, incluirBasePct = false, incluirTelegram = false, historial } = {}) {
  const plan = await planificar({ sheetId, incluirBasePct, incluirTelegram });
  if (!confirmHash) throw new Error('falta confirmHash: primero hay que previsualizar');
  if (confirmHash !== plan.hash) throw new Error('la planilla cambió desde la previsualización — volvé a previsualizar antes de importar');

  const snap = snapshot();
  const basePctPendientes = []; // el precio base va por historial (versionado), fuera de la tabla

  const tx = db.transaction(() => {
    // 1) catálogo de divisas
    for (const d of plan.altaDivisas) divisasStore.upsert({ codigo: d, nombre: d, activa: 1 });

    // 2) clientes: se arma todo en memoria y se guarda de una sola vez
    const data = clientes.list();
    const usados = new Set(data.clientes.map((c) => key(c.codigo)));
    const porNombre = new Map(data.clientes.map((c) => [key(c.nombre || c.nombreVisible || c.codigo), c]));

    for (const nuevo of plan.clientes.crear) {
      const cod = codigoDesdeNombre(nuevo.nombre, usados);
      const c = {
        id: 'c_' + crypto.randomBytes(5).toString('hex'), codigo: cod, nombreVisible: nuevo.nombre,
        createdAt: new Date().toISOString(), telegram: { chatId: '', enabled: false }, cajas: [],
        nombre: nuevo.nombre, estado: 'activo', paga_proveedores: false, permite_deuda: false,
        mezcla_pago_usdt: null, ajuste_usdt_pct: null, fecha_alta: new Date().toISOString().slice(0, 10),
        mover_balance: false, saldo_inicial: null, saldo_inicial_divisa: null, saldo_inicial_mov_id: null,
      };
      aplicarCampos(c, nuevo.campos, basePctPendientes);
      data.clientes.push(c);
      porNombre.set(key(nuevo.nombre), c);
    }
    for (const cambio of plan.clientes.actualizar) {
      const c = data.clientes.find((x) => x.id === cambio.id);
      if (c) aplicarCampos(c, cambio.campos, basePctPendientes);
    }
    clientes.seed(data);

    // 3) paneles (el cliente_id de los recién creados se resuelve acá)
    for (const p of plan.paneles.crear) {
      const cli = data.clientes.find((x) => x.id === p.cliente_id) || porNombre.get(key(p.clienteNombre || ''));
      paneles.create({ ...p, cliente_id: (cli && cli.id) || p.cliente_id });
    }
    // Igual que arriba: si el panel pasa a un cliente que se crea en ESTA misma corrida, su id
    // recién existe ahora. Sin esto el update mandaba cliente_id null y DESVINCULABA el panel.
    for (const u of plan.paneles.actualizar) {
      const d = { ...u.datos };
      if (!d.cliente_id) {
        const cli = porNombre.get(key(d.clienteNombre || ''));
        if (cli) d.cliente_id = cli.id;
        else delete d.cliente_id; // sin cliente resuelto: NO tocar el que ya tenía
      }
      paneles.update(u.id, d);
    }
  });
  tx();

  // 4) precio base: fuera de la transacción porque va por el historial versionado
  if (incluirBasePct && historial) {
    const hoy = new Date().toISOString().slice(0, 10);
    for (const b of basePctPendientes) {
      try { historial.setValor('cliente', b.cliente_id, 'precio_base_pct', b.valor, { tipo: 'vigencia', vigente_desde: hoy }); }
      catch (e) { plan.avisos.push(`precio base de ${b.cliente_id}: ${e.message}`); }
    }
  }

  return {
    hash: plan.hash,
    creados: plan.clientes.crear.length,
    actualizados: plan.clientes.actualizar.length,
    panelesCreados: plan.paneles.crear.length,
    panelesActualizados: plan.paneles.actualizar.length,
    divisasAlta: plan.altaDivisas.length,
    basePctAplicados: incluirBasePct ? basePctPendientes.length : 0,
    avisos: plan.avisos,
    snapshot: snap,
  };
}

/** Vuelca los campos del plan sobre el objeto cliente (y separa el precio base, que va aparte). */
function aplicarCampos(c, campos, basePctPendientes) {
  for (const [k, v] of Object.entries(campos || {})) {
    if (k === 'precio_base_pct') { basePctPendientes.push({ cliente_id: c.id, valor: v }); continue; }
    if (k === 'telegram_chat_id') { c.telegram = { ...(c.telegram || {}), chatId: String(v) }; continue; }
    if (k === 'paga_proveedores' || k === 'mover_balance') { c[k] = !!v; continue; }
    c[k] = v === '' ? null : v;
  }
}

module.exports = { planificar, aplicar, snapshot, restaurar, SHEET_ID_DEFAULT, parseCsv, parseDivisas, leerClientes, leerPaneles, nivelValido, bajarCsv };
