/**
 * estadisticas-mes.service.js — LA FOTO DEL MES: se le pregunta al casino UNA VEZ y queda guardada.
 *
 * EL PROBLEMA: cada reporte de proveedores externos le preguntaba al casino en vivo, panel por panel
 * y divisa por divisa. Para toda la flota son 525 consultas, y el casino tarda entre 2 y 16 segundos
 * en cada una. Sacar el reporte de un cliente con 9 paneles multidivisa no llegaba a terminar nunca.
 *
 * LA IDEA (del dueño): un mes cerrado YA NO CAMBIA. Entonces se le pregunta una sola vez, a principio
 * del mes siguiente, y se guarda. Después armar el reporte de Titán, de Juan, de Alexa o de quien sea
 * es leer la base — instantáneo, y sin depender de que el casino esté arriba.
 *
 * LO QUE LO HACE POSIBLE: el reporte agrupado por superagente devuelve TODOS los nodos en UNA sola
 * consulta. Verificado contra producción: una consulta de 2,9 s trajo 951 filas cubriendo 39 nodos, y
 * comparado nodo por nodo con la consulta individual dio EXACTAMENTE lo mismo — 11 proveedores,
 * 11 coincidencias, total 480.187,11 contra 480.187,11, diferencia 0,00.
 *
 *   antes:  525 consultas, EN CADA REPORTE
 *   ahora:  ~130 consultas, UNA VEZ POR MES
 *
 * DOS TIPOS DE CONSULTA:
 *   · MASIVA (una por conexión × divisa): trae de golpe todos los nodos del nivel que el casino
 *     tenga elegido en ESE momento.
 *   · SUELTA (una por panel): para los Distribuidores y Agentes, pidiendo su nodo puntual.
 *
 * ⚠️ EL NIVEL DE LA MASIVA NO SE ELIGE DESDE ACÁ. Es un ajuste guardado en el servidor del casino
 * por cuenta, y solo se cambia a mano en su pantalla (Estadísticas → Agrupar por). Mandar el mismo
 * formulario por HTTP NO lo guarda: probado desde la propia página del casino, el submit nativo sí
 * y un fetch con idéntico cuerpo no.
 *
 * Y los dos niveles son EXCLUYENTES. Verificado sobre junio en Europa:
 *     superagent → 951 filas, 39 nodos: 31 superagentes nuestros, 0 distribuidores
 *     diller     → 2076 filas, 128 nodos: 0 superagentes, 23 distribuidores nuestros
 * Por eso, antes de guardar, se mira en qué modo está y se frena si no coincide: si no, quedarían
 * archivados los números de unos nodos bajo el nombre de otros, sin que nada avise.
 */
const { db } = require('./db');
const nowISO = () => new Date().toISOString();
const paneles = require('./paneles-store');
const casinoConex = require('./casino-conexiones-store');

const K = (s) => String(s || '').trim();

/** Primer y último día del mes, con hora: el motor del casino descarta la fecha pelada. */
function rango(mes) {
  const [y, m] = String(mes).split('-').map(Number);
  const ult = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${mes}-01 00:00:00`, to: `${mes}-${String(ult).padStart(2, '0')} 23:59:59` };
}

/**
 * Las divisas que hay que sacar de una conexión: las de sus paneles.
 * No se piden las 36 del catálogo porque la mayoría no tiene un peso de movimiento y cada una es
 * una consulta más.
 */
function divisasDe(conexionId) {
  const s = new Set(['ARS']);
  paneles.list().filter((p) => p.conexion_id === conexionId)
    .forEach((p) => (p.divisas || []).forEach((d) => { if (d) s.add(String(d).toUpperCase()); }));
  return [...s].sort();
}

/**
 * ⚠️ EL NIVEL DE AGRUPACIÓN CAMBIA LA PLATA, y no es un detalle de presentación.
 *
 * El reporte se pide con el filtro `profit > 0`. Agrupado por SUPERAGENTE, los distribuidores que
 * perdieron se restan ANTES del filtro. Abierto por DISTRIBUIDOR, esos negativos quedan afuera del
 * filtro y el total sale más alto. Verificado: Titán junio da 7.150 por superagente y 7.162,50 por
 * distribuidor; Oscar-SA da 480.187,11 contra 480.378,36.
 *
 * Ninguno de los dos está "mal": hay que usar el que corresponde al panel.
 *   · panel que es SuperAgente  → la captura por superagente
 *   · panel que es Distribuidor → la captura por distribuidor
 * (Regla del dueño: "si para sacar la cuenta de Titán necesitás 5 superagentes, tomás los datos de
 *  ahí; si necesitás los de Gabriel@, revisás un superagente y un distribuidor".)
 *
 * ⚠️ El nivel del reporte NO se elige desde acá: es un ajuste guardado en el servidor del casino
 * por cuenta (Estadísticas → Agrupar por), y mandar el mismo formulario por HTTP no lo cambia —
 * probado. Así que la foto se saca en DOS pasadas: una con la cuenta en Superagente y otra en
 * Dealer. `capturar()` lee en qué modo está y guarda las filas con ESE nivel; nunca las etiqueta
 * como el otro.
 */
const NIVELES = ['superagente', 'distribuidor'];

/** El nivel de captura que le corresponde a un panel. */
function nivelDe(panel) {
  return (panel && panel.nivel_usuario === 'SuperAgente') ? 'superagente' : 'distribuidor';
}

/** El modo del casino ('superagent' | 'diller') traducido al nivel que produce. */
function nivelDeModo(valor) {
  if (valor === 'superagent') return 'superagente';
  if (valor === 'diller') return 'distribuidor';
  return null;                                  // cualquier otro modo no sirve para la foto
}

/**
 * Qué hay que sacar para un mes: DOS pasadas por panel × divisa, una por nivel.
 *
 * Se sacan las dos aunque cada cliente use una sola, por dos razones: el nivel del casino se cambia
 * a mano y conviene aprovechar cada pasada para todos los paneles, y tener las dos permite VER la
 * diferencia — que es exactamente la plata que el filtro profit>0 esconde en los negativos.
 */
/**
 * ── QUÉ DIVISAS SE LE PREGUNTAN A UN PANEL ────────────────────────────────────────────────────
 *
 * `divisas` es lo que el nodo tiene HABILITADO en el casino: es la lista correcta para facturar,
 * pero preguntarlas todas cuesta caro. NewSkin-SA tiene 27 habilitadas y mueve dos; Henry777, 26
 * y mueve tres. Sobre 201 paneles son 1248 consultas, y ~550 son de monedas que nadie tocó nunca.
 *
 * Con alcance 'movidas' se preguntan las que el panel movió de verdad en los últimos meses. Si un
 * panel no movió NADA, no hay con qué estrechar y se le preguntan todas: "no tengo datos" no es
 * "no usa ninguna" — 114 paneles están en ese caso y dejarlos en cero los volvería invisibles.
 *
 * ⚠️ LO QUE ESTO NO VE. Una moneda que el panel empieza a mover POR PRIMERA VEZ no está en el
 * acumulado, así que con 'movidas' no se pregunta y no se descubre sola. Es exactamente cómo se
 * pasó UYU en 463.live. Por eso: el alcance 'todas' sigue existiendo y el plan devuelve `fuera`,
 * la lista de lo que se está dejando afuera, para que la pantalla lo diga en vez de callarlo.
 * Conviene correr una 'todas' cada tanto, y siempre que un cliente avise que arranca en otra moneda.
 */
function divisasDePanel(p, alcance, usadasPorPanel) {
  const habilitadas = (p.divisas || []).length ? p.divisas.map((d) => String(d).toUpperCase()) : ['ARS'];
  if (alcance !== 'movidas') return { pedir: habilitadas, fuera: [] };
  const movidas = (usadasPorPanel[p.id] || []).map((d) => String(d).toUpperCase());
  if (!movidas.length) return { pedir: habilitadas, fuera: [] };
  // sólo las que además siguen habilitadas: si el casino le sacó una, no tiene sentido pedirla
  const pedir = habilitadas.filter((d) => movidas.includes(d));
  if (!pedir.length) return { pedir: habilitadas, fuera: [] };
  return { pedir, fuera: habilitadas.filter((d) => !movidas.includes(d)) };
}

/**
 * ── QUÉ ENTRA EN LA FOTO ──────────────────────────────────────────────────────────────────────
 *
 * Dos recortes, y los dos importan más que el de las divisas:
 *
 * 1. SÓLO EL NIVEL PROPIO DE CADA PANEL. El nivel no viaja en la consulta: es el ajuste global
 *    "Agrupar por" del casino, y el plan listaba cada panel DOS veces, una por nivel. La segunda
 *    era una pasada de control para poder ver cuánto esconde el filtro profit>0 — pero nadie la
 *    lee: externos.service pide `filasDe(..., nivelDe(panel))`, o sea el propio y nada más. Eran
 *    347 consultas de 694 que se guardaban y no las miraba ningún reporte. Con `control:true`
 *    vuelven, para cuando se quiera medir esa diferencia a propósito.
 *
 * 2. SÓLO LOS PANELES MARCADOS. `en_foto` en false saca al panel del plan. No rompe nada: su
 *    reporte de externos sigue saliendo, preguntándole al casino en vivo — más lento y puede
 *    fallar, que es lo que ya avisa el cartel de la pantalla para los meses sin foto. Sirve para
 *    lo que pidió el dueño: de los distribuidores sólo necesita unos contados.
 *
 * Las dos pasadas por el casino se siguen necesitando igual: con el ajuste en superagentes salen
 * los paneles superagentes, y con el ajuste en distribuidores, los distribuidores.
 */
function plan(mes, { conexionId = null, nivel = null, divisa = null, alcance = 'movidas',
  control = false } = {}) {
  // list463: la Foto del mes pide nodos/reportes, que solo entiende el engine 463. Una conexión
  // TBS acá reventaría con "cli.nodos is not a function".
  const cxs = casinoConex.list463().filter((c) => !conexionId || c.id === conexionId);
  const out = [];
  const dejadasAfuera = [];
  const usadasPorPanel = {};
  if (alcance === 'movidas') {
    paneles.divisasUsadas(6).forEach((x) => { usadasPorPanel[x.panel_id] = x.usadas || []; });
  }
  for (const cx of cxs) {
    for (const p of paneles.list().filter((x) => x.conexion_id === cx.id && x.id_usuario && x.en_foto !== false)) {
      const { pedir, fuera } = divisasDePanel(p, alcance, usadasPorPanel);
      if (fuera.length) dejadasAfuera.push({ panel: p.nombre, divisas: fuera });
      for (const d of pedir) {
        if (divisa && String(d).toUpperCase() !== String(divisa).toUpperCase()) continue;
        for (const niv of NIVELES) {
          if (nivel && niv !== nivel) continue;
          // sin `control`, a cada panel se le pide sólo el nivel en el que factura
          if (!control && niv !== nivelDe(p)) continue;
          out.push({
            conexion_id: cx.id, conexion: cx.nombre, mes,
            divisa: String(d).toUpperCase(), nivel: niv,
            nodo: String(p.id_usuario), panel: p.nombre,
            // el nivel que ESTE panel usa para facturar; el otro queda como control
            propio: niv === nivelDe(p),
          });
        }
      }
    }
  }
  // El plan viaja como array desde siempre; lo que quedó afuera se cuelga como propiedad para no
  // romper a quien lo recorra con un for. `plan.fuera` existe sólo cuando hay algo que avisar.
  if (dejadasAfuera.length) {
    Object.defineProperty(out, 'fuera', { value: dejadasAfuera, enumerable: false });
    Object.defineProperty(out, 'fueraTotal', { value: dejadasAfuera.reduce((a, x) => a + x.divisas.length, 0), enumerable: false });
  }
  return out;
}

/**
 * ── LA EXTRACCIÓN NUEVA: UNA LLAMADA POR DIVISA, NO UNA POR PANEL ─────────────────────────────
 *
 * La pantalla de reportes del casino manda `reports_user_group_by` y devuelve TODOS los nodos de
 * ese nivel en una respuesta. Eso es lo que hace reporteProveedores. La Foto venía pidiendo una
 * consulta por panel Y divisa (reporteProveedoresNodo): 347 contra 32.
 *
 * Y no era sólo lento. reporteProveedoresNodo manda `reports_base_group_by=users` y
 * `reports_group_by=terminal`, dos valores que YA NO EXISTEN en esa pantalla —hoy las opciones son
 * ''/'bets' y provider/label/category/vendor/provider_label/game_name—. De ahí los "49 con error"
 * de Europa: 8 de 8 y 6 de 6 fallaron en la prueba mientras la global respondía en 2,9s.
 *
 * ⚠️ EL NÚMERO NO ES EL MISMO, Y ESO ES A PROPÓSITO. El filtro se aplica a las FILAS del reporte:
 * agrupando por terminal se tiran las terminales negativas y se suman sólo las positivas;
 * agrupando por nodo×proveedor los negativos se netean adentro del proveedor antes de filtrar. Por
 * eso la global da siempre igual o menos (Europa/julio/ARS: 20 de 31 paneles idénticos, 11 con
 * -0,13%). La regla del dueño es "un proveedor en negativo va en cero, nunca se resta" — a nivel
 * PROVEEDOR, que es lo que hace la global. El método viejo la aplicaba una vuelta más abajo, a la
 * terminal, y por eso venía cobrando de más.
 *
 * @param divisas  las monedas a pedir; una llamada por cada una
 * @param guardar  false = probar sin escribir nada
 */
async function capturarGlobal({ mes, conexionId, nivel = 'superagente', divisas = [], plantilla = '',
  guardar = false, onPaso = null } = {}) {
  const m = String(mes || '').slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(m)) return { ok: false, error: 'mes inválido (se espera YYYY-MM)' };
  const cli = casinoConex.client(conexionId);
  if (!cli) return { ok: false, error: 'la conexión no responde' };
  const { from, to } = rango(m);
  const grupo = nivel === 'superagente' ? 'superagent' : 'diller';
  // Ganancia mayor a cero, explícito. Antes iba `profit > ''` (valor vacío), que deja al casino
  // decidir qué significa. El dueño lo pidió así: profit > 0.
  const filtros = [{ column_name: 'profit', condition: '>', value: '0' }];

  const salida = [];
  for (const divisa of divisas.map((d) => String(d).toUpperCase())) {
    const t0 = Date.now();
    let r;
    try { r = await cli.reporteProveedores({ from, to, currency: divisa, userGroupBy: grupo, activeTemplate: plantilla, filtros }); }
    catch (e) { r = { ok: false, error: String((e && e.message) || e) }; }
    const seg = Number(((Date.now() - t0) / 1000).toFixed(1));
    if (!r.ok) { salida.push({ divisa, ok: false, error: r.error, segundos: seg }); if (onPaso) onPaso(salida[salida.length - 1]); continue; }

    // partir por nodo: la respuesta trae todos juntos
    const porNodo = new Map();
    (r.filas || []).forEach((f) => {
      if (!f.saId) return;
      if (!porNodo.has(f.saId)) porNodo.set(f.saId, []);
      porNodo.get(f.saId).push(f);
    });
    // sólo se guardan los nodos que son paneles NUESTROS en esa conexión: la global trae también
    // los de otros, y guardarlos llenaría la base de filas que ningún reporte va a leer.
    const mios = new Map();
    paneles.list().filter((p) => p.conexion_id === conexionId && p.id_usuario)
      .forEach((p) => mios.set(String(p.id_usuario), p));
    let guardados = 0, filas = 0;
    const sinPanel = [];
    porNodo.forEach((fs, nodoId) => {
      if (!mios.has(nodoId)) { sinPanel.push(nodoId); return; }
      if (guardar) {
        const t = { conexion_id: conexionId, mes: m, divisa, nivel, nodo: nodoId };
        filas += _guardar(t, fs);
        _marcar(t, { estado: 'ok', filas: fs.length, nodos: 1, segundos: seg, modo: grupo });
      } else filas += fs.length;
      guardados++;
    });
    salida.push({ divisa, ok: true, segundos: seg, filasQueTrajo: (r.filas || []).length,
      nodosQueTrajo: porNodo.size, panelesNuestros: guardados, filasGuardadas: filas,
      nodosAjenos: sinPanel.length });
    if (onPaso) onPaso(salida[salida.length - 1]);
  }
  return { ok: true, mes: m, nivel, plantilla, guardado: !!guardar, divisas: salida,
    total: { llamadas: salida.length, ok: salida.filter((x) => x.ok).length,
      filas: salida.reduce((a, x) => a + (x.filasGuardadas || 0), 0),
      paneles: salida.reduce((a, x) => a + (x.panelesNuestros || 0), 0) } };
}

// ── guardado ────────────────────────────────────────────────────────────────

function _guardar(t, filasIn) {
  // Siempre se guarda a nombre del PANEL que se consultó, con el NIVEL en el que se pidió.
  // El subárbol devuelve una fila por terminal/distribuidor: se suman por proveedor antes de
  // guardar; si no, entrarían con la misma clave y se perdería todo menos una.
  const acc = {};
  for (const f of filasIn || []) {
    const k = `${f.provider}|${f.label}|${f.vendor}`;
    const a = acc[k] || (acc[k] = { saLogin: f.saLogin || '', provider: f.provider, label: f.label, vendor: f.vendor, bet: 0, win: 0, profit: 0 });
    a.bet += Number(f.bet) || 0; a.win += Number(f.win) || 0; a.profit += Number(f.profit) || 0;
  }
  const filas = Object.values(acc);
  const del = db.prepare('DELETE FROM estad_mes WHERE conexion_id=? AND mes=? AND divisa=? AND grupo=? AND nodo_id=?');
  const ins = db.prepare(`INSERT INTO estad_mes
    (id, conexion_id, mes, divisa, grupo, nodo_id, nodo_login, provider, label, vendor, bet, win, profit, capturado_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const at = nowISO();
  // Una transacción: o queda la foto entera de esa combinación, o no queda nada. Una foto a medias
  // es peor que ninguna, porque parece completa.
  const tx = db.transaction(() => {
    del.run(t.conexion_id, t.mes, t.divisa, t.nivel, String(t.nodo));
    let n = 0;
    for (const f of filas) {
      const id = [t.conexion_id, t.mes, t.divisa, t.nivel, t.nodo, f.provider, f.label, f.vendor].join('|');
      ins.run(id, t.conexion_id, t.mes, t.divisa, t.nivel, String(t.nodo), K(f.saLogin),
        K(f.provider), K(f.label), K(f.vendor),
        String(f.bet), String(f.win), String(f.profit), at);
      n++;
    }
    return n;
  });
  return tx();
}

function _marcar(t, { estado, filas = 0, nodos = 0, error = null, segundos = 0, modo = null }) {
  db.prepare(`INSERT INTO estad_captura (id, conexion_id, mes, divisa, grupo, estado, filas, nodos, error, segundos, capturado_at, modo)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
              ON CONFLICT(id) DO UPDATE SET estado=excluded.estado, filas=excluded.filas, nodos=excluded.nodos,
                error=excluded.error, segundos=excluded.segundos, capturado_at=excluded.capturado_at, modo=excluded.modo`)
    .run(claveDe(t), t.conexion_id, t.mes, t.divisa, t.nivel,
      estado, filas, nodos, error, segundos, nowISO(), modo);
}

/** La clave de una consulta. Las sueltas llevan el nodo: son una foto por panel, no por conexión. */
function claveDe(t) {
  return [t.conexion_id, t.mes, t.divisa, t.nivel, t.nodo].join('|');
}
function captura(conexionId, mes, divisa, nivel, nodo) {
  return db.prepare('SELECT * FROM estad_captura WHERE id=?')
    .get([conexionId, mes, divisa, nivel, String(nodo)].join('|')) || null;
}

// ── sacar la foto ───────────────────────────────────────────────────────────

/**
 * Le pregunta al casino y guarda. Serializado POR CONEXIÓN (el motor de reportes tiene estado por
 * sesión y el casino tira abajo la sesión anterior al volver a entrar) y en paralelo entre conexiones.
 * @param onPaso  se llama con cada paso terminado, para poder mostrar el avance
 */
/**
 * ⚠️ EN QUÉ MODO ESTÁ LA CUENTA DEL CASINO AHORA MISMO.
 *
 * El casino agrupa el reporte según un ajuste GUARDADO EN SU SERVIDOR por cuenta, y no se puede
 * cambiar desde acá: solo cambiándolo a mano en su pantalla (el <select> hace un submit nativo del
 * formulario, y mandar el mismo cuerpo por HTTP no lo guarda — probado).
 *
 * Y los dos modos son EXCLUYENTES. Verificado sobre junio en Europa:
 *   · superagent → 951 filas, 39 nodos: 31 superagentes nuestros,  0 distribuidores
 *   · diller     → 2076 filas, 128 nodos: 0 superagentes,          23 distribuidores nuestros
 *
 * Por eso hay que mirarlo ANTES de guardar. Si no, se sacaría la foto en modo dealer y quedaría
 * archivada como si fuera de superagentes: números de otra gente bajo el nombre equivocado, sin que
 * nada avise.
 */
/**
 * EN QUÉ NIVEL ESTÁ AGRUPANDO EL CASINO.
 *
 * Se leía del <select name="reports_user_group_by"> de la pantalla de reportes. El casino DEJÓ DE
 * marcar con `selected` la opción elegida de ese campo — los otros selects de la misma pantalla
 * (statistic_type, currency, active_template) la siguen marcando, así que no es la sesión ni el
 * idioma: es ese campo. El valor lo aplica JavaScript y no está en el HTML, ni en los inputs
 * ocultos, ni en la plantilla activa. Comprobado en las dos conexiones.
 *
 * Cuando no se puede leer, el candado automático deja de existir. La alternativa NO es adivinar:
 * es que lo diga quien lo cambió. El dueño elige el nivel a mano en el casino, así que sabe cuál
 * está puesto; el OS le pregunta y anota que ese dato fue DECLARADO y no verificado.
 */
async function modoActual(cliCx) {
  try {
    const r = await cliCx.camposDeReportes();
    if (!r.ok) return { ok: false, error: r.error };
    const s = (r.selects || []).find((x) => x.name === 'reports_user_group_by');
    const sel = s && (s.opciones || []).find((o) => o.seleccionada);
    if (!sel) return { ok: false, error: 'no se pudo leer cómo está agrupando el casino' };
    // 'diller' es como el casino escribe "dealer" (sic)
    return { ok: true, valor: sel.value, nivel: nivelDeModo(sel.value) };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/**
 * @param {number} o.desde   desde qué paso arrancar — para pedir la foto DE A PEDAZOS
 * @param {number} o.limite  cuántos pasos hacer en esta llamada (0 = todos)
 *
 * El troceado existe por dos razones. Una es el proxy de Railway, que corta a los ~5 minutos y
 * hacía que una foto grande no terminara nunca. La otra es que así el navegador puede mostrar el
 * avance de verdad — consulta por consulta, con su divisa y sus segundos — en vez de un botón
 * apretado y varios minutos de nada.
 */
async function capturar({ mes, conexionId = null, nivel = null, divisa = null, alcance = 'movidas',
  control = false, desde = 0, limite = 0, refrescar = false, onPaso = null, nivelDeclarado = null } = {}) {
  const m = String(mes || '').slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(m)) return { ok: false, error: 'mes inválido (se espera YYYY-MM)' };
  const { from, to } = rango(m);
  const todos = plan(m, { conexionId, nivel, divisa, alcance, control });
  if (!todos.length) return { ok: false, error: 'no hay conexiones con paneles para sacar la foto' };
  const ini = Math.max(0, Number(desde) || 0);
  const pasos = limite > 0 ? todos.slice(ini, ini + limite) : todos.slice(ini);

  const porCx = new Map();
  pasos.forEach((p) => { if (!porCx.has(p.conexion_id)) porCx.set(p.conexion_id, []); porCx.get(p.conexion_id).push(p); });

  // Las agrupaciones 'distributor' y 'agent' fueron un intento que no sirvió (el casino devolvía
  // lo mismo que 'superagent'): si quedaron filas de esa época, se limpian.
  // Sólo en el primer pedazo: con la foto troceada esto correría en cada llamada al pedo.
  //
  // ⚠️ LA LISTA SALE DE NIVELES, NO SE ESCRIBE A MANO. Estaba escrita en inglés —('superagent',
  // 'nodo')— de cuando los niveles se llamaban así. Después se renombraron al español y esta línea
  // quedó atrás: 'superagente' ya no coincidía con 'superagent', así que la limpieza le pasaba por
  // encima a LOS DOS NIVELES. Cada vez que se arrancaba una captura se borraba el mes entero, y
  // como la captura que seguía iba guardando, parecía que "se perdían al cargar el otro panel".
  // Atado a NIVELES esto no se puede volver a desfasar sin que fallen los tests.
  if (ini === 0) {
    const vigentes = [...NIVELES, 'nodo'];
    const hueco = vigentes.map(() => '?').join(',');
    db.prepare(`DELETE FROM estad_mes WHERE mes=? AND grupo NOT IN (${hueco})`).run(m, ...vigentes);
    db.prepare(`DELETE FROM estad_captura WHERE mes=? AND grupo NOT IN (${hueco})`).run(m, ...vigentes);
  }

  const hechos = [];
  await Promise.all([...porCx.entries()].map(async ([cxId, lista]) => {
    const cli = casinoConex.client(cxId);         // UNA sesión para toda la conexión
    // 🔒 CANDADO: si el casino está agrupando de otra forma, lo que devuelva NO es lo que dice ser.
    let modo = cli ? await modoActual(cli) : { ok: false, error: 'la conexión no responde' };
    // Si el casino ya no deja leerlo pero el dueño dijo en qué nivel lo puso, se le cree — y queda
    // anotado que fue declarado. Sin esto la foto no se puede sacar más, que es peor.
    if (!modo.ok && cli && nivelDeclarado && NIVELES.includes(nivelDeclarado)) {
      modo = { ok: true, valor: 'declarado:' + nivelDeclarado, nivel: nivelDeclarado, declarado: true };
    }
    if (!cli) {
      lista.forEach((t) => { _marcar(t, { estado: 'error', error: 'la conexión no responde' }); hechos.push({ ...t, estado: 'error', error: 'la conexión no responde' }); });
      return;
    }
    for (const t of lista) {
      // 🔒 EL CANDADO. El nivel lo decide el casino, no nosotros: si está agrupando por
      // distribuidor, lo que devuelva NO son números de superagente aunque se los pida así. Y no
      // es cosmético — el filtro profit>0 esconde los negativos, así que los dos niveles dan
      // totales distintos. Guardar uno con la etiqueta del otro sería cobrar el número equivocado.
      if (!modo.ok || modo.nivel !== t.nivel) {
        // No es un error: es la OTRA pasada. El nivel lo decide el casino y se cambia a mano, así
        // que cada corrida saca la mitad que corresponde y la otra queda esperando. Lo que NO puede
        // pasar es guardar filas de un nivel con la etiqueta del otro: el filtro profit>0 esconde
        // los negativos distinto en cada uno y el total cambia (Titán: 7.150 vs 7.162,50).
        const espera = modo.ok
          ? `falta la pasada por ${t.nivel} (el casino está en "${modo.valor}")`
          : `no se pudo leer cómo está agrupando el casino: ${modo.error}`;
        _marcar(t, { estado: modo.ok ? 'otro-nivel' : 'error', error: espera, modo: modo.ok ? modo.valor : null });
        hechos.push({ ...t, estado: modo.ok ? 'otro-nivel' : 'error', error: espera });
        if (onPaso) onPaso(hechos[hechos.length - 1]);
        continue;
      }
      const ya = captura(cxId, m, t.divisa, t.nivel, t.nodo);
      if (!refrescar && ya && ya.estado === 'ok') { hechos.push({ ...t, estado: 'ya estaba', filas: ya.filas, nodos: ya.nodos }); if (onPaso) onPaso(hechos[hechos.length - 1]); continue; }
      const t0 = Date.now();
      let r;
      // Siempre scopeada al nodo del panel: lo que cambia el nivel es el ajuste del casino.
      try { r = await cli.reporteProveedoresNodo({ nodoId: t.nodo, from, to, currency: t.divisa }); }
      catch (e) { r = { ok: false, error: String((e && e.message) || e) }; }
      const seg = Number(((Date.now() - t0) / 1000).toFixed(1));
      if (!r.ok) {
        _marcar(t, { estado: 'error', error: r.error, segundos: seg, modo: modo.ok ? modo.valor : null });
        hechos.push({ ...t, estado: 'error', error: r.error, segundos: seg });
      } else {
        const filas = r.filas || [];
        const n = _guardar(t, filas);
        const nodos = new Set(filas.map((f) => K(f.saId)).filter(Boolean)).size;
        _marcar(t, { estado: 'ok', filas: n, nodos, segundos: seg, modo: modo.ok ? modo.valor : null });
        hechos.push({ ...t, estado: 'ok', filas: n, nodos, segundos: seg });
      }
      if (onPaso) onPaso(hechos[hechos.length - 1]);
    }
  }));

  const modos = {};
  const ok = hechos.filter((h) => h.estado === 'ok' || h.estado === 'ya estaba').length;
  const otroNivel = hechos.filter((h) => h.estado === 'otro-nivel').length;
  const hechas = ini + pasos.length;
  return {
    ok: true, mes: m, consultas: pasos.length, logradas: ok,
    esperandoElOtroNivel: otroNivel,
    fallidas: hechos.length - ok - otroNivel,
    filas: hechos.reduce((s, h) => s + (h.filas || 0), 0),
    // para que el navegador sepa si tiene que seguir pidiendo
    total: todos.length, hechas, faltan: Math.max(0, todos.length - hechas),
    detalle: hechos,
  };
}

// ── leer la foto ────────────────────────────────────────────────────────────

/**
 * Las filas de un nodo, con la MISMA forma que devuelve el casino, para que quien las use no tenga
 * que enterarse de si salieron de la foto o de una consulta en vivo.
 * Devuelve null si esa combinación todavía no se sacó: eso significa "no sé", que es distinto de
 * "no tuvo movimiento". Nunca hay que tomar el null como cero.
 */
function filasDe({ conexionId, nodoId, mes, divisa, nivel = 'superagente' }) {
  // Cada panel lee la foto de SU nivel: la de superagente si es superagente, la de distribuidor si
  // no. Mezclarlas cambiaría el número, porque el filtro profit>0 esconde distinto en cada una.
  const g = nivel;
  const c = captura(conexionId, String(mes).slice(0, 7), String(divisa).toUpperCase(), g, nodoId);
  if (!c || c.estado !== 'ok') return null;
  const rows = db.prepare(`SELECT nodo_id, nodo_login, provider, label, vendor, bet, win, profit
    FROM estad_mes WHERE conexion_id=? AND mes=? AND divisa=? AND grupo=? AND nodo_id=?`)
    .all(conexionId, String(mes).slice(0, 7), String(divisa).toUpperCase(), g, String(nodoId));
  return rows.map((r) => ({
    saId: r.nodo_id, saLogin: r.nodo_login,
    provider: r.provider, label: r.label, vendor: r.vendor,
    bet: Number(r.bet) || 0, win: Number(r.win) || 0, profit: Number(r.profit) || 0,
  }));
}

/** Cómo está la foto de un mes: qué se sacó, qué falta y qué falló. */
function estado(mes) {
  const m = String(mes || '').slice(0, 7);
  const pasos = plan(m);
  const nom = {}; casinoConex.list().forEach((c) => { nom[c.id] = c.nombre; });
  const filas = pasos.map((p) => {
    const c = captura(p.conexion_id, m, p.divisa, p.nivel, p.nodo);
    return {
      conexion: nom[p.conexion_id] || p.conexion_id, conexion_id: p.conexion_id,
      divisa: p.divisa, nivel: p.nivel, nodo: p.nodo || null, panel: p.panel || null,
      estado: c ? c.estado : 'falta', filas: c ? c.filas : 0, nodos: c ? c.nodos : 0,
      error: c ? c.error : null, segundos: c ? c.segundos : null, capturado_at: c ? c.capturado_at : null,
      modo: c ? c.modo : null,
    };
  });
  const listas = filas.filter((f) => f.estado === 'ok').length;
  const porNivel = {};
  NIVELES.forEach((niv) => {
    const dela = filas.filter((f) => f.nivel === niv);
    porNivel[niv] = { total: dela.length, listas: dela.filter((f) => f.estado === 'ok').length };
  });
  // ⚠️ Un mes sacado mitad en un modo y mitad en otro NO es comparable: el modo cambia los números
  // (mismo nodo y mes: superagente 480.187,11 vs dealer 480.378,36). Se avisa, no se corrige solo.
  const modos = [...new Set(filas.filter((f) => f.estado === 'ok' && f.modo).map((f) => f.modo))];
  const conError = filas.filter((f) => f.estado === 'error');
  return {
    mes: m, total: filas.length, listas, porNivel, modos, modosMezclados: modos.length > 1, faltan: filas.filter((f) => f.estado === 'falta').length,
    conError: conError.length, completa: listas === filas.length && filas.length > 0,
    filasGuardadas: db.prepare('SELECT COUNT(*) c FROM estad_mes WHERE mes=?').get(m).c,
    detalle: filas,
  };
}

/** Meses que tienen algo sacado. */
function meses() {
  return db.prepare('SELECT mes, COUNT(*) filas, MAX(capturado_at) ultimo FROM estad_mes GROUP BY mes ORDER BY mes DESC').all();
}

function borrarMes(mes) {
  const m = String(mes || '').slice(0, 7);
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM estad_mes WHERE mes=?').run(m);
    db.prepare('DELETE FROM estad_captura WHERE mes=?').run(m);
  });
  tx();
  return true;
}

module.exports = { capturar, capturarGlobal, filasDe, estado, meses, plan, divisasDe, nivelDe, nivelDeModo, modoActual, captura, borrarMes, rango, NIVELES, divisasDePanel};
