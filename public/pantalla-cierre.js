/* ── 🗓 CIERRE DEL MES, GUIADO — fase 3 ───────────────────────────────────────────────────────
   Seis pasos, en el orden en que se hacen (26-oct-2026). Antes eran 13; lo que se juntó o pasó a
   hacerse solo:
     · apenas la foto está completa, el servidor corre solo el contraste y el cálculo del pago a
       proveedores (cierre-auto.service);
     · los % que no cambiaron contra el mes pasado no hay que repasarlos;
     · «Emitir» es un botón: congela el mes, emite externos, consumo (que guarda las facturas) y
       vendedores, y manda las dos cuentas a Cuentas Imperium (el grupo interno, decisión de Alexa).
   Lo que sigue siendo a mano: la foto (el «Agrupar por» del casino), el TC del proveedor (sale de su
   factura), mandar las facturas a cada cliente (de a una, decisión de Alexa) y emitir el pago.
   El mes se elige una vez y viaja a la pantalla de cada paso. Los estados salen de
   /cierre/pasos/:mes; se cargan después del script principal porque usan sus ayudantes. */

const CM_STYLE = `<style>
  .cm-cab { display:flex; gap:12px; align-items:center; flex-wrap:wrap }
  .cm-cab input { width:auto }
  .cm-estado { flex:1 1 260px; font-size:14.5px }
  .cm-estado b { font-size:16px }
  .cm-barra { height:6px; border-radius:4px; background:var(--bg3); overflow:hidden; margin-top:6px }
  .cm-barra span { display:block; height:100%; background:var(--green) }
  .cm-paso { display:grid; grid-template-columns:30px minmax(0,1fr) auto; gap:3px 12px; align-items:start; padding:13px 4px; border-bottom:1px solid var(--border) }
  .cm-paso:last-child { border-bottom:0 }
  .cm-paso.toca { background:rgba(196,86,173,.07); border-radius:8px }
  .cm-n { width:24px; height:24px; border-radius:50%; background:var(--bg3); color:var(--muted); font-weight:700; font-size:12.5px; display:flex; align-items:center; justify-content:center }
  .cm-n.listo { background:rgba(46,158,99,.16); color:var(--green) }
  .cm-n.aviso { background:var(--durazno-bg); color:var(--durazno) }
  .cm-tit { font-weight:700; font-size:14.5px }
  .cm-det { font-size:12.5px; color:var(--muted); margin-top:2px }
  .cm-sub { display:flex; flex-direction:column; gap:3px; margin-top:6px; font-size:13px }
  .cm-sub span { color:var(--muted) }
  .cm-auto { font-size:12.5px; margin-top:5px; color:var(--uva) }
  .cm-acc { display:flex; gap:6px; flex-wrap:wrap; justify-content:flex-end }
  .cm-acc button { white-space:nowrap }
  .cm-log { margin-top:8px; font-size:13px; display:flex; flex-direction:column; gap:3px }
</style>`;

const _CM_PEOR = (estados) => (estados.includes('falta') ? 'falta' : estados.includes('aviso') ? 'aviso' : 'listo');
const _CM_IC = { listo: '✅', aviso: '⚠️', falta: '○' };

async function cmPasos() {
  const cont = document.getElementById('cie-body');
  cont.innerHTML = '<div class="card"><div class="muted">Mirando cómo viene el mes…</div></div>';
  const mes = _pasosMes;
  const [r, docs] = await Promise.all([
    api('/api/os/cierre/pasos/' + encodeURIComponent(mes)),
    api('/api/os/documentos?tipo=pago-proveedores&mes=' + encodeURIComponent(mes)),
  ]);
  if (!r || !r.ok) { cont.innerHTML = '<div class="card"><div class="nota err">No se pudo leer: ' + esc((r && r.error) || '') + '</div></div>'; return; }
  const P = Object.fromEntries((r.pasos || []).map((p) => [p.id, p]));
  const dPago = ((docs && docs.documentos) || []).filter((d) => !d.mes || d.mes === mes);
  P.pago = { id: 'pago', titulo: 'Emitir lo que se les paga a los proveedores', estado: dPago.length ? 'listo' : 'falta',
    detalle: dPago.length ? 'emitido el ' + String(dPago[0].emitido_at || '').slice(0, 10) : 'el cálculo ya está hecho si la foto está completa' };
  _cmDatos = { mes, P };
  const de = (ids) => ids.map((id) => P[id]).filter(Boolean);
  const est = (ids) => _CM_PEOR(de(ids).map((p) => p.estado));
  const auto = r.automatico;

  /* Los seis. Cada uno: estado, qué dice, y el botón. Los que juntan varios del servidor muestran
     cada parte en una línea chica. */
  const SEIS = [
    { n: 1, ids: ['foto'], tit: 'Sacar la foto del mes', ir: 'foto',
      extra: auto ? `<div class="cm-auto">${auto.corriendo ? '⏳ Corriendo solo el contraste y el cálculo del pago…'
        : '⚙ Hecho solo: contraste ' + (auto.contraste && auto.contraste.ok ? '✓' : '✗ ' + esc((auto.contraste || {}).error || ''))
          + ' · pago ' + (auto.pago && auto.pago.ok ? '✓' : '✗ ' + esc((auto.pago || {}).error || ''))}</div>`
        : (P.foto && P.foto.estado === 'listo' ? '' : '<div class="cm-auto">Al completarse corren solos el contraste y el cálculo del pago.</div>') },
    { n: 2, ids: ['tc', 'tc-real'], tit: 'Tipos de cambio', ir: 'tc' },
    { n: 3, ids: ['pct'], tit: 'Repasar los % que cambiaron', ir: 'cierre:externos' },
    { n: 4, ids: ['contraste'], tit: 'Revisar el contraste contra los paneles', ir: 'facturacion', accion: (P.contraste || {}).accion },
    { n: 5, ids: ['congelar', 'externos', 'facturacion', 'vendedores', 'enviar_externos', 'enviar_vendedores'], tit: 'Emitir', ir: 'cierre:externos', emitir: true },
    { n: 6, ids: ['facturas', 'pago'], tit: 'Mandar a los clientes y pagar a los proveedores', partes: true },
  ];
  const listos = SEIS.filter((s) => est(s.ids) === 'listo').length;
  const toca = SEIS.find((s) => est(s.ids) === 'falta');

  const fila = (s) => {
    const e = est(s.ids); const ps = de(s.ids);
    const det = ps.length === 1 ? `<div class="cm-det">${esc(ps[0].detalle || '')}</div>`
      : `<div class="cm-sub">${ps.map((p) => `<div>${_CM_IC[p.estado]} ${esc(_cmCorto(p))} <span>${esc(p.detalle || '')}</span></div>`).join('')}</div>`;
    let acc;
    if (s.emitir) acc = (e === 'listo' ? `<button class="outline small" onclick="cmIr('cierre:externos')">ver →</button>`
      : `<button class="${toca === s ? '' : 'outline '}small" onclick="cmEmitirTodo()">Emitir</button>`);
    else if (s.partes) acc = `<button class="${P.facturas && P.facturas.estado !== 'listo' ? '' : 'outline '}small" onclick="cmIr('facturacion')">Facturas${P.facturas && P.facturas.deTotal ? ' · ' + P.facturas.salieron + ' de ' + P.facturas.deTotal : ''} →</button>`
      + `<button class="${P.pago.estado !== 'listo' ? '' : 'outline '}small" onclick="cmIr('cierre:pago')">Pago →</button>`;
    else acc = (s.accion ? `<button class="small" onclick="${esc(s.accion)}()">correr</button>` : '')
      + `<button class="${toca === s && !s.accion ? '' : 'outline '}small" onclick="cmIr('${s.ir}')">${e === 'listo' ? 'ver' : 'ir'} →</button>`;
    return `<div class="cm-paso${toca === s ? ' toca' : ''}">
      <span class="cm-n ${e}">${e === 'listo' ? '✓' : s.n}</span>
      <div><div class="cm-tit">${esc(s.tit)}</div>${det}${s.extra || ''}${s.emitir ? '<div class="cm-log" id="cm-log"></div>' : ''}</div>
      <div class="cm-acc">${acc}</div></div>`;
  };

  cont.innerHTML = CM_STYLE + `<div class="card">
      <div class="cm-cab">
        <input type="month" value="${esc(mes)}" onchange="pasosIrA(this.value)" title="El mes que estás cerrando: vale para todos los pasos"/>
        <div class="cm-estado">${toca ? `<b>${listos} de 6 listos</b> · sigue: ${esc(toca.tit)}` : `<b>✓ ${esc(mesNombre(mes))} está cerrado</b>`}
          <div class="cm-barra"><span style="width:${Math.round(100 * listos / 6)}%"></span></div></div>
      </div>
    </div>
    <div class="card">${SEIS.map(fila).join('')}</div>`;
}
let _cmDatos = null;
// El nombre corto de cada parte, para las líneas de los pasos que juntan varios.
function _cmCorto(p) {
  return ({ tc: 'TC del proveedor', 'tc-real': 'Confirmar los que puso el sistema', congelar: 'Congelar el mes', externos: 'Externos',
    facturacion: 'Consumo y facturas guardadas', vendedores: 'Vendedores', enviar_externos: 'Externos a Cuentas Imperium',
    enviar_vendedores: 'Vendedores a Cuentas Imperium', facturas: 'Facturas a los clientes', pago: 'Pago a proveedores' })[p.id] || p.titulo;
}

/* ── EMITIR, TODO DE UNA ──────────────────────────────────────────────────────────────────────
   Lo mismo que se hacía en cuatro pantallas, en orden y con las mismas rutas: congelar, emitir
   externos, consumo y vendedores, y mandar las dos cuentas al grupo interno. Sólo hace lo que
   falta; si algo falla, frena ahí y lo dice. Lo que quedó VIEJO (emitido antes de la última foto)
   no se re-emite solo: eso se anula a mano en su pantalla. */
async function cmEmitirTodo() {
  const { mes, P } = _cmDatos || {}; if (!mes) return;
  const falta = (id) => P[id] && P[id].estado === 'falta';
  const tareas = [
    ['congelar', 'Congelar el mes', () => api('/api/os/cierre/mes/' + encodeURIComponent(mes) + '/congelar', { method: 'POST', body: JSON.stringify({ notas: 'congelado al emitir el cierre' }) }), P.congelar && P.congelar.estado !== 'listo'],
    ['externos', 'Emitir externos', () => api('/api/os/emision/externos', { method: 'POST', body: JSON.stringify({ mes }) }), falta('externos')],
    ['facturacion', 'Emitir consumo y guardar las facturas', () => _cmConsumo(mes), falta('facturacion')],
    ['vendedores', 'Emitir vendedores', () => api('/api/os/emision/vendedores', { method: 'POST', body: JSON.stringify({ mes }) }), falta('vendedores')],
    ['enviar_externos', 'Mandar externos a Cuentas Imperium', () => api('/api/os/emision/externos/' + encodeURIComponent(mes) + '/enviar', { method: 'POST', body: '{}' }), null],
    ['enviar_vendedores', 'Mandar vendedores a Cuentas Imperium', () => api('/api/os/emision/vendedores/' + encodeURIComponent(mes) + '/enviar', { method: 'POST', body: '{}' }), null],
  ];
  const aHacer = tareas.filter(([id, , , hace]) => (hace == null ? P[id] && P[id].estado !== 'listo' : hace));
  if (!aHacer.length) return toast('No falta nada para emitir');
  if (!confirm('¿Emitir ' + mesNombre(mes) + '?\n\n' + aHacer.map(([, t]) => '· ' + t).join('\n')
    + '\n\nPasa a la deuda de los clientes y manda las dos cuentas al grupo interno. Emitir de nuevo no duplica.')) return;
  const log = document.getElementById('cm-log');
  const linea = (t) => { if (log) log.insertAdjacentHTML('beforeend', '<div>' + t + '</div>'); };
  for (const [id, t, hacer] of aHacer) {
    // Mandar al grupo sólo si su emisión quedó hecha (la de antes en esta misma tanda o de antes).
    linea('⏳ ' + esc(t) + '…');
    let r; try { r = await hacer(); } catch (e) { r = { ok: false, error: e.message }; }
    if (log && log.lastChild) log.lastChild.remove();
    if (!r || !r.ok) { linea('✗ ' + esc(t) + ': ' + esc((r && r.error) || 'no se pudo') + ' — frené acá.'); return; }
    linea('✓ ' + esc(t) + (r.creados != null ? ' · ' + r.creados + ' emitidos' : '') + ((r.fallaron || []).length ? ' · ' + r.fallaron.length + ' salteados (mirá su pantalla)' : ''));
  }
  toast('Emitido');
  setTimeout(() => cmPasos(), 1200);
}
/* El consumo pide confirmación cuando el contraste tiene diferencias: se pregunta acá mismo. */
async function _cmConsumo(mes) {
  let r = await api('/api/os/emision/facturacion', { method: 'POST', body: JSON.stringify({ mes }) });
  if (!r.ok && r.requiereConfirmacion) {
    const n = (r.paraRevisar || []).length;
    if (!confirm('El contraste tiene ' + (n || 'algunas') + ' diferencia(s) contra los paneles. ¿Emitir el consumo igual?\n\n(Si no, mirá el paso 4 y volvé.)')) return { ok: false, error: 'frenado para revisar el contraste' };
    r = await api('/api/os/emision/facturacion', { method: 'POST', body: JSON.stringify({ mes, confirmado: true }) });
  }
  return r;
}

/* IR A UN PASO CON EL MES PUESTO. Cada pantalla del cierre tiene su propio mes; se ponen todos en el
   que se está cerrando antes de ir, y se borra lo que tenían calculado de otro mes. */
function cmIr(dest) {
  const m = _pasosMes;
  _fotoMes = m; _facMes = m; _tcMes = m;
  _extMes = m; _extData = null;
  _pagoMes = m; _pagoData = null;
  _venMes = m; _venData = null;
  irA(dest);
}
