/**
 * caja-token.js — conseguir el api_token de un cliente, sin romperle nada.
 *
 * 🔑 EL PROBLEMA: una cuenta NO puede ver ni administrar su propia configuración de acceso —
 *    medido el 27-ago: `usersettings` sobre uno mismo devuelve HTML, sobre un hijo devuelve JSON.
 *    Así que el cliente no puede activarse el token solo: hace falta una credencial de arriba.
 *
 * 🔑 LA BUENA: esa credencial superior llega a TODA la red hacia abajo, no sólo a los hijos
 *    directos (verificado: un distribuidor leyó la configuración de un NIETO). Con una sola
 *    cuenta raíz alcanza para aprovisionar a todos.
 *
 * 🔑 Y LA MEJOR: el token EXISTENTE se puede LEER. El campo viene como
 *    `authorization_via_apitoken/api_token` de tipo `const`, así que a quien ya tiene uno no hay
 *    que generarle nada — generar lo invalidaría y le rompería cualquier integración que tenga.
 *
 * De ahí el orden de este módulo: LEER primero, activar y generar sólo si hace falta.
 */

/** Recorre el árbol de `settings` y devuelve {ruta: valor}. */
function aplanar(nodo, ruta = '', salida = {}) {
  for (const [k, v] of Object.entries(nodo || {})) {
    const p = ruta ? `${ruta}/${k}` : k;
    if (v && typeof v === 'object') {
      if ('value' in v) salida[p] = v.value;
      if (v.childs) aplanar(v.childs, p, salida);
    }
  }
  return salida;
}

const esToken = (v) => typeof v === 'string' && /^[A-Za-z0-9]{64}$/.test(v);

/** Lee la configuración de acceso de una cuenta usando la credencial de arriba. */
async function leerAcceso(clienteRaiz, idCuenta) {
  const r = await clienteRaiz.apiCall('usersettings', {}, { id: String(idCuenta), module: 'authorization' });
  /* El motor contesta HTML con status 200 cuando no hay permiso: sin esto, JSON.parse rompe. */
  if (!r.ok || !r.data || typeof r.data !== 'object') {
    return { ok: false, error: 'no se pudo leer la configuración de esa cuenta' };
  }
  if (r.data.error) return { ok: false, error: String(r.data.error) };
  const campos = aplanar(r.data.settings);
  return {
    ok: true,
    activo: campos.authorization_via_apitoken === true,
    token: esToken(campos['authorization_via_apitoken/api_token'])
      ? campos['authorization_via_apitoken/api_token'] : null,
  };
}

/** Escribe un ajuste. `nombre` puede ser una ruta: ['authorization_via_apitoken','generate']. */
async function escribir(clienteRaiz, idCuenta, nombre, valor) {
  /* ⚠️ `setting[name][]` va REPETIDO, un tramo por vez. Nada de `Object.fromEntries`: con claves
     repetidas se queda con la última y manda `generate` huérfano, que el motor ignora sin avisar. */
  const cuerpo = {
    'setting[name][]': [].concat(nombre).map(String),
    'setting[value]': String(valor),
  };
  const r = await clienteRaiz.apiCall('usersettings',
    cuerpo, { id: String(idCuenta), module: 'authorization' });
  return r.ok && r.data && typeof r.data === 'object' && !r.data.error;
}

/**
 * Deja a la cuenta con un api_token utilizable y lo devuelve.
 *
 * @param {object} clienteRaiz  cliente del motor con una credencial POR ENCIMA del cliente
 * @param {string} idCuenta     id de la cuenta del cliente
 * @param {{permitirGenerar?:boolean}} opciones
 *        permitirGenerar=false → si no tiene token, no inventa nada: avisa y se usa la sesión.
 * @returns {Promise<{ok:boolean, token?:string, generado?:boolean, error?:string}>}
 */
async function asegurarToken(clienteRaiz, idCuenta, { permitirGenerar = true } = {}) {
  const actual = await leerAcceso(clienteRaiz, idCuenta);
  if (!actual.ok) return actual;

  /* 1 · Ya lo tiene: se usa el suyo. Éste es el camino de la enorme mayoría, y no toca nada. */
  if (actual.activo && actual.token) return { ok: true, token: actual.token, generado: false };

  if (!permitirGenerar) {
    return { ok: false, error: 'la cuenta no tiene api_token activo', necesitaGenerar: true };
  }

  /* 2 · Está apagado: hay que prenderlo antes de que exista el campo del token. */
  if (!actual.activo) {
    const prendio = await escribir(clienteRaiz, idCuenta, 'authorization_via_apitoken', 'true');
    if (!prendio) return { ok: false, error: 'no se pudo activar el acceso por token' };
  }

  /* 3 · Y recién ahí, generarlo.
     ⚠️ Esto invalida cualquier token anterior de esa cuenta — por eso sólo se llega acá cuando
     no había ninguno legible. */
  const genero = await escribir(clienteRaiz, idCuenta, ['authorization_via_apitoken', 'generate'], '1');
  if (!genero) return { ok: false, error: 'no se pudo generar el token' };

  /* 4 · Se vuelve a leer: el valor generado viene en la ficha, no en la respuesta del botón. */
  const nuevo = await leerAcceso(clienteRaiz, idCuenta);
  if (!nuevo.ok) return nuevo;
  if (!nuevo.token) return { ok: false, error: 'el motor no devolvió un token utilizable' };
  return { ok: true, token: nuevo.token, generado: true };
}

module.exports = { asegurarToken, leerAcceso, aplanar };
