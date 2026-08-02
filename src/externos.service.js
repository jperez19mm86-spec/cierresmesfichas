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
function pctsDelCliente(nombreCliente, mes, p) {
  if (!p) p = cierreMes.preciosDe(mes);
  const out = {};
  for (const [prov, fila] of Object.entries(p.celdas || {})) {
    const pct = fila && fila[nombreCliente];
    if (pct != null && pct !== '') out[K(prov)] = pct;
  }
  return {
    celdas: out,
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
  return (fila) => {
    const marca = String(fila.label || fila.provider || '').trim();
    const vendor = String(fila.vendor || '').trim();
    const conVendor = `${marca} ${vendor}`.trim();
    if (links[K(conVendor)]) return links[K(conVendor)];
    if (dela.has(K(conVendor))) return conVendor;
    if (links[K(marca)]) return links[K(marca)];
    if (dela.has(K(marca))) return marca;
    return null;                                        // sin vincular: se informa aparte
  };
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
 * Es el número por el que se multiplica todo lo que se cobra, así que ahora hay una sola regla:
 *   1) el CONFIRMADO para ese mes (gana siempre: es una decisión explícita del dueño)
 *   2) el vigente en el historial al CIERRE de ese mes
 *   3) si el panel tiene precio propio, ese pisa al del cliente
 * Devuelve también de DÓNDE salió, para poder mostrarlo y que nadie tenga que adivinar.
 */
function baseDelMes(cliente, mes, panel = null) {
  const m = String(mes || '').slice(0, 7);
  const g = baseGuardada(cliente.nombre, m);
  if (g && g.base_pct != null && g.base_pct !== '') return { valor: String(g.base_pct), fuente: 'confirmado', mes: m };
  const { to } = rango(m);                       // el vigente al cierre del mes, no el de hoy
  if (panel && panel.usa_config_cliente === false) {
    const ov = historial.getVigente('panel', panel.id, 'precio_base_pct', to);
    if (ov != null && ov !== '') return { valor: String(ov), fuente: 'precio propio del panel', mes: m };
  }
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
  const base = basePct != null ? String(basePct) : res.valor;
  const baseFuente = basePct != null ? 'a mano' : res.fuente;
  if (base == null) {
    return { ok: false, error: `"${cli.nombre}" no tiene % base cargado. Confirmalo antes de calcular.`, faltaBase: true };
  }

  const precios = cierreMes.preciosDe(mes);   // UNA sola vez: parsea la foto entera del mes
  const { celdas, proveedores, congelado, congeladoEn } = pctsDelCliente(cli.nombre, mes, precios);
  const costoDe = {}; proveedores.forEach((p) => { costoDe[K(p.nombre)] = p.base_pct; });
  const traducir = traductor(precios);
  const { from, to } = rango(mes);
  const mios = paneles.list().filter((p) => p.cliente_id === cli.id);

  // Cómo se lee la celda de la matriz para ESTE cliente.
  const modo = cli.es_vendedor ? 'vendedor' : (cli.externos_modo || 'total');

  const filas = [];            // una por panel+proveedor+divisa
  const sinVincular = new Map();
  const negativos = new Map(); // proveedor con % MENOR que la base → generaría negativo
  const avisos = [];
  let deCache = 0, delCasino = 0;

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
  const clientePorCx = new Map();     // una sesión por conexión, reusada para todas sus consultas
  const trabajos = [];
  for (const panel of mios) {
    const cx = casinoConex.list().find((c) => c.id === panel.conexion_id) || casinoConex.list().find((c) => K(c.nombre) === K(panel.sistema));
    if (!cx) { avisos.push(`${panel.nombre}: sin conexión de casino, no se pudo consultar`); continue; }
    if (!clientePorCx.has(cx.id)) clientePorCx.set(cx.id, casinoConex.client(cx.id));
    const cliCx = clientePorCx.get(cx.id);
    if (!cliCx) { avisos.push(`${panel.nombre}: la conexión "${cx.nombre}" no responde`); continue; }
    // Un SuperAgente puede tener varias divisas; de un Distribuidor/Agente para abajo hay UNA sola.
    const divisas = (panel.divisas || []).length ? panel.divisas : ['ARS'];
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

  // Todo lo que se resuelve con el caché, primero y sin tocar el casino.
  const pendientes = [];
  trabajos.forEach((t, i) => {
    const guardado = cache.get(t.cxId, t.panel.id_usuario, mes, t.divisa, { refrescar });
    if (guardado) { resultados[i] = { ok: true, filas: guardado.filas }; deCache++; }
    else pendientes.push(i);
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
  for (let i = 0; i < trabajos.length; i++) {
    const { panel, divisa } = trabajos[i];
    const r = resultados[i] || { ok: false, error: 'sin respuesta' };
    {
      if (!r.ok) { avisos.push(`${panel.nombre} (${divisa}): ${r.error}`); continue; }
      const tasa = tcDe(divisa, mes);

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
        const monto = cobra ? money.round(money.pct(profit, dif), 2) : '0';
        filas.push({
          panel: panel.nombre, panel_id: panel.id, nivel: panel.nivel_usuario, sistema: panel.sistema,
          divisa, proveedor: nombreMatriz, proveedorCasino: `${f.label || f.provider} ${f.vendor}`.trim(),
          costo: costoDe[K(nombreMatriz)] ?? null,
          profit, pct, base, dif, cobra, monto,
          tasa, usdt: (cobra && tasa) ? money.round(money.div(monto, tasa), 2) : '0',
          sinTasa: cobra && !tasa,
        });
        if (cobra && !tasa) avisos.push(`falta el TC de ${divisa} para ${mesCierre(mes)} — ese monto no se pudo pasar a USDT`);
      }
    }
  }

  // agrupar por panel, como el PDF
  const porPanel = new Map();
  for (const f of filas) {
    if (!porPanel.has(f.panel)) porPanel.set(f.panel, { panel: f.panel, nivel: f.nivel, sistema: f.sistema, divisa: f.divisa, items: [], total: '0', usdt: '0' });
    const g = porPanel.get(f.panel);
    g.items.push(f);
    if (f.cobra) { g.total = money.add(g.total, f.monto); g.usdt = money.add(g.usdt, f.usdt); }
  }
  const listaPaneles = [...porPanel.values()].sort((a, b) => money.cmp(b.usdt, a.usdt));
  const totalUsdt = money.sum(filas.filter((f) => f.cobra).map((f) => f.usdt));

  return {
    ok: true,
    cliente: cli.nombre, clienteId: cli.id, mes, mesNombre: mesCierre(mes), from, to,
    congelado, congeladoEn, baseFuente,
    base, baseConfirmada: !!guardada, confirmadoAt: guardada ? guardada.confirmadoAt : null,
    modo,
    negativos: [...negativos.values()],
    esVendedor: !!cli.es_vendedor,
    margenExtra: cli.margen_externos_pct ?? null,
    paneles: listaPaneles,
    deCache, delCasino, consultas: trabajos.length, sinTiempo, incompleto: sinTiempo > 0,
    cobrables: filas.filter((f) => f.cobra).length,
    revisados: filas.length,
    totalUsdt: money.round(totalUsdt, 2),
    sinVincular: [...sinVincular.entries()].map(([nombre, profit]) => ({ nombre, profit })).sort((a, b) => money.cmp(b.profit, a.profit)),
    avisos: [...new Set(avisos)],
  };
}

module.exports = { reporte, baseGuardada, confirmarBase, baseDelMes, tcDe, mesCierre, rango };
