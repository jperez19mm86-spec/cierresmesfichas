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
async function armar({ clienteId, mes, consumo = null, conExternos = true }) {
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

/** La misma factura en texto plano, para pegar en WhatsApp o Telegram. */
function aTexto(f) {
  const L = [];
  const $ = (x) => money.fmt(x, 2);
  L.push(`🧾 *${f.cliente.nombre}* — ${f.mesNombre}`);
  L.push('');
  if (f.consumo) {
    L.push(`*Cargas del mes*`);
    L.push(`  ${f.consumo.pedidos} carga(s) · ${$(f.consumo.vendido_usdt)} USDT`);
    (f.consumo.porDivisa || []).forEach((d) => L.push(`     ${d.divisa} ${$(d.vendido)}`));
    L.push(`  Comisión ${f.consumo.base}% → *${$(f.consumo.total_usdt)} USDT*`);
    L.push('');
  }
  if (f.externos && f.externos.items && f.externos.items.length) {
    L.push(`*Proveedores externos*`);
    f.externos.items.slice(0, 12).forEach((i) => L.push(`  ${i.proveedor}: ${$(i.usdt)} USDT`));
    if (f.externos.items.length > 12) L.push(`  …y ${f.externos.items.length - 12} más`);
    L.push(`  Total → *${$(f.externos.total_usdt)} USDT*`);
    L.push('');
  }
  L.push(`*TOTAL DEL MES: ${$(f.totalMes_usdt)} USDT*`);
  L.push('');
  L.push(`Saldo de la cuenta: *${$(f.cuenta.saldo)} USDT*`);
  if (Number(f.pagadoMes) > 0) L.push(`(pagado este mes: ${$(f.pagadoMes)} USDT)`);
  return L.join('\n');
}

module.exports = { armar, aTexto, nombreMes };
