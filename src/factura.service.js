/**
 * factura.service.js — LA FACTURA DEL MES DE UN CLIENTE, para mandársela.
 *
 * Junta en un solo documento las DOS facturas, que son cosas distintas y por eso van separadas:
 *
 *   1. CONSUMO           lo que pidió y se le cargó en el mes, por su % base.
 *   2. PROVEEDORES EXT.  los proveedores que cuestan más que su %, sobre la ganancia que dieron.
 *
 * Y abajo la cuenta corriente: qué debía, qué se le sumó, qué pagó y cómo queda.
 *
 * NO calcula nada por su cuenta: pide los mismos números que muestran las pantallas y que se emiten
 * a la deuda. Si la factura que se manda dijera algo distinto de lo que dice el panel, no habría
 * forma de saber cuál de las dos está bien.
 */
// Para los nombres de panel: Telegram auto-enlaza lo que parece un dominio (ver telegram.cuenta).
const tg = require('./telegram');
const clientes = require('./clientes-store');
const deudaSvc = require('./deuda.service');
const movs = require('./movimientos-store');
const externosSvc = require('./externos.service');
const tcUnico = require('./tc-unico.service');
const ventasOnline = require('./ventas-online.service');
const money = require('./lib/money');
const crypto = require('crypto');
const { db } = require('./db');

const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const nombreMes = (m) => {
  const [y, mm] = String(m).split('-');
  return `${MESES[Number(mm) - 1] || m} de ${y}`;
};

/**
 * @param consumo  la línea de ese cliente que devuelve la facturación del mes (ya calculada afuera,
 *                 para no volver a consultar el sistema en línea por cada factura)
 */
async function armar({ clienteId, mes, consumo = null, conExternos = true, conDetalle = true }) {
  const cli = clientes.get(clienteId);
  if (!cli) return { ok: false, error: 'cliente no encontrado' };
  const m = String(mes || '').slice(0, 7);

  // ── 1) consumo ──
  const cons = consumo ? {
    pedidos: consumo.pedidos || 0,
    base: consumo.base,
    sinBase: !!consumo.sinBase,
    vendido_usdt: consumo.vendido_usdt || '0',
    total_usdt: consumo.fee_usdt || '0',
    porDivisa: consumo.porDivisa || [],
  } : null;

  // ── 1b) el detalle carga por carga, para que se pueda auditar ──
  // Sin esto el cliente ve un total y tiene que creernos. Con esto puede cruzar cada línea contra
  // lo que él pidió: fecha, panel, moneda y monto.
  let detalle = null; let porPanel = null;
  if (conDetalle) {
    try {
      const d = await ventasOnline.detalleDelMes(m, cli.id);
      if (d.ok) {
        detalle = d.detalle;
        const acc = {};
        for (const x of detalle) {
          const k = `${x.panel}|${x.divisa}`;
          const a = acc[k] = acc[k] || { panel: x.panel, divisa: x.divisa, cargas: 0, monto: 0 };
          a.cargas++; a.monto += x.monto;
        }
        porPanel = Object.values(acc)
          .map((a) => ({ ...a, monto: money.round(String(a.monto), 2) }))
          .sort((a, b) => Number(b.monto) - Number(a.monto));

        // El cliente audita POR PANEL, no por orden cronológico global: quiere ver las cargas de
        // un panel juntas y numeradas. Así que se ordena por panel (el de más volumen primero) y
        // dentro de cada uno por fecha, con su número de orden.
        const orden = {};
        porPanel.forEach((p, i) => { orden[`${p.panel}|${p.divisa}`] = i; });
        detalle.sort((a, b) => {
          const oa = orden[`${a.panel}|${a.divisa}`] ?? 999;
          const ob = orden[`${b.panel}|${b.divisa}`] ?? 999;
          if (oa !== ob) return oa - ob;
          return String(a.fecha + a.hora).localeCompare(String(b.fecha + b.hora));
        });
        const cuenta = {};
        detalle.forEach((d) => {
          const k = `${d.panel}|${d.divisa}`;
          cuenta[k] = (cuenta[k] || 0) + 1;
          d.n = cuenta[k];                 // 1, 2, 3… dentro de SU panel
        });
      }
    } catch (e) { /* si el puente no responde, la factura sale igual sin el detalle */ }
  }

  // ── 2) proveedores externos ──
  let ext = null;
  if (conExternos) {
    try {
      const r = await externosSvc.reporte({ clienteNombre: cli.nombre, mes: m });
      if (r.ok) {
        ext = {
          base: r.base,
          total_usdt: r.totalUsdt,
          incompleto: !!r.incompleto,
          // Una línea por proveedor Y MONEDA, con todo el desglose: cuánto ganó ese proveedor, qué
          // porcentaje EXCEDENTE se le cobra (su precio menos la base del cliente — si cuesta 14 y
          // el cliente paga 6, se cobra 8, no 14), cuánto da eso en la moneda del panel y cuánto en
          // USDT con el tipo de cambio del mes.
          //
          // Se agrupa por proveedor + MONEDA a propósito: sumar la ganancia de un proveedor en
          // pesos con la de guaraníes daría un número que no significa nada, y el tipo de cambio
          // sería el de cuál. Al cliente sí le da lo mismo en qué panel se generó, eso se suma.
          items: (() => {
            const acc = {};
            (r.paneles || []).forEach((p) => (p.items || []).filter((i) => i.cobra).forEach((i) => {
              const k = `${i.proveedor}|${i.divisa}`;
              const a = acc[k] = acc[k] || {
                proveedor: i.proveedor, divisa: i.divisa,
                pct: i.pct, base: i.base, excedente: i.dif, tc: i.tasa,
                profit: '0', monto: '0', usdt: '0', paneles: new Set(),
              };
              a.profit = money.add(a.profit, i.profit);
              a.monto = money.add(a.monto, i.monto);
              a.usdt = money.add(a.usdt, i.usdt);
              a.paneles.add(i.panel);
            }));
            return Object.values(acc)
              .map((a) => ({
                ...a,
                profit: money.round(a.profit, 2),
                monto: money.round(a.monto, 2),
                usdt: money.round(a.usdt, 2),
                paneles: [...a.paneles],
              }))
              .sort((a, b) => Number(b.usdt) - Number(a.usdt));
          })(),
          // El DESGLOSE POR PANEL, que es como el cliente audita: igual que con las cargas, quiere
          // ver qué salió de cada panel suyo, no un total en el que no puede verificar nada.
          //
          // Se separa por panel Y moneda (un panel puede reportar en más de una) porque el tipo de
          // cambio es uno por moneda. Y se suma por proveedor dentro de cada panel: dos proveedores
          // del casino pueden mapear al mismo nombre de la matriz y saldrían repetidos.
          porPanel: (() => {
            const acc = {};
            (r.paneles || []).forEach((p) => (p.items || []).filter((i) => i.cobra).forEach((i) => {
              const kp = `${i.panel}|${i.divisa}`;
              const g = acc[kp] = acc[kp] || {
                panel: i.panel, divisa: i.divisa, tc: i.tasa, prov: {}, monto: '0', usdt: '0',
              };
              const a = g.prov[i.proveedor] = g.prov[i.proveedor] || {
                proveedor: i.proveedor, pct: i.pct, base: i.base, excedente: i.dif,
                profit: '0', monto: '0', usdt: '0',
              };
              a.profit = money.add(a.profit, i.profit);
              a.monto = money.add(a.monto, i.monto);
              a.usdt = money.add(a.usdt, i.usdt);
              g.monto = money.add(g.monto, i.monto);
              g.usdt = money.add(g.usdt, i.usdt);
            }));
            return Object.values(acc)
              .map((g) => ({
                panel: g.panel, divisa: g.divisa, tc: g.tc,
                monto: money.round(g.monto, 2), usdt: money.round(g.usdt, 2),
                items: Object.values(g.prov)
                  .map((a) => ({
                    ...a,
                    profit: money.round(a.profit, 2),
                    monto: money.round(a.monto, 2),
                    usdt: money.round(a.usdt, 2),
                  }))
                  .sort((a, b) => Number(b.usdt) - Number(a.usdt)),
              }))
              .sort((a, b) => Number(b.usdt) - Number(a.usdt));
          })(),
        };
      } else if (r.faltaBase) ext = { faltaBase: true, error: r.error };
      else ext = { error: r.error };
    } catch (e) { ext = { error: String((e && e.message) || e) }; }
  }

  // ── 3) la cuenta corriente ──
  const cuenta = deudaSvc.cuentaCorriente(cli.id);
  const pagosMes = movs.list({ cliente_id: cli.id, tipo: 'pago', mes: m })
    .map((p) => ({ fecha: String(p.fecha || '').slice(0, 10), usdt: money.round(p.monto_usdt || '0', 2), medio: p.medio || null, notas: p.notas || '' }));
  const pagadoMes = money.round(money.sum(pagosMes.map((p) => p.usdt)), 2);

  const delMes = money.add(cons ? cons.total_usdt : '0', (ext && ext.total_usdt) ? ext.total_usdt : '0');

  // ── 4) LO MISMO, EN LA MONEDA DEL CLIENTE ────────────────────────────────────────────────────
  // Se cobra en USDT, pero el cliente vende en su moneda y piensa en su moneda: "2.860.000 ARS" le
  // dice algo que "1.816,89 USDT" no. Es el mismo cobro visto de los dos lados, no otro cobro.
  //
  // La comisión local es EXACTA, no una conversión: es el mismo % sobre lo que vendió en su
  // moneda, que es de donde sale el número en USDT. Convertir el total redondeado de vuelta daría
  // 2.859.998,40 en vez de 2.860.000 y no habría forma de explicar esos 1,60.
  //
  // Sólo existe si vendió en UNA sola moneda. Con dos o más no hay un número local que signifique
  // nada —sumar guaraníes con pesos es exactamente el error que nos costó el Reparto— así que ahí
  // no se muestra ninguno y cada moneda queda con el suyo en su renglón.
  let local = null; let comisionPorDivisa = [];
  {
    const divs = ((cons && cons.porDivisa) || []).filter((d) => money.isPos(String(d.vendido || '0')));

    // LA COMISIÓN DE CADA MONEDA, en esa moneda y en USDT. Es lo único que se puede mostrar cuando
    // el cliente vende en varias: no hay un total local, pero sí hay un número exacto por moneda, y
    // los USDT de cada una sí se suman entre sí —todos son la misma unidad— y dan el total de
    // arriba. Así el cliente puede verificar la cuenta renglón por renglón en vez de creernos.
    comisionPorDivisa = divs
      .filter((d) => money.isPos(String(d.fee || '0')))
      .map((d) => ({
        divisa: String(d.divisa),
        monto: money.round(String(d.fee), 2),
        tc: d.tc != null ? String(d.tc) : null,
        usdt: money.isPos(String(d.tc || '0')) ? money.round(money.div(String(d.fee), String(d.tc)), 2) : null,
      }));

    const una = divs.length === 1 ? divs[0] : null;
    const esLocal = una && !['USDT', 'USD'].includes(String(una.divisa || '').toUpperCase());
    if (esLocal && money.isPos(String(una.fee || '0'))) {
      // Los externos vienen en USDT: se pasan a la moneda con el MISMO TC de esa moneda, que es el
      // que ya se usó para traerlos. Sin externos, el total local es la comisión y punto.
      const extLocal = (ext && money.isPos(String(ext.total_usdt || '0')) && money.isPos(String(una.tc || '0')))
        ? money.mul(String(ext.total_usdt), String(una.tc)) : '0';
      local = {
        divisa: String(una.divisa), tc: una.tc != null ? String(una.tc) : null,
        comision: money.round(String(una.fee), 2),
        total: money.round(money.add(String(una.fee), extLocal), 2),
        // Con externos el total lleva una parte convertida desde USDT, y eso se dice: el cliente
        // tiene que poder distinguir el número exacto del que salió de un tipo de cambio.
        aproximado: money.isPos(extLocal),
      };
    }
  }
  if (cons) { cons.local = local; cons.comisionPorDivisa = comisionPorDivisa; }

  return {
    ok: true,
    cliente: { id: cli.id, codigo: cli.codigo, nombre: cli.nombre || cli.nombreVisible },
    mes: m, mesNombre: nombreMes(m),
    emitidaEl: new Date().toISOString().slice(0, 10),
    tc: tcUnico.tcDelMes('ARS', m).valor,
    consumo: cons,
    detalle, porPanel,
    externos: ext,
    totalMes_usdt: money.round(delMes, 2),
    totalMes_local: local ? { divisa: local.divisa, monto: local.total, aproximado: local.aproximado } : null,
    cuenta: {
      consumo_pendiente: cuenta.fichas_pendientes,
      externos_pendiente: cuenta.proveedores_pendientes,
      pagos: cuenta.pagos,
      saldo: cuenta.total,
      // Si hay pagos esperando el TC del cierre, el saldo es correcto pero todavía se mueve. Se
      // dice: un número provisorio presentado como definitivo es peor que no darlo.
      esperandoTC: cuenta.esperandoTC || 0,
      sinValuar: cuenta.sinValuar || 0,
    },
    pagosDelMes: pagosMes,
    pagadoMes,
  };
}

/**
 * La misma factura, lista para mandar por Telegram.
 *
 * Va en HTML porque es lo que usa el bot (`parse_mode: 'HTML'`); con asteriscos de Markdown
 * llegaría con los asteriscos a la vista.
 *
 * @param opciones.detalle  incluir la lista carga por carga (para auditoría)
 */
function aTexto(f, { detalle = false } = {}) {
  const L = [];
  const $ = (x) => money.fmt(x, 2);
  const esc = (x) => String(x == null ? '' : x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  L.push(`🧾 <b>${esc(f.cliente.nombre)}</b> — ${esc(f.mesNombre)}`);
  L.push('');

  if (f.consumo) {
    L.push('<b>Cargas del mes</b>');
    L.push(`  ${f.consumo.pedidos} carga(s) · ${$(f.consumo.vendido_usdt)} USDT`);
    (f.consumo.porDivisa || []).forEach((d) => L.push(`     ${esc(d.divisa)} ${$(d.vendido)}`));
    const lo = f.consumo.local;
    L.push(`  Comisión ${esc(f.consumo.base)}% → <b>${$(f.consumo.total_usdt)} USDT</b>`
      + (lo ? ` (${$(lo.comision)} ${esc(lo.divisa)})` : ''));
    // Con UNA moneda el desglose repetiría la línea de arriba. Con varias es lo único que se puede
    // mostrar: cada moneda con su comisión exacta, y los USDT que sí suman entre sí.
    const cpd = f.consumo.comisionPorDivisa || [];
    if (cpd.length > 1) {
      cpd.forEach((c) => L.push(`     ${esc(c.divisa)} ${$(c.monto)}`
        + (c.usdt != null ? ` → ${$(c.usdt)} USDT` : '')));
    }
    L.push('');
  }

  // Por panel: es el corte que el cliente entiende, porque son SUS cuentas.
  if ((f.porPanel || []).length) {
    L.push('<b>Por panel</b>');
    f.porPanel.forEach((p) => L.push(`  ${tg.cuenta(p.panel)} (${esc(p.divisa)}): ${p.cargas} carga(s) · ${$(p.monto)}`));
    L.push('');
  }

  if (f.externos && f.externos.items && f.externos.items.length) {
    L.push('<b>Proveedores externos</b>');
    L.push('<i>Se cobra la diferencia entre lo que cuesta el proveedor y tu base.</i>');
    // Por Telegram va el total DE CADA PANEL, no proveedor por proveedor: con 32 proveedores el
    // mensaje sería ilegible. El desglose completo, con la ganancia de cada uno, está en el link.
    const pp = f.externos.porPanel || [];
    if (pp.length) {
      pp.slice(0, 20).forEach((p) => L.push(
        `  ${esc(p.panel)} (${esc(p.divisa)}): ${p.items.length} proveedor(es) · ${$(p.usdt)} USDT`,
      ));
      if (pp.length > 20) L.push(`  …y ${pp.length - 20} panel(es) más (están en el link)`);
    } else {
      f.externos.items.slice(0, 15).forEach((i) => L.push(
        `  ${esc(i.proveedor)} · ${esc(i.divisa)} · ${esc(i.excedente)}% de ${$(i.profit)} → ${$(i.usdt)} USDT`,
      ));
      if (f.externos.items.length > 15) L.push(`  …y ${f.externos.items.length - 15} más (están en el link)`);
    }
    L.push(`  Total → <b>${$(f.externos.total_usdt)} USDT</b>`);
    L.push('');
  }

  const tl = f.totalMes_local;
  L.push(`<b>TOTAL DEL MES: ${$(f.totalMes_usdt)} USDT</b>`
    + (tl ? ` <b>(${tl.aproximado ? '≈ ' : ''}${$(tl.monto)} ${esc(tl.divisa)})</b>` : ''));
  L.push('');
  L.push(`Saldo de la cuenta: <b>${$(f.cuenta.saldo)} USDT</b>`);
  // Un saldo que todavía se mueve se dice que se mueve. Mandarlo como definitivo hace que el
  // cliente lo anote y que al cerrar el mes no le coincida — y el que queda mal es el sistema.
  if (Number(f.cuenta.esperandoTC || 0) > 0) L.push('<i>(incluye pagos en pesos que se ajustan al cerrar el tipo de cambio del mes)</i>');
  if (Number(f.cuenta.sinValuar || 0) > 0) L.push(`<i>⚠ ${f.cuenta.sinValuar} pago(s) todavía sin convertir: no están descontados de este saldo</i>`);
  if (Number(f.pagadoMes) > 0) L.push(`(pagado este mes: ${$(f.pagadoMes)} USDT)`);

  if (detalle && (f.detalle || []).length) {
    L.push('');
    L.push('<b>Detalle de las cargas</b>');
    // Agrupado por panel: es como lo auditan. Cada bloque arranca con el panel, su moneda y su
    // subtotal, y las cargas van numeradas DENTRO del panel (1, 2, 3…), no del mes.
    let panelActual = null;
    f.detalle.forEach((d) => {
      const k = `${d.panel}|${d.divisa}`;
      if (k !== panelActual) {
        panelActual = k;
        const p = (f.porPanel || []).find((x) => `${x.panel}|${x.divisa}` === k);
        L.push('');
        L.push(`▸ ${tg.cuenta(d.panel)} (${esc(d.divisa)})${p ? ` — ${p.cargas} carga(s) · ${money.fmt(p.monto, 2)}` : ''}`);
      }
      L.push(`   ${d.n}. ${esc(d.fecha.slice(8) + '/' + d.fecha.slice(5, 7))} ${esc(d.hora)} · ${money.fmt(String(d.monto), 2)}${d.anulando ? ' (anulando)' : ''}`);
    });
  }
  return L.join('\n');
}

/**
 * Telegram corta los mensajes en 4096 caracteres. El detalle de un mes movido se pasa fácil, así
 * que se parte por LÍNEAS — cortar a la mitad de un renglón dejaría un importe partido.
 */
function partir(texto, max = 3800) {
  const lineas = String(texto).split('\n');
  const partes = []; let actual = ''; let bloque = '';
  for (const l of lineas) {
    if (l.startsWith('▸ ')) bloque = l;          // arranca un panel: se recuerda su encabezado
    if ((actual + '\n' + l).length > max) {
      if (actual) partes.push(actual);
      // Si el corte cae a mitad de un panel, el mensaje siguiente arranca repitiendo de cuál es.
      // Sin esto, la segunda parte serían números sueltos sin decir a qué panel pertenecen.
      actual = (bloque && !l.startsWith('▸ ')) ? `${bloque} <i>(sigue)</i>\n${l}` : l;
    } else actual = actual ? `${actual}\n${l}` : l;
  }
  if (actual) partes.push(actual);
  return partes;
}


// ── link público ────────────────────────────────────────────────────────────

/**
 * Crea (o refresca) el link con el que el cliente ve el desglose completo.
 *
 * Guarda una FOTO de la factura. Si el link recalculara al abrirlo, el cliente podría ver un
 * número distinto del que se le mandó — entran cargas nuevas, se confirma otro %, cambia el TC.
 * Una factura que se mueve sola no se puede auditar.
 *
 * El token es al azar y largo: es la única llave del documento, así que no puede ser adivinable
 * ni derivable del id del cliente.
 */
function crearLink(factura) {
  const token = crypto.randomBytes(24).toString('base64url');
  const ya = db.prepare('SELECT token FROM factura_link WHERE cliente_id=? AND mes=? AND revocado=0')
    .get(factura.cliente.id, factura.mes);
  const at = new Date().toISOString();
  if (ya) {
    // Se refresca la foto pero se conserva el token: si ya se lo mandaste, el link que tiene sigue
    // andando. Queda registrado cuándo se actualizó, para que no parezca la original.
    db.prepare('UPDATE factura_link SET datos=?, actualizado_at=? WHERE token=?')
      .run(JSON.stringify(factura), at, ya.token);
    return { token: ya.token, actualizado: true };
  }
  db.prepare('INSERT INTO factura_link (token, cliente_id, mes, datos, creado_at, actualizado_at) VALUES (?,?,?,?,?,?)')
    .run(token, factura.cliente.id, factura.mes, JSON.stringify(factura), at, at);
  return { token, actualizado: false };
}

/** La factura de un token. Cuenta el acceso: sirve para saber si el cliente la abrió. */
function porToken(token) {
  const r = db.prepare('SELECT * FROM factura_link WHERE token=?').get(String(token || ''));
  if (!r) return null;
  if (r.revocado) return { revocado: true };
  db.prepare('UPDATE factura_link SET accesos=accesos+1, ultimo_acceso=? WHERE token=?')
    .run(new Date().toISOString(), r.token);
  try {
    return { factura: JSON.parse(r.datos), creado_at: r.creado_at, actualizado_at: r.actualizado_at, accesos: r.accesos + 1 };
  } catch (e) { return null; }
}

function linksDe(clienteId, mes) {
  return db.prepare('SELECT token, mes, creado_at, actualizado_at, accesos, ultimo_acceso, revocado FROM factura_link WHERE cliente_id=?' + (mes ? ' AND mes=?' : '') + ' ORDER BY mes DESC')
    .all(...(mes ? [clienteId, mes] : [clienteId]));
}

function revocar(token) {
  db.prepare('UPDATE factura_link SET revocado=1 WHERE token=?').run(String(token));
  return true;
}

module.exports = { armar, aTexto, partir, crearLink, porToken, linksDe, revocar, nombreMes };
