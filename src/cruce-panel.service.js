/**
 * cruce-panel.service.js — ¿LAS CARGAS QUE SE PIDIERON SON LAS QUE REGISTRA EL PANEL?
 *
 * Hasta acá la factura decía "10 cargas en cash365.vip" y no había forma de contrastarlo: la
 * columna "Casino" de la Factura de consumo compara contra el `in` del nodo, y `in` es **lo que
 * depositan los JUGADORES**, no las fichas que se le vendieron al cliente. Son dos cosas distintas,
 * así que ese control no controla nada — Marcelo daba −50,7% sin que faltara un peso.
 *
 * El contraste real es el HISTORIAL DE BALANCE del nodo (`area=balance`, `balance_type=usual:to`
 * = "Al usuario"), que es fila por fila lo que entró a esa cuenta. Ahí la columna que decide es
 * `from`:
 *
 *     from = null   →  VENTA. Las fichas salieron de la cuenta principal: se las vendimos.
 *     from = <nodo> →  MOVIMIENTO INTERNO. Fichas que ya le habíamos vendido, bajando por el árbol.
 *                      NO se cobra: cobrarlo sería cobrar dos veces la misma venta.
 *
 * 🔴 LA MISMA URL CARGA FICHAS. En esa página del motor conviven el filtro del historial y el
 * formulario de "cambiar balance". La orden de carga es
 * `balance_currency + amount + send=true + operation`. Acá se manda ÚNICAMENTE rango, tipo y
 * moneda — nunca `amount`, `send`, `operation` ni `all` — y hay un candado abajo que ABORTA si
 * alguno aparece, en vez de filtrarlo en silencio.
 *
 * ⚠️ `balance_currency` HAY que mandarlo: sin él un nodo multi-divisa devuelve sólo su moneda
 * principal y el resto sale vacío. `LuWinCasino-SA` (ARS 0,00 + USD 1.200,82) contestaba vacío en
 * los tres balance_type aunque el saldo se había movido. Verificado que es lectura midiendo el
 * saldo antes y después.
 */
const casinoConex = require('./casino-conexiones-store');
const paneles = require('./paneles-store');
const pedidosStore = require('./pedidos-store');
const movPanel = require('./movimientos-panel');
const clientes = require('./clientes-store');
const tcUnico = require('./tc-unico.service');
const money = require('./lib/money');

/** 🔒 Lo único que puede viajar. Los cinco de la orden de carga no están, y no se agregan. */
const PERMITIDOS = new Set(['from', 'to', 'interval', 'balance_type', 'limit', 'balance_currency']);
const MUEVEN_PLATA = ['amount', 'send', 'sended', 'operation', 'all'];
function soloLectura(params) {
  for (const k of Object.keys(params)) {
    if (MUEVEN_PLATA.includes(k)) throw new Error(`cruce-panel: "${k}" carga fichas — esto es una lectura`);
    if (!PERMITIDOS.has(k)) throw new Error(`cruce-panel: parámetro no permitido "${k}"`);
  }
  return params;
}

const num = (x) => Number(String(x == null ? 0 : x).replace(/,/g, '')) || 0;
const ultimoDia = (m) => new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0)).getUTCDate();
// El casino devuelve la hora en UTC, igual que el `resueltoAt` de los pedidos: verificado al
// segundo sobre 76 cargas (`2026-08-31 16:45:33` ↔ `2026-08-31T16:45:33.461Z`). No hay que correr
// el reloj. La tolerancia es holgada por si alguna vez difieren.
const TOLERANCIA_MS = 5 * 60 * 1000;

/* 📅 DESDE CUÁNDO LOS DATOS SON CONFIABLES.
   Antes de julio de 2026 el árbol no estaba armado como ahora: se cargaba a nodos intermedios que
   después bajaban al destino, y quedaban DOS pedidos por una sola entrega (Luxor: 8 cargas a
   `GAMati-D` en may-jun que en realidad llegaban a `GAMati-A`). Esos meses están cerrados y no se
   tocan, pero tampoco se leen como si fueran comparables: se avisa. Regla de la dueña, 3-sep-2026. */
const DESDE_CONFIABLE = '2026-07';

/* Regla del dueño: una carga chica se asume prueba o reposición y no se cobra, sin preguntar.
   Es un UMBRAL ABSOLUTO, no relativo — 416.666 en reysanto-SA y 600.000 en Ahora463.com son cargas
   REALES, y se preguntó. En las demás monedas se convierte con el TC del mes en vez de inventar un
   número por moneda; si falta el TC no se aplica, porque marcar algo como prueba sin poder medirlo
   es justo la forma de que se escape plata. */
const UMBRAL_PRUEBA_ARS = 50000;

/**
 * El historial de "Al usuario" de un nodo, moneda por moneda.
 *
 * Una llamada por moneda con `limit` alto: adentro del OS la respuesta viene entera, así que no
 * hace falta paginar de a una fila como cuando se lee desde afuera.
 */
async function _historial(cli, nodoId, from, to, divisas) {
  const vueltas = (divisas && divisas.length) ? divisas : [null];
  const filas = []; const vistas = new Set(); const fallaron = [];
  for (const divisa of vueltas) {
    const params = soloLectura({
      from, to, interval: 'custom', balance_type: 'usual:to', limit: '1000',
      ...(divisa ? { balance_currency: divisa } : {}),
    });
    const r = await cli.apiCall('balance', params, { id: String(nodoId) });
    if (!r.ok || !r.data || !Array.isArray(r.data.operationsData)) {
      // Un error NO es "no hay movimientos": confundirlos deja al cliente con un panel que parece
      // vacío. Se anota cuál falló y la factura lo dice.
      fallaron.push({ divisa: divisa || 'principal', error: r.error || `respuesta inesperada (${r.status})` });
      continue;
    }
    for (const o of r.data.operationsData) {
      if (o.id && vistas.has(String(o.id))) continue;   // pedir dos monedas puede repetir filas
      if (o.id) vistas.add(String(o.id));
      filas.push({
        id: String(o.id || ''),
        desde: o.from == null || o.from === '' ? null : String(o.from),
        operacion: String(o.operation || ''),
        divisa: String(o.currency || '').toUpperCase(),
        monto: num(o.cash),
        fecha: o.datetime || null,
        iniciador: o.initiator || null,
      });
    }
  }
  return { filas, fallaron };
}

/**
 * ⭐ DE DÓNDE VINIERON LAS FICHAS — y por qué no todas las de "arriba" son lo mismo.
 *
 * El historial dice `from`: el nodo del que salieron. Ese dato decide si una carga está cobrada,
 * si ya se cobró más arriba, o si hay que mirarla. NO son todos el mismo caso:
 *
 * ┌ `from` vacío ─────────── VENTA de la cuenta principal al dueño del panel. Es lo que cobramos.
 * │
 * ├ un nodo del MISMO cliente ── redistribución suya. La venta ya ocurrió en el nodo de arriba, y
 * │   contar las dos cobraría dos veces las mismas fichas. Verificado: `goldenclub.pro` (Pistacho)
 * │   recibió 45.000.000 con `from` vacío y `Eliteadmin`, que cuelga de él, muestra los mismos
 * │   45.000.000 con `from: goldenclub.pro`. Son las mismas fichas.
 * │
 * ├ un nodo de un VENDEDOR ──── ES LA ENTREGA de una carga que SÍ facturamos. El cliente cuelga
 * │   del SuperAgente del vendedor y las fichas le bajan por ahí; la venta nuestra fue al
 * │   vendedor, que compra al costo. Verificado: `21luciadm` (Lucia) recibió dos cargas de
 * │   3.000.000 con `from: IgLatamAlexa`, y coinciden AL SEGUNDO con sus dos pedidos.
 * │   🔴 Tratarlas como "movimiento interno, no es plata" deja ciega la validación de todos los
 * │   clientes que cuelgan de un vendedor — 63 de los 207 paneles.
 * │
 * ├ un nodo de OTRO cliente facturable ── ni venta ni interno: fichas cruzando de un árbol a otro.
 * │   Se avisa, no se asume.
 * │
 * └ un nodo que no tenemos registrado ── se cruza igual, pero marcado: no lo podemos verificar.
 */
function _clasificarOrigen(login, porLogin) {
  if (login == null) return { tipo: 'venta' };
  const pan = porLogin[String(login).toLowerCase()];
  if (!pan) return { tipo: 'desconocido', login };
  const c = clientes.get(pan.cliente_id);
  return { tipo: c && c.es_vendedor ? 'vendedor' : 'cliente', login, panel: pan, cliente: c };
}

/**
 * Cruza las cargas de un cliente en un mes contra lo que registran sus paneles.
 *
 * @param detalle  las cargas ya traídas (las mismas que muestra la factura). Si no viene, se leen.
 * @returns por panel: cuántas se pidieron, cuántas registró el panel, cuáles cruzan, y CADA
 *          diferencia con su motivo — que es lo que hay que poder explicar.
 */
async function cruzar({ codigos = [], mes, detalle = null }) {
  const m = String(mes || '').slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(m)) return { ok: false, error: 'mes inválido (se espera YYYY-MM)' };
  /* El historial se pide desde una semana ANTES del mes. No es para cruzar cargas de otro mes —eso
     se sigue haciendo sólo con las del mes— sino para poder encontrar la otra mitad de un pase
     hecho a mano que cruza el borde: Titan retiró 50.000.000 de `463.live` a fin de julio y los
     cargó en `Beting-SA` el 1 de agosto. Con la ventana pegada al mes, ese retiro quedaba afuera y
     la carga aparecía como 31.555 USDT sin cobrar. */
  const desde = new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)) - 1, 1) - 7 * 86400000);
  const from = `${desde.toISOString().slice(0, 10)} 00:00:00`;
  const to = `${m}-${String(ultimoDia(m)).padStart(2, '0')} 23:59:59`;

  const cods = new Set(codigos.map((c) => String(c).toLowerCase()));
  const cargas = (detalle || pedidosStore.detalleDelMes(m))
    .filter((d) => !cods.size || cods.has(String(d.codigo).toLowerCase()));

  // Se agrupa por NODO, no por nombre de panel: el nombre puede repetirse y el nodo no.
  const porNodo = {};
  for (const c of cargas) {
    const k = String(c.userId || '');
    const n = porNodo[k] = porNodo[k] || { nodo: k, panel: c.panel, sistema: c.sistema, cargas: [] };
    n.cargas.push(c);
  }

  /* ── LOS PASES ENTRE PANELES ────────────────────────────────────────────────────────────────
     Un pase mueve fichas de un panel del cliente a otro. Como son DOS CASINOS distintos, no hay
     traslado: se retira en el origen —vuelve a la cuenta principal— y se carga en el destino desde
     la cuenta principal. O sea que en el historial **las dos mitades aparecen con `from` vacío**,
     exactamente igual que una venta.
     Sin esto, cada pase generaba una falsa alarma: el destino figuraba como "fichas entregadas y
     no cobradas" y el origen como una devolución. Verificado al segundo: el pase
     `cash365.vip → LuckyDay-SA` de 10.000.000 quedó `hecho` a las 12:44:19.669 del 17-ago, y el
     historial de LuckyDay-SA muestra esa entrada a las 12:44:19.
     Son fichas que el cliente YA compró: cobrarlas otra vez sería cobrar dos veces. */
  const pases = movPanel.list({ estado: 'hecho' })
    .map((x) => ({ ...x, at: Date.parse(x.hecho_at || x.resuelto_at || x.creado_at || 0) }))
    .filter((x) => String(x.hecho_at || x.creado_at || '').slice(0, 7) === m);

  /** ¿Es tan chica que se asume prueba o reposición? Devuelve null si no se puede medir. */
  const tcARS = tcUnico.tcDelMes('ARS', m).valor;
  const esPrueba = (divisa, monto) => {
    if (divisa === 'ARS') return monto <= UMBRAL_PRUEBA_ARS;
    const t = tcUnico.tcDelMes(divisa, m).valor;
    if (!t || !tcARS) return null;                 // sin TC no se puede medir: no se asume nada
    return Number(money.div(String(monto), t)) <= Number(money.div(String(UMBRAL_PRUEBA_ARS), tcARS));
  };

  const registrados = {}; const porLogin = {};
  paneles.list().forEach((p) => {
    if (p.id_usuario) registrados[String(p.id_usuario)] = p;
    // `from` viene como LOGIN, no como id: hace falta el índice por nombre para saber de quién es.
    if (p.nombre) porLogin[String(p.nombre).toLowerCase()] = p;
  });

  // El historial de cada nodo se lee UNA vez, aunque haga falta de nuevo para mirar el nodo padre.
  const cache = {};
  const historialDe = async (pan) => {
    const k = String(pan.id_usuario);
    if (cache[k]) return cache[k];
    const cli = casinoConex.client(pan.conexion_id);
    if (!cli) return (cache[k] = { filas: [], fallaron: [{ divisa: 'todas', error: 'la conexión al casino no está disponible' }] });
    try { cache[k] = await _historial(cli, k, from, to, pan.divisas || []); }
    catch (e) { cache[k] = { filas: [], fallaron: [{ divisa: 'todas', error: String((e && e.message) || e) }] }; }
    return cache[k];
  };

  const salida = [];
  for (const n of Object.values(porNodo)) {
    /* Un nodo que no está registrado como panel TAMBIÉN se puede consultar: el pedido dice en qué
       SISTEMA se cargó, y hay una sola conexión por sistema (Casino y Europa). Antes lo daba por
       imposible de verificar y dejaba afuera cargas que sí se cobran — GAF-ParD (Fran, 13 cargas) y
       GAMati-D (Luxor, 8) entre ellas. Se valida igual, y queda dicho que falta darlo de alta. */
    let pan = registrados[n.nodo];
    let sinRegistrar = null;
    if (!pan || !pan.conexion_id) {
      const hermano = paneles.list().find((q) => q.sistema === n.sistema && q.conexion_id);
      if (hermano) {
        sinRegistrar = `ese nodo no está dado de alta como panel: se validó por la conexión de ${n.sistema}`;
        pan = { id: null, cliente_id: (pan && pan.cliente_id) || null, nombre: n.panel,
          id_usuario: n.nodo, conexion_id: hermano.conexion_id, divisas: [] };
      }
    }
    if (!pan || !pan.conexion_id || !casinoConex.client(pan.conexion_id)) {
      salida.push({
        panel: n.panel, nodo: n.nodo, sistema: n.sistema,
        pedidas: n.cargas.length, registradas: null,
        noSePuedeVerificar: pan ? 'la conexión al casino no está disponible' : `no hay ninguna conexión para el sistema ${n.sistema}`,
        cargas: n.cargas.map((c) => ({ ...c, cruza: null })),
        diferencias: [],
      });
      continue;
    }

    const h = await historialDe(pan);
    /* 🔴 La ventana se abre una semana ANTES del mes sólo para encontrar el retiro de un pase que
       cruza el borde. Todo lo demás se mira SÓLO dentro del mes: si no, cada venta de fin del mes
       anterior —cuyo pedido está en el mes anterior— aparece como "entregada y no cobrada".
       Medido cuando faltaba este filtro: el "no se cobra" de agosto pasó de 34.091 a 164.679 USDT
       y los paneles que cuadraban de 66 a 38. Las filas sin fecha se cuentan como del mes: son las
       que el motor devuelve sin `datetime` y no hay con qué ubicarlas. */
    const inicioMes = Date.parse(`${m}-01T00:00:00Z`);
    const delMes = (f) => !f.fecha || Date.parse(`${f.fecha.replace(' ', 'T')}Z`) >= inicioMes;
    const ventas = h.filas.filter((f) => f.desde == null && f.operacion === 'in' && delMes(f));
    // Un retiro que es el ORIGEN de un pase no es una devolución: las fichas no volvieron, se
    // fueron al otro panel del mismo cliente. Confundirlos hacía que una venta legítima pareciera
    // anulada sólo porque el importe coincidía con un pase.
    // Los retiros sí se miran en toda la ventana: son los candidatos a ser la otra mitad de un pase.
    const salidas = h.filas.filter((f) => f.desde == null && f.operacion === 'out');
    const esOrigenDePase = (o) => pases.some((x) => String(x.origen_panel_id) === String(pan.id)
      && String(x.divisa || '').toUpperCase() === o.divisa
      && Math.abs(Number(x.monto) - o.monto) < 0.01);
    const devoluciones = salidas.filter((o) => !esOrigenDePase(o) && delMes(o));
    const entradas = h.filas.filter((f) => f.desde != null && f.operacion === 'in' && delMes(f));

    const cerca = (o, c) => o.fecha
      && Math.abs(Date.parse(`${o.fecha.replace(' ', 'T')}Z`) - Date.parse(c.iso)) <= TOLERANCIA_MS;
    const mismoImporte = (o, c) => o.divisa === c.divisa && Math.abs(o.monto - c.monto) < 0.01;
    /** Busca en `lista` la fila que corresponde a la carga, sin reusar ninguna. */
    const buscar = (lista, usadas, c, exigirHora) => {
      for (let i = 0; i < lista.length; i++) {
        if (usadas.has(i) || !mismoImporte(lista[i], c)) continue;
        if (exigirHora ? !cerca(lista[i], c) : lista[i].fecha) continue;
        usadas.add(i); return lista[i];
      }
      return null;
    };

    // Las salidas INTERNAS: las fichas que se fueron hacia otro nodo. Son la vuelta de una anulación
    // cuando el panel cuelga del árbol de un vendedor.
    const salidasInternas = h.filas.filter((f) => f.desde != null && f.operacion === 'out' && delMes(f));
    const usadasV = new Set(); const usadasE = new Set(); const usadasS = new Set();
    const cargasOut = []; const diferencias = [];
    let entregadasPorVendedor = 0; let bajaronDeSuArbol = 0;

    for (const c of n.cargas) {
      // 1) ¿la vendimos directo a este panel?
      let v = buscar(ventas, usadasV, c, true) || buscar(ventas, usadasV, c, false);
      let origen = v ? { tipo: 'venta' } : null;
      let via = null;

      // 2) si no, ¿entró desde otro nodo? y ahí importa DE QUIÉN es ese nodo.
      if (!v) {
        const e = buscar(entradas, usadasE, c, true) || buscar(entradas, usadasE, c, false);
        if (e) {
          origen = _clasificarOrigen(e.desde, porLogin);
          via = e.desde;
          v = e;
          if (origen.tipo === 'vendedor') entregadasPorVendedor += 1;
          else if (origen.tipo === 'cliente' && origen.panel.cliente_id === pan.cliente_id) {
            // Bajó por su propio árbol: la venta está en el nodo de arriba. Se la marca como usada
            // ahí para que ese nodo no la reporte después como "una venta que nadie pidió".
            bajaronDeSuArbol += 1;
            origen.tipo = 'propio';
            // La venta que le dio origen está en el nodo de arriba, y se descuenta allá en la
            // pasada final: hacerlo acá dependía de que ese panel se procesara DESPUÉS, y si salía
            // primero su venta quedaba marcada como "nadie la pidió".
          } else if (origen.tipo === 'cliente') {
            diferencias.push({ tipo: 'vino_de_otro_cliente', carga: c, desde: e.desde,
              motivo: `las fichas vinieron de ${e.desde}, que es un panel de ${origen.cliente ? (origen.cliente.nombre || origen.cliente.codigo) : 'otro cliente'} — no es una venta nuestra ni un movimiento suyo` });
          }
        }
      }

      if (!v) {
        diferencias.push({
          tipo: 'pedida_sin_registro', carga: c,
          motivo: h.fallaron.length
            ? 'el casino no devolvió el historial de esa moneda, así que no se pudo verificar'
            : 'el panel no registra ninguna entrada por ese importe — se está cobrando algo que no llegó',
        });
      }
      cargasOut.push({
        ...c, cruza: !!v, cruzaPorMonto: !!(v && !v.fecha),
        via, comoLlego: origen ? origen.tipo : null,
        fechaPanel: v ? v.fecha : null, iniciador: v ? v.iniciador : null,
      });
    }

    // ── entradas internas que NADIE pidió ──
    // Fichas que le bajaron al panel desde otro nodo sin una carga que las respalde. No es lo mismo
    // que una venta sin pedido —no salieron de la cuenta principal— pero para un cliente que cuelga
    // del árbol de un vendedor ES la forma en que recibe fichas, así que una sin pedido es
    // exactamente "recibió y no se le cobró". Va en su propia categoría para poder mirarla sin
    // mezclarla con las otras.
    entradas.forEach((o, i) => {
      if (usadasE.has(i)) return;
      /* 🔴 Un PASE cuyo destino cuelga hondo en el árbol no llega como venta: la cascada del OS le
         baja las fichas desde su nodo PADRE, así que `from` trae el padre y no el origen del pase.
         Buscarlo sólo entre las ventas dejaba afuera justo esos. Verificado: el pase
         `CM-21L → RM21Luciadm` de 2.000.000 quedó hecho a las 03:47:10 del 13-ago y la entrada en
         RM21Luciadm figura a las 03:47:09 con `from: RMIglatamAlexa`, que es su padre. */
      const pase = pases.find((x) => String(x.destino_panel_id) === String(pan.id)
        && String(x.divisa || '').toUpperCase() === o.divisa
        && Math.abs(Number(x.monto) - o.monto) < 0.01
        && (!o.fecha || Math.abs(Date.parse(`${o.fecha.replace(' ', 'T')}Z`) - x.at) <= TOLERANCIA_MS));
      if (pase) {
        const desde = paneles.list().find((q) => String(q.id) === String(pase.origen_panel_id));
        diferencias.push({ tipo: 'pase_entre_paneles', venta: o, paseId: pase.id,
          motivo: `es el pase que se hizo desde ${desde ? desde.nombre : 'otro panel suyo'} y bajó por `
            + `${o.desde} — fichas que el cliente ya había comprado, no una entrega nueva` });
        return;
      }
      /* 🔴 ¿Entró y VOLVIÓ? Un pedido anulado deja las dos patas, y cuando el panel cuelga del árbol
         de un vendedor las dos son INTERNAS —entra desde el padre y sale hacia el padre—, así que
         no aparecen ni en las ventas ni en las devoluciones de la cuenta principal.
         Verificado: `GanamosF01` recibió 1.000.000 desde GanamosAlexa a las 01:22:21 del 30-ago y
         los devolvió a las 01:25:14, el mismo segundo en que el pedido quedó `anulado`. Figuraba
         como "el cliente las recibió y no se le cobraron". */
      const vuelta = salidasInternas.find((x, j) => !usadasS.has(j)
        && x.divisa === o.divisa && Math.abs(x.monto - o.monto) < 0.01
        && (!x.fecha || !o.fecha || Date.parse(`${x.fecha.replace(' ', 'T')}Z`) >= Date.parse(`${o.fecha.replace(' ', 'T')}Z`))
        && (usadasS.add(j) || true));
      if (vuelta) {
        diferencias.push({ tipo: 'entro_y_volvio', venta: o, devueltaEl: vuelta.fecha,
          motivo: `entraron desde ${o.desde} y volvieron${vuelta.fecha ? ` el ${vuelta.fecha}` : ''} — `
            + 'normalmente es un pedido anulado, y funcionó bien' });
        return;
      }
      const org = _clasificarOrigen(o.desde, porLogin);
      // Si bajó de un nodo del MISMO cliente es su propia redistribución: ya se cobró arriba.
      if (org.tipo === 'cliente' && org.panel && org.panel.cliente_id === pan.cliente_id) return;
      diferencias.push({
        tipo: 'entro_sin_pedido', venta: o, desde: o.desde, origen: org.tipo,
        motivo: org.tipo === 'vendedor'
          ? `bajaron ${o.divisa} ${o.monto} desde ${o.desde} (el árbol de un vendedor) sin ningún pedido que las respalde — el cliente las recibió y no se le cobraron`
          : `entraron ${o.divisa} ${o.monto} desde ${o.desde} sin ningún pedido que las respalde`,
      });
    });

    // ── lo que el panel registra como VENTA y nadie pidió ──
    const esDeVendedor = (() => { const c = clientes.get(pan.cliente_id); return !!(c && c.es_vendedor); })();
    ventas.forEach((o, i) => {
      if (usadasV.has(i)) return;
      // ¿Es el lado de DESTINO de un pase que hizo el propio cliente entre sus paneles?
      const pase = pases.find((x) => String(x.destino_panel_id) === String(pan.id)
        && String(x.divisa || '').toUpperCase() === o.divisa
        && Math.abs(Number(x.monto) - o.monto) < 0.01
        && (!o.fecha || Math.abs(Date.parse(`${o.fecha.replace(' ', 'T')}Z`) - x.at) <= TOLERANCIA_MS));
      if (pase) {
        const desde = registrados[Object.keys(registrados).find((k) => String(registrados[k].id) === String(pase.origen_panel_id))];
        diferencias.push({ tipo: 'pase_entre_paneles', venta: o, paseId: pase.id,
          motivo: `es el pase que se hizo desde ${desde ? desde.nombre : 'otro panel suyo'} — fichas que el cliente ya había comprado, no una venta nueva` });
        return;
      }
      const dev = devoluciones.find((d) => d.divisa === o.divisa && Math.abs(d.monto - o.monto) < 0.01);
      // Chica y sin pedido: es una prueba o una reposición, no un agujero. Confirmado por la dueña
      // sobre la de 50.000 en Celuapuestas-SA del 3-ago: *"ese fue un testeo mío en agosto"*.
      const chica = !dev && !esDeVendedor ? esPrueba(o.divisa, o.monto) : false;
      if (chica === true) {
        diferencias.push({ tipo: 'probable_prueba', venta: o,
          motivo: `son ${o.divisa} ${o.monto}: por debajo del umbral de prueba o reposición. `
            + 'Se informa igual — que se asuma prueba no quiere decir que no haya que verlo' });
        return;
      }
      // 🔴 `null` = falta el TC de esa moneda, así que NO se puede medir si es chica ni cuánto vale.
      // Eso no se resuelve suponiendo: se dice que no se pudo medir. Callarlo dejaría una entrada
      // sin respaldo escondida detrás de un importe en cero.
      if (chica === null) {
        diferencias.push({ tipo: 'sin_tc_no_medible', venta: o,
          motivo: `entraron ${o.divisa} ${o.monto} sin pedido y ${o.divisa} no tiene tipo de cambio `
            + `cargado en ${m}: no se puede saber cuánto es ni si entra en el umbral de prueba` });
        return;
      }
      diferencias.push({
        tipo: dev ? 'registrada_y_devuelta' : (esDeVendedor ? 'compra_del_vendedor' : 'registrada_sin_pedido'),
        venta: o,
        devueltaEl: dev ? dev.fecha : null,
        motivo: dev
          ? `se cargó y se devolvió${dev.fecha ? ` el ${dev.fecha}` : ''} — normalmente es un pedido anulado`
          : (esDeVendedor
            ? 'es la compra del vendedor, que compra al costo y reparte a sus clientes — no es una carga sin cobrar'
            : 'entró al panel desde la cuenta principal sin un pedido que lo respalde — son fichas entregadas y no cobradas'),
      });
    });

    const porDivisa = {};
    cargasOut.forEach((c) => {
      const d = porDivisa[c.divisa] = porDivisa[c.divisa] || { divisa: c.divisa, pedidas: 0, cruzan: 0, monto: '0' };
      d.pedidas += 1; if (c.cruza) d.cruzan += 1;
      d.monto = money.add(d.monto, String(c.monto));
    });
    Object.values(porDivisa).forEach((d) => { d.monto = money.round(d.monto, 2); });

    salida.push({
      panel: n.panel, nodo: n.nodo, sistema: n.sistema,
      sinRegistrar,
      cliente_id: pan.cliente_id, panel_id: pan.id,
      // Los retiros que quedaron SUELTOS: no son el origen de un pase registrado y tampoco
      // explicaron una anulación en este panel. Son los candidatos a ser la otra mitad de un pase
      // hecho a mano, que se busca en la pasada final.
      // Acá sí entra toda la ventana, incluida la semana previa: es lo que hace que el pase de
      // Titan —retiro el 31 de julio, carga el 1 de agosto— se pueda reconocer.
      salidasLibres: salidas.filter((o) => !esOrigenDePase(o)).filter((o) => !diferencias.some(
        (d) => d.tipo === 'registrada_y_devuelta' && d.venta.divisa === o.divisa
          && Math.abs(d.venta.monto - o.monto) < 0.01)),
      esDeVendedor,
      pedidas: n.cargas.length,
      registradas: ventas.length,
      entregadasPorVendedor,
      bajaronDeSuArbol,
      devoluciones: devoluciones.length,
      cruzan: cargasOut.filter((c) => c.cruza).length,
      // Un panel con una prueba o con una moneda que no se puede medir NO cuadra: cuadrar es que no
      // quede nada por mirar, y las dos cosas hay que verlas.
      cuadra: cargasOut.every((c) => c.cruza)
        && !diferencias.some((d) => ['registrada_sin_pedido', 'vino_de_otro_cliente', 'entro_sin_pedido',
          'probable_prueba', 'sin_tc_no_medible'].includes(d.tipo)),
      incompleto: h.fallaron.length ? h.fallaron : null,
      porDivisa: Object.values(porDivisa).sort((a, b) => Number(b.monto) - Number(a.monto)),
      cargas: cargasOut,
      diferencias,
    });
  }

  /* ── PASES HECHOS A MANO ────────────────────────────────────────────────────────────────────
     El pase por el sistema es nuevo: antes las fichas se movían entrando al casino. Esos no están
     en `movimiento_panel`, pero se reconocen igual — dejan una VENTA sin pedido en el panel de
     destino y un RETIRO del mismo importe en otro panel del MISMO cliente.
     Verificado con Titan: `Beting-SA` recibió 50.000.000 el 1-ago y `463.live` tiene un retiro de
     exactamente 50.000.000 en el mismo tramo. No es una venta: son fichas que ya había comprado.
     Se dice "parece" a propósito — las filas del motor a veces vuelven sin hora, así que el cruce
     es por importe y no se puede afirmar más que eso. */
  for (const p of salida) {
    if (!p.cliente_id) continue;
    for (const d of (p.diferencias || [])) {
      if (d.tipo !== 'registrada_sin_pedido') continue;
      const otro = salida.find((q) => q !== p && q.cliente_id === p.cliente_id
        && (q.salidasLibres || []).some((o) => o.divisa === d.venta.divisa
          && Math.abs(o.monto - d.venta.monto) < 0.01 && !o._usada));
      if (!otro) continue;
      const fila = otro.salidasLibres.find((o) => o.divisa === d.venta.divisa
        && Math.abs(o.monto - d.venta.monto) < 0.01 && !o._usada);
      fila._usada = true;
      d.tipo = 'pase_a_mano';
      d.desde = otro.panel;
      d.motivo = `parece un pase hecho a mano: ${otro.panel} tiene un retiro de ${d.venta.divisa} `
        + `${d.venta.monto} en el mismo mes. Serían fichas que el cliente ya había comprado, movidas `
        + 'entre sus propios paneles — no una venta nueva';
    }
  }
  /* La venta del nodo de arriba que después BAJÓ a un panel del mismo cliente no es una venta sin
     pedido: el pedido existe, está abajo. Se descuenta acá y no cuando se arma cada panel, porque
     ahí dependía del orden en que se procesaran y el padre podía salir primero. */
  for (const p of salida) {
    for (const c of (p.cargas || [])) {
      if (!c.cruza || c.comoLlego !== 'propio') continue;
      const arriba = salida.find((q) => q.panel === c.via || String(q.nodo) === String(c.via));
      if (!arriba) continue;
      const i = (arriba.diferencias || []).findIndex((d) => d.tipo === 'registrada_sin_pedido'
        && d.venta.divisa === c.divisa && Math.abs(d.venta.monto - c.monto) < 0.01);
      if (i >= 0) arriba.diferencias.splice(i, 1);
    }
  }

  /* ── 🔴 DOS PEDIDOS PARA LA MISMA ENTREGA ────────────────────────────────────────────────────
     La carga entra a un nodo intermedio y baja al destino en el mismo segundo. Si en el OS hay un
     pedido para CADA tramo, y los dos llevan el código del mismo cliente, se le está cobrando dos
     veces la misma ficha — y todo cuadra, porque cada pedido tiene su movimiento.
     Verificado con Luxor: GAMati-D recibió 10.000.000 el 2026-06-20T23:09:32 y GAMati-A los mismos
     10.000.000 a las 23:09:36 con from: GAMati-D. Dos pedidos, una sola entrega.
     Se busca desde la carga del HIJO, que es la que sabe de dónde vino. */
  for (const p of salida) {
    for (const c of (p.cargas || [])) {
      if (!c.cruza || c.comoLlego !== 'propio') continue;
      const arriba = salida.find((q) => q.panel === c.via || String(q.nodo) === String(c.via));
      if (!arriba) continue;
      const gemela = (arriba.cargas || []).find((x) => x.divisa === c.divisa
        && Math.abs(x.monto - c.monto) < 0.01
        && Math.abs(Date.parse(x.iso) - Date.parse(c.iso)) <= TOLERANCIA_MS
        && x.id !== c.id);
      if (!gemela) continue;
      p.diferencias.push({
        tipo: 'cobrada_dos_veces', carga: c, gemela, desde: c.via,
        motivo: `estas mismas fichas tienen otro pedido cargado a ${arriba.panel} (${gemela.fecha} ${gemela.hora}) `
          + 'por el mismo importe y en el mismo momento: entraron ahí y bajaron acá, es una sola entrega '
          + 'facturada dos veces',
      });
    }
  }

  salida.forEach((p) => { delete p.salidasLibres; });
  salida.forEach((p) => {
    p.cuadra = p.cargas.every((c) => c.cruza)
      && !p.diferencias.some((d) => !d.resuelta && ['registrada_sin_pedido', 'vino_de_otro_cliente',
        'entro_sin_pedido', 'probable_prueba', 'sin_tc_no_medible', 'cobrada_dos_veces'].includes(d.tipo));
  });

  /* Las que ya se miraron dejan de contar. No se borran ni se esconden: se marcan con quién las
     revisó y cuándo, y salen del recuento de plata para que el aviso vuelva a hablar sólo de lo
     que nadie vio todavía. */
  const yaVistas = resoluciones(m);
  for (const p of salida) {
    for (const d of (p.diferencias || [])) {
      const o = d.venta || d.carga;
      if (!o) continue;
      d.clave = claveDe(m, p.nodo, { divisa: o.divisa, monto: o.monto, fecha: o.fecha || null });
      const r = yaVistas[d.clave];
      if (r) d.resuelta = { decision: r.decision, motivo: r.motivo, quien: r.quien, cuando: r.cuando };
    }
  }

  salida.sort((a, b) => b.pedidas - a.pedidas);
  return {
    ok: true,
    mes: m,
    paneles: salida,
    totales: {
      pedidas: salida.reduce((a, p) => a + p.pedidas, 0),
      cruzan: salida.reduce((a, p) => a + p.cruzan, 0),
      sinRegistro: salida.reduce((a, p) => a + p.diferencias.filter((d) => d.tipo === 'pedida_sin_registro').length, 0),
      sinPedido: salida.reduce((a, p) => a + p.diferencias.filter((d) => d.tipo === 'registrada_sin_pedido').length, 0),
      entroSinPedido: salida.reduce((a, p) => a + p.diferencias.filter((d) => d.tipo === 'entro_sin_pedido').length, 0),
      entraronYVolvieron: salida.reduce((a, p) => a + p.diferencias.filter((d) => d.tipo === 'entro_y_volvio').length, 0),
      deOtroCliente: salida.reduce((a, p) => a + p.diferencias.filter((d) => d.tipo === 'vino_de_otro_cliente').length, 0),
      comprasDeVendedor: salida.reduce((a, p) => a + p.diferencias.filter((d) => d.tipo === 'compra_del_vendedor').length, 0),
      pasesEntrePaneles: salida.reduce((a, p) => a + p.diferencias.filter((d) => d.tipo === 'pase_entre_paneles').length, 0),
      pasesAMano: salida.reduce((a, p) => a + p.diferencias.filter((d) => d.tipo === 'pase_a_mano').length, 0),
      probablesPruebas: salida.reduce((a, p) => a + p.diferencias.filter((d) => d.tipo === 'probable_prueba').length, 0),
      sinTcNoMedible: salida.reduce((a, p) => a + p.diferencias.filter((d) => d.tipo === 'sin_tc_no_medible').length, 0),
      cobradasDosVeces: salida.reduce((a, p) => a + p.diferencias.filter((d) => d.tipo === 'cobrada_dos_veces').length, 0),
      panelesQueCuadran: salida.filter((p) => p.cuadra).length,
      panelesSinVerificar: salida.filter((p) => p.noSePuedeVerificar).length,
    },
  };
}

/**
 * ⭐ VALIDA UN MES ENTERO contra los paneles, en una sola pasada.
 *
 * Es lo que corre ANTES de emitir. La emisión convierte el número en deuda: si una carga que se
 * factura no existe en el panel se está cobrando de más, y si el panel entregó fichas que nadie
 * pidió no se está cobrando. El panel es la validación, así que no se emite sin haberlo mirado.
 *
 * Cada panel se lee UNA vez aunque lo compartan varios clientes, y el resultado se atribuye a
 * quien corresponda por el código de la carga.
 *
 * Lo que NO es un hallazgo, y por eso se separa:
 *   · las cargas que bajan del SuperAgente de un vendedor son movimientos internos;
 *   · una venta que se cargó y se devolvió es un pedido anulado que funcionó bien.
 */
async function cruzarMes(mes) {
  const m = String(mes || '').slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(m)) return { ok: false, error: 'mes inválido (se espera YYYY-MM)' };

  const cargas = pedidosStore.detalleDelMes(m);
  if (!cargas.length) return { ok: true, mes: m, paneles: [], porCliente: [], totales: _totalesVacios(), sinCargas: true };

  const r = await cruzar({ mes: m, detalle: cargas });
  if (!r.ok) return r;

  // a quién pertenece cada código
  const deCodigo = {};
  clientes.list().clientes.forEach((c) => { deCodigo[String(c.codigo).toLowerCase()] = c; });
  const usdt = (monto, divisa) => {
    const t = tcUnico.tcDelMes(divisa, m);
    return t.valor ? money.div(String(monto), t.valor) : null;
  };

  const porCliente = {};
  const dueño = (cod) => deCodigo[String(cod || '').toLowerCase()] || null;
  const acc = (c) => {
    const k = c ? c.id : '__sin_cliente__';
    return porCliente[k] = porCliente[k] || {
      cliente_id: c ? c.id : null, nombre: c ? (c.nombre || c.nombreVisible) : '(código sin cliente)',
      codigo: c ? c.codigo : null, es_vendedor: !!(c && c.es_vendedor),
      cobraDeMas_usdt: '0', noSeCobra_usdt: '0', sinValidar_usdt: '0',
      cargasSinRegistro: 0, ventasSinPedido: 0, cargasSinValidar: 0, deOtroCliente: 0,
      pruebas: 0, pruebas_usdt: '0', sinTc: 0, dosVeces: 0, dosVeces_usdt: '0', dePaso: 0, paneles: [],
    };
  };

  for (const p of r.paneles) {
    // Un panel que no se puede consultar no se da por bueno: se marca SIN VALIDAR y se dice.
    if (p.noSePuedeVerificar || p.incompleto) {
      for (const c of p.cargas.length ? p.cargas : []) {
        const a = acc(dueño(c.codigo)); a.cargasSinValidar += 1;
        a.sinValidar_usdt = money.add(a.sinValidar_usdt, usdt(c.monto, c.divisa) || '0');
        if (!a.paneles.includes(p.panel)) a.paneles.push(p.panel);
      }
      continue;
    }
    // Una carga que NO cruzó es plata: se le está cobrando algo que el panel no registra haber
    // recibido. Las que sí cruzaron ya están, sin importar si llegaron como venta directa, bajando
    // por su propio árbol o entregadas por el vendedor — son tres caminos, no tres problemas.
    for (const c of p.cargas) {
      if (c.cruza) continue;
      if ((p.diferencias || []).some((d) => d.resuelta && d.carga && d.carga.id === c.id)) continue;
      const a = acc(dueño(c.codigo)); a.cargasSinRegistro += 1;
      a.cobraDeMas_usdt = money.add(a.cobraDeMas_usdt, usdt(c.monto, c.divisa) || '0');
      if (!a.paneles.includes(p.panel)) a.paneles.push(p.panel);
    }
    // Fichas que vinieron del árbol de OTRO cliente: ni venta nuestra ni movimiento suyo.
    for (const d of (p.diferencias || []).filter((x) => x.tipo === 'vino_de_otro_cliente' && !x.resuelta)) {
      const a = acc(dueño(d.carga.codigo)); a.deOtroCliente = (a.deOtroCliente || 0) + 1;
      if (!a.paneles.includes(p.panel)) a.paneles.push(p.panel);
    }
    // Las ventas que nadie pidió se le imputan al DUEÑO del panel: no hay código del que colgarlas.
    // Las compras del VENDEDOR quedan afuera: compra al costo y reparte, no es una carga sin cobrar
    // (sin esto, `GanamosBot-SA` solo metía 85.782 USDT de falsa alarma).
    // Ni la compra del vendedor ni un pase entre sus propios paneles son plata sin cobrar.
    /* Las pruebas y las que no se pueden medir NO son plata sin cobrar, pero SÍ se informan.
       Regla de la dueña (3-sep-2026): «cualquier cosa que no cuadre, que no cierre, incluso los
       movimientos que asumimos como test, se me deben avisar». Van en su propia columna. */
    for (const d of (p.diferencias || []).filter((x) => x.tipo === 'probable_prueba' && !x.resuelta)) {
      const pan = paneles.list().find((x) => String(x.id_usuario) === String(p.nodo));
      const a = acc(pan ? clientes.get(pan.cliente_id) : null);
      a.pruebas += 1;
      a.pruebas_usdt = money.add(a.pruebas_usdt, usdt(d.venta.monto, d.venta.divisa) || '0');
      if (!a.paneles.includes(p.panel)) a.paneles.push(p.panel);
    }
    // Cobrar dos veces la misma entrega es el error más caro de todos: se le imputa al cliente
    // cuyo código lleva la carga, que es a quien se le está cobrando de más.
    for (const d of (p.diferencias || []).filter((x) => x.tipo === 'cobrada_dos_veces' && !x.resuelta)) {
      const a = acc(dueño(d.carga.codigo));
      a.dosVeces += 1;
      a.dosVeces_usdt = money.add(a.dosVeces_usdt, usdt(d.carga.monto, d.carga.divisa) || '0');
      if (!a.paneles.includes(p.panel)) a.paneles.push(p.panel);
    }
    for (const d of (p.diferencias || []).filter((x) => x.tipo === 'sin_tc_no_medible' && !x.resuelta)) {
      const pan = paneles.list().find((x) => String(x.id_usuario) === String(p.nodo));
      const a = acc(pan ? clientes.get(pan.cliente_id) : null);
      a.sinTc += 1;
      if (!a.paneles.includes(p.panel)) a.paneles.push(p.panel);
    }
    const sinPedido = (p.diferencias || []).filter((d) => !d.resuelta
      && (d.tipo === 'registrada_sin_pedido' || d.tipo === 'entro_sin_pedido'));
    if (sinPedido.length) {
      const pan = paneles.list().find((x) => String(x.id_usuario) === String(p.nodo));
      const c = pan ? clientes.get(pan.cliente_id) : null;
      const a = acc(c);
      for (const d of sinPedido) {
        a.ventasSinPedido += 1;
        a.noSeCobra_usdt = money.add(a.noSeCobra_usdt, usdt(d.venta.monto, d.venta.divisa) || '0');
      }
      if (!a.paneles.includes(p.panel)) a.paneles.push(p.panel);
    }
  }

  /* ── LA CARGA DEL VENDEDOR QUE BAJÓ A UN CLIENTE ────────────────────────────────────────────
     Un vendedor carga a su SuperAgente y de ahí baja al panel del cliente. Si hay un pedido por
     cada tramo —uno con el código del vendedor y otro con el del cliente— la entrega es UNA, y si
     el vendedor tiene % base se le estaría cobrando a él lo mismo que al cliente.
     No se descuenta solo: se avisa, porque quién paga qué es una decisión comercial. Medido: de las
     6 cargas de Alexa, 3 bajaron a clientes y 3 se las quedó. */
  const todas = cargas;
  const esVend = {}; clientes.list().clientes.forEach((c) => { esVend[String(c.codigo).toLowerCase()] = !!c.es_vendedor; });
  for (const p of r.paneles) {
    for (const c of (p.cargas || [])) {
      if (!esVend[String(c.codigo).toLowerCase()]) continue;
      const par = todas.find((x) => x.id !== c.id && x.divisa === c.divisa
        && Math.abs(x.monto - c.monto) < 0.01
        && String(x.codigo).toLowerCase() !== String(c.codigo).toLowerCase()
        && Math.abs(Date.parse(x.iso) - Date.parse(c.iso)) <= 5 * 60 * 1000);
      if (!par) continue;
      const cl = dueño(c.codigo);
      if (!cl || !Number(cl.precio_base_pct)) continue;    // en 0% no se le cobra: no hay conflicto
      const a = acc(cl); a.dePaso = (a.dePaso || 0) + 1;
      if (!a.paneles.includes(p.panel)) a.paneles.push(p.panel);
      (p.diferencias = p.diferencias || []).push({
        tipo: 'carga_de_paso', carga: c, par,
        motivo: `esta carga del vendedor bajó a ${par.panel} y ahí hay otro pedido por el mismo `
          + `importe con el código ${par.codigo}: la entrega es una sola y se estaría cobrando dos veces`,
      });
    }
  }

  const lista = Object.values(porCliente).map((a) => ({
    ...a,
    cobraDeMas_usdt: money.round(a.cobraDeMas_usdt, 2),
    noSeCobra_usdt: money.round(a.noSeCobra_usdt, 2),
    sinValidar_usdt: money.round(a.sinValidar_usdt, 2),
    pruebas_usdt: money.round(a.pruebas_usdt, 2),
    dosVeces_usdt: money.round(a.dosVeces_usdt, 2),
  })).filter((a) => a.cargasSinRegistro || a.ventasSinPedido || a.cargasSinValidar || a.deOtroCliente
    || a.pruebas || a.sinTc || a.dosVeces || a.dePaso)
    .sort((a, b) => Number(b.noSeCobra_usdt) + Number(b.cobraDeMas_usdt) - (Number(a.noSeCobra_usdt) + Number(a.cobraDeMas_usdt)));

  const sum = (k) => money.round(money.sum(lista.map((a) => a[k])), 2);
  return {
    ok: true, mes: m, validadoAt: new Date().toISOString(),
    paneles: r.paneles,
    porCliente: lista,
    totales: {
      panelesMirados: r.paneles.length,
      panelesQueCuadran: r.paneles.filter((p) => p.cuadra).length,
      panelesSinValidar: r.paneles.filter((p) => p.noSePuedeVerificar || p.incompleto).length,
      cargas: r.totales.pedidas,
      cruzan: r.totales.cruzan,
      cobraDeMas_usdt: sum('cobraDeMas_usdt'),
      noSeCobra_usdt: sum('noSeCobra_usdt'),
      sinValidar_usdt: sum('sinValidar_usdt'),
      deOtroCliente: lista.reduce((a, x) => a + (x.deOtroCliente || 0), 0),
      // Los tres caminos por los que una carga llega bien. Se cuentan para poder decir "estas
      // 61 no son un problema, es cómo entrega el vendedor" en vez de dejarlas como ruido.
      entregadasPorVendedor: r.paneles.reduce((a, p) => a + (p.entregadasPorVendedor || 0), 0),
      bajaronDeSuArbol: r.paneles.reduce((a, p) => a + (p.bajaronDeSuArbol || 0), 0),
      comprasDeVendedor: r.totales.comprasDeVendedor,
      pasesEntrePaneles: r.totales.pasesEntrePaneles,
      entraronYVolvieron: r.totales.entraronYVolvieron,
      pasesAMano: r.totales.pasesAMano,
      probablesPruebas: r.totales.probablesPruebas,
      sinTcNoMedible: r.totales.sinTcNoMedible,
      cobradasDosVeces: r.totales.cobradasDosVeces,
      cargasDePaso: lista.reduce((a, x) => a + (x.dePaso || 0), 0),
      // Los meses viejos se leen distinto: el árbol no estaba armado como ahora.
      anteriorAlCorte: m < DESDE_CONFIABLE ? DESDE_CONFIABLE : null,
      pruebas_usdt: money.round(money.sum(lista.map((a) => a.pruebas_usdt)), 2),
      dosVeces_usdt: money.round(money.sum(lista.map((a) => a.dosVeces_usdt)), 2),
      clientesConDiferencias: lista.length,
      yaRevisadas: r.paneles.reduce((a, p) => a + (p.diferencias || []).filter((d) => d.resuelta).length, 0),
    },
  };
}

function _totalesVacios() {
  return { panelesMirados: 0, panelesQueCuadran: 0, panelesSinValidar: 0, cargas: 0, cruzan: 0,
    cobraDeMas_usdt: '0', noSeCobra_usdt: '0', sinValidar_usdt: '0', clientesConDiferencias: 0 };
}

/**
 * ¿Hay algo que sea plata? Es lo que decide si la emisión pide confirmación.
 *
 * 🔴 Se mira la CANTIDAD, no el importe en USDT. Si a una moneda le falta el tipo de cambio del
 * mes, su importe se convierte en 0 — y con la condición puesta sobre el USDT, una carga sin
 * respaldo en una moneda sin TC no disparaba ningún aviso. Justo el caso que hay que ver.
 */
function hayQueMirar(v) {
  if (!v || !v.ok) return false;
  const t = v.totales;
  // Todo lo que no cierra se avisa, incluidas las que se asumen prueba y las que no se pudieron
  // medir por falta de TC. Que el sistema tenga una explicación no quiere decir que no haya que verlo.
  return (v.porCliente || []).some((c) => c.cargasSinRegistro || c.ventasSinPedido
      || c.deOtroCliente || c.pruebas || c.sinTc || c.dosVeces || c.dePaso)
    || t.panelesSinValidar > 0 || (t.cobradasDosVeces || 0) > 0;
}

/**
 * La clave de un movimiento, para poder decir "esto ya lo miré".
 *
 * Va sin el TIPO a propósito: si mañana el cruce clasifica mejor la misma fila —de "sin pedido" a
 * "pase a mano", por ejemplo— la resolución que ya se anotó sigue valiendo. Lo que identifica al
 * movimiento es el nodo, la moneda, el importe y la hora, no cómo lo llamamos nosotros.
 */
function claveDe(mes, nodo, o) {
  return [String(mes), String(nodo), String(o.divisa || ''), String(o.monto), String(o.fecha || '')].join('|');
}

/** Las diferencias que ya se miraron en un mes, por clave. */
function resoluciones(mes) {
  const { db } = require('./db');
  const out = {};
  db.prepare('SELECT * FROM diferencia_resuelta WHERE mes=?').all(String(mes || '').slice(0, 7))
    .forEach((r) => { out[r.clave] = r; });
  return out;
}

/** Deja anotado que alguien miró una diferencia. No borra ni corrige: sólo dice quién y cuándo. */
function resolver({ mes, nodo, panel, cliente_id, divisa, monto, fecha, decision, motivo, quien }) {
  if (!['prueba', 'revisada'].includes(decision)) return { ok: false, error: `decisión inválida: ${decision}` };
  const { db } = require('./db');
  const clave = claveDe(mes, nodo, { divisa, monto, fecha });
  db.prepare(`INSERT INTO diferencia_resuelta
      (clave, mes, nodo, panel, cliente_id, divisa, monto, fecha, decision, motivo, quien, cuando)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(clave) DO UPDATE SET decision=excluded.decision, motivo=excluded.motivo,
        quien=excluded.quien, cuando=excluded.cuando`)
    .run(clave, String(mes).slice(0, 7), String(nodo), panel || null, cliente_id || null,
      divisa || null, String(monto), fecha || null, decision, motivo || null,
      quien || 'admin', new Date().toISOString());
  return { ok: true, clave };
}

/** Deshace una resolución: si se marcó por error, tiene que poder volver a aparecer. */
function desresolver(clave) {
  const { db } = require('./db');
  const n = db.prepare('DELETE FROM diferencia_resuelta WHERE clave=?').run(String(clave)).changes;
  return { ok: true, borradas: n };
}

/** Guarda la validación de un mes. Se mira de nuevo meses después sin volver a preguntarle al casino. */
function guardar(v, { confirmadoPor = null } = {}) {
  if (!v || !v.ok) return null;
  const { db } = require('./db');
  const t = v.totales;
  db.prepare(`INSERT INTO validacion_mes
      (mes, datos, cobra_de_mas, no_se_cobra, sin_validar, clientes_con_diferencias, validado_at, confirmado_at, confirmado_por)
      VALUES (?,?,?,?,?,?,?,?,?)
      ON CONFLICT(mes) DO UPDATE SET datos=excluded.datos, cobra_de_mas=excluded.cobra_de_mas,
        no_se_cobra=excluded.no_se_cobra, sin_validar=excluded.sin_validar,
        clientes_con_diferencias=excluded.clientes_con_diferencias, validado_at=excluded.validado_at,
        confirmado_at=COALESCE(excluded.confirmado_at, validacion_mes.confirmado_at),
        confirmado_por=COALESCE(excluded.confirmado_por, validacion_mes.confirmado_por)`)
    .run(v.mes, JSON.stringify(v), t.cobraDeMas_usdt, t.noSeCobra_usdt, t.sinValidar_usdt,
      t.clientesConDiferencias, v.validadoAt,
      confirmadoPor ? new Date().toISOString() : null, confirmadoPor);
  return leer(v.mes);
}

/** La validación guardada de un mes, o null si nunca se corrió. */
function leer(mes) {
  const { db } = require('./db');
  const r = db.prepare('SELECT * FROM validacion_mes WHERE mes=?').get(String(mes || '').slice(0, 7));
  if (!r) return null;
  let datos = null; try { datos = JSON.parse(r.datos); } catch (e) { /* la fila igual sirve */ }
  return {
    mes: r.mes, validadoAt: r.validado_at,
    confirmadoAt: r.confirmado_at, confirmadoPor: r.confirmado_por,
    cobraDeMas_usdt: r.cobra_de_mas, noSeCobra_usdt: r.no_se_cobra, sinValidar_usdt: r.sin_validar,
    clientesConDiferencias: r.clientes_con_diferencias,
    datos,
  };
}

module.exports = { cruzar, cruzarMes, hayQueMirar, guardar, leer, resolver, desresolver, resoluciones, claveDe, _soloLectura: soloLectura };
