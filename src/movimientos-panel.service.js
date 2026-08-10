/**
 * movimientos-panel.service.js — EJECUTAR UN MOVIMIENTO DE FICHAS ENTRE PANELES.
 *
 * Toda la explicación de POR QUÉ está en `movimientos-panel.js` (el store). Acá está el cómo, que
 * es corto porque casi todo ya existía:
 *
 *   1. RETIRAR del origen  →  casinoClient.loadChips(..., 'out'). Una sola llamada: retirar sube
 *      las fichas al padre, y el padre es la cuenta con la que cargamos.
 *   2. CARGAR en el destino →  la CASCADA de siempre, la misma que usa un pedido normal. No es una
 *      copia: es literalmente `cascada.ejecutar`, con su reanudación y su manejo de trabadas.
 *
 * Que la segunda mitad sea un pedido normal es lo mejor de este diseño. Cargar en un distribuidor
 * le saca las fichas a su padre, así que hay que fundir cada eslabón de arriba hacia abajo — eso ya
 * está resuelto y probado en producción. Reimplementarlo acá habría sido escribir de nuevo la parte
 * difícil, y peor.
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
  if (m0.estado !== 'pendiente' && m0.estado !== 'retirado') {
    return { ok: false, status: 400, error: `no se puede ejecutar: está "${m0.estado}"` };
  }
  const mal = revisar(m0);
  if (mal) return { ok: false, status: 400, error: mal };

  const origen = paneles.get(m0.origen_panel_id);
  const destino = paneles.get(m0.destino_panel_id);
  const sys = sistemaParaCargar(origen.sistema);
  if (!sys) return { ok: false, status: 400, error: `no hay con qué operar en "${origen.sistema}": marcá una conexión con "carga fichas de ${origen.sistema}"` };
  if (!sys.password) return { ok: false, status: 400, error: `la conexión de "${origen.sistema}" no tiene contraseña guardada` };

  // 🔒 El candado, ANTES de tocar el casino. El camino son decenas de segundos.
  const tomado = store.tomar(id, m0.estado);
  if (!tomado) return { ok: false, status: 409, error: 'ese movimiento ya se está ejecutando' };

  try {
    const t = await casino.testConnection(sys.url, sys.user, sys.password);
    if (!t.ok || !t.sessionCookie) {
      store.soltar(id, 'no se pudo autenticar contra el casino');
      return { ok: false, status: 502, error: `no se pudo entrar al panel de ${origen.sistema} — revisá usuario y contraseña de esa conexión` };
    }

    // ── MITAD 1: RETIRAR DEL ORIGEN ───────────────────────────────────────────────────────────
    // Sólo si no se hizo ya. Un movimiento en 'retirado' viene justamente de acá: repetirlo sacaría
    // el monto dos veces.
    if (m0.estado === 'pendiente') {
      log(`[Mover] ${id}: retirando ${m0.monto} ${m0.divisa} de ${origen.nombre} (${origen.id_usuario})`);
      const out = await casino.loadChips(sys.url, t.sessionCookie, origen.id_usuario, m0.monto, m0.divisa, 'out');
      if (!out.ok) {
        // No se movió nada: vuelve a pendiente y se puede reintentar entero. La causa más común es
        // que el origen no tenga saldo, y por eso el retiro va primero.
        store.soltar(id, out.error || 'el casino no confirmó el retiro');
        return { ok: false, status: 502, mitad: 'retiro',
          error: `no se pudo retirar de "${origen.nombre}": ${out.error || 'el casino no confirmó'}. No se movió nada.` };
      }
      store.marcarRetiroOk(id, { newBalance: out.newBalance, at: new Date().toISOString() });
      log(`[Mover] ${id}: retiro OK, saldo del origen ${out.newBalance}`);
    }

    // ── MITAD 2: CARGAR EN EL DESTINO ─────────────────────────────────────────────────────────
    // Es un pedido normal: la cascada funde cada eslabón de arriba hacia abajo.
    const plan = cascada.pasosDe({
      sistema: destino.sistema, userId: destino.id_usuario,
      monto: m0.monto, divisa: m0.divisa, cajaUsuario: destino.usuario,
    });
    if (plan.bloqueo) {
      store.soltar(id, plan.bloqueo);
      return { ok: false, status: 400, mitad: 'carga', quedoAMedias: true,
        error: `Las fichas YA SE RETIRARON de "${origen.nombre}" y están en la cuenta con la que cargamos, `
          + `pero no se pueden mandar a "${destino.nombre}": ${plan.bloqueo}` };
    }
    const r = await cascada.ejecutar({
      url: sys.url, sessionCookie: t.sessionCookie, monto: m0.monto, divisa: m0.divisa,
      pasos: plan.pasos, serie: `${destino.sistema}|${plan.superagenteId}`, log,
    });
    if (!r.ok) {
      store.soltar(id, (r.error || 'la carga falló'));
      return { ok: false, status: 502, mitad: 'carga', quedoAMedias: true,
        error: `Las fichas YA SE RETIRARON de "${origen.nombre}" pero no llegaron a "${destino.nombre}": `
          + `${r.error || 'la carga falló'}. Están en la cuenta con la que cargamos — reintentá y se manda sólo esa mitad.` };
    }

    const fin = store.marcarHecho(id, { pasos: r.pasos || null, at: new Date().toISOString() }, por);
    log(`[Mover] ${id}: HECHO`);
    return { ok: true, movimiento: fin };
  } catch (e) {
    // Cualquier cosa inesperada suelta el candado al estado que corresponda. Sin esto un error raro
    // dejaba el movimiento tomado para siempre.
    store.soltar(id, String((e && e.message) || e));
    return { ok: false, status: 500, error: String((e && e.message) || e) };
  }
}

module.exports = { ejecutar, revisar };
