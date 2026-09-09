/**
 * probar-fichas.js — MAQUETA del panel de Fichas, fuera de producción.
 *
 * Sirve para mirar el ASPECTO antes de subirlo: junta las hojas de estilo de verdad
 * —/estilos.css, la compartida con el panel, más lo propio de Fichas— y dibuja las seis pestañas
 * con las MISMAS clases que emite public/index.html.
 *
 * ⚠️ Lo que se copia acá son las clases, no los datos: es una maqueta de cómo se ve, no de qué
 * dice. Que las clases sean las que el panel emite de verdad lo cuida test/smoke.js, con los
 * checks que empiezan en "estilo:".
 *
 *   node herramientas/probar-fichas.js [salida.html]
 */
const fs = require('fs');
const path = require('path');

const RAIZ = path.join(__dirname, '..');
const salida = process.argv[2] || path.join(RAIZ, 'maqueta-fichas.html');

const panel = fs.readFileSync(path.join(RAIZ, 'public', 'index.html'), 'utf8');
const propio = (panel.match(/<style>([\s\S]*?)<\/style>/) || [])[1];
const compartida = fs.readFileSync(path.join(RAIZ, 'public', 'estilos.css'), 'utf8');
if (!propio) throw new Error('no encontré el <style> del panel');

const pill = (t) => `<span class="pill" style="font-size:10px;opacity:.7">${t}</span>`;
const tapa = (t, sub, acc) => `<div class="tapa"><div><h2>${t}</h2>${
  sub ? `<div class="sub">${sub}</div>` : ''}</div>${acc ? `<div class="acciones">${acc}</div>` : ''}</div>`;

const cliente = ({ nom, cod, vend, cajas, gente, abierto, cuerpo, sangria }) => `
  <div class="plegable ${abierto ? 'abierto' : ''}" style="margin-left:${(sangria || 0) * 20}px">
    <div class="fila">
      <span class="chev"></span>
      <span class="nom">${nom}</span>
      ${pill(cod)}
      ${vend ? '<span class="señal" style="background:var(--bg3);color:var(--gold)">vendedor</span>' : ''}
      <span class="meta">${cajas ? `<span class="ver-cajas">${abierto ? '▾' : '▸'} ${cajas} caja${cajas === 1 ? '' : 's'}</span>` : 'sin cajas'}${
        gente ? ` · ${gente} a cargo` : ''}</span>
      <span class="acciones">
        <button class="outline small">✏️</button>
        <button class="outline small danger">🗑</button>
      </span>
    </div>
    ${cuerpo || ''}
  </div>`;

const cajaFila = (u, sis, id, div) => `
  <div class="caja-row">
    <div><div class="caja-head">usuario</div><input value="${u}"></div>
    <div><div class="caja-head">sistema</div><select><option>${sis}</option></select></div>
    <div><div class="caja-head">user_id (ID casino)</div><input value="${id}"></div>
    <div><div class="caja-head">divisas</div><input value="${div}"></div>
    <div><div class="caja-head">montos rápidos (botones)</div><input value=""></div>
    <div style="display:flex;gap:6px"><button class="small">💾</button><button class="outline small danger">🗑</button></div>
  </div>`;

const pedido = (divisa, monto, nom, cod, caja, sis, id) => `
  <div class="ped">
    <div class="montobig">${divisa} ${monto}</div>
    <div class="who">
      <b>${nom}</b> ${pill(cod)}<br>
      <span class="meta">→ caja <code>${caja}</code> · ${sis} · id ${id} · ${divisa}</span><br>
      <span class="meta" style="font-size:11px">9/9/2026, 08:16:20</span>
    </div>
    <button class="small">✅ Cargar</button>
    <button class="danger small">✗ Rechazar</button>
  </div>`;

const filaHist = (fecha, nom, caja, sis, divisa, monto, est, clase, quien, anular) => `
  <tr>
    <td data-label="Fecha">${fecha}</td>
    <td data-label="Cliente"><b>${nom}</b></td>
    <td data-label="Caja"><code>${caja}</code></td>
    <td data-label="Sistema">${sis}</td>
    <td data-label="Monto"><strong>${divisa}</strong> ${monto}</td>
    <td data-label="Estado" class="estado-${clase}">${est}${
      anular ? ' <button class="anular-sutil">↩ anular 46:23</button>' : ''}</td>
    <td data-label="Quién">${quien}</td>
  </tr>`;

const PESTAÑAS = [
  { t: '📥 Pedidos', h: `<div class="card">
      ${tapa('📥 Pedidos pendientes', '2 pendientes', '<button class="outline small">↻ Refrescar</button>')}
      ${pedido('ARS', '2.500.000', 'Marcelo', 'MARCELO44', 'Celuapuestas-SA', 'Casino', '9099270')}
      ${pedido('ARS', '800.000', 'Marcelo', 'MARCELO44', 'Celuapuestas-SA', 'Casino', '9099270')}
    </div>` },

  { t: '📜 Historial', h: `<div class="card">
      ${tapa('📜 Historial', '4 movimientos de 2026-09', '<button class="outline small">↻</button>')}
      <div style="display:flex; gap:8px; margin-bottom:12px; flex-wrap:wrap">
        <input type="month" style="flex:0 0 175px" value="2026-09">
        <input type="search" placeholder="filtrar por código (ej: L210)…" style="flex:1; min-width:200px">
        <button class="outline">Filtrar</button>
        <button class="outline">Todo el historial</button>
      </div>
      <table class="hist"><thead><tr><th>Fecha</th><th>Cliente</th><th>Caja</th><th>Sistema</th>
        <th>Monto</th><th>Estado</th><th>Quién</th></tr></thead><tbody>
        ${filaHist('9/9/2026, 02:46:54', 'Titan', 'Beting-SA', 'Europa', 'ARS', '226.542.857,14', '✓ cargado', 'cargado', '<b>SophiLatam</b>', true)}
        ${filaHist('9/9/2026, 02:46:48', 'Titan', 'Luckcity.net', 'Casino', 'ARS', '113.271.428,57', '✓ cargado', 'cargado', '<b>Alexa</b>', true)}
        ${filaHist('9/9/2026, 02:45:11', 'Titan', '463.live', 'Casino', 'ARS', '226.542.857,14', '↩ anulado', 'anulado', '<b>Alexa</b><br><span class="meta">cargó SophiLatam</span>', false)}
        ${filaHist('8/9/2026, 09:25:36', 'Marcelo', 'Celuapuestas-SA', 'Casino', 'ARS', '1.000.000', '✓ cargado', 'cargado', '<span class="meta">—</span>', false)}
      </tbody></table>
    </div>` },

  { t: '👥 Clientes', h: `<div class="card">
      ${tapa('Clientes', '47 clientes · 213 cajas', '<button class="outline small">▸ Plegar todo</button>')}
      <input type="search" placeholder="🔍 buscar por código, nombre, usuario o user_id…" style="margin-bottom:12px">
      ${cliente({ nom: 'Alexa', cod: 'ALEXA777', vend: true, cajas: 3, gente: 30, abierto: true,
        cuerpo: `<div class="cuerpo">
          <div style="margin:10px 0 4px" class="caja-head">📣 grupo telegram (aviso automático al cargar)</div>
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
            <input value="-1003945099284" style="flex:1;min-width:220px">
            <label style="display:flex;gap:5px;align-items:center;font-size:12px;color:var(--muted);white-space:nowrap"><input type="checkbox" checked style="width:auto"> avisar</label>
            <button class="small">💾</button><button class="outline small">🔔 Probar</button>
          </div>
          ${cajaFila('RMIglatamAlexa', 'Casino', '3663997', 'ARS')}
          ${cajaFila('AleXalataM', 'Europa', '1605476', 'ARS,AUD,CLP,COP')}
          ${cajaFila('RoyalAlexa-SA', 'Europa', '5990821', 'ARS,UYU')}
        </div>` })}
      ${cliente({ nom: 'Marcelo', cod: 'MARCELO44', cajas: 4, sangria: 1 })}
      ${cliente({ nom: 'Rafael', cod: 'RAFAEL-SA', cajas: 1, sangria: 1 })}
      ${cliente({ nom: 'Carlos', cod: 'CARLOS777', vend: true, cajas: 6, gente: 9 })}
    </div>` },

  { t: '📦 Abrir una caja', h: `<div class="card">
      <h2>📦 Solicitud para abrir una nueva caja</h2>
      <p class="meta" style="margin-top:0">Una caja es el destino al que se le cargan las fichas. Acá se
      <strong>pide</strong>; el alta la hace Alexa, porque además define a quién se le factura.</p>
      <div class="row" style="align-items:flex-end;flex-wrap:wrap">
        <div style="flex:0 0 190px"><label>Vendedor</label><select><option>— todos —</option></select></div>
        <div style="flex:1 1 240px"><label>Cliente al que se le abre</label><select><option>Alexa (ALEXA777) — el vendedor</option></select></div>
        <div style="flex:0 0 150px"><label>Panel</label><select><option>Casino</option></select></div>
      </div>
      <div class="row" style="align-items:flex-end;flex-wrap:wrap;margin-top:8px">
        <div style="flex:0 0 190px"><label>ID del casino</label><input placeholder="946463"></div>
        <div style="flex:1 1 200px"><label>Login en el panel</label><input placeholder="RMJoseDiaz-SA"></div>
        <div style="flex:1 1 220px"><label>Nota (opcional)</label><input placeholder="para qué es, quién la pidió…"></div>
        <button>Enviar solicitud</button>
      </div>
    </div>
    <div class="card">
      ${tapa('📋 Solicitudes enviadas', '', '<button class="outline small">↻</button>')}
      <div class="empty">Todavía no se pidió ninguna.</div>
    </div>` },

  { t: '⚙️ Configuración', h: `<div class="card">
      <h2>🎰 Dónde se cargan las fichas</h2>
      <p class="meta" style="margin-top:0">Las páginas de admin del casino se configuran
      <strong>una sola vez</strong> en 📊 Panel → <strong>Casino</strong>.</p>
      <table class="hist"><thead><tr><th>Sistema</th><th>Con qué conexión carga</th></tr></thead><tbody>
        <tr><td data-label="Sistema"><b>Casino</b></td><td data-label="Con qué conexión carga"><code>Casino_Fichas</code></td></tr>
        <tr><td data-label="Sistema"><b>Europa</b></td><td data-label="Con qué conexión carga"><code>Europa_Fichas</code></td></tr>
      </tbody></table>
    </div>` },
];

fs.writeFileSync(salida, `<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Maqueta · panel de Fichas</title>
<style>${compartida}</style>
<style>${propio}</style>
<style>
  .maq { max-width: 1000px; margin: 0 auto; padding: 20px; }
  .maq > h1 { font-size: 21px; margin: 0 0 4px; }
  .maq > p { color: var(--muted); font-size: 13px; margin: 0 0 22px; }
  .maq h3 { font-size: 12px; text-transform: uppercase; letter-spacing: .06em; color: var(--gold);
            margin: 30px 0 9px; }
</style></head><body>
<div class="maq">
  <h1>Panel de Fichas — con el aspecto del OS</h1>
  <p>Las hojas de estilo son las de verdad: la compartida con el panel más lo propio de Fichas.
     Nada de esto está en producción.</p>
  ${PESTAÑAS.map((p) => `<h3>${p.t}</h3>${p.h}`).join('')}
</div>
</body></html>`);
console.log('maqueta →', salida);
