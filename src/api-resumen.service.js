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

/** El nombre con el que el dueño lo llama, si lo cargó; si no, el login del panel. */
function comoLoLlama(c) {
  return (Array.isArray(c.alias) && c.alias.length ? c.alias[0] : '') || c.login;
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
      es_caja: false, de: null,
      total: propio.usdt_cliente, proveedor: propio.usdt_proveedor, empresa: propio.usdt_empresa,
      entra: !(String(c.cliente_id) in excl),
      motivo: excl[String(c.cliente_id)] || '',
    });
    (c.cajas || []).forEach((k) => filas.push({
      clave: String(k.cliente_id), titulo: comoLoLlama(k), login: k.login,
      es_caja: true, de: comoLoLlama(c),
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

module.exports = { resumen, comoLoLlama };
