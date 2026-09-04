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
 * ⭐ EL DETALLE CARGA POR CARGA de un mes — lo que hace que la factura se pueda auditar.
 *
 * Es el mismo universo que `ventasDelMes` (cargados + anulando del mes, la fecha sale de
 * `resueltoAt` y si falta de `createdAt`), pero fila por fila en vez de sumado. Tiene que ser la
 * MISMA función la que decide qué entra: si el detalle mostrara un pedido que el total no cuenta,
 * el cliente sumaría las líneas y le daría otra cosa.
 *
 * Cada fila lleva el NODO del casino (`userId`), que es lo que después permite cruzar la carga
 * contra el movimiento real del panel.
 */
function detalleDelMes(mes) {
  // El nombre del panel se resuelve por el NODO del casino, no por el texto que quedó guardado en
  // el pedido. Dos motivos:
  //   · el mismo panel viene escrito distinto según cuándo se cargó (`cash365.vip` / `Cash365.vip`,
  //     `Celuapuestas-SA` / `CeluApuestas-SA`), y así "Por panel" lo partía en dos filas;
  //   · si un panel se renombró, las cargas viejas seguían mostrando el nombre anterior y el
  //     cliente no las reconocía como suyas.
  // El nodo no cambia nunca, así que es la única llave estable. Si ese nodo no está registrado
  // como panel se deja el texto del pedido, que es lo único que hay.
  const porNodo = {};
  try {
    require('./paneles-store').list().forEach((p) => { if (p.id_usuario) porNodo[String(p.id_usuario)] = p.nombre; });
  } catch (e) { /* sin padrón de paneles el detalle sale igual, con el nombre del pedido */ }
  const out = [];
  for (const p of load().pedidos) {
    if (p.estado !== 'cargado' && p.estado !== 'anulando') continue;
    const f = String(p.resueltoAt || p.createdAt || '');
    if (mes && f.slice(0, 7) !== mes) continue;
    out.push({
      id: p.id,
      codigo: String(p.codigo || '—'),
      fecha: f.slice(0, 10),
      hora: f.slice(11, 16),
      iso: f,
      panel: porNodo[String(p.userId || '')] || p.cajaUsuario || p.userId || '—',
      panelPedido: p.cajaUsuario || null,   // cómo estaba escrito cuando se cargó
      userId: String(p.userId || ''),
      sistema: p.sistema || '',
      divisa: String(p.divisa || 'ARS').toUpperCase(),
      monto: Number(p.monto) || 0,
      anulando: p.estado === 'anulando',
    });
  }
  out.sort((a, b) => String(a.iso).localeCompare(String(b.iso)));
  return out;
}

/**
 * ⭐ LO VENDIDO DEL MES, YA RUTEADO AL CLIENTE QUE LO PAGA.
 *
 * `ventasDelMes` agrupa por CÓDIGO, y el código no siempre dice quién paga. Cada panel puede
 * decidirlo con `consumo_a`:
 *
 *   'codigo'  (default) → al cliente del código. Correcto cuando el panel es de la misma persona
 *                         con otra cuenta: Marcelo carga en los de JJ y JJ *es* Marcelo; Fran en
 *                         los de Ariel, igual. 213 cargas dependen de esto.
 *   'dueno'             → al dueño del panel. `Rafael-SA` recibió una carga con el código de Alexa
 *                         y se le cobra a Rafael.
 *   'ninguno'           → panel de TRÁNSITO de un vendedor, por donde bajan las fichas hacia sus
 *                         clientes. Pero no se descarta a ciegas: 🔴 SE VERIFICA que esa misma
 *                         entrega esté cobrada abajo. Regla de la dueña (3-sep-2026): «hay que
 *                         verificar si se cobran a un cliente. Si cobran a un cliente, no generan
 *                         deuda; si no, hay que revisarlo».
 *                         Una marca ciega se tragaría justo las que NO se cobraron a nadie, que son
 *                         las únicas que importan. Verificado: de las 5 cargas en los paneles de
 *                         tránsito de Alexa, 3 bajaron a clientes y 2 no — esas dos hay que verlas.
 *
 * Devuelve además QUÉ se ruteó distinto, qué no se cobró y qué quedó PARA REVISAR, porque una carga
 * que cambia de dueño o que deja de cobrarse no puede pasar en silencio.
 */
function ventasDelMesPorCliente(mes) {
  let paneles = []; let clientes = [];
  try { paneles = require('./paneles-store').list(); } catch (e) { /* sin padrón se rutea por código */ }
  try { clientes = require('./clientes-store').list().clientes; } catch (e) { /* idem */ }
  const porNodo = {}; paneles.forEach((p) => { if (p.id_usuario) porNodo[String(p.id_usuario)] = p; });
  const porCodigo = {}; clientes.forEach((c) => { porCodigo[String(c.codigo).toLowerCase()] = c; });

  const porCliente = {}; const sinCliente = {}; const ruteadas = []; const sinCobrar = []; const paraRevisar = [];
  const todas = detalleDelMes(mes);
  /** ¿Esta misma entrega aparece cobrada más abajo, con el código de otro cliente? */
  const bajoAUnCliente = (d) => todas.find((x) => x.id !== d.id
    && x.divisa === d.divisa && Math.abs(x.monto - d.monto) < 0.01
    && String(x.codigo).toLowerCase() !== String(d.codigo).toLowerCase()
    && Math.abs(Date.parse(x.iso) - Date.parse(d.iso)) <= 5 * 60 * 1000);
  const bolsa = (dest) => (porCliente[dest] = porCliente[dest] || {
    count: 0, porDivisa: {}, porUserId: {}, anulando: { count: 0, porDivisa: {} }, codigos: new Set(),
  });

  for (const d of todas) {
    const pan = porNodo[d.userId];
    const delCodigo = porCodigo[String(d.codigo).toLowerCase()];
    const modo = (pan && pan.consumo_a) || 'codigo';

    if (modo === 'ninguno') {
      const abajo = bajoAUnCliente(d);
      if (abajo) {
        sinCobrar.push({ ...d, panel: pan ? pan.nombre : d.panel, cobradaEn: abajo.panel, conCodigo: abajo.codigo,
          motivo: `bajó a ${abajo.panel} y ahí se cobra con el código ${abajo.codigo}: cobrarla acá sería cobrarla dos veces` });
        continue;
      }
      // 🔴 No bajó a ningún cliente: NO se la traga la marca. Queda para revisar y el mes no se
      // puede emitir sin haberla visto.
      paraRevisar.push({ ...d, panel: pan ? pan.nombre : d.panel,
        motivo: 'ese panel es de tránsito, pero esta carga no aparece cobrada a ningún cliente más abajo' });
      continue;
    }
    let destino = modo === 'dueno' && pan && pan.cliente_id ? pan.cliente_id : (delCodigo ? delCodigo.id : null);
    /* ── EL CLIENTE QUE CUELGA DE OTRO ────────────────────────────────────────────────────────
       Ariel trabaja al 14 pero su consumo lo paga Fran, a quien se le cobra el 12; los 2 puntos
       de diferencia son la ganancia de Fran. Hasta acá eso funcionaba SOLO porque los pedidos de
       los paneles de Ariel se cargaban tipeando FRAN74 — una costumbre. El día que alguien
       tipeara ARIEL65 la deuda se le iba a Ariel, al 14, y no saltaba nada.
       `factura_a` lo vuelve una regla: la deuda va a quien de verdad paga, se tipee lo que se
       tipee. El cliente conserva su % para su propia cuenta, que es otra pregunta.
       Se sigue UNA sola vez a propósito: un cliente que cuelga de otro que a su vez cuelga de un
       tercero no existe hoy, y una cadena sin tope se cuelga sola con un ciclo mal cargado. */
    const puente = destino ? (clientes.find((c) => c.id === destino) || {}).factura_a : null;
    if (puente && puente !== destino && clientes.some((c) => c.id === puente)) {
      const de = clientes.find((c) => c.id === destino) || {};
      ruteadas.push({ ...d, deCodigo: de.nombre, aCliente: (clientes.find((c) => c.id === puente) || {}).nombre,
        porFacturaA: true });
      destino = puente;
    }
    if (!destino) {
      const s = sinCliente[d.codigo] = sinCliente[d.codigo] || { codigo: d.codigo, count: 0, porDivisa: {} };
      s.count += 1; s.porDivisa[d.divisa] = (s.porDivisa[d.divisa] || 0) + d.monto;
      continue;
    }
    if (modo === 'dueno' && delCodigo && delCodigo.id !== destino && !puente) {
      ruteadas.push({ ...d, deCodigo: delCodigo.nombre, aCliente: (clientes.find((c) => c.id === destino) || {}).nombre });
    }
    const o = bolsa(destino);
    o.codigos.add(d.codigo);
    if (d.anulando) {
      o.anulando.count += 1;
      o.anulando.porDivisa[d.divisa] = (o.anulando.porDivisa[d.divisa] || 0) + d.monto;
      continue;
    }
    o.count += 1;
    o.porDivisa[d.divisa] = (o.porDivisa[d.divisa] || 0) + d.monto;
    if (d.userId) o.porUserId[d.userId] = (o.porUserId[d.userId] || 0) + d.monto;
  }
  Object.values(porCliente).forEach((o) => { o.codigos = [...o.codigos]; });
  return { porCliente, sinCliente: Object.values(sinCliente), ruteadas, sinCobrar, paraRevisar };
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
  destrabarAlArrancar, destrabarCarga, marcarEnCurso, quitarEnCurso, estaEnCurso, tomarParaAnular, revertirAnulando, list, counts, ventasCargadasMes, ventasDelMes, ventasDelMesPorCliente, detalleDelMes, remove, seed: save, FILE };
