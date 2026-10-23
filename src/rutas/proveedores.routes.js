/**
 * proveedores.routes.js — Proveedores: la lista, lo que se les paga, y los vendedores.
 * Sale de os.routes.js (fase 2): las rutas se movieron tal cual y en el mismo orden.
 */
const proveedores = require('../proveedores-store');
const pagoProv = require('../pago-proveedores.service');
const vendedorLineaDoc = require('../vendedor-linea-doc');
const pagoProvHtml = require('../pago-proveedores-html');
const { mesCierre: mesCierreLbl } = require('../lib/fechas');
const casinoConex = require('../casino-conexiones-store');
const vendedoresSvc = require('../vendedores.service');
const configStore = require('../config-store');
const telegram = require('../telegram');
const chat = require('../chat-externo.store');
const { fechaTZ, mesTZ } = require('../lib/fechas'); // fechaTZ/mesTZ=ART (billing) · fechaUTC/mesUTC=UTC (casino)
const { ok, err, wrap, _facturacionDe, _urlPublica } = require('./comun');

function mount(app) {
  // ───────── PROVEEDORES ─────────
  app.get('/api/os/proveedores', (_req, res) => ok(res, { proveedores: proveedores.list() }));
  app.post('/api/os/proveedores', wrap((req, res) => ok(res, { proveedor: proveedores.create(req.body || {}) })));
  app.put('/api/os/proveedores/:id', wrap((req, res) => {
    const p = proveedores.update(req.params.id, req.body || {}); if (!p) return err(res, 404, 'no encontrado'); ok(res, { proveedor: p });
  }));
  app.delete('/api/os/proveedores/:id', (req, res) => proveedores.remove(req.params.id) ? ok(res) : err(res, 404, 'no encontrado'));
  // Importar el catálogo desde el REPORTE de proveedores (los que aparecen en el cierre): 1 entrada
  // por (provider|label|vendor). ?conexion=<id>|todas (default todas) — UNIÓN de conexiones activas,
  // dedupe por codigo (misma marca en Europa y Casino = 1 sola). No pisa los que ya tienen % costo.
  app.post('/api/os/proveedores/importar-reporte', wrap(async (req, res) => {
    const q = Object.assign({}, req.query, req.body || {});
    const conexion = q.conexion || 'todas';
    const to = q.to || (fechaTZ() + ' 23:59:59');
    const from = q.from || (fechaTZ(new Date(Date.now() - 45 * 864e5)) + ' 00:00:00'); // default: últimos 45 días
    const curs = String(q.currencies || 'ARS').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
    const conns = casinoConex.list463();   // importar proveedores usa el reporte del engine 463
    const ids = conexion === 'todas' ? conns.filter((c) => c.activa).map((c) => c.id) : [conexion];
    if (!ids.length) return err(res, 400, 'No hay conexiones de casino activas para importar.');
    const seen = new Map(); // codigo(label|vendor) → nombre(label) — identidad = PROVEEDOR + VENDOR
    const porConexion = [];
    for (const id of ids) {
      const cx = conns.find((c) => c.id === id);
      const cli = casinoConex.client(id);
      if (!cli) { porConexion.push({ id, nombre: cx && cx.nombre, ok: false, error: 'conexión no encontrada' }); continue; }
      const errs = []; let filas = 0;
      for (const cur of curs) {
        const r = await cli.reporteProveedores({ from, to, currency: cur, userGroupBy: '' }); // vista GENERAL (agrega por proveedor)
        if (!r.ok) { errs.push(cur + ': ' + r.error); continue; }
        for (const f of (r.filas || [])) {
          const label = String(f.label == null ? '' : f.label).trim();   // PROVEEDOR (la marca)
          const vendor = String(f.vendor == null ? '' : f.vendor).trim(); // VENDOR
          const codigo = `${label}|${vendor}`; // identidad = PROVEEDOR + VENDOR (sin el "Sistema"/provider)
          if (!codigo.replace(/[|\s]/g, '')) continue; // fila sin datos
          const nombre = label || vendor || String(f.provider == null ? '' : f.provider).trim() || codigo;
          if (!seen.has(codigo)) seen.set(codigo, nombre);
          filas++;
        }
      }
      porConexion.push({ id, nombre: cx && cx.nombre, ok: errs.length === 0, filas, error: errs.join('; ') || undefined });
    }
    const entries = [...seen.entries()].map(([codigo, nombre]) => ({ codigo, nombre }));
    // 'todas' = refresco total → limpia entradas del reporte sin % costo (identidad vieja / ya no aparecen)
    const stats = proveedores.importarCatalogo(entries, { limpiarSinCosto: conexion === 'todas' });
    ok(res, {
      from, to, ...stats, total: entries.length, porConexion,
      // para el dropdown de alta manual (shape {code,label,sub} que ya usa el front)
      proveedores: entries.map((e) => ({ code: e.codigo, label: e.nombre, sub: true })),
    });
  }));
  /**
   * La factura de proveedores como hoja, para imprimir o mandar.
   *
   * ⚠️ Va DETRÁS DEL LOGIN, sin token público como la cuenta de un cliente: dice cuánto se le paga
   * a cada proveedor y a qué costo, o sea el margen del negocio.
   */
  app.get('/api/os/pago-proveedores/hoja', wrap(async (req, res) => {
    const r = await pagoProv.reporte({ mes: req.query.mes || mesTZ(), refrescar: req.query.refrescar === '1' });
    res.type('html').send(pagoProvHtml.hoja(r));
  }));
  // ───────── 💸 CUÁNTO LE PAGAMOS A LOS PROVEEDORES (punto 8) ─────────
  // El otro lado de la factura de externos: aquella cobra `ganancia × (celda − base)` al cliente,
  // ésta paga `ganancia × costo` al proveedor. Consulta el casino, así que tarda.
  app.get('/api/os/pago-proveedores', wrap(async (req, res) => {
    const r = await pagoProv.reporte({
      mes: req.query.mes || mesTZ(),
      monedas: req.query.monedas ? String(req.query.monedas).split(',').map((s) => s.trim().toUpperCase()).filter(Boolean) : null,
      refrescar: req.query.refrescar === '1',
    });
    r.ok ? ok(res, r) : err(res, 400, r.error);
  }));
  // El CSV con el mismo formato que el dueño ya usaba a mano.
  // Traer el mes de a pedazos y dejarlo guardado. El reporte entero no entra en una sola
  // request; esto se llama varias veces (una por panel, y TBS de a tandas de grupos) y despues
  // el reporte sale de lo guardado.
  app.post('/api/os/pago-proveedores/precargar', wrap(async (req, res) => {
    const b = req.body || {};
    const r = await pagoProv.precargar({
      confirmar: !!b.confirmar,
      mes: b.mes || mesTZ(), conexion_id: b.conexion_id,
      desde: Number(b.desde) || 0, limite: Number(b.limite) || 12, refrescar: !!b.refrescar,
    });
    r.ok ? ok(res, r) : err(res, 502, r.error,
      { reintentable: !!r.reintentable, requiereConfirmar: !!r.requiereConfirmar });
  }));
  app.get('/api/os/pago-proveedores/planilla.csv', wrap(async (req, res) => {
    const r = await pagoProv.reporte({ mes: req.query.mes || mesTZ(), refrescar: req.query.refrescar === '1' });
    if (!r.ok) return err(res, 400, r.error);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="pago-proveedores-${r.mes}.csv"`);
    res.send('﻿' + pagoProv.csv(r));   // BOM: si no, Excel rompe los acentos
  }));
  // ───────── 🤝 VENDEDORES ─────────
  // Un vendedor no paga un % sobre lo que carga: paga AL COSTO por los proveedores que use, en
  // sus paneles y en los de sus clientes. Es una cuenta interna, no una factura.
  app.get('/api/os/vendedores', (_req, res) => ok(res, { vendedores: vendedoresSvc.lista() }));
  /* El costo de proveedores del mes, repartido sin superponer. Ver el comentario grande en
     vendedores.service: el número de un vendedor incluye el de los que tiene abajo. */
  app.get('/api/os/vendedores-reparto/:mes', wrap(async (req, res) => {
    const r = await vendedoresSvc.repartoCosto(req.params.mes);
    r.ok ? ok(res, r) : err(res, 502, r.error);
  }));
  app.get('/api/os/vendedores/:nombre/rama-proveedores', wrap(async (req, res) => {
    const mes = String(req.query.mes || mesTZ()).slice(0, 7);
    const r = await vendedoresSvc.ramaPorProveedor(req.params.nombre, mes);
    r.ok ? ok(res, r) : err(res, 404, r.error);
  }));
  /* Y mandarla al grupo interno, igual que las cuentas de TBS. Va a «Cuentas Imperium»
     (`tgChatInterno`), que NO es el grupo de la matriz —donde van las de TBS— ni el de los avisos
     del chat: son tres grupos distintos y confundirlos manda la cuenta de un vendedor a donde no
     va. El detalle por proveedor viaja en el mensaje: son muchas líneas, pero `partir` las corta
     en varios mensajes y así no hace falta abrir nada para verlo. */
  app.post('/api/os/vendedores/:nombre/rama-proveedores/enviar', wrap(async (req, res) => {
    const mes = String((req.body || {}).mes || req.query.mes || mesTZ()).slice(0, 7);
    const chat = String(configStore.getCfg('tgChatInterno') || '').trim();
    const tok = configStore.getTelegramToken();
    if (!tok) return err(res, 400, 'el bot de Telegram no está configurado');
    if (!chat) return err(res, 400, 'no hay grupo interno cargado en Config → Medios de pago (Cuentas Imperium)');
    const r = await vendedoresSvc.ramaPorProveedor(req.params.nombre, mes);
    if (!r.ok) return err(res, 404, r.error);
    if (!(r.proveedores || []).length) return err(res, 400, `${r.vendedor} no movió nada en ${mes}: no hay nada que mandar`);

    const fmt = (x, d) => Number(x || 0).toLocaleString('es-AR',
      { minimumFractionDigits: d == null ? 2 : d, maximumFractionDigits: d == null ? 2 : d });
    const E = telegram.escapeHtml;

    /* UN MENSAJE CORTO Y UN LINK, como la cuenta de TBS. La primera versión mandaba las ~150 líneas
       del detalle adentro del mensaje, cortadas en varios: llega, pero se lee mal y ensucia el
       grupo. Telegram no puede mostrar una tabla con el movimiento de cada divisa y su tipo de
       cambio, que es justo lo que hay que mirar. */
    const mesNom = mesCierreLbl(mes).replace('_', ' ');
    const l = vendedorLineaDoc.crearLink({ ok: true, vendedor: r.vendedor, mes, mesNombre: mesNom,
      proveedores: r.proveedores, porCliente: r.porCliente, clientes: r.clientes, totalUsdt: r.totalUsdt });
    const url = `${_urlPublica(req)}/linea/${l.token}`;
    const texto = [`🤝 <b>Cuenta de vendedor ${E(mesNom)}</b>`,
      `<b>${E(r.vendedor)}</b>`, '',
      `💵 <b>Total: ${fmt(r.totalUsdt)} USD</b>`, '',
      `<i>${r.proveedores.length} proveedores · ${(r.clientes || []).length} cuentas en su línea</i>`, '',
      `📄 <a href="${E(url)}">Ver el detalle por proveedor y divisa</a>`].join('\n');
    const cuerpo = (req.body && req.body.texto != null && String(req.body.texto).trim())
      ? String(req.body.texto) : texto;
    if (req.body && req.body.soloTexto) {
      return ok(res, { previsualizacion: true, texto: cuerpo, chat, destino: 'Cuentas Imperium',
        link: url, proveedores: r.proveedores.length, total_usdt: r.totalUsdt });
    }
    const x = await telegram.sendMessage(tok, chat, cuerpo);
    if (!x.ok) return err(res, 502, x.error || 'Telegram no aceptó el mensaje');
    console.log(`[vendedores] línea de ${r.vendedor} (${mes}) → Cuentas Imperium: ${url}`);
    ok(res, { enviado: true, vendedor: r.vendedor, mes, chat, link: url,
      proveedores: r.proveedores.length, total_usdt: r.totalUsdt });
  }));
  app.get('/api/os/vendedores/:id', wrap(async (req, res) => {
    const mes = String(req.query.mes || mesTZ()).slice(0, 7);
    // la facturación se calcula UNA vez y se reparte: el vendedor y sus clientes salen de ahí
    const fac = await _facturacionDe(mes, { control: false });
    if (fac.ok === false) return err(res, 502, fac.error);
    const r = await vendedoresSvc.cuenta({ vendedorId: req.params.id, mes, facturacion: fac, conProveedores: req.query.proveedores !== '0' });
    r.ok ? ok(res, r) : err(res, 404, r.error);
  }));
}

module.exports = { mount };
