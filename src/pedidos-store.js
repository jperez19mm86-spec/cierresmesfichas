/**
 * pedidos-store.js — almacenamiento local (JSON) de los PEDIDOS de carga.
 *
 * Flujo: el cliente arma un pedido (vista cliente) → queda 'pendiente' → el admin lo Carga o Rechaza.
 *   - Cargar  → se ejecuta la carga real en el casino (area=balance) → estado 'cargado'.
 *   - Rechazar → estado 'rechazado'.
 * Los resueltos quedan en el "historial" (filtrable por cliente / estado).
 *
 * Pedido = {
 *   id, codigo, clienteNombre, cajaId, cajaUsuario, sistema, userId, divisa, monto,
 *   estado: 'pendiente'|'cargado'|'rechazado'|'anulado', createdAt, resueltoAt, newBalance, error
 *   ('anulado' = una carga que se revirtió: se retiró el monto del casino, ej. carga a usuario equivocado)
 * }
 * Se guarda en data/pedidos.json (gitignored).
 */
const crypto = require('crypto');
const { db } = require('./db');

const FILE = 'sqlite:pedidos'; // compat (ya no es un archivo)

function load() {
  const pedidos = db.prepare('SELECT data FROM pedidos ORDER BY ord ASC').all().map((r) => {
    try { return JSON.parse(r.data); } catch (e) { return null; }
  }).filter(Boolean);
  return { pedidos };
}

const _saveTx = db.transaction((data) => {
  db.prepare('DELETE FROM pedidos').run();
  const ins = db.prepare('INSERT INTO pedidos (id,data,ord) VALUES (@id,@data,@ord)');
  (data.pedidos || []).forEach((p, i) => ins.run({ id: p.id, data: JSON.stringify(p), ord: i }));
});
function save(data) { _saveTx(data); }

/**
 * Mete un pedido que viene de OTRO sistema conservando su id, su estado y sus fechas.
 *
 * No usa create(): ése pone id nuevo, estado 'pendiente' y la fecha de hoy. Con eso, un pedido ya
 * cargado hace tres meses volvería a aparecer como pendiente y alguien lo cargaría de nuevo —
 * fichas entregadas dos veces. Acá se copia tal cual y se respeta lo que ya pasó.
 */
function importar(p) {
  const data = load();
  if (data.pedidos.some((x) => x.id === p.id)) return null;
  const pedido = {
    id: String(p.id || ('p_' + crypto.randomBytes(5).toString('hex'))),
    codigo: String(p.codigo || '').trim(),
    clienteNombre: String(p.clienteNombre || '').trim(),
    cajaId: String(p.cajaId || '').trim(),
    cajaUsuario: String(p.cajaUsuario || '').trim(),
    sistema: String(p.sistema || '').trim(),
    userId: String(p.userId || '').trim(),
    divisa: String(p.divisa || 'ARS').trim(),
    monto: Number(p.monto) || 0,
    estado: String(p.estado || 'pendiente'),
    createdAt: p.createdAt || new Date().toISOString(),
    resueltoAt: p.resueltoAt || null,
    newBalance: p.newBalance == null ? null : p.newBalance,
    error: p.error || null,
    importado_de: 'app.latamgames.online',
  };
  data.pedidos.unshift(pedido);
  save(data);
  return pedido;
}

function create(p) {
  const data = load();
  const pedido = {
    id: 'p_' + crypto.randomBytes(5).toString('hex'),
    codigo: String(p.codigo || '').trim(),
    clienteNombre: String(p.clienteNombre || '').trim(),
    cajaId: String(p.cajaId || '').trim(),
    cajaUsuario: String(p.cajaUsuario || '').trim(),
    sistema: String(p.sistema || '').trim(),
    userId: String(p.userId || '').trim(),
    divisa: String(p.divisa || 'ARS').trim(),
    monto: Number(p.monto) || 0,
    estado: 'pendiente',
    createdAt: new Date().toISOString(),
    resueltoAt: null,
    newBalance: null,
    error: null,
  };
  data.pedidos.unshift(pedido);
  save(data);
  return pedido;
}

function get(id) { return load().pedidos.find((p) => p.id === id) || null; }

/** Cambia estado de un pedido (cargado/rechazado) + extra (newBalance/error). */
function setEstado(id, estado, extra = {}) {
  const data = load();
  const p = data.pedidos.find((x) => x.id === id);
  if (!p) return null;
  p.estado = estado;
  p.resueltoAt = new Date().toISOString();
  if (extra.newBalance !== undefined) p.newBalance = extra.newBalance;
  if (extra.error !== undefined) p.error = extra.error;
  if (extra.cascada !== undefined) p.cascada = extra.cascada;
  if (extra.trabadoEn !== undefined) p.trabadoEn = extra.trabadoEn;
  save(data);
  return p;
}

/**
 * Guarda el avance de la cascada SIN tocar el estado: el pedido sigue 'pendiente' para poder
 * RETOMARLO. Es lo que permite que volver a apretar "Cargar" no repita los pasos ya hechos.
 */
function setCascada(id, cascada, trabadoEn) {
  const data = load();
  const p = data.pedidos.find((x) => x.id === id);
  if (!p) return null;
  p.cascada = cascada;
  p.trabadoEn = trabadoEn || null;
  save(data);
  return p;
}

/** LOCK atómico para anular: si el pedido está 'cargado' lo pasa a 'anulando' y lo devuelve; si no, null.
 *  Es SINCRÓNICO (better-sqlite3) → corre entero sin interleave → previene doble-retiro concurrente.
 *  NO toca resueltoAt/newBalance (así el rollback preserva los datos de la carga original). */
function tomarParaAnular(id) {
  const data = load();
  const p = data.pedidos.find((x) => x.id === id);
  if (!p || p.estado !== 'cargado') return null;
  p.estado = 'anulando';
  save(data);
  return { ...p };
}
/**
 * 🔒 LOCK DE CARGA: 'pendiente' → 'cargando', de una sola vez.
 *
 * Sin esto, apretar "Cargar" dos veces cargaba las fichas DOS VECES y se facturaba una sola: la
 * ruta chequeaba `estado !== 'pendiente'` pero recién lo marcaba 'cargado' AL FINAL, y el camino
 * completo tarda decenas de segundos (login al casino + un loadChips por eslabón de la cascada).
 * En todo ese rato el pedido seguía en 'pendiente' y una segunda request pasaba el mismo chequeo.
 * Con los pedidos como base de cobro la fuga es muda: hay UN pedido, se cobra UNA vez, y el casino
 * recibió el monto dos veces.
 *
 * Devuelve null si ya lo tomó otro. Es sincrónico (load/save de un JSON, sin await en el medio),
 * así que entre el chequeo y el guardado no se puede colar nadie.
 */
function tomarParaCargar(id) {
  const data = load();
  const p = data.pedidos.find((x) => x.id === id);
  if (!p || p.estado !== 'pendiente') return null;
  p.estado = 'cargando';
  p.tomadoAt = new Date().toISOString();
  save(data);
  return { ...p };
}

/* ── QUÉ CARGAS ESTÁN CORRIENDO AHORA MISMO ──────────────────────────────────────────────────
   En memoria y a propósito: si el proceso se muere, este conjunto se va con él — y eso es
   exactamente lo que hace falta. Un pedido que figura 'cargando' después de un reinicio NO está
   corriendo; lo estaba en el proceso anterior, que ya no existe.
   Sirve para lo otro: que nadie destrabe a mano una carga que sí se está ejecutando en este
   momento, porque destrabarla la haría cargar dos veces. Es el mismo mecanismo que ya usa
   movimientos-panel.js. */
const _enCurso = new Set();
const marcarEnCurso = (id) => _enCurso.add(String(id));
const quitarEnCurso = (id) => _enCurso.delete(String(id));
const estaEnCurso = (id) => _enCurso.has(String(id));

/**
 * ── LA BARRIDA AL ARRANCAR ─────────────────────────────────────────────────────────────────────
 * Antes de tocar el casino el pedido pasa a 'cargando' y eso queda escrito. La cascada tarda
 * decenas de segundos. Si el proceso se cae o Railway redespliega en ese rato, nadie lo devolvía a
 * 'pendiente': no había ninguna barrida al arrancar y el pedido quedaba en 'cargando' PARA SIEMPRE.
 *
 * Y ese estado no estaba contemplado en ningún lado: no aparecía en la cola de pendientes, no se
 * contaba, en el historial se dibujaba como "✗ rechazado" —una mentira sobre un pedido cuyas
 * fichas pueden estar cargadas— y el servidor rechazaba cualquier intento de retomarlo.
 *
 * Acá es seguro y no hace falta mirar el reloj: si este proceso recién arranca, ninguna carga suya
 * puede estar corriendo. Vuelve a 'pendiente', que es lo correcto porque la cascada RETOMA desde el
 * paso que falló en vez de repetir los que salieron (ver el `onPaso` de la ruta de carga: los pasos
 * se guardan a medida que salen, justamente para esto).
 *
 * @returns los pedidos que se destrabaron, para poder decirlo en el log de arranque
 */
function destrabarAlArrancar() {
  const data = load();
  const trabados = data.pedidos.filter((p) => p.estado === 'cargando');
  if (!trabados.length) return [];
  for (const p of trabados) {
    p.estado = 'pendiente';
    p.tomadoAt = null;
    p.error = 'el servidor se reinició mientras se cargaba: volvé a apretar Cargar '
      + '(retoma desde donde quedó, no repite lo que ya salió)';
  }
  save(data);
  return trabados.map((p) => ({ id: p.id, codigo: p.codigo, caja: p.cajaUsuario,
    divisa: p.divisa, monto: p.monto,
    // Cuántos eslabones ya habían salido: es lo que dice si quedaron fichas trabadas en un padre.
    pasosHechos: (p.cascada || []).filter((x) => x.estado === 'ok').length }));
}

/**
 * Destrabar A MANO uno que quedó en 'cargando' con el servidor andando (la petición se murió pero
 * el proceso no). Acá el reloj y el conjunto en curso SÍ importan: la carga puede estar corriendo.
 */
function destrabarCarga(id, minimoMinutos = 5) {
  const data = load();
  const p = data.pedidos.find((x) => x.id === id);
  if (!p) return { ok: false, error: 'no existe ese pedido' };
  if (p.estado !== 'cargando') return { ok: false, error: `ese pedido está "${p.estado}", no trabado` };
  // 🔒 Lo primero, y no el reloj: si hay una carga viva, destrabar la haría cargar dos veces.
  if (estaEnCurso(id)) {
    return { ok: false, error: 'ese pedido se está cargando AHORA (puede estar esperando turno '
      + 'detrás de otra carga del mismo superagente). Esperá a que termine.' };
  }
  const desde = p.tomadoAt ? Date.parse(p.tomadoAt) : NaN;
  if (Number.isFinite(desde) && Date.now() - desde < minimoMinutos * 60000) {
    return { ok: false, error: `se tomó hace menos de ${minimoMinutos} minutos: puede estar cargándose ahora mismo` };
  }
  p.estado = 'pendiente';
  p.tomadoAt = null;
  p.error = 'se destrabó a mano: la carga se cortó en el medio';
  save(data);
  return { ok: true, pedido: { ...p }, pasosHechos: (p.cascada || []).filter((x) => x.estado === 'ok').length };
}

/** Rollback del lock de carga: 'cargando' → 'pendiente'. Preserva lo ya movido en la cascada. */
function soltarCarga(id) {
  const data = load();
  const p = data.pedidos.find((x) => x.id === id);
  if (!p || p.estado !== 'cargando') return null;
  p.estado = 'pendiente';
  p.tomadoAt = null;
  save(data);
  return { ...p };
}

/** Rollback del lock: 'anulando' → 'cargado' (si el retiro en el casino no se hizo). Preserva los datos. */
function revertirAnulando(id) {
  const data = load();
  const p = data.pedidos.find((x) => x.id === id);
  if (!p || p.estado !== 'anulando') return null;
  p.estado = 'cargado';
  save(data);
  return p;
}

/** Lista con filtros opcionales: { estado, codigo }. */
function list(filters = {}) {
  let arr = load().pedidos;
  if (filters.estado) arr = arr.filter((p) => p.estado === filters.estado);
  if (filters.codigo) arr = arr.filter((p) => String(p.codigo).toLowerCase() === String(filters.codigo).toLowerCase());
  // ── EL ORDEN SALE DE LA FECHA, NO DE CÓMO ENTRARON ──────────────────────────────────────────
  // Antes alcanzaba con el orden del array: create() mete cada pedido nuevo adelante, así que
  // quedaba del más nuevo al más viejo solo. Pero al importar los 875 del sistema en línea, que ya
  // venían del más nuevo al más viejo, cada unshift los fue dando vuelta: el historial mostraba
  // 31/7 y después 1/8, avanzando hacia adelante en vez de hacia atrás.
  // Ordenar por fecha lo arregla venga de donde venga el pedido. Empate → el id, para que dos
  // pedidos del mismo segundo no se intercambien entre una consulta y la siguiente.
  return [...arr].sort((a, b) => {
    const fa = String(a.createdAt || ''); const fb = String(b.createdAt || '');
    if (fa !== fb) return fa < fb ? 1 : -1;
    return String(b.id).localeCompare(String(a.id));
  });
}

function counts() {
  const arr = load().pedidos;
  return {
    pendientes: arr.filter((p) => p.estado === 'pendiente').length,
    // 'cargando' no se contaba en ningún lado: un pedido trabado no aparecía en ningún número de
    // ninguna pantalla, así que quedar trabado era quedar invisible.
    cargando: arr.filter((p) => p.estado === 'cargando').length,
    cargados: arr.filter((p) => p.estado === 'cargado').length,
    rechazados: arr.filter((p) => p.estado === 'rechazado').length,
    anulados: arr.filter((p) => p.estado === 'anulado').length,
    anulando: arr.filter((p) => p.estado === 'anulando').length,
    total: arr.length,
  };
}

/** VENTAS DE FICHAS de un mes = pedidos CARGADOS (compra prepaga) agrupados por código de cliente.
 *  Esta es la BASE real de facturación (el % se cobra sobre lo vendido, no sobre el `in` de jugadores).
 *  Devuelve { [codigo]: { monto, count, porUserId:{userId:monto}, porDivisa:{divisa:monto} } }.
 *  La fecha del mes se toma de resueltoAt (cuándo se cargó) y si falta, createdAt. */
function ventasCargadasMes(mes) {
  const arr = load().pedidos.filter((p) => p.estado === 'cargado');
  const out = {};
  for (const p of arr) {
    const f = String(p.resueltoAt || p.createdAt || '').slice(0, 7);
    if (mes && f !== mes) continue;
    const cod = String(p.codigo || '—');
    const o = out[cod] = out[cod] || { monto: 0, count: 0, porUserId: {}, porDivisa: {} };
    const m = Number(p.monto) || 0;
    o.monto += m; o.count += 1;
    const uid = String(p.userId || '');
    o.porUserId[uid] = (o.porUserId[uid] || 0) + m;
    const dv = p.divisa || 'ARS';
    o.porDivisa[dv] = (o.porDivisa[dv] || 0) + m;
  }
  return out;
}

/**
 * ⭐ LO QUE SE LE COBRA A CADA CLIENTE EN UN MES.
 *
 * Decisión del dueño: manda lo VENDIDO por el sistema de pedidos, no el `in` que reporta el casino.
 * Son dos números distintos por diseño (hay cargas hechas por fuera, bonos, movimientos internos),
 * y el que factura es este.
 *
 * Diferencias con `ventasCargadasMes`, que se queda solo para el reparto viejo:
 *   · `monto` NO se usa para facturar: mezcla pesos con guaraníes y no significa nada. Lo que sirve
 *     es `porDivisa`, y cada moneda se pasa a USDT con SU tipo de cambio.
 *   · Los pedidos en 'anulando' se informan APARTE: las fichas ya están en el casino pero todavía no
 *     se confirmó que volvieran. Ni contarlos en silencio ni descartarlos en silencio.
 *
 * El mes sale de `resueltoAt` (cuándo se cargó de verdad) y si falta, de `createdAt`.
 */
function ventasDelMes(mes) {
  const out = {};
  const suma = (cod) => (out[cod] = out[cod] || {
    count: 0, porDivisa: {}, porUserId: {},
    anulando: { count: 0, porDivisa: {} },
  });
  for (const p of load().pedidos) {
    if (p.estado !== 'cargado' && p.estado !== 'anulando') continue;
    const f = String(p.resueltoAt || p.createdAt || '').slice(0, 7);
    if (mes && f !== mes) continue;
    const o = suma(String(p.codigo || '—'));
    const m = Number(p.monto) || 0;
    const dv = String(p.divisa || 'ARS').toUpperCase();
    if (p.estado === 'anulando') {
      o.anulando.count += 1;
      o.anulando.porDivisa[dv] = (o.anulando.porDivisa[dv] || 0) + m;
      continue;
    }
    o.count += 1;
    o.porDivisa[dv] = (o.porDivisa[dv] || 0) + m;
    const uid = String(p.userId || '');
    if (uid) o.porUserId[uid] = (o.porUserId[uid] || 0) + m;
  }
  return out;
}

/**
 * Borra un pedido. Para sacar los que se sembraron de prueba o los que se crearon por error.
 *
 * Es acotado a propósito: los pedidos son la base de lo que se le cobra a cada cliente, así que
 * borrar uno CAMBIA la facturación del mes. Devuelve el pedido borrado para poder dejar rastro.
 */
function remove(id) {
  const data = load();
  const i = data.pedidos.findIndex((p) => p.id === String(id));
  if (i < 0) return { ok: false, error: 'no existe ese pedido' };
  const [p] = data.pedidos.splice(i, 1);
  save(data);
  return { ok: true, pedido: p };
}

/**
 * Deja anotado si el aviso al grupo salió. Los pedidos se guardan como JSON en una sola columna,
 * así que esto va adentro del objeto y no en una columna nueva.
 *
 * Se guarda salga o no: un aviso que no salió es una cosa que hay que hacer, y si no queda escrita
 * la descubre el cliente por un reclamo. Es la misma lección que dejó el comprobante que no llegó.
 */
function marcarAviso(id, { ok, error }) {
  const data = load();
  const p = data.pedidos.find((x) => x.id === id);
  if (!p) return null;
  p.aviso = { ok: !!ok, error: ok ? null : String(error || 'no se pudo avisar').slice(0, 300),
    at: new Date().toISOString() };
  save(data);
  return { ...p };
}

module.exports = { marcarAviso, create, importar, get, setEstado, setCascada, tomarParaCargar, soltarCarga,
  destrabarAlArrancar, destrabarCarga, marcarEnCurso, quitarEnCurso, estaEnCurso, tomarParaAnular, revertirAnulando, list, counts, ventasCargadasMes, ventasDelMes, remove, seed: save, FILE };
