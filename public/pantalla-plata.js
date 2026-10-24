/* ── 📥 PLATA QUE ENTRA — fase 3, primera pantalla por tarea ──────────────────────────────────
   Junta seis pantallas que mostraban lo mismo en lugares distintos:
     · QUIÉN DEBE = Cobranzas + Cuenta del cliente. Se toca un cliente y se abre ahí mismo su
       cuenta mes a mes, lo que se le cobró por SuperAgente y qué mandarle.
     · QUÉ ENTRÓ = Pagos recibidos + Pagos y cargas + Comprobantes resueltos.
   No calcula nada: lee las mismas rutas que las pantallas viejas (/cobranzas, /cuenta, /factura,
   /pagos), así que dice los mismos números. Se carga después del script principal porque usa sus
   ayudantes (`api`, `esc`, `money`, `toast`, `mesDeCierre`, `verFactura`). */

const QD_STYLE = `<style>
  .qd-fila { cursor:pointer }
  .qd-fila:hover td, .qd-fila.abierta td { background:var(--bg3) }
  .qd-hijo td:first-child { padding-left:26px }
  .qd-det > td { background:var(--bg3); padding:0 10px 14px }
  .qd-caja { background:var(--bg2); border:1px solid var(--border); border-radius:10px; padding:14px; display:flex; flex-direction:column; gap:12px }
  .qd-barra { display:flex; gap:6px; flex-wrap:wrap; align-items:center }
  .qd-barra button { border-radius:20px }
  .qd-barra .esp { flex:1 }
  .qd-cuenta { font-size:15px; display:flex; gap:6px 14px; flex-wrap:wrap; align-items:baseline }
  .qd-cuenta span { color:var(--muted) }
  .qd-chip { display:inline-block; font-size:12px; font-weight:600; border-radius:10px; padding:1px 7px; background:var(--bg3); margin-left:4px; white-space:nowrap; color:var(--text) }
  .qd-chip.alerta { color:var(--red) }
  .qd-chip.espera { background:var(--durazno-bg); color:var(--durazno) }
  .qd-doc { display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1.3fr); gap:14px }
  @media (max-width:820px) { .qd-doc { grid-template-columns:minmax(0,1fr) } }
  .qd-opc { display:flex; flex-direction:column; gap:6px }
  .qd-opc button { text-align:left; border-radius:8px; padding:9px 12px; display:flex; justify-content:space-between; gap:8px }
  .qd-msg { background:#eef3f7; border-radius:12px; padding:12px 14px; white-space:pre-wrap; font-size:13.5px; line-height:1.45; color:#1d2a33; max-height:460px; overflow:auto }
  .qd-msg code { background:rgba(0,0,0,.06) }
  .qd-control { font-size:13px; border-radius:8px; padding:8px 11px }
  .qd-control.ok { background:rgba(46,158,99,.10); color:var(--green) }
  .qd-control.mal { background:rgba(217,83,79,.10); color:var(--red) }
  .qd-nuevo { font-size:12px; font-weight:700; color:var(--uva) }
</style>`;

const _MESES = ['', 'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const _nomMes = (m) => { const [a, b] = String(m || '').split('-'); return (_MESES[Number(b)] || m) + ' ' + (a || ''); };
const _cero = (x) => Math.abs(Number(x || 0)) < 0.005;
const _num = (x, d = 2) => (_cero(x) ? '<span class="muted">—</span>' : money(x, d));
/* Lo que queda por redondeo (pidió 58.823 fichas al 17% = 9.999,91 y pagó 10.000) no es deuda ni
   saldo a favor: menos de 1 (peso o dólar) cuenta como al día. Y lo que tiene a favor se dice así,
   no con un signo menos que parece un error. */
const _chico = (x) => Math.abs(Number(x || 0)) < 1;
const _saldo = (x) => (_cero(x) ? '<span class="muted">—</span>'
  : Number(x) < 0 ? `<span style="color:var(--green)" title="Pagó de más: lo tiene a favor">a favor ${money(-Number(x))}</span>` : money(x));
// El nombre del panel en externos puede traer «· JJ» (de quién es la cuenta): es el mismo panel.
const _panelBase = (p) => String(p || '').split(' · ')[0];

/* ═══════════════════════════════ QUIÉN DEBE ═══════════════════════════════ */
let _qdQ = '', _qdMes = '', _qdOrden = 'total', _qdJuntos = true, _qdVend = false;
let _qdAbierto = '', _qdTab = 'meses', _qdMesDoc = '', _qdDoc = 'todo';
let _qdDatos = null;                       // { cob, clientes } de la última lectura

VIEWS.quienDebe = async () => {
  const main = document.getElementById('main');
  main.innerHTML = '<div class="card"><div class="muted">Cargando…</div></div>';
  const [cob, cl] = await Promise.all([
    api('/api/os/cobranzas' + (_qdMes ? '?mes=' + encodeURIComponent(_qdMes) : '')),
    api('/api/os/clientes'),
  ]);
  if (!cob || !cob.ok) { main.innerHTML = '<div class="card"><div class="nota err">No se pudo leer: ' + esc((cob && cob.error) || '') + '</div></div>'; return; }
  /* Los pagos de los dos meses que se muestran, con el mismo mes de cierre que usa Cobranzas: con
     ellos cada mes se parte en lo que GENERÓ y lo que se pagó. */
  const [pAnt, pAct] = await Promise.all([cob.mes_anterior, cob.mes].map((m) => api('/api/os/pagos?mes=' + encodeURIComponent(m))));
  _qdDatos = { cob, clientes: (cl && cl.clientes) || [], pagos: { [cob.mes_anterior]: pAnt, [cob.mes]: pAct } };
  if (!_qdMesDoc) _qdMesDoc = cob.mes_anterior;
  qdPintar();
};

function qdPintar() {
  const { cob, clientes } = _qdDatos;
  const main = document.getElementById('main');
  const porId = Object.fromEntries(clientes.map((c) => [c.id, c]));
  const q = _qdQ.toLowerCase();
  const coincide = (f) => !q || String(f.codigo || '').toLowerCase().includes(q) || String(f.nombre || '').toLowerCase().includes(q);
  const conDeuda = (cob.filas || []).filter((f) => !_chico(f.total)).filter((f) => _qdVend || !f.es_vendedor);

  /* QUIÉN PAGA. Un cliente que paga lo de otro (JJ → Marcelo) lleva al otro adentro, aunque esté
     en cero: JJ no debe nada porque lo suyo ya se le cobra a Marcelo, y eso es lo que hay que ver. */
  const todas = (cob.filas || []).filter((f) => _qdVend || !f.es_vendedor);
  for (const c of clientes) {                 // cobranzas no trae a los que nunca tuvieron saldo propio
    if (!c.factura_a || todas.some((f) => f.cliente_id === c.id)) continue;
    const padre = conDeuda.find((x) => x.cliente_id === c.factura_a); if (!padre) continue;
    todas.push({ cliente_id: c.id, codigo: c.codigo, nombre: c.nombre, moneda: padre.moneda, antes: 0, anterior: 0, actual: 0, total: 0, cuadra: true, esperando: 0, provisional: false, es_vendedor: !!c.es_vendedor });
  }
  const pagaPor = (f) => {
    const a = (porId[f.cliente_id] || {}).factura_a;
    if (!_qdJuntos || !a) return null;
    return conDeuda.some((x) => x.cliente_id === a && x.moneda === f.moneda) ? a : null;
  };
  const raices = conDeuda.filter((f) => !pagaPor(f));
  const hijosDe = (f) => todas.filter((h) => pagaPor(h) === f.cliente_id && h.moneda === f.moneda);
  /* LO QUE GENERÓ CADA MES Y LO QUE PAGÓ, APARTE. Cobranzas da cada mes neto de lo que se pagó
     en él: Fran pagó 8.456 en septiembre (deuda de agosto) y septiembre decía «a favor 5.961,87».
     Acá cada mes muestra la deuda que generó (cargas + externos − abonos y anulaciones) y los pagos
     van en su columna: antes + lo generado − lo pagado = lo que debe hoy. Los pagos se leen en la
     moneda de la cuenta (lo que le bajó la deuda), como los cuenta Cobranzas. */
  const pagado = {};                          // codigo → { mes: monto }
  for (const [m, r] of Object.entries(_qdDatos.pagos || {})) {
    for (const p of [...((r && r.pesos) || []), ...((r && r.usdt) || [])]) {
      const f = (cob.filas || []).find((x) => x.codigo === p.codigo); if (!f) continue;
      const v = f.moneda === 'ARS' ? Number(p.ars || 0) : Number(p.saldo_usdt != null ? p.saldo_usdt : (p.usdt || 0));
      const o = pagado[p.codigo] = pagado[p.codigo] || {}; o[m] = (o[m] || 0) + v;
    }
  }
  const partes = (f) => {
    const pa = (pagado[f.codigo] || {})[cob.mes_anterior] || 0, pc = (pagado[f.codigo] || {})[cob.mes] || 0;
    return { antes: f.antes, genAnt: f.anterior + pa, genAct: f.actual + pc, pago: pa + pc, total: f.total };
  };
  const sumar = (f) => [f, ...hijosDe(f)].map(partes).reduce((a, x) => ({ antes: a.antes + x.antes, genAnt: a.genAnt + x.genAnt, genAct: a.genAct + x.genAct, pago: a.pago + x.pago, total: a.total + x.total }),
    { antes: 0, genAnt: 0, genAct: 0, pago: 0, total: 0 });
  const visibles = raices.filter((f) => coincide(f) || hijosDe(f).some(coincide));
  const orden = (a, b) => _qdOrden === 'codigo' ? String(a.codigo).localeCompare(String(b.codigo))
    : _qdOrden === 'antes' ? sumar(b).antes - sumar(a).antes : sumar(b).total - sumar(a).total;
  const monedas = [...new Set(visibles.map((f) => f.moneda))]
    .sort((a, b) => Math.abs((cob.totales[b] || {}).total || 0) - Math.abs((cob.totales[a] || {}).total || 0));
  const alDia = (cob.filas || []).filter((f) => _chico(f.total)).length;

  // Señales con número, no frases (criterio del panel): se explican al pasar el mouse.
  const marcas = (f) => {
    const sa = ((porId[f.cliente_id] || {}).paneles || []).length;
    return [
      sa > 1 ? `<span class="qd-chip" title="${sa} SuperAgentes o paneles">🎰 ${sa}</span>` : '',
      f.esperando ? `<span class="qd-chip espera" title="Comprobantes esperando que los apruebes">⏳ ${f.esperando}</span>` : '',
      f.provisional ? '<span class="qd-chip" title="Tiene pagos con un cambio que todavía se puede mover">~</span>' : '',
      f.cuadra ? '' : '<span class="qd-chip alerta" title="Los meses no suman el total: revisá su cuenta">⚠</span>',
      f.es_vendedor ? '<span class="qd-chip">vendedor</span>' : '',
    ].join('');
  };
  const fila = (f, hijo, v) => {
    const ab = _qdAbierto === f.cliente_id;
    const hs = hijo ? [] : hijosDe(f);
    v = v || partes(f);
    return `<tr class="qd-fila${hijo ? ' qd-hijo' : ''}${ab ? ' abierta' : ''}" onclick="qdAbrir('${f.cliente_id}')">
      <td>${hijo ? '↳ ' : ''}<b>${esc(f.codigo)}</b> <span class="muted">${esc(f.nombre || '')}</span>${marcas(f)}${hs.length ? `<span class="qd-chip" title="Paga también lo de ${hs.map((h) => esc(h.codigo)).join(', ')}: está sumado en esta fila">+${hs.length}</span>` : ''}</td>
      <td class="right"${v.antes >= 1 ? ' style="font-weight:700"' : ''}>${_saldo(v.antes)}</td>
      <td class="right">${_num(v.genAnt)}</td>
      <td class="right">${_num(v.genAct)}</td>
      <td class="right" style="color:var(--green)">${_num(v.pago)}</td>
      <td class="right"><b>${_saldo(v.total)}</b></td>
    </tr>${ab ? `<tr class="qd-det"><td colspan="6"><div class="qd-caja" id="qd-det"><div class="muted">Cargando…</div></div></td></tr>` : ''}`;
  };
  const tabla = (mon) => {
    const rs = visibles.filter((f) => f.moneda === mon).sort(orden);
    const T = rs.reduce((a, f) => { const s = sumar(f); return { antes: a.antes + s.antes, genAnt: a.genAnt + s.genAnt, genAct: a.genAct + s.genAct, pago: a.pago + s.pago, total: a.total + s.total }; },
      { antes: 0, genAnt: 0, genAct: 0, pago: 0, total: 0 });
    return `<div class="card"><div style="overflow-x:auto"><table style="min-width:100%">
        <thead><tr><th>${esc(mon)} · ${rs.length}</th>
          <th class="right" title="Lo que quedó sin pagar de los meses anteriores">Venía de antes</th>
          <th class="right" title="Cargas + externos − abonos de ${esc(_nomMes(cob.mes_anterior))}">Generó ${esc(_MESES[Number(cob.mes_anterior.slice(5))])}</th>
          <th class="right" title="Cargas + externos − abonos de ${esc(_nomMes(cob.mes))}">Generó ${esc(_MESES[Number(cob.mes.slice(5))])}</th>
          <th class="right" title="Pagos de ${esc(_nomMes(cob.mes_anterior))} y ${esc(_nomMes(cob.mes))}">Pagó</th>
          <th class="right">Debe hoy</th></tr></thead>
        <tbody>${rs.map((f) => { const hs = hijosDe(f); return fila(f, false, sumar(f)) + hs.map((h) => fila(h, true)).join(''); }).join('')}</tbody>
        <tfoot><tr><th>Total</th><th class="right">${money(T.antes)}</th><th class="right">${money(T.genAnt)}</th><th class="right">${money(T.genAct)}</th>
          <th class="right">${money(T.pago)}</th><th class="right">${money(T.total)}</th></tr></tfoot>
      </table></div></div>`;
  };

  main.innerHTML = QD_STYLE + `
    <div class="card"><div class="row" style="align-items:flex-end">
      <div style="flex:1 1 200px"><label>Buscar</label><input id="qd-q" value="${esc(_qdQ)}" placeholder="código o nombre" oninput="qdBuscar(this.value)"/></div>
      <div style="flex:0"><label>Mes</label><input type="month" value="${esc(cob.mes)}" onchange="qdSet('mes', this.value)"/></div>
      <div style="flex:0"><label>Ordenar</label><select onchange="qdSet('orden', this.value)">
        <option value="total"${_qdOrden === 'total' ? ' selected' : ''}>lo que debe</option>
        <option value="antes"${_qdOrden === 'antes' ? ' selected' : ''}>lo más viejo</option>
        <option value="codigo"${_qdOrden === 'codigo' ? ' selected' : ''}>código</option></select></div>
      <div style="flex:0;display:flex;flex-direction:column;gap:4px">
        <label style="display:flex;gap:6px;align-items:center;white-space:nowrap;margin:0"><input type="checkbox" ${_qdJuntos ? 'checked' : ''} onchange="qdSet('juntos', this.checked)"> juntar por quién paga</label>
        <label style="display:flex;gap:6px;align-items:center;white-space:nowrap;margin:0"><input type="checkbox" ${_qdVend ? 'checked' : ''} onchange="qdSet('vend', this.checked)"> vendedores</label></div>
    </div></div>
    ${monedas.length ? monedas.map(tabla).join('') : '<div class="card"><div class="muted">Nadie debe nada.</div></div>'}
    ${alDia ? `<div class="muted" style="margin:10px 2px">${alDia} al día.</div>` : ''}`;
  if (_qdAbierto) qdDetalle();
}

function qdBuscar(v) { _qdQ = v; qdPintar(); setTimeout(() => { const i = document.getElementById('qd-q'); if (i) { i.focus(); i.setSelectionRange(i.value.length, i.value.length); } }, 0); }
function qdSet(k, v) {
  if (k === 'mes') { _qdMes = v; _qdMesDoc = ''; return VIEWS.quienDebe(); }
  if (k === 'orden') _qdOrden = v; if (k === 'juntos') _qdJuntos = v; if (k === 'vend') _qdVend = v;
  qdPintar();
}
function qdAbrir(id) { _qdAbierto = _qdAbierto === id ? '' : id; _qdDoc = 'todo'; qdPintar(); }
function qdTab(t) { _qdTab = t; qdDetalle(); }
function qdMesDoc(m) { _qdMesDoc = m; qdDetalle(); }
function qdElegirDoc(d) { _qdDoc = d; qdDetalle(); }

/* EL DETALLE DE UN CLIENTE. Arriba, de dónde sale lo que debe en una línea (no repite la fila:
   la parte en cargas, externos y pagos). Abajo, tres solapas. */
async function qdDetalle() {
  const box = document.getElementById('qd-det'); if (!box) return;
  const id = _qdAbierto; const c = (_qdDatos.clientes || []).find((x) => x.id === id) || {};
  box.onclick = (e) => e.stopPropagation();
  const cuenta = await api('/api/os/cuenta/' + encodeURIComponent(id));
  const cc = (cuenta && cuenta.cuenta) || {};
  const linea = cuenta && cuenta.ok ? `<div class="qd-cuenta">
      <div><span>Cargas</span> ${money(cc.fichas_pendientes)}</div><div><span>+ Externos</span> ${money(cc.proveedores_pendientes)}</div>
      <div><span>− Pagó</span> ${money(cc.pagos)}</div><div><span>=</span> <b>${_chico(cc.total) ? 'al día' : Number(cc.total) < 0 ? 'a favor ' + money(-Number(cc.total)) : 'debe ' + money(cc.total)}</b> <span>${esc(cc.moneda || 'USDT')}${cc.provisional ? ' ~' : ''}</span></div></div>` : '';
  const tabs = [['meses', 'Mes a mes'], ['sa', 'Por SuperAgente'], ['mandar', 'Mandarle']];
  const barra = `<div class="qd-barra">${tabs.map(([k, l]) => `<button class="${k === _qdTab ? '' : 'outline'} small" onclick="qdTab('${k}')">${l}</button>`).join('')}
    <span class="esp"></span>${_qdTab !== 'meses' ? `<input type="month" value="${esc(_qdMesDoc)}" onchange="qdMesDoc(this.value)" style="width:auto" title="Mes"/>` : ''}</div>`;
  box.innerHTML = linea + barra + '<div class="muted">Cargando…</div>';
  let cuerpo = '';
  try {
    if (_qdTab === 'meses') cuerpo = qdMeses(cuenta, cc);
    else {
      const f = await api('/api/os/factura/' + encodeURIComponent(id) + '?mes=' + encodeURIComponent(_qdMesDoc));
      if (!f.ok) cuerpo = '<div class="nota err">' + esc(f.error || 'No se pudo armar ese mes') + '</div>';
      else cuerpo = _qdTab === 'sa' ? qdSuperAgentes(f) : qdMandar(f, cuenta, c);
    }
  } catch (e) { cuerpo = '<div class="nota err">No se pudo leer: ' + esc(e.message) + '</div>'; }
  if (_qdAbierto === id) box.innerHTML = linea + barra + cuerpo;
}

function qdMeses(r, cc) {
  if (!r || !r.ok) return '<div class="nota err">' + esc((r && r.error) || 'No se pudo leer la cuenta') + '</div>';
  /* El mes a mes del servidor (/cuenta) está sólo en dólares: a una cuenta en pesos le da todo
     cero. Hasta que se arregle (fase 4) se dice, en vez de mostrar una tabla de ceros. */
  if (cc && cc.moneda && cc.moneda !== 'USDT') return `<div class="qd-control mal">Esta cuenta es en ${esc(cc.moneda)} y el mes a mes todavía sale sólo en dólares. Lo de arriba sí está en ${esc(cc.moneda)} y es correcto.</div>`;
  const meses = (r.meses || []).slice().reverse();
  const hayOtros = meses.some((m) => !_cero(m.otros));
  const salio = (f) => !f ? '' : f.salio_at
    ? `<span title="Salió el ${esc(String(f.salio_at).slice(0, 10))}">${({ impresa: '🖨', copiada: '📋', link: '🔗', telegram: '✈️' }[f.salio_como] || '✔')}</span>`
    : '<span class="qd-chip espera" title="Se generó y no consta que se le haya mandado">sin mandar</span>';
  return `<div style="overflow-x:auto"><table style="min-width:100%"><thead><tr><th>Mes</th><th class="right">Cargas</th><th class="right">Externos</th>
      ${hayOtros ? '<th class="right" title="Ajustes, abonos y saldo inicial">Ajustes</th>' : ''}<th class="right">Pagó</th><th class="right">Debe al cierre</th><th></th></tr></thead>
    <tbody>${meses.map((m) => `<tr><td><b>${esc(_nomMes(m.mes))}</b></td>
      <td class="right">${_num(m.consumo)}</td><td class="right">${_num(m.externos)}</td>${hayOtros ? `<td class="right">${_num(m.otros)}</td>` : ''}
      <td class="right" style="color:var(--green)">${_num(m.pagos)}</td><td class="right"><b>${_saldo(m.saldo_acumulado)}</b></td>
      <td class="right" style="white-space:nowrap">${salio(m.factura)} <button class="outline small" title="Mandarle este mes" onclick="_qdMesDoc='${m.mes}';qdTab('mandar')">📤</button></td></tr>`).join('')
      || '<tr><td colspan="7" class="empty">Sin movimientos todavía.</td></tr>'}</tbody></table></div>`;
}

/* Lo cobrado por cada SuperAgente, sacado de la factura del mes (cargas y externos por panel).
   Los pagos son del cliente, no del SuperAgente: por eso acá no hay saldo. */
function _qdPorPanel(f) {
  const filas = {};
  const fila = (p, d) => filas[p + '|' + d] || (filas[p + '|' + d] = { panel: p, divisa: d, cargas: 0, monto: 0, cobra: 0, ext: 0, items: [] });
  for (const p of f.porPanel || []) { const x = fila(p.panel, p.divisa); x.cargas += Number(p.cargas || 0); x.monto += Number(p.monto || 0); x.cobra += Number(p.paga || 0); }
  for (const p of (f.externos && f.externos.porPanel) || []) { const x = fila(_panelBase(p.panel), p.divisa); x.ext += Number(p.usdt || 0); x.items.push(...(p.items || [])); }
  return Object.values(filas).sort((a, b) => (b.cobra + b.ext) - (a.cobra + a.ext));
}
function qdSuperAgentes(f) {
  const l = _qdPorPanel(f);
  const T = l.reduce((a, x) => ({ cobra: a.cobra + x.cobra, ext: a.ext + x.ext }), { cobra: 0, ext: 0 });
  return `${f.externos && f.externos.incompleto ? '<div class="qd-control mal">Los externos de este mes están incompletos: el casino no contestó por algún panel.</div>' : ''}
    <div style="overflow-x:auto"><table style="min-width:100%"><thead><tr><th>SuperAgente</th><th class="right">Cargas</th>
      <th class="right">Fichas</th><th class="right">Por cargas</th><th class="right">Externos</th><th class="right">Total USDT</th><th></th></tr></thead>
    <tbody>${l.map((x) => `<tr><td><b>${esc(x.panel)}</b></td><td class="right">${x.cargas || '<span class="muted">—</span>'}</td>
      <td class="right">${_cero(x.monto) ? '<span class="muted">—</span>' : money(x.monto) + ' <span class="muted">' + esc(x.divisa) + '</span>'}</td>
      <td class="right">${_num(x.cobra)}</td><td class="right">${_num(x.ext)}</td><td class="right"><b>${money(x.cobra + x.ext)}</b></td>
      <td class="right"><button class="outline small" title="Su documento" onclick="_qdDoc=this.dataset.k;qdTab('mandar')" data-k="sa:${esc(x.panel)}|${esc(x.divisa)}">📤</button></td></tr>`).join('')
      || '<tr><td colspan="7" class="empty">Ese mes no tuvo cargas ni externos.</td></tr>'}</tbody>
    <tfoot><tr><th colspan="3">Total ${esc(_nomMes(f.mes))}</th><th class="right">${money(T.cobra)}</th><th class="right">${money(T.ext)}</th>
      <th class="right">${money(T.cobra + T.ext)}</th><th></th></tr></tfoot></table></div>`;
}

/* ── LOS DOCUMENTOS PARA EL CLIENTE ─────────────────────────────────────────────────────────
   «Todo junto» es el texto que arma el servidor hoy (factura.service → aTexto), tal cual sale.
   Los otros tres son nuevos y se dibujan acá con el mismo formato, para verlos antes de
   programarlos en el servidor. Ninguno lleva el saldo: se sacó del mensaje el 7-sep-2026 a
   pedido de la dueña, porque todavía no siempre refleja lo real. Cada uno dice el total de lo suyo. */
const _$ = (x) => money(x, 2);
const _cab = (f, que) => `${que} <b>${esc(f.cliente.nombre)}</b> — ${esc(f.mesNombre || _nomMes(f.mes))}`;
function docCargas(f) {
  const c = f.consumo; if (!c) return null;
  const L = [_cab(f, '⚡'), '', '<b>Cargas del mes</b>', `  ${c.pedidos} carga(s) · ${_$(c.vendido_usdt)} USDT`];
  (c.porDivisa || []).forEach((d) => L.push(`     ${esc(d.divisa)} ${_$(d.vendido)}`));
  L.push(`  Comisión ${esc(c.base)}% → <b>${_$(c.total_usdt)} USDT</b>`);
  (c.comisionPorDivisa || []).forEach((d) => L.push(`     ${esc(d.divisa)} ${_$(d.monto)}${d.divisa === 'USDT' ? '' : ` → ${_$(d.usdt)} USDT`}`));
  if ((f.porPanel || []).length > 1) {
    L.push('', '<b>Por SuperAgente</b>');
    f.porPanel.forEach((p) => L.push(`  <code>${esc(p.panel)}</code> (${esc(p.divisa)}): ${p.cargas} carga(s) · ${_$(p.monto)} → <b>${_$(p.paga)} USDT</b>`));
  }
  L.push('', `<b>TOTAL DE CARGAS: ${_$(c.total_usdt)} USDT</b>`);
  return { texto: L.join('\n'), total: c.total_usdt };
}
function docExternos(f) {
  const e = f.externos; if (!e || _cero(e.total_usdt)) return null;
  const L = [_cab(f, '🏷'), '', '<b>Proveedores externos</b>', '<i>Se cobra la diferencia entre lo que cuesta el proveedor y tu base.</i>'];
  (e.porPanel || []).forEach((p) => {
    const its = (p.items || []).filter((i) => !_cero(i.usdt));
    L.push('', `<code>${esc(p.panel)}</code> (${esc(p.divisa)}) · <b>${_$(p.usdt)} USDT</b>`);
    its.slice(0, 8).forEach((i) => L.push(`  ${esc(i.proveedor)} · ${esc(i.excedente)}% de ${_$(i.profit)} → ${_$(i.usdt)}`));
    if (its.length > 8) L.push(`  …y ${its.length - 8} más (en el link)`);
  });
  L.push('', `<b>TOTAL DE EXTERNOS: ${_$(e.total_usdt)} USDT</b>`);
  return { texto: L.join('\n'), total: e.total_usdt };
}
function docSuperAgente(f, clave) {
  const x = _qdPorPanel(f).find((p) => p.panel + '|' + p.divisa === clave); if (!x) return null;
  const L = [_cab(f, '🎰') + ` · <code>${esc(x.panel)}</code>`, ''];
  if (x.cargas) L.push('<b>Cargas</b>', `  ${x.cargas} carga(s) · ${_$(x.monto)} ${esc(x.divisa)}`, `  Comisión ${esc((f.consumo || {}).base)}% → <b>${_$(x.cobra)} USDT</b>`);
  if (!_cero(x.ext)) {
    const its = x.items.filter((i) => !_cero(i.usdt));
    L.push('', '<b>Proveedores externos</b>');
    its.slice(0, 10).forEach((i) => L.push(`  ${esc(i.proveedor)} · ${esc(i.excedente)}% de ${_$(i.profit)} → ${_$(i.usdt)}`));
    if (its.length > 10) L.push(`  …y ${its.length - 10} más (en el link)`);
    L.push(`  Total → <b>${_$(x.ext)} USDT</b>`);
  }
  L.push('', `<b>TOTAL ${esc(x.panel)}: ${_$(x.cobra + x.ext)} USDT</b>`);
  return { texto: L.join('\n'), total: x.cobra + x.ext };
}
// El mensaje se ve como en Telegram: sólo negrita, cursiva y código; el resto, como texto.
const _qdTg = (t) => String(t || '').replace(/<a [^>]*>([^<]*)<\/a>/g, '$1').replace(/<(?!\/?(b|i|code)>)/g, '&lt;');

/* QUÉ MANDARLE. A la izquierda se elige; a la derecha se ve el mensaje tal como le llega, con un
   control arriba: si lo que dice el documento no es lo que está anotado en su cuenta para ese
   mes, se avisa ANTES de mandarlo. */
function qdMandar(f, cuenta, c) {
  const mesC = ((cuenta && cuenta.meses) || []).find((m) => m.mes === f.mes) || null;
  const sas = _qdPorPanel(f);
  const opciones = [
    ['todo', '🧾 Todo junto', f.totalMes_usdt, true],
    ['cargas', '⚡ Sólo las cargas', f.consumo && f.consumo.total_usdt, !!f.consumo],
    ['externos', '🏷 Sólo los externos', f.externos && f.externos.total_usdt, !!(f.externos && !_cero(f.externos.total_usdt))],
    ...(sas.length > 1 ? sas.map((x) => ['sa:' + x.panel + '|' + x.divisa, '🎰 ' + x.panel + (sas.filter((y) => y.panel === x.panel).length > 1 ? ' ' + x.divisa : ''), x.cobra + x.ext, true]) : []),
  ].filter(([, , , hay]) => hay);
  if (!opciones.some(([k]) => k === _qdDoc)) _qdDoc = 'todo';
  let doc, existe = false;
  if (_qdDoc === 'todo') { doc = { texto: f.texto, total: f.totalMes_usdt }; existe = true; }
  else if (_qdDoc === 'cargas') doc = docCargas(f);
  else if (_qdDoc === 'externos') doc = docExternos(f);
  else doc = docSuperAgente(f, _qdDoc.slice(3));

  // El control contra la cuenta: cargas y externos del documento contra los del mes en la cuenta.
  let control = '';
  if (mesC && ['todo', 'cargas', 'externos'].includes(_qdDoc)) {
    const dif = [];
    const cmp = (lbl, enDoc, enCuenta) => { if (Math.abs(Number(enDoc || 0) - Number(enCuenta || 0)) >= 1) dif.push(`${lbl}: el documento dice <b>${_$(enDoc)}</b> y la cuenta <b>${_$(enCuenta)}</b>`); };
    /* Las cargas se comparan NETAS: la cuenta pone una carga anulada en «cargas» y su anulación en
       «ajustes» (Titan, 9-sep: 10.000 y −10.000). Mirar sólo «cargas» avisaba de más. */
    if (_qdDoc !== 'externos') cmp('cargas', f.consumo && f.consumo.total_usdt, Number(mesC.consumo || 0) + Number(mesC.otros || 0));
    if (_qdDoc !== 'cargas') cmp('externos', f.externos && f.externos.total_usdt, mesC.externos);
    control = dif.length
      ? `<div class="qd-control mal">⚠ No coincide con su cuenta de ${esc(_nomMes(f.mes))}. ${dif.join(' · ')}. Revisalo antes de mandarlo.</div>`
      : '<div class="qd-control ok">✔ Coincide con su cuenta.</div>';
  }
  const g = f.guardada;
  const yaSalio = _qdDoc === 'todo' && g && g.salio_at ? `Salió el ${esc(String(g.salio_at).slice(0, 10))} (${esc(g.salio_como || '')})` : '';
  const bloq = (t) => `<button class="outline small" disabled title="Se programa cuando apruebes la maqueta">${t}</button>`;
  const acciones = existe
    ? `<button class="small" onclick="qdAbrirFactura('${c.id}','${f.mes}')">Revisar y mandar</button>`
    : `<span class="qd-nuevo">Nuevo · todavía no se manda</span> ${bloq('✈️ Telegram')} ${bloq('🔗 Link')}`;
  return `<div class="qd-doc">
      <div class="qd-opc">${opciones.map(([k, l, t]) =>
        `<button class="${k === _qdDoc ? '' : 'outline'}" data-k="${esc(k)}" onclick="qdElegirDoc(this.dataset.k)"><b>${esc(l)}</b><span>${_$(t)}</span></button>`).join('')}</div>
      <div style="display:flex;flex-direction:column;gap:8px;min-width:0">
        ${control}
        <div class="qd-msg">${doc ? _qdTg(doc.texto) : '<span class="muted">No hay nada de esto en ese mes.</span>'}</div>
        <div class="qd-barra">${acciones}<span class="esp"></span><span class="muted">${yaSalio}</span></div>
      </div></div>`;
}
// La factura de siempre (con su previa antes de mandar); el ← vuelve acá con el cliente abierto.
function qdAbrirFactura(id, mes) { _facVolverA = 'quienDebe'; _facMes = mes; verFactura(id); }

/* ═══════════════════════════════ QUÉ ENTRÓ ═══════════════════════════════ */
let _qeMes = '', _qeVia = 'todo', _qeQ = '', _qeOrden = 'fecha', _qeTope = 40;
let _qeDatos = null;

VIEWS.queEntro = async () => {
  const main = document.getElementById('main');
  main.innerHTML = '<div class="card"><div class="muted">Cargando…</div></div>';
  const mes = _qeMes || mesDeCierre();
  const [r, rech] = await Promise.all([
    api('/api/os/pagos?mes=' + encodeURIComponent(mes)),
    api('/api/os/comprobantes?estado=rechazado'),
  ]);
  if (!r || !r.ok) { main.innerHTML = '<div class="card"><div class="nota err">No se pudo leer: ' + esc((r && r.error) || '') + '</div></div>'; return; }
  window._pagDatos = r;                     // el envío al grupo de la pantalla vieja lee esto
  _qeDatos = { r, rechazados: ((rech && rech.comprobantes) || []).filter((x) => String(x.resuelto_at || x.creado_at || '').slice(0, 7) === r.mes) };
  qePintar();
};

function qePintar() {
  const { r, rechazados } = _qeDatos;
  const main = document.getElementById('main');
  const todos = [...(r.pesos || []).map((p) => ({ ...p, _via: 'pesos' })), ...(r.usdt || []).map((p) => ({ ...p, _via: 'usdt' }))];
  const q = _qeQ.toLowerCase();
  const l = todos.filter((p) => _qeVia === 'todo' || p._via === _qeVia)
    .filter((p) => !q || [p.cliente, p.codigo, p.referencia, p.billetera].some((x) => String(x || '').toLowerCase().includes(q)))
    .sort((a, b) => _qeOrden === 'monto' ? Number(b.usdt || 0) - Number(a.usdt || 0)
      : _qeOrden === 'cliente' ? String(a.cliente).localeCompare(String(b.cliente)) : String(b.fecha).localeCompare(String(a.fecha)));
  const T = r.totales || {};
  const vis = l.slice(0, _qeTope);
  const via = (k, lbl, n) => `<button class="${_qeVia === k ? '' : 'outline'} small" onclick="qeSet('via','${k}')">${lbl} · ${n}</button>`;
  const dia = (f) => String(f).slice(5).split('-').reverse().join('/');
  main.innerHTML = QD_STYLE + `
    <div class="card" style="display:flex;flex-direction:column;gap:12px">
      <div class="qd-barra">${(r.meses || []).slice(0, 8).map((m) => `<button class="${m.mes === r.mes ? '' : 'outline'} small" onclick="qeSet('mes','${m.mes}')">${esc(_nomMes(m.mes))}</button>`).join('')}</div>
      <div class="qd-cuenta">
        <div><span>Pesos</span> $ ${money(T.pesos_ars)} <span>≈ ${money(T.pesos_usdt)} USDT</span></div>
        <div><span>+ USDT</span> ${money(T.usdt_usdt)}</div>
        <div><span>= Entró</span> <b style="color:var(--green)">${money(Number(T.pesos_usdt || 0) + Number(T.usdt_usdt || 0))} USDT</b></div>
      </div>
    </div>
    <div class="card">
      <div class="row" style="align-items:flex-end">
        <div style="flex:0;display:flex;gap:6px">${via('todo', 'Todo', todos.length)}${via('pesos', 'Pesos', (r.pesos || []).length)}${via('usdt', 'USDT', (r.usdt || []).length)}</div>
        <div style="flex:1 1 200px"><input id="qe-q" value="${esc(_qeQ)}" placeholder="Buscar cliente, referencia o billetera" oninput="qeBuscar(this.value)"/></div>
        <div style="flex:0"><select onchange="qeSet('orden', this.value)" title="Ordenar">
          <option value="fecha"${_qeOrden === 'fecha' ? ' selected' : ''}>por fecha</option>
          <option value="monto"${_qeOrden === 'monto' ? ' selected' : ''}>por monto</option>
          <option value="cliente"${_qeOrden === 'cliente' ? ' selected' : ''}>por cliente</option></select></div>
        <div style="flex:0;display:flex;gap:6px">
          <button class="small" onclick="_movSub='cuenta';go('movimientos')">＋ Pago a mano</button>
          <button class="outline small" onclick="pagEnviar()" title="Fecha y monto de los pagos en pesos, al grupo que concilia con el banco">📣 Pesos al grupo</button>
          <button class="outline small" onclick="qeCSV()" title="Bajar en Excel">⬇</button></div>
      </div>
      <div style="overflow-x:auto;margin-top:10px"><table style="min-width:100%"><thead><tr><th>Fecha</th><th>Cliente</th>
        <th class="right">Recibido</th><th class="right">En USDT</th><th>Referencia</th><th></th></tr></thead>
      <tbody>${vis.map((p) => `<tr><td>${esc(dia(p.fecha))}${p.mes && p.mes !== String(p.fecha).slice(0, 7) ? ` <span class="qd-chip" title="Entra en el cierre de ${esc(_nomMes(p.mes))}">→ ${esc(_MESES[Number(p.mes.slice(5))])}</span>` : ''}</td>
        <td><b>${esc(p.codigo || '')}</b> <span class="muted">${esc(p.cliente || '')}</span></td>
        <td class="right">${p._via === 'pesos' ? '$ ' + money(p.ars) : money(p.usdt) + ' <span class="muted">USDT' + (p.billetera ? ' · ' + esc(p.billetera) : '') + '</span>'}</td>
        <td class="right">${p._via === 'usdt' ? '' : p.usdt != null ? money(p.usdt) + (p.provisional ? ' <span class="qd-chip" title="Con un cambio que todavía se puede mover">~</span>' : '') : '<span class="qd-chip espera" title="Todavía sin tipo de cambio">sin TC</span>'}</td>
        <td class="muted">${esc(p.referencia || '')}</td>
        <td class="right">${p.comprobante && p.archivo ? `<button class="outline small" title="Ver el comprobante" onclick="window.open('/api/os/comprobantes/${p.comprobante}/archivo','_blank')">📎</button>` : ''}</td></tr>`).join('')
        || '<tr><td colspan="6" class="empty">No entró nada con ese filtro.</td></tr>'}</tbody></table></div>
      ${l.length > vis.length ? `<div style="text-align:center;margin-top:10px"><button class="outline small" onclick="_qeTope+=60;qePintar()">Ver ${Math.min(60, l.length - vis.length)} más de ${l.length - vis.length}</button></div>` : ''}
    </div>
    ${rechazados.length ? `<div class="card"><h2>✖ Rechazados · ${rechazados.length}</h2>
      <table><tbody>${rechazados.slice(0, 20).map((x) => `<tr><td><b>${esc(x.codigo || '')}</b> <span class="muted">${esc(x.cliente_nombre || '')}</span></td>
        <td class="right">${money(x.monto)} <span class="muted">${esc(x.divisa || '')}</span></td><td class="muted">${esc(x.motivo || '')}</td></tr>`).join('')}</tbody></table></div>` : ''}`;
}
function qeBuscar(v) { _qeQ = v; _qeTope = 40; qePintar(); setTimeout(() => { const i = document.getElementById('qe-q'); if (i) { i.focus(); i.setSelectionRange(i.value.length, i.value.length); } }, 0); }
function qeSet(k, v) { _qeTope = 40; if (k === 'mes') { _qeMes = v; return VIEWS.queEntro(); } if (k === 'via') _qeVia = v; if (k === 'orden') _qeOrden = v; qePintar(); }
/* Punto y coma y coma decimal, como el Excel en castellano (igual que pagCSV). */
function qeCSV() {
  const { r } = _qeDatos; const num = (x) => (x == null ? '' : String(Number(x).toFixed(2)).replace('.', ','));
  const qq = (x) => '"' + String(x == null ? '' : x).replace(/"/g, '""') + '"';
  const filas = [...(r.pesos || []).map((p) => ['pesos', p, num(p.ars)]), ...(r.usdt || []).map((p) => ['USDT', p, num(p.usdt)])];
  const csv = '﻿' + ['Fecha;Entra en;Código;Cliente;Cómo;Recibido;En USDT;Billetera;Referencia']
    .concat(filas.map(([v, p, rec]) => [p.fecha, p.mes, qq(p.codigo), qq(p.cliente), v, rec, num(p.usdt), qq(p.billetera), qq(p.referencia)].join(';'))).join('\n');
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  a.download = 'entro-' + r.mes + '.csv'; a.click();
}
