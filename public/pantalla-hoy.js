/* ── ☀️ HOY — fase 3, segunda pantalla por tarea ──────────────────────────────────────────────
   Lo del día en un solo lugar: lo que espera tu decisión (🔔 Pendientes) y lo que está mal y puede
   hacer salir un número equivocado (🩺 Revisión, que vivía escondida en ⚙ Ajustes).
   Lo de aprobar NO se reescribe: se usan las mismas funciones de siempre (pintarComprobantes,
   solicitudesCaja, movimientosPanel), que escriben en los mismos contenedores. Lo nuevo es cómo se
   ordena y que cada problema de la Revisión tenga un botón que lleva a donde se arregla.
   Se carga después del script principal porque usa sus ayudantes. */

const HOY_STYLE = `<style>
  .hoy-arriba { display:flex; gap:8px; flex-wrap:wrap; align-items:center }
  .hoy-n { display:inline-flex; gap:6px; align-items:center; border:1px solid var(--border); border-radius:20px; padding:5px 12px; background:var(--bg2); cursor:pointer; font-size:13.5px; color:var(--text); font-weight:600 }
  .hoy-n b { font-size:15px }
  .hoy-n.cero { color:var(--muted); font-weight:400; cursor:default }
  .hoy-n.urg { border-color:var(--gold); background:rgba(196,86,173,.08) }
  .hoy-n.grave { border-color:var(--red); background:rgba(217,83,79,.07); color:var(--red) }
  .hoy-sep { flex:1 }
  .hoy-tit { display:flex; align-items:baseline; gap:10px; margin:18px 2px 8px }
  .hoy-tit h2 { margin:0; font-size:16px }
  .hoy-ok { color:var(--green); font-weight:600 }
  .hoy-mal { display:flex; flex-direction:column }
  .hoy-item { display:grid; grid-template-columns:auto minmax(0,1fr) auto; gap:4px 12px; align-items:center; padding:11px 2px; border-bottom:1px solid var(--border) }
  .hoy-item:last-child { border-bottom:0 }
  .hoy-dot { width:9px; height:9px; border-radius:50%; background:var(--gold) }
  .hoy-dot.grave { background:var(--red) }
  .hoy-item b { font-size:14px }
  .hoy-quien { grid-column:2; font-size:12.5px; color:var(--muted) }
  .hoy-quien a { color:var(--muted) }
  .hoy-item button { white-space:nowrap }
</style>`;

/* DÓNDE SE ARREGLA CADA COSA. La Revisión lo dice en texto («📍 Se arregla en: …»); acá se lleva.
   Se reconoce por el título, que arma revision.service.js. Lo que no se reconoce no lleva botón:
   antes que mandarte a una pantalla equivocada, que se lea el texto. */
const HOY_ARREGLO = [
  [/sin % base|Externos: cobrar/, 'clientes', 'Clientes'],
  [/sin tipo de cambio|no coinciden|cambio/i, 'tc', 'Tipos de cambio'],
  [/matriz|celda|costo/i, 'cierre:matriz', 'Matriz de %'],
  [/proveedor\(es\) del casino sin vincular/, 'proveedores', 'Proveedores'],
  [/panel|caja|anotadas distinto/i, 'clientes', 'Clientes'],
  [/casino y los pedidos/, 'facturacion', 'Consumo'],
];

let _hoyRev = null, _hoyAbierto = new Set();

VIEWS.hoy = async () => {
  const main = document.getElementById('main');
  /* Los contenedores que usan las funciones de aprobar (mov-body, sol-*, mov-*), puestos en el
     orden en que se ven: comprobantes primero, que son los más frecuentes. */
  main.innerHTML = HOY_STYLE + `
    <div class="card hoy-arriba" id="hoy-arriba"><span class="muted">Cargando…</span></div>
    <div class="hoy-tit"><h2>Para aprobar</h2><span id="hoy-aprobar-ok"></span></div>
    <div id="mov-body"></div>
    <div id="sol-aviso"></div><div id="sol-caja"></div>
    <div id="mov-aviso"></div><div id="mov-caja"></div>
    <div class="hoy-tit"><h2 id="hoy-mal-tit">Qué está mal</h2><span id="hoy-mal-ok"></span></div>
    <div class="card" id="hoy-mal"><span class="muted">Revisando…</span></div>`;
  const mes = mesDeCierre();
  const [, rev] = await Promise.all([refrescarTodoPendiente(), api('/api/os/revision?mes=' + encodeURIComponent(mes))]);
  _hoyRev = rev && rev.ok !== false ? rev : null;
  hoyArriba(mes);
  if (!_pendTotal()) document.getElementById('hoy-aprobar-ok').innerHTML = '<span class="hoy-ok">✓ nada esperando</span>';
  // Las de siempre, en modo buzón: sólo lo que espera.
  if (_cmpPend) await pintarComprobantes('pendiente', false);
  if (_pend.cajas) solicitudesCaja();
  if (_pend.movs) movimientosPanel();
  hoyMal(mes);
};

/* La línea de arriba: cuántas cosas hay de cada una, con número. Tocar una lleva a su lugar. */
function hoyArriba(mes) {
  const r = _hoyRev || {};
  const n = (k, cant, txt, extra) => `<span class="hoy-n${cant ? (extra ? ' ' + extra : ' urg') : ' cero'}"${cant ? ` onclick="hoyIr('${k}')"` : ''}>${txt} <b>${cant}</b></span>`;
  document.getElementById('hoy-arriba').innerHTML =
    n('mov-body', _cmpPend, '🧾 Comprobantes') + n('sol-caja', _pend.cajas, '📦 Cajas') + n('mov-caja', _pend.movs, '🔀 Fichas')
    + '<span class="hoy-sep"></span>'
    + n('hoy-mal', r.graves || 0, '⚠ Graves', 'grave') + n('hoy-mal', r.avisos || 0, 'Avisos')
    + `<button class="outline small" onclick="VIEWS.hoy()" title="Volver a leer">↻</button>`;
}
function hoyIr(id) { const e = document.getElementById(id); if (e && e.scrollIntoView) e.scrollIntoView({ behavior: 'smooth', block: 'start' }); }

/* QUÉ ESTÁ MAL: una línea por problema, los graves primero. Debajo, a quiénes afecta (los primeros;
   el resto al tocar «y N más»). A la derecha, el botón que lleva a donde se arregla. */
function hoyMal(mes) {
  const box = document.getElementById('hoy-mal'); if (!box) return;
  const r = _hoyRev;
  document.getElementById('hoy-mal-tit').textContent = 'Qué está mal en ' + mesNombre(mes);
  if (!r) { box.innerHTML = '<div class="nota err">No se pudo hacer la revisión.</div>'; return; }
  /* MIENTRAS EL MES ESTÁ ABIERTO, que falte su tipo de cambio es lo esperable: se carga al cerrarlo.
     Ahí no es grave; pasa a aviso y lo dice. Lo demás queda como lo manda la Revisión. */
  const abierto = mes === hoyISO().slice(0, 7);
  const items = (r.items || []).map((i) => (abierto && i.nivel === 'grave' && /sin tipo de cambio/.test(i.titulo)
    ? { ...i, nivel: 'aviso', titulo: i.titulo + ' (normal hasta que cierre el mes)' } : i))
    .sort((a, b) => (a.nivel === 'grave' ? 0 : 1) - (b.nivel === 'grave' ? 0 : 1));
  _hoyRev.graves = items.filter((i) => i.nivel === 'grave').length; _hoyRev.avisos = items.length - _hoyRev.graves;
  hoyArriba(mes);
  if (!items.length) { box.outerHTML = '<div class="card"><span class="hoy-ok">✓ Nada mal: todos tienen % base, todas las monedas tienen cambio y los paneles están vinculados.</span></div>'; return; }
  box.innerHTML = '<div class="hoy-mal">' + items.map((i, k) => {
    const a = HOY_ARREGLO.find(([re]) => re.test(i.titulo + ' ' + (i.donde || '')));
    const af = i.afectados || []; const abierto = _hoyAbierto.has(k);
    const quien = af.length ? (abierto ? af : af.slice(0, 4)).map(esc).join(' · ')
      + (af.length > 4 && !abierto ? ` <a href="#" onclick="_hoyAbierto.add(${k});hoyMal('${mes}');return false">y ${af.length - 4} más</a>` : '') : '';
    return `<div class="hoy-item">
      <span class="hoy-dot${i.nivel === 'grave' ? ' grave' : ''}" title="${i.nivel === 'grave' ? 'Grave: puede salir un número mal' : 'Aviso'}"></span>
      <div><b>${esc(i.titulo)}</b></div>
      ${a ? `<button class="${i.nivel === 'grave' ? '' : 'outline '}small" onclick="irA('${a[1]}')" title="${esc(i.detalle || '')}">Arreglar en ${esc(a[2])} →</button>` : `<span class="muted" style="font-size:12px" title="${esc(i.detalle || '')}">${esc(i.donde || '')}</span>`}
      ${quien ? `<div class="hoy-quien">${quien}</div>` : ''}
    </div>`;
  }).join('') + '</div>';
}
