/**
 * deuda-carga.service.js — CADA CARGA SUMA SU DEUDA, EN EL MOMENTO.
 *
 * Hasta acá la deuda de fichas nacía una sola vez por mes, al emitir el cierre. Entre carga y carga
 * la cuenta del cliente no se movía, así que no había forma de decirle cuánto debía al acreditarle
 * las fichas — que es justo lo que se le quiere decir.
 *
 * Ahora cada carga cargada genera su movimiento: `monto × su % base`, en la divisa de la carga.
 *
 * ── EL TIPO DE CAMBIO SE CONGELA ACÁ, Y SÓLO PARA ALGUNOS ────────────────────────────────────
 *
 * Un cliente con la cuenta en USDT necesita saber cuántos dólares suma esa carga, y eso depende
 * del cambio. Se toma el del momento y se GUARDA en el movimiento — la palabra de la dueña: "ese
 * momento se hace un snap, se ve que el tipo de cambio es 1670, se divide 1.000.000 entre 1670 y
 * eso es lo que se suma en USDT".
 *
 * Un cliente con la cuenta en ARS no necesita nada de eso: su deuda ES el monto en pesos. No se
 * convierte, no se congela ningún TC, no hay nada que pueda quedar viejo. Por eso esto NO aplica a
 * todos: aplica a los que se les lleva la cuenta en dólares.
 *
 * ── POR QUÉ CONGELAR Y NO PROMEDIAR AL FIN DE MES ───────────────────────────────────────────
 *
 * En julio el peso se movió 2,6% dentro del mes (1.559 → 1.598,85). Con un TC único, dos clientes
 * que cargaron lo mismo pagan distinto según el día en que lo hicieron, y ninguno de los dos
 * eligió ese día por eso. Congelando, cada operación se cotiza cuando ocurre.
 *
 * Y hay una consecuencia mejor: el cierre del mes pasa a ser LA SUMA DE LAS CARGAS. Antes había dos
 * cálculos que tenían que coincidir; ahora hay uno solo, y la pregunta "¿por qué no cuadran?" no
 * existe porque no hay dos números.
 *
 * ── SI NO HAY TC, NO SE INVENTA ─────────────────────────────────────────────────────────────
 *
 * Si la fuente no contesta, la carga se registra en su divisa SIN la cara en dólares y queda
 * marcada. Congelar con una cotización de hace tres días es peor que no congelar: se ve igual de
 * bien y está mal, y nadie va a volver a mirarla.
 */
const movs = require('./movimientos-store');
const clientes = require('./clientes-store');
const money = require('./lib/money');
const tcSvc = require('./tc.service');
const historial = require('./historial');

/** El % base vigente de un cliente. Es lo que convierte una carga en deuda. */
function baseDe(cli) {
  const h = historial.getVigente('cliente', cli.id, 'precio_base_pct');
  const v = h != null && h !== '' ? h : cli.precio_base_pct;
  return v != null && v !== '' ? String(v) : null;
}

/**
 * Genera el movimiento de deuda de una carga ya hecha. Idempotente por pedido: si ese pedido ya
 * generó su deuda, no se vuelve a generar.
 *
 * @param pedido  el pedido en estado 'cargado' — necesita codigo, monto, divisa e id
 * @returns { ok, movimiento?, motivo? }  `motivo` explica por qué NO se generó, y eso no es un
 *          error: un cliente sin base cargada o una carga en cero no generan deuda.
 */
async function porCarga(pedido) {
  if (!pedido || !pedido.id) return { ok: false, motivo: 'sin pedido' };
  // 🔒 Idempotente. La ruta de cargar puede reintentarse y el pedido puede pasar por acá dos veces:
  // sin esto, la misma carga sumaría la deuda dos veces y cuadraría en todas las pantallas.
  const cli = clientes.getByCodigo(pedido.codigo);
  if (!cli) return { ok: false, motivo: `el código ${pedido.codigo} no es de ningún cliente` };
  const ya = movs.list({ cliente_id: cli.id, tipo: 'carga' }).find((m) => m.pedido_id === pedido.id);
  if (ya) return { ok: true, movimiento: ya, motivo: 'ya estaba' };
  const base = baseDe(cli);
  if (base == null) return { ok: false, motivo: `${cli.nombre || cli.codigo} no tiene % base cargado` };
  if (!money.isPos(String(base))) return { ok: false, motivo: 'base en cero: no genera deuda' };

  const monto = String(pedido.monto || '0');
  if (!money.isPos(monto)) return { ok: false, motivo: 'carga en cero' };
  const divisa = String(pedido.divisa || 'ARS').toUpperCase();
  // La deuda es el % base sobre lo cargado, EN LA DIVISA DE LA CARGA. Sin conversión todavía:
  // convertir es una decisión aparte y sólo aplica a las cuentas en dólares.
  const deuda = money.round(money.pct(monto, base), 2);

  const cuentaEn = cli.moneda_cuenta === 'ARS' ? 'ARS' : 'USDT';
  let enUsdt = null; let tc = null; let aviso = null;

  if (cuentaEn === 'USDT') {
    if (divisa === 'USDT' || divisa === 'USD') {
      enUsdt = deuda;                       // ya está en dólares, no hay nada que convertir
    } else {
      const r = await tcSvc.tcAhora().catch(() => null);
      // `vivo` distingue una cotización de AHORA de la última que quedó guardada. Sólo se congela
      // con una viva: una vieja se vería igual de bien y estaría mal.
      if (r && r.vivo && money.isPos(String(r.tc))) {
        tc = String(r.tc);
        enUsdt = money.round(money.div(deuda, tc), 2);
      } else {
        aviso = 'no se pudo tomar el tipo de cambio del momento: la deuda quedó en '
          + `${divisa} y falta pasarla a dólares`;
      }
    }
  }

  const mv = movs.create({
    cliente_id: cli.id, tipo: 'carga', pedido_id: pedido.id,
    monto_ars: divisa === 'ARS' ? deuda : null,
    monto_usdt: enUsdt,
    tc_momento: tc,
    base_pct_aplicado: String(base),
    divisa,
    fecha: pedido.resueltoAt || pedido.createdAt || undefined,
    notas: `Fichas · ${base}% de ${money.fmt(monto, 0)} ${divisa}`
      + (tc ? ` · TC ${tc}` : '') + (aviso ? ` · ${aviso}` : ''),
  });
  return { ok: true, movimiento: mv, tc, aviso, deuda, divisa, base, cuentaEn };
}

/**
 * Lo que ya está en la cuenta por cargas de un mes, por cliente. Es contra esto que se concilia el
 * cierre: si la suma de las cargas ya cubre lo del mes, el cierre no tiene nada que agregar.
 */
function delMes(mes) {
  const m = String(mes || '').slice(0, 7);
  const out = {};
  movs.list({}).forEach((x) => {
    if (x.tipo !== 'carga' || !x.pedido_id) return;
    if (String(x.fecha || '').slice(0, 7) !== m) return;
    const o = out[x.cliente_id] = out[x.cliente_id] || { usdt: '0', ars: '0', cargas: 0 };
    o.usdt = money.add(o.usdt, x.monto_usdt || '0');
    o.ars = money.add(o.ars, x.monto_ars || '0');
    o.cargas += 1;
  });
  return out;
}

/**
 * Da de baja la deuda de una carga que se ANULÓ.
 *
 * Anular retira las fichas del casino: el cliente no las tiene, así que no las debe. Sin esto la
 * deuda quedaba puesta y el error era invisible — el pedido decía "anulado" y la cuenta seguía
 * cobrándolo.
 *
 * ── SE CONTRA-ASIENTA, NO SE BORRA ───────────────────────────────────────────────────────────
 * Se crea un movimiento OPUESTO en vez de borrar el original. Borrarlo dejaría una cuenta que
 * cuadra y una historia que no se puede leer: el mes que viene nadie sabría que hubo una carga y
 * una anulación. Los dos renglones cuentan lo que pasó, y su suma es cero.
 *
 * Y va con el MISMO tipo de cambio que la carga, no con el de hoy. Si se usara el de hoy, anular
 * una carga de hace una semana dejaría una diferencia de cambio en la cuenta del cliente que él
 * nunca pidió — una ganancia o una pérdida nacida de un error administrativo.
 */
function porAnulacion(pedido) {
  if (!pedido || !pedido.id) return { ok: false, motivo: 'sin pedido' };
  const cli = clientes.getByCodigo(pedido.codigo);
  if (!cli) return { ok: false, motivo: `el código ${pedido.codigo} no es de ningún cliente` };
  const orig = movs.list({ cliente_id: cli.id, tipo: 'carga' }).find((m) => m.pedido_id === pedido.id);
  if (!orig) return { ok: false, motivo: 'esa carga no había generado deuda' };
  // Idempotente igual que la carga: anular dos veces no puede acreditar dos veces.
  const yaCont = movs.list({ cliente_id: cli.id, tipo: 'correccion' })
    .find((m) => m.pedido_id === pedido.id);
  if (yaCont) return { ok: true, movimiento: yaCont, motivo: 'ya estaba dada de baja' };

  const neg = (v) => (v == null || v === '' ? null : money.round(money.mul(String(v), '-1'), 2));
  const mv = movs.create({
    cliente_id: cli.id, tipo: 'correccion', pedido_id: pedido.id,
    monto_ars: neg(orig.monto_ars), monto_usdt: neg(orig.monto_usdt),
    tc_momento: orig.tc_momento,          // el de la carga, no el de hoy
    base_pct_aplicado: orig.base_pct_aplicado, divisa: orig.divisa,
    notas: `Anulación de la carga · da de baja ${orig.id}`,
  });
  return { ok: true, movimiento: mv, dioDeBaja: orig.id };
}

module.exports = { porCarga, porAnulacion, delMes, baseDe };
