/**
 * comun.js — lo que usan varias partes del servidor del OS: las respuestas (ok, err, wrap) y las
 * piezas que comparten varios sectores. Sale de os.routes.js (fase 2): sólo se movió de lugar.
 */
const clientes = require('../clientes-store');
const paneles = require('../paneles-store');
const casinoConex = require('../casino-conexiones-store');
const reporteDiarioStore = require('../reporte-diario-store');
const pedidosStore = require('../pedidos-store');
const externosSvc = require('../externos.service');
const tcUnico = require('../tc-unico.service');
const ventasOnline = require('../ventas-online.service');
const configStore = require('../config-store');
const money = require('../lib/money');

const ok = (res, extra = {}) => res.json(Object.assign({ ok: true }, extra));
const err = (res, code, msg, extra) => res.status(code).json({ ok: false, error: msg, ...(extra || {}) });
const wrap = (fn) => async (req, res) => { try { await fn(req, res); } catch (e) { err(res, 400, e.message); } };

// Panel del OS (HTML estático, detrás del gate de auth)
const path = require('path');
/* ── EL NAVEGADOR NO PUEDE QUEDARSE CON UNA COPIA VIEJA ──────────────────────────────────────
   `express.static` no manda ningún Cache-Control, y sin él el navegador aplica su propia regla:
   reutiliza la respuesta un rato SIN preguntar si cambió. Para un archivo que se reescribe en
   cada despliegue eso significa que un cambio ya desplegado no aparece — y desde la pantalla se
   ve idéntico a que no se hubiera subido. Pasó de verdad: la pestaña nueva estaba en el servidor
   y en la pantalla no.

   `no-cache` NO quiere decir "no guardes": quiere decir "guardala, pero preguntá siempre si
   cambió". Con el ETag que ya manda express, la pregunta se contesta con un 304 sin cuerpo, así
   que no cuesta ancho de banda — sólo un viaje corto. Es lo correcto para un HTML que cambia. */
const html = (res, archivo) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(path.join(__dirname, '..', '..', 'public', archivo));
};
// Espeja un panel del OS → CAJA operativa (para /pedir y las cargas de fichas). Idempotente por (userId, sistema).
// `clienteDestino` deja mandar la caja a OTRO cliente que el dueño del panel. Pasa de verdad:
// un panel figura a nombre del vendedor pero las fichas las pide el cliente final, o al revés.
// Por defecto va al dueño del panel, que es lo que corresponde casi siempre.
/* ⚠️ Y SI YA EXISTE, SE ACTUALIZA. Antes sólo creaba: cambiar las divisas de un panel en el OS
   no llegaba nunca a Fichas, y el cliente seguía pudiendo pedir sólo en las viejas. Pasó con
   GAF-D — puesto en PYG en el OS y ofreciendo ARS en Fichas — y con otros 68 paneles.
   Se copia lo que describe a la cuenta (nombre y divisas); los montos rápidos y el grupo son de
   Fichas y no se tocan. */
// La caja y el panel son la misma cuenta: la regla de qué se copia vive en cuenta-espejo.js.
const _espejarCaja = (p, clienteDestino, desde) => require('../cuenta-espejo').panelACaja(p, { destino: clienteDestino, desde });

// ───────── FACTURACIÓN ─────────
//
// ⭐ LO QUE SE COBRA SALE DE LOS PEDIDOS, no del casino (decisión del dueño).
// Son dos números distintos por diseño: el casino informa todo lo que entró a los paneles
// (incluidas cargas hechas por fuera del sistema, bonos y movimientos internos), y los pedidos
// son lo que se le vendió al cliente. Se factura lo vendido.
//
// El casino se sigue trayendo AL LADO, como control: si los dos números se separan mucho, o falta
// cargar pedidos o hubo cargas por fuera. Pero si el casino no responde, se factura igual —
// antes una caída del casino dejaba sin facturar.
// EL CÁLCULO DE LA FACTURACIÓN, en una función: lo usan la pantalla y la emisión a la deuda.
// Si cada una lo calculara por su lado, el número que se muestra y el que se cobra podrían
// separarse — que es exactamente lo que veníamos de arreglar en todo lo demás.
async function _facturacionDe(mes, opciones = {}) {
  opciones = opciones || {};
  const from = opciones.from || `${mes}-01 00:00:00`;
  // El 'hasta' sale del MES elegido, no de hoy: si no, facturar un mes cerrado suma todo lo que
  // pasó después (pedir junio en agosto traía junio+julio+agosto en una sola línea, rotulada 'Junio').
  const _ultDia = new Date(Date.UTC(Number(mes.slice(0, 4)), Number(mes.slice(5, 7)), 0)).getUTCDate();
  const to = opciones.to || `${mes}-${String(_ultDia).padStart(2, '0')} 23:59:59`;
  const conControl = opciones.control !== false;

  // 1) LA BASE DE COBRO: los pedidos cargados del mes, por cliente y por moneda.
  //
  // Los pedidos se toman en el SISTEMA EN LÍNEA, no acá. Si el puente está configurado se traen
  // de allá, ya traducidos a clientes de este lado (los dos padrones usan códigos distintos: allá
  // "M526", acá "Marcelo"). Si no está configurado, se usan los pedidos locales — que en el OS
  // normalmente son cero, y por eso la factura salía vacía.
  let ventasCli = {}; let huerfanas = []; let origen = 'pedidos locales';
  let avisoPuente = null;
  const puente = ventasOnline.getConfig();
  // ── SI EL PUENTE FALLA, SE USAN LOS PEDIDOS DE ACÁ ──────────────────────────────────────────
  //
  // El puente traía los pedidos del sistema viejo. Desde la migración los 848 pedidos viven en
  // esta base, y el sistema viejo ya no autentica: devolvía 401 y esta función cortaba con un
  // error, o sea que la facturación mensual ENTERA estaba caída y no se podía emitir nada.
  //
  // No es un fallback silencioso —eso sí podría duplicar— porque las dos fuentes son
  // excluyentes: o los pedidos están allá o están acá. Se usa lo de acá y se dice que el puente
  // falló, para que quede claro de dónde salió el número y para que alguien lo apague.
  if (puente && puente.url) {
    const vo = await ventasOnline.ventasDelMes(mes);
    if (!vo.ok) {
      avisoPuente = `el puente al sistema en línea no contestó (${vo.error}). Se usaron los pedidos `
        + 'de este sistema, que desde la migración son los buenos. Conviene apagar el puente en Config.';
      console.warn('[Facturación] ' + avisoPuente);
    } else {
    ventasCli = vo.porCliente;
    huerfanas = (vo.sinMapeo || []).map((x) => ({ codigo: x.codigo, pedidos: x.count, porDivisa: Object.entries(x.porDivisa).map(([d, m]) => ({ divisa: d, monto: money.round(String(m), 2) })) }));
    origen = 'pedidos del sistema en línea';
    }
  }
  let ruteadas = []; let sinCobrar = []; let paraRevisar = [];
  if (!Object.keys(ventasCli).length) {
    /* El ruteo lo decide cada panel (`consumo_a`), no el código a secas: hay paneles que son de
       la misma persona con otra cuenta (los de JJ son de Marcelo, los de Ariel de Fran) y hay
       paneles de tránsito de un vendedor donde cobrar sería cobrar dos veces la misma entrega.
       Lo que se ruteó distinto y lo que no se cobra se devuelve, para que no pase en silencio. */
    const r = pedidosStore.ventasDelMesPorCliente(mes);
    ventasCli = r.porCliente;
    ruteadas = r.ruteadas; sinCobrar = r.sinCobrar; paraRevisar = r.paraRevisar;
    huerfanas = huerfanas.concat((r.sinCliente || []).map((x) => ({
      codigo: x.codigo, pedidos: x.count,
      porDivisa: Object.entries(x.porDivisa).map(([d, m]) => ({ divisa: d, monto: money.round(String(m), 2) })),
    })));
  }

  // 2) EL CONTROL: lo que dice el casino. Si falla, se informa y se sigue.
  //
  // ⚡ Sale del ACUMULADO GUARDADO, no del casino en vivo. El cron nocturno ya baja esto todas
  // las noches a `reporte_diario`; preguntárselo otra vez al casino en cada pantallazo tardaba
  // ~70s (bajaba el árbol ENTERO de las dos conexiones) para llegar al mismo número. Un mes
  // cerrado además no cambia más, así que consultarlo de nuevo no aporta nada.
  // Se va en vivo solo si se pide `?vivo=1` o si el rango de fechas no es un mes completo
  // (el acumulado está guardado por mes, no puede contestar un rango arbitrario).
  const linked = paneles.list().filter((p) => p.conexion_id && p.id_usuario);
  const nodeMap = {}; const errores = [];
  let controlDe = 'acumulado guardado'; let cobertura = null;
  if (conControl) {
    const rangoPropio = !!(opciones.from || opciones.to);
    const vivo = !!opciones.vivo || rangoPropio;
    if (!vivo) {
      const keys = linked.map((p) => ({ conexion_id: p.conexion_id, grp: 'superagent', sa_id: String(p.id_usuario) }));
      const filas = reporteDiarioStore.filasPanelesMes(keys, mes);
      for (const f of filas) {
        const m = nodeMap[f.conexion_id] = nodeMap[f.conexion_id] || {};
        const n = m[String(f.sa_id)] = m[String(f.sa_id)] || { montos: {} };
        const div = String(f.moneda || 'ARS');
        n.montos[div] = n.montos[div] || { in: '0' };
        n.montos[div].in = money.add(n.montos[div].in, String(f.in_amt || 0));
      }
      cobertura = reporteDiarioStore.diasCapturados(mes);
      // Un mes a medio capturar mostraría el control más chico de lo que es y parecería un desvío.
      if (!cobertura.dias) errores.push(`el acumulado de ${mes} está vacío: el control no dice nada (capturalo en 📒 Acumulado, o pedí ?vivo=1)`);
    } else {
      controlDe = rangoPropio ? 'casino en vivo (rango propio)' : 'casino en vivo (pedido)';
      const byConn = {};
      linked.forEach((p) => { (byConn[p.conexion_id] = byConn[p.conexion_id] || []).push(p); });
      for (const cid of Object.keys(byConn)) {
        const cli = casinoConex.client(cid); if (!cli) { errores.push(`conexión ${cid} no disponible`); continue; }
        try {
          const r = await cli.nodos({ from, to, soloActivos: true, multiMoneda: true });
          if (!r.ok) { errores.push(`conexión ${cid}: ${r.error}`); continue; }
          const m = {}; r.nodos.forEach((n) => { m[String(n.id)] = n; }); nodeMap[cid] = m;
        } catch (e) { errores.push(`conexión ${cid}: ${String((e && e.message) || e)}`); }
      }
    }
  }

  // Las cargas del mes, una sola vez: sirven para saber a quién se le facturó lo que entró a cada
  // panel, que es lo que distingue "faltan pedidos" de "sus cargas van a otra cuenta".
  let detalleMes = [];
  try { detalleMes = pedidosStore.detalleDelMes(mes); } catch (e) { /* el aviso sale igual, sin el detalle */ }

  const _tc = tcUnico.tcDelMes('ARS', mes);
  const tc = _tc.valor;
  const out = []; const sinBase = new Set(); const sinTC = new Set();
  const sinPedidos = [];      // tienen movimiento en el casino pero NO se les vendió nada
  const enCero = [];          // el % base dice 0: se les factura cero y parece correcto
  // ⚠️ Ventas cuyo código NO corresponde a ningún cliente. Con los pedidos como base de cobro,
  // eso es plata vendida que no se le factura a nadie y que no aparece por ningún lado.
  // Verificado en producción: "Mclain" y "CharlyS2" con 170.000.000 cargados, sin cliente.
  // Pasa cuando se renombra el código de un cliente y los pedidos viejos quedan con el anterior.
  let totVend = '0', totFee = '0', totCasino = '0';
  let cmpVend = '0', cmpCasino = '0';   // solo los clientes que SÍ tienen pedidos

  // ⚠️ LOS VENDEDORES NO VAN EN ESTA FACTURA. No pagan un % de lo que cargan: pagan el COSTO
  // REAL de los proveedores que usen, y eso se liquida en 🧮 Cierre de Mes → 🤝 Vendedores.
  // Estando acá aparecían como "sin % base — van al 0%" (los 6 en rojo: David, IGLatam, Sarah,
  // Alexa, Carlos, Henry), se les facturaba cero, y su movimiento del casino igual se sumaba al
  // control: el total decía que la venta difería un 66% de lo que el casino registró, mezclando
  // plata que esta factura no cobra por diseño.
  const vendedores = [];
  for (const c of clientes.list().clientes) {
    const v = ventasCli[c.id] || null;
    const cps = linked.filter((p) => p.cliente_id === c.id);
    /* ── UN VENDEDOR TAMBIÉN CONSUME ────────────────────────────────────────────────────────
       Antes se los salteaba enteros, y con eso se perdían las cargas que llevan SU código —
       las que carga para sí mismo, no las que pasan hacia sus clientes. Medido jun-ago 2026:
       364.965 USDT que no generaban deuda a nadie. Julian tenía 4 cargas propias en M7Martin-SA
       y David 8 en sus paneles, todas con su código y ninguna de paso.
       Lo que separa una cosa de la otra es el CÓDIGO del pedido, que ya viene resuelto: lo que
       va hacia un cliente lleva el código del cliente y se le factura a él.
       Y lo que decide si al vendedor se le cobra es su % base: en 0 no se le cobra nada, que es
       el caso de IGLatam (regla de la dueña: «IGLatamYa no se cobra, sólo lo que se cobran a los
       usuarios abajo»). Se lo sigue listando aparte para que se vea que es vendedor. */
    if (c.es_vendedor && (v || cps.length)) vendedores.push(c.nombre || c.nombreVisible || c.codigo);
    if (c.es_vendedor && !v) continue;          // vendedor sin cargas propias: nada que facturar

    // el % del MES que se está facturando. Los pedidos son por CLIENTE, así que el precio propio
    // de un panel no se puede aplicar acá: si un cliente tiene paneles con precios distintos, hay
    // que unificarlos o cobrarle esa diferencia aparte.
    const rb = externosSvc.baseDelMes(c, mes);
    const base = rb.valor || '0';

    // ── lo vendido, moneda por moneda ──
    let vendUsdt = '0', feeUsdt = '0'; const porDivisa = []; const sinTCCliente = [];
    for (const [div, monto] of Object.entries((v && v.porDivisa) || {})) {
      const t = tcUnico.tcDelMes(div, mes);
      const fee = money.pct(String(monto), base);
      /* La lista global `sinTC` dice QUÉ monedas faltan; la del cliente dice A QUIÉN le faltan.
         Sin esa segunda, la emisión no puede saltear al cliente afectado y le emite el total
         recortado — y como emitir es idempotente por cliente+mes, la parte que falta ya no se
         puede agregar salvo anulando el mes entero. */
      if (!t.valor) { sinTC.add(div); sinTCCliente.push(div);
        porDivisa.push({ divisa: div, vendido: String(monto), tc: null }); continue; }
      vendUsdt = money.add(vendUsdt, money.div(String(monto), t.valor));
      feeUsdt = money.add(feeUsdt, money.div(fee, t.valor));
      porDivisa.push({ divisa: div, vendido: money.round(monto, 2), fee: money.round(fee, 2), tc: t.valor, vendidoUsdt: money.round(money.div(String(monto), t.valor), 2) });
    }

    // ── el control del casino ──
    let casinoUsdt = '0'; let hayCasino = false;
    for (const p of cps) {
      const node = (nodeMap[p.conexion_id] || {})[String(p.id_usuario)];
      if (!node) continue;
      hayCasino = true;
      const montos = (node.montos && Object.keys(node.montos).length) ? node.montos : { ARS: { in: node.in } };
      for (const [div, x] of Object.entries(montos)) {
        const t = tcUnico.tcDelMes(div, mes);
        if (t.valor) casinoUsdt = money.add(casinoUsdt, money.div(x.in || '0', t.valor));
      }
    }

    if (!v && !hayCasino) continue;                       // ni vendido ni movimiento: no aparece
    if (rb.valor == null && v) sinBase.add(c.nombre || c.nombreVisible || c.codigo);
    // Base CERO no es lo mismo que base sin cargar: acá el número está puesto, dice cero, y la
    // factura sale en cero "correctamente". Si fue un olvido, nada lo iba a delatar.
    if (rb.valor != null && !money.isPos(base) && (v || money.isPos(casinoUsdt))) {
      enCero.push({ nombre: c.nombre || c.nombreVisible || c.codigo, vendido_usdt: money.round(vendUsdt, 2), casino_usdt: money.round(casinoUsdt, 2) });
    }

    /* Movimiento en el casino pero CERO pedidos: se avisa, porque una factura en cero pasa
       desapercibida. Pero NO siempre falta algo: si los paneles de este cliente recibieron cargas
       que se le facturan a OTRO —los de JJ llevan el código de Marcelo, los de Ariel el de Fran—
       entonces está bien que él no tenga pedidos, y decir "faltan pedidos" manda a buscar algo
       que no existe. Se dice a quién se le facturaron. */
    if (!v && hayCasino && money.isPos(casinoUsdt)) {
      const nodos = new Set(cps.map((p) => String(p.id_usuario)));
      const aOtro = {};
      for (const d of (detalleMes || [])) {
        if (!nodos.has(String(d.userId))) continue;
        const dest = clientes.list().clientes.find((x) => String(x.codigo).toLowerCase() === String(d.codigo).toLowerCase());
        if (!dest || dest.id === c.id) continue;
        const k = dest.nombre || dest.codigo;
        aOtro[k] = (aOtro[k] || 0) + 1;
      }
      /* Y lo que decide si esto es normal o no: ¿cuándo fue la última vez que a estos paneles les
         entró una carga? El `in` del nodo es lo que depositan los JUGADORES, y eso sigue pasando
         mientras les quede saldo — un cliente que compró en julio y no en agosto tiene movimiento
         en agosto sin deberle nada a nadie. Distinto es un panel al que NUNCA le entró una carga
         por el sistema y aun así tiene jugadores depositando: ahí las fichas entran por otro lado.
         Verificado: Luis compró 9.856.250 en julio y nada en agosto; los paneles de Ivan y Raul
         no recibieron una sola carga en toda la historia. */
      let ultimaCarga = null;
      try {
        for (const d of pedidosStore.detalleDelMes(null)) {
          if (!nodos.has(String(d.userId))) continue;
          if (!ultimaCarga || d.iso > ultimaCarga.iso) ultimaCarga = { iso: d.iso, mes: String(d.iso).slice(0, 7), codigo: d.codigo };
        }
      } catch (e) { /* sin esto el aviso sale igual, sólo que sin poder distinguir */ }
      sinPedidos.push({
        codigo: c.codigo, nombre: c.nombre || c.nombreVisible,
        casino_usdt: money.round(casinoUsdt, 2),
        seFacturanA: Object.entries(aOtro).map(([n, k]) => ({ cliente: n, cargas: k })),
        ultimaCarga,
      });
    }

    // lo que quedó a mitad de anular: las fichas están puestas pero la vuelta no se confirmó
    let anulandoUsdt = '0';
    for (const [div, monto] of Object.entries((v && v.anulando && v.anulando.porDivisa) || {})) {
      const t = tcUnico.tcDelMes(div, mes);
      if (t.valor) anulandoUsdt = money.add(anulandoUsdt, money.div(String(monto), t.valor));
    }

    const dif = money.isPos(casinoUsdt) ? money.round(money.mul(money.div(money.sub(vendUsdt, casinoUsdt), casinoUsdt), '100'), 1) : null;
    out.push({
      cliente_id: c.id, codigo: c.codigo, nombre: c.nombre || c.nombreVisible, moneda: 'USDT',
      base, baseFuente: rb.fuente, sinBase: rb.valor == null,
      pedidos: (v && v.count) || 0,
      vendido_usdt: money.round(vendUsdt, 2),
      fee_usdt: money.round(feeUsdt, 2),
      casino_usdt: money.round(casinoUsdt, 2),
      dif_pct: dif,
      anulando: (v && v.anulando && v.anulando.count) ? { count: v.anulando.count, usdt: money.round(anulandoUsdt, 2) } : null,
      porDivisa,
      sinTC: sinTCCliente,          // las monedas de ESTE cliente que no se pudieron pasar a USDT
      paneles: cps.map((p) => p.nombre),
      // Con qué código(s) se pidieron estas cargas. La factura lo necesita para traer el detalle
      // de los MISMOS pedidos que forman el total: si eligiera por su cuenta, las líneas podrían
      // no sumar el número de arriba.
      codigos: (v && v.codigos) || [c.codigo],
    });
    totVend = money.add(totVend, vendUsdt);
    totFee = money.add(totFee, feeUsdt);
    totCasino = money.add(totCasino, casinoUsdt);
    // El total contra el total no dice nada cuando hay clientes que cargan por fuera del
    // sistema: Titan solo son 1,96M de los 3,3M del control, y arrastra el promedio a -66%
    // sin que haya nada mal. Este otro total compara SOLO a los que sí pasan por pedidos, que
    // es donde un desvío significa de verdad que algo no cuadra.
    if (v && v.count) { cmpVend = money.add(cmpVend, vendUsdt); cmpCasino = money.add(cmpCasino, casinoUsdt); }
  }

  out.sort((a, b) => Number(b.fee_usdt) - Number(a.fee_usdt));

  // Lo vendido que quedó sin dueño: códigos del sistema en línea que no están mapeados a
  // ningún cliente de acá. Es plata vendida que no se le factura a nadie, así que se informa
  // con el monto para poder mapearla o crear el cliente.
  for (const h of huerfanas) {
    let u = '0';
    for (const d of h.porDivisa) {
      const t = tcUnico.tcDelMes(d.divisa, mes);
      if (t.valor) u = money.add(u, money.div(String(d.monto), t.valor));
    }
    h.usdt = money.round(u, 2);
  }
  huerfanas.sort((a, b) => Number(b.usdt) - Number(a.usdt));

  return {
    mes, from, to, tc, tcFuente: _tc.fuente, tcConflicto: _tc.conflicto, moneda: 'USDT',
    fuente: 'pedidos cargados', control: conControl ? controlDe : 'apagado', cobertura,
    origen, avisoPuente, sinBase: [...sinBase], sinTC: [...sinTC], sinPedidos, enCero, huerfanas,
    /* Los vendedores que DE VERDAD quedaron afuera: los que no aparecen en la tabla. Desde que un
       vendedor con % base sí se factura por sus propias cargas, listarlos a todos como "afuera
       por diseño" era mentira en pantalla — David y Julian estaban ahí Y facturando. */
    vendedores: vendedores.filter((n) => !out.some((c) => (c.nombre || c.codigo) === n)),
    // Cargas que se le facturaron a otro (por la marca del panel) y cargas que no se cobran.
    ruteadas, sinCobrar, paraRevisar,
    totales: {
      vendido_usdt: money.round(totVend, 2),
      fee_usdt: money.round(totFee, 2),
      casino_usdt: money.round(totCasino, 2),
      dif_pct: money.isPos(totCasino) ? money.round(money.mul(money.div(money.sub(totVend, totCasino), totCasino), '100'), 1) : null,
      // Comparable = solo los clientes que pasan por pedidos. Es el número que dice si la
      // facturación cuadra; el otro mezcla a los que cargan por fuera del sistema.
      cmp_vendido_usdt: money.round(cmpVend, 2),
      cmp_casino_usdt: money.round(cmpCasino, 2),
      cmp_dif_pct: money.isPos(cmpCasino) ? money.round(money.mul(money.div(money.sub(cmpVend, cmpCasino), cmpCasino), '100'), 1) : null,
      fuera_usdt: money.round(money.sub(totCasino, cmpCasino), 2),
    },
    clientes: out, errores,
  };
}

/** La URL pública de este servicio, para armar los links que se le mandan al cliente. */
function _urlPublica(req) {
  const cfg = configStore.getUrlPublica();
  if (cfg) return cfg;
  const host = process.env.RAILWAY_PUBLIC_DOMAIN || (req && req.get && req.get('host')) || 'localhost';
  return /^https?:\/\//.test(host) ? host.replace(/\/+$/, '') : 'https://' + host;
}

module.exports = { ok, err, wrap, html, _espejarCaja, _facturacionDe, _urlPublica };
