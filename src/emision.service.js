/**
 * emision.service.js — PASAR LO FACTURADO A LA DEUDA DEL CLIENTE, sin poder duplicarlo.
 *
 * Hasta acá la deuda solo se movía a mano: Facturación y Proveedores externos calculaban un número
 * y alguien lo tenía que copiar a Movimientos. Ahora se emite de una.
 *
 * LO QUE NO PUEDE PASAR: que emitir dos veces cobre dos veces. Este negocio ya tuvo cargas
 * acreditadas por duplicado y referidos pagados 163 veces por falta de idempotencia. Así que:
 *
 *   · cada movimiento emitido lleva `origen` ('facturacion' | 'externos') y `origen_ref` (el mes),
 *   · hay un índice ÚNICO sobre (cliente, origen, origen_ref) — la base lo rechaza, no el código,
 *   · volver a emitir el mismo mes no agrega nada: informa cuántos ya estaban.
 *
 * Y ES REVERSIBLE: `anular(mes, origen)` borra SOLO lo que generó esa emisión. Si cambió un %, un
 * tipo de cambio o entraron pedidos nuevos, se anula y se emite otra vez. No hay "actualizar en el
 * lugar" a propósito: dejar rastro de qué se emitió y cuándo vale más que un número que se mueve solo.
 *
 * NO se emite sobre un mes ya congelado sin decirlo, y NO se emite un importe en cero.
 */
const { db } = require('./db');
const movs = require('./movimientos-store');
const money = require('./lib/money');

/*
 * 'vendedores' va aparte de 'externos' aunque los dos terminen en un movimiento `proveedor_extra`:
 * son cuentas distintas y se emiten por separado. El cliente paga el DIFERENCIAL (su celda menos
 * su % base); el vendedor paga el COSTO REAL del proveedor, sin base. Tener dos orígenes distintos
 * es además lo que hace que el índice único los trate por separado: un mismo nombre no puede
 * quedar cobrado dos veces por el mismo concepto, pero sí puede tener las dos cuentas.
 */
const ORIGENES = { facturacion: 'carga', externos: 'proveedor_extra', vendedores: 'proveedor_extra' };

const nowISO = () => new Date().toISOString();

/** Qué se emitió ya para un mes. */
function emitido(mes, origen = null) {
  const m = String(mes || '').slice(0, 7);
  const filas = origen
    ? db.prepare('SELECT * FROM movimientos WHERE origen=? AND origen_ref=?').all(String(origen), m)
    : db.prepare('SELECT * FROM movimientos WHERE origen IS NOT NULL AND origen_ref=?').all(m);
  const porOrigen = {};
  for (const f of filas) {
    const o = porOrigen[f.origen] = porOrigen[f.origen] || { cantidad: 0, total: '0', desde: null };
    o.cantidad += 1;
    o.total = money.add(o.total, f.monto_usdt || '0');
    if (!o.desde || String(f.createdAt) < o.desde) o.desde = f.createdAt;
  }
  Object.values(porOrigen).forEach((o) => { o.total = money.round(o.total, 2); });
  return { mes: m, cantidad: filas.length, porOrigen };
}

/**
 * Emite. `lineas` = [{ cliente_id, monto_usdt, base_pct, notas }].
 * Devuelve qué se creó y qué ya estaba, sin tocar lo que ya estaba.
 */
function emitir({ mes, origen, lineas, fecha = null }) {
  const m = String(mes || '').slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(m)) return { ok: false, error: 'mes inválido (se espera YYYY-MM)' };
  const tipo = ORIGENES[origen];
  if (!tipo) return { ok: false, error: `origen inválido: ${origen}` };

  const creados = []; const yaEstaban = []; const enCero = [];
  const tx = db.transaction(() => {
    for (const l of lineas || []) {
      if (!l.cliente_id) continue;
      // Un importe en cero no se emite: ensuciaría la cuenta corriente sin decir nada.
      if (!money.isPos(l.monto_usdt)) { enCero.push(l.cliente_id); continue; }
      const ya = db.prepare('SELECT id FROM movimientos WHERE cliente_id=? AND origen=? AND origen_ref=?')
        .get(String(l.cliente_id), String(origen), m);
      if (ya) { yaEstaban.push({ cliente_id: l.cliente_id, movimiento_id: ya.id }); continue; }
      const mv = movs.create({
        cliente_id: l.cliente_id, tipo,
        monto_usdt: String(l.monto_usdt),
        base_pct_aplicado: l.base_pct != null ? String(l.base_pct) : null,
        // la fecha cae DENTRO del mes emitido, no el día que se apretó el botón: si no, emitir
        // junio en agosto lo dejaría contado en agosto (`movs.list({mes})` filtra por la fecha).
        fecha: fecha || `${m}-${String(new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0)).getUTCDate()).padStart(2, '0')}T23:59:00.000Z`,
        notas: l.notas || `${origen} ${m}`,
        divisa: 'USDT',
        origen, origen_ref: m,
      });
      creados.push({ cliente_id: l.cliente_id, movimiento_id: mv.id, monto_usdt: mv.monto_usdt });
    }
  });
  try { tx(); } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }

  return {
    ok: true, mes: m, origen, tipo,
    creados: creados.length, yaEstaban: yaEstaban.length, enCero: enCero.length,
    total: money.round(money.sum(creados.map((c) => c.monto_usdt)), 2),
    detalle: { creados, yaEstaban },
  };
}

/** Deshace una emisión: borra SOLO lo que generó, nada cargado a mano. */
function anular({ mes, origen }) {
  const m = String(mes || '').slice(0, 7);
  if (!ORIGENES[origen]) return { ok: false, error: `origen inválido: ${origen}` };
  const antes = db.prepare('SELECT COUNT(*) c, COALESCE(SUM(CAST(monto_usdt AS REAL)),0) t FROM movimientos WHERE origen=? AND origen_ref=?')
    .get(String(origen), m);
  db.prepare('DELETE FROM movimientos WHERE origen=? AND origen_ref=?').run(String(origen), m);
  return { ok: true, mes: m, origen, borrados: antes.c, total: money.round(String(antes.t), 2) };
}

module.exports = { emitir, anular, emitido, ORIGENES };
