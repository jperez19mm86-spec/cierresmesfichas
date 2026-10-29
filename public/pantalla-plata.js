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
  .qd-versiones { font-size:12.5px; color:var(--muted); display:flex; gap:6px; flex-wrap:wrap; align-items:center }
  .qd-arriba { display:flex; gap:10px; align-items:center; flex-wrap:wrap }
  .qd-arriba input { flex:1 1 220px; width:auto }
  .qd-arriba select { width:auto }
  .qd-ley { display:flex; gap:6px; align-items:center; flex-wrap:wrap; color:var(--muted); font-size:12.5px }
  .qd-tabla td { vertical-align:middle }
  .qd-debe { font-size:15px; font-weight:700; white-space:nowrap }
  .qd-meses { display:flex; gap:4px; flex-wrap:wrap }
  .qd-m { display:inline-block; min-width:34px; text-align:center; font-size:12px; font-weight:600; border-radius:6px; padding:2px 6px; background:var(--bg3); color:var(--muted) }
  .qd-m.ok { background:rgba(46,158,99,.16); color:var(--green) }
  .qd-m.parcial { background:var(--durazno-bg); color:var(--durazno) }
  .qd-m.nada { background:#ece6ea; color:#5b5058 }
  .qd-m.demas { background:rgba(138,47,116,.12); color:var(--uva) }
  .qd-m.vacio { background:transparent; color:#c9bfc6 }
  .qd-pago { font-size:12px; color:var(--green); white-space:nowrap }
  .qe-barra { display:flex; flex-wrap:wrap; gap:8px; align-items:center }
  .qe-barra button, .qe-barra select { white-space:nowrap; width:auto }
  .qe-barra input { flex:1 1 220px; min-width:180px; width:auto }
  .qe-seg { display:flex; gap:4px }
  .qe-acc { display:flex; gap:6px; flex-wrap:wrap; margin-left:auto }
  .qe-tabla td { vertical-align:middle }
  .qe-fecha { white-space:nowrap; color:var(--muted) }
  .qe-esde { width:auto; min-width:0; padding:3px 6px; font-size:13px; border-radius:6px }
  .qe-ref { max-width:240px }
  .qe-wallet { display:inline-block; font-size:12px; font-weight:600; border-radius:10px; padding:1px 8px; margin-right:6px; background:rgba(59,111,180,.12); color:#2d5a99; white-space:nowrap }
  .qe-txt { display:inline-block; max-width:170px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; vertical-align:bottom; font-size:12px; color:var(--muted) }
  .qe-clip { background:none; border:1px solid var(--border); border-radius:6px; padding:2px 7px; cursor:pointer }
  .qd-pago.de-mas { color:var(--durazno); font-weight:700 }
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
let _qdQ = '', _qdMes = '', _qdOrden = 'total', _qdVend = false;
let _qdAbierto = '', _qdTab = 'cuenta', _qdMesDoc = '', _qdDoc = 'todo';
let _qdDatos = null;                       // { cob, clientes } de la última lectura

VIEWS.quienDebe = async () => {
  const main = document.getElementById('main');
  main.innerHTML = '<div class="card"><div class="muted">Cargando…</div></div>';
  /* UN SOLO PEDIDO: lo que debe cada uno y, de los últimos cuatro meses, lo que generó y lo que pagó
     de la deuda de ese mes (por «a qué mes entra», que es lo que se elige al cargar el pago). */
  const [cob, cl] = await Promise.all([
    api('/api/os/quien-debe' + (_qdMes ? '?mes=' + encodeURIComponent(_qdMes) : '')),
    api('/api/os/clientes'),
  ]);
  if (!cob || !cob.ok) { main.innerHTML = '<div class="card"><div class="nota err">No se pudo leer: ' + esc((cob && cob.error) || '') + '</div></div>'; return; }
  const meses = cob.meses;
  const clientes = (cl && cl.clientes) || [];
  _qdDatos = { cob, clientes, meses, porCliente: _qdPorMes(cob, meses) };
  if (!_qdMesDoc) _qdMesDoc = cob.mes_anterior;
  qdPintar();
};

/* CADA CLIENTE, MES POR MES: generó, pagó y lo que queda; arriba «antes» con lo de meses anteriores.
   «Antes» sale por diferencia contra lo que debe hoy, así la fila siempre cierra. Una cuenta sin nada
   generado mes a mes (vieja, cargada a mano): los dos últimos meses salen de Cobranzas y lo demás va
   a «antes». */
function _qdPorMes(cob, meses) {
  const out = {};
  for (const f of (cob.filas || []).filter((x) => !_chico(x.total))) {
    const pm = f.porMes || { hayMesAMes: false, gen: {}, pag: {} };
    const gen = {}, pag = {};
    for (const m of meses) {
      pag[m] = Number(pm.pag[m] || 0);
      gen[m] = pm.hayMesAMes ? Number(pm.gen[m] || 0)
        : m === cob.mes ? f.actual + pag[m] : m === cob.mes_anterior ? f.anterior + pag[m] : 0;
    }
    const antes = f.total - meses.reduce((a, m) => a + gen[m] - pag[m], 0);
    out[f.cliente_id] = { antes, gen, pag, total: f.total };
  }
  return out;
}

function qdPintar() {
  const { cob, clientes, meses, porCliente } = _qdDatos;
  const main = document.getElementById('main');
  const porId = Object.fromEntries(clientes.map((c) => [c.id, c]));
  const q = _qdQ.toLowerCase();
  const coincide = (f) => !q || String(f.codigo || '').toLowerCase().includes(q) || String(f.nombre || '').toLowerCase().includes(q);
  const vendedores = (cob.filas || []).filter((f) => f.es_vendedor && !_chico(f.total)).length;
  const conDeuda = (cob.filas || []).filter((f) => !_chico(f.total)).filter((f) => _qdVend || !f.es_vendedor);
  /* El que paga lo de otro (JJ → Marcelo) suma al otro en su fila; el detalle lo dice. */
  const pagaPor = (f) => { const a = (porId[f.cliente_id] || {}).factura_a; return a && conDeuda.some((x) => x.cliente_id === a && x.moneda === f.moneda) ? a : null; };
  const raices = conDeuda.filter((f) => !pagaPor(f));
  const hijosDe = (f) => conDeuda.filter((h) => pagaPor(h) === f.cliente_id);
  const vacio = () => ({ antes: 0, gen: Object.fromEntries(meses.map((m) => [m, 0])), pag: Object.fromEntries(meses.map((m) => [m, 0])), total: 0 });
  const datosDe = (f) => porCliente[f.cliente_id] || { ...vacio(), antes: f.total, total: f.total };
  const sumar = (f) => [f, ...hijosDe(f)].map(datosDe).reduce((a, x) => ({ antes: a.antes + x.antes, total: a.total + x.total,
    gen: Object.fromEntries(meses.map((m) => [m, a.gen[m] + x.gen[m]])), pag: Object.fromEntries(meses.map((m) => [m, a.pag[m] + x.pag[m]])) }), vacio());
  const visibles = raices.filter((f) => coincide(f) || hijosDe(f).some(coincide));
  const orden = (a, b) => (_qdOrden === 'codigo' ? String(a.codigo).localeCompare(String(b.codigo)) : sumar(b).total - sumar(a).total);
  const monedas = [...new Set(visibles.map((f) => f.moneda))].sort((a, b) => (a === 'USDT' ? -1 : b === 'USDT' ? 1 : a.localeCompare(b)));

  /* UN MES, UN CUADRITO. Verde: lo de ese mes está pagado. Naranja: pagó una parte. Gris: no pagó
     nada. Violeta: pagó más de lo que generó (seguramente es de otro mes). Al pasar el mouse, los
     números. El detalle con generó / pagó / queda está al tocar el cliente. */
  const cuadro = (m, g, p) => {
    const queda = g - p;
    const tipo = _cero(g) && _cero(p) ? 'vacio' : queda <= 0.5 && queda >= -0.5 ? 'ok' : queda < -0.5 ? 'demas' : _cero(p) ? 'nada' : 'parcial';
    const t = tipo === 'vacio' ? 'Sin movimiento' : `Generó ${money(g)} · pagó ${money(p)}` + (tipo === 'demas' ? ' · pagó de más: revisá de qué mes es' : queda > 0.5 ? ' · queda ' + money(queda) : '');
    return `<span class="qd-m ${tipo}" title="${esc(_nomMes(m))}: ${t}">${esc(_MESES[Number(m.slice(5))].slice(0, 3))}</span>`;
  };
  const fila = (f) => {
    const v = sumar(f); const ab = _qdAbierto === f.cliente_id;
    return `<tr class="qd-fila${ab ? ' abierta' : ''}" onclick="qdAbrir('${f.cliente_id}')">
      <td><b>${esc(f.codigo)}</b> <span class="muted">${esc(f.nombre || '')}</span>${f.esperando ? ` <span class="qd-chip espera" title="Comprobantes esperando que los apruebes">⏳ ${f.esperando}</span>` : ''}</td>
      <td><div class="qd-meses">${!_cero(v.antes) ? `<span class="qd-m ${v.antes > 0.5 ? 'nada' : 'demas'}" title="Antes de ${esc(_nomMes(meses[0]))}: ${v.antes > 0 ? 'queda ' + money(v.antes) : 'a favor ' + money(-v.antes)}">antes</span>` : ''}${meses.map((m) => cuadro(m, v.gen[m], v.pag[m])).join('')}</div></td>
      <td class="right qd-debe">${_saldo(v.total)}</td>
    </tr>${ab ? `<tr class="qd-det"><td colspan="3"><div class="qd-caja" id="qd-det"><div class="muted">Cargando…</div></div></td></tr>` : ''}`;
  };
  const tabla = (mon) => {
    const rs = visibles.filter((f) => f.moneda === mon).sort(orden);
    const T = rs.reduce((a, f) => a + sumar(f).total, 0);
    return `<div class="card"><div style="overflow-x:auto"><table class="qd-tabla" style="min-width:100%">
        <thead><tr><th>${esc(mon === 'ARS' ? 'Cuentas en pesos' : 'Cuentas en dólares')} · ${rs.length}</th><th>Meses</th><th class="right">Debe hoy</th></tr></thead>
        <tbody>${rs.map(fila).join('')}</tbody>
        <tfoot><tr><th colspan="2">Total</th><th class="right">${money(T)} ${esc(mon)}</th></tr></tfoot>
      </table></div></div>`;
  };

  main.innerHTML = QD_STYLE + `
    <div class="card qd-arriba">
      <input id="qd-q" value="${esc(_qdQ)}" placeholder="Buscar cliente" oninput="qdBuscar(this.value)"/>
      <select onchange="qdSet('orden', this.value)" title="Ordenar">
        <option value="total"${_qdOrden === 'total' ? ' selected' : ''}>Más deuda primero</option>
        <option value="codigo"${_qdOrden === 'codigo' ? ' selected' : ''}>Por código</option></select>
      <div class="qd-ley"><span class="qd-m ok">ok</span> pagado <span class="qd-m parcial">½</span> pagó una parte <span class="qd-m nada">—</span> sin pagar <span class="qd-m demas">+</span> pagó de más</div>
    </div>
    ${monedas.length ? monedas.map(tabla).join('') : '<div class="card"><div class="muted">Nadie debe nada.</div></div>'}
    <div class="muted" style="margin:10px 2px">${(cob.filas || []).filter((f) => _chico(f.total)).length} al día${vendedores ? ` · <a href="#" onclick="qdSet('vend', ${!_qdVend});return false">${_qdVend ? 'ocultar' : 'ver'} vendedores (${vendedores})</a>` : ''}</div>`;
  if (_qdAbierto) qdDetalle();
}

function qdBuscar(v) { _qdQ = v; qdPintar(); setTimeout(() => { const i = document.getElementById('qd-q'); if (i) { i.focus(); i.setSelectionRange(i.value.length, i.value.length); } }, 0); }
function qdSet(k, v) {
  if (k === 'mes') { _qdMes = v; _qdMesDoc = ''; return VIEWS.quienDebe(); }
  if (k === 'orden') _qdOrden = v; if (k === 'vend') _qdVend = v;
  qdPintar();
}
function qdAbrir(id) { _qdAbierto = _qdAbierto === id ? '' : id; _qdDoc = 'todo'; _qdVer = null; qdPintar(); }
function qdTab(t) { _qdTab = t; qdDetalle(); }
function qdMesDoc(m) { _qdMesDoc = m; _qdVer = null; qdDetalle(); }
function qdElegirDoc(d) { _qdDoc = d; _qdVer = null; qdDetalle(); }

/* EL DETALLE DE UN CLIENTE. Cuatro solapas; la primera es la cuenta: mes por mes, lo que generó, lo
   que pagó de ese mes y lo que queda. Las otras, para actuar: registrar un pago, mandarle algo, y lo
   cobrado por SuperAgente para el que maneja varios. */
async function qdDetalle() {
  const box = document.getElementById('qd-det'); if (!box) return;
  const id = _qdAbierto; const c = (_qdDatos.clientes || []).find((x) => x.id === id) || {};
  box.onclick = (e) => e.stopPropagation();
  const f = (_qdDatos.cob.filas || []).find((x) => x.cliente_id === id) || {};
  const mon = f.moneda || (c.deuda && c.deuda.moneda) || 'USDT';
  const tabs = [['cuenta', 'Cuenta'], ['pago', 'Registrar pago'], ['mandar', 'Mandarle'], ['sa', 'Por SuperAgente']];
  if (!tabs.some(([k]) => k === _qdTab)) _qdTab = 'cuenta';
  const barra = `<div class="qd-barra">${tabs.map(([k, l]) => `<button class="${k === _qdTab ? '' : 'outline'} small" onclick="qdTab('${k}')">${l}</button>`).join('')}
    <span class="esp"></span>${_qdTab === 'sa' || _qdTab === 'mandar' ? `<input type="month" value="${esc(_qdMesDoc)}" onchange="qdMesDoc(this.value)" style="width:auto" title="Mes"/>` : ''}</div>`;
  box.innerHTML = barra + '<div class="muted">Cargando…</div>';
  let cuerpo = '';
  try {
    if (_qdTab === 'cuenta') cuerpo = qdCuenta(c, mon);
    else if (_qdTab === 'pago') cuerpo = await qdFormPago(c, { moneda: mon });
    else {
      const [fa, cuenta, vers] = await Promise.all([api('/api/os/factura/' + encodeURIComponent(id) + '?mes=' + encodeURIComponent(_qdMesDoc)),
        _qdTab === 'mandar' ? api('/api/os/cuenta/' + encodeURIComponent(id)) : Promise.resolve(null),
        _qdTab === 'mandar' ? api('/api/os/facturas-guardadas/' + encodeURIComponent(id) + '/' + encodeURIComponent(_qdMesDoc) + '/versiones') : Promise.resolve(null)]);
      if (!fa.ok) cuerpo = '<div class="nota err">' + esc(fa.error || 'No se pudo armar ese mes') + '</div>';
      else cuerpo = _qdTab === 'sa' ? qdSuperAgentes(fa) : qdMandar(fa, cuenta, c, (vers && vers.versiones) || []);
    }
  } catch (e) { cuerpo = '<div class="nota err">No se pudo leer: ' + esc(e.message) + '</div>'; }
  if (_qdAbierto === id) box.innerHTML = barra + cuerpo;
}

/* La cuenta de un cliente en sus tres números por mes. «Queda» es lo que generó menos lo que pagó de
   ese mes; abajo, lo que debe hoy. Si pagó de más en un mes, se dice que seguramente es de otro. */
function qdCuenta(c, mon) {
  const d = (_qdDatos.porCliente || {})[c.id];
  if (!d) return '<div class="muted">Sin movimientos en estos meses.</div>';
  const meses = (_qdDatos.meses || []).slice().reverse();
  const hijos = (_qdDatos.clientes || []).filter((x) => x.factura_a === c.id).map((x) => x.codigo);
  const fila = (lbl, g, p) => { const q = g - p; return `<tr><td>${lbl}</td><td class="right">${_num(g)}</td><td class="right" style="color:var(--green)">${_num(p)}</td>
    <td class="right">${q < -0.5 ? `<span style="color:var(--uva)" title="Pagó más de lo que generó: seguramente es de otro mes. Se cambia en Qué entró → «Es de».">pagó de más ${money(-q)}</span>` : _saldo(q)}</td></tr>`; };
  return `<div style="overflow-x:auto"><table style="min-width:100%"><thead><tr><th>Mes</th><th class="right">Generó</th><th class="right">Pagó</th><th class="right">Queda</th></tr></thead>
    <tbody>${meses.map((m) => fila('<b>' + esc(_nomMes(m)) + '</b>', d.gen[m], d.pag[m])).join('')}
      ${!_cero(d.antes) ? fila('Antes de ' + esc(_nomMes(_qdDatos.meses[0])), d.antes, 0) : ''}</tbody>
    <tfoot><tr><th colspan="3">Debe hoy</th><th class="right">${_saldo(d.total)} ${esc(mon)}</th></tr></tfoot></table></div>
    ${hijos.length ? `<div class="muted">También paga lo de ${hijos.map(esc).join(', ')}.</div>` : ''}`;
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
let _qdVer = null;                         // la versión vieja que se está mirando en «Todo junto»
function qdVerVersion(n) { _qdVer = _qdVer === n ? null : n; qdDetalle(); }
function qdMandar(f, cuenta, c, versiones = []) {
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
  const vieja = _qdDoc === 'todo' && _qdVer ? versiones.find((v) => v.version === _qdVer) : null;
  if (vieja) doc = { texto: vieja.texto, total: vieja.total_usdt };
  else if (_qdDoc === 'todo') { doc = { texto: f.texto, total: f.totalMes_usdt }; existe = true; }
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
  const yaSalio = _qdDoc === 'todo' && !vieja ? (g && g.salio_at ? `Salió el ${esc(String(g.salio_at).slice(0, 10))} (${esc(g.salio_como || '')})`
    : versiones.length ? '<span style="color:var(--durazno)">Ésta todavía no se le mandó</span>' : '') : '';
  /* LO QUE SE LE MANDÓ ANTES. Si la factura se regeneró con otros números después de mandarla, lo
     que recibió el cliente quedó guardado como versión: se ve acá, tal como salió. */
  const antes = _qdDoc === 'todo' && versiones.length ? `<div class="qd-versiones">Antes se le mandó: ${versiones.map((v) =>
    `<button class="${_qdVer === v.version ? '' : 'outline '}small" onclick="qdVerVersion(${v.version})" title="Salió el ${esc(String(v.salio_at || '').slice(0, 10))} (${esc(v.salio_como || '')})">v${v.version} · ${_$(v.total_usdt)} · ${esc(String(v.salio_at || '').slice(5, 10).split('-').reverse().join('/'))}</button>`).join(' ')}</div>` : '';
  const bloq = (t) => `<button class="outline small" disabled title="Todavía no está programado">${t}</button>`;
  const acciones = existe
    ? `<button class="small" onclick="qdAbrirFactura('${c.id}','${f.mes}')">Revisar y mandar</button>`
    : `<span class="qd-nuevo">Nuevo · todavía no se manda</span> ${bloq('✈️ Telegram')} ${bloq('🔗 Link')}`;
  return `<div class="qd-doc">
      <div class="qd-opc">${opciones.map(([k, l, t]) =>
        `<button class="${k === _qdDoc ? '' : 'outline'}" data-k="${esc(k)}" onclick="qdElegirDoc(this.dataset.k)"><b>${esc(l)}</b><span>${_$(t)}</span></button>`).join('')}</div>
      <div style="display:flex;flex-direction:column;gap:8px;min-width:0">
        ${control}
        ${vieja ? `<div class="qd-control">Ésta es la v${vieja.version}: la que salió el ${esc(String(vieja.salio_at || '').slice(0, 10))}. <a href="#" onclick="qdVerVersion(${vieja.version});return false">Volver a la de ahora</a></div>` : ''}
        <div class="qd-msg">${doc ? _qdTg(doc.texto) : '<span class="muted">No hay nada de esto en ese mes.</span>'}</div>
        <div class="qd-barra">${vieja ? '' : acciones}<span class="esp"></span><span class="muted">${yaSalio}</span></div>
        ${antes}
      </div></div>`;
}
/* REGISTRAR UN PAGO, DICIENDO DE QUÉ MES ES. «Gabriel pagó el 26 de octubre 4.077 y es de la deuda
   de septiembre»: la fecha es cuándo entró la plata y el mes es la deuda que cancela. Cada mes se
   muestra con lo que le queda, y viene elegido el más viejo que todavía debe. Usa la ruta de
   siempre del pago a mano (/movimientos/pago), que ya guarda los dos datos. */
async function qdFormPago(c, cc) {
  const d = (_qdDatos.porCliente || {})[c.id];
  const meses = (_qdDatos.meses || []).slice().reverse();
  const queda = (m) => (d ? d.gen[m] - d.pag[m] : 0);
  const sugerido = (meses.slice().reverse().find((m) => queda(m) > 0.5)) || meses[0];
  const personas = await api('/api/os/personas');
  const mon = cc.moneda || 'USDT';
  return `<form class="qd-form" onsubmit="event.preventDefault();qdRegistrarPago('${c.id}')">
    <div class="row" style="align-items:flex-end">
      <div style="flex:0"><label>Fecha</label><input type="date" id="qp-fecha" value="${new Date().toISOString().slice(0, 10)}"/></div>
      <div style="flex:1 1 140px"><label>Monto</label><input id="qp-monto" inputmode="decimal" placeholder="0,00" required/></div>
      <div style="flex:0"><label>Moneda</label><select id="qp-moneda">${['USDT', 'ARS'].map((x) => `<option${x === mon ? ' selected' : ''}>${x}</option>`).join('')}</select></div>
      <div style="flex:0"><label>Cómo pagó</label><select id="qp-medio"><option value="usdt">USDT</option><option value="cvu"${mon === 'ARS' ? ' selected' : ''}>Transferencia</option><option value="efectivo">Efectivo</option></select></div>
    </div>
    <div class="row" style="align-items:flex-end;margin-top:10px">
      <div style="flex:1 1 260px"><label>¿De qué mes es la deuda que paga?</label><select id="qp-mes">${meses.map((m) =>
        `<option value="${m}"${m === sugerido ? ' selected' : ''}>${esc(_nomMes(m))} — ${queda(m) > 0.5 ? 'queda ' + money(queda(m)) + ' ' + esc(mon) : 'pagado'}</option>`).join('')}</select></div>
      <div style="flex:1 1 180px"><label>¿Quién la recibió?</label><select id="qp-recibio"><option value="">—</option>${((personas && personas.personas) || []).map((x) => `<option value="${esc(x.id)}">${esc(x.nombre)}</option>`).join('')}</select></div>
      <div style="flex:0"><button class="small" type="submit">Registrar pago</button></div>
    </div>
    ${d && !_cero(d.antes) ? `<div class="muted" style="margin-top:8px">Además le quedan ${money(d.antes)} ${esc(mon)} de antes de ${esc(_nomMes(_qdDatos.meses[0]))}.</div>` : ''}
  </form>`;
}
async function qdRegistrarPago(id) {
  const v = (k) => (document.getElementById(k) || {}).value || '';
  const monto = String(v('qp-monto')).replace(/\./g, '').replace(',', '.');
  if (!(Number(monto) > 0)) return toast('Poné el monto');
  const enPesos = v('qp-moneda') === 'ARS';
  const r = await api('/api/os/movimientos/pago', { method: 'POST', body: JSON.stringify({
    cliente_id: id, fecha: v('qp-fecha'), mes_cierre: v('qp-mes'), medio: v('qp-medio'), recibido_por: v('qp-recibio') || null,
    moneda: enPesos ? 'ARS' : 'USDT', monto_ars: enPesos ? monto : undefined, monto_usdt: enPesos ? undefined : monto, avisar: false,
  }) });
  if (!r || !r.ok) return toast('No se registró: ' + ((r && r.error) || ''));
  toast('Pago registrado en ' + _nomMes(v('qp-mes')));
  VIEWS.quienDebe();
}
// La factura de siempre (con su previa antes de mandar); el ← vuelve acá con el cliente abierto.
function qdAbrirFactura(id, mes) { _facVolverA = 'quienDebe'; _facMes = mes; verFactura(id); }

/* ═══════════════════════════════ QUÉ ENTRÓ ═══════════════════════════════ */
let _qeMes = '', _qeVia = 'todo', _qeQ = '', _qeOrden = 'fecha', _qeTope = 40, _qeVista = 'pagos';
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
  /* POR FECHA, NO POR MES DE LA DEUDA. /pagos agrupa por «a qué mes entra» (el mes de la deuda que
     paga); acá la pregunta es cuándo entró la plata. Se juntan los pagos de todos los meses y se
     filtra por la fecha: lo que Gabriel pagó el 26-oct de la deuda de septiembre entra en octubre. */
  const mesesDeuda = (r.meses || []).map((m) => m.mes).slice(0, 12);
  const todos = await Promise.all(mesesDeuda.map((m) => (m === r.mes ? Promise.resolve(r) : api('/api/os/pagos?mes=' + encodeURIComponent(m)))));
  const lista = (k) => todos.flatMap((x) => (x && x[k]) || []);
  _qeDatos = { r, todosPesos: lista('pesos'), todosUsdt: lista('usdt'), mesesDeuda,
    rechazados: ((rech && rech.comprobantes) || []).filter((x) => String(x.resuelto_at || x.creado_at || '').slice(0, 7) === r.mes) };
  /* POR CLIENTE: lo que pagó cada uno, mes por mes. Seis meses hacia atrás desde el elegido. */
  if (_qeVista === 'clientes') {
    const cl = await api('/api/os/clientes');
    const meses = [...new Set([..._qeDatos.todosPesos, ..._qeDatos.todosUsdt].map((p) => String(p.fecha).slice(0, 7)))].filter((m) => m <= r.mes).sort().reverse().slice(0, 6);
    const pagos = meses.map((m) => ({ pesos: _qeDatos.todosPesos.filter((p) => String(p.fecha).slice(0, 7) === m), usdt: _qeDatos.todosUsdt.filter((p) => String(p.fecha).slice(0, 7) === m) }));
    _qeDatos.porMes = { meses, pagos, clientes: (cl && cl.clientes) || [] };
  }
  qePintar();
};

function qePintar() {
  if (_qeVista === 'clientes' && _qeDatos.porMes) return qePorCliente();
  const { r, rechazados, todosPesos, todosUsdt, mesesDeuda } = _qeDatos;
  const main = document.getElementById('main');
  const delMes = (p) => String(p.fecha).slice(0, 7) === r.mes;
  const pesos = todosPesos.filter(delMes), usd = todosUsdt.filter(delMes);
  const todos = [...pesos.map((p) => ({ ...p, _via: 'pesos' })), ...usd.map((p) => ({ ...p, _via: 'usdt' }))];
  const q = _qeQ.toLowerCase();
  const l = todos.filter((p) => _qeVia === 'todo' || p._via === _qeVia)
    .filter((p) => !q || [p.cliente, p.codigo, p.referencia, p.billetera].some((x) => String(x || '').toLowerCase().includes(q)))
    .sort((a, b) => _qeOrden === 'monto' ? Number(b.usdt || 0) - Number(a.usdt || 0)
      : _qeOrden === 'cliente' ? String(a.cliente).localeCompare(String(b.cliente)) : String(b.fecha).localeCompare(String(a.fecha)));
  // Los totales, de lo que entró en el mes (por fecha), no de lo imputado a ese mes.
  const sumaDe = (l, k) => l.reduce((a, p) => a + Number(p[k] || 0), 0);
  const T = { pesos_ars: sumaDe(pesos, 'ars'), pesos_usdt: sumaDe(pesos, 'usdt'), usdt_usdt: sumaDe(usd, 'usdt') };
  const vis = l.slice(0, _qeTope);
  const via = (k, lbl, n) => `<button class="${_qeVia === k ? '' : 'outline'} small" onclick="qeSet('via','${k}')">${lbl} · ${n}</button>`;
  const dia = (f) => String(f).slice(5).split('-').reverse().join('/');
  main.innerHTML = QD_STYLE + `
    <div class="card" style="display:flex;flex-direction:column;gap:12px">
      ${_qeVistas()}
      <div class="qd-barra">${(r.meses || []).slice(0, 8).map((m) => `<button class="${m.mes === r.mes ? '' : 'outline'} small" onclick="qeSet('mes','${m.mes}')">${esc(_nomMes(m.mes))}</button>`).join('')}</div>
      <div class="qd-cuenta">
        <div><span>Pesos</span> $ ${money(T.pesos_ars)} <span>≈ ${money(T.pesos_usdt)} USDT</span></div>
        <div><span>+ USDT</span> ${money(T.usdt_usdt)}</div>
        <div><span>= Entró</span> <b style="color:var(--green)">${money(Number(T.pesos_usdt || 0) + Number(T.usdt_usdt || 0))} USDT</b></div>
      </div>
    </div>
    <div class="card">
      <div class="qe-barra">
        <div class="qe-seg">${via('todo', 'Todo', todos.length)}${via('pesos', 'Pesos', pesos.length)}${via('usdt', 'USDT', usd.length)}</div>
        <input id="qe-q" value="${esc(_qeQ)}" placeholder="Buscar cliente, billetera o referencia" oninput="qeBuscar(this.value)"/>
        <select onchange="qeSet('orden', this.value)" title="Ordenar">
          <option value="fecha"${_qeOrden === 'fecha' ? ' selected' : ''}>Por fecha</option>
          <option value="monto"${_qeOrden === 'monto' ? ' selected' : ''}>Por monto</option>
          <option value="cliente"${_qeOrden === 'cliente' ? ' selected' : ''}>Por cliente</option></select>
        <div class="qe-acc">
          <button class="small" onclick="_movSub='cuenta';go('movimientos')">＋ Pago a mano</button>
          <button class="outline small" onclick="pagEnviar()" title="Fecha y monto de los pagos en pesos, al grupo que concilia con el banco">📣 Pesos al grupo</button>
          <button class="outline small" onclick="qeCSV()" title="Bajar en Excel">⬇ Excel</button></div>
      </div>
      <!-- Dos columnas de plata, una por moneda: cada pago llena la suya. Al de pesos se le ve al lado
           cuánto valió en dólares (lo que le bajó la deuda); al de USDT, la billetera a la que entró. -->
      <div style="overflow-x:auto;margin-top:12px"><table class="qe-tabla" style="min-width:100%"><thead><tr><th>Fecha</th><th>Cliente</th>
        <th class="right">Pesos</th><th class="right">USDT</th><th title="De qué mes es la deuda que paga. Se puede cambiar">Es de</th><th>Entró a / referencia</th><th></th></tr></thead>
      <tbody>${vis.map((p) => `<tr><td class="qe-fecha">${esc(dia(p.fecha))}</td>
        <td><b>${esc(p.codigo || '')}</b> <span class="muted">${esc(p.cliente || '')}</span></td>
        <td class="right">${p._via === 'pesos' ? '<b>$ ' + money(p.ars) + '</b>' : '<span class="muted">—</span>'}</td>
        <td class="right">${p._via === 'usdt' ? '<b>' + money(p.usdt) + '</b>'
          : p.usdt != null ? `<span class="muted" title="Lo que le bajó de la deuda, en dólares">≈ ${money(p.usdt)}</span>${p.provisional ? ' <span class="qd-chip" title="Con un cambio que todavía se puede mover">~</span>' : ''}`
          : '<span class="qd-chip espera" title="Todavía no está cargado el cambio de ese mes: no se sabe cuánto bajó en dólares">falta cambio</span>'}</td>
        <td><select class="qe-esde" title="De qué mes es la deuda que paga" onchange="qeMoverPago('${p.id}', this.value, '${esc(p.mes)}', this)">${
          [...new Set([...mesesDeuda, p.mes])].sort().reverse().map((m) => `<option value="${m}"${m === p.mes ? ' selected' : ''}>${esc(_MESES[Number(m.slice(5))])}${m.slice(0, 4) !== r.mes.slice(0, 4) ? ' ' + m.slice(0, 4) : ''}</option>`).join('')}</select></td>
        <td class="qe-ref">${p.billetera ? `<span class="qe-wallet" title="Billetera a la que entró">${esc(p.billetera)}</span>` : ''}${p.referencia ? `<span class="qe-txt" title="${esc(p.referencia)}">${esc(p.referencia)}</span>` : ''}</td>
        <td class="right">${p.comprobante && p.archivo ? `<button class="qe-clip" title="Ver el comprobante" onclick="window.open('/api/os/comprobantes/${p.comprobante}/archivo','_blank')">📎</button>` : ''}</td></tr>`).join('')
        || '<tr><td colspan="7" class="empty">No entró nada con ese filtro.</td></tr>'}</tbody></table></div>
      ${l.length > vis.length ? `<div style="text-align:center;margin-top:10px"><button class="outline small" onclick="_qeTope+=60;qePintar()">Ver ${Math.min(60, l.length - vis.length)} más de ${l.length - vis.length}</button></div>` : ''}
    </div>
    ${rechazados.length ? `<div class="card"><h2>✖ Rechazados · ${rechazados.length}</h2>
      <table><tbody>${rechazados.slice(0, 20).map((x) => `<tr><td><b>${esc(x.codigo || '')}</b> <span class="muted">${esc(x.cliente_nombre || '')}</span></td>
        <td class="right">${money(x.monto)} <span class="muted">${esc(x.divisa || '')}</span></td><td class="muted">${esc(x.motivo || '')}</td></tr>`).join('')}</tbody></table></div>` : ''}`;
}
const _qeVistas = () => `<div class="qd-barra">${[['pagos', 'Pago por pago'], ['clientes', 'Por cliente, mes a mes']].map(([k, l]) =>
  `<button class="${_qeVista === k ? '' : 'outline'} small" onclick="qeSet('vista','${k}')">${l}</button>`).join('')}</div>`;

/* Una fila por cliente y una columna por mes: cuánto pagó cada uno. En la moneda de su cuenta (lo que
   le bajó la deuda), y una tabla por moneda: pesos y dólares no se suman. */
function qePorCliente() {
  const { meses, pagos, clientes } = _qeDatos.porMes;
  const main = document.getElementById('main');
  const porCod = Object.fromEntries(clientes.map((c) => [c.codigo, c]));
  const filas = {};                            // moneda → codigo → { mes: monto }
  meses.forEach((m, i) => {
    const r = pagos[i] || {};
    for (const p of [...(r.pesos || []), ...(r.usdt || [])]) {
      const c = porCod[p.codigo] || {}; const mon = (c.deuda && c.deuda.moneda) || c.moneda_cuenta || 'USDT';
      const v = mon === 'ARS' ? Number(p.ars || 0) : Number(p.saldo_usdt != null ? p.saldo_usdt : (p.usdt || 0));
      const t = filas[mon] = filas[mon] || {}; const o = t[p.codigo] = t[p.codigo] || { nombre: p.cliente, n: 0 };
      o[m] = (o[m] || 0) + v; o.n += 1;
    }
  });
  const q = _qeQ.toLowerCase();
  const orden = meses.slice().reverse();      // de lo más viejo a lo más nuevo, de izquierda a derecha
  const tabla = (mon) => {
    const l = Object.entries(filas[mon]).filter(([cod, o]) => !q || cod.toLowerCase().includes(q) || String(o.nombre || '').toLowerCase().includes(q))
      .map(([cod, o]) => ({ cod, o, tot: orden.reduce((a, m) => a + (o[m] || 0), 0) })).sort((a, b) => b.tot - a.tot);
    const T = Object.fromEntries(orden.map((m) => [m, l.reduce((a, x) => a + (x.o[m] || 0), 0)]));
    return `<div class="card"><div style="overflow-x:auto"><table style="min-width:100%"><thead><tr><th>${esc(mon)} · ${l.length}</th>
      ${orden.map((m) => `<th class="right">${esc(_MESES[Number(m.slice(5))])}</th>`).join('')}<th class="right">Total</th></tr></thead>
      <tbody>${l.map((x) => `<tr><td><b>${esc(x.cod)}</b> <span class="muted">${esc(x.o.nombre || '')}</span></td>
        ${orden.map((m) => `<td class="right">${_num(x.o[m])}</td>`).join('')}<td class="right"><b>${money(x.tot)}</b></td></tr>`).join('')
        || `<tr><td colspan="${orden.length + 2}" class="empty">Nadie con ese nombre pagó en estos meses.</td></tr>`}</tbody>
      <tfoot><tr><th>Total</th>${orden.map((m) => `<th class="right">${money(T[m])}</th>`).join('')}<th class="right">${money(orden.reduce((a, m) => a + T[m], 0))}</th></tr></tfoot>
      </table></div></div>`;
  };
  const monedas = Object.keys(filas).sort((a, b) => (a === 'USDT' ? -1 : b === 'USDT' ? 1 : a.localeCompare(b)));
  main.innerHTML = QD_STYLE + `
    <div class="card" style="display:flex;flex-direction:column;gap:12px">
      ${_qeVistas()}
      <div class="row" style="align-items:flex-end"><div style="flex:1 1 200px"><input id="qe-q" value="${esc(_qeQ)}" placeholder="Buscar cliente" oninput="qeBuscar(this.value)"/></div></div>
    </div>
    ${monedas.map(tabla).join('') || '<div class="card"><div class="muted">No hubo pagos en estos meses.</div></div>'}`;
}
/* Cambiar de qué mes es la deuda que paga un pago. Usa la ruta que ya existía (sólo cambia el mes:
   el pago no se toca). Ojo: el mes decide con qué puntos se reparte lo cobrado y, en un pago en
   pesos que espera el cambio del mes, con qué cambio se pasa a dólares. */
async function qeMoverPago(id, mes, antes, sel) {
  // Se pregunta: un cambio de mes mueve en qué mes descuenta y, en pesos, con qué cambio se valúa.
  if (!confirm('¿Pasar este pago a la deuda de ' + _nomMes(mes) + '?\n\nDescuenta de lo que debía ese mes. Si es en pesos, se valúa con el cambio de ese mes.')) { if (sel) sel.value = antes; return; }
  const r = await api('/api/os/movimientos/' + encodeURIComponent(id) + '/mes-cierre', { method: 'PUT', body: JSON.stringify({ mes_cierre: mes }) });
  if (!r || !r.ok) { toast('No se cambió: ' + ((r && r.error) || '')); if (sel) sel.value = antes; return; }
  toast('Ahora es de ' + _nomMes(mes));
  VIEWS.queEntro();
}
function qeBuscar(v) { _qeQ = v; _qeTope = 40; qePintar(); setTimeout(() => { const i = document.getElementById('qe-q'); if (i) { i.focus(); i.setSelectionRange(i.value.length, i.value.length); } }, 0); }
function qeSet(k, v) { _qeTope = 40; if (k === 'mes') { _qeMes = v; return VIEWS.queEntro(); } if (k === 'vista') { _qeVista = v; return VIEWS.queEntro(); } if (k === 'via') _qeVia = v; if (k === 'orden') _qeOrden = v; qePintar(); }
/* Punto y coma y coma decimal, como el Excel en castellano (igual que pagCSV). */
function qeCSV() {
  const { r } = _qeDatos; const num = (x) => (x == null ? '' : String(Number(x).toFixed(2)).replace('.', ','));
  const qq = (x) => '"' + String(x == null ? '' : x).replace(/"/g, '""') + '"';
  const delMes = (p) => String(p.fecha).slice(0, 7) === r.mes;
  const filas = [..._qeDatos.todosPesos.filter(delMes).map((p) => ['pesos', p, num(p.ars)]), ..._qeDatos.todosUsdt.filter(delMes).map((p) => ['USDT', p, num(p.usdt)])];
  const csv = '﻿' + ['Fecha;Es de;Código;Cliente;Cómo;Recibido;En USDT;Billetera;Referencia']
    .concat(filas.map(([v, p, rec]) => [p.fecha, p.mes, qq(p.codigo), qq(p.cliente), v, rec, num(p.usdt), qq(p.billetera), qq(p.referencia)].join(';'))).join('\n');
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  a.download = 'entro-' + r.mes + '.csv'; a.click();
}
