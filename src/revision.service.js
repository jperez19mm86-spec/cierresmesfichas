/**
 * revision.service.js — 🩺 "¿QUÉ ESTÁ MAL ANTES DE COBRAR?", EN UNA SOLA PANTALLA.
 *
 * El problema no era que faltaran datos, era que el aviso de que faltaban estaba repartido: el % sin
 * cargar se veía en la ficha, el TC sin cargar en Tipos de cambio, el proveedor sin vincular en el
 * Cierre, y la columna huérfana en ningún lado. Había que acordarse de mirar en cinco lugares.
 *
 * Acá se junta todo lo que puede hacer que un mes salga con un número equivocado, ordenado por
 * gravedad. Cada punto dice QUÉ pasa, A QUIÉN afecta y DÓNDE se arregla.
 *
 * Es solo de lectura: no corrige nada solo. Que un número esté mal es una decisión del dueño.
 */
const clientes = require('./clientes-store');
const paneles = require('./paneles-store');
const cierre = require('./cierre-store');
const cierreMes = require('./cierre-mes.service');
const externosSvc = require('./externos.service');
const tcUnico = require('./tc-unico.service');
const { db } = require('./db');

const GRAVE = 'grave';   // sale un número equivocado y no se nota
const AVISO = 'aviso';   // no rompe la cuenta pero confunde

function revisar(mes) {
  const m = String(mes || new Date().toISOString().slice(0, 7)).slice(0, 7);
  const items = [];
  const push = (nivel, titulo, detalle, donde, afectados = []) =>
    items.push({ nivel, titulo, detalle, donde, afectados, cuantos: afectados.length });

  const cs = clientes.list().clientes;
  const noVendedores = cs.filter((c) => !c.es_vendedor);

  // 1) SIN % BASE → se factura al 0% y la factura sale en cero sin avisar
  const sinBase = noVendedores
    .filter((c) => externosSvc.baseDelMes(c, m).valor == null)
    .map((c) => c.nombre || c.nombreVisible || c.codigo);
  if (sinBase.length) {
    push(GRAVE, `${sinBase.length} cliente(s) sin % base en ${m}`,
      'Todo lo que carguen se factura al 0%: la factura sale en cero y parece correcta.',
      'Clientes → abrí el cliente → Precio base (con vigencia)', sinBase);
  }

  // 2) DIVISAS SIN TC → lo que se cobre en esa moneda no se puede pasar a USDT
  // los paneles guardan TODAS sus monedas (`divisas`), porque un superagente puede tener varias
  const divisas = [...new Set(paneles.list().flatMap((p) => (Array.isArray(p.divisas) ? p.divisas : []))
    .map((d) => String(d || '').toUpperCase()).filter(Boolean))];
  const sinTC = tcUnico.faltantes(m, divisas);
  if (sinTC.length) {
    push(GRAVE, `${sinTC.length} moneda(s) sin tipo de cambio en ${m}`,
      'Los paneles en esas monedas no se pueden pasar a USDT: quedan afuera del total.',
      '💱 Tipos de cambio → Cargado a mano (moneda × mes)', sinTC);
  }

  // 3) TC QUE NO COINCIDEN ENTRE FUENTES
  const disc = tcUnico.discrepancias(m);
  if (disc.length) {
    push(AVISO, `${disc.length} moneda(s) con tipos de cambio que no coinciden`,
      'Se usa el cargado a mano, pero el automático dice otra cosa. Si el de a mano quedó viejo, todo el mes sale corrido.',
      '💱 Tipos de cambio → arriba de todo',
      disc.map((d) => `${d.divisa}: se usa ${d.valor}, ${d.conflicto.map((c) => `${c.fuente} ${c.valor} (${c.difPct}%)`).join(', ')}`));
  }

  // 4) LA MATRIZ Y LOS CLIENTES NO SE CORRESPONDEN
  const inc = cierre.inconsistencias();
  if (inc.huerfanas.length) {
    push(AVISO, `${inc.huerfanas.length} columna(s) de la matriz sin cliente`,
      'Son porcentajes cargados a nombre de alguien que ya no existe (o que se renombró). No los usa nadie.',
      '🧮 Cierre de Mes → Matriz %', inc.huerfanas.map((h) => `${h.nombre} (${h.celdas} celdas)`));
  }
  if (inc.sinColumna.length) {
    const reales = inc.sinColumna.filter((n) => {
      const c = cs.find((x) => String(x.nombre || '').toLowerCase() === n);
      return c && !c.es_vendedor;
    });
    if (reales.length) {
      push(GRAVE, `${reales.length} cliente(s) sin columna en la matriz`,
        'No tienen ningún % de proveedor cargado: Proveedores externos les va a dar cero siempre.',
        '🧮 Cierre de Mes → Matriz %', reales);
    }
  }

  // 5) PANELES A MEDIO CONFIGURAR → no traen datos del casino y suman 0 en silencio
  const ps = paneles.list();
  const sinNodo = ps.filter((p) => !p.conexion_id || !p.id_usuario).map((p) => p.nombre);
  if (sinNodo.length) {
    push(GRAVE, `${sinNodo.length} panel(es) sin vincular al casino`,
      'No se les puede leer la carga ni la ganancia: suman cero en la factura sin avisar.',
      'Paneles → Conexión + Nodo', sinNodo);
  }
  const sinCliente = ps.filter((p) => !p.cliente_id).map((p) => p.nombre);
  if (sinCliente.length) {
    push(AVISO, `${sinCliente.length} panel(es) sin cliente`,
      'Tienen movimiento pero no se le cobran a nadie.',
      'Paneles → Cliente', sinCliente);
  }

  // 6) PROVEEDORES DEL CASINO SIN VINCULAR → sus ganancias no entran en el cálculo de externos
  const sinVinc = db.prepare("SELECT casino FROM cierre_link WHERE matriz IS NULL OR matriz=''").all().map((r) => r.casino);
  if (sinVinc.length) {
    push(AVISO, `${sinVinc.length} proveedor(es) del casino sin vincular a la matriz`,
      'Lo que ganen esos proveedores no entra en Proveedores externos: se deja de cobrar.',
      '🧮 Cierre de Mes → 🔗 Vincular proveedores', sinVinc.slice(0, 40));
  }

  // 7) LA MISMA CUENTA ANOTADA EN DOS LADOS: `cajas` (operativo) y `paneles` (comercial)
  const dobles = [];
  for (const c of cs) {
    const cajas = (c.cajas || []).map((k) => String(k.usuario || '').trim().toLowerCase()).filter(Boolean);
    if (!cajas.length) continue;
    const pans = paneles.list({ cliente_id: c.id }).map((p) => String(p.usuario || '').trim().toLowerCase()).filter(Boolean);
    const soloEnCajas = cajas.filter((u) => !pans.includes(u));
    const soloEnPaneles = pans.filter((u) => !cajas.includes(u));
    if (soloEnCajas.length || soloEnPaneles.length) {
      dobles.push(`${c.nombre || c.codigo}: ${soloEnCajas.length ? `solo en cajas → ${soloEnCajas.join(', ')}` : ''}${(soloEnCajas.length && soloEnPaneles.length) ? ' · ' : ''}${soloEnPaneles.length ? `solo en paneles → ${soloEnPaneles.join(', ')}` : ''}`);
    }
  }
  if (dobles.length) {
    push(AVISO, `${dobles.length} cliente(s) con las cuentas anotadas distinto en Cajas y en Paneles`,
      'La misma cuenta del casino se anota en dos lugares. Lo que se factura sale de Paneles: lo que esté solo en Cajas no se le cobra a nadie.',
      'Paneles (comercial) y Clientes → Cajas (operativo)', dobles);
  }

  // 8) LO QUE DICE EL CASINO vs LO QUE DICEN LOS PEDIDOS
  // Son dos números distintos por diseño (uno es lo que el casino registró, el otro lo que se vendió
  // por el sistema de pedidos), pero si se separan mucho es que algo no se cargó donde correspondía.
  try {
    const pedidos = require('./pedidos-store').ventasCargadasMes(m);
    const desvios = [];
    for (const c of noVendedores) {
      const vendido = Number((pedidos[c.codigo] || {}).monto || 0);
      if (!vendido) continue;
      const keys = paneles.list({ cliente_id: c.id }).filter((p) => p.conexion_id && p.id_usuario)
        .map((p) => ({ conexion_id: p.conexion_id, grp: 'superagent', sa_id: String(p.id_usuario) }));
      const casino = require('./reporte-diario-store').filasPanelesMes(keys, m)
        .reduce((s, r) => s + Number(r.in_amt || 0), 0);
      if (!casino) continue;
      const dif = Math.abs(casino - vendido) / Math.max(casino, vendido);
      if (dif > 0.1) desvios.push(`${c.nombre || c.codigo}: casino ${Math.round(casino).toLocaleString('es-AR')} vs pedidos ${Math.round(vendido).toLocaleString('es-AR')} (${Math.round(dif * 100)}%)`);
    }
    if (desvios.length) {
      // ⚠️ Este texto decía "se factura por lo que dice el CASINO". Es al revés desde el 2-ago:
      // se factura por los PEDIDOS, y el casino queda al lado solo como control.
      push(AVISO, `${desvios.length} cliente(s) donde el casino y los pedidos no dan lo mismo`,
        'Se factura por los PEDIDOS; el casino es solo el control. Que entre MÁS por el casino que lo vendido '
        + 'es normal cuando hubo cargas que no se cobran (reponer balance por un error, una prueba, un bono). '
        + 'Que entre MENOS, o falta cargar pedidos, o hubo ventas por fuera del sistema.',
        '🧾 Factura de consumo → columna Casino y la diferencia en %', desvios);
    }
  } catch { /* si falta el acumulado del mes, este chequeo simplemente no aplica */ }

  // 9) CAMPOS VIEJOS QUE NO USA NADIE PERO TIENEN VALOR CARGADO
  const conMargen = cs.filter((c) => c.margen_externos_pct != null && c.margen_externos_pct !== '')
    .map((c) => `${c.nombre || c.codigo}: +${c.margen_externos_pct}%`);
  if (conMargen.length) {
    push(AVISO, `${conMargen.length} cliente(s) con "Externos: cobrar +X%" cargado`,
      'Ese campo NO entra en ningún cálculo. Si la idea era cobrarles de más, hoy no se les está cobrando.',
      'Clientes → ficha (o cargalo en la matriz, que sí se usa)', conMargen);
  }

  // 10) CELDAS POR DEBAJO DEL COSTO DEL PROVEEDOR → se está facturando a pérdida
  //
  // El chequeo que ya existía compara la celda contra el % base del CLIENTE, que suele ser mucho
  // más chico que el costo. Así, una celda en 5 con un proveedor que cuesta 12 pasaba como buena
  // y se cobraba igual: se le factura al cliente menos de lo que el proveedor nos cobra a nosotros.
  //
  // Es también lo que pasa cuando SUBE un costo: la celda del cliente es un precio final, no un
  // margen, así que si el proveedor pasa de 12 a 13 y nadie toca las celdas, el margen se come
  // solo y nada avisa. Este punto es ese aviso.
  //
  // ⚠️ Un 0 NO se marca: significa "a este proveedor no se le cobra", que es una decisión tomada.
  items.push(...revisarBajoCosto(m));

  const graves = items.filter((i) => i.nivel === GRAVE).length;
  return { mes: m, items, graves, avisos: items.length - graves, limpio: items.length === 0 };
}

/**
 * Las celdas de la matriz que quedaron por debajo del costo del proveedor.
 * Devuelve items ya armados (uno por gravedad) para empujar al listado de Revisión.
 */
function revisarBajoCosto(mes) {
  const out = [];
  const m = String(mes || '').slice(0, 7);
  // Contra la foto del mes si está congelado: es lo que ese mes va a facturar de verdad.
  const precios = cierreMes.preciosDe(m);
  const mx = cierre.getMatriz();
  const costo = {};
  if (precios && precios.costo && Object.keys(precios.costo).length) Object.assign(costo, precios.costo);
  else mx.proveedores.forEach((p) => { costo[p.nombre] = p.base_pct; });
  const celdas = (precios && precios.celdas && Object.keys(precios.celdas).length) ? precios.celdas : mx.celdas;

  // A los VENDEDORES el motor les ignora la celda: pagan el costo real (`dif = costoProv`). Una
  // celda suya por debajo del costo no cobra de menos — no se cobra por ahí. Marcarlas sería
  // gritar 9 falsas alarmas sobre 15 y volver inútil el aviso.
  const K = (s) => String(s || '').trim().toLowerCase();
  const esVendedor = new Set();
  clientes.list().clientes.filter((c) => c.es_vendedor).forEach((c) => {
    [c.nombre, c.nombreVisible, c.codigo].filter(Boolean).forEach((n) => esVendedor.add(K(n)));
  });

  const num = (v) => (v == null || v === '' ? null : Number(v));
  const bajo = []; const enCero = []; const deVendedores = [];
  for (const [prov, porCliente] of Object.entries(celdas || {})) {
    const c = num(costo[prov]);
    if (c == null) continue;                       // proveedor sin costo cargado: es otro problema
    for (const [cliente, pct] of Object.entries(porCliente || {})) {
      const v = num(pct);
      if (v == null) continue;
      if (v === 0) { enCero.push(`${cliente} · ${prov}`); continue; }   // decisión tomada, no se toca
      if (v >= c) continue;
      if (esVendedor.has(K(cliente))) { deVendedores.push(`${cliente} · ${prov}`); continue; }
      bajo.push({ cliente, proveedor: prov, celda: String(pct), costo: String(costo[prov]), pierde: Math.round((c - v) * 100) / 100 });
    }
  }

  if (bajo.length) {
    bajo.sort((a, b) => b.pierde - a.pierde);
    const porCliente = {};
    bajo.forEach((b) => { (porCliente[b.cliente] = porCliente[b.cliente] || []).push(b); });
    out.push({
      nivel: GRAVE,
      titulo: `${bajo.length} celda(s) por debajo del costo del proveedor`,
      detalle: 'Se le cobra al cliente MENOS de lo que ese proveedor nos cuesta: cada ficha jugada ahí es pérdida. '
        + 'Pasa sobre todo cuando sube un costo y no se suben las celdas, porque la celda es un precio final, no un margen.'
        + (precios && precios.congelado ? ' (Mirado sobre la foto congelada de este mes.)' : ''),
      donde: '🧮 Cierre de Mes → Matriz % (la fila del proveedor, la columna del cliente)',
      afectados: Object.entries(porCliente)
        .sort((a, b) => b[1].length - a[1].length)
        .map(([cli, xs]) => `${cli}: ${xs.length} (peor ${xs[0].proveedor} ${xs[0].celda} vs costo ${xs[0].costo})`),
      cuantos: bajo.length,
      detalleFilas: bajo.slice(0, 200),
    });
  }
  if (deVendedores.length) {
    out.push({
      nivel: AVISO,
      titulo: `${deVendedores.length} celda(s) de VENDEDORES por debajo del costo (no molestan)`,
      detalle: 'Al vendedor no se le cobra por la celda sino por el costo real del proveedor, así que estas celdas están de más y no hacen daño. Se listan solo para que no sorprendan al mirarlas.',
      donde: '🧮 Cierre de Mes → Matriz % (las columnas de los vendedores)',
      afectados: deVendedores.slice(0, 60), cuantos: deVendedores.length,
    });
  }
  if (enCero.length) {
    out.push({
      nivel: AVISO,
      titulo: `${enCero.length} celda(s) en cero (no se les cobra)`,
      detalle: 'Un 0 significa que a ese proveedor NO se le cobra a ese cliente. Está bien si fue una decisión; se lista para que se vea.',
      donde: '🧮 Cierre de Mes → Matriz %',
      afectados: enCero.slice(0, 60), cuantos: enCero.length,
    });
  }
  return out;
}

module.exports = { revisar, revisarBajoCosto };
