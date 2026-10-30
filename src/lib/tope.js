/**
 * tope.js — TOPE DE PEDIDOS POR DIRECCIÓN, para las puertas que no piden sesión.
 *
 * Vivía adentro de index.js, y sirve igual en Mi Caja —que corre en OTRO servicio con el mismo
 * código— así que se mudó acá en vez de copiarse. Una copia era garantizar que mañana uno de los
 * dos topes se arregle y el otro no.
 *
 * El contador es en memoria a propósito: se pierde al reiniciar y no se comparte entre instancias,
 * y las dos cosas están bien para lo que hace. Lo que frena es un aluvión de minutos, no un
 * atacante paciente — para eso están la firma del token y la contraseña.
 */
const _visto = new Map();

/**
 * Devuelve un middleware que corta en `tope` pedidos por IP cada `ventanaMin` minutos.
 * `nombre` separa los contadores: gastar el de una puerta no cierra las otras.
 */
function porIp(nombre, tope, ventanaMin) {
  return (req, res, next) => {
    // La IP real la resuelve `trust proxy` en la app. Leer X-Forwarded-For acá a mano dejaba que
    // cualquiera escribiera la suya y tuviera topes nuevos en cada pedido.
    const ip = String(req.ip || 'x');
    const clave = nombre + ':' + ip;
    const ahora = Date.now(); const ventana = ventanaMin * 60 * 1000;
    const prev = (_visto.get(clave) || []).filter((t) => ahora - t < ventana);
    // Se tiran sólo los vencidos: vaciarlo entero le reiniciaba el tope a quien lo estaba gastando.
    if (_visto.size > 5000) for (const [k, v] of _visto) if (!v.some((t) => ahora - t < ventana)) _visto.delete(k);
    if (prev.length >= tope) {
      console.log(`[Público] tope de ${nombre} desde ${ip}`);
      return res.status(429).json({ ok: false, error: 'Demasiados pedidos seguidos. Probá de nuevo en unos minutos.' });
    }
    prev.push(ahora); _visto.set(clave, prev);
    return next();
  };
}

module.exports = { porIp };
