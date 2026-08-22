/**
 * arbol.service.js — jerarquía real de los paneles en el casino.
 *
 * Para bajarle fichas a un panel hay que pasarlas nivel por nivel: primero al SuperAgente,
 * después al Dealer (lo que acá llamamos Distribuidor) y recién ahí al Agente. Este servicio
 * resuelve, para CADA panel, su nivel real y por qué padres hay que pasar.
 *
 * Cómo se saca (el casino NO devuelve el padre en ningún campo):
 *   El endpoint de usuarios devuelve la lista PLANA pero en orden jerárquico (recorrido en
 *   profundidad). El padre de un nodo es el último nodo de nivel superior visto antes que él,
 *   así que el árbol se reconstruye con una pila. Verificado contra el casino: pedirle el
 *   subárbol de un nodo (?id=) devuelve exactamente los descendientes que calcula esta pila.
 */
const casinoConex = require('./casino-conexiones-store');
const paneles = require('./paneles-store');

// El casino llama "Dealer" al nivel que en el OS se llama "Distribuidor": es el mismo escalón.
const RANGO = { SuperAgente: 3, Dealer: 2, Distribuidor: 2, Agente: 1 };
const rango = (nivel) => RANGO[nivel] || 0;
const A_NIVEL_OS = (nivel) => (nivel === 'Dealer' ? 'Distribuidor' : nivel);

/**
 * Reconstruye el árbol desde la lista plana.
 * @returns Map(id → { nodo, nivel, padre, cadena }) — `cadena` incluye al propio nodo, del
 *          SuperAgente hacia abajo.
 */
function armar(nodos) {
  const idx = new Map();
  const abiertos = []; // nodos que todavía pueden ser padres, de mayor a menor rango
  for (const n of nodos) {
    const r = rango(n.nivel);
    // se cierran los del mismo nivel o más abajo: ninguno puede ser el padre de este
    while (abiertos.length && rango(abiertos[abiertos.length - 1].nivel) <= r) abiertos.pop();
    const padre = abiertos.length ? abiertos[abiertos.length - 1] : null;
    const previa = padre ? idx.get(String(padre.id)).cadena : [];
    idx.set(String(n.id), {
      nodo: n,
      // SIEMPRE en el vocabulario del OS, igual que la cadena y el padre: mezclar 'Dealer' con
      // 'Distribuidor' según el campo que se mire es una fuente segura de bugs.
      nivel: A_NIVEL_OS(n.nivel || 'Caja'),
      nivelCasino: n.nivel || '',
      padre: padre ? { id: String(padre.id), login: padre.login, nivel: A_NIVEL_OS(padre.nivel) } : null,
      // `divisas` va en cada eslabón porque el saldo del padre es POR DIVISA: si el SuperAgente
      // no tiene habilitada la moneda del pedido, la cascada no puede pasar por ahí.
      cadena: [...previa, {
        id: String(n.id), login: n.login, nivel: A_NIVEL_OS(n.nivel || 'Caja'),
        divisas: (n.currencies || []).map((c) => String(c).toUpperCase()),
      }],
    });
    if (r > 0) abiertos.push(n); // una caja no tiene hijos
  }
  return idx;
}

/** Por dónde hay que pasar las fichas para llegar al nodo (la cadena SIN el nodo mismo). */
function escalaDe(entrada) {
  return entrada ? entrada.cadena.slice(0, -1) : [];
}

/**
 * Baja el árbol de UNA conexión. Devuelve { ok, idx, total }
 * `verBorrados` trae también las cuentas borradas (el árbol pasa de ~62k a ~178k nodos y tarda
 * el doble): solo sirve para diagnosticar por qué falta un panel, no para operar.
 */
async function arbolDe(conexionId, { verBorrados = false } = {}) {
  const cli = casinoConex.client(conexionId);
  if (!cli) return { ok: false, error: 'conexión no encontrada' };
  // soloActivos=false → también los inactivos, si no faltarían paneles que igual hay que cargar
  const r = await cli.nodos({
    cur: 'ARS', soloActivos: false, currencies: ['ARS'],
    ...(verBorrados ? { extra: { deleted_users: 'delete' } } : {}),
  });
  if (!r.ok) return { ok: false, error: r.error };
  return { ok: true, idx: armar(r.nodos || []), total: (r.nodos || []).length };
}

/**
 * Resuelve y GUARDA la jerarquía de todos los paneles.
 * Los paneles que no aparecen en el árbol NO se tocan (se informan): borrarles el nivel que ya
 * tenían cargado a mano sería peor que dejarlo viejo.
 */
/**
 * @param soloConexion  resolver sólo esa conexión
 * @param soloPanel     resolver UN panel (id del OS). Sigue bajando el árbol entero de su conexión
 *                      —el casino no devuelve el padre de un nodo, hay que reconstruirlo desde la
 *                      lista plana— pero ESCRIBE uno solo. Es lo que hace falta cuando se crea una
 *                      caja nueva: sin esto había que re-sincronizar los 204 paneles para arreglar 1.
 * @param dry           calcula y NO escribe. Deja ver qué cambiaría antes de cambiarlo.
 */
async function sincronizar({ soloConexion = null, soloPanel = null, dry = false } = {}) {
  // Solo el engine 463: el árbol de nodos no existe como tal en TBS.
  const uno = soloPanel ? paneles.get(soloPanel) : null;
  if (soloPanel && !uno) return { ok: false, error: 'no existe ese panel' };
  const conexiones = casinoConex.list463()
    .filter((c) => !soloConexion || c.id === soloConexion)
    // Con un panel puntual sólo hace falta el árbol de SU sistema: el resto no se toca ni se baja.
    .filter((c) => !uno || String(c.nombre || '').toLowerCase() === String(uno.sistema || '').toLowerCase());
  const todos = uno ? [uno] : paneles.list();
  const res = { conexiones: [], resueltos: 0, sinEncontrar: [], nivelCorregido: [], total: todos.length, dry: !!dry };

  for (const cx of conexiones) {
    const a = await arbolDe(cx.id);
    if (!a.ok) { res.conexiones.push({ nombre: cx.nombre, ok: false, error: a.error }); continue; }
    res.conexiones.push({ nombre: cx.nombre, ok: true, nodos: a.total });

    // el sistema del panel se llama igual que la conexión (Europa / Casino)
    const suyos = todos.filter((p) => String(p.sistema || '').toLowerCase() === String(cx.nombre || '').toLowerCase());
    for (const p of suyos) {
      const e = a.idx.get(String(p.id_usuario));
      if (!e) { res.sinEncontrar.push({ id: p.id, nombre: p.nombre, sistema: p.sistema, id_usuario: String(p.id_usuario) }); continue; }
      const nivelReal = e.nivel;   // ya viene en el vocabulario del OS
      const escala = escalaDe(e);
      if (nivelReal !== p.nivel_usuario) {
        res.nivelCorregido.push({ id: p.id, nombre: p.nombre, sistema: p.sistema,
          de: p.nivel_usuario, a: nivelReal,
          // Por dónde van a pasar las fichas ahora. Sin esto, "de SuperAgente a Agente" no dice
          // nada sobre si la carga va a funcionar.
          escala: escala.map((x) => `${x.login} (${x.nivel})`),
          nuevo: !p.arbol_at });
      }
      if (!dry) {
        paneles.setJerarquia(p.id, {
          nivel: nivelReal,
          padre: e.padre,
          superagente: e.cadena.length ? e.cadena[0] : null,
          escala,
        });
      }
      res.resueltos++;
    }

    // Los que no aparecieron: averiguar si están BORRADOS en el casino o si directamente no
    // existen. La diferencia importa — a una cuenta borrada no se le pueden cargar fichas, así
    // que el panel está muerto y hay que sacarlo, no arreglarle el id.
    const faltantes = res.sinEncontrar.filter((f) => String(f.sistema || '').toLowerCase() === String(cx.nombre || '').toLowerCase() && !f.diagnostico);
    if (faltantes.length) {
      const b = await arbolDe(cx.id, { verBorrados: true });
      for (const f of faltantes) {
        const e = b.ok ? b.idx.get(f.id_usuario) : null;
        f.diagnostico = !b.ok ? 'no se pudo verificar' : (e ? 'BORRADO en el casino' : 'no existe con ese id');
        if (e) f.login_casino = e.nodo.login;
      }
    }
  }
  return { ok: true, ...res };
}

module.exports = { armar, escalaDe, arbolDe, sincronizar, RANGO, rango, A_NIVEL_OS };
