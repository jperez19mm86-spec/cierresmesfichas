/**
 * caja.routes.js — los endpoints de MI CAJA.
 *
 * El navegador NO le habla al motor: las cookies del casino son de otro dominio y el api_token no
 * puede viajar al cliente. Así que estos endpoints son el pasamanos — reciben "dame los jugadores
 * de esta caja" y por dentro llaman al motor con las credenciales que corresponden.
 *
 * 🔴 Todo lo de acá está calibrado con lo MEDIDO contra producción (ver MAPEO-MOTOR.md). Las
 *    trampas que se neutralizan en este archivo:
 *      · los parámetros de `dashboardinfo` y `reportstable` van en la QUERY, no en el cuerpo
 *      · `limit` sólo acepta [50,100,200,500,1000]: cualquier otro cae a 50 EN SILENCIO
 *      · `sum` de balance es de la PÁGINA, no del período → los totales salen de `footer`
 *      · `area=users` filtra por HOY y por activos si no se le dice lo contrario
 *      · la lista de usuarios trae una fila de totales con id vacío, que no es una cuenta
 *      · el motor puede contestar un HTML de error con HTTP 200
 */
const auth = require('./caja-auth');
const { aplanar: aplanarAjustes } = require('./caja-token');

/* Los únicos `limit` que el motor respeta. Pedir otro devuelve 50 sin avisar. */
const LIMITES = [50, 100, 200, 500, 1000];
const limiteValido = (n) => {
  const q = Number(n) || 0;
  return LIMITES.includes(q) ? q : LIMITES.reduce((a, b) => (b <= q && b > a ? b : a), 50);
};

/* El motor devuelve HTML de error con status 200. Sin esto, un JSON.parse rompe el endpoint. */
const esJson = (r) => r && r.ok && r.data && typeof r.data === 'object';

/* La fila de totales viene mezclada con las cuentas: id vacío. Nunca es un usuario. */
const sinFilaTotal = (filas) => (filas || []).filter((x) => x && x.id !== '' && x.id != null);

const hoy = () => new Date().toISOString().slice(0, 10);
/* 🔴 EL SALDO DE UNA FILA DE `users` VIVE EN `balances`, NO EN `balance`. El motor manda
   `balances: { ARS: "1000.00" }` — un objeto por moneda, y el número como texto. Leerlo como
   `fila.balance` da `undefined`, que en JavaScript se convierte en 0 sin quejarse.
   Ahí estaba el error que reportó Sarah el 4-sep-2026: creó un jugador con 1.000 y la pantalla
   le dijo «Le pediste 1.000 y quedó con 0». Las fichas SÍ estaban en el jugador; lo que estaba
   mal era la lectura, y el aviso salía en TODA alta con saldo inicial, siempre. */
const saldoDeFila = (fila) => {
  const b = fila && fila.balances && Object.values(fila.balances)[0];
  return Number(String(b == null ? 0 : b).replace(/[^\d.-]/g, '')) || 0;
};

const rango = (q) => ({
  from: `${q.desde || hoy()} 00:00:00`,
  to: `${q.hasta || hoy()} 23:59:59`,
});

function mount(app) {
  const ok = (res, datos) => res.json({ ok: true, ...datos });
  const mal = (res, error, code = 400) => res.status(code).json({ ok: false, error });
  /* Un error del motor no es un 500 nuestro: se lo cuenta como lo que es. */
  const delMotor = (res, r) => mal(res, r.error || 'el casino no respondió como se esperaba', 502);
  /* 🔴 `intersections` y `changes` NO responden al api_token: dan «No rights» o vienen vacías.
     Si la sesión del motor se cayó, estas dos pantallas dejan de andar aunque el resto siga
     funcionando con token. Hay que decirlo con esas palabras, no con un 502 pelado. */
  const soloConSesion = (res, r) => {
    if (r && /no rights|wrong user/i.test(String(r.error || ''))) {
      return res.status(409).json({ ok: false, relogin: true,
        error: 'Esta pantalla necesita tu contraseña del casino. Volvé a entrar para verla.' });
    }
    return delMotor(res, r);
  };
  const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => {
    console.error('[caja]', e && e.message);
    mal(res, 'error interno', 500);
  });

  /* ══════ entrar y salir ══════ */

  /* La credencial que aprovisiona: una sola, por encima de todos los clientes. Se arma una vez.
     Sin ella el panel igual anda — cada cliente trabaja con su sesión, que caduca. */
  const { makeClient } = require('../casino-api');
  const raiz = process.env.CASINO_ROOT_TOKEN
    ? makeClient({ url: process.env.CASINO_URL, token: process.env.CASINO_ROOT_TOKEN })
    : null;
  if (!raiz) console.warn('[caja] sin CASINO_ROOT_TOKEN: los clientes van a trabajar con sesión');

  app.post('/api/caja/login', wrap(async (req, res) => {
    const b = req.body || {};
    const r = await auth.entrar({
      url: process.env.CASINO_URL,
      user: String(b.usuario || '').trim(),
      password: String(b.clave || ''),
      raiz,
      /* 🔴 Generar invalida el token anterior del cliente. Por defecto NO se genera: si no tiene,
         se trabaja con su sesión y se avisa. Encenderlo es una decisión, no un accidente. */
      generar: process.env.CASINO_GENERAR_TOKEN === '1',
    });
    if (!r.ok) return mal(res, r.error, 401);
    auth.ponerCookie(res, r.sesion.sid);
    /* Con el saldo adentro: el panel ya no necesita preguntarlo por separado para arrancar. */
    ok(res, { yo: { ...auth.publica(r.sesion), balance: r.sesion.balanceInicial } });
  }));

  app.post('/api/caja/logout', (req, res) => { auth.salir(req); auth.borrarCookie(res); ok(res, {}); });

  /* 🔴 El saldo NO se guarda en la sesión: cambia con cada carga y cada retiro. Se pregunta al
     motor cada vez —`info` es la llamada más barata que tiene— y así la cabecera nunca miente.
     Viene como `main.balance` (número) y `main.currency` (string), medido el 27-ago. */
  app.get('/api/caja/yo', auth.requerida, wrap(async (req, res) => {
    const base = auth.publica(req.caja);
    const cli = auth.clienteDe(req.caja);
    const r = await cli.apiCall('info');
    const m = (esJson(r) && r.data.main) || null;
    if (!m) return ok(res, { yo: { ...base, balance: null, saldoIncierto: true } });
    ok(res, { yo: { ...base, balance: Number(m.balance) || 0, moneda: m.currency || base.moneda } });
  }));

  /* ══════ el menú lo dicta el motor, no nosotros ══════ */

  app.get('/api/caja/acciones', auth.requerida, wrap(async (req, res) => {
    const cli = auth.clienteDe(req.caja);
    const r = await cli.apiCall('buttons', {}, { id: req.query.id || req.caja.id });
    if (!esJson(r)) return delMotor(res, r);
    ok(res, { acciones: r.data.buttons || [] });
  }));

  /* ══════ las cuentas que cuelgan de un nodo ══════ */

  app.get('/api/caja/cuentas', auth.requerida, wrap(async (req, res) => {
    const cli = auth.clienteDe(req.caja);
    const q = req.query;
    /* 🔴 Sin esto el motor devuelve sólo los que se movieron HOY y están activos: en una caja de
       1.851 jugadores eso son 39. El cliente concluye que le borraron la cuenta. */
    /* 🔴 `offset` y `search` van en la QUERY, no en el cuerpo. Medido el 27-ago: mandados en el
       body el motor los ignora — las cuatro páginas devolvían las mismas 500 filas y la búsqueda
       no filtraba nada. En la query, `offset=2` trae la página 2 y `search` devuelve 1 fila.
       Es el mismo patrón de `dashboardinfo` y `reportstable`. */
    const r = await cli.apiCall('users', {
      /* Mismo motivo que arriba: el rango largo cuesta segundos y no cambia los saldos. */
      ...(q.desde ? { from: `${q.desde} 00:00:00`, to: `${q.hasta || hoy()} 23:59:59` } : rangoBarato()),
      inactive_users: 'all',
      deleted_users: q.eliminados === '1' ? 'delete' : 'undelete',
      limit: String(limiteValido(q.limite || 200)),
    }, {
      id: q.id || req.caja.id,
      offset: String(q.pagina || 1),
      ...(q.buscar ? { search: String(q.buscar) } : {}),
    });
    if (!esJson(r)) return delMotor(res, r);
    let filas = sinFilaTotal(r.data.users);
    /* 🔴 «BUSCAR» TIENE QUE BUSCAR. El motor ignora `search` cuando abajo hay CAJEROS —medido el
       4-sep-2026: sobre una caja filtra 1 de 5, sobre la raíz de un agente devuelve las cuatro
       igual, y ningún otro nombre de parámetro cambia nada—. Así que devolvía la lista entera como
       si fuera el resultado de la búsqueda. Se filtra acá sobre lo que vino: dentro de la página es
       exacto, y es lo único honesto que se puede hacer sin recorrer todo el árbol. */
    if (q.buscar) {
      const aguja = String(q.buscar).toLowerCase();
      filas = filas.filter((f) => `${f.login || ''} ${f.name || ''}`.toLowerCase().includes(aguja));
    }
    ok(res, {
      cuentas: filas,
      /* ⚠️ Al buscar, `pageCount` NO se actualiza: sigue diciendo el total sin filtro. */
      paginas: q.buscar ? null : (r.data.pageCount || 1),
      rango: { desde: r.data.config && r.data.config.from, hasta: r.data.config && r.data.config.to },
    });
  }));

  /* ══════ movimientos de fichas ══════ */

  app.get('/api/caja/movimientos', auth.requerida, wrap(async (req, res) => {
    const cli = auth.clienteDe(req.caja);
    const q = req.query;
    const r = await cli.apiCall('balance', {
      ...rango(q),
      balance_type: q.tipo || 'usual:players',
      limit: String(limiteValido(q.limite || 200)),
      offset: String(q.pagina || 1),
    }, { id: q.id || req.caja.id });
    if (!esJson(r)) return delMotor(res, r);
    const filas = r.data.operationsData || [];
    ok(res, {
      movimientos: filas,
      paginas: r.data.pageCount || 1,
      /* 🔴 `sum` es de ESTA página, no del período. Se devuelve con su nombre honesto para que
         nadie lo muestre como total: el total del período sale de /resumen. */
      subtotalDeEstaPagina: r.data.sum || null,
      parcial: (r.data.pageCount || 1) > 1,
    });
  }));

  /* ══════ la matriz de una ronda ══════
     🔴 EL MOTOR SÍ LA DA, Y YO DIJE QUE NO. El 4-sep-2026 contesté que no se podía porque la lista
     de sesiones trae 21 campos y ninguno es la grilla. Era cierto de ESA llamada, y yo nunca probé
     la de adentro. El dueño abrió el panel del casino y ahí estaba, un `[LOG]` por ronda.

     🔑 Es la MISMA área `history`, con un parámetro más: `session`. Y va el campo `id` de la
        sesión, NO el campo `session` —que es un hash y devuelve la respuesta vacía—. Con el `id`
        vuelve `history` con una fila por ronda y, en cada una, `matrix` y `winLines`.

     `winLines` llega como TEXTO con JSON adentro; se parsea acá para que la pantalla no tenga que
     saberlo. Trae lo único que importa para entender un pago: qué símbolo, cuántos, en qué celdas
     y cuánto pagó. */

  app.get('/api/caja/ronda', auth.requerida, wrap(async (req, res) => {
    const q = req.query;
    if (!q.jugador) return mal(res, 'falta el jugador');
    if (!q.sesion) return mal(res, 'falta la sesión');
    const cli = auth.clienteDe(req.caja);
    const r = rango(q);
    const d = await cli.apiCall('history', {}, {
      id: String(q.jugador), session: String(q.sesion),
      from: r.from, to: r.to,
      limit: String(limiteValido(q.limite || 200)), offset: String(q.pagina || 1),
    });
    if (!esJson(d)) return delMotor(res, d);
    /* Sin `session` válido el motor contesta sin `history`: no es un error, es «no hay detalle». */
    if (!d.data.history) return ok(res, { rondas: [], sinDetalle: true });

    const comoJson = (t) => {
      if (t == null || t === '') return null;
      if (typeof t === 'object') return t;
      try { return JSON.parse(t); } catch (e) { return null; }
    };
    ok(res, {
      rondas: (d.data.history || []).map((f) => ({
        id: String(f.id), estado: f.status, cuando: f.dateTime,
        antes: f.before, apostó: f.bet, ganó: f.win,
        juego: f.gameName, proveedor: f.gameProvider,
        /* 🔴 NO TODAS LAS RONDAS SE VEN IGUAL. Señalado por el dueño el 4-sep-2026: «no siempre
           se ve igual, no todos llevan imágenes». El motor declara una `class` por proveedor
           —`slot` es la que medimos— y hay rondas sin grilla ninguna (una apuesta sin premio, o
           un juego que no la manda). Se pasa la grilla SI VIENE y se pasa la forma que el motor
           declaró, para que la pantalla dibuje lo que hay en vez de suponer. */
        matriz: (f.matrix && Array.isArray(f.matrix.matrix) && f.matrix.matrix.length)
          ? f.matrix.matrix : null,
        forma: (f.matrix && f.matrix.class) || null,
        lineas: comoJson(f.winLines) || [],
        info: comoJson(f.info),
      })),
      paginas: d.data.pageCount || 1,
    });
  }));

  /* ══════ el tablero ══════ */

  app.get('/api/caja/resumen', auth.requerida, wrap(async (req, res) => {
    const cli = auth.clienteDe(req.caja);
    const q = req.query;
    /* 🔴 NUNCA se usa `type: day|week|month` a secas. Medido el 27-ago: el motor NO los calcula
       contra hoy sino contra el `from`/`to` que quedó pegado en la sesión — pidiendo «week» un
       jueves 27 devolvió del 20 al 25, y «month» del 28-jul al 25-ago. El rótulo del panel decía
       otra cosa y los números eran de otros días, sin ningún aviso.
       Con `custom_range` y fechas explícitas el motor obedece, y lo que se muestra coincide con
       lo que dice el encabezado. */
    const paneles = ['summary_stats', 'combined', 'active_players', 'active_halls'];
    const r = rango(q);
    const desde = r.from.slice(0, 10);
    const hasta = r.to.slice(0, 10);
    const pedido = {};
    for (const p of paneles) {
      pedido[p] = {
        period: { type: 'custom_range', start_date: desde, end_date: hasta },
        currency: req.caja.moneda || 'ARS',
      };
    }
    /* 🔴 `dashboards` va en la QUERY con el cuerpo VACÍO. Mandado en el body el motor lo ignora
       y contesta todo en cero con gráficos de las últimas 24 h — parece roto y no lo está. */
    const resp = await cli.apiCall('dashboardinfo', {}, {
      id: q.id || req.caja.id,
      dashboards: JSON.stringify(pedido),
    });
    if (!esJson(resp)) return delMotor(res, resp);
    const charts = resp.data.charts || {};

    /* 🔴 A UN SUB-AGENTE EL MOTOR LE CONTESTA TODO EN CERO. Medido el 2-sep-2026: el agente ve
       13 jugadores y el sub-agente 0, en su propio nodo Y en la caja que sí tiene habilitada. No
       es un permiso mal puesto: el casino no calcula este panel para ese nivel.
       Por eso a ese nivel la pantalla directamente no existe (ver `MENU_POR_NIVEL` en
       caja-logica.js). Se llegó a calcularla sumando sus cajas, y se dio de baja: costaba una
       consulta más por visita para sostener algo que el casino no sostiene. */
    ok(res, {
      paneles: charts,
      /* Lo que se pidió, para que el panel pueda comparar con lo que muestra. */
      rango: { desde, hasta },
      rangoDelMotor: resp.data.config || null,
    });
  }));

  /* ══════ estadísticas ══════ */


  /* ══════ EL EJE DE DINERO, ARMADO POR NOSOTROS ══════
     El motor sólo entrega el eje que tenga guardado la plantilla del cliente, y no se puede
     cambiar por API (ver MAPEO-MOTOR.md). Pero el eje de DINERO no hace falta pedírselo: sale de
     los movimientos, que sí podemos leer con la credencial del propio cliente.

     ✅ Verificado el 28-ago contra el informe del motor leído con una credencial en eje dinero:
        cargas 40.820 · retiros 36.716,6 · los 4 jugadores con sus cifras — IDÉNTICO, uno por uno.

     El eje de apuestas NO se puede reconstruir así: `bet`/`win` sólo existen en el informe. */

  async function movimientosDe(cli, nodo, from, to) {
    const filas = [];
    for (let pagina = 1; pagina <= 20; pagina++) {
      const r = await cli.apiCall('balance',
        { from, to, balance_type: 'usual:from', limit: '500', offset: String(pagina) },
        { id: String(nodo) });
      if (!esJson(r)) break;
      const d = r.data.operationsData || [];
      filas.push(...d);
      if (d.length < 500) break;      // última página
    }
    return filas;
  }

  const aNumero = (v) => Number(String(v == null ? 0 : v).replace(/[^\d.-]/g, '')) || 0;
  const dosDec = (n) => Math.round(n * 100) / 100;

  async function ejeDineroArmado(cli, { nodo, fanOut, from, to, agrupar }) {
    /* Un agente parado en su raíz necesita recorrer sus cajas: los movimientos son de cada una
       hacia sus jugadores. Un cajero (o un agente metido en una caja) resuelve con una sola. */
    const fuentes = fanOut.length ? fanOut : [{ id: String(nodo), login: String(nodo) }];
    const porJugador = new Map();
    const porCaja = new Map();

    for (const f of fuentes) {
      const movs = await movimientosDe(cli, f.id, from, to);
      for (const m of movs) {
        const quien = m.user || '(sin nombre)';
        const v = aNumero(m.cash);
        const suma = (mapa, clave, etiqueta) => {
          const e = mapa.get(clave) || { login: etiqueta, id: clave, in: 0, out: 0, count_in: 0, count_out: 0 };
          if (m.operation === 'in') { e.in += v; e.count_in += 1; } else { e.out += v; e.count_out += 1; }
          mapa.set(clave, e);
        };
        suma(porJugador, quien, quien);
        suma(porCaja, String(f.id), f.login || String(f.id));
      }
    }

    /* 🔑 El RTP del eje de dinero es retiros/cargas — comprobado: 40.157,6 / 45.211 = 88,82,
       que es exactamente lo que devuelve el motor. No es el mismo RTP que el de apuestas. */
    const cerrar = (e) => ({
      ...e,
      in: dosDec(e.in), out: dosDec(e.out), profit: dosDec(e.in - e.out),
      rtp: e.in > 0 ? dosDec((e.out / e.in) * 100) : null,
      avg_in: e.count_in ? dosDec(e.in / e.count_in) : 0,
      avg_out: e.count_out ? dosDec(e.out / e.count_out) : 0,
    });

    const filas = [...(agrupar === 'child_users' ? porCaja : porJugador).values()].map(cerrar);
    const bruto = filas.reduce((a, x) => ({
      in: a.in + x.in, out: a.out + x.out, count_in: a.count_in + x.count_in, count_out: a.count_out + x.count_out,
    }), { in: 0, out: 0, count_in: 0, count_out: 0, login: '', id: '' });
    return { filas, total: cerrar(bruto) };
  }


  app.get('/api/caja/estadisticas', auth.requerida, wrap(async (req, res) => {
    const cli = auth.clienteDe(req.caja);
    const q = req.query;
    const r = rango(q);
    const nodo = String(q.id || req.caja.id);
    const tipo = q.tipo === 'on_bets' ? 'on_bets' : 'on_money';
    const campo = q.ordenar || 'profit';
    const orden = q.sentido === 'asc' ? 'asc' : 'desc';
    /* 🔴 Son DOS áreas: `reports` da la configuración y `reportstable` las filas.
       El orden se pide con sort/order — `filter`/`filter_asc` se guardan pero NO ordenan. */
    const tabla = await cli.apiCall('reportstable', {}, {
      id: nodo,
      safe_content: '1',
      from: r.from, to: r.to, search: '',
      sort: campo,
      order: orden,
      offset: '0',                                   // ⚠️ acá arranca en 0, no en 1
      limit: String(limiteValido(q.limite || 1000)),
      statistic_type: tipo,
    });
    if (!esJson(tabla)) return delMotor(res, tabla);

    /* 🔴🔴 «POR APUESTAS» TAMPOCO SE PUEDE PEDIR. `statistic_type` se ignora igual que la
       agrupación: medido el 27-ago en dos nodos, con el token raíz y con el propio, y probando el
       parámetro en la query, en el cuerpo y con otros nombres. Siempre vuelven las columnas de
       dinero (`in`/`out`), nunca `bet`/`win` — aunque `config.statistic_type` ya diga `on_bets`.
       Se detecta mirando los datos, no confiando en lo que pedimos: si vienen con forma de dinero,
       se avisa. Mostrar 0 apostado y 0 ganado sería inventar. */
    const muestra = (tabla.data.rows || []).find((x) => x && x.id) || tabla.data.footer || {};
    const eje = ('bet' in muestra || 'win' in muestra) ? 'apuestas' : 'dinero';
    const ejePedido = tipo === 'on_bets' ? 'apuestas' : 'dinero';

    /* 🔴🔴 «POR CAJA» NO SE PUEDE PEDIR. Medido el 27-ago barriendo `reports_group_by` y
       `reports_base_group_by` con todos sus valores plausibles: NINGUNO cambia nada. El eje lo
       fija QUIÉN PREGUNTA, no el parámetro —
         · la raíz preguntando por el agente  → una fila por CAJERO
         · el agente preguntando por sí mismo → una fila por JUGADOR
       Como el cliente entra con su propia credencial, siempre le tocan jugadores. El rótulo decía
       «una fila por caja» y mostraba jugadores: el número estaba bien y el significado mal.

       Se arma acá: el `footer` de cada cajero ES su total del período. Verificado al centavo contra
       lo que ve la raíz. Cuesta una llamada por cajero, y por eso esta pantalla vive detrás de un
       botón explícito y no se abre sola. */
    /* Se pidió dinero y el motor entregó apuestas: en vez de rendirse, se arma de los
       movimientos. Cuesta una llamada por caja, y por eso vive detrás de un botón explícito. */
    if (tipo === 'on_money' && eje === 'apuestas') {
      let fanOut = [];
      if (req.caja.rol === 'agente' && String(nodo) === String(req.caja.id)) {
        const hijos = await cli.apiCall('users',
          { ...rangoBarato(), limit: '200', inactive_users: 'all', deleted_users: 'undelete' },
          { id: nodo, offset: '1' });
        if (!esJson(hijos)) return delMotor(res, hijos);
        fanOut = sinFilaTotal(hijos.data.users || hijos.data.rows || [])
          .map((c) => ({ id: String(c.id), login: c.login || String(c.id) }));

        /* 🔴 SIN CAJAS NO HAY EJE DE JUGADORES, Y NO SE PUEDE DISIMULAR. Acá abajo, si el fan-out
           queda vacío, `ejeDineroArmado` cae al propio nodo del agente — y `usual:from` sobre la
           raíz de un agente NO son sus jugadores: son sus CAJEROS. La tabla salía igual, con el
           encabezado «Jugador» y un cajero adentro. Reportado el 4-sep-2026: un agente vio una
           sola fila, `GaCajersala`, con 5.100 de cargas y 0 retiros — que es exactamente la
           transferencia que él le había hecho a su cajero, presentada como si la hubiera jugado
           alguien. El número era real y el significado, falso.
           Ese respaldo es correcto para un CAJERO —ahí `usual:from` sí son sus jugadores— pero
           nunca para un agente parado en su raíz. Si no se pudieron leer las cajas, se contesta
           vacío y se dice por qué. */
        if (!fanOut.length) {
          return ok(res, { filas: [], cuantas: 0, total: null, eje: 'dinero', ejePedido: 'dinero',
            armadoDeMovimientos: true, cajasLeidas: 0, sinCajas: true });
        }
      }
      const armado = await ejeDineroArmado(cli, { nodo, fanOut, from: r.from, to: r.to, agrupar: q.agrupar });
      const num = (x) => Number(x) || 0;
      armado.filas.sort((a, b) => (orden === 'asc' ? 1 : -1) * (num(b[campo]) - num(a[campo])));
      return ok(res, { filas: armado.filas, cuantas: armado.filas.length, total: armado.total,
        eje: 'dinero', ejePedido: 'dinero', armadoDeMovimientos: true, cajasLeidas: fanOut.length || 1 });
    }

    if (q.agrupar === 'child_users') {
      const hijos = await cli.apiCall('users',
        { ...rangoBarato(), limit: '200', inactive_users: 'all', deleted_users: 'undelete' },
        { id: nodo, offset: '1' });
      if (!esJson(hijos)) return delMotor(res, hijos);
      const cajas = sinFilaTotal(hijos.data.users || hijos.data.rows || []);

      /* De a 5 por vez: ni una ráfaga de 40 llamadas ni una fila por segundo. */
      const filas = [];
      for (let i = 0; i < cajas.length; i += 5) {
        const tanda = await Promise.all(cajas.slice(i, i + 5).map(async (c) => {
          const t = await cli.apiCall('reportstable', {}, {
            id: String(c.id), safe_content: '1', from: r.from, to: r.to,
            search: '', sort: 'profit', order: 'desc', offset: '0', limit: '50',
            statistic_type: tipo,
          });
          const pie = esJson(t) ? t.data.footer : null;
          return pie ? { ...pie, id: String(c.id), login: c.login || String(c.id) } : null;
        }));
        filas.push(...tanda.filter(Boolean));
      }

      const num = (x) => Number(x) || 0;
      filas.sort((a, b) => (orden === 'asc' ? 1 : -1) * (num(b[campo]) - num(a[campo])));
      return ok(res, { filas, cuantas: filas.length, total: tabla.data.footer || null,
        eje, ejePedido, armadoPorCaja: true, cajasLeidas: filas.length, cajasTotales: cajas.length });
    }

    /* 🔑 Los siete números que se miran: cargas, retiros, ganancia, cuántas cargas, cuántos
       retiros, y los dos promedios. El motor manda `avg_in`/`avg_out` en algunos nodos y en otros
       no (medido: sí en 7357552, no en 7278954), así que se calculan cuando faltan en vez de
       dejar un hueco. */
    const conPromedios = (f) => {
      const ci = Number(f.count_in) || 0, co = Number(f.count_out) || 0;
      return { ...f,
        avg_in: f.avg_in != null ? f.avg_in : (ci ? dosDec(aNumero(f.in) / ci) : 0),
        avg_out: f.avg_out != null ? f.avg_out : (co ? dosDec(aNumero(f.out) / co) : 0) };
    };
    ok(res, {
      filas: sinFilaTotal(tabla.data.rows).map(conPromedios),
      cuantas: tabla.data.total || 0,
      /* ⭐ El total del PERÍODO entero, no de la página. Es el número que hay que mostrar. */
      total: tabla.data.footer ? conPromedios(tabla.data.footer) : null,
      /* 🔴 El eje que el casino ENTREGÓ, que no siempre es el que pedimos. Ver la nota de arriba:
         lo manda la plantilla guardada de la cuenta, y desde acá no se puede cambiar. */
      eje, ejePedido,
    });
  }));

  /* ══════ historial de jugadas — va con el id del JUGADOR ══════ */

  app.get('/api/caja/jugadas', auth.requerida, wrap(async (req, res) => {
    const q = req.query;
    if (!q.jugador) return mal(res, 'falta el jugador');
    const cli = auth.clienteDe(req.caja);
    const r = rango(q);
    const d = await cli.apiCall('history', {}, {
      id: q.jugador,
      from: r.from, to: r.to,
      limit: String(limiteValido(q.limite || 200)),
      offset: String(q.pagina || 1),
    });
    if (!esJson(d)) return delMotor(res, d);
    ok(res, {
      sesiones: d.data.history || [],
      total: d.data.total || null,               // del período, calculado por el motor
      /* Llega como objeto {imperium_bet:"ImperiumBet"}, no como lista. */
      proveedores: Object.entries(d.data.providers || {}).map(([clave, nombre]) => ({ clave, nombre })),
      paginas: d.data.pageCount || 1,
    });
  }));


  /* ══════════════════════════════════════════════════════════════════════════
     MOVER FICHAS — lo único irreversible de todo el panel.
     ══════════════════════════════════════════════════════════════════════════

     🔴 EL RECHAZO DEL MOTOR ES SILENCIOSO. Medido el 26-ago: pidiendo cargar 10.000 a un jugador
        cuya caja tenía 3.045, el motor contestó normalmente y NO MOVIÓ NADA. Sin error, sin aviso.
        Por eso acá no alcanza con que la llamada no falle: hay que LEER EL SALDO ANTES Y DESPUÉS
        y comparar. Si no cambió, se devuelve un error explicando por qué.

     🔴 `all=true` IGNORA EL MONTO y se lleva todo. Medido: con `all=true` y `amount=2`, un jugador
        con 1.000 quedó en 0. Por eso «todo» tiene que venir como una decisión aparte y explícita
        del cliente, nunca deducida de que el monto coincida con el saldo.

     🔑 El tope al cargar es el saldo de LA CAJA, no el de quien opera. Un agente con 45.990 no
        pudo cargar 10.000 porque la caja tenía 3.045.
  */

  /* Operaciones ya ejecutadas, para que un doble clic no cargue dos veces. */
  const hechas = new Map();
  setInterval(() => {
    const corte = Date.now() - 5 * 60 * 1000;
    for (const [k, v] of hechas) if (v.cuando < corte) hechas.delete(k);
  }, 60 * 1000).unref?.();

  /* 🔴 UNA OPERACIÓN POR CUENTA A LA VEZ.
     `hechas` atrapa el doble clic —el MISMO gesto repetido— pero no esto: el operador aprieta
     Cargar, la pantalla parece trabada, aprieta de nuevo, y sale un gesto NUEVO que pasa el
     filtro. Las dos órdenes corren juntas sobre la misma cuenta, se pisan al leer el saldo, y
     una devuelve un error que dice «no se movió nada» mientras la otra sí movió.

     Pasó de verdad el 1-sep-2026: dos cargas de 10.000 sobre 7369514, una entró y la otra
     contestó error. El operador vio el error y creyó que no se había cargado.

     Se guarda por CUENTA y no por sesión: la misma cuenta puede tocarse desde dos lados —el
     agente y su sub-usuario— y el problema es del lado del casino, no de quién lo pide. */
  const enCurso = new Map();
  const LIMPIAR_CURSO = 3 * 60 * 1000;   // por si un pedido muere sin pasar por `finally`

  /**
   * El saldo de UNA cuenta, en el momento.
   * 🔴 Se busca con `search` EN LA QUERY. Recorrer las páginas no sirve: una caja tiene 1.851
   *    jugadores y el que se busca puede estar en cualquiera. Con `search` es una sola llamada.
   * @param {string} [login] el login, que es lo que `search` matchea; si no se sabe, se recorre.
   */
  /* ⚡⚡ EL RANGO DE FECHAS ES LO QUE HACE LENTO A `area=users`, no el `limit`. Medido el 31-ago
     sobre el nodo del AGENTE, que agrega todo lo que cuelga debajo:

       rango 2020→hoy, limit 500 …… 7.548 ms
       sin rango,      limit 500 …… 7.543 ms
       sin rango,      limit  50 …… 7.590 ms
       rango de HOY,   limit  50 ……   279 ms   ← 27 veces más rápido

     🔑 Y los SALDOS SON LOS MISMOS: `balances` es el saldo actual, no del período. Verificado
        cuenta por cuenta con los dos rangos. Sobre una caja da igual (~245 ms las dos), así que
        el costo se lo lleva sólo el nodo que tiene cajas debajo.
     ⚠️ El rango NO decide qué cuentas aparecen: eso lo hace `inactive_users:'all'`, que se manda
        igual. Con el rango de hoy siguen viniendo las cinco, incluida la que no movió nada. */
  const rangoBarato = () => ({ from: `${hoy()} 00:00:00`, to: `${hoy()} 23:59:59` });

  async function saldoDeCuenta(cli, idPadre, idCuenta, login) {
    /* 🔴 `deleted_users` VA SIEMPRE, aunque su valor sea el que el motor usa por defecto.
       Acá estaba el error que hizo que «no se pudo leer el saldo» apareciera durante horas sin
       patrón: el motor RECUERDA el último valor por sesión, y la pantalla «Jugadores eliminados»
       pide `delete`. Desde el momento en que alguien la abre, esta lectura —que no mandaba el
       parámetro— hereda ese filtro y **sólo ve cuentas borradas**. El jugador vivo no aparece
       jamás, y no se arregla ni volviendo a entrar: el token del motor es el mismo.

       Medido el 1-sep-2026 con el diagnóstico puesto: pidiendo el saldo de 7369500 la página 1
       devolvía [7378089, 7378088, 7357744] — las tres eliminadas de esa caja, ninguna otra.

       Es el mismo vicio de `from`/`to` y de `search`: lo que no se manda, se hereda. La regla en
       este motor es mandar SIEMPRE todos los filtros, incluso los que parecen redundantes. */
    const comun = {
      ...rangoBarato(),
      inactive_users: 'all',
      deleted_users: 'undelete',
      limit: '500',
    };
    const buscarEn = async (query) => {
      const r = await cli.apiCall('users', comun, Object.assign({ id: String(idPadre) }, query));
      if (!esJson(r)) return null;
      return sinFilaTotal(r.data.users).find((u) => String(u.id) === String(idCuenta)) || null;
    };

    /* 🔴 PRIMERO SE RECORREN LAS PÁGINAS, Y RECIÉN DESPUÉS SE BUSCA. El orden importa y costó
       encontrarlo.

       Antes se buscaba primero con `search=<login>` porque es una sola llamada. El problema: el
       motor deja el filtro PEGADO EN LA SESIÓN. Si esa búsqueda no encuentra nada —y a veces no
       encuentra, sin motivo aparente— TODAS las llamadas siguientes heredan el filtro y vuelven
       vacías, aunque no manden `search`. La cuenta existe, está en la primera página, y el panel
       decía «no se pudo leer el saldo» una y otra vez.

       Mandar `search: ''` para limpiarlo NO sirve: el motor ignora el valor vacío y se queda con
       el anterior. Medido el 1-sep-2026 sobre la cuenta 7369514: cuatro intentos seguidos
       fallaron, y `/cuentas` —que nunca usa `search`— la devolvía sin problema.

       Listar la página es igual de barato (~330 ms) y no ensucia nada. La búsqueda queda sólo
       como último recurso, para cajas de miles de cuentas donde el recorrido no llegue. */
    let fila = null;
    for (let pag = 1; !fila && pag <= 4; pag++) {
      // eslint-disable-next-line no-await-in-loop
      fila = await buscarEn({ offset: String(pag) });
    }
    if (!fila && login) fila = await buscarEn({ search: String(login), offset: '1' });
    if (!fila) return null;
    return saldoDeFila(fila);
  }


  app.post('/api/caja/fichas', auth.requerida, wrap(async (req, res) => {
    const b = req.body || {};
    const cuenta = String(b.cuenta || '').trim();          // a quién
    let padre = String(b.padre || req.caja.id).trim();     // de qué caja sale / entra
    const operacion = b.operacion === 'out' ? 'out' : 'in';
    const todo = b.todo === true;                          // explícito, nunca deducido
    const monto = Number(b.monto);

    if (!cuenta) return mal(res, 'falta la cuenta');
    if (!todo && (!Number.isFinite(monto) || monto <= 0)) {
      return mal(res, 'El monto tiene que ser un número mayor que cero');
    }
    /* `all=true` con un monto escrito es una contradicción: o se lleva todo, o se lleva ese monto.
       Se rechaza en vez de elegir por el cliente. */
    if (todo && Number.isFinite(monto) && monto > 0) {
      return mal(res, 'Pediste «todo» y además un monto. Elegí una de las dos.');
    }

    /* Doble clic: la misma operación dentro de la misma sesión no se repite. */
    const huella = `${req.caja.sid}|${cuenta}|${operacion}|${todo ? 'ALL' : monto}|${b.gesto || ''}`;
    if (b.gesto && hechas.has(huella)) {
      const previa = hechas.get(huella);
      return res.status(409).json({ ok: false, repetida: true,
        error: 'Esa misma operación ya se hizo hace un momento.', resultado: previa.resultado });
    }

    const cli = auth.clienteDe(req.caja);

    /* ── LA COLA ────────────────────────────────────────────────────────────────────────
       Antes esto rebotaba con «esperá y volvé a intentar», y hacer volver al operador es
       justamente lo que queríamos evitar. Ahora espera el turno solo. Pero hay que separar
       DOS casos que parecen iguales y no lo son:

       · MISMO pedido (misma cuenta, misma operación, mismo monto): es un doble clic. Encolarlo
         cargaría DOS VECES. Se espera al que ya está corriendo y se devuelve SU resultado —lo
         que el operador quería ver— sin tocar el casino de nuevo.
       · Pedido DISTINTO sobre la misma cuenta: es trabajo real. Se hace la cola de verdad.

       Sin esa distinción, «encolar» sería duplicar la plata. */
    const marca = `${cuenta}|${operacion}|${todo ? 'ALL' : monto}`;
    /* Se espera EN BUCLE, no una sola vez: si hay tres esperando, al despertarse todas juntas
       arrancarían a la vez y estaríamos igual que al principio. Cada una vuelve a mirar si la
       cuenta quedó libre. El tope evita que alguien espere para siempre. */
    const HASTA = Date.now() + 45 * 1000;
    let espero = false;
    for (;;) {
      const previo = enCurso.get(cuenta);
      if (!previo || Date.now() - previo.desde >= LIMPIAR_CURSO) break;
      const suyo = await previo.promesa.catch(() => null);
      if (previo.marca === marca) {
        console.log('[caja/fichas] doble clic sobre %s: devuelvo el resultado del primero', cuenta);
        if (suyo) return ok(res, { ...suyo, yaEstaba: true });
        return res.status(409).json({ ok: false, enCurso: true,
          error: 'Se pidió dos veces lo mismo y el primero no terminó bien. Mirá el saldo antes '
            + 'de repetir.' });
      }
      espero = true;
      if (Date.now() > HASTA) {
        return res.status(409).json({ ok: false, enCurso: true,
          error: 'La cuenta estuvo ocupada demasiado tiempo y no llegamos a hacerlo. Mirá el saldo '
            + 'y volvé a intentar.' });
      }
    }
    if (espero) console.log('[caja/fichas] %s esperó turno en la cola', cuenta);

    /* El turno propio: se anota ANTES de tocar el casino, con una promesa que el que venga
       después pueda esperar. */
    let terminar;
    const promesa = new Promise((r) => { terminar = r; });
    enCurso.set(cuenta, { desde: Date.now(), marca, promesa });

    console.log('[caja/fichas] %s %s cuenta=%s padre=%s monto=%s todo=%s',
      req.caja.login, operacion, cuenta, padre, monto, todo);
    try {

    /* 1 · el saldo ANTES — la única forma de saber después si se movió algo */
    let dePadre = padre;
    let antes = await saldoDeCuenta(cli, dePadre, cuenta, b.login);

    /* 🔴 UN REINTENTO, PORQUE EL MOTOR SE TROPIEZA SOLO.
       Medido el 1-sep-2026: la misma carga a la misma cuenta falló dos veces seguidas al leer el
       saldo y funcionó a la tercera, sin cambiar nada. El motor devuelve HTML en vez de JSON cada
       tanto —una sesión que se refresca, un pico— y `saldoDeCuenta` contesta null.

       Rendirse al primer tropiezo tiene un costo que no se ve: el operador recibe un error, vuelve
       a apretar, y ESE reintento manual es el que se pisa con el anterior y termina cargando dos
       veces. Reintentar una vez acá, con medio segundo de espera, evita casi todos esos.
       Es sólo una LECTURA: repetirla no mueve una ficha. */
    if (antes == null) {
      await new Promise((r) => { setTimeout(r, 500); });
      antes = await saldoDeCuenta(cli, dePadre, cuenta, b.login);
    }

    /* Si no apareció, puede que el padre esté mal: la pantalla manda `padre` sólo cuando entraste
       al cajero, y quien llega al jugador por el buscador global no lo tiene. Antes eso terminaba
       en «no se pudo leer el saldo de esa cuenta» y no se podía cargar. Se le pregunta al motor de
       qué caja cuelga y se reintenta una vez. Medido el 1-sep-2026 con P000999888. */
    if (antes == null) {
      const real = await padreDeVerdad(cli, cuenta, b.login);
      if (real && real !== String(dePadre)) {
        dePadre = real;
        antes = await saldoDeCuenta(cli, dePadre, cuenta, b.login);
      }
    }
    if (antes == null) {
      return mal(res, 'No se pudo leer el saldo de esa cuenta, así que la orden no se envió. No se movió nada.', 502);
    }
    padre = dePadre;

    /* 2 · la orden */
    const r = await cli.apiCall('balance', {
      balance_currency: req.caja.moneda || 'ARS',
      amount: todo ? '0' : String(monto),
      send: 'true',
      all: todo ? 'true' : 'false',
      operation: operacion,
    }, { id: cuenta, type: 'frame', printing: 'true' });

    /* 3 · el saldo DESPUÉS — acá se descubre el rechazo silencioso.
       ⚡ Va EN PARALELO con el del pagador: son dos nodos distintos, no dependen entre sí, y cada
          llamada al motor cuesta ~220 ms. En serie se notaba. */
    const pagadorEsMio = String(padre) === String(req.caja.id);
    const [despues, saldoPagador] = await Promise.all([
      saldoDeCuenta(cli, padre, cuenta, b.login),
      pagadorEsMio
        ? cli.apiCall('info').then((m) => (esJson(m) && m.data.main ? Number(m.data.main.balance) || 0 : null))
        : saldoDeCuenta(cli, req.caja.id, String(padre)),
    ]);
    if (despues == null) {
      return mal(res, 'La orden se envió pero no pudimos confirmar el saldo, así que NO sabemos si se movió. Mirá el saldo antes de repetir.', 502);
    }

    let despuesFinal = despues;
    let movido = Math.round((despues - antes) * 100) / 100;
    const esperado = todo ? (operacion === 'out' ? -antes : null) : (operacion === 'in' ? monto : -monto);

    /* 🔴 «RETIRAR TODO» DE UNA CAJA: SI EL MOTOR LO IGNORA, SE PIDE EL MONTO EXACTO.
       El casino acepta `all=true` y no mueve nada cuando el destino es una caja —medido el
       1-sep-2026—, pero sobre un jugador sí funciona y ahí conviene dejarlo: es atómico, y un
       jugador puede estar jugando entre que se lee el saldo y se manda la orden.

       Así que se intenta `all` primero y, sólo si no movió nada, se reintenta con el número. Y el
       número ya lo tenemos: es el saldo que se leyó ANTES de mandar la orden. Antes esto terminaba
       en «escribí el monto a mano», haciéndole hacer a mano algo que el sistema ya sabía.
       Pedido por el dueño el 2-sep-2026, mirando el caso E-3: pidió todo de una caja con 5.000 y
       el servidor tenía el 5.000 delante. */
    if (movido === 0 && operacion === 'out' && todo && antes > 0) {
      console.log('[caja/fichas] «todo» no movió nada en %s: reintento con el monto exacto %s', cuenta, antes);
      await cli.apiCall('balance', {
        balance_currency: req.caja.moneda || 'ARS',
        amount: String(antes),
        send: 'true',
        all: 'false',
        operation: 'out',
      }, { id: cuenta, type: 'frame', printing: 'true' });
      const reintento = await saldoDeCuenta(cli, padre, cuenta, b.login);
      if (reintento != null) {
        despuesFinal = reintento;
        movido = Math.round((reintento - antes) * 100) / 100;
      }
    }

    /* 4 · nada se movió: el motor rechazó sin decirlo */
    console.log('[caja/fichas] antes=%s despues=%s movido=%s', antes, despuesFinal, movido);
    if (movido === 0) {
      /* 🔴 EL MENSAJE TIENE QUE DECIR LO QUE PASÓ. Antes, cualquier retiro que no moviera nada
         contestaba lo mismo —«fijate que el jugador tenga ese saldo»— incluso cuando el retiro era
         SOBRE UNA CAJA y el jugador no tenía nada que ver. Y encima el caso más común es conocido:
         «retirar todo» no funciona sobre una caja, el casino lo acepta y no mueve nada (medido el
         1-sep-2026). Decirlo ahorra el llamado telefónico. */
      const razon = operacion === 'in'
        ? 'No alcanzan las fichas de la caja. El tope para cargar es el saldo de la caja, no el tuyo.'
        : (todo
          ? 'No se pudo retirar el saldo. Se probó de las dos maneras —«todo» y el monto exacto— y '
            + 'el casino no movió nada. Puede que la cuenta tenga el retiro bloqueado.'
          : 'No se pudo retirar. Fijate que tenga ese saldo y que la caja permita retiro parcial.');
      return res.status(409).json({ ok: false, sinEfecto: true, error: razon, saldo: despuesFinal, antes });
    }

    /* 5 · se movió algo distinto de lo pedido: se dice, no se disimula */
    const resultado = {
      antes, despues: despuesFinal, movido,
      operacion, todo,
      parcial: esperado != null && Math.abs(movido - esperado) > 0.009,
    };
    if (b.gesto) hechas.set(huella, { cuando: Date.now(), resultado });

    const salida = {
      ...resultado,
      pagador: { id: String(padre), saldo: saldoPagador },
      motor: esJson(r) ? undefined : 'el motor respondió en HTML; el saldo se verificó igual',
    };
    terminar(salida);          // el que esté esperando por doble clic recibe esto
    return ok(res, salida);
    } finally {
      /* Pase lo que pase se suelta y se despierta al que esté en la cola. Si esto no corriera,
         un error dejaría la cuenta trabada y a alguien esperando para siempre. */
      terminar(null);
      enCurso.delete(cuenta);
    }
  }));


  /* ══════ ALTA Y BAJA DE CUENTAS ══════
     Medido el 27-ago-2026 contra producción, con un alta y una baja reales sobre el hall de prueba.

     🔴 LO QUE HACE ESTO DISTINTO DE TODO LO DEMÁS: el motor NO dice si funcionó.
        · El alta contesta su blob de `config` tanto si creó como si rebotó.
        · `area=search` no anda con api_token: devuelve 0 aunque la cuenta exista.
        · Un login usado en OTRA caja rebota el alta y desde acá es invisible.
        ⇒ La única prueba válida es volver a pedir la lista y buscar el login. Se hace siempre.

     🔑 El tope del saldo inicial es DINÁMICO: el saldo del padre en ese instante. Se lee del
        formulario (`balance.max`) en cada alta, nunca de una constante. */

  const GRUPOS = { jugador: '5', subcajero: '8', cajero: '4', subagente: '6' };

  /* 🔴 Un sub-usuario NO aparece en `area=users`: vive en `area=sub`, bajo la clave `subs`.
     Verificar su alta contra la lista de cuentas daría siempre «no se creó». */
  async function buscarSub(cli, padre, login) {
    const r = await cli.apiCall('sub', {}, { id: String(padre) });
    if (!esJson(r) || r.data.error) return null;
    const lista = r.data.subs || r.data.sub || [];
    return lista.find((x) => x && String(x.login) === String(login)) || null;
  }

  /* Busca un login dentro de un nodo. El parámetro `search` va en la QUERY.

     🔴 EL RANGO NO ES OPCIONAL, y su ausencia rompía el alta de una forma fea: sin `from`/`to`
        el motor devuelve sólo las cuentas CON MOVIMIENTO, y una recién creada no movió nada.
        La verificación del alta —que es esta misma función— no la encontraba y contestaba «ese
        nombre ya está usado, probá con otro»… con la cuenta ya creada del otro lado. El operador
        creaba la misma persona dos y tres veces.
        Medido el 1-sep-2026: se creó PruebaClaude051848, la ruta devolvió ese error, y la cuenta
        estaba ahí (id 7378088). Con el rango puesto aparece. */
  /* DE QUÉ CAJA CUELGA ESTA CUENTA, preguntándoselo al motor.
     `area=search` busca en TODO lo que ve la sesión y devuelve `create`, que es el id del padre.
     Sirve de red cuando la pantalla no sabe el padre —llegaste al jugador por el buscador global,
     no entrando a su cajero— y sin eso la carga fallaba con «no se pudo leer el saldo». */
  async function padreDeVerdad(cli, cuenta, login) {
    const r = await cli.apiCall('search', { search_login: String(login || cuenta), page: '1' }, {});
    if (!esJson(r)) return null;
    const fila = (r.data.users || []).find((u) => u && String(u.id) === String(cuenta));
    return fila && fila.create ? String(fila.create) : null;
  }

  /* 🔴 `search` SÓLO FILTRA JUGADORES, NO CAJEROS. Medido el 4-sep-2026 barriendo diez nombres de
     parámetro (`search`, `login`, `user`, `filter`, `q`…) en la query y en el cuerpo, sobre los dos
     tipos de nodo: sobre una caja, `search` en la query devuelve 1 de 5; sobre la raíz de un
     agente, NINGUNO filtra — vuelven las cuatro cajas igual.
     Por eso esto no puede confiar en el filtro. Se manda igual (cuando sirve, ahorra el recorrido)
     pero se PAGINA hasta encontrar el login, y sólo se rinde cuando el motor deja de dar filas.
     Sin esto, un agente con más de 200 cajas no podía crear la 201: la verificación del alta miraba
     la primera página, no la encontraba, y contestaba «ese nombre ya está usado» con la caja recién
     creada del otro lado — el mismo error que ya nos costó cuentas duplicadas.

     🔴 Y `deleted_users` VA SIEMPRE. Mismo vicio del motor que en `saldoDeCuenta`: lo que no se
     manda se hereda de la última consulta de la sesión. Si alguien abrió «Eliminados», esta
     búsqueda mira SÓLO cuentas borradas y no encuentra la que se acaba de crear.
     Medido el 1-sep-2026: crear CajaTest093825 devolvió ese error y la cuenta estaba ahí. */
  const PAGINAS_BUSCANDO = 10;               // 2.000 cuentas: más que cualquier agente real

  async function buscarLogin(cli, padre, login) {
    for (let pagina = 1; pagina <= PAGINAS_BUSCANDO; pagina++) {
      // eslint-disable-next-line no-await-in-loop
      const r = await cli.apiCall('users',
        { ...rangoBarato(), limit: '200', inactive_users: 'all', deleted_users: 'undelete' },
        { id: String(padre), offset: String(pagina), search: String(login) });
      if (!esJson(r)) return null;
      const filas = sinFilaTotal(r.data.users || r.data.rows || []);
      const hallada = filas.find((x) => String(x.login) === String(login));
      if (hallada) return hallada;
      /* Página incompleta = no hay más. Y una vacía corta también, por si el motor pagina raro. */
      if (filas.length < 200) return null;
    }
    return null;
  }

  app.post('/api/caja/crear', auth.requerida, wrap(async (req, res) => {
    const b = req.body || {};
    const padre = String(b.padre || req.caja.id).trim();
    const login = String(b.login || '').trim();
    const clave = String(b.clave || '').trim();
    const nombre = String(b.nombre || '').trim();
    const grupo = GRUPOS[b.tipo] || GRUPOS.jugador;
    const saldo = b.saldo == null || b.saldo === '' ? 0 : Number(b.saldo);

    if (!login) return mal(res, 'Falta el login');
    if (!clave) return mal(res, 'Falta la contraseña');
    if (!Number.isFinite(saldo) || saldo < 0) return mal(res, 'El saldo inicial no es un número válido');

    const cli = auth.clienteDe(req.caja);
    const esSub = grupo === GRUPOS.subcajero || grupo === GRUPOS.subagente;
    const buscar = esSub ? buscarSub : buscarLogin;

    /* 1 · ¿ya existe acá? Si está a la vista, se corta antes de tocar nada. No prueba que esté
       libre —el login es único en TODO el motor y esta cuenta sólo ve lo suyo— pero ataja el caso
       más común sin gastar un alta. */
    const yaEsta = await buscar(cli, padre, login);
    if (yaEsta) {
      return res.status(409).json({ ok: false, ocupado: true,
        error: `Ya tenés una cuenta que se llama ${login}.` });
    }

    /* 2 · el tope real de este momento, leído del formulario */
    const form = await cli.apiCall('createuser', { group: grupo }, { id: padre });
    const campos = (esJson(form) && (form.data.createFields || {})[grupo]) || {};
    const tope = Number((campos.balance || {}).max ?? (campos['max-amount'] || {}).value);
    if (saldo > 0 && Number.isFinite(tope) && saldo > tope) {
      return mal(res, `No te alcanzan las fichas: podés darle hasta ${tope}.`);
    }

    /* 3 · el alta. La respuesta NO se cree: se verifica abajo. */
    const cuerpo = { group: grupo, sended: 'true', login, password: clave };
    if (saldo > 0) cuerpo.balance = String(saldo);
    /* 🔑 El motor EXIGE `name` para los sub-usuarios y para las cajas, pero el panel no tiene
       dónde mostrarlo. Se manda el login, que es como los nombra la gente. */
    if (esSub || grupo === GRUPOS.cajero) cuerpo.name = nombre || login;
    await cli.apiCall('createuser', cuerpo, { id: padre });

    /* 4 · LA PRUEBA */
    const creada = await buscar(cli, padre, login);
    if (!creada) {
      return res.status(409).json({ ok: false, ocupado: true,
        error: `No se pudo crear ${login}. Ese nombre ya está usado en el sistema, aunque no lo veas `
          + 'en tu panel: los logins son únicos y quedan reservados aunque la cuenta se elimine. '
          + 'Probá con otro.' });
    }
    /* El saldo que se muestra es el que el casino confirma, leído de donde de verdad está. */
    const quedo = saldoDeFila(creada);
    ok(res, { cuenta: { ...creada, balance: quedo }, saldoPedido: saldo, saldoQuedo: quedo,
      parcial: saldo > 0 && Math.abs(quedo - saldo) > 0.009 });
  }));

  app.post('/api/caja/eliminar', auth.requerida, wrap(async (req, res) => {
    const b = req.body || {};
    const cuenta = String(b.cuenta || '').trim();
    const padre = String(b.padre || req.caja.id).trim();
    const login = String(b.login || '').trim();
    if (!cuenta) return mal(res, 'falta la cuenta');
    if (b.confirmado !== true) return mal(res, 'falta confirmar la baja');

    const cli = auth.clienteDe(req.caja);

    /* 🔴 `area=delete` sin cuerpo NO borra: devuelve el blob de config y la cuenta sigue viva.
       La confirmación es `delete=true` — medido el 27-ago probando `sended` y `confirm`, que no
       hacen nada. Es la diferencia entre creer que borraste y haber borrado. */
    await cli.apiCall('delete', { delete: 'true' }, { id: cuenta });

    /* Y otra vez: la prueba es mirar, no la respuesta. */
    if (login) {
      const sigue = await buscarLogin(cli, padre, login);
      if (sigue) {
        return res.status(409).json({ ok: false, sinEfecto: true,
          error: 'El casino aceptó la orden pero la cuenta sigue estando. No se borró nada.' });
      }
    }
    ok(res, { eliminada: cuenta, login });
  }));

  /* ══════ SUB-USUARIOS ══════
     🔴 `area=sub` tampoco anda con api_token: devuelve «No rights», igual que `intersections` y
     `changes` (medido el 27-ago). El patrón ya es claro: el token OPERA —jugadores, movimientos,
     estadísticas, tablero, fichas— pero no ADMINISTRA cuentas ni audita. Esto va con sesión. */
  app.get('/api/caja/subusuarios', auth.requerida, wrap(async (req, res) => {
    const id = req.query.id || req.caja.id;
    /* ✅ CORREGIDO el 28-ago: `sub` SÍ anda con api_token — devuelve `subs`. La medición vieja que
       decía «necesita sesión» estaba hecha sobre otra cuenta y se dio por general.
       Igual se deja la sesión como respaldo: si el token no alcanza en alguna cuenta, no se cae. */
    let r = await auth.clienteDe(req.caja).apiCall('sub', {}, { id });
    if (!esJson(r) || r.data.error) {
      const conSesion = auth.clienteDe(req.caja, { auditoria: true });
      if (conSesion !== auth.clienteDe(req.caja)) r = await conSesion.apiCall('sub', {}, { id });
    }
    if (!esJson(r) || r.data.error) return soloConSesion(res, esJson(r) ? { error: r.data.error } : r);
    /* La fila que devuelve es mínima: id, login, name y si se puede borrar. Los permisos
       (`hide_hall_balance`, `disable_statistic`) viven en la ficha de cada uno. */
    ok(res, { subusuarios: sinFilaTotal(r.data.subs || r.data.sub || r.data.users || []) });
  }));


  /* ══════ QUÉ CAJAS VE UN SUB-AGENTE ══════
     Capturado del panel real el 28-ago-2026, en `useredit` pestaña «Los usuarios editados».

     ```
     POST area=useredit&tab=editable_users&id=<subagente>
     send=true
     editable_users/<idCaja>=1   → habilita
     editable_users/<idCaja>=0   → quita
     ```

     🔴 EL VALOR ES `1`, NO `on`. El formulario del panel manda `on` porque es una casilla HTML,
        pero mandar `on` —o `true`— **BORRA el permiso** en vez de darlo. Se descubrió apagándole
        sin querer una caja a un sub-agente real. Sólo `1` marca.
     🔑 Es DIFERENCIAL: lo que no se manda no se toca. Mandar sólo `send=true` no borra nada.
     ✅ Anda con api_token y el efecto es inmediato: el sub-agente pasa a ver esa caja y sus
        jugadores en la misma llamada siguiente. */

  app.post('/api/caja/permisos-subagente', auth.requerida, wrap(async (req, res) => {
    const b = req.body || {};
    const sub = String(b.sub || '').trim();
    const cajas = b.cajas && typeof b.cajas === 'object' ? b.cajas : null;
    if (!sub) return mal(res, 'falta el sub-agente');
    if (!cajas || !Object.keys(cajas).length) return mal(res, 'no dijiste qué cajas');

    const cli = auth.clienteDe(req.caja);
    const cuerpo = { send: 'true' };
    for (const [id, dar] of Object.entries(cajas)) cuerpo[`editable_users/${id}`] = dar ? '1' : '0';
    await cli.apiCall('useredit', cuerpo, { id: sub, tab: 'editable_users' });

    /* Como siempre en este motor: la respuesta no prueba nada, se vuelve a leer. */
    const r = await cli.apiCall('useredit', {}, { id: sub, tab: 'editable_users' });
    if (!esJson(r)) return delMotor(res, r);
    const estado = {};
    for (const [id, campo] of Object.entries(r.data.fields || {})) {
      estado[id] = { login: campo.title, ve: campo.value === true };
    }
    const fallaron = Object.entries(cajas)
      .filter(([id, dar]) => estado[id] && estado[id].ve !== !!dar)
      .map(([id]) => (estado[id] || {}).login || id);
    if (fallaron.length) {
      return res.status(409).json({ ok: false, sinEfecto: true, estado,
        error: `El casino aceptó el cambio pero no quedó aplicado en: ${fallaron.join(', ')}.` });
    }
    ok(res, { estado });
  }));

  /* Lo que un sub-agente ve hoy, para dibujar las palancas con la verdad. */
  app.get('/api/caja/permisos-subagente', auth.requerida, wrap(async (req, res) => {
    if (!req.query.sub) return mal(res, 'falta el sub-agente');
    const cli = auth.clienteDe(req.caja);
    const r = await cli.apiCall('useredit', {}, { id: String(req.query.sub), tab: 'editable_users' });
    if (!esJson(r)) return delMotor(res, r);
    const estado = {};
    for (const [id, campo] of Object.entries(r.data.fields || {})) {
      estado[id] = { login: campo.title, ve: campo.value === true };
    }
    ok(res, { estado });
  }));


  /* ══════ CONTRASEÑAS ══════
     Medido el 28-ago contra producción (cambiada y verificada entrando con la nueva):

     ```
     POST area=usersettings&id=<cuenta>&module=authorization
     setting[name][]=authorization_via_password
     setting[name][]=password
     setting[value]=<la nueva>
     ```

     🔴 `setting[name][]` va REPETIDO, un tramo por vez. Con los dos pegados por coma el motor
        contesta bien y NO cambia nada (la misma trampa del `generate` del token).
     🔴 Una cuenta NO puede administrarse a sí misma: `usersettings` sobre uno mismo devuelve HTML.
        Por eso la propia se cambia con la credencial de arriba, y sólo después de comprobar la
        actual entrando con ella — que es lo que prueba que es la persona y no una sesión robada. */

  const APLICAR_CLAVE = (nueva) => ({
    'setting[name][]': ['authorization_via_password', 'password'],
    'setting[value]': String(nueva),
  });

  /* Reglas del dueño: para gente del panel, 8 con mayúscula y número. Para un jugador, lo que sea
     sin espacios — se la dicta el cajero por teléfono y tiene que poder escribirla. */
  function claveFloja(nueva, esJugador) {
    const v = String(nueva || '');
    if (/\s/.test(v)) return 'La contraseña no puede llevar espacios';
    if (esJugador) return v.length ? null : 'Falta la contraseña';
    if (v.length < 8) return 'Tiene que tener al menos 8 caracteres';
    if (!/[A-Z]/.test(v)) return 'Le falta una mayúscula';
    if (!/[0-9]/.test(v)) return 'Le falta un número';
    return null;
  }

  /* La mía. Pide la actual, y la actual se comprueba entrando con ella. */
  app.post('/api/caja/mi-clave', auth.requerida, wrap(async (req, res) => {
    const { actual, nueva } = req.body || {};
    if (!actual) return mal(res, 'Falta tu contraseña actual');
    const floja = claveFloja(nueva, false);
    if (floja) return mal(res, floja);
    if (String(actual) === String(nueva)) return mal(res, 'La nueva tiene que ser distinta de la actual');
    if (!raiz) {
      return mal(res, 'Ahora mismo no se puede cambiar la contraseña desde acá. Escribile a soporte.', 503);
    }

    /* 1 · que sea quien dice ser: se entra con la actual y tiene que dar ESTA cuenta */
    const prueba = makeClient({ url: req.caja.url, user: req.caja.login, password: String(actual) });
    const quien = await prueba.apiCall('info');
    const login = (esJson(quien) && ((quien.data.editUser || {}).login || (quien.data.main || {}).login)) || null;
    if (!login || String(login) !== String(req.caja.login)) {
      return mal(res, 'Tu contraseña actual no es ésa', 403);
    }

    /* 2 · y recién ahí se cambia, desde arriba */
    await raiz.apiCall('usersettings', APLICAR_CLAVE(nueva), { id: req.caja.id, module: 'authorization' });

    /* 3 · la prueba: entrar con la nueva */
    const conNueva = makeClient({ url: req.caja.url, user: req.caja.login, password: String(nueva) });
    const ok2 = await conNueva.apiCall('info');
    if (!esJson(ok2) || ((ok2.data.editUser || {}).login !== req.caja.login)) {
      return res.status(409).json({ ok: false, sinEfecto: true,
        error: 'El casino aceptó el cambio pero tu contraseña sigue siendo la anterior. Probá de nuevo.' });
    }
    auth.salir(req);
    auth.borrarCookie(res);
    ok(res, { cambiada: true });
  }));

  /* La de alguien de abajo: no pide la anterior, alcanza con ser su superior. */
  app.post('/api/caja/clave-de', auth.requerida, wrap(async (req, res) => {
    const b = req.body || {};
    const cuenta = String(b.cuenta || '').trim();
    if (!cuenta) return mal(res, 'falta la cuenta');
    if (String(cuenta) === String(req.caja.id)) return mal(res, 'Para la tuya usá «Cambiar mi contraseña»');
    const floja = claveFloja(b.nueva, b.esJugador === true);
    if (floja) return mal(res, floja);

    const cli = auth.clienteDe(req.caja);
    await cli.apiCall('usersettings', APLICAR_CLAVE(b.nueva), { id: cuenta, module: 'authorization' });

    /* Se relee: el motor guarda la contraseña en claro y la devuelve, así que la verificación
       es directa. (Que la devuelva es su decisión, no nuestra; nosotros no la guardamos.) */
    const r = await cli.apiCall('usersettings', {}, { id: cuenta, module: 'authorization' });
    if (!esJson(r)) return delMotor(res, r);
    const campos = aplanarAjustes(r.data.settings);
    const quedo = campos['authorization_via_password/show_password'];
    if (quedo != null && String(quedo) !== String(b.nueva)) {
      return res.status(409).json({ ok: false, sinEfecto: true,
        error: 'El casino aceptó el cambio pero la contraseña sigue siendo la anterior.' });
    }
    ok(res, { cambiada: true, login: campos['authorization_via_password/login'] || null });
  }));


  /* ══════ MEDIOS DE COMUNICACIÓN ══════
     Los contactos que ven los jugadores de una caja. Medido el 28-ago creando, editando y
     borrando uno en una caja vacía, que quedó como estaba.

     ```
     POST area=usersettings&id=<caja>&module=siteAdditional
     add_contact = 1                              → crea uno vacío (tipo telegram por defecto)
     contacts/contact_N/type    = telegram|whatsapp
     contacts/contact_N/contact = <número>        → el motor REARMA el link solo
     contacts/contact_N/title / description
     contacts/contact_N/delete  = 1               → lo borra
     ```

     🔴 `setting[name][]` va REPETIDO, un tramo por vez — la trampa de siempre.
     🔴 El motor NO valida el número: arma `wa.me/<lo que sea>`. En producción hay un WhatsApp
        cargado como `+626283974'2`, y su link no lleva a ningún lado. Por eso se valida acá. */

  const CANALES = { telegram: 'telegram', whatsapp: 'whatsapp' };

  /* Lo que puede ir en un link sin romperlo. El apóstrofo, los espacios y las comillas quedan
     afuera: son exactamente lo que dejó un contacto muerto en producción. */
  const contactoValido = (v) => /^[A-Za-z0-9_.+-]{3,40}$/.test(String(v || ''));

  const ajusteDeCaja = (cli, caja, nombre, valor) => cli.apiCall('usersettings',
    { 'setting[name][]': [].concat(nombre), 'setting[value]': String(valor) },
    { id: String(caja), module: 'siteAdditional' });

  async function leerContactos(cli, caja) {
    const r = await cli.apiCall('usersettings', {}, { id: String(caja), module: 'siteAdditional' });
    if (!esJson(r) || r.data.error) return null;
    const plano = aplanarAjustes(r.data.settings);
    const lista = [];
    for (let n = 1; n <= 30; n++) {
      const base = `contacts/contact_${n}/`;
      if (plano[`${base}id`] == null) continue;
      lista.push({
        n,                                   // el índice que entiende el motor
        id: String(plano[`${base}id`]),
        type: plano[`${base}type`] || '',
        title: plano[`${base}title`] || '',
        contact: plano[`${base}contact`] || '',
        description: plano[`${base}description`] || '',
        link: plano[`${base}link`] || '',
      });
    }
    return lista;
  }

  app.get('/api/caja/contactos', auth.requerida, wrap(async (req, res) => {
    const caja = String(req.query.caja || req.caja.id);
    const lista = await leerContactos(auth.clienteDe(req.caja), caja);
    if (lista == null) return mal(res, 'no se pudieron leer los medios de comunicación', 502);
    ok(res, { contactos: lista });
  }));

  app.post('/api/caja/contacto', auth.requerida, wrap(async (req, res) => {
    const b = req.body || {};
    const caja = String(b.caja || req.caja.id);
    const tipo = CANALES[String(b.tipo || '').toLowerCase()];
    if (!tipo) return mal(res, 'Elegí si es Telegram o WhatsApp');
    if (!contactoValido(b.contacto)) {
      return mal(res, 'Ese número no sirve para armar el link: sólo números, letras, «+», «.», «-» '
        + 'y «_», sin espacios ni comillas.');
    }
    const cli = auth.clienteDe(req.caja);

    /* Editar uno existente, o crear. Al crear, el motor lo agrega vacío y después se llena. */
    let n = Number(b.n) || 0;
    if (!n) {
        const antes = (await leerContactos(cli, caja)) || [];
      const alta = await ajusteDeCaja(cli, caja, 'add_contact', '1');
      const despues = (await leerContactos(cli, caja)) || [];
      const nuevo = despues.find((c) => !antes.some((x) => x.id === c.id));
      if (!nuevo) {
        /* 🔴 UNA CAJA RECIÉN CREADA NO TIENE DÓNDE GUARDAR CONTACTOS. El motor contesta
           «Wrong name» a `add_contact`: esa caja sólo tiene el ajuste `active` y la sección de
           contactos todavía no existe. Medido el 2-sep-2026 comparando una caja nueva con una
           vieja. No es un fallo nuestro y no se arregla desde acá, así que se dice lo que pasa
           en vez de un «no se pudo» que manda a nadie a ningún lado. */
        const porQue = alta && alta.data && alta.data.error === 'Wrong name'
          ? 'Esta caja todavía no tiene la sección de contactos habilitada en el casino. '
            + 'Escribile a soporte para que se la abran; una vez abierta, acá se cargan solos.'
          : 'El casino no creó el contacto.';
        return res.status(502).json({ ok: false, sinSeccion: true, error: porQue });
      }
      n = nuevo.n;
    }

    /* 🔴 EL TÍTULO Y LA DESCRIPCIÓN SÓLO SE MANDAN SI TIENEN ALGO. El motor los rechaza vacíos
       con «Required», y la pantalla dejó de pedirlos (no servían para nada, decisión del dueño el
       1-sep-2026). Mandarlos igual eran dos llamadas al casino que siempre fallaban, ensuciando un
       guardado que por lo demás salía bien — y en el camino, dos viajes de más por cada guardado.
       Medido el 2-sep-2026 con una sonda sobre una caja real. */
    const ruta = (campo) => ['contacts', `contact_${n}`, campo];
    await ajusteDeCaja(cli, caja, ruta('type'), tipo);
    await ajusteDeCaja(cli, caja, ruta('contact'), String(b.contacto).trim());
    const titulo = String(b.titulo || '').trim();
    if (titulo) await ajusteDeCaja(cli, caja, ruta('title'), titulo);
    const descripcion = String(b.descripcion || '').trim();
    if (descripcion) await ajusteDeCaja(cli, caja, ruta('description'), descripcion);

    /* Se relee: el link lo arma el motor, así que es lo único que prueba que quedó bien. */
    const lista = await leerContactos(cli, caja);
    const quedo = (lista || []).find((c) => c.n === n);
    if (!quedo || quedo.contact !== String(b.contacto).trim()) {
      return res.status(409).json({ ok: false, sinEfecto: true,
        error: 'El casino aceptó el cambio pero el contacto no quedó guardado.' });
    }
    ok(res, { contacto: quedo, contactos: lista });
  }));

  app.post('/api/caja/contacto-borrar', auth.requerida, wrap(async (req, res) => {
    const b = req.body || {};
    const caja = String(b.caja || req.caja.id);
    const n = Number(b.n) || 0;
    if (!n) return mal(res, 'falta cuál contacto');
    const cli = auth.clienteDe(req.caja);
    await ajusteDeCaja(cli, caja, ['contacts', `contact_${n}`, 'delete'], '1');
    const lista = await leerContactos(cli, caja);
    if (lista && lista.some((c) => c.n === n)) {
      return res.status(409).json({ ok: false, sinEfecto: true,
        error: 'El casino aceptó la orden pero el contacto sigue estando.' });
    }
    ok(res, { contactos: lista || [] });
  }));


  /* ══════ EL ACCESO DE UN JUGADOR — lo arma EL MOTOR, no nosotros ══════
     Regla del dueño: el dominio del billete **no se deduce nunca**. Y no hace falta: `area=buttons`
     sobre la cuenta trae el link ya armado, con el dominio que le corresponde a esa caja.

     ```
     copy_ticket.copy_link  → "https://ganamos-lat.com?u=7357744&p=777"
     copy_auth.copy_link    → "Login:7357744 Password:777"
     share_auth.share_link  → "Login:… \nPassword:… \nhttps://…"
     ```

     🔴 `ticket_url` es un campo POR CAJA (`useredit`), y **puede estar vacío**: medido el 28-ago,
        la caja 7357836 no tiene ninguno. Cuando está vacío no hay link que dar, y eso se dice —
        antes el panel caía en una constante y mostraba un dominio que podía no ser el de esa caja. */

  app.get('/api/caja/acceso', auth.requerida, wrap(async (req, res) => {
    const cuenta = String(req.query.cuenta || '').trim();
    if (!cuenta) return mal(res, 'falta la cuenta');
    const cli = auth.clienteDe(req.caja);
    const r = await cli.apiCall('buttons', {}, { id: cuenta });
    if (!esJson(r)) return delMotor(res, r);
    const botones = r.data.buttons || [];
    const de = (nombre) => botones.find((x) => x && x.name === nombre) || {};
    const link = de('copy_ticket').copy_link || '';
    ok(res, {
      link,
      acceso: de('copy_auth').copy_link || '',
      compartir: de('share_auth').share_link || '',
      /* Sin link no hay dominio configurado para esa caja: se dice, no se inventa. */
      dominio: link ? String(link).replace(/^https?:\/\//, '').split(/[?#/]/)[0] : null,
    });
  }));

  /* El dominio de una caja, para mostrarlo en su configuración. Sale de la ficha, no de una
     constante nuestra: cada caja tiene el suyo y puede no tener ninguno. */
  app.get('/api/caja/dominio', auth.requerida, wrap(async (req, res) => {
    const caja = String(req.query.caja || req.caja.id);
    const cli = auth.clienteDe(req.caja);
    const r = await cli.apiCall('useredit', {}, { id: caja });
    if (!esJson(r)) return delMotor(res, r);
    const campos = r.data.fields || {};
    const valor = (k) => {
      const c = campos[k];
      return c && typeof c === 'object' && 'value' in c ? c.value : c;
    };
    const url = String(valor('ticket_url') || '').trim();
    ok(res, { dominio: url ? url.replace(/^https?:\/\//, '') : null, url: url || null });
  }));


  /* Guardar el dominio del billete de una caja.
     ```
     POST area=useredit&id=<caja>   send=true & ticket_url=<url>
     ```
     🔑 Regla del dueño: el dominio NUNCA se deduce — y tampoco se acepta a ciegas. Antes de
        guardarlo se verifica contra «Dominios permitidos» (`usersettings&module=domains`), que
        lista los del sistema, los pelados incluidos (`ganamos-lat.com` está ahí). Si no figura, el
        link no va a funcionar y es mejor decirlo ahora que después, con el jugador afuera. */
  app.post('/api/caja/dominio', auth.requerida, wrap(async (req, res) => {
    const b = req.body || {};
    const caja = String(b.caja || req.caja.id);
    const crudo = String(b.url || '').trim();
    if (!crudo) return mal(res, 'Falta el link');

    const limpio = crudo.replace(/^https?:\/\//i, '').replace(/\/.*$/, '').trim().toLowerCase();
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(limpio)) {
      return mal(res, 'Eso no parece un link. Poné algo como «ganamos-lat.com».');
    }

    const cli = auth.clienteDe(req.caja);
    /* 🔴 SI NO SE PUEDE LEER LA LISTA, SE GUARDA PERO SE AVISA. El motor le niega `usersettings`
       a todo lo que esté por debajo de agente —contesta `error: "No rights"`, medido el
       1-sep-2026 con un cajero de prueba—, y antes esta validación se salteaba en silencio: el
       cajero grababa cualquier dominio y el panel le decía que estaba todo bien. El link del
       billete no se deduce ni se supone; si no se pudo comprobar, se dice. */
    const d = await cli.apiCall('usersettings', {}, { id: caja, module: 'domains' });
    let verificado = false;
    if (esJson(d) && !d.data.error) {
      verificado = true;
      const permitidos = Object.keys(aplanarAjustes(d.data.settings))
        .filter((k) => k.startsWith('domains/')).map((k) => k.slice(8).toLowerCase());
      if (permitidos.length && !permitidos.includes(limpio)) {
        return res.status(409).json({ ok: false, noPermitido: true,
          error: `«${limpio}» no está entre los dominios habilitados, así que el link no le va a `
            + 'funcionar a tus jugadores. Escribile a soporte para que lo habiliten.' });
      }
    }

    await cli.apiCall('useredit', { send: 'true', ticket_url: `https://${limpio}` }, { id: caja });

    const r = await cli.apiCall('useredit', {}, { id: caja });
    if (!esJson(r)) return delMotor(res, r);
    const campo = (r.data.fields || {}).ticket_url;
    const quedo = String((campo && typeof campo === 'object' ? campo.value : campo) || '');
    if (!quedo) {
      return res.status(409).json({ ok: false, sinEfecto: true,
        error: 'El casino aceptó el link pero no quedó guardado.' });
    }
    ok(res, { url: quedo, dominio: quedo.replace(/^https?:\/\//, ''), verificado,
      aviso: verificado ? null
        : `Quedó guardado, pero no pude comprobar que «${limpio}» esté habilitado: tu nivel no `
          + 'puede ver esa lista. Si a tus jugadores no les abre el link, escribile a soporte.' });
  }));


  /* ══════ LOS PERMISOS DE UN SUB-CAJERO ══════
     Viven en `useredit` de la propia cuenta, como casillas. Medido el 28-ago sobre una cuenta de
     prueba, que quedó como estaba.

     ```
     POST area=useredit&id=<subcajero>
     send=true
     hide_hall_balance=1|0     ← no ve cuántas fichas tiene la caja
     disable_statistic=1|0     ← no ve estadísticas
     cashout_all=1|0           ← puede retirar todo el saldo de un jugador
     ```

     🔴 `1` marca, `0` borra. Igual que en los permisos de caja, mandar `on` **BORRA**.
     🔑 Es DIFERENCIAL: lo que no se manda no se toca (verificado dejando `cashout_all` en 1
        mientras se cambiaba otro). */

  const PERMISOS_SUB = ['hide_hall_balance', 'disable_statistic', 'cashout_all'];

  /* ⚠️ LEER NO PUEDE ESCRIBIR. Tentaba usar el POST con la lista vacía para leer el estado, pero
     en este motor las casillas ausentes se interpretan como desmarcadas en varias áreas: abrir la
     ficha le habría borrado los permisos al sub-cajero. Se lee con su propio GET. */
  app.get('/api/caja/permisos-subcajero', auth.requerida, wrap(async (req, res) => {
    const sub = String(req.query.sub || '').trim();
    if (!sub) return mal(res, 'falta el sub-cajero');
    const r = await auth.clienteDe(req.caja).apiCall('useredit', {}, { id: sub });
    if (!esJson(r)) return delMotor(res, r);
    const campos = r.data.fields || {};
    const estado = {};
    for (const k of PERMISOS_SUB) {
      const c = campos[k];
      estado[k] = String((c && typeof c === 'object' ? c.value : c) || '0') === '1';
    }
    ok(res, { estado });
  }));

  app.post('/api/caja/permisos-subcajero', auth.requerida, wrap(async (req, res) => {
    const b = req.body || {};
    const sub = String(b.sub || '').trim();
    const permisos = b.permisos && typeof b.permisos === 'object' ? b.permisos : null;
    if (!sub) return mal(res, 'falta el sub-cajero');
    if (!permisos) return mal(res, 'no dijiste qué permiso');

    const cuerpo = { send: 'true' };
    for (const [k, v] of Object.entries(permisos)) {
      if (!PERMISOS_SUB.includes(k)) return mal(res, `«${k}» no es un permiso de sub-cajero`);
      cuerpo[k] = v ? '1' : '0';
    }
    const cli = auth.clienteDe(req.caja);
    await cli.apiCall('useredit', cuerpo, { id: sub });

    /* Se relee: el motor contesta igual haya cambiado algo o no. */
    const r = await cli.apiCall('useredit', {}, { id: sub });
    if (!esJson(r)) return delMotor(res, r);
    const campos = r.data.fields || {};
    const estado = {};
    for (const k of PERMISOS_SUB) {
      const c = campos[k];
      estado[k] = String((c && typeof c === 'object' ? c.value : c) || '0') === '1';
    }
    const fallaron = Object.entries(permisos).filter(([k, v]) => estado[k] !== !!v).map(([k]) => k);
    if (fallaron.length) {
      return res.status(409).json({ ok: false, sinEfecto: true, estado,
        error: 'El casino aceptó el cambio pero el permiso quedó como estaba.' });
    }
    ok(res, { estado });
  }));


  /* ══════ BUSCAR UN JUGADOR EN TODA LA RED ══════
     El problema real del agente: le piden fichas para un jugador y no sabe en qué caja está.

     ```
     POST area=search&response=js    search_login=<texto> & page=1
     → users: [{ id, login, group, name, create }]
     ```

     🔴 EL PARÁMETRO ES `search_login`, NO `search`. Con `search` (o `name`, o `q`) el motor
        contesta **«No todos los datos son introducidos»** con HTTP 200. Yo había concluido dos
        veces que `area=search` no andaba con api_token: andaba, le faltaba el nombre correcto.
     🔑 `create` es el ID DE LA CAJA donde vive esa cuenta. Eso es lo que resuelve la pregunta.
     🔑 `group`: 5 jugador · 8 sub-cajero · 4 caja.
     📌 Es por PREFIJO, pagina de a 10 y normaliza acentos (ver MAPEO-MOTOR.md). Y el alcance lo
        limita la propia credencial: cada uno ve lo suyo. */

  app.get('/api/caja/buscar-jugador', auth.requerida, wrap(async (req, res) => {
    const q = String(req.query.q || '').trim();
    if (q.length < 3) return mal(res, 'Escribí al menos 3 letras');
    const cli = auth.clienteDe(req.caja);
    const r = await cli.apiCall('search',
      { search_login: q, page: String(req.query.pagina || 1) }, {});
    if (!esJson(r)) return delMotor(res, r);
    if (r.data.error) return mal(res, String(r.data.error), 502);

    const TIPO = { 5: 'jugador', 8: 'subcajero', 4: 'cajero', 6: 'subagente' };
    const filas = (r.data.users || []).filter((u) => u && u.id).map((u) => ({
      id: String(u.id), login: u.login, name: u.name || '',
      tipo: TIPO[Number(u.group)] || String(u.group),
      caja: u.create ? String(u.create) : null,
    }));
    ok(res, { encontrados: filas, hayMas: r.data.next_page_enable === true || r.data.next_page_enable === '1' });
  }));


  /* ══════ CUENTAS ELIMINADAS ══════
     Medido el 31-ago creando, borrando y restaurando una cuenta descartable.

     Listar:    `area=users` con `deleted_users` → `delete` (sólo borradas) · `undelete` (sólo
                vivas, y es el DEFAULT) · `all` (las dos).
     Restaurar: `POST area=delete&id=<cuenta>` con **`restore=true`** — la misma área que borra,
                otra bandera. `area=restore` no existe.

     🔑 Borrar NO devuelve las fichas: quedan congeladas dentro de la cuenta. Por eso el saldo de
        cada eliminada se muestra, y no como un dato de color: es plata que no está viendo nadie. */

  app.get('/api/caja/eliminadas', auth.requerida, wrap(async (req, res) => {
    const caja = String(req.query.caja || req.caja.id);
    const cli = auth.clienteDe(req.caja);
    const r = await cli.apiCall('users',
      { ...rangoBarato(), inactive_users: 'all', deleted_users: 'delete', limit: '500' },
      { id: caja, offset: '1' });
    if (!esJson(r)) return delMotor(res, r);
    const filas = sinFilaTotal(r.data.users || []).map((u) => ({
      id: String(u.id), login: u.login, name: u.name || '', balances: u.balances,
    }));
    ok(res, { eliminadas: filas, caja });
  }));

  app.post('/api/caja/restaurar', auth.requerida, wrap(async (req, res) => {
    const b = req.body || {};
    const cuenta = String(b.cuenta || '').trim();
    const caja = String(b.caja || req.caja.id);
    if (!cuenta) return mal(res, 'falta la cuenta');
    const cli = auth.clienteDe(req.caja);
    await cli.apiCall('delete', { restore: 'true' }, { id: cuenta });

    /* 🔴 SE MIRA VARIAS VECES, Y EN VARIAS PÁGINAS. Antes se miraba UNA vez la primera página y,
       si la cuenta no estaba, se contestaba «sigue eliminada». Y no era cierto: la cuenta volvía
       entera un rato después. Es lo mismo que pasa en el alta — el motor tarda en mostrar lo que
       ya hizo—, y encima en una caja grande la cuenta puede estar en otra página. Medido el
       1-sep-2026 restaurando una caja de prueba.

       Si aun así no aparece, NO se dice que falló: se dice que no se pudo confirmar. Decirle a
       alguien que su cuenta sigue borrada cuando en realidad volvió lo empuja a repetir la orden
       o a dar la plata por perdida. */
    const buscarViva = async () => {
      for (let pag = 1; pag <= 3; pag += 1) {
        // eslint-disable-next-line no-await-in-loop
        const r = await cli.apiCall('users',
          { ...rangoBarato(), inactive_users: 'all', deleted_users: 'undelete', limit: '500' },
          { id: caja, offset: String(pag) });
        if (!esJson(r)) return null;
        const hallada = sinFilaTotal(r.data.users || []).find((u) => String(u.id) === cuenta);
        if (hallada) return hallada;
        if (Number(r.data.pageCount || 1) <= pag) break;
      }
      return null;
    };

    let viva = await buscarViva();
    if (!viva) {
      await new Promise((r) => { setTimeout(r, 1200); });
      viva = await buscarViva();
    }
    if (!viva) {
      return res.status(202).json({ ok: false, sinConfirmar: true,
        error: 'La orden se envió, pero el casino todavía no muestra la cuenta como activa. '
          + 'Suele tardar un momento: mirá la lista en un rato antes de volver a intentarlo.' });
    }
    ok(res, { cuenta: { id: String(viva.id), login: viva.login, balances: viva.balances } });
  }));

  /* ══════ SEGURIDAD — estas dos NO andan con token, van con sesión ══════ */

  app.get('/api/caja/cruces-ip', auth.requerida, wrap(async (req, res) => {
    const cli = auth.clienteDe(req.caja, { auditoria: true });
    const r = await cli.apiCall('intersections', {
      ...rango(req.query), limit: '1000', offset: '1',
    }, { id: req.query.id || req.caja.id });
    if (!esJson(r) || r.data.error) return soloConSesion(res, esJson(r) ? { error: r.data.error } : r);
    ok(res, { cruces: r.data.intersections || {} });
  }));

}

module.exports = { mount };
