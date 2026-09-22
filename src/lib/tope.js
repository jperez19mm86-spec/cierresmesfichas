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
    const ip = String(req.ip || (req.headers && req.headers['x-forwarded-for']) || 'x').split(',')[0].trim();
    const clave = nombre + ':' + ip;
    const ahora = Date.now(); const ventana = ventanaMin * 60 * 1000;
    const prev = (_visto.get(clave) || []).filter((t) => ahora - t < ventana);
    if (_visto.size > 5000) _visto.clear();            // no crece para siempre
    if (prev.length >= tope) {
      console.log(`[Público] tope de ${nombre} desde ${ip}`);
      return res.status(429).json({ ok: false, error: 'Demasiados pedidos seguidos. Probá de nuevo en unos minutos.' });
    }
    prev.push(ahora); _visto.set(clave, prev);
    return next();
  };
}

module.exports = { porIp };
