/**
 * reparto.routes.js — El reparto: participaciones, base del reparto, resultado y lo cobrado.
 * Sale de os.routes.js (fase 2): las rutas se movieron tal cual y en el mismo orden.
 */
const clientes = require('../clientes-store');
const personas = require('../personas-store');
const participaciones = require('../participaciones-store');
const splitBase = require('../split-base-store');
const movs = require('../movimientos-store');
const repartoSvc = require('../reparto.service');
const externosSvc = require('../externos.service');
const tcUnico = require('../tc-unico.service');
const money = require('../lib/money');
const { mesTZ } = require('../lib/fechas'); // fechaTZ/mesTZ=ART (billing) · fechaUTC/mesUTC=UTC (casino)
const { ok, err, wrap } = require('./comun');

function mount(app) {
  app.get('/api/os/participaciones', (req, res) => {
    const { cliente_id, panel_id } = req.query;
    if (!cliente_id) return err(res, 400, 'cliente_id requerido');
    ok(res, {
      efectivo: participaciones.repartoEfectivo(cliente_id, panel_id || null),
      vigente: participaciones.listVigente(cliente_id, panel_id || null),
    });
  });
  app.post('/api/os/participaciones', wrap((req, res) => {
    const { cliente_id, panel_id, items, vigente_desde, mes, parcial } = req.body || {};
    if (!cliente_id || !Array.isArray(items)) return err(res, 400, 'cliente_id + items[] requeridos');
    // §12: el reparto cierra contra el % BASE del cliente, no contra 100. `parcial:true` deja
    // guardar un reparto a medio configurar — los puntos que faltan quedan visibles como
    // "sin asignar" en vez de bloquear el guardado y perder lo ya cargado.
    const c = clientes.get(cliente_id);
    if (!c) return err(res, 404, 'cliente no encontrado');
    const base = externosSvc.baseDelMes(c, mes || mesTZ()).valor;
    if (base == null || base === '') return err(res, 400, `${c.codigo} no tiene % base cargado: sin eso no hay contra qué cerrar el reparto`);
    const suma = money.sum(items.map((i) => i.porcentaje));
    if (money.cmp(suma, base) > 0) return err(res, 400, `El reparto suma ${suma}% y la base es ${base}%: se estaría repartiendo más de lo que paga el cliente`);
    if (!parcial && money.cmp(suma, base) !== 0) return err(res, 400, `El reparto debe sumar el ${base}% de base (suma ${suma}%)`);
    const r = participaciones.setReparto(cliente_id, panel_id || null, items, vigente_desde, { esperado: suma });
    ok(res, { reparto: r, base, suma: money.round(suma, 4), resto: money.round(money.sub(base, suma), 4) });
  }));
  app.get('/api/os/participaciones/historial', (req, res) =>
    ok(res, { historial: participaciones.listHistorial(req.query.cliente_id, req.query.panel_id || null) }));
  // ───────── SPLIT_BASE (JUBILADA — §12) ─────────
  // Era el 1er paso del reparto viejo: por cada % base, cuánto iba a Empresa y cuánto a LATAM.
  // Ahora el reparto es de un solo paso y la Empresa es un participante más (reparto.service).
  // Queda SOLO LECTURA: los datos siguen en la base y `sembrarDesdeSplit` los usa para
  // pre-cargar el reparto de cada cliente. Se sacaron el PUT y el DELETE a propósito —
  // editarla ya no cambiaría ningún cálculo, así que dejarlos era una trampa.
  app.get('/api/os/split-base', (_req, res) => ok(res, { split_base: splitBase.list(), jubilada: true }));
  // Sembrar el reparto de los clientes desde la vieja Tabla Split (Empresa) — ver reparto.service.
  app.post('/api/os/reparto/sembrar', wrap((req, res) => {
    const mes = req.body && req.body.mes ? String(req.body.mes).slice(0, 7) : mesTZ();
    const aplicar = !!(req.body && req.body.aplicar);
    ok(res, repartoSvc.sembrarDesdeSplit(clientes.list().clientes, mes, { aplicar }));
  }));
  // El reparto de UN cliente, contrastado contra su % base (lo consume el editor).
  /* ───────── 💰 EL REPARTO DE LO COBRADO ────────────────────────────────────────────────────
     La pantalla de Reparto dice a quién le CORRESPONDE lo facturado. Esto dice de quién es la
     plata que YA ENTRÓ, que nunca es lo mismo: se cobra parcial, se descuentan comisiones, y un
     pago de hoy puede estar pagando un cierre viejo.

     Regla de la dueña (5-oct-2026): cada pago se parte con los puntos que tenía ese cliente EN EL
     MES AL QUE ENTRA EL PAGO, no con los de hoy ni tapando el mes más viejo primero. Si cambió un
     porcentaje en el medio, lo que se cobró de un mes viejo sigue siendo de quien era entonces.

     Y van las DOS caras, que son preguntas distintas: de quién ES cada peso (los puntos) y quién
     LO RECIBIÓ (`recibido_por`). La diferencia entre las dos es lo que un socio le debe al otro.

     ⚠️ LO QUE NO ESTÁ EN LOS PUNTOS NO SE REPARTE SOLO. Los puntos suman el % base del cliente,
     que es el fee de las FICHAS. Un cliente que además paga proveedores externos está pagando dos
     conceptos con la misma transferencia, y acá no hay forma de saber qué parte es cuál. Se avisa
     por cliente en vez de repartir de más. */
  app.get('/api/os/reparto-cobrado', wrap((req, res) => {
    const mes = String(req.query.mes || mesTZ()).slice(0, 7);
    const cs = clientes.list().clientes;
    const porId = {}; cs.forEach((c) => { porId[c.id] = c; });
    const nomPersona = {}; const esEmp = {};
    personas.list().forEach((p) => { nomPersona[p.id] = p.nombre; esEmp[p.id] = !!p.es_empresa; });

    // Quiénes tuvieron externos este mes: su pago mezcla dos conceptos y el reparto sólo cubre uno.
    const conExternos = new Set();
    try {
      movs.list({ tipo: 'proveedor_extra' }).forEach((mv) => {
        if (movs.mesDe(mv) === mes) conExternos.add(mv.cliente_id);
      });
    } catch (e) { /* si no se puede leer, se reparte igual y no se avisa */ }

    const porPersona = {}; const porReceptor = {};
    let total = '0'; let sinAsignar = '0';
    const pagos = movs.list({ tipo: 'pago' }).filter((mv) => movs.mesDe(mv) === mes).map((mv) => {
      const cli = porId[mv.cliente_id] || {};
      /* SIEMPRE en USDT: es la unidad de la cuenta y la única forma de sumar a todos juntos.
         ── EL QUE LLEVA SU CUENTA EN PESOS ───────────────────────────────────────────────────
         Su pago se guarda sólo en pesos: su cuenta es en pesos y nadie necesitó la otra cara. Para
         el reparto sí hace falta, así que se pasa con el TC DEL MES —el mismo que valúa todo lo
         demás— y se marca `convertido`, para que en pantalla se vea que ese número se derivó y no
         es un importe que alguien escribió. Antes quedaba afuera del informe: 1 de los 18 pagos de
         septiembre, y el total decía 10.222,15 como si no faltara nada. */
      // Lo que ENTRÓ, no lo que bajó la deuda: con «los pesos cancelan pesos» un pago en pesos salda
      // más dólares de los que dio el trader, y esa diferencia la pone la empresa. Se reparte la plata real.
      let usdt = mv.usdt_recibido != null ? mv.usdt_recibido : mv.monto_usdt;
      let convertido = null;
      if ((usdt == null || usdt === '') && mv.monto_ars != null && mv.monto_ars !== '') {
        const t = tcUnico.tcPagosDelMes('ARS', mes);   // plata que entró: el cambio del trader
        if (t.valor && money.isPos(t.valor)) {
          usdt = money.round(money.div(mv.monto_ars, t.valor), 2);
          convertido = { desde_ars: mv.monto_ars, tc: t.valor, fuente: t.fuente };
        }
      }
      const sinUsdt = usdt == null || usdt === '';
      const r = sinUsdt ? null : repartoSvc.repartirCobrado(usdt, cli, mes);
      if (r) {
        total = money.add(total, r.monto_usdt);
        sinAsignar = money.add(sinAsignar, r.sin_asignar);
        r.items.forEach((it) => {
          const a = porPersona[it.persona_id] = porPersona[it.persona_id]
            || { persona_id: it.persona_id, nombre: it.nombre, es_empresa: it.es_empresa, monto: '0' };
          a.monto = money.add(a.monto, it.monto);
        });
        const k = mv.recibido_por || '';
        const rc = porReceptor[k] = porReceptor[k]
          || { persona_id: k || null, nombre: k ? (nomPersona[k] || '(persona borrada)') : '(sin anotar)', monto: '0', pagos: 0 };
        rc.monto = money.add(rc.monto, r.monto_usdt); rc.pagos += 1;
      }
      return {
        id: mv.id, fecha: String(mv.fecha || mv.createdAt || '').slice(0, 10),
        cliente: cli.nombre || cli.codigo || '(sin cliente)', codigo: cli.codigo || '',
        usdt: sinUsdt ? null : money.round(usdt, 2),
        convertido,
        via: mv.medio || null,
        recibido_por: mv.recibido_por || '', recibido: mv.recibido_por ? (nomPersona[mv.recibido_por] || '(persona borrada)') : '',
        estado: r ? r.estado : 'sin_usdt',
        base: r ? r.reparto.base : null,
        items: r ? r.items.map((it) => ({ persona_id: it.persona_id, nombre: it.nombre, pct: it.pct, monto: it.monto })) : [],
        sin_asignar: r ? r.sin_asignar : '0',
        mezcla_externos: conExternos.has(mv.cliente_id),
      };
    }).sort((a, b) => String(b.fecha).localeCompare(String(a.fecha)));

    const orden = (o) => Object.values(o).sort((a, b) => Number(b.monto) - Number(a.monto));
    ok(res, {
      mes, pagos,
      porPersona: orden(porPersona).map((x) => ({ ...x, monto: money.round(x.monto, 2) })),
      porReceptor: orden(porReceptor).map((x) => ({ ...x, monto: money.round(x.monto, 2) })),
      total_usdt: money.round(total, 2), sin_asignar_usdt: money.round(sinAsignar, 2),
      personas: personas.list().map((p) => ({ id: p.id, nombre: p.nombre, es_empresa: !!p.es_empresa })),
    });
  }));
  app.get('/api/os/reparto/:clienteId', (req, res) => {
    const c = clientes.get(req.params.clienteId);
    if (!c) return err(res, 404, 'cliente no encontrado');
    const mes = req.query.mes ? String(req.query.mes).slice(0, 7) : mesTZ();
    ok(res, { cliente: { id: c.id, codigo: c.codigo, nombre: c.nombre || c.nombreVisible }, mes, reparto: repartoSvc.repartoCliente(c, mes) });
  });
}

module.exports = { mount };
