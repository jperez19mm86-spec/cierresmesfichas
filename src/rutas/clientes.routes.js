/**
 * clientes.routes.js — Clientes y sus cuentas del casino: ficha, paneles, accesos, personas, solicitudes de caja, agentes, importar y pedidos.
 * Sale de os.routes.js (fase 2): las rutas se movieron tal cual y en el mismo orden.
 */
const clientes = require('../clientes-store');
const personas = require('../personas-store');
const paneles = require('../paneles-store');
const movs = require('../movimientos-store');
const historial = require('../historial');
const deudaSvc = require('../deuda.service');
const tcSvc = require('../tc.service');
const casinoConex = require('../casino-conexiones-store');
const reporteDiarioStore = require('../reporte-diario-store');
const pedidosStore = require('../pedidos-store');
const solicitudes = require('../solicitudes-caja');
const deudaCargaSvc = require('../deuda-carga.service');
const acceso = require('../cliente-acceso');
const arbolSvc = require('../arbol.service');
const externosSvc = require('../externos.service');
const tcUnico = require('../tc-unico.service');
const emision = require('../emision.service');
const clientesCascada = require('../clientes-cascada');
const importSheet = require('../import-sheet.service');
const chat = require('../chat-externo.store');
const { db } = require('../db');
const money = require('../lib/money');
const { mesTZ } = require('../lib/fechas'); // fechaTZ/mesTZ=ART (billing) · fechaUTC/mesUTC=UTC (casino)
const { ok, err, wrap, _espejarCaja } = require('./comun');

function mount(app) {
  // ───────── CLIENTES (comercial) ─────────
  app.get('/api/os/clientes', (_req, res) => {
    const list = clientes.list().clientes.map((c) => ({
      id: c.id, codigo: c.codigo, nombre: c.nombre || c.nombreVisible, estado: c.estado,
      telegram: c.telegram, paga_proveedores: c.paga_proveedores, permite_deuda: c.permite_deuda, avisa_pagos: c.avisa_pagos !== false,
      mezcla_pago_usdt: c.mezcla_pago_usdt, ajuste_usdt_pct: c.ajuste_usdt_pct,
      // v3.0 ficha
      divisa_fichas: c.divisa_fichas, moneda_cobro: c.moneda_cobro, momento_pago: c.momento_pago,
      disparador: c.disparador, tc_aplicar: c.tc_aplicar, tc_proveedor: c.tc_proveedor,
      // v3.0 §7-10 (planilla). Si no viajan acá, el modal los renderiza vacíos y al Guardar los pisa con null.
      mover_balance: c.mover_balance, moneda_cuenta: c.moneda_cuenta, margen_externos_pct: c.margen_externos_pct,
      // ⚠️ Si no viaja, la ficha dibuja «la principal» y al Guardar le borra la billetera al cliente.
      billetera_id: c.billetera_id || null,
      es_vendedor: c.es_vendedor, vendedor_id: c.vendedor_id, externos_modo: c.externos_modo, saldo_inicial: c.saldo_inicial,
      factura_a: c.factura_a, externos_precios_de: c.externos_precios_de,
      internos_se_cobran: !!c.internos_se_cobran,
      // ⚠️ Lo mismo: sin estos, Guardar la ficha apagaba el prepago, le sacaba el abono por carga y le
      // volvía a habilitar las dos divisas de pago (auditoría 17-oct). Toda clave que manda saveCli va acá.
      prepago: !!c.prepago, prepago_margen_pct: c.prepago_margen_pct, divisas_pago: c.divisas_pago,
      abona_a: c.abona_a || null, abona_pts: c.abona_pts || null,
      tc_cargas: c.tc_cargas || null, tope_deuda: c.tope_deuda || null,
      saldo_inicial_divisa: c.saldo_inicial_divisa, saldo_inicial_mov_id: c.saldo_inicial_mov_id,
      precio_base_pct: historial.getVigente('cliente', c.id, 'precio_base_pct'),
      paneles: paneles.list({ cliente_id: c.id }).length,
      deuda: deudaSvc.cuentaCorriente(c.id),
    }));
    ok(res, { clientes: list });
  });
  // ALTA de cliente desde el OS (código + nombre). Los campos comerciales se editan luego.
  app.post('/api/os/clientes', wrap((req, res) => {
    const codigo = String((req.body && req.body.codigo) || '').trim();
    const nombre = String((req.body && req.body.nombre) || '').trim();
    if (!codigo) return err(res, 400, 'falta el código del cliente');
    const c = clientesCascada.crear({ codigo, nombre }); // + su columna en la matriz del Cierre
    ok(res, { cliente: c });
  }));
  // BAJA de cliente (cascada: borra sus paneles, % de proveedores, participaciones, config y movimientos).
  app.delete('/api/os/clientes/:id', (req, res) =>
    clientesCascada.borrar(req.params.id) ? ok(res) : err(res, 404, 'cliente no encontrado'));
  // Prender o apagar "avisar pagos" a varios de una. Es lo primero que se necesita: apagarlo para
  // todos y prenderlo solo a los pocos que corresponde.
  app.post('/api/os/clientes/avisa-pagos', wrap((req, res) => {
    const b = req.body || {};
    const valor = !!b.valor;
    const ids = Array.isArray(b.ids) && b.ids.length ? b.ids : clientes.list().clientes.map((c) => c.id);
    let n = 0;
    ids.forEach((id) => { if (clientes.updateComercial(id, { avisa_pagos: valor })) n++; });
    ok(res, { cambiados: n, valor });
  }));
  /**
   * 🔒 NO SE CAMBIA LA MONEDA DE LA CUENTA SI YA HAY MOVIMIENTOS EN LA OTRA.
   *
   * Cambiarla no convierte nada: sólo cambia qué columna se suma. Un cliente con pagos cargados en
   * dólares que pasa a pesos vería su saldo en cero —los movimientos siguen ahí, en la columna que
   * ya no se mira— y eso parece un error de plata, no de configuración. Se corta antes.
   *
   * La salida no es "no se puede nunca": es cargar el ajuste que cierra la cuenta en la moneda
   * vieja, y recién ahí cambiarla. Con la cuenta en cero no hay nada que se pueda perder.
   */
  function puedeCambiarMoneda(cliente_id, nueva) {
    const actual = (clientes.get(cliente_id) || {}).moneda_cuenta === 'ARS' ? 'ARS' : 'USDT';
    const quiere = String(nueva).toUpperCase() === 'ARS' ? 'ARS' : 'USDT';
    if (actual === quiere) return null;
    const col = actual === 'ARS' ? 'monto_ars' : 'monto_usdt';
    const cuantos = movs.list({ cliente_id }).filter((m) => m[col] != null && m[col] !== '' && Number(m[col]) !== 0).length;
    if (!cuantos) return null;
    return `no se puede pasar la cuenta a ${quiere}: este cliente ya tiene ${cuantos} movimiento(s) `
      + `cargados en ${actual}. Cambiar la moneda no los convierte —sólo deja de sumarlos— y el saldo `
      + `quedaría en cero como si se hubiera perdido plata. Cerrá la cuenta en ${actual} con un ajuste y después cambiala.`;
  }
  /**
   * ── LA CUENTA PROPIA DE UN CLIENTE ───────────────────────────────────────────────────────────
   * Prenderla devuelve la clave EN CLARO UNA SOLA VEZ. No hay forma de volver a verla: lo que se
   * guarda es el hash. Si el cliente la pierde, se genera otra — eso es lo que hace que perderla
   * sea un trámite y no una filtración.
   */
  app.get('/api/os/clientes/:id/acceso', (req, res) => {
    const e = acceso.estado(req.params.id);
    return e ? ok(res, { acceso: e }) : err(res, 404, 'no encontré ese cliente');
  });
  app.post('/api/os/clientes/:id/acceso', wrap((req, res) => {
    const b = req.body || {};
    if (b.habilitado === false) return ok(res, { ...acceso.deshabilitar(req.params.id), acceso: acceso.estado(req.params.id) });
    const r = acceso.habilitar(req.params.id, { usuario: b.usuario, clave: b.clave });
    if (!r.ok) return err(res, 400, r.error);
    // La clave viaja UNA vez en esta respuesta. La pantalla la muestra y avisa que no vuelve.
    ok(res, { ...r, acceso: acceso.estado(req.params.id) });
  }));
  app.get('/api/os/accesos', (_req, res) => {
    const conChat = new Set(chat.list().filter((p) => p.activo && p.cliente_id).map((p) => p.cliente_id));
    const filas = clientes.list().clientes.map((c) => {
      const e = acceso.estado(c.id) || {};
      return {
        id: c.id, codigo: c.codigo, nombre: c.nombre || c.nombreVisible || c.codigo,
        estado: c.estado || 'activo',
        entra: e.habilitado ? (e.usuario || c.codigo) : null,
        acceso: !!e.habilitado, desde: e.desde || null,
        // Lo que puede hacer hoy. `avisa_pagos` viene en true cuando nunca se tocó.
        avisa_pagos: c.avisa_pagos !== false,
        mover_balance: !!c.mover_balance,
        chat: conChat.has(c.id),
      };
    });
    ok(res, { clientes: filas });
  });
  /* Dar acceso a varios de una. La clave viaja UNA vez en esta respuesta: se guarda cifrada y no se
     puede volver a mostrar, así que la pantalla la muestra y avisa que no vuelve. */
  app.post('/api/os/accesos/generar', wrap((req, res) => {
    const ids = Array.isArray((req.body || {}).ids) ? req.body.ids : [];
    if (!ids.length) return err(res, 400, 'no marcaste ningún cliente');
    const hechos = []; const fallaron = [];
    for (const id of ids) {
      // Sin usuario: `habilitar` conserva el que ya tenía. Mandarle el código acá le cambiaría el
      // nombre con el que entra a todo el que tuviera uno propio.
      const r = acceso.habilitar(id, {});
      const c = clientes.get(id) || {};
      if (r.ok) hechos.push({ id, cliente: c.nombre || c.codigo, usuario: r.usuario, clave: r.clave });
      else fallaron.push({ id, cliente: c.nombre || c.codigo || id, error: r.error });
    }
    ok(res, { generadas: hechos.length, claves: hechos, fallaron });
  }));
  app.post('/api/os/accesos/quitar', wrap((req, res) => {
    const ids = Array.isArray((req.body || {}).ids) ? req.body.ids : [];
    ids.forEach((id) => acceso.deshabilitar(id));
    ok(res, { quitados: ids.length });
  }));
  /* Qué puede hacer cada uno, para varios a la vez. Sólo estos dos campos: son permisos, y el resto
     de la ficha del cliente son números que no se tocan en masa. */
  app.post('/api/os/accesos/permiso', wrap((req, res) => {
    const b = req.body || {};
    const ids = Array.isArray(b.ids) ? b.ids : [];
    if (!['avisa_pagos', 'mover_balance'].includes(b.campo)) return err(res, 400, 'ese permiso no se toca desde acá');
    const valor = b.valor === true;
    for (const id of ids) {
      const c = clientes.get(id);
      // updateCliente sólo toca código y nombre: los permisos viven en updateComercial. Pasarlos
      // por la otra función los descartaba en silencio y la pantalla mostraba un cambio que no fue.
      if (c) clientes.updateComercial(id, { [b.campo]: valor });
    }
    ok(res, { cambiados: ids.length, campo: b.campo, valor });
  }));
  /* ── PERMISOS POR AGENTE (Mi Caja) ──────────────────────────────────────────────────────────
     Cada caja del cliente es la cuenta de un agente en el casino. Acá se decide qué puede hacer
     cada uno en Mi Caja: pedir fichas, registrar pagos, ver la cuenta. Ver clientes.permisosDe. */
  const agenteVista = (c, k) => {
    const efectivos = clientes.permisosDe(c, k);
    return { id: k.id, usuario: k.usuario, etiqueta: k.etiqueta || '', sistema: k.sistema, userId: k.userId,
      permisos: k.permisos ? { pedir: !!k.permisos.pedir, pagos: !!k.permisos.pagos, cuenta: !!k.permisos.cuenta } : null,
      efectivos, pagosCliente: c.avisa_pagos !== false, rol: k.rol || '', divisas: k.divisas || [],
      ...(k.rol === 'distribuidor' ? { agentesPiden: k.agentesPiden !== false } : {}) };
  };
  app.get('/api/os/clientes/:id/agentes', (req, res) => {
    const c = clientes.get(req.params.id);
    if (!c) return err(res, 404, 'cliente no encontrado');
    ok(res, { agentes: (c.cajas || []).map((k) => agenteVista(c, k)), porDefecto: clientes.PERMISOS_POR_DEFECTO });
  });
  app.put('/api/os/clientes/:id/agentes/:cajaId', wrap((req, res) => {
    const b = req.body || {};
    const conPermisos = !!b.permisos && typeof b.permisos === 'object';
    if (!conPermisos && b.agentesPiden === undefined) return err(res, 400, 'faltan los permisos');
    /* El distribuidor también puede registrar pagos y ver la cuenta (8-oct-2026, pedido del dueño):
       un cliente PREPAGO que no puede avisar su pago nunca tiene saldo para pedir. Se habilita
       acá, cuenta por cuenta, igual que a un agente; «Puede avisar pagos» del cliente sigue siendo
       la llave general. */
    const patch = {};
    if (conPermisos) patch.permisos = b.permisos;
    if (b.agentesPiden !== undefined) {
      const c0 = clientes.get(req.params.id);
      const k0 = c0 && (c0.cajas || []).find((x) => x.id === req.params.cajaId);
      if (k0 && k0.rol !== 'distribuidor') return err(res, 400, '«Sus agentes piden fichas» es sólo para un distribuidor');
      patch.agentesPiden = !!b.agentesPiden;
    }
    const k = clientes.updateCaja(req.params.id, req.params.cajaId, patch);
    if (!k) return err(res, 404, 'no existe esa cuenta en este cliente');
    ok(res, { agente: agenteVista(clientes.get(req.params.id), k) });
  }));
  /* El asistente de alta crea el panel y el espejo le arma la caja, así que no conoce su id: la
     busca por la cuenta del casino (sistema + id). */
  app.put('/api/os/clientes/:id/agentes-por-cuenta', wrap((req, res) => {
    const b = req.body || {};
    const c = clientes.get(req.params.id);
    if (!c) return err(res, 404, 'cliente no encontrado');
    const k = (c.cajas || []).find((x) => String(x.userId) === String(b.userId || '')
      && (!b.sistema || String(x.sistema || '').toLowerCase() === String(b.sistema).toLowerCase()));
    if (!k) return err(res, 404, 'esa cuenta no está en este cliente');
    const nk = clientes.updateCaja(c.id, k.id, { permisos: b.permisos || null });
    ok(res, { agente: agenteVista(clientes.get(c.id), nk) });
  }));
  /* UNA VEZ, el día que se sube: los agentes que ya operaban quedan con lo que podían hacer hasta
     hoy. Sólo toca las cajas sin permisos; correrlo de nuevo no cambia nada. */
  /* ── LA CUENTA DE UN DISTRIBUIDOR ───────────────────────────────────────────────────────────
     Para que el alta de agentes desde Mi Caja sepa a qué cliente sumarlos, la cuenta del
     distribuidor tiene que estar en su cliente. Entra como IDENTIDAD (caja con rol 'distribuidor'),
     no como panel: el consumo de un distribuidor ya incluye el de sus agentes. Antes de guardarla se
     le pregunta al casino que ese login sea ese id en ese sistema: un id tipeado mal sumaría los
     agentes de otro a este cliente. */
  app.post('/api/os/clientes/:id/distribuidores', wrap(async (req, res) => {
    const b = req.body || {};
    const c = clientes.get(req.params.id);
    if (!c) return err(res, 404, 'cliente no encontrado');
    const login = String(b.login || '').trim(); const uid = String(b.userId || '').trim();
    const sistema = String(b.sistema || '').trim();
    const divisa = String(b.divisa || 'ARS').trim().toUpperCase();
    if (!login || !/^\d+$/.test(uid) || !sistema) return err(res, 400, 'faltan el login, el id o el sistema');
    const cx = casinoConex.list463().find((x) => String(x.nombre || '').toLowerCase() === sistema.toLowerCase() && !x.carga_de);
    const cli = cx && casinoConex.client(cx.id);
    if (!cli) return err(res, 400, `no hay conexión de lectura para ${sistema}`);
    const r = await cli.buscar({ login });
    if (!r.ok) return err(res, 502, 'no se pudo preguntar al casino: ' + (r.error || ''));
    const hit = (r.users || []).find((u) => String(u.login).toLowerCase() === login.toLowerCase());
    if (!hit) return err(res, 404, `${login} no existe en ${sistema}`);
    if (String(hit.id) !== uid) return err(res, 409, `en ${sistema}, ${login} es el id ${hit.id}, no ${uid}`);
    const ya = (c.cajas || []).find((k) => String(k.userId) === uid && (k.sistema || '') === sistema);
    const caja = ya
      ? clientes.updateCaja(c.id, ya.id, { rol: 'distribuidor', divisas: [divisa] })
      : clientes.addCaja(c.id, { usuario: hit.login, sistema, userId: uid, divisas: [divisa], rol: 'distribuidor',
        permisos: { pedir: false, pagos: false, cuenta: false } });
    ok(res, { agente: agenteVista(clientes.get(c.id), caja) });
  }));
  app.post('/api/os/agentes/congelar', wrap((_req, res) => {
    ok(res, { congeladas: clientes.congelarPermisosActuales() });
  }));
  app.put('/api/os/accesos/:id/usuario', wrap((req, res) => {
    const u = String((req.body || {}).usuario || '').trim();
    if (!u) return err(res, 400, 'falta el usuario');
    /* Cambiar el usuario le cambia la puerta: la clave que tenía sigue valiendo, pero el nombre con
       el que entra es otro. Se avisa en la pantalla porque hay que volver a decírselo. */
    const r = acceso.habilitar(req.params.id, { usuario: u, clave: (req.body || {}).clave });
    r.ok ? ok(res, r) : err(res, 400, r.error);
  }));
  // El saldo para pedir de un cliente PREPAGO (para la ficha). A los demás: {prepago:false}.
  app.get('/api/os/clientes/:id/prepago', wrap(async (req, res) => {
    const c = clientes.get(req.params.id);
    if (!c) return err(res, 404, 'cliente no encontrado');
    ok(res, { prepago: await require('../prepago.service').estado(c) });
  }));
  app.put('/api/os/clientes/:id/comercial', wrap((req, res) => {
    const antes = clientes.get(req.params.id);
    /* ── QUIÉN PAGA Y DE QUIÉN SON LOS PRECIOS APUNTAN A OTRO CLIENTE ────────────────────────
       Los dos se siguen UNA sola vez, así que un ciclo no cuelga nada; pero apuntar a sí mismo o
       a un id que no existe deja una ficha que dice algo falso y que después hay que descubrir
       mirando por qué un número no cierra. Se frena acá, que es donde se escribe. */
    for (const campo of ['factura_a', 'externos_precios_de', 'abona_a']) {
      const v = (req.body || {})[campo];
      if (v === undefined || v === null || v === '') continue;
      if (String(v) === String(req.params.id)) return err(res, 400, `"${campo}": un cliente no puede apuntarse a sí mismo`);
      if (!clientes.get(String(v))) return err(res, 400, `"${campo}": no existe ese cliente`);
    }
    if ((req.body || {}).moneda_cuenta !== undefined) {
      const mal = puedeCambiarMoneda(req.params.id, req.body.moneda_cuenta);
      if (mal) return err(res, 400, mal);
    }
    const c = clientes.updateComercial(req.params.id, req.body || {});
    if (!c) return err(res, 404, 'cliente no encontrado');
    // Renombrar ARRASTRA su columna de la matriz y su % base por mes: la matriz se referencia por
    // NOMBRE, así que sin esto el cliente pierde todos sus % en silencio.
    clientesCascada.arrastrarRenombre(antes, c);
    ok(res, { cliente: c });
  }));
  /* ── CAMBIAR UN % SIN DECIR DESDE CUÁNDO ES LO QUE ROMPIÓ JULIO ───────────────────────────────
     Una CORRECCIÓN pisa el tramo vigente EN SU LUGAR: el valor viejo desaparece de la línea de
     tiempo, no queda un tramo anterior. Titan estaba al 7 desde el 1-ago; el 11-ago se lo corrigió
     a 5 con la nota «desde agosto 2026» —una nota, que ningún cálculo lee— y el 7 se borró. Julio
     quedó sin ningún tramo que lo cubriera, así que al confirmar los % de julio el repaso propuso
     el 5 de hoy y se le facturó 3.179,64 USDT de más.

     Por eso ahora hay que decir SIEMPRE desde cuándo rige, y son dos cosas distintas:
       · una fecha  → VIGENCIA: de ahí en adelante vale esto, lo de antes queda como estaba
       · 'siempre'  → CORRECCIÓN: estaba mal escrito, vale para todo lo que ese tramo cubre
     No hay default, a propósito: el default es justo la respuesta que nadie piensa.

     Y si la corrección pisa meses que ya tienen el % confirmado, se dice cuáles y se pide
     confirmar: esos meses se facturaron con el valor viejo. */
  app.put('/api/os/clientes/:id/precio-base', wrap((req, res) => {
    const b = req.body || {};
    if (b.valor === undefined) return err(res, 400, 'falta valor');
    const c = clientes.get(req.params.id);
    if (!c) return err(res, 404, 'cliente no encontrado');

    const crudo = String(b.vigente_desde || b.desde || '').trim();
    const siempre = crudo.toLowerCase() === 'siempre' || b.desde_siempre === true;
    if (!siempre && !/^\d{4}-\d{2}(-\d{2})?$/.test(crudo)) {
      return err(res, 400, 'falta decir DESDE CUÁNDO rige este %: una fecha (2026-08 o 2026-08-01) '
        + 'si cambió a partir de ahí, o "siempre" si estaba mal escrito y hay que corregirlo hacia atrás. '
        + 'Sin eso, el valor viejo se borra de la línea de tiempo y los meses anteriores se recalculan mal.');
    }

    if (siempre) {
      // Qué meses ya confirmados quedan con otro piso. Se avisa antes, no después de facturar.
      const pisados = externosSvc.mesesConfirmados(c.nombre)
        .filter((m) => String(m.base_pct) !== String(b.valor));
      if (pisados.length && b.confirmar !== true) {
        return res.status(409).json({ ok: false, requiereConfirmacion: true,
          error: `este cliente tiene ${pisados.length} mes(es) confirmados con otro %: `
            + pisados.map((m) => `${m.mes} al ${m.base_pct}%`).join(', ')
            + '. Corregir hacia atrás los deja distintos de lo que se les facturó. Si el % cambió a '
            + 'partir de una fecha, mandá esa fecha en vez de "siempre".',
          meses: pisados });
      }
    }

    // Mismo motivo que al confirmar el % del mes: con coma se guarda y después vale cero.
    if (!money.esNumero(b.valor)) {
      return err(res, 400, `"${b.valor}" no es un número. Escribilo con punto: 6.5`);
    }
    const vigente_desde = siempre ? null : (crudo.length === 7 ? crudo + '-01' : crudo);
    const v = historial.setValor('cliente', req.params.id, 'precio_base_pct', {
      valor: b.valor, tipo_cambio: siempre ? 'correccion' : 'vigencia', vigente_desde, notas: b.notas });
    ok(res, { precio_base_pct: v, desde: siempre ? 'siempre' : vigente_desde,
      tramos: historial.listValores('cliente', req.params.id, 'precio_base_pct') });
  }));
  app.get('/api/os/clientes/:id/precio-base/historial', (req, res) =>
    ok(res, { historial: historial.listValores('cliente', req.params.id, 'precio_base_pct') }));
  app.get('/api/os/clientes/:id/cuenta', (req, res) => ok(res, { cuenta: deudaSvc.cuentaCorriente(req.params.id) }));
  // PERFIL del cliente: header + historial de % (vigencias) + resumen MES A MES (cargas/fee/pagos/profit reales).
  app.get('/api/os/clientes/:id/perfil', wrap(async (req, res) => {
    const c = clientes.get(req.params.id); if (!c) return err(res, 404, 'cliente no encontrado');
    const nMeses = Math.min(Math.max(Number(req.query.meses) || 6, 1), 12);
    const baseActual = historial.getVigente('cliente', c.id, 'precio_base_pct');
    const histPct = historial.listValores('cliente', c.id, 'precio_base_pct');
    const auditPct = historial.listHistorial({ entidad_tipo: 'cliente', entidad_id: c.id, campo: 'precio_base_pct' });
    const deuda = deudaSvc.cuentaCorriente(c.id);
    const cPaneles = paneles.list({ cliente_id: c.id }).filter((p) => p.conexion_id && p.id_usuario);
    // lista de meses (actual hacia atrás)
    const mesesList = [];
    let [y, m] = mesTZ().split('-').map(Number);
    for (let i = 0; i < nMeses; i++) { mesesList.push(`${y}-${String(m).padStart(2, '0')}`); m--; if (m < 1) { m = 12; y--; } }
    // Cargas/profit del acumulado GUARDADO (no consulta el casino en vivo → instantáneo; el cron lo mantiene al día).
    // Para meses sin backfill aparece 0 — backfillear ese mes en el Acumulado para poblarlo.
    const GRP_DE_NIVEL = { SuperAgente: 'superagent', Distribuidor: 'distributor', Agente: 'agent' };
    const panelKeys = cPaneles.map((p) => ({ conexion_id: p.conexion_id, grp: GRP_DE_NIVEL[p.nivel_usuario] || 'superagent', sa_id: String(p.id_usuario) }));
    const filas = [];
    for (const mes of mesesList) {
      // Antes esto sumaba SOLO pesos argentinos: un cliente con paneles en pesos uruguayos aparecía
      // más chico y no había forma de notarlo. Ahora se suma cada moneda por separado y se pasa a
      // USDT con SU tipo de cambio, que es la única unidad en la que se pueden sumar entre sí.
      const porDivisa = {};
      for (const r of reporteDiarioStore.filasPanelesMes(panelKeys, mes)) {
        const d = String(r.moneda || 'ARS').toUpperCase();
        const o = porDivisa[d] = porDivisa[d] || { divisa: d, cargas: '0', profit: '0' };
        o.cargas = money.add(o.cargas, r.in_amt || '0');
        o.profit = money.add(o.profit, r.profit || '0');
      }
      const baseMes = externosSvc.baseDelMes(c, mes).valor || baseActual || '0';
      let cargas = '0', profit = '0', fee = '0'; const sinTC = [];
      for (const o of Object.values(porDivisa)) {
        const t = tcUnico.tcDelMes(o.divisa, mes);
        o.tc = t.valor; o.tcFuente = t.fuente;
        o.fee = money.pct(o.cargas, baseMes);
        if (!t.valor) { sinTC.push(o.divisa); continue; }   // sin TC no se puede sumar: se informa
        cargas = money.add(cargas, money.div(o.cargas, t.valor));
        profit = money.add(profit, money.div(o.profit, t.valor));
        fee = money.add(fee, money.div(o.fee, t.valor));
        o.cargasUsdt = money.round(money.div(o.cargas, t.valor), 2);
      }
      const pagos = money.sum(movs.list({ cliente_id: c.id, tipo: 'pago', mes }).map((mv) => mv.monto_usdt || '0'));
      filas.push({
        mes, base: baseMes, moneda: 'USDT',
        cargas: money.round(cargas, 2), fee: money.round(fee, 2),
        pagos: money.round(pagos, 2), profit: money.round(profit, 2),
        porDivisa: Object.values(porDivisa), sinTC,
      });
    }
    // Lista de plataformas (superagentes/paneles) del cliente → control de que estén todas.
    const plataformas = paneles.list({ cliente_id: c.id }).map((p) => ({
      id: p.id, nombre: p.nombre || p.usuario || '', usuario: p.usuario || '',
      sistema: p.sistema || '', nivel: p.nivel_usuario || '', id_usuario: p.id_usuario || '',
      conectada: !!(p.conexion_id && p.id_usuario),
    })).sort((a, b) => (a.sistema + a.usuario).localeCompare(b.sistema + b.usuario));
    // ── DE QUÉ ESTÁ HECHA ESA DEUDA ────────────────────────────────────────────────────────
    // El saldo solo no sirve para hablar con el cliente: cuando pregunta "¿por qué debo esto?" hay
    // que poder abrir el renglón. Son los MISMOS movimientos que ve él en su pantalla, con lo que
    // acá hace falta y allá no: la nota, el tipo de cambio y las dos monedas.
    // Vienen valuados del store, así que un pago que espera el TC del mes ya figura con su valor.
    const cuentaMovs = movs.list({ cliente_id: c.id }).slice(0, 100).map((m) => {
      /* CUÁNTAS FICHAS Y A QUÉ CAJA. La nota decía «12% de 10.000.000 ARS» y ahí se terminaba: para
         saber a cuál de sus cajas habían ido esas fichas había que ir a buscar el pedido. Con
         varias cajas —y más si alguna se mudó de cliente— es la primera pregunta que llega. */
      let cargado = null; let caja = null; let cajaEtiqueta = '';
      if (m.pedido_id) {
        try {
          const ped = pedidosStore.get(m.pedido_id);
          if (ped) { cargado = ped.monto; caja = ped.cajaUsuario || null; cajaEtiqueta = ped.cajaEtiqueta || ''; }
        } catch (e) { /* un pedido borrado no puede tapar la cuenta */ }
      }
      return {
        id: m.id, fecha: String(m.fecha || '').slice(0, 10), tipo: m.tipo,
        monto_ars: m.monto_ars, monto_usdt: m.monto_usdt,
        tc: m.tc_momento || m.tc_usado || null, tc_pendiente: m.tc_modo === 'mes' && !!m.provisional,
        divisa: m.divisa, notas: m.notas || '', medio: m.medio || null,
        cargado, caja, caja_etiqueta: cajaEtiqueta,
      };
    });
    ok(res, {
      cliente: { id: c.id, codigo: c.codigo, nombre: c.nombre || c.nombreVisible, estado: c.estado, paneles: cPaneles.length },
      base_actual: baseActual, deuda, historial_pct: histPct, auditoria_pct: auditPct, meses: filas, plataformas,
      movimientos: cuentaMovs,
    });
  }));
  // ───────── PERSONAS ─────────
  app.get('/api/os/personas', (_req, res) => ok(res, { personas: personas.list() }));
  app.post('/api/os/personas', wrap((req, res) => ok(res, { persona: personas.create(req.body || {}) })));
  app.put('/api/os/personas/:id', wrap((req, res) => {
    const p = personas.update(req.params.id, req.body || {}); if (!p) return err(res, 404, 'no encontrada'); ok(res, { persona: p });
  }));
  app.delete('/api/os/personas/:id', (req, res) => personas.remove(req.params.id) ? ok(res) : err(res, 404, 'no encontrada'));
  // ───────── PANELES ─────────
  app.get('/api/os/paneles', (req, res) => {
    /* El nombre para el cliente NO se guarda en el panel: vive en la caja de esa cuenta del casino,
       y el OS lo lee de ahí. Un solo dato, así Fichas y el OS no pueden decir cosas distintas. */
    const etq = new Map();
    clientes.list().clientes.forEach((c) => (c.cajas || []).forEach((k) => {
      const key = `${k.sistema || ''}:${k.userId}`;
      if (k.etiqueta && !etq.get(key)) etq.set(key, k.etiqueta);
    }));
    const list = paneles.list({ cliente_id: req.query.cliente_id }).map((p) => ({
      ...p, precio_base_override: p.usa_config_cliente ? null : historial.getVigente('panel', p.id, 'precio_base_pct'),
      etiqueta: etq.get(`${p.sistema || ''}:${p.id_usuario}`) || '',
    }));
    ok(res, { paneles: list });
  });
  /* ── UN PANEL NUEVO SE RESUELVE SOLO ─────────────────────────────────────────────────────────
     El nivel con el que nace un panel es una ELECCIÓN: en el alta manual sale del desplegable, y al
     aprobar una caja está escrito fijo como 'SuperAgente'. La cascada de carga le cree, y un panel
     marcado SuperAgente carga DIRECTO, sin pasar por sus padres. Si en realidad es un Agente, la
     carga falla — el padre real no tiene saldo — y desde la pantalla no hay forma de darse cuenta:
     el nivel se ve escrito como cualquier otro dato.
     Pasó con GanamosM01: caja creada el 21 de agosto, marcada SuperAgente, siendo Agente. Era el
     único de los 204 paneles sin resolver.

     Va en segundo plano y no bloquea la respuesta: baja el árbol entero de esa conexión (el casino
     no devuelve el padre de un nodo) y tarda cerca de un minuto. Si falla, el panel queda "sin
     resolver" y la pantalla lo muestra así, con su botón para reintentar. */
  /* Vive en arbol.service porque las cajas se crean TAMBIÉN del lado de Fichas, y esa alta
     necesita exactamente esto. Tenerlo acá adentro era la razón por la que aquel camino se quedó
     sin resolver: no se podía llamar desde afuera. */
  const _resolverJerarquia = (panel) => arbolSvc.resolverEnSegundoPlano(panel);
  /* ── SÓLO LOS SUPERAGENTES MANEJAN VARIAS MONEDAS ────────────────────────────────────────────
     Regla de la dueña (5-sep-2026): un distribuidor —y todo lo que cuelga de él— maneja UNA sola,
     la suya. Y si un distribuidor está en USD, sus agentes y cajas también.
     Se frena al guardar y no sólo en la pantalla: una ficha con tres monedas en un distribuidor
     hace que la Foto le pregunte al casino por monedas que ese nodo no puede tener, y que el
     cliente pueda pedir en una que su caja no acepta. */
  function _revisarDivisas(body, actual) {
    const nivel = String((body && body.nivel_usuario) || (actual && actual.nivel_usuario) || '').toLowerCase();
    if (nivel.startsWith('superagente')) return null;
    const d = (body && body.divisas !== undefined) ? body.divisas : (actual && actual.divisas);
    if (!Array.isArray(d) || d.length <= 1) return null;
    return `un ${nivel || 'panel que no es SuperAgente'} maneja UNA sola moneda, y vinieron ${d.length}: `
      + d.join(', ') + '. Sólo los SuperAgentes llevan varias.';
  }
  app.post('/api/os/paneles', wrap((req, res) => {
    const mal = _revisarDivisas(req.body || {}, null);
    if (mal) return err(res, 400, mal);
    const panel = paneles.create(req.body || {});
    _espejarCaja(panel);
    _resolverJerarquia(panel);
    ok(res, { panel });
  }));
  app.put('/api/os/paneles/:id', wrap((req, res) => {
    // El nombre para el cliente se escribe en las cajas de esa cuenta, no en el panel.
    const { etiqueta, ...cambios } = req.body || {};
    /* La regla de una sola moneda se revisa cuando se toca el PANEL. Cambiar sólo el nombre no toca
       nada del panel, y un panel que ya venía con dos monedas no puede dejar sin nombre a su caja. */
    if (Object.keys(cambios).length) {
      const mal = _revisarDivisas(cambios, paneles.get(req.params.id));
      if (mal) return err(res, 400, mal);
    }
    const antes = paneles.get(req.params.id);
    const p = paneles.update(req.params.id, cambios); if (!p) return err(res, 404, 'no encontrado');
    if (etiqueta !== undefined) {
      if (!p.id_usuario) return err(res, 400, 'este panel no está linkeado a una cuenta del casino: no hay caja donde poner el nombre');
      clientes.setEtiquetaCuenta(p.sistema, p.id_usuario, etiqueta);
    }
    // Lo que se cambia acá tiene que llegar a Fichas: es la misma cuenta del casino.
    // Si se movió a otro cliente, la caja se muda con él (no nace otra y queda la vieja).
    const caja = _espejarCaja(p, null, antes && antes.cliente_id);
    ok(res, { panel: p, caja: caja === 'actualizada' || caja === 'movida' ? caja : (caja ? 'creada' : 'sin cambios') });
  }));
  // Qué monedas MUEVE cada panel de verdad, contra las que tiene guardadas.
  app.get('/api/os/paneles/divisas', (req, res) => {
    const filas = paneles.divisasUsadas(Number(req.query.meses) || 6);
    ok(res, {
      paneles: filas,
      conSobrante: filas.filter((f) => f.sobran.length).length,
      conFaltante: filas.filter((f) => f.faltan.length).length,
      sinDatos: filas.filter((f) => f.sinDatos).length,
    });
  });
  /**
   * ── EL CRUCE DE VERDAD: LO QUE EL CASINO TIENE HABILITADO ─────────────────────────────────────
   *
   * /paneles/divisas compara lo guardado contra lo que el panel MOVIÓ. Eso sólo detecta las que
   * sobran, y de las que faltan no sabe nada. Este cruce trae la tercera lista —la que el casino
   * tiene HABILITADA— leyendo la pantalla de divisas de cada nodo. Con las tres se puede decir:
   *
   *   habilitada + movida + guardada  → está bien
   *   habilitada + movida + NO guardada → FALTA, y es la peor: mueve plata y el OS no la lista
   *   habilitada + no movida + guardada → sobra, se puede sacar
   *   NO habilitada + guardada          → sobra seguro, el casino ni siquiera la acepta
   *
   * Va TROCEADO (desde/limite) porque es un pedido HTTP por panel y son 200: de una sola vez se
   * come los 5 minutos que aguanta el proxy de Railway y se corta a la mitad sin decir dónde quedó.
   *
   * SÓLO LEE. La pantalla que consulta también guarda —tiene un form por divisa con los proveedores
   * y su botón Guardar—, así que divisasDeNodo hace GET y nada más. Ver el comentario allá.
   */
  app.post('/api/os/paneles/divisas/casino', wrap(async (req, res) => {
    const b = req.body || {};
    const desde = Number(b.desde) || 0;
    const limite = Number(b.limite) || 25;
    let lista = paneles.list().filter((p) => p.conexion_id && p.id_usuario);
    if (b.conexion_id) lista = lista.filter((p) => p.conexion_id === b.conexion_id);
    if (b.panel_id) lista = lista.filter((p) => p.id === b.panel_id);
    lista.sort((a, z) => String(a.nombre || '').localeCompare(String(z.nombre || ''), 'es', { sensitivity: 'base' }));
    const total = lista.length;
    const tanda = lista.slice(desde, desde + limite);
    const usadasPorPanel = {};
    paneles.divisasUsadas(Number(b.meses) || 6).forEach((x) => { usadasPorPanel[x.panel_id] = x.usadas || []; });

    const porConexion = {};
    const filas = [];
    for (const p of tanda) {
      // client() elige el módulo según el motor. Una conexión de TBS devuelve el cliente de TBS,
      // que no tiene esta pantalla — de ahí el chequeo de la función y no sólo del cliente.
      if (porConexion[p.conexion_id] === undefined) porConexion[p.conexion_id] = casinoConex.client(p.conexion_id);
      const cli = porConexion[p.conexion_id];
      if (!cli) { filas.push({ panel_id: p.id, nombre: p.nombre, error: 'sin conexión configurada' }); continue; }
      if (typeof cli.divisasDeNodo !== 'function') {
        filas.push({ panel_id: p.id, nombre: p.nombre, error: 'esa conexión no es del motor Imperia' }); continue;
      }
      const r = await cli.divisasDeNodo(p.id_usuario);
      if (!r.ok) { filas.push({ panel_id: p.id, nombre: p.nombre, error: r.error, pista: r.pista || null }); continue; }
      const guardadas = (p.divisas || []).map((x) => String(x).toUpperCase());
      const usadas = usadasPorPanel[p.id] || [];

      // ── REGLA DEL DUEÑO: SÓLO UN SUPERAGENTE PUEDE TENER VARIAS DIVISAS ────────────────────
      // Un distribuidor tiene una y nada más. Al leer los 201 paneles la regla se cumplió sola
      // —los 65 distribuidores trajeron exactamente 1—, así que acá no corrige nada: vigila.
      // Si algún día un distribuidor vuelve con dos, el que está mal es alguno de los dos lados,
      // y escribirlo callado taparía justo eso. Se avisa y no se toca.
      const esSuper = /superagente/i.test(String(p.nivel_usuario || ''));
      const rompeRegla = !esSuper && r.divisas.length > 1;

      let aplicado = null;
      if (b.aplicar && !rompeRegla && r.divisas.length
          && r.divisas.join(',') !== guardadas.slice().sort().join(',')) {
        paneles.update(p.id, { divisas: r.divisas });
        aplicado = { antes: guardadas, ahora: r.divisas };
      }
      filas.push({
        aplicado, rompeRegla, nivel: p.nivel_usuario || '',
        panel_id: p.id, nombre: p.nombre, nodo: p.id_usuario,
        habilitadas: r.divisas, guardadas, usadas,
        // faltan primero: es lo único de acá que puede estar costando plata
        faltan: r.divisas.filter((d) => !guardadas.includes(d)),
        faltanYMueven: r.divisas.filter((d) => !guardadas.includes(d) && usadas.includes(d)),
        sobran: guardadas.filter((d) => !r.divisas.includes(d)),
        sinUsar: guardadas.filter((d) => r.divisas.includes(d) && usadas.length && !usadas.includes(d)),
      });
    }
    ok(res, { total, desde, devueltos: tanda.length, hay_mas: desde + tanda.length < total, paneles: filas });
  }));
  /**
   * ── LOS SUPERAGENTES, PARA ELEGIR DE CUÁLES SE SACAN LOS DISTRIBUIDORES ───────────────────────
   *
   * De los distribuidores el dueño necesita muy pocos, pero la Foto los sacaba todos. Acá se lista
   * cada superagente con los distribuidores que le cuelgan, para marcar de a grupos en vez de
   * panel por panel.
   *
   * El vínculo sale de `sa_id`/`padre_id`, que los resuelve arbol.service contra el árbol del
   * casino. 2 de los 68 no cuelgan de ningún superagente cargado en el OS: van aparte y NO se
   * esconden — si quedaran fuera de la lista no habría forma de marcarlos, y "no lo veo" se
   * volvería "no lo saco" sin que nadie lo haya decidido.
   */
  app.get('/api/os/paneles/foto-distribuidores', (_req, res) => {
    const todos = paneles.list();
    const porNodo = new Map();
    todos.forEach((p) => { if (p.id_usuario) porNodo.set(String(p.id_usuario), p); });
    const esSuper = (p) => /superagente/i.test(String(p.nivel_usuario || ''));
    const hijosDe = new Map();
    const sueltos = [];
    todos.filter((p) => !esSuper(p) && p.id_usuario).forEach((p) => {
      const sa = porNodo.get(String(p.sa_id || '')) || porNodo.get(String(p.padre_id || ''));
      if (sa && sa.id !== p.id) {
        if (!hijosDe.has(sa.id)) hijosDe.set(sa.id, []);
        hijosDe.get(sa.id).push({ id: p.id, nombre: p.nombre, nivel: p.nivel_usuario, en_foto: p.en_foto !== false });
      } else sueltos.push({ id: p.id, nombre: p.nombre, nivel: p.nivel_usuario, en_foto: p.en_foto !== false,
        conexion_id: p.conexion_id });
    });
    const conexiones = casinoConex.list463().map((cx) => ({
      id: cx.id, nombre: cx.nombre,
      superagentes: todos.filter((p) => esSuper(p) && p.conexion_id === cx.id && p.id_usuario)
        .map((p) => ({ id: p.id, nombre: p.nombre, nodo: p.id_usuario, en_foto: p.en_foto !== false,
          hijos: (hijosDe.get(p.id) || []).sort((a, b) => a.nombre.localeCompare(b.nombre, 'es', { sensitivity: 'base' })) }))
        .sort((a, b) => a.nombre.localeCompare(b.nombre, 'es', { sensitivity: 'base' })),
      sueltos: sueltos.filter((x) => x.conexion_id === cx.id),
    }));
    ok(res, { conexiones });
  });
  /** Marca o desmarca de una todos los distribuidores que cuelgan de un superagente. */
  app.post('/api/os/paneles/foto-distribuidores', wrap((req, res) => {
    const b = req.body || {};
    const ids = Array.isArray(b.panel_ids) ? b.panel_ids : (b.panel_id ? [b.panel_id] : []);
    const val = !!b.en_foto;
    const hechos = ids.filter((id) => paneles.get(id)).map((id) => {
      paneles.update(id, { en_foto: val });
      return paneles.get(id).nombre;
    });
    ok(res, { cambiados: hechos.length, paneles: hechos, en_foto: val });
  }));
  /**
   * ── LOS PANELES QUE NADIE PUEDE PEDIR ────────────────────────────────────────────────────────
   *
   * Un panel del OS y una caja del operativo son la MISMA cuenta del casino guardada dos veces: las
   * dos tienen usuario, sistema y id de nodo. La diferencia es para qué se usan — el panel factura,
   * la caja recibe fichas — y por eso están separadas.
   *
   * El problema es que se desincronizan sin avisar: hoy hay 68 paneles sin caja, o sea 68 cuentas
   * a las que ningún cliente puede pedirle fichas aunque el OS las tenga cargadas y facturadas.
   * Los vendedores son los peores: Carlos tiene 11 paneles y 2 cajas.
   *
   * Desde hace un tiempo crear o editar un panel ESPEJA la caja solo (_espejarCaja). Los 68 que
   * faltan son de antes de eso, o entraron por la importación, que no pasa por ahí. Esto es el
   * repaso hacia atrás.
   *
   * Listar sólo INFORMA. Crear la caja es decidir que a esa cuenta se le pueden mandar fichas, y eso
   * no lo adivina un endpoint: se pide panel por panel.
   */
  app.get('/api/os/cajas-faltantes', (_req, res) => {
    const todosPan = paneles.list().filter((p) => p.id_usuario);
    const out = [];
    clientes.list().clientes.forEach((c) => {
      const mios = todosPan.filter((p) => p.cliente_id === c.id);
      if (!mios.length) return;
      // MISMA identidad que usa _espejarCaja: nodo + sistema. Comparar sólo por nodo daría por
      // cubierto un panel de Europa porque existe una caja con ese mismo id en Casino.
      const clave = (sis, uid) => `${sis || ''}|${uid}`;
      const conCaja = new Set((c.cajas || []).map((k) => clave(k.sistema, String(k.userId))));
      const faltan = mios.filter((p) => !conCaja.has(clave(p.sistema, String(p.id_usuario))));
      const nodos = new Set(mios.map((p) => clave(p.sistema, String(p.id_usuario))));
      const huerfanas = (c.cajas || []).filter((k) => !nodos.has(clave(k.sistema, String(k.userId))));
      if (faltan.length || huerfanas.length) {
        out.push({ cliente_id: c.id, cliente: c.nombre, es_vendedor: !!c.es_vendedor,
          faltan: faltan.map((p) => ({ panel_id: p.id, nombre: p.nombre, sistema: p.sistema,
            userId: String(p.id_usuario), divisas: p.divisas || [] })),
          huerfanas: huerfanas.map((k) => ({ id: k.id, usuario: k.usuario, sistema: k.sistema, userId: k.userId })) });
      }
    });
    out.sort((a, b) => b.faltan.length - a.faltan.length);
    ok(res, { clientes: out,
      totalFaltan: out.reduce((a, x) => a + x.faltan.length, 0),
      totalHuerfanas: out.reduce((a, x) => a + x.huerfanas.length, 0) });
  });
  /** Crea las cajas que falten. Se pide panel por panel: crear todas de una es una decisión grande. */
  app.post('/api/os/cajas-faltantes', wrap((req, res) => {
    // Se acepta [{panel_id, cliente_id}] o la forma corta [id]: el destino por defecto es el dueño.
    const crudo = (req.body && (req.body.crear || req.body.panel_ids)) || [];
    const items = (Array.isArray(crudo) ? crudo : []).map((x) => (typeof x === 'string'
      ? { panel_id: x, cliente_id: null } : { panel_id: x.panel_id, cliente_id: x.cliente_id || null }));
    if (!items.length) return err(res, 400, 'no viene ningún panel');
    const hechas = []; const saltadas = [];
    items.forEach(({ panel_id: pid, cliente_id: destinoId }) => {
      const p = paneles.get(pid);
      if (!p || !p.id_usuario) { saltadas.push({ panel_id: pid, motivo: 'no existe o no está linkeado' }); return; }
      const c = clientes.get(destinoId || p.cliente_id);
      if (!c) { saltadas.push({ panel_id: pid, motivo: 'el cliente destino no existe' }); return; }
      // Se reusa _espejarCaja, la misma que corre al crear o editar un panel: es idempotente por
      // (nodo, sistema). Escribir la caja acá a mano abriría la puerta a que las dos formas de
      // crearla queden distintas — y una caja mal armada manda fichas al lugar equivocado.
      if (!_espejarCaja(p, c.id)) { saltadas.push({ panel_id: pid, motivo: 'ya tiene caja' }); return; }
      hechas.push({ cliente: c.nombre, caja: p.nombre, sistema: p.sistema, userId: String(p.id_usuario),
        aOtroCliente: c.id !== p.cliente_id });
    });
    ok(res, { creadas: hechas.length, hechas, saltadas });
  }));
  /**
   * ── TRAER LOS PEDIDOS DEL SISTEMA EN LÍNEA ───────────────────────────────────────────────────
   *
   * Para mudar app.latamgames.online acá sin perder nada. Se le pasa el array de pedidos que
   * devuelve /api/_backup del otro lado y los mete acá.
   *
   * ⚠️ NO USAR /api/_restore PARA ESTO. Ese endpoint pisa clientes y sistemas enteros: se llevaría
   * puesto todo el trabajo del OS y de TBS. Acá sólo entran pedidos.
   *
   * ⚠️ Y NO MANDES EL BACKUP COMPLETO A NINGÚN LADO: incluye las contraseñas del casino EN CLARO.
   * De todo ese dump acá sólo hace falta `pedidos`.
   *
   * ── CÓMO SE ENGANCHA CADA PEDIDO ─────────────────────────────────────────────────────────────
   *
   * Los dos padrones NO comparten códigos: allá un pedido viene con "M526" y acá el cliente se
   * llama "Marcelo". Por eso se busca en este orden:
   *   1. el NODO del casino (sistema + userId) — el mismo dato en los dos lados, y el más confiable
   *   2. el mapeo ventas_mapeo, que se armó justamente cruzando por el nodo
   *   3. el código, sólo si coincide exacto
   * Lo que no engancha por ninguna se informa y NO se importa. Un pedido colgado del cliente
   * equivocado le carga fichas a otro.
   */
  app.post('/api/os/importar-pedidos', wrap((req, res) => {
    const entrada = (req.body && (req.body.pedidos || (req.body.dump && req.body.dump.pedidos))) || [];
    const lista = Array.isArray(entrada) ? entrada : (entrada.pedidos || []);
    if (!Array.isArray(lista) || !lista.length) return err(res, 400, 'no vino ningún pedido');
    const soloProbar = req.body.probar !== false && req.body.aplicar !== true;

    const todos = clientes.list().clientes;
    const porNodo = new Map();
    todos.forEach((c) => (c.cajas || []).forEach((k) => {
      porNodo.set(`${(k.sistema || '').toLowerCase()}|${k.userId}`, { cliente: c, caja: k });
    }));
    const porCodigo = new Map(todos.map((c) => [String(c.codigo || '').toUpperCase(), c]));
    const mapeo = new Map(db.prepare('SELECT codigo, cliente_id FROM ventas_mapeo').all()
      .map((r) => [String(r.codigo).toUpperCase(), r.cliente_id]));
    const yaEstan = new Set(pedidosStore.list().map((x) => x.id));

    const enganchados = []; const sinCliente = []; const repetidos = [];
    lista.forEach((p) => {
      if (p.id && yaEstan.has(p.id)) { repetidos.push(p.id); return; }
      const clave = `${String(p.sistema || '').toLowerCase()}|${String(p.userId || '')}`;
      let via = null; let cliente = null; let caja = null;
      const porN = porNodo.get(clave);
      if (porN) { cliente = porN.cliente; caja = porN.caja; via = 'nodo del casino'; }
      if (!cliente && p.codigo && mapeo.has(String(p.codigo).toUpperCase())) {
        cliente = todos.find((c) => c.id === mapeo.get(String(p.codigo).toUpperCase())) || null;
        if (cliente) via = 'mapeo del sistema en línea';
      }
      if (!cliente && p.codigo && porCodigo.has(String(p.codigo).toUpperCase())) {
        cliente = porCodigo.get(String(p.codigo).toUpperCase()); via = 'código igual';
      }
      if (!cliente) {
        sinCliente.push({ id: p.id, codigo: p.codigo, cliente: p.clienteNombre,
          sistema: p.sistema, userId: p.userId, monto: p.monto, estado: p.estado });
        return;
      }
      enganchados.push({ p, cliente, caja, via });
    });

    if (soloProbar) {
      const porEstado = {};
      enganchados.forEach((x) => { porEstado[x.p.estado || '?'] = (porEstado[x.p.estado || '?'] || 0) + 1; });
      const porVia = {};
      enganchados.forEach((x) => { porVia[x.via] = (porVia[x.via] || 0) + 1; });
      return ok(res, { probar: true, entraron: enganchados.length, porEstado, porVia,
        yaEstaban: repetidos.length, sinCliente,
        ejemplos: enganchados.slice(0, 5).map((x) => ({ codigo: x.p.codigo, va_a: x.cliente.nombre,
          caja: x.caja ? x.caja.usuario : '(sin caja: se guarda igual con el nodo)', via: x.via })) });
    }

    // Se conserva el id, el estado y las fechas del original: si se les pusiera uno nuevo, un mes
    // ya cerrado del otro lado volvería a figurar como recién hecho.
    let creados = 0;
    enganchados.forEach(({ p, cliente, caja }) => {
      pedidosStore.importar({ ...p, codigo: cliente.codigo, clienteNombre: cliente.nombreVisible || cliente.nombre,
        cajaId: caja ? caja.id : (p.cajaId || ''), cajaUsuario: caja ? caja.usuario : p.cajaUsuario });
      creados += 1;
    });
    ok(res, { importados: creados, yaEstaban: repetidos.length, sinCliente });
  }));
  /**
   * ── SOLICITUDES PARA ABRIR UNA CAJA ──────────────────────────────────────────────────────────
   * Las crea quien despacha; las aprueba el dueño. Ver src/solicitudes-caja.js para el porqué.
   */
  app.get('/api/os/solicitudes-caja', (req, res) => {
    const filas = solicitudes.list(req.query.estado ? { estado: req.query.estado } : {});
    const porId = {}; clientes.list().clientes.forEach((c) => { porId[c.id] = c; });
    ok(res, { solicitudes: filas.map((s) => ({ ...s, cliente: (porId[s.cliente_id] || {}).nombre || '(borrado)' })),
      pendientes: solicitudes.pendientes() });
  });
  /**
   * Aprobar: se verifica el nodo CONTRA EL CASINO antes de crear nada.
   *
   * Eso hace dos cosas de una: confirma que la cuenta existe —un id mal tipeado se descubre acá y
   * no el día que una carga falla— y trae las divisas que tiene habilitadas, que es mejor que
   * pedírselas a quien llena el formulario.
   *
   * Se crea el PANEL. La caja sale sola por _espejarCaja: crear sólo la caja dejaría una cuenta que
   * recibe fichas y no se le factura a nadie.
   */
  app.post('/api/os/solicitudes-caja/:id/aprobar', wrap(async (req, res) => {
    const s = solicitudes.get(req.params.id);
    if (!s) return err(res, 404, 'no encontré esa solicitud');
    if (s.estado !== 'pendiente') return err(res, 400, `esa solicitud ya está "${s.estado}"`);
    const cli = clientes.get(s.cliente_id);
    if (!cli) return err(res, 400, 'el cliente de la solicitud ya no existe');

    // ¿ese nodo ya está en el OS? Dos paneles al mismo nodo se facturarían dos veces.
    const repe = paneles.list().find((p) => String(p.id_usuario) === String(s.nodo)
      && String(p.sistema || '').toLowerCase() === String(s.sistema).toLowerCase());
    if (repe) {
      solicitudes.resolver(s.id, { estado: 'rechazada', motivo: `el nodo ya es el panel "${repe.nombre}"` });
      return err(res, 400, `Ese nodo ya está cargado como el panel "${repe.nombre}".`);
    }

    // la conexión de LECTURA de ese sistema: es la que sabe qué divisas tiene el nodo
    const cx = casinoConex.list463().find((c) => String(c.nombre).toLowerCase() === String(s.sistema).toLowerCase());
    let divisas = [];
    let aviso = null;
    if (cx) {
      const cli463 = casinoConex.client(cx.id);
      const r = cli463 && cli463.divisasDeNodo ? await cli463.divisasDeNodo(s.nodo) : { ok: false, error: 'la conexión no responde' };
      if (r.ok) divisas = r.divisas;
      else if (!req.body || !req.body.igual) {
        // No se crea a ciegas: si el casino no confirma el nodo, puede no existir. Se puede forzar
        // con `igual: true`, pero que sea una decisión y no un descuido.
        return err(res, 400, `El casino no confirmó el nodo ${s.nodo}: ${r.error}. `
          + 'Revisá el id, o aprobá igual si sabés que está bien.', { requiereForzar: true });
      } else aviso = `no se pudieron leer las divisas (${r.error}); se creó con ARS`;
    } else aviso = `no hay una conexión llamada "${s.sistema}" para verificar; se creó con ARS`;

    /* 'SuperAgente' es sólo el valor con el que NACE: el de verdad lo resuelve el casino un
       segundo después (_resolverJerarquia). Antes se quedaba con éste para siempre, y la carga en
       cascada le creía. */
    const panel = paneles.create({ cliente_id: cli.id, nombre: s.login, sistema: s.sistema,
      nivel_usuario: 'SuperAgente', id_usuario: String(s.nodo),
      divisas: divisas.length ? divisas : ['ARS'], conexion_id: cx ? cx.id : null });
    _espejarCaja(panel);
    _resolverJerarquia(panel);
    solicitudes.resolver(s.id, { estado: 'aprobada', panel_id: panel.id,
      motivo: `panel y caja creados para ${cli.nombre}` });
    ok(res, { panel, divisas, aviso });
  }));
  app.post('/api/os/solicitudes-caja/:id/rechazar', wrap((req, res) => {
    const s = solicitudes.get(req.params.id);
    if (!s) return err(res, 404, 'no encontré esa solicitud');
    if (s.estado !== 'pendiente') return err(res, 400, `esa solicitud ya está "${s.estado}"`);
    ok(res, { solicitud: solicitudes.resolver(s.id, { estado: 'rechazada',
      motivo: String((req.body || {}).motivo || '').trim() || 'sin motivo' }) });
  }));
  // Dejar en un panel SOLO las monedas que usa. Es una decisión, así que se pide explícita.
  app.post('/api/os/paneles/divisas/ajustar', wrap((req, res) => {
    const b = req.body || {};
    const filas = paneles.divisasUsadas(Number(b.meses) || 6)
      .filter((f) => (b.panel_id ? f.panel_id === b.panel_id : f.sobran.length) && f.usadas.length);
    const hechos = filas.map((f) => {
      paneles.update(f.panel_id, { divisas: f.usadas });
      return { panel: f.nombre, antes: f.guardadas, ahora: f.usadas };
    });
    ok(res, { ajustados: hechos.length, hechos });
  }));
  app.delete('/api/os/paneles/:id', (req, res) => {
    const p = paneles.get(req.params.id);
    const borrado = paneles.remove(req.params.id);
    if (borrado && p && p.cliente_id && p.id_usuario) { // remover la caja espejo
      const c = clientes.get(p.cliente_id);
      const k = c && (c.cajas || []).find((x) => String(x.userId) === String(p.id_usuario) && (x.sistema || '') === (p.sistema || ''));
      if (k) clientes.removeCaja(p.cliente_id, k.id);
    }
    borrado ? ok(res) : err(res, 404, 'no encontrado');
  });
  // Sincroniza TODOS los paneles del OS → cajas operativas (one-shot; puebla lo ya cargado). Idempotente.
  /* Pasa TODOS los paneles a Fichas: crea las que faltan y corrige las que quedaron con otras
     divisas. Con `dry:true` sólo cuenta, sin escribir — 69 paneles estaban distintos. */
  app.post('/api/os/paneles/sync-cajas', wrap((req, res) => {
    const dry = !!(req.body && req.body.dry);
    let creadas = 0, actualizadas = 0, ya = 0; const detalle = [];
    for (const c of clientes.list().clientes) {
      for (const p of paneles.list({ cliente_id: c.id })) {
        if (!p.id_usuario) continue;
        if (dry) {
          const k = (c.cajas || []).find((x) => String(x.userId) === String(p.id_usuario) && (x.sistema || '') === (p.sistema || ''));
          if (!k) { creadas++; detalle.push({ panel: p.nombre, que: 'falta la caja' }); continue; }
          const mismas = (k.divisas || []).slice().sort().join(',') === (p.divisas || []).slice().sort().join(',');
          if (!mismas) { actualizadas++; detalle.push({ panel: p.nombre, que: 'divisas distintas',
            os: p.divisas, fichas: k.divisas }); } else ya++;
          continue;
        }
        const r = _espejarCaja(p);
        if (r === 'actualizada') actualizadas++; else if (r) creadas++; else ya++;
      }
    }
    ok(res, { dry, creadas, actualizadas, ya, detalle: detalle.slice(0, 100) });
  }));
  /* ── COMPLETAR EL USUARIO DE LOS PANELES (fase 1, paso 4a, 22-oct-2026) ─────────────────────────
     Los paneles que se crearon desde el árbol del casino guardaron el login sólo en `nombre` y
     dejaron `usuario` vacío. Todo el que necesita el login lee «usuario, y si no, nombre», así que
     llenarlo con el nombre no cambia ninguna carga ni ninguna cuenta; lo que cambia es que caja y
     panel dicen lo mismo en los dos campos. Simula por defecto; con {aplicar:true} escribe, y sólo
     toca los que siguen vacíos. */
  app.post('/api/os/paneles/completar-usuario', wrap((req, res) => {
    const aplicar = !!(req.body && req.body.aplicar);
    const faltan = paneles.list().filter((p) => p.id_usuario && !String(p.usuario || '').trim() && String(p.nombre || '').trim());
    const lista = faltan.map((p) => ({ panel_id: p.id, cliente_id: p.cliente_id, sistema: p.sistema, id_usuario: p.id_usuario, usuario: p.nombre }));
    let escritos = 0;
    if (aplicar) {
      const up = db.prepare("UPDATE paneles SET usuario=? WHERE id=? AND (usuario IS NULL OR trim(usuario)='')");
      db.transaction(() => { for (const x of lista) escritos += up.run(String(x.usuario).trim(), x.panel_id).changes; })();
    }
    ok(res, { aplicar, paneles: lista.length, escritos, lista });
  }));
  app.put('/api/os/paneles/:id/precio-base', wrap((req, res) => {
    const { valor, tipo_cambio, vigente_desde, notas } = req.body || {};
    const v = historial.setValor('panel', req.params.id, 'precio_base_pct', { valor, tipo_cambio, vigente_desde, notas });
    ok(res, { precio_base_pct: v });
  }));
  // ───────── IMPORTAR LA PLANILLA "BASE DE DATOS CLIENTES" (v3.0) ─────────
  // Flujo obligado: previsualizar → revisar → aplicar con el hash de esa previsualización.
  // Nada se escribe sin haber mirado antes qué cambia, y siempre queda el snapshot para deshacer.
  app.get('/api/os/import/snapshot', (_req, res) => ok(res, { snapshot: importSheet.snapshot() }));
  app.post('/api/os/import/sheet', wrap(async (req, res) => {
    const { sheetId, dryRun, confirmHash, incluirBasePct, incluirTelegram } = req.body || {};
    const opts = { sheetId: sheetId || importSheet.SHEET_ID_DEFAULT, incluirBasePct: !!incluirBasePct, incluirTelegram: !!incluirTelegram };
    if (dryRun !== false) return ok(res, { plan: await importSheet.planificar(opts) });
    const r = await importSheet.aplicar({ ...opts, confirmHash, historial });
    ok(res, { resultado: r });
  }));
  app.post('/api/os/import/rollback', wrap((req, res) => {
    const { snapshot, force } = req.body || {};
    if (!force) return err(res, 400, 'para deshacer hay que mandar force:true');
    ok(res, { restaurado: importSheet.restaurar(snapshot) });
  }));
  // SALDO ANTERIOR (v3.0): la deuda que el cliente ya traía antes de que el sistema empiece a
  // facturar. La cuenta corriente se arma SOLO con movimientos (deuda.service.js), así que la
  // columna `saldo_inicial` por sí sola no suma nada: hay que materializarla como un movimiento
  // de tipo 'ajuste'. Guardamos su id para poder REEMPLAZARLO (no duplicarlo) si se re-aplica.
  app.post('/api/os/clientes/:id/saldo-inicial', wrap(async (req, res) => {
    const cli = clientes.get(req.params.id); if (!cli) return err(res, 404, 'cliente no encontrado');
    const { monto, divisa, tc } = req.body || {};
    const div = String(divisa || '').toUpperCase();
    if (!money.isPos(monto)) return err(res, 400, 'monto inválido');
    if (!div) return err(res, 400, 'falta la divisa del saldo anterior');

    let tcUsado = null, montoUsdt;
    if (div === 'USDT') {
      montoUsdt = money.round(monto, 6); // ya está en USDT: no se convierte
    } else {
      tcUsado = tc;
      if (!tcUsado) { const t = await tcSvc.tcAhora(); tcUsado = t.tc; }
      if (!money.isPos(tcUsado)) return err(res, 400, 'no hay TC disponible para convertir a USDT (pasá tc)');
      montoUsdt = money.round(money.div(monto, tcUsado), 6);
    }

    // Idempotente: si ya había un saldo anterior aplicado, se borra ese movimiento y se crea el nuevo.
    if (cli.saldo_inicial_mov_id) movs.remove(cli.saldo_inicial_mov_id);
    // ── LA ETIQUETA DICE HASTA CUÁNDO ──────────────────────────────────────────────────────
    // "saldo anterior (deuda previa al sistema)" le habla al que armó el sistema, no al cliente:
    // él no sabe ni le importa cuándo empezamos a usar esto. Lo que necesita saber es de qué
    // período es esa deuda, y con eso ya no pregunta. Sale del mes del propio movimiento, así que
    // se escribe solo y no hay un texto fijo que se quede viejo el mes que viene.
    const hoy = (req.body && req.body.fecha) ? String(req.body.fecha) : new Date().toISOString();
    const [aa, mm] = hoy.slice(0, 7).split('-');
    const etiqueta = `deuda antes de ${mm}/${aa.slice(2)}`;
    const movimiento = movs.create({
      cliente_id: cli.id, tipo: 'ajuste', monto_ars: div === 'ARS' ? monto : null, monto_usdt: montoUsdt,
      tc_momento: tcUsado, divisa: div, notas: etiqueta,
    });
    clientes.updateComercial(cli.id, { saldo_inicial: String(monto), saldo_inicial_divisa: div, saldo_inicial_mov_id: movimiento.id });
    ok(res, { movimiento_id: movimiento.id, monto_usdt: montoUsdt, tc: tcUsado, deuda: deudaSvc.cuentaCorriente(cli.id) });
  }));
  // La escala de UN panel: por dónde pasan las fichas, de arriba hacia abajo.
  app.get('/api/os/paneles/:id/escala', (req, res) => {
    const p = paneles.get(req.params.id);
    if (!p) return err(res, 404, 'panel no encontrado');
    const pasos = [...(p.escala || []), { id: String(p.id_usuario), login: p.usuario || p.nombre, nivel: p.nivel_usuario, destino: true }];
    ok(res, {
      panel: { id: p.id, nombre: p.nombre, sistema: p.sistema, id_usuario: String(p.id_usuario), nivel: p.nivel_usuario },
      resueltoEn: p.arbol_at || null,
      superagente: p.sa_id ? { id: p.sa_id, login: p.sa_login } : null,
      padre: p.padre_id ? { id: p.padre_id, login: p.padre_login, nivel: p.padre_nivel } : null,
      pasos,                       // el recorrido completo, el último es el panel destino
      saltos: pasos.length - 1,    // cuántas transferencias hay que hacer
    });
  });
  // ───────── PANEL ↔ CASINO (stats reales por nodo linkeado) ─────────
  app.get('/api/os/paneles/:id/casino', wrap(async (req, res) => {
    const p = paneles.get(req.params.id); if (!p) return err(res, 404, 'panel no encontrado');
    if (!p.conexion_id || !p.id_usuario) return err(res, 400, 'el panel no está linkeado a un nodo del casino');
    const cli = casinoConex.client(p.conexion_id); if (!cli) return err(res, 404, 'conexión no encontrada');
    const r = await cli.totalNodo({ nodeId: p.id_usuario, from: req.query.from, to: req.query.to });
    r.ok ? ok(res, { nodo: r.nodo }) : err(res, 502, r.error);
  }));
  // Borrar un pedido: para sacar los sembrados de prueba o los creados por error.
  // ⚠️ Los pedidos son la base de lo que se cobra, así que borrar uno CAMBIA la facturación del mes.
  // Por eso se niega si ese pedido ya generó un movimiento, y si el mes ya se emitió a la deuda.
  app.delete('/api/os/pedidos/:id', (req, res) => {
    const p = pedidosStore.get(req.params.id);
    if (!p) return err(res, 404, 'no existe ese pedido');
    const mov = db.prepare('SELECT id FROM movimientos WHERE pedido_id=?').get(String(p.id));
    if (mov) return err(res, 409, `ese pedido ya generó el movimiento ${mov.id}: anulá el movimiento primero`);
    const mes = String(p.resueltoAt || p.createdAt || '').slice(0, 7);
    const em = emision.emitido(mes, 'facturacion');
    if (em.cantidad) return err(res, 409, `${mes} ya se emitió a la deuda (${em.cantidad} movimientos): anulá la emisión, borrá el pedido y volvé a emitir`);
    const r = pedidosStore.remove(req.params.id);
    if (!r.ok) return err(res, 400, r.error);
    console.log(`[Pedido] BORRADO ${p.id} · ${p.codigo} · ${p.divisa} ${p.monto} · estado ${p.estado}`);
    ok(res, r);
  });
  app.post('/api/os/clientes/:id/abonos/completar', wrap((req, res) => {
    const b = req.body || {};
    const cli = clientes.get(req.params.id);
    if (!cli) return err(res, 404, 'cliente no encontrado');
    if (!cli.abona_a || !cli.abona_pts) return err(res, 400, 'este cliente no tiene configurado a quién abona ni cuántos puntos');
    const desde = String(b.desde || '0000-00-00').slice(0, 10);
    const otro = clientes.get(cli.abona_a);
    const yaAbonados = new Set(movs.list({ cliente_id: cli.abona_a, tipo: 'bonificacion' }).map((m) => m.pedido_id).filter(Boolean));
    const cargas = movs.list({ cliente_id: cli.id, tipo: 'carga' })
      .filter((m) => m.pedido_id && String(m.fecha || '').slice(0, 10) >= desde);
    const out = [];
    for (const m of cargas) {
      if (yaAbonados.has(m.pedido_id)) { out.push({ pedido: m.pedido_id, fecha: String(m.fecha).slice(0, 10), estado: 'ya estaba' }); continue; }
      const p = pedidosStore.get(m.pedido_id);
      if (!p) { out.push({ pedido: m.pedido_id, estado: 'no encontré el pedido' }); continue; }
      if (b.aplicar !== true) {
        const usdt = m.monto_usdt != null ? money.round(money.div(money.mul(String(m.monto_usdt), String(cli.abona_pts)), String(m.base_pct_aplicado)), 2) : null;
        out.push({ pedido: m.pedido_id, fecha: String(m.fecha).slice(0, 10), estado: 'se abonaría', usdt });
        continue;
      }
      const r = deudaCargaSvc.abonoPorCarga(p, m, cli);
      out.push({ pedido: m.pedido_id, fecha: String(m.fecha).slice(0, 10), estado: r && r.ok ? 'abonado' : ((r && r.motivo) || 'sin abono'),
        movimiento: r && r.movimiento ? r.movimiento.id : null, usdt: r && r.movimiento ? r.movimiento.monto_usdt : null });
    }
    ok(res, { cliente: cli.nombre, abonaA: otro ? otro.nombre : null, puntos: cli.abona_pts, simulado: b.aplicar !== true, cargas: out });
  }));
}

module.exports = { mount };
