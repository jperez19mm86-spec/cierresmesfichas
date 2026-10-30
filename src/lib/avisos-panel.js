/**
 * avisos-panel.js — LOS PENDIENTES DEL PANEL, AVISADOS EN VEZ DE PREGUNTADOS (30-oct-2026).
 *
 * El panel preguntaba cada 45 segundos —con la pestaña escondida también— cuántos comprobantes,
 * cajas nuevas y movimientos de fichas esperaban, y para el tercero se bajaba la lista entera:
 * ~5.800 pedidos y ~60 MB por día por pestaña abierta, para mostrar tres números.
 *
 * Ahora el panel deja UNA conexión abierta (/api/os/novedades, Server-Sent Events) y el servidor
 * le manda los tres números sólo cuando cambian. Dos cosas lo disparan:
 *  · `cambio()`, que llaman los stores al crear o resolver un pendiente: el aviso sale en el acto.
 *  · Un recuento INTERNO cada 15 s, sólo mientras haya algún panel conectado. Son tres COUNT en la
 *    base, sin salir a internet, y existe por dos motivos: un «trabado» aparece por el reloj
 *    (5 minutos en 'ejecutando') y no por una escritura, y un camino nuevo que se olvide de llamar
 *    a `cambio()` igual termina avisando.
 * Por la red no viaja nada si no cambió nada, salvo una línea vacía cada 25 s para que el proxy
 * no corte la conexión.
 */
const conectados = new Set();
let ultimo = null; let reloj = null; let espera = null;

function contar() {
  const cmp = require('../comprobantes-store'); const sol = require('../solicitudes-caja');
  const mov = require('../movimientos-panel');
  return {
    comprobantes: Number((cmp.cuentas() || {}).pendiente) || 0,
    cajas: Number(sol.pendientes()) || 0,
    movs: Number((mov.counts() || {}).requierenAtencion) || 0,
  };
}

function mandar(res, datos) { try { res.write(`event: pendientes\ndata: ${JSON.stringify(datos)}\n\n`); } catch (e) { /* se fue */ } }

function revisar() {
  if (!conectados.size) return;
  let c; try { c = contar(); } catch (e) { return; }
  const s = JSON.stringify(c);
  if (s === ultimo) return;
  ultimo = s;
  for (const res of conectados) mandar(res, c);
}

/** Algo cambió en los pendientes. Se agrupan los avisos de un mismo instante en uno. */
function cambio() { clearTimeout(espera); espera = setTimeout(revisar, 300); }

/** GET /api/os/novedades: deja la conexión abierta y manda los números de entrada. */
function conectar(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 5000\n\n');
  try { mandar(res, contar()); } catch (e) { /* el primer recuento llega con el próximo cambio */ }
  conectados.add(res);
  const latido = setInterval(() => { try { res.write(': sigo\n\n'); } catch (e) { /* se fue */ } }, 25000);
  if (!reloj) reloj = setInterval(revisar, 15000);
  req.on('close', () => {
    clearInterval(latido); conectados.delete(res);
    if (!conectados.size) { clearInterval(reloj); reloj = null; ultimo = null; }
  });
}

module.exports = { contar, cambio, conectar, _conectados: () => conectados.size };
