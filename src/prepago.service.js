/**
 * prepago.service.js — clientes que pagan PRIMERO y piden fichas contra su saldo a favor.
 *
 * Decisiones del dueño (6-oct-2026):
 *  · Se elige por cliente (`prepago`). El resto sigue como siempre: carga y después paga.
 *  · El saldo es el de su cuenta corriente —la misma de siempre, en su moneda (USDT o ARS)—: un pago
 *    APROBADO lo sube y cada carga lo baja. No hay una cuenta aparte que pueda no cuadrar.
 *  · Puede pedir hasta su saldo a favor MÁS un margen: un % de su ÚLTIMO PAGO aprobado
 *    (`prepago_margen_pct`). Es un monto fijo hasta que vuelve a pagar —si fuera un % del saldo,
 *    se achicaría a medida que consume y el tope cambiaría solo—. Sin pagos, no pide nada.
 *  · Los pedidos pendientes RESERVAN saldo: no se puede pedir dos veces la misma plata.
 *  · Si al cargar el tipo de cambio se movió y ya no alcanza por esa diferencia, se carga igual: el
 *    pedido se validó al pedirlo, y la diferencia chica queda como deuda.
 *
 * El costo de un pedido se calcula IGUAL que la deuda que genera al cargarse (deuda-carga.service):
 * monto × % base (el del panel si tiene precio propio) y, en una cuenta en USDT, dividido por el
 * dólar cripto del momento. Es una estimación —la deuda real se congela al cargar—, y por eso el
 * margen existe.
 */
const clientes = require('./clientes-store');
const paneles = require('./paneles-store');
const pedidos = require('./pedidos-store');
const money = require('./lib/money');
const tcSvc = require('./tc.service');
const deudaSvc = require('./deuda.service');
const movs = require('./movimientos-store');
const { baseDe, tcDelDia } = require('./deuda-carga.service');

const K = (s) => String(s == null ? '' : s).trim().toLowerCase();
const n = (v) => Number(v) || 0;
const r2 = (x) => Math.round(x * 100) / 100;

function panelDe(sistema, userId) {
  return paneles.list().find((p) => K(p.sistema) === K(sistema) && String(p.id_usuario) === String(userId)) || null;
}

/** El tipo de cambio para pasar la comisión de una divisa a la moneda de la cuenta. Uno por consulta. */
async function tcPara(divisa, cacheTc = {}) {
  const d = String(divisa || 'ARS').toUpperCase();
  if (cacheTc[d] !== undefined) return cacheTc[d];
  let tc = null;
  if (d === 'USDT' || d === 'USD') tc = 1;
  else if (d === 'ARS') { const r = await tcSvc.tcAhora().catch(() => null); tc = r && n(r.tc) > 0 ? n(r.tc) : null; }
  else { const t = tcDelDia(new Date().toISOString(), d); tc = n(t) > 0 ? n(t) : null; }
  cacheTc[d] = tc;
  return tc;
}

/**
 * Lo que cuesta un pedido, en la moneda de la cuenta del cliente.
 * @returns {{costo:number, base:number, tc:number|null, cuentaEn:string}|{error:string}}
 */
async function costoDe(cli, { sistema, userId, monto, divisa }, cacheTc = {}) {
  const base = n(baseDe(cli, panelDe(sistema, userId)));
  if (!(base > 0)) return { error: 'sin_base' };
  const div = String(divisa || 'ARS').toUpperCase();
  const comision = n(monto) * base / 100;                     // en la divisa de la carga
  const cuentaEn = cli.moneda_cuenta === 'ARS' ? 'ARS' : 'USDT';
  if (cuentaEn === 'ARS') {
    if (div === 'ARS') return { costo: r2(comision), base, tc: null, cuentaEn };
    const tcDiv = await tcPara(div, cacheTc); const tcArs = await tcPara('ARS', cacheTc);
    if (!tcDiv || !tcArs) return { error: 'sin_tc' };
    return { costo: r2(comision / tcDiv * tcArs), base, tc: tcArs, cuentaEn };
  }
  const tc = await tcPara(div, cacheTc);
  if (!tc) return { error: 'sin_tc' };
  return { costo: r2(comision / tc), base, tc, cuentaEn };
}

/**
 * La foto del prepago de un cliente: saldo a favor, cuánto tienen reservado sus pedidos pendientes y
 * cuánto le queda para pedir (con el margen). Para un cliente que no es prepago devuelve {prepago:false}.
 */
async function estado(cli, cacheTc = {}) {
  if (!cli || !cli.prepago) return { prepago: false };
  const cc = deudaSvc.cuentaCorriente(cli.id);
  const moneda = cli.moneda_cuenta === 'ARS' ? 'ARS' : 'USDT';
  const saldo = -n(cc && cc.total);                          // + a favor · − debe
  const margenPct = n(cli.prepago_margen_pct);
  const col = moneda === 'ARS' ? 'monto_ars' : 'monto_usdt';
  const ultimo = movs.list({ cliente_id: cli.id, tipo: 'pago' })
    .filter((m) => n(m[col]) > 0)
    .sort((a, b) => String(b.fecha || b.createdAt || '').localeCompare(String(a.fecha || a.createdAt || '')))[0];
  const ultimoPago = ultimo ? r2(n(ultimo[col])) : 0;
  const margen = r2(ultimoPago * margenPct / 100);
  let reservado = 0;
  for (const p of pedidos.list({ estado: 'pendiente' }).filter((x) => K(x.codigo) === K(cli.codigo))) {
    // eslint-disable-next-line no-await-in-loop
    const c = await costoDe(cli, p, cacheTc);
    if (c.costo) reservado += c.costo;
  }
  reservado = r2(reservado);
  return {
    prepago: true, moneda,
    saldoAFavor: r2(Math.max(0, saldo)), debe: r2(Math.max(0, -saldo)),
    margenPct, ultimoPago, margen, reservado,
    disponible: r2(Math.max(0, saldo + margen - reservado)),
  };
}

/** Cuántas fichas (en esa divisa) se pueden pedir con lo disponible, para la cuenta de ese caja. */
async function alcanzaPara(cli, est, { sistema, userId, divisa }, cacheTc = {}) {
  if (!est || !est.prepago) return null;
  // Con un millón de referencia: con 1.000, el costo redondeado a centavos (0,06) inflaba el
  // resultado un 4% —decía que alcanzaba para 1.000.000 cuando eran 960.000—.
  const ref = 1000000;
  const uno = await costoDe(cli, { sistema, userId, monto: ref, divisa }, cacheTc);
  if (!uno.costo) return null;
  return Math.floor((est.disponible / uno.costo) * ref);
}

/**
 * ¿Puede pedir esto? Para los que NO son prepago contesta siempre que sí (no cambia nada).
 * @param items [{sistema,userId,monto,divisa}] — uno o varios pedidos juntos (distribuidor)
 * @returns {{ok:true, estado?}|{ok:false, motivo:'sin_saldo'|'sin_base'|'sin_tc', estado, costo, alcanza}}
 */
async function puedePedir(cli, items) {
  if (!cli || !cli.prepago) return { ok: true };
  const cacheTc = {};
  const est = await estado(cli, cacheTc);
  let costo = 0;
  for (const it of items) {
    // eslint-disable-next-line no-await-in-loop
    const c = await costoDe(cli, it, cacheTc);
    if (c.error) return { ok: false, motivo: c.error, estado: est };
    costo += c.costo;
  }
  costo = r2(costo);
  if (costo <= est.disponible + 0.005) return { ok: true, estado: est, costo };
  const alcanza = items.length === 1 ? await alcanzaPara(cli, est, items[0], cacheTc) : null;
  return { ok: false, motivo: 'sin_saldo', estado: est, costo, alcanza };
}

module.exports = { estado, costoDe, puedePedir, alcanzaPara };
