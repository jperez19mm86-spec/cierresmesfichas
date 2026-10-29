/**
 * cuenta.routes.js — La cuenta corriente: movimientos, pagos, cobranzas, comprobantes, deuda, carga y billeteras.
 * Sale de os.routes.js (fase 2): las rutas se movieron tal cual y en el mismo orden.
 */
const clientes = require('../clientes-store');
const paneles = require('../paneles-store');
const tcStore = require('../tc-store');
const movs = require('../movimientos-store');
const historial = require('../historial');
const deudaSvc = require('../deuda.service');
const tcSvc = require('../tc.service');
const tcDivisas = require('../tc-divisas.service');
const { parseMonto } = require('../lib/monto');
const { mesCierre: mesCierreLbl } = require('../lib/fechas');
const pedidosStore = require('../pedidos-store');
const deudaCargaSvc = require('../deuda-carga.service');
const externosSvc = require('../externos.service');
const comprobantes = require('../comprobantes-store');
const crucePanel = require('../cruce-panel.service');
const facturasGuardadas = require('../facturas-guardadas');
const configStore = require('../config-store');
const telegram = require('../telegram');
const billeteras = require('../billeteras-store');
const tipoArchivo = require('../lib/tipo-archivo');
/* ── CUÁNTO PUEDE SEPARARSE EL CAMBIO DE UN COMPROBANTE DEL DE HOY ───────────────────────────
   Aprobar un comprobante es aceptar su tipo de cambio: si se acepta uno lejos del mercado, la
   diferencia la pone la empresa. Regla del dueño (26-oct-2026): hasta 4% está bien. Configurable
   porque el número lo decide el negocio, no el código. */
const TC_DIF_MAX_PCT = Number(process.env.TC_DIF_MAX_PCT || 4);
const chat = require('../chat-externo.store');
const money = require('../lib/money');
const { mesTZ } = require('../lib/fechas'); // fechaTZ/mesTZ=ART (billing) · fechaUTC/mesUTC=UTC (casino)
const { ok, err, wrap, _espejarCaja } = require('./comun');

/* El mes a mes de una cuenta, con la regla de lo que debe (ver la ruta /api/os/cuenta). Lo usan la
   cuenta del cliente y la cobranza de la lista: los dos tienen que decir lo mismo. */
function mesesDeLaCuenta(cli, movimientos, cuenta) {
    const col = deudaSvc.columnaDe(cuenta.moneda);
    const meses = {};
    const fila = (m) => (meses[m] = meses[m] || {
      mes: m, consumo: '0', externos: '0', otros: '0', pagos: '0',
      facturado: '0', movimientos: 0,
    });
    for (const mv of movimientos) {
      const m = movs.mesDe(mv);
      if (!/^\d{4}-\d{2}$/.test(m)) continue;
      const signo = deudaSvc.signoDe(mv.tipo);
      const val = Number(mv[col]);
      const f = fila(m); f.movimientos += 1;
      if (!signo || !Number.isFinite(val) || !val) continue;
      const v = String(signo * val);
      if (mv.tipo === 'carga' || (mv.tipo === 'correccion' && mv.pedido_id)) f.consumo = money.add(f.consumo, v);
      else if (mv.tipo === 'proveedor_extra') f.externos = money.add(f.externos, v);
      else if (mv.tipo === 'pago') f.pagos = money.sub(f.pagos, v);
      else f.otros = money.add(f.otros, v);
    }

    // Un mes puede tener factura generada y todavía ningún movimiento (si no se emitió): igual tiene
    // que aparecer, o el historial de facturas queda con agujeros.
    facturasGuardadas.delCliente(cli.id).forEach((g) => fila(g.mes));
    const filas = Object.values(meses).sort((a, b) => a.mes.localeCompare(b.mes));
    let acum = '0';
    for (const f of filas) {
      f.facturado = money.round(money.add(money.add(f.consumo, f.externos), f.otros), 2);
      acum = money.sub(money.add(acum, f.facturado), f.pagos);
      f.saldo_acumulado = money.round(acum, 2);
      ['consumo', 'externos', 'otros', 'pagos'].forEach((k) => { f[k] = money.round(f[k], 2); });
    }
    return filas;
}

/* ── LA COBRANZA DE LA LISTA (29-oct-2026) ─────────────────────────────────────────────────────
   Cuánto debe no alcanza para cobrar: deber 2.000 de este mes no es lo mismo que 2.000 de julio.
   Los pagos se aplican a lo más viejo (FIFO): lo que debe se reparte desde el mes más nuevo hacia
   atrás, y el último mes que todavía tiene algo es «debe desde». No cambia ningún número: lee. */
function cobranzaDe(cli, mesHoy) {
  const movimientos = movs.list({ cliente_id: cli.id });
  const cuenta = deudaSvc.cuentaCorriente(cli.id);
  const col = deudaSvc.columnaDe(cuenta.moneda);
  const ult = (tipo) => movimientos.filter((m) => m.tipo === tipo && m.fecha)
    .sort((a, b) => String(b.fecha).localeCompare(String(a.fecha)))[0];
  const up = ult('pago'), uc = ult('carga');
  const r = { cliente_id: cli.id, moneda: cuenta.moneda, debe: cuenta.total, provisional: !!cuenta.provisional,
    ultimo_pago: up ? { fecha: String(up.fecha).slice(0, 10), monto: up[col] != null && up[col] !== '' ? money.round(up[col], 2) : null } : null,
    ultima_carga: uc ? String(uc.fecha).slice(0, 10) : null,
    desde: null, este_mes: '0', mes_pasado: '0', mas_viejo: '0' };
  if (money.cmp(String(cuenta.total), '0.005') < 0) return r;
  const filas = mesesDeLaCuenta(cli, movimientos, cuenta).reverse();   // del más nuevo al más viejo
  const [a, m] = mesHoy.split('-').map(Number);
  const pasado = `${m === 1 ? a - 1 : a}-${String(m === 1 ? 12 : m - 1).padStart(2, '0')}`;
  let resta = String(cuenta.total);
  for (const f of filas) {
    if (money.cmp(resta, '0') <= 0) break;
    if (money.cmp(f.facturado, '0') <= 0) continue;
    const toma = money.cmp(f.facturado, resta) < 0 ? f.facturado : resta;
    const k = f.mes >= mesHoy ? 'este_mes' : f.mes === pasado ? 'mes_pasado' : 'mas_viejo';
    r[k] = money.round(money.add(r[k], toma), 2);
    r.desde = f.mes; resta = money.sub(resta, toma);
  }
  // Lo que queda sin un mes facturado que lo explique (saldo anterior, ajustes viejos) es lo más viejo.
  if (money.cmp(resta, '0.005') > 0) { r.mas_viejo = money.round(money.add(r.mas_viejo, resta), 2); r.desde = r.desde || 'antes'; }
  return r;
}

function mount(app) {
  /* ───────── 💰 COBRANZAS: QUIÉN DEBE, Y DE CUÁNDO ──────────────────────────────────────────
     Lo que no había en ninguna pantalla: todos los clientes juntos, con el saldo ABIERTO POR MES.
     «Cuenta del cliente» muestra uno por vez y «Cuenta y pagos» muestra el total de todos sumado;
     para saber qué quedó sin cobrar de meses pasados había que abrir cliente por cliente.

     Tres columnas y el total: el mes en curso, el anterior, y TODO lo de antes en una sola. Más
     de tres no ayuda a decidir a quién llamar, y la deuda vieja importa por cuánta es, no por el
     mes exacto en que nació — para eso está la cuenta del cliente.

     ⚠️ EL TOTAL NO SE SUMA ACÁ. Lo calcula `cuentaCorriente`, que es la autoridad e incluye los
     proveedores externos. Esta ruta PARTE ese mismo saldo y manda las dos cosas: si la suma de los
     meses no da el total, la pantalla lo dice en vez de mostrar una fila que cuadra por casualidad.

     Y NO se suman monedas distintas. Un cliente que lleva su cuenta en pesos no entra en el total
     en USDT; cada moneda tiene su propia línea. */
  /* Quién debe pide además, por cliente, lo que GENERÓ y lo que PAGÓ en cada uno de los últimos
     `ultimos` meses: así la pantalla sale de un solo pedido en vez de uno por cliente. */
  function cobranzasDe(mesPedido, { ultimos = 0 } = {}) {
    const mes = /^\d{4}-\d{2}$/.test(String(mesPedido || '')) ? String(mesPedido) : mesTZ();
    const [aa, mm] = mes.split('-').map(Number);
    const prev = mm === 1 ? `${aa - 1}-12` : `${aa}-${String(mm - 1).padStart(2, '0')}`;
    const mesesUlt = Array.from({ length: ultimos }, (_, i) => new Date(Date.UTC(aa, mm - ultimos + i, 1)).toISOString().slice(0, 7));

    // Los comprobantes que el cliente mandó y todavía nadie aprobó. No bajan la deuda —por eso no
    // entran en ninguna columna— pero cambian a quién llamar: reclamarle a alguien que ya avisó
    // que pagó es el peor llamado que se puede hacer.
    const esperando = {};
    for (const c of comprobantes.list({ estado: 'pendiente', limite: 500 })) {
      const k = String(c.codigo || '').toUpperCase();
      esperando[k] = (esperando[k] || 0) + 1;
    }

    const porCliente = {};
    for (const m of movs.list()) {
      (porCliente[m.cliente_id] = porCliente[m.cliente_id] || []).push(m);
    }

    const filas = [];
    const totales = {};
    for (const c of clientes.list().clientes) {
      const cuenta = deudaSvc.cuentaCorriente(c.id);
      const moneda = cuenta.moneda;
      const col = deudaSvc.columnaDe(moneda);
      const mios = porCliente[c.id] || [];
      let antes = 0, anterior = 0, actual = 0;
      const pag = {}, genTodos = {};
      for (const m of mios) {
        const v = deudaSvc.signoDe(m.tipo) * (Number(m[col]) || 0);
        if (!v) continue;
        const k = movs.mesDe(m);
        /* Por mes, con la misma regla que la cuenta del cliente (/api/os/cuenta): lo que generó es
           todo menos los pagos; lo pagado va al mes de la deuda que paga. */
        if (ultimos && /^\d{4}-\d{2}$/.test(k)) {
          if (m.tipo === 'pago') pag[k] = (pag[k] || 0) - v;
          else genTodos[k] = (genTodos[k] || 0) + v;
        }
        if (k >= mes) actual += v;            // ⚠️ `>=`: lo que quedó cargado con un mes futuro
        else if (k === prev) anterior += v;   //    tiene que aparecer en algún lado, no perderse.
        else antes += v;
      }
      const total = Number(cuenta.total) || 0;
      // Nadie con la cuenta en cero ocupa una fila; pero si tiene movimientos y da cero, tampoco
      // es un error — es alguien que está al día.
      if (!mios.length && !total) continue;
      const parte = antes + anterior + actual;
      filas.push({
        cliente_id: c.id, codigo: c.codigo, nombre: c.nombre || c.nombreVisible || '',
        moneda, antes, anterior, actual, total,
        // Si esto no da, la pantalla avisa en vez de dibujar una fila que no cierra.
        cuadra: Math.abs(parte - total) < 0.02,
        esperando: esperando[String(c.codigo || '').toUpperCase()] || 0,
        provisional: !!cuenta.provisional,
        es_vendedor: !!c.es_vendedor,
        ...(ultimos ? { porMes: {
          // Sin nada generado en ningún mes (cuentas viejas cargadas a mano), la pantalla reparte por Cobranzas.
          hayMesAMes: Object.values(genTodos).some((x) => Math.abs(x) >= 0.005),
          gen: Object.fromEntries(mesesUlt.map((k) => [k, genTodos[k] || 0])),
          pag: Object.fromEntries(mesesUlt.map((k) => [k, pag[k] || 0])),
        } } : {}),
      });
      const t = (totales[moneda] = totales[moneda] || { antes: 0, anterior: 0, actual: 0, total: 0, clientes: 0 });
      t.antes += antes; t.anterior += anterior; t.actual += actual; t.total += total; t.clientes += 1;
    }
    filas.sort((a, b) => b.total - a.total);
    return { mes, mes_anterior: prev, filas, totales, ...(ultimos ? { meses: mesesUlt } : {}) };
  }
  app.get('/api/os/cobranzas', (req, res) => ok(res, cobranzasDe(req.query.mes)));
  /* ───────── QUIÉN DEBE, EN UN SOLO PEDIDO (29-oct-2026) ─────────
     Lo de Cobranzas más, por cliente, generó y pagó de los últimos cuatro meses. Antes la pantalla
     pedía la cuenta de cada cliente por separado (uno por cliente con deuda) y los pagos de cada mes. */
  app.get('/api/os/quien-debe', (req, res) => ok(res, cobranzasDe(req.query.mes, { ultimos: 4 })));
  // ───────── PARTICIPACIONES ─────────
  /* ── LAS BILLETERAS ───────────────────────────────────────────────────────────────────────
     Cada una con sus direcciones (una por red) y SU grupo de Telegram. Un cliente apunta a una;
     el que no apunta a ninguna usa la principal, que es la que estaba en Configuración. */
  app.get('/api/os/billeteras', (_req, res) => ok(res, { billeteras: billeteras.list(), principal: billeteras.principal() }));
  app.post('/api/os/billeteras', wrap((req, res) => {
    const b = req.body || {};
    if (!String(b.nombre || '').trim()) return err(res, 400, 'ponele un nombre: es lo que se ve en el OS y en el comprobante');
    ok(res, { billetera: billeteras.crear(b) });
  }));
  app.put('/api/os/billeteras/:id', wrap((req, res) => {
    const w = billeteras.actualizar(req.params.id, req.body || {});
    w ? ok(res, { billetera: w }) : err(res, 404, 'no existe esa billetera');
  }));
  app.delete('/api/os/billeteras/:id', wrap((req, res) => {
    const r = billeteras.borrar(req.params.id);
    r.ok ? ok(res, r) : err(res, 409, r.error);
  }));
  // El % de proveedor POR CLIENTE vive en la MATRIZ del Cierre (cierre_pct), que es la que usa
  // Proveedores externos. Acá vivía un SEGUNDO motor que calculaba lo mismo con otros porcentajes,
  // leyendo tablas propias (cliente_proveedores / panel_proveedores). No lo llamaba ninguna pantalla
  // y tener dos respuestas para la misma pregunta es justo lo que hay que evitar, así que se fue.
  // Las tablas quedan en la base por si hay que mirarlas, pero ya no las lee nadie.



  // ───────── 🧾 COMPROBANTES DE PAGO ─────────
  // Los sube el cliente desde la pantalla pública. Quedan PENDIENTES: aprobar es a mano, porque
  // acreditar un pago porque alguien subió una imagen sería confiar en la imagen.
  app.get('/api/os/comprobantes', (req, res) => {
    // ── LO DECLARADO Y LO ACREDITADO SON DOS NÚMEROS ─────────────────────────────────────────
    // El cliente escribe un monto y el comprobante puede decir otro: declara 300.000 y transfirió
    // 205.000. Se acredita lo del comprobante, y eso quedaba guardado en el movimiento — o sea,
    // registrado pero invisible: la tarjeta mostraba lo DECLARADO y un id de movimiento, así que
    // para saber qué se cobró de verdad había que ir a buscarlo. Ahora viaja con cada comprobante.
    // A qué billetera entró cada pago. El nombre viaja con el comprobante: sin esto, en la pantalla
    // sólo se ve un id, y con dos billeteras la pregunta «¿esto dónde entró?» llega siempre.
    const nombreBw = {}; billeteras.list().forEach((b) => { nombreBw[b.id] = b.nombre; });
    const lista = comprobantes.list({ estado: req.query.estado, codigo: req.query.codigo })
      .map((c) => ({ ...c, billetera: c.billetera_id ? (nombreBw[c.billetera_id] || 'billetera borrada') : '' }))
      .map((c) => {
        if (!c.movimiento_id) return c;
        const m = movs.get(c.movimiento_id);            // ya viene valuado
        if (!m) return c;
        // En la moneda en que PAGÓ, que es la del comprobante: comparar 205.000 contra 300.000 es
        // inmediato; contra "129,84 USDT" hay que hacer una cuenta para ver si coincide.
        const enUsdt = c.via === 'usdt';
        const propio = enUsdt ? m.monto_usdt : m.monto_ars;
        const otro = enUsdt ? m.monto_ars : m.monto_usdt;
        return { ...c,
          acreditado: propio != null && propio !== '' ? String(propio) : null,
          acreditado_moneda: enUsdt ? 'USDT' : 'ARS',
          acreditado_otro: otro != null && otro !== '' ? String(otro) : null,
          acreditado_otro_moneda: enUsdt ? 'ARS' : 'USDT',
          acreditado_tc: m.tc_momento || m.tc_usado || null,
        };
      });
    ok(res, {
      cuentas: comprobantes.cuentas(),
      // La lista de clientes con comprobantes va SIEMPRE completa, filtre o no: es la que llena el
      // desplegable, y si se armara con lo que quedó filtrado no habría forma de volver a otro.
      porCliente: comprobantes.porCliente(),
      comprobantes: lista,
    });
  });
  /* 🔴 EL TIPO LO DECIDE EL SERVIDOR, NO QUIEN SUBE EL ARCHIVO ──────────────────────────────────
     Un comprobante se sube desde la pantalla pública —alcanza con saber el código de un cliente— y
     su `Content-Type` viajaba tal cual hasta la respuesta. El 21-sep-2026 alguien subió un .html
     con el código de Fran y el navegador lo abrió COMO PÁGINA DEL PANEL: desde ahí un script puede
     hacer pedidos con la sesión de quien lo mira (la cookie es HttpOnly, así que no se lee, pero
     se usa igual). Es el mismo blindaje que ya tenía el archivo de un aviso del chat.
     Ahora manda lo que dicen los BYTES: una imagen o un PDF se muestran; cualquier otra cosa se
     descarga y no se abre nunca. Más nosniff —que el navegador no adivine— y sandbox, que apaga
     scripts aunque alguien fuerce la apertura. */
  app.get('/api/os/comprobantes/:id/archivo', (req, res) => {
    const c = comprobantes.get(req.params.id, true);
    if (!c || !c.archivo_datos) return err(res, 404, 'ese comprobante no tiene archivo');
    const buf = Buffer.from(c.archivo_datos, 'base64');
    const tipo = tipoArchivo.tipoPorBytes(buf);
    const mostrar = tipoArchivo.sePuedeMostrar(tipo);
    const nombre = (c.archivo_nombre || 'comprobante').replace(/[^\w.\-]/g, '_');
    res.setHeader('Content-Type', mostrar ? tipo : 'application/octet-stream');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; sandbox");
    res.setHeader('Cache-Control', 'no-store, private');
    res.setHeader('Content-Disposition', `${mostrar ? 'inline' : 'attachment'}; filename="${nombre}"`);
    res.send(buf);
  });
  // Aprobar → registra el PAGO (que es lo único que mueve la deuda). Rechazar → solo queda el motivo.
  app.post('/api/os/comprobantes/:id/resolver', wrap(async (req, res) => {
    const b = req.body || {};
    const c = comprobantes.get(req.params.id);
    if (!c) return err(res, 404, 'no existe ese comprobante');
    if (c.estado !== 'pendiente') return err(res, 409, `ya estaba ${c.estado}`);
    if (b.estado === 'rechazado') {
      const r = comprobantes.resolver(req.params.id, { estado: 'rechazado', por: 'panel', motivo: b.motivo });
      return r.ok ? ok(res, r) : err(res, 400, r.error);
    }
    if (b.estado !== 'aprobado') return err(res, 400, "estado inválido: 'aprobado' o 'rechazado'");
    // getByCodigo resuelve también los códigos VIEJOS (codigosAlias): si un cliente se renombró,
    // su comprobante viejo tiene que seguir encontrándolo.
    const cli = clientes.getByCodigo(c.codigo);
    if (!cli) return err(res, 404, `el código ${c.codigo} ya no corresponde a ningún cliente`);

    // ── UN PAGO SE GUARDA CON LAS DOS CARAS Y EL TIPO DE CAMBIO ───────────────────────────────
    //
    // Es como la dueña lo lleva en su planilla, y tiene razón: cada renglón tiene el monto en
    // pesos, el TC al que se recibió, y los dólares. Los tres. Guardar uno solo obliga a
    // reconstruir los otros dos después, y no se puede — el TC de un pago NO es el del día:
    //     "si alguien sube comprobante en ARS yo debo poner a qué cambio manual recibí ese dinero
    //      en USDT porque no es exacto al tipo de cambio del momento"
    // Ese TC es un dato del acuerdo con quien cambió la plata, no una cotización. Si no se guarda
    // en el momento, se pierde.
    //
    // `moneda` es la de la CUENTA: la que resta la deuda. La otra cara queda igual de guardada, y
    // por eso la misma fila sirve para mirar el saldo en pesos o en dólares sin recalcular nada.
    const moneda = cli.moneda_cuenta === 'ARS' ? 'ARS' : 'USDT';

    // ── EL TC PUEDE QUEDAR PENDIENTE DEL CIERRE ──────────────────────────────────────────────
    // Hay clientes que pagan en pesos todo el mes y el cambio recién se acuerda al cerrarlo. Con
    // `tc_modo: 'mes'` se acredita lo que SÍ se sabe —los pesos que entraron— y la otra cara se
    // deriva del TC del mes cada vez que se lee (ver src/valuacion.js): el día que se carga el TC
    // del cierre, estos pagos pasan a valer lo correcto solos.
    //
    // Sin esto había que elegir entre inventar un TC —y guardar un número que no es el real— o no
    // aprobar el pago, dejando al cliente como deudor de algo que ya pagó.
    const porElMes = b.tc_modo === 'mes';
    // Con TC del mes se carga la moneda en que PAGÓ, no la de la cuenta: es el único monto que se
    // conoce de verdad. Si la cuenta ya se lleva en esa moneda, no hay nada pendiente que derivar.
    const monedaCargada = porElMes ? (c.via === 'usdt' ? 'USDT' : 'ARS') : moneda;
    // La pantalla manda en qué moneda cree que está el monto y acá se compara. Si alguna vez las
    // dos puntas dejan de coincidir, esto lo frena; sin esta comprobación, un número en pesos
    // entraría como dólares —1.476.000 en vez de 1.000— y nadie se enteraría hasta el cierre.
    if (b.moneda && String(b.moneda).toUpperCase() !== monedaCargada) {
      return err(res, 400, `la pantalla dice ${b.moneda} y el pago está en ${monedaCargada} — recargá la página`);
    }
    // Entiende coma y punto igual que la pantalla: quien aprueba escribe "94,22" y eso tiene que
    // valer. Y si escribe "94.22" se lee como 94,22, no como 9422 — el error de los 100×.
    const montoNum = parseMonto(b.monto != null ? b.monto : b.monto_usdt);
    const monto = montoNum == null ? null : String(montoNum);
    if (!money.isPos(monto)) return err(res, 400, `poné cuántos ${monedaCargada} se acreditan`);
    // El TC lo pone quien aprueba. Sin él sólo se guarda la cara que se declaró: es preferible un
    // dato faltante y visible a un número inventado con la cotización del día.
    const tcNum = !porElMes && b.tc != null && String(b.tc).trim() !== '' ? parseMonto(b.tc) : null;
    let tc = tcNum == null ? null : String(tcNum);
    if (tc != null && !money.isPos(tc)) return err(res, 400, 'el tipo de cambio tiene que ser mayor a cero');

    /* ── EL CAMBIO SE COMPARA CON EL DE HOY, NO CON EL DEL CIERRE (26-oct-2026) ──────────────
       Aprobar es una decisión de AHORA: el cambio del cierre puede ser de hace semanas y no dice
       nada sobre si este comprobante es razonable hoy. Se compara contra el mercado del momento
       —`tcAhora`: criptoya, que agrega Binance P2P, con caída al último snapshot—.

       Hasta TC_DIF_MAX_PCT pasa solo. Más arriba hay que aprobarlo a propósito (`forzar: true`) y
       queda escrito en el movimiento: quién lo aceptó y con cuánta diferencia.

       Y SI NO SE ESCRIBIÓ NINGUNO, SE SELLA EL DE HOY. Antes quedaba null para siempre: un pago
       en USDT sin TC no tenía cara en pesos, y al cliente —que lee en pesos— la deuda le salía
       inflada (a NahuelGanamosD, ARS 2.110.000 sobre 1.722.000). Sellarlo es seguro porque en
       este camino el monto SIEMPRE viene en la moneda de la CUENTA: el TC sólo llena la OTRA
       cara, la que se muestra, nunca la que suma. No puede mover ninguna deuda. */
    let tcHoy = null; let tcDifPct = null; let tcSellado = false;
    if (!porElMes) {
      const h = await tcSvc.tcAhora().catch(() => null);
      tcHoy = h && money.isPos(String(h.tc || '')) ? String(h.tc) : null;
      // `vivo:false` = no contestó la fuente y se usó el último snapshot (hasta 12 h viejo).
      const tcHoyVivo = !!(h && h.vivo);
      if (tc == null) { if (tcHoy) { tc = tcHoy; tcSellado = true; } }
      else if (tcHoy) {
        tcDifPct = Math.round(((Number(tc) - Number(tcHoy)) / Number(tcHoy)) * 1000) / 10;
        if (Math.abs(tcDifPct) > TC_DIF_MAX_PCT && b.forzar !== true) {
          return err(res, 409, `El cambio que pusiste (${tc}) está ${Math.abs(tcDifPct)}% `
            + `${tcDifPct > 0 ? 'arriba' : 'abajo'} del de hoy (${tcHoy}). El tope es ${TC_DIF_MAX_PCT}%.`,
          { tc_fuera_de_rango: true, tc, tc_hoy: tcHoy, dif_pct: tcDifPct, limite_pct: TC_DIF_MAX_PCT, tc_hoy_vivo: tcHoyVivo });
        }
      }
    }
    let enArs = null; let enUsdt = null;
    if (monedaCargada === 'ARS') { enArs = monto; if (tc) enUsdt = money.round(money.div(monto, tc), 2); }
    else { enUsdt = monto; if (tc) enArs = money.round(money.mul(monto, tc), 2); }
    const mov = movs.create({ cliente_id: cli.id, tipo: 'pago',
      monto_usdt: enUsdt, monto_ars: enArs, tc_momento: tc,
      // Sólo si de verdad queda algo pendiente: si pagó en la misma moneda en que se lleva su
      // cuenta, el importe que suma ya está y no depende de ningún tipo de cambio.
      tc_modo: (porElMes && monedaCargada !== moneda) ? 'mes' : null,
      /* ── A QUÉ CIERRE ENTRA ESTE PAGO ────────────────────────────────────────────────────
         No es lo mismo que cuándo entró la plata. Un cliente que paga el 2 de octubre la factura
         de septiembre tiene que descontar de SEPTIEMBRE: si no, el tablero de cobranzas muestra
         septiembre sin cobrar y octubre con un pago que no corresponde a nada.
         Hasta el 3-oct-2026 esto no se podía decir al aprobar —sólo en el pago cargado a mano— y
         todo caía en el mes en que se apretaba el botón. Sin `mes` se comporta igual que antes. */
      mes_cierre: /^\d{4}-\d{2}$/.test(String(b.mes || '')) ? String(b.mes) : null,
      // Y quién la agarró, si se eligió. Vacío es un estado válido: se completa después.
      recibido_por: b.recibido_por || null,
      divisa: moneda, fecha: b.fecha, medio: c.via === 'usdt' ? 'usdt' : 'cvu',
      notas: `comprobante ${c.id}${b.motivo ? ' · ' + b.motivo : ''}`
        + (tcSellado ? ` · TC ${tc} del día (nadie escribió uno)` : '')
        + (tcDifPct != null && Math.abs(tcDifPct) > TC_DIF_MAX_PCT
          ? ` · TC ${tcDifPct > 0 ? '+' : ''}${tcDifPct}% vs el de hoy (${tcHoy}), aprobado igual` : '') });
    const montoUsdt = enUsdt;
    const r = comprobantes.resolver(req.params.id, { estado: 'aprobado', por: 'panel', motivo: b.motivo, movimiento_id: mov.id });
    if (!r.ok) return err(res, 400, r.error);
    // ── EL AVISO AL GRUPO VA ACÁ, NO AL RECIBIRLO ────────────────────────────────────────────
    // Antes salía cuando el cliente subía el comprobante y decía "queda pendiente": el grupo se
    // enteraba de algo que todavía no había pasado, y después nadie confirmaba si pasó. Ahora sale
    // cuando el pago está ACREDITADO, con la foto adentro y con el monto que se acreditó de verdad
    // —no el que declaró el cliente, que pueden ser dos números distintos.
    // Fire-and-forget: que Telegram no conteste no puede tumbar un pago ya registrado.
    const avisar = req.app.get('avisarComprobante');
    if (typeof avisar === 'function') {
      Promise.resolve(avisar(comprobantes.get(req.params.id), cli, monto, monedaCargada))
        .catch((e) => console.warn('[Comprobante] aviso error:', e.message));
    }
    ok(res, { ...r, movimiento: mov, deuda: deudaSvc.cuentaCorriente(cli.id) });
  }));
  /**
   * ── 💵 LOS PAGOS QUE ENTRARON, POR MES ──────────────────────────────────────────────────────
   *
   * Para mandarle a alguien lo que se recibió: pesos por un lado y USDT por el otro, porque no son
   * el mismo dinero y sumarlos da un número que no entró a ninguna cuenta.
   *
   * ⚠️ Agrupa por MES DE CIERRE, no por fecha. Un pago del 3 de septiembre asignado a agosto tiene
   * que aparecer en agosto: es la razón por la que existe ese campo. Con la fecha, el resumen del
   * mes que se está cerrando dejaría afuera justo los pagos que llegaron tarde.
   *
   * El monto es el que se ACREDITÓ, no el que declaró el cliente: son dos números distintos y el
   * que vale es el que entró.
   */
  /* Lo que comparten /pagos (por mes de la deuda) y /entro (por fecha): todos los pagos, la fila
     que se muestra de cada uno y el resumen por mes de la deuda. */
  function _pagosBase() {
    const cs = clientes.list().clientes;
    const nom = {}; cs.forEach((c) => { nom[c.id] = c; });
    // Los comprobantes, para poder mostrar la referencia y si hay archivo.
    const porMov = {};
    // `limite` alto a propósito: por defecto son 200 y el resumen de un mes viejo se quedaría sin
    // las referencias de los comprobantes más antiguos, en silencio.
    try { comprobantes.list({ limite: 5000 }).forEach((c) => { if (c.movimiento_id) porMov[c.movimiento_id] = c; }); }
    catch (e) { /* sin comprobantes el resumen sale igual */ }
    // Los nombres de las billeteras, para no mostrar un id en pantalla.
    const nomBw = {};
    try { billeteras.list().forEach((b) => { nomBw[b.id] = b.nombre; }); } catch (e) { /* idem */ }

    const todos = movs.list({ tipo: 'pago' });
    /* La lista de meses con lo que entró en cada uno. Sólo el conteo no sirve para decidir a cuál
       entrar: «54 pagos» no dice si fueron 13 millones o 300 mil. */
    const meses = {};
    todos.forEach((mv) => {
      const k = movs.mesDe(mv); if (!/^\d{4}-\d{2}$/.test(k)) return;
      const m = meses[k] = meses[k] || { pagos: 0, ars: '0', usdt: '0' };
      m.pagos += 1;
      if (mv.monto_ars) m.ars = money.add(m.ars, mv.monto_ars);
      const entro = mv.usdt_recibido != null ? mv.usdt_recibido : mv.monto_usdt;   // lo que entró de verdad
      if (entro) m.usdt = money.add(m.usdt, entro);
    });

    const fila = (mv) => {
      const c = nom[mv.cliente_id] || {};
      const cmp = porMov[mv.id] || {};
      /* La vía sale del `medio`; los primeros pagos no lo tienen guardado y ahí manda el
         comprobante que los originó. Sin esa vuelta, el de Rafael (1.000 USDT del 10-ago) caía
         del lado equivocado o se perdía. */
      const via = (mv.medio === 'usdt' || mv.medio === 'cvu') ? mv.medio
        : (cmp.via === 'usdt' ? 'usdt' : (mv.monto_ars ? 'cvu' : 'usdt'));
      return {
        id: mv.id, fecha: String(mv.fecha || mv.createdAt || '').slice(0, 10),
        mes: movs.mesDe(mv), cliente: c.nombre || c.codigo || '(sin cliente)', codigo: c.codigo || '',
        via, medio: mv.medio || null,
        /* A QUÉ BILLETERA ENTRÓ. Sale del comprobante, que es donde se eligió al pagar. Sin esto,
           con dos wallets activas no había forma de saber a cuál llegó cada USDT desde la pantalla
           de pagos: había que abrir el comprobante de a uno. */
        billetera: (cmp.billetera_id && (nomBw[cmp.billetera_id] || '(billetera borrada)')) || '',
        ars: mv.monto_ars ?? null, usdt: (mv.usdt_recibido != null ? mv.usdt_recibido : mv.monto_usdt) ?? null,
        // Lo que saldó de su deuda, cuando no es lo mismo que lo que entró (pesos que cancelan pesos).
        saldo_usdt: mv.usdt_recibido != null ? mv.monto_usdt : null, dif_cambio: mv.dif_cambio ?? null,
        tc: mv.tc_usado || mv.tc_momento || null,
        provisional: !!mv.provisional, sinValuar: !!mv.sinValuar,
        referencia: cmp.referencia || '', comprobante: cmp.id || null, archivo: !!(cmp.archivo_bytes),
      };
    };
    return { todos, fila, meses };
  }
  app.get('/api/os/pagos', wrap((req, res) => {
    const mes = String(req.query.mes || mesTZ()).slice(0, 7);
    const { todos, fila, meses } = _pagosBase();
    const delMes = todos.filter((mv) => movs.mesDe(mv) === mes).map(fila)
      .sort((a, b) => String(b.fecha).localeCompare(String(a.fecha)));
    const pesos = delMes.filter((x) => x.via === 'cvu');
    const usdt = delMes.filter((x) => x.via === 'usdt');
    const suma = (arr, k) => arr.reduce((a, x) => money.add(a, x[k] || '0'), '0');
    ok(res, {
      mes,
      meses: Object.keys(meses).sort().reverse().map((m) => ({ mes: m, pagos: meses[m].pagos,
        ars: money.round(meses[m].ars, 2), usdt: money.round(meses[m].usdt, 2) })),
      pesos, usdt,
      totales: {
        pesos_ars: money.round(suma(pesos, 'ars'), 2),
        pesos_usdt: money.round(suma(pesos, 'usdt'), 2),
        usdt_usdt: money.round(suma(usdt, 'usdt'), 2),
      },
    });
  }));
  /* ───────── QUÉ ENTRÓ: POR FECHA, EN UN SOLO PEDIDO (29-oct-2026) ─────────
     /pagos agrupa por el mes de la deuda; Qué entró pregunta cuándo entró la plata, y para eso la
     pantalla pedía /pagos de doce meses y filtraba. Acá se filtra por la FECHA del pago: los de los
     últimos `meses` (1 a 12) meses terminando en `mes`. `meses` (la lista) sigue siendo la de los
     meses de la deuda, que es la que usa «Es de». */
  app.get('/api/os/entro', wrap((req, res) => {
    const mes = /^\d{4}-\d{2}$/.test(String(req.query.mes || '')) ? String(req.query.mes) : mesTZ();
    const n = Math.min(12, Math.max(1, Number(req.query.meses) || 1));
    const [aa, mm] = mes.split('-').map(Number);
    const mesesFecha = Array.from({ length: n }, (_, i) => new Date(Date.UTC(aa, mm - 1 - i, 1)).toISOString().slice(0, 7));
    const { todos, fila, meses } = _pagosBase();
    const elegidos = todos.map(fila).filter((x) => mesesFecha.includes(String(x.fecha).slice(0, 7)))
      .sort((a, b) => String(b.fecha).localeCompare(String(a.fecha)));
    ok(res, {
      mes, mesesFecha,
      meses: Object.keys(meses).sort().reverse().map((m) => ({ mes: m, pagos: meses[m].pagos,
        ars: money.round(meses[m].ars, 2), usdt: money.round(meses[m].usdt, 2) })),
      pesos: elegidos.filter((x) => x.via === 'cvu'), usdt: elegidos.filter((x) => x.via === 'usdt'),
    });
  }));
  /**
   * El resumen de PESOS al grupo donde llegan los comprobantes.
   *
   * ⚠️ SIN NOMBRE NI CÓDIGO DE CLIENTE, y es a propósito: ese grupo concilia contra el banco —le
   * sirven la fecha y el monto— y no tiene por qué saber quién pagó cuánto. Mandar de más no se
   * puede deshacer: una vez que salió, salió.
   *
   * SALE PARA AFUERA: sólo se manda cuando alguien lo pide, y se dice a qué grupo fue.
   */
  app.post('/api/os/pagos/:mes/enviar', wrap(async (req, res) => {
    const mes = String(req.params.mes || '').slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(mes)) return err(res, 400, 'mes inválido');
    const chat = String(configStore.getCfg('tgChatArs') || '').trim();
    const tok = configStore.getTelegramToken();
    if (!tok) return err(res, 400, 'el bot de Telegram no está configurado');
    if (!chat) return err(res, 400, 'no hay grupo de pesos cargado en Config → Medios de pago');

    const cs = clientes.list().clientes; const nom = {}; cs.forEach((c) => { nom[c.id] = c; });
    const porMov = {};
    try { comprobantes.list({ limite: 5000 }).forEach((c) => { if (c.movimiento_id) porMov[c.movimiento_id] = c; }); }
    catch (e) { /* sigue */ }
    const filas = movs.list({ tipo: 'pago' })
      .filter((mv) => movs.mesDe(mv) === mes)
      .filter((mv) => {
        const c = porMov[mv.id] || {};
        return (mv.medio === 'cvu') || (mv.medio !== 'usdt' && c.via !== 'usdt' && mv.monto_ars);
      })
      .sort((a, b) => String(a.fecha || '').localeCompare(String(b.fecha || '')));
    if (!filas.length) return err(res, 400, `no hay pagos en pesos en ${mes}`);

    const fmt = (x) => Number(x || 0).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const total = filas.reduce((a, mv) => money.add(a, mv.monto_ars || '0'), '0');
    const texto = [`💵 <b>Pagos en pesos — ${mesCierreLbl(mes).replace('_', ' ')}</b>`, '']
      .concat(filas.map((mv) => `  ${String(mv.fecha || '').slice(0, 10)}   $ ${fmt(mv.monto_ars)}`))
      .concat(['', `<b>Total: $ ${fmt(total)}</b>`, `<i>${filas.length} transferencia(s)</i>`])
      .join('\n');
    const r = await telegram.sendMessage(tok, chat, texto);
    r.ok ? ok(res, { enviado: filas.length, total: money.round(total, 2), chat })
         : err(res, 502, r.error || 'Telegram no aceptó el mensaje');
  }));
  // ───────── MOVIMIENTOS ─────────
  app.get('/api/os/movimientos', (req, res) => ok(res, { movimientos: movs.list({ cliente_id: req.query.cliente_id, tipo: req.query.tipo, mes: req.query.mes }) }));
  app.post('/api/os/movimientos', wrap((req, res) => ok(res, { movimiento: movs.create(req.body || {}) })));
  /* A qué mes entra un pago ya cargado. Es lo único editable de un movimiento: el resto se
     inserta y se borra, nunca se modifica (ver movimientos-store). Corregirlo no puede obligar a
     borrar el pago y perder su comprobante. */
  app.put('/api/os/movimientos/:id/mes-cierre', wrap((req, res) => {
    const r = movs.setMesCierre(req.params.id, (req.body || {}).mes_cierre || null);
    r.ok ? ok(res, r) : err(res, 400, r.error);
  }));
  /* Borrar un pago se lleva su comprobante. Si queda suelto es un cobro fantasma: figura en
     «Comprobantes resueltos» como plata acreditada y no está en la cuenta de nadie.
     Sólo se borra el que generó ESE pago, y sólo si fue cargado a mano — los que sube el cliente
     no se borran nunca, se rechazan. */
  app.delete('/api/os/movimientos/:id', (req, res) => {
    let comprobante = null;
    try {
      const c = comprobantes.list({ limite: 5000 }).find((x) => x.movimiento_id === req.params.id);
      if (c && /cargado a mano/.test(c.notas || '')) { comprobantes.borrar(c.id); comprobante = c.id; }
      else if (c) comprobante = { quedó: c.id, porQue: 'lo subió el cliente: no se borra' };
    } catch (e) { /* el pago se borra igual */ }
    return movs.remove(req.params.id) ? ok(res, { comprobante }) : err(res, 404, 'no encontrado');
  });
  // La CARGA COMERCIAL a mano se sacó (2-ago).
  //
  // Calculaba el fee de una venta y lo sumaba a la deuda. Ahora eso lo hace la Factura de consumo,
  // que sale sola de los pedidos y se emite una vez por mes con candado contra el doble cobro.
  // Tenerlas conviviendo era una fuga concreta: registrar la carga a mano Y emitir el mes cobraba
  // la MISMA venta dos veces, y ni el índice único ni el chequeo previo lo veían, porque solo miran
  // los movimientos que generó una emisión.
  //
  // Lo que sí queda es el LIBRO (la lista de movimientos) y el registro de PAGOS.

  /**
   * PAGO A MANO: para lo que no entra por un comprobante del cliente.
   *
   * 🔴 ANTES ERA UN CAMINO APARTE, Y SE NOTABA. No había forma de adjuntar el comprobante —un pago
   * cargado a mano quedaba sin respaldo— y el aviso salía SÓLO al grupo del cliente: el de
   * cobranzas, que es el que controla, no se enteraba. Aprobar un comprobante avisa a los dos y
   * manda la foto; registrarlo a mano no. La misma plata entrando por dos puertas distintas.
   *
   * Ahora es la misma puerta: se crea un comprobante YA APROBADO, con su archivo, apuntando al
   * movimiento. Con eso hereda todo — la foto al grupo de cobranzas, el aviso al cliente, y
   * aparece en «Comprobantes resueltos» junto a los demás, donde antes no figuraba en ningún lado.
   */
  app.post('/api/os/movimientos/pago', wrap(async (req, res) => {
    const { cliente_id, monto_usdt, fecha, notas, medio, archivo, mes_cierre, recibido_por } = req.body || {};
    /* ── SE PUEDE CARGAR EN PESOS SIN SABER LOS DÓLARES ────────────────────────────────────────
       Muchos pagos llegan en pesos y el cambio recién se acuerda al cerrar el mes. Antes acá había
       que poner USDT sí o sí: o se inventaba un número, o el pago no se cargaba y el cliente
       aparecía debiendo plata que ya había pagado.
       Con `tc_modo: 'mes'` se guarda lo único que se sabe de verdad —los pesos— y la otra cara se
       DERIVA al leer (ver valuacion.js). El día que se carga el TC del cierre, todos estos pagos
       pasan a valer lo que corresponde solos, sin ningún proceso que haya que acordarse de correr.
       Es el mismo camino que ya usaba aprobar un comprobante en pesos. */
    const enPesos = String((req.body || {}).moneda || '').toUpperCase() === 'ARS';
    const monto_ars = (req.body || {}).monto_ars;
    /* ⚠️ EL AVISO NO SALE SOLO. Muchos de estos pagos ya se avisaron por otro lado —el cliente
       mandó la captura al grupo— y volver a mandarlos sería ruido; y cargar comprobantes viejos
       dispararía avisos de cosas que pasaron hace un mes. Se manda sólo si quien lo carga lo pide:
       una decisión por pago, no un comportamiento por defecto. */
    const avisar = (req.body || {}).avisar === true;
    const cli = clientes.get(cliente_id); if (!cli) return err(res, 404, 'cliente no encontrado');
    if (enPesos ? !money.isPos(monto_ars) : !money.isPos(monto_usdt)) {
      return err(res, 400, enPesos ? 'poné cuántos pesos entraron' : 'monto inválido');
    }
    const antes = deudaSvc.cuentaCorriente(cliente_id).total;
    // `medio` = por dónde entró la plata (CVU, USDT, efectivo…). Sin esto, al mes siguiente no
    // se puede reconstruir de dónde vino cada pago, que es lo primero que se pregunta cuando
    // un cliente reclama.
    /* La cuenta del cliente se lleva en su moneda; `tc_modo:'mes'` sólo hace falta cuando lo que
       se cargó NO es esa moneda — si lleva la cuenta en pesos y pagó en pesos, no hay nada que
       derivar. `divisa` es la de la CUENTA, que es la que resta la deuda. */
    const monedaCuenta = cli.moneda_cuenta === 'ARS' ? 'ARS' : 'USDT';
    const movimiento = movs.create({
      cliente_id, tipo: 'pago', fecha, notas, medio, mes_cierre, recibido_por: recibido_por || null,
      monto_usdt: enPesos ? null : monto_usdt,
      monto_ars: enPesos ? String(monto_ars) : null,
      tc_modo: enPesos && monedaCuenta !== 'ARS' ? 'mes' : null,
      divisa: monedaCuenta,
    });
    const despues = deudaSvc.cuentaCorriente(cliente_id);

    /* La vía decide a QUÉ grupo de cobranzas va (hay uno de pesos y otro de USDT). Efectivo y
       "otro" van al de pesos, que es donde se concilia lo que no es cripto. */
    const via = String(medio || '').toLowerCase() === 'usdt' ? 'usdt' : 'ars';
    let comprobante = null; let avisoCobranzas = null;
    try {
      const c = comprobantes.crear({
        codigo: cli.codigo, clienteNombre: cli.nombreVisible || cli.nombre,
        via, monto: String(enPesos ? monto_ars : monto_usdt), divisa: enPesos ? 'ARS' : 'USDT',
        notas: 'cargado a mano desde el panel' + (notas ? ' · ' + notas : ''),
        archivo: archivo || null,
      });
      if (c.ok) {
        comprobante = comprobantes.resolver(c.comprobante.id, {
          estado: 'aprobado', por: 'panel',
          motivo: 'pago registrado a mano', movimiento_id: movimiento.id,
        });
        // El MISMO aviso que al aprobar un comprobante —foto al grupo de cobranzas + el cliente—
        // pero SÓLO si se pidió. El comprobante queda guardado igual, así que se puede avisar
        // después desde «Comprobantes resueltos» sin volver a cargar nada.
        const fn = req.app.get('avisarComprobante');
        if (avisar && typeof fn === 'function') {
          avisoCobranzas = await Promise.resolve(
            // En la moneda que ENTRÓ: el cliente verifica contra su comprobante, que está en pesos.
            fn(comprobantes.get(c.comprobante.id), cli,
              String(enPesos ? monto_ars : monto_usdt), enPesos ? 'ARS' : 'USDT'),
          ).catch((e) => ({ ok: false, error: String((e && e.message) || e) }));
        }
      } else comprobante = { ok: false, error: c.error };
    } catch (e) {
      // Que el respaldo o el aviso fallen no puede tumbar un pago YA registrado: baja la deuda
      // igual y se dice qué no salió.
      comprobante = { ok: false, error: String((e && e.message) || e) };
    }
    /* Un solo `aviso`: `avisarComprobante` manda los DOS —cobranzas con la foto y el cliente— y
       devuelve el de cobranzas, que es el que puede fallar por falta de grupo configurado. */
    ok(res, { movimiento, deuda: despues, comprobante, aviso: avisoCobranzas, avisado: avisar });
  }));
  // ───────── PASAR LO FACTURADO A LA DEUDA ─────────
  // Emitir es EXPLÍCITO y no se puede duplicar: hay un índice único en la base sobre
  // (cliente, origen, mes). Volver a emitir el mismo mes no agrega nada.
  // ───────── 📒 LA CUENTA DE UN CLIENTE, MES A MES ─────────
  //
  // El agujero que cerraba: no había dónde ver qué se le facturó a un cliente hace tres o cinco
  // meses. La factura se armaba en pantalla y se iba; para saber qué se le había cobrado en mayo
  // había que volver a calcularlo, y el cálculo de hoy no es el de entonces.
  //
  // Sale de los MOVIMIENTOS, que son la deuda de verdad, así que también muestra los meses viejos.
  // El saldo va acumulado hacia adelante a propósito: deber 20.000 no es lo mismo si son de este
  // mes o si vienen arrastrando desde marzo.
  app.get('/api/os/clientes-cobranza', (_req, res) => {
    const mesHoy = mesTZ();
    ok(res, { mes: mesHoy, clientes: clientes.list().clientes.map((c) => cobranzaDe(c, mesHoy)) });
  });
  app.get('/api/os/cuenta/:clienteId', (req, res) => {
    const cli = clientes.get(req.params.clienteId);
    if (!cli) return err(res, 404, 'cliente no encontrado');
    const movimientos = movs.list({ cliente_id: cli.id });
    const cuenta = deudaSvc.cuentaCorriente(cli.id);
    /* MES A MES CON LA MISMA REGLA QUE LO QUE DEBE (fase 4, 27-oct-2026). Antes:
       · agrupaba por la FECHA del movimiento: un pago del 2-oct que es de septiembre caía en octubre;
         ahora va al mes de la deuda que paga (`movs.mesDe`, el mismo de Cobranzas y Qué entró);
       · sumaba siempre la columna en dólares: una cuenta en pesos daba todo cero; ahora suma la
         columna de la moneda en que se lleva la cuenta (`deudaSvc.columnaDe`), como Cobranzas;
       · la anulación de una carga iba a «otros»: Titan sep decía 43.477 de cargas y −10.000 de
         ajustes; ahora se resta dentro de «consumo», que es lo que de verdad se le cobró.
       La suma de los meses da lo mismo que antes y que lo que debe: sólo cambia dónde cae cada cosa. */
    const filas = mesesDeLaCuenta(cli, movimientos, cuenta);
    for (const f of filas) {
      // Qué decía el contraste contra los paneles ese mes, para ESTE cliente. Es lo que permite
      // mirar hacia atrás y saber si lo que se le cobró estaba validado o se emitió igual.
      const g = facturasGuardadas.get(cli.id, f.mes);
      f.factura = g ? {
        total_usdt: g.total_usdt, consumo_usdt: g.consumo_usdt, externos_usdt: g.externos_usdt,
        generada_at: g.generada_at, generada_por: g.generada_por, veces: g.veces,
        salio_at: g.salio_at, salio_como: g.salio_como,
      } : null;
      const v = crucePanel.leer(f.mes);
      const suyo = v && v.datos && (v.datos.porCliente || []).find((x) => x.cliente_id === cli.id);
      f.validacion = v ? {
        validadoAt: v.validadoAt, confirmadoAt: v.confirmadoAt, confirmadoPor: v.confirmadoPor,
        cuadra: !suyo,
        cobraDeMas_usdt: suyo ? suyo.cobraDeMas_usdt : '0',
        noSeCobra_usdt: suyo ? suyo.noSeCobra_usdt : '0',
        sinValidar_usdt: suyo ? suyo.sinValidar_usdt : '0',
      } : null;
    }
    filas.reverse();
    ok(res, { cliente: { id: cli.id, codigo: cli.codigo, nombre: cli.nombre || cli.nombreVisible },
      cuenta, moneda: cuenta.moneda, meses: filas });
  });
  /**
   * Generar hacia atrás la deuda de las cargas de un mes.
   *
   * Se usa una vez, el día que esto se enciende: las cargas ya hechas están en la factura pero no
   * en la cuenta corriente, así que el saldo del cliente arranca incompleto. Cada carga se convierte
   * con el TC de SU día — usar el de hoy le cambiaría el precio a operaciones que ya pasaron.
   *
   * Por defecto SIMULA. Escribir de verdad hay que pedirlo con `aplicar: true`: son movimientos de
   * plata en la cuenta de cada cliente y conviene mirar los números antes.
   */
  app.post('/api/os/deuda/generar-mes', wrap(async (req, res) => {
    const b = req.body || {};
    const mes = String(b.mes || mesTZ()).slice(0, 7);
    const delMes = pedidosStore.list({ estado: 'cargado' })
      .filter((p) => String(p.resueltoAt || p.createdAt || '').slice(0, 7) === mes);
    const r = await deudaCargaSvc.generarMes(mes, delMes, { simular: b.aplicar !== true });
    ok(res, { ...r, simulado: b.aplicar !== true, pedidosDelMes: delMes.length });
  }));
  /**
   * Completar los abonos de las cargas que ya pasaron (ver `deuda-carga.abonoPorCarga`).
   *
   * El abono nace con cada carga nueva; las de antes de prenderlo no lo tienen. Esto recorre las
   * cargas de un cliente desde una fecha y le crea el abono a la que le falte. Idempotente por
   * pedido: correrlo dos veces no abona dos veces. Simula salvo `aplicar: true`.
   */
  /* Pasar al PROMEDIO del mes las cargas ya anotadas de los clientes con cuenta a fin de mes
     (regla del 18-oct-2026). Simula salvo `aplicar: true`. */
  app.post('/api/os/deuda/pasar-al-promedio', wrap((req, res) => {
    const b = req.body || {};
    if (!/^\d{4}-\d{2}$/.test(String(b.mes || ''))) return err(res, 400, 'mes inválido (YYYY-MM)');
    if (b.excluir != null && !(Array.isArray(b.excluir) && b.excluir.every((x) => /^[^:]+:[A-Za-z]{3,4}$/.test(String(x)))))
      return err(res, 400, 'excluir va como ["CODIGO:MONEDA", …]');
    ok(res, deudaCargaSvc.pasarAlPromedio(b.mes, { aplicar: b.aplicar === true, excluir: b.excluir || [] }));
  }));
  /**
   * Borrar la deuda generada por cargas de un mes, para poder rehacerla.
   *
   * Se pide con `confirmar: true` porque borra movimientos de la cuenta de los clientes. Sólo toca
   * los que nacieron de una carga: no roza pagos, ajustes ni saldos anteriores.
   */
  app.post('/api/os/deuda/borrar-mes', wrap((req, res) => {
    const b = req.body || {};
    if (b.confirmar !== true) return err(res, 400, 'esto borra movimientos de la cuenta: mandá confirmar:true');
    ok(res, deudaCargaSvc.borrarMes(String(b.mes || mesTZ()).slice(0, 7)));
  }));
  /* Lo que movió TODA la línea de un vendedor, proveedor por proveedor: el movimiento por divisa,
     el costo real de ese proveedor, y el equivalente en dólares con el TC de cada divisa. Es lo que
     lleva el papel del vendedor — su cuenta propia (`/:id`) es sólo la rebanada de sus paneles. */
  /* ── CUÁNTO CARGARLE, ANTES DE CARGARLO ────────────────────────────────────────────────────
     «Titan pide 10.000 dólares en 463.life»: la caja está en pesos, así que hay que convertir, y
     además hay que saber qué comisión le genera eso. Se hacía a mano con la calculadora del
     teléfono y el TC de algún lado.

     ⚠️ USA LAS MISMAS FUNCIONES QUE LA CARGA DE VERDAD (`baseDe`, `tcDelDia`). Recalcularlo acá
     con su propia cuenta es cómo la pantalla termina diciendo un número y el sistema anotando
     otro — y el que queda mal es el sistema, porque el cliente ya vio el primero.

     La carga NO es deuda: la deuda es la comisión (`base% × lo cargado`). Por eso se contesta
     `cargar` y `comision` por separado, y no un total que mezcla dos cosas distintas. */
  app.get('/api/os/carga/calcular', wrap(async (req, res) => {
    const q = req.query || {};
    const cli = clientes.get(q.cliente_id) || clientes.getByCodigo(q.cliente_id);
    if (!cli) return err(res, 404, 'no encuentro ese cliente');
    const caja = (cli.cajas || []).find((k) => String(k.id) === String(q.caja_id));
    if (!caja) return err(res, 400, `${cli.nombre || cli.codigo} no tiene esa caja`);
    // Con la regla de src/lib/monto.js: "10.000" son diez mil, no diez.
    const leido = parseMonto(q.monto);
    if (leido == null) return err(res, 400, 'el monto tiene que ser mayor que cero');
    const monto = String(leido);

    /* ── EN QUÉ DIVISA SE PUEDE CARGAR ─────────────────────────────────────────────────────────
       La CAJA suele tener una sola («463.life: ARS») pero el PANEL, que es lo que dice el casino,
       tiene diez: ARS, BRL, CLP, DOP, EUR, MXN, PEN, USD, UYU, VEF. La caja se quedó vieja, y con
       ella el selector ofrecía sólo pesos cuando el cliente puede pedir en uruguayos.

       ⚠️ Y hay una trampa: `/api/pedir` valida contra la CAJA y si la divisa no está la CAMBIA en
       silencio por la primera. Un pedido en UYU se guardaba como ARS y nadie se enteraba. Por eso
       se avisa cuándo la caja no la tiene, y se ofrece espejarla desde el panel. */
    const panelPre = paneles.list().find((p) => String(p.id_usuario) === String(caja.userId)
      || (p.nombre === caja.usuario && p.cliente_id === cli.id)) || null;
    const dCaja0 = String((caja.divisas && caja.divisas[0]) || 'ARS').toUpperCase();
    const delPanel = ((panelPre && panelPre.divisas) || []).map((x) => String(x).toUpperCase());
    const delaCaja = ((caja.divisas) || []).map((x) => String(x).toUpperCase());
    const disponibles = [...new Set([...delaCaja, ...delPanel])];
    if (!disponibles.length) disponibles.push('ARS');

    const dCaja = String(q.cargar_en || dCaja0).toUpperCase();
    if (!disponibles.includes(dCaja)) {
      return err(res, 400, `${caja.usuario} no maneja ${dCaja}. Puede: ${disponibles.join(', ')}`);
    }
    const dPide = String(q.divisa || dCaja).toUpperCase();
    const avisos = [];
    const enLaCaja = delaCaja.includes(dCaja);
    if (!enLaCaja) {
      avisos.push(`El panel ${caja.usuario} acepta ${dCaja}, pero para PEDIR todavía no está habilitada. `
        + `Si se creara el pedido así, se guardaría en ${delaCaja[0] || 'ARS'}.`);
    }

    /* ── EL TIPO DE CAMBIO: EL DE AHORA, Y SI NO EL ÚLTIMO QUE HAY ─────────────────────────────
       Para cargar fichas el promedio del mes no sirve: incluye días viejos y no es el precio al
       que se compra hoy. El orden es cotización VIVA → última foto guardada (de hoy, de ayer o de
       cuando sea, y se dice de cuándo) → recién al final el promedio del mes.

       El peso va por `tcAhora` (Binance) y el resto por `fetchTasas`, que es la misma fuente que
       usa el snapshot diario. Las dos pueden no contestar, y ahí es cuando importa tener la última
       foto con su fecha en vez de un promedio sin cara. */
    let tc = null; let tcFuente = null; let tcVivo = false; let tcFecha = null;
    if (dPide !== dCaja) {
      const esUsd = (d) => d === 'USD' || d === 'USDT';
      const otra = esUsd(dPide) ? dCaja : dPide;
      if (!esUsd(dPide) && !esUsd(dCaja)) {
        return err(res, 400, `no sé convertir ${dPide} a ${dCaja}: la conversión pasa por dólares`);
      }
      const hoy = require('../lib/fechas').fechaTZ();
      if (otra === 'ARS') {
        const a = await tcSvc.tcAhora().catch(() => null);
        if (a && a.vivo && money.isPos(String(a.tc))) { tc = String(a.tc); tcFuente = a.fuente; tcVivo = true; tcFecha = hoy; }
      } else {
        const viva = await tcDivisas.fetchTasas().catch(() => null);
        const v = viva && viva.ok && viva.tasas ? viva.tasas[otra] : null;
        if (v && money.isPos(String(v))) { tc = String(v); tcFuente = viva.fuente || 'cotización en vivo'; tcVivo = true; tcFecha = hoy; }
      }
      if (!tc) {
        // La última foto que haya, sin importar de qué día: es un precio real de un día real.
        const u = otra === 'ARS'
          ? (() => { const t = tcStore.ultimoTC(); return t && money.isPos(String(t)) ? { tasa: String(t), fecha: null, fuente: 'último snapshot' } : null; })()
          : tcDivisas.ultimo(otra, hoy);
        if (u && money.isPos(String(u.tasa))) {
          tc = String(u.tasa); tcFecha = u.fecha || null;
          const dias = tcFecha ? Math.round((Date.parse(hoy) - Date.parse(tcFecha)) / 86400000) : null;
          tcFuente = (u.fuente || 'snapshot') + (tcFecha
            ? ` · ${dias === 0 ? 'de hoy' : dias === 1 ? 'de ayer' : 'del ' + tcFecha}`
            : '');
          if (dias != null && dias > 1) avisos.push(`El tipo de cambio de ${otra} es del ${tcFecha} (${dias} días): no hay uno más nuevo guardado.`);
        }
      }
      if (!tc) {
        const d = deudaCargaSvc.tcDelDia(new Date().toISOString(), otra);
        if (d && money.isPos(String(d))) {
          tc = String(d); tcFuente = 'promedio del mes';
          avisos.push(`No hay cotización ni foto diaria de ${otra}: se usa el PROMEDIO DEL MES, que no es el precio de hoy.`);
        }
      }
      if (!tc) return err(res, 400, `no hay tipo de cambio para ${otra}: cargalo en 💱 Tipos de cambio`);
    }

    // El monto, llevado a la moneda en la que se carga. Recién después entra el %.
    const enCarga = tc
      ? (String(dPide) === 'USD' || String(dPide) === 'USDT'
        ? money.round(money.mul(monto, tc), 2)          // dólares → moneda de la caja
        : money.round(money.div(monto, tc), 2))         // moneda de la caja → dólares
      : money.round(monto, 2);

    const panel = panelPre;

    /* ── EL % DE ESE MES, Y SI YA SE CONFIRMÓ ──────────────────────────────────────────────────
       El % no es un número fijo del cliente: es una serie con fechas. Titan estuvo al 5 y desde
       septiembre va al 7. `baseDelMes` mira primero el CONFIRMADO de ese mes y después el vigente
       al cierre — la misma función que usa la facturación, para que no puedan decir distinto.

       ⚠️ Y se compara contra el que usaría la carga DE VERDAD, que toma el vigente de HOY. Si dan
       distinto se avisa: significa que el % de ese mes no está escrito como vigencia y la carga
       va a anotar otra cosa que la que dice esta pantalla. */
    const mes = String(q.mes || mesTZ()).slice(0, 7);
    const bm = externosSvc.baseDelMes(cli, mes, panel);
    const confirmada = externosSvc.baseGuardada(cli.nombre, mes);
    const base = bm.valor;
    const baseHoy = deudaCargaSvc.baseDe(cli, panel);
    if (base == null) avisos.push(`${cli.nombre || cli.codigo} no tiene % base cargado: la carga no va a generar deuda`);
    else if (baseHoy != null && String(baseHoy) !== String(base)) {
      avisos.push(`Ojo: para ${mes} figura ${base}%, pero una carga hecha hoy se anotaría al ${baseHoy}%. `
        + `Si el ${base}% rige desde ${mes}, guardalo con esa fecha para que la carga lo tome.`);
    }

    /* ── QUÉ SIGNIFICA EL % ────────────────────────────────────────────────────────────────────
       NO es un recargo sobre lo que carga: es lo que PAGA por cada 100 de fichas. Al 7%, quien
       pone 7 recibe 100. La fórmula es `fichas = paga ÷ % × 100`.

       Está comprobado contra la factura de Marcelo de agosto: pagó 23.491.277,28 ARS de comisión
       al 6% y sus cargas del mes son 391.521.288 ARS — y 23.491.277,28 ÷ 6 × 100 da exactamente
       eso. El motor de deuda dice lo mismo al revés: `deuda = % × lo cargado`, o sea que lo que
       paga ES la comisión, no una parte de ella.

       La primera versión de esta pantalla lo trató como un recargo (`fichas = paga ÷ 1,06`) y daba
       17 veces menos. Un error así no se ve mirando el número: se ve comparándolo contra una
       factura de verdad. */
    const enUsd = (dCaja === 'USD' || dCaja === 'USDT');
    const enUsdDe = (x) => (x == null ? null : (enUsd ? x : (tc ? money.round(money.div(x, tc), 2) : null)));
    const puedeBase = base != null && money.isPos(String(base));

    // ME PAGA ese monto → cuántas fichas recibe.
    const fichasPorPago = puedeBase
      ? money.round(money.div(money.mul(enCarga, '100'), String(base)), 2) : null;
    // QUIERE ese monto EN FICHAS → cuánto tiene que pagar.
    const pagoPorFichas = puedeBase ? money.round(money.pct(enCarga, String(base)), 2) : null;

    ok(res, {
      cliente: { id: cli.id, nombre: cli.nombre || cli.nombreVisible, codigo: cli.codigo },
      caja: { id: caja.id, usuario: caja.usuario, sistema: caja.sistema, divisa: dCaja,
        // Lo que la caja tiene hoy vs lo que el casino dice del panel: la diferencia es lo que
        // hace que un pedido se guarde en otra moneda sin avisar.
        divisas: delaCaja, divisasPanel: delPanel, disponibles, habilitadaEnLaCaja: enLaCaja },
      pide: { monto: money.round(monto, 2), divisa: dPide },
      tc: tc ? { valor: tc, fuente: tcFuente, vivo: tcVivo, fecha: tcFecha } : null,
      mes,
      base: base == null ? null : {
        pct: String(base),
        de: (panel && panel.usa_config_cliente === false) ? 'panel' : 'cliente',
        fuente: bm.fuente,
        // `confirmada` es lo que hace que se pregunte UNA vez por mes y por cliente, no siempre.
        confirmada: !!(confirmada && confirmada.base_pct != null && confirmada.base_pct !== ''),
        hoy: baseHoy == null ? null : String(baseHoy),
      },
      // Te paga ese monto → esas son las fichas que recibe. Lo que paga ES la comisión.
      comoPago: { cargar: fichasPorPago, divisa: dCaja,
        paga: enCarga, paga_usdt: enUsdDe(enCarga) },
      // Quiere ese monto EN FICHAS → esto es lo que tiene que pagar.
      comoFichas: { cargar: enCarga, divisa: dCaja,
        paga: pagoPorFichas, paga_usdt: enUsdDe(pagoPorFichas) },
      avisos,
    });
  }));
  /* CONFIRMAR EL % DE UN CLIENTE PARA UN MES. Se pregunta UNA vez por mes y por cliente, antes de
     la primera carga: es el momento en que alguien sabe si cambió.

     Si es el MISMO, sólo se anota la confirmación y no se vuelve a preguntar.
     Si es OTRO, además se guarda como VIGENCIA desde el día 1 de ese mes — no como corrección.
     Es lo que hace que la carga real lo tome: ella lee el vigente de hoy, no la confirmación del
     mes. Guardarlo sólo como confirmación dejaría la pantalla diciendo 7 y la carga anotando 5.
     Y una corrección («siempre») pisaría los meses anteriores: Titan estuvo al 5 de verdad. */
  /* Poner al día las divisas de UNA caja desde su panel. `/api/pedir` valida contra la caja y si
     la divisa no está la cambia en silencio por la primera: un pedido en UYU se guardaba como ARS.
     Antes había que correr el sync de TODAS o editarla a mano. */
  app.post('/api/os/carga/sincronizar-caja', wrap((req, res) => {
    const b = req.body || {};
    const cli = clientes.get(b.cliente_id) || clientes.getByCodigo(b.cliente_id);
    if (!cli) return err(res, 404, 'no encuentro ese cliente');
    const caja = (cli.cajas || []).find((k) => String(k.id) === String(b.caja_id));
    if (!caja) return err(res, 400, 'no encuentro esa caja');
    const panel = paneles.list().find((p) => String(p.id_usuario) === String(caja.userId)
      || (p.nombre === caja.usuario && p.cliente_id === cli.id));
    if (!panel) return err(res, 400, `no encuentro el panel de ${caja.usuario}: sin él no sé qué divisas tiene`);
    const antes = (caja.divisas || []).slice();
    const r = _espejarCaja(panel);
    const dsp = ((clientes.get(cli.id).cajas || []).find((k) => String(k.id) === String(caja.id)) || {}).divisas || [];
    ok(res, { resultado: r || 'sin cambios', antes, ahora: dsp, panel: panel.nombre });
  }));
  app.post('/api/os/carga/base', wrap((req, res) => {
    const b = req.body || {};
    const cli = clientes.get(b.cliente_id) || clientes.getByCodigo(b.cliente_id);
    if (!cli) return err(res, 404, 'no encuentro ese cliente');
    const mes = String(b.mes || mesTZ()).slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(mes)) return err(res, 400, 'mes inválido');
    const pct = String(b.pct == null ? '' : b.pct).trim().replace(',', '.');
    // `Number('') === 0` y `0 >= 0` es true: sin preguntar por el vacío aparte, se colaba hasta
    // `setValor`, que lo rechaza con un mensaje que no dice qué hacer. Un 0 sí es un % válido.
    if (pct === '') return err(res, 400, 'falta el %: escribilo antes de guardar');
    if (!Number.isFinite(Number(pct)) || Number(pct) < 0) return err(res, 400, `"${b.pct}" no es un porcentaje`);

    const antes = deudaCargaSvc.baseDe(cli, null);
    let vigencia = null;
    if (antes == null || String(antes) !== pct) {
      vigencia = historial.setValor('cliente', cli.id, 'precio_base_pct', {
        valor: pct, tipo_cambio: 'vigencia', vigente_desde: `${mes}-01`,
        notas: `confirmado al calcular una carga de ${mes}`,
      });
    }
    const g = externosSvc.confirmarBase(cli.nombre, mes, pct);
    ok(res, { mes, pct, cambio: !!vigencia, antes: antes == null ? null : String(antes), confirmada: g });
  }));
  /* Quién agarró la plata de un pago. Se corrige después a propósito: al acreditar no siempre se
     sabe, y obligar a elegir en ese momento lleva a elegir cualquier cosa para poder seguir. */
  app.put('/api/os/pagos/:id/recibido-por', wrap((req, res) => {
    const r = movs.setRecibidoPor(req.params.id, (req.body || {}).persona_id || null);
    r.ok ? ok(res, { movimiento: r.movimiento }) : err(res, 404, r.error);
  }));
}

module.exports = { mount };
