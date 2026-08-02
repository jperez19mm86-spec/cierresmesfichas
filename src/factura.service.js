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
const clientes = require('./clientes-store');
const deudaSvc = require('./deuda.service');
const movs = require('./movimientos-store');
const externosSvc = require('./externos.service');
const tcUnico = require('./tc-unico.service');
const ventasOnline = require('./ventas-online.service');
const money = require('./lib/money');

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
          // una línea por proveedor, sumando todos los paneles: al cliente le importa el proveedor,
          // no en cuál de sus paneles se generó
          items: (() => {
            const acc = {};
            (r.paneles || []).forEach((p) => (p.items || []).filter((i) => i.cobra).forEach((i) => {
              const a = acc[i.proveedor] = acc[i.proveedor] || { proveedor: i.proveedor, pct: i.pct, base: i.base, dif: i.dif, usdt: '0' };
              a.usdt = money.add(a.usdt, i.usdt);
            }));
            return Object.values(acc)
              .map((a) => ({ ...a, usdt: money.round(a.usdt, 2) }))
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
    cuenta: {
      consumo_pendiente: cuenta.fichas_pendientes,
      externos_pendiente: cuenta.proveedores_pendientes,
      pagos: cuenta.pagos,
      saldo: cuenta.total,
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
    L.push(`  Comisión ${esc(f.consumo.base)}% → <b>${$(f.consumo.total_usdt)} USDT</b>`);
    L.push('');
  }

  // Por panel: es el corte que el cliente entiende, porque son SUS cuentas.
  if ((f.porPanel || []).length) {
    L.push('<b>Por panel</b>');
    f.porPanel.forEach((p) => L.push(`  ${esc(p.panel)} (${esc(p.divisa)}): ${p.cargas} carga(s) · ${$(p.monto)}`));
    L.push('');
  }

  if (f.externos && f.externos.items && f.externos.items.length) {
    L.push('<b>Proveedores externos</b>');
    f.externos.items.slice(0, 15).forEach((i) => L.push(`  ${esc(i.proveedor)}: ${$(i.usdt)} USDT`));
    if (f.externos.items.length > 15) L.push(`  …y ${f.externos.items.length - 15} más`);
    L.push(`  Total → <b>${$(f.externos.total_usdt)} USDT</b>`);
    L.push('');
  }

  L.push(`<b>TOTAL DEL MES: ${$(f.totalMes_usdt)} USDT</b>`);
  L.push('');
  L.push(`Saldo de la cuenta: <b>${$(f.cuenta.saldo)} USDT</b>`);
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
        L.push(`▸ <b>${esc(d.panel)}</b> (${esc(d.divisa)})${p ? ` — ${p.cargas} carga(s) · ${money.fmt(p.monto, 2)}` : ''}`);
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

module.exports = { armar, aTexto, partir, nombreMes };
