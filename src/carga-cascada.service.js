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

/**
 * Los pasos de un MOVIMIENTO entre dos paneles. No es una carga: es un PASAJE.
 *
 * ── LA DIFERENCIA, QUE ES TODA LA CUESTIÓN ───────────────────────────────────────────────────
 * `pasosDe` (la carga) FUNDE las fichas: el SuperAgente tiene saldo ilimitado, así que cargar
 * significa crearlas arriba y bajarlas. Está perfecto para vender.
 *
 * Un movimiento no crea nada: las fichas SUBEN del origen hasta el ancestro que los dos comparten
 * y BAJAN hasta el destino. Ni una más ni una menos.
 *
 * Usar la cascada de carga para la segunda mitad —que es lo que hacía la primera versión de esto—
 * regala fichas cuando los dos paneles están emparentados. El caso peor: si el destino cuelga del
 * origen, la carga PASA POR el origen y le devuelve lo que se le acababa de retirar; el destino
 * igual queda con +M y el cliente terminó con M fichas de regalo. Cuadraba en todas las pantallas.
 *
 * ── CÓMO SALE LA CADENA ──────────────────────────────────────────────────────────────────────
 * Se toma el camino de cada uno desde la raíz (su `escala` más él mismo), se busca hasta dónde
 * coinciden, y el resto de un lado se sube retirando y el del otro se baja cargando:
 *
 *   hermanos bajo el mismo padre   →  out(A), in(B)            el padre gana M y lo pierde: neto 0
 *   ramas distintas del mismo SA   →  out(A), out(padreA), in(padreB), in(B)
 *   el destino es padre del origen →  out(A) y nada más        no existe el medio camino
 *   el origen es padre del destino →  in(B) y nada más         se lo saca al origen
 *   los dos son SuperAgentes       →  out(A), in(B)            la casa recibe y entrega: neto 0
 *
 * El ancestro común NO es un paso: recibe de una rama y entrega a la otra.
 *
 * ⚠️ Si de alguno de los dos no se conoce el árbol, esto BLOQUEA. En una carga, no saber el árbol
 * degrada a carga directa y como mucho se carga de más, que se nota. Acá sería sacar de un lado y
 * poner en el otro sin saber por dónde pasa el camino: el monto quedaría arriba de una rama y
 * faltando abajo de la otra, sin que nada lo diga.
 */
function pasosDeMovimiento({ origen, destino, divisa }) {
  const div = String(divisa || 'ARS').toUpperCase();
  const eslabon = (x, propios) => ({ id: String(x.id), login: x.login, nivel: x.nivel,
    divisas: x.divisas, estado: 'pendiente', ...(propios || {}) });
  const caminoDe = (p) => [
    ...((p.escala) || []).map((x) => eslabon(x)),
    eslabon({ id: p.id_usuario, login: p.usuario || p.nombre, nivel: p.nivel_usuario, divisas: p.divisas }),
  ];

  if (!origen || !destino) return { bloqueo: 'falta uno de los dos paneles' };
  if (!origen.arbol_at || !destino.arbol_at) {
    return { bloqueo: `no se conoce el árbol de "${(!origen.arbol_at ? origen : destino).nombre}" en el casino. `
      + 'Sincronizá el árbol antes de mover: sin saber por dónde pasa el camino, mover fichas las deja a mitad de camino.' };
  }

  const co = caminoDe(origen); const cd = caminoDe(destino);

  /* ── PASAR DE UNA PLATAFORMA A LA OTRA ────────────────────────────────────────────────────
     Casino y Europa son dos instalaciones separadas —dos dominios, dos bases— y no comparten ni
     un nodo. El prefijo común no se calcula: se sabe que es cero.

     ⚠️ Y NO SE CALCULA A PROPÓSITO. Los ids de usuario salen de una secuencia propia de cada
     instalación y pueden coincidir: dos ids iguales de plataformas distintas se leerían como "el
     mismo nodo", el recorte se comería eslabones de las dos ramas, y la cadena sacaría de un lado
     sin cerrar del otro sin que nada lo diga.

     ⚠️ LA CADENA PARA EN EL SUPERAGENTE DE CADA LADO, y ése es el punto entero del diseño. Arriba
     del SuperAgente no hay ninguna cuenta con saldo: las credenciales con las que el sistema se
     conecta son de administración y no tienen billetera —está medido—. Si la cadena subiera más
     allá, las fichas quedarían en un lugar que no se puede mirar, y si el pase se corta en el
     medio no habría forma de encontrarlas. El SuperAgente sí es una billetera de verdad, con
     saldo finito y visible, así que ahí descansan y ella lo comprueba mirando el número.

     Es la misma regla de siempre, no una excepción: el nodo donde se apoyan las dos mitades nunca
     es un paso, porque recibe de una rama y entrega a la otra. Adentro de un sistema ese nodo es
     el ancestro común; cruzando son dos, uno por plataforma. */
  const cruce = String(origen.sistema || '').toLowerCase() !== String(destino.sistema || '').toLowerCase();
  let i = 0;
  if (cruce) {
    i = 1;                                   // el SuperAgente de cada lado: apoyo, no paso
  } else {
    while (i < co.length && i < cd.length && co[i].id === cd[i].id) i += 1;  // hasta dónde comparten
  }
  /* Cada paso lleva SU plataforma: la mitad de arriba corre contra una sesión y la de abajo contra
     otra, y sin la etiqueta no hay forma de saber cuál es cuál al retomar uno a medias. En un
     movimiento común las dos son la misma y nada cambia. */
  const tag = (x, sis) => ({ ...x, sistema: sis || null });
  const subir = co.slice(i).reverse().map((x) => ({ ...tag(x, cruce ? origen.sistema : null), op: 'out' }));
  const bajar = cd.slice(i).map((x) => ({ ...tag(x, cruce ? destino.sistema : null), op: 'in' }));
  const pasos = [...subir, ...bajar];
  if (pasos.length) pasos[pasos.length - 1].destino = true;

  // El saldo es POR DIVISA en cada eslabón, igual que en la carga: si uno del camino no la tiene
  // habilitada, la cadena se corta ahí. Mejor decirlo antes de mover nada.
  const sinLaDivisa = pasos.filter((x) => Array.isArray(x.divisas) && x.divisas.length && !x.divisas.includes(div));
  const bloqueo = sinLaDivisa.length
    ? `"${sinLaDivisa[0].login}" (${sinLaDivisa[0].nivel}) está en el camino y no tiene ${div} habilitada. Tiene: ${sinLaDivisa[0].divisas.join(', ')}`
    : (!pasos.length ? 'el origen y el destino son la misma cuenta del casino' : null);

  return {
    pasos, bloqueo, sinLaDivisa, divisa: div,
    cruce,
    // Dónde descansan las fichas entre las dos mitades, uno por lado. Es lo que hay que mirar si
    // el pase queda a medias, y lo que hay que comprobar que tenga saldo ANTES de sacar nada.
    apoyoOrigen: cruce ? co[0] : null,
    apoyoDestino: cruce ? cd[0] : null,
    pivote: i > 0 && !cruce ? co[i - 1] : null,   // el ancestro común, cuando es uno solo
    // Serie: se toma la raíz del camino del origen para no pisarse con una carga del mismo árbol.
    superagenteId: String(co[0].id),
    superagenteDestinoId: String(cd[0].id),
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
async function ejecutar({ url, sessionCookie, monto, divisa, pasos, log, serie, onPaso }) {
  // Serializada por superagente: dos cascadas a la vez sobre el mismo nodo se pisan el saldo.
  if (serie) return enFila(serie, () => _ejecutar({ url, sessionCookie, monto, divisa, pasos, log, onPaso }));
  return _ejecutar({ url, sessionCookie, monto, divisa, pasos, log, onPaso });
}

/**
 * @param onPaso  se llama con el estado de TODOS los pasos después de cada uno. Sirve para
 *                guardarlo: si el proceso se muere en el medio, lo que ya se movió tiene que estar
 *                escrito, o el reintento lo vuelve a mover. Los pedidos no lo usan porque guardan
 *                al final; un movimiento sí, porque su cadena retira y carga y repetirla no es
 *                cargar de más — es descuadrar dos cuentas.
 */
async function _ejecutar({ url, sessionCookie, monto, divisa, pasos, log, onPaso }) {
  const hechos = pasos.map((p) => ({ ...p }));
  for (const paso of hechos) {
    if (paso.estado === 'ok') continue;                      // ya se hizo en un intento anterior
    // `paso.op` es 'in' (cargar) o 'out' (retirar). Los pasos de una CARGA no lo traen y siguen
    // siendo 'in', igual que siempre. Lo traen los de un MOVIMIENTO, que es una cadena mixta: sube
    // por una rama retirando y baja por la otra cargando. Sin esto, este recorredor sólo sabía
    // sumar, y un movimiento armado con él terminaba creando fichas.
    const op = paso.op === 'out' ? 'out' : 'in';
    const r = await casino.loadChips(url, sessionCookie, paso.id, monto, divisa, op);
    if (!r.ok) {
      paso.estado = 'falló';
      paso.error = r.error || (op === 'out' ? 'el retiro falló' : 'la carga falló');
      paso.at = new Date().toISOString();
      if (onPaso) { try { onPaso(hechos); } catch (e) { /* guardar no puede tumbar la cascada */ } }
      const previo = hechos.filter((x) => x.estado === 'ok');
      const trabadoEn = previo.length ? previo[previo.length - 1] : null;
      if (log) log(`[Cascada] FALLÓ en ${paso.login} (${paso.nivel}): ${paso.error}` + (trabadoEn ? ` — quedaron ${divisa} ${monto} en ${trabadoEn.login}` : ''));
      return { ok: false, pasos: hechos, trabadoEn, error: paso.error };
    }
    paso.estado = 'ok';
    paso.balance = r.newBalance;
    paso.at = new Date().toISOString();
    if (onPaso) { try { onPaso(hechos); } catch (e) { /* idem */ } }
    if (log) log(`[Cascada] ${paso.destino ? 'DESTINO' : 'padre'} ${paso.login} (${paso.nivel}) ${op === 'out' ? '−' : '+'}${divisa} ${monto} → ${r.newBalance}`);
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

module.exports = { panelDe, pasosDe, pasosDeMovimiento, ejecutar, devolver };
