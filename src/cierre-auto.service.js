/**
 * cierre-auto.service.js — lo que el cierre del mes hace SOLO, apenas está la foto (26-oct-2026).
 *
 * Con la foto completa ya se tiene todo para dos cosas que antes había que acordarse de apretar:
 *   1. el CONTRASTE contra los paneles (lo que se le va a cobrar a cada cliente contra lo que
 *      registró el casino), y
 *   2. el CÁLCULO del pago a proveedores (la ganancia de cada proveedor, que el casino tarda en dar).
 * Las dos le preguntan al casino y tardan minutos, así que corren en segundo plano después de que la
 * foto contesta. No escriben deuda ni mandan nada: dejan los números listos para mirar.
 *
 * Nada de esto puede tirar el OS: todo va en try, y lo que pasó queda anotado en `estado(mes)` para
 * que la pantalla del cierre lo diga (corriendo, listo a tal hora, o qué falló).
 */
const crucePanel = require('./cruce-panel.service');
const pagoProv = require('./pago-proveedores.service');
const casinoConex = require('./casino-conexiones-store');
const paneles = require('./paneles-store');

const _estado = {};                            // mes → { corriendo, desde, contraste, pago }

function estado(mes) { return _estado[String(mes || '').slice(0, 7)] || null; }

/* El pago se precarga por conexión y en tandas, igual que la pantalla de pago: sólo las conexiones
   activas que tienen paneles (Europa_Fichas agrupa por distribuidor y haría saltar el candado). */
async function _precargarPago(mes) {
  const cxs = casinoConex.list().filter((c) => c.activa !== false && paneles.list().some((p) => p.conexion_id === c.id));
  const avisos = [];
  for (const cx of cxs) {
    let desde = 0;
    for (let vuelta = 0; vuelta < 20; vuelta++) {
      const r = await pagoProv.precargar({ mes, conexion_id: cx.id, desde, limite: 12 });
      if (!r.ok) { avisos.push(`${cx.nombre}: ${r.error || 'no respondió'}`); break; }
      if (!r.faltan) break;
      desde = r.hechos;
    }
  }
  return avisos;
}

/**
 * Corre el contraste y el cálculo del pago para un mes. Si ya está corriendo para ese mes, no
 * arranca otro: la foto se saca en tandas y cada tanda avisa, pero el trabajo es uno.
 */
async function trasLaFoto(mes) {
  const m = String(mes || '').slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(m)) return;
  if (_estado[m] && _estado[m].corriendo) return;
  const e = _estado[m] = { corriendo: true, desde: new Date().toISOString(), contraste: null, pago: null };
  try {
    try {
      const v = await crucePanel.cruzarMes(m);
      if (v && v.ok) { crucePanel.guardar(v); e.contraste = { ok: true, at: new Date().toISOString(), conDiferencias: Number(v.clientesConDiferencias || 0) }; }
      else e.contraste = { ok: false, error: (v && v.error) || 'no respondió' };
    } catch (err) { e.contraste = { ok: false, error: String((err && err.message) || err) }; }
    try {
      const avisos = await _precargarPago(m);
      e.pago = avisos.length ? { ok: false, error: avisos.join(' · ') } : { ok: true, at: new Date().toISOString() };
    } catch (err) { e.pago = { ok: false, error: String((err && err.message) || err) }; }
    console.log(`[Cierre] ${m}: después de la foto — contraste ${e.contraste.ok ? 'listo' : 'falló'}, pago ${e.pago.ok ? 'calculado' : 'falló'}`);
  } finally { e.corriendo = false; }
}

/** Para la ruta de la foto: si el mes quedó completo, dispara lo de arriba sin esperarlo. */
function siLaFotoEstaCompleta(mes, completa) {
  if (!completa) return false;
  setImmediate(() => { trasLaFoto(mes).catch((err) => console.warn('[Cierre] después de la foto:', err && err.message)); });
  return true;
}

module.exports = { trasLaFoto, siLaFotoEstaCompleta, estado };
