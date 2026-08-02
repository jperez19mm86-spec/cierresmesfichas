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

  // 7) CAMPOS VIEJOS QUE NO USA NADIE PERO TIENEN VALOR CARGADO
  const conMargen = cs.filter((c) => c.margen_externos_pct != null && c.margen_externos_pct !== '')
    .map((c) => `${c.nombre || c.codigo}: +${c.margen_externos_pct}%`);
  if (conMargen.length) {
    push(AVISO, `${conMargen.length} cliente(s) con "Externos: cobrar +X%" cargado`,
      'Ese campo NO entra en ningún cálculo. Si la idea era cobrarles de más, hoy no se les está cobrando.',
      'Clientes → ficha (o cargalo en la matriz, que sí se usa)', conMargen);
  }

  const graves = items.filter((i) => i.nivel === GRAVE).length;
  return { mes: m, items, graves, avisos: items.length - graves, limpio: items.length === 0 };
}

module.exports = { revisar };
