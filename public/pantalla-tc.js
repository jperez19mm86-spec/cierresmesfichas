/* ── TIPOS DE CAMBIO — LA PANTALLA COMPARTIDA ────────────────────────────────────────────────
   La usan el panel (/os) y TBS (/tbs), y es la misma: un solo número por moneda y por mes
   divide todo lo que se cobra en los dos negocios. Del lado del servidor ya estaba unificada
   (`tc-unico`); esto es lo mismo del lado de la pantalla.

   Se carga DESPUES del script principal de cada página, porque usa sus ayudantes
   (`api`, `esc`, `money`, `toast`, `val`, `seccion`, `_cieFlash`, `CIE_STYLE`) y escribe
   `VIEWS.tc`. Cambiarla acá la cambia en los dos lados, que es todo el punto. */
async function cieSetTC(el, forzar){
  const r=await api('/api/os/cierre/tc',{method:'POST',body:JSON.stringify({moneda:el.dataset.mon,mes:el.dataset.mes,tasa:el.value,forzar:!!forzar})});
  if(r.ok){ _cieFlash(el); return; }
  // 409 = el valor es sospechoso (salto enorme contra el mes anterior). Se pregunta, no se guarda solo.
  if(r.confirmar){ if(confirm(r.error+' ¿Guardarlo igual?')) return cieSetTC(el, true); el.value=r.anterior||''; return; }
  toast('No se guardó: '+(r.error||''));
  el.style.borderColor='var(--red)';
}
async function cieAddMes(){ const me=val('cie-nmes').trim(); if(!me)return toast('Poné el mes'); const mon=(await api('/api/os/cierre/tc')).monedas||[]; await api('/api/os/cierre/tc',{method:'POST',body:JSON.stringify({moneda:mon[0]||'USD',mes:me,tasa:'1'})}); toast('Mes agregado'); VIEWS.tc(); }
async function cieAddMon(){ const mon=val('cie-nmon').trim(); if(!mon)return toast('Poné la moneda'); const me=(await api('/api/os/cierre/tc')).meses||[]; await api('/api/os/cierre/tc',{method:'POST',body:JSON.stringify({moneda:mon,mes:me[0]||'Mayo_2026',tasa:'1'})}); toast('Moneda agregada'); VIEWS.tc(); }

// ───────── TIPOS DE CAMBIO ─────────
let _tcMes = new Date().toISOString().slice(0,7);
/* ─────────────────────────────────────────────────────────────────────────────────────────
   TIPOS DE CAMBIO. Un solo número por moneda y por mes divide TODO lo que se cobra, así que
   la pantalla está ordenada por de dónde sale ese número:
     1. el que se está usando este mes (todas las monedas, con su fuente)
     2. la grilla moneda × mes, que es la que manda
     3. lo que se está juntando ahora, que es lo que va a formar la próxima columna
     4. el cierre mensual: promedio del mes contra el TC que factura el proveedor
   ARS_OF no es una moneda: es el ARS que factura el PROVEEDOR. Es la misma casilla que
   "TC Proveedor" de la tarjeta de cierre — antes eran dos y se habían separado.
   ───────────────────────────────────────────────────────────────────────────────────────── */
VIEWS.tc = async () => {
  const meses = (await api('/api/os/tc/meses')).meses||[];
  const d = await api('/api/os/cierre/tc'); const monedas=d.monedas||[], tasas=d.tasas||{};
  const uso = await api('/api/os/tc/del-mes?mes='+encodeURIComponent(_tcMes));
  const prom = (await api('/api/os/tc/divisas/promedios?mes='+encodeURIComponent(_tcMes))).promedios||[];
  const seg = await api('/api/os/tc/divisas/seguidas');
  const PROV='ARS_OF';

  // Las columnas se ordenan por el mes que representan, no como salieron de la base: mezcladas
  // (Enero_26 después de Julio_2026) no hay forma de leer la grilla.
  const mesesCie = (d.meses||[]).slice().sort((a,b)=>String(tcISO(a)||a).localeCompare(String(tcISO(b)||b)));
  const head = ['<th class="cie-h0">Moneda</th>'].concat(mesesCie.map(me=>
    `<th>${esc(me)}<br><span class="cie-x" title="borrar la columna ${esc(me)}" onclick="tcBorrarMes('${esc(me).replace(/'/g,"\\'")}')">✕</span></th>`)).join('');
  const filas = monedas.slice().sort((a,b)=> (a===PROV?1:0)-(b===PROV?1:0) || a.localeCompare(b));
  const body = filas.map(mon=>{
    const esProv = mon===PROV;
    const tds = mesesCie.map(me=>{const t=(tasas[mon]||{})[me]; return `<td><input class="cie-b" style="width:70px" data-mon="${esc(mon)}" data-mes="${esc(me)}" value="${t==null?'':esc(t)}" onchange="cieSetTC(this)"></td>`;}).join('');
    return `<tr${esProv?' class="cie-hv"':''}><td class="cie-p">${esc(mon)}${esProv?' <span class="cie-tag">del proveedor</span>':''}
      <span class="cie-x" title="borrar la fila ${esc(mon)}" onclick="tcBorrarMoneda('${esc(mon).replace(/'/g,"\\'")}')">✕</span></td>${tds}</tr>`;
  }).join('');
  const disc = uso.discrepancias||[];
  const rows = (uso.monedas||[]);

  // ── LO QUE SE VE SIEMPRE: qué número se está usando este mes ─────────────────────────────────
  // Las 23 monedas salían todas iguales y con la palabra «promedio» repetida abajo de cada una.
  // Ahora la etiqueta aparece SÓLO cuando NO es el promedio automático —a mano, o sin cargar—,
  // que es justamente el caso que hay que mirar, y esas van primero.
  const usadas = (rows.length?rows:[uso.ars].filter(Boolean)).slice().sort((a,b)=>{
    const pa=!a.valor?0:(/a mano|cierre/.test(a.fuente||'')?1:2);
    const pb=!b.valor?0:(/a mano|cierre/.test(b.fuente||'')?1:2);
    return pa-pb || String(a.divisa||'').localeCompare(String(b.divisa||''));
  });
  const sinCargar = usadas.filter(x=>!x.valor).length;
  const aMano = usadas.filter(x=>x.valor && /a mano|cierre/.test(x.fuente||'')).length;

  document.getElementById('main').innerHTML = CIE_STYLE + `
    <div class="card">
      <div class="row" style="align-items:flex-end;margin-bottom:12px">
        <div style="flex:0 0 190px"><label>Mes</label><input type="month" id="tc-mes" value="${esc(_tcMes)}" onchange="_tcMes=this.value;VIEWS.tc()"></div>
        <div style="flex:1"><h2 style="margin:0">El TC que se está usando en ${esc(_tcMes)}</h2>
          <div class="muted" style="font-size:12.5px">Con este número Facturación, Reparto y Proveedores externos pasan todo a USDT.
            Manda lo <b>cargado a mano</b>; si no hay, el <b>promedio automático</b> del mes.</div></div>
      </div>
      <div class="tc-tiles">
        ${usadas.map(x=>{
          const f=String(x.fuente||'');
          const mano=/a mano|cierre/.test(f), unidad=/unidad/.test(f);
          return `<div class="tc-t${!x.valor?' mal':(mano?' mano':'')}">
            <div class="d">${esc(x.divisa||'ARS')}${mano?' <span class="señal rosa" style="padding:1px 6px;font-size:10px">a mano</span>':''}</div>
            <div class="v">${x.valor?money(x.valor,x.valor>100?2:4):'sin cargar'}</div>
            ${unidad?'<div class="f">el dólar es la unidad</div>':''}</div>`;
        }).join('')}
      </div>
      <div class="muted" style="margin-top:10px">${usadas.length} moneda(s) en juego${
        aMano?' · <b>'+aMano+'</b> cargada(s) a mano':''}${
        sinCargar?' · <b style="color:var(--rosa)">'+sinCargar+' sin cargar</b>':''}</div>
      ${disc.length?('<div class="nota-suave" style="margin-top:12px"><b style="color:var(--durazno)">⚠ '+disc.length+' moneda(s) donde las fuentes NO coinciden</b><table style="margin-top:6px"><thead><tr><th>Moneda</th><th class="right">Se usa</th><th>De dónde sale</th><th>Las otras fuentes dicen</th></tr></thead><tbody>'+disc.map(x=>'<tr><td><b>'+esc(x.divisa)+'</b></td><td class="right">'+money(x.valor,4)+'</td><td class="muted">'+esc(x.fuente)+'</td><td class="muted">'+x.conflicto.map(c=>esc(c.fuente)+' = '+money(c.valor,4)+' <span style="color:var(--durazno)">('+c.difPct+'%)</span>').join(' · ')+'</td></tr>').join('')+'</tbody></table><div class="muted" style="margin-top:6px">Corregí el que esté mal en la grilla: si el cargado a mano está bien, ignorá el aviso.</div></div>')
        :'<div class="muted" style="margin-top:10px">✅ Las fuentes coinciden en todas las monedas de este mes.</div>'}
    </div>

    <div style="margin-top:12px">
    ${seccion('tc.grilla', 'La grilla · moneda × mes',
      `<b>${filas.length}</b><span class="u">monedas × ${mesesCie.length} meses</span>`, `
      <div class="muted" style="margin:12px 0 10px">Es la que <b>manda</b>: la ganancia de cada proveedor se convierte con la tasa de su moneda en ese mes.
        Se guarda sola al salir de la casilla. La fila <b>ARS_OF</b> es el ARS que factura el <b>proveedor</b> —
        es la misma casilla que «TC del proveedor» de más abajo.</div>
      <div class="acciones" style="margin:0 0 10px">
        <button class="outline small" onclick="tcArmarColumna()">✨ Armar la columna de ${esc(_tcMes)} con los promedios</button>
      </div>
      <div style="overflow:auto;max-height:52vh">
        ${filas.length? `<table class="ciet"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>` : '<div class="empty">Sin tipos de cambio. Agregá una moneda y un mes, o importá la planilla.</div>'}
      </div>
      <details class="cajas" style="margin-top:12px">
        <summary class="abrir"><span class="chev" aria-hidden="true"></span>Agregar una columna o una fila</summary>
        <div class="row" style="margin-top:10px;align-items:flex-end;gap:10px;flex-wrap:wrap">
          <div style="flex:0"><label>Mes nuevo</label><input id="cie-nmes" placeholder="ej: Junio_2026" style="width:150px"></div>
          <div style="flex:0"><button class="small" onclick="cieAddMes()">Agregar columna</button></div>
          <div style="flex:0"><label>Moneda nueva</label><input id="cie-nmon" placeholder="ej: ARS" style="width:110px"></div>
          <div style="flex:0"><button class="small" onclick="cieAddMon()">Agregar fila</button></div>
        </div>
      </details>`)}

    ${seccion('tc.junta', `Lo que se está juntando en ${esc(_tcMes)}`,
      `<b>${prom.length}</b><span class="u">monedas con cotización</span>`, `
      <div class="muted" style="margin:12px 0 10px">Todos los días se guarda la cotización de cada moneda. Cuando el mes termina, este promedio
        se escribe solo como columna nueva de la grilla — sin pisar nada que hayas cargado a mano.
        Se siguen <b>sólo las monedas que están como fila en la grilla</b> (la fuente publica ~160 y no sirven).
        Agregá una fila y al otro día ya se le junta la cotización.</div>
      <div class="acciones" style="margin:0 0 10px">
        <button class="outline small" onclick="snapNow()">📸 Guardar ARS ahora</button>
        <button class="outline small" onclick="snapDivisas()">📸 Guardar el resto ahora</button>
        <button class="outline small" onclick="tcAhora()">Ver ARS al instante</button>
        <div id="tc-now" class="muted" style="align-self:center"></div>
      </div>
      <table><thead><tr><th>Moneda</th><th class="right">Días juntados</th><th class="right">Promedio del mes</th><th>Ya está en la grilla</th></tr></thead><tbody>
      ${prom.map(x=>{
        const lbl=tcLabel(_tcMes); const yaVal=(tasas[x.divisa]||{})[lbl];
        return `<tr><td><b>${esc(x.divisa)}</b>${x.fuente?' <span class="muted" style="font-size:10.5px">'+esc(x.fuente)+'</span>':''}</td>
          <td class="right">${x.dias||0}</td><td class="right">${x.promedio?money(x.promedio,4):'—'}</td>
          <td>${yaVal!=null?'<span class="badge ok">'+esc(yaVal)+'</span>':'<span class="muted">todavía no</span>'}</td></tr>`;
      }).join('') || '<tr><td colspan="4" class="empty">Sin cotizaciones guardadas este mes.</td></tr>'}
      </tbody></table>
      <div class="muted" style="margin-top:8px;font-size:12px">Se siguen: ${(seg.monedas||[]).join(' · ')}</div>`)}

    ${seccion('tc.prov', 'Contra el TC del proveedor',
      (()=>{ const ch=meses.filter(m=>{const of=(tasas[PROV]||{})[tcLabel(m.mes)];
               return of!=null && m.tc_proveedor_ext && String(of)!==String(m.tc_proveedor_ext);}).length;
             const falta=meses.filter(m=>!m.tc_proveedor_ext).length;
             return ch?`<b style="color:var(--rosa)">${ch}</b><span class="u">no coinciden</span>`
                  : falta?`<b style="color:var(--durazno)">${falta}</b><span class="u">mes(es) sin su factura</span>`
                        : `<b>${meses.length}</b><span class="u">meses al día</span>`; })(), `
      <div class="muted" style="margin:12px 0 10px">El <b>TC Cliente</b> es el promedio del mes (Binance/criptoya) y es con el que se le cobra a los clientes.
        El <b>TC Proveedor</b> sale de la factura del proveedor y es el mismo dato que la fila <b>ARS_OF</b> de la grilla:
        se escribe una vez y queda en los dos lados.</div>
      <table><thead><tr><th>Mes</th><th class="right">TC Cliente (promedio)</th><th class="right">TC Proveedor (ARS_OF)</th><th class="right">Diferencia</th><th></th></tr></thead><tbody>
      ${meses.map(m=>{
        const lbl=tcLabel(m.mes); const of=(tasas[PROV]||{})[lbl];
        const cruce = (of!=null && m.tc_proveedor_ext && String(of)!==String(m.tc_proveedor_ext));
        return `<tr><td><b>${esc(m.mes)}</b> <span class="muted">${esc(lbl)}</span></td>
          <td class="right">${m.tc_cliente?money(m.tc_cliente,2):'—'}</td>
          <td class="right">${m.tc_proveedor_ext?money(m.tc_proveedor_ext,2):'<input id="tcp-'+m.mes+'" placeholder="de su factura" style="width:120px">'}</td>
          <td class="right">${m.diferencia_tc?money(m.diferencia_tc,2):'—'}</td>
          <td>${m.tc_proveedor_ext?(cruce?'<span class="badge err">la grilla dice '+esc(of)+'</span>':''):'<button class="small" onclick="setTcProv(\''+m.mes+'\')">Guardar</button>'}</td></tr>`;
      }).join('') || '<tr><td colspan="5" class="empty">Sin meses todavía.</td></tr>'}
      </tbody></table>`)}
    </div>`;
};
const TC_MESES_ES=['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
/** '2026-07' → 'Julio_2026' (así se llaman las columnas de la grilla) */
function tcLabel(iso){ const [y,m]=String(iso||'').split('-'); return TC_MESES_ES[Number(m)-1]?TC_MESES_ES[Number(m)-1]+'_'+y:String(iso); }
/** 'Julio_2026' / 'JULIO_26' → '2026-07'. Sirve para ordenar las columnas por fecha. */
function tcISO(lbl){ const m=/^\s*([A-Za-zÁ-ú]+)[_\s-]+(\d{2}|\d{4})\s*$/.exec(String(lbl||'')); if(!m)return null;
  const i=TC_MESES_ES.findIndex(x=>x.toLowerCase()===m[1].toLowerCase()); if(i<0)return null;
  return (m[2].length===2?'20'+m[2]:m[2])+'-'+String(i+1).padStart(2,'0'); }
async function tcBorrarMes(mes){
  if(!confirm('¿Borrar la columna "'+mes+'" entera? Se van los tipos de cambio de todas las monedas de ese mes.')) return;
  const r=await api('/api/os/cierre/tc/mes/'+encodeURIComponent(mes),{method:'DELETE'});
  toast(r.ok?('Columna borrada ('+r.celdas+' celdas)'):(r.error||'error')); VIEWS.tc();
}
async function tcBorrarMoneda(mon){
  if(!confirm('¿Borrar la fila "'+mon+'" entera? Se van sus tipos de cambio de todos los meses y deja de cotizarse.')) return;
  const r=await api('/api/os/cierre/tc/moneda/'+encodeURIComponent(mon),{method:'DELETE'});
  toast(r.ok?('Fila borrada ('+r.celdas+' celdas'+(r.snapshotsBorrados?', '+r.snapshotsBorrados+' cotizaciones':'')+')'):(r.error||'error')); VIEWS.tc();
}
async function tcArmarColumna(){
  const r=await api('/api/os/tc/columna',{method:'POST',body:JSON.stringify({mes:_tcMes})});
  if(!r.ok) return toast(r.error||'error');
  toast(r.escritas.length?('Columna '+r.columna+': '+r.escritas.length+' monedas escritas'+(r.respetadas.length?', '+r.respetadas.length+' ya cargadas a mano':'')):'No había nada nuevo para escribir');
  VIEWS.tc();
}
async function snapDivisas(){ const r=await api('/api/os/tc/divisas/snapshot',{method:'POST'}); toast(r.ok?('Guardadas '+r.divisas+' monedas'):(r.error||'error')); VIEWS.tc(); }
async function snapNow(){ const r=await api('/api/os/tc/snapshot',{method:'POST'}); if(r.ok) toast('Snapshot: '+r.snapshot.tc_ars_usdt); VIEWS.tc(); }
async function tcAhora(){ const r=await api('/api/os/tc/ahora'); document.getElementById('tc-now').textContent = r.tc?('TC '+money(r.tc,2)+' ('+(r.vivo?'vivo':'snapshot')+')'):'sin TC'; }
/* El TC del proveedor es el divisor de TODO lo que se le paga a los externos en pesos. El control
   del 50% vive en el servidor (setTC) y estaba apagado desde acá; ahora, cuando frena, la pantalla
   muestra la pregunta y recién con un sí explícito reenvía con `forzar`.
   El caso que atrapa: "1.473" es un número válido —uno coma cuatro siete tres— así que el control
   de formato lo deja pasar, y todo lo que se paga sale mil veces más grande. */
async function setTcProv(mes, forzar){
  const v = val('tcp-'+mes); if(!v) return;
  const r = await api('/api/os/tc/mes/'+mes, {method:'PUT',
    body: JSON.stringify({ tc_proveedor_ext: v, forzar: !!forzar })});
  if (!r.ok) {
    // api() ya mostró el motivo; acá se pregunta sólo cuando el servidor dice que se puede forzar.
    if (r.confirmar && confirm(r.error + '\n\n¿Guardar ' + v + ' igual?')) return setTcProv(mes, true);
    return;
  }
  toast('Mes cerrado'); VIEWS.tc();
}

// ───────── MOVIMIENTOS ─────────
// Un comprobante aprobado ES un movimiento de pago: eran dos pantallas para los dos lados de lo
// mismo, y había que acordarse de mirar la otra. Ahora es una sola con solapas, y los que esperan
// aprobación se ven desde cualquier pantalla porque el número va en la pestaña de arriba.
