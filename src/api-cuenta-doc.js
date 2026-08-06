/**
 * api-cuenta-doc.js — LOS DOS DOCUMENTOS que salen de la misma cuenta.
 *
 *   vista 'cliente'  → lo que se le manda al cliente: qué consumió y cuánto paga. NADA MÁS.
 *   vista 'interno'  → la del dueño: además, lo que le pagamos al proveedor y lo que queda.
 *
 * Y por alcance, para los clientes que tienen una caja aparte (Nacho):
 *   'propio'  → todo menos la caja        'caja' → sólo esa caja        'total' → las dos juntas
 *
 * ── POR QUÉ ES UNA LISTA BLANCA Y NO UN `delete` ───────────────────────────────────────────────
 *
 * El riesgo acá no es que la pantalla muestre una columna de más: es filtrarle al cliente lo que le
 * pagamos al proveedor y cuánto le ganamos. Esconder columnas en el navegador no sirve — el JSON
 * viaja igual y se lee en la consola del browser en dos clics. Y borrar campos de un objeto tampoco:
 * el día que alguien agregue un campo nuevo al motor, se filtra solo.
 *
 * Por eso el documento del cliente se ARMA campo por campo desde una lista explícita. Lo que no
 * está en la lista no existe en la respuesta. Si mañana se agrega algo al motor, no aparece acá
 * hasta que alguien lo ponga a mano — que es exactamente lo que se quiere.
 */
const money = require('./lib/money');

const LINEA_CLIENTE = ['sello', 'sello_largo', 'tipo', 'divisa', 'ggr', 'ggr_usd', 'tc_cliente',
  'pct_cliente', 'monto_cliente', 'usdt_cliente'];
const DIVISA_CLIENTE = ['divisa', 'tc_cliente', 'ggr', 'ggr_usd', 'usdt_cliente'];

const LINEA_INTERNA = [...LINEA_CLIENTE, 'pct_proveedor', 'costo_sello', 'monto_proveedor',
  'tc_proveedor', 'usdt_proveedor', 'usdt_empresa', 'origen'];
const DIVISA_INTERNA = [...DIVISA_CLIENTE, 'tc_proveedor', 'tc_proveedor_varios',
  'usdt_proveedor', 'usdt_empresa'];

const tomar = (obj, campos) => {
  const o = {};
  campos.forEach((k) => { if (obj[k] !== undefined) o[k] = obj[k]; });
  return o;
};

/** El bloque que pide el alcance. Devuelve null si no existe (ej: pidieron una caja que no está). */
function bloqueDe(cuenta, alcance, caja_id) {
  if (alcance === 'caja') {
    const k = (cuenta.cajas || []).find((x) => String(x.cliente_id) === String(caja_id));
    return k || null;
  }
  if (alcance === 'total') return cuenta.total || cuenta;
  return cuenta.propio || cuenta;               // 'propio' — sin caja, propio === la cuenta entera
}

/**
 * @param {object} o.cuenta   una cuenta de las que devuelve api-cuenta.service.cuentas()
 * @param {string} o.vista    'cliente' | 'interno'
 * @param {string} o.alcance  'propio' | 'caja' | 'total'
 */
function documento({ cuenta, mes, vista = 'interno', alcance = 'total', caja_id = null } = {}) {
  if (!cuenta) return { ok: false, error: 'no hay cuenta para ese cliente en ese mes' };
  const b = bloqueDe(cuenta, alcance, caja_id);
  if (!b) return { ok: false, error: `esa cuenta no tiene una caja ${caja_id}` };
  const esCliente = vista === 'cliente';
  const cl = esCliente ? LINEA_CLIENTE : LINEA_INTERNA;
  const cd = esCliente ? DIVISA_CLIENTE : DIVISA_INTERNA;

  const proyectar = (bloque) => (bloque.porDivisa || []).map((d) => ({
    ...tomar(d, cd),
    lineas: (d.lineas || []).map((l) => tomar(l, cl)),
  }));

  // EL TOTAL VA EN SECCIONES, NO MEZCLADO.
  // Sumar los dos proyectos en una sola tabla deja SL, SL2 y XG repetidos sin decir de cuál son.
  // El dueño siempre mandó esta cuenta con los proyectos separados, cada uno con su subtotal, y el
  // total abajo. Una sección por proyecto es eso mismo: sirve para leerla y para conciliarla.
  const partes = (alcance === 'total' && cuenta.cajas && cuenta.cajas.length)
    ? [{ titulo: cuenta.login, bloque: cuenta.propio },
      ...cuenta.cajas.map((k) => ({ titulo: k.login, bloque: k }))]
    : [{ titulo: alcance === 'caja' ? b.login : cuenta.login, bloque: b }];

  const secciones = partes.map((p) => {
    const porDivisa = proyectar(p.bloque);
    const s = { titulo: p.titulo, porDivisa,
      ggr_usd: porDivisa.reduce((a, d) => money.add(a, d.ggr_usd || '0'), '0'),
      usdt_cliente: p.bloque.usdt_cliente };
    if (!esCliente) { s.usdt_proveedor = p.bloque.usdt_proveedor; s.usdt_empresa = p.bloque.usdt_empresa; }
    return s;
  });

  const doc = {
    ok: true, mes, vista, alcance,
    cuenta: cuenta.login,
    caja: alcance === 'caja' ? b.login : null,
    secciones,
    // El total sólo se puede dar en dólares: sumar GGR de monedas distintas no significa nada.
    ggr_usd: secciones.reduce((a, s) => money.add(a, s.ggr_usd), '0'),
    usdt_cliente: b.usdt_cliente,
  };
  if (!esCliente) {
    doc.usdt_proveedor = b.usdt_proveedor;
    doc.usdt_empresa = b.usdt_empresa;
    doc.sinVerificar = b.sinVerificar || 0;
    // Las tres vistas de un cliente con caja, para poder conciliarlas de un vistazo.
    if (cuenta.cajas && cuenta.cajas.length) {
      doc.desglose = {
        propio: { usdt_cliente: cuenta.propio.usdt_cliente, usdt_empresa: cuenta.propio.usdt_empresa },
        cajas: cuenta.cajas.map((k) => ({ cliente_id: k.cliente_id, login: k.login,
          usdt_cliente: k.usdt_cliente, usdt_empresa: k.usdt_empresa })),
        total: { usdt_cliente: cuenta.total.usdt_cliente, usdt_empresa: cuenta.total.usdt_empresa },
      };
    }
  }
  return doc;
}

module.exports = { documento, LINEA_CLIENTE, DIVISA_CLIENTE };
