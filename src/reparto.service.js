/**
 * reparto.service.js — cómo se reparte lo que paga cada cliente (§12 del addendum v3).
 *
 * ═══ UN SOLO PASO ═══
 * Antes iban dos: la tabla SPLIT_BASE partía el fee en Empresa/LATAM según el % base, y recién
 * después PARTICIPACIONES repartía el pedazo de LATAM entre los socios. Eran dos modelos
 * mentales para una sola pregunta, y la Empresa vivía en una tabla distinta a la de los socios.
 *
 * Ahora hay una sola lista por cliente. Cada fila es un participante con SUS PUNTOS, y la suma
 * tiene que dar EXACTAMENTE el % base de ese cliente. Ejemplo del dueño:
 *
 *     Pistacho, base 10%  →  Empresa 6 · Julián 1 · Henry 1,5 · Alexa 1,5  =  10 ✓
 *
 * Los porcentajes son PUNTOS ABSOLUTOS sobre la venta, no una porción de otra cosa. Por eso
 * cierran solos: Σ puntos = base ⇒ Σ montos = base% × ventas = el fee. No hay forma de que el
 * reparto y la factura difieran.
 *
 * ⚠️ Consecuencia buscada: si cambia el % base de un cliente, su reparto DEJA DE CERRAR y hay
 * que decidir quién absorbe la diferencia. No se prorratea solo — eso sería inventar una
 * decisión comercial. `revisar()` los lista y la pantalla los muestra en rojo.
 */
const participaciones = require('./participaciones-store');
const personas = require('./personas-store');
const externosSvc = require('./externos.service');
const money = require('./lib/money');

/**
 * El reparto vigente de un cliente para un mes, ya contrastado contra su % base.
 * @returns {{base, items, suma, resto, cierra, estado}}
 *   estado: 'ok' · 'parcial' (falta repartir puntos) · 'excedido' (se repartió de más)
 *           · 'sin_reparto' · 'sin_base'
 *
 * 'parcial' NO es un error: es el estado normal mientras se termina de configurar. Los puntos
 * que faltan se muestran como pendientes y se valorizan en USDT, en vez de tirar todo el
 * reparto del cliente. 'excedido' sí es un error: se estaría cobrando más que el % base.
 */
function repartoCliente(cliente, mes, fecha) {
  const f = fecha || `${String(mes).slice(0, 7)}-15`;   // fecha media del mes, para las vigencias
  const base = externosSvc.baseDelMes(cliente, mes).valor;
  const nombres = {}; const esEmp = {};
  personas.list().forEach((p) => { nombres[p.id] = p.nombre; esEmp[p.id] = !!p.es_empresa; });

  const crudos = participaciones.repartoEfectivo(cliente.id, null, f).items || [];
  const items = crudos.map((it) => ({
    persona_id: it.persona_id,
    nombre: nombres[it.persona_id] || it.persona_id,
    es_empresa: !!esEmp[it.persona_id],
    pct: String(it.porcentaje),
  }));
  const suma = money.sum(items.map((i) => i.pct));
  const resto = base != null && base !== '' ? money.sub(base, suma) : '0';

  let estado;
  if (base == null || base === '') estado = 'sin_base';
  else if (!items.length) estado = 'sin_reparto';
  else if (money.cmp(suma, base) === 0) estado = 'ok';
  else estado = money.isNeg(resto) ? 'excedido' : 'parcial';

  return {
    base, items,
    suma: money.round(suma, 4), resto: money.round(resto, 4),
    cierra: estado === 'ok', estado,
  };
}

/**
 * Reparte el fee de un cliente entre sus participantes.
 * @param ventasUsdt monto vendido del mes YA EN USDT
 * @returns {{ok, estado, fee_usdt, items, sin_asignar, reparto}}
 *
 * ── POR QUÉ ACÁ NO HAY TIPO DE CAMBIO ────────────────────────────────────────────────────────
 * Antes esta función recibía el monto en moneda local y UN tipo de cambio, y el que lo llamaba le
 * pasaba siempre el del PESO. Los clientes no venden todos en pesos: los guaraníes de Fran se
 * dividían por 1.574 en vez de 6.005 (3,8× de más) y los uruguayos de Titan por 1.574 en vez de
 * 40 (39× de menos). En julio 2026 eso repartió 16.787,91 USDT que no existían.
 *
 * La conversión no se arregló acá adentro, se sacó de acá. Un solo tipo de cambio por cliente es
 * la premisa equivocada: un cliente puede vender en tres monedas el mismo mes, y ahí no hay número
 * único que sirva. Quien llama convierte moneda por moneda —que es donde vive el dato— y esta
 * función recibe USDT y sólo reparte. Así el error no puede volver por otra puerta.
 *
 * 🔑 INVARIANTE: Σ items + sin_asignar = fee_usdt, exacto al centavo. Se consigue dándole al
 * ÚLTIMO renglón el residuo en vez de su propio redondeo. Calcular cada parte por separado y
 * sumarlas deja centavos colgando: es el mismo error que descuadraba la factura de externos.
 *
 * Con 'excedido' no se reparte nada: el reparto suma más que el % base, así que cualquier
 * número que devolviera estaría cobrando de más. Hay que arreglarlo antes.
 */
function distribuir(ventasUsdt, cliente, mes, fecha) {
  const r = repartoCliente(cliente, mes, fecha);
  const vacio = { ok: false, estado: r.estado, fee_usdt: '0', items: [], sin_asignar: '0', reparto: r };
  if (r.estado === 'sin_base') return vacio;

  const feeUsdt = money.round(money.pct(ventasUsdt, r.base), 2);
  if (r.estado === 'excedido') return { ...vacio, fee_usdt: feeUsdt };
  if (r.estado === 'sin_reparto') return { ...vacio, fee_usdt: feeUsdt, sin_asignar: feeUsdt };

  // Lo que se reparte de verdad: el fee menos los puntos que todavía no tienen dueño.
  const sinAsignar = money.round(money.pct(ventasUsdt, r.resto), 2);
  const repartible = money.sub(feeUsdt, sinAsignar);

  const out = []; let acum = '0';
  r.items.forEach((it, i) => {
    const monto = i === r.items.length - 1
      ? money.sub(repartible, acum)                                    // el residuo, para cerrar exacto
      : money.round(money.pct(ventasUsdt, it.pct), 2);
    acum = money.add(acum, monto);
    out.push({ ...it, monto });
  });
  return {
    ok: r.estado === 'ok', estado: r.estado,
    fee_usdt: feeUsdt, items: out, sin_asignar: sinAsignar, reparto: r,
  };
}

/** Los clientes cuyo reparto no cierra, con el motivo. Alimenta la pantalla y Revisión. */
function revisar(listaClientes, mes) {
  const problemas = [];
  for (const c of listaClientes) {
    const r = repartoCliente(c, mes);
    if (r.estado === 'ok') continue;
    problemas.push({
      cliente_id: c.id, codigo: c.codigo, nombre: c.nombre || c.nombreVisible,
      estado: r.estado, base: r.base, suma: r.suma, resto: r.resto,
      detalle: r.estado === 'sin_base' ? 'no tiene % base cargado'
        : r.estado === 'sin_reparto' ? 'tiene % base pero nadie lo cobra todavía'
          : r.estado === 'excedido' ? `el reparto suma ${r.suma}% y su base es ${r.base}%: se estaría cobrando ${money.round(money.mul(r.resto, '-1'), 4)} de más`
            : `faltan repartir ${r.resto} puntos de los ${r.base}% de base`,
    });
  }
  return problemas;
}

/**
 * Siembra el reparto de cada cliente a partir de la vieja Tabla Split.
 *
 * La Tabla Split decía, por cada % base, cuánto iba a Empresa y cuánto al conjunto LATAM. La
 * parte de Empresa se traduce directo a una fila del reparto nuevo. La parte de LATAM **no**:
 * saber qué socio se lleva cuánto es una decisión comercial que nadie tomó todavía (0 de 52
 * clientes tenían participaciones cargadas). Esos puntos quedan SIN ASIGNAR, a la vista.
 *
 * No pisa a los clientes que ya tengan reparto. `aplicar=false` devuelve el plan sin escribir.
 */
function sembrarDesdeSplit(listaClientes, mes, { aplicar = false } = {}) {
  const splitBase = require('./split-base-store');
  const emp = personas.empresa();
  const plan = []; const salteados = [];

  for (const c of listaClientes) {
    const r = repartoCliente(c, mes);
    if (r.items.length) { salteados.push({ codigo: c.codigo, motivo: 'ya tiene reparto' }); continue; }
    if (r.base == null || r.base === '') { salteados.push({ codigo: c.codigo, motivo: 'sin % base' }); continue; }
    const row = splitBase.forBase(r.base);
    if (!row || !row.pct_empresa) { salteados.push({ codigo: c.codigo, motivo: `la Tabla Split no cubre base ${r.base}%` }); continue; }
    plan.push({
      cliente_id: c.id, codigo: c.codigo, base: r.base,
      empresa_pct: String(row.pct_empresa),
      sin_asignar_pct: money.round(money.sub(r.base, row.pct_empresa), 4),
    });
  }

  if (aplicar) {
    for (const p of plan) {
      // esperado = empresa_pct: se guarda un reparto PARCIAL a propósito, y el resto queda
      // pendiente. Cerrarlo contra la base acá obligaría a inventar quién cobra el resto.
      participaciones.setReparto(
        p.cliente_id, null,
        [{ persona_id: emp.id, porcentaje: p.empresa_pct }],
        `${String(mes).slice(0, 7)}-01`,
        { esperado: p.empresa_pct, notas: 'sembrado desde la Tabla Split' },
      );
    }
  }
  return { aplicado: aplicar, empresa_id: emp.id, plan, salteados };
}

module.exports = { repartoCliente, distribuir, revisar, sembrarDesdeSplit };
