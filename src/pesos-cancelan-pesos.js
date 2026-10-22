/**
 * pesos-cancelan-pesos.js — UN PAGO EN PESOS SALDA LAS CARGAS EN PESOS, A LO QUE VALIERON.
 *
 * Fran cargó 5.000.000 ARS al 12%: 600.000 pesos de comisión, que el día de la carga, con el dólar
 * cripto a 1.584,99, quedaron en 378,55 USDT. Pagó esos 600.000 pesos y el pago se pasó a dólares
 * con el cambio del trader del cierre (1.679,88): 357,17. En pesos no debía nada; en dólares le
 * quedaban 21,38 por cada carga. Medido el 13-oct-2026: 163,63 USDT de Fran y ~210 entre todos.
 *
 * Decisión del dueño (13-oct-2026): «los pesos cancelan pesos», desde agosto, y la diferencia de
 * cambio la absorbe la empresa.
 *
 * ── CÓMO ─────────────────────────────────────────────────────────────────────────────────────
 * Las cargas con cara en pesos forman una fila, de la más vieja a la más nueva, cada una con sus
 * pesos y lo que valieron en dólares. Un pago en pesos va saldando esa fila en orden y vale, en
 * dólares, lo que valían los pesos que saldó. Si paga más pesos de los que hay en la fila, el
 * sobrante se pasa con el cambio del propio pago, como antes.
 *
 * · Sólo cuentas llevadas en USDT: en una cuenta en pesos la deuda ya ES en pesos.
 * · Sólo pagos EN PESOS: un pago en dólares no toca la fila.
 * · Una anulación (o un ajuste o bonificación en menos) saca pesos de la fila: si es de una carga
 *   concreta (mismo pedido) se lleva esa; si no, los toma de la más vieja.
 * · Desde AGOSTO 2026: los meses anteriores quedan como se cerraron.
 *
 * ── LO QUE ENTRÓ DE VERDAD NO SE PIERDE ──────────────────────────────────────────────────────
 * El pago vale para la DEUDA lo que saldó, pero el trader entregó lo que entregó. Las dos cifras
 * viajan: `monto_usdt` (lo que baja la deuda) y `usdt_recibido` (lo que entró). La diferencia,
 * `dif_cambio`, es lo que pone la empresa. El reparto de lo cobrado reparte lo que ENTRÓ.
 *
 * Se calcula al LEER, como la valuación con el TC del mes, y nunca se guarda: el día que se anula
 * una carga o se corrige un pago, el reparto de los pesos cambia con él.
 */
const money = require('./lib/money');

const DESDE = '2026-08';
const lleno = (v) => v != null && String(v) !== '';

const { mesDe } = require('./lib/mes-de');

/** ¿Es un pago hecho en pesos? La cara en dólares se derivó de los pesos, o entró por CVU/efectivo. */
function esPagoEnPesos(m) {
  if (!m || m.tipo !== 'pago' || !lleno(m.monto_ars) || !money.isPos(String(m.monto_ars))) return false;
  if (m.derivada === 'monto_usdt') return true;
  return m.medio === 'cvu' || m.medio === 'efectivo';
}

/** Una carga (o lo que mueve pesos de la fila): tiene las dos caras guardadas. */
const conDosCaras = (m) => lleno(m.monto_ars) && lleno(m.monto_usdt);

/**
 * @param movs  TODOS los movimientos de UN cliente, ya valuados (movimientos-store.list)
 * @returns Map pagoId → { aplicado, recibido, dif, saldado_ars }
 */
function aplicar(movs) {
  const out = new Map();
  const orden = (movs || []).slice().sort((a, b) =>
    String(a.fecha || '').localeCompare(String(b.fecha || '')) || (Number(a.ord) || 0) - (Number(b.ord) || 0));
  const fila = [];   // { ars, usd, pedido_id }
  /* Lo que se saca de una carga se redondea al centavo, y si se la lleva entera se lleva sus
     dólares exactos. Así una cuenta saldada da CERO, no -0,01. */
  const tomar = (l, ars) => {
    const t = money.cmp(l.ars, ars) <= 0 ? l.ars : ars;
    const u = money.cmp(t, l.ars) === 0 ? l.usd : money.round(money.div(money.mul(l.usd, t), l.ars), 2);
    l.ars = money.sub(l.ars, t); l.usd = money.sub(l.usd, u);
    return { t, u };
  };
  /* Una anulación o una bonificación saca SUS pesos y SUS dólares (los que dice ese movimiento),
     no una proporción: si no, la fila y la deuda se separan por centavos. */
  const sacar = (ars, usd, pedidoId) => {
    let resta = ars; let restaUsd = usd;
    const lotes = fila.filter((l) => money.isPos(l.ars));
    const primero = pedidoId ? lotes.find((l) => l.pedido_id === pedidoId) : null;
    for (const l of (primero ? [primero, ...lotes.filter((x) => x !== primero)] : lotes)) {
      if (!money.isPos(resta)) break;
      const t = money.cmp(l.ars, resta) <= 0 ? l.ars : resta;
      const ultimo = money.cmp(t, resta) === 0;
      const u = ultimo ? restaUsd : money.round(money.div(money.mul(usd, t), ars), 2);
      l.ars = money.sub(l.ars, t); l.usd = money.sub(l.usd, u);
      resta = money.sub(resta, t); restaUsd = money.sub(restaUsd, u);
    }
  };
  for (const m of orden) {
    if (mesDe(m) < DESDE) continue;
    if (m.tipo === 'pago') {
      if (!esPagoEnPesos(m) || !lleno(m.monto_usdt)) continue;
      let ars = String(m.monto_ars); let usd = '0';
      for (const l of fila) {
        if (!money.isPos(ars)) break;
        if (!money.isPos(l.ars)) continue;
        const { t, u } = tomar(l, ars);
        usd = money.add(usd, u);
        ars = money.sub(ars, t);
      }
      const saldado = money.sub(String(m.monto_ars), ars);
      if (!money.isPos(saldado)) continue;           // no había pesos que saldar: queda como estaba
      // El sobrante, con el cambio del propio pago.
      if (money.isPos(ars)) usd = money.add(usd, money.div(money.mul(String(m.monto_usdt), ars), String(m.monto_ars)));
      const aplicado = money.round(usd, 2);
      out.set(m.id, { aplicado, recibido: String(m.monto_usdt), dif: money.round(money.sub(aplicado, String(m.monto_usdt)), 2),
        saldado_ars: money.round(saldado, 2) });
      continue;
    }
    if (!['carga', 'ajuste', 'correccion', 'bonificacion'].includes(m.tipo) || !conDosCaras(m)) continue;
    // Suma a la fila lo que SUBE la deuda en pesos. Lo que la baja (una anulación, un ajuste en
    // menos, una bonificación, que se guarda en positivo) saca pesos de la fila.
    const ars = String(m.monto_ars);
    if (m.tipo !== 'bonificacion' && money.isPos(ars)) fila.push({ ars, usd: String(m.monto_usdt), pedido_id: m.pedido_id || null });
    else {
      const abs = (v) => (money.isNeg(v) ? money.mul(v, '-1') : v);
      const cuanto = abs(ars);
      if (money.isPos(cuanto)) sacar(cuanto, abs(String(m.monto_usdt)), m.pedido_id || null);
    }
  }
  return out;
}

module.exports = { aplicar, esPagoEnPesos, DESDE };
