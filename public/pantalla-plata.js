/* ── 📥 PLATA QUE ENTRA — fase 3, primera pantalla por tarea ──────────────────────────────────
   Junta seis pantallas que mostraban lo mismo en lugares distintos:
     · QUIÉN DEBE = Cobranzas + Cuenta del cliente. Se toca un cliente y se abre ahí mismo su
       cuenta mes a mes, lo que se le cobró por SuperAgente y qué mandarle.
     · QUÉ ENTRÓ = Pagos recibidos + Pagos y cargas + Comprobantes resueltos. El mes, lo cobrado
       en pesos y en USDT, y cada pago con su comprobante al lado.
   No calcula nada: lee las mismas rutas que las pantallas viejas (/cobranzas, /cuenta, /factura,
   /pagos), así que dice los mismos números. Se carga después del script principal porque usa sus
   ayudantes (`api`, `esc`, `money`, `toast`, `mesNombre`, `verFactura`, `enviarConPrevia`). */

const QD_STYLE = `<style>
  .qd-fila { cursor:pointer }
  .qd-fila:hover td { background:var(--bg3) }
  .qd-fila.abierta td { background:var(--bg3); border-bottom-color:transparent }
  .qd-hijo td:first-child { padding-left:26px }
  .qd-det > td { background:var(--bg3); padding:0 10px 14px }
  .qd-caja { background:var(--bg2); border:1px solid var(--border); border-radius:10px; padding:14px }
  .qd-tabs { display:flex; gap:6px; flex-wrap:wrap; margin:0 0 12px }
  .qd-tabs button { border-radius:20px }
  .qd-kpis { display:flex; gap:10px; flex-wrap:wrap; margin:0 0 12px }
  .qd-kpis > div { flex:1 1 140px; background:var(--bg3); border-radius:8px; padding:9px 12px }
  .qd-kpis label { display:block; color:var(--muted); font-size:12px; font-weight:600 }
  .qd-kpis b { font-size:18px }
  .qd-mandar { display:grid; grid-template-columns:repeat(auto-fit,minmax(230px,1fr)); gap:10px }
  .qd-op { border:1px solid var(--border); border-radius:10px; padding:12px; display:flex; flex-direction:column; gap:6px; background:var(--bg2) }
  .qd-op b { font-size:14.5px }
  .qd-op .acc { display:flex; gap:6px; flex-wrap:wrap; margin-top:auto; padding-top:6px }
  .qd-nuevo { font-size:11px; font-weight:700; color:var(--uva); background:rgba(138,47,116,.10); border-radius:10px; padding:1px 7px; align-self:flex-start }
  .qd-chip { display:inline-block; font-size:12px; border-radius:10px; padding:1px 8px; background:var(--bg3); margin-left:4px; white-space:nowrap }
  .qe-meses { display:flex; gap:6px; flex-wrap:wrap; margin:10px 0 0 }
  .qe-meses button { border-radius:20px }
</style>`;

const _MESES = ['', 'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const _nomMes = (m) => { const [a, b] = String(m || '').split('-'); return (_MESES[Number(b)] || m) + ' ' + (a || ''); };
const _cero = (x) => Math.abs(Number(x || 0)) < 0.005;
const _num = (x, d = 2) => (_cero(x) ? '<span class="muted">—</span>' : money(x, d));

/* ═══════════════════════════════ QUIÉN DEBE ═══════════════════════════════ */
let _qdQ = '', _qdMes = '', _qdOrden = 'total', _qdJuntos = true, _qdVend = false;
let _qdAbierto = '', _qdTab = 'meses', _qdMesDoc = '';
let _qdDatos = null;                       // { cob, clientes } de la última lectura

VIEWS.quienDebe = async () => {
  const main = document.getElementById('main');
  main.innerHTML = '<div class="card"><div class="muted">Cargando…</div></div>';
  const [cob, cl] = await Promise.all([
    api('/api/os/cobranzas' + (_qdMes ? '?mes=' + encodeURIComponent(_qdMes) : '')),
    api('/api/os/clientes'),
  ]);
  if (!cob || !cob.ok) { main.innerHTML = '<div class="card"><div class="nota err">No se pudo leer: ' + esc((cob && cob.error) || '') + '</div></div>'; return; }
  _qdDatos = { cob, clientes: (cl && cl.clientes) || [] };
  if (!_qdMesDoc) _qdMesDoc = cob.mes_anterior;
  qdPintar();
};

function qdPintar() {
  const { cob, clientes } = _qdDatos;
  const main = document.getElementById('main');
  const porId = Object.fromEntries(clientes.map((c) => [c.id, c]));
  const q = _qdQ.toLowerCase();
  const coincide = (f) => !q || String(f.codigo || '').toLowerCase().includes(q) || String(f.nombre || '').toLowerCase().includes(q);
  const conDeuda = (cob.filas || []).filter((f) => !_cero(f.total)).filter((f) => _qdVend || !f.es_vendedor);
  const alDia = (cob.filas || []).filter((f) => _cero(f.total) && !(_qdJuntos && (porId[f.cliente_id] || {}).factura_a)).length;

  /* QUIÉN PAGA. Un cliente que paga lo de otro (JJ → Marcelo) va adentro del que paga, para
     que lo que se le reclama a una persona se lea en una fila. Sólo si es la misma moneda: sumar
     pesos con dólares no dice nada. */
  // Los que paga otro se muestran adentro aunque estén en cero: JJ no debe nada porque lo suyo
  // ya se le cobra a Marcelo, y justamente eso es lo que hay que poder ver.
  const todas = (cob.filas || []).filter((f) => _qdVend || !f.es_vendedor);
  // Cobranzas no trae a los que nunca tuvieron saldo propio (JJ): van en cero, con la moneda del que paga.
  for (const c of clientes) {
    if (!c.factura_a || todas.some((f) => f.cliente_id === c.id)) continue;
    const padre = conDeuda.find((x) => x.cliente_id === c.factura_a); if (!padre) continue;
    todas.push({ cliente_id: c.id, codigo: c.codigo, nombre: c.nombre, moneda: padre.moneda, antes: 0, anterior: 0, actual: 0, total: 0, cuadra: true, esperando: 0, provisional: false, es_vendedor: !!c.es_vendedor });
  }
  const pagaPor = (f) => {
    const c = porId[f.cliente_id]; const a = c && c.factura_a;
    if (!_qdJuntos || !a) return null;
    const padre = conDeuda.find((x) => x.cliente_id === a && x.moneda === f.moneda);
    return padre ? a : null;
  };
  const raices = conDeuda.filter((f) => !pagaPor(f));
  const hijosDe = (f) => todas.filter((h) => pagaPor(h) === f.cliente_id && h.moneda === f.moneda);
  const sumar = (f) => hijosDe(f).reduce((a, h) => ({ antes: a.antes + h.antes, anterior: a.anterior + h.anterior, actual: a.actual + h.actual, total: a.total + h.total }),
    { antes: f.antes, anterior: f.anterior, actual: f.actual, total: f.total });
  const visibles = raices.filter((f) => coincide(f) || hijosDe(f).some(coincide));
  const orden = (a, b) => _qdOrden === 'codigo' ? String(a.codigo).localeCompare(String(b.codigo))
    : _qdOrden === 'antes' ? sumar(b).antes - sumar(a).antes : sumar(b).total - sumar(a).total;
  const monedas = [...new Set(visibles.map((f) => f.moneda))]
    .sort((a, b) => Math.abs((cob.totales[b] || {}).total || 0) - Math.abs((cob.totales[a] || {}).total || 0));

  const marcas = (f, c) => [
    f.es_vendedor ? '<span class="qd-chip">vendedor</span>' : '',
    f.esperando ? `<span class="qd-chip" style="background:var(--durazno-bg)" title="Avisó que pagó y todavía no se aprobó">⏳ ${f.esperando}</span>` : '',
    f.provisional ? '<span class="qd-chip" title="Tiene pagos con un cambio que todavía se puede mover">~ provisorio</span>' : '',
    f.cuadra ? '' : '<span class="qd-chip" style="color:var(--red)" title="Los meses no suman el total">⚠ no cierra</span>',
    c && (c.paneles || []).length > 1 ? `<span class="qd-chip" title="SuperAgentes y paneles a su nombre">🎰 ${(c.paneles || []).length}</span>` : '',
  ].join('');
  const fila = (f, hijo, suma) => {
    const c = porId[f.cliente_id]; const v = suma || f; const ab = _qdAbierto === f.cliente_id;
    const hs = hijo ? [] : hijosDe(f);
    return `<tr class="qd-fila${hijo ? ' qd-hijo' : ''}${ab ? ' abierta' : ''}" onclick="qdAbrir('${f.cliente_id}')">
      <td>${hijo ? '↳ ' : ''}<b>${esc(f.codigo)}</b> <span class="muted">${esc(f.nombre || '')}</span>${marcas(f, c)}
        ${hs.length ? `<div class="muted" style="font-size:12px">paga también lo de ${hs.map((h) => esc(h.codigo)).join(', ')} · la suma está acá</div>` : ''}
        ${hijo ? `<div class="muted" style="font-size:12px">lo paga ${esc((porId[c.factura_a] || {}).codigo || '')}</div>` : ''}</td>
      <td class="right"${v.antes > 0 ? ' style="font-weight:700"' : ''}>${money(v.antes)}</td>
      <td class="right">${money(v.anterior)}</td>
      <td class="right">${money(v.actual)}</td>
      <td class="right"><b>${money(v.total)}</b></td>
      <td class="right" style="width:24px">${ab ? '▾' : '▸'}</td>
    </tr>${ab ? `<tr class="qd-det"><td colspan="6"><div class="qd-caja" id="qd-det">${qdDetalleVacio(f)}</div></td></tr>` : ''}`;
  };

  const tabla = (mon) => {
    const rs = visibles.filter((f) => f.moneda === mon).sort(orden);
    const T = rs.reduce((a, f) => { const s = sumar(f); return { antes: a.antes + s.antes, anterior: a.anterior + s.anterior, actual: a.actual + s.actual, total: a.total + s.total }; },
      { antes: 0, anterior: 0, actual: 0, total: 0 });
    return `<div class="card"><h2>${esc(mon)} <span class="muted" style="font-weight:400;font-size:13px">· ${rs.length} que deben</span></h2>
      <div style="overflow-x:auto"><table style="min-width:100%">
        <thead><tr><th>Cliente</th>
          <th class="right" title="Lo que quedó sin cobrar de meses ya cerrados">Antes de ${esc(_nomMes(cob.mes_anterior))}</th>
          <th class="right">${esc(_nomMes(cob.mes_anterior))}</th><th class="right">${esc(_nomMes(cob.mes))}</th>
          <th class="right">Debe hoy</th><th></th></tr></thead>
        <tbody>${rs.map((f) => {
          const hs = hijosDe(f);
          return fila(f, false, hs.length ? sumar(f) : null) + (hs.length ? hs.map((h) => fila(h, true)).join('') : '');
        }).join('')}</tbody>
        <tfoot><tr><th>Total ${esc(mon)}${q || !_qdVend ? ' <span class="muted" style="font-weight:400">de lo que se ve</span>' : ''}</th>
          <th class="right">${money(T.antes)}</th><th class="right">${money(T.anterior)}</th><th class="right">${money(T.actual)}</th>
          <th class="right">${money(T.total)}</th><th></th></tr></tfoot>
      </table></div></div>`;
  };

  main.innerHTML = QD_STYLE + `
    <div class="card">
      <h2>📥 Quién debe</h2>
      <div class="muted" style="margin-bottom:10px">Tocá un cliente y se abre ahí mismo: su cuenta mes a mes, lo que se le cobró
        por cada SuperAgente, y qué mandarle. <b>Antes de ${esc(_nomMes(cob.mes_anterior))}</b> es lo que quedó de meses cerrados.</div>
      <div class="row" style="align-items:flex-end">
        <div style="flex:1 1 200px"><label>Buscar</label>
          <input id="qd-q" value="${esc(_qdQ)}" placeholder="código o nombre" oninput="qdBuscar(this.value)"/></div>
        <div style="flex:0"><label>Mes</label><input type="month" value="${esc(cob.mes)}" onchange="qdSet('mes', this.value)"/></div>
        <div style="flex:0"><label>Ordenar por</label><select onchange="qdSet('orden', this.value)">
          <option value="total"${_qdOrden === 'total' ? ' selected' : ''}>lo que debe hoy</option>
          <option value="antes"${_qdOrden === 'antes' ? ' selected' : ''}>lo más viejo</option>
          <option value="codigo"${_qdOrden === 'codigo' ? ' selected' : ''}>código</option></select></div>
        <div style="flex:0"><label style="display:flex;gap:6px;align-items:center;white-space:nowrap">
          <input type="checkbox" ${_qdJuntos ? 'checked' : ''} onchange="qdSet('juntos', this.checked)"> juntar por quién paga</label>
          <label style="display:flex;gap:6px;align-items:center;white-space:nowrap">
          <input type="checkbox" ${_qdVend ? 'checked' : ''} onchange="qdSet('vend', this.checked)"> ver vendedores</label></div>
      </div>
    </div>
    ${monedas.length ? monedas.map(tabla).join('') : '<div class="card"><div class="muted">Nadie debe nada.</div></div>'}
    ${alDia ? `<div class="muted" style="margin:10px 2px">Y ${alDia} cliente${alDia === 1 ? '' : 's'} en cero, que no se listan.</div>` : ''}`;
  if (_qdAbierto) qdDetalle();
}

function qdBuscar(v) { _qdQ = v; qdPintar(); setTimeout(() => { const i = document.getElementById('qd-q'); if (i) { i.focus(); i.setSelectionRange(i.value.length, i.value.length); } }, 0); }
function qdSet(k, v) {
  if (k === 'mes') { _qdMes = v; _qdMesDoc = ''; return VIEWS.quienDebe(); }
  if (k === 'orden') _qdOrden = v; if (k === 'juntos') _qdJuntos = v; if (k === 'vend') _qdVend = v;
  qdPintar();
}
function qdAbrir(id) { _qdAbierto = _qdAbierto === id ? '' : id; qdPintar(); }
function qdTab(t) { _qdTab = t; qdDetalle(); }
function qdMesDoc(m) { _qdMesDoc = m; qdDetalle(); }

function qdDetalleVacio() { return '<div class="muted">Cargando…</div>'; }

/* EL DETALLE DE UN CLIENTE. Tres solapas, la misma cabecera. Lo que trae cada una sale de la
   ruta que ya existía: la cuenta de /cuenta, el reparto por SuperAgente de /factura del mes. */
async function qdDetalle() {
  const box = document.getElementById('qd-det'); if (!box) return;
  const id = _qdAbierto; const c = (_qdDatos.clientes || []).find((x) => x.id === id) || {};
  const tabs = [['meses', '📅 Mes a mes'], ['sa', '🎰 Por SuperAgente'], ['mandar', '📤 Mandarle']];
  const cab = `<div class="qd-tabs">${tabs.map(([k, l]) => `<button class="${k === _qdTab ? '' : 'outline'} small" onclick="event.stopPropagation();qdTab('${k}')">${l}</button>`).join('')}
    <span style="flex:1"></span>
    ${_qdTab !== 'meses' ? `<label class="muted" style="display:flex;gap:6px;align-items:center">Mes
      <input type="month" value="${esc(_qdMesDoc)}" onclick="event.stopPropagation()" onchange="qdMesDoc(this.value)" style="width:auto"/></label>` : ''}</div>`;
  box.innerHTML = cab + '<div class="muted">Cargando…</div>';
  box.onclick = (e) => e.stopPropagation();
  let cuerpo = '';
  try {
    if (_qdTab === 'meses') cuerpo = await qdMeses(id);
    else if (_qdTab === 'sa') cuerpo = await qdSuperAgentes(id, c);
    else cuerpo = await qdMandar(id, c);
  } catch (e) { cuerpo = '<div class="nota err">No se pudo leer: ' + esc(e.message) + '</div>'; }
  if (_qdAbierto === id) box.innerHTML = cab + cuerpo;
}

async function qdMeses(id) {
  const r = await api('/api/os/cuenta/' + encodeURIComponent(id));
  if (!r.ok) return '<div class="nota err">' + esc(r.error || 'no se pudo leer la cuenta') + '</div>';
  const cc = r.cuenta || {}, meses = (r.meses || []).slice().reverse();
  const salio = (f) => !f ? '<span class="muted">no se generó</span>'
    : f.salio_at ? `${({ impresa: '🖨', copiada: '📋', link: '🔗', telegram: '✈️' }[f.salio_como] || '✔')} <span class="muted">${esc(String(f.salio_at).slice(0, 10))}</span>`
    : '<span style="color:var(--gold)">sin mandar</span>';
  return `<div class="qd-kpis">
      <div><label>Cargas sin pagar</label><b>${money(cc.fichas_pendientes)}</b> <span class="muted">USDT</span></div>
      <div><label>Externos sin pagar</label><b>${money(cc.proveedores_pendientes)}</b> <span class="muted">USDT</span></div>
      <div><label>Pagó</label><b style="color:var(--green)">${money(cc.pagos)}</b> <span class="muted">USDT</span></div>
      <div><label>Debe hoy</label><b>${money(cc.total)}</b> <span class="muted">USDT${cc.provisional ? ' · provisorio' : ''}</span></div>
    </div>
    <div style="overflow-x:auto"><table style="min-width:100%"><thead><tr><th>Mes</th><th class="right">Cargas</th><th class="right">Externos</th>
      <th class="right">Otros</th><th class="right">Facturado</th><th class="right">Pagó</th><th class="right">Debe al final del mes</th><th>Se le mandó</th><th></th></tr></thead>
    <tbody>${meses.map((m) => `<tr><td><b>${esc(_nomMes(m.mes))}</b></td>
      <td class="right">${_num(m.consumo)}</td><td class="right">${_num(m.externos)}</td><td class="right">${_num(m.otros)}</td>
      <td class="right"><b>${money(m.facturado)}</b></td><td class="right" style="color:var(--green)">${_num(m.pagos)}</td>
      <td class="right"><b>${money(m.saldo_acumulado)}</b></td><td>${salio(m.factura)}</td>
      <td class="right" style="white-space:nowrap"><button class="outline small" title="Elegir qué mandarle de este mes" onclick="qdMesDoc('${m.mes}');qdTab('mandar')">📤</button></td></tr>`).join('')
      || '<tr><td colspan="9" class="empty">Sin movimientos todavía.</td></tr>'}</tbody></table></div>`;
}

/* LO QUE SE LE COBRÓ POR CADA SUPERAGENTE. La factura ya lo trae partido por panel (cargas y
   externos); acá se juntan por panel y moneda en una sola tabla. Los PAGOS no: un pago entra a
   la cuenta del cliente, no a un SuperAgente, así que el saldo es uno solo. */
async function qdSuperAgentes(id, c) {
  const mes = _qdMesDoc;
  const f = await api('/api/os/factura/' + encodeURIComponent(id) + '?mes=' + encodeURIComponent(mes));
  if (!f.ok) return '<div class="nota err">' + esc(f.error || 'no se pudo armar el mes') + '</div>';
  const filas = {};
  const k = (p, d) => p + '|' + d;
  for (const p of f.porPanel || []) filas[k(p.panel, p.divisa)] = { panel: p.panel, divisa: p.divisa, cargas: p.cargas, monto: p.monto, cobra: Number(p.paga || 0), ext: 0 };
  for (const p of (f.externos && f.externos.porPanel) || []) {
    const x = filas[k(p.panel, p.divisa)] || (filas[k(p.panel, p.divisa)] = { panel: p.panel, divisa: p.divisa, cargas: 0, monto: 0, cobra: 0, ext: 0 });
    x.ext += Number(p.usdt || 0);
  }
  const l = Object.values(filas).sort((a, b) => (b.cobra + b.ext) - (a.cobra + a.ext));
  const T = l.reduce((a, x) => ({ cobra: a.cobra + x.cobra, ext: a.ext + x.ext }), { cobra: 0, ext: 0 });
  const inc = f.externos && f.externos.incompleto;
  return `${f.guardada ? `<div class="muted" style="margin-bottom:8px">Es la factura de ${esc(_nomMes(mes))} que ya se generó (${esc(String(f.guardada.generada_at).slice(0, 10))}): lo mismo que se le mandó.</div>` : ''}
    ${inc ? '<div class="nota-suave" style="margin:0 0 10px">⚠ Los externos de este mes están incompletos: el casino no contestó por algún panel.</div>' : ''}
    <div style="overflow-x:auto"><table style="min-width:100%"><thead><tr><th>SuperAgente / panel</th><th>Moneda</th><th class="right">Cargas</th>
      <th class="right">Fichas</th><th class="right">Se cobra por cargas</th><th class="right">Externos</th><th class="right">Total USDT</th></tr></thead>
    <tbody>${l.map((x) => `<tr><td><b>${esc(x.panel)}</b></td><td>${esc(x.divisa)}</td><td class="right">${x.cargas || '<span class="muted">—</span>'}</td>
      <td class="right">${_num(x.monto)}</td><td class="right">${_num(x.cobra)}</td><td class="right">${_num(x.ext)}</td>
      <td class="right"><b>${money(x.cobra + x.ext)}</b></td></tr>`).join('') || '<tr><td colspan="7" class="empty">Ese mes no tuvo cargas ni externos.</td></tr>'}</tbody>
    <tfoot><tr><th colspan="4">Total de ${esc(_nomMes(mes))}</th><th class="right">${money(T.cobra)}</th><th class="right">${money(T.ext)}</th>
      <th class="right">${money(T.cobra + T.ext)}</th></tr></tfoot></table></div>
    <div class="muted" style="margin-top:8px">Los pagos entran a la cuenta de ${esc(c.nombre || c.codigo || 'el cliente')}, no a un SuperAgente:
      lo que debe es uno solo. Esto es lo que se le cobró por cada uno.</div>`;
}

/* QUÉ MANDARLE. Las cuatro formas que se usan con un cliente, para el mes elegido. Lo que ya
   existe abre la factura de siempre (con su previa antes de mandar); lo que es nuevo está
   marcado y todavía no manda nada. */
async function qdMandar(id, c) {
  const mes = _qdMesDoc;
  const f = await api('/api/os/factura/' + encodeURIComponent(id) + '?mes=' + encodeURIComponent(mes));
  if (!f.ok) return '<div class="nota err">' + esc(f.error || 'no se pudo armar el mes') + '</div>';
  const g = f.guardada;
  const salio = g && g.salio_at ? `Ya salió el ${esc(String(g.salio_at).slice(0, 10))} (${esc(g.salio_como || '')}).` : 'Todavía no se le mandó.';
  const cons = (f.consumo && f.consumo.total_usdt) || 0, ext = (f.externos && f.externos.total_usdt) || 0;
  const paneles = (f.porPanel || []).length;
  const nuevo = '<span class="qd-nuevo">nuevo · todavía no manda</span>';
  const bloq = (t) => `<button class="outline small" disabled title="Se programa cuando apruebes la maqueta">${t}</button>`;
  return `<div class="muted" style="margin-bottom:10px">${esc(_nomMes(mes))} · ${salio} Debe hoy <b>${money(f.cuenta && f.cuenta.saldo)}</b> USDT.</div>
    <div class="qd-mandar">
      <div class="qd-op"><b>🧾 Todo junto</b>
        <div class="muted">Cargas + externos + lo que debe. Es la factura de siempre: se abre, se revisa y se manda por Telegram o con link.</div>
        <div>${money(f.totalMes_usdt)} USDT del mes</div>
        <div class="acc"><button class="small" onclick="qdAbrirFactura('${id}','${mes}')">Abrir y mandar</button></div></div>
      <div class="qd-op"><b>⚡ Sólo las cargas</b>${nuevo}
        <div class="muted">${f.consumo ? f.consumo.pedidos : 0} cargas · ${(f.consumo && f.consumo.porDivisa || []).map((d) => esc(d.divisa)).join(', ') || '—'}. Sin externos.</div>
        <div>${money(cons)} USDT</div>
        <div class="acc">${bloq('✈️ Telegram')}${bloq('🔗 Link')}${bloq('🖨 PDF')}</div></div>
      <div class="qd-op"><b>🏷 Sólo los externos</b>${nuevo}
        <div class="muted">${(f.externos && f.externos.items || []).length} líneas de proveedores, por panel.</div>
        <div>${money(ext)} USDT</div>
        <div class="acc"><button class="outline small" onclick="window.open('/api/os/externos-guardados/${encodeURIComponent(mes)}/${encodeURIComponent(id)}.html','_blank')">Ver el de hoy</button>${bloq('✈️ Telegram')}${bloq('🔗 Link')}</div></div>
      <div class="qd-op"><b>🎰 Uno por SuperAgente</b>${nuevo}
        <div class="muted">${paneles} SuperAgente${paneles === 1 ? '' : 's'}: cada uno con sus cargas y sus externos, para el que los maneja por separado.</div>
        <div>${(f.porPanel || []).slice(0, 4).map((p) => esc(p.panel)).join(' · ')}${paneles > 4 ? ' …' : ''}</div>
        <div class="acc"><button class="outline small" onclick="qdTab('sa')">Ver el reparto</button>${bloq('✈️ Mandar los ' + paneles)}</div></div>
    </div>`;
}
// Desde acá, la factura de siempre; el ← vuelve a Quién debe con el cliente abierto.
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
  window._pagDatos = r;                     // el envío al grupo y el CSV de la pantalla vieja leen esto
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
  main.innerHTML = QD_STYLE + `
    <div class="card"><h2>📥 Qué entró en ${esc(_nomMes(r.mes))}</h2>
      <div class="qd-kpis">
        <div><label>En pesos</label><b>$ ${money(T.pesos_ars)}</b><div class="muted">${(r.pesos || []).length} transferencias · equivale a ${money(T.pesos_usdt)} USDT</div></div>
        <div><label>En USDT</label><b>${money(T.usdt_usdt)}</b><div class="muted">${(r.usdt || []).length} pagos</div></div>
        <div><label>Todo, en USDT</label><b style="color:var(--green)">${money(Number(T.pesos_usdt || 0) + Number(T.usdt_usdt || 0))}</b><div class="muted">lo que bajó de las cuentas</div></div>
        <div><label>Rechazados</label><b>${rechazados.length}</b><div class="muted">comprobantes que no entraron</div></div>
      </div>
      <div class="qe-meses">${(r.meses || []).slice(0, 8).map((m) => `<button class="${m.mes === r.mes ? '' : 'outline'} small" onclick="qeSet('mes','${m.mes}')">${esc(_nomMes(m.mes))} · ${m.pagos}</button>`).join('')}</div>
    </div>
    <div class="card">
      <div class="row" style="align-items:flex-end">
        <div style="flex:0"><label>Ver</label><select onchange="qeSet('via', this.value)">
          <option value="todo"${_qeVia === 'todo' ? ' selected' : ''}>todo</option>
          <option value="pesos"${_qeVia === 'pesos' ? ' selected' : ''}>en pesos</option>
          <option value="usdt"${_qeVia === 'usdt' ? ' selected' : ''}>en USDT</option></select></div>
        <div style="flex:1 1 200px"><label>Buscar</label><input id="qe-q" value="${esc(_qeQ)}" placeholder="cliente, código, referencia o billetera" oninput="qeBuscar(this.value)"/></div>
        <div style="flex:0"><label>Ordenar por</label><select onchange="qeSet('orden', this.value)">
          <option value="fecha"${_qeOrden === 'fecha' ? ' selected' : ''}>fecha</option>
          <option value="monto"${_qeOrden === 'monto' ? ' selected' : ''}>monto</option>
          <option value="cliente"${_qeOrden === 'cliente' ? ' selected' : ''}>cliente</option></select></div>
        <div style="flex:0;display:flex;gap:6px">
          <button class="small" onclick="_movSub='cuenta';go('movimientos')" title="El formulario de siempre, en Pagos y cargas">＋ Registrar pago a mano</button>
          <button class="outline small" onclick="pagEnviar()" title="Sólo fecha y monto de los pagos en pesos, al grupo que concilia con el banco">📣 Pesos al grupo</button>
          <button class="outline small" onclick="qeCSV()">⬇ Excel</button></div>
      </div>
      <div class="muted" style="margin:8px 0">${l.length} de ${todos.length}${l.length > vis.length ? ' · se ven ' + vis.length : ''}</div>
      <div style="overflow-x:auto"><table style="min-width:100%"><thead><tr><th>Fecha</th><th>Cliente</th><th>Cómo</th>
        <th class="right">Recibido</th><th class="right">Equivale (USDT)</th><th>Referencia</th><th></th></tr></thead>
      <tbody>${vis.map((p) => `<tr><td>${esc(p.fecha)}${p.mes && p.mes !== String(p.fecha).slice(0, 7) ? `<div class="muted" style="font-size:12px">entra en ${esc(_nomMes(p.mes))}</div>` : ''}</td>
        <td><b>${esc(p.codigo || '')}</b> <span class="muted">${esc(p.cliente || '')}</span></td>
        <td>${p._via === 'pesos' ? '🏦 ' + esc(p.medio || 'transferencia') : '💠 USDT' + (p.billetera ? ' · ' + esc(p.billetera) : '')}</td>
        <td class="right">${p._via === 'pesos' ? '$ ' + money(p.ars) : money(p.usdt)}</td>
        <td class="right">${p.usdt != null ? money(p.usdt) : '<span class="muted" title="Todavía sin tipo de cambio">sin TC</span>'}${p.provisional ? ' <span class="qd-chip">prov.</span>' : ''}</td>
        <td>${esc(p.referencia || '')}</td>
        <td class="right">${p.comprobante && p.archivo ? `<button class="outline small" title="Ver el comprobante" onclick="window.open('/api/os/comprobantes/${p.comprobante}/archivo','_blank')">📎</button>` : ''}</td></tr>`).join('')
        || '<tr><td colspan="7" class="empty">No entró nada con ese filtro.</td></tr>'}</tbody></table></div>
      ${l.length > vis.length ? `<div style="text-align:center;margin-top:10px"><button class="outline small" onclick="_qeTope+=60;qePintar()">Ver 60 más</button></div>` : ''}
    </div>
    ${rechazados.length ? `<div class="card"><h2>✖ Rechazados en ${esc(_nomMes(r.mes))} <span class="muted" style="font-weight:400">· no bajaron nada</span></h2>
      <table><thead><tr><th>Cliente</th><th class="right">Declarado</th><th>Por qué</th></tr></thead><tbody>
      ${rechazados.slice(0, 20).map((x) => `<tr><td><b>${esc(x.codigo || '')}</b> <span class="muted">${esc(x.cliente_nombre || '')}</span></td>
        <td class="right">${money(x.monto)} ${esc(x.divisa || '')}</td><td class="muted">${esc(x.motivo || '')}</td></tr>`).join('')}</tbody></table>
      <div class="muted" style="margin-top:6px">El detalle completo sigue en <a href="#" onclick="_cmpFiltro='rechazado';_movSub='historial';go('movimientos');return false">Comprobantes resueltos</a>.</div></div>` : ''}`;
}
function qeBuscar(v) { _qeQ = v; _qeTope = 40; qePintar(); setTimeout(() => { const i = document.getElementById('qe-q'); if (i) { i.focus(); i.setSelectionRange(i.value.length, i.value.length); } }, 0); }
function qeSet(k, v) { _qeTope = 40; if (k === 'mes') { _qeMes = v; return VIEWS.queEntro(); } if (k === 'via') _qeVia = v; if (k === 'orden') _qeOrden = v; qePintar(); }
/* Punto y coma y coma decimal, como el Excel en castellano (igual que pagCSV). */
function qeCSV() {
  const { r } = _qeDatos; const num = (x) => (x == null ? '' : String(Number(x).toFixed(2)).replace('.', ','));
  const qq = (x) => '"' + String(x == null ? '' : x).replace(/"/g, '""') + '"';
  const filas = [...(r.pesos || []).map((p) => ['pesos', p, num(p.ars)]), ...(r.usdt || []).map((p) => ['USDT', p, num(p.usdt)])];
  const csv = '﻿' + ['Fecha;Entra en;Código;Cliente;Cómo;Recibido;Equivale (USDT);Billetera;Referencia']
    .concat(filas.map(([v, p, rec]) => [p.fecha, p.mes, qq(p.codigo), qq(p.cliente), v, rec, num(p.usdt), qq(p.billetera), qq(p.referencia)].join(';'))).join('\n');
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  a.download = 'entro-' + r.mes + '.csv'; a.click();
}
