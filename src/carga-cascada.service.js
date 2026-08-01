/**
 * carga-cascada.service.js — bajar fichas pasando por los padres.
 *
 * POR QUÉ: en el casino el SuperAgente tiene fichas ilimitadas, pero para cargar un Distribuidor
 * el tope es el saldo del SuperAgente, y para cargar un Agente el tope es el saldo del Distribuidor.
 * Cargar directo en un nivel bajo "funciona" solo mientras el padre tenga saldo — falla justo
 * cuando el padre quedó corto. (Medido: 70 paneles dependen del saldo de su padre.)
 *
 * QUÉ HACE: funde cada eslabón JUSTO ANTES de usarlo, de arriba hacia abajo.
 *   cargar M en un Agente  →  SuperAgente +M  →  Distribuidor +M (se lo saca al SA)  →  Agente +M
 * Como cada nivel entrega lo mismo que recibió, **los padres terminan con el saldo que tenían** y
 * solo el destino queda con +M. Nunca falta.
 *
 * SI SE CORTA: se frena y se avisa (fail-closed, igual que los retiros). Las fichas quedan
 * TRABADAS en el último eslabón que sí se cargó, queda registrado en el pedido, y volver a
 * apretar "Cargar" RETOMA desde el paso que falló (los ya hechos no se repiten).
 */
const paneles = require('./paneles-store');
const casino = require('./casino-client');

const K = (s) => String(s || '').trim().toLowerCase();

/** El panel del OS que corresponde a esa cuenta del casino (trae la escala de padres). */
function panelDe(sistema, userId) {
  return paneles.list().find((p) => String(p.id_usuario) === String(userId) && K(p.sistema) === K(sistema)) || null;
}

/**
 * Los pasos de la carga, de arriba hacia abajo. El último es el destino.
 * Si el panel no tiene escala (es SuperAgente, o no está resuelto) devuelve un solo paso: la carga
 * directa de siempre.
 */
function pasosDe({ sistema, userId, monto, divisa, cajaUsuario }) {
  const panel = panelDe(sistema, userId);
  const escala = (panel && panel.escala) || [];
  const div = String(divisa || 'ARS').toUpperCase();
  const pasos = escala.map((x) => ({
    id: String(x.id), login: x.login, nivel: x.nivel, padre: true, estado: 'pendiente',
  }));
  pasos.push({
    id: String(userId), login: (panel && (panel.usuario || panel.nombre)) || cajaUsuario || String(userId),
    nivel: (panel && panel.nivel_usuario) || '', destino: true, estado: 'pendiente',
  });

  // El saldo del padre es POR DIVISA: si un padre no tiene habilitada la moneda del pedido, la
  // cascada no puede pasar por ahí y hay que habilitarla en el casino. Se avisa ANTES de mover
  // nada, con el nombre del nodo, en vez de fallar a mitad de camino con un error del casino.
  // Si de un eslabón no sabemos las divisas (dato viejo o incompleto) NO se bloquea: se intenta,
  // igual que antes — bloquear por falta de dato frenaría cargas que hoy funcionan.
  const sinLaDivisa = escala.filter((x) => Array.isArray(x.divisas) && x.divisas.length && !x.divisas.includes(div));
  const bloqueo = sinLaDivisa.length
    ? `"${sinLaDivisa[0].login}" (${sinLaDivisa[0].nivel}) no tiene ${div} habilitada — hay que habilitársela en el casino para poder bajarle fichas en esa moneda a este panel. Tiene: ${sinLaDivisa[0].divisas.join(', ')}`
    : null;

  return {
    panel,
    resuelto: !!(panel && panel.arbol_at),
    monto: Number(monto), divisa: div,
    superagenteId: escala.length ? String(escala[0].id) : String(userId),
    bloqueo, sinLaDivisa,
    pasos,
  };
}

// ── Una cascada a la vez por superagente ──
// 9 superagentes están compartidos por varios clientes (GanamosBot-SA por 12). Dos cascadas
// simultáneas sobre el mismo nodo se pisarían el saldo intermedio, así que se serializan.
const colas = new Map();
function enFila(clave, fn) {
  const previa = colas.get(clave) || Promise.resolve();
  const propia = previa.then(fn, fn);                 // corre igual si la anterior falló
  const silenciosa = propia.catch(() => {});          // la cola NUNCA queda rechazada
  colas.set(clave, silenciosa);
  silenciosa.then(() => { if (colas.get(clave) === silenciosa) colas.delete(clave); });
  return propia;
}

/**
 * Ejecuta (o RETOMA) la cascada. Los pasos con estado 'ok' NO se repiten: es lo que hace seguro
 * volver a intentar sin cargar dos veces.
 * @returns { ok, pasos, trabadoEn, error, newBalance }  — newBalance es el del destino.
 */
async function ejecutar({ url, sessionCookie, monto, divisa, pasos, log, serie }) {
  // Serializada por superagente: dos cascadas a la vez sobre el mismo nodo se pisan el saldo.
  if (serie) return enFila(serie, () => _ejecutar({ url, sessionCookie, monto, divisa, pasos, log }));
  return _ejecutar({ url, sessionCookie, monto, divisa, pasos, log });
}

async function _ejecutar({ url, sessionCookie, monto, divisa, pasos, log }) {
  const hechos = pasos.map((p) => ({ ...p }));
  for (const paso of hechos) {
    if (paso.estado === 'ok') continue;                      // ya se hizo en un intento anterior
    const r = await casino.loadChips(url, sessionCookie, paso.id, monto, divisa, 'in');
    if (!r.ok) {
      paso.estado = 'falló';
      paso.error = r.error || 'la carga falló';
      paso.at = new Date().toISOString();
      const previo = hechos.filter((x) => x.estado === 'ok');
      const trabadoEn = previo.length ? previo[previo.length - 1] : null;
      if (log) log(`[Cascada] FALLÓ en ${paso.login} (${paso.nivel}): ${paso.error}` + (trabadoEn ? ` — quedaron ${divisa} ${monto} en ${trabadoEn.login}` : ''));
      return { ok: false, pasos: hechos, trabadoEn, error: paso.error };
    }
    paso.estado = 'ok';
    paso.balance = r.newBalance;
    paso.at = new Date().toISOString();
    if (log) log(`[Cascada] ${paso.destino ? 'DESTINO' : 'padre'} ${paso.login} (${paso.nivel}) +${divisa} ${monto} → ${r.newBalance}`);
  }
  const destino = hechos[hechos.length - 1];
  return { ok: true, pasos: hechos, newBalance: destino ? destino.balance : null };
}

/**
 * Devuelve hacia arriba las fichas que quedaron trabadas (operation='out' en el eslabón trabado).
 * NO se llama solo: es una acción explícita, porque si esto también falla el lío es peor.
 */
async function devolver({ url, sessionCookie, monto, divisa, paso }) {
  if (!paso) return { ok: false, error: 'no hay ningún paso trabado' };
  const r = await casino.loadChips(url, sessionCookie, paso.id, monto, divisa, 'out');
  return r.ok ? { ok: true, newBalance: r.newBalance } : { ok: false, error: r.error };
}

module.exports = { panelDe, pasosDe, ejecutar, devolver };
