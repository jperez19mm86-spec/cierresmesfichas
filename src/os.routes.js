/**
 * os.routes.js — endpoints del núcleo comercial/financiero (LATAM Games OS v3).
 * Se montan DESPUÉS del gate de auth de la MATRIZ (todo /api/os/* requiere sesión de admin).
 * mount(app) también siembra split_base y arranca el scheduler de TC.
 * Desde la fase 2 las rutas viven partidas por tema en src/rutas/ (lo compartido, en
 * src/rutas/comun.js). Acá quedan el arranque, y el orden en que se montan los sectores.
 */
const splitBase = require('./split-base-store');
const historial = require('./historial');
const tcSvc = require('./tc.service');
const tcDivisas = require('./tc-divisas.service');
const tcColumna = require('./tc-columna.service');
const tbsDiarioSvc = require('./tbs-diario.service');
const acumSvc = require('./acumulado.service');
const ofertas = require('./api-ofertas-store');
const chat = require('./chat-externo.store');

/* Las rutas, partidas por tema en src/rutas/ (fase 2). El orden importa: Express atiende con la
   primera que coincide, y cada archivo conserva el orden que tenían sus rutas acá. */
const SECTORES = [
  require('./rutas/ajustes.routes'),
  require('./rutas/clientes.routes'),
  require('./rutas/cuenta.routes'),
  require('./rutas/cambios.routes'),
  require('./rutas/cierre.routes'),
  require('./rutas/proveedores.routes'),
  require('./rutas/reparto.routes'),
  require('./rutas/casino.routes'),
  require('./rutas/api-tbs.routes'),
];

/* EL CHAT EXTERNO NO PUEDE TIRAR EL OS. Es otro producto que vive en el mismo servidor: si su
   archivo de rutas no carga (un error al cambiarlo), antes no arrancaba NADA. Ahora se carga
   aparte y, si falla, el OS arranca igual y sólo las pantallas del chat contestan que no está.
   Ojo: el store del chat (chat-externo.store) sí es parte del OS —la emisión, la ficha y la
   cuenta lo usan para cobrar el servicio—, así que ése no se puede apagar sin apagar la cobranza. */
const RUTAS_DEL_CHAT = ['/api/os/chat/*', '/api/os/proveedor/*', '/chat-externo'];
function _montarChat(app) {
  try {
    require('./rutas/chat.routes').mount(app);
  } catch (e) {
    console.error('[Chat] no se pudo montar; el resto del OS sigue andando:', e.message);
    const noEsta = (_req, res) => res.status(503).json({ ok: false, error: 'El chat no está disponible en este momento. El resto del sistema anda.' });
    for (const r of RUTAS_DEL_CHAT) app.all(r, noEsta);
  }
}

function mount(app) {
  splitBase.seedIfEmpty();
  // Los paquetes de la oferta comercial, una sola vez. Si ya hay alguno no se toca nada.
  try { ofertas.sembrarPaquetes(); } catch (e) { console.warn('[Ofertas] no se pudieron sembrar:', e.message); }
  historial.repararTramosDadosVuelta();   // tramos que quedaron al revés por el bug de setVigencia
  tcSvc.startScheduler();
  tcDivisas.startScheduler();
  tcColumna.startScheduler();
  acumSvc.startCron();
  // TBS tiene su propio cron y su propia hora: corta los días en la zona del panel (GMT+2), no en
  // la nuestra. Pedirle "ayer" según la hora argentina traería un día que allá no terminó.
  tbsDiarioSvc.startCron();
  /* El recordatorio del chat externo: una vez por día le dice a ELLA qué cuentas quedaron cobradas
     y sin mandar. No le manda nada a ningún cliente — eso lo sigue apretando ella. */
  try { require('./chat-avisos.service').startCron(); } catch (e) { console.error('[ChatAvisos] no arrancó el recordatorio:', e.message); }
  /* EL MANTENIMIENTO SE DEVENGA SOLO. Se paga por TENER el servicio, así que apenas arranca el
     período ya es plata que el cliente debe: esperar a que alguien apretara un botón hacía que
     entrara a su portal y viera "estás al día" debiendo un mes. Cada media hora se pone al día y
     además se llama al abrir la pantalla y el portal, por si el proceso estuvo caído: es
     idempotente, la llave (cliente, caja, fecha) impide repetir. */
  const _devengar = () => {
    try {
      const r = chat.devengarMensualidades();
      if (r.creadas) console.log(`[Chat] ${r.creadas} mantenimiento(s) devengado(s)`);
    } catch (e) { console.warn('[Chat] devengar:', e.message); }
  };
  setTimeout(_devengar, 20 * 1000);
  setInterval(_devengar, 30 * 60 * 1000);

  for (const s of SECTORES) s.mount(app);
  _montarChat(app);   // último, como siempre, y sin poder tirar a los demás

  console.log('[OS] rutas comerciales/financieras montadas (/api/os/*)');
}

module.exports = { mount };
