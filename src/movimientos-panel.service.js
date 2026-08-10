/**
 * movimientos-panel.service.js — EJECUTAR UN MOVIMIENTO DE FICHAS ENTRE PANELES.
 *
 * El porqué del flujo está en `movimientos-panel.js` (el store) y el de la cadena en
 * `carga-cascada.pasosDeMovimiento`. Acá está el pegamento.
 *
 * ⚠️ LA PRIMERA VERSIÓN DE ESTO ESTABA MAL Y CONVIENE QUE QUEDE ESCRITO. Retiraba del origen y
 * después usaba la cascada de CARGA para el destino. La cascada de carga funde fichas nuevas desde
 * el SuperAgente, que tiene saldo ilimitado — perfecto para vender, y un desastre para mover: si
 * el destino colgaba del origen, la carga pasaba por el origen y le devolvía lo que se le acababa
 * de retirar. El destino igual terminaba con +M y el cliente se quedaba con M fichas regaladas,
 * con todas las pantallas cuadrando.
 *
 * Ahora es UNA sola cadena balanceada, y el recorredor es el mismo de siempre: cada paso dice si
 * suma o resta (`paso.op`) y `carga-cascada.ejecutar` lo respeta. Se reusa entero su manejo de
 * fallas —frena en el que falla, dice dónde quedaron las fichas y no repite los que salieron— que
 * es justamente la parte difícil.
 */
const casino = require('./casino-client');
const cascada = require('./carga-cascada.service');
const paneles = require('./paneles-store');
const clientes = require('./clientes-store');
const store = require('./movimientos-panel');

/**
 * Todo lo que hay que comprobar ANTES de tocar el casino.
 * Se hace en el servidor y no en la pantalla: esconder un botón no impide postear a la ruta.
 */
function revisar(m) {
  const cli = clientes.get(m.cliente_id);
  if (!cli) return 'el cliente ya no existe';
  // El permiso se mira acá, en el momento de mover. Mirarlo sólo al pedir dejaría pasar un pedido
  // viejo de alguien a quien después se le sacó el permiso.
  if (!cli.mover_balance) return `"${cli.nombre || cli.codigo}" no tiene habilitado mover balance`;

  const o = paneles.get(m.origen_panel_id);
  const d = paneles.get(m.destino_panel_id);
  if (!o) return 'el panel de origen ya no existe';
  if (!d) return 'el panel de destino ya no existe';
  if (String(o.cliente_id) !== String(m.cliente_id)) return `el panel "${o.nombre}" no es de ese cliente`;
  if (String(d.cliente_id) !== String(m.cliente_id)) return `el panel "${d.nombre}" no es de ese cliente`;
  if (!o.id_usuario) return `el panel "${o.nombre}" no tiene el id del casino cargado`;
  if (!d.id_usuario) return `el panel "${d.nombre}" no tiene el id del casino cargado`;

  // Mismo sistema: las fichas de Casino no cruzan a Europa. Son dos plataformas distintas y el
  // retiro y la carga se harían contra dos sesiones que no se conocen.
  if (String(o.sistema || '').toLowerCase() !== String(d.sistema || '').toLowerCase()) {
    return `no se puede mover entre sistemas distintos: "${o.nombre}" es de ${o.sistema} y "${d.nombre}" de ${d.sistema}`;
  }
  // Y misma divisa habilitada en los dos. Si el destino no la tiene, la carga falla DESPUÉS del
  // retiro — o sea con las fichas ya afuera. Barato comprobarlo antes.
  const tiene = (p) => !Array.isArray(p.divisas) || !p.divisas.length || p.divisas.includes(m.divisa);
  if (!tiene(o)) return `el panel "${o.nombre}" no tiene habilitada la divisa ${m.divisa}`;
  if (!tiene(d)) return `el panel "${d.nombre}" no tiene habilitada la divisa ${m.divisa}`;
  return null;
}

/**
 * Ejecuta el movimiento. Sirve para aprobarlo por primera vez y para reintentar uno que quedó a
 * medias: la diferencia la marca el estado del que se lo toma, no un parámetro.
 *
 * @param sistemaParaCargar  cómo conseguir las credenciales del panel (lo inyecta index.js, que es
 *                           donde vive esa resolución). Se pasa en vez de importarlo para no atar
 *                           este módulo al arranque entero de la app.
 */
async function ejecutar(id, { sistemaParaCargar, por = 'admin', log = () => {} } = {}) {
  const m0 = store.get(id);
  if (!m0) return { ok: false, status: 404, error: 'no encontré ese movimiento' };
  if (m0.estado !== 'pendiente' && m0.estado !== 'a_medias') {
    return { ok: false, status: 400, error: `no se puede ejecutar: está "${m0.estado}"` };
  }
  const mal = revisar(m0);
  if (mal) return { ok: false, status: 400, error: mal };

  const origen = paneles.get(m0.origen_panel_id);
  const destino = paneles.get(m0.destino_panel_id);
  const sys = sistemaParaCargar(origen.sistema);
  if (!sys) return { ok: false, status: 400, error: `no hay con qué operar en "${origen.sistema}": marcá una conexión con "carga fichas de ${origen.sistema}"` };
  if (!sys.password) return { ok: false, status: 400, error: `la conexión de "${origen.sistema}" no tiene contraseña guardada` };

  // La cadena, armada ANTES de tocar nada. Si no se puede armar, no se mueve una ficha.
  const plan = cascada.pasosDeMovimiento({ origen, destino, divisa: m0.divisa });
  if (plan.bloqueo) return { ok: false, status: 400, error: plan.bloqueo };

  // 🔒 El candado, antes del casino. El camino son decenas de segundos.
  const tomado = store.tomar(id, m0.estado);
  if (!tomado) return { ok: false, status: 409, error: 'ese movimiento ya se está ejecutando' };

  try {
    // Se RETOMA lo guardado si la cadena es la misma. Si el árbol cambió entre un intento y otro,
    // los pasos viejos ya no describen el camino: se corta en vez de mezclar dos caminos distintos.
    const guardados = store.pasosDe(id);
    let pasos = plan.pasos;
    if (guardados) {
      const misma = guardados.length === plan.pasos.length
        && guardados.every((p, i) => String(p.id) === String(plan.pasos[i].id) && p.op === plan.pasos[i].op);
      if (!misma) {
        store.soltar(id, 'el árbol del casino cambió desde el intento anterior');
        return { ok: false, status: 409, quedoAMedias: true,
          error: 'El camino entre los dos paneles cambió desde el intento anterior, y hay pasos ya '
            + 'hechos con el camino viejo. No se sigue solo: mirá los saldos y resolvelo a mano.' };
      }
      pasos = guardados;
    }

    const t = await casino.testConnection(sys.url, sys.user, sys.password);
    if (!t.ok || !t.sessionCookie) {
      store.soltar(id, 'no se pudo autenticar contra el casino');
      return { ok: false, status: 502, error: `no se pudo entrar al panel de ${origen.sistema} — revisá usuario y contraseña de esa conexión` };
    }

    log(`[Mover] ${id}: ${m0.monto} ${m0.divisa} · ${plan.pasos.map((p) => `${p.op}(${p.login})`).join(' → ')}`);
    const r = await cascada.ejecutar({
      url: sys.url, sessionCookie: t.sessionCookie, monto: m0.monto, divisa: m0.divisa,
      pasos, serie: `${origen.sistema}|${plan.superagenteId}`, log,
      // Después de CADA paso, no al final: si el proceso se muere, lo ya movido tiene que estar
      // escrito o el reintento lo repite.
      onPaso: (hechos) => store.guardarPasos(id, hechos),
    });
    if (!r.ok) {
      store.soltar(id, r.error || 'la cadena se cortó');
      const donde = r.trabadoEn ? ` Quedaron en "${r.trabadoEn.login}".` : ' No se movió nada.';
      return { ok: false, status: 502, quedoAMedias: !!r.trabadoEn,
        error: `El movimiento se cortó: ${r.error || 'el casino no confirmó un paso'}.${donde} `
          + 'Reintentar retoma desde el paso que falló — los que ya salieron no se repiten.' };
    }

    const fin = store.marcarHecho(id, { pasos: r.pasos || null, at: new Date().toISOString() }, por);
    log(`[Mover] ${id}: HECHO`);
    return { ok: true, movimiento: fin };
  } catch (e) {
    store.soltar(id, String((e && e.message) || e));
    return { ok: false, status: 500, error: String((e && e.message) || e) };
  }
}

module.exports = { ejecutar, revisar };
