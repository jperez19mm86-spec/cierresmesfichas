/* ── 🗓 CIERRE DEL MES, GUIADO — fase 3 ───────────────────────────────────────────────────────
   Los pasos del cierre en cinco bloques, en el orden en que se hacen: los datos del mes, los
   precios, emitir, mandar y pagarle a los proveedores. El mes se elige UNA vez acá y viaja a la
   pantalla de cada paso: antes cada pantalla tenía su propio mes y al saltar se perdía (Tipos de
   cambio abría siempre en el mes en curso).
   No hace ningún paso por su cuenta: los estados salen de /cierre/pasos/:mes, como antes, y cada
   botón lleva a la pantalla de siempre. Lo único nuevo es el paso 13, pagar a los proveedores, que
   no figuraba: está hecho cuando hay un documento de pago emitido de ese mes.
   Se carga después del script principal porque usa sus ayudantes. */

const CM_STYLE = `<style>
  .cm-cab { display:flex; gap:12px; align-items:center; flex-wrap:wrap }
  .cm-cab input { width:auto }
  .cm-estado { flex:1 1 260px; font-size:14.5px }
  .cm-estado b { font-size:16px }
  .cm-barra { height:6px; border-radius:4px; background:var(--bg3); overflow:hidden; margin-top:6px }
  .cm-barra span { display:block; height:100%; background:var(--green) }
  .cm-bloque { margin-top:14px }
  .cm-bloque h3 { display:flex; gap:8px; align-items:baseline; margin:0 0 4px; font-size:14.5px }
  .cm-bloque h3 span { color:var(--muted); font-weight:400; font-size:12.5px }
  .cm-paso { display:grid; grid-template-columns:22px minmax(0,1fr) auto; gap:2px 10px; align-items:center; padding:9px 2px; border-bottom:1px solid var(--border) }
  .cm-paso:last-child { border-bottom:0 }
  .cm-paso .ic { text-align:center }
  .cm-paso .det { grid-column:2; font-size:12.5px; color:var(--muted) }
  .cm-paso.toca { background:rgba(196,86,173,.07); border-radius:8px }
  .cm-paso .acc { display:flex; gap:6px }
  .cm-paso button { white-space:nowrap }
</style>`;

const CM_BLOQUES = [
  ['Los datos del mes', ['foto', 'tc', 'tc-real']],
  ['Los precios', ['pct', 'congelar']],
  ['Emitir', ['contraste', 'externos', 'facturacion', 'vendedores']],
  ['Mandar', ['facturas', 'enviar_externos', 'enviar_vendedores']],
  ['Pagarle a los proveedores', ['pago']],
];

async function cmPasos() {
  const cont = document.getElementById('cie-body');
  cont.innerHTML = '<div class="card"><div class="muted">Mirando cómo viene el mes…</div></div>';
  const mes = _pasosMes;
  const [r, docs] = await Promise.all([
    api('/api/os/cierre/pasos/' + encodeURIComponent(mes)),
    api('/api/os/documentos?tipo=pago-proveedores&mes=' + encodeURIComponent(mes)),
  ]);
  if (!r || !r.ok) { cont.innerHTML = '<div class="card"><div class="nota err">No se pudo leer: ' + esc((r && r.error) || '') + '</div></div>'; return; }
  // El paso que faltaba: pagarle a los proveedores. Hecho = hay un documento de pago de ese mes.
  const dPago = ((docs && docs.documentos) || []).filter((d) => !d.mes || d.mes === mes);
  const pasos = [...r.pasos, {
    id: 'pago', n: r.pasos.length + 1, ir: 'cierre:pago', titulo: 'Emitir lo que se les paga a los proveedores',
    estado: dPago.length ? 'listo' : 'falta',
    detalle: dPago.length ? 'Emitido' + (dPago[0].emitido_at ? ' el ' + String(dPago[0].emitido_at).slice(0, 10) : '') + (dPago.length > 1 ? ' · ' + dPago.length + ' versiones' : '') : 'Calcular y emitir el documento del mes',
  }];
  const porId = Object.fromEntries(pasos.map((p) => [p.id, p]));
  const listos = pasos.filter((p) => p.estado === 'listo').length;
  const toca = pasos.find((p) => p.estado === 'falta');
  const ICO = { listo: '✅', aviso: '⚠️', falta: '○' };

  const paso = (p) => `<div class="cm-paso${toca && p.id === toca.id ? ' toca' : ''}">
      <span class="ic">${ICO[p.estado] || '○'}</span>
      <b>${esc(p.titulo)}</b>
      <span class="acc">${p.accion ? `<button class="small" onclick="${esc(p.accion)}()">correr</button>` : ''}<button class="${toca && p.id === toca.id && !p.accion ? '' : 'outline '}small" onclick="cmIr('${esc(p.ir)}')">${p.estado === 'listo' ? 'ver' : 'ir'} →</button></span>
      ${p.detalle ? `<span class="det">${esc(p.detalle)}</span>` : ''}
    </div>`;
  const usados = new Set();
  const bloques = CM_BLOQUES.map(([tit, ids]) => {
    const ps = ids.map((id) => porId[id]).filter(Boolean); ps.forEach((p) => usados.add(p.id));
    if (!ps.length) return '';
    const ok = ps.filter((p) => p.estado === 'listo').length;
    return `<div class="cm-bloque"><h3>${esc(tit)} <span>${ok === ps.length ? '✓ listo' : ok + ' de ' + ps.length}</span></h3>${ps.map(paso).join('')}</div>`;
  }).join('');
  // Por si el servidor suma un paso nuevo que todavía no tiene bloque: que se vea igual.
  const sueltos = pasos.filter((p) => !usados.has(p.id));

  cont.innerHTML = CM_STYLE + `<div class="card">
      <div class="cm-cab">
        <input type="month" value="${esc(mes)}" onchange="pasosIrA(this.value)" title="El mes que estás cerrando: vale para todos los pasos"/>
        <div class="cm-estado">${toca
          ? `<b>Faltan ${pasos.length - listos} de ${pasos.length}</b> · sigue: ${esc(toca.titulo)}`
          : `<b>✓ ${esc(mesNombre(mes))} está cerrado</b>`}${r.avisos ? ` · ${r.avisos} aviso${r.avisos === 1 ? '' : 's'}` : ''}
          <div class="cm-barra"><span style="width:${Math.round(100 * listos / pasos.length)}%"></span></div></div>
        ${toca ? `<button class="small" onclick="cmIr('${esc(toca.ir)}')">Ir al siguiente →</button>` : ''}
      </div>
      ${bloques}
      ${sueltos.length ? `<div class="cm-bloque"><h3>Otros</h3>${sueltos.map(paso).join('')}</div>` : ''}
    </div>`;
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
