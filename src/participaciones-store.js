/**
 * participaciones-store.js — el ALMACÉN del reparto: quién cobra cuánto de cada cliente.
 *
 * Guarda filas (cliente/panel → participante → %) con vigencia. La REGLA DE NEGOCIO de contra
 * qué tiene que cerrar la suma vive en `reparto.service.js`, que es quien sabe el % base del
 * cliente; acá solo se valida contra el total que ese servicio pida (`opts.esperado`).
 *
 * ⚠️ Desde el reparto de un solo paso (§12), `porcentaje` son PUNTOS ABSOLUTOS sobre la venta
 * y suman el % BASE del cliente — ya no son una porción del profit LATAM que sumaba 100.
 *
 * Scope: por CLIENTE (panel_id=null) o por PANEL (override). Regla de herencia: si el panel
 * no tiene reparto propio vigente → usa el del cliente.
 * Versionado: setReparto cierra el reparto vigente del scope e inserta el nuevo (vigencia).
 */
const crypto = require('crypto');
const { db } = require('./db');
const money = require('./lib/money');
const { fechaTZ, nowISO } = require('./lib/fechas');
const { diaAnterior, logCambio } = require('./historial');

const newId = () => 'part_' + crypto.randomBytes(5).toString('hex');

/** Reparto vigente de un scope en una fecha. panel_id=null = nivel cliente. */
function listVigente(cliente_id, panel_id = null, fecha = fechaTZ()) {
  return db.prepare(`
    SELECT * FROM participaciones
    WHERE cliente_id=? AND ${panel_id ? 'panel_id=?' : 'panel_id IS NULL'}
      AND vigente_desde <= ? AND (vigente_hasta IS NULL OR vigente_hasta >= ?)
    ORDER BY createdAt ASC
  `).all(...(panel_id ? [cliente_id, panel_id, fecha, fecha] : [cliente_id, fecha, fecha]));
}

/**
 * Reparto EFECTIVO de un panel (herencia): si el panel tiene reparto propio vigente lo usa;
 * si no, cae al del cliente. Devuelve { scope:'panel'|'cliente', items:[...] }.
 */
function repartoEfectivo(cliente_id, panel_id, fecha = fechaTZ()) {
  if (panel_id) {
    const propio = listVigente(cliente_id, panel_id, fecha);
    if (propio.length) return { scope: 'panel', items: propio };
  }
  return { scope: 'cliente', items: listVigente(cliente_id, null, fecha) };
}

/**
 * Valida que una lista [{persona_id, porcentaje}] sume lo esperado.
 *
 * Con el reparto de un solo paso (§12) lo esperado es el **% BASE del cliente**, no 100: las
 * filas son puntos absolutos sobre la venta (Pistacho 10% = 6+1+1,5+1,5), no porciones de un
 * pedazo previo. El default sigue en 100 por si alguien llama sin decir contra qué cerrar.
 */
function validarSuma(items, esperado = '100') {
  const total = money.sum((items || []).map((i) => i.porcentaje));
  return { ok: money.cmp(total, String(esperado)) === 0, total, esperado: String(esperado) };
}

/** Historial de repartos de un scope (todas las versiones). */
function listHistorial(cliente_id, panel_id = null) {
  return db.prepare(`
    SELECT * FROM participaciones
    WHERE cliente_id=? AND ${panel_id ? 'panel_id=?' : 'panel_id IS NULL'}
    ORDER BY vigente_desde ASC, createdAt ASC
  `).all(...(panel_id ? [cliente_id, panel_id] : [cliente_id]));
}

/**
 * Setea el reparto de un scope (cliente o panel) con VIGENCIA.
 * items: [{persona_id, porcentaje}]. Valida 100% o tira error.
 */
const setReparto = db.transaction((cliente_id, panel_id, items, vigente_desde, opts = {}) => {
  const esperado = opts.esperado != null ? String(opts.esperado) : '100';
  const v = validarSuma(items, esperado);
  if (!v.ok) {
    throw new Error(esperado === '100'
      ? `Las participaciones deben sumar 100% (suman ${v.total}%)`
      : `El reparto debe sumar el % base del cliente: ${esperado}% (suma ${v.total}%)`);
  }
  const desde = vigente_desde || fechaTZ();
  const hasta = diaAnterior(desde);
  const donde = panel_id ? 'panel_id=?' : 'panel_id IS NULL';
  const args = panel_id ? [cliente_id, panel_id] : [cliente_id];

  /* ⚠️ "Desde esta fecha rige ESTE reparto" — y eso obliga a mirar TODAS las vigencias, no solo
     las abiertas.

     Antes se cerraban únicamente las que tenían `vigente_hasta IS NULL`. Alcanzaba mientras cada
     reparto nuevo empezara después del anterior, pero al cargar uno con fecha ANTERIOR a una
     vigencia ya cerrada, esa vieja quedaba viva y se superponía con la nueva: el mes devolvía
     los dos repartos juntos y la Empresa aparecía dos veces. Pasó de verdad al fusionar a Henry
     con la Empresa desde julio — Karen-Fede quedó con "Empresa 8 · Henry 3,5 · Alexa 3,5 ·
     Empresa 11,5 · Alexa 3,5" y el reparto sumaba más que la base del cliente.

     Un reparto no se "suma" al anterior: lo reemplaza de esa fecha en adelante. */
  const superadas = db.prepare(`SELECT id FROM participaciones
    WHERE cliente_id=? AND ${donde} AND vigente_desde >= ?`).all(...args, desde);
  superadas.forEach((r) => db.prepare('DELETE FROM participaciones WHERE id=?').run(r.id));

  const vigentes = db.prepare(`SELECT id FROM participaciones
    WHERE cliente_id=? AND ${donde} AND vigente_desde < ?
      AND (vigente_hasta IS NULL OR vigente_hasta >= ?)`).all(...args, desde, desde);
  vigentes.forEach((r) => db.prepare('UPDATE participaciones SET vigente_hasta=? WHERE id=?').run(hasta, r.id));
  // insertar las nuevas
  const ins = db.prepare(`INSERT INTO participaciones
    (id,cliente_id,panel_id,persona_id,porcentaje,vigente_desde,vigente_hasta,createdAt)
    VALUES (?,?,?,?,?,?,NULL,?)`);
  items.forEach((it) => ins.run(newId(), cliente_id, panel_id || null, it.persona_id, money.round(it.porcentaje, 4), desde, nowISO()));
  logCambio({
    entidad_tipo: 'participacion', entidad_id: panel_id || cliente_id, campo: 'reparto',
    valor_anterior: JSON.stringify(vigentes.map((x) => x.id)), valor_nuevo: JSON.stringify(items),
    tipo_cambio: 'vigencia', vigente_desde: desde, usuario_id: opts.usuario_id, notas: opts.notas,
  });
  return repartoEfectivo(cliente_id, panel_id, desde);
});

module.exports = { listVigente, repartoEfectivo, validarSuma, listHistorial, setReparto };
