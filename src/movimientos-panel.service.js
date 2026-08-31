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
const telegram = require('./telegram');
const tgDestino = require('./telegram-destino');
const config = require('./config-store');

/**
 * Todo lo que hay que comprobar ANTES de tocar el casino.
 * Se hace en el servidor y no en la pantalla: esconder un botón no impide postear a la ruta.
 *
 * ── DEVUELVE DOS TEXTOS, Y ESO NO ES UN CAPRICHO ─────────────────────────────────────────────
 * `interno` es el que lee la dueña: dice todo, con nombres de paneles y de plataformas. `publico`
 * es el que se le puede contestar al cliente en la ruta pública.
 *
 * Antes era un solo string y se le devolvía tal cual al cliente. El del caso de sistemas distintos
 * decía «"juanito01" es de Casino y "juanito02" de Europa» — o sea, le mandaba a qué plataforma
 * pertenece cada panel, que es control interno y que el resto del sistema se cuida de no mandarle
 * (por eso la pantalla del cliente recibe un `grupo` opaco y no el nombre del sistema).
 *
 * Separarlo en dos campos hace que el día que se agregue un motivo nuevo haya que elegir a
 * propósito qué se le dice al cliente, en vez de que nazca filtrando por defecto.
 */
function revisar(m) {
  const no = (interno, publico) => ({ interno, publico: publico || interno });
  const cli = clientes.get(m.cliente_id);
  if (!cli) return no('el cliente ya no existe');
  // El permiso se mira acá, en el momento de mover. Mirarlo sólo al pedir dejaría pasar un pedido
  // viejo de alguien a quien después se le sacó el permiso.
  if (!cli.mover_balance) {
    return no(`"${cli.nombre || cli.codigo}" no tiene habilitado mover balance`,
      'tu cuenta no tiene habilitado mover fichas entre usuarios');
  }

  const o = paneles.get(m.origen_panel_id);
  const d = paneles.get(m.destino_panel_id);
  if (!o) return no('el panel de origen ya no existe', 'ese usuario ya no está');
  if (!d) return no('el panel de destino ya no existe', 'ese usuario ya no está');
  if (String(o.cliente_id) !== String(m.cliente_id)) return no(`el panel "${o.nombre}" no es de ese cliente`, 'ese usuario no es tuyo');
  if (String(d.cliente_id) !== String(m.cliente_id)) return no(`el panel "${d.nombre}" no es de ese cliente`, 'ese usuario no es tuyo');
  if (!o.id_usuario) return no(`el panel "${o.nombre}" no tiene el id del casino cargado`, 'ese usuario no está terminado de configurar');
  if (!d.id_usuario) return no(`el panel "${d.nombre}" no tiene el id del casino cargado`, 'ese usuario no está terminado de configurar');

  /* ── PASAR DE UNA PLATAFORMA A LA OTRA ──────────────────────────────────────────────────
     Casino y Europa son dos instalaciones separadas y una ficha de una no existe en la otra: no
     hay ninguna llamada que la cruce. Lo que sí se puede es sacarla de un lado y ponerla del
     otro, que son DOS operaciones y no un traslado. `ejecutar()` ya lo hace así (plan.cruce): dos
     sesiones, se comprueba que el destino pueda recibir ANTES de sacar nada, y los dos tramos por
     separado.

     ANTES ESTO SE RECHAZABA cuando lo pedía el cliente, y sólo lo originaba ella con el botón del
     panel. Ya no: el cliente PIDE y ella APRUEBA, que es el mismo camino que el resto de los
     movimientos. La decisión sigue siendo de ella —el pase le mueve saldo de una cuenta suya a la
     otra— pero ahora la toma aprobando en vez de teniendo que armar el pedido a mano.

     El cliente sigue sin enterarse de que hay dos plataformas: elige dos usuarios suyos y ya. Es
     la pantalla de ella la que marca el cruce, porque es la única que tiene que verlo. */
  // Y misma divisa habilitada en los dos. Si el destino no la tiene, la carga falla DESPUÉS del
  // retiro — o sea con las fichas ya afuera. Barato comprobarlo antes.
  const tiene = (p) => !Array.isArray(p.divisas) || !p.divisas.length || p.divisas.includes(m.divisa);
  if (!tiene(o)) return no(`el panel "${o.nombre}" no tiene habilitada la divisa ${m.divisa}`, `ese usuario no maneja ${m.divisa}`);
  if (!tiene(d)) return no(`el panel "${d.nombre}" no tiene habilitada la divisa ${m.divisa}`, `ese usuario no maneja ${m.divisa}`);
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
  /* Lo aprueba ella desde el panel, así que el pase entre plataformas está permitido acá. El
     bloqueo sigue en pie para el pedido público del cliente, que es donde no corresponde. */
  const mal = revisar(m0);
  if (mal) return { ok: false, status: 400, error: mal.interno };

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
  // Queda anotado como VIVO mientras dure, incluido el rato que pasa haciendo cola. Es lo que
  // impide que alguien lo "destrabe" y termine ejecutándolo dos veces.
  store.marcarEnCurso(id);

  try {
    // Se RETOMA lo guardado si la cadena es la misma. Si el árbol cambió entre un intento y otro,
    // los pasos viejos ya no describen el camino: se corta en vez de mezclar dos caminos distintos.
    const guardados = store.pasosDe(id);
    let pasos = plan.pasos;
    if (guardados) {
      /* ⚠️ SE COMPARA TAMBIÉN LA PLATAFORMA. Los ids de usuario salen de una secuencia propia de
         cada instalación y pueden coincidir: dos pasos "id 5501, in" de plataformas distintas
         comparan iguales, y darlos por el mismo es saltearse una pata entera de la cadena. */
      const misma = guardados.length === plan.pasos.length
        && guardados.every((p, i) => String(p.id) === String(plan.pasos[i].id)
          && p.op === plan.pasos[i].op
          && String(p.sistema || '') === String(plan.pasos[i].sistema || ''));
      if (!misma) {
        store.soltar(id, 'el árbol del casino cambió desde el intento anterior');
        return { ok: false, status: 409, quedoAMedias: true,
          error: 'El camino entre los dos paneles cambió desde el intento anterior, y hay pasos ya '
            + 'hechos con el camino viejo. No se sigue solo: mirá los saldos y resolvelo a mano.' };
      }
      pasos = guardados;
    }

    /* ── LAS DOS SESIONES ────────────────────────────────────────────────────────────────
       Un pase corre contra DOS instalaciones, así que hace falta una sesión por plataforma. Se
       entra a las dos ANTES de mover una ficha: descubrir que no se puede entrar a la segunda con
       las fichas ya afuera del panel del cliente es exactamente el estado que hay que evitar. */
    const sesiones = {};
    const sistemas = plan.cruce ? [origen.sistema, destino.sistema] : [origen.sistema];
    for (const nom of sistemas) {
      const sy = sistemaParaCargar(nom);
      if (!sy || !sy.password) {
        store.soltar(id, `no hay con qué operar en ${nom}`);
        return { ok: false, status: 400, error: `no hay con qué operar en "${nom}": marcá una conexión con "carga fichas de ${nom}" y con contraseña guardada` };
      }
      // eslint-disable-next-line no-await-in-loop
      const t = await casino.testConnection(sy.url, sy.user, sy.password);
      if (!t.ok || !t.sessionCookie) {
        store.soltar(id, `no se pudo autenticar contra ${nom}`);
        return { ok: false, status: 502, error: `no se pudo entrar al panel de ${nom} — revisá usuario y contraseña de esa conexión` };
      }
      sesiones[nom] = { url: sy.url, cookie: t.sessionCookie };
    }

    /* ¿Puede recibir el destino? Antes de sacar una sola ficha. Sólo si NO se empezó todavía:
       retomando uno a medias, la mitad de arriba ya salió y frenar acá no arregla nada. */
    if (plan.cruce && !pasos.some((x) => x.estado === 'ok')) {
      const noPuede = await destinoPuedeRecibir({
        plan, sys: sistemaParaCargar(destino.sistema), monto: m0.monto, divisa: m0.divisa, log });
      if (noPuede) {
        store.soltar(id, 'el destino no tenía saldo');
        return { ok: false, status: 400, error: noPuede };
      }
    }

    log(`[Mover] ${id}: ${m0.monto} ${m0.divisa}${plan.cruce ? ' · PASE ' + origen.sistema + '→' + destino.sistema : ''} · ${plan.pasos.map((p) => `${p.op}(${p.login})`).join(' → ')}`);

    /* ── EL PASE, EN DOS TRAMOS ──────────────────────────────────────────────────────────
       Cada mitad corre contra su plataforma. El orden —primero sacar, después poner— NO es un
       detalle: si se pusiera primero y se cortara, el cliente se quedaría con las fichas de
       regalo y ninguna pantalla lo diría. Sacando primero, si se corta el cliente queda corto y
       las fichas están en el SuperAgente de origen, que es un lugar real y con saldo visible.
       Un tramo que ya está entero en 'ok' no se vuelve a correr: por eso reintentar no repite el
       retiro. */
    const tramos = plan.cruce
      ? [{ sis: origen.sistema, desde: 0, hasta: plan.pasos.findIndex((x) => x.op === 'in') },
        { sis: destino.sistema, desde: plan.pasos.findIndex((x) => x.op === 'in'), hasta: plan.pasos.length }]
      : [{ sis: origen.sistema, desde: 0, hasta: plan.pasos.length }];

    let r = { ok: true, pasos };
    for (const tr of tramos) {
      const trozo = pasos.slice(tr.desde, tr.hasta);
      if (!trozo.length || trozo.every((x) => x.estado === 'ok')) continue;   // ya está hecho
      const se = sesiones[tr.sis];
      // eslint-disable-next-line no-await-in-loop
      const rt = await cascada.ejecutar({
        url: se.url, sessionCookie: se.cookie, monto: m0.monto, divisa: m0.divisa,
        pasos: trozo,
        serie: `${tr.sis}|${tr.desde === 0 ? plan.superagenteId : plan.superagenteDestinoId}`, log,
        // Después de CADA paso, no al final: si el proceso se muere, lo ya movido tiene que estar
        // escrito o el reintento lo repite. Se guarda la lista ENTERA, con el tramo puesto en su
        // lugar, para que al retomar se sepa qué mitad ya salió.
        onPaso: (hechos) => {
          hechos.forEach((h, k) => { pasos[tr.desde + k] = h; });
          store.guardarPasos(id, pasos);
        },
      });
      (rt.pasos || []).forEach((h, k) => { pasos[tr.desde + k] = h; });
      store.guardarPasos(id, pasos);
      if (!rt.ok) { r = { ...rt, pasos, trabadoEn: rt.trabadoEn }; break; }
      r = { ok: true, pasos, newBalance: rt.newBalance };
    }

    if (!r.ok) {
      store.soltar(id, r.error || 'la cadena se cortó');
      const donde = dondeEstan(plan, pasos, origen, destino);
      return { ok: false, status: 502, quedoAMedias: pasos.some((x) => x.estado === 'ok'),
        error: `El movimiento se cortó: ${r.error || 'el casino no confirmó un paso'}. ${donde} `
          + 'Reintentar retoma desde el paso que falló — los que ya salieron no se repiten.' };
    }

    const fin = store.marcarHecho(id, { pasos: r.pasos || null, at: new Date().toISOString() }, por);
    log(`[Mover] ${id}: HECHO`);
    avisarAlGrupo({ m: m0, origen, destino, log });
    return { ok: true, movimiento: fin };
  } catch (e) {
    store.soltar(id, String((e && e.message) || e));
    return { ok: false, status: 500, error: String((e && e.message) || e) };
  } finally {
    // Pase lo que pase deja de estar vivo. Si esto no se limpiara, un movimiento que falló quedaría
    // imposible de destrabar hasta reiniciar.
    store.quitarEnCurso(id);
  }
}

/**
 * DÓNDE ESTÁN LAS FICHAS AHORA. Es lo único que importa cuando algo se cortó.
 *
 * ⚠️ ANTES ESTE TEXTO MENTÍA, y en un pase la mentira cuesta encontrar la plata. Decía «quedaron
 * en X» nombrando el último paso que salió bien — pero un `out(X)` que salió bien mandó las fichas
 * al PADRE de X, no las dejó en X. Un `in(X)` sí las deja ahí.
 */
function dondeEstan(plan, pasos, origen, destino) {
  const ok = pasos.filter((x) => x.estado === 'ok');
  if (!ok.length) return 'No se movió nada: siguen donde estaban.';
  const ult = ok[ok.length - 1];
  if (ult.op === 'in') return `Quedaron en "${ult.login}".`;
  // Fue un retiro: subieron un escalón. En un pase, ese escalón es el SuperAgente de origen.
  const idx = pasos.indexOf(ult);
  const arriba = pasos.slice(0, idx).reverse().find((x) => x.op === 'out');
  const donde = arriba ? arriba.login : (plan.apoyoOrigen ? plan.apoyoOrigen.login : null);
  return donde
    ? `Salieron de "${ult.login}" y quedaron en "${donde}"${plan.cruce ? ` (${origen.sistema})` : ''}. `
      + 'Ahí las podés ver mirando su saldo.'
    : `Salieron de "${ult.login}".`;
}

/**
 * ¿PUEDE RECIBIR EL DESTINO? Se pregunta ANTES de sacar una sola ficha.
 *
 * En un pase las dos mitades son independientes: si la de abajo no puede correr, la de arriba ya
 * dejó al cliente corto. Descubrirlo antes convierte «quedó a medias» en «no se pudo», que es un
 * problema mucho más barato. Devuelve el motivo si NO se puede, o null si está bien.
 *
 * Si no se puede leer el saldo, NO se frena: el pase sigue. Un chequeo de más que se cae solo no
 * puede convertirse en un motivo para no trabajar; lo que hace es sacar el caso conocido.
 */
async function destinoPuedeRecibir({ plan, sys, monto, divisa, log = () => {} }) {
  if (!plan.cruce || !plan.apoyoDestino || !sys || !sys.id) return null;
  try {
    const cli = require('./casino-conexiones-store').client(sys.id);
    if (!cli) return null;
    const r = await cli.totalNodo({ id: plan.apoyoDestino.id, cur: divisa });
    const saldo = r && r.ok ? Number(r.balance != null ? r.balance : r.total) : NaN;
    if (!isFinite(saldo)) return null;
    log(`[Mover] saldo de ${plan.apoyoDestino.login}: ${saldo} ${divisa}`);
    if (saldo >= Number(monto)) return null;
    return `"${plan.apoyoDestino.login}" tiene ${saldo.toLocaleString('es-AR')} ${divisa} y hacen falta `
      + `${Number(monto).toLocaleString('es-AR')}. No se sacó nada del origen: cargale saldo y volvé a intentar.`;
  } catch (e) { log(`[Mover] no se pudo leer el saldo del destino: ${e.message}`); return null; }
}

/**
 * Le avisa al grupo de Telegram del cliente que las fichas se movieron.
 *
 * SÓLO cuando el movimiento terminó entero. Uno que quedó a medias no se avisa: el cliente vería
 * "fichas movidas" con las fichas todavía en el camino, y eso es peor que no decir nada.
 *
 * Va al mismo grupo y con el mismo interruptor que los avisos de carga —heredando del vendedor si
 * el cliente no tiene el suyo— porque para el cliente es la misma conversación. Y es
 * fire-and-forget: que Telegram no conteste no puede hacer fallar un movimiento que YA se hizo.
 */
function avisarAlGrupo({ m, origen, destino, log = () => {} }) {
  try {
    const cli = clientes.get(m.cliente_id);
    const tok = config.getTelegramToken();
    const dest = cli ? tgDestino.destinoDe(cli, (id) => clientes.get(id)) : { chatId: null };
    if (!cli || !dest.chatId || !dest.enabled || !tok) return;
    telegram.sendMessage(tok, dest.chatId, telegram.movimientoText({
      origen: origen.nombre, destino: destino.nombre, divisa: m.divisa, monto: m.monto,
    })).then((tr) => { if (!tr.ok) log(`[Telegram] aviso de movimiento falló: ${tr.error}`); })
      .catch((e) => log(`[Telegram] aviso de movimiento error: ${e.message}`));
  } catch (e) { log(`[Telegram] aviso de movimiento error: ${e.message}`); }
}

module.exports = { ejecutar, revisar, dondeEstan, destinoPuedeRecibir };
