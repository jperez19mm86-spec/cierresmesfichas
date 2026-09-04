/**
 * externos.service.js — §9 PROVEEDORES EXTERNOS: cuánto hay que cobrarle a cada cliente.
 *
 * IDEA: el cliente paga su % base sobre lo que carga. Pero algunos proveedores de juegos cuestan
 * más que ese %, así que la diferencia se le cobra aparte, sobre las GANANCIAS que ese proveedor
 * generó EN ESE PANEL.
 *
 *   Diferencial% = (% del proveedor PARA ESE CLIENTE)  −  (% base del cliente)     [piso 0]
 *   Monto        = Ganancias del proveedor en el panel × Diferencial%
 *   USDT         = Monto / TC promedio del mes de la divisa del panel
 *
 * Si el proveedor cuesta igual o menos que el % base, NO se cobra. Si el proveedor dio pérdida
 * tampoco se cobra, y NO se arrastra al mes siguiente.
 *
 * De dónde sale cada dato:
 *   · % del proveedor para el cliente → la MATRIZ del cierre (`cierre_pct`), que es la planilla.
 *   · % base del cliente              → se CONFIRMA por mes (cambia: un mes 6%, otro 7%).
 *   · ganancias por proveedor y panel → el casino (`reporteProveedoresNodo`).
 *   · TC del mes                      → `tc-unico.service`, el mismo que usa Facturación.
 *
 * ⚠️ Los nombres de proveedor del casino NO son los de la matriz: se traducen con `cierre_link`.
 */
const paneles = require('./paneles-store');
const clientes = require('./clientes-store');
const cierre = require('./cierre-store');
const cierreMes = require('./cierre-mes.service');
const historial = require('./historial');
const cache = require('./ganancias-cache');
const estadMes = require('./estadisticas-mes.service');
const casinoConex = require('./casino-conexiones-store');
const tcUnico = require('./tc-unico.service');
const money = require('./lib/money');
const { db } = require('./db');

const K = (s) => String(s || '').trim().toLowerCase();
const MESES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];

/** '2026-07' → 'Julio_2026'. Los meses del cierre se llaman así, no en ISO. */
function mesCierre(iso) {
  const [y, m] = String(iso || '').split('-');
  return MESES[Number(m) - 1] ? `${MESES[Number(m) - 1]}_${y}` : String(iso);
}
/** Primer y último día del mes ISO, que es lo que pide el casino. */
function rango(iso) {
  const [y, m] = String(iso).split('-').map(Number);
  const ult = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${iso}-01`, to: `${iso}-${String(ult).padStart(2, '0')}` };
}

/**
 * TC del mes para una divisa. Tolerante con cómo se escribió el mes en el histórico
 * (Julio_2026, ABRIL_2026, Enero_26…). USD y USDT valen 1 aunque no estén cargados.
 */
function tcDe(moneda, iso) {
  // Antes esto leía SOLO la tabla del cierre, mientras Facturación leía otra: la misma factura
  // podía salir con dos tipos de cambio distintos. Ahora las tres pantallas preguntan lo mismo.
  return tcUnico.tcDelMes(moneda, iso).valor;
}

/**
 * El % de proveedor que le corresponde a ESE cliente, CON LOS PRECIOS DE ESE MES.
 * Si el mes está congelado se usa su foto; si no, la matriz viva. Sin esto, cambiar un precio hoy
 * cambiaría lo que calcula un mes ya facturado.
 */
/* ── DE QUIÉN SALEN LOS PRECIOS ──────────────────────────────────────────────────────────────
   La matriz tiene una columna por cliente. Ariel no tiene ni una celda —por eso el reporte se
   negaba a salir— y sus precios son los mismos que los de Fran; Marcelo y JJ, en cambio, difieren
   en 16 proveedores y cada uno conserva la suya.
   Se LEE la columna del otro, no se copia: copiar 186 celdas deja una foto que queda vieja el
   primer mes que se toque un precio, y nadie se entera. */
function columnaDe(nombreCliente) {
  try {
    const lista = clientes.list().clientes;
    const c = lista.find((x) => K(x.nombre) === K(nombreCliente));
    if (c && c.externos_precios_de) {
      // Se guarda el ID, no el nombre: la matriz se referencia por nombre y renombrar un cliente
      // le arrastra la columna, pero un puntero por nombre quedaría colgado en ese mismo momento.
      const otro = lista.find((x) => x.id === c.externos_precios_de);
      // Un solo salto, y nunca a sí mismo: una cadena mal cargada colgaría el reporte.
      if (otro && otro.id !== c.id) return otro.nombre;
    }
  } catch (e) { /* sin padrón se usa la propia */ }
  return nombreCliente;
}

function pctsDelCliente(nombreCliente, mes, p) {
  if (!p) p = cierreMes.preciosDe(mes);
  const columna = columnaDe(nombreCliente);
  const out = {};
  for (const [prov, fila] of Object.entries(p.celdas || {})) {
    const pct = fila && fila[columna];
    if (pct != null && pct !== '') out[K(prov)] = pct;
  }
  return {
    celdas: out,
    // De quién salieron, para que el reporte lo pueda decir en vez de que haya que adivinarlo.
    columna, columnaPrestada: K(columna) !== K(nombreCliente),
    congelado: p.congelado, congeladoEn: p.congeladoEn,
    proveedores: Object.entries(p.costo).map(([nombre, base_pct]) => ({ nombre, base_pct })),
  };
}

/** Traduce el nombre de proveedor del casino al de la matriz (cierre_link). */
function traductor(precios) {
  // Los nombres válidos y los vínculos salen DEL MES: si están congelados se usan esos. Si no,
  // agregar un proveedor hoy haría que un nombre del casino se resuelva distinto y un mes ya
  // cerrado cambiaría de número (pasó: Titan junio se movió de 7.150 a 6.628).
  const links = {};
  const fuenteLinks = (precios && precios.links) || db.prepare('SELECT casino, matriz FROM cierre_link').all();
  fuenteLinks.forEach((r) => { if (r.matriz) links[K(r.casino)] = r.matriz; });
  const nombres = (precios && precios.costo) ? Object.keys(precios.costo)
    : db.prepare('SELECT nombre FROM cierre_proveedor').all().map((r) => r.nombre);
  const dela = new Set(nombres.map((n) => K(n)));

  // ── UN VÍNCULO NUEVO SÍ ENTRA EN UN MES CERRADO, PERO SÓLO SI NO HABÍA NINGUNO ───────────────
  //
  // La regla de arriba existe por un caso real: Titan estaba vinculado, se lo revinculó, y junio se
  // movió de 7.150 a 6.628 sin que nadie lo pidiera. Eso NO puede volver a pasar y por eso la foto
  // manda siempre que la foto tenga algo que decir.
  //
  // Pero un nombre que la foto no sabe resolver no está "bien resuelto": no se resuelve a nada, y
  // la ganancia de ese proveedor se cae del cálculo entera. En julio son tres —CREEDROOMZ LIVE OP,
  // AMUSNET SZ y 3OAKS SZ— y son plata que no se le está pagando a nadie. La única forma de
  // arreglarlo era descongelar el mes, que es peor.
  //
  // Entonces: los vínculos de hoy completan SÓLO los huecos. Si la foto ya resuelve ese nombre —por
  // vínculo o porque el nombre del casino coincide con una fila— no se toca. Así este agregado sólo
  // puede sumar lo que faltaba, nunca cambiar lo que ya estaba, que es lo que rompió a Titan.
  const nuevos = new Set();
  if (precios && precios.links) {
    db.prepare('SELECT casino, matriz FROM cierre_link').all().forEach((r) => {
      if (!r.matriz) return;
      const k = K(r.casino);
      if (links[k] || dela.has(k)) return;      // ya se resuelve: la foto manda
      links[k] = r.matriz;
      nuevos.add(k);
    });
  }

  const fn = (fila) => {
    const marca = String(fila.label || fila.provider || '').trim();
    const vendor = String(fila.vendor || '').trim();
    const conVendor = `${marca} ${vendor}`.trim();
    if (links[K(conVendor)]) return links[K(conVendor)];
    if (dela.has(K(conVendor))) return conVendor;
    if (links[K(marca)]) return links[K(marca)];
    if (dela.has(K(marca))) return marca;
    return null;                                        // sin vincular: se informa aparte
  };
  // Qué nombres se resolvieron con un vínculo creado DESPUÉS de congelar el mes. Quien lea el
  // reporte tiene que poder ver que ese renglón no salió de la foto, igual que con los costos.
  fn.vinculosNuevos = nuevos;
  return fn;
}

// ── % base confirmado por MES ────────────────────────────────────────────────
// El % de un cliente cambia de un mes a otro (un mes 6, otro 7) pero su costo de proveedores casi
// nunca. Por eso el % se confirma POR MES y no se toca el histórico hacia atrás.
function baseGuardada(cliente, mes) {
  const r = db.prepare('SELECT base_pct, confirmadoAt FROM externos_base_mes WHERE cliente=? AND mes=?').get(String(cliente), String(mes));
  return r || null;
}
function confirmarBase(cliente, mes, base_pct) {
  db.prepare(`INSERT INTO externos_base_mes (cliente,mes,base_pct,confirmadoAt) VALUES (?,?,?,?)
              ON CONFLICT(cliente,mes) DO UPDATE SET base_pct=excluded.base_pct, confirmadoAt=excluded.confirmadoAt`)
    .run(String(cliente), String(mes), String(base_pct), new Date().toISOString());
  return baseGuardada(cliente, mes);
}

/**
 * ⭐ EL % BASE DE UN CLIENTE PARA UN MES — UNA SOLA FORMA DE RESOLVERLO.
 *
 * Antes cada pantalla lo hacía distinto y el mismo cliente-mes daba tres números:
 *   · Facturación lo pedía SIN fecha → usaba el de HOY (facturar junio en agosto aplicaba agosto)
 *   · Perfil y Reparto usaban el vigente al día 15 del mes
 *   · Proveedores externos usaba el confirmado a mano, en una tabla aparte
 * Es el número por el que se multiplica todo lo que se cobra, así que ahora hay una sola regla,
 * de lo MÁS específico a lo más general:
 *   1) el PRECIO PROPIO DEL PANEL, si ese panel tiene uno
 *   2) el CONFIRMADO para ese mes (una decisión explícita del dueño sobre el cliente)
 *   3) el vigente en el historial al CIERRE de ese mes
 * Devuelve también de DÓNDE salió, para poder mostrarlo y que nadie tenga que adivinar.
 *
 * ⚠️ EL PANEL VA ANTES QUE EL CONFIRMADO, Y EL ORDEN IMPORTA (decidido con la dueña, 1-sep-2026).
 * `externos_base_mes` guarda UN solo % por cliente y por mes: confirmar la base de Lucía en 11
 * pisaba el 15 de su panel `GALat-21Lu` y el precio propio no se aplicaba nunca —sin avisar—,
 * justo en los meses ya cerrados, que son los que se facturan. Cuando se confirma la base de un
 * mes se está confirmando el número GENERAL del cliente, no el de un panel que tiene precio
 * aparte. Los demás paneles del cliente siguen tomando el confirmado, como siempre.
 */
function baseDelMes(cliente, mes, panel = null) {
  const m = String(mes || '').slice(0, 7);
  const { to } = rango(m);                       // el vigente al cierre del mes, no el de hoy
  if (panel && panel.usa_config_cliente === false) {
    const ov = historial.getVigente('panel', panel.id, 'precio_base_pct', to);
    if (ov != null && ov !== '') return { valor: String(ov), fuente: 'precio propio del panel', mes: m };
  }
  const g = baseGuardada(cliente.nombre, m);
  if (g && g.base_pct != null && g.base_pct !== '') return { valor: String(g.base_pct), fuente: 'confirmado', mes: m };
  const v = historial.getVigente('cliente', cliente.id, 'precio_base_pct', to);
  return v != null && v !== ''
    ? { valor: String(v), fuente: 'vigente en el mes', mes: m }
    : { valor: null, fuente: 'SIN CARGAR', mes: m };
}

/**
 * El reporte de un cliente para un mes.
 * @returns { cliente, mes, base, baseConfirmada, paneles[], totales, sinVincular[], avisos[] }
 */
async function reporte({ clienteNombre, mes, basePct = null, refrescar = false }) {
  const cli = clientes.list().clientes.find((c) => K(c.nombre) === K(clienteNombre));
  if (!cli) return { ok: false, error: `no existe el cliente "${clienteNombre}"` };

  // % base: el que mandan, si no el confirmado del mes, si no el de la ficha del cliente
  const guardada = baseGuardada(cli.nombre, mes);
  const res = baseDelMes(cli, mes);
  // Al VENDEDOR no se le resta ninguna base: paga el costo real del proveedor (`dif = costoProv`
  // más abajo). Exigirle un % base cortaba el reporte por un dato que su cálculo ni mira — y como
  // sus bases se cargaron en 0 recién el 1-ago, julio abortaba para 7 de los 8. Se asume 0.
  const esVendedor = !!cli.es_vendedor;
  const base = basePct != null ? String(basePct) : (res.valor != null ? res.valor : (esVendedor ? '0' : null));
  const baseFuente = basePct != null ? 'a mano' : (res.valor != null ? res.fuente : 'vendedor: paga el costo, no lleva base');
  if (base == null) {
    return { ok: false, error: `"${cli.nombre}" no tiene % base cargado. Confirmalo antes de calcular.`, faltaBase: true };
  }

  const precios = cierreMes.preciosDe(mes);   // UNA sola vez: parsea la foto entera del mes
  const { celdas, proveedores, congelado, congeladoEn, columna, columnaPrestada } = pctsDelCliente(cli.nombre, mes, precios);
  const costoDe = {}; proveedores.forEach((p) => { costoDe[K(p.nombre)] = p.base_pct; });
  const traducir = traductor(precios);
  const { from, to } = rango(mes);
  const mios = paneles.list().filter((p) => p.cliente_id === cli.id);

  // Cómo se lee la celda de la matriz para ESTE cliente.
  const modo = esVendedor ? 'vendedor' : (cli.externos_modo || 'total');

  const filas = [];            // una por panel+proveedor+divisa
  const sinVincular = new Map();
  const negativos = new Map(); // proveedor con % MENOR que la base → generaría negativo
  const avisos = [];
  let deCache = 0, delCasino = 0, deLaFoto = 0;

  // ── 1) armar la lista de consultas ────────────────────────────────────────
  // Cada panel × divisa es UNA consulta al casino, y son independientes entre sí. Hacerlas EN FILA
  // era lo que hacía que un cliente con 9 paneles multidivisa (26 consultas, hasta 2 min cada una)
  // nunca terminara: la conexión se cortaba antes y el reporte no se podía sacar (pasó con Oscar).
  // ⚠️ UNA SOLA SESIÓN POR CONEXIÓN, Y LAS CONSULTAS DE ESA CONEXIÓN EN FILA.
  // El motor de reportes del casino tiene ESTADO por sesión (guarda el filtro y el template antes de
  // pedir la tabla) y además el casino tira abajo la sesión anterior cuando el mismo usuario vuelve a
  // entrar. Mandarle varias consultas a la vez sobre la misma conexión hace que se pisen: probado
  // contra producción, 14 de 26 consultas volvieron con "sesión inválida" y el reporte dio 0.
  // Lo que SÍ se puede hacer en paralelo es una conexión contra otra: son casinos distintos.
  // 🔴 UN PANEL QUE CUELGA DE OTRO PANEL DEL MISMO CLIENTE SE CONTABA DOS VECES.
  // La consulta de un nodo devuelve TODO su subárbol, así que si el cliente tiene cargado el padre
  // Y el hijo, la plata del hijo entra en las dos y se le cobra doble. Verificado: Luxor tenía
  // "GAMati-A" colgando de "GAMati-D" y su factura salía 762,72 en vez de ~381.
  // Se saltea el HIJO y se deja el padre, que ya lo incluye. Se informa cuál y por qué.
  const nodosDelCliente = new Map();
  mios.forEach((p) => { if (p.id_usuario) nodosDelCliente.set(String(p.id_usuario), p); });
  const incluidos = [];
  const propios = mios.filter((p) => {
    const padre = nodosDelCliente.get(String(p.padre_id || '')) || nodosDelCliente.get(String(p.sa_id || ''));
    if (padre && padre.id !== p.id) {
      incluidos.push({ panel: p.nombre, dentroDe: padre.nombre });
      return false;
    }
    return true;
  });
  if (incluidos.length) {
    incluidos.forEach((i) => avisos.push(`"${i.panel}" no se consulta aparte: ya está adentro de "${i.dentroDe}", que es del mismo cliente. Contarlo dos veces le cobraría el doble.`));
  }

  const clientePorCx = new Map();     // una sesión por conexión, reusada para todas sus consultas
  const trabajos = [];
  /* ── POR QUÉ SALIÓ CORTO, CONTADO APARTE ────────────────────────────────────────────────────
     La marca `incompleto` miraba SÓLO el reloj (`sinTiempo`), y hay cuatro formas más de que el
     reporte salga corto: un panel sin conexión de casino, una conexión que no responde, una
     consulta que falló, y una línea que se cobra pero cuya moneda no tiene tipo de cambio (entra
     al total valiendo cero). Con cualquiera de esas cuatro, `incompleto` quedaba en false, la
     guarda de la emisión dejaba pasar, y se le facturaba de menos al cliente con una factura que
     se ve impecable.
     Se cuentan acá, uno por uno, y no leyendo los textos de `avisos`: contar strings se rompe la
     primera vez que alguien corrige una palabra del mensaje. */
  let sinConexion = 0, noResponde = 0, consultasFallidas = 0;
  for (const panel of propios) {
    const cx = casinoConex.list().find((c) => c.id === panel.conexion_id) || casinoConex.list().find((c) => K(c.nombre) === K(panel.sistema));
    if (!cx) { avisos.push(`${panel.nombre}: sin conexión de casino, no se pudo consultar`); sinConexion++; continue; }
    if (!clientePorCx.has(cx.id)) clientePorCx.set(cx.id, casinoConex.client(cx.id));
    const cliCx = clientePorCx.get(cx.id);
    if (!cliCx) { avisos.push(`${panel.nombre}: la conexión "${cx.nombre}" no responde`); noResponde++; continue; }
    // Un SuperAgente puede tener varias divisas; de un Distribuidor/Agente para abajo hay UNA sola.
    // Las que la dueña marcó como "no se consultan nunca" tampoco se piden en vivo: si no valen
    // para la Foto tampoco valen acá, y este camino es el lento (una consulta de hasta 16s c/u).
    const igns = require('./config-store').getDivisasIgnoradas();
    const sinIgn = (panel.divisas || []).filter((d) => !igns.includes(String(d).toUpperCase()));
    const divisas = sinIgn.length ? sinIgn : ['ARS'];
    for (const divisa of divisas) trabajos.push({ panel, cxId: cx.id, cliCx, divisa });
  }

  // ── 2) traerlas de a varias a la vez ──────────────────────────────────────
  // El caché primero: un mes cerrado ya no cambia. Lo que falte se le pide al casino con varios
  // pedidos en paralelo, pero acotados: si se le mandan las 26 juntas el casino empieza a fallar.
  // Tope de tiempo: si el casino está lento y no llegamos, se devuelve lo que se juntó en vez de
  // cortar la conexión y perder todo. Lo traído queda en el caché, así que volver a calcular sigue
  // desde donde quedó en lugar de empezar de cero.
  const PRESUPUESTO_MS = Number(process.env.EXTERNOS_PRESUPUESTO_MS) || 150000;
  const vence = Date.now() + PRESUPUESTO_MS;
  const resultados = new Array(trabajos.length);
  let sinTiempo = 0;

  // Todo lo que se resuelve SIN tocar el casino, primero.
  //   1) la FOTO DEL MES: se sacó una vez y sirve para todos los clientes de esa conexión
  //   2) el caché de consultas sueltas anteriores
  // Recién lo que no está en ninguna de las dos se le pregunta al casino.
  const pendientes = [];
  trabajos.forEach((t, i) => {
    // Cada panel lee la foto de SU nivel: superagente o distribuidor. No se mezclan, porque el
    // filtro profit>0 esconde los negativos distinto en cada nivel y el total cambia.
    const nivel = estadMes.nivelDe(t.panel);
    const deFoto = estadMes.filasDe({ conexionId: t.cxId, nodoId: t.panel.id_usuario, mes, divisa: t.divisa, nivel });
    if (deFoto) { resultados[i] = { ok: true, filas: deFoto }; deLaFoto++; return; }
    const guardado = cache.get(t.cxId, t.panel.id_usuario, mes, t.divisa, { refrescar });
    if (guardado) { resultados[i] = { ok: true, filas: guardado.filas }; deCache++; return; }
    // Si la foto de esa combinación se INTENTÓ y falló, no tiene sentido volver a preguntarle al
    // casino en vivo: falla igual y tarda. Pasaba con Oscar: 14 consultas condenadas, 157 segundos
    // de espera para terminar dando lo mismo. Se dice que falta y se sigue.
    const c = estadMes.captura(t.cxId, mes, t.divisa, nivel, t.panel.id_usuario);
    if (c && c.estado === 'error' && !refrescar) {
      resultados[i] = { ok: false, error: `la foto del mes falló para esta conexión (${c.error}). Volvé a sacarla en 📸 Foto del mes.` };
      return;
    }
    pendientes.push(i);
  });

  // Lo que falta: agrupado POR CONEXIÓN. Dentro de cada una, una por vez; entre conexiones, a la par.
  const porCx = new Map();
  pendientes.forEach((i) => {
    const k = trabajos[i].cxId;
    if (!porCx.has(k)) porCx.set(k, []);
    porCx.get(k).push(i);
  });
  await Promise.all([...porCx.values()].map(async (indices) => {
    for (const i of indices) {
      const t = trabajos[i];
      if (Date.now() > vence) { resultados[i] = { ok: false, error: 'no llegó a consultarse (se acabó el tiempo)', porTiempo: true }; sinTiempo++; continue; }
      try {
        const r = await t.cliCx.reporteProveedoresNodo({ nodoId: t.panel.id_usuario, from, to, currency: t.divisa });
        if (r.ok) { cache.set(t.cxId, t.panel.id_usuario, mes, t.divisa, r.filas); delCasino++; }
        resultados[i] = r;
      } catch (e) {
        resultados[i] = { ok: false, error: String((e && e.message) || e) };
      }
    }
  }));
  if (sinTiempo) {
    avisos.push(`⚠ quedaron ${sinTiempo} de ${trabajos.length} consultas sin hacer: el casino está lento. Lo que ya se trajo quedó guardado — apretá Calcular de nuevo y sigue desde ahí. El total de abajo está INCOMPLETO.`);
  }

  // ── 3) procesar en orden ──────────────────────────────────────────────────
  // El cálculo se hace después y en el orden original, para que el resultado no dependa de cuál
  // consulta contestó primero.
  // Se junta por PANEL + MONEDA + PROVEEDOR DE LA MATRIZ antes de sacar cuentas, y recién ahí se
  // aplica el porcentaje y se pasa a USDT. Una vez, no una por cada línea del casino.
  //
  // Por qué importa: el casino puede devolver varias líneas que caen en el mismo proveedor de la
  // matriz ("EGT DIGITAL SZ" y "EGT DIGITAL default", por ejemplo). Si se redondea cada una y
  // después se suman, el resultado no coincide con hacer la cuenta de una sola vez, y al cliente
  // le da distinto por centavos cuando divide para verificar. Sumando primero, la factura cierra:
  // ganancia × excedente% = a cobrar, y a cobrar ÷ TC = USDT, exacto.
  const grupos = new Map();
  let lineasCasino = 0;

  for (let i = 0; i < trabajos.length; i++) {
    const { panel, divisa } = trabajos[i];
    const r = resultados[i] || { ok: false, error: 'sin respuesta' };
    {
      // `porTiempo` ya lo cuenta `sinTiempo`: sumarlo acá lo contaría dos veces.
      if (!r.ok) { avisos.push(`${panel.nombre} (${divisa}): ${r.error}`); if (!r.porTiempo) consultasFallidas++; continue; }

      for (const f of (r.filas || [])) {
        const profit = String(f.profit || '0');
        if (money.cmp(profit, '0') <= 0) continue;              // pérdida o cero: no se cobra, sin arrastre
        const nombreMatriz = traducir(f);
        if (!nombreMatriz) {
          const k = `${f.label || f.provider} ${f.vendor}`.trim();
          sinVincular.set(k, money.add(sinVincular.get(k) || '0', profit));
          continue;
        }
        const pct = celdas[K(nombreMatriz)];
        const costoProv = costoDe[K(nombreMatriz)];
        // EL VENDEDOR NO ES UN CLIENTE: paga SIEMPRE el costo real del proveedor, sea 0.5 o 17, y
        // por TODOS los que use. No necesita celda en la matriz ni le aplica ninguna otra regla
        // (regla del dueño). Por eso sus columnas se sacaron de la matriz.
        if (modo === 'vendedor') {
          if (costoProv == null || costoProv === '') continue;   // sin costo cargado no se puede cobrar
        } else if (pct == null) continue;                        // el cliente no tiene ese proveedor
        // Para los clientes, la celda es el precio final y se le resta su % base.
        const dif = modo === 'vendedor' ? costoProv : money.sub(pct, base);
        const cobra = money.cmp(dif, '0') > 0;
        // Aviso: un cliente que hoy trabaja al 7% no puede tener un proveedor en 6 → daría negativo.
        if (modo === 'total' && money.cmp(pct, base) < 0) {
          negativos.set(nombreMatriz, { proveedor: nombreMatriz, pct, base });
        }
        // 🔑 QUÉ TC SE USA DEPENDE DE QUÉ CUENTA ES (regla del dueño, 4-ago). Hay tres:
        //   · la que se le COBRA AL CLIENTE (Marcelo, Titan…) → SIEMPRE el promedio del mes
        //   · la INTERNA, por vendedor (Henry, Alexa…)        → el TC del proveedor
        //   · la GLOBAL, lo que pagamos (pago-proveedores)    → el TC del proveedor
        // Las dos últimas son lo que el dueño realmente paga, y por eso van con la tasa del
        // proveedor (salvo SL2 y BVS, que van con el promedio). Al cliente se le cobra con el
        // promedio y punto: la diferencia entre las dos tasas es margen, no un costo a trasladar.
        const tcE = modo === 'vendedor'
          ? tcUnico.tcExternos(divisa, mes, nombreMatriz)
          : tcUnico.tcDelMes(divisa, mes);
        const tasa = tcE.valor;
        const k = `${panel.id}|${divisa}|${K(nombreMatriz)}`;
        const g = grupos.get(k) || {
          panel: panel.nombre, panel_id: panel.id, nivel: panel.nivel_usuario, sistema: panel.sistema,
          divisa, proveedor: nombreMatriz, deCasino: [],
          costo: costoDe[K(nombreMatriz)] ?? null,
          profit: '0', pct, base, dif, cobra, tasa, tcFuente: tcE.fuente,
        };
        g.profit = money.add(g.profit, profit);        // la ganancia se suma ENTERA, sin redondear
        g.deCasino.push(`${f.label || f.provider} ${f.vendor}`.trim());
        grupos.set(k, g);
        lineasCasino++;
        if (cobra && !tasa) avisos.push(`falta el TC de ${divisa} para ${mesCierre(mes)} — ese monto no se pudo pasar a USDT`);
      }
    }
  }

  // Recién ahora: el porcentaje y el pase a USDT, una sola vez por línea facturable.
  for (const g of grupos.values()) {
    const monto = g.cobra ? money.round(money.pct(g.profit, g.dif), 2) : '0';
    filas.push({
      panel: g.panel, panel_id: g.panel_id, nivel: g.nivel, sistema: g.sistema,
      divisa: g.divisa, proveedor: g.proveedor,
      // De qué líneas del casino salió: se guardan todas para poder rastrear de dónde viene el número.
      proveedorCasino: [...new Set(g.deCasino)].join(' + '),
      lineas: g.deCasino.length,
      costo: g.costo,
      profit: money.round(g.profit, 2), pct: g.pct, base: g.base, dif: g.dif, cobra: g.cobra, monto,
      tasa: g.tasa, usdt: (g.cobra && g.tasa) ? money.round(money.div(monto, g.tasa), 2) : '0',
      // De dónde salió la tasa. Viaja hasta acá porque es lo que deja ver que una línea del
      // VENDEDOR se valuó con el promedio por falta del TC del proveedor: sin esto el aviso
      // existía adentro del cálculo y no llegaba a ningún lado.
      tcFuente: g.tcFuente || null,
      sinTasa: g.cobra && !g.tasa,
    });
  }

  // agrupar por panel, como el PDF
  // Por panel Y MONEDA: un panel puede reportar en varias, y "total" está en moneda local — juntar
  // pesos con guaraníes en un mismo número no significa nada.
  const porPanel = new Map();
  for (const f of filas) {
    const kp = `${f.panel}|${f.divisa}`;
    if (!porPanel.has(kp)) porPanel.set(kp, { panel: f.panel, nivel: f.nivel, sistema: f.sistema, divisa: f.divisa, items: [], total: '0', usdt: '0' });
    const g = porPanel.get(kp);
    g.items.push(f);
    if (f.cobra) { g.total = money.add(g.total, f.monto); g.usdt = money.add(g.usdt, f.usdt); }
  }
  const listaPaneles = [...porPanel.values()].sort((a, b) => money.cmp(b.usdt, a.usdt));
  const totalUsdt = money.sum(filas.filter((f) => f.cobra).map((f) => f.usdt));

  // Una línea que se cobra y no tiene tipo de cambio entra al total valiendo CERO (ver `usdt`
  // más arriba): es plata que se factura de menos sin que nada se rompa.
  const sinTasaN = filas.filter((f) => f.sinTasa).length;
  const monedasSinTasa = [...new Set(filas.filter((f) => f.sinTasa).map((f) => f.divisa))].sort();
  const motivosIncompleto = [];
  if (sinTiempo) motivosIncompleto.push(`${sinTiempo} consulta(s) no llegaron a hacerse: se acabó el tiempo`);
  if (sinConexion) motivosIncompleto.push(`${sinConexion} panel(es) sin conexión de casino`);
  if (noResponde) motivosIncompleto.push(`${noResponde} panel(es) cuya conexión no respondió`);
  if (consultasFallidas) motivosIncompleto.push(`${consultasFallidas} consulta(s) al casino fallaron`);
  if (sinTasaN) motivosIncompleto.push(`${sinTasaN} línea(s) cobrables en ${monedasSinTasa.join(', ')} `
    + 'sin tipo de cambio: entran al total valiendo cero');

  /* ── EL VENDEDOR SIN EL TC DEL PROVEEDOR ────────────────────────────────────────────────────
     La cuenta del vendedor es lo que se paga DE VERDAD, y por eso va con el TC que factura el
     proveedor (la fila ARS_OF). Si ese TC no está cargado para el mes, `tcExternos` cae al
     promedio y sigue como si nada: sólo deja un aviso adentro de `fuente`, que no mira nadie.
     Al cliente no lo afecta —a él se le cobra siempre con el promedio— pero al vendedor sí, y
     con el promedio (más alto) la cuenta sale con MENOS dólares. Agosto 2026: el promedio era
     1584,53 y el del proveedor 1508,77.
     Se marca INCOMPLETO, que es lo que hace que la emisión no lo pase a la deuda: un número
     cobrado de menos que cuadra es peor que uno que falta. */
  const sinTcProv = filas.filter((f) => f.cobra && /sin TC de proveedor/i.test(String(f.tcFuente || ''))).length;
  if (sinTcProv) motivosIncompleto.push(`${sinTcProv} línea(s) sin el TC del proveedor del mes `
    + '(la fila ARS_OF): se valuarían con el promedio y la cuenta saldría con menos dólares');

  return {
    ok: true,
    cliente: cli.nombre, clienteId: cli.id, mes, mesNombre: mesCierre(mes), from, to,
    congelado, congeladoEn, baseFuente,
    // De qué columna de la matriz salieron los precios: la propia, o la del cliente que lo banca.
    columnaPrecios: columna, columnaPrestada: !!columnaPrestada,
    base, baseConfirmada: !!guardada, confirmadoAt: guardada ? guardada.confirmadoAt : null,
    modo,
    negativos: [...negativos.values()],
    esVendedor: !!cli.es_vendedor,
    margenExtra: cli.margen_externos_pct ?? null,
    paneles: listaPaneles,
    deCache, delCasino, deLaFoto, consultas: trabajos.length, yaIncluidos: incluidos, sinTiempo,
    /* `incompleto` = falta algo que HARÍA COBRAR MÁS. Cada motivo por separado, para que quien
       lo lea sepa qué arreglar; y el texto ya armado, para poder mostrarlo sin rearmarlo en cada
       pantalla. Ver el comentario de los contadores más arriba. */
    faltantes: { sinTiempo, sinConexion, noResponde, consultasFallidas, sinTasa: sinTasaN },
    porQueIncompleto: motivosIncompleto,
    incompleto: motivosIncompleto.length > 0,
    cobrables: filas.filter((f) => f.cobra).length,
    // "revisados" sigue siendo lo que trajo el casino; "facturables" son las líneas después de
    // juntar las que caen en el mismo proveedor de la matriz.
    revisados: lineasCasino,
    facturables: filas.length,
    totalUsdt: money.round(totalUsdt, 2),
    sinVincular: [...sinVincular.entries()].map(([nombre, profit]) => ({ nombre, profit })).sort((a, b) => money.cmp(b.profit, a.profit)),
    avisos: [...new Set(avisos)],
  };
}

// `traductor` se exporta para que la cuenta de lo que le PAGAMOS a los proveedores use el mismo
// cruce casino→matriz que la de lo que les cobramos a los clientes. Si fueran dos, los dos lados
// del mismo proveedor podrían resolverse distinto.
module.exports = { reporte, baseGuardada, confirmarBase, baseDelMes, tcDe, mesCierre, rango, traductor,
  pctsDelCliente, columnaDe };
