/* ── ⚡ CALCULAR UNA CARGA — LA PANTALLA, UNA SOLA VEZ ─────────────────────────────────────────
   La usan el PANEL (/os) y FICHAS (/), que es donde se despacha. Copiarla en los dos era la forma
   segura de que en un mes dijeran cosas distintas: ya pasó con la letra chica de los envíos.

   Los dos paneles tienen ayudantes con el MISMO nombre y distinta forma —el `api` de Fichas
   devuelve `{status, body}` y el del OS devuelve el cuerpo; su `money` no lleva decimales y no
   tiene `toast`—, así que no alcanza con cargar el archivo: cada uno los inyecta al montar.

   La cuenta la hace el servidor, con las mismas funciones que la carga de verdad. Acá no se
   multiplica nada. */
window.PantallaCarga = (function () {
  let api, esc, money, toast, ayuda;
  let _cgCajas = [], _cgRes = null, _cgTimer = null, _cgUsar = null, _cgPaneles = {}, _raiz = null;
  const val = (id) => { const el = _raiz && _raiz.querySelector('#' + id); return el ? String(el.value || '').trim() : ''; };
  const mesNombre = (m) => {
    const N = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
    const [y, mm] = String(m || '').split('-');
    return N[Number(mm) - 1] ? N[Number(mm) - 1] + ' de ' + y : String(m || '');
  };


async function montar(opts) {
  ({ api, esc, money, toast, ayuda } = opts);
  const main = _raiz = opts.el;
  main.innerHTML = '<div class="card"><div class="muted">Cargando clientes…</div></div>';
  /* Las divisas salen del PANEL, no de la caja: la caja de 463.life dice ARS y el panel tiene
     diez. Se traen una vez acá para poder etiquetar el selector y llenar «Cargar en» sin esperar
     a que se calcule. */
  const [cli0, pan0] = await Promise.all([api('/api/clientes'), api('/api/os/paneles')]);
  _cgPaneles = {};
  ((pan0 && pan0.paneles) || []).forEach(p => { if (p.id_usuario) _cgPaneles[String(p.id_usuario)] = (p.divisas||[]).map(x => String(x).toUpperCase()); });
  const cs = ((cli0.clientes || [])).filter(c => (c.cajas||[]).length);
  cs.sort((a,b) => String(a.nombre||a.nombreVisible||'').localeCompare(String(b.nombre||b.nombreVisible||''), 'es'));
  main.innerHTML = `
    <div class="card">
      <h2>⚡ Calcular una carga</h2>
      ${ayuda ? ayuda('cg', 'Cuánto hay que poner en el panel y qué comisión le genera.',
        'La cuenta la hace el servidor con las mismas funciones que usa la carga de verdad, así que '
        + 'lo que dice acá es exactamente lo que se va a anotar. El tipo de cambio es el <b>vivo</b>; '
        + 'si no contesta, se usa el del mes y se avisa.<br><br>'
        + '<b>Qué significa el %.</b> No es un recargo sobre lo que carga: es lo que <b>paga por cada 100 '
        + 'de fichas</b>. Al 7%, quien pone 7 recibe 100 — o sea <b>fichas = lo que paga ÷ % × 100</b>.<br><br>'
        + 'Lo que paga <b>es</b> la comisión: es exactamente lo que le queda anotado como deuda del mes.') : ''}
      <div class="row" style="align-items:flex-end;margin-top:8px">
        <div style="flex:1 1 240px"><label>Cliente</label>
          <select id="cg-cli" onchange="cgCliente()">
            <option value="">— elegir —</option>
            ${cs.map(c => `<option value="${esc(c.id)}">${esc(c.nombre||c.nombreVisible)} · ${esc(c.codigo)}</option>`).join('')}
          </select></div>
        <div style="flex:1 1 260px"><label>Caja / panel</label>
          <select id="cg-caja" onchange="cgCaja()"><option value="">— elegí un cliente —</option></select></div>
        <div style="flex:0 0 170px"><label>Cargar en</label>
          <select id="cg-carga-div" onchange="cgPaga();cgCalcular()"><option value="">—</option></select>
          <div class="muted" id="cg-divs" style="font-size:11px;margin-top:2px"></div></div>
      </div>
      <div class="row" style="align-items:flex-end;margin-top:6px">
        <div style="flex:0 0 200px"><label>Ese monto es…</label>
          <select id="cg-modo" onchange="cgCalcular()">
            <option value="pago">lo que ME PAGA</option>
            <option value="fichas">fichas que QUIERE</option>
          </select></div>
        <div style="flex:1 1 160px"><label>Monto</label>
          <input id="cg-monto" inputmode="decimal" placeholder="10000" oninput="cgLuego()"></div>
        <div style="flex:0 0 120px"><label>Que paga en</label>
          <select id="cg-div" onchange="cgCalcular()"><option value="USD">USD</option></select></div>
        <div style="flex:0 0 150px"><label>Mes</label>
          <input type="month" id="cg-mes" value="${esc(new Date().toISOString().slice(0,7))}" onchange="cgCalcular()"></div>
        <div style="flex:0"><button onclick="cgCalcular()">Calcular</button></div>
      </div>
    </div>
    <div id="cg-out"></div>`;
};

function cgCliente(){
  const id = val('cg-cli');
  api('/api/clientes').then(r => {
    const c = (r.clientes||[]).find(x => String(x.id) === String(id));
    _cgCajas = c ? (c.cajas||[]) : [];
    const sel = _raiz.querySelector('#cg-caja'); if(!sel) return;
    sel.innerHTML = _cgCajas.length
      ? _cgCajas.map(k => {
          const ds = cgDivisasDe(k);
          return `<option value="${esc(k.id)}">${esc(k.usuario)}${k.sistema?' · '+esc(k.sistema):''} · ${esc(ds.slice(0,3).join('/'))}${ds.length>3?' +'+(ds.length-3):''}</option>`;
        }).join('')
      : '<option value="">este cliente no tiene cajas</option>';
    // Los selectores de divisa los arma el servidor al contestar: junta las de la caja con las
    // del panel, que es lo que dice el casino. Al cambiar de caja se limpian para no arrastrar
    // la divisa de la anterior.
    cgCaja();
  });
}
/* Las divisas de una caja: las del PANEL —lo que dice el casino— más las que la caja tenga
   cargadas. La caja sola miente: la de 463.life dice ARS y el panel tiene diez. */
function cgDivisasDe(k){
  if(!k) return ['ARS'];
  const dp = _cgPaneles[String(k.userId)] || [];
  const dc = (k.divisas||[]).map(x => String(x).toUpperCase());
  const t = [...new Set([...dc, ...dp])];
  return t.length ? t : ['ARS'];
}
/* Al elegir la caja se llenan «Cargar en» y «Que paga en» EN EL ACTO, sin esperar a calcular:
   antes el selector aparecía vacío hasta que había un monto, y parecía que no había más divisas. */
function cgCaja(){
  const k = _cgCajas.find(x => String(x.id) === val('cg-caja'));
  const ds = cgDivisasDe(k);
  const sc = _raiz.querySelector('#cg-carga-div');
  if (sc) {
    const antes = sc.value;
    sc.innerHTML = ds.map(d => `<option value="${esc(d)}">${esc(d)}</option>`).join('');
    sc.value = ds.includes(antes) ? antes : ds[0];
  }
  /* ── UNA SOLA LÍNEA, NO UNA MARCA EN CADA OPCIÓN ────────────────────────────────────────────
     Antes cada divisa que el panel tiene y la caja no llevaba «·no en la caja»: nueve de diez
     marcadas es ruido, y encima el campo se llama «caja / panel», así que decir «no en la caja»
     de algo que el panel SÍ tiene se lee como una contradicción.

     Son dos cosas distintas con nombres parecidos: el PANEL es el nodo del casino y acepta esas
     divisas; la CAJA es por dónde entran los pedidos, y quedó con una sola cargada. Se dice así,
     y con el botón al lado para emparejarlas de una vez. */
  const enCaja = (k && (k.divisas||[]).map(x => String(x).toUpperCase())) || [];
  const faltan = ds.filter(d => !enCaja.includes(d));
  const nota = _raiz.querySelector('#cg-divs');
  if (nota) {
    nota.innerHTML = !faltan.length
      ? (ds.length > 1 ? ds.length + ' divisas habilitadas' : '')
      : '<span style="color:var(--gold)">El panel acepta ' + ds.length + ', pero para pedir sólo está'
        + (enCaja.length === 1 ? '' : 'n') + ' <b>' + esc(enCaja.join(', ') || '—') + '</b></span>'
        + ' <button class="outline small" style="margin-left:4px;padding:2px 7px" onclick="cgSincronizar()">habilitar las ' + ds.length + '</button>';
  }
  cgPaga();
  cgCalcular();
}
/* En qué puede pagar: dólares, o la misma moneda de la carga. Otra combinación pasa por dólares y
   el servidor la rechaza, así que no se ofrece. */
function cgPaga(){
  const d = val('cg-carga-div') || 'ARS';
  const sd = _raiz.querySelector('#cg-div'); if(!sd) return;
  const ops = (d === 'USD' || d === 'USDT') ? ['USD'] : ['USD', d];
  const antes = sd.value;
  sd.innerHTML = ops.map(x => `<option value="${esc(x)}">${esc(x)}</option>`).join('');
  sd.value = ops.includes(antes) ? antes : 'USD';
}

// Al escribir se espera un momento: una consulta por tecla le pega al TC vivo en cada dígito.
function cgLuego(){ clearTimeout(_cgTimer); _cgTimer = setTimeout(cgCalcular, 450); }

async function cgCalcular(){
  const out = _raiz.querySelector('#cg-out'); if(!out) return;
  const cli = val('cg-cli'), caja = val('cg-caja'), monto = val('cg-monto').replace(',', '.');
  if(!cli || !caja || !(Number(monto) > 0)) { out.innerHTML = ''; _cgRes = null; return; }
  out.innerHTML = '<div class="card"><div class="muted">Calculando…</div></div>';
  const r = await api('/api/os/carga/calcular?cliente_id=' + encodeURIComponent(cli)
    + '&caja_id=' + encodeURIComponent(caja) + '&monto=' + encodeURIComponent(monto)
    + '&divisa=' + encodeURIComponent(val('cg-div')) + '&mes=' + encodeURIComponent(val('cg-mes'))
    + (val('cg-carga-div') ? '&cargar_en=' + encodeURIComponent(val('cg-carga-div')) : ''));
  if(!r || !r.ok){ out.innerHTML = '<div class="card"><div class="badge err">' + esc((r&&r.error)||'no se pudo') + '</div></div>'; _cgRes = null; return; }
  _cgRes = r;
  const M = (x, d) => money(x, d == null ? 2 : d);
  const modo = val('cg-modo') || 'pago';
  const A = modo === 'pago' ? r.comoPago : r.comoFichas;   // la lectura elegida
  const B = modo === 'pago' ? r.comoFichas : r.comoPago;   // la otra, abajo y en chico
  _cgUsar = A;
  const D = esc(A.divisa), P = M(r.pide.monto) + ' ' + esc(r.pide.divisa);
  /* ── SE PREGUNTA UNA VEZ POR MES Y POR CLIENTE ────────────────────────────────────────────
     El % no es fijo: es una serie con fechas, y el momento en que alguien SABE si cambió es justo
     antes de la primera carga del mes. Titan estuvo al 5 y desde septiembre va al 7 — sin esta
     pregunta, la primera carga de septiembre se anotaba al 5 y nadie se enteraba hasta el cierre. */
  const preguntar = r.base && !r.base.confirmada;
  const cab = preguntar ? `
    <div class="card" style="margin:8px 0;border-left:3px solid var(--gold)">
      <b>¿${esc(r.cliente.nombre)} trabaja al ${esc(r.base.pct)}% en ${esc(mesNombre(r.mes))}?</b>
      <div class="muted" style="margin-top:2px">Sale de ${esc(r.base.fuente)}. Se pregunta una sola vez por mes.</div>
      <div class="row" style="margin-top:8px;align-items:flex-end">
        <div style="flex:0"><button onclick="cgBase('${esc(r.base.pct)}')">Sí, ${esc(r.base.pct)}%</button></div>
        <div style="flex:0 0 120px"><label>No, es otro</label><input id="cg-otro" inputmode="decimal" placeholder="7"></div>
        <div style="flex:0"><button class="outline" onclick="cgBase()">Guardar</button></div>
        <div class="muted" style="flex:1 1 220px;align-self:center;font-size:11.5px">
          Si es otro, se guarda como vigente <b>desde el 1 de ${esc(mesNombre(r.mes))}</b>: los meses
          anteriores quedan como estaban y la carga de verdad lo va a tomar.</div>
      </div>
    </div>` : '';
  out.innerHTML = cab + `
    <div class="card" style="background:var(--bg3)${preguntar ? ';opacity:.55' : ''}">
      <label>Cargar en ${esc(r.caja.usuario)}</label>
      <div style="font-size:34px;font-weight:800;color:var(--gold);line-height:1.15">${M(A.cargar)} <span style="font-size:18px">${D}</span></div>
      <div class="muted" style="margin-top:2px">
        ${modo === 'pago'
          ? 'porque te paga ' + P + (r.base ? ' y trabaja al ' + esc(r.base.pct) + '%: por cada ' + esc(r.base.pct) + ' que pone, recibe 100' : '')
          : 'te tiene que pagar ' + (A.paga != null ? '<b>' + M(A.paga) + ' ' + D + '</b>' + (A.paga_usdt != null && D !== 'USDT' && D !== 'USD' ? ' (' + M(A.paga_usdt) + ' USDT)' : '') : '—')}
      </div>
      ${r.tc ? `<div style="margin-top:8px;padding:8px 11px;background:var(--bg2);border-radius:8px;display:inline-block">
        <span class="muted" style="font-size:11px;text-transform:uppercase;letter-spacing:.04em">Tipo de cambio</span>
        <div style="font-size:17px;font-weight:800">1 ${esc(r.pide.divisa)} = ${M(r.tc.valor)} ${D}</div>
        <div class="muted" style="font-size:11.5px${r.tc.vivo ? '' : ';color:var(--gold)'}">${esc(r.tc.fuente)}${r.tc.vivo ? ' · cotización de ahora' : ''}</div>
      </div>` : ''}
      <div class="row" style="margin-top:12px;gap:22px">
        <div><label>${modo === 'pago' ? 'Lo que te queda a vos' : 'Lo que te tiene que pagar'}</label>
          <div style="font-size:22px;font-weight:800">${A.paga_usdt != null ? M(A.paga_usdt) + ' USDT' : (A.paga != null ? M(A.paga) + ' ' + D : '<span class="muted">sin % base</span>')}</div>
          ${r.base ? '<div class="muted" style="font-size:11.5px">su ' + esc(r.base.pct) + '%' + (r.base.de === 'panel' ? ' (precio propio del panel)' : '')
            + (A.paga != null && D !== 'USDT' && D !== 'USD' ? ' · ' + M(A.paga) + ' ' + D : '') + '</div>' : ''}
        </div>
        ${B && B.cargar != null ? `<div><label>${modo === 'pago' ? 'Si los ' + M(r.pide.monto,0) + ' fueran las FICHAS' : 'Si los ' + M(r.pide.monto,0) + ' fueran lo que te paga'}</label>
          <div style="font-size:18px;font-weight:700;opacity:.75">cargar ${M(B.cargar)} ${esc(B.divisa)}</div></div>` : ''}
      </div>
      ${(r.avisos||[]).length ? '<div class="muted" style="margin-top:10px;color:var(--gold)">⚠ ' + r.avisos.map(esc).join('<br>⚠ ') + '</div>' : ''}
      <div class="row" style="margin-top:12px">
        <button class="outline" onclick="cgCopiar()">📋 Copiar el monto</button>
        ${r.caja.habilitadaEnLaCaja === false
          ? '<button class="grave" onclick="cgSincronizar()">🔄 Habilitar ' + esc(r.caja.divisa) + ' para pedir</button>'
            + '<span class="muted" style="align-self:center">El panel la acepta, pero el pedido todavía no: se guardaría en ' + esc((r.caja.divisas||['ARS'])[0]) + '</span>'
          : (preguntar
            ? '<span class="muted" style="align-self:center">Confirmá el % arriba para poder crear el pedido</span>'
            : '<button class="grave" onclick="cgPedido()">📥 Crear el pedido a su nombre</button>')}
      </div>
    </div>`;
}

/* Contesta la pregunta del %. Con el mismo número sólo anota la confirmación; con otro además lo
   guarda como VIGENCIA desde el 1 de ese mes —no como corrección— así los meses anteriores quedan
   como estaban y la carga real, que lee el vigente de hoy, lo toma. */
async function cgBase(pct){
  const r = _cgRes; if(!r) return;
  const v = String(pct != null ? pct : val('cg-otro')).trim().replace(',', '.');
  /* ⚠️ `Number('') === 0`, y `0 >= 0` es true: con el campo vacío la validación pasaba y el vacío
     llegaba al servidor, que contestaba «setValor: valor vacío para precio_base_pct». Hay que
     preguntar por el vacío APARTE — un 0 sí es un % válido. */
  if (v === '') return toast('Escribí el % en el campo de al lado', true);
  if (!Number.isFinite(Number(v)) || Number(v) < 0) return toast('"' + v + '" no es un porcentaje', true);
  if(pct == null && !confirm('¿' + r.cliente.nombre + ' pasa a trabajar al ' + v + '% desde el 1 de '
    + mesNombre(r.mes) + '?\n\nLos meses anteriores quedan como estaban.')) return;
  const x = await api('/api/os/carga/base', { method:'POST', body: JSON.stringify({
    cliente_id: r.cliente.id, mes: r.mes, pct: v }) });
  if(!x || !x.ok) return toast('No se guardó: ' + ((x&&x.error)||''), true);
  toast(x.cambio ? ('✔ ' + r.cliente.nombre + ' al ' + v + '% desde ' + mesNombre(r.mes)
                    + (x.antes != null ? ' (antes ' + x.antes + '%)' : ''))
                 : ('✔ Confirmado al ' + v + '%'));
  cgCalcular();
}

/* Pone al día las divisas de la caja desde su panel. Hace falta porque `/api/pedir` valida contra
   la caja y, si la divisa no está, la CAMBIA en silencio por la primera: un pedido en UYU se
   guardaba como ARS. */
async function cgSincronizar(){
  const r = _cgRes; if(!r) return;
  if(!confirm('¿Habilitar en ' + r.caja.usuario + ' todas las divisas que acepta el panel?\n\n'
    + 'Se puede pedir hoy: ' + ((r.caja.divisas||[]).join(', ') || '—') + '\n'
    + 'Pasa a: ' + ((r.caja.divisasPanel||[]).join(', ') || '—') + '\n\n'
    + 'Es lo mismo que ya hace el sync de paneles, para esta sola.')) return;
  const x = await api('/api/os/carga/sincronizar-caja', { method:'POST', body: JSON.stringify({
    cliente_id: r.cliente.id, caja_id: r.caja.id }) });
  if(!x || !x.ok) return toast('No se pudo: ' + ((x&&x.error)||''), true);
  toast('✔ ' + r.caja.usuario + ': ' + (x.ahora||[]).join(', '));
  cgCliente();   // se relee el cliente para que el selector traiga las divisas nuevas
}

function cgCopiar(){
  if(!_cgUsar) return;
  navigator.clipboard.writeText(String(_cgUsar.cargar))
    .then(() => toast('Copiado: ' + money(_cgUsar.cargar,2) + ' ' + _cgUsar.divisa))
    .catch(() => toast('No se pudo copiar', true));
}

/* CREA UN PEDIDO DE VERDAD, a nombre del cliente y en la moneda de la caja. Es la misma puerta por
   la que entra un pedido del cliente, así que sigue el mismo camino: queda pendiente y lo despacha
   quien corresponde. Se pregunta antes porque después aparece en la cola de otra persona. */
async function cgPedido(){
  const r = _cgRes, u = _cgUsar; if(!r || !u) return;
  if(!confirm('¿Crear el pedido a nombre de ' + r.cliente.nombre + '?\n\n'
    + money(u.cargar,2) + ' ' + u.divisa + ' en ' + r.caja.usuario + '\n\n'
    + 'Queda pendiente, como si lo hubiera pedido él.')) return;
  toast('Creando el pedido…');
  const x = await api('/api/pedir', { method:'POST', body: JSON.stringify({
    codigo: r.cliente.codigo, cajaId: r.caja.id, monto: Number(u.cargar), divisa: u.divisa }) });
  if(!x || !x.ok) return toast('No se creó: ' + ((x&&x.error)||''), true);
  toast('✅ Pedido creado · ' + money(u.cargar,2) + ' ' + u.divisa + ' en ' + r.caja.usuario);
}

  /* Los `onclick` del HTML llaman por nombre global: sin esto, un botón dentro de la pantalla no
     encuentra la función y no pasa nada — sin error, que es lo peor. */
  Object.assign(window, { cgCliente, cgCaja, cgPaga, cgLuego, cgCalcular, cgBase, cgSincronizar, cgCopiar, cgPedido });

  return { montar };
})();
