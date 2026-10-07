/**
 * api-resumen.service.js — EL CIERRE DEL MES DE API, en una hoja.
 *
 * Es el "Crypto <MES>" que el dueño armaba a mano: una fila por cliente con lo que se le cobró, lo
 * que se le pagó al proveedor y lo que quedó para la empresa, y arriba el total de todo.
 *
 * ── LA PARTE QUE NO ES OBVIA: NO TODO ENTRA ────────────────────────────────────────────────────
 *
 * El total del mes NO es la suma de todos los clientes. Hay cuentas que no se cobran — montos
 * insignificantes, un cliente nuevo que todavía no se factura, o un acuerdo puntual. En junio la
 * caja de Nacho quedó afuera por un arreglo con él, y en julio entra. Por eso:
 *
 *   1. La unidad que se elige NO es el cliente: es el cliente Y CADA CAJA por separado. Nacho puede
 *      entrar sin su caja, que es exactamente lo que pasó en junio.
 *   2. La decisión se guarda POR MES. Un resumen viejo tiene que poder volver a sacarse igual, y no
 *      cambiar el día que cambia el trato con el cliente.
 *   3. Se guardan las EXCLUSIONES, no las inclusiones: un cliente nuevo entra solo. Al revés, el
 *      que aparece en agosto quedaría afuera en silencio y eso es plata que no se cobra.
 */
const apiStore = require('./api-store');
const apiCuenta = require('./api-cuenta.service');
const money = require('./lib/money');

/**
 * Cómo se la nombra: de quién es, si está cargado; si no, el login de TBS.
 *
 * Es lo que hace que la cuenta que se le manda diga "Cuenta Raul" en vez de "Cuenta Raul-API". El
 * login sigue estando adentro del documento, sección por sección: esto es el encabezado, no la
 * identidad. Antes salía del primer `alias`, que era la lista de nombres de la planilla vieja.
 */
function comoLoLlama(c) {
  return String(c.de_quien || '').trim() || c.login;
}

/**
 * Las unidades facturables del mes, con lo que entra y lo que no.
 * @returns { ok, mes, filas[], totales, fuera[], avisos[] }
 */
function resumen({ mes } = {}) {
  const m = String(mes || '').slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(m)) return { ok: false, error: 'mes inválido (se espera YYYY-MM)' };
  const r = apiCuenta.cuentas({ mes: m });
  if (!r.ok) return r;

  const excl = {}; apiStore.fueraDelResumen(m).forEach((x) => { excl[x.clave] = x.motivo || ''; });

  const filas = [];
  (r.cuentas || []).forEach((c) => {
    const tieneCajas = !!(c.cajas && c.cajas.length);
    const propio = tieneCajas ? c.propio : c;
    filas.push({
      clave: String(c.cliente_id), titulo: comoLoLlama(c), login: c.login,
      es_caja: false, de: null, padre: null, con_cajas: tieneCajas,
      total: propio.usdt_cliente, proveedor: propio.usdt_proveedor, empresa: propio.usdt_empresa,
      entra: !(String(c.cliente_id) in excl),
      motivo: excl[String(c.cliente_id)] || '',
    });
    (c.cajas || []).forEach((k) => filas.push({
      clave: String(k.cliente_id), titulo: comoLoLlama(k), login: k.login,
      es_caja: true, de: comoLoLlama(c), padre: String(c.cliente_id), con_cajas: true,
      total: k.usdt_cliente, proveedor: k.usdt_proveedor, empresa: k.usdt_empresa,
      entra: !(String(k.cliente_id) in excl),
      motivo: excl[String(k.cliente_id)] || '',
    }));
  });

  const suma = (rs, campo) => rs.reduce((a, x) => money.add(a, x[campo]), '0');
  const dentro = filas.filter((x) => x.entra);
  const afuera = filas.filter((x) => !x.entra);

  const avisos = [...(r.avisos || [])];
  if (afuera.length) {
    avisos.push(`${afuera.length} cuenta(s) quedan FUERA del total de ${m}: `
      + afuera.map((x) => `${x.titulo} (${x.total} USDT)`).join(' · ')
      + `. Suman ${money.round(suma(afuera, 'total'), 2)} USDT que no se están cobrando.`);
  }

  return {
    ok: true, mes: m,
    // Alfabético, no por monto: el cierre se lee para buscar una cuenta, no para ver cuál es la
    // más grande. Con locale español, así la Ñ y los acentos caen donde tienen que caer.
    filas: filas.sort((a, b) => String(a.titulo).localeCompare(String(b.titulo), 'es', { sensitivity: 'base' })),
    totales: {
      cliente: money.round(suma(dentro, 'total'), 2),
      proveedor: money.round(suma(dentro, 'proveedor'), 2),
      empresa: money.round(suma(dentro, 'empresa'), 2),
    },
    // El total de TODO, para que se vea de un vistazo cuánto se está dejando afuera.
    totalesConTodo: {
      cliente: money.round(suma(filas, 'total'), 2),
      proveedor: money.round(suma(filas, 'proveedor'), 2),
      empresa: money.round(suma(filas, 'empresa'), 2),
    },
    fuera: afuera.map((x) => ({ clave: x.clave, titulo: x.titulo, total: x.total, motivo: x.motivo })),
    avisos,
  };
}

/**
 * COBROS POR MES: todas las cuentas desde un mes hasta hoy, con lo que dice la cuenta y si pagó.
 *
 * Es para auditar hacia atrás sin ir mes por mes: el monto sale del MISMO resumen que el cierre
 * —así lo que se ve acá es lo que se le mandó al cliente— y el pago es una marca a mano.
 * Si la marca se puso con otro monto (se recalculó el mes después), se avisa en la casilla.
 */
function cobros({ desde = '2026-06', hasta } = {}) {
  const d = String(desde).slice(0, 7);
  const h = String(hasta || new Date().toISOString()).slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(d) || !/^\d{4}-\d{2}$/.test(h) || d > h) return { ok: false, error: 'rango de meses inválido' };
  const meses = [];
  for (let [y, m] = d.split('-').map(Number); `${y}-${String(m).padStart(2, '0')}` <= h; m === 12 ? (y++, m = 1) : m++) {
    meses.push(`${y}-${String(m).padStart(2, '0')}`);
  }
  const marcas = apiStore.cobros(meses);
  const porClave = {}; const totales = {}; const avisos = [];
  meses.forEach((m) => {
    const r = resumen({ mes: m });
    const T = { facturado: '0', cobrado: '0', pendiente: '0', cuentas: 0, pagadas: 0 };
    if (!r.ok) { avisos.push(`${m}: ${r.error}`); totales[m] = T; return; }
    (r.filas || []).forEach((f) => {
      const fila = porClave[f.clave] = porClave[f.clave] || { clave: f.clave, titulo: f.titulo, login: f.login,
        es_caja: f.es_caja, de: f.de, padre: f.padre, meses: {} };
      // El nombre más nuevo gana: si se le cargó "de quién es" en septiembre, que junio diga lo mismo.
      Object.assign(fila, { titulo: f.titulo, de: f.de, padre: f.padre });
      const mk = (marcas[m] || {})[f.clave];
      const total = money.round(f.total, 2);
      fila.meses[m] = {
        total, entra: f.entra, motivo: f.motivo, con_cajas: f.con_cajas,
        pagado: !!mk, pagado_at: mk ? mk.at : null, pagado_monto: mk ? mk.monto : null,
        cambio: !!(mk && mk.monto != null && money.round(mk.monto, 2) !== total),
      };
      if (!f.entra || !(Number(f.total) > 0)) return;
      T.cuentas++; T.facturado = money.add(T.facturado, f.total);
      if (mk) { T.pagadas++; T.cobrado = money.add(T.cobrado, f.total); } else T.pendiente = money.add(T.pendiente, f.total);
    });
    totales[m] = { ...T, facturado: money.round(T.facturado, 2), cobrado: money.round(T.cobrado, 2), pendiente: money.round(T.pendiente, 2) };
  });
  const filas = Object.values(porClave).sort((a, b) =>
    String(a.es_caja ? a.de + ' ' + a.titulo : a.titulo).localeCompare(String(b.es_caja ? b.de + ' ' + b.titulo : b.titulo), 'es', { sensitivity: 'base' }));
  return { ok: true, meses, filas, totales, avisos };
}

module.exports = { resumen, comoLoLlama, cobros };
