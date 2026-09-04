/**
 * movimientos-store.js — el LIBRO MAYOR (sección 7, tabla MOVIMIENTOS).
 * Toda plata que entra/sale o se cobra es un movimiento. La cuenta corriente y los reportes
 * se derivan de acá (no hay tabla de "saldo" — es una vista sobre movimientos; ver deuda.service).
 *
 * tipo: carga | pago | proveedor_extra | ajuste | correccion | bonificacion
 * Cada movimiento guarda el tc_momento y el base_pct_aplicado (snapshot) → reproducible.
 */
const crypto = require('crypto');
const { db } = require('./db');
const { nowISO } = require('./lib/fechas');
const valuacion = require('./valuacion');

const TIPOS = ['carga', 'pago', 'proveedor_extra', 'ajuste', 'correccion', 'bonificacion'];
const newId = () => 'mov_' + crypto.randomBytes(6).toString('hex');
const S = (x) => (x === null || x === undefined ? null : String(x));

const _vacio = (x) => x === null || x === undefined || String(x).trim() === '';

function create(d) {
  if (!TIPOS.includes(d.tipo)) throw new Error(`tipo de movimiento inválido: ${d.tipo}`);
  /* ⚠️ UNA CARGA SIN NINGÚN IMPORTE NO SE GUARDA.
     Pasaba con una cuenta en dólares y una carga en una moneda que no es el peso ni el dólar
     cuando no había tipo de cambio para esa moneda: las dos columnas quedaban en null. El
     movimiento existía, sumaba cero, y la cuenta corriente cerraba perfecta con esa comisión
     regalada. Quien lo arregla de verdad es deuda-carga.service (no llega hasta acá); esto es el
     respaldo, para que ningún camino nuevo lo vuelva a meter en silencio.
     Sólo se exige para 'carga': un ajuste o una corrección en cero son válidos. */
  if (d.tipo === 'carga' && _vacio(d.monto_ars) && _vacio(d.monto_usdt)) {
    throw new Error('una carga no se puede guardar sin importe en ninguna de las dos monedas'
      + (d.divisa ? ` (divisa ${d.divisa})` : ''));
  }
  const id = newId();
  // MAX+1, no COUNT: con un borrado de por medio el COUNT repite el mismo `ord`.
  const ord = db.prepare('SELECT COALESCE(MAX(ord), -1) + 1 AS n FROM movimientos').get().n;
  db.prepare(`INSERT INTO movimientos
    (id,cliente_id,panel_id,proveedor_id,pedido_id,tipo,monto_ars,monto_usdt,tc_momento,base_pct_aplicado,divisa,fecha,usuario_id,notas,createdAt,ord,origen,origen_ref,medio,tc_modo,mes_cierre)
    VALUES (@id,@cli,@pan,@prov,@ped,@tipo,@mars,@musdt,@tc,@base,@div,@fecha,@uid,@notas,@ca,@ord,@origen,@oref,@medio,@tcmodo,@mescierre)`).run({
    id, cli: d.cliente_id || null, pan: d.panel_id || null, prov: d.proveedor_id || null, ped: d.pedido_id || null,
    tipo: d.tipo, mars: S(d.monto_ars), musdt: S(d.monto_usdt), tc: S(d.tc_momento), base: S(d.base_pct_aplicado),
    div: d.divisa || 'ARS', fecha: d.fecha || nowISO(), uid: d.usuario_id || null, notas: d.notas || '', ca: nowISO(), ord,
    // `origen` marca que lo generó una emisión mensual y es lo que impide cobrarlo dos veces.
    // Solo lo pone emision.service: desde la ruta de alta manual llega siempre vacío.
    origen: d.origen || null, oref: d.origen_ref || null,
    medio: d.medio || null,   // por dónde entró el pago: cvu | usdt | efectivo | …
    // A qué mes entra. Vacío = el de la fecha; se guarda sólo cuando alguien decidió otra cosa.
    mescierre: d.mes_cierre ? String(d.mes_cierre).slice(0, 7) : null,
    // 'mes' = la cara que falta se deriva del TC del mes al leer, no se congela acá.
    tcmodo: d.tc_modo === 'mes' ? 'mes' : null,
  });
  // Devuelve lo que se GUARDÓ, sin derivar: quien acaba de escribir tiene que ver su escritura.
  return getCrudo(id);
}

/**
 * ── LO QUE SE LEE VIENE VALUADO ──────────────────────────────────────────────────────────────
 * Un pago con `tc_modo='mes'` guarda una sola cara: la otra se deriva del tipo de cambio del mes
 * (ver src/valuacion.js). Esa derivación se hace ACÁ, en la lectura, y no en cada pantalla.
 *
 * La primera versión la hacía sólo en la cuenta corriente, y el resultado fue que el saldo bajaba
 * bien pero la factura del cliente listaba el pago en "0,00", el historial por mes daba cero y el
 * aviso de Telegram mandaba los pesos rotulados como dólares. Cada lector nuevo era otra chance de
 * olvidarse. Poniéndolo en el store, olvidarse deja de ser posible.
 *
 * Es seguro porque nadie ACTUALIZA un movimiento: se insertan y se borran, nunca se modifican. Si
 * algún día hiciera falta escribir uno, hay que leerlo con `getCrudo` — el valor derivado no se
 * guarda nunca, porque el día que cambie el TC del mes tiene que cambiar con él.
 */
function get(id) { return valuacion.valuar(getCrudo(id)); }
function getCrudo(id) { return db.prepare('SELECT * FROM movimientos WHERE id=?').get(id) || null; }

function list(filters = {}) {
  const w = [], p = [];
  if (filters.cliente_id) { w.push('cliente_id=?'); p.push(filters.cliente_id); }
  if (filters.panel_id) { w.push('panel_id=?'); p.push(filters.panel_id); }
  if (filters.tipo) { w.push('tipo=?'); p.push(filters.tipo); }
  if (filters.mes) { w.push('substr(fecha,1,7)=?'); p.push(filters.mes); }
  const sql = 'SELECT * FROM movimientos' + (w.length ? ' WHERE ' + w.join(' AND ') : '') + ' ORDER BY fecha DESC';
  return valuacion.valuarLista(db.prepare(sql).all(...p));
}

function remove(id) { return db.prepare('DELETE FROM movimientos WHERE id=?').run(id).changes > 0; }

/* A QUÉ MES pertenece un movimiento. Vive acá y no en cada pantalla: si la cuenta corriente lo
   decidiera distinto que la factura, el mismo pago aparecería en dos meses según dónde se mire. */
function mesDe(mv) {
  if (mv && mv.mes_cierre) return String(mv.mes_cierre).slice(0, 7);
  return String((mv && (mv.fecha || mv.createdAt)) || '').slice(0, 7);
}

module.exports = { TIPOS, create, get, getCrudo, list, remove, mesDe };
